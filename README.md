---
title: Edge Images
emoji: 🖼️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 3000
pinned: false
---

# Edge Image (Go)

Go 语言重写的图片和视频处理服务。下载远程媒体，按参数执行缩放、裁剪、填充等处理，返回优化后的输出。

## 特性

- 支持 WebP、JPEG、PNG、AVIF 输出，质量可控
- 支持视频封面提取（MP4/WebM）和元数据查询
- `format=json` 返回图片或视频元信息
- 可选内置 NSFW 内容分类（`nsfw` 参数）：基于 `viddexa/nsfw-detection-2-mini`（EfficientNet-B4）
- 批量处理：两阶段队列处理，先并发下载再限流处理，支持同步（最多 20 张）和异步回调（最多 50 张）两种模式
- 平台感知配置：根据部署平台自动调整参数和缓存策略
- 两级缓存（ristretto 内存 + 文件系统磁盘）：Docker 部署下自动启用
- 20 秒源媒体下载超时
- 处理失败时降级返回原图
- 响应头包含 CDN 缓存控制和媒体元信息
- 源媒体域名白名单
- 优雅关闭

## 快速开始

```shell
# 安装依赖（需要 libvips 开发库）
go mod tidy

# 运行测试
go test ./...

# 启动服务（NSFW 模型需放到 /data/models 或用 NSFW_MODEL_PATH 指向）
go run ./cmd/server
```

NSFW 模型不随仓库或镜像分发。本地开发可把生成的模型放到 `./models`，然后：

```shell
NSFW_MODEL_PATH=./models/nsfw_detection_2_mini.onnx go run ./cmd/server
```

模型的来源、哈希与生成方式见 `models/README.md`。

## Docker 部署

```shell
# 构建镜像
docker build -t edge-image-go .

# 运行
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com edge-image-go

# 挂载缓存卷
docker run -p 3000:3000 -v edge-cache:/data -e IMAGE_URL_ALLOWLIST=example.com edge-image-go

# 使用 NSFW 分类时，把模型放到 ./models 并只读挂载到 /data/models
docker run -p 3000:3000 -v edge-cache:/data -v "$PWD/models:/data/models:ro" \
  -e IMAGE_URL_ALLOWLIST=example.com edge-image-go
```

## API

完整的接口文档（含参数表、响应示例、在线复制与明暗主题）由服务直接托管在根路径 `/`。

### 单图处理

```text
GET /api/media/<encoded-source-url>
```

### 批量处理

```text
POST /api/batch
Content-Type: application/json
```
### 异步批量处理

```text
POST /api/batch/async
Content-Type: application/json
```

异步模式接受更大的批次（最多 50 张），服务端返回 `202 Accepted` 后在后台处理，完成后通过 `callbackUrl` POST 回调结果。

同步与异步批量的每个 item 共用同一套来源字段，`url` 与 `base64` 二选一：

- `url`：http/https 图片地址。
- `base64`：内联图片数据，可带 `data:image/png;base64,` 前缀；解码后单张上限 50MB。
- `contentType`：可选，仅用于 `base64`；缺省时从图片字节自动推断。
- 单次请求体上限 256MB（包含所有 item 的 base64 数据）。

内联图片示例：

```json
[
  { "uuid": "img-1", "base64": "iVBORw0KGgo...", "contentType": "image/png", "params": { "width": 800, "format": "webp" } }
]
```

请求体示例：

```json
{
  "items": [
    { "uuid": "img-1", "url": "https://example.com/photo.jpg", "params": { "width": 800, "format": "webp" } }
  ],
  "callbackUrl": "https://your-service.com/callback",
  "jobId": "my-job-123"
}
```

回调响应体包含 `jobId`、`status`（`completed` 或 `partial`）、`items`、`results` 和 `timestamp`。回调失败时最多重试 3 次（指数退避）。


### 查询参数

| 参数         | 默认值   | 说明                                                     |
| ------------ | -------- | -------------------------------------------------------- |
| `width`      | -        | 目标宽度（px），上限 2048                                |
| `height`     | -        | 目标高度（px），上限 2048                                |
| `crop`       | `none`   | 裁剪策略：`none`、`centre`、`attention`、`entropy`       |
| `size`       | `both`   | 缩放行为：`both`、`down`、`up`、`force`                  |
| `quality`    | `90`     | 输出质量，1–100                                          |
| `format`     | `webp`   | 输出格式：`webp`、`jpeg`、`png`、`avif`、`json`          |
| `background` | `FFFFFF` | 填充背景色，RRGGBB 格式，用于 `crop=none` 时的填充       |
| `rotate`     | -        | 旋转角度：`90`、`180`、`270`                             |
| `flip`       | -        | 翻转方向：`h`、`v`、`hv`                                 |
| `nsfw`       | -        | 可选；开启后响应变为 JSON（base64 图片 + NSFW 五分类）    |

