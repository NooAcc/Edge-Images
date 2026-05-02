import { fetchImage } from "../lib/fetch-image.js";
import { createImageLogger } from "../lib/image-logger.js";
import { ParamError, parseParams } from "../lib/parse-params.js";
import { processImage } from "../lib/process-image.js";

export const CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PROCESSOR_NAME = "vercel-node-image";

export function createImageHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage,
  logger = console
} = {}) {
  return async function imageHandler(req, res) {
    const requestLogger = createImageLogger({
      env: req.env,
      sink: logger,
      requestId: getRequestId(req),
      base: {
        route: "/api/image"
      }
    });

    requestLogger.info("image.request.start", {
      method: req.method || "GET",
      path: getRequestPath(req)
    });

    if (req.method && req.method !== "GET") {
      requestLogger.warn("image.request.method_not_allowed", {
        method: req.method
      });
      return sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }

    let params;
    try {
      params = parseParams(extractQuery(req), { env: req.env });
    } catch (error) {
      if (error instanceof ParamError) {
        requestLogger.warn("image.request.param_error", {
          error
        });
        return sendJson(res, 400, { error: error.message });
      }

      requestLogger.error("image.request.param_unexpected_error", {
        error
      });
      return sendJson(res, 500, { error: "Internal Server Error" });
    }

    requestLogger.info("image.request.params", {
      sourceUrl: params.url,
      sourceHost: getUrlHost(params.url),
      width: params.width,
      height: params.height,
      fit: params.fit,
      quality: params.quality,
      format: params.format,
      rotate: params.rotate,
      flip: params.flip || ""
    });

    let source;
    try {
      source = await fetchImageImpl(params.url, {
        logger: requestLogger
      });
    } catch (error) {
      requestLogger.warn("image.request.fetch_failed", {
        error,
        status: error?.status,
        sourceUrl: params.url,
        sourceHost: getUrlHost(params.url)
      });

      return sendJson(
        res,
        502,
        {
          error: "Bad Gateway",
          details: sanitizeHeaderValue(error?.message || "Source image fetch failed")
        },
        { "X-Processor": PROCESSOR_NAME }
      );
    }

    try {
      const webpBuffer = await processImageImpl(
        source.buffer,
        {
          ...params,
          sourceContentType: source.contentType
        },
        {
          logger: requestLogger
        }
      );

      requestLogger.info("image.request.success", {
        statusCode: 200,
        sourceBytes: source.buffer.length,
        outputBytes: webpBuffer.length,
        outputContentType: "image/webp"
      });

      return sendBuffer(res, 200, webpBuffer, {
        "Content-Type": "image/webp",
        "Cache-Control": CACHE_CONTROL,
        "X-Processor": PROCESSOR_NAME
      });
    } catch (error) {
      requestLogger.warn("image.request.processing_failed_fallback", {
        error,
        sourceBytes: source.buffer.length,
        sourceContentType: source.contentType || "",
        fallbackContentType: source.contentType || "application/octet-stream"
      });

      return sendBuffer(res, 200, source.buffer, {
        "Content-Type": source.contentType || "application/octet-stream",
        "Cache-Control": CACHE_CONTROL,
        "X-Processor": PROCESSOR_NAME,
        "X-Processing-Error": sanitizeHeaderValue(error?.message || "Image processing failed")
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
    ...headers
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
