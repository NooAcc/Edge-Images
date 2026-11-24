const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '../../public');

test('the shipped static page starts using local libraries and the real Markdown file', async t => {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const filename = path.join(root, pathname === '/' ? 'index.html' : pathname);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.md': 'text/markdown' };
      res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
      res.end(await fs.readFile(filename));
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/#async-batch';
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', err => errors.push(err.message));
  let ready;
  const loaded = new Promise(resolve => { ready = resolve; });
  const dom = await JSDOM.fromURL(url, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.AbortController = AbortController;
      w.fetch = (input, options) => fetch(new URL(input, w.location.href), options);
      w.HTMLElement.prototype.scrollIntoView = function () { w.lastScrolled = this.id; };
      w.document.addEventListener('edge-docs-ready', ready, { once: true });
    }
  });
  t.after(() => dom.window.close());
  await Promise.race([loaded, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Shipped page did not load documentation: ' + errors.join('; '))), 5000);
    t.after(() => clearTimeout(timer));
  })]);
  const doc = dom.window.document;
  assert.equal(doc.querySelector('#doc-body h1').textContent, 'Edge Image API');
  assert.equal(doc.querySelectorAll('#doc-navigation a').length, 12);
  assert.ok(doc.querySelector('#doc-body .copy-btn'));
  assert.equal(dom.window.lastScrolled, 'async-batch');
  assert.deepEqual(errors, []);
});
