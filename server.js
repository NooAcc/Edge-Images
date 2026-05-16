import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createImageHandler } from './lib/handler.js';
import { getPlatformConfig } from './lib/platform-config.js';
import { createCache } from './lib/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const platformConfig = getPlatformConfig();
const cache = createCache(platformConfig);

if (cache) {
  await cache.initDisk();
  await cache.cleanup();
  console.log(`[server] cache enabled: type=${platformConfig.cache.type}, memory=${platformConfig.cache.maxMemoryMB}MB, disk=${platformConfig.cache.maxDiskGB}GB`);
}

const imageHandler = createImageHandler({ platformConfig, cache });

let indexHtml;
try {
  indexHtml = await readFile(join(__dirname, 'index.html'));
} catch {
  // index.html not found, will serve 404 for root
}

const server = createServer(async (req, res) => {
  req.env = process.env;

  const pathname = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`).pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname.startsWith('/api/media')) {
    return imageHandler(req, res);
  }

  if ((pathname === '/' || pathname === '/index.html') && indexHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
