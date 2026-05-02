import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { noopImageLogger } from "./image-logger.js";
import { planImageTransform } from "./image-geometry.js";

const require = createRequire(import.meta.url);
const AVIF_DECODER_WASM_PATH = require.resolve("@jsquash/avif/codec/dec/avif_dec.wasm");

let photonModulePromise;
let webpModulePromise;
let avifModulePromise;
let avifDecoderInitPromise;
let avifDecoderWasmModulePromise;

const AVIF_BRANDS = new Set(["avif", "avis"]);

function isAvifFormat(bytes, contentType = "") {
  if (String(contentType).toLowerCase().split(";")[0].trim() === "image/avif") {
    return true;
  }

  if (bytes.length < 16 || readAscii(bytes, 4, 8) !== "ftyp") {
    return false;
  }

  if (AVIF_BRANDS.has(readAscii(bytes, 8, 12))) {
    return true;
  }

  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const declaredEnd = boxSize >= 16 && boxSize <= bytes.length ? boxSize : bytes.length;
  const end = Math.min(declaredEnd, 256);

  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (AVIF_BRANDS.has(readAscii(bytes, offset, offset + 4))) {
      return true;
    }
  }

  return false;
}

async function defaultDecodeAvif(buffer, { logger = noopImageLogger } = {}) {
  if (!avifModulePromise) {
    avifModulePromise = import("@jsquash/avif/decode.js");
  }

  const { default: decode, init } = await avifModulePromise;
  await initAvifDecoder(init, logger);
  return decode(buffer);
}

async function initAvifDecoder(init, logger) {
  if (!avifDecoderInitPromise) {
    avifDecoderInitPromise = loadAvifDecoderWasmModule(logger)
      .then((wasmModule) => init(wasmModule))
      .then(() => {
        logger.info("image.decode.avif_wasm_init_done", {
          wasmPath: AVIF_DECODER_WASM_PATH
        });
      })
      .catch((error) => {
        avifDecoderInitPromise = undefined;
        throw error;
      });
  }

  return avifDecoderInitPromise;
}

async function loadAvifDecoderWasmModule(logger) {
  if (!avifDecoderWasmModulePromise) {
    logger.info("image.decode.avif_wasm_load_start", {
      wasmPath: AVIF_DECODER_WASM_PATH
    });

    avifDecoderWasmModulePromise = readFile(AVIF_DECODER_WASM_PATH)
      .then((wasmBytes) => {
        logger.info("image.decode.avif_wasm_load_done", {
          wasmPath: AVIF_DECODER_WASM_PATH,
          wasmBytes: wasmBytes.byteLength
        });

        return WebAssembly.compile(wasmBytes);
      })
      .catch((error) => {
        avifDecoderWasmModulePromise = undefined;
        throw error;
      });
  }

  return avifDecoderWasmModulePromise;
}

export async function processImage(sourceBuffer, params, dependencies = {}) {
  const photon = dependencies.photon || (await loadPhoton());
  const encodeWebp = dependencies.encodeWebp || defaultWebpEncoder;
  const decodeAvif = dependencies.decodeAvif || defaultDecodeAvif;
  const logger = dependencies.logger || noopImageLogger;
  const imageBytes = sourceBuffer instanceof Uint8Array ? sourceBuffer : Uint8Array.from(sourceBuffer);
  const sourceContentType = params.sourceContentType || "";
  const inputFormat = isAvifFormat(imageBytes, sourceContentType) ? "avif" : "photon";
  const startedAt = Date.now();

  let current;
  const disposed = new WeakSet();
  const dispose = (image) => {
    if (!image || disposed.has(image) || typeof image.free !== "function") {
      return;
    }

    image.free();
    disposed.add(image);
  };

  const replaceCurrent = (nextImage) => {
    if (nextImage !== current) {
      dispose(current);
      current = nextImage;
    }
  };

  logger.info("image.process.start", {
    sourceBytes: imageBytes.byteLength,
    sourceContentType,
    inputFormat,
    width: params.width,
    height: params.height,
    fit: params.fit,
    quality: params.quality
  });

  try {
    logger.info("image.decode.start", {
      inputFormat,
      sourceContentType,
      sourceBytes: imageBytes.byteLength
    });

    if (inputFormat === "avif") {
      const imageData = await decodeAvif(imageBytes, { logger });
      current = createPhotonImageFromRawPixels(
        photon,
        new Uint8Array(imageData.data),
        imageData.width,
        imageData.height
      );
    } else {
      current = photon.PhotonImage.new_from_byteslice(imageBytes);
    }

    logger.info("image.decode.done", {
      inputFormat,
      width: getWidth(current),
      height: getHeight(current),
      durationMs: Date.now() - startedAt
    });

    current = applyOrientation(current, params, photon, replaceCurrent);
    applyGeometry(current, params, photon, replaceCurrent, dispose, logger);

    const webpBytes = await encodeWebp(current, params.quality);
    logger.info("image.encode.done", {
      outputContentType: "image/webp",
      outputBytes: webpBytes.byteLength,
      width: getWidth(current),
      height: getHeight(current),
      durationMs: Date.now() - startedAt
    });

    return Buffer.from(webpBytes);
  } catch (error) {
    logger.warn("image.process.failed", {
      error,
      inputFormat,
      sourceContentType,
      sourceBytes: imageBytes.byteLength,
      durationMs: Date.now() - startedAt
    });

    throw error;
  } finally {
    dispose(current);
  }
}

