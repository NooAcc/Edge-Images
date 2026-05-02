export class FakePhotonImage {
  constructor(widthOrPixels, heightOrWidth, pixelsOrHeight) {
    let width = widthOrPixels;
    let height = heightOrWidth;
    let pixels = pixelsOrHeight;

    if (widthOrPixels instanceof Uint8Array || widthOrPixels instanceof Uint8ClampedArray) {
      pixels = widthOrPixels;
      width = heightOrWidth;
      height = pixelsOrHeight;
    }

    this.width = width;
    this.height = height;
    this.pixels = pixels;
    this.freeCount = 0;
    this.flippedH = false;
    this.flippedV = false;
  }

  static new_from_byteslice(bytes) {
    const payload = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return new FakePhotonImage(payload.width, payload.height, payload.pixels && Uint8Array.from(payload.pixels));
  }

  static new(pixels, width, height) {
    return new FakePhotonImage(Uint8Array.from(pixels), width, height);
  }

  get_width() {
    return this.width;
  }

  get_height() {
    return this.height;
  }

  get_raw_pixels() {
    if (!this.pixels) {
      this.pixels = makePixels(this.width, this.height);
    }

    return this.pixels;
  }

  get_bytes_webp(quality) {
    return Buffer.from(
      JSON.stringify({
        width: this.width,
        height: this.height,
        quality,
        firstPixel: Array.from(this.get_raw_pixels().slice(0, 4)),
        flippedH: this.flippedH,
        flippedV: this.flippedV
      })
    );
  }

  free() {
    this.freeCount += 1;
  }
}

export function createFakePhoton(log = []) {
  return {
    PhotonImage: FakePhotonImage,
    SamplingFilter: {
      Lanczos3: "lanczos3"
    },
    resize(image, width, height, filter) {
      log.push({
        op: "resize",
        from: [image.get_width(), image.get_height()],
        to: [width, height],
        filter
      });
      return new FakePhotonImage(width, height, makePixels(width, height, [11, 22, 33, 255]));
    },
    crop(image, x1, y1, x2, y2) {
      log.push({
        op: "crop",
        from: [image.get_width(), image.get_height()],
        box: [x1, y1, x2, y2]
      });
      return new FakePhotonImage(x2 - x1, y2 - y1, makePixels(x2 - x1, y2 - y1, [44, 55, 66, 255]));
    },
    rotate(image, angle) {
      log.push({
        op: "rotate",
        from: [image.get_width(), image.get_height()],
        angle
      });
      const swapsDimensions = angle === 90 || angle === 270;
      return new FakePhotonImage(
        swapsDimensions ? image.get_height() : image.get_width(),
        swapsDimensions ? image.get_width() : image.get_height(),
        makePixels(
          swapsDimensions ? image.get_height() : image.get_width(),
          swapsDimensions ? image.get_width() : image.get_height(),
          [77, 88, 99, 255]
        )
      );
    },
    fliph(image) {
      log.push({ op: "fliph", size: [image.get_width(), image.get_height()] });
      image.flippedH = true;
    },
    flipv(image) {
      log.push({ op: "flipv", size: [image.get_width(), image.get_height()] });
      image.flippedV = true;
    }
  };
}

export function makeImageBytes(width, height, pixels) {
  return Buffer.from(JSON.stringify({ width, height, pixels }));
}

export function decodeOutput(buffer) {
  return JSON.parse(Buffer.from(buffer).toString("utf8"));
}

export async function fakeWebpEncoder(image, quality) {
  return image.get_bytes_webp(quality);
}

function makePixels(width, height, color = [0, 0, 0, 255]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = color[3];
  }

  return pixels;
}
