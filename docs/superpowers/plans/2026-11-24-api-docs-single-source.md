# API 文档单一来源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将完整 API 文档合并为一份 Markdown，并由网页渲染、README/Docker Hub 链接引用。

**Architecture:** `public/docs/api.md` 是唯一正文源，静态页面使用同源 fetch、本地 Marked 与 DOMPurify 渲染它。现有 app.js 的代码增强、主题、菜单和阅读进度功能在动态正文就绪后初始化，导航和目录来自实际标题。

**Tech Stack:** Go 静态文件服务、原生 JavaScript/CSS；Marked 18.3.0、DOMPurify 3.5.0；开发测试使用 Node.js >=24、node:test、jsdom 31.0.1。

**Spec:** `docs/superpowers/specs/2026-11-24-api-docs-single-source-design.md`（记录对话中已批准的范围及实现默认值）

## Execution Status

- Tasks 1–2 implemented. `public/docs/api.md` is the only full API source; entrypoints link to it; the page renders local Markdown with local sanitization.
- Task 3 automated verification: `npm test` 16/16, JavaScript syntax and `git diff --check` pass.
- Chrome desktop/mobile checks: 12 sections, content search and mobile navigation work, document width equals 390px viewport, zero script errors; screenshots inspected.
- Full Go test baseline is blocked by local CGO/native-library build failures in cmd/server, nsfw/onnx, processor and server. Pure-Go cache/config/nsfw/params tests pass.
- No commits or pushes. Current branch: `docs/single-source-api`.
- Independent review completed: two anchor allocation/fragment defects fixed, three regression tests watched fail then pass; no deferred minor findings.

## Global Constraints

- 唯一 API 文档源为 `public/docs/api.md`，以普通 Markdown 编写。
- 不引入前端框架或生产构建步骤；浏览器不依赖 CDN。
- 保留导航、目录、搜索、代码复制、明暗主题；不添加在线调试功能。
- 保留现有 12 个章节锚点和旧页面跳转。
- README 保留 Hugging Face YAML 头；DOCKERHUB 保持英文并使用绝对 GitHub 文档链接。
- 不修改媒体 API、Go 静态路由、Dockerfile 或发布流程。
- 不提交、不推送，保留未跟踪的 `.codegraph/`。

## Review Focus

- 首次以 `/#async-batch` 打开：异步加载完成后能定位到正确章节，而非停在顶部。
- Markdown 含同名标题、中文标题和内部链接：ID 唯一且链接可到达对应标题。
- Markdown 加载返回 404/空内容或网络失败：显示可用的原文入口和重试，不留下空白页面。
- Markdown 中含 script、事件属性或 javascript 链接：输出经过清理，不执行恶意代码。
- 渲染后才出现的代码块、导航项：复制、搜索、移动导航和阅读进度都能识别动态元素。

---

### Task 1: 合并 API Markdown 与精简入口

**Files:**
- Create: `public/docs/api.md`
- Create: `package.json`, `package-lock.json`, `tests/web/docs-source.test.cjs`
- Modify: `README.md`, `DOCKERHUB.md`, `.gitignore`

**Interfaces:**
- Consumes: 现有 `public/index.html`、README、DOCKERHUB 的文档正文。
- Produces: 可直接通过 `/docs/api.md` 获取的 UTF-8 Markdown；node:test 测试命令 `npm test`。

- [ ] **Step 1: 添加文档来源测试**：`single API source` 检查 MD 有全部 12 个章节、三类媒体/批量接口、base64 限制 50MB/256MB、同步 20/异步 50 与 NSFW 信息；`minimal entrypoints` 检查 README YAML 头保留、两个入口链接存在且没有完整 API 参数表或请求体；`legacy anchors` 检查旧跳转锚点全部存在。
- [ ] **Step 2: 执行失败测试**：`node --test tests/web/docs-source.test.cjs`，预期因 MD 尚不存在失败。
- [ ] **Step 3: 从现有三处文档合并 Markdown**，保留有用的完整示例、错误/缓存/环境配置说明；章节使用 `##` 标题和少量显式锚点保持旧链接，其他内容不依赖布局 HTML。
- [ ] **Step 4: 精简 README 和 DOCKERHUB**，使用设计中的路径/URL，保留最小部署、模型与白名单提示；配置 Node >=24、`npm test`，忽略 node_modules。
- [ ] **Step 5: 重跑来源测试**，预期全部 PASS。

### Task 2: 本地 Markdown 渲染与动态文档站

