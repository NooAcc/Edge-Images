# Vercel Edge Images

一个运行在 Vercel Node.js Serverless Functions 上的图片和视频处理服务。它会下载远程图片或视频，按参数执行受控的缩放、裁剪、填充等处理，并返回优化后的输出（支持 WebP、JPEG、PNG、AVIF）。

本实现遵循 `Vercel Edge Images.md` 中的项目需求：

- `GET /api/image` 接收类似 Cloudflare Images 风格的查询参数。
- 默认输出 WebP，质量为 `85`。
- 支持多格式输出：`webp`、`jpeg`、`png`、`avif`。
- 支持 `format=json` 返回图片或视频元信息，并通过响应头解析源文件实际大小。
- 输出尺寸始终限制在 `1024 x 1024` 以内。
- 源媒体下载超时时间为 20 秒。
- 图片处理失败时会降级返回已下载的原图。
- 响应包含适合 CDN 缓存的响应头和媒体元信息头。
- **支持视频封面提取**：自动检测 MP4/WebM 视频，提取首帧作为封面图。
- **支持视频元数据查询**：获取视频分辨率、编码格式、时长等信息。

## 快速开始

```shell
npm install
npm test
npm run vercel:dev
```

可选的源媒体域名白名单：

```shell
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

本地调试源图下载、媒体处理和降级路径时，可以打开结构化日志：

```shell
IMAGE_DEBUG_LOGS=1
```

本地接口示例：

```text
# 图片处理
http://localhost:3000/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover

# 视频封面提取
http://localhost:3000/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&width=800&format=webp

# 视频元数据查询
http://localhost:3000/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&format=json
```

## 部署到 Vercel

### 1. 推送项目到 GitHub

初始化 Git，提交项目，并推送到 GitHub 仓库：

```shell
git init -b main
git add .
git commit -m "feat: 初始化 Vercel 媒体处理服务"
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

### 2. 在 Vercel 中导入仓库

1. 打开 Vercel 控制台。
2. 点击 **Add New...**，选择 **Project**。
3. 选择对应的 GitHub 仓库。
4. Framework Preset 保持默认的 **Other**。
5. Node.js 运行时使用 Vercel 项目默认设置。

### 3. 配置环境变量

公开部署前，建议配置源媒体域名白名单：

```text
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

每个配置的域名会同时允许该域名本身和所有子域名。如果 `IMAGE_URL_ALLOWLIST` 为空或未设置，服务会以开放媒体代理的方式运行。

### 4. 启用 Vercel Analytics 和 Speed Insights

项目已安装并接入：

```text
@vercel/analytics
@vercel/speed-insights
```

静态页面中已经包含 Vercel Web Analytics 与 Speed Insights 的采集脚本。部署到 Vercel 后，还需要在项目控制台中启用对应功能：

1. 打开 Vercel 项目。
2. 进入 **Analytics**，启用 Web Analytics。
3. 进入 **Speed Insights**，启用 Speed Insights。
4. 重新部署项目，等待 Vercel 控制台开始展示访问和性能数据。

### 5. 执行部署

可以在 Vercel 控制台中部署，也可以使用 Vercel CLI：

```shell
vercel deploy
```

使用 CLI 部署到生产环境：

```shell
vercel deploy --prod
```

### 6. 验证部署

打开生成的域名查看首页：

```text
https://<your-project>.vercel.app/
```

然后测试媒体处理 API：

```text
# 图片处理
https://<your-project>.vercel.app/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover

# 视频封面
https://<your-project>.vercel.app/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&width=800&format=webp

# 视频元数据
https://<your-project>.vercel.app/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&format=json
```

预期响应头：

```text
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
X-Processor: vercel-node-image
X-Image-Width: 800
X-Image-Height: 600
X-Image-Format: webp
X-Image-Size: <bytes>
```

## API

接口：

```text
GET /api/image
```

必需查询参数：

| 参数  | 说明                                                                        |
| ----- | --------------------------------------------------------------------------- |
| `url` | 绝对 `http` 或 `https` 图片或视频地址。需要使用 `encodeURIComponent` 编码。 |

## 源媒体域名白名单

通过 `IMAGE_URL_ALLOWLIST` 限制服务可以下载的远程媒体域名。只需要配置基础域名。例如，配置 `example.com` 后，会同时允许 `example.com`、`img.example.com` 和 `a.b.example.com`。

如果该变量为空或未设置，白名单会关闭，服务会允许任意源媒体域名。

白名单条目只接受基础域名或显式 `*`。不要填写 URL、路径、端口或 `*.example.com` 形式。

支持的配置：

| 配置              | 含义                                            |
| ----------------- | ----------------------------------------------- |
| `example.com`     | 允许 `example.com` 以及它下面的所有子域名。     |
| `trusted-cdn.com` | 允许 `trusted-cdn.com` 以及它下面的所有子域名。 |
| `*`               | 显式允许所有域名。仅建议本地开发使用。          |

多个域名可以用逗号或空格分隔：

```text
IMAGE_URL_ALLOWLIST=example.com trusted-cdn.com
```

被拒绝的源媒体域名会返回 `400` JSON 错误。

可选查询参数：

| 参数         | 默认值   | 说明                                                                                          |
| ------------ | -------- | --------------------------------------------------------------------------------------------- |
| `width`      | 未设置   | 目标宽度，单位为像素。最大值会被限制为 `1024`。                                               |
| `height`     | 未设置   | 目标高度，单位为像素。最大值会被限制为 `1024`。                                               |
| `fit`        | `inside` | 使用 sharp 原生模式，支持 `cover`、`contain`、`fill`、`inside`、`outside`。非法值返回 `400`。 |
| `quality`    | `85`     | 输出质量，范围为 `1` 到 `100`。超出范围的值会被截断。                                         |
| `format`     | `webp`   | 输出格式，支持 `webp`、`jpeg`、`png`、`avif`、`json`。非法值返回 `400`。                      |
| `background` | `FFFFFF` | `contain` 模式使用的十六进制 `RRGGBB` 背景色。非法值会回退为白色。                            |
| `rotate`     | 未设置   | 支持 `90`、`180`、`270`。                                                                     |
| `flip`       | 未设置   | 支持 `h`、`v`、`hv`。                                                                         |

## 示例

### 图片处理

覆盖裁剪：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&height=600&fit=cover
```

