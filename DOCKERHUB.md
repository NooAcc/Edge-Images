# Edge Image (Go)

Go image and video processing service. Downloads remote media, applies resize/crop/fill transformations, and returns optimized output.

## Features

- WebP, JPEG, PNG, AVIF output with quality control
- Video cover extraction (MP4/WebM) and metadata query
- `format=json` returns image or video metadata
- Batch processing with two-phase queue
- Two-tier cache (ristretto in-memory LRU + Pebble disk)
- Graceful degradation to original on processing failure
- CDN cache control and media metadata in response headers

## Quick Start

```shell
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com your-user/edge-image
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `PLATFORM` | `huggingface` | Deployment platform |
| `MAX_DIMENSION` | `2048` | Max output dimension (px) |
| `DEFAULT_QUALITY` | `90` | Default output quality |
| `BATCH_CONCURRENCY` | `4` | Batch processing concurrency |
| `CACHE_MAX_MEMORY_MB` | `4096` | Memory cache size (MB) |
| `CACHE_MAX_DISK_GB` | `50` | Disk cache size (GB) |
| `IMAGE_URL_ALLOWLIST` | - | Source domain allowlist |

## API

### Image Processing

```
GET /api/media/<encoded-source-url>?width=400&height=300&fit=cover&quality=82&format=webp
```

### Batch Processing

```
POST /api/batch
Content-Type: application/json
```

### Parameters

| Param | Default | Description |
|---|---|---|
| `width` | - | Target width (px), max 2048 |
| `height` | - | Target height (px), max 2048 |
| `fit` | `inside` | Scale mode: `cover`, `contain`, `fill`, `inside`, `outside` |
| `quality` | `90` | Output quality, 1-100 |
| `format` | `webp` | Output format: `webp`, `jpeg`, `png`, `avif`, `json` |
| `background` | `FFFFFF` | Hex `RRGGBB` background for contain mode |
| `rotate` | - | Rotation: `90`, `180`, `270` |
| `flip` | - | Flip direction: `h`, `v`, `hv` |
