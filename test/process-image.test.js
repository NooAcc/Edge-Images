import assert from "node:assert/strict";
import test from "node:test";

import { createImageLogger } from "../lib/image-logger.js";
import { processImage } from "../lib/process-image.js";
import {
  createFakePhoton,
  decodeOutput,
  fakeWebpEncoder,
  makeImageBytes
} from "./helpers/fake-photon.js";
import { createCaptureSink } from "./helpers/capture-logs.js";

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

test("processImage decodes AVIF when avif is a compatible brand", async () => {
  const capture = createCaptureSink();
  const logger = createImageLogger({
    env: { IMAGE_DEBUG_LOGS: "1" },
    sink: capture.sink,
    requestId: "req_avif"
  });
  let decodeCalls = 0;

  const output = await processImage(
    makeAvifBytes({ majorBrand: "mif1", compatibleBrands: ["mif1", "avif"] }),
    {
      fit: "scale-down",
      quality: 82,
      background: [255, 255, 255],
      flip: ""
    },
    {
      photon: createFakePhoton(),
      encodeWebp: fakeWebpEncoder,
      decodeAvif: async () => {
        decodeCalls += 1;
        return {
          width: 320,
          height: 180,
          data: new Uint8ClampedArray(320 * 180 * 4)
        };
      },
      logger
    }
  );

  const metadata = decodeOutput(output);
  const records = capture.records();
  const decodeDone = records.find((record) => record.event === "image.decode.done");

  assert.equal(decodeCalls, 1);
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
  assert.equal(metadata.quality, 82);
  assert.equal(decodeDone.inputFormat, "avif");
  assert.equal(decodeDone.width, 320);
});

test("processImage loads the AVIF decoder wasm without global fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("unexpected wasm fetch");
  };

  try {
    await assert.rejects(
      () =>
        processImage(
          Buffer.from("not an avif file"),
          {
            sourceContentType: "image/avif",
            fit: "scale-down",
            quality: 82,
            background: [255, 255, 255],
            flip: ""
          },
          {
            photon: createFakePhoton(),
            encodeWebp: fakeWebpEncoder
          }
        ),
      (error) => {
        assert.notEqual(error.message, "unexpected wasm fetch");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeAvifBytes({ majorBrand, compatibleBrands }) {
  const bytes = Buffer.alloc(16 + compatibleBrands.length * 4);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write(majorBrand, 8, "ascii");
  bytes.writeUInt32BE(0, 12);

  compatibleBrands.forEach((brand, index) => {
    bytes.write(brand, 16 + index * 4, "ascii");
  });

  return bytes;
}
