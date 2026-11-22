"""Local nsfw-detection-2-mini inference through ONNX Runtime."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from .preprocess import CLASSES, ModelInputSize, preprocess_image

MODEL_NAME = "nsfw_detection_2_mini"


class LocalModelError(RuntimeError):
    """The local ONNX model is missing or failed to load/run."""


@dataclass
class LocalResult:
    model: str
    probabilities: dict[str, float]
    input_size: int


def probabilities_from_logits(logits: np.ndarray | list[float]) -> dict[str, float]:
    values = np.asarray(logits, dtype=np.float64).reshape(-1)
    if values.size != len(CLASSES):
        raise ValueError(f"expected {len(CLASSES)} logits, got {values.size}")
    if not np.all(np.isfinite(values)):
        raise ValueError("logits contain a non-finite value")

    shifted = values - np.max(values)
    exps = np.exp(shifted)
    probs = exps / exps.sum()
    return {name: float(probs[i]) for i, name in enumerate(CLASSES)}


class LocalClassifier:
    def __init__(self, model_path: str | Path) -> None:
        path = Path(model_path)
        if not path.is_file():
            raise LocalModelError(f"找不到本地模型：{path}")
        try:
            self._session = ort.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
        except Exception as exc:  # onnxruntime raises a variety of types
            raise LocalModelError(f"加载本地模型失败：{exc}") from exc
        self._input_name = self._session.get_inputs()[0].name

    def classify(self, image: Image.Image) -> LocalResult:
        tensor = preprocess_image(image)
        try:
            outputs = self._session.run(None, {self._input_name: tensor})
        except Exception as exc:
            raise LocalModelError(f"本地推理失败：{exc}") from exc
        return LocalResult(
            model=MODEL_NAME,
            probabilities=probabilities_from_logits(outputs[0]),
            input_size=ModelInputSize,
        )

    @property
    def model_name(self) -> str:
        return MODEL_NAME
