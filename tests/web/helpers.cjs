const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
function browser(html = '<div></div>', url = 'http://localhost/') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () { w.lastScrolled = this.id; };
  w.eval(read('node_modules/marked/lib/marked.umd.js'));
  w.eval(read('node_modules/dompurify/dist/purify.min.js'));
  if (fs.existsSync(path.join(root, 'public/docs.js'))) w.eval(read('public/docs.js'));
  return dom;
}
module.exports = { read, browser };
