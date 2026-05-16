import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LRUCache } from 'lru-cache';

const CACHE_DIR = '/data';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export function createCache(platformConfig) {
  const { type, maxMemoryMB, maxDiskGB } = platformConfig.cache;

  if (type === 'none') {
    return null;
  }

  const memoryCache = maxMemoryMB > 0
    ? new LRUCache({
        maxSize: maxMemoryMB * 1024 * 1024,
        sizeCalculation: (entry) => entry.buffer.length + (entry.header ? JSON.stringify(entry.header).length : 0),
        ttl: DEFAULT_TTL_MS,
      })
    : null;

  const diskEnabled = maxDiskGB > 0;
  let diskReady = false;

  async function initDisk() {
    if (!diskEnabled) return;
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      diskReady = true;
    } catch {
      diskReady = false;
    }
  }

  async function get(key) {
    // L1: memory
    if (memoryCache) {
      const memHit = memoryCache.get(key);
      if (memHit) return memHit;
    }

    // L2: disk
    if (diskReady) {
      try {
        const filePath = join(CACHE_DIR, hashKey(key));
        const data = await readFile(filePath);
        const headerLen = data.readUInt32BE(0);
        const header = JSON.parse(data.subarray(4, 4 + headerLen).toString());
        const buffer = data.subarray(4 + headerLen);
        const entry = { buffer, header };

        // Promote to L1
        if (memoryCache) memoryCache.set(key, entry);

        return entry;
      } catch {
        // cache miss
      }
    }

    return null;
  }

  async function set(key, entry) {
    // L2: disk (write first so L1 stays consistent with disk)
    if (diskReady) {
      try {
        const headerBuf = Buffer.from(JSON.stringify(entry.header || {}));
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(headerBuf.length, 0);
        const filePath = join(CACHE_DIR, hashKey(key));
        await writeFile(filePath, Buffer.concat([lenBuf, headerBuf, entry.buffer]));
      } catch (err) {
        console.warn('[cache] disk write failed, skipping L1 cache:', err.message);
        return;
      }
    }

    // L1: memory (only if L2 succeeded or L2 is disabled)
    if (memoryCache) memoryCache.set(key, entry);
  }

  async function cleanup() {
    if (!diskReady) return;
    try {
      const maxBytes = maxDiskGB * 1024 * 1024 * 1024;
      const files = await readdir(CACHE_DIR);
      const entries = [];
      let totalSize = 0;

      for (const file of files) {
        try {
          const filePath = join(CACHE_DIR, file);
          const fileStat = await stat(filePath);
          entries.push({ path: filePath, size: fileStat.size, mtime: fileStat.mtimeMs });
          totalSize += fileStat.size;
        } catch {
          // skip unreadable files
        }
      }

      if (totalSize <= maxBytes) return;

      // Sort by mtime ascending (oldest first)
      entries.sort((a, b) => a.mtime - b.mtime);

      for (const entry of entries) {
        if (totalSize <= maxBytes) break;
        await unlink(entry.path).catch(() => {});
        totalSize -= entry.size;
      }
    } catch {
      // cleanup failure is non-fatal
    }
  }

  return { get, set, initDisk, cleanup };
}

export function buildCacheKey(type, url, params) {
  const urlHash = sha256(url);

  if (type === 'source') return `source:${urlHash}`;
  if (type === 'meta') return `meta:${urlHash}`;

  // processed: include param hash
  const paramStr = [params.width, params.height, params.fit, params.quality, params.format, params.rotate, params.flip].join('|');
  const paramHash = sha256(paramStr).slice(0, 16);
  return `processed:${urlHash}_${paramHash}`;
}

function hashKey(key) {
  return sha256(key);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}
