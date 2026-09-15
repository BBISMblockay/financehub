/* Every Beacon token a page reads must actually exist.
 *
 * This suite exists because of one bug with one cause and a lot of symptoms.
 * 57 rules across the Accounting Suite set a background, a sticky header or a
 * popover from `var(--bcn-panel)` with no fallback -- and --bcn-panel is
 * defined in no stylesheet in this repo. CSS does not warn about that: the
 * declaration is invalid at computed-value time, background-color falls back
 * to its initial value, and the initial value of background-color is
 * `transparent`.
 *
 * So the row-detail drawer, the split editor, the confirm dialogs, the sticky
 * page header, the popover menu and the suite's own nav bar were all
 * see-through, and the register scrolled visibly through them. Nothing in the
 * markup was wrong and no console message was produced. A grep is the only
 * thing that finds it, so the grep is a test.
 *
 * Note the asymmetry: `var(--x, fallback)` is FINE when --x is undefined --
 * the fallback is used. It is the no-fallback form that silently voids the
 * declaration, so that is what this scans for.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { V2 } = require('../lib/load');

const r = createReporter('beacon-tokens');

const BEACON = path.join(V2, 'beacon.css');
const defined = new Set(
  (fs.readFileSync(BEACON, 'utf8').match(/--bcn-[a-z0-9-]+\s*:/g) || [])
    .map((m) => m.replace(/\s*:$/, '')));

/* The files this PR's module owns: the Accounting Suite pages, their
   stylesheets and the shared components they mount. */
const SUITE = [
  'accounting-books.html', 'accounting-books.css',
  'accounting-export.html', 'accounting-suite.css', 'accounting-suite.js',
  'cash-forecast.html', 'cashflow.css', 'cashflow.js',
  'fixed-assets.html', 'qbo-reports.html', 'schedules.html',
  'transactions.html', 'transactions-workspace.css', 'transaction-filters.js',
  'je-composer.js', 'finance-dialog.js', 'card-splits.js', 'bank-workspace.js',
  'transactions-tiles.js', 'beacon.css', 'silo-brand.css',
];

/* Known offenders OUTSIDE this suite, left alone on purpose rather than
   swept into an accounting PR. Listed so the count cannot grow unnoticed and
   so nobody has to rediscover them; see docs/ops/bugs.md. */
const KNOWN_ELSEWHERE = [
  ['products.html', '--bcn-bg-2'],
  ['po-builder-beacon.css', '--bcn-surface-2'],
  ['po-workbench.css', '--bcn-surface-2'],
];

/** Every `var(--bcn-x)` in `file` that has NO fallback. */
function undefinedTokens(file) {
  const full = path.join(V2, file);
  if (!fs.existsSync(full)) return [`MISSING FILE ${file}`];
  const source = fs.readFileSync(full, 'utf8');
  const hits = source.match(/var\(\s*--bcn-[a-z0-9-]+\s*\)/g) || [];
  return [...new Set(hits.map((h) => h.replace(/var\(\s*|\s*\)/g, '')))]
    .filter((token) => !defined.has(token));
}

console.log('\n── beacon.css defines what it is asked for ──');

r.test('beacon.css defines a usable set of tokens', () => {
  r.truthy(defined.size > 20, `only ${defined.size} tokens parsed out of beacon.css`);
  for (const core of ['--bcn-surface', '--bcn-ink', '--bcn-border', '--bcn-bg']) {
    r.truthy(defined.has(core), `${core} is not defined`);
  }
});

r.test('--bcn-surface and --bcn-ink are defined in BOTH themes', () => {
  const css = fs.readFileSync(BEACON, 'utf8');
  for (const theme of ['light', 'dark']) {
    const block = css.split(`:root[data-theme="${theme}"]`)[1] || '';
    const body = block.slice(0, block.indexOf('}'));
    r.truthy(/--bcn-surface\s*:/.test(body), `--bcn-surface missing from the ${theme} block`);
    r.truthy(/--bcn-ink\s*:/.test(body), `--bcn-ink missing from the ${theme} block`);
  }
});

console.log('\n── no Accounting Suite file reads a token that does not exist ──');

for (const file of SUITE) {
  const missing = undefinedTokens(file);
  r.ok(`${file} uses only defined tokens`, missing.length === 0,
    missing.length ? `undefined, and with no fallback: ${missing.join(', ')}` : '');
}

r.test('a fallback form is not flagged -- it is legitimate', () => {
  // Guard against this suite becoming a blanket ban on var() fallbacks:
  // je-composer.js deliberately uses them for colours it can degrade on.
  const source = fs.readFileSync(path.join(V2, 'je-composer.js'), 'utf8');
  r.truthy(/var\(--bcn-[a-z0-9-]+,\s*#/.test(source),
    'expected je-composer.js to still carry at least one fallback form');
});

console.log('\n── the known offenders elsewhere have not grown ──');

for (const [file, token] of KNOWN_ELSEWHERE) {
  const missing = undefinedTokens(file);
  r.ok(`${file} is still limited to ${token}`, missing.length === 1 && missing[0] === token,
    `found: ${missing.join(', ') || 'none — fixed? remove it from KNOWN_ELSEWHERE'}`);
}

r.test('no OTHER v2 file has picked up an undefined token', () => {
  const known = new Set(KNOWN_ELSEWHERE.map(([f]) => f));
  const offenders = [];
  for (const file of fs.readdirSync(V2)) {
    if (!/\.(css|js|html)$/.test(file) || known.has(file)) continue;
    const missing = undefinedTokens(file);
    if (missing.length) offenders.push(`${file}: ${missing.join(', ')}`);
  }
  r.eq(offenders, [], 'files reading tokens beacon.css does not define');
});

process.exit(r.summary().fail ? 1 : 0);
