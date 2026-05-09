import assert from 'node:assert/strict';
import test from 'node:test';

import { createImageLogger } from '../lib/image-logger.js';
import {
  buildResizeOptions,
  probeImageMetadataFromUrl,
  processImage,
} from '../lib/process-image.js';
import { createFakeSharp, decodeOutput, makeImageBytes } from './helpers/fake-sharp.js';
import { createCaptureSink } from './helpers/capture-logs.js';

test('buildResizeOptions uses sharp native inside fit as the default cap', () => {
  assert.deepEqual(
    buildResizeOptions({
      fit: 'inside',
      background: [255, 255, 255],
    }),
    {
      width: 1024,
      height: 1024,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    },
  );
});

test('buildResizeOptions passes sharp native fit options directly', () => {
  assert.deepEqual(
    buildResizeOptions({
      width: 800,
      height: 600,
      fit: 'cover',
      background: [255, 255, 255],
    }),
    {
      width: 800,
      height: 600,
      fit: 'cover',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    },
  );
});

test('buildResizeOptions adds background only for native contain', () => {
  assert.deepEqual(
    buildResizeOptions({
      width: 500,
      height: 500,
      fit: 'contain',
      background: [255, 0, 0],
    }),
    {
      width: 500,
      height: 500,
      fit: 'contain',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  );
});

test('processImage uses one native sharp resize and fastest WebP effort', async () => {
  const log = [];
  const { buffer, metadata } = await processImage(
    makeImageBytes(2048, 1536),
    {
      width: 800,
      height: 600,
      fit: 'cover',
      quality: 50,
      background: [255, 255, 255],
      flip: '',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(log),
    },
  );

  const decoded = decodeOutput(buffer);
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.format, 'webp');
  assert.equal(decoded.quality, 50);
  assert.equal(decoded.formatOptions.effort, 0);
  assert.deepEqual(
    log.filter((entry) => entry.op),
    [
      {
        op: 'resize',
        from: [2048, 1536],
        to: [800, 600],
        options: {
          width: 800,
          height: 600,
          fit: 'cover',
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
        },
        fit: 'cover',
        background: undefined,
      },
    ],
  );
});

