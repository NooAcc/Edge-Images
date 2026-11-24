# Edge Image API

面向图片与视频的即时处理服务，支持缩放、裁剪、格式转换、视频封面提取、元信息查询、批量处理与 NSFW 分类。

<a id="overview"></a>

## 概览与接入

服务本身不存储你的媒体，每次请求都会按需下载源文件、执行处理，并返回可直接缓存的响应。三个接口共享同一套查询参数。

1. 传入源地址 把完整的 http/https 媒体地址编码后放在路径里，或使用批量接口提交多个地址与内联图片。
2. 服务端处理 下载源文件（带重试与超时保护），按参数缩放、裁剪、旋转、翻转并重新编码。
3. 缓存并返回 结果写入内存与磁盘缓存，并带 1 年 immutable 缓存头，可直接交给 CDN 与浏览器。

- 图片变换 等比缩放、居中/智能/熵裁剪、旋转、翻转与背景填充，全部通过查询参数控制。
- 多格式输出 WebP、JPEG、PNG、AVIF 输出，质量 1–100 可调；`format=json` 改为返回元信息。
- 视频封面 自动识别 MP4 / WebM，通过 Range 请求提取首帧，无需下载完整视频。
- 批量与回调 同步批量最多 20 项；异步批量最多 50 项，处理完成后回调通知，失败自动重试。
- NSFW 分类 可选的五分类内容审核，支持单图与批量；分类对象为源图，结果按源地址缓存。
- 两级缓存 内存 + 文件系统磁盘缓存；处理参数参与缓存键，相同请求不会重复处理。

