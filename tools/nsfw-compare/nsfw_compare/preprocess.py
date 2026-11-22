"""Exact replica of the server-side preprocessing for nsfw-detection-2-mini.

Mirrors internal/nsfw/preprocess.go and tools/nsfw-model/verify.py: Pillow's
NEAREST resize to 380x380, rescale by 1/255, ImageNet normalization, then the
extra include_top division by std. The result is a float32 NCHW tensor.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

ModelInputSize = 380
RESCALE_FACTOR = 0.00392156862745098
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float64)
STD = np.array([0.47853944, 0.4732864, 0.47434163], dtype=np.float64)

CLASSES = ("safe", "hentai", "porn", "sexy", "drawing")


def nearest_indices(src_size: int, dst_size: int) -> list[int]:
    """Reproduce Pillow's NEAREST sampling centres.

    Pillow walks a source position that starts at scale*0.5 and advances by
    scale per output pixel; the index is the truncated position, clamped to
    the source bounds.
    """
    if src_size <= 0 or dst_size <= 0:
        return []
    scale = float(src_size) / float(dst_size)
    pos = scale * 0.5
    out: list[int] = []
    for _ in range(dst_size):
        idx = int(pos)
        if idx < 0:
            idx = 0
        elif idx >= src_size:
            idx = src_size - 1
        out.append(idx)
        pos += scale
    return out


def preprocess_image(image: Image.Image) -> np.ndarray:
    """Return the [1, 3, 380, 380] float32 tensor for an RGB image."""
    rgb = image.convert("RGB")
    width, height = rgb.size
    if width <= 0 or height <= 0:
        raise ValueError(f"invalid image dimensions {width}x{height}")

    raw = np.frombuffer(rgb.tobytes(), dtype=np.uint8)
    raw = raw.reshape(height, width, 3).astype(np.float64)
    x_tab = nearest_indices(width, ModelInputSize)
    y_tab = nearest_indices(height, ModelInputSize)
    sampled = raw[y_tab][:, x_tab]

    values = sampled * RESCALE_FACTOR
    values = (values - MEAN) / STD
    values = values / STD
    return np.transpose(values, (2, 0, 1))[None].astype(np.float32)
