#!/usr/bin/env python3
"""Verify the nsfw-detection-2-mini ONNX export and its preprocessing.

This script is a development/maintenance helper. It is not part of the
Docker or CI build.

Usage:
    python tools/nsfw-model/verify.py
    python tools/nsfw-model/verify.py --model /data/models/nsfw_detection_2_mini.onnx
    python tools/nsfw-model/verify.py --image path/to/image.jpg

Running without --image checks the model hash and I/O, cross-checks PyTorch
against ONNX Runtime, verifies that the Go preprocessing formula matches the
upstream processor, and rewrites the Go golden file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# Must be set before transformers/huggingface_hub read it.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402
from transformers import (  # noqa: E402
    AutoModelForImageClassification,
    EfficientNetImageProcessorPil,
)

MODEL_ID = "viddexa/nsfw-detection-2-mini"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = ROOT / "models" / "nsfw_detection_2_mini.onnx"
DEFAULT_GOLDEN = ROOT / "internal" / "nsfw" / "testdata" / "preprocess_golden.json"
EXPECTED_SHA256 = "b747929f02a129b77db27daf29eb100aa424d78ba59100ee568e216bdaeddbec"
IMAGE_SIZE = 380
RESCALE_FACTOR = 0.00392156862745098
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float64)
STD = np.array([0.47853944, 0.4732864, 0.47434163], dtype=np.float64)
CLASSES = ["safe", "hentai", "porn", "sexy", "drawing"]
GOLDEN_SAMPLES = 512


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_session(path: Path) -> ort.InferenceSession:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    outputs = session.get_outputs()
    if len(inputs) != 1 or len(outputs) != 1:
        raise SystemExit(
            f"unexpected ONNX I/O count: {len(inputs)} inputs, {len(outputs)} outputs"
        )
    if inputs[0].name != "pixel_values" or outputs[0].name != "logits":
        raise SystemExit(
            f"unexpected ONNX names: {inputs[0].name} -> {outputs[0].name}"
        )
    input_shape = inputs[0].shape
    if list(input_shape[1:]) != [3, IMAGE_SIZE, IMAGE_SIZE]:
        raise SystemExit(f"unexpected input shape: {input_shape}")
    output_shape = outputs[0].shape
    if output_shape[-1] != 5:
        raise SystemExit(f"unexpected output shape: {output_shape}")
    return session


def make_image(width: int, height: int) -> Image.Image:
    data = bytearray(width * height * 3)
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 3
            for c in range(3):
                data[offset + c] = (x * 7 + y * 13 + c * 29) & 0xFF
    return Image.frombytes("RGB", (width, height), bytes(data))


def pillow_nearest_indices(src_size: int, dst_size: int) -> list[int]:
    """Reproduce Pillow's NEAREST sampling centres exactly."""
    scale = float(src_size) / float(dst_size)
    pos = scale * 0.5
    indices = []
    for _ in range(dst_size):
        idx = int(pos)
        if idx < 0:
            idx = 0
        if idx >= src_size:
            idx = src_size - 1
        indices.append(idx)
        pos += scale
    return indices


def rebuild_preprocessing(image: Image.Image) -> np.ndarray:
    """Rebuild the Go PreprocessRGB tensor from the raw RGB pixels."""
    width, height = image.size
    raw = np.frombuffer(image.tobytes(), dtype=np.uint8)
    raw = raw.reshape(height, width, 3).astype(np.float64)
    x_tab = pillow_nearest_indices(width, IMAGE_SIZE)
    y_tab = pillow_nearest_indices(height, IMAGE_SIZE)
    sampled = raw[y_tab][:, x_tab]
    values = sampled * RESCALE_FACTOR
    values = (values - MEAN) / STD
    values = values / STD
    return np.transpose(values, (2, 0, 1))[None].astype(np.float32)


def processor_tensor(processor, image: Image.Image) -> np.ndarray:
    return processor(images=image, return_tensors="pt")["pixel_values"].numpy()


def run_onnx(session: ort.InferenceSession, tensor: np.ndarray) -> np.ndarray:
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    return session.run([output_name], {input_name: tensor.astype(np.float32)})[0]


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits)
    exps = np.exp(shifted)
    return exps / exps.sum()


