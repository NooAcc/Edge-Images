import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createImageHandler } from './lib/handler.js';
import { createBatchHandler } from './lib/batch.js';
import { getPlatformConfig } from './lib/platform-config.js';
import { createCache } from './lib/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(__dirname, 'public');

const platformConfig = getPlatformConfig();
const cache = createCache(platformConfig);

if (cache) {
  await cache.initDisk();
  await cache.cleanup();
  console.log(`[server] cache enabled: type=${platformConfig.cache.type}, memory=${platformConfig.cache.maxMemoryMB}MB, disk=${platformConfig.cache.maxDiskGB}GB`);
}

const imageHandler = createImageHandler({ platformConfig, cache });
const batchHandler = createBatchHandler({ platformConfig, cache });

let indexHtml;
try {
  indexHtml = await readFile(join(PUBLIC_DIR, 'index.html'));
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

  if (pathname === '/api/batch') {
    return batchHandler(req, res);
  }

  if ((pathname === '/' || pathname === '/index.html') && indexHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  // Serve static files from public directory
  const safePath = pathname.replace(/\.\./g, '');
  const filePath = join(PUBLIC_DIR, safePath);
  try {
    const content = await readFile(filePath);
    const ext = filePath.split('.').pop();
    const contentTypes = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain; charset=utf-8' });
    res.end(content);
    return;
  } catch {
    // file not found, fall through to 404
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
