# Platform-Aware Configuration Design

## Overview

Add a `PLATFORM` environment variable that selects deployment-specific presets (Vercel vs Hugging Face Docker). Presets control processing limits, caching strategy, and runtime behavior. Individual settings can be overridden via environment variables.

## Architecture

### New Files

- `lib/platform-config.js` — Platform preset registry + env override logic
- `lib/cache.js` — Two-tier caching (memory LRU + disk)

### Modified Files

- `lib/parse-params.js` — Read `maxDimension`/`defaultQuality` from platformConfig
- `lib/handler.js` — Inject cache layer and platformConfig
- `server.js` — Load platformConfig at startup, pass to handler
- `Dockerfile` — Add `PLATFORM=huggingface` default
- `.env.example` — Document PLATFORM and override variables

## Configuration

### Presets

| Key | Vercel | Hugging Face | Env Override |
|-----|--------|-------------|--------------|
| `maxDimension` | 1024 | 2048 | `MAX_DIMENSION` |
| `defaultQuality` | 85 | 90 | `DEFAULT_QUALITY` |
| `cache.type` | `'none'` | `'lru+disk'` | — |
| `cache.maxMemoryMB` | 0 | 4096 | `CACHE_MAX_MEMORY_MB` |
| `cache.maxDiskGB` | 0 | 50 | `CACHE_MAX_DISK_GB` |

### Env Override Rules

- `PLATFORM` selects the base preset (default: `vercel`)
- Each config key has an optional env var that overrides the preset value
- Unknown `PLATFORM` values fall back to `vercel`

## Platform Config Module (`lib/platform-config.js`)

```js
const PRESETS = {
  vercel: {
    maxDimension: 1024,
    defaultQuality: 85,
    cache: { type: 'none', maxMemoryMB: 0, maxDiskGB: 0 },
  },
  huggingface: {
    maxDimension: 2048,
    defaultQuality: 90,
    cache: { type: 'lru+disk', maxMemoryMB: 4096, maxDiskGB: 50 },
  },
};

export function getPlatformConfig(env = process.env) {
  const platform = env.PLATFORM || 'vercel';
  const preset = PRESETS[platform] ?? PRESETS.vercel;
  return applyEnvOverrides(preset, env);
}
```

## Cache Layer (`lib/cache.js`)

### Three Cache Categories

| Category | Key Format | Content |
|----------|-----------|---------|
| Source file | `source:{sha256(url)}` | Raw image/video frame buffer |
| Processed result | `processed:{sha256(url)}_{paramHash}` | Processed image buffer + metadata JSON |
| Metadata | `meta:{sha256(url)}` | JSON metadata (when `format=json`) |

**paramHash** = `sha256(width|height|fit|quality|format|rotate|flip)` — only includes non-default values to maximize cache hits.

### Two-Tier Design

**L1 — Memory (LRU):**
- Uses `lru-cache` package
- Bounded by `maxMemoryMB`
- TTL: 1 hour (configurable)

**L2 — Disk:**
- Stored in `/app/cache/` directory (Docker volume mount point)
- File path: `/app/cache/{keyHash}` (no extension)
- File format: 4-byte header length (uint32 BE) + JSON header (content-type, width, height, format, cachedAt) + raw binary data
- Bounded by `maxDiskGB`, LRU eviction based on `cachedAt` timestamp on startup scan
- Source and processed caches stored in the same directory, distinguished by key prefix

### Cache Flow

```
Request → L1 memory lookup
           ↓ miss
          L2 disk lookup
           ↓ miss
          Download source → Write to source cache
           ↓
          Process → Write to processed cache → Return
```

### Integration with handler.js

- `createImageHandler` receives `platformConfig` parameter
- When `cache.type === 'none'` (Vercel): no caching, current behavior unchanged
- When `cache.type === 'lru+disk'` (HF): wrap fetch + process in cache layer
- Cache layer is transparent to existing fetch/process logic

## Processing Parameters

### Changes to `parse-params.js`

- `parseParams()` accepts `platformConfig` via options
- `MAX_DIMENSION` constant replaced by `platformConfig.maxDimension`
- `DEFAULT_QUALITY` constant replaced by `platformConfig.defaultQuality`
- Vercel behavior unchanged (same defaults)

## Environment Variables

### New

| Variable | Purpose | Default |
|----------|---------|---------|
| `PLATFORM` | Select platform preset | `vercel` |
| `MAX_DIMENSION` | Override max image dimension | preset value |
| `DEFAULT_QUALITY` | Override default quality | preset value |
| `CACHE_MAX_MEMORY_MB` | Override memory cache size | preset value |
| `CACHE_MAX_DISK_GB` | Override disk cache size | preset value |

### Existing (unchanged)

| Variable | Purpose |
|----------|---------|
| `IMAGE_URL_ALLOWLIST` | Domain allowlist |
| `IMAGE_DEBUG_LOGS` | Enable debug logging |
| `PORT` | Server port |
| `USE_SYSTEM_FFMPEG` | Use system ffmpeg |

## Deployment Changes

### Dockerfile

```dockerfile
ENV PLATFORM=huggingface
```

### Vercel

No changes needed — `PLATFORM` defaults to `vercel`.

## Dependencies

- `lru-cache` — Memory caching (new)

## Non-Goals

- No internal concurrency limiting (controlled externally)
- No sharp memory/threads configuration
- No Vercel caching (serverless has no persistent state)
