export const IMAGE_DEBUG_LOGS_ENV = 'IMAGE_DEBUG_LOGS';

export const noopImageLogger = {
  enabled: false,
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
};

export function createImageLogger({
  env = process.env,
  sink = console,
  requestId = createRequestId(),
  base = {},
} = {}) {
  return createLogger({
    enabled: isImageDebugLoggingEnabled(env),
    sink,
    base: {
      requestId,
      ...base,
    },
  });
}

export function isImageDebugLoggingEnabled(env = process.env) {
  const value = String(env?.[IMAGE_DEBUG_LOGS_ENV] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function createLogger({ enabled, sink, base }) {
  return {
    enabled,
    child(fields = {}) {
      return createLogger({
        enabled,
        sink,
        base: {
          ...base,
          ...fields,
        },
      });
    },
    info(event, details) {
      writeLog({ enabled, sink, level: 'info', event, base, details });
    },
    warn(event, details) {
      writeLog({ enabled, sink, level: 'warn', event, base, details });
    },
    error(event, details) {
      writeLog({ enabled, sink, level: 'error', event, base, details });
    },
  };
}

function writeLog({ enabled, sink, level, event, base, details }) {
  if (!enabled) {
    return;
  }

  const sanitizedDetails = sanitizeLogValue(details || {});
  const errorDetails = sanitizedDetails.error || {};
  if (errorDetails.errorName || errorDetails.errorMessage) {
    delete sanitizedDetails.error;
  }

  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    ...base,
    ...sanitizedDetails,
    ...errorDetails,
  };
  const line = `[image] ${JSON.stringify(payload)}`;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';

  if (typeof sink?.[method] === 'function') {
    sink[method](line);
  } else if (typeof sink?.log === 'function') {
    sink.log(line);
  }
}

function sanitizeLogValue(value) {
  if (value instanceof Error) {
    return {
      errorName: value.name,
      errorMessage: value.message,
    };
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeLogValue(item)]),
    );
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

function createRequestId() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
