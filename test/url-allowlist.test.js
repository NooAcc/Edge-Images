import assert from "node:assert/strict";
import test from "node:test";

import {
  UrlAllowlistConfigError,
  createUrlAllowlist,
  getUrlAllowlistFromEnv,
  isUrlAllowed
} from "../lib/url-allowlist.js";

test("createUrlAllowlist disables enforcement when no rules are configured", () => {
  const allowlist = createUrlAllowlist("");

  assert.equal(allowlist.enabled, false);
  assert.equal(isUrlAllowed("https://any.example.com/photo.jpg", allowlist), true);
});

test("isUrlAllowed accepts configured domain and all subdomains", () => {
  const allowlist = createUrlAllowlist("example.com");

  assert.equal(isUrlAllowed("https://example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://deep.images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://notexample.com/photo.jpg", allowlist), false);
  assert.equal(isUrlAllowed("https://example.net/photo.jpg", allowlist), false);
});

test("isUrlAllowed allows all when wildcard star is explicitly configured", () => {
  const allowlist = createUrlAllowlist("*");

  assert.equal(isUrlAllowed("https://example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("http://localhost:3000/photo.jpg", allowlist), true);
});

test("getUrlAllowlistFromEnv reads IMAGE_URL_ALLOWLIST only", () => {
  const allowlist = getUrlAllowlistFromEnv({
    IMAGE_URL_ALLOWLIST: "example.com"
  });

  assert.equal(isUrlAllowed("https://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://example.net/photo.jpg", allowlist), false);
});

test("createUrlAllowlist rejects non-domain rules", () => {
  assert.throws(() => createUrlAllowlist("*example.com"), UrlAllowlistConfigError);
  assert.throws(() => createUrlAllowlist("*.example.com"), UrlAllowlistConfigError);
  assert.throws(() => createUrlAllowlist("https://images.example.com/path"), UrlAllowlistConfigError);
  assert.throws(() => createUrlAllowlist("images.example.com:443"), UrlAllowlistConfigError);
});
