'use strict';
// Every internal page link and asset reference must point at a file that exists.
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
//
// The same pass covers `src=` / `href=` .js and .css references, because a page
// one directory deeper than the assets it names with RELATIVE paths loads none
// of them. Both pages in `v2/hidden/` did exactly that: every one of
// `beacon.css`, `v2-shell.js`, `nav-config.js`, `silo-chrome.js` resolved under
// `/v2/hidden/`, and `../pages/config.js` resolved to `/v2/pages/config.js`, so
// the page threw "Missing Supabase config" before it built a client. All eight
// were 404 on production. They are absolute now. A link test alone could not
// have caught it -- the link was fine, the destination could not boot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
// `legacy/` is archived and must not be edited, so its rot is not ours to fix.
// `tests` holds fixtures that name pages on purpose, including deleted ones.
const skipDirs = new Set(['.git', '.claude', 'node_modules', 'legacy', 'tests', 'data', 'docs']);
// `v2/v2/launch-calendar2.html` is an orphaned copy of the launch calendar,
// documented as such in CHANGELOG 2026-10-14: nothing links to it and it keeps
// the old type lists. It carries the same relative-asset defect as the hidden
// pages did, and it is skipped rather than repaired because repairing it would
// turn a page nobody links to from broken into working, which is a decision
// about whether it should exist at all -- raised with Blake 2026-11-11. Delete
// the page and this entry together.
const skipFiles = new Set(['v2/v2/launch-calendar2.html']);
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

// A page link can be written anywhere (a JS redirect, an onclick, an href). An
// asset reference is an attribute, so it is matched as one -- `"beacon.css"`
// loose in a script is a name, not a load.
const PAGE_LINK = /["'`]([^"'`\s<>]*\.html(?:[?#][^"'`\s<>]*)?)["'`]/g;
const ASSET_REF = /(?:src|href)=["']([^"'\s<>]+\.(?:js|css)(?:[?#][^"'\s<>]*)?)["']/g;

const broken = [];
let checked = 0;
for (const file of files) {
  const rel0 = path.relative(root, file).replaceAll(path.sep, '/');
  if (skipFiles.has(rel0)) continue;
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  for (const match of [...source.matchAll(PAGE_LINK), ...source.matchAll(ASSET_REF)]) {
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

assert.deepEqual(broken, [], `internal reference(s) point at a file that does not exist:\n  ${broken.join('\n  ')}`);
console.log(`internal references: ${checked} site-local page link(s) and asset reference(s) across ${files.length} files all resolve`);
