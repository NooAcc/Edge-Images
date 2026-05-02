import { planImageTransform } from "./image-geometry.js";

let photonModulePromise;
let webpModulePromise;
let avifModulePromise;

const AVIF_MAGIC = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);

function isAvifFormat(bytes) {
  if (bytes.length < 12) return false;
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand === "avif" || brand === "avis";
  }
  return false;
}

async function decodeAvif(buffer) {
  if (!avifModulePromise) {
    avifModulePromise = import("@jsquash/avif");
  }
  const { decode } = await avifModulePromise;
  return decode(buffer);
}

export async function processImage(sourceBuffer, params, dependencies = {}) {
  const photon = dependencies.photon || (await loadPhoton());
  const encodeWebp = dependencies.encodeWebp || defaultWebpEncoder;
  const imageBytes = sourceBuffer instanceof Uint8Array ? sourceBuffer : Uint8Array.from(sourceBuffer);

  let current;
  if (isAvifFormat(imageBytes)) {
    const imageData = await decodeAvif(imageBytes);
    current = photon.PhotonImage.new(
      new Uint8Array(imageData.data),
      imageData.width,
      imageData.height
    );
  } else {
    current = photon.PhotonImage.new_from_byteslice(imageBytes);
  }

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

  try {
    current = applyOrientation(current, params, photon, replaceCurrent);
    applyGeometry(current, params, photon, replaceCurrent, dispose);

    const webpBytes = await encodeWebp(current, params.quality);
    return Buffer.from(webpBytes);
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

function applyGeometry(current, params, photon, replaceCurrent, dispose) {
  const plan = planImageTransform(getWidth(current), getHeight(current), params);

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

  return photon.PhotonImage.new(targetPixels, plan.width, plan.height);
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
