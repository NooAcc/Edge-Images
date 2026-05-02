# Testing

## Commands

```shell
npm test
npm run test:unit
npm run test:system
```

The test scripts use a single-process runner (`node test/run-tests.js`) because some sandboxed Windows environments block the Node test runner from spawning one child process per test file.

## Test Coverage

Unit tests:

- `test/parse-params.test.js`
  - Required `url`.
  - Configured URL allowlist enforcement.
  - Dimension clamping.
  - Quality clamping.
  - Fit/background defaults.
  - Rotation, flip, and format validation.
- `test/url-allowlist.test.js`
  - Disabled allowlist behavior.
  - Domain plus subdomain matching.
  - Explicit `*` allow-all behavior.
  - Non-domain rule rejection.
  - Malformed rule rejection.
- `test/image-geometry.test.js`
  - Aspect inference.
  - `1024 x 1024` cap.
  - `scale-down`, `pad`, and `cover` planning.
- `test/fetch-image.test.js`
  - Successful image download.
  - Non-2xx failure.
  - Non-image content rejection.
  - Source byte limit.
  - Timeout abort.
- `test/process-image.test.js`
  - Fit behavior through a fake Photon module.
  - Quality propagation.
  - Rotation before flip and resize.
  - Padding background.

Integration and system tests:

- `test/api-image.test.js`
  - API headers and response bodies.
  - 400, 405, 502, and processing fallback paths.
- `test/system.test.js`
  - End-to-end handler flow with real parse logic and fake image processing backend.
  - Corrupt image fallback behavior.
- `test/photon-smoke.test.js`
  - Actual `@cf-wasm/photon` decode path.
  - Actual WebP output generation.
  - Actual transparent alpha preservation after WebP output is decoded again.

## Acceptance Mapping

| Requirement scenario | Covered by |
| --- | --- |
| JPEG 2048 x 1536 to 800 x 600 `cover` | `process-image.test.js`, `system.test.js` with equivalent dimensions |
| Width-only proportional resize | `image-geometry.test.js` |
| `fit=pad` with red background | `image-geometry.test.js`, `process-image.test.js` |
| `scale-down` must not upscale | `image-geometry.test.js`, `process-image.test.js` |
| `quality=50` reaches encoder | `process-image.test.js` |
| Transparent channel preservation | `photon-smoke.test.js` decodes transparent WebP output and checks alpha |
| Oversized original without dimensions | `image-geometry.test.js`, `process-image.test.js` |
| Download failure | `fetch-image.test.js`, `api-image.test.js` |
| Processing failure fallback | `api-image.test.js`, `system.test.js` |
| URL allowlist rejection | `url-allowlist.test.js`, `parse-params.test.js`, `api-image.test.js` |

## Manual Smoke Test

Run the Vercel dev server:

```shell
npm run vercel:dev
```

Then open:

```text
http://localhost:3000/api/image?url=<encoded-image-url>&width=800&height=600&fit=cover
```

Expected:

- Status `200`.
- `Content-Type: image/webp`.
- `X-Processor: vercel-node-image`.
- Output dimensions no larger than `1024 x 1024`.
