# NSFW model tooling

把 `viddexa/nsfw-detection-2-mini`（EfficientNet-B4）转换成 ONNX，并验证
Go 端预处理与推理结果。这些脚本只用于开发/维护，不参与 Docker 或 CI 构建。

## 1. 安装

需要 Python 3.12+。固定版本见 `requirements.txt`：

```shell
pip install -r tools/nsfw-model/requirements.txt
```

默认使用 `HF_ENDPOINT=https://hf-mirror.com`；可通过同名环境变量覆盖。

## 2. 转换

```shell
python tools/nsfw-model/convert.py
```

脚本会：

- 加载上游 `AutoModelForImageClassification`，校验 `id2label`；
- 用 `torch.onnx.export`（opset 17、`dynamo=False`）导出到
  `models/nsfw_detection_2_mini.onnx`；
- 校验 I/O，并把 ONNX Runtime 与 PyTorch 的 logits 做数值比较；
- 打印文件大小与 SHA-256，与记录的哈希不一致时给出警告。

## 3. 验证

```shell
python tools/nsfw-model/verify.py
```

脚本会：

- 校验模型 SHA-256 与 ONNX I/O；
- 对 `7×5`（放大）与 `761×757`（缩小）两张确定性合成图，用上游
  `EfficientNetImageProcessorPil` 生成参考张量；
- 用 NumPy 按 Go 端公式重建张量，确认最大绝对差 `< 1e-6`；
- 比较 PyTorch 与 ONNX Runtime 的 logits；
- 重写 `internal/nsfw/testdata/preprocess_golden.json`（每个 case 512 个采样点）。

可选地对真实图片分类（不会把图片写入仓库）：

```shell
python tools/nsfw-model/verify.py --image path/to/image.jpg
```

`--model` 可指向 Bucket 上已上传的文件：

```shell
python tools/nsfw-model/verify.py --model /data/models/nsfw_detection_2_mini.onnx
```

## 4. 上传

把 `models/nsfw_detection_2_mini.onnx` 手工上传到 Hugging Face Space Bucket 的
`/data/models/` 目录（容器内即 `/data/models/nsfw_detection_2_mini.onnx`），
重启服务后启动日志中的 `modelId` 应更新为新模型哈希前 16 位。
