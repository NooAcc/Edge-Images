import assert from "node:assert/strict";
import test from "node:test";

import { createImageLogger } from "../lib/image-logger.js";
import { buildResizeOptions, processImage } from "../lib/process-image.js";
import {
  createFakeSharp,
  decodeOutput,
  makeImageBytes
} from "./helpers/fake-sharp.js";
import { createCaptureSink } from "./helpers/capture-logs.js";

test("buildResizeOptions uses sharp native inside fit as the default cap", () => {
  assert.deepEqual(
    buildResizeOptions({
      fit: "inside",
      background: [255, 255, 255]
    }),
    {
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
      fastShrinkOnLoad: true
    }
  );
});

test("buildResizeOptions passes sharp native fit options directly", () => {
  assert.deepEqual(
    buildResizeOptions({
      width: 800,
      height: 600,
      fit: "cover",
      background: [255, 255, 255]
    }),
    {
      width: 800,
      height: 600,
      fit: "cover",
      withoutEnlargement: true,
      fastShrinkOnLoad: true
    }
  );
});

test("buildResizeOptions adds background only for native contain", () => {
  assert.deepEqual(
    buildResizeOptions({
      width: 500,
      height: 500,
      fit: "contain",
      background: [255, 0, 0]
    }),
    {
      width: 500,
      height: 500,
      fit: "contain",
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  );
});

test("processImage uses one native sharp resize and fastest WebP effort", async () => {
  const log = [];
  const output = await processImage(
    makeImageBytes(2048, 1536),
    {
      width: 800,
      height: 600,
      fit: "cover",
      quality: 50,
      background: [255, 255, 255],
      flip: ""
    },
    {
      sharp: createFakeSharp(log)
    }
  );

  const metadata = decodeOutput(output);
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.quality, 50);
  assert.equal(metadata.webpOptions.effort, 0);
  assert.deepEqual(
    log.filter((entry) => entry.op),
    [
      {
        op: "resize",
        from: [2048, 1536],
        to: [800, 600],
        options: {
          width: 800,
          height: 600,
          fit: "cover",
          withoutEnlargement: true,
          fastShrinkOnLoad: true
        },
        fit: "cover",
        background: undefined
      }
    ]
  );
});

test("processImage native inside fit does not upscale smaller inputs", async () => {
  const output = await processImage(
    makeImageBytes(500, 500),
    {
      width: 1024,
      height: 1024,
      fit: "inside",
      quality: 85,
      background: [255, 255, 255],
      flip: ""
    },
    {
      sharp: createFakeSharp()
    }
  );

  assert.equal(decodeOutput(output).width, 500);
  assert.equal(decodeOutput(output).height, 500);
});

test("processImage enforces max size when dimensions are omitted", async () => {
  const output = await processImage(
    makeImageBytes(5000, 5000),
    {
      fit: "inside",
      quality: 85,
      background: [255, 255, 255],
      flip: ""
    },
    {
      sharp: createFakeSharp()
    }
  );

  assert.equal(decodeOutput(output).width, 1024);
  assert.equal(decodeOutput(output).height, 1024);
});

test("processImage native contain fills the canvas with the requested background", async () => {
  const output = await processImage(
    makeImageBytes(800, 400),
    {
      width: 500,
      height: 500,
      fit: "contain",
      quality: 85,
      background: [255, 0, 0],
      flip: ""
    },
    {
      sharp: createFakeSharp()
    }
  );

  const metadata = decodeOutput(output);
  assert.equal(metadata.width, 500);
  assert.equal(metadata.height, 500);
  assert.deepEqual(metadata.firstPixel, [255, 0, 0, 255]);
});

test("processImage uses sharp native orientation operations", async () => {
  const log = [];
  const output = await processImage(
    makeImageBytes(300, 600),
    {
      width: 200,
      fit: "inside",
      quality: 85,
      rotate: 90,
      flip: "hv",
      background: [255, 255, 255]
    },
    {
      sharp: createFakeSharp(log)
    }
  );

  const metadata = decodeOutput(output);
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 100);
  assert.deepEqual(
    log.map((entry) => entry.op),
    ["rotate", "flip", "flop", "resize"]
  );
});

test("processImage logs sharp native transform plan", async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: "1" },
    sink: capture.sink,
    requestId: "req_avif"
  });

  const output = await processImage(
    makeImageBytes(320, 180, { format: "avif" }),
    {
      fit: "inside",
      quality: 82,
      background: [255, 255, 255],
      flip: "",
      sourceContentType: "image/avif"
    },
    {
      sharp: createFakeSharp(),
      logger
    }
  );

  const metadata = decodeOutput(output);
  const records = capture.records();
  const plan = records.find((record) => record.event === "image.transform.plan");

  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
  assert.equal(metadata.quality, 82);
  assert.equal(plan.inputFormat, "avif");
  assert.equal(plan.resize.fit, "inside");
});
