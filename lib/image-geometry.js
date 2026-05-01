import { MAX_DIMENSION } from "./parse-params.js";

export function roundDimension(value) {
  return Math.max(1, Math.min(MAX_DIMENSION, Math.round(value)));
}

export function constrainToMax(width, height, maxDimension = MAX_DIMENSION) {
  if (width <= maxDimension && height <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height), scale: 1 };
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale
  };
}

export function inferTargetBox(sourceWidth, sourceHeight, params) {
  const requestedWidth = params.width;
  const requestedHeight = params.height;

  if (requestedWidth && requestedHeight) {
    return { width: requestedWidth, height: requestedHeight };
  }

  if (requestedWidth) {
    return constrainToMax(requestedWidth, (sourceHeight * requestedWidth) / sourceWidth);
  }

  if (requestedHeight) {
    return constrainToMax((sourceWidth * requestedHeight) / sourceHeight, requestedHeight);
  }

  return constrainToMax(sourceWidth, sourceHeight);
}

export function planImageTransform(sourceWidth, sourceHeight, params) {
  const box = inferTargetBox(sourceWidth, sourceHeight, params);

  switch (params.fit) {
    case "contain":
    case "pad":
      return planContain(sourceWidth, sourceHeight, box, params.background);
    case "cover":
      return planCover(sourceWidth, sourceHeight, box);
    case "crop":
      return planCrop(sourceWidth, sourceHeight, box);
    case "scale-down":
    default:
      return planScaleDown(sourceWidth, sourceHeight, box);
  }
}

function planScaleDown(sourceWidth, sourceHeight, box) {
  const scale = Math.min(1, box.width / sourceWidth, box.height / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  if (width === sourceWidth && height === sourceHeight) {
    return { type: "none", width, height };
  }

  return { type: "resize", width, height };
}

function planContain(sourceWidth, sourceHeight, box, background) {
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const resizeWidth = Math.max(1, Math.round(sourceWidth * scale));
  const resizeHeight = Math.max(1, Math.round(sourceHeight * scale));

  return {
    type: "pad",
    width: box.width,
    height: box.height,
    resizeWidth,
    resizeHeight,
    offsetX: Math.floor((box.width - resizeWidth) / 2),
    offsetY: Math.floor((box.height - resizeHeight) / 2),
    background
  };
}

function planCover(sourceWidth, sourceHeight, box) {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = box.width / box.height;

  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;

  if (sourceAspect > targetAspect) {
    cropWidth = Math.max(1, Math.round(sourceHeight * targetAspect));
    cropX = Math.floor((sourceWidth - cropWidth) / 2);
  } else if (sourceAspect < targetAspect) {
    cropHeight = Math.max(1, Math.round(sourceWidth / targetAspect));
    cropY = Math.floor((sourceHeight - cropHeight) / 2);
  }

  return {
    type: "cover",
    width: box.width,
    height: box.height,
    crop: {
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight
    }
  };
}

function planCrop(sourceWidth, sourceHeight, box) {
  if (box.width === sourceWidth && box.height === sourceHeight) {
    return { type: "none", width: sourceWidth, height: sourceHeight };
  }

  return { type: "resize", width: box.width, height: box.height };
}
