import { createImageLogger } from './image-logger.js';
import { ParamError, parseParams } from './parse-params.js';
import { createImageHandler } from './handler.js';

const MAX_IMAGES = 20;

export function createBatchHandler({
  logger = console,
  platformConfig,
  cache,
} = {}) {
  const imageHandler = createImageHandler({ logger, platformConfig, cache });

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

    const results = await Promise.allSettled(
      body.map((item) => processSingleItem(item, { req, imageHandler, requestLogger }))
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

async function processSingleItem(item, { req, imageHandler, requestLogger }) {
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

  const encodedUrl = encodeURIComponent(url);
  const mockReq = {
    method: 'GET',
    url: `/api/media/${encodedUrl}?${queryParams.toString()}`,
    headers: req.headers || {},
    env: req.env,
    query: queryParams,
  };

  let capturedData = null;
  let capturedStatus = 200;
  let capturedHeaders = {};

  const mockRes = {
    statusCode: 200,
    _headers: {},
    setHeader(key, value) {
      this._headers[key] = value;
    },
    end(data) {
      capturedStatus = this.statusCode;
      capturedHeaders = { ...this._headers };
      capturedData = data;
    },
  };

  await imageHandler(mockReq, mockRes);

  const contentType = capturedHeaders['Content-Type'] || capturedHeaders['content-type'] || '';

  if (capturedStatus !== 200) {
    let errorMsg = 'Processing failed';
    try {
      const parsed = JSON.parse(capturedData?.toString() || '{}');
      errorMsg = parsed.details || parsed.error || errorMsg;
    } catch {}
    return { success: false, error: errorMsg };
  }

  if (contentType.includes('application/json')) {
    try {
      const jsonData = JSON.parse(capturedData?.toString() || '{}');
      return { success: true, data: jsonData };
    } catch {
      return { success: true, data: { raw: capturedData?.toString() } };
    }
  }

  const base64 = Buffer.isBuffer(capturedData)
    ? capturedData.toString('base64')
    : Buffer.from(capturedData || '').toString('base64');

  return { success: true, data: { base64 } };
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
