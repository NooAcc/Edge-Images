import assert from "node:assert/strict";
import test from "node:test";

import { ImageFetchError, fetchImage } from "../lib/fetch-image.js";

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
