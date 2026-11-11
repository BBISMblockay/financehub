'use strict';
// Every internal page link must point at a file that exists.
//
// WHY THIS EXISTS. `v2/hidden/bi-dashboard.html` linked to `/v2/bi-returns.html`
// for weeks. The file is at `v2/hidden/bi-returns.html`, so the link 404'd. It
// survived because nothing checks hrefs: `legacy-retirement.test.js` asserts a
// link does not point at a RETIRED page, which is the opposite question, and a
// page that merely moved is retired nowhere. Both pages are parked out of the
// nav, so no person hit it either.
//
// The check is deliberately dumb: a string literal that looks like a site-local
// .html path must resolve to a file on disk. An absolute path resolves from the
// repo root (that is what both hosts serve), a relative one from the file that
// wrote it. Query strings and fragments are stripped; external URLs, protocol-
// relative URLs and templated paths are not ours to resolve and are skipped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
// `legacy/` is archived and must not be edited, so its rot is not ours to fix.
// `tests` holds fixtures that name pages on purpose, including deleted ones.
const skipDirs = new Set(['.git', '.claude', 'node_modules', 'legacy', 'tests', 'data', 'docs']);
const scanDirs = ['v2', 'v3', 'pages', 'assets'];

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name)); }
    else if (/\.(html|js)$/.test(entry.name) && !/\.min\.js$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
}
for (const d of scanDirs) walk(path.join(root, d));
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.html$/.test(entry.name)) files.push(path.join(root, entry.name));
}

// A templated path cannot be resolved statically, and a half-built one is not a
// link yet: `${` covers template literals, `+` string concatenation, and a
// literal that does not START like a path is a suffix somebody concatenates
// (`'…' + '-print.html'`), not a link.
const TEMPLATED = /[$]{|\+/;
const PATH_START = /^[A-Za-z0-9_./]/;

// Prose about a link is not a link. `v2/profile.html` documents, in a comment,
// two paths that deliberately do NOT exist -- flagging those would teach the
// next person to delete the explanation instead of the dead link.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const broken = [];
let checked = 0;
for (const file of files) {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/["'`]([^"'`\s<>]*\.html(?:[?#][^"'`\s<>]*)?)["'`]/g)) {
    const raw = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;   // http:, mailto:, //host
    if (TEMPLATED.test(raw) || !PATH_START.test(raw)) continue;
    const target = raw.split(/[?#]/)[0];
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? path.join(root, target)
      : path.resolve(path.dirname(file), target);
    checked += 1;
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(root, file).replaceAll(path.sep, '/')} -> ${raw}`);
    }
  }
}

assert.deepEqual(broken, [], `internal link(s) point at a file that does not exist:\n  ${broken.join('\n  ')}`);
console.log(`internal links: ${checked} site-local .html link(s) across ${files.length} files all resolve`);
