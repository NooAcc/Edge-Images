import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VideoProcessError,
  extractVideoFrameRange,
  probeVideoMetadataFromUrl,
} from '../lib/process-video.js';

function createMockRunProcess(overrides = {}) {
  return async function mockRunProcess(_command, _args, _stdinBuffer, _options) {
    if (overrides.error) {
      throw overrides.error;
    }
    return {
      exitCode: overrides.exitCode ?? 0,
      stdout: overrides.stdout ?? Buffer.alloc(0),
      stderr: overrides.stderr ?? '',
    };
  };
}

function createMockFetch(responses = []) {
  let callIndex = 0;
  return async function mockFetch(url, options = {}) {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;

    const isRangeRequest = options.headers?.Range || options.headers?.range;
    if (isRangeRequest && response.rangeStatus) {
      return {
        status: response.rangeStatus,
        ok: response.rangeStatus === 200,
        headers: {
          get: (name) => {
            const normalized = name.toLowerCase();
            if (normalized === 'content-type') return response.rangeContentType || 'video/mp4';
            if (normalized === 'content-length') {
              return String(getByteLength(response.rangeBody));
            }
            if (normalized === 'content-range') return response.rangeContentRange || null;
            return null;
          },
        },
        arrayBuffer: async () => response.rangeBody || new ArrayBuffer(0),
      };
    }

    return {
      status: response.status || 200,
      ok: (response.status || 200) >= 200 && (response.status || 200) < 300,
      headers: {
        get: (name) => {
          const normalized = name.toLowerCase();
          if (normalized === 'content-type') return response.contentType || 'video/mp4';
          if (normalized === 'content-length') return String(getByteLength(response.body));
          if (normalized === 'content-range') return response.contentRange || null;
          return null;
        },
      },
      arrayBuffer: async () => response.body || new ArrayBuffer(0),
    };
  };
}

function getByteLength(value) {
  return value?.byteLength ?? value?.length ?? 0;
}

test('probeVideoMetadataFromUrl returns metadata from Range response', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        duration: '10.5',
      },
    ],
    format: {
      duration: '10.5',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
  };

  const metadata = await probeVideoMetadataFromUrl('https://example.com/clip.mp4', {
    ffprobePath: '/usr/bin/ffprobe',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 206,
        rangeContentType: 'video/mp4',
        rangeBody: new ArrayBuffer(512 * 1024),
        rangeContentRange: `bytes 0-${512 * 1024 - 1}/${2 * 1024 * 1024}`,
      },
    ]),
    runProcess: createMockRunProcess({
      stdout: Buffer.from(JSON.stringify(probeData)),
    }),
  });

  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.codec, 'h264');
  assert.equal(metadata.duration, 10.5);
  assert.equal(metadata.format, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.equal(metadata.sourceSize, 2 * 1024 * 1024);
});

test('probeVideoMetadataFromUrl falls back to full download when partial probe fails', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1280,
        height: 720,
      },
    ],
    format: {
      duration: '30.2',
      format_name: 'matroska,webm',
    },
  };

  let processCallCount = 0;
  const mockRunProcess = async () => {
    processCallCount++;
    if (processCallCount === 1) {
      throw new VideoProcessError('No video stream found in source');
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(probeData)),
      stderr: '',
    };
  };

  const metadata = await probeVideoMetadataFromUrl('https://example.com/clip.webm', {
    ffprobePath: '/usr/bin/ffprobe',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 206,
        rangeContentType: 'video/webm',
        rangeBody: new ArrayBuffer(512 * 1024),
        rangeContentRange: `bytes 0-${512 * 1024 - 1}/${1024 * 1024}`,
      },
      {
        status: 200,
        contentType: 'video/webm',
        body: new ArrayBuffer(1024 * 1024),
      },
    ]),
    runProcess: mockRunProcess,
  });

  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
  assert.equal(metadata.sourceSize, 1024 * 1024);
  assert.equal(processCallCount, 2);
});

test('probeVideoMetadataFromUrl uses full source size when Range is ignored', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'vp9',
        width: 640,
        height: 360,
      },
    ],
    format: {
      duration: '8.4',
      format_name: 'matroska,webm',
    },
  };

  const metadata = await probeVideoMetadataFromUrl('https://example.com/clip.webm', {
    ffprobePath: '/usr/bin/ffprobe',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 200,
        rangeContentType: 'video/webm',
        rangeBody: new ArrayBuffer(768 * 1024),
      },
    ]),
    runProcess: createMockRunProcess({
      stdout: Buffer.from(JSON.stringify(probeData)),
    }),
  });

  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 360);
  assert.equal(metadata.codec, 'vp9');
  assert.equal(metadata.sourceSize, 768 * 1024);
});

test('extractVideoFrameRange returns frame from Range response', async () => {
  const framePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const result = await extractVideoFrameRange('https://example.com/clip.mp4', {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 206,
        rangeContentType: 'video/mp4',
        rangeBody: new ArrayBuffer(512 * 1024),
      },
    ]),
    runProcess: createMockRunProcess({
      stdout: framePng,
    }),
  });

  assert.ok(Buffer.isBuffer(result));
  assert.equal(result[0], 0x89);
  assert.equal(result[1], 0x50);
});

test('extractVideoFrameRange falls back to full download when partial decode fails', async () => {
  const framePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  let processCallCount = 0;
  const mockRunProcess = async () => {
    processCallCount++;
    if (processCallCount === 1) {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'Invalid data found' };
    }
    return { exitCode: 0, stdout: framePng, stderr: '' };
  };

  const result = await extractVideoFrameRange('https://example.com/clip.mp4', {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 206,
        rangeContentType: 'video/mp4',
        rangeBody: new ArrayBuffer(512 * 1024),
      },
      {
        status: 200,
        contentType: 'video/mp4',
        body: new ArrayBuffer(1024 * 1024),
      },
    ]),
    runProcess: mockRunProcess,
  });

  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.length, 6);
  assert.equal(processCallCount, 2);
});

test('extractVideoFrameRange uses full download when server does not support Range', async () => {
  const framePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const result = await extractVideoFrameRange('https://example.com/clip.mp4', {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: createMockFetch([
      {
        rangeStatus: 200,
        rangeContentType: 'video/mp4',
        rangeBody: new ArrayBuffer(1024 * 1024),
      },
    ]),
    runProcess: createMockRunProcess({
      stdout: framePng,
    }),
  });

  assert.ok(Buffer.isBuffer(result));
});

test('extractVideoFrameRange throws VideoProcessError for non-video Content-Type', async () => {
  await assert.rejects(
    () =>
      extractVideoFrameRange('https://example.com/not-video.html', {
        ffmpegPath: '/usr/bin/ffmpeg',
        fetchImpl: createMockFetch([
          {
            rangeStatus: 200,
            rangeContentType: 'text/html',
            rangeBody: new ArrayBuffer(100),
          },
        ]),
        runProcess: createMockRunProcess(),
      }),
    /did not return a video/,
  );
});

test('extractVideoFrameRange throws when ffmpeg fails with full download', async () => {
  await assert.rejects(
    () =>
      extractVideoFrameRange('https://example.com/bad.mp4', {
        ffmpegPath: '/usr/bin/ffmpeg',
        fetchImpl: createMockFetch([
          {
            rangeStatus: 200,
            rangeContentType: 'video/mp4',
            rangeBody: new ArrayBuffer(1024),
          },
        ]),
        runProcess: createMockRunProcess({
          exitCode: 1,
          stderr: 'Conversion failed',
        }),
      }),
    VideoProcessError,
  );
});
