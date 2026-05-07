import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BACKGROUND, ParamError, parseParams } from "../lib/parse-params.js";
import { createUrlAllowlist } from "../lib/url-allowlist.js";

test("parseParams rejects missing url", () => {
  assert.throws(() => parseParams({}), ParamError);
});

test("parseParams normalizes defaults", () => {
  const params = parseParams({ url: "https://example.com/photo.jpg" });

  assert.equal(params.url, "https://example.com/photo.jpg");
  assert.equal(params.fit, "inside");
  assert.equal(params.quality, 85);
  assert.equal(params.format, "webp");
  assert.deepEqual(params.background, DEFAULT_BACKGROUND);
  assert.equal(params.rotate, undefined);
  assert.equal(params.flip, "");
});

test("parseParams clamps dimensions and quality", () => {
  const params = parseParams({
    url: "https://example.com/photo.jpg",
    width: "5000",
    height: "2048",
    quality: "150",
  });

  assert.equal(params.width, 1024);
  assert.equal(params.height, 1024);
  assert.equal(params.quality, 100);
});

test("parseParams rejects invalid fit and defaults invalid background", () => {
  assert.throws(
    () =>
      parseParams({
        url: "https://example.com/photo.jpg",
        fit: "invalid",
      }),
    /fit must be/,
  );

  const params = parseParams({
    url: "https://example.com/photo.jpg",
    background: "not-a-color",
  });

  assert.equal(params.fit, "inside");
  assert.deepEqual(params.background, [255, 255, 255]);
  assert.equal(params.backgroundHex, "FFFFFF");
});

test("parseParams accepts background, rotation, and flip", () => {
  const params = parseParams({
    url: "https://example.com/photo.jpg",
    background: "#ff0000",
    rotate: "90",
    flip: "hv",
  });

  assert.deepEqual(params.background, [255, 0, 0]);
  assert.equal(params.backgroundHex, "FF0000");
  assert.equal(params.rotate, 90);
  assert.equal(params.flip, "hv");
});

test("parseParams accepts supported format values", () => {
  for (const format of ["webp", "jpeg", "png", "avif", "json"]) {
    const params = parseParams({
      url: "https://example.com/photo.jpg",
      format,
    });
    assert.equal(params.format, format);
  }
});

test("parseParams rejects unsupported format and invalid transform values", () => {
  assert.throws(
    () => parseParams({ url: "https://example.com/photo.jpg", format: "gif" }),
    /format must be one of webp, jpeg, png, avif, or json/,
  );
  assert.throws(
    () => parseParams({ url: "https://example.com/photo.jpg", fit: "scale-down" }),
    /fit must be/,
  );
  assert.throws(
    () => parseParams({ url: "https://example.com/photo.jpg", rotate: "45" }),
    /rotate must be/,
  );
  assert.throws(
    () => parseParams({ url: "https://example.com/photo.jpg", flip: "diagonal" }),
    /flip must be/,
  );
});

test("parseParams rejects non-http urls and invalid dimensions", () => {
  assert.throws(() => parseParams({ url: "file:///tmp/a.jpg" }), /http or https/);
  assert.throws(() => parseParams({ url: "https://example.com/a.jpg", width: "0" }), /positive/);
  assert.throws(
    () => parseParams({ url: "https://example.com/a.jpg", height: "12.5" }),
    /positive/,
  );
});

test("parseParams enforces configured source URL allowlist", () => {
  const urlAllowlist = createUrlAllowlist("images.example.com,trusted-cdn.com");

  assert.equal(
    parseParams(
      { url: "https://images.example.com/photo.jpg" },
      { urlAllowlist },
    ).url,
    "https://images.example.com/photo.jpg",
  );
  assert.equal(
    parseParams(
      { url: "https://assets.trusted-cdn.com/photo.jpg" },
      { urlAllowlist },
    ).url,
    "https://assets.trusted-cdn.com/photo.jpg",
  );
  assert.equal(
    parseParams(
      { url: "https://trusted-cdn.com/photo.jpg" },
      { urlAllowlist },
    ).url,
    "https://trusted-cdn.com/photo.jpg",
  );
  assert.throws(
    () => parseParams({ url: "https://evil.example.net/photo.jpg" }, { urlAllowlist }),
    /not allowed/,
  );
});
