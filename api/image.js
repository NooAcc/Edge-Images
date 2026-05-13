import { fetchImage } from '../lib/fetch-image.js';
import { createImageLogger } from '../lib/image-logger.js';
import { ParamError, getQueryValue, parseParams } from '../lib/parse-params.js';
import {
  FORMAT_CONTENT_TYPES,
  probeImageMetadataFromUrl,
  processImage,
} from '../lib/process-image.js';
import { extractVideoFrameRange, probeVideoMetadataFromUrl } from '../lib/process-video.js';

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PROCESSOR_NAME = 'vercel-node-image';
const IMAGE_ROUTE_PREFIX = '/api/image';
const VIDEO_EXTENSIONS = /\.(mp4|webm)(\?.*)?$/i;

export function createImageHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage,
  probeImageMetadataFromUrlImpl = probeImageMetadataFromUrl,
  probeVideoMetadataFromUrlImpl = probeVideoMetadataFromUrl,
  extractVideoFrameRangeImpl = extractVideoFrameRange,
  logger = console,
} = {}) {
  return async function imageHandler(req, res) {
    const requestLogger = createImageLogger({
      env: req.env,
      sink: logger,
      requestId: getRequestId(req),
      base: {
        route: '/api/image',
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
      params = parseParams(extractSourceUrl(req, query), query, { env: req.env });
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
      try {
        const videoMetadata = await probeVideoMetadataFromUrlImpl(params.url, {
          logger: requestLogger,
        });

        requestLogger.info('image.request.success', {
          statusCode: 200,
          videoMetadata,
        });

        return sendJson(res, 200, {
          width: videoMetadata.width,
          height: videoMetadata.height,
          codec: videoMetadata.codec,
          duration: videoMetadata.duration,
          format: videoMetadata.format,
          sourceUrl: params.url,
          sourceSize: videoMetadata.sourceSize ?? null,
        });
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
      try {
        const imageMetadata = await probeImageMetadataFromUrlImpl(params.url, {
          logger: requestLogger,
        });

        requestLogger.info('image.request.success', {
          statusCode: 200,
          imageMetadata,
        });

        return sendJson(res, 200, {
          width: imageMetadata.width,
          height: imageMetadata.height,
          format: imageMetadata.format,
          channels: imageMetadata.channels,
          sourceUrl: params.url,
          sourceContentType: imageMetadata.sourceContentType,
          sourceSize: imageMetadata.sourceSize ?? null,
        });
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

    let imageBuffer;
    let sourceBytes;
    let sourceContentType;

    if (isVideo) {
      try {
        imageBuffer = await extractVideoFrameRangeImpl(params.url, {
          logger: requestLogger,
        });
        sourceBytes = imageBuffer.length;
        sourceContentType = 'image/png';
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
  const sourcePrefix = `${IMAGE_ROUTE_PREFIX}/`;
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
    return new URL(req.url || '/api/image', 'http://localhost').pathname;
  } catch {
    return req.url || '/api/image';
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export default createImageHandler();
