import assert from 'node:assert/strict';
import test from 'node:test';

import { createImageLogger, isImageDebugLoggingEnabled } from '../lib/image-logger.js';
import { createCaptureSink } from './helpers/capture-logs.js';

test('isImageDebugLoggingEnabled accepts explicit enabled values', () => {
  assert.equal(isImageDebugLoggingEnabled({ IMAGE_DEBUG_LOGS: '1' }), true);
  assert.equal(isImageDebugLoggingEnabled({ IMAGE_DEBUG_LOGS: 'true' }), true);
  assert.equal(isImageDebugLoggingEnabled({ IMAGE_DEBUG_LOGS: 'on' }), true);
  assert.equal(isImageDebugLoggingEnabled({ IMAGE_DEBUG_LOGS: '0' }), false);
});

test('createImageLogger stays silent when debug logging is disabled', () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: {},
    sink: capture.sink,
    requestId: 'req_disabled',
  });

  logger.info('image.test.event', { value: 1 });

  assert.equal(capture.lines.length, 0);
});

test('createImageLogger writes structured records when enabled', () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: '1' },
    sink: capture.sink,
    requestId: 'req_enabled',
    base: { route: '/api/media' },
  }).child({ sourceHost: 'example.com' });

  logger.warn('image.test.event', {
    error: new Error('sample failure'),
    bytes: 42,
  });

  const [record] = capture.records();
  assert.equal(record.level, 'warn');
  assert.equal(record.event, 'image.test.event');
  assert.equal(record.requestId, 'req_enabled');
  assert.equal(record.route, '/api/media');
  assert.equal(record.sourceHost, 'example.com');
  assert.equal(record.errorName, 'Error');
  assert.equal(record.errorMessage, 'sample failure');
  assert.equal(record.bytes, 42);
});
