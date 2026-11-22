# NSFW 识别对比工具

逐张对比本地 `nsfw_detection_2_mini`（ONNX）与 Cloudflare Workers AI
`@cf/cloudflare/clef-flash` 的 NSFW 识别结果。

- 本地模型不上传图片，直接在本机推理。
- clef-flash 通过 Cloudflare API 调用；凭证在网页的「设置」里填写，只保存在浏览器中。
- 两张卡片使用同一套五分类与同一个 NSFW 阈值，便于同口径对比。

## 运行

模型文件默认读取仓库根目录的 `models/nsfw_detection_2_mini.onnx`（见
`models/README.md` 生成方式），也可用 `--model` 或 `NSFW_MODEL_PATH` 指定。

```shell
python -m pip install -r tools/nsfw-compare/requirements.txt

python tools/nsfw-compare/app.py
# 浏览器打开 http://127.0.0.1:8765/
```

常用参数：

```shell
python tools/nsfw-compare/app.py --port 9000 --open
python tools/nsfw-compare/app.py --model /data/models/nsfw_detection_2_mini.onnx
```

模型缺失时服务照常启动，页面左侧会显示错误，右侧仍可单独使用。

## 使用

1. 拖入、选择或 `Ctrl+V` 粘贴图片；一次可选多张，页面逐张显示。
2. 点「设置」填写 Cloudflare Account ID 与 API Token，可先点「测试连接」。
3. 用顶部的阈值滑块调整判定线，两边卡片和「结论不一致」提示会即时更新。
4. `←` / `→` 翻页；「重跑」用当前设置重新识别。

未填写凭证时，如果服务端环境变量里有 `CF_ACCOUNT_ID` / `CF_API_TOKEN`，
会自动兜底；否则右侧卡片提示去设置。

## 判定口径

| 项目 | 本地 nsfw_detection_2_mini | Cloudflare clef-flash |
| --- | --- | --- |
| 输入 | 380×380 NCHW，复刻上游预处理 | 原图（PNG/JPEG/WebP，≤4 MiB、≤16 MP），超出则转码压缩 |
| 五类 | softmax 输出 safe/hentai/porn/sexy/drawing | `choice` 问题的五个选项概率 |
| NSFW 合计 | hentai + porn + sexy | 同左 |
| 判定 | 合计 ≥ 阈值 | 同左 |

clef-flash 额外返回一个 `noul` 问题的直接 NSFW 概率，页面上单独展示，不参与上面的判定。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 页面 |
| GET | `/api/health` | `{ok, localModel}` |
| POST | `/api/compare` | `{image: base64/dataURL, credentials?: {accountId, token}}` |
| POST | `/api/test-credentials` | `{accountId, token}` |

`/api/compare` 总是返回本地结果；Cloudflare 未配置或失败时放在 `cloud.error` 中，
不会影响本地结果。

## 测试

```shell
cd tools/nsfw-compare
python -m unittest discover -s tests -p "test_*.py"
```

预处理测试直接使用仓库里的 `internal/nsfw/testdata/preprocess_golden.json`，
与 Go 服务端的 380×380 预处理逐值对齐。本地推理测试需要模型文件，缺失时自动跳过。

## 隐私

- Cloudflare 凭证只保存在浏览器 `localStorage`/`sessionStorage` 中，随请求发到
  本机服务，再转发给 Cloudflare；服务端不落盘、不写日志。页面和接口响应都不会回显 token。
- 配置 Cloudflare 后，图片会上传至 Cloudflare Workers AI（该模型为零数据保留）。
- 本地模型推理不产生任何上传。
