import { spawn } from 'node:child_process';
import { noopImageLogger } from './image-logger.js';

export const DEFAULT_VIDEO_TIMEOUT_MS = 30000;

export class VideoProcessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VideoProcessError';
    this.cause = options.cause;
  }
}

let ffmpegPathPromise;
let ffprobePathPromise;

export async function getFfmpegPath() {
  if (!ffmpegPathPromise) {
    ffmpegPathPromise = import('ffmpeg-static').then((m) => m.default || m);
  }
  return ffmpegPathPromise;
}

export async function getFfprobePath() {
  if (!ffprobePathPromise) {
    ffprobePathPromise = import('ffprobe-static').then((m) => {
      const mod = m.default || m;
      return mod.path || mod;
    });
  }
  return ffprobePathPromise;
}

export async function probeVideoMetadata(sourceBuffer, options = {}) {
  const logger = options.logger || noopImageLogger;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const ffprobePath = options.ffprobePath || (await getFfprobePath());
  const runProcessFn = options.runProcess || runProcess;
  const startedAt = Date.now();

  logger.info('video.probe.start', {
    sourceBytes: sourceBuffer.length,
    timeoutMs,
  });

  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-',
  ];

  const result = await runProcessFn(ffprobePath, args, sourceBuffer, { timeoutMs });

  if (result.exitCode !== 0) {
    logger.warn('video.probe.failed', {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });

    throw new VideoProcessError(
      `ffprobe exited with code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    );
  }

  let probeData;
  try {
    probeData = JSON.parse(result.stdout);
  } catch {
    throw new VideoProcessError('ffprobe output was not valid JSON');
  }

  const videoStream = findVideoStream(probeData);
  if (!videoStream) {
    throw new VideoProcessError('No video stream found in source');
  }

  const metadata = {
    width: videoStream.width,
    height: videoStream.height,
    codec: videoStream.codec_name || '',
    duration: extractDuration(probeData, videoStream),
    format: extractFormatName(probeData),
  };

  logger.info('video.probe.done', {
    ...metadata,
    durationMs: Date.now() - startedAt,
  });

  return metadata;
}

export async function extractVideoFrame(sourceBuffer, options = {}) {
  const logger = options.logger || noopImageLogger;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const ffmpegPath = options.ffmpegPath || (await getFfmpegPath());
  const runProcessFn = options.runProcess || runProcess;
  const startedAt = Date.now();

  logger.info('video.frame.extract_start', {
    sourceBytes: sourceBuffer.length,
    timeoutMs,
  });

  const args = [
    '-i', 'pipe:0',
    '-vframes', '1',
    '-f', 'image2',
    '-vcodec', 'png',
    '-y',
    'pipe:1',
  ];

  const result = await runProcessFn(ffmpegPath, args, sourceBuffer, { timeoutMs });

  if (result.exitCode !== 0) {
    logger.warn('video.frame.extract_failed', {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });

    throw new VideoProcessError(
      `ffmpeg frame extraction exited with code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    );
  }

  if (result.stdout.length === 0) {
    throw new VideoProcessError('ffmpeg frame extraction produced no output');
  }

  logger.info('video.frame.extract_done', {
    outputBytes: result.stdout.length,
    durationMs: Date.now() - startedAt,
  });

  return Buffer.from(result.stdout);
}

export function runProcess(command, args, stdinBuffer, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdinClosed = false;

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    proc.stdin.on('error', (error) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
        stdinClosed = true;
        return;
      }
      stdinClosed = true;
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new VideoProcessError(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(new VideoProcessError(`Failed to spawn process: ${error.message}`, { cause: error }));
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;

    function writeNextChunk() {
      if (stdinClosed) {
        try { proc.stdin.end(); } catch { /* ignored */ }
        return;
      }

      while (offset < stdinBuffer.length && !stdinClosed) {
        const chunk = stdinBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, stdinBuffer.length));
        const canContinue = proc.stdin.write(chunk);
        offset += chunk.length;

        if (!canContinue) {
          proc.stdin.once('drain', writeNextChunk);
          return;
        }
      }

      if (offset >= stdinBuffer.length && !stdinClosed) {
        try { proc.stdin.end(); } catch { /* ignored */ }
      }
    }

    writeNextChunk();
  });
}

function findVideoStream(probeData) {
  const streams = probeData.streams || [];
  return streams.find((s) => s.codec_type === 'video') || null;
}

function extractDuration(probeData, videoStream) {
  if (probeData.format?.duration) {
    return Number(probeData.format.duration);
  }
  if (videoStream.duration) {
    return Number(videoStream.duration);
  }
  return undefined;
}

function extractFormatName(probeData) {
  return probeData.format?.format_name || '';
}