### NSFW 分类（可选）

单图、同步批量和异步批量都接受 `nsfw` 参数。开启后，单图响应从图片二进制变为
JSON（图片以标准 base64 返回）；批量响应的 `data` 中增加 `nsfw` 字段。

```text
GET /api/media/<encoded-source-url>?width=400&format=png&nsfw=1
```

```json
{
  "width": 800,
  "height": 600,
  "format": "webp",
  "contentType": "image/webp",
  "image": "UklGRi...",
  "nsfw": {
    "drawing": 0.02,
    "hentai": 0.01,
    "safe": 0.91,
    "porn": 0.03,
    "sexy": 0.03,
    "isNsfw": false
  }
}
```

- `isNsfw = hentai + porn + sexy >= NSFW_THRESHOLD`（默认 `0.5`，`safe` 与 `drawing` 不计入）。
- 分类对象是源图（视频取封面帧），与输出尺寸、裁剪、格式无关，结果按源 URL 缓存。
- 参数取值：不存在为关闭；存在但为空、`1`、`true`、`yes`、`on` 为开启；
  `0`、`false`、`no`、`off` 为关闭；其他值返回 400。
- `format=json` 与开启的 `nsfw` 同时使用会返回 400；`format=json&nsfw=0` 仍按元数据请求处理。
- 分类器不可用（模型/运行库缺失）时单图返回 503；推理失败返回 502。
  批量中只有请求了 `nsfw` 的 item 会 `success=false`（`error` 以 `nsfw:` 开头）。
- 模型为 `viddexa/nsfw-detection-2-mini`（EfficientNet-B4，Apache-2.0，约 67 MiB）。
  ONNX 权重不随仓库或镜像分发，需手动上传到 HF Space Bucket 的
  `/data/models/nsfw_detection_2_mini.onnx`；详见 `models/README.md`。

## 环境变量

| 变量                 | 默认值 | 说明                                     |
| -------------------- | ------ | ---------------------------------------- |
| `PORT`               | `3000` | 监听端口                                 |
| `PLATFORM`           | `huggingface` | 部署平台                           |
| `MAX_DIMENSION`      | `2048` | 最大输出尺寸（px）                       |
| `DEFAULT_QUALITY`    | `90`   | 默认输出质量                             |
| `CACHE_MAX_MEMORY_MB`| `3072` | 内存缓存大小（MB）                       |
| `CACHE_MAX_DISK_GB`  | `50`   | 磁盘缓存大小（GB）                       |
| `IMAGE_URL_ALLOWLIST`| -      | 源媒体域名白名单                         |
| `IMAGE_DEBUG_LOGS`   | `0`    | 设为 `1` 启用调试日志                    |
| `NSFW_MODEL_PATH`    | `/data/models/nsfw_detection_2_mini.onnx` | NSFW ONNX 模型路径；文件缺失时功能禁用 |
| `ONNXRUNTIME_LIB_PATH` | -    | ONNX Runtime 动态库路径；Docker 镜像内已设置 |
| `NSFW_THRESHOLD`     | `0.5`  | `isNsfw` 判定阈值（0–1）；非法值会禁用分类器 |
| `NSFW_CONCURRENCY`   | `2`    | 并发推理上限；非法值回落为 `2`            |

## 架构

```
cmd/server/main.go     — 入口，初始化所有组件
internal/
  config/              — 平台配置和环境变量
  cache/               — 两级缓存（ristretto + 文件系统）
  processor/           — 图片处理（govips）和视频处理（ffmpeg）
  fetcher/             — HTTP 下载，重试，Range 请求
  params/              — 查询参数解析
  nsfw/                — NSFW 类型、softmax、EfficientNet-B4 预处理（纯 Go）
  nsfw/onnx/           — ONNX Runtime 分类器（cgo）
  allowlist/           — 域名白名单
  logger/              — 结构化日志
  server/              — HTTP 路由和处理器
models/                — 模型来源、许可与校验信息（ONNX 权重不在仓库）
public/                — 前端静态文件
```

## 相比 Node.js 版本的改进

1. **goroutine 并发模型**：每个请求一个 goroutine，I/O 等待不阻塞 CPU
2. **govips (libvips)**：底层和 sharp 相同，但 CGO 调用开销更小
3. **ristretto 缓存**：基于 LFU 变体，命中率高于手动 LRU
4. **文件系统磁盘缓存**：纯文件系统缓存，无需额外数据库引擎
5. **编译为静态二进制**：Docker 镜像更小，启动更快
6. **优雅关闭**：drain 现有请求后退出
