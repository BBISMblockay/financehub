/* Confirming a card paydown match on the Transactions page.
 *
 * The feature these cover exists because the old one asked too much: you had
 * to suspect a row was a paydown, open it, press Find, then read a table. What
 * must hold now is that the page ASKS first and the person only confirms:
 *   - every paydown on screen is asked about in one call, and a row with two
 *     candidates of the same amount is offered no pick;
 *   - the offer appears above the table as well as in the row, because a
 *     paydown nobody opens is exactly the one that doubles;
 *   - confirming is offered only where it could succeed (an editable row with
 *     no unsaved edits), and a confirmed row goes to excluded with the payment
 *     named -- on the row AND in the page's own copy of the import;
 *   - the message says what happened to the PAYING side, which is the half a
 *     person cannot see from here.
 *
 * These run the SHIPPED inline script of v2/transactions.html against a stub
 * DOM, so they fail if the wiring is removed rather than only the helpers.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const page = await readFile(new URL('../../v2/transactions.html', import.meta.url), 'utf8');
const script = page.slice(page.indexOf('<script>\n(function') + '<script>'.length);
const BOOT = '  // --------------------------------------------------------------- boot';
assert.ok(script.includes(BOOT), 'the inline script must keep its boot marker for this harness');
const body = script.slice(0, script.indexOf(BOOT));
assert.ok(page.includes('id="codePaydowns"'), 'the offers strip must exist in the page for this harness');

const siblings = await Promise.all(['transaction-filters', 'transaction-dates', 'card-splits']
  .map((name) => readFile(new URL(`../../v2/${name}.js`, import.meta.url), 'utf8')));

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const EXPOSE = ['paymentMatchSection', 'renderPaydownOffers', 'confirmableRows', 'ensureProposals',
  'applyMatchToRow', 'proposalCache', 'proposalAsked', 'matchCache', 'reviewDateRows'].join(', ');

function harness({ rows = [], batch = null, sources = [], proposals = [], rpcError = null, linkResult = {} } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, disabled: false,
      value: '', listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null,
      querySelectorAll: () => [], addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      setAttribute() {}, insertAdjacentHTML() {}, append() {} });
    return nodes.get(id);
  };
  const calls = { rpc: [] };
  const db = {
    from() {
      const q = {};
      for (const m of ['select', 'gte', 'lte', 'order', 'limit', 'range', 'maybeSingle', 'update', 'insert', 'delete', 'eq', 'in']) q[m] = () => q;
      q.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return q;
    },
    rpc: (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'card_payment_match_proposals') return Promise.resolve({ data: proposals, error: rpcError });
      if (name === 'link_card_payment_match') return Promise.resolve({ data: linkResult, error: rpcError });
      return Promise.resolve({ data: 0, error: null });
    },
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
  };
  const window = {
    __SILO_CONFIG__: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'synthetic' },
    supabase: { createClient: () => db },
    SiloBankFeeds: { canEditBatch: (b) => !!b && ['draft', 'categorized'].includes(b.status), isAvailable: () => true,
      isBankPending: () => false, isRemovedByBank: () => false, wasPendingWhenRemoved: () => false,
      eligibleForAi: () => true, mount: () => ({}) },
    SiloCodingSuggestions: { ago: () => 'just now' },
    SiloReclass: { current: () => null, load: async () => new Map(), section: () => '' },
    SiloFinanceDialog: { ask: async () => false },
    SiloTransactionsTiles: { mount: () => ({}) },
    SiloChrome: { mount() {} },
    addEventListener() {}, location: { href: '', search: '' }, history: { replaceState() {} },
  };
  const document = { getElementById: node, querySelector: () => node('main'), querySelectorAll: () => [],
    createElement: () => node('created'), addEventListener() {}, body: node('body') };
  const sandbox = { window, document, console, setTimeout: () => 0, clearTimeout: () => {}, URL, URLSearchParams,
    Intl, Date, Map, Set, JSON, Number, String, Math, Object, Array, isNaN, parseFloat, parseInt, crypto: { randomUUID: () => 'id' } };
  for (const module of siblings) vm.runInNewContext(module, sandbox);
  if (!window.SiloTransactionDates?.read) window.SiloTransactionDates = { ...window.SiloTransactionDates, read: async () => [] };
  vm.runInNewContext(body + `
    _co = { id: 'co' };
    state.batch = ${JSON.stringify(batch)};
    state.batches = ${JSON.stringify(batch ? [batch] : [])};
    state.sources = ${JSON.stringify(sources)};
    state.txns = ${JSON.stringify(rows)};
    window.subject = { ${EXPOSE} };
  })();`, sandbox);
  return { api: sandbox.window.subject, node, calls, nodes };
}

const CARD = { id: 's1', source_type: 'card', display_name: 'Company card', posting_enabled: true, qbo_connection_id: 'c1' };
const BATCH = { id: 'b1', company_entity_id: 'co', source_id: 's1', source_name: 'Company card', label: '2026-10 card',
  status: 'draft', period_start: '2026-10-01', period_end: '2026-10-31', txn_count: 3, uncoded_count: 0,
  excluded_count: 0, coded_amount: 0, posting_status: null, source_posting_enabled: true };
const paydown = (over = {}) => ({ id: 'p1', batch_id: 'b1', txn_date: '2026-10-10', amount: -5412.01, status: 'coded',
  description: 'AUTOPAY PYMT', merchant: 'AUTOPAY PYMT', coding_source: 'manual', qbo_account_id: 'clearing',
  qbo_account_name: 'Clearing', origin: 'csv', ...over });
const offer = (over = {}) => ({ transaction_id: 'p1', candidate_count: 1, bank_transaction_id: 'bank-1',
  bank_txn_date: '2026-10-09', bank_amount: 5412.01, bank_source_name: 'Operating checking',
  bank_description: 'CARD AUTOPAY', ...over });

test('every paydown on screen is asked about in one call, and only paydowns', async () => {
  const rows = [paydown(), paydown({ id: 'p2', amount: -100 }), paydown({ id: 'spend', amount: 42.5 })];
  const h = harness({ rows, batch: BATCH, sources: [CARD], proposals: [offer()] });
  h.api.ensureProposals(rows);
  await settle();
  const asked = h.calls.rpc.filter((c) => c.name === 'card_payment_match_proposals');
  assert.equal(asked.length, 1, 'one call for the screen, not one per row');
  assert.deepEqual(asked[0].args.p_transaction_ids, ['p1', 'p2'],
    'money arriving on a card is a paydown; a purchase is not');

  h.api.ensureProposals(rows);
  await settle();
  assert.equal(h.calls.rpc.filter((c) => c.name === 'card_payment_match_proposals').length, 1,
    'and the answer is kept, so redrawing the table does not re-ask');
});

test('the row offers the payment to confirm, and offers no pick when there are two', () => {
  const h = harness({ rows: [paydown()], batch: BATCH, sources: [CARD], proposals: [offer()] });
  h.api.matchCache.set('p1', null);
  h.api.proposalCache.set('p1', offer());
  const html = h.api.paymentMatchSection(paydown());
  assert.match(html, /Looks like the payment/);
  assert.match(html, /Operating checking/);
  assert.match(html, /2026-10-09/);
  assert.match(html, /data-link-match="bank-1"/, 'confirming is one press, with the payment already chosen');
  assert.match(html, /Pick a different payment/, 'and the old search is still there when the offer is wrong');

  h.api.proposalCache.set('p1', offer({ candidate_count: 2, bank_transaction_id: null }));
  const two = h.api.paymentMatchSection(paydown());
  assert.doesNotMatch(two, /data-link-match/, 'two payments of the same amount is a judgement, not an offer');
  assert.match(two, /2 bank payments/);
});

test('the strip above the table counts what can be confirmed, and separates what cannot', () => {
  const rows = [paydown(), paydown({ id: 'p2', amount: -100 }), paydown({ id: 'p3', amount: -7 })];
  const h = harness({ rows, batch: BATCH, sources: [CARD] });
  for (const id of ['p1', 'p2', 'p3']) h.api.matchCache.set(id, null);
  h.api.proposalCache.set('p1', offer());
  h.api.proposalCache.set('p2', offer({ transaction_id: 'p2' }));
  h.api.proposalCache.set('p3', offer({ transaction_id: 'p3', candidate_count: 3, bank_transaction_id: null }));
  h.api.renderPaydownOffers(rows);
  const strip = h.node('codePaydowns');
  assert.equal(strip.hidden, false);
  assert.match(strip.innerHTML, /2 paydowns match a bank payment/);
  assert.match(strip.innerHTML, /Confirm all 2/);
  assert.match(strip.innerHTML, /1 other paydown has more than one payment/);
  assert.match(strip.innerHTML, /codes the payment on the bank side/,
    'the strip must say the paying side gets coded, because that half is not visible from here');

  h.api.proposalCache.clear();
  h.api.renderPaydownOffers(rows);
  assert.equal(h.node('codePaydowns').hidden, true, 'nothing to confirm says nothing at all');
});

test('a frozen import offers no confirm, however the proposal reads', () => {
  const frozen = { ...BATCH, status: 'approved' };
  const rows = [paydown()];
  const h = harness({ rows, batch: frozen, sources: [CARD] });
  h.api.matchCache.set('p1', null);
  h.api.proposalCache.set('p1', offer());
  assert.deepEqual(h.api.confirmableRows(rows), [],
    'an approved import is frozen, and the RPC would refuse it anyway');
  h.api.renderPaydownOffers(rows);
  assert.doesNotMatch(h.node('codePaydowns').innerHTML, /Confirm/);
});

test('a confirmed match lands on the row and on the page’s copy of the import', () => {
  const row = paydown();
  const h = harness({ rows: [row], batch: BATCH, sources: [CARD] });
  h.api.proposalCache.set('p1', offer());
  h.api.applyMatchToRow(row, { exclude_reason: 'Paid by Operating checking on 2026-10-09 — matched to the bank feed, which posts this payment',
    bank_transaction_id: 'bank-1', bank_coded: true });
  assert.equal(row.status, 'excluded');
  assert.match(row.exclude_reason, /Operating checking/);
  assert.equal(h.api.matchCache.get('p1').bank_transaction_id, 'bank-1');
  assert.equal(h.api.proposalCache.has('p1'), false, 'a settled row is no longer offered');
  assert.equal(h.api.confirmableRows([row]).length, 0);
});
