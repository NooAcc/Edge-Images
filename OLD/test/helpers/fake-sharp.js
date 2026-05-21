export function createFakeSharp(log = []) {
  return function fakeSharp(input) {
    return new FakeSharpPipeline(input, log);
  };
}

export function makeImageBytes(width, height, options = {}) {
  return Buffer.from(
    JSON.stringify({
      width,
      height,
      format: options.format || 'jpeg',
      firstPixel: options.firstPixel || [11, 22, 33, 255],
    }),
  );
}

export function decodeOutput(buffer) {
  return JSON.parse(Buffer.from(buffer).toString('utf8'));
}

class FakeSharpPipeline {
  constructor(input, log) {
    const payload = JSON.parse(Buffer.from(input).toString('utf8'));
    this.log = log;
    this.width = payload.width;
    this.height = payload.height;
    this.format = payload.format || 'jpeg';
    this.firstPixel = payload.firstPixel || [11, 22, 33, 255];
    this.quality = undefined;
    this.outputFormat = 'webp';
    this.formatOptions = {};
    this.flippedH = false;
    this.flippedV = false;
  }

  async metadata() {
    return {
      width: this.width,
      height: this.height,
      format: this.format,
    };
  }

  rotate(angle) {
    this.log.push({
      op: 'rotate',
      from: [this.width, this.height],
      angle,
    });

    if (angle === 90 || angle === 270) {
      [this.width, this.height] = [this.height, this.width];
    }

    return this;
  }

  flip() {
    this.log.push({ op: 'flip', size: [this.width, this.height] });
    this.flippedV = true;
    return this;
  }

  flop() {
    this.log.push({ op: 'flop', size: [this.width, this.height] });
    this.flippedH = true;
    return this;
  }

  extract({ left, top, width, height }) {
    this.log.push({
      op: 'extract',
      from: [this.width, this.height],
      box: [left, top, width, height],
    });
    this.width = width;
    this.height = height;
    return this;
  }

  resize(options) {
    const from = [this.width, this.height];
    const next = resolveResize(this.width, this.height, options);
    this.log.push({
      op: 'resize',
      from,
      to: [next.width, next.height],
      options: { ...options },
      fit: options.fit,
      background: options.background,
    });
    this.width = next.width;
    this.height = next.height;

    if (options.fit === 'contain' && options.background) {
      this.firstPixel = [
        options.background.r,
        options.background.g,
        options.background.b,
        Math.round(options.background.alpha * 255),
      ];
    }

    return this;
  }

  webp(options) {
    this.outputFormat = 'webp';
    this.quality = options.quality;
    this.formatOptions = { ...options };
    return this;
  }

  jpeg(options) {
    this.outputFormat = 'jpeg';
    this.quality = options.quality;
    this.formatOptions = { ...options };
    return this;
  }

  png(options) {
    this.outputFormat = 'png';
    this.quality = options.quality;
    this.formatOptions = { ...options };
    return this;
  }

  avif(options) {
    this.outputFormat = 'avif';
    this.quality = options.quality;
    this.formatOptions = { ...options };
    return this;
  }

  async toBuffer(options = {}) {
    const data = Buffer.from(
      JSON.stringify({
        width: this.width,
        height: this.height,
        quality: this.quality,
        outputFormat: this.outputFormat,
        formatOptions: this.formatOptions,
        firstPixel: this.firstPixel,
        flippedH: this.flippedH,
        flippedV: this.flippedV,
      }),
    );

    if (options.resolveWithObject) {
      return {
        data,
        info: {
          format: this.outputFormat,
          size: data.byteLength,
          width: this.width,
          height: this.height,
          channels: 3,
        },
      };
    }

    return data;
  }
}

function resolveResize(sourceWidth, sourceHeight, options) {
  const targetWidth = options.width;
  const targetHeight = options.height;

  if (targetWidth && targetHeight) {
    if (options.fit === 'inside') {
      return scaleTo(
        sourceWidth,
        sourceHeight,
        Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight),
        options,
      );
    }

    if (options.fit === 'outside') {
      return scaleTo(
        sourceWidth,
        sourceHeight,
        Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight),
        options,
      );
    }

    if (options.withoutEnlargement && sourceWidth <= targetWidth && sourceHeight <= targetHeight) {
      return { width: sourceWidth, height: sourceHeight };
    }

    return { width: targetWidth, height: targetHeight };
  }

  if (targetWidth) {
    return scaleTo(sourceWidth, sourceHeight, targetWidth / sourceWidth, options);
  }

  if (targetHeight) {
    return scaleTo(sourceWidth, sourceHeight, targetHeight / sourceHeight, options);
  }

  return { width: sourceWidth, height: sourceHeight };
}

function scaleTo(width, height, scale, options) {
  const safeScale = options.withoutEnlargement ? Math.min(1, scale) : scale;
  return {
    width: Math.max(1, Math.round(width * safeScale)),
    height: Math.max(1, Math.round(height * safeScale)),
  };
}