export async function loadPhoton() {
  if (!photonModulePromise) {
    photonModulePromise = import("@cf-wasm/photon/node");
  }

  return photonModulePromise;
}

function applyOrientation(current, params, photon, replaceCurrent) {
  let working = current;

  if (params.rotate) {
    working = photon.rotate(working, params.rotate);
    replaceCurrent(working);
  }

  if (params.flip?.includes("h")) {
    photon.fliph(working);
  }

  if (params.flip?.includes("v")) {
    photon.flipv(working);
  }

  return working;
}

function applyGeometry(current, params, photon, replaceCurrent, dispose, logger) {
  const plan = planImageTransform(getWidth(current), getHeight(current), params);
  logger.info("image.transform.plan", {
    sourceWidth: getWidth(current),
    sourceHeight: getHeight(current),
    ...summarizePlan(plan)
  });

  if (plan.type === "none") {
    return;
  }

  if (plan.type === "resize") {
    replaceCurrent(resizeImage(photon, current, plan.width, plan.height));
    return;
  }

  if (plan.type === "cover") {
    let base = current;
    const crop = plan.crop;
    if (crop.x !== 0 || crop.y !== 0 || crop.width !== getWidth(current) || crop.height !== getHeight(current)) {
      base = photon.crop(current, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
      replaceCurrent(base);
    }

    if (getWidth(base) !== plan.width || getHeight(base) !== plan.height) {
      replaceCurrent(resizeImage(photon, base, plan.width, plan.height));
    }
    return;
  }

  if (plan.type === "pad") {
    let resized = current;
    if (plan.resizeWidth !== getWidth(current) || plan.resizeHeight !== getHeight(current)) {
      resized = resizeImage(photon, current, plan.resizeWidth, plan.resizeHeight);
    }

    const composed = composeOnBackground(photon, resized, plan);
    if (resized !== current) {
      dispose(resized);
    }

    replaceCurrent(composed);
  }
}

function resizeImage(photon, image, width, height) {
  const filter = photon.SamplingFilter?.Lanczos3 ?? 5;
  return photon.resize(image, width, height, filter);
}

export function composeOnBackground(photon, image, plan) {
  const sourceWidth = getWidth(image);
  const sourceHeight = getHeight(image);
  const sourcePixels = image.get_raw_pixels();
  const targetPixels = new Uint8Array(plan.width * plan.height * 4);
  const [red, green, blue] = plan.background;

  for (let index = 0; index < targetPixels.length; index += 4) {
    targetPixels[index] = red;
    targetPixels[index + 1] = green;
    targetPixels[index + 2] = blue;
    targetPixels[index + 3] = 255;
  }

  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceStart = y * sourceWidth * 4;
    const sourceEnd = sourceStart + sourceWidth * 4;
    const targetStart = ((y + plan.offsetY) * plan.width + plan.offsetX) * 4;
    targetPixels.set(sourcePixels.slice(sourceStart, sourceEnd), targetStart);
  }

  return createPhotonImageFromRawPixels(photon, targetPixels, plan.width, plan.height);
}

export async function defaultWebpEncoder(image, quality) {
  try {
    return await encodeWithWebpWasm(image, quality);
  } catch (error) {
    if (typeof image.get_bytes_webp === "function") {
      return image.get_bytes_webp(quality);
    }

    throw error;
  }
}

async function encodeWithWebpWasm(image, quality) {
  if (!webpModulePromise) {
    webpModulePromise = import("webp-wasm");
  }

  const module = await webpModulePromise;
  const encode = module.encode || module.default?.encode;
  if (typeof encode !== "function") {
    throw new Error("webp-wasm encode function is unavailable");
  }

  const rawPixels = image.get_raw_pixels();
  return encode(
    {
      data: new Uint8ClampedArray(rawPixels),
      width: getWidth(image),
      height: getHeight(image)
    },
    { quality }
  );
}

function getWidth(image) {
  return Number(image.get_width());
}

function getHeight(image) {
  return Number(image.get_height());
}

function createPhotonImageFromRawPixels(photon, pixels, width, height) {
  return new photon.PhotonImage(pixels, width, height);
}

function readAscii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function summarizePlan(plan) {
  return Object.fromEntries(
    Object.entries(plan).map(([key, value]) => [
      key === "type" ? "planType" : key,
      value
    ])
  );
}
