# User Guide

## What This Service Does

This API receives a remote image URL and returns a transformed WebP image. It is intended for frontend image delivery where you want consistent dimensions, smaller payloads, and Vercel edge caching.

## Basic Usage

Always URL-encode the source image URL:

```js
const src = encodeURIComponent('https://example.com/photo.jpg');
const imageUrl = `/api/image?url=${src}&width=800&height=600&fit=cover`;
```

Use it in HTML:

```html
<img
  src="/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover"
  alt=""
/>
```

## Source URL Allowlist

For production deployments, configure `IMAGE_URL_ALLOWLIST` so the API only fetches images from trusted hosts:

```text
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

Each entry is a domain. A configured domain allows both itself and all subdomains:

- `example.com` allows `example.com`, `img.example.com`, and `a.b.example.com`.
- `trusted-cdn.com` allows `trusted-cdn.com` and `assets.trusted-cdn.com`.
- `*` allows all hosts and should be limited to local development.

Entries must be plain base domains or `*`. URLs, paths, ports, and `*.example.com` wildcard entries are rejected.

If `IMAGE_URL_ALLOWLIST` is empty or unset, the allowlist is disabled and the service allows any source image host.

## Common Recipes

Responsive card image:

```text
/api/image?url=<encoded-url>&width=640&height=360&fit=cover
```

Avatar without upscaling:

```text
/api/image?url=<encoded-url>&width=256&height=256&fit=inside
```

Product image with visible full object:

```text
/api/image?url=<encoded-url>&width=800&height=800&fit=contain&background=FFFFFF
```

Lower bandwidth preview:

```text
/api/image?url=<encoded-url>&width=480&quality=50
```

## Parameter Details

`width` and `height`

- Positive integers.
- Values above `1024` become `1024`.
- If only one is provided, the other is inferred from the source aspect ratio.
- If neither is provided, oversized sources are still reduced to fit inside `1024 x 1024`.

`fit`

- `inside`: default. Fit within the box without enlarging the source.
- `cover`: fill the full box and crop overflow using sharp's native behavior.
- `contain`: show the whole image inside the box and fill empty area.
- `fill`: force output to the requested dimensions.
- `outside`: resize to cover at least one requested dimension without cropping.

`quality`

- Integer from `1` to `100`.
- Default is `85`.
- Lower values reduce bandwidth but may show compression artifacts.

`background`

- Six hex characters: `RRGGBB`.
- Used by `contain`.
- Invalid values default to `FFFFFF`.

`rotate`

- One of `90`, `180`, `270`.
- Rotation uses sharp's native operation order before resize.

`flip`

- `h`: horizontal.
- `v`: vertical.
- `hv`: horizontal and vertical.

## Caching

The API returns:

```text
Cache-Control: public, max-age=86400, s-maxage=604800
```

This lets browsers cache for one day and Vercel's CDN cache for seven days. Since the query string is part of the URL, different parameter combinations create separate cache entries.

## Fallback Behavior

If the source downloads successfully but processing fails, the service returns the original image bytes with:

```text
X-Processing-Error: <message>
```

This keeps pages usable even when a source image has an unsupported or damaged format.

## Operational Guidance

- Prefer explicit `width` and `height` for predictable layout.
- Configure `IMAGE_URL_ALLOWLIST` before exposing the service publicly.
- Set `IMAGE_DEBUG_LOGS=1` locally when diagnosing source fetches, image processing, or original-image fallbacks.
- Use `cover` for thumbnails and cards.
- Use `contain` for product images where the full object should remain visible.
- Keep source images reasonably sized; the service rejects source payloads above 50 MB.
- Monitor Vercel function duration, bandwidth, and error rate after deployment.

## Debug Logs

Set `IMAGE_DEBUG_LOGS=1` before running the dev server to emit structured console logs:

```shell
IMAGE_DEBUG_LOGS=1 npm run vercel:dev
```

Each line starts with `[image]` and contains a JSON record. Key events:

- `image.source.fetch_bad_status`: the source server rejected the image request before processing.
- `image.source.fetch_timeout`: the source response or body download exceeded the configured timeout.
- `image.transform.plan`: the sharp resize, rotate, and flip options selected for the request.
- `image.request.processing_failed_fallback`: processing failed after a successful download, so the API returned the original bytes.
