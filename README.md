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

图片与视频处理服务，支持缩放、裁剪、格式转换、视频封面、元信息查询、同步/异步批量处理与可选 NSFW 分类。

## 快速开始

```shell
docker build -t edge-image-go .
docker run -p 3000:3000 -e IMAGE_URL_ALLOWLIST=example.com edge-image-go
```

打开 [http://localhost:3000/](http://localhost:3000/) 阅读完整 API 文档。

- 生产环境请设置 `IMAGE_URL_ALLOWLIST`，限制可下载的源域名。
- 挂载 `-v edge-cache:/data` 可持久化磁盘缓存。
- NSFW 模型不随仓库或镜像分发；使用时将模型目录只读挂载到 `/data/models`。来源与生成方法见 [模型说明](models/README.md)。

本地开发需要 Go 1.26 和 libvips 开发库：

```shell
go run ./cmd/server
```

## 文档

- **API 文档网页**：启动服务后访问根路径 `/`（默认 [http://localhost:3000/](http://localhost:3000/)）。
- **API 文档源文件**：[public/docs/api.md](public/docs/api.md)，包含接口、参数、响应、错误与环境变量说明。
- [Docker Compose 配置](docker-compose.yml) · [环境变量示例](.env.example)

API 内容仅维护 `public/docs/api.md`，网页直接加载并渲染它，README 和 Docker Hub 不再重复正文。

前端依赖已本地打包，无需构建或访问 CDN。开发测试与依赖更新需要 Node.js 24+：

```shell
npm ci
npm test
# 修改 package.json 中的渲染库版本并更新 lockfile 后，重新打包本地资源
npm run vendor:docs
```
