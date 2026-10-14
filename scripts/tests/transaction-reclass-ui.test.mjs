/* The posted-period reclass on the Transactions page (v2/transaction-reclass.js).
 *
 * Executes the shipped module and its real dialog callbacks; only the DOM, the
 * Supabase transport and the composer are fakes. What is held down:
 *   - the button is offered only where the RPC would accept it, and never
 *     beside a reclass already awaiting review or posting;
 *   - staging sends exactly the chosen target and the reason, and only then
 *     opens the composer on the STORED draft in review-only mode;
 *   - a refused stage keeps the dialog open with the reason and opens nothing;
 *   - discarding deletes only a draft and says so when nothing was deleted;
 *   - the page loads reclasses through every loader and routes reclass clicks
 *     before its read-only gate (a posted period is read-only by definition).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const code = await readFile(new URL('../../v2/transaction-reclass.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../../v2/transactions.html', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.hidden = false; this.textContent = ''; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? { text: k } : k); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async fire(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  remove() { this.removed = true; }
  focus() {}
  all(tag) { const out = []; const walk = (n) => { for (const c of n.children || []) { if (c.tag === tag) out.push(c); walk(c); } }; walk(this); return out; }
}
// The resolver says where the amount sits in QuickBooks now. Its location is the
// one the ORIGINAL posting used (the source default at approval), which a row
// with no location of its own does not carry.
const FROM = { account_id: 'meals', account_name: 'Meals', location_id: 'hq', location_name: 'HQ', entity_type: null, entity_id: null, basis: 'posting' };
function harness({ rpcResult = { data: { adjustment_id: 'adj-1', reclass_id: 'r-1' }, error: null }, deleted = [{ id: 'adj-1' }],
  fromResult = { data: FROM, error: null } } = {}) {
  const body = new El('body');
  const document = { body, createElement: (tag) => new El(tag), createTextNode: (text) => ({ text }) };
  const calls = { rpc: [], composer: [], deletes: [], order: [] };
  const window = {
    SiloJE: { open: (opts) => { calls.composer.push(opts); calls.order.push('composer'); } },
  };
  const db = {
    rpc: async (name, params) => {
      calls.rpc.push({ name, params });
      if (name === 'card_transaction_reclass_from') return fromResult;
      if (name === 'reopen_journal_adjustment') return { data: null, error: null };
      return rpcResult;
    },
    from(table) {
      const filters = [];
      const query = {
        delete() { return query; }, eq(k, v) { filters.push([k, v]); return query; },
        select() { calls.deletes.push({ table, filters }); return Promise.resolve({ data: deleted, error: null }); },
      };
      return query;
    },
  };
  vm.runInNewContext(code, { window, document }, { filename: 'v2/transaction-reclass.js' });
  return { R: window.SiloReclass, body, calls, db };
}

const posted = { id: 'b1', status: 'posted', qbo_connection_id: 'c1' };
const txn = { id: 't1', batch_id: 'b1', status: 'coded', amount: 84.5, txn_date: '2026-08-12', description: 'DELTA', clean_merchant: 'Delta',
  qbo_account_id: 'meals', qbo_account_name: 'Meals', qbo_location_id: 'hq', origin: 'csv' };
const accounts = [{ id: 'meals', name: 'Meals', type: 'Expense', connectionId: 'c1' }, { id: 'travel', name: 'Travel', type: 'Expense', connectionId: 'c1' },
  { id: 'other', name: 'Other books', type: 'Expense', connectionId: 'c2' }];
const locations = [{ id: 'hq', name: 'HQ', connectionId: 'c1' }];
const entities = [{ id: 'v1', name: 'Delta', type: 'Vendor', connectionId: 'c1' }];

test('the button is offered only where the RPC would accept it', () => {
  const { R } = harness();
  assert.equal(R.blocker(txn, posted, []), null);
  assert.equal(R.blocker(txn, { ...posted, status: 'approved' }, []), 'not-posted');
  assert.match(R.blocker({ ...txn, status: 'uncoded' }, posted, []), /categorized/);
  assert.match(R.blocker({ ...txn, qbo_account_id: null }, posted, []), /split/);
  assert.match(R.blocker({ ...txn, amount: 0 }, posted, []), /zero/);
  assert.match(R.blocker({ ...txn, origin: 'plaid', accounting_treatment: 'transfer' }, posted, []), /purchase or refund/);
  assert.equal(R.blocker({ ...txn, origin: 'plaid', accounting_treatment: 'refund' }, posted, []), null);
  assert.match(R.blocker(txn, posted, [{ adjustment_status: 'approved' }]), /awaiting/);
  assert.equal(R.blocker(txn, posted, [{ adjustment_status: 'posted' }]), null, 'a posted reclass does not block the next');
});

test('the panel shows where the amount sits now and the right action for each state', () => {
  const { R } = harness();
  assert.equal(R.section(txn, { ...posted, status: 'approved' }, [], esc), '', 'nothing for an unposted period');
  assert.match(R.section(txn, posted, [], esc), /data-reclass>Reclassify/);
  const done = [{ adjustment_status: 'posted', adjustment_id: 'a0', from_qbo_account_name: 'Meals', to_qbo_account_name: 'Travel <x>', reason: 'r', entry_date: '2026-08-31', qbo_doc_number: '1042' }];
  const html = R.section(txn, posted, done, esc);
  assert.match(html, /In QuickBooks now: <b>Travel &lt;x&gt;<\/b>/, 'escaped');
  assert.match(html, /JE 1042/);
  const draft = R.section(txn, posted, [...done, { adjustment_status: 'draft', adjustment_id: 'a1', reason: 'r' }], esc);
  assert.match(draft, /data-reclass-review="a1">Review and post/);
  assert.match(draft, /data-reclass-discard="a1"/);
  assert.doesNotMatch(draft, /data-reclass>/, 'no second reclass beside an open one');
  const approved = R.section(txn, posted, [{ adjustment_status: 'approved', adjustment_id: 'a2', reason: 'r' }], esc);
  assert.match(approved, /Post approved reclass/);
  assert.match(approved, /data-reclass-reopen="a2"[^>]*>Reopen approval/, 'an approved, unposted reclass can go back to draft without posting');
  assert.doesNotMatch(approved, /data-reclass-discard/, 'an approved entry is not deleted directly');
  assert.doesNotMatch(draft, /data-reclass-reopen/);
  assert.match(R.section({ ...txn, status: 'uncoded' }, posted, [], esc), /data-reclass disabled title="Only a categorized/);
});

test('staging sends the chosen target and reason, refreshes, then opens the stored draft for review only', async () => {
  const { R, body, calls, db } = harness();
  let refreshed = 0;
  // The row itself has NO location; it posted on the source default (HQ).
  const done = R.open({ db, companyId: 'co', t: { ...txn, qbo_location_id: null }, batch: posted, list: [], accounts, locations, entities, connectionId: 'c1',
    onChanged: async () => { refreshed++; calls.order.push('refresh'); }, setStatus() {} });
  await settle();
  const dialog = body.children.at(-1);
  assert.match(dialog.children[1].textContent, /Currently Meals at HQ/);
  const [account, location, entity] = dialog.all('select');
  assert.deepEqual(account.children.map((o) => o.value), ['', 'meals', 'travel'], 'only the period\'s QuickBooks connection');
  assert.equal(location.value, 'hq', 'defaults to the location the original posting used, not the row\'s empty one');
  assert.equal(entity.value, '', 'no entity on the original line, none by default');
  const [date] = dialog.all('input'); const [reason] = dialog.all('textarea');
  account.value = 'travel'; entity.value = 'Vendor:v1'; reason.value = '  Flight, not a meal  ';
  await dialog.all('form')[0].fire('submit');
  await done; await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rpc)), [{ name: 'card_transaction_reclass_from', params: { p_transaction_id: 't1' } }, { name: 'stage_card_transaction_reclass', params: {
    p_transaction_id: 't1', p_to_account_id: 'travel', p_to_location_id: 'hq', p_to_entity_type: 'Vendor', p_to_entity_id: 'v1',
    p_entry_date: null, p_reason: 'Flight, not a meal' } }]);
  assert.equal(refreshed, 1);
  assert.deepEqual(calls.order, ['refresh', 'composer'], 'the panel knows about the draft before the composer opens');
  assert.equal(calls.composer[0].adjustmentId, 'adj-1');
  assert.equal(calls.composer[0].reviewOnly, true);
  assert.equal(dialog.removed, true);
  assert.equal(date.value, '', 'a blank date lets the server choose the original or first open day');
});

test('a refused stage keeps the dialog open with the reason and opens nothing', async () => {
  const { R, body, calls, db } = harness({ rpcResult: { data: null, error: { message: 'The books are locked through 2026-09-30' } } });
  R.open({ db, companyId: 'co', t: txn, batch: posted, list: [], accounts, locations, entities, connectionId: 'c1' });
  await settle();
  const dialog = body.children.at(-1);
  dialog.all('select')[0].value = 'travel'; dialog.all('textarea')[0].value = 'wrong';
  await dialog.all('form')[0].fire('submit');
  await settle();
  const status = dialog.all('div').find((d) => d.className?.includes('bcn-status'));
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /locked through/);
  assert.equal(dialog.open, true);
  assert.equal(calls.composer.length, 0);
});

test('nothing is sent without a category and a reason, or when cancelled', async () => {
  const { R, body, calls, db } = harness();
  const done = R.open({ db, companyId: 'co', t: txn, batch: posted, list: [], accounts, locations, entities, connectionId: 'c1' });
  await settle();
  const dialog = body.children.at(-1);
  await dialog.all('form')[0].fire('submit');
  dialog.all('select')[0].value = 'travel';
  await dialog.all('form')[0].fire('submit');
  assert.deepEqual(calls.rpc.map((c) => c.name), ['card_transaction_reclass_from'], 'nothing was staged');
  await dialog.all('button').find((b) => b.textContent === 'Cancel').fire('click');
  await done;
  assert.equal(calls.composer.length, 0);
});

test('a period whose original location is unknown is refused before any dialog opens', async () => {
  const { R, body, calls, db } = harness({ fromResult: { data: null, error: { message: 'the location it posted with is unknown' } } });
  await assert.rejects(R.open({ db, companyId: 'co', t: txn, batch: posted, list: [], accounts, locations, entities, connectionId: 'c1' }), /location it posted with is unknown/);
  assert.equal(body.children.length, 0, 'no dialog');
  assert.deepEqual(calls.rpc.map((c) => c.name), ['card_transaction_reclass_from']);
  assert.equal(calls.composer.length, 0);
});

test('reopen sends the approved reclass back to draft through the existing RPC, and nothing else', async () => {
  const { R, calls, db } = harness();
  await R.reopen({ db, adjustmentId: 'adj-9', reason: 'Deleted in QuickBooks' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rpc)), [{ name: 'reopen_journal_adjustment', params: { p_adjustment_id: 'adj-9', p_reason: 'Deleted in QuickBooks' } }]);
  assert.equal(calls.composer.length, 0, 'no composer, so no posting request');
});

test('discard deletes only a draft in the active company and reports a no-op', async () => {
  const ok = harness();
  await ok.R.discard({ db: ok.db, companyId: 'co', adjustmentId: 'adj-1' });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.deletes[0].filters)), [['id', 'adj-1'], ['company_entity_id', 'co'], ['status', 'draft']]);
  const none = harness({ deleted: [] });
  await assert.rejects(none.R.discard({ db: none.db, companyId: 'co', adjustmentId: 'adj-1' }), /Only a draft reclass/);
});

test('the page loads reclasses through every loader and routes reclass clicks before its read-only gate', () => {
  const loadSplits = page.slice(page.indexOf('async function loadSplits(rows) {'));
  assert.ok(loadSplits.slice(0, 400).includes('await loadReclasses(rows);'), 'loadSplits loads reclasses');
  const click = page.slice(page.indexOf('async function onTxnTableClick(e) {'));
  assert.match(click, /\[data-reclass\], \[data-reclass-review\], \[data-reclass-reopen\], \[data-reclass-discard\]/, 'reopen is routed too');
  const route = click.indexOf("await onReclassClick(e, t0); return;");
  const gate = click.indexOf('if (!requireEditable() || !rowEditable(t0)) return;');
  assert.ok(route > 0 && gate > 0 && route < gate, 'reclass routing precedes the editability gate');
  assert.match(page, /<script src="transaction-reclass\.js\?v=[0-9a-f]{12}"><\/script>/);
  assert.match(page, /\$\{reclassSection\(t\)\}`;/);
});
