import { getUrlAllowlistFromEnv, isUrlAllowed } from './url-allowlist.js';

export const MAX_DIMENSION = 1024;
export const DEFAULT_QUALITY = 85;
export const DEFAULT_BACKGROUND = [255, 255, 255];
export const DEFAULT_BACKGROUND_HEX = 'FFFFFF';
export const DEFAULT_FIT = 'inside';
export const SUPPORTED_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
export const SUPPORTED_FORMATS = new Set(['webp', 'jpeg', 'png', 'avif', 'json']);
export const SUPPORTED_ROTATIONS = new Set([90, 180, 270]);
export const SUPPORTED_FLIPS = new Set(['h', 'v', 'hv']);

export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParamError';
  }
}

export function parseParams(sourceUrl, query, options = {}) {
  if (hasQueryValue(query, 'url')) {
    throw new ParamError(
      'url query parameter is no longer supported; encode the source URL in the path',
    );
  }

  if (!sourceUrl) {
    throw new ParamError('Missing required source URL path segment');
  }

  const url = parseSourceUrl(sourceUrl);
  const urlAllowlist = options.urlAllowlist ?? getUrlAllowlistFromEnv(options.env);
  if (!isUrlAllowed(url, urlAllowlist)) {
    throw new ParamError(
      `url host is not allowed by ${options.allowlistEnvName || 'IMAGE_URL_ALLOWLIST'}`,
    );
  }

  const width = parseDimension(getQueryValue(query, 'width'), 'width');
  const height = parseDimension(getQueryValue(query, 'height'), 'height');
  const quality = parseQuality(getQueryValue(query, 'quality'));
  const fit = parseFit(getQueryValue(query, 'fit'));
  const format = parseFormat(getQueryValue(query, 'format'));
  const background = parseBackground(getQueryValue(query, 'background'));
  const rotate = parseRotation(getQueryValue(query, 'rotate'));
  const flip = parseFlip(getQueryValue(query, 'flip'));

  return {
    url,
    width,
    height,
    fit,
    quality,
    format,
    background: background.rgb,
    backgroundHex: background.hex,
    rotate,
    flip,
  };
}

export function getQueryValue(query, name) {
  if (!query) {
    return undefined;
  }

  if (query instanceof URLSearchParams) {
    const value = query.get(name);
    return value === null ? undefined : value;
  }

  const value = query[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function hasQueryValue(query, name) {
  if (!query) {
    return false;
  }

  if (query instanceof URLSearchParams) {
    return query.has(name);
  }

  return Object.hasOwn(query, name);
}

function parseSourceUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new ParamError('url must be an absolute HTTP or HTTPS URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ParamError('url must use http or https');
  }

  return parsed.toString();
}

function parseDimension(rawValue, name) {
  if (rawValue === undefined || rawValue === '') {
    return undefined;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ParamError(`${name} must be a positive integer`);
  }

  return Math.min(value, MAX_DIMENSION);
}

function parseQuality(rawValue) {
  if (rawValue === undefined || rawValue === '') {
    return DEFAULT_QUALITY;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new ParamError('quality must be an integer between 1 and 100');
  }

  return Math.min(100, Math.max(1, value));
}

function parseFit(rawValue) {
  if (!rawValue) {
    return DEFAULT_FIT;
  }

  const value = String(rawValue).toLowerCase();
  if (!SUPPORTED_FITS.has(value)) {
    throw new ParamError('fit must be one of cover, contain, fill, inside, or outside');
  }

  return value;
}

function parseFormat(rawValue) {
  if (!rawValue) {
    return 'webp';
  }

  const value = String(rawValue).toLowerCase();
  if (!SUPPORTED_FORMATS.has(value)) {
    throw new ParamError('format must be one of webp, jpeg, png, avif, or json');
  }

  return value;
}

function parseBackground(rawValue) {
  if (!rawValue) {
    return { rgb: DEFAULT_BACKGROUND, hex: DEFAULT_BACKGROUND_HEX };
  }

  const normalized = String(rawValue).trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    return { rgb: DEFAULT_BACKGROUND, hex: DEFAULT_BACKGROUND_HEX };
  }

  return {
    rgb: [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ],
    hex: normalized,
  };
}

function parseRotation(rawValue) {
  if (rawValue === undefined || rawValue === '') {
    return undefined;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || !SUPPORTED_ROTATIONS.has(value)) {
    throw new ParamError('rotate must be one of 90, 180, or 270');
  }

  return value;
}

function parseFlip(rawValue) {
  if (!rawValue) {
    return '';
  }

  const value = String(rawValue).toLowerCase();
  if (!SUPPORTED_FLIPS.has(value)) {
    throw new ParamError('flip must be h, v, or hv');
  }

  return value;
}
