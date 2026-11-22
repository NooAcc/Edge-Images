#!/usr/bin/env python3
"""Download, verify, and inspect the nsfwjs MobileNetV2 ONNX model.

This script is a development/maintenance helper. It is not part of the
Docker or CI build.

Usage:
    python tools/nsfw-model/fetch.py
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort

URLS = [
    "https://hf-mirror.com/deepghs/imgutils-models/resolve/main/nsfw/nsfwjs.onnx",
    "https://huggingface.co/deepghs/imgutils-models/resolve/main/nsfw/nsfwjs.onnx",
]
SHA256 = "510dce55edcd1cf8281cbe906dedb3f4963f8814bc1edfbd42d3bf261148df2d"
DEST = Path(__file__).resolve().parents[2] / "models" / "nsfwjs_mobilenet_v2.onnx"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for url in URLS:
        try:
            print(f"downloading {url}")
            urllib.request.urlretrieve(url, dest)
            return
        except Exception as exc:  # noqa: BLE001 - report and try next mirror
            last_error = exc
            print(f"download failed: {exc}")
    raise SystemExit(f"all mirrors failed: {last_error}")


def main() -> int:
    if not DEST.exists() or DEST.stat().st_size == 0:
        download(DEST)

    actual = sha256_file(DEST)
    if actual != SHA256:
        DEST.unlink(missing_ok=True)
        raise SystemExit(f"sha256 mismatch: got {actual}, want {SHA256}")

    print(f"model: {DEST} ({DEST.stat().st_size} bytes)")
    print(f"sha256: {actual}")

    session = ort.InferenceSession(str(DEST), providers=["CPUExecutionProvider"])
    for inp in session.get_inputs():
        print(f"INPUT {inp.name} {inp.shape} {inp.type}")
    for out in session.get_outputs():
        print(f"OUTPUT {out.name} {out.shape} {out.type}")

    input_name = session.get_inputs()[0].name
    zero = np.zeros((1, 224, 224, 3), dtype=np.float32)
    result = session.run(None, {input_name: zero})[0]

    if result.shape != (1, 5):
        raise SystemExit(f"unexpected output shape: {result.shape}")
    total = float(result.sum())
    print(f"zero-input sum: {total:.4f}")
    if abs(total - 1.0) >= 1e-3:
        raise SystemExit("output does not look like softmax probabilities")

    return 0


if __name__ == "__main__":
    sys.exit(main())
