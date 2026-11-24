const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { marked } = require('marked');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('README and Docker Hub link to the readable single API source', () => {
  assert.ok(fs.existsSync(path.join(root, 'public/docs/api.md')), 'API Markdown must exist');
  const source = read('public/docs/api.md');
  const doc = new JSDOM(marked.parse(source)).window.document;
  assert.ok(doc.querySelector('h1'));
  assert.ok(doc.querySelector('table'));
  assert.ok(doc.querySelector('pre code'));
  for (const entry of ['README.md', 'DOCKERHUB.md']) {
    const page = new JSDOM(marked.parse(read(entry))).window.document;
    const links = [...page.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    assert.ok(links.some(href => href.endsWith('public/docs/api.md')), entry + ' needs an API source link');
    for (const href of links.filter(href => !/^(?:https?:|#)/.test(href))) {
      assert.ok(fs.existsSync(path.join(root, href.split('#')[0])), entry + ': missing ' + href);
    }
  }
});

test('old documentation redirects still point at anchors in the API source', () => {
  assert.ok(fs.existsSync(path.join(root, 'public/docs/api.md')), 'API Markdown must exist');
  const doc = new JSDOM(marked.parse(read('public/docs/api.md'))).window.document;
  for (const file of ['public/api.html', 'public/docs/index.html', 'public/images.html', 'public/videos.html', 'public/batch.html']) {
    const redirect = new JSDOM(read(file)).window.document.querySelector('link[rel="canonical"]').getAttribute('href');
    assert.ok(doc.getElementById(redirect.split('#')[1]), 'missing redirect target ' + redirect);
  }
});
