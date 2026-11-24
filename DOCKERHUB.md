# Edge Image (Go)

Image and video processing service with resizing, cropping, format conversion, video covers, metadata, sync/async batches, and optional local NSFW classification.

## Quick Start

```shell
docker run -p 3000:3000 \
  -e IMAGE_URL_ALLOWLIST=example.com \
  your-user/edge-image:latest
```

Replace `your-user/edge-image` with the image repository you use. Open [http://localhost:3000/](http://localhost:3000/) for the full API documentation.

## Image Tags

| Tag | Description |
| --- | --- |
| `latest` | Default image |
| `latest-ffmpeg` | Includes FFmpeg for video covers and metadata |
| `YYYYMMDD-HHMMSS` | Timestamped build |
| `YYYYMMDD-HHMMSS-ffmpeg` | Timestamped build with FFmpeg |

## Deployment Notes

- Set `IMAGE_URL_ALLOWLIST` in production to restrict source domains.
- Add `-v edge-cache:/data` to persist the disk cache.
- NSFW model weights are not bundled. Mount your model directory with `-v "$PWD/models:/data/models:ro"`; see the [model guide](https://github.com/NooAcc/Edge-Images/blob/main/models/README.md).

## Documentation

- **Web documentation:** the root path `/` of your running service (default [http://localhost:3000/](http://localhost:3000/)).
- **API reference and configuration:** [the single Markdown source](https://github.com/NooAcc/Edge-Images/blob/main/public/docs/api.md).
- **Project and deployment:** [GitHub README](https://github.com/NooAcc/Edge-Images/blob/main/README.md).

The web page renders the Markdown shipped with the image. The GitHub link above shows the latest documentation on `main`.
