"""Decode uploaded images and fit them into Cloudflare's clef limits.

Clef accepts embedded PNG/JPEG/WebP only: at most 4 MiB and 16 megapixels per
image, 8 MiB total decoded. Unsupported formats and oversized inputs are
converted here so the UI can explain what happened.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

CLEF_MAX_BYTES = 4 * 1024 * 1024
CLEF_MAX_PIXELS = 16_000_000
CLEF_FORMATS = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
}
QUALITY_LADDER = (85, 75, 65, 55, 45, 35)


class ImageError(ValueError):
    """The upload could not be decoded or could not be made Clef-compatible."""


@dataclass(frozen=True)
class PreparedImage:
    data: bytes
    content_type: str
    width: int
    height: int
    note: str | None = None


def _open(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageError("无法识别的图片格式") from exc


def load_rgb(data: bytes) -> Image.Image:
    """Decode any Pillow-readable image to RGB for local inference."""
    return _open(data).convert("RGB")


def _encode(image: Image.Image, fmt: str, quality: int | None = None) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG":
        image.convert("RGB").save(
            buf, format="JPEG", quality=quality or 85, optimize=True
        )
    elif fmt == "WEBP":
        image.save(buf, format="WEBP", quality=quality or 85)
    else:
        image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _encode_within(
    image: Image.Image, fmt: str, max_bytes: int
) -> tuple[bytes, Image.Image]:
    current = image
    for _ in range(12):
        if fmt in ("JPEG", "WEBP"):
            for quality in QUALITY_LADDER:
                encoded = _encode(current, fmt, quality)
                if len(encoded) <= max_bytes:
                    return encoded, current
        else:
            encoded = _encode(current, "PNG")
            if len(encoded) <= max_bytes:
                return encoded, current

        width, height = current.size
        if width <= 1 and height <= 1:
            break
        current = current.resize(
            (max(1, width // 2), max(1, height // 2)), Image.Resampling.LANCZOS
        )
    raise ImageError("无法把图片压缩到 Cloudflare 的体积限制内")


def prepare_for_clef(
    data: bytes,
    max_bytes: int = CLEF_MAX_BYTES,
    max_pixels: int = CLEF_MAX_PIXELS,
) -> PreparedImage:
    image = _open(data)
    fmt = (image.format or "").upper()
    width, height = image.size

    if (
        fmt in CLEF_FORMATS
        and len(data) <= max_bytes
        and width * height <= max_pixels
    ):
        return PreparedImage(data, CLEF_FORMATS[fmt], width, height, None)

    notes: list[str] = []
    if fmt in CLEF_FORMATS:
        target_fmt = fmt
    else:
        target_fmt = "PNG"
        notes.append(f"格式 {fmt or '未知'} 不受 Cloudflare 支持，已转为 PNG")

    rgb = image.convert("RGB")
    if rgb.width * rgb.height > max_pixels:
        scale = math.sqrt(max_pixels / (rgb.width * rgb.height))
        new_width = max(1, int(rgb.width * scale))
        new_height = max(1, int(rgb.height * scale))
        rgb = rgb.resize((new_width, new_height), Image.Resampling.LANCZOS)
        notes.append(
            f"已缩放到 {new_width}×{new_height}"
            f"（{new_width * new_height / 1_000_000:.1f} MP）"
        )

    encoded, final = _encode_within(rgb, target_fmt, max_bytes)
    if len(encoded) < len(data):
        notes.append(f"已重新压缩到 {len(encoded) / 1_048_576:.1f} MB")

    return PreparedImage(
        encoded,
        CLEF_FORMATS[target_fmt],
        final.width,
        final.height,
        "；".join(notes) or None,
    )
