import { noopImageLogger } from "./image-logger.js";
import { planImageTransform } from "./image-geometry.js";

const SHARP_INPUT_OPTIONS = {
  animated: false
};

let sharpModulePromise;

export async function processImage(sourceBuffer, params, dependencies = {}) {
  const sharp = dependencies.sharp || (await loadSharp());
  const logger = dependencies.logger || noopImageLogger;
  const imageBytes = sourceBuffer instanceof Uint8Array ? sourceBuffer : Uint8Array.from(sourceBuffer);
  const sourceContentType = params.sourceContentType || "";
  const startedAt = Date.now();
  let inputFormat = inferInputFormatFromContentType(sourceContentType);

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

    const metadata = await sharp(imageBytes, SHARP_INPUT_OPTIONS).metadata();
    inputFormat = metadata.format || inputFormat;
    const sourceWidth = requireMetadataDimension(metadata.width, "width");
    const sourceHeight = requireMetadataDimension(metadata.height, "height");
    const oriented = getOrientedDimensions(sourceWidth, sourceHeight, params.rotate);

    logger.info("image.decode.done", {
      inputFormat,
      width: oriented.width,
      height: oriented.height,
      sourceWidth,
      sourceHeight,
      durationMs: Date.now() - startedAt
    });

    const plan = planImageTransform(oriented.width, oriented.height, params);
    logger.info("image.transform.plan", {
      sourceWidth: oriented.width,
      sourceHeight: oriented.height,
      ...summarizePlan(plan)
    });

    let pipeline = sharp(imageBytes, SHARP_INPUT_OPTIONS);
    pipeline = applyOrientation(pipeline, params);
    pipeline = applyGeometry(pipeline, plan);

    const result = await pipeline
      .webp({ quality: params.quality })
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

function applyOrientation(pipeline, params) {
  const flips = mapPostRotationFlipToSharp(params.flip, params.rotate);
  let working = pipeline;

  if (flips.horizontal) {
    working = working.flop();
  }

  if (flips.vertical) {
    working = working.flip();
  }

  if (params.rotate) {
    working = working.rotate(params.rotate);
  }

  return working;
}

function applyGeometry(pipeline, plan) {
  if (plan.type === "none") {
    return pipeline;
  }

  if (plan.type === "resize") {
    return pipeline.resize({
      width: plan.width,
      height: plan.height,
      fit: "fill",
      kernel: "lanczos3"
    });
  }

  if (plan.type === "cover") {
    return pipeline
      .extract({
        left: plan.crop.x,
        top: plan.crop.y,
        width: plan.crop.width,
        height: plan.crop.height
      })
      .resize({
        width: plan.width,
        height: plan.height,
        fit: "fill",
        kernel: "lanczos3"
      });
  }

  if (plan.type === "pad") {
    return pipeline.resize({
      width: plan.width,
      height: plan.height,
      fit: "contain",
      background: toSharpBackground(plan.background),
      kernel: "lanczos3"
    });
  }

  return pipeline;
}

function getOrientedDimensions(width, height, rotate) {
  if (rotate === 90 || rotate === 270) {
    return { width: height, height: width };
  }

  return { width, height };
}

function mapPostRotationFlipToSharp(flip = "", rotate) {
  let horizontal = flip.includes("h");
  let vertical = flip.includes("v");

  if ((rotate === 90 || rotate === 270) && horizontal !== vertical) {
    [horizontal, vertical] = [vertical, horizontal];
  }

  return { horizontal, vertical };
}

function toSharpBackground(background = [255, 255, 255]) {
  const [r, g, b] = background;
  return { r, g, b, alpha: 1 };
}

function requireMetadataDimension(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Source image metadata is missing ${name}`);
  }

  return Number(value);
}

function inferInputFormatFromContentType(contentType) {
  const normalized = String(contentType).toLowerCase().split(";")[0].trim();
  return normalized.startsWith("image/") ? normalized.slice("image/".length) : "unknown";
}

function summarizePlan(plan) {
  return Object.fromEntries(
    Object.entries(plan).map(([key, value]) => [
      key === "type" ? "planType" : key,
      value
    ])
  );
}
