import { fetchImage } from "../lib/fetch-image.js";
import { createImageLogger } from "../lib/image-logger.js";
import { ParamError, parseParams } from "../lib/parse-params.js";
import { FORMAT_CONTENT_TYPES, processImage } from "../lib/process-image.js";
import { extractVideoFrameRange, probeVideoMetadataFromUrl } from "../lib/process-video.js";

export const CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PROCESSOR_NAME = "vercel-node-image";
const VIDEO_EXTENSIONS = /\.(mp4|webm)(\?.*)?$/i;

export function createImageHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage,
  probeVideoMetadataFromUrlImpl = probeVideoMetadataFromUrl,
  extractVideoFrameRangeImpl = extractVideoFrameRange,
  logger = console,
} = {}) {
  return async function imageHandler(req, res) {
    const requestLogger = createImageLogger({
      env: req.env,
      sink: logger,
      requestId: getRequestId(req),
      base: {
        route: "/api/image",
      },
    });

    requestLogger.info("image.request.start", {
      method: req.method || "GET",
      path: getRequestPath(req),
    });

    if (req.method && req.method !== "GET") {
      requestLogger.warn("image.request.method_not_allowed", {
        method: req.method,
      });
      return sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }

    let params;
    try {
      params = parseParams(extractQuery(req), { env: req.env });
    } catch (error) {
      if (error instanceof ParamError) {
        requestLogger.warn("image.request.param_error", {
          error,
        });
        return sendJson(res, 400, { error: error.message });
      }

      requestLogger.error("image.request.param_unexpected_error", {
        error,
      });
      return sendJson(res, 500, { error: "Internal Server Error" });
    }

    const isVideo = VIDEO_EXTENSIONS.test(params.url);

    requestLogger.info("image.request.params", {
      sourceUrl: params.url,
      sourceHost: getUrlHost(params.url),
      width: params.width,
      height: params.height,
      fit: params.fit,
      quality: params.quality,
      format: params.format,
      rotate: params.rotate,
      flip: params.flip || "",
      isVideo,
    });

    if (isVideo && params.format === "json") {
      try {
        const videoMetadata = await probeVideoMetadataFromUrlImpl(params.url, {
          logger: requestLogger,
        });

        requestLogger.info("image.request.success", {
          statusCode: 200,
          videoMetadata,
        });

        return sendJson(res, 200, {
          width: videoMetadata.width,
          height: videoMetadata.height,
          codec: videoMetadata.codec,
          duration: videoMetadata.duration,
          format: videoMetadata.format,
          sourceUrl: params.url,
          bytesDownloaded: videoMetadata.bytesDownloaded,
        });
      } catch (error) {
        requestLogger.warn("image.request.video_probe_failed", {
          error,
          sourceUrl: params.url,
        });

        return sendJson(res, 502, {
          error: "Bad Gateway",
          details: sanitizeHeaderValue(error?.message || "Video probe failed"),
        }, { "X-Processor": PROCESSOR_NAME });
      }
    }

    let imageBuffer;
    let sourceBytes;
    let sourceContentType;

    if (isVideo) {
      try {
        imageBuffer = await extractVideoFrameRangeImpl(params.url, {
          logger: requestLogger,
        });
        sourceBytes = imageBuffer.length;
        sourceContentType = "image/png";
      } catch (error) {
        requestLogger.warn("image.request.video_frame_failed", {
          error,
          sourceUrl: params.url,
        });

        return sendJson(res, 502, {
          error: "Bad Gateway",
          details: sanitizeHeaderValue(error?.message || "Video frame extraction failed"),
        }, { "X-Processor": PROCESSOR_NAME });
      }
    } else {
      let source;
      try {
        source = await fetchImageImpl(params.url, {
          logger: requestLogger,
        });
      } catch (error) {
        requestLogger.warn("image.request.fetch_failed", {
          error,
          status: error?.status,
          sourceUrl: params.url,
          sourceHost: getUrlHost(params.url),
        });

        return sendJson(
          res,
          502,
          {
            error: "Bad Gateway",
            details: sanitizeHeaderValue(error?.message || "Source image fetch failed"),
          },
          { "X-Processor": PROCESSOR_NAME },
        );
      }

      imageBuffer = source.buffer;
      sourceBytes = source.buffer.length;
      sourceContentType = source.contentType;
    }

    try {
      const result = await processImageImpl(
        imageBuffer,
        {
          ...params,
          sourceContentType,
        },
        {
          logger: requestLogger,
        },
      );

      const { buffer, metadata } = result;
      const outputContentType = FORMAT_CONTENT_TYPES[metadata.format] || "application/octet-stream";

      requestLogger.info("image.request.success", {
        statusCode: 200,
        sourceBytes,
        outputBytes: buffer.length,
        outputContentType,
        metadata,
      });

      if (params.format === "json") {
        return sendJson(res, 200, {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          size: metadata.size,
          channels: metadata.channels,
          sourceUrl: params.url,
          sourceBytes,
        });
      }

      return sendBuffer(res, 200, buffer, {
        "Content-Type": outputContentType,
        "Cache-Control": CACHE_CONTROL,
        "X-Processor": PROCESSOR_NAME,
        "X-Image-Width": String(metadata.width),
        "X-Image-Height": String(metadata.height),
        "X-Image-Format": metadata.format,
        "X-Image-Size": String(metadata.size),
      });
    } catch (error) {
      requestLogger.warn("image.request.processing_failed_fallback", {
        error,
        sourceBytes,
      });

      return sendBuffer(res, 200, imageBuffer, {
        "Content-Type": sourceContentType || "application/octet-stream",
        "Cache-Control": CACHE_CONTROL,
        "X-Processor": PROCESSOR_NAME,
        "X-Processing-Error": sanitizeHeaderValue(error?.message || "Image processing failed"),
      });
    }
  };
}

function extractQuery(req) {
  if (req.query) {
    return req.query;
  }

  const host = req.headers?.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  return url.searchParams;
}

function sendJson(res, statusCode, body, headers = {}) {
  return sendBuffer(res, statusCode, Buffer.from(JSON.stringify(body)), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
}

function sendBuffer(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }

  res.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
}

export function sanitizeHeaderValue(value) {
  return String(value).replace(/[^\x20-\x7E]/g, " ").slice(0, 180);
}

function getRequestId(req) {
  return (
    getHeader(req, "x-vercel-id") ||
    getHeader(req, "x-request-id") ||
    getHeader(req, "x-correlation-id") ||
    undefined
  );
}

function getHeader(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") {
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

function getRequestPath(req) {
  try {
    return new URL(req.url || "/api/image", "http://localhost").pathname;
  } catch {
    return req.url || "/api/image";
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export default createImageHandler();