**Files:**
- Create: `public/docs.js`, `public/vendor/marked.umd.js`, `public/vendor/purify.min.js`, `public/vendor/*LICENSE*`
- Create: `tests/web/docs-render.test.cjs`, `tests/web/docs-ui.test.cjs`
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: Task 1 的 `/docs/api.md`、`npm test`；本地 `window.marked` 与 `window.DOMPurify`。
- Produces: `window.EdgeDocs.renderMarkdown(source: string): string`、`window.EdgeDocs.load(): Promise<void>`；成功插入正文后触发 `edge-docs-ready`，失败可再次调用 load。
- 页面 DOM：`#doc-body`、`#doc-navigation`、`#doc-toc`、`#doc-loading`、`#doc-error`、`#doc-retry`；沿用 `#doc-search`、`#theme-toggle`、`#menu-toggle`、`#sidebar` 和现有样式类。

- [ ] **Step 1: 写渲染失败测试**：GFM 表格/语言代码块渲染；标题生成唯一 ID；已有锚点/内部链接有效；script、onerror 和 javascript 链接被清理；真实 api.md 的每个章节都渲染为 `.doc-section`。
- [ ] **Step 2: 执行失败测试**：`node --test tests/web/docs-render.test.cjs`，预期缺少 docs.js 失败。
- [ ] **Step 3: 安装锁定的开发依赖并本地打包库与许可**：Marked 18.3.0、DOMPurify 3.5.0、jsdom 31.0.1。仅复制受维护的浏览器分发文件，不自行实现 Markdown 解析器；运行时不要求 npm 或外网。
- [ ] **Step 4: 实现 docs.js 接口**：Marked 解析、DOMPurify 清理，通过 DOM 操作包装 H2 章节/表格/代码，生成标题锚点和导航关键词；章节文本作为搜索来源。禁止生成未经清理的 Markdown HTML；忽略围栏内锚点标记。
- [ ] **Step 5: 重跑渲染测试**，预期 PASS。
- [ ] **Step 6: 写加载/UI 失败测试**：同源加载；404、空响应、网络拒绝后显示错误/原文入口，重试成功；初始 deep link；动态代码复制；正文关键字搜索；移动菜单关闭、主题切换；ready 事件后更新导航高亮。
- [ ] **Step 7: 执行 UI 失败测试**：`node --test tests/web/docs-ui.test.cjs`，预期页面尚未接入动态加载失败。
- [ ] **Step 8: 将 index.html 改为外壳并接入加载**：移除硬编码 API 正文/导航；按本地 Marked、DOMPurify、docs.js、app.js 顺序加载；提供无 JS 原文入口、loading/error/retry；load 完成触发 ready 并处理 location.hash。
- [ ] **Step 9: 修改 app.js 动态初始化**：代码增强和章节/锚点收集在 ready 后执行，可安全重复；复制与导航点击使用事件委托；主题/菜单基础事件仅初始化一次。styles.css 只补齐 Markdown 列表、表格、状态和内文样式，不重做设计。
- [ ] **Step 10: 执行 `npm test` 与 `node --check public/docs.js`、`node --check public/app.js`**，预期全 PASS。

### Task 3: 集成验证与独立复核

**Files:**
- Test: `tests/web/*.test.cjs`
- Inspect: `Dockerfile`、`cmd/server/main.go`、`public/*`、两个入口和本计划。

**Interfaces:**
- Consumes: Task 2 的完整文档页面。
- Produces: 已验证的改动和明确的验证报告，不提交/推送。

- [ ] **Step 1: 跑全套 Node 测试和语法检查**，确认唯一正文源、实际 Markdown 渲染和 DOM 交互均通过。
- [ ] **Step 2: 用本地静态服务器验证 `/`、`/docs/api.md` 和 vendor 文件的 HTTP 响应**，检查现有 Docker COPY 可以覆盖所有运行资源；如果真实浏览器可用，补充桌面/窄屏阅读、搜索、复制和深链接检查。
- [ ] **Step 3: 执行 `git diff --check`、查看 diff 和状态**，确认无重复 API 内容、无意外服务端变更、无缓存/下载目录被纳入。
- [ ] **Step 4: 独立审阅整组改动**，重点为安全渲染、异步初始化、锚点与静态部署；修正已验证问题并重跑测试。
- [ ] **Step 5: 更新计划进度并报告结果**，明确未做的验证（例如 Go/libvips 或浏览器受环境限制）及唯一维护文件路径。不创建 commit 或 push。