Base URL 下文示例使用 `https://your-domain.com`，请替换为你的实际部署域名。服务默认不要求鉴权； 生产环境建议通过 [`IMAGE_URL_ALLOWLIST`](#allowlist) 限制可下载的源域名。

<a id="quickstart"></a>

## 快速开始

最常用的调用方式是直接拼接 URL。源地址必须整体做 URL 编码，避免其中的 `?`、`&` 与查询参数混淆。

### 1 · 用 curl 获取一张处理后的图片

```bash
curl -sSL "https://your-domain.com/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&crop=centre" \
  -o cover.webp
```

### 2 · 直接嵌入网页

```html
<img
  src="https://your-domain.com/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&crop=centre"
  alt="居中裁剪的 800×600 封面"
  width="800"
  height="600"
  loading="lazy"
>
```

### 3 · 在前端代码中调用

```js
const source = "https://example.com/photo.jpg";
const path =
  "/api/media/" +
  encodeURIComponent(source) +
  "?width=800&height=600&crop=centre";

const response = await fetch(path);
const blob = await response.blob();
document.querySelector("img").src = URL.createObjectURL(blob);
```

务必编码源地址 使用 `encodeURIComponent(source)`（或后端的对应函数）。直接拼接原始 URL 会让服务端把源地址里的查询参数误当成处理参数。

<a id="single-image"></a>

## 单图处理 GET

下载远程图片，按查询参数处理后返回二进制图片。请求方法只接受 `GET`。

```http
GET /api/media/<encoded-source-url>
```

### 路径参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `encoded-source-url` | 是 | 完整的 `http` / `https` 媒体地址，需整体做 URL 编码。服务端解码后校验协议与域名白名单。 |

### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `width` | integer | 按源图推断 | 目标宽度（px）。上限由 `MAX_DIMENSION` 决定（默认 2048），超出会被截断；只传一个维度时另一维按比例推断。 |
| `height` | integer | 按源图推断 | 目标高度（px）。规则与 `width` 相同。 |
| `crop` | string | `none` | `none` · `centre` · `attention` · `entropy`。未知值按 `none` 处理。 |
| `size` | string | `both` | `both` · `down` · `up` · `force`，控制是否允许放大。未知值按 `both` 处理。 |
| `quality` | integer | `90` | 输出质量 1–100，越界会被截断。默认值由 `DEFAULT_QUALITY` 决定。 |
| `format` | string | `webp` | `webp` · `jpeg` · `png` · `avif` · `json`。未知值按 `webp` 处理。 |
| `background` | string | `FFFFFF` | RRGGBB 填充色，仅在 `crop=none` 且输出区域大于图像时生效。非法值回退为白色。 |
| `rotate` | integer | 不旋转 | `90` · `180` · `270`；其他值忽略。 |
| `flip` | string | 不翻转 | `h` · `v` · `hv`；其他值忽略。 |
| `nsfw` | string | 关闭 | 开启后响应变为 JSON（图片以 base64 返回）。详见 [NSFW 分类](#nsfw)。 |

参数值不合法时多数会被规范化而不是报错；唯一的例外是非法的 `nsfw` 取值，以及 `format=json` 与 `nsfw` 同时开启。

### 请求示例

```bash
curl -sSL "https://your-domain.com/api/media/https%3A%2F%2Fexample.com%2Fphoto.jpg?width=800&height=600&crop=centre&format=webp" \
  -o cover.webp
```

### 成功响应

```http
HTTP/1.1 200 OK
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
X-Processor: edge-image
X-Image-Width: 800
X-Image-Height: 600
X-Image-Format: webp
X-Image-Size: 45678

[WebP 图片二进制]
```

### 处理降级

源图可以下载但解码或编码失败时，接口仍返回 `200`，内容为源图原始字节，并通过 `X-Processing-Error` 标记降级原因。

```http
HTTP/1.1 200 OK
Content-Type: image/jpeg
Cache-Control: public, max-age=31536000, immutable
X-Processor: edge-image
X-Processing-Error: Image processing failed: ...

[原始图片二进制]
```

不要只看状态码 降级响应也是 `200`。需要严格保证输出格式时，请检查 `Content-Type` 与 `X-Processing-Error` 响应头。

<a id="metadata"></a>

## 元信息查询

设置 `format=json` 后不返回图片，而是返回源媒体的尺寸、格式等信息。图片与视频返回的字段略有不同。

```http
GET /api/media/<encoded-source-url>?format=json
```

### 图片响应

```json
{
  "width": 1600,
  "height": 900,
  "format": "jpeg",
  "channels": 3,
  "sourceUrl": "https://example.com/photo.jpg",
  "sourceContentType": "image/jpeg",
  "sourceSize": 2483921
}
```

### 视频响应

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

### 字段说明

| 字段 | 图片 | 视频 | 说明 |
| --- | --- | --- | --- |
| `width` | ✓ | ✓ | 像素宽度 |
| `height` | ✓ | ✓ | 像素高度 |
| `format` | ✓ | ✓ | 图片格式或视频容器格式 |
| `channels` | ✓ | — | 颜色通道数 |
| `codec` | — | ✓ | 视频编码，如 `h264`、`vp9` |
| `duration` | — | ✓ | 时长（秒） |
| `sourceUrl` | ✓ | ✓ | 原始媒体地址；内联图片为 `inline` |
| `sourceContentType` | ✓ | — | 源文件的 MIME 类型 |
| `sourceSize` | ✓ | ✓ | 源文件字节数 |

图片元信息优先通过 Range 请求读取源文件前 **64 KB** 解析；解析失败时自动回退为完整下载。 视频元信息读取前 **512 KB**，同样支持失败回退。

<a id="video"></a>

## 视频封面

视频与图片共用 `/api/media`。服务端根据 URL 后缀识别 `.mp4` 与 `.webm`， 提取首帧后按图片参数处理，默认输出 WebP。

```http
GET /api/media/<encoded-video-url>?width=1200&height=675
```

- **识别规则：**URL 路径以 `.mp4` 或 `.webm` 结尾；允许后面带查询参数。
- **首帧提取：**先用 Range 请求读取前 512 KB 交给 ffmpeg；无法解码时自动回退为完整下载。
- **后续处理：**提取出的 JPEG 首帧继续应用 `width`、`height`、`crop`、`format` 等全部图片参数。
- **元信息：**使用 `format=json` 可获取视频宽高、编码、时长与容器格式。

```html
<video poster="https://your-domain.com/api/media/https%3A%2F%2Fexample.com%2Fclip.mp4?width=1200" controls>
  <source src="https://example.com/clip.mp4" type="video/mp4" />
</video>
```

视频封面会占用较长的处理时间（ffmpeg 提取 + 图片编码）。首帧提取结果与图片处理结果都会进入缓存，同一视频地址的后续请求会直接命中。

<a id="nsfw"></a>

## NSFW 分类

可选的五分类内容审核。开启后，单图响应从图片二进制变为 JSON，图片以标准 base64 返回，并附带分类概率。

```http
GET /api/media/<encoded-source-url>?width=400&format=png&nsfw=1
```

### 参数取值

| 取值 | 行为 |
| --- | --- |
| 参数不存在 | 关闭分类 |
| `?nsfw`、空值、`1`、`true`、`yes`、`on` | 开启分类 |
| `0`、`false`、`no`、`off` | 关闭分类 |
| 其他任意值 | `400 Bad Request` |

### 响应示例

```json
{
  "width": 400,
  "height": 300,
  "format": "png",
  "contentType": "image/png",
  "image": "iVBORw0KGgo...",
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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `width` / `height` | integer | 输出图片尺寸 |
| `format` / `contentType` | string | 输出格式与 MIME 类型 |
| `image` | string | 输出图片的标准 base64（无 data URI 前缀） |
| `nsfw.safe` 等 | number | 五个类别的概率，范围 0–1 |
| `nsfw.isNsfw` | boolean | `hentai + porn + sexy ≥ NSFW_THRESHOLD`（默认 0.5） |

- **分类对象是源图**（视频取封面帧），与输出尺寸、裁剪、格式无关；结果按源 URL 缓存。
- **与元信息冲突：**`format=json` 与开启的 `nsfw` 同时使用返回 `400`；`format=json&nsfw=0` 仍按元数据处理。
- **批量：**请求了 `nsfw` 的条目会在 `data.nsfw` 中返回分类结果；只有该条目失败时错误信息以 `nsfw:` 开头。
- **不可用：**模型或运行库缺失时单图返回 `503`，推理失败返回 `502`。

安全与隐私 分类在本服务进程内完成，图片不会发送给第三方服务。模型为 `viddexa/nsfw-detection-2-mini`（EfficientNet-B4），ONNX 权重需单独部署。模型使用 Apache-2.0 许可，约 67 MiB；来源、校验及生成方法见 [模型说明](https://github.com/NooAcc/Edge-Images/blob/main/models/README.md)。

<a id="batch"></a>

## 同步批量 POST

一次请求处理多张图片。服务端先并发下载所有源文件，再并发处理，全部完成后返回以 `uuid` 为键的结果对象。

```http
POST /api/batch
```

- 最多 20 项
- 请求体 ≤ 256 MB
- 单张 base64 解码后 ≤ 50 MB
- 逐项成功 / 失败

### 请求体

请求体是一个 JSON 数组，每个元素描述一张图片：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `uuid` | string | 是 | 唯一标识，用于关联结果；同一批次内不可重复 |
| `url` | string | 二选一 | http/https 图片地址；与 `base64` 互斥 |
| `base64` | string | 二选一 | 内联图片数据，可带 `data:image/png;base64,` 前缀；与 `url` 互斥 |
| `contentType` | string | 否 | 仅用于 `base64`；缺省时从图片字节自动推断 |
| `params` | object | 否 | 处理参数，键名与单图查询参数一致，支持 `nsfw` |

### 请求示例

```bash
curl -X POST "https://your-domain.com/api/batch" \
  -H "Content-Type: application/json" \
  -d '[
    {"uuid": "cover", "url": "https://example.com/a.jpg", "params": {"width": 800, "format": "webp"}},
    {"uuid": "meta", "url": "https://example.com/b.png", "params": {"format": "json"}},
    {"uuid": "inline", "base64": "iVBORw0KGgo...", "contentType": "image/png", "params": {"width": 256}}
  ]'
```

### 响应示例

```json
{
  "cover": {
    "success": true,
    "data": { "base64": "UklGRi...", "contentType": "image/webp" }
  },
  "meta": {
    "success": true,
    "data": {
      "width": 1920,
      "height": 1080,
      "format": "png",
      "channels": 4,
      "sourceUrl": "https://example.com/b.png",
      "sourceContentType": "image/png",
      "sourceSize": 123456
    }
  },
  "inline": {
    "success": false,
    "error": "Invalid base64 data"
  }
}
```

`success=true` 时返回 `data`：普通图片为 `{base64, contentType}`，开启 `nsfw` 时额外带 `nsfw`，`format=json` 时为元信息对象。 `success=false` 时返回 `error` 字符串。单项失败不影响其他项。

处理失败也会成功返回 单张图片解码或编码失败时，该项仍为 `success=true`，内容为源图原始字节。需要严格格式保证时，请依据 `contentType` 做二次校验。

### 校验错误

| 状态码 | 触发条件 | 错误信息示例 |
| --- | --- | --- |
| `400` | 请求体不是 JSON 数组 | `Request body must be a JSON array` |
| `400` | 缺少 `uuid` | `Each image must have a string uuid` |
| `400` | `uuid` 重复 | `Duplicate uuid: cover` |
| `400` | `url` 与 `base64` 缺失或同时出现 | `Missing url or base64 for uuid: cover` |
| `400` | 超过 20 项 | `Maximum 20 images allowed per batch` |
| `413` | 请求体超过 256 MB | `Request body too large` |
| `405` | 方法不是 `POST` | `Method Not Allowed` |

空数组会直接返回 `200 {}`。

<a id="async-batch"></a>

## 异步批量 POST

适合较大的批次：服务端立即返回 `202 Accepted`，在后台处理完成后向 `callbackUrl` POST 结果。回调失败会自动重试。

```http
POST /api/batch/async
```

- 最多 50 项
- 立即返回 202
- 回调最多重试 3 次
- 逐项成功 / 失败

### 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `items` | array | 是 | 图片列表，元素格式与同步批量完全相同 |
| `callbackUrl` | string | 是 | 处理完成后接收结果的 http/https 地址 |
| `jobId` | string | 否 | 自定义任务 ID；不填时自动生成 `ej-<timestamp>` |

### 请求示例

```bash
curl -X POST "https://your-domain.com/api/batch/async" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"uuid": "cover", "url": "https://example.com/a.jpg", "params": {"width": 800}}
    ],
    "callbackUrl": "https://your-service.example/callback",
    "jobId": "job-2026-001"
  }'
