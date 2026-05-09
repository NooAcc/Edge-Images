import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_IMAGE_METADATA_BYTES,
  ImageFetchError,
  fetchImage,
  fetchImageMetadataRange,
} from '../lib/fetch-image.js';
import { createImageLogger } from '../lib/image-logger.js';
import { createCaptureSink } from './helpers/capture-logs.js';

test('fetchImage downloads an image buffer', async () => {
  const result = await fetchImage('https://example.com/photo.jpg', {
    fetchImpl: async () =>
      fakeResponse({
        body: Buffer.from('jpeg'),
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '4',
        },
      }),
  });

  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.buffer.toString(), 'jpeg');
  assert.equal(result.status, 200);
});

test('fetchImage sends browser-like image request headers', async () => {
  let requestOptions;

  const result = await fetchImage('https://example.com/photo.avif', {
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return fakeResponse({
        body: Buffer.from('avif'),
        headers: {
          'content-type': 'image/avif',
          'content-length': '4',
        },
      });
    },
  });

  assert.equal(result.contentType, 'image/avif');
  assert.match(requestOptions.headers.Accept, /^image\/avif,image\/webp/);
  assert.match(requestOptions.headers['User-Agent'], /Mozilla\/5\.0 .* Chrome\/124\.0/);
  assert.equal(requestOptions.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
  assert.equal(requestOptions.headers.Referer, 'https://example.com/');
});

test('fetchImageMetadataRange requests only the image metadata prefix', async () => {
  let requestOptions;

  const result = await fetchImageMetadataRange('https://example.com/photo.jpg', {
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return fakeStreamResponse({
        status: 206,
        ok: true,
        body: createStreamBody([Buffer.from('jpeg')]),
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '4',
          'content-range': 'bytes 0-3/12345',
        },
      });
    },
  });

  assert.equal(requestOptions.headers.Range, 'bytes=0-5119');
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.buffer.toString(), 'jpeg');
  assert.equal(result.sourceSize, 12345);
  assert.equal(result.status, 206);
});

test('fetchImageMetadataRange stops after 5KB when Range is ignored', async () => {
  const body = createStreamBody(createFixedChunks(10, 1024));

  const result = await fetchImageMetadataRange('https://example.com/photo.jpg', {
    fetchImpl: async () =>
      fakeStreamResponse({
        status: 200,
        ok: true,
        body,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(10 * 1024),
        },
      }),
  });

  assert.equal(result.buffer.length, DEFAULT_IMAGE_METADATA_BYTES);
  assert.equal(result.sourceSize, 10 * 1024);
  assert.equal(body.readCount, 5);
  assert.equal(body.cancelled, true);
});

test('fetchImageMetadataRange returns null source size without size headers', async () => {
  const result = await fetchImageMetadataRange('https://example.com/photo.jpg', {
    fetchImpl: async () =>
      fakeStreamResponse({
        status: 200,
        ok: true,
        body: createStreamBody([Buffer.from('jpeg')]),
        headers: {
          'content-type': 'image/jpeg',
        },
      }),
  });

  assert.equal(result.buffer.length, 4);
  assert.equal(result.sourceSize, null);
});

test('fetchImageMetadataRange does not trust partial content-length as source size', async () => {
  const result = await fetchImageMetadataRange('https://example.com/photo.jpg', {
    fetchImpl: async () =>
      fakeStreamResponse({
        status: 206,
        ok: true,
        body: createStreamBody([Buffer.from('jpeg')]),
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '4',
        },
      }),
  });

  assert.equal(result.buffer.length, 4);
  assert.equal(result.sourceSize, null);
});

test('fetchImage rejects non-2xx responses', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/missing.jpg', {
        fetchImpl: async () => fakeResponse({ status: 404, ok: false }),
      }),
    ImageFetchError,
  );
});

test('fetchImage logs source response details before rejecting bad status', async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: '1' },
    sink: capture.sink,
    requestId: 'req_fetch_403',
  });

  await assert.rejects(
    () =>
      fetchImage('https://example.com/photo.avif', {
        logger,
        fetchImpl: async () =>
          fakeResponse({
            status: 403,
            ok: false,
            headers: {
              'content-type': 'image/avif',
              'content-length': '0',
            },
          }),
      }),
    /HTTP 403/,
  );

  const records = capture.records();
  const response = records.find((record) => record.event === 'image.source.fetch_response');
  const rejected = records.find((record) => record.event === 'image.source.fetch_bad_status');

  assert.equal(response.status, 403);
  assert.equal(response.contentType, 'image/avif');
  assert.equal(response.sourceHost, 'example.com');
  assert.equal(rejected.status, 403);
});

test('fetchImage rejects non-image content', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/index.html', {
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from('<html></html>'),
            headers: { 'content-type': 'text/html' },
          }),
      }),
    /did not return an image/,
  );
});

test('fetchImage rejects video content types', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/clip.mp4', {
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from('mp4'),
            headers: {
              'content-type': 'video/mp4',
              'content-length': '3',
            },
          }),
      }),
    /did not return an image/,
  );
});

test('fetchImage enforces source size limits', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/huge.jpg', {
        maxBytes: 3,
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from('1234'),
            headers: {
              'content-type': 'image/jpeg',
              'content-length': '4',
            },
          }),
      }),
    /exceeds/,
  );
});

test('fetchImage aborts slow downloads', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/slow.jpg', {
        timeoutMs: 1,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      }),
    /timed out/,
  );
});

test('fetchImage aborts slow response bodies', async () => {
  await assert.rejects(
    () =>
      fetchImage('https://example.com/slow-body.jpg', {
        timeoutMs: 1,
        fetchImpl: async (_url, { signal }) => ({
          status: 200,
          ok: true,
          headers: {
            get(name) {
              return name.toLowerCase() === 'content-type' ? 'image/jpeg' : undefined;
            },
          },
          async arrayBuffer() {
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            });
          },
        }),
      }),
    /timed out/,
  );
});

function fakeResponse({ status = 200, ok = true, body = Buffer.alloc(0), headers = {} } = {}) {
  return {
    status,
    ok,
    headers: {
      get(name) {
        return headers[name.toLowerCase()];
      },
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

function fakeStreamResponse({ status = 200, ok = true, body, headers = {} } = {}) {
  return {
    status,
    ok,
    headers: {
      get(name) {
        return headers[name.toLowerCase()];
      },
    },
    body,
  };
}

function createStreamBody(chunks) {
  let index = 0;
  const body = {
    cancelled: false,
    readCount: 0,
    getReader() {
      return {
        async read() {
          if (body.cancelled || index >= chunks.length) {
            return { done: true };
          }

          body.readCount++;
          const value = chunks[index];
          index++;
          return { done: false, value };
        },
        async cancel() {
          body.cancelled = true;
        },
        releaseLock() {},
      };
    },
  };

  return body;
}

function createFixedChunks(count, size) {
  return Array.from({ length: count }, (_item, index) => Buffer.alloc(size, index));
}
