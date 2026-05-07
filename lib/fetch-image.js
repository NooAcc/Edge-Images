import { noopImageLogger } from "./image-logger.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/mp4,video/webm,*/*;q=0.8";
const DEFAULT_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class ImageFetchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ImageFetchError";
    this.cause = options.cause;
    this.status = options.status;
  }
}

export async function fetchImage(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_SOURCE_BYTES,
    logger = noopImageLogger
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new ImageFetchError("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const requestHeaders = buildImageFetchHeaders(url);

  logger.info("image.source.fetch_start", {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    timeoutMs,
    maxBytes,
    requestHeaders
  });

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: requestHeaders
    });
  } catch (error) {
    clearTimeout(timeout);

    if (controller.signal.aborted || error?.name === "AbortError") {
      logger.warn("image.source.fetch_timeout", {
        sourceUrl: url,
        sourceHost: getUrlHost(url),
        durationMs: Date.now() - startedAt,
        error
      });

      throw new ImageFetchError(`Source image fetch timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }

    logger.warn("image.source.fetch_error", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      durationMs: Date.now() - startedAt,
      error
    });

    throw new ImageFetchError("Source image fetch failed", { cause: error });
  }

  const contentType = response.headers?.get?.("content-type")?.split(";")[0]?.trim() || "";
  const contentLengthHeader = response.headers?.get?.("content-length");
  const contentLength = Number(contentLengthHeader);

  logger.info("image.source.fetch_response", {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    status: response.status,
    ok: response.ok,
    contentType,
    contentLength: contentLengthHeader || "",
    durationMs: Date.now() - startedAt
  });

  if (!response.ok) {
    clearTimeout(timeout);

    logger.warn("image.source.fetch_bad_status", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      status: response.status,
      contentType,
      contentLength: contentLengthHeader || "",
      durationMs: Date.now() - startedAt
    });

    throw new ImageFetchError(`Source image returned HTTP ${response.status}`, {
      status: response.status
    });
  }

  if (contentType && !isAllowedContentType(contentType)) {
    clearTimeout(timeout);

    logger.warn("image.source.fetch_non_media", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      status: response.status,
      contentType,
      durationMs: Date.now() - startedAt
    });

    throw new ImageFetchError("Source URL did not return an image or video");
  }

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    clearTimeout(timeout);

    logger.warn("image.source.fetch_too_large_header", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      status: response.status,
      contentLength,
      maxBytes,
      durationMs: Date.now() - startedAt
    });

    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  let arrayBuffer;
  try {
    arrayBuffer = await response.arrayBuffer();
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      logger.warn("image.source.fetch_timeout", {
        sourceUrl: url,
        sourceHost: getUrlHost(url),
        durationMs: Date.now() - startedAt,
        error
      });

      throw new ImageFetchError(`Source image fetch timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }

    logger.warn("image.source.fetch_body_error", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      status: response.status,
      durationMs: Date.now() - startedAt,
      error
    });

    throw new ImageFetchError("Source image body read failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (arrayBuffer.byteLength > maxBytes) {
    logger.warn("image.source.fetch_too_large_body", {
      sourceUrl: url,
      sourceHost: getUrlHost(url),
      status: response.status,
      bytes: arrayBuffer.byteLength,
      maxBytes,
      durationMs: Date.now() - startedAt
    });

    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  logger.info("image.source.fetch_done", {
    sourceUrl: url,
    sourceHost: getUrlHost(url),
    status: response.status,
    contentType,
    bytes: arrayBuffer.byteLength,
    durationMs: Date.now() - startedAt
  });

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
    status: response.status
  };
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function buildImageFetchHeaders(url) {
  const requestHeaders = {
    Accept: DEFAULT_IMAGE_ACCEPT,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": DEFAULT_IMAGE_USER_AGENT
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
    return "";
  }
}

const ALLOWED_CONTENT_TYPE_PREFIXES = ['image/', 'video/mp4', 'video/webm'];

export function isAllowedContentType(contentType) {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
