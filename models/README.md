# nsfwjs MobileNetV2 ONNX model

本目录包含服务内置 NSFW 分类使用的 ONNX 模型。模型随仓库提交，Docker 构建时
直接 `COPY` 进镜像，运行时不会联网下载。

## 文件

| 文件 | 说明 |
| --- | --- |
| `nsfwjs_mobilenet_v2.onnx` | nsfwjs 默认 MobileNetV2 模型的 ONNX 转换产物 |

- 大小：10,318,774 字节（约 9.84 MiB）
- SHA-256：`510dce55edcd1cf8281cbe906dedb3f4963f8814bc1edfbd42d3bf261148df2d`
- 输入：`input_1`，`[N, 224, 224, 3]`，`float32`，NHWC，值域 `[0, 1]`
- 输出：`dense_3`，`[N, 5]`，`float32`，已包含 softmax（概率和为 1）
- 类别顺序（与 nsfwjs `src/nsfw_classes.ts` 一致）：
  `0 = drawing`、`1 = hentai`、`2 = neutral`、`3 = porn`、`4 = sexy`

## 来源

- 主来源 URL：
  `https://hf-mirror.com/deepghs/imgutils-models/resolve/main/nsfw/nsfwjs.onnx`
- 备用 URL：
  `https://huggingface.co/deepghs/imgutils-models/resolve/main/nsfw/nsfwjs.onnx`
- 上游仓库：`deepghs/imgutils-models`（Hugging Face）
- 上游许可：MIT
- 训练来源：`GantMan/nsfw_model`（MIT），nsfwjs 的默认模型由其转换而来

该 ONNX 文件是 nsfwjs MobileNetV2 的转换产物，并非另行训练的模型。

## 许可

模型权重遵循上游 MIT 许可：

```text
MIT License

Copyright (c) deepghs / imgutils-models contributors
Copyright (c) GantMan
```

若需从原始 TFJS 模型重新转换，可参考：

```shell
tensorflowjs_converter --input_format=tfjs_layers_model --output_format=keras \
  model.json model.h5
python -m tf2onnx.convert --keras model.h5 \
  --output nsfwjs_mobilenet_v2.onnx --opset 13
```

重新转换后必须校验模型 I/O、5 类顺序和输出一致性，并更新本文件的 SHA-256。

## 预处理

推理前的预处理必须精确复刻 nsfwjs（`src/core.ts`）：

1. 解码、EXIF 自动旋转、转 sRGB、丢弃 alpha，得到全分辨率 RGB。
2. 使用 `alignCorners=true` 的双线性缩放（不是 libvips 的 `Thumbnail`/`Resize`）
   缩放到 224×224。
3. 像素值除以 255，得到 `[0, 1]` 的 `float32`。
4. 输出 NHWC；若模型输入为 NCHW 则转置。

## 校验

```shell
pip install -r tools/nsfw-model/requirements.txt
python tools/nsfw-model/fetch.py
```

脚本会校验 SHA-256，打印模型 I/O，并执行一次零输入推理，要求输出为
`(1, 5)` 且概率和与 1 的差小于 1e-3。
