# API 文档单一来源改造

## 已批准的目标

用户已在本次对话批准：完整 API 内容只维护一份 Markdown；README 和 Docker Hub 仅保留最低限度说明与文档链接；网页直接展示同一份 Markdown，并保留导航、目录、搜索、代码复制、明暗主题。不添加在线调试功能。

## 实现选择

- 唯一 API 文档源为 `public/docs/api.md`，以普通 Markdown 标题、表格、列表与带语言的代码围栏编写。允许为已有链接保留少量显式 HTML 锚点，不搬运页面布局 HTML。
- 合并现有网页、README、DOCKERHUB 中的接口、示例、限制、响应、错误、NSFW、回调、缓存、白名单与环境变量说明，部署入口保留必要的配置提示而不是完整参数表。
- `public/index.html` 仅负责文档站外壳。浏览器同源加载 `/docs/api.md`，以本地打包的 Marked 渲染，以本地 DOMPurify 清理输出，动态生成导航、目录与搜索数据。
- 继续使用原生 JavaScript/CSS，不引入前端框架或生产构建步骤。Marked 18.3.0、DOMPurify 3.5.0 随仓库发布，许可随附；浏览器不依赖 CDN。Node.js >=24 仅用于开发、依赖更新和测试，Docker 运行不需要 Node。
- 保留现有 12 个章节锚点：`overview`、`quickstart`、`single-image`、`metadata`、`video`、`nsfw`、`batch`、`async-batch`、`responses`、`errors`、`allowlist`、`environment`。新标题自动生成唯一锚点，兼容 Markdown 内部链接。
- 加载失败时显示重试按钮与原始 Markdown 链接；无 JavaScript 时提供原始 Markdown 入口。加载完成后处理初始 URL 锚点。
- README 保留 Hugging Face YAML 头、简短特性、最小本地启动/Docker 部署、模型说明和文档链接。DOCKERHUB 保持英文，保留最小启动、标签说明、缓存/白名单/模型提示，API 链接使用 `https://github.com/NooAcc/Edge-Images/blob/main/public/docs/api.md`。
- Docker 已有 `COPY public /app/public`，Go 已托管 `PUBLIC_DIR` 的静态文件，因此无需改变服务端、Dockerfile 或发布流程。

## 不做的事情

不更改媒体 API 行为，不添加在线请求表单，不重新设计页面，不自动生成重复文档，不发布、不提交、不推送。保留用户现有未跟踪的 `.codegraph/`。

## 验收

只有 `public/docs/api.md` 包含完整 API 正文；三个入口均可到达它。渲染后表格、代码、导航、搜索、深链接与移动菜单可用；不执行 Markdown 中的脚本或危险链接；文档与渲染库都包含在现有 Docker 静态目录内。自动测试覆盖正常加载、失败与重试、锚点、搜索和恶意 Markdown。
