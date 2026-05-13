import assert from 'node:assert/strict';
import test from 'node:test';

import { CACHE_CONTROL, PROCESSOR_NAME, createImageHandler } from '../api/image.js';
import { createCaptureSink } from './helpers/capture-logs.js';

test('api handler returns processed output with cache headers and metadata', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('source'),
      contentType: 'image/jpeg',
    }),
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from(`webp:${params.width}`),
      metadata: {
        width: params.width,
        height: 600,
        format: 'webp',
        size: 12345,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.jpg', {
      width: '800',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.headers['cache-control'], CACHE_CONTROL);
  assert.equal(res.headers['x-processor'], PROCESSOR_NAME);
  assert.equal(res.headers['x-image-width'], '800');
  assert.equal(res.headers['x-image-height'], '600');
  assert.equal(res.headers['x-image-format'], 'webp');
  assert.equal(res.headers['x-image-size'], '12345');
  assert.equal(res.body.toString(), 'webp:800');
});

test('api handler returns 400 for missing source URL path segment', async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler({ method: 'GET', url: '/api/image' }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body.toString()), {
    error: 'Missing required source URL path segment',
  });
});

test('api handler rejects legacy url query parameter', async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler(
    {
      method: 'GET',
      url: '/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg',
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body.toString()), {
    error: 'url query parameter is no longer supported; encode the source URL in the path',
  });
});

test('api handler returns 400 for malformed source URL path encoding', async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler({ method: 'GET', url: '/api/image/%E0%A4%A?format=json' }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body.toString()), {
    error: 'source URL path segment must be valid percent-encoding',
  });
});

test('api handler returns 400 when source host is not allowlisted', async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler(
    createImageRequest(
      'https://blocked.example.com/photo.jpg',
      {},
      {
        env: { IMAGE_URL_ALLOWLIST: 'images.example.com' },
      },
    ),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.toString(), /not allowed/);
});

test('api handler returns 405 for unsupported methods', async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler({ method: 'POST', query: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET');
});

test('api handler returns 502 when source fetch fails', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => {
      throw new Error('upstream failed');
    },
  });
  const res = createMockResponse();

  await handler(createImageRequest('https://example.com/photo.jpg'), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /Bad Gateway/);
  assert.equal(res.headers['x-processor'], PROCESSOR_NAME);
});

test('api handler logs source fetch failures when debug logging is enabled', async () => {
  const capture = createCaptureSink();
  const handler = createImageHandler({
    fetchImageImpl: async () => {
      const error = new Error('Source image returned HTTP 403');
      error.status = 403;
      throw error;
    },
    logger: capture.sink,
  });
  const res = createMockResponse();

  await handler(
    createImageRequest(
      'https://example.com/photo.avif',
      {
        width: '420',
        height: '296',
        fit: 'cover',
        quality: '82',
      },
      {
        headers: { 'x-request-id': 'req_debug' },
        env: { IMAGE_DEBUG_LOGS: '1' },
      },
    ),
    res,
  );

  const records = capture.records();
  const params = records.find((record) => record.event === 'image.request.params');
  const failed = records.find((record) => record.event === 'image.request.fetch_failed');

  assert.equal(res.statusCode, 502);
  assert.equal(params.requestId, 'req_debug');
  assert.equal(params.sourceHost, 'example.com');
  assert.equal(params.width, 420);
  assert.equal(params.fit, 'cover');
  assert.equal(failed.status, 403);
  assert.equal(failed.errorMessage, 'Source image returned HTTP 403');
});

test('api handler falls back to the original image when processing fails', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('original'),
      contentType: 'image/png',
    }),
    processImageImpl: async () => {
      throw new Error('decode failed');
    },
  });
  const res = createMockResponse();

  await handler(createImageRequest('https://example.com/photo.png'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-processing-error'], 'decode failed');
  assert.equal(res.body.toString(), 'original');
});

test('api handler returns jpeg content type for format=jpeg', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('source'),
      contentType: 'image/png',
    }),
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from(`jpeg:${params.width}`),
      metadata: {
        width: params.width,
        height: 400,
        format: 'jpeg',
        size: 5432,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.png', {
      width: '600',
      format: 'jpeg',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-image-format'], 'jpeg');
  assert.equal(res.headers['x-image-width'], '600');
  assert.equal(res.body.toString(), 'jpeg:600');
});

