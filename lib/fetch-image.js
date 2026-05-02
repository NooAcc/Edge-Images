export const DEFAULT_FETCH_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const DEFAULT_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class ImageFetchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ImageFetchError";
    this.cause = options.cause;
    this.status = options.status;
  }
}

export async function fetchImage(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_SOURCE_BYTES
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new ImageFetchError("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: buildImageFetchHeaders(url)
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new ImageFetchError(`Source image fetch timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }

    throw new ImageFetchError("Source image fetch failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ImageFetchError(`Source image returned HTTP ${response.status}`, {
      status: response.status
    });
  }

  const contentType = response.headers?.get?.("content-type")?.split(";")[0]?.trim() || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new ImageFetchError("Source URL did not return an image");
  }

  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new ImageFetchError(`Source image exceeds ${maxBytes} bytes`);
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
    status: response.status
  };
}

function buildImageFetchHeaders(url) {
  const requestHeaders = {
    Accept: DEFAULT_IMAGE_ACCEPT,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": DEFAULT_IMAGE_USER_AGENT
  };

  const sourceOrigin = getUrlOrigin(url);
  if (sourceOrigin) {
    requestHeaders.Referer = `${sourceOrigin}/`;
  }

  return requestHeaders;
}

function getUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
