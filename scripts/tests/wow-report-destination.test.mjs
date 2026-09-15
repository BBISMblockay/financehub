/* The destination as the Marketing Report actually renders it.
 *
 * The helpers are pulled out of v2/wow-report.html by name and evaluated, so
 * these run against the shipped source text rather than a copy of the logic.
 * The last two tests are the ones that matter most: they assert the render
 * path and the CSV export actually CALL this code. A helper that passes in
 * isolation while nothing invokes it is the exact shape of the temporal-dead-
 * zone bug this repo shipped in an orchestrator callback with 91 green
 * assertions underneath it.
 *
 * Mutations (each must make this file FAIL):
 *   WOW_DEST_MUTATION=no-url-guard   (any string accepted into the href)
 *   WOW_DEST_MUTATION=blank-missing  (an unresolved destination renders empty)
 *
 * Run:  node scripts/tests/wow-report-destination.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const mutation = process.env.WOW_DEST_MUTATION || '';
assert.ok(['', 'no-url-guard', 'blank-missing'].includes(mutation), `Unknown mutation ${mutation}`);

let html = await readFile(new URL('../../v2/wow-report.html', import.meta.url), 'utf8');
if (mutation === 'no-url-guard') {
  html = html.replace('/^https?:\\/\\/[^\\s<>"\']+$/i.test(v.trim())', 'Boolean(v.trim())');
} else if (mutation === 'blank-missing') {
  html = html.replace(
    'if (!url) return `<span class="wow-dest dim">destination not resolved</span>`;',
    "if (!url) return '';");
}
if (mutation) assert.notEqual(html, await readFile(new URL('../../v2/wow-report.html', import.meta.url), 'utf8'),
  'mutation did not apply');

/** Lift a named function/const out of the page by brace matching. */
function lift(name) {
  const starts = [`function ${name}(`, `const ${name} = `];
  const start = starts.map((s) => html.indexOf(s)).find((i) => i >= 0);
  assert.ok(start >= 0 && start !== undefined, `${name} not found in wow-report.html`);
  let i = html.indexOf('{', start), depth = 0, end = -1;
  // `const x = (...) => (...)` has no block body; take to the end of statement.
  const arrowBody = html.slice(start, html.indexOf('\n', start)).includes('=> (');
  if (arrowBody) {
    let j = html.indexOf('=> (', start) + 3, d = 0;
    for (; j < html.length; j++) {
      if (html[j] === '(') d++;
      else if (html[j] === ')') { d--; if (d === 0) { end = j + 2; break; } }
    }
    return html.slice(start, end);
  }
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `could not delimit ${name}`);
  return html.slice(start, end);
}

const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sandbox = { URL, esc, console };
vm.createContext(sandbox);
vm.runInContext([lift('safeUrl'), lift('destCell'), lift('destFoot')].join('\n;\n'), sandbox);
const { destCell, destFoot } = sandbox;

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

// Every call below passes supported=true; the unsupported case has its own test.
const cell = (a) => destCell(a, true);

test('a site destination renders host and path, linked', () => {
  const out = cell({ link: 'https://baseballism.com/collections/new', link_path: '/collections/new', link_source: 'link_data' });
  assert.match(out, /href="https:\/\/baseballism\.com\/collections\/new"/);
  assert.match(out, />baseballism\.com\/collections\/new</);
  assert.match(out, /rel="noopener noreferrer"/, 'a new-tab link must not hand over window.opener');
  assert.ok(!out.includes('wow-dest--offsite'), 'the site is not offsite');
});

test('the host is always shown, so a page-post destination is visible as one', () => {
  // The reason link_url_source exists. A bare "/123/posts/456" would read as
  // a landing page on the site.
  const out = cell({ link: 'https://www.facebook.com/123/posts/456', link_path: '/123/posts/456', link_source: 'effective_object_url' });
  assert.match(out, />facebook\.com\/123\/posts\/456</);
  assert.match(out, /wow-dest--offsite/, 'a Meta-hosted destination must be marked');
  assert.match(out, /not the site/, 'and must say why in its title');
});

test('a bare origin drops the redundant trailing slash', () => {
  const out = cell({ link: 'https://baseballism.com/', link_path: '/', link_source: 'link_data' });
  assert.match(out, />baseballism\.com</);
});

