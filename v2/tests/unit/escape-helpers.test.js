/* Escape helpers that feed innerHTML (security audit 2026-10-08).
 *
 * Several pages had an esc() that escaped & < > but not quotes, and used it
 * inside value="…" / title="…" attributes, so a stored value like
 * `1" autofocus onfocus="…` broke out and ran for whoever opened the page.
 * Launch Calendar put designer / channel into innerHTML unescaped, and links
 * built from free-text URLs accepted javascript:. Each helper is extracted
 * from its page and run, not pattern-matched. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('escape-helpers');
const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// `const esc = …;` on one line, or a `function esc(…) {…}` block.
function extractEsc(src, name = 'esc') {
  const line = src.split('\n').find((l) => new RegExp(`^\\s*const ${name} = `).test(l));
  if (line) return line.trim();
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  return null;
}
function load(code, name) {
  const ctx = vm.createContext({ URL, location: { href: 'https://silo.example/v2/x.html' } });
  vm.runInContext(code, ctx);
  return vm.runInContext(name, ctx);
}

const BREAKOUT = `1" autofocus onfocus="alert(1)`;
const SINGLE = `x' onmouseover='alert(1)`;

for (const file of ['v2/wow-report.html', 'v2/po-costing.html', 'v2/profile.html', 'v2/help.html', 'v2/marketing-explorer.html']) {
  r.test(`${file}: esc() is safe inside a quoted attribute`, () => {
    const src = extractEsc(read(file));
    if (!src) throw new Error('esc() not found');
    const esc = load(src, 'esc');
    r.eq(esc(BREAKOUT).includes('"'), false, 'double quote must be escaped');
    r.eq(esc(SINGLE).includes("'"), false, 'single quote must be escaped');
    r.eq(esc('<b>&'), '&lt;b&gt;&amp;');
  });
}

r.test('evidence-card.js: esc() is safe inside a quoted attribute', () => {
  const src = read('v2/evidence-card.js');
  const line = src.split('\n').find((l) => /^\s*const esc = /.test(l));
  const esc = load(line.trim(), 'esc');
  r.eq(esc(BREAKOUT).includes('"'), false);
  r.eq(esc(SINGLE).includes("'"), false);
});

for (const file of ['v2/launch-calendar.html', 'v2/v2/launch-calendar2.html']) {
  const src = read(file);
  r.test(`${file}: designer and channel are escaped in the drawer`, () => {
    r.ok('no raw designer', !src.includes('`Designer: ${x.designer}`'));
    r.ok('no raw channel', !src.includes('`Channel: ${x.marketing_channel}`'));
  });
  r.test(`${file}: every esc() href goes through safeUrl()`, () => {
    const raw = src.match(/href="\$\{esc\((?!safeUrl\()[^}]*\)\}"/g) || [];
    r.eq(raw, [], 'href built without safeUrl');
    const safeUrl = load(extractEsc(src, 'safeUrl'), 'safeUrl');
    r.eq(safeUrl('javascript:alert(1)'), '#');
    r.eq(safeUrl(' JAVASCRIPT:alert(1)'), '#');
    r.eq(safeUrl('data:text/html,x'), '#');
    r.eq(safeUrl('https://drive.google.com/a'), 'https://drive.google.com/a');
    r.eq(safeUrl('http://example.com/'), 'http://example.com/');
  });
}

r.test('calendar.html: every esc() href goes through safeUrl()', () => {
  const src = read('v2/calendar.html');
  r.eq(src.match(/href="\$\{esc\((?!safeUrl\()[^}]*\)\}"/g) || [], []);
});

r.test('avatar.js: a quote or paren in avatar_url cannot close the CSS url()', () => {
  const src = read('v2/avatar.js');
  const cssUrl = load(extractEsc(src, 'cssUrl'), 'cssUrl');
  const out = cssUrl("x') ;background:url(https://evil/;('");
  r.eq(/['"()]/.test(out), false, out);
  r.eq(cssUrl('https://abc.supabase.co/storage/v1/object/public/avatars/u/a%20b.png'),
    'https://abc.supabase.co/storage/v1/object/public/avatars/u/a%20b.png', 'an ordinary URL is unchanged');
  r.ok('the style attribute uses cssUrl', src.includes("url('${escAttr(cssUrl(p.avatarUrl))}')"));
});

const s = r.summary();
process.exit(s.fail ? 1 : 0);
