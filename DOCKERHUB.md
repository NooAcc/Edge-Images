# Edge Image (Go)

Go image and video processing service. Downloads remote media, applies resize/crop/fill transformations, and returns optimized output.

## Features

- WebP, JPEG, PNG, AVIF output with quality control
- Video cover extraction (MP4/WebM) and metadata query
- `format=json` returns image or video metadata
- Batch processing with two-phase queue: concurrent download, then rate-limited processing
- Sync batch (up to 20 items) and async callback batch (up to 50 items)
- Platform-aware configuration and caching strategy
- Two-tier cache (ristretto in-memory + filesystem disk)
- 20s source media download timeout
- Graceful degradation to original media on processing failure
- CDN cache control and media metadata in response headers
- Source domain allowlist
- Graceful shutdown

## Quick Start

```shell
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com your-user/edge-image
```

With a persistent cache volume:

```shell
docker run -p 3000:3000 \
  -v edge-cache:/data \
  -e IMAGE_URL_ALLOWLIST=example.com \
  your-user/edge-image
```

## Image Variants

| Tag | Description |
|---|---|
| `latest` | Default image |
| `latest-ffmpeg` | Image with system FFmpeg for video cover extraction |
| `YYYYMMDD-HHMMSS` | Timestamped build |
| `YYYYMMDD-HHMMSS-ffmpeg` | Timestamped build with FFmpeg |

Use the `-ffmpeg` tag when you need video frame extraction and video metadata probing.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `PLATFORM` | `huggingface` | Deployment platform preset |
| `MAX_DIMENSION` | `2048` | Max output dimension (px) |
| `DEFAULT_QUALITY` | `90` | Default output quality |
| `CACHE_MAX_MEMORY_MB` | `3072` | Memory cache size (MB) |
| `CACHE_MAX_DISK_GB` | `50` | Disk cache size (GB) |
| `IMAGE_URL_ALLOWLIST` | - | Source media domain allowlist (comma-separated) |
| `IMAGE_DEBUG_LOGS` | `0` | Set to `1` to enable debug logs |

## API

### Single Media Processing

```text
GET /api/media/<encoded-source-url>?width=800&height=600&crop=centre&format=webp
```

Example:

```text
GET /api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=400&height=300&crop=centre&quality=82&format=webp
```

### Sync Batch Processing

```text
POST /api/batch
Content-Type: application/json
```

Accepts up to 20 items and returns processed results in the response body.

### Async Batch Processing

```text
POST /api/batch/async
Content-Type: application/json
```

Accepts up to 50 items. The service returns `202 Accepted`, processes in the background, then POSTs results to `callbackUrl`. Callback delivery retries up to 3 times with exponential backoff.

Request body example:

```json
{
  "items": [
    {
      "uuid": "img-1",
      "url": "https://example.com/photo.jpg",
      "params": {
        "width": 800,
        "format": "webp"
      }
    }
  ],
  "callbackUrl": "https://your-service.com/callback",
  "jobId": "my-job-123"
}
```

Callback payload includes `jobId`, `status` (`completed` or `partial`), `items`, `results`, and `timestamp`.

### Health Check

```text
GET /healthz
```

Returns plain text `ok`.

### Query Parameters

| Param | Default | Description |
|---|---|---|
| `width` | - | Target width (px), max 2048 |
| `height` | - | Target height (px), max 2048 |
| `crop` | `none` | Crop strategy: `none`, `centre`, `attention`, `entropy` |
| `size` | `both` | Resize behavior: `both`, `down`, `up`, `force` |
| `quality` | `90` | Output quality, 1-100 |
| `format` | `webp` | Output format: `webp`, `jpeg`, `png`, `avif`, `json` |
| `background` | `FFFFFF` | Hex `RRGGBB` fill color used with `crop=none` |
| `rotate` | - | Rotation: `90`, `180`, `270` |
| `flip` | - | Flip direction: `h`, `v`, `hv` |

## Notes

- Mount `/data` if you want persistent filesystem disk cache across restarts.
- Configure `IMAGE_URL_ALLOWLIST` in production to restrict allowed source domains.
- Processing failures fall back to the original media when possible.
