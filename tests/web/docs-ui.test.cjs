const test = require('node:test');
const assert = require('node:assert/strict');
const { read, browser } = require('./helpers.cjs');
const source = '# Guide\n\n<a id="overview"></a>\n\n## Overview\n\nHello world\n\n<a id="async-batch"></a>\n\n## Async Batch\n\ncallbackUrl\n\n```json\n{"jobId":"123"}\n```';
function setup(t, response = async () => new Response(source), url) {
  const dom = browser(read('public/index.html'), url);
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = response;
  w.eval(read('public/app.js'));
  assert.equal(typeof w.EdgeDocs?.load, 'function', 'dynamic loader must exist');
  return w;
}

test('loads Markdown into the page, generating navigation and current section', async t => {
  const w = setup(t);
  await w.EdgeDocs.load();
  const doc = w.document;
  assert.equal(doc.querySelector('#doc-body h1').textContent, 'Guide');
  assert.equal(doc.querySelectorAll('#doc-navigation a').length, 2);
  assert.equal(doc.querySelectorAll('#doc-toc a').length, 2);
  assert.equal(doc.querySelector('#doc-loading').hidden, true);
  assert.equal(doc.querySelector('#doc-error').hidden, true);
  assert.equal(doc.querySelector('#doc-body').getAttribute('aria-busy'), 'false');
  assert.ok(doc.querySelector('#doc-navigation a[aria-current]'));
});

for (const [name, response] of [
  ['HTTP failure', async () => new Response('Not found', { status: 404 })],
  ['empty response', async () => new Response('   ')],
  ['network failure', async () => { throw new Error('offline'); }]
]) {
  test(name + ' exposes raw documentation and can recover via retry', async t => {
    let failing = true;
    const w = setup(t, () => failing ? response() : Promise.resolve(new Response(source)));
    await w.EdgeDocs.load();
    assert.equal(w.document.querySelector('#doc-error').hidden, false);
    assert.equal(w.document.querySelector('#doc-loading').hidden, true);
    assert.equal(w.document.querySelector('#doc-error a').getAttribute('href'), '/docs/api.md');
    failing = false;
    const ready = new Promise(resolve => w.document.addEventListener('edge-docs-ready', resolve, { once: true }));
    w.document.querySelector('#doc-retry').click();
    await ready;
    assert.equal(w.document.querySelector('#doc-error').hidden, true);
    assert.ok(w.document.querySelector('#overview'));
  });
}

test('restores initial fragment after Markdown is available', async t => {
  const w = setup(t, undefined, 'http://localhost/#async-batch');
  await w.EdgeDocs.load();
  assert.equal(w.lastScrolled, 'async-batch');
});

test('headings colliding with SVG shell IDs keep reachable document fragments', async t => {
  const w = setup(t, async () => new Response('## i-copy\n\n[Copy](#i-copy)'), 'http://localhost/#i-copy');
  await w.EdgeDocs.load();
  assert.equal(w.document.querySelectorAll('[id="i-copy"]').length, 1);
  assert.equal(w.document.querySelector('#doc-body .doc-section').id, 'i-copy-1');
  assert.equal(w.document.querySelector('#doc-body a').getAttribute('href'), '#i-copy-1');
  assert.equal(w.lastScrolled, 'i-copy-1');
});

test('searches section content and keeps dynamic code copy and menu interactions', async t => {
  const w = setup(t);
  let copied;
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  await w.EdgeDocs.load();
  const doc = w.document;
  const search = doc.querySelector('#doc-search');
  search.value = 'callbackUrl';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(doc.querySelector('#doc-navigation a[href="#overview"]').closest('li').hidden, true);
  assert.equal(doc.querySelector('#doc-navigation a[href="#async-batch"]').closest('li').hidden, false);
  search.value = 'does not exist';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(doc.querySelector('#search-empty').hidden, false);
  doc.querySelector('#doc-body .copy-btn').click();
  await Promise.resolve();
  assert.equal(copied, '{"jobId":"123"}');
  doc.querySelector('#menu-toggle').click();
  assert.equal(doc.querySelector('#sidebar').classList.contains('is-open'), true);
  doc.querySelector('#doc-navigation a').click();
  assert.equal(doc.querySelector('#sidebar').classList.contains('is-open'), false);
  doc.querySelector('#theme-toggle').click();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  await w.EdgeDocs.load();
  assert.equal(doc.querySelectorAll('#doc-body .copy-btn').length, 1);
  assert.equal(doc.querySelector('#search-empty').hidden, false);
});
