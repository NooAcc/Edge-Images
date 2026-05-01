export const DEFAULT_FETCH_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

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
      redirect: "follow"
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
