# Architecture

## Goals

The service is a Node.js image and video processing API designed for Docker deployment:

- Fetch a third-party source image or video.
- Apply bounded transforms.
- Return optimized output (WebP, JPEG, PNG, AVIF).
- Use efficient caching (memory LRU + disk) for performance.
- Use a single native image pipeline for decode, transform, and encode.

## Module Map

```text
server.js
lib/handler.js
lib/batch.js
lib/parse-params.js
lib/fetch-image.js
lib/image-logger.js
lib/process-image.js
lib/process-video.js
lib/cache.js
lib/platform-config.js
```

`server.js`

- Main HTTP server entry point.
- Routes requests to appropriate handlers.
- Serves static files (index.html, docs).

`lib/handler.js`

- Main request handler for image/video processing.
- Validates `GET` requests.
- Sends JSON errors for bad parameters and failed source fetches.
- Sends success responses with cache headers.
- Falls back to the original source bytes when processing fails after fetch.

`lib/batch.js`

- Batch processing handler for multiple images/videos.
- Validates `POST` requests.
- Processes up to 20 items per batch.

`lib/parse-params.js`

- Normalizes transform query values.
- Requires an absolute `http` or `https` source URL supplied by the `/api/media/<encoded-source-url>` path.
- Rejects the legacy `url` query parameter.
- Enforces `IMAGE_URL_ALLOWLIST` when configured.
- Clamps `width` and `height` to `2048`.
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
- Parses source file size from `Content-Range`, or from `Content-Length` only for full responses.

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
- Returns `sourceSize` in metadata responses without downloading the full source solely for size.
- Builds transform responses with a single native sharp pipeline.
- Applies rotate, flip/flop, native resize, and WebP output in one chain.
- Uses `effort: 0` for fastest WebP encoding.

`index.html` and `docs/index.html`

- Serve the static homepage and documentation page.

## Request Flow

```text
GET /api/media/<encoded-source-url>
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
GET /api/media/<encoded-source-url>?format=json
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
- Uses the `2048 x 2048` max box when dimensions are omitted.

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
- Output dimensions are capped at `2048 x 2048`.
- Source response body is capped at 50 MB.
- Source fetch timeout is 20 seconds.

## Deployment

The project is designed for Docker deployment. The `Dockerfile` configures a multi-stage build:

1. **Stage 1**: Install dependencies and prune unnecessary packages (ffmpeg-static, ffprobe-static).
2. **Stage 2**: Production image with system ffmpeg, optimized for size.

The server runs on port 3000 by default and can be configured via the `PORT` environment variable.
