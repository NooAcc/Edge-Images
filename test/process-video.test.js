import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VideoProcessError,
  extractVideoFrame,
  probeVideoMetadata,
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

test('probeVideoMetadata returns width, height, codec, duration, and format from ffprobe output', async () => {
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

  const metadata = await probeVideoMetadata(Buffer.from('fake-video'), {
    ffprobePath: '/usr/bin/ffprobe',
    runProcess: createMockRunProcess({
      stdout: Buffer.from(JSON.stringify(probeData)),
    }),
  });

  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.codec, 'h264');
  assert.equal(metadata.duration, 10.5);
  assert.equal(metadata.format, 'mov,mp4,m4a,3gp,3g2,mj2');
});

test('probeVideoMetadata prefers format duration over stream duration', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'vp9',
        width: 1280,
        height: 720,
      },
    ],
    format: {
      duration: '30.2',
      format_name: 'matroska,webm',
    },
  };

  const metadata = await probeVideoMetadata(Buffer.from('fake-video'), {
    ffprobePath: '/usr/bin/ffprobe',
    runProcess: createMockRunProcess({
      stdout: Buffer.from(JSON.stringify(probeData)),
    }),
  });

  assert.equal(metadata.duration, 30.2);
});

test('probeVideoMetadata uses stream duration when format duration is missing', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 640,
        height: 480,
        duration: '5.0',
      },
    ],
    format: {
      format_name: 'mov,mp4',
    },
  };

  const metadata = await probeVideoMetadata(Buffer.from('fake-video'), {
    ffprobePath: '/usr/bin/ffprobe',
    runProcess: createMockRunProcess({
      stdout: Buffer.from(JSON.stringify(probeData)),
    }),
  });

  assert.equal(metadata.duration, 5.0);
});

test('probeVideoMetadata throws when no video stream is found', async () => {
  const probeData = {
    streams: [
      {
        codec_type: 'audio',
        codec_name: 'aac',
      },
    ],
    format: {},
  };

  await assert.rejects(
    () =>
      probeVideoMetadata(Buffer.from('fake-video'), {
        ffprobePath: '/usr/bin/ffprobe',
        runProcess: createMockRunProcess({
          stdout: Buffer.from(JSON.stringify(probeData)),
        }),
      }),
    /No video stream found/,
  );
});

test('probeVideoMetadata throws VideoProcessError when ffprobe exits non-zero', async () => {
  await assert.rejects(
    () =>
      probeVideoMetadata(Buffer.from('bad'), {
        ffprobePath: '/usr/bin/ffprobe',
        runProcess: createMockRunProcess({
          exitCode: 1,
          stderr: 'Invalid data found',
        }),
      }),
    VideoProcessError,
  );
});

test('probeVideoMetadata throws when ffprobe output is not valid JSON', async () => {
  await assert.rejects(
    () =>
      probeVideoMetadata(Buffer.from('bad'), {
        ffprobePath: '/usr/bin/ffprobe',
        runProcess: createMockRunProcess({
          stdout: Buffer.from('not json'),
        }),
      }),
    /not valid JSON/,
  );
});

test('extractVideoFrame returns a buffer from ffmpeg stdout', async () => {
  const framePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  const result = await extractVideoFrame(Buffer.from('fake-video'), {
    ffmpegPath: '/usr/bin/ffmpeg',
    runProcess: createMockRunProcess({
      stdout: framePng,
    }),
  });

  assert.ok(Buffer.isBuffer(result));
  assert.equal(result[0], 0x89);
  assert.equal(result[1], 0x50);
  assert.equal(result.length, 6);
});

test('extractVideoFrame throws VideoProcessError when ffmpeg exits non-zero', async () => {
  await assert.rejects(
    () =>
      extractVideoFrame(Buffer.from('bad'), {
        ffmpegPath: '/usr/bin/ffmpeg',
        runProcess: createMockRunProcess({
          exitCode: 1,
          stderr: 'Conversion failed',
        }),
      }),
    VideoProcessError,
  );
});

test('extractVideoFrame throws when ffmpeg produces no output', async () => {
  await assert.rejects(
    () =>
      extractVideoFrame(Buffer.from('bad'), {
        ffmpegPath: '/usr/bin/ffmpeg',
        runProcess: createMockRunProcess({
          stdout: Buffer.alloc(0),
        }),
      }),
    /produced no output/,
  );
});
