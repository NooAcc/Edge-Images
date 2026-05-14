# Edge Image

轻量级、自托管的图片与视频处理服务。通过简单的 URL 参数即可实现缩放、裁剪、格式转换等操作，适合作为 CDN 后端或微服务使用。

## 核心功能

- 图片处理：缩放、裁剪、填充、旋转、翻转
- 多格式输出：WebP、JPEG、PNG、AVIF
- 视频封面提取：自动检测 MP4/WebM，提取首帧
- 元信息查询：`format=json` 返回图片/视频元数据
- 处理失败自动降级返回原图
- CDN 友好的缓存响应头

## 快速启动

```shell
docker run -p 3000:3000 edge-image/edge-image
```

测试图片处理：

```shell
curl "http://localhost:3000/api/image/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&fit=cover" -o output.webp
```

## 环境变量

| 变量                  | 默认值 | 说明                                       |
| --------------------- | ------ | ------------------------------------------ |
| `IMAGE_URL_ALLOWLIST` | -      | 源媒体域名白名单，逗号分隔。留空允许任意域名 |
| `IMAGE_DEBUG_LOGS`    | `0`    | 设为 `1` 启用调试日志                      |
| `USE_SYSTEM_FFMPEG`   | `true` | 使用系统 ffmpeg，`false` 则用 ffmpeg-static |

## 构建选项

默认构建（安装系统 ffmpeg）：

```shell
docker build -t edge-image .
```

轻量构建（使用 ffmpeg-static，不安装系统 ffmpeg）：

```shell
docker build --build-arg USE_SYSTEM_FFMPEG=false -t edge-image .
```

## API 用法

```text
GET /api/image/<encoded-source-url>?<parameters>
```

源 URL 需经 `encodeURIComponent` 编码后放入路径。

**常用参数：**

| 参数       | 说明                                               |
| ---------- | -------------------------------------------------- |
| `width`    | 目标宽度（px），最大 1024                          |
| `height`   | 目标高度（px），最大 1024                          |
| `fit`      | 缩放模式：`cover`、`contain`、`fill`、`inside`、`outside` |
| `quality`  | 输出质量 1–100，默认 85                            |
| `format`   | 输出格式：`webp`（默认）、`jpeg`、`png`、`avif`、`json`  |

**示例：**

```text
# 覆盖裁剪
/api/image/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&fit=cover

# 红色背景填充
/api/image/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=500&height=500&fit=contain&background=FF0000

# 视频封面
/api/image/https%3A%2F%2Fexample.com%2Fclip.mp4?width=800&format=webp

# 元信息查询
/api/image/https%3A%2F%2Fexample.com%2Fphoto.jpg?format=json
```

## 域名白名单

通过 `IMAGE_URL_ALLOWLIST` 限制可下载的源媒体域名，配置基础域名即可自动包含所有子域名：

```shell
docker run -p 3000:3000 \
  -e IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com \
  edge-image/edge-image
```

设置为 `*` 显式允许所有域名（仅建议本地开发）。

## 调试

```shell
docker run -p 3000:3000 \
  -e IMAGE_DEBUG_LOGS=1 \
  edge-image/edge-image
```

日志输出为 `[image]` 前缀的 JSON 格式，包含请求参数、下载状态、处理路径和降级原因。

## 技术栈

- [sharp](https://sharp.pixelplumbing.com/) — 图片处理
- [ffmpeg](https://ffmpeg.org/) — 视频处理
- Node.js 22 + Alpine Linux

## 更多信息

- [GitHub 仓库](https://github.com/NooAcc/Edge-Images)
- [架构说明](https://github.com/NooAcc/Edge-Images/blob/main/docs/architecture.md)
