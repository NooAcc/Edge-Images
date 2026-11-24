const test = require('node:test');
const assert = require('node:assert/strict');
const { read, browser } = require('./helpers.cjs');
function render(t, source) {
  const dom = browser();
  t.after(() => dom.window.close());
  assert.equal(typeof dom.window.EdgeDocs?.renderMarkdown, 'function', 'Markdown renderer must exist');
  const el = dom.window.document.createElement('article');
  el.innerHTML = dom.window.EdgeDocs.renderMarkdown(source);
  return el;
}

test('renders Markdown tables and fenced code in the existing styled containers', t => {
  const el = render(t, '# Guide\n\n## Section\n\n| Name | Value |\n| --- | --- |\n| size | 20 |\n\n```json\n{"size":20}\n```');
  assert.equal(el.querySelector('.table-wrap td').textContent, 'size');
  assert.equal(el.querySelector('pre.code').dataset.lang, 'json');
  assert.equal(el.querySelector('pre code').textContent.trim(), '{"size":20}');
  assert.equal(el.querySelector('.doc-section > h2').textContent, 'Section');
});

test('keeps explicit and automatic heading anchors unique and links reachable', t => {
  const el = render(t, '# Guide\n\n<a id="overview"></a>\n\n## 概览\n\n[跳转](#overview)\n\n## 中文 标题\n\n### Detail\n\n### Detail\n\n```html\n<a id="fake"></a>\n```');
  assert.equal(el.querySelector('#overview').className, 'doc-section');
  assert.ok(el.querySelector('[id="中文-标题"]'));
  assert.ok(el.querySelector('#detail'));
  assert.ok(el.querySelector('#detail-1'));
  assert.equal(el.querySelectorAll('#overview').length, 1);
  assert.equal(el.querySelector('#fake'), null);
  assert.equal(el.querySelector('a[href="#overview"]').textContent, '跳转');
});

test('sanitizes active HTML and dangerous links before rendering', t => {
  const el = render(t, '## Safe\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n<form id="doc-body"><input name="load"></form>');
  assert.equal(el.querySelector('script, form, input, [onerror], a[href^="javascript:"]'), null);
  assert.equal(el.querySelector('#doc-body'), null);
});

test('explicit subheading anchors do not duplicate heading IDs', t => {
  const el = render(t, '## Section\n\n<a id="detail"></a>\n\n### Detail\n\n[Details](#detail)');
  assert.equal(el.querySelectorAll('#detail').length, 1);
  assert.equal(el.querySelector('#detail').tagName, 'H3');
});

test('links follow automatic headings renamed to avoid shell ID collisions', t => {
  const el = render(t, '## Main\n\n[Main](#main)');
  assert.equal(el.querySelector('.doc-section').id, 'main-1');
  assert.equal(el.querySelector('a[href]').getAttribute('href'), '#main-1');
});

test('renders the actual API source with all legacy sections and valid fragment links', t => {
  const el = render(t, read('public/docs/api.md'));
  for (const id of ['overview', 'quickstart', 'single-image', 'metadata', 'video', 'nsfw', 'batch', 'async-batch', 'responses', 'errors', 'allowlist', 'environment']) {
    assert.ok(el.querySelector('.doc-section[id="' + id + '"]'), id);
  }
  for (const link of el.querySelectorAll('a[href^="#"]')) {
    assert.ok([...el.querySelectorAll('[id]')].some(n => n.id === decodeURIComponent(link.hash.slice(1))), link.hash);
  }
});
