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
      format: options.format || "jpeg",
      firstPixel: options.firstPixel || [11, 22, 33, 255]
    })
  );
}

export function decodeOutput(buffer) {
  return JSON.parse(Buffer.from(buffer).toString("utf8"));
}

class FakeSharpPipeline {
  constructor(input, log) {
    const payload = JSON.parse(Buffer.from(input).toString("utf8"));
    this.log = log;
    this.width = payload.width;
    this.height = payload.height;
    this.format = payload.format || "jpeg";
    this.firstPixel = payload.firstPixel || [11, 22, 33, 255];
    this.quality = undefined;
    this.flippedH = false;
    this.flippedV = false;
  }

  async metadata() {
    return {
      width: this.width,
      height: this.height,
      format: this.format
    };
  }

  rotate(angle) {
    this.log.push({
      op: "rotate",
      from: [this.width, this.height],
      angle
    });

    if (angle === 90 || angle === 270) {
      [this.width, this.height] = [this.height, this.width];
    }

    return this;
  }

  flip() {
    this.log.push({ op: "flip", size: [this.width, this.height] });
    this.flippedV = true;
    return this;
  }

  flop() {
    this.log.push({ op: "flop", size: [this.width, this.height] });
    this.flippedH = true;
    return this;
  }

  extract({ left, top, width, height }) {
    this.log.push({
      op: "extract",
      from: [this.width, this.height],
      box: [left, top, width, height]
    });
    this.width = width;
    this.height = height;
    return this;
  }

  resize(options) {
    this.log.push({
      op: "resize",
      from: [this.width, this.height],
      to: [options.width, options.height],
      fit: options.fit,
      kernel: options.kernel,
      background: options.background
    });
    this.width = options.width;
    this.height = options.height;

    if (options.fit === "contain" && options.background) {
      this.firstPixel = [
        options.background.r,
        options.background.g,
        options.background.b,
        Math.round(options.background.alpha * 255)
      ];
    }

    return this;
  }

  webp(options) {
    this.quality = options.quality;
    return this;
  }

  async toBuffer(options = {}) {
    const data = Buffer.from(
      JSON.stringify({
        width: this.width,
        height: this.height,
        quality: this.quality,
        firstPixel: this.firstPixel,
        flippedH: this.flippedH,
        flippedV: this.flippedV
      })
    );

    if (options.resolveWithObject) {
      return {
        data,
        info: {
          format: "webp",
          size: data.byteLength,
          width: this.width,
          height: this.height
        }
      };
    }

    return data;
  }
}