仅按宽度等比缩放：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=400
```

红色背景的正方形填充图：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=500&height=500&fit=contain&background=FF0000
```

旋转并翻转：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&rotate=90&flip=h
```

输出 JPEG 格式：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&format=jpeg
```

输出 PNG 格式：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&format=png
```

输出 AVIF 格式：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&width=800&format=avif
```

### 视频封面提取

提取 MP4 视频首帧作为封面：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&width=800&height=600&fit=cover
```

提取 WebM 视频首帧并输出 JPEG：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fclip.webm&width=1024&format=jpeg
```

### 元信息查询

获取图片元信息：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&format=json
```

图片元信息查询采用 Range 请求优化，只读取源图前 5KB 并解析源图元数据，不执行缩放或格式转换。`sourceSize` 表示源文件总字节数；如果源站没有返回可靠的大小响应头，则为 `null`。

图片 JSON 响应示例：

```json
{
  "width": 800,
  "height": 600,
  "format": "jpeg",
  "channels": 3,
  "sourceUrl": "https://example.com/photo.jpg",
  "sourceContentType": "image/jpeg",
  "sourceSize": 2483921
}
```

获取视频元信息：

```text
/api/image?url=https%3A%2F%2Fexample.com%2Fclip.mp4&format=json
```

视频 JSON 响应示例：

```json
{
  "width": 1920,
  "height": 1080,
  "codec": "h264",
  "duration": 10.5,
  "format": "mov,mp4,m4a,3gp,3g2,mj2",
  "sourceUrl": "https://example.com/clip.mp4",
  "sourceSize": 8349123
}
```

## 响应头

成功处理后的图片响应：

```text
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
X-Processor: vercel-node-image
X-Image-Width: <width>
X-Image-Height: <height>
X-Image-Format: <format>
X-Image-Size: <bytes>
```

处理失败后的原图降级响应：

```text
Content-Type: <original source content-type>
Cache-Control: public, max-age=31536000, immutable
X-Processor: vercel-node-image
X-Processing-Error: <short error message>
```

JSON 元信息响应：

```text
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
X-Processor: vercel-node-image
```

## 错误响应

| 状态码 | 含义                                                             |
| ------ | ---------------------------------------------------------------- |
| `400`  | 请求参数缺失或非法。                                             |
| `405`  | 请求方法不是 `GET`。                                             |
| `502`  | 源媒体无法下载、下载超时、返回非 2xx、文件过大，或响应不是媒体。 |
| `500`  | 源媒体下载成功前发生未预期的服务器错误。                         |

## 调试日志

默认不输出详细调试日志。设置 `IMAGE_DEBUG_LOGS=1` 后，服务会向控制台输出以 `[image]` 开头的 JSON 日志，包含请求参数、源媒体下载状态、请求头、内容类型、字节数、媒体处理路径、媒体变换计划、编码结果和原图降级原因。

本地运行示例：

```shell
IMAGE_DEBUG_LOGS=1 npm run vercel:dev
```

如果日志里出现 `image.source.fetch_bad_status` 且 `status` 为 `403`，说明请求还没有进入媒体处理阶段，是源站拒绝了函数侧下载请求。如果出现 `image.request.processing_failed_fallback`，说明源媒体已经下载成功，但解码、变换或编码阶段失败，接口会按设计返回原图。如果源媒体响应头很快返回但 body 下载很慢，`image.source.fetch_timeout` 会在完整下载超时后出现。

## 实现说明

`sharp` 用于图片解码、几何变换和质量可控的多格式编码。普通图片处理会通过单一 sharp 管线输出指定格式；图片元信息查询会通过 Range 请求读取前 5KB 并仅执行 `metadata()`，源文件大小优先从 `Content-Range` 解析。

`ffmpeg` 用于视频帧提取和元数据探测。视频处理采用 Range 请求优化，优先下载前 512KB 提取首帧或获取元数据，源文件大小同样优先从 `Content-Range` 解析。

支持的输出格式及特性：

| 格式   | 质量控制 | 编码速度 | 特点                   |
| ------ | -------- | -------- | ---------------------- |
| `webp` | 是       | 快       | 默认格式，高效压缩     |
| `jpeg` | 是       | 快       | 兼容性好               |
| `png`  | 是       | 中       | 支持透明通道           |
| `avif` | 是       | 较慢     | 最高压缩率，现代浏览器 |
| `json` | 不适用   | -        | 返回元信息，不返回媒体 |

首页和文档页会初始化 Vercel Web Analytics 与 Speed Insights 的客户端队列，并加载对应采集脚本，用于采集页面访问和性能指标。实际数据展示需要在 Vercel 项目控制台中启用对应功能。

更多文档：

- [架构说明](docs/architecture.md)
- [用户指南](docs/user-guide.md)
- [测试说明](docs/testing.md)
