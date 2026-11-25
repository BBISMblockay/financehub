/* The account dropdown and period bar are presentation over the two <select>s
   bank-workspace.js owns. These tests run the ACTUAL file against a DOM and
   assert the contract that matters: picking an account must drive the select
   the existing listeners read. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const source = await readFile(new URL('v2/transactions-tiles.js', root), 'utf8');
const stylesheet = await readFile(new URL('v2/transactions-workspace.css', root), 'utf8');
function cssText() { return stylesheet; }

test('workspace asset URLs change with their contents so cached pre-tile assets cannot mix with the new page', async () => {
  const html = await readFile(new URL('v2/transactions.html', root), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], 'https://silo.test/v2/transactions.html'));
  for (const name of ['transactions-workspace.css', 'bank-workspace.js', 'transactions-tiles.js', 'transaction-dates.js', 'card-splits.js', 'transaction-filters.js']) {
    const bytes = await readFile(new URL('v2/' + name, root));
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const matches = urls.filter(url => url.pathname === '/v2/' + name);
    assert.equal(matches.length, 1, name + ' must be included exactly once');
    assert.equal(matches[0].searchParams.get('v'), digest,
      `Update ${name}?v= in transactions.html to ${digest} when this asset changes`);
    assert.notEqual(matches[0].href, new URL(name, 'https://silo.test/v2/transactions.html').href,
      'the browser must not reuse the unversioned pre-tile cache entry');
  }
});

// Minimal DOM: enough for querySelector/closest/dataset/innerHTML on the few
// nodes this module touches, without pulling in a browser.
function dom() {
  const listeners = new Map();
  function mkOption(o) {
    return { value: o.value, text: o.text, selected: !!o.selected, dataset: o.data || {} };
  }
  const nodes = {};
  function node(id) {
    return nodes[id] || (nodes[id] = {
      id, innerHTML: '', textContent: '', hidden: false, disabled: false,
      classList: { _s: new Set(), toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      setAttribute() {}, addEventListener(k, fn) { listeners.set(id + ':' + k, fn); },
      options: [],
      dispatchEvent(e) { const fn = listeners.get(id + ':' + e.type); if (fn) fn({ target: this }); return true; },
    });
  }
  const doc = {
    getElementById: node,
    addEventListener(k, fn) { listeners.set('doc:' + k, fn); },
  };
  return { doc, node, listeners, mkOption };
}

function setup() {
  const { doc, node, listeners, mkOption } = dom();
  const account = node('workspaceAccount');
  const period = node('workspacePeriod');
  node('workspaceTiles'); node('workspacePeriodBar');
  node('workspaceAccountMeta');
  account.options = [
    mkOption({ value: 'src-1', text: 'Key Bank · 3126', selected: true,
      data: { name: 'Key Bank · Checking', mask: '3126', balance: '$58,425.87', balanceLabel: 'Available',
              health: 'synced-recently', healthLabel: 'Recently synced', pending: '14', synced: new Date().toISOString() } }),
    mkOption({ value: 'src-2', text: 'Amex · 1008',
      data: { name: 'Amex · Platinum', mask: '1008', balance: '$12,904.42', balanceLabel: 'Balance',
              health: 'login_required', healthLabel: 'Bank login required', pending: '0', synced: '' } }),
  ];
  period.options = [
    mkOption({ value: 'b-aug', text: 'Aug', selected: true, data: { label: 'August 2026', start: '2026-08-01', status: 'draft', pending: '14' } }),
    mkOption({ value: 'b-jul', text: 'Jul', data: { label: 'July 2026', start: '2026-07-01', status: 'posted', pending: '0' } }),
  ];
  // MutationObserver is a no-op here; these tests call render() directly.
  const ctx = { window: {}, document: doc, MutationObserver: class { observe() {} }, Event, console };
  vm.runInNewContext(source, ctx);
  const ui = ctx.window.SiloTransactionTiles.create({ document: doc });
  return { ui, doc, account, period, listeners, api: ctx.window.SiloTransactionTiles };
}

test('the account control is one closed dropdown listing every account', () => {
  const { doc, account } = setup();
  const html = doc.getElementById('workspaceTiles').innerHTML;
  assert.equal((html.match(/class="wacct-label"/g) || []).length, 1, 'one control, not a tile per account');
  assert.equal((html.match(/role="option"/g) || []).length, 2, 'every account is in the list');
  assert.ok(html.includes('data-value="src-1"') && html.includes('data-value="src-2"'));
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.ok(/<div class="wacct-pop"[^>]*\shidden/.test(html), 'the list starts closed');
  assert.ok(html.includes('$58,425.87'), 'balance is on the closed control');
  assert.ok(html.includes('14 to categorize'), 'pending count uses the categorize vocabulary');
  assert.ok(html.includes('All done'), 'an account with nothing pending says so');
  assert.equal(account.value, undefined, 'rendering must not mutate the select');
});

test('nothing in the account control scrolls sideways', () => {
  // The rail this replaced hid accounts past the right edge. A horizontal
  // scroller here would bring that back.
  const style = cssText();
  const rail = style.match(/\.wacct[^{]*\{[^}]*overflow-x[^}]*\}/g);
  assert.equal(rail, null, 'no account element may scroll horizontally');
  assert.ok(!/\.wacct-pop\s*\{[^}]*scroll-snap-type/.test(style), 'no x snapping');
});

test('the account meta line totals what is actually pending', () => {
  const { doc } = setup();
  assert.equal(doc.getElementById('workspaceAccountMeta').textContent, '2 accounts · 14 to categorize across imports');
});

test('choosing an account drives the select and fires change, so existing listeners run', () => {
  const { doc, account, listeners } = setup();
  let changed = null;
  listeners.set('workspaceAccount:change', (e) => { changed = e.target.value; });
  listeners.get('workspaceTiles:click')({
    stopPropagation() {},
    target: { closest: s => s==='[data-value]' ? ({ dataset: { value: 'src-2' }, disabled: false }) : null },
  });
  assert.equal(account.value, 'src-2', 'select is the state');
  assert.equal(changed, 'src-2', 'a change event reached the existing handler');
});

test('a disabled select is never driven by the account control', () => {
  const { account, listeners } = setup();
  account.disabled = true;
  let fired = false;
  listeners.set('workspaceAccount:change', () => { fired = true; });
  listeners.get('workspaceTiles:click')({
    stopPropagation() {},
    target: { closest: s => s==='[data-value]' ? ({ dataset: { value: 'src-2' }, disabled: false }) : null },
  });
  assert.equal(fired, false, 'navigation in flight must not be interrupted');
});

test('period bar shows months and flags periods with rows to categorize', () => {
  const { doc } = setup();
  const html = doc.getElementById('workspacePeriodBar').innerHTML;
  assert.ok(html.includes('August 2026'));
  assert.ok(html.includes("Aug ’26") && html.includes("Jul ’26"), 'months, not a day grid');
  assert.ok(/wper-cell[^"]*has-pending[^"]*"[^>]*data-value="b-aug"/.test(html), 'August carries the pending flag');
  assert.ok(!/data-value="b-jul"[^>]*has-pending/.test(html), 'a settled period is not flagged');
});

test('opening the period popover does not immediately close it', () => {
  // Regression: renderPeriod() replaces the clicked node, so the document-level
  // close handler saw a detached element, closest() returned null, and the
  // popover shut on the same click that opened it. Found in a real browser —
  // a stub DOM cannot reproduce it, so the guard is asserted directly.
  const { doc, listeners } = setup();
  let propagationStopped = false;
  listeners.get('workspacePeriodBar:click')({
    target: { closest: (s) => (s === '.wper-label' ? {} : null) },
    stopPropagation() { propagationStopped = true; },
  });
  assert.equal(propagationStopped, true, 'the bar must stop the click reaching the document closer');
  assert.ok(!/<div class="wper-pop"[^>]*\shidden/.test(doc.getElementById('workspacePeriodBar').innerHTML),
    'popover is open after clicking the label');
});

test('institution marks never borrow a status colour', () => {
  const { api } = setup();
  // Red/amber/green are the sync dot's vocabulary; a mark must not speak it.
  for (const name of ['Brex · Corporate', 'Amex · Platinum', 'Key Bank', 'Divvy', 'Chase', 'PayPal', 'x', '']) {
    const h = api.hue(name);
    const warm = (h >= 0 && h <= 180);
    assert.equal(warm, false, `${name} resolved to hue ${h}, which reads as a status colour`);
  }
});

test('the control keeps its height however many accounts there are', () => {
  const { ui, doc, account } = setup();
  const before = doc.getElementById('workspaceTiles').innerHTML.match(/class="wacct-label"/g).length;
  account.options = Array.from({ length: 23 }, (_, i) => ({
    value: 's' + i, text: 'Account ' + i, selected: i === 0,
    dataset: { name: 'Account ' + i, pending: '1', health: 'synced-recently' },
  }));
  ui.render();
  const html = doc.getElementById('workspaceTiles').innerHTML;
  assert.equal(html.match(/class="wacct-label"/g).length, before, 'still one control');
  assert.equal((html.match(/role="option"/g) || []).length, 23, 'all 23 are reachable in the list');
  assert.equal(doc.getElementById('workspaceAccountMeta').textContent, '23 accounts · 23 to categorize across imports');
});

test('opening the account list does not immediately close it', () => {
  // Same regression the period popover had: renderTiles() replaces the clicked
  // node, so the document-level closer sees a detached element.
  const { doc, listeners } = setup();
  let propagationStopped = false;
  listeners.get('workspaceTiles:click')({
    stopPropagation() { propagationStopped = true; },
    target: { closest: (s) => (s === '[data-account-open]' ? { disabled: false } : null) },
  });
  assert.equal(propagationStopped, true, 'the control must stop the click reaching the document closer');
  assert.ok(!/<div class="wacct-pop"[^>]*\shidden/.test(doc.getElementById('workspaceTiles').innerHTML),
    'the list is open after clicking the control');
});

test('Escape closes the account list', () => {
  const { doc, listeners } = setup();
  listeners.get('workspaceTiles:click')({
    stopPropagation() {},
    target: { closest: (s) => (s === '[data-account-open]' ? { disabled: false } : null) },
  });
  listeners.get('doc:keydown')({ key: 'Escape' });
  assert.ok(/<div class="wacct-pop"[^>]*\shidden/.test(doc.getElementById('workspaceTiles').innerHTML));
});

test('sync tone: green only when the account is genuinely current', () => {
  const { api } = setup();
  assert.equal(api.tone('synced-recently'), 'ok');
  assert.equal(api.tone('csv'), 'ok');
  assert.equal(api.tone('syncing'), 'busy');
  for (const bad of ['login_required', 'disconnected', 'stale', 'error', 'unmapped', 'mapped-never-synced']) {
    assert.equal(api.tone(bad), 'warn', bad + ' must not read as healthy');
  }
});

test('initials and hue are derived, stable, and never blank', () => {
  const { api } = setup();
  assert.equal(api.initials('Key Bank · Checking'), 'KB');
  assert.equal(api.initials('Amex'), 'AM');
  assert.equal(api.initials(''), '••');
  assert.equal(api.initials(null), '••');
  assert.equal(api.hue('Key Bank'), api.hue('Key Bank'), 'same account keeps its colour');
  assert.ok(api.hue('Key Bank') >= 0 && api.hue('Key Bank') < 360);
});

test('escaping: an account name cannot inject markup into the account control', () => {
  const { ui, doc, account } = setup();
  account.options = [{ value: 'x', text: 'x', selected: true,
    dataset: { name: '<img src=x onerror=alert(1)>', pending: '0', health: 'csv' } }];
  ui.render();
  const html = doc.getElementById('workspaceTiles').innerHTML;
  assert.ok(!html.includes('<img'), 'raw tag must not survive');
  assert.ok(html.includes('&lt;img'), 'it is rendered as text');
});
