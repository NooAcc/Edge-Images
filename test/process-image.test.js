import assert from "node:assert/strict";
import test from "node:test";

import { processImage } from "../lib/process-image.js";
import {
  createFakePhoton,
  decodeOutput,
  fakeWebpEncoder,
  makeImageBytes
} from "./helpers/fake-photon.js";

test("processImage handles cover resize and passes quality to the encoder", async () => {
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
      photon: createFakePhoton(log),
      encodeWebp: fakeWebpEncoder
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
        op: "resize",
        from: [2048, 1536],
        to: [800, 600],
        filter: "lanczos3"
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
      photon: createFakePhoton(),
      encodeWebp: fakeWebpEncoder
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
      photon: createFakePhoton(),
      encodeWebp: fakeWebpEncoder
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
      photon: createFakePhoton(),
      encodeWebp: fakeWebpEncoder
    }
  );

  const metadata = decodeOutput(output);
  assert.equal(metadata.width, 500);
  assert.equal(metadata.height, 500);
  assert.deepEqual(metadata.firstPixel, [255, 0, 0, 255]);
});

test("processImage applies rotation before flip and resize", async () => {
  const log = [];
  const output = await processImage(
    makeImageBytes(300, 600),
    {
      width: 200,
      fit: "scale-down",
      quality: 85,
      rotate: 90,
      flip: "hv",
      background: [255, 255, 255]
    },
    {
      photon: createFakePhoton(log),
      encodeWebp: fakeWebpEncoder
    }
  );

  const metadata = decodeOutput(output);
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 100);
  assert.deepEqual(
    log.map((entry) => entry.op),
    ["rotate", "fliph", "flipv", "resize"]
  );
  assert.deepEqual(log[1].size, [600, 300]);
});
