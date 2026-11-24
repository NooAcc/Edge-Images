// Run after updating the pinned dependencies and lockfile: npm run vendor:docs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'public/vendor');
fs.mkdirSync(destination, { recursive: true });
for (const [source, target] of [
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['marked/LICENSE', 'marked-LICENSE'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['dompurify/dist/purify.min.js.map', 'purify.min.js.map'],
  ['dompurify/LICENSE', 'dompurify-LICENSE']
]) {
  fs.copyFileSync(path.join(root, 'node_modules', source), path.join(destination, target));
}
