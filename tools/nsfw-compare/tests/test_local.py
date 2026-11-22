"""Local nsfw-detection-2-mini ONNX classifier."""

from __future__ import annotations

import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from nsfw_compare.local import (
    CLASSES,
    LocalClassifier,
    LocalModelError,
    probabilities_from_logits,
)
from nsfw_compare.preprocess import ModelInputSize

ROOT = Path(__file__).resolve().parents[3]
MODEL = ROOT / "models" / "nsfw_detection_2_mini.onnx"


class SoftmaxTest(unittest.TestCase):
    def test_uniform_logits_give_uniform_probabilities(self) -> None:
        probs = probabilities_from_logits([0.0, 0.0, 0.0, 0.0, 0.0])
        self.assertEqual(set(probs), set(CLASSES))
        for value in probs.values():
            self.assertAlmostEqual(value, 0.2, places=6)

    def test_large_logits_do_not_overflow(self) -> None:
        probs = probabilities_from_logits([1000.0, 0.0, -1000.0, 0.0, 0.0])
        self.assertAlmostEqual(sum(probs.values()), 1.0, places=5)
        self.assertAlmostEqual(probs["safe"], 1.0, places=5)

    def test_wrong_logit_count_raises(self) -> None:
        with self.assertRaises(ValueError):
            probabilities_from_logits([0.0, 1.0])


class MissingModelTest(unittest.TestCase):
    def test_missing_file_raises_local_model_error(self) -> None:
        with self.assertRaises(LocalModelError):
            LocalClassifier(ROOT / "models" / "does-not-exist.onnx")


@unittest.skipUnless(MODEL.is_file(), f"model not found: {MODEL}")
class LocalInferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.classifier = LocalClassifier(MODEL)

    def test_solid_image_yields_five_normalized_probabilities(self) -> None:
        image = Image.new("RGB", (320, 240), (20, 40, 60))
        result = self.classifier.classify(image)
        self.assertEqual(result.model, "nsfw_detection_2_mini")
        self.assertEqual(result.input_size, ModelInputSize)
        self.assertEqual(set(result.probabilities), set(CLASSES))
        self.assertAlmostEqual(sum(result.probabilities.values()), 1.0, places=5)
        for value in result.probabilities.values():
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)

    def test_inference_is_deterministic(self) -> None:
        image = Image.new("RGB", (64, 64), (200, 100, 50))
        first = self.classifier.classify(image)
        second = self.classifier.classify(image)
        for name in CLASSES:
            self.assertAlmostEqual(
                first.probabilities[name], second.probabilities[name], places=6
            )

    def test_logits_array_is_accepted_directly(self) -> None:
        probs = probabilities_from_logits(np.array([0.1, 0.2, 0.3, 0.4, 0.5]))
        self.assertAlmostEqual(sum(probs.values()), 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
