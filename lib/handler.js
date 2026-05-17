import { fetchImage } from './fetch-image.js';
import { createImageLogger } from './image-logger.js';
import { ParamError, getQueryValue, parseParams } from './parse-params.js';
import { FORMAT_CONTENT_TYPES, probeImageMetadataFromUrl, processImage } from './process-image.js';
import { extractVideoFrameRange, probeVideoMetadataFromUrl } from './process-video.js';
import { buildCacheKey } from './cache.js';

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PROCESSOR_NAME = 'edge-image';
const MEDIA_ROUTE_PREFIX = '/api/media';
const VIDEO_EXTENSIONS = /\.(mp4|webm)(\?.*)?$/i;

export function createImageHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage,
  probeImageMetadataFromUrlImpl = probeImageMetadataFromUrl,
  probeVideoMetadataFromUrlImpl = probeVideoMetadataFromUrl,
  extractVideoFrameRangeImpl = extractVideoFrameRange,
  logger = console,
  platformConfig,
  cache,
} = {}) {
  return async function imageHandler(req, res) {
    const requestLogger = createImageLogger({
      env: req.env,
      sink: logger,
      requestId: getRequestId(req),
      base: {
        route: '/api/media',
      },
    });

    requestLogger.info('image.request.start', {
      method: req.method || 'GET',
      path: getRequestPath(req),
    });

    if (req.method && req.method !== 'GET') {
      requestLogger.warn('image.request.method_not_allowed', {
        method: req.method,
      });
      return sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
    }

    const query = extractQuery(req);
    let params;
    try {
      params = parseParams(extractSourceUrl(req, query), query, { env: req.env, platformConfig });
    } catch (error) {
      if (error instanceof ParamError) {
        requestLogger.warn('image.request.param_error', {
          error,
        });
        return sendJson(res, 400, { error: error.message });
      }

      requestLogger.error('image.request.param_unexpected_error', {
        error,
      });
      return sendJson(res, 500, { error: 'Internal Server Error' });
    }

    const isVideo = VIDEO_EXTENSIONS.test(params.url);

    requestLogger.info('image.request.params', {
      sourceUrl: params.url,
      sourceHost: getUrlHost(params.url),
      width: params.width,
      height: params.height,
      fit: params.fit,
      quality: params.quality,
      format: params.format,
      rotate: params.rotate,
      flip: params.flip || '',
      isVideo,
    });

    if (isVideo && params.format === 'json') {
      // Check metadata cache
      if (cache) {
        const cacheKey = buildCacheKey('meta', params.url);
        const cached = await cache.get(cacheKey);
        if (cached) {
          requestLogger.info('image.request.cache_hit', { type: 'meta' });
          return sendJson(res, 200, JSON.parse(cached.buffer.toString()));
        }
      }

      try {
        const videoMetadata = await probeVideoMetadataFromUrlImpl(params.url, {
          logger: requestLogger,
        });

        const result = {
          width: videoMetadata.width,
          height: videoMetadata.height,
          codec: videoMetadata.codec,
          duration: videoMetadata.duration,
          format: videoMetadata.format,
          sourceUrl: params.url,
          sourceSize: videoMetadata.sourceSize ?? null,
        };

        // Write to metadata cache
        if (cache) {
          const cacheKey = buildCacheKey('meta', params.url);
          await cache.set(cacheKey, { buffer: Buffer.from(JSON.stringify(result)), header: { contentType: 'application/json' } });
        }

        requestLogger.info('image.request.success', { statusCode: 200, videoMetadata });

        return sendJson(res, 200, result);
      } catch (error) {
        requestLogger.warn('image.request.video_probe_failed', {
          error,
          sourceUrl: params.url,
        });

        return sendJson(
          res,
          502,
          {
            error: 'Bad Gateway',
            details: sanitizeHeaderValue(error?.message || 'Video probe failed'),
          },
          { 'X-Processor': PROCESSOR_NAME },
        );
      }
    }

    if (!isVideo && params.format === 'json') {
      // Check metadata cache
      if (cache) {
        const cacheKey = buildCacheKey('meta', params.url);
        const cached = await cache.get(cacheKey);
        if (cached) {
          requestLogger.info('image.request.cache_hit', { type: 'meta' });
          return sendJson(res, 200, JSON.parse(cached.buffer.toString()));
        }
      }

      try {
        const imageMetadata = await probeImageMetadataFromUrlImpl(params.url, {
          logger: requestLogger,
        });

        const result = {
          width: imageMetadata.width,
          height: imageMetadata.height,
          format: imageMetadata.format,
          channels: imageMetadata.channels,
          sourceUrl: params.url,
          sourceContentType: imageMetadata.sourceContentType,
          sourceSize: imageMetadata.sourceSize ?? null,
        };

        // Write to metadata cache
        if (cache) {
          const cacheKey = buildCacheKey('meta', params.url);
          await cache.set(cacheKey, { buffer: Buffer.from(JSON.stringify(result)), header: { contentType: 'application/json' } });
        }

        requestLogger.info('image.request.success', { statusCode: 200, imageMetadata });

        return sendJson(res, 200, result);
      } catch (error) {
        requestLogger.warn('image.request.image_probe_failed', {
          error,
          sourceUrl: params.url,
          sourceHost: getUrlHost(params.url),
        });

        return sendJson(
          res,
          502,
          {
            error: 'Bad Gateway',
            details: sanitizeHeaderValue(error?.message || 'Image metadata probe failed'),
          },
          { 'X-Processor': PROCESSOR_NAME },
        );
      }
    }

    // Check processed result cache
    if (cache) {
      const processedKey = buildCacheKey('processed', params.url, params);
      const cachedProcessed = await cache.get(processedKey);
      if (cachedProcessed) {
        requestLogger.info('image.request.cache_hit', { type: 'processed' });
        const outputContentType = cachedProcessed.header?.contentType || 'application/octet-stream';
        return sendBuffer(res, 200, cachedProcessed.buffer, {
          'Content-Type': outputContentType,
          'Cache-Control': CACHE_CONTROL,
          'X-Processor': PROCESSOR_NAME,
          'X-Cache': 'HIT',
        });
      }
    }

    let imageBuffer;
    let sourceBytes;
    let sourceContentType;

    // Check source cache
    let sourceCacheHit = false;
    if (cache) {
      const sourceKey = buildCacheKey('source', params.url);
      const cachedSource = await cache.get(sourceKey);
      if (cachedSource) {
        imageBuffer = cachedSource.buffer;
        sourceBytes = cachedSource.buffer.length;
        sourceContentType = cachedSource.header?.contentType || 'application/octet-stream';
        sourceCacheHit = true;
        requestLogger.info('image.request.cache_hit', { type: 'source' });
      }
    }

    if (!sourceCacheHit) {
      if (isVideo) {
        try {
          imageBuffer = await extractVideoFrameRangeImpl(params.url, {
            logger: requestLogger,
          });
          sourceBytes = imageBuffer.length;
          sourceContentType = 'image/png';

          // Cache video frame
          if (cache) {
            const sourceKey = buildCacheKey('source', params.url);
            await cache.set(sourceKey, { buffer: imageBuffer, header: { contentType: sourceContentType } });
          }
        } catch (error) {
          requestLogger.warn('image.request.video_frame_failed', {
            error,
            sourceUrl: params.url,
          });

          return sendJson(
            res,
            502,
            {
              error: 'Bad Gateway',
              details: sanitizeHeaderValue(error?.message || 'Video frame extraction failed'),
            },
            { 'X-Processor': PROCESSOR_NAME },
          );
        }
      } else {
        let source;
        try {
          source = await fetchImageImpl(params.url, {
            logger: requestLogger,
          });
        } catch (error) {
          requestLogger.warn('image.request.fetch_failed', {
            error,
            status: error?.status,
            sourceUrl: params.url,
            sourceHost: getUrlHost(params.url),
          });

          return sendJson(
            res,
            502,
            {
              error: 'Bad Gateway',
              details: sanitizeHeaderValue(error?.message || 'Source image fetch failed'),
            },
            { 'X-Processor': PROCESSOR_NAME },
          );
        }

        imageBuffer = source.buffer;
        sourceBytes = source.buffer.length;
        sourceContentType = source.contentType;

        // Cache source image
        if (cache) {
          const sourceKey = buildCacheKey('source', params.url);
          await cache.set(sourceKey, { buffer: imageBuffer, header: { contentType: sourceContentType } });
        }
      }
    }

    try {
      const result = await processImageImpl(
        imageBuffer,
        {
          ...params,
          sourceContentType,
        },
        {
          logger: requestLogger,
        },
      );

      const { buffer, metadata } = result;
      const outputContentType = FORMAT_CONTENT_TYPES[metadata.format] || 'application/octet-stream';

      // Cache processed result
      if (cache) {
        const processedKey = buildCacheKey('processed', params.url, params);
        await cache.set(processedKey, { buffer, header: { contentType: outputContentType, ...metadata } });
      }

      requestLogger.info('image.request.success', {
        statusCode: 200,
        sourceBytes,
        outputBytes: buffer.length,
        outputContentType,
        metadata,
      });

      return sendBuffer(res, 200, buffer, {
        'Content-Type': outputContentType,
        'Cache-Control': CACHE_CONTROL,
        'X-Processor': PROCESSOR_NAME,
        'X-Image-Width': String(metadata.width),
        'X-Image-Height': String(metadata.height),
        'X-Image-Format': metadata.format,
        'X-Image-Size': String(metadata.size),
      });
    } catch (error) {
      requestLogger.warn('image.request.processing_failed_fallback', {
        error,
        sourceBytes,
      });

      return sendBuffer(res, 200, imageBuffer, {
        'Content-Type': sourceContentType || 'application/octet-stream',
        'Cache-Control': CACHE_CONTROL,
        'X-Processor': PROCESSOR_NAME,
        'X-Processing-Error': sanitizeHeaderValue(error?.message || 'Image processing failed'),
      });
    }
  };
}

