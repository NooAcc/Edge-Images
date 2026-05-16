---
title: Edge Image
emoji: 🖼️
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 3000
pinned: false
---

# Edge Image

一个 Node.js 图片和视频处理服务。下载远程媒体，按参数执行缩放、裁剪、填充等处理，返回优化后的输出。

## 特性

- 支持 WebP、JPEG、PNG、AVIF 输出，质量可控
- 支持视频封面提取（MP4/WebM）和元数据查询
- `format=json` 返回图片或视频元信息
- 平台感知配置：根据部署平台自动调整参数和缓存策略
- 两级缓存（内存 LRU + 磁盘）：Docker 部署下自动启用
- 20 秒源媒体下载超时
- 处理失败时降级返回原图
- 响应头包含 CDN 缓存控制和媒体元信息
- 源媒体域名白名单

## 快速开始

```shell
npm install
npm test
npm run vercel:dev
```

## API

```text
GET /api/media/<encoded-source-url>
```

`encoded-source-url` 是经 `encodeURIComponent` 编码的完整 `http` 或 `https` 图片/视频地址。

### 查询参数

| 参数         | 默认值   | 说明                                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------------------ |
| `width`      | -        | 目标宽度（px），上限由平台决定（Vercel 1024 / HF 2048）                              |
| `height`     | -        | 目标高度（px），上限由平台决定（Vercel 1024 / HF 2048）                              |
| `fit`        | `inside` | 缩放模式：`cover`、`contain`、`fill`、`inside`、`outside`                            |
| `quality`    | 平台默认 | 输出质量，1–100（Vercel 默认 85 / HF 默认 90）                                       |
| `format`     | `webp`   | 输出格式：`webp`、`jpeg`、`png`、`avif`、`json`                                      |
| `background` | `FFFFFF` | `contain` 模式的十六进制 `RRGGBB` 背景色                                             |
| `rotate`     | -        | 旋转角度：`90`、`180`、`270`                                                         |
| `flip`       | -        | 翻转方向：`h`、`v`、`hv`                                                             |

### 示例

```text
# 覆盖裁剪
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&fit=cover

# 按宽度等比缩放
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=400

# 红色背景正方形填充
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=500&height=500&fit=contain&background=FF0000

# 旋转并翻转
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?rotate=90&flip=h

# 输出 JPEG
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&format=jpeg

# 视频封面提取
/api/media/https%3A%2F%2Fexample.com%2Fclip.mp4?width=800&height=600&fit=cover

# 图片元信息
/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?format=json

# 视频元信息
/api/media/https%3A%2F%2Fexample.com%2Fclip.mp4?format=json
```

### 元信息响应

图片元信息采用 Range 请求优化，只读取前 5KB 解析元数据，不执行缩放或格式转换。

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

视频元信息：

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

### 响应头

成功响应：

```text
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
X-Processor: edge-image
X-Image-Width: <width>
X-Image-Height: <height>
X-Image-Format: <format>
X-Image-Size: <bytes>
```

降级响应（处理失败，返回原图）：

```text
Content-Type: <original content-type>
Cache-Control: public, max-age=31536000, immutable
X-Processor: edge-image
X-Processing-Error: <error message>
```

JSON 响应：

```text
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
X-Processor: edge-image
```

### 错误码

| 状态码 | 含义                                                             |
| ------ | ---------------------------------------------------------------- |
| `400`  | 参数缺失或非法                                                   |
| `405`  | 请求方法不是 `GET`                                               |
| `502`  | 源媒体无法下载、超时、返回非 2xx、文件过大，或响应不是媒体       |
| `500`  | 源媒体下载成功前发生未预期错误                                   |

## 环境变量

### 平台配置

| 变量                 | 默认值   | 说明                                                                   |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| `PLATFORM`           | `vercel` | 部署平台：`vercel` 或 `huggingface`，自动选择预设参数和缓存策略        |

### 平台预设覆盖（可选）

