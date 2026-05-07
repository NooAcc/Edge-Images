import assert from "node:assert/strict";
import test from "node:test";

import { ImageFetchError, fetchImage } from "../lib/fetch-image.js";
import { createImageLogger } from "../lib/image-logger.js";
import { createCaptureSink } from "./helpers/capture-logs.js";

test("fetchImage downloads an image buffer", async () => {
  const result = await fetchImage("https://example.com/photo.jpg", {
    fetchImpl: async () =>
      fakeResponse({
        body: Buffer.from("jpeg"),
        headers: {
          "content-type": "image/jpeg",
          "content-length": "4"
        }
      })
  });

  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.buffer.toString(), "jpeg");
  assert.equal(result.status, 200);
});

test("fetchImage sends browser-like image request headers", async () => {
  let requestOptions;

  const result = await fetchImage("https://example.com/photo.avif", {
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return fakeResponse({
        body: Buffer.from("avif"),
        headers: {
          "content-type": "image/avif",
          "content-length": "4"
        }
      });
    }
  });

  assert.equal(result.contentType, "image/avif");
  assert.match(requestOptions.headers.Accept, /^image\/avif,image\/webp/);
  assert.match(requestOptions.headers["User-Agent"], /Mozilla\/5\.0 .* Chrome\/124\.0/);
  assert.equal(requestOptions.headers["Accept-Language"], "zh-CN,zh;q=0.9,en;q=0.8");
  assert.equal(requestOptions.headers.Referer, "https://example.com/");
});

test("fetchImage rejects non-2xx responses", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/missing.jpg", {
        fetchImpl: async () => fakeResponse({ status: 404, ok: false })
      }),
    ImageFetchError
  );
});

test("fetchImage logs source response details before rejecting bad status", async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: "1" },
    sink: capture.sink,
    requestId: "req_fetch_403"
  });

  await assert.rejects(
    () =>
      fetchImage("https://example.com/photo.avif", {
        logger,
        fetchImpl: async () =>
          fakeResponse({
            status: 403,
            ok: false,
            headers: {
              "content-type": "image/avif",
              "content-length": "0"
            }
          })
      }),
    /HTTP 403/
  );

  const records = capture.records();
  const response = records.find((record) => record.event === "image.source.fetch_response");
  const rejected = records.find((record) => record.event === "image.source.fetch_bad_status");

  assert.equal(response.status, 403);
  assert.equal(response.contentType, "image/avif");
  assert.equal(response.sourceHost, "example.com");
  assert.equal(rejected.status, 403);
});

test("fetchImage rejects non-image content", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/index.html", {
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from("<html></html>"),
            headers: { "content-type": "text/html" }
          })
      }),
    /did not return an image/
  );
});

test("fetchImage rejects video content types", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/clip.mp4", {
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from("mp4"),
            headers: {
              "content-type": "video/mp4",
              "content-length": "3"
            }
          })
      }),
    /did not return an image/
  );
});

test("fetchImage enforces source size limits", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/huge.jpg", {
        maxBytes: 3,
        fetchImpl: async () =>
          fakeResponse({
            body: Buffer.from("1234"),
            headers: {
              "content-type": "image/jpeg",
              "content-length": "4"
            }
          })
      }),
    /exceeds/
  );
});

test("fetchImage aborts slow downloads", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/slow.jpg", {
        timeoutMs: 1,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      }),
    /timed out/
  );
});

test("fetchImage aborts slow response bodies", async () => {
  await assert.rejects(
    () =>
      fetchImage("https://example.com/slow-body.jpg", {
        timeoutMs: 1,
        fetchImpl: async (_url, { signal }) => ({
          status: 200,
          ok: true,
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "image/jpeg" : undefined;
            }
          },
          async arrayBuffer() {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            });
          }
        })
      }),
    /timed out/
  );
});

function fakeResponse({ status = 200, ok = true, body = Buffer.alloc(0), headers = {} } = {}) {
  return {
    status,
    ok,
    headers: {
      get(name) {
        return headers[name.toLowerCase()];
      }
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
  };
}
