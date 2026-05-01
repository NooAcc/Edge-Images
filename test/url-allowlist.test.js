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

test("isUrlAllowed normalizes legacy wildcard subdomain entries to domain rules", () => {
  const allowlist = createUrlAllowlist("*.example.com");

  assert.equal(isUrlAllowed("https://example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://deep.images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://notexample.com/photo.jpg", allowlist), false);
});

test("isUrlAllowed normalizes URL-style entries to host domain rules", () => {
  const allowlist = createUrlAllowlist("https://images.example.com:443/path");

  assert.equal(isUrlAllowed("https://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("http://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://thumbs.images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://example.com/photo.jpg", allowlist), false);
});

test("isUrlAllowed allows all when wildcard star is explicitly configured", () => {
  const allowlist = createUrlAllowlist("*");

  assert.equal(isUrlAllowed("https://example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("http://localhost:3000/photo.jpg", allowlist), true);
});

test("getUrlAllowlistFromEnv reads IMAGE_URL_ALLOWLIST before legacy env name", () => {
  const allowlist = getUrlAllowlistFromEnv({
    IMAGE_URL_ALLOWLIST: "example.com",
    ALLOWED_IMAGE_HOSTS: "legacy.example.com"
  });

  assert.equal(isUrlAllowed("https://images.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://legacy.example.com/photo.jpg", allowlist), true);
  assert.equal(isUrlAllowed("https://legacy.example.net/photo.jpg", allowlist), false);
});

test("createUrlAllowlist rejects malformed wildcard rules", () => {
  assert.throws(() => createUrlAllowlist("*example.com"), UrlAllowlistConfigError);
});
