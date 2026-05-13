import assert from 'node:assert/strict';
import test from 'node:test';

import { createImageHandler } from '../api/image.js';
import { processImage } from '../lib/process-image.js';
import { decodeOutput, createFakeSharp, makeImageBytes } from './helpers/fake-sharp.js';

test('system: GET /api/image/<encoded-source-url> cover scenario reaches the expected output size', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: makeImageBytes(2048, 1536),
      contentType: 'image/jpeg',
    }),
    processImageImpl: async (buffer, params) =>
      processImage(buffer, params, {
        sharp: createFakeSharp(),
      }),
  });
  const res = createMockResponse();

  await handler(
    createImageRequest('https://example.com/photo.jpg', {
      width: '800',
      height: '600',
      fit: 'cover',
    }),
    res,
  );

  const metadata = decodeOutput(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.quality, 85);
});

test('system: corrupt downloaded image is returned as original fallback', async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from('not-json-image'),
      contentType: 'image/jpeg',
    }),
    processImageImpl: async (buffer, params) =>
      processImage(buffer, params, {
        sharp: createFakeSharp(),
      }),
  });
  const res = createMockResponse();

  await handler(createImageRequest('https://example.com/broken.jpg'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.match(res.headers['x-processing-error'], /Unexpected token/);
  assert.equal(res.body.toString(), 'not-json-image');
});

function createImageRequest(sourceUrl, query = {}) {
  const searchParams = new URLSearchParams(query);
  const queryString = searchParams.toString();

  return {
    method: 'GET',
    url: `/api/image/${encodeURIComponent(sourceUrl)}${queryString ? `?${queryString}` : ''}`,
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
