export const IMAGE_URL_ALLOWLIST_ENV = "IMAGE_URL_ALLOWLIST";
export const LEGACY_ALLOWED_HOSTS_ENV = "ALLOWED_IMAGE_HOSTS";

export class UrlAllowlistConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "UrlAllowlistConfigError";
  }
}

export function getUrlAllowlistFromEnv(env = process.env) {
  const rawValue = env[IMAGE_URL_ALLOWLIST_ENV] ?? env[LEGACY_ALLOWED_HOSTS_ENV] ?? "";
  return createUrlAllowlist(rawValue);
}

export function createUrlAllowlist(rawValue) {
  const entries = String(rawValue || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return {
      enabled: false,
      rules: []
    };
  }

  return {
    enabled: true,
    rules: entries.map(parseRule)
  };
}

export function isUrlAllowed(rawUrl, allowlist) {
  const normalizedAllowlist = allowlist ?? getUrlAllowlistFromEnv();

  if (!normalizedAllowlist.enabled) {
    return true;
  }

  const sourceUrl = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
  return normalizedAllowlist.rules.some((rule) => matchesRule(sourceUrl, rule));
}

export function describeAllowlist(allowlist) {
  if (!allowlist?.enabled) {
    return "disabled";
  }

  return allowlist.rules.map((rule) => rule.raw).join(", ");
}

function parseRule(rawEntry) {
  const raw = rawEntry.trim().toLowerCase();
  if (raw === "*") {
    return {
      type: "all",
      raw
    };
  }

  const parsed = parseHostPattern(raw, rawEntry);
  return {
    type: "domain",
    raw,
    hostname: parsed.hostname
  };
}

function parseHostPattern(hostPattern, rawEntry) {
  const withoutProtocol = hostPattern.replace(/^(https?):\/\//, "");
  const normalizedHostPattern = withoutProtocol
    .split("/")[0]
    .replace(/^\*\./, "")
    .replace(/^\./, "");

  if (!normalizedHostPattern || normalizedHostPattern.includes("*")) {
    throw new UrlAllowlistConfigError(`Invalid allowlist entry: ${rawEntry}`);
  }

  let parsed;
  try {
    parsed = new URL(`https://${normalizedHostPattern}`);
  } catch {
    throw new UrlAllowlistConfigError(`Invalid allowlist entry: ${rawEntry}`);
  }

  return {
    hostname: parsed.hostname.toLowerCase()
  };
}

function matchesRule(sourceUrl, rule) {
  if (rule.type === "all") {
    return true;
  }

  const hostname = sourceUrl.hostname.toLowerCase();
  return hostname === rule.hostname || hostname.endsWith(`.${rule.hostname}`);
}
