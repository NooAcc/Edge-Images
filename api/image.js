import { fetchImage } from "../lib/fetch-image.js";
import { ParamError, parseParams } from "../lib/parse-params.js";
import { processImage } from "../lib/process-image.js";

export const CACHE_CONTROL = "public, max-age=86400, s-maxage=604800";
export const PROCESSOR_NAME = "vercel-node-image";

export function createImageHandler({
  fetchImageImpl = fetchImage,
  processImageImpl = processImage
} = {}) {
  return async function imageHandler(req, res) {
    if (req.method && req.method !== "GET") {
      return sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }

    let params;
    try {
      params = parseParams(extractQuery(req), { env: req.env });
    } catch (error) {
      if (error instanceof ParamError) {
        return sendJson(res, 400, { error: error.message });
      }

      return sendJson(res, 500, { error: "Internal Server Error" });
    }

    let source;
    try {
      source = await fetchImageImpl(params.url);
    } catch (error) {
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
      const webpBuffer = await processImageImpl(source.buffer, params);

      return sendBuffer(res, 200, webpBuffer, {
        "Content-Type": "image/webp",
        "Cache-Control": CACHE_CONTROL,
        "X-Processor": PROCESSOR_NAME
      });
    } catch (error) {
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

export default createImageHandler();
