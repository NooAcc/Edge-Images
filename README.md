# Vercel Edge Images

A Vercel Node.js Serverless Function that fetches a remote image, applies bounded resizing/cropping/padding transforms, and returns optimized WebP output.

The implementation follows the project requirements in `Vercel Edge Images.md`:

- `GET /api/image` accepts Cloudflare Images-style query parameters.
- Output is WebP by default with quality `85`.
- Output dimensions are always capped at `1024 x 1024`.
- Source downloads use an 8 second timeout.
- Processing failures fall back to the original downloaded image.
- Responses include CDN-friendly cache headers.

## Quick Start

Use Node.js 22.x for Vercel deployments. The project pins this through `package.json` so Vercel does not select the current default Node.js 24.x runtime.

```shell
npm install
npm test
npm run vercel:dev
```

Optional source URL allowlist:

```shell
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

Local endpoint:

```text
http://localhost:3000/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover
```

## Deploy to Vercel

### 1. Push the project to GitHub

Initialize Git, commit the project, and push it to a GitHub repository:

```shell
git init -b main
git add .
git commit -m "feat: 初始化 Vercel 图片处理服务"
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

### 2. Import the repository in Vercel

1. Open the Vercel dashboard.
2. Click **Add New...** and choose **Project**.
3. Select the GitHub repository.
4. Keep the default framework preset as **Other**.
5. Confirm that the Node.js version is controlled by `package.json`:

```json
{
  "engines": {
    "node": "22.x"
  }
}
```

### 3. Configure environment variables

For public deployments, set a source image allowlist before exposing the API:

```text
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

Each configured domain allows the domain itself and all subdomains. If you leave `IMAGE_URL_ALLOWLIST` empty, the service behaves as an open image proxy.

### 4. Deploy

Deploy from the Vercel dashboard, or use the Vercel CLI:

```shell
vercel deploy
```

For a production deployment through the CLI:

```shell
vercel deploy --prod
```

### 5. Verify the deployment

Open the generated domain to view the homepage:

```text
https://<your-project>.vercel.app/
```

Then test the image API:

```text
https://<your-project>.vercel.app/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover
```

Expected response headers:

```text
Content-Type: image/webp
Cache-Control: public, max-age=86400, s-maxage=604800
X-Processor: vercel-node-image
```

## API

Endpoint:

```text
GET /api/image
```

Required query parameter:

| Parameter | Description |
| --- | --- |
| `url` | Absolute `http` or `https` image URL. Encode it with `encodeURIComponent`. |

## Source URL Allowlist

Set `IMAGE_URL_ALLOWLIST` to restrict which remote image hosts can be fetched. Configure only base domains. For example, `example.com` allows both `example.com` and any subdomain such as `img.example.com` or `a.b.example.com`.

When the variable is empty or unset, the allowlist is disabled for backwards compatibility.

Supported entries:

| Pattern | Meaning |
| --- | --- |
| `example.com` | Allow `example.com` and all subdomains under it. |
| `trusted-cdn.com` | Allow `trusted-cdn.com` and all subdomains under it. |
| `*` | Explicitly allow every host. Useful only for local development. |

Multiple entries can be separated by commas or whitespace:

```text
IMAGE_URL_ALLOWLIST=example.com trusted-cdn.com
```

Rejected source hosts return `400` with a JSON error.

Optional query parameters:

| Parameter | Default | Description |
| --- | --- | --- |
| `width` | unset | Target width in pixels. Clamped to `1024`. |
| `height` | unset | Target height in pixels. Clamped to `1024`. |
| `fit` | `scale-down` | One of `scale-down`, `contain`, `cover`, `pad`, `crop`. Invalid values fall back to `scale-down`. |
| `quality` | `85` | WebP quality from `1` to `100`. Values outside the range are clamped. |
| `format` | `webp` | Reserved for future formats. Current implementation only accepts `webp`. |
| `background` | `FFFFFF` | Hex `RRGGBB` background for `contain` and `pad`. Invalid values fall back to white. |
| `rotate` | unset | One of `90`, `180`, `270`. |
| `flip` | unset | One of `h`, `v`, `hv`. |

## Examples

Cover crop:

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover
```

Width-only proportional resize:

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=400
```

Padded square with red background:

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=500&height=500&fit=pad&background=FF0000
```

Rotate and flip:

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&rotate=90&flip=h
```

## Response Headers

Successful processed image:

```text
Content-Type: image/webp
Cache-Control: public, max-age=86400, s-maxage=604800
X-Processor: vercel-node-image
```

Processing fallback:

```text
Content-Type: <original source content-type>
Cache-Control: public, max-age=86400, s-maxage=604800
X-Processor: vercel-node-image
X-Processing-Error: <short error message>
```

## Error Responses

| Status | Meaning |
| --- | --- |
| `400` | Missing or invalid request parameters. |
| `405` | Method is not `GET`. |
| `502` | Source image cannot be downloaded, times out, returns non-2xx, is too large, or is not an image response. |
| `500` | Unexpected server error before source fetch succeeds. |

## Implementation Notes

`@cf-wasm/photon` is used for image decode and transformations. The currently published Photon WebP method exposes no quality argument, so the production encoder first uses `webp-wasm` for quality-aware WebP output and falls back to Photon's `get_bytes_webp()` if that encoder is unavailable.

See:

- [Architecture](docs/architecture.md)
- [User Guide](docs/user-guide.md)
- [Testing](docs/testing.md)
