"""Image decoding, format acceptance, and Cloudflare limit handling."""

from __future__ import annotations

import io
import unittest

from PIL import Image

from nsfw_compare.imaging import (
    CLEF_MAX_BYTES,
    CLEF_MAX_PIXELS,
    ImageError,
    load_rgb,
    prepare_for_clef,
)


def png_bytes(size=(64, 48), color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def gif_bytes(size=(40, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, format="GIF")
    return buf.getvalue()


def jpeg_bytes(size=(64, 48), quality=80) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (30, 120, 200)).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


class PrepareForClefTest(unittest.TestCase):
    def test_png_within_limits_is_passed_through_untouched(self) -> None:
        data = png_bytes()
        prepared = prepare_for_clef(data)
        self.assertEqual(prepared.data, data)
        self.assertEqual(prepared.content_type, "image/png")
        self.assertIsNone(prepared.note)
        self.assertEqual((prepared.width, prepared.height), (64, 48))

    def test_jpeg_and_webp_are_accepted(self) -> None:
        for fmt, content_type in (("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            with self.subTest(format=fmt):
                buf = io.BytesIO()
                Image.new("RGB", (32, 32), (1, 2, 3)).save(buf, format=fmt)
                prepared = prepare_for_clef(buf.getvalue())
                self.assertEqual(prepared.content_type, content_type)
                self.assertIsNone(prepared.note)

    def test_gif_is_converted_to_png(self) -> None:
        prepared = prepare_for_clef(gif_bytes())
        self.assertEqual(prepared.content_type, "image/png")
        self.assertIsNotNone(prepared.note)
        with Image.open(io.BytesIO(prepared.data)) as reopened:
            self.assertEqual(reopened.format, "PNG")

    def test_oversized_pixels_are_downscaled(self) -> None:
        data = png_bytes(size=(400, 300))
        prepared = prepare_for_clef(data, max_pixels=50_000)
        self.assertLessEqual(prepared.width * prepared.height, 50_000)
        self.assertAlmostEqual(prepared.width / prepared.height, 400 / 300, delta=0.01)
        self.assertIsNotNone(prepared.note)
        self.assertEqual(prepared.content_type, "image/png")

    def test_oversized_bytes_are_recompressed(self) -> None:
        data = jpeg_bytes(size=(256, 256), quality=95)
        prepared = prepare_for_clef(data, max_bytes=len(data) // 2)
        self.assertLessEqual(len(prepared.data), len(data) // 2)
        self.assertEqual(prepared.content_type, "image/jpeg")
        self.assertIsNotNone(prepared.note)

    def test_default_limits_match_clef_documentation(self) -> None:
        self.assertEqual(CLEF_MAX_BYTES, 4 * 1024 * 1024)
        self.assertEqual(CLEF_MAX_PIXELS, 16_000_000)

    def test_corrupt_data_raises_image_error(self) -> None:
        with self.assertRaises(ImageError):
            prepare_for_clef(b"not an image")

    def test_transparent_png_is_accepted(self) -> None:
        buf = io.BytesIO()
        Image.new("RGBA", (16, 16), (1, 2, 3, 128)).save(buf, format="PNG")
        prepared = prepare_for_clef(buf.getvalue())
        self.assertEqual(prepared.content_type, "image/png")


class LoadRGBTest(unittest.TestCase):
    def test_rgba_is_flattened_to_rgb(self) -> None:
        buf = io.BytesIO()
        Image.new("RGBA", (8, 8), (10, 20, 30, 100)).save(buf, format="PNG")
        image = load_rgb(buf.getvalue())
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.size, (8, 8))

    def test_corrupt_data_raises_image_error(self) -> None:
        with self.assertRaises(ImageError):
            load_rgb(b"\x00\x01")


if __name__ == "__main__":
    unittest.main()
