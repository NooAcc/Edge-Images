import assert from "node:assert/strict";
import test from "node:test";

import { inferTargetBox, planImageTransform } from "../lib/image-geometry.js";

test("inferTargetBox preserves aspect ratio and the 1024 output limit", () => {
  assert.deepEqual(inferTargetBox(400, 800, { width: 1024 }), {
    width: 512,
    height: 1024,
    scale: 0.5
  });

  assert.deepEqual(inferTargetBox(5000, 2500, {}), {
    width: 1024,
    height: 512,
    scale: 0.2048
  });
});

test("scale-down never upscales", () => {
  assert.deepEqual(planImageTransform(500, 500, { width: 1024, height: 1024, fit: "scale-down" }), {
    type: "none",
    width: 500,
    height: 500
  });
});

test("scale-down enforces max dimensions when no size is provided", () => {
  assert.deepEqual(planImageTransform(5000, 5000, { fit: "scale-down" }), {
    type: "resize",
    width: 1024,
    height: 1024
  });
});

test("pad keeps the full image visible and centers it on the requested canvas", () => {
  assert.deepEqual(
    planImageTransform(800, 400, {
      width: 500,
      height: 500,
      fit: "pad",
      background: [255, 0, 0]
    }),
    {
      type: "pad",
      width: 500,
      height: 500,
      resizeWidth: 500,
      resizeHeight: 250,
      offsetX: 0,
      offsetY: 125,
      background: [255, 0, 0]
    }
  );
});

test("cover crops the source before resize to avoid oversized intermediate images", () => {
  assert.deepEqual(
    planImageTransform(5000, 1000, {
      width: 500,
      height: 500,
      fit: "cover"
    }),
    {
      type: "cover",
      width: 500,
      height: 500,
      crop: {
        x: 2000,
        y: 0,
        width: 1000,
        height: 1000
      }
    }
  );
});
