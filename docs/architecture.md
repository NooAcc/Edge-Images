# Architecture

## Goals

The service is a small Vercel Node.js API that behaves like a dynamic image CDN:

- Fetch a third-party source image.
- Apply bounded transforms.
- Return WebP output.
- Keep memory and CPU use predictable under Vercel Hobby limits.
- Use a single native image pipeline for decode, transform, and WebP encode.

## Module Map

```text
api/image.js
lib/parse-params.js
lib/fetch-image.js
lib/image-logger.js
lib/process-image.js
```

`api/image.js`

- Vercel function entrypoint.
- Validates `GET` requests.
- Sends JSON errors for bad parameters and failed source fetches.
- Sends WebP success responses with cache headers.
- Falls back to the original source bytes when processing fails after fetch.

`lib/parse-params.js`

- Normalizes `req.query` values.
- Requires an absolute `http` or `https` `url`.
- Enforces `IMAGE_URL_ALLOWLIST` when configured.
- Clamps `width` and `height` to `1024`.
- Clamps `quality` to `1..100`.
- Accepts only sharp native `fit` values: `cover`, `contain`, `fill`, `inside`, and `outside`.
- Defaults invalid `background` to white.

`lib/fetch-image.js`

- Uses `fetch` plus `AbortController`.
- Defaults to a 20 second timeout.
- Rejects non-2xx responses.
- Rejects non-image content types.
- Rejects source payloads above 50 MB to keep memory bounded.
- Fetches only the first 5KB for image metadata requests, even when the source ignores Range.

`lib/url-allowlist.js`

- Parses `IMAGE_URL_ALLOWLIST`.
- Treats each configured domain as allowing that domain and all of its subdomains.
- Rejects URL-shaped, port-bearing, or wildcard subdomain entries; only base domains and explicit `*` are accepted.
- Keeps allowlist enforcement disabled when no rules are configured.

`lib/image-logger.js`

- Creates opt-in structured debug logs when `IMAGE_DEBUG_LOGS=1`.
- Emits JSON records for request parsing, source fetches, processing, and fallback paths.
- Stays silent by default to avoid noisy production logs.

`lib/process-image.js`

- Lazily imports `sharp`.
- Probes source image metadata from the first 5KB for `format=json` image requests.
- Builds transform responses with a single native sharp pipeline.
- Applies rotate, flip/flop, native resize, and WebP output in one chain.
- Uses `effort: 0` for fastest WebP encoding.

`index.html` and `docs/index.html`

- Serve the static homepage and documentation page.
- Initialize `window.va` and `window.si` queues before Vercel scripts load.
- Include Vercel Web Analytics through `/_vercel/insights/script.js`.
- Include Vercel Speed Insights through `/_vercel/speed-insights/script.js`.
- These scripts become active after the matching Vercel project features are enabled in the dashboard.

## Request Flow

```text
GET /api/image
  -> parseParams()
       -> URL allowlist check
  -> fetchImage()
  -> processImage()
       -> rotate / flip
       -> sharp native resize
       -> fastest WebP encode
  -> image/webp response
```

Image metadata flow:

```text
GET /api/image?format=json
  -> parseParams()
       -> URL allowlist check
  -> fetchImageMetadataRange()
       -> Range: bytes=0-5119
  -> sharp.metadata()
  -> JSON source metadata response
```

Failure flow:

```text
Parameter error        -> 400 JSON
Fetch error            -> 502 JSON
Processing error       -> 200 original bytes + X-Processing-Error
Unexpected early error -> 500 JSON
```

## Fit Modes

`inside`

- Default mode.
- Fits inside the requested box and never enlarges the source image.
- Uses the `1024 x 1024` max box when dimensions are omitted.

`cover`

- Uses sharp's native cover behavior to fill the requested box and crop overflow.

`contain`

- Uses sharp's native contain behavior to show the whole image and fill empty area.

`fill`

- Uses sharp's native fill behavior to force the exact requested dimensions.

`outside`

- Uses sharp's native outside behavior to resize until at least one requested dimension is met.

## Resource Controls

- Optional source URL allowlist through `IMAGE_URL_ALLOWLIST`.
- Optional structured debug logs through `IMAGE_DEBUG_LOGS`.
- Output dimensions are capped at `1024 x 1024`.
- Source response body is capped at 50 MB.
- Source fetch timeout is 20 seconds.
- The Vercel function is configured with `maxDuration: 40`.

## Deployment

The project does not pin a Node.js version in `package.json`; Vercel uses the project default Node.js runtime.

`vercel.json` configures only function duration:

```json
{
  "functions": {
    "api/image.js": {
      "maxDuration": 40
    }
  }
}
```

Runtime selection can be changed in the Vercel project settings if a deployment needs a specific Node.js version.
