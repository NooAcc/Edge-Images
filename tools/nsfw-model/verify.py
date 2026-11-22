#!/usr/bin/env python3
"""Verify the bundled nsfwjs ONNX model and the alignCorners preprocessing.

This script is a development helper; it is not part of the Docker/CI build.

Checks:
  1. Model file SHA-256, input/output shape and dtype, softmax probability sum.
  2. The alignCorners 2x2 -> 4x4 reference matrix used by the Go unit test.
  3. Runs the Go unit test for the same reference matrix (when `go` exists).
  4. Optional: when `node` and `@tensorflow/tfjs` are available, compares
     tf.image.resizeBilinear(..., alignCorners=true) against the same reference
     values; max absolute difference must be < 1e-6.

Together, (2)+(3) pin the Go implementation to the reference matrix and (4)
pins that matrix to TFJS.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "models" / "nsfwjs_mobilenet_v2.onnx"
SHA256 = "510dce55edcd1cf8281cbe906dedb3f4963f8814bc1edfbd42d3bf261148df2d"

SRC_2X2 = [
    [[0, 0, 0], [255, 0, 0]],
    [[0, 255, 0], [255, 255, 255]],
]

# Expected values from the plan/spec, scaled to [0,1].
EXPECTED_4X4 = [
    [0, 0, 0], [1 / 3, 0, 0], [2 / 3, 0, 0], [1, 0, 0],
    [0, 1 / 3, 0], [1 / 3, 1 / 3, 1 / 9], [2 / 3, 1 / 3, 2 / 9], [1, 1 / 3, 1 / 3],
    [0, 2 / 3, 0], [1 / 3, 2 / 3, 2 / 9], [2 / 3, 2 / 3, 4 / 9], [1, 2 / 3, 2 / 3],
    [0, 1, 0], [1 / 3, 1, 1 / 3], [2 / 3, 1, 2 / 3], [1, 1, 1],
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resize_bilinear_align_corners(
    src: list[list[list[int]]], width: int, height: int, out_w: int, out_h: int
) -> list[float]:
    out: list[float] = []
    for y in range(out_h):
        src_y = y * (height - 1) / (out_h - 1) if out_h > 1 else 0.0
        y0 = math.floor(src_y)
        y1 = min(y0 + 1, height - 1)
        fy = src_y - y0
        for x in range(out_w):
            src_x = x * (width - 1) / (out_w - 1) if out_w > 1 else 0.0
            x0 = math.floor(src_x)
            x1 = min(x0 + 1, width - 1)
            fx = src_x - x0
            for c in range(3):
                p00 = src[y0][x0][c]
                p01 = src[y0][x1][c]
                p10 = src[y1][x0][c]
                p11 = src[y1][x1][c]
                top = p00 + (p01 - p00) * fx
                bottom = p10 + (p11 - p10) * fx
                out.append((top + (bottom - top) * fy) / 255.0)
    return out


def check_model() -> list[str]:
    errors: list[str] = []
    if not MODEL.exists():
        return [f"model not found: {MODEL} (run tools/nsfw-model/fetch.py)"]

    actual = sha256_file(MODEL)
    if actual != SHA256:
        errors.append(f"sha256 mismatch: got {actual}, want {SHA256}")

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    outputs = session.get_outputs()
    if len(inputs) != 1 or len(outputs) != 1:
        errors.append(f"expected 1 input/output, got {len(inputs)}/{len(outputs)}")
        return errors

    inp, out = inputs[0], outputs[0]
    if list(inp.shape[1:]) != [224, 224, 3]:
        errors.append(f"unexpected input shape {inp.shape}")
    if inp.type != "tensor(float)":
        errors.append(f"unexpected input type {inp.type}")
    if out.shape[-1] != 5:
        errors.append(f"unexpected output shape {out.shape}")
    print(f"INPUT {inp.name} {inp.shape} {inp.type}")
    print(f"OUTPUT {out.name} {out.shape} {out.type}")

    for name, value in (
        ("zero", np.zeros((1, 224, 224, 3), dtype=np.float32)),
        ("grey", np.full((1, 224, 224, 3), 128 / 255.0, dtype=np.float32)),
    ):
        probs = session.run(None, {inp.name: value})[0]
        total = float(probs.sum())
        print(f"{name}-input sum: {total:.6f}")
        if not np.isfinite(probs).all():
            errors.append(f"{name} input produced non-finite scores")
        if abs(total - 1.0) >= 1e-3:
            errors.append(f"{name} input probability sum is {total}")

    return errors


def check_reference() -> float:
    got = resize_bilinear_align_corners(SRC_2X2, 2, 2, 4, 4)
    expected = [v for px in EXPECTED_4X4 for v in px]
    return max(abs(a - b) for a, b in zip(got, expected))


def check_go() -> str:
    if shutil.which("go") is None:
        return "skipped (go not found)"
    proc = subprocess.run(
        ["go", "test", "./internal/nsfw", "-run", "TestResizeBilinearAlignCorners2x2To4x4"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return f"FAILED\n{proc.stdout}\n{proc.stderr}"
    return "ok"


def check_tfjs() -> str:
    if shutil.which("node") is None:
        return "skipped (node not found)"

    js = r"""
const tf = require('@tensorflow/tfjs');
const src = tf.tensor3d(
  [[[0,0,0],[255,0,0]],[[0,255,0],[255,255,255]]], [2,2,3], 'float32');
const out = tf.image.resizeBilinear(src, [4,4], true).div(255);
console.log(JSON.stringify(Array.from(out.dataSync())));
"""
    try:
        proc = subprocess.run(
            ["node", "-e", js], cwd=ROOT, capture_output=True, text=True, timeout=60
        )
    except Exception as exc:  # noqa: BLE001
        return f"skipped ({exc})"
    if proc.returncode != 0:
        return "skipped (@tensorflow/tfjs is not installed)"

    values = json.loads(proc.stdout)
    expected = resize_bilinear_align_corners(SRC_2X2, 2, 2, 4, 4)
    diff = max(abs(a - b) for a, b in zip(values, expected))
    if diff >= 1e-6:
        return f"FAILED (max diff {diff})"
    return f"ok (max diff {diff:.2e})"


def main() -> int:
    errors: list[str] = []

    print("== model ==")
    errors.extend(check_model())

    print("== alignCorners reference ==")
    ref_diff = check_reference()
    print(f"2x2 -> 4x4 max abs diff: {ref_diff}")
    if ref_diff >= 1e-6:
        errors.append(f"reference matrix mismatch: {ref_diff}")

    print("== Go implementation ==")
    go_result = check_go()
    print(go_result)
    if go_result.startswith("FAILED"):
        errors.append("go unit test failed")

    print("== TFJS cross-check ==")
    tfjs_result = check_tfjs()
    print(tfjs_result)
    if tfjs_result.startswith("FAILED"):
        errors.append("tfjs cross-check failed")

    if errors:
        print("\nFAILED:")
        for err in errors:
            print(f"- {err}")
        return 1

    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
