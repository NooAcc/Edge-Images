# Architecture

## Goals

The service is a small Vercel Node.js API that behaves like a dynamic image CDN:

- Fetch a third-party source image.
- Apply bounded transforms.
- Return WebP output.
- Keep memory and CPU use predictable under Vercel Hobby limits.
- Remain easy to migrate because all image work is WASM-based.

## Module Map

```text
api/image.js
lib/parse-params.js
lib/fetch-image.js
lib/image-geometry.js
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
- Defaults invalid `fit` to `scale-down`.
- Defaults invalid `background` to white.

`lib/fetch-image.js`

- Uses `fetch` plus `AbortController`.
- Defaults to an 8 second timeout.
- Rejects non-2xx responses.
- Rejects non-image content types.
- Rejects source payloads above 15 MB to keep memory bounded.

`lib/url-allowlist.js`

- Parses `IMAGE_URL_ALLOWLIST`.
- Treats each configured domain as allowing that domain and all of its subdomains.
- Rejects URL-shaped, port-bearing, or wildcard subdomain entries; only base domains and explicit `*` are accepted.
- Keeps allowlist enforcement disabled when no rules are configured.

`lib/image-geometry.js`

- Contains pure transform planning logic.
- Keeps output dimensions under `1024 x 1024`.
- Uses source-side cropping for `cover` to avoid huge intermediate resized images.

`lib/image-logger.js`

- Creates opt-in structured debug logs when `IMAGE_DEBUG_LOGS=1`.
- Emits JSON records for request parsing, source fetches, processing, and fallback paths.
- Stays silent by default to avoid noisy production logs.

`lib/process-image.js`

- Lazily imports `@cf-wasm/photon/node`.
- Decodes AVIF with `@jsquash/avif` when the source content type or `ftyp` brands indicate AVIF.
- Decodes other source images with `PhotonImage.new_from_byteslice`.
- Applies orientation first, then fit geometry.
- Frees Photon images in `finally` paths.
- Encodes quality-aware WebP via `webp-wasm`, with Photon WebP fallback.

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
       -> Photon decode
       -> rotate / flip
       -> fit transform
       -> WebP encode
       -> Photon free()
  -> image/webp response
```

Failure flow:

```text
Parameter error        -> 400 JSON
Fetch error            -> 502 JSON
Processing error       -> 200 original bytes + X-Processing-Error
Unexpected early error -> 500 JSON
```

## Fit Modes

`scale-down`

- Uses the requested box if provided.
- Uses the `1024 x 1024` max box if no dimensions are provided.
- Never enlarges the source image.

`contain` and `pad`

- Resize proportionally to fit inside the requested box.
- Create the exact target canvas.
- Fill surrounding space with the configured background.

`cover`

- Center-crop the source to the target aspect ratio first.
- Resize the cropped source to the exact requested box.
- This avoids creating very large intermediate images for extreme aspect ratios.

`crop`

- Resize directly to the target box without preserving source aspect ratio.

## Resource Controls

- Optional source URL allowlist through `IMAGE_URL_ALLOWLIST`.
- Optional structured debug logs through `IMAGE_DEBUG_LOGS`.
- Output dimensions are capped at `1024 x 1024`.
- Source response body is capped at 15 MB.
- Source fetch timeout is 8 seconds.
- Photon images are explicitly freed after use.
- The Vercel function is configured with `maxDuration: 10`.

## Deployment

The project does not pin a Node.js version in `package.json`; Vercel uses the project default Node.js runtime.

`vercel.json` configures only function duration:

```json
{
  "functions": {
    "api/image.js": {
      "maxDuration": 10
    }
  }
}
```

Runtime selection can be changed in the Vercel project settings if a deployment needs a specific Node.js version.