function extractQuery(req) {
  if (req.query) {
    return req.query;
  }

  const host = req.headers?.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  return url.searchParams;
}

function extractSourceUrl(req, query) {
  const encodedPathSource = getEncodedPathSource(req);
  if (encodedPathSource !== undefined) {
    return decodePathSource(encodedPathSource);
  }

  const rewriteSource = getQueryValue(query, 'source');
  if (rewriteSource === undefined || rewriteSource === '') {
    return rewriteSource;
  }

  return normalizeRewriteSource(rewriteSource);
}

function getEncodedPathSource(req) {
  const pathname = getRequestPath(req);
  const sourcePrefix = `${MEDIA_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(sourcePrefix)) {
    return undefined;
  }

  return pathname.slice(sourcePrefix.length);
}

function decodePathSource(encodedPathSource) {
  try {
    return decodeURIComponent(encodedPathSource);
  } catch {
    throw new ParamError('source URL path segment must be valid percent-encoding');
  }
}

function normalizeRewriteSource(source) {
  const value = String(source);
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return decodePathSource(value);
}

function sendJson(res, statusCode, body, headers = {}) {
  return sendBuffer(res, statusCode, Buffer.from(JSON.stringify(body)), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function sendBuffer(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }

  res.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
}

export function sanitizeHeaderValue(value) {
  return String(value)
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, 180);
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

function getRequestPath(req) {
  try {
    return new URL(req.url || '/api/media', 'http://localhost').pathname;
  } catch {
    return req.url || '/api/media';
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