test('api handler returns json metadata for format=json', async () => {
  let fetchImageCalled = false;
  let processImageCalled = false;
  const handler = createImageHandler({
    fetchImageImpl: async () => {
      fetchImageCalled = true;
      throw new Error('fetchImage should not be called for image metadata');
    },
    processImageImpl: async () => {
      processImageCalled = true;
      throw new Error('processImage should not be called for image metadata');
    },
    probeImageMetadataFromUrlImpl: async (url) => {
      assert.equal(url, 'https://example.com/photo.jpg');
      return {
        width: 800,
        height: 600,
        format: 'jpeg',
        channels: 3,
        sourceContentType: 'image/jpeg',
        sourceSize: 123456,
      };
    },
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.jpg', {
      width: '800',
      height: '600',
      format: 'json',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');

  assert.deepEqual(JSON.parse(res.body.toString()), {
    width: 800,
    height: 600,
    format: 'jpeg',
    channels: 3,
    sourceUrl: 'https://example.com/photo.jpg',
    sourceContentType: 'image/jpeg',
    sourceSize: 123456,
  });
  assert.equal(fetchImageCalled, false);
  assert.equal(processImageCalled, false);
});

test('api handler preserves encoded source URL query values after one path decode', async () => {
  const sourceUrl = 'https://example.com/photo.jpg?token=a%2Fb&name=A%2BB';
  const handler = createImageHandler({
    fetchImageImpl: async (url) => {
      assert.equal(url, sourceUrl);
      return {
        buffer: Buffer.from('source'),
        contentType: 'image/jpeg',
      };
    },
    processImageImpl: async () => ({
      buffer: Buffer.from('webp-output'),
      metadata: {
        width: 200,
        height: 100,
        format: 'webp',
        size: 4321,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(createImageRequest(sourceUrl, { width: '200' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'webp-output');
});

test('api handler accepts internal rewrite source query parameter', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async (url) => {
      assert.equal(url, 'https://example.com/rewrite.jpg');
      return {
        buffer: Buffer.from('source'),
        contentType: 'image/jpeg',
      };
    },
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from(`webp:${params.width}`),
      metadata: {
        width: params.width,
        height: 180,
        format: 'webp',
        size: 2345,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(
    {
      method: 'GET',
      query: {
        source: encodeURIComponent('https://example.com/rewrite.jpg'),
        width: '320',
      },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'webp:320');
});

test('api handler returns png content type for format=png', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('source'),
      contentType: 'image/jpeg',
    }),
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from(`png:${params.width}`),
      metadata: {
        width: params.width,
        height: 300,
        format: 'png',
        size: 9999,
        channels: 4,
      },
    }),
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.jpg', {
      width: '400',
      format: 'png',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-image-format'], 'png');
  assert.equal(res.headers['x-image-channels'], undefined);
});

test('api handler returns avif content type for format=avif', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('source'),
      contentType: 'image/jpeg',
    }),
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from(`avif:${params.width}`),
      metadata: {
        width: params.width,
        height: 200,
        format: 'avif',
        size: 7777,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.jpg', {
      width: '300',
      format: 'avif',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/avif');
  assert.equal(res.headers['x-image-format'], 'avif');
});

test('api handler extracts video frame for video/mp4 source', async () => {
  const handler = createImageHandler({
    extractVideoFrameRangeImpl: async (url) => {
      assert.equal(url, 'https://example.com/clip.mp4');
      return Buffer.from('extracted-frame');
    },
    processImageImpl: async (buffer, params) => {
      assert.equal(buffer.toString(), 'extracted-frame');
      assert.equal(params.sourceContentType, 'image/png');
      return {
        buffer: Buffer.from(`webp:${params.width}`),
        metadata: {
          width: params.width || 1024,
          height: 576,
          format: 'webp',
          size: 8900,
          channels: 3,
        },
      };
    },
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/clip.mp4', {
      width: '800',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.headers['x-image-width'], '800');
  assert.equal(res.body.toString(), 'webp:800');
});

test('api handler extracts video frame for video/webm source', async () => {
  const handler = createImageHandler({
    extractVideoFrameRangeImpl: async () => Buffer.from('extracted-frame'),
    processImageImpl: async (_buffer, params) => ({
      buffer: Buffer.from('webp-output'),
      metadata: {
        width: params.width || 1024,
        height: 576,
        format: 'webp',
        size: 5000,
        channels: 3,
      },
    }),
  });
  const res = createMockResponse();

  await handler(createImageRequest('https://example.com/clip.webm'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
});

test('api handler returns video metadata for format=json with video source', async () => {
  const handler = createImageHandler({
    probeVideoMetadataFromUrlImpl: async (url) => {
      assert.equal(url, 'https://example.com/clip.mp4');
      return {
        width: 1920,
        height: 1080,
        codec: 'h264',
        duration: 10.5,
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        sourceSize: 987654,
      };
    },
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/clip.mp4', {
      format: 'json',
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');

  assert.deepEqual(JSON.parse(res.body.toString()), {
    width: 1920,
    height: 1080,
    codec: 'h264',
    duration: 10.5,
    format: 'mov,mp4,m4a,3gp,3g2,mj2',
    sourceUrl: 'https://example.com/clip.mp4',
    sourceSize: 987654,
  });
});

test('api handler returns 502 when video frame extraction fails', async () => {
  const handler = createImageHandler({
    extractVideoFrameRangeImpl: async () => {
      throw new Error('ffmpeg frame extraction failed');
    },
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/bad.mp4', {
      width: '400',
    }),
    res,
  );

  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /Bad Gateway/);
});

test('api handler returns 502 when video probe fails for format=json', async () => {
  const handler = createImageHandler({
    probeVideoMetadataFromUrlImpl: async () => {
      throw new Error('No video stream found');
    },
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/bad.webm', {
      format: 'json',
    }),
    res,
  );

  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /Bad Gateway/);
});

function createImageRequest(sourceUrl, query = {}, overrides = {}) {
  const searchParams = new URLSearchParams(query);
  const queryString = searchParams.toString();

  return {
    method: 'GET',
    url: `/api/image/${encodeURIComponent(sourceUrl)}${queryString ? `?${queryString}` : ''}`,
    ...overrides,
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) {
        this.chunks.push(Buffer.from(chunk));
      }
      this.body = Buffer.concat(this.chunks);
    },
    body: Buffer.alloc(0),
  };
}