test('the source travels into the title, always', () => {
  const out = cell({ link: 'https://baseballism.com/x', link_path: '/x', link_source: 'carousel_card' });
  assert.match(out, /source: carousel_card/);
});

test('a source that is not the shape the sync writes cannot break the title', () => {
  // link_source is plain database text landing in an attribute, and this
  // page's esc() does not escape quotes.
  const out = cell({ link: 'https://baseballism.com/x', link_path: '/x',
    link_source: 'link_data" onmouseover="alert(1)' });
  assert.ok(!out.includes('onmouseover'), 'an attribute must not be injectable through the source');
  assert.match(out, /source: unknown/);
});

test('an unresolved destination says so, and is never a link', () => {
  const out = cell({ link: null, link_path: null, link_source: null });
  assert.match(out, /destination not resolved/);
  assert.ok(!out.includes('<a '), 'nothing to link to');
});

test('a dangerous value never reaches the href', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
                     'vbscript:msgbox', 'file:///etc/passwd', '//evil.example.com',
                     'https://evil.com/" onmouseover="alert(1)']) {
    const out = cell({ link: bad, link_path: '/x', link_source: 'link_data' });
    assert.ok(!out.includes('<a '), `${bad} must not render as a link`);
    assert.ok(!out.includes('onmouseover'), `${bad} must not inject an attribute`);
    assert.match(out, /destination not resolved/);
  }
});

test('an RPC that does not know about destinations says NOTHING', () => {
  // The page and wow_creatives deploy separately. "destination not resolved"
  // on every row would be a claim about the ads; the truth is nothing asked.
  assert.equal(destCell({ link: null, link_path: null, link_source: null }, false), '');
  assert.equal(destCell({ link: 'https://baseballism.com/x', link_path: '/x', link_source: 'link_data' }, false), '');
});

test('the coverage note is silent when every ad resolved', () => {
  assert.equal(destFoot({ ads_total: 10, ads_with_link: 10 }), null);
});

test('a partial resolve says how many, and that a blank is unresolved', () => {
  const note = destFoot({ ads_total: 20, ads_with_link: 8 });
  assert.match(note, /8 of 20/);
  assert.match(note, /not an ad going nowhere/);
});

test('zero resolved is explained, not left as twenty blank cells', () => {
  const note = destFoot({ ads_total: 20, ads_with_link: 0 });
  assert.match(note, /Not a claim that these ads go nowhere/);
});

test('an older payload without the field says nothing rather than "0 of 20"', () => {
  // wow_creatives is deployed separately from this page. Between the two, the
  // RPC has no ads_with_link -- which is absent, not zero.
  assert.equal(destFoot({ ads_total: 20 }), null);
});

// ── the call sites, which is where this kind of change actually breaks ──
test('the creative row RENDERS the destination cell', () => {
  const row = html.slice(html.indexOf('<td><div class="wow-ad">${a.thumb'));
  assert.match(row.slice(0, 600), /\$\{destCell\(a, destSupported\)\}/,
    'destCell is defined but the ad cell never calls it');
  assert.match(html, /const destSupported = g\.ads_with_link != null;/,
    'support must be derived from the payload, not assumed');
});

test('creFoot routes every return through the destination note', () => {
  const start = html.indexOf('function creFoot(g)');
  const body = html.slice(start, html.indexOf('\n  }', start));
  const returns = body.split('return ').slice(1);
  assert.ok(returns.length >= 4, `expected creFoot to have several returns, saw ${returns.length}`);
  for (const r of returns) {
    assert.ok(r.trimStart().startsWith('withDest('),
      `a creFoot return bypasses the destination note: ${r.slice(0, 60)}`);
  }
});

test('the CSV export carries the destination AND its source', () => {
  const start = html.indexOf("push('Ad','Ad set','Campaign','Copy','Copy source'");
  assert.ok(start > 0, 'creative export header not found');
  const block = html.slice(start, start + 900);
  assert.match(block, /'Destination','Destination source'/);
  assert.match(block, /a\.link \?\? 'not resolved'/, 'a blank cell in a spreadsheet is not "unresolved"');
  assert.match(block, /a\.link_source \?\? ''/);
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