```

### 即时响应

```http
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8

{
  "jobId": "job-2026-001",
  "status": "accepted"
}
```

### 回调请求

处理结束后，服务端向 `callbackUrl` 发送 `POST` 请求：

| 请求头 | 值 |
| --- | --- |
| `Content-Type` | `application/json; charset=utf-8` |
| `X-Job-ID` | 任务 ID |
| `User-Agent` | `Mozilla/5.0 (compatible; EdgeImage/1.0)` |

```json
{
  "jobId": "job-2026-001",
  "status": "completed",
  "items": [
    {
      "uuid": "cover",
      "url": "https://example.com/a.jpg",
      "params": { "width": 800 }
    }
  ],
  "results": {
    "cover": {
      "success": true,
      "data": { "base64": "UklGRi...", "contentType": "image/webp" }
    }
  },
  "timestamp": "2026-06-01T12:00:00Z"
}
```

- `status` 为 `completed`（全部成功）或 `partial`（存在失败项）。
- `items` 回显原始请求项（`uuid`、`url`、`contentType`、`params`），内联图片不会回显 base64。
- `results` 与同步批量响应结构完全一致。
- 回调返回任意 `2xx` 视为成功；否则最多重试 3 次，间隔依次为 1 秒、2 秒。

回调端点必须可公网访问 服务端由后台任务发起回调，请确保 `callbackUrl` 可被服务器访问，并尽快返回 `2xx`，避免因超时触发重试。

<a id="responses"></a>

## 响应与缓存

### 健康检查

```http
GET /healthz
```

返回纯文本 `ok`。

所有成功响应都带 long-lived 缓存策略；处理参数参与缓存键，因此同一个 URL 可以安全地生成任意多个尺寸与格式的变体。

### 响应头

| 响应头 | 出现场景 | 说明 |
| --- | --- | --- |
| `Content-Type` | 全部 | 图片 MIME 类型、`application/json` 或错误 JSON |
| `Cache-Control` | 成功响应 | `public, max-age=31536000, immutable` |
| `X-Processor` | 处理响应 | `edge-image` |
| `X-Image-Width` | 图片处理成功 | 输出宽度（px） |
| `X-Image-Height` | 图片处理成功 | 输出高度（px） |
| `X-Image-Format` | 图片处理成功 | 输出格式，如 `webp` |
| `X-Image-Size` | 图片处理成功 | 输出字节数 |
| `X-Cache` | 命中缓存 | `HIT` |
| `X-Processing-Error` | 降级响应 | 处理失败原因（仅 ASCII 字符） |
| `Allow` | `405` | 允许的方法，如 `GET` / `POST` |

命中已处理缓存时，为保证低延迟，部分 `X-Image-*` 头可能省略。

### 缓存行为

- **两级缓存：**进程内 Ristretto（TinyLFU）+ 文件系统磁盘缓存；Docker 部署下自动启用。
- **缓存键：**源文件、元信息、处理结果分别缓存；处理结果包含全部处理参数，参数变化即生成新条目。
- **NSFW：**预测按源 URL + 模型版本 + 阈值缓存，调整模型或阈值会自动失效。
- **失效策略：**结果带 `immutable`，适合长期 CDN 缓存；源内容变化时请更换源 URL 或使用不同参数。

### 上游下载

- 普通图片下载超时 **20 秒**，单文件上限 **50 MB**。
- 对 `403`、`429`、`500`、`502`、`503`、`504` 自动重试，最多 3 次，退避 0.5 / 1 / 2 秒。
- 视频 Range 请求超时 30 秒，完整下载回退超时 120 秒。

<a id="errors"></a>

## 错误处理

错误以 JSON 返回，通常包含 `error`，部分场景附加 `details`（已过滤为可安全放入响应头的 ASCII 文本）。

```json
{
  "error": "Bad Gateway",
  "details": "fetch source: upstream timeout"
}
```

| 状态码 | 场景 | 典型响应 |
| --- | --- | --- |
| `200` | 处理成功、降级返回原图、批量部分失败 | 图片 / JSON |
| `202` | 异步批量已接受 | `{"jobId":"…","status":"accepted"}` |
| `400` | 缺少源地址、协议非法、域名不在白名单、参数冲突、批量校验失败 | `{"error":"…"}` |
| `405` | 请求方法不正确 | `{"error":"Method Not Allowed"}` |
| `413` | 批量请求体超过 256 MB | `{"error":"Request body too large"}` |
| `502` | 源媒体下载失败、ffprobe/ffmpeg 失败、NSFW 推理失败 | `{"error":"Bad Gateway","details":"…"}` |
| `503` | NSFW 分类器不可用（模型或运行库缺失） | `{"error":"Service Unavailable","details":"nsfw classifier is not available"}` |

### 常见错误

| 错误信息 | 处理方式 |
| --- | --- |
| `Missing source URL` | 检查 `/api/media/` 后是否包含编码后的地址 |
| `url must use http or https` | 仅支持 http/https，不支持 data URI 等协议（批量请用 `base64` 字段） |
| `url host is not allowed by IMAGE_URL_ALLOWLIST` | 把源域名加入部署环境的白名单 |
| `invalid nsfw value "…"` | 使用允许的布尔写法或移除该参数 |
| `nsfw is not supported with format=json` | 元信息与 NSFW 分类分开请求 |

<a id="allowlist"></a>

## 域名白名单

生产环境建议配置 `IMAGE_URL_ALLOWLIST`，限制接口只能下载可信域名下的媒体，防止被当作开放代理滥用。

```bash
IMAGE_URL_ALLOWLIST=example.com,trusted-cdn.com
```

- 使用英文逗号或空格分隔，大小写不敏感。
- 写根域名 `example.com` 会同时允许其所有子域名，如 `cdn.example.com`。
- 单独的 `*` 表示允许所有域名，仅建议本地开发使用。
- 变量留空或未设置时允许所有域名。

白名单同样适用于批量和视频 批量接口的 `url` 字段、视频地址都会经过同一套白名单校验；内联 `base64` 图片不经过域名校验。

<a id="environment"></a>

## 环境变量

以下变量用于调整服务行为，修改后需要重启进程。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `PLATFORM` | `huggingface` | 部署平台预设；未知值回退为默认预设 |
| `MAX_DIMENSION` | `2048` | 输出尺寸上限（px） |
| `DEFAULT_QUALITY` | `90` | 默认输出质量 1–100 |
| `CACHE_MAX_MEMORY_MB` | `3072` | 内存缓存上限（MB） |
| `CACHE_MAX_DISK_GB` | `50` | 磁盘缓存上限（GB） |
| `IMAGE_URL_ALLOWLIST` | 允许全部 | 源媒体域名白名单 |
| `IMAGE_DEBUG_LOGS` | `0` | 设为 `1` 启用调试日志 |
| `NSFW_MODEL_PATH` | `/data/models/nsfw_detection_2_mini.onnx` | NSFW ONNX 模型路径；文件缺失时功能禁用 |
| `ONNXRUNTIME_LIB_PATH` | — | ONNX Runtime 动态库路径；Docker 镜像内已设置 |
| `NSFW_THRESHOLD` | `0.5` | `isNsfw` 判定阈值（0–1）；非法值会禁用分类器 |
| `NSFW_CONCURRENCY` | `2` | 并发推理上限；非法值回落为 2 |
| `PUBLIC_DIR` | `./public` | 静态文档目录 |

部署提示 NSFW 模型不随仓库或镜像分发。使用分类功能时，将 `nsfw_detection_2_mini.onnx` 挂载到 `/data/models`，或通过 `NSFW_MODEL_PATH` 指向实际位置。