test('processImage native inside fit does not upscale smaller inputs', async () => {
  const { buffer, metadata } = await processImage(
    makeImageBytes(500, 500),
    {
      width: 1024,
      height: 1024,
      fit: 'inside',
      quality: 85,
      background: [255, 255, 255],
      flip: '',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  assert.equal(decodeOutput(buffer).width, 500);
  assert.equal(metadata.height, 500);
});

test('processImage enforces max size when dimensions are omitted', async () => {
  const { buffer, metadata } = await processImage(
    makeImageBytes(5000, 5000),
    {
      fit: 'inside',
      quality: 85,
      background: [255, 255, 255],
      flip: '',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  assert.equal(decodeOutput(buffer).width, 1024);
  assert.equal(metadata.height, 1024);
});

test('processImage native contain fills the canvas with the requested background', async () => {
  const { buffer, metadata } = await processImage(
    makeImageBytes(800, 400),
    {
      width: 500,
      height: 500,
      fit: 'contain',
      quality: 85,
      background: [255, 0, 0],
      flip: '',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  const decoded = decodeOutput(buffer);
  assert.equal(metadata.width, 500);
  assert.equal(metadata.height, 500);
  assert.deepEqual(decoded.firstPixel, [255, 0, 0, 255]);
});

test('processImage uses sharp native orientation operations', async () => {
  const log = [];
  const { buffer, metadata } = await processImage(
    makeImageBytes(300, 600),
    {
      width: 200,
      fit: 'inside',
      quality: 85,
      rotate: 90,
      flip: 'hv',
      background: [255, 255, 255],
      format: 'webp',
    },
    {
      sharp: createFakeSharp(log),
    },
  );

  decodeOutput(buffer);
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 100);
  assert.deepEqual(
    log.map((entry) => entry.op),
    ['rotate', 'flip', 'flop', 'resize'],
  );
});

test('processImage logs sharp native transform plan', async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: '1' },
    sink: capture.sink,
    requestId: 'req_avif',
  });

  const { buffer, metadata } = await processImage(
    makeImageBytes(320, 180, { format: 'avif' }),
    {
      fit: 'inside',
      quality: 82,
      background: [255, 255, 255],
      flip: '',
      sourceContentType: 'image/avif',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(),
      logger,
    },
  );

  const decoded = decodeOutput(buffer);
  const records = capture.records();
  const plan = records.find((record) => record.event === 'image.transform.plan');

  assert.equal(decoded.width, 320);
  assert.equal(metadata.height, 180);
  assert.equal(decoded.quality, 82);
  assert.equal(plan.inputFormat, 'avif');
  assert.equal(plan.resize.fit, 'inside');
});

test('processImage encodes to jpeg format', async () => {
  const log = [];
  const { buffer, metadata } = await processImage(
    makeImageBytes(800, 600),
    {
      width: 400,
      fit: 'inside',
      quality: 75,
      background: [255, 255, 255],
      flip: '',
      format: 'jpeg',
    },
    {
      sharp: createFakeSharp(log),
    },
  );

  const decoded = decodeOutput(buffer);
  assert.equal(metadata.format, 'jpeg');
  assert.equal(decoded.outputFormat, 'jpeg');
  assert.equal(decoded.quality, 75);
});

test('processImage encodes to png format', async () => {
  const { buffer, metadata } = await processImage(
    makeImageBytes(800, 600),
    {
      width: 400,
      fit: 'inside',
      quality: 85,
      background: [255, 255, 255],
      flip: '',
      format: 'png',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  const decoded = decodeOutput(buffer);
  assert.equal(metadata.format, 'png');
  assert.equal(decoded.outputFormat, 'png');
});

test('processImage encodes to avif format', async () => {
  const { buffer, metadata } = await processImage(
    makeImageBytes(800, 600),
    {
      width: 400,
      fit: 'inside',
      quality: 70,
      background: [255, 255, 255],
      flip: '',
      format: 'avif',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  const decoded = decodeOutput(buffer);
  assert.equal(metadata.format, 'avif');
  assert.equal(decoded.outputFormat, 'avif');
  assert.equal(decoded.formatOptions.effort, 0);
});

test('probeImageMetadataFromUrl returns source metadata from the image prefix', async () => {
  let requestOptions;
  const imageBytes = makeImageBytes(800, 600, { format: 'png' });

  const metadata = await probeImageMetadataFromUrl('https://example.com/photo.png', {
    sharp: createFakeSharp(),
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return fakeStreamResponse({
        status: 206,
        ok: true,
        body: createStreamBody([imageBytes]),
        headers: {
          'content-type': 'image/png',
          'content-length': '5120',
          'content-range': `bytes 0-${imageBytes.length - 1}/98765`,
        },
      });
    },
  });

  assert.equal(requestOptions.headers.Range, 'bytes=0-5119');
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.channels, undefined);
  assert.equal(metadata.sourceContentType, 'image/png');
  assert.equal(metadata.sourceSize, 98765);
});

test('processImage returns metadata with width, height, format, size, and channels', async () => {
  const { metadata } = await processImage(
    makeImageBytes(800, 600),
    {
      width: 400,
      fit: 'inside',
      quality: 85,
      background: [255, 255, 255],
      flip: '',
      format: 'webp',
    },
    {
      sharp: createFakeSharp(),
    },
  );

  assert.equal(typeof metadata.width, 'number');
  assert.equal(typeof metadata.height, 'number');
  assert.equal(metadata.format, 'webp');
  assert.equal(typeof metadata.size, 'number');
  assert.equal(typeof metadata.channels, 'number');
});

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
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) {
            return { done: true };
          }

          const value = chunks[index];
          index++;
          return { done: false, value };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
}