| 变量                 | 说明                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `MAX_DIMENSION`      | 覆盖最大输出尺寸（px）                                                 |
| `DEFAULT_QUALITY`    | 覆盖默认输出质量（1–100）                                              |
| `CACHE_MAX_MEMORY_MB`| 覆盖内存缓存大小（MB）                                                 |
| `CACHE_MAX_DISK_GB`  | 覆盖磁盘缓存大小（GB）                                                 |

### 其他

| 变量                 | 默认值 | 说明                                                                   |
| -------------------- | ------ | ---------------------------------------------------------------------- |
| `IMAGE_URL_ALLOWLIST`| -      | 源媒体域名白名单，逗号或空格分隔。留空则允许任意域名                   |
| `IMAGE_DEBUG_LOGS`   | `0`    | 设为 `1` 启用结构化调试日志                                            |
| `USE_SYSTEM_FFMPEG`  | `true` | Docker 部署时是否使用系统 ffmpeg，`false` 则使用 ffmpeg-static npm 包   |

### 域名白名单

`IMAGE_URL_ALLOWLIST` 配置基础域名即可，会自动包含所有子域名。例如 `example.com` 同时允许 `img.example.com`。

| 配置              | 含义                               |
| ----------------- | ---------------------------------- |
| `example.com`     | 允许该域名及所有子域名             |
| `*`               | 显式允许所有域名（仅建议本地开发） |

未通过白名单的请求返回 `400` JSON 错误。

## 部署

### Docker（默认 PLATFORM=huggingface）

Docker 部署自动启用两级缓存（内存 LRU + 磁盘），输出尺寸上限提升至 2048px，默认质量 90。

构建镜像：

```shell
docker build -t edge-image .
```

运行：

```shell
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com edge-image
```

挂载缓存卷（推荐）：

```shell
docker run -p 3000:3000 -v edge-cache:/app/cache -e IMAGE_URL_ALLOWLIST=example.com edge-image
```

### Vercel（默认 PLATFORM=vercel）

Vercel 部署无缓存，保持 serverless 轻量特性。

1. 推送到 GitHub 仓库
2. 在 Vercel 控制台导入仓库，Framework Preset 保持 **Other**
3. 配置环境变量 `IMAGE_URL_ALLOWLIST`
4. 部署：

```shell
vercel deploy --prod
```

5. 在 Vercel 项目控制台启用 **Analytics** 和 **Speed Insights**，重新部署

## 平台预设对比

| 配置项             | Vercel       | Hugging Face   |
| ------------------ | ------------ | -------------- |
| 最大输出尺寸       | 1024px       | 2048px         |
| 默认质量           | 85           | 90             |
| 缓存策略           | 无           | 内存 LRU + 磁盘 |
| 内存缓存           | -            | 4096 MB        |
| 磁盘缓存           | -            | 50 GB          |

## 调试

设置 `IMAGE_DEBUG_LOGS=1` 后，服务输出以 `[image]` 开头的 JSON 日志，包含请求参数、源媒体下载状态、处理路径和降级原因。

```shell
IMAGE_DEBUG_LOGS=1 npm run vercel:dev
```

常见日志含义：

- `image.source.fetch_bad_status`（status 403）— 源站拒绝下载，尚未进入处理阶段
- `image.request.processing_failed_fallback` — 下载成功但处理失败，已降级返回原图
- `image.source.fetch_timeout` — 响应头已返回但 body 下载超时

## 实现说明

- `sharp` — 图片解码、几何变换、多格式编码。元信息查询通过 Range 请求读取前 5KB 执行 `metadata()`
- `ffmpeg` — 视频帧提取和元数据探测。优先下载前 512KB 提取首帧或获取元数据

| 格式   | 质量控制 | 速度 | 特点               |
| ------ | -------- | ---- | ------------------ |
| `webp` | 是       | 快   | 默认格式，高效压缩 |
| `jpeg` | 是       | 快   | 兼容性好           |
| `png`  | 是       | 中   | 支持透明通道       |
| `avif` | 是       | 慢   | 最高压缩率         |
| `json` | -        | -    | 返回元信息         |

## 更多文档

- [架构说明](docs/architecture.md)
- [用户指南](docs/user-guide.md)
- [测试说明](docs/testing.md)