def check_cases(processor, torch_model, session) -> list[dict]:
    cases = [("upscale", 7, 5), ("downscale", 761, 757)]
    golden_cases = []

    for name, width, height in cases:
        image = make_image(width, height)
        processor_values = processor_tensor(processor, image)
        rebuilt = rebuild_preprocessing(image)

        if processor_values.shape != (1, 3, IMAGE_SIZE, IMAGE_SIZE):
            raise SystemExit(
                f"{name}: processor shape {processor_values.shape}, "
                f"expected (1, 3, {IMAGE_SIZE}, {IMAGE_SIZE})"
            )
        preprocess_diff = float(np.max(np.abs(processor_values - rebuilt)))
        print(f"{name}: max |rebuild - processor| = {preprocess_diff:.3e}")
        if preprocess_diff >= 1e-6:
            raise SystemExit(
                f"{name}: preprocessing differs from the upstream processor "
                f"by {preprocess_diff}"
            )

        with torch.no_grad():
            torch_logits = torch_model(
                torch.from_numpy(processor_values)
            ).logits.numpy()
        onnx_logits = run_onnx(session, processor_values)
        logits_diff = float(np.max(np.abs(torch_logits - onnx_logits)))
        scale = float(np.max(np.abs(torch_logits)))
        print(
            f"{name}: max |onnx - pytorch| = {logits_diff:.3e} "
            f"(relative {logits_diff / max(scale, 1e-9):.3e})"
        )
        # Large logits (e.g. 28.0) sit near float32 ULP limits, so compare with
        # an absolute floor plus a small relative tolerance.
        if not np.allclose(torch_logits, onnx_logits, atol=1e-4, rtol=1e-5):
            raise SystemExit(f"{name}: ONNX logits differ from PyTorch by {logits_diff}")

        flat = processor_values.reshape(-1)
        total = flat.size
        indices = [(i * total) // GOLDEN_SAMPLES for i in range(GOLDEN_SAMPLES)]
        golden_cases.append(
            {
                "name": name,
                "width": width,
                "height": height,
                "samples": [
                    {"index": int(idx), "value": float(flat[idx])}
                    for idx in indices
                ],
            }
        )

    print("preprocess matches processor")
    print("onnx matches pytorch")
    return golden_cases


def write_golden(path: Path, cases: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": MODEL_ID,
        "inputSize": IMAGE_SIZE,
        "sourceFormula": "x*7+y*13+c*29",
        "cases": cases,
    }
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    print(f"wrote {path} ({sum(len(c['samples']) for c in cases)} samples)")


def classify_image(path: Path, processor, session) -> None:
    image = Image.open(path).convert("RGB")
    tensor = processor_tensor(processor, image)
    probs = softmax(run_onnx(session, tensor)[0])
    nsfw_score = float(probs[1] + probs[2] + probs[3])
    print(f"image: {path}")
    for label, p in zip(CLASSES, probs):
        print(f"  {label}: {float(p):.6f}")
    print(f"  isNsfw (threshold 0.5): {nsfw_score >= 0.5}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--image", type=Path, default=None)
    parser.add_argument("--golden", type=Path, default=DEFAULT_GOLDEN)
    args = parser.parse_args()

    sha256 = sha256_file(args.model)
    print(f"model: {args.model}")
    print(f"sha256: {sha256}")
    if sha256 != EXPECTED_SHA256:
        raise SystemExit(
            f"model SHA-256 does not match the recorded value {EXPECTED_SHA256}"
        )
    print(f"size: {args.model.stat().st_size}")

    session = load_session(args.model)
    print("onnx I/O: pixel_values [1,3,380,380] -> logits [*,5]")

    processor = EfficientNetImageProcessorPil.from_pretrained(MODEL_ID)
    if args.image is not None:
        classify_image(args.image, processor, session)
        return 0

    torch_model = AutoModelForImageClassification.from_pretrained(MODEL_ID).eval()
    cases = check_cases(processor, torch_model, session)
    write_golden(args.golden, cases)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
