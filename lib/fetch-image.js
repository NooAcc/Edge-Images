import { noopImageLogger } from './image-logger.js';

export const DEFAULT_FETCH_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_IMAGE_METADATA_BYTES = 64 * 1024;
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000];

const DEFAULT_IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const DEFAULT_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RETRYABLE_STATUS_CODES = new Set([403, 429, 500, 502, 503, 504]);

export class ImageFetchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ImageFetchError';
    this.cause = options.cause;
    this.status = options.status;
    this.retryable = Boolean(options.retryable);
  }
}

export function parseSourceSize(headers, { allowContentLength = false } = {}) {
  const contentRangeSize = parseContentRangeSourceSize(headers?.get?.('content-range'));
  if (contentRangeSize !== null) {
    return contentRangeSize;
  }

  if (!allowContentLength) {
    return null;
  }

  return parseSourceSizeValue(headers?.get?.('content-length'));
}

export async function fetchImage(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_SOURCE_BYTES,
    logger = noopImageLogger,
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    now = Date.now,
  } = {},
) {
  const requestHeaders = buildImageFetchHeaders(url);

  return fetchWithRetry({
    url,
    fetchImpl,
    timeoutMs,
    logger,
    retryCount,
    retryDelaysMs,
    sleep,
    now,
    context: {
      logPrefix: 'image.source',
      startEvent: 'image.source.fetch_start',
      retryEvent: 'image.source.fetch_retry',
      retryExhaustedEvent: 'image.source.fetch_retry_exhausted',
      timeoutMessage: `Source image fetch timed out after ${timeoutMs}ms`,
      fetchErrorMessage: 'Source image fetch failed',
      extraStartFields: { maxBytes },
    },
    requestHeaders,
    handleResponse: async ({ response, attempt, startedAt, signal }) =>
      readImageResponse({
        url,
        response,
        attempt,
        startedAt,
        signal,
        logger,
        maxBytes,
      }),
  });
}

export async function fetchImageMetadataRange(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    rangeSize = DEFAULT_IMAGE_METADATA_BYTES,
    logger = noopImageLogger,
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    now = Date.now,
  } = {},
) {
  const requestHeaders = {
    ...buildImageFetchHeaders(url),
    Range: `bytes=0-${rangeSize - 1}`,
  };

  return fetchWithRetry({
    url,
    fetchImpl,
    timeoutMs,
    logger,
    retryCount,
    retryDelaysMs,
    sleep,
    now,
    context: {
      logPrefix: 'image.metadata',
      startEvent: 'image.metadata.fetch_start',
      retryEvent: 'image.metadata.fetch_retry',
      retryExhaustedEvent: 'image.metadata.fetch_retry_exhausted',
      timeoutMessage: `Source image metadata fetch timed out after ${timeoutMs}ms`,
      fetchErrorMessage: 'Source image metadata fetch failed',
      extraStartFields: { rangeSize },
    },
    requestHeaders,
    handleResponse: async ({ response, attempt, startedAt, signal }) =>
      readImageMetadataResponse({
        url,
        response,
        attempt,
        startedAt,
        signal,
        logger,
        rangeSize,
      }),
  });
}

async function fetchWithRetry({
  url,
  fetchImpl,
  timeoutMs,
  logger,
  retryCount,
  retryDelaysMs,
  sleep,
  now,
  context,
  requestHeaders,
  handleResponse,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new ImageFetchError('fetch is not available in this runtime');
  }

  const startedAt = now();
  const maxAttempts = Math.max(1, retryCount + 1);

  logger.info(context.startEvent, {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    timeoutMs,
    retryCount,
    requestHeaders,
    ...context.extraStartFields,
  });

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = getRemainingMs({ now, startedAt, timeoutMs });
    if (remainingMs <= 0) {
      throw buildTimeoutError(context.timeoutMessage, lastError);
    }

    try {
      return await fetchOnce({
        url,
        fetchImpl,
        requestHeaders,
        remainingMs,
        logger,
        context,
        startedAt,
        attempt,
        handleResponse,
      });
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (!shouldRetryFetch({ error: lastError, attempt, maxAttempts })) {
        if (attempt > 1 && lastError.retryable) {
          logRetryExhausted({ logger, context, url, error: lastError, attempt, maxAttempts });
        }
        throw lastError;
      }

      const delayMs = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0;
      const delayRemainingMs = getRemainingMs({ now, startedAt, timeoutMs });
      if (delayRemainingMs <= 0) {
        logRetryExhausted({ logger, context, url, error: lastError, attempt, maxAttempts });
        throw buildTimeoutError(context.timeoutMessage, lastError);
      }

      const boundedDelayMs = Math.min(delayMs, delayRemainingMs);
      logger.warn(context.retryEvent, {
        sourceUrl: url,
        sourceHost: getUrlHost(url),
        attempt,
        maxAttempts,
        status: lastError.status,
        delayMs: boundedDelayMs,
        error: lastError,
      });

      if (boundedDelayMs > 0) {
        await sleep(boundedDelayMs);
      }
    }
  }

  throw lastError || buildTimeoutError(context.timeoutMessage);
}

