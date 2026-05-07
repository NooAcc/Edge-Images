## Formatting — Prettier

保存时自动格式化，配置见 `.prettierrc`。

- **缩进**：2 空格，不使用 Tab
- **分号**：强制 (`semi: true`)
- **引号**：单引号 (`singleQuote: true`)
- **尾逗号**：全部 (`trailingComma: "all"`)
- **行宽**：100 字符 (`printWidth: 100`)
- **换行符**：LF (`endOfLine: "lf"`)

运行 `npm run format` 格式化全部文件，`npm run format:check` 仅检查。

## Lint — ESLint

使用 ESLint flat config（`eslint.config.js`），已集成 `eslint-config-prettier` 避免与 Prettier 冲突。

- `no-var`: error —— 禁用 `var`，优先 `const`，其次 `let`
- `prefer-const`: error
- `prefer-template`: error —— 复杂拼接使用模板字符串
- `no-eval` / `no-implied-eval`: error —— 禁用高风险写法
- `no-unused-vars`: warn（`_` 前缀参数/变量忽略）

运行 `npm run lint` 检查，`npm run lint:fix` 自动修复。

## 命名约定

- 未使用的函数参数以 `_` 开头（如 `_width`、`_index`）
- 解构时跳过的字段以 `_` 开头（如 `{ depth: _depth, ...row }`）
- React 组件使用 PascalCase，文件名与组件名一致
- 工具函数使用 camelCase
