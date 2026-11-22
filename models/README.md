# NSFW model: viddexa/nsfw-detection-2-mini

本目录只保存模型来源、许可与校验信息。**ONNX 权重不提交进 Git，也不打进镜像**，
由部署方生成后上传到运行环境的 `/data/models/`（Hugging Face Space Bucket 挂载为
`/data`）。

## 来源

| 项目 | 值 |
| --- | --- |
| 上游仓库 | <https://huggingface.co/viddexa/nsfw-detection-2-mini> |
| 镜像 | <https://hf-mirror.com/viddexa/nsfw-detection-2-mini> |
| 架构 | `EfficientNetForImageClassification`（`google/efficientnet-b4` 微调） |
| 参数 | 17,557,581 |
| 许可 | Apache-2.0（见 `LICENSE-APACHE-2.0`） |
| 论文 | F. C. Akyon 等，`arxiv:2312.16338`；上游报告 LSPD test F1 = 96.09% |

上游没有提供 ONNX 产物，本仓库用 `tools/nsfw-model/convert.py` 自行转换。

## 产物

| 项目 | 值 |
| --- | --- |
| 文件名 | `nsfw_detection_2_mini.onnx` |
| 大小 | 70,159,395 字节（约 67 MiB） |
| SHA-256 | `b747929f02a129b77db27daf29eb100aa424d78ba59100ee568e216bdaeddbec` |
| 默认加载路径 | `/data/models/nsfw_detection_2_mini.onnx` |
| 覆盖变量 | `NSFW_MODEL_PATH` |

## ONNX 接口

- 输入：`pixel_values`，`[1, 3, 380, 380]`，`float32`，NCHW
- 输出：`logits`，`[1, 5]`，`float32`
- opset：17

类别顺序（与上游 `id2label` 一致）：

| id | 标签 |
| --- | --- |
| 0 | `safe` |
| 1 | `hentai` |
| 2 | `porn` |
| 3 | `sexy` |
| 4 | `drawing` |

`isNsfw = hentai + porn + sexy >= NSFW_THRESHOLD`，默认阈值 `0.5`。
服务端对输出始终应用 softmax。

## 预处理

服务端精确复刻上游 `EfficientNetImageProcessorPil`（`use_fast=False`）：

1. 用 Pillow NEAREST 缩放到 380×380。NEAREST 不是 `floor(x*src/dst)`，而是逐像素累加：

   ```text
   scale = src / dst
   pos = scale * 0.5
   for i in 0..dst-1:
       srcIndex = int(pos)
       pos += scale
   ```

2. `x = pixel * 0.00392156862745098`
3. `x = (x - mean[c]) / std[c]`
4. `include_top` 再归一化一次：`x = x / std[c]`

`mean = [0.485, 0.456, 0.406]`，`std = [0.47853944, 0.4732864, 0.47434163]`。
因此有效变换为 `((pixel/255 - mean[c]) / std[c]) / std[c]`，输出 NCHW。

## 生成、上传与校验

```shell
# 1) 安装转换依赖（Python 3.12+）
pip install -r tools/nsfw-model/requirements.txt

# 2) 下载并导出到 models/nsfw_detection_2_mini.onnx（被 .gitignore 忽略）
python tools/nsfw-model/convert.py

# 3) 校验 ONNX / PyTorch / 预处理一致性，并刷新 Go golden
python tools/nsfw-model/verify.py

# 4) 手工上传到 HF Space Bucket 的 /data/models/nsfw_detection_2_mini.onnx
#    上传后在容器内校验：
python tools/nsfw-model/verify.py --model /data/models/nsfw_detection_2_mini.onnx

# 5) 本地开发也可以把模型放在 ./models（docker-compose 只读挂载到 /data/models）
NSFW_MODEL_PATH=./models/nsfw_detection_2_mini.onnx go run ./cmd/server
```

模型文件缺失或不可读时服务照常启动，分类请求返回 503，日志会给出实际路径。
