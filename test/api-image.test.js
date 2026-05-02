import assert from "node:assert/strict";
import test from "node:test";

import { CACHE_CONTROL, PROCESSOR_NAME, createImageHandler } from "../api/image.js";
import { createCaptureSink } from "./helpers/capture-logs.js";

test("api handler returns processed WebP output with cache headers", async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from("source"),
      contentType: "image/jpeg"
    }),
    processImageImpl: async (_buffer, params) => Buffer.from(`webp:${params.width}`)
  });
  const res = createMockResponse();

  await handler(
    {
      method: "GET",
      query: {
        url: "https://example.com/photo.jpg",
        width: "800"
      }
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.equal(res.headers["cache-control"], CACHE_CONTROL);
  assert.equal(res.headers["x-processor"], PROCESSOR_NAME);
  assert.equal(res.body.toString(), "webp:800");
});

test("api handler returns 400 for missing url", async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler({ method: "GET", query: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body.toString()), {
    error: "Missing required parameter: url"
  });
});

test("api handler returns 400 when source host is not allowlisted", async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler(
    {
      method: "GET",
      query: { url: "https://blocked.example.com/photo.jpg" },
      env: { IMAGE_URL_ALLOWLIST: "images.example.com" }
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.toString(), /not allowed/);
});

test("api handler returns 405 for unsupported methods", async () => {
  const handler = createImageHandler();
  const res = createMockResponse();

  await handler({ method: "POST", query: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET");
});

test("api handler returns 502 when source fetch fails", async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => {
      throw new Error("upstream failed");
    }
  });
  const res = createMockResponse();

  await handler({ method: "GET", query: { url: "https://example.com/photo.jpg" } }, res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /Bad Gateway/);
  assert.equal(res.headers["x-processor"], PROCESSOR_NAME);
});

test("api handler logs source fetch failures when debug logging is enabled", async () => {
  const capture = createCaptureSink();
  const handler = createImageHandler({
    fetchImageImpl: async () => {
      const error = new Error("Source image returned HTTP 403");
      error.status = 403;
      throw error;
    },
    logger: capture.sink
  });
  const res = createMockResponse();

  await handler(
    {
      method: "GET",
      url: "/api/image",
      headers: { "x-request-id": "req_debug" },
      env: { IMAGE_DEBUG_LOGS: "1" },
      query: {
        url: "https://example.com/photo.avif",
        width: "420",
        height: "296",
        fit: "cover",
        quality: "82"
      }
    },
    res
  );

  const records = capture.records();
  const params = records.find((record) => record.event === "image.request.params");
  const failed = records.find((record) => record.event === "image.request.fetch_failed");

  assert.equal(res.statusCode, 502);
  assert.equal(params.requestId, "req_debug");
  assert.equal(params.sourceHost, "example.com");
  assert.equal(params.width, 420);
  assert.equal(params.fit, "cover");
  assert.equal(failed.status, 403);
  assert.equal(failed.errorMessage, "Source image returned HTTP 403");
});

test("api handler falls back to the original image when processing fails", async () => {
  const handler = createImageHandler({
    fetchImageImpl: async () => ({
      buffer: Buffer.from("original"),
      contentType: "image/png"
    }),
    processImageImpl: async () => {
      throw new Error("decode failed");
    }
  });
  const res = createMockResponse();

  await handler({ method: "GET", query: { url: "https://example.com/photo.png" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["x-processing-error"], "decode failed");
  assert.equal(res.body.toString(), "original");
});

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) {
        this.chunks.push(Buffer.from(chunk));
      }
      this.body = Buffer.concat(this.chunks);
    },
    body: Buffer.alloc(0)
  };
}
