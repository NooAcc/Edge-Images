import { spawn } from 'node:child_process';
import { noopImageLogger } from './image-logger.js';
import { buildImageFetchHeaders } from './fetch-image.js';

export const DEFAULT_VIDEO_TIMEOUT_MS = 30000;
export const DEFAULT_VIDEO_RANGE_SIZE = 512 * 1024;
const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/webm']);

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

export async function probeVideoMetadataFromUrl(url, options = {}) {
  const logger = options.logger || noopImageLogger;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const ffprobePath = options.ffprobePath || (await getFfprobePath());
  const runProcessFn = options.runProcess || runProcess;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const rangeSize = options.rangeSize || DEFAULT_VIDEO_RANGE_SIZE;
  const startedAt = Date.now();

  logger.info('video.probe.start', { url, timeoutMs });

  const { buffer: partialBuffer, bytesDownloaded } = await fetchWithRangeFallback(
    url,
    { fetchImpl, rangeSize, logger, timeoutMs },
  );

  try {
    const metadata = await probeVideoMetadata(partialBuffer, {
      ffprobePath,
      runProcess: runProcessFn,
      timeoutMs,
      logger,
    });

    logger.info('video.probe.done', {
      ...metadata,
      bytesDownloaded,
      durationMs: Date.now() - startedAt,
    });

    return { ...metadata, bytesDownloaded };
  } catch {
    if (partialBuffer.length >= bytesDownloaded) {
      throw new VideoProcessError('No video stream found in source');
    }

    logger.info('video.probe.range_fallback', { reason: 'partial probe failed' });

    const { buffer: fullBuffer } = await fetchFull(url, { fetchImpl, logger, timeoutMs });
    const metadata = await probeVideoMetadata(fullBuffer, {
      ffprobePath,
      runProcess: runProcessFn,
      timeoutMs,
      logger,
    });

    logger.info('video.probe.done', {
      ...metadata,
      bytesDownloaded: fullBuffer.length,
      durationMs: Date.now() - startedAt,
    });

    return { ...metadata, bytesDownloaded: fullBuffer.length };
  }
}

async function probeVideoMetadata(sourceBuffer, options = {}) {
  const logger = options.logger || noopImageLogger;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const ffprobePath = options.ffprobePath || (await getFfprobePath());
  const runProcessFn = options.runProcess || runProcess;

  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-',
  ];

  const result = await runProcessFn(ffprobePath, args, sourceBuffer, { timeoutMs });

  if (result.exitCode !== 0) {
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

  return {
    width: videoStream.width,
    height: videoStream.height,
    codec: videoStream.codec_name || '',
    duration: extractDuration(probeData, videoStream),
    format: extractFormatName(probeData),
  };
}

export async function extractVideoFrameRange(url, options = {}) {
  const logger = options.logger || noopImageLogger;
  const ffmpegPath = options.ffmpegPath || (await getFfmpegPath());
  const runProcessFn = options.runProcess || runProcess;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const rangeSize = options.rangeSize || DEFAULT_VIDEO_RANGE_SIZE;
  const startedAt = Date.now();

  logger.info('video.frame.range_start', { url, rangeSize });

  const { buffer: partialBuffer, bytesDownloaded } = await fetchWithRangeFallback(
    url,
    { fetchImpl, rangeSize, logger, timeoutMs },
  );

  try {
    const frame = await extractVideoFrame(partialBuffer, {
      ffmpegPath,
      runProcess: runProcessFn,
      timeoutMs,
      logger,
    });

    logger.info('video.frame.range_done', {
      outputBytes: frame.length,
      bytesDownloaded,
      durationMs: Date.now() - startedAt,
    });

    return frame;
  } catch {
    if (partialBuffer.length >= bytesDownloaded) {
      throw new VideoProcessError('ffmpeg frame extraction failed with full download');
    }

    logger.info('video.frame.range_fallback', { reason: 'partial decode failed' });

    const { buffer: fullBuffer } = await fetchFull(url, { fetchImpl, logger, timeoutMs });
    const frame = await extractVideoFrame(fullBuffer, {
      ffmpegPath,
      runProcess: runProcessFn,
      timeoutMs,
      logger,
    });

    logger.info('video.frame.range_done', {
      outputBytes: frame.length,
      bytesDownloaded: fullBuffer.length,
      durationMs: Date.now() - startedAt,
    });

    return frame;
  }
}

async function extractVideoFrame(sourceBuffer, options = {}) {
  const logger = options.logger || noopImageLogger;
  const timeoutMs = options.timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS;
  const ffmpegPath = options.ffmpegPath || (await getFfmpegPath());
  const runProcessFn = options.runProcess || runProcess;

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
  });

  return Buffer.from(result.stdout);
}

async function fetchWithRangeFallback(url, options = {}) {
  const { fetchImpl = globalThis.fetch, rangeSize = DEFAULT_VIDEO_RANGE_SIZE, logger = noopImageLogger, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      ...buildImageFetchHeaders(url),
      Range: `bytes=0-${rangeSize - 1}`,
    };

    const response = await fetchImpl(url, { signal: controller.signal, headers });

    if (response.status === 206) {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      logger.info('video.fetch.range_partial', {
        url,
        bytes: buffer.length,
        status: response.status,
      });

      clearTimeout(timeout);
      return { buffer, bytesDownloaded: buffer.length };
    }

    const contentType = response.headers?.get?.('content-type')?.split(';')[0]?.trim() || '';
    if (contentType && !VIDEO_CONTENT_TYPES.has(contentType.toLowerCase())) {
      clearTimeout(timeout);
      throw new VideoProcessError(`Source URL did not return a video (got ${contentType})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info('video.fetch.full', {
      url,
      bytes: buffer.length,
      reason: 'server does not support Range',
    });

    clearTimeout(timeout);
    return { buffer, bytesDownloaded: buffer.length };
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof VideoProcessError) throw error;
    throw new VideoProcessError(`Video fetch failed: ${error.message}`, { cause: error });
  }
}

async function fetchFull(url, options = {}) {
  const { fetchImpl = globalThis.fetch, logger = noopImageLogger, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = buildImageFetchHeaders(url);
    const response = await fetchImpl(url, { signal: controller.signal, headers });

    if (!response.ok) {
      throw new VideoProcessError(`Video fetch returned HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info('video.fetch.full', {
      url,
      bytes: buffer.length,
      reason: 'fallback from Range',
    });

    clearTimeout(timeout);
    return { buffer, bytesDownloaded: buffer.length };
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof VideoProcessError) throw error;
    throw new VideoProcessError(`Video fetch failed: ${error.message}`, { cause: error });
  }
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
