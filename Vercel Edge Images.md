# Vercel Node.js 图片处理程序需求文档（基于 sharp）

## 1. 项目背景与目标
本项目旨在开发一个部署在 Vercel Node.js Runtime (Serverless Functions) 上的图片处理服务。该服务接收包含第三方图片 URL 的 HTTP 请求，按指定参数对图片进行转换、优化后返回。核心应用场景是作为 Web 前端的动态图片 CDN，将任意来源图片转换为统一、高效的 WebP 格式并限制尺寸，以节省带宽、提升加载性能。

**核心目标**：
- 接收任意来源的图片，将其转换为 **85% 质量的 WebP 格式**。
- 支持缩放、裁剪等 fit 模式，输出分辨率 **严格不超过 1024×1024**。
- 完全运行在 Vercel Hobby 计划的资源限制内，高效稳定。
- 使用 `sharp` 作为统一图片处理管线，覆盖解码、缩放、裁剪、填充和 WebP 编码。

## 2. 运行环境与限制
- **部署平台**：Vercel Serverless Functions (Node.js Runtime)。
- **计划类型**：Hobby（免费）。
- **关键限制**：
  - 内存：**1024 MB**（单个函数实例）。
  - 代码包大小：**50 MB**。
  - 执行超时：**10 秒**（Hobby 计划默认，可延长至 60 秒，我们的处理应在数秒内完成）。
  - 每月带宽：100 GB。
  - 每月调用次数：100 万次。
  - 每月 CPU 时间：4 小时。
- **技术约束**：Node.js Runtime 允许使用原生依赖，本方案选择 `sharp` 以获得更高效的大图缩小图处理能力。

## 3. 功能需求

### 3.1 输入接口
- 接受 `GET` 请求，通过查询参数传递处理指令。
- 必需参数：
  - `url`：原始图片的完整 URL（需 encodeURIComponent 编码）。若缺失返回 400 错误。
- 可选参数（模拟 Cloudflare Images 参数风格）：
  - `width`：目标宽度（像素），最大 1024。若仅提供宽度，高度按比例缩放。
  - `height`：目标高度（像素），最大 1024。若仅提供高度，宽度按比例缩放。
  - `fit`：缩放模式，支持：
    - `scale-down`：仅当原始尺寸大于目标尺寸时才缩放（默认）。
    - `contain`：保持宽高比完整包含在目标框内，空白部分由背景色填充（默认白色）。
    - `cover`：保持宽高比完整覆盖目标框，多余部分裁剪（居中裁剪）。
    - `pad`：同 `contain`，确保图像完整可见，周围填充背景色。
    - `crop`：直接裁剪为目标尺寸，不保持原始宽高比。
  - `quality`：WebP 输出质量，范围 1-100，**默认 85**。该参数直接影响有损压缩程度。
  - `format`：输出格式，当前版本仅支持 `webp`（默认）。预留扩展。
  - `background`：填充背景色，十六进制 RRGGBB，默认 `FFFFFF`。适用于 `fit=contain` 和 `fit=pad` 模式。
  - `rotate`：旋转角度（度），可选 90、180、270。默认无旋转。
  - `flip`：水平翻转，`h` 或 `v` 或 `hv`。默认无。

### 3.2 处理流程
1. 参数解析与验证：校验所有参数合法性，强制将宽高上限限制为 1024。
2. 源图片获取：使用 `fetch` 下载第三方图片，设置超时 20 秒。若下载失败返回 502。
3. 图片处理：
   - 使用 sharp 读取源图元数据并建立处理管线。
   - 应用旋转/翻转（如果指定）。
   - 根据 `fit` 模式和目标尺寸执行缩放、裁剪或填充。
   - 调用 sharp 的 WebP 编码器，传入质量参数（默认 85）输出 WebP 字节流。
4. 响应构造：
   - 设置 `Content-Type: image/webp`
   - 设置 `Cache-Control: public, max-age=86400, s-maxage=604800`（客户端 1 天，CDN 7 天）
   - 设置 `X-Processor: vercel-node-image`
5. 错误降级：任何内部处理失败时，若已成功获取源图片，则直接返回原始图片（透传），并在响应头中添加 `X-Processing-Error` 描述失败原因，保证服务高可用。

### 3.3 输出要求
- 最终输出图片分辨率 **严格不超过 1024×1024**。若未指定尺寸但原图超过该限制，应强制缩小（通过 fit 默认模式 `scale-down`）。
- 默认输出格式为 WebP，质量为 85（可调整）。
- 保持透明通道（如果源图支持且格式支持）。

## 4. 技术选型与理由
- **运行时**：Node.js Runtime（Vercel Serverless Functions）。该运行时支持 sharp 的原生依赖。
- **图像处理库**：`sharp`。
  - 基于 libvips，适合服务端大图解码、缩放和格式转换。
  - 支持 JPEG、PNG、WebP、AVIF 等常见输入格式，覆盖当前接口需求。
  - 内置缩放、裁剪、旋转、翻转、画布填充和质量可控的 WebP 输出能力。
  - 相比 JS/WASM 组合，能减少大尺寸 AVIF 等输入在实时缩略图转换中的 CPU 和内存压力。

## 5. 架构与模块设计
采用 Vercel 标准的 API 目录结构，Node.js 函数路由为 `/api/image.js`（或 `.ts` 如果使用 TypeScript）。
project-root/
├── api/
│ └── image.js # Serverless Function 入口
├── lib/
│ ├── parse-params.js # 参数解析与校验
│ ├── fetch-image.js # 图片下载（含超时控制）
│ └── process-image.js # 图片处理管道（sharp 调用封装）
├── package.json
└── vercel.json # (可选) 配置路由或构建选项

