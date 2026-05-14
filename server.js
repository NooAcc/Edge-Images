import { createServer } from 'node:http';
import { createImageHandler } from './lib/handler.js';

const PORT = Number(process.env.PORT) || 3000;
const imageHandler = createImageHandler();

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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
