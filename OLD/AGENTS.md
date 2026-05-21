# AGENTS.md

本文件适用于仓库内所有 JavaScript、HTML、CSS、JSON、Markdown 及测试代码。修改代码时，必须优先遵守这里的规范；若子目录另有更近的 `AGENTS.md`，以更近的文件为准。

## JavaScript 规范

- 以 Google JavaScript Style Guide 作为基础代码风格。
- 使用现代 ES Module 语法，保持模块职责清晰，避免无关重构。
- 变量声明禁用 `var`：默认使用 `const`，只有确实需要重新赋值时使用 `let`。
- 复杂字符串拼接优先使用模板字符串，避免多段 `+` 拼接。
- 禁用 `eval`、`new Function`、字符串形式的计时器回调等高风险写法。
- 函数、变量、工具方法使用 `camelCase`；类和 React/Vue 等组件使用 `PascalCase`。
- 未使用的函数参数或解构字段以 `_` 开头，例如 `_index`、`{ depth: _depth, ...row }`。
- 保持函数短小、命名明确；公共逻辑优先抽成可测试的工具函数。
- 异步代码优先使用 `async` / `await`，错误处理要给出可诊断的信息。

## Prettier 格式化

Prettier 是唯一的代码格式化来源，编辑器应开启保存时自动格式化。提交前运行格式化或格式检查，避免手工调整版式。

推荐配置：

```json
{
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "endOfLine": "lf"
}
```

- 缩进统一使用 2 个空格，不使用 Tab。
- 强制分号。
- 字符串统一使用单引号；需要避免转义或符合 JSON 语法时按语言要求处理。
- 多行对象、数组、参数列表保留尾逗号。
- Google JavaScript Style Guide 与 Prettier 在版式上冲突时，以 Prettier 输出为准。

## ESLint 质量约束

使用 ESLint flat config（`eslint.config.js`）约束质量和潜在错误，并集成 `eslint-config-prettier`，避免 ESLint 与 Prettier 的格式化规则冲突。

基础规则要求：

- `no-var`: `error`
- `prefer-const`: `error`
- `prefer-template`: `error`
- `no-eval`: `error`
- `no-implied-eval`: `error`
- `no-unused-vars`: `warn`，并忽略 `_` 前缀参数和变量
- 禁止未处理的 Promise；需要显式 `await`、`return` 或捕获错误
- 禁止静默吞掉异常；如果必须忽略，需用简短注释说明原因

建议脚本：

```json
{
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

## 修改与验证

- 修改代码前先阅读相关模块和测试，沿用现有目录结构和命名风格。
- 对行为变更补充或更新测试；共享逻辑、边界条件和错误分支应覆盖到。
- 提交前至少运行与改动相关的测试；涉及格式或 lint 规则时运行 `npm run format:check` 和 `npm run lint`。
- 不要为了通过格式化或 lint 做无关重构；保持改动聚焦。