### 5.1 `parse-params.js`
- 解析 `req.query` 对象。
- 验证 `url` 存在性。
- 将 `width` 和 `height` 解析为数字，若超过 1024 则截断为 1024。
- 将 `quality` 解析为整数，若未提供则默认为 85，限制在 1-100。
- 验证 `fit` 枚举值，非法时默认为 `scale-down`。
- 将 `background` 转换为 RGB 数组（`[r, g, b]`），非法时默认白色 `[255,255,255]`。
- 返回规范化的配置对象。

### 5.2 `fetch-image.js`
- 使用 `fetch` 和 `AbortController` 实现超时（20 秒）。
- 若响应状态非 200，抛出错误。
- 返回响应的 `Buffer`（通过 `arrayBuffer()` 然后 `Buffer.from()`），供 sharp 处理管线消费。

### 5.3 `process-image.js`
- 接收源图片 Buffer 和参数对象。
- 使用 sharp 从源图片 Buffer 读取元数据并创建处理管线。
- 应用旋转和翻转变换。
- 根据 `fit` 模式计算目标尺寸并执行：
  - `scale-down`：仅当原图尺寸超过目标时 resize。
  - `contain`：计算等比例缩放尺寸，将图像 resize 后放置到新的目标尺寸画布上（背景色填充）。
  - `cover`：按覆盖比例缩放，然后居中裁剪。
  - `pad`：同 `contain`，用背景色填充。
  - `crop`：直接 resize 到目标尺寸（不保持宽高比）。
- 调用 sharp 的 `webp({ quality })` 输出 WebP 字节。
- 返回 WebP 字节数组。

## 6. 缓存策略
充分利用 Vercel 边缘缓存降低源站压力和费用：
- 响应头 `Cache-Control: public, max-age=86400, s-maxage=604800`。
  - `max-age=86400` 表示浏览器可缓存 1 天。
  - `s-maxage=604800` 表示 CDN/Edge 缓存 7 天。
- 由于 Vercel 边缘缓存基于 URL（查询字符串），相同的参数组合会自动命中边缘缓存，无需额外 ETag 逻辑。
- 注意：Hobby 计划边缘缓存有存储容量和时长的软限制，但足够我们使用。

## 7. 错误处理与容错
- 参数缺失/校验失败 → 400 `Bad Request`，JSON 格式错误 `{ error: "..." }`。
- 源图片获取失败（非 2xx、超时、网络错误） → 502 `Bad Gateway`，JSON 错误。
- 图片格式不支持或解码失败 → 502 或透传原图（已获取的情况下）。
- sharp 处理失败（如格式损坏或内存不足） → 若源图已获取，则返回原始图片（200 OK），并在 `X-Processing-Error` 头中记录错误信息，确保用户体验不受损。
- 任何未捕获异常 → 500 `Internal Server Error`。

## 8. 性能目标与资源监控
- **首次冷启动**（含 sharp 加载）：期望控制在可接受范围内。
- **图片处理耗时**（下载+处理）：对于 1024×1024 以内的图片，整体响应时间控制在 1.5 秒内（含网络延迟）。
- **内存使用**：峰值 < 200 MB（1024 MB 限制下非常安全）。
- **监控**：定期检查 Vercel Dashboard 中的函数调用次数、CPU 时间、带宽使用、错误率，确保在 Hobby 配额内。

## 9. 开发与部署要求
- **语言**：推荐使用 TypeScript（可兼容），也可纯 JavaScript。所有代码使用 ES 模块（`"type": "module"` 或 `.mjs`）。
- **依赖管理**：`sharp` 必须作为 `dependency` 安装在 `package.json` 中，严禁使用全局安装等非标准方式。
- **构建**：无需特殊构建，`vercel build` 应能自动识别 Node.js Runtime。若需要配置，在 `vercel.json` 中指定：
  ```json
  {
    "functions": {
      "api/image.js": {
        "runtime": "nodejs18.x"
      }
    }
  }

## 10. 测试场景

| 测试场景 | 描述 | 预期结果 |
|:---|:---|:---|
| 正常转换 | JPEG 原图 2048×1536，`width=800&height=600&fit=cover` | 输出 800×600 WebP，画面居中裁剪覆盖 |
| 仅按宽度缩放 | `width=400`，不传高度 | 按比例缩放，高度自动计算，保持原宽高比 |
| 填充模式 `fit=pad` | `width=500&height=500&fit=pad&background=FF0000` | 图像完整呈现，周围填充红色 (#FF0000) |
| 缩小模式 (scale-down) | 原图 500×500，传 `width=1024&height=1024` | 图片不放大，输出保持 500×500 |
| 质量参数 | `quality=50` | 输出 WebP 文件明显压缩，肉眼可见块效应 |
| 透明通道 | 源图为透明 PNG | 输出 WebP 透明区域保持透明 |
| 超宽原图限制 | 原图 5000×5000，不传宽高 | 输出时自动缩小到 1024×1024 以内（fit 默认为 scale-down） |
| 下载失败 | 源 URL 404 或超时 | 返回 502 |
| 处理失败降级 | 故意传一个损坏的图片 URL | 返回原图（如果下载成功）或 502，不崩溃 |

## 11. 关键代码改造清单

1. **WebP 质量参数**：使用 `sharp().webp({ quality })` 传入 `quality` 参数。
2. **新增 fit 模式**：在 `ImageTransformSchema` 中添加 `scale-down`、`pad`、`crop`，并在 `autoResize` 函数中实现对应的逻辑分支。
3. **分辨率上限**：在解析参数后强制 `width = Math.min(width, 1024)`，`height = Math.min(height, 1024)`。
4. **移除商业 API 调用**：清理任何指向外部商业服务的逻辑，仅使用本地 sharp 管线。
5. **响应头设置**：正确设置 `Content-Type` 和 `Cache-Control`。
