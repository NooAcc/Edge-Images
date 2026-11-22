#!/usr/bin/env python3
"""Download viddexa/nsfw-detection-2-mini and export it to ONNX.

This script is a development/maintenance helper. It is not part of the
Docker or CI build, and its output is never committed to Git.

Usage:
    python tools/nsfw-model/convert.py

The exported file is written to models/nsfw_detection_2_mini.onnx. Verify it
with tools/nsfw-model/verify.py, then upload it to the deployment's
/data/models directory.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

# Must be set before transformers/huggingface_hub read it.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForImageClassification  # noqa: E402

MODEL_ID = "viddexa/nsfw-detection-2-mini"
ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "models" / "nsfw_detection_2_mini.onnx"
EXPECTED_SHA256 = "b747929f02a129b77db27daf29eb100aa424d78ba59100ee568e216bdaeddbec"
IMAGE_SIZE = 380
EXPECTED_ID2LABEL = {
    0: "safe",
    1: "hentai",
    2: "porn",
    3: "sexy",
    4: "drawing",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_io(path: Path) -> None:
    model = onnx.load(str(path))
    inputs = {value.name: value for value in model.graph.input}
    outputs = {value.name: value for value in model.graph.output}

    if set(inputs) != {"pixel_values"} or set(outputs) != {"logits"}:
        raise SystemExit(
            f"unexpected ONNX I/O: inputs={sorted(inputs)}, outputs={sorted(outputs)}"
        )

    input_dims = [d.dim_value for d in inputs["pixel_values"].type.tensor_type.shape.dim]
    output_dims = [d.dim_value for d in outputs["logits"].type.tensor_type.shape.dim]
    if input_dims != [1, 3, IMAGE_SIZE, IMAGE_SIZE]:
        raise SystemExit(f"unexpected input shape: {input_dims}")
    if output_dims[-1] != 5:
        raise SystemExit(f"unexpected output shape: {output_dims}")


def compare_logits(model: torch.nn.Module, path: Path) -> None:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name

    generator = torch.Generator().manual_seed(0)
    cases = {
        "zeros": np.zeros((1, 3, IMAGE_SIZE, IMAGE_SIZE), dtype=np.float32),
        "random": torch.randn(
            (1, 3, IMAGE_SIZE, IMAGE_SIZE), generator=generator
        ).numpy(),
    }
    for name, array in cases.items():
        with torch.no_grad():
            torch_logits = model(torch.from_numpy(array)).logits.numpy()
        onnx_logits = session.run([output_name], {input_name: array})[0]
        if torch_logits.shape != (1, 5) or onnx_logits.shape != (1, 5):
            raise SystemExit(
                f"{name}: unexpected logits shapes {torch_logits.shape} {onnx_logits.shape}"
            )
        diff = float(np.max(np.abs(torch_logits - onnx_logits)))
        print(f"{name}: max |onnx - pytorch| = {diff:.3e}")
        if diff >= 1e-4:
            raise SystemExit(f"{name}: ONNX logits differ from PyTorch by {diff}")


def main() -> int:
    model = AutoModelForImageClassification.from_pretrained(MODEL_ID).eval()

    id2label = {int(k): v for k, v in model.config.id2label.items()}
    if id2label != EXPECTED_ID2LABEL:
        raise SystemExit(
            f"unexpected id2label mapping: {id2label}; "
            f"expected {EXPECTED_ID2LABEL}"
        )

    DEST.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        model,
        (dummy,),
        str(DEST),
        input_names=["pixel_values"],
        output_names=["logits"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
        export_params=True,
    )

    check_io(DEST)
    compare_logits(model, DEST)

    size = DEST.stat().st_size
    sha256 = sha256_file(DEST)
    print(f"wrote {DEST}")
    print(f"size: {size}")
    print(f"sha256: {sha256}")
    if sha256 != EXPECTED_SHA256:
        print(
            "WARNING: SHA-256 differs from the value recorded in models/README.md "
            "and verify.py; update both if this export is intentional.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
