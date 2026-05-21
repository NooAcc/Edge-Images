# Edge Image (Go)

Go 语言重写的图片和视频处理服务。下载远程媒体，按参数执行缩放、裁剪、填充等处理，返回优化后的输出。

## 特性

- 支持 WebP、JPEG、PNG、AVIF 输出，质量可控
- 支持视频封面提取（MP4/WebM）和元数据查询
- `format=json` 返回图片或视频元信息
- 批量处理：两阶段队列处理，先并发下载再限流处理
- 平台感知配置：根据部署平台自动调整参数和缓存策略
- 两级缓存（ristretto 内存 LRU + bbolt 磁盘）：Docker 部署下自动启用
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

# 启动服务
go run ./cmd/server
```

## Docker 部署

```shell
# 构建镜像
docker build -t edge-image-go .

# 运行
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com edge-image-go

# 挂载缓存卷
docker run -p 3000:3000 -v edge-cache:/data -e IMAGE_URL_ALLOWLIST=example.com edge-image-go
```

## API

### 单图处理

```text
GET /api/media/<encoded-source-url>
```

### 批量处理

```text
POST /api/batch
Content-Type: application/json
```

### 查询参数

| 参数         | 默认值   | 说明                                                     |
| ------------ | -------- | -------------------------------------------------------- |
| `width`      | -        | 目标宽度（px），上限 2048                                |
| `height`     | -        | 目标高度（px），上限 2048                                |
| `fit`        | `inside` | 缩放模式：`cover`、`contain`、`fill`、`inside`、`outside`|
| `quality`    | `90`     | 输出质量，1–100                                          |
| `format`     | `webp`   | 输出格式：`webp`、`jpeg`、`png`、`avif`、`json`          |
| `background` | `FFFFFF` | `contain` 模式的十六进制 `RRGGBB` 背景色                 |
| `rotate`     | -        | 旋转角度：`90`、`180`、`270`                             |
| `flip`       | -        | 翻转方向：`h`、`v`、`hv`                                 |

## 环境变量

| 变量                 | 默认值 | 说明                                     |
| -------------------- | ------ | ---------------------------------------- |
| `PORT`               | `3000` | 监听端口                                 |
| `PLATFORM`           | `huggingface` | 部署平台                           |
| `MAX_DIMENSION`      | `2048` | 最大输出尺寸（px）                       |
| `DEFAULT_QUALITY`    | `90`   | 默认输出质量                             |
| `BATCH_CONCURRENCY`  | `4`    | 批量处理并发数                           |
| `CACHE_MAX_MEMORY_MB`| `4096` | 内存缓存大小（MB）                       |
| `CACHE_MAX_DISK_GB`  | `50`   | 磁盘缓存大小（GB）                       |
| `IMAGE_URL_ALLOWLIST`| -      | 源媒体域名白名单                         |
| `IMAGE_DEBUG_LOGS`   | `0`    | 设为 `1` 启用调试日志                    |

## 架构

```
cmd/server/main.go     — 入口，初始化所有组件
internal/
  config/              — 平台配置和环境变量
  cache/               — 两级缓存（ristretto + bbolt）
  processor/           — 图片处理（govips）和视频处理（ffmpeg）
  fetcher/             — HTTP 下载，重试，Range 请求
  params/              — 查询参数解析
  allowlist/           — 域名白名单
  logger/              — 结构化日志
  server/              — HTTP 路由和处理器
public/                — 前端静态文件
```

## 相比 Node.js 版本的改进

1. **goroutine 并发模型**：每个请求一个 goroutine，I/O 等待不阻塞 CPU
2. **govips (libvips)**：底层和 sharp 相同，但 CGO 调用开销更小
3. **ristretto 缓存**：基于 LFU 变体，命中率高于手动 LRU
4. **bbolt 磁盘缓存**：B+树引擎，无文件碎片，崩溃安全
5. **编译为静态二进制**：Docker 镜像更小，启动更快
6. **优雅关闭**：drain 现有请求后退出
