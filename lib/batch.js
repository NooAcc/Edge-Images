import { fetchImage } from './fetch-image.js';
import { createImageLogger } from './image-logger.js';
import { ParamError, parseParams } from './parse-params.js';
import { FORMAT_CONTENT_TYPES, probeImageMetadataFromUrl, processImage } from './process-image.js';
import { buildCacheKey } from './cache.js';

const MAX_IMAGES = 20;

export function createBatchHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage,
  probeImageMetadataFromUrlImpl = probeImageMetadataFromUrl,
  logger = console,
  platformConfig,
  cache,
} = {}) {
  return async function batchHandler(req, res) {
    const requestLogger = createImageLogger({
      env: req.env,
      sink: logger,
      requestId: getRequestId(req),
      base: { route: '/api/batch' },
    });

    requestLogger.info('batch.request.start', {
      method: req.method || 'POST',
    });

    if (req.method && req.method !== 'POST') {
      requestLogger.warn('batch.request.method_not_allowed', { method: req.method });
      return sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
    }

    const platform = req.env?.PLATFORM || 'vercel';
    if (platform !== 'huggingface') {
      requestLogger.warn('batch.request.platform_not_allowed', { platform });
      return sendJson(res, 403, { error: 'Batch endpoint is only available on huggingface platform' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      requestLogger.warn('batch.request.body_read_failed', { error });
      return sendJson(res, 400, { error: 'Failed to read request body' });
    }

    if (!Array.isArray(body)) {
      requestLogger.warn('batch.request.invalid_body');
      return sendJson(res, 400, { error: 'Request body must be a JSON array' });
    }

    if (body.length === 0) {
      return sendJson(res, 200, {});
    }

    if (body.length > MAX_IMAGES) {
      requestLogger.warn('batch.request.too_many_images', { count: body.length });
      return sendJson(res, 400, { error: `Maximum ${MAX_IMAGES} images allowed per batch` });
    }

    const uuids = new Set();
    for (const item of body) {
      if (!item.uuid || typeof item.uuid !== 'string') {
        return sendJson(res, 400, { error: 'Each image must have a string uuid' });
      }
      if (uuids.has(item.uuid)) {
        return sendJson(res, 400, { error: `Duplicate uuid: ${item.uuid}` });
      }
      uuids.add(item.uuid);
      if (!item.url || typeof item.url !== 'string') {
        return sendJson(res, 400, { error: `Missing url for uuid: ${item.uuid}` });
      }
    }

    requestLogger.info('batch.request.params', { count: body.length });

    const results = await Promise.allSettled(
      body.map((item) => processSingleImage(item, { req, requestLogger, platformConfig, cache, fetchImageImpl, processImageImpl, probeImageMetadataFromUrlImpl }))
    );

    const response = {};
    for (let i = 0; i < body.length; i++) {
      const uuid = body[i].uuid;
      const result = results[i];
      if (result.status === 'fulfilled') {
        response[uuid] = result.value;
      } else {
        requestLogger.warn('batch.image.unexpected_error', { uuid, error: result.reason });
        response[uuid] = { success: false, error: result.reason?.message || 'Unknown error' };
      }
    }

    requestLogger.info('batch.request.complete', { count: body.length });
    return sendJson(res, 200, response);
  };
}

async function processSingleImage(item, { req, requestLogger, platformConfig, cache, fetchImageImpl, processImageImpl, probeImageMetadataFromUrlImpl }) {
  const { uuid, url, params: imageParams = {} } = item;

  const queryParams = new URLSearchParams();
  if (imageParams.width !== undefined) queryParams.set('width', String(imageParams.width));
  if (imageParams.height !== undefined) queryParams.set('height', String(imageParams.height));
  if (imageParams.quality !== undefined) queryParams.set('quality', String(imageParams.quality));
  if (imageParams.fit !== undefined) queryParams.set('fit', imageParams.fit);
  if (imageParams.format !== undefined) queryParams.set('format', imageParams.format);
  if (imageParams.rotate !== undefined) queryParams.set('rotate', String(imageParams.rotate));
  if (imageParams.flip !== undefined) queryParams.set('flip', imageParams.flip);
  if (imageParams.background !== undefined) queryParams.set('background', imageParams.background);

  let params;
  try {
    params = parseParams(url, queryParams, { env: req.env, platformConfig });
  } catch (error) {
    if (error instanceof ParamError) {
      requestLogger.warn('batch.image.param_error', { uuid, error: error.message });
      return { success: false, error: error.message };
    }
    throw error;
  }

  requestLogger.info('batch.image.processing', {
    uuid,
    sourceUrl: params.url,
    width: params.width,
    height: params.height,
    format: params.format,
  });

  if (params.format === 'json') {
    if (cache) {
      const cacheKey = buildCacheKey('meta', params.url);
      const cached = await cache.get(cacheKey);
      if (cached) {
        requestLogger.info('batch.image.cache_hit', { uuid, type: 'meta' });
        return { success: true, data: JSON.parse(cached.buffer.toString()) };
      }
    }

    const metadata = await probeImageMetadataFromUrlImpl(params.url, { logger: requestLogger });
    const result = {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      channels: metadata.channels,
      sourceUrl: params.url,
      sourceContentType: metadata.sourceContentType,
      sourceSize: metadata.sourceSize ?? null,
    };

    if (cache) {
      const cacheKey = buildCacheKey('meta', params.url);
      await cache.set(cacheKey, { buffer: Buffer.from(JSON.stringify(result)), header: { contentType: 'application/json' } });
    }

    return { success: true, data: result };
  }

  if (cache) {
    const processedKey = buildCacheKey('processed', params.url, params);
    const cachedProcessed = await cache.get(processedKey);
    if (cachedProcessed) {
      requestLogger.info('batch.image.cache_hit', { uuid, type: 'processed' });
      return { success: true, data: { base64: cachedProcessed.buffer.toString('base64') } };
    }
  }

  let imageBuffer;
  let sourceBytes;
  let sourceContentType;

  if (cache) {
    const sourceKey = buildCacheKey('source', params.url);
    const cachedSource = await cache.get(sourceKey);
    if (cachedSource) {
      imageBuffer = cachedSource.buffer;
      sourceBytes = cachedSource.buffer.length;
      sourceContentType = cachedSource.header?.contentType || 'application/octet-stream';
      requestLogger.info('batch.image.cache_hit', { uuid, type: 'source' });
    }
  }

  if (!imageBuffer) {
    const source = await fetchImageImpl(params.url, { logger: requestLogger });
    imageBuffer = source.buffer;
    sourceBytes = source.buffer.length;
    sourceContentType = source.contentType;

    if (cache) {
      const sourceKey = buildCacheKey('source', params.url);
      await cache.set(sourceKey, { buffer: imageBuffer, header: { contentType: sourceContentType } });
    }
  }

  const result = await processImageImpl(
    imageBuffer,
    { ...params, sourceContentType },
    { logger: requestLogger }
  );

  const { buffer, metadata } = result;
  const outputContentType = FORMAT_CONTENT_TYPES[metadata.format] || 'application/octet-stream';

  if (cache) {
    const processedKey = buildCacheKey('processed', params.url, params);
    await cache.set(processedKey, { buffer, header: { contentType: outputContentType, ...metadata } });
  }

  requestLogger.info('batch.image.success', {
    uuid,
    sourceBytes,
    outputBytes: buffer.length,
    outputContentType,
  });

  return { success: true, data: { base64: buffer.toString('base64') } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        try { resolve(JSON.parse(req.body)); } catch { reject(new Error('Invalid JSON')); }
        return;
      }
      if (Buffer.isBuffer(req.body)) {
        try { resolve(JSON.parse(req.body.toString())); } catch { reject(new Error('Invalid JSON')); }
        return;
      }
      if (typeof req.body === 'object') {
        resolve(req.body);
        return;
      }
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(payload);
}

function getRequestId(req) {
  return (
    getHeader(req, 'x-vercel-id') ||
    getHeader(req, 'x-request-id') ||
    getHeader(req, 'x-correlation-id') ||
    undefined
  );
}

function getHeader(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === 'function') {
    return headers.get(name) || undefined;
  }

  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}