async function fetchOnce({
  url,
  fetchImpl,
  requestHeaders,
  remainingMs,
  logger,
  context,
  startedAt,
  attempt,
  handleResponse,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: requestHeaders,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw createFetchFailure({
      error,
      signal: controller.signal,
      logger,
      context,
      url,
      startedAt,
      attempt,
    });
  }

  try {
    return await handleResponse({
      response,
      attempt,
      startedAt,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readImageResponse({ url, response, attempt, startedAt, signal, logger, maxBytes }) {
  const responseInfo = getResponseInfo(response);

  logger.info('image.source.fetch_response', {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    status: response.status,
    ok: response.ok,
    contentType: responseInfo.contentType,
    contentLength: responseInfo.contentLengthHeader || '',
    durationMs: Date.now() - startedAt,
  });

  await assertSuccessfulImageResponse({
    url,
    response,
    responseInfo,
    logger,
    logPrefix: 'image.source',
    startedAt,
    attempt,
  });

  if (Number.isFinite(responseInfo.contentLength) && responseInfo.contentLength > maxBytes) {
    await cancelResponseBody(response);

    logger.warn('image.source.fetch_too_large_header', {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status: response.status,
      contentLength: responseInfo.contentLength,
      maxBytes,
      durationMs: Date.now() - startedAt,
    });

    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  const arrayBuffer = await readArrayBuffer({
    response,
    signal,
    logger,
    logPrefix: 'image.source',
    timeoutMessage: 'Source image fetch timed out',
    bodyErrorMessage: 'Source image body read failed',
    url,
    startedAt,
    attempt,
    status: response.status,
  });

  if (arrayBuffer.byteLength > maxBytes) {
    logger.warn('image.source.fetch_too_large_body', {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status: response.status,
      bytes: arrayBuffer.byteLength,
      maxBytes,
      durationMs: Date.now() - startedAt,
    });

    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  logger.info('image.source.fetch_done', {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    status: response.status,
    contentType: responseInfo.contentType,
    bytes: arrayBuffer.byteLength,
    durationMs: Date.now() - startedAt,
  });

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: responseInfo.contentType,
    status: response.status,
  };
}

async function readImageMetadataResponse({
  url,
  response,
  attempt,
  startedAt,
  signal,
  logger,
  rangeSize,
}) {
  const responseInfo = getResponseInfo(response);
  const sourceSize = parseSourceSize(response.headers, {
    allowContentLength: response.status !== 206,
  });

  logger.info('image.metadata.fetch_response', {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    status: response.status,
    ok: response.ok,
    contentType: responseInfo.contentType,
    contentLength: responseInfo.contentLengthHeader || '',
    sourceSize,
    durationMs: Date.now() - startedAt,
  });

  await assertSuccessfulImageResponse({
    url,
    response,
    responseInfo,
    logger,
    logPrefix: 'image.metadata',
    startedAt,
    attempt,
  });

  let buffer;
  try {
    buffer = await readResponsePrefix(response, rangeSize);
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') {
      logger.warn('image.metadata.fetch_timeout', {
        sourceUrl: url,
        sourceHost: getUrlHost(url),
        attempt,
        status: response.status,
        durationMs: Date.now() - startedAt,
        error,
      });

      throw new ImageFetchError('Source image metadata fetch timed out', {
        cause: error,
        retryable: true,
      });
    }

    logger.warn('image.metadata.fetch_body_error', {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status: response.status,
      durationMs: Date.now() - startedAt,
      error,
    });

    throw new ImageFetchError('Source image metadata body read failed', { cause: error });
  }

  logger.info('image.metadata.fetch_done', {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    status: response.status,
    contentType: responseInfo.contentType,
    bytes: buffer.length,
    sourceSize,
    durationMs: Date.now() - startedAt,
  });

  return {
    buffer,
    contentType: responseInfo.contentType,
    status: response.status,
    sourceSize,
  };
}

async function assertSuccessfulImageResponse({
  url,
  response,
  responseInfo,
  logger,
  logPrefix,
  startedAt,
  attempt,
}) {
  if (!response.ok) {
    await cancelResponseBody(response);

    logger.warn(`${logPrefix}.fetch_bad_status`, {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status: response.status,
      contentType: responseInfo.contentType,
      contentLength: responseInfo.contentLengthHeader || '',
      durationMs: Date.now() - startedAt,
    });

    throw new ImageFetchError(`Source image returned HTTP ${response.status}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS_CODES.has(response.status),
    });
  }

  if (responseInfo.contentType && !responseInfo.contentType.toLowerCase().startsWith('image/')) {
    await cancelResponseBody(response);

    logger.warn(`${logPrefix}.fetch_non_image`, {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status: response.status,
      contentType: responseInfo.contentType,
      durationMs: Date.now() - startedAt,
    });

    throw new ImageFetchError('Source URL did not return an image');
  }
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    /* Stop reading rejected response bodies before retrying or returning an error. */
  }
}

async function readArrayBuffer({
  response,
  signal,
  logger,
  logPrefix,
  bodyErrorMessage,
  url,
  startedAt,
  attempt,
  status,
}) {
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') {
      logger.warn(`${logPrefix}.fetch_timeout`, {
        sourceUrl: url,
        sourceHost: getUrlHost(url),
        attempt,
        status,
        durationMs: Date.now() - startedAt,
        error,
      });

      throw new ImageFetchError(
        `${logPrefix === 'image.source' ? 'Source image' : 'Source image metadata'} fetch timed out`,
        {
          cause: error,
          retryable: true,
        },
      );
    }

    logger.warn(`${logPrefix}.fetch_body_error`, {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      status,
      durationMs: Date.now() - startedAt,
      error,
    });

    throw new ImageFetchError(bodyErrorMessage, { cause: error });
  }
}

function createFetchFailure({ error, signal, logger, context, url, startedAt, attempt }) {
  if (signal.aborted || error?.name === 'AbortError') {
    logger.warn(`${context.logPrefix}.fetch_timeout`, {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      attempt,
      durationMs: Date.now() - startedAt,
      error,
    });

    return new ImageFetchError(context.timeoutMessage, {
      cause: error,
      retryable: true,
    });
  }

  logger.warn(`${context.logPrefix}.fetch_error`, {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    durationMs: Date.now() - startedAt,
    error,
  });

  return new ImageFetchError(context.fetchErrorMessage, {
    cause: error,
    retryable: true,
  });
}

function normalizeFetchError(error) {
  if (error instanceof ImageFetchError) {
    return error;
  }

  return new ImageFetchError(error?.message || 'Source image fetch failed', {
    cause: error,
    retryable: true,
  });
}

function shouldRetryFetch({ error, attempt, maxAttempts }) {
  return attempt < maxAttempts && Boolean(error.retryable);
}

function logRetryExhausted({ logger, context, url, error, attempt, maxAttempts }) {
  logger.warn(context.retryExhaustedEvent, {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    attempt,
    maxAttempts,
    status: error.status,
    delayMs: 0,
    error,
  });
}

function buildTimeoutError(message, cause) {
  return new ImageFetchError(message, {
    cause,
    retryable: true,
  });
}

function getRemainingMs({ now, startedAt, timeoutMs }) {
  return Math.max(0, timeoutMs - (now() - startedAt));
}

async function defaultSleep(delayMs) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getResponseInfo(response) {
  const contentType = response.headers?.get?.('content-type')?.split(';')[0]?.trim() || '';
  const contentLengthHeader = response.headers?.get?.('content-length');

  return {
    contentType,
    contentLengthHeader,
    contentLength: Number(contentLengthHeader),
  };
}

async function readResponsePrefix(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new ImageFetchError('Readable response body is not available');
  }

  const chunks = [];
  let bytes = 0;

  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        await cancelReader(reader);
        return Buffer.concat(chunks, bytes);
      }

      chunks.push(chunk);
      bytes += chunk.length;
    }

    if (bytes >= maxBytes) {
      await cancelReader(reader);
    }

    return Buffer.concat(chunks, bytes);
  } finally {
    reader.releaseLock?.();
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    /* Stop reading once the metadata prefix is available. */
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function buildImageFetchHeaders(url) {
  const requestHeaders = {
    Accept: DEFAULT_IMAGE_ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': DEFAULT_IMAGE_USER_AGENT,
  };

  const sourceOrigin = getUrlOrigin(url);
  if (sourceOrigin) {
    requestHeaders.Referer = `${sourceOrigin}/`;
  }

  return requestHeaders;
}

function getUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function parseContentRangeSourceSize(contentRange) {
  const match = String(contentRange || '').match(/^bytes\s+\d+-\d+\/(\d+|\*)$/i);
  if (!match || match[1] === '*') {
    return null;
  }

  return parseSourceSizeValue(match[1]);
}

function parseSourceSizeValue(value) {
  const normalized = String(value || '').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const sourceSize = Number(normalized);
  return Number.isSafeInteger(sourceSize) && sourceSize >= 0 ? sourceSize : null;
}
