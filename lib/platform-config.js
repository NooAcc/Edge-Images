const PRESETS = {
  huggingface: {
    maxDimension: 2048,
    defaultQuality: 90,
    cache: { type: 'lru+disk', maxMemoryMB: 4096, maxDiskGB: 50 },
  },
};

const ENV_OVERRIDES = {
  maxDimension: { env: 'MAX_DIMENSION', parse: Number },
  defaultQuality: { env: 'DEFAULT_QUALITY', parse: Number },
  'cache.maxMemoryMB': { env: 'CACHE_MAX_MEMORY_MB', parse: Number },
  'cache.maxDiskGB': { env: 'CACHE_MAX_DISK_GB', parse: Number },
};

export function getPlatformConfig(env = process.env) {
  const platform = env.PLATFORM || 'huggingface';
  const preset = PRESETS[platform];
  if (!preset) {
    throw new Error(`Unknown platform: ${platform}. Supported platforms: ${Object.keys(PRESETS).join(', ')}`);
  }
  return applyEnvOverrides(structuredClone(preset), env);
}

function applyEnvOverrides(config, env) {
  for (const [key, { env: envName, parse }] of Object.entries(ENV_OVERRIDES)) {
    const value = env[envName];
    if (value === undefined || value === '') continue;

    const parsed = parse(value);
    if (!Number.isFinite(parsed)) continue;

    setNestedValue(config, key, parsed);
  }

  return config;
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]];
  }
  current[keys.at(-1)] = value;
}
