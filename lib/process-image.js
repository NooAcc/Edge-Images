import { MAX_DIMENSION } from "./parse-params.js";
import { noopImageLogger } from "./image-logger.js";

const SHARP_INPUT_OPTIONS = {
  animated: false,
  sequentialRead: true
};

const WEBP_SPEED_OPTIONS = {
  effort: 0,
  smartSubsample: false
};

let sharpModulePromise;

export async function processImage(sourceBuffer, params, dependencies = {}) {
  const sharp = dependencies.sharp || (await loadSharp());
  const logger = dependencies.logger || noopImageLogger;
  const imageBytes = sourceBuffer instanceof Uint8Array ? sourceBuffer : Uint8Array.from(sourceBuffer);
  const sourceContentType = params.sourceContentType || "";
  const inputFormat = inferInputFormatFromContentType(sourceContentType);
  const resizeOptions = buildResizeOptions(params);
  const startedAt = Date.now();

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
    logger.info("image.transform.plan", {
      inputFormat,
      resize: resizeOptions,
      rotate: params.rotate,
      flip: params.flip || ""
    });

    let pipeline = sharp(imageBytes, SHARP_INPUT_OPTIONS);

    if (params.rotate) {
      pipeline = pipeline.rotate(params.rotate);
    }

    if (params.flip?.includes("v")) {
      pipeline = pipeline.flip();
    }

    if (params.flip?.includes("h")) {
      pipeline = pipeline.flop();
    }

    pipeline = pipeline.resize(resizeOptions);

    const result = await pipeline
      .webp({
        ...WEBP_SPEED_OPTIONS,
        quality: params.quality
      })
      .toBuffer({ resolveWithObject: true });

    logger.info("image.encode.done", {
      outputContentType: "image/webp",
      outputBytes: result.data.byteLength,
      width: result.info.width,
      height: result.info.height,
      durationMs: Date.now() - startedAt
    });

    return Buffer.from(result.data);
  } catch (error) {
    logger.warn("image.process.failed", {
      error,
      inputFormat,
      sourceContentType,
      sourceBytes: imageBytes.byteLength,
      durationMs: Date.now() - startedAt
    });

    throw error;
  }
}

export async function loadSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp").then((module) => module.default || module);
  }

  return sharpModulePromise;
}

export function buildResizeOptions(params) {
  const hasWidth = Number.isInteger(params.width);
  const hasHeight = Number.isInteger(params.height);
  const fit = hasWidth || hasHeight ? params.fit : "inside";
  const options = {
    fit,
    withoutEnlargement: true,
    fastShrinkOnLoad: true
  };

  if (hasWidth) {
    options.width = params.width;
  }

  if (hasHeight) {
    options.height = params.height;
  }

  if (!hasWidth && !hasHeight) {
    options.width = MAX_DIMENSION;
    options.height = MAX_DIMENSION;
  }

  if (fit === "contain") {
    options.background = toSharpBackground(params.background);
  }

  return options;
}

function toSharpBackground(background = [255, 255, 255]) {
  const [r, g, b] = background;
  return { r, g, b, alpha: 1 };
}

function inferInputFormatFromContentType(contentType) {
  const normalized = String(contentType).toLowerCase().split(";")[0].trim();
  return normalized.startsWith("image/") ? normalized.slice("image/".length) : "unknown";
}
