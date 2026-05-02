import assert from "node:assert/strict";
import test from "node:test";

import { createImageLogger } from "../lib/image-logger.js";
import { processImage } from "../lib/process-image.js";
import {
  createFakeSharp,
  decodeOutput,
  makeImageBytes
} from "./helpers/fake-sharp.js";
import { createCaptureSink } from "./helpers/capture-logs.js";

test("processImage handles cover resize and passes quality to WebP output", async () => {
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

  assert.deepEqual(decodeOutput(output), {
    width: 800,
    height: 600,
    quality: 50,
    firstPixel: [11, 22, 33, 255],
    flippedH: false,
    flippedV: false
  });
  assert.deepEqual(
    log.filter((entry) => entry.op),
    [
      {
        op: "extract",
        from: [2048, 1536],
        box: [0, 0, 2048, 1536]
      },
      {
        op: "resize",
        from: [2048, 1536],
        to: [800, 600],
        fit: "fill",
        kernel: "lanczos3",
        background: undefined
      }
    ]
  );
});

test("processImage scale-down does not upscale smaller inputs", async () => {
  const output = await processImage(
    makeImageBytes(500, 500),
    {
      width: 1024,
      height: 1024,
      fit: "scale-down",
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
      fit: "scale-down",
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

test("processImage pad fills the surrounding canvas with the requested background", async () => {
  const output = await processImage(
    makeImageBytes(800, 400),
    {
      width: 500,
      height: 500,
      fit: "pad",
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

test("processImage maps post-rotation horizontal flip to sharp vertical pre-flip", async () => {
  const log = [];
  const output = await processImage(
    makeImageBytes(300, 600),
    {
      width: 200,
      fit: "scale-down",
      quality: 85,
      rotate: 90,
      flip: "h",
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
    ["flip", "rotate", "resize"]
  );
  assert.deepEqual(log[0].size, [300, 600]);
  assert.deepEqual(log[1].from, [300, 600]);
});

test("processImage logs source metadata discovered by sharp", async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: "1" },
    sink: capture.sink,
    requestId: "req_avif"
  });

  const output = await processImage(
    makeImageBytes(320, 180, { format: "avif" }),
    {
      fit: "scale-down",
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
  const decodeDone = records.find((record) => record.event === "image.decode.done");

  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
  assert.equal(metadata.quality, 82);
  assert.equal(decodeDone.inputFormat, "avif");
  assert.equal(decodeDone.width, 320);
});
