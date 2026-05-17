import { createImageLogger } from './image-logger.js';
import { ParamError, parseParams } from './parse-params.js';
import { fetchImage } from './fetch-image.js';
import { FORMAT_CONTENT_TYPES, processImage, probeImageMetadataFromUrl } from './process-image.js';
import { extractVideoFrameRange, probeVideoMetadataFromUrl } from './process-video.js';
import { buildCacheKey } from './cache.js';
import { VIDEO_EXTENSIONS } from './handler.js';

const MAX_IMAGES = 20;

let globalLimiter;

export function createBatchHandler({
  logger = console,
  platformConfig,
  cache,
} = {}) {
  const concurrency = platformConfig.batchConcurrency || 4;
  if (!globalLimiter) {
    globalLimiter = createLimiter(concurrency);
  }

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

    const response = {};

    // Parse all items and handle metadata / cache hits
    const pending = [];

    for (const item of body) {
      const { uuid, url, params: imageParams = {} } = item;

      let params;
      try {
        const query = buildQueryParams(imageParams);
        params = parseParams(url, query, { env: req.env, platformConfig });
      } catch (error) {
        if (error instanceof ParamError) {
          response[uuid] = { success: false, error: error.message };
          continue;
        }
        response[uuid] = { success: false, error: 'Internal Server Error' };
        continue;
      }

      const isVideo = VIDEO_EXTENSIONS.test(params.url);

      // format=json: metadata-only, handle inline
      if (params.format === 'json') {
        response[uuid] = await handleMetadata(params, isVideo, { cache, requestLogger });
        continue;
      }

      // Check processed cache
      if (cache) {
        const processedKey = buildCacheKey('processed', params.url, params);
        const cached = await cache.get(processedKey);
        if (cached) {
          const base64 = cached.buffer.toString('base64');
          response[uuid] = { success: true, data: { base64 } };
          continue;
        }
      }

      pending.push({ uuid, params, isVideo });
    }

    // Phase 1: Download all sources concurrently (no concurrency limit)
    await Promise.all(
      pending.map(async (entry) => {
        const { params, isVideo } = entry;

        // Check source cache
        if (cache) {
          const sourceKey = buildCacheKey('source', params.url);
          const cached = await cache.get(sourceKey);
          if (cached) {
            entry.sourceBuffer = cached.buffer;
            entry.sourceContentType = cached.header?.contentType || 'application/octet-stream';
            return;
          }
        }

        try {
          if (isVideo) {
            entry.sourceBuffer = await extractVideoFrameRange(params.url, {
              logger: requestLogger,
            });
            entry.sourceContentType = 'image/png';
          } else {
            const source = await fetchImage(params.url, {
              logger: requestLogger,
            });
            entry.sourceBuffer = source.buffer;
            entry.sourceContentType = source.contentType;
          }

          // Cache source
          if (cache) {
            const sourceKey = buildCacheKey('source', params.url);
            await cache.set(sourceKey, {
              buffer: entry.sourceBuffer,
              header: { contentType: entry.sourceContentType },
            });
          }
        } catch (error) {
          requestLogger.warn('batch.item.source_failed', {
            uuid: entry.uuid,
            sourceUrl: params.url,
            error,
          });
          entry.error = error?.message || 'Source fetch failed';
        }
      }),
    );

    // Filter to items that downloaded successfully
    const toProcess = pending.filter((entry) => !entry.error);

    // Mark download failures
    for (const entry of pending) {
      if (entry.error) {
        response[entry.uuid] = { success: false, error: entry.error };
      }
    }

    // Phase 2: Process all with global concurrency limit
    await Promise.all(
      toProcess.map((entry) =>
        globalLimiter(async () => {
          const { uuid, params, sourceBuffer, sourceContentType } = entry;
          try {
            const result = await processImage(
              sourceBuffer,
              { ...params, sourceContentType },
              { logger: requestLogger },
            );
            const base64 = result.buffer.toString('base64');

            // Cache processed result
            if (cache) {
              const processedKey = buildCacheKey('processed', params.url, params);
              await cache.set(processedKey, {
                buffer: result.buffer,
                header: {
                  contentType: FORMAT_CONTENT_TYPES[params.format] || 'application/octet-stream',
                },
              });
            }

            response[uuid] = { success: true, data: { base64 } };
          } catch (error) {
            requestLogger.warn('batch.item.process_failed', {
              uuid,
              sourceUrl: params.url,
              error,
            });
            // Fallback: return original source as base64
            const base64 = sourceBuffer.toString('base64');
            response[uuid] = { success: true, data: { base64 } };
          }
        }),
      ),
    );

    requestLogger.info('batch.request.complete', { count: body.length });
    return sendJson(res, 200, response);
  };
}

async function handleMetadata(params, isVideo, { cache, requestLogger }) {
  // Check metadata cache
  if (cache) {
    const cacheKey = buildCacheKey('meta', params.url);
    const cached = await cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached.buffer.toString()) };
    }
  }

  try {
    let data;
    if (isVideo) {
      const meta = await probeVideoMetadataFromUrl(params.url, {
        logger: requestLogger,
      });
      data = {
        width: meta.width,
        height: meta.height,
        codec: meta.codec,
        duration: meta.duration,
        format: meta.format,
        sourceUrl: params.url,
        sourceSize: meta.sourceSize ?? null,
      };
    } else {
      const meta = await probeImageMetadataFromUrl(params.url, {
        logger: requestLogger,
      });
      data = {
        width: meta.width,
        height: meta.height,
        format: meta.format,
        channels: meta.channels,
        sourceUrl: params.url,
        sourceContentType: meta.sourceContentType,
        sourceSize: meta.sourceSize ?? null,
      };
    }

    // Cache metadata
    if (cache) {
      const cacheKey = buildCacheKey('meta', params.url);
      await cache.set(cacheKey, { buffer: Buffer.from(JSON.stringify(data)), header: { contentType: 'application/json' } });
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: error?.message || 'Metadata probe failed' };
  }
}

function buildQueryParams(imageParams) {
  const query = new URLSearchParams();
  if (imageParams.width !== undefined) query.set('width', String(imageParams.width));
  if (imageParams.height !== undefined) query.set('height', String(imageParams.height));
  if (imageParams.quality !== undefined) query.set('quality', String(imageParams.quality));
  if (imageParams.fit !== undefined) query.set('fit', imageParams.fit);
  if (imageParams.format !== undefined) query.set('format', imageParams.format);
  if (imageParams.rotate !== undefined) query.set('rotate', String(imageParams.rotate));
  if (imageParams.flip !== undefined) query.set('flip', imageParams.flip);
  if (imageParams.background !== undefined) query.set('background', imageParams.background);
  return query;
}

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  }

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
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
