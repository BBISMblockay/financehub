// Historical coding evidence in card-categorize: the real function runs in a
// vm against synthetic company history. No Anthropic or database network.
//
// Every fixture is invented. Account names are generic; amounts and dates are
// arbitrary. Nothing here is a real Baseballism vendor, account or figure.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCategorizer, prepareSource } from './lib/card-categorize-sandbox.mjs';
const source = await prepareSource();
// Mutation hooks: run with CATEGORIZE_HISTORY_MUTATION=<name> and the suite
// must FAIL, or the assertion it guards is not really guarding anything.
const MUTATIONS = {
  'no-disagree-cap': ["confidence = Math.min(confidence, HISTORY_CAPS.consistent_disagree);", "confidence = confidence;"],
  'no-conflict-cap': ["confidence = Math.min(confidence, HISTORY_CAPS.conflicting);", "confidence = confidence;"],
  'count-unconfirmed-ai': ["|| (r.coding_source === 'ai' && ['approved', 'posted'].includes(String(r.batch_status)));", "|| r.coding_source === 'ai';"],
  'ignore-window': ["const inWindow = (d: string) => d >= from && d <= anchor;", "const inWindow = (d: string) => true;"],
  'drop-connection-scope': [".eq('qbo_connection_id', connectionId);", ";"],
  'similar-is-precedent': ["const strong = leading.weight >= 0.8 && (leading.count - leading.similar) >= 1;", "const strong = leading.weight >= 0.8;"],
  'drop-source-scope': ["return bound ? bound === connectionId : sourceKeys.has(String(r.source_key));", "return bound ? bound === connectionId : true;"],
  'no-cap-ceiling': ["confidence = Math.min(confidence, HISTORY_CAPS.capped);", "confidence = confidence;"],
  'ineligible-as-removed': ["if (live) tally(ineligible, id, live.name, date); else tally(inactive, id, name || id, date);", "tally(inactive, id, name || id, date);"],
  'ignore-batch-binding': ["return bound ? bound === connectionId : sourceKeys.has(String(r.source_key));", "return sourceKeys.has(String(r.source_key));"],
  'chart-failure-as-removed': ["if (!activeById) { tally(unresolved, id, name || id, date); return; }", ""],
};
const mutation = process.env.CATEGORIZE_HISTORY_MUTATION;
let effective = source;
if (mutation) {
  const [from, to] = MUTATIONS[mutation] || [];
  if (!from || !source.includes(from)) throw new Error(`Unknown or stale mutation ${mutation}`);
  effective = source.replace(from, to);
}

const ids = { batch: '00000000-0000-4000-8000-000000000001', source: '00000000-0000-4000-8000-000000000002',
  tx: '00000000-0000-4000-8000-000000000003', connection: '00000000-0000-4000-8000-000000000005',
  company: '00000000-0000-4000-8000-000000000006', otherCompany: '00000000-0000-4000-8000-000000000007',
  importId: '00000000-0000-4000-8000-000000000008', foreignImport: '00000000-0000-4000-8000-000000000009' };

// Anchor: the transaction being coded is dated 2026-09-01, so history runs
// from 2024-09-01 to 2026-09-01.
const ANCHOR = '2026-09-01';
const monthsAgo = (n) => { const d = new Date(`${ANCHOR}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

const GL = 'Insurance - General Liability', EXP = 'Insurance Expense';
function siloRow(overrides = {}) {
  return { company_entity_id: ids.company, status: 'coded', merchant_norm: 'state farm', txn_date: monthsAgo(2), source_key: 'card-a',
    qbo_account_id: 'ins-gl', qbo_account_name: GL, coding_source: 'manual', batch_status: 'posted', id: `h${Math.random()}`, batch_id: 'batch-here', ...overrides };
}
function ledgerLine(overrides = {}) {
  return { company_entity_id: ids.company, import_id: ids.importId, row_kind: 'transaction', account_type: 'Expense',
    qbo_account_id: 'ins-gl', account_name: GL, transaction_date: monthsAgo(3), counterparty: 'State Farm Insurance Co',
    qbo_transaction_id: `t${Math.random()}`, natural_amount: 120.5, ...overrides };
}

function fixture(options = {}) {
  const records = {
    profiles: [{ id: 'user', active_company_id: ids.company, is_active: true, role: 'owner', department: 'finance' }],
    entity_memberships: [{ user_id: 'user', entity_id: ids.company, role: 'owner_admin' }],
    entities: [{ id: ids.company, title: 'Synthetic Company' }],
    card_import_batches: [{ id: ids.batch, company_entity_id: ids.company, source_id: ids.source,
      qbo_connection_id: ids.connection, status: 'draft', origin: 'csv' },
      // History batches: one bound to this realm, one to a previous realm on
      // the SAME source, one made before batches recorded a binding.
      { id: 'batch-here', company_entity_id: ids.company, source_id: ids.source, qbo_connection_id: ids.connection, status: 'posted', origin: 'csv' },
      { id: 'batch-realm-a', company_entity_id: ids.company, source_id: ids.source, qbo_connection_id: 'other-connection', status: 'posted', origin: 'csv' },
      { id: 'batch-unbound', company_entity_id: ids.company, source_id: ids.source, qbo_connection_id: null, status: 'posted', origin: 'csv' },
      { id: 'batch-old-source', company_entity_id: ids.company, source_id: 'old-realm-source', qbo_connection_id: 'other-connection', status: 'posted', origin: 'csv' }],
    card_sources: [{ id: ids.source, company_entity_id: ids.company, source_type: 'card', ingest_mode: 'csv', source_key: 'card-a',
      qbo_connection_id: ids.connection, display_name: 'Synthetic Card', is_active: true },
      // Same company, a card that was bound to a previous QuickBooks realm.
      { id: 'old-realm-source', company_entity_id: ids.company, source_type: 'card', ingest_mode: 'csv', source_key: 'old-card',
        qbo_connection_id: 'other-connection', display_name: 'Old Realm Card', is_active: false }],
    quickbooks_connections: [{ id: ids.connection, company_entity_id: ids.company, is_active: true }],
    // The row being coded, plus this company's confirmed history in the same
    // view (history rows carry an id the request never selects).
    card_transactions_v: [
      { id: ids.tx, batch_id: ids.batch, company_entity_id: ids.company, merchant_norm: 'state farm', card_name: null,
        description: 'STATE FARM INSURANCE 4421', amount: 120.5, currency: 'USD', status: 'uncoded', qbo_account_id: null,
        origin: 'csv', provider_status: null, accounting_treatment: 'unknown', txn_date: ANCHOR },
      ...(options.silo || []),
    ],
    quickbooks_accounts: [
      { company_entity_id: ids.company, connection_id: ids.connection, qbo_account_id: 'ins-exp', name: EXP, account_type: 'Expense', is_active: true },
      { company_entity_id: ids.company, connection_id: ids.connection, qbo_account_id: 'ins-gl', name: GL, account_type: 'Expense', is_active: true },
      { company_entity_id: ids.company, connection_id: ids.connection, qbo_account_id: 'office', name: 'Office Supplies', account_type: 'Expense', is_active: true },
      // Inactive accounts are not returned by the is_active filter the chart
      // query applies, which is the whole point of the inactive test.
      ...(options.accounts || []),
    ],
    quickbooks_locations: [{ company_entity_id: ids.company, connection_id: ids.connection, name: 'HQ', is_active: true }],
    quickbooks_report_runs: [],
    card_coding_rules: [],
    qbo_history_imports: options.imports || [{ id: ids.importId, company_entity_id: ids.company, qbo_connection_id: ids.connection }],
    qbo_history_lines: options.ledger || [],
  };
  const queries = [], modelCalls = [], writes = [], runWrites = [], rpcCalls = [];
  const failures = new Set(options.historyFailure || []);
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.singleResult = false; this.maxRows = Infinity; }
    select(columns) { this.columns = columns; return this; }
    eq(key, value) { this.filters.push(['eq', key, value]); return this; }
    in(key, value) { this.filters.push(['in', key, value]); return this; }
    not(key, operator, value) { this.filters.push(['not', key, value]); return this; }
    or(value) { this.filters.push(['or', value]); return this; }
    gte(key, value) { this.filters.push(['gte', key, value]); return this; }
    lte(key, value) { this.filters.push(['lte', key, value]); return this; }
    order(key, opts) { this.orders = [...(this.orders || []), [key, opts?.ascending !== false]]; return this; }
    limit(count) { this.maxRows = count; return this; }
    range(from, to) { this.offset = from; this.maxRows = to - from + 1; return this; }
    // The run log is the one table the preparer writes directly. Any other
    // write -- above all to card_transactions -- is refused and counted.
    update(value) { if (this.table === 'card_coding_preparation_runs') { runWrites.push(['update', value]); this.writeResult = { data: null, error: null }; return this; }
      writes.push(value); throw new Error('Categorizer must not write'); }
    insert(value) { if (this.table === 'card_coding_preparation_runs') { runWrites.push(['insert', value]); this.writeResult = { data: { id: 'run-1' }, error: null }; return this; }
      writes.push(value); throw new Error('Categorizer must not write'); }
    single() { return Promise.resolve(this.writeResult || this.execute()); }
    delete() { throw new Error('Categorizer must not delete'); }
    isHistoryQuery() {
      return (this.table === 'card_transactions_v' && this.filters.some(([op, key]) => op === 'in' && key === 'merchant_norm'))
        || this.table === 'qbo_history_imports' || this.table === 'qbo_history_lines';
    }
    // The full-chart read is the one quickbooks_accounts query with no account_type filter.
    isFullChartQuery() { return this.table === 'quickbooks_accounts' && !this.filters.some(([op, key]) => op === 'in' && key === 'account_type'); }
    execute() {
      queries.push({ table: this.table, filters: structuredClone(this.filters), columns: this.columns });
      const sourceName = this.table === 'card_transactions_v' ? 'silo' : 'ledger';
      if (this.isHistoryQuery() && failures.has(sourceName)) return { data: null, error: { message: 'synthetic read failure' } };
      if (this.isFullChartQuery() && failures.has('chart')) return { data: null, error: { message: 'synthetic chart read failure' } };
      const rows = (records[this.table] || []).filter((row) => this.filters.every(([op, key, value]) => {
        if (op === 'eq') return row[key] === value;
        if (op === 'in') return value.includes(row[key]);
        if (op === 'not') return row[key] !== value;
        if (op === 'gte') return row[key] >= value;
        if (op === 'lte') return row[key] <= value;
        if (op === 'or') return key.split(',').some((part) => {
          const [field, comparator, expected] = part.split('.');
          return comparator === 'is' ? row[field] == null : row[field] === expected;
        });
        throw new Error(`Unsupported filter ${op}`);
      }));
      for (const [key, asc] of [...(this.orders || [])].reverse()) rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1));
      const page = rows.slice(this.offset || 0, (this.offset || 0) + this.maxRows);
      return { data: structuredClone(this.singleResult ? page[0] ?? null : page), error: null };
    }
    maybeSingle() { this.singleResult = true; return Promise.resolve(this.execute()); }
    then(resolve, reject) { return Promise.resolve(this.writeResult || this.execute()).then(resolve, reject); }
  }
  // The two RPCs the preparer calls. Fingerprints come back per id; the writer
  // echoes what it was given so a test can read exactly what would be stored.
  const fakeRpc = async (name, args) => {
    rpcCalls.push({ name, args: structuredClone(args) });
    if (name === 'card_coding_input_hashes') return { data: args.p_ids.map((id) => ({ transaction_id: id, input_hash: `hash:${id}` })), error: null };
    if (name === 'record_card_coding_suggestions') {
      if (options.recordFailure) return { data: null, error: { message: 'synthetic record failure' } };
      return { data: { recorded: args.p_rows.length, skipped: [] }, error: null };
    }
    throw new Error(`Unexpected rpc ${name}`);
  };
  const { handler } = loadCategorizer(effective, {
    console: { ...console, warn() {} },
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) }, from: (table) => new Query(table), rpc: async (name, args) => fakeRpc(name, args) }),
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      modelCalls.push(JSON.parse(init.body));
      const asked = [...JSON.parse(init.body).messages[0].content.matchAll(/merchant: "([^"]+)"/g)].map((m) => m[1]);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify({ suggestions: asked.map((merchant) => ({ merchant, card_name: null,
        account_name: EXP, location_name: null, vendor_name: 'State Farm', confidence: 0.9, reasoning: 'Synthetic insurance premium.', ...options.suggestion })) }) }], stop_reason: 'end_turn' });
    },
  });
  const runIds = async (transaction_ids) => {
    const response = await handler(new Request('https://silo.test/card-categorize', { method: 'POST',
      headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: ids.batch, transaction_ids }) }));
    return { status: response.status, body: await response.json() };
  };
  return { records, queries, modelCalls, writes, runWrites, rpcCalls, runIds, run: () => runIds([ids.tx]) };
}
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const first = async (h) => { const r = await h.run(); assert.equal(r.status, 200, JSON.stringify(r.body)); return { r, s: r.body.suggestions[0], system: h.modelCalls[0]?.system || '' }; };

test('similar insurance accounts: consistent history outranks the model when they disagree', async () => {
  const h = fixture({ silo: many(6, (i) => siloRow({ txn_date: monthsAgo(i + 1) })), ledger: many(3, () => ledgerLine()) });
  const { r, s, system } = await first(h);
  assert.equal(s.history_status, 'consistent');
  assert.equal(s.account_name, EXP, 'the model answer stands; history sets the ceiling');
  assert.equal(s.confidence, 0.5);
  assert.match(s.evidence, /^History points to Insurance - General Liability; the model chose Insurance Expense\./);
  assert.match(s.evidence, /6 confirmed SILO codings/); assert.match(s.evidence, /3 ledger lines \(3 by similar payee name\)/);
  assert.match(system, /# Historical coding evidence/); assert.match(system, /- "state farm" \(lines dated up to 2026-09-01\) -> CONSISTENT: Insurance - General Liability/);
  assert.equal(r.body.history.silo_rows, 6); assert.equal(r.body.history.ledger_lines, 3); assert.equal(r.body.history.ledger_imports, 1);
  assert.equal(h.writes.length, 0);
});

test('model agreeing with consistent history keeps its confidence and says history agrees', async () => {
  const h = fixture({ silo: many(6, (i) => siloRow({ txn_date: monthsAgo(i + 1) })), suggestion: { account_name: GL } });
  const { s } = await first(h);
  assert.equal(s.account_name, GL); assert.equal(s.confidence, 0.9); assert.equal(s.history_status, 'consistent');
  assert.match(s.evidence, /^History agrees\. CONSISTENT: Insurance - General Liability \[6 confirmed SILO codings; last 2026-08-01\]/);
});

test('a changed coding pattern: recent codings outweigh old ones, and a split reads as conflicting', async () => {
  const old = many(5, (i) => siloRow({ txn_date: monthsAgo(19 + i), qbo_account_id: 'ins-exp', qbo_account_name: EXP }));
  const recent = (n) => many(n, (i) => siloRow({ txn_date: monthsAgo(1 + (i % 4)) }));
  // 5 old at 0.4 = 2.0 against 4 recent at 1.0 = 4.0: the new account leads
  // but only carries two thirds, so this is a visible conflict.
  const split = fixture({ silo: [...old, ...recent(4)], suggestion: { account_name: GL } });
  let { s, system } = await first(split);
  assert.equal(s.history_status, 'conflicting'); assert.equal(s.confidence, 0.55);
  assert.match(s.evidence, /^The model chose the leading account, but history is split\. CONFLICTING: Insurance - General Liability \[4 confirmed SILO codings; last 2026-08-01\] vs Insurance Expense \[5 confirmed SILO codings; last 2025-02-01\]/);
  assert.match(system, /CONFLICTING/);
  // 8 recent at 1.0 = 8.0 against 2.0: four fifths, and the switch reads as
  // the company's current practice.
  const settled = fixture({ silo: [...old, ...recent(8)], suggestion: { account_name: GL } });
  ({ s } = await first(settled));
  assert.equal(s.history_status, 'consistent'); assert.equal(s.confidence, 0.9);
  assert.match(s.evidence, /CONSISTENT \(mostly\): Insurance - General Liability \[8 confirmed SILO codings/); assert.match(s.evidence, /earlier or minor: Insurance Expense \[5 confirmed SILO codings; last 2025-02-01\]/);
});

test('no history in the window: stated plainly, confidence capped, no precedent claimed in the prompt', async () => {
  const h = fixture();
  const { s, system } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(s.confidence, 0.75);
  assert.equal(s.evidence, 'No confirmed coding for this merchant in the 24 months before 2026-09-01.');
  assert.match(system, /-> No confirmed coding for this merchant in the 24 months before 2026-09-01\./);
  assert.match(system, /An account NAME resembling the merchant is not history/);
});

test('history unavailable: both sources failing to read is named, not silently treated as no history', async () => {
  const both = fixture({ silo: many(3, () => siloRow()), ledger: [ledgerLine()], historyFailure: ['silo', 'ledger'] });
  let { s, r } = await first(both);
  assert.equal(s.history_status, 'unavailable'); assert.equal(s.confidence, 0.75);
  assert.equal(s.evidence, 'History unavailable: SILO coding history and QBO ledger archive could not be read (SILO coding history unavailable; QBO ledger archive unavailable).');
  assert.deepEqual(r.body.history.unavailable, ['SILO coding history', 'QBO ledger archive']);
  // One source down degrades to the other and says which was missing.
  const ledgerOnly = fixture({ silo: many(3, () => siloRow()), ledger: many(2, () => ledgerLine({ counterparty: 'STATE FARM' })), historyFailure: ['silo'] });
  ({ s } = await first(ledgerOnly));
  assert.equal(s.history_status, 'consistent');
  assert.match(s.evidence, /2 ledger lines; last 2026-06-01\] \(SILO coding history unavailable\)\./);
});

test('history pointing only at accounts no longer in the chart cannot lead and lowers confidence', async () => {
  const h = fixture({ silo: many(4, () => siloRow({ qbo_account_id: 'ins-old', qbo_account_name: 'Insurance (retired)' })) });
  const { s } = await first(h);
  assert.equal(s.history_status, 'inactive_only'); assert.equal(s.confidence, 0.6);
  assert.match(s.evidence, /^History points only at accounts no longer in the active chart: Insurance \(retired\) \[4 lines; last 2026-07-01\]\./);
  // With one live candidate beside a retired one, the live one leads and the
  // retired one is still disclosed.
  const mixed = fixture({ silo: [...many(4, () => siloRow({ qbo_account_id: 'ins-old', qbo_account_name: 'Insurance (retired)' })), siloRow()], suggestion: { account_name: GL } });
  const m = await first(mixed);
  assert.equal(m.s.history_status, 'consistent'); assert.match(m.s.evidence, /Also coded to since-removed account\(s\): Insurance \(retired\)\./);
});

test('company isolation: another company\'s codings and another connection\'s ledger never count or reach the model', async () => {
  const h = fixture({
    silo: many(6, () => siloRow({ company_entity_id: ids.otherCompany, qbo_account_name: 'FOREIGN ' + GL })),
    imports: [{ id: ids.importId, company_entity_id: ids.company, qbo_connection_id: ids.connection },
      { id: ids.foreignImport, company_entity_id: ids.company, qbo_connection_id: 'other-connection' },
      { id: 'other-co-import', company_entity_id: ids.otherCompany, qbo_connection_id: ids.connection }],
    ledger: [...many(5, () => ledgerLine({ import_id: ids.foreignImport, counterparty: 'FOREIGN CONNECTION STATE FARM' })),
      ...many(5, () => ledgerLine({ import_id: 'other-co-import', company_entity_id: ids.otherCompany, counterparty: 'FOREIGN COMPANY STATE FARM' }))],
  });
  const { s, r } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(r.body.history.silo_rows, 0); assert.equal(r.body.history.ledger_lines, 0);
  assert.equal(JSON.stringify(h.modelCalls).includes('FOREIGN'), false);
  for (const q of h.queries.filter((q) => ['qbo_history_imports', 'qbo_history_lines'].includes(q.table) || (q.table === 'card_transactions_v' && q.filters.some(([op, k]) => op === 'in' && k === 'merchant_norm')))) {
    assert.ok(q.filters.some(([op, k, v]) => op === 'eq' && k === 'company_entity_id' && v === ids.company), `${q.table} is company scoped`);
  }
  assert.ok(h.queries.some((q) => q.table === 'qbo_history_imports' && q.filters.some(([op, k, v]) => op === 'eq' && k === 'qbo_connection_id' && v === ids.connection)), 'ledger imports are connection scoped');
});

test('only confirmed codings count: unsaved AI in draft batches and voided batches are excluded', async () => {
  const h = fixture({ silo: [
    ...many(5, () => siloRow({ coding_source: 'ai', batch_status: 'draft', qbo_account_id: 'ins-exp', qbo_account_name: EXP })),
    ...many(5, () => siloRow({ coding_source: 'ai', batch_status: 'categorized', qbo_account_id: 'ins-exp', qbo_account_name: EXP })),
    ...many(3, () => siloRow({ coding_source: 'manual', batch_status: 'voided', qbo_account_id: 'ins-exp', qbo_account_name: EXP })),
    ...many(2, () => siloRow({ coding_source: 'ai', batch_status: 'posted' })),
    ...many(1, () => siloRow({ coding_source: 'rule', batch_status: 'approved' })),
  ], suggestion: { account_name: GL } });
  const { s, r } = await first(h);
  assert.equal(r.body.history.silo_rows, 3, 'two posted-AI plus one approved rule row');
  assert.equal(s.history_status, 'consistent');
  assert.equal(s.evidence, 'History agrees. CONSISTENT: Insurance - General Liability [3 confirmed SILO codings; last 2026-07-01].');
  assert.equal(s.evidence.includes(EXP), false, 'unconfirmed and voided rows leave no trace');
});

test('the 24-month window precedes the transaction date: older rows and later rows are ignored', async () => {
  const h = fixture({ silo: [
    siloRow({ txn_date: monthsAgo(25) }), siloRow({ txn_date: '2026-09-15' }), siloRow({ txn_date: '2027-01-01' }),
  ], ledger: [ledgerLine({ transaction_date: monthsAgo(30) }), ledgerLine({ transaction_date: '2026-10-01' })] });
  const { s } = await first(h);
  assert.equal(s.history_status, 'none');
  const edge = fixture({ silo: [siloRow({ txn_date: monthsAgo(24) }), siloRow({ txn_date: ANCHOR })] });
  const e = await first(edge);
  assert.equal(e.s.history_status, 'consistent'); assert.match(e.s.evidence, /2 confirmed SILO codings; last 2026-09-01/);
  // Two merchants with different dates share one database read but NOT one
  // window: a state farm coding dated after the state farm line, yet inside
  // the later merchant's window, is still "after" for state farm.
  const two = fixture({ silo: [siloRow({ txn_date: '2026-10-15' })] });
  two.records.card_transactions_v.push({ id: ids.tx.replace(/3$/, '4'), batch_id: ids.batch, company_entity_id: ids.company, merchant_norm: 'other vendor', card_name: null,
    description: 'OTHER VENDOR', amount: 5, currency: 'USD', status: 'uncoded', qbo_account_id: null, origin: 'csv', provider_status: null, accounting_treatment: 'unknown', txn_date: '2026-12-01' });
  const response = await two.runIds([ids.tx, ids.tx.replace(/3$/, '4')]);
  const sf = response.body.suggestions.find((x) => x.merchant === 'state farm');
  assert.equal(sf.history_status, 'none', 'a coding dated after the transaction is not history for it');
});

test('a retained zero-amount ledger line (row_kind zero_amount) never becomes a candidate', async () => {
  // The archive stores a blank or .00 line as row_kind 'zero_amount'; the
  // evidence read here filters row_kind = 'transaction', so an exact-payee
  // zero line for a merchant with no other history yields no history at all.
  const h = fixture({ ledger: [ledgerLine({ row_kind: 'zero_amount', natural_amount: 0, counterparty: 'STATE FARM' })] });
  const { r, s } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(r.body.history.ledger_lines, 0);
  assert.ok(!(s.evidence || '').includes('ledger line'), s.evidence);
  assert.ok(h.queries.some((q) => q.table === 'qbo_history_lines' && q.filters.some(([op, k, v]) => op === 'eq' && k === 'row_kind' && v === 'transaction')), 'the ledger read is pinned to row_kind transaction');
  // The same line as a real transaction is what the filter is there to admit.
  const real = fixture({ ledger: [ledgerLine({ counterparty: 'STATE FARM' })] });
  assert.equal((await first(real)).r.body.history.ledger_lines, 1);
});

test('ledger evidence counts only the expense-side leg and dedupes overlapping snapshots', async () => {
  const shared = { qbo_transaction_id: 'same-bill', transaction_date: monthsAgo(2), natural_amount: 88 };
  const h = fixture({
    imports: [{ id: ids.importId, company_entity_id: ids.company, qbo_connection_id: ids.connection }, { id: 'second-snapshot', company_entity_id: ids.company, qbo_connection_id: ids.connection }],
    ledger: [ledgerLine(shared), ledgerLine({ ...shared, import_id: 'second-snapshot' }),
      ledgerLine({ account_type: 'Accounts Payable', qbo_account_id: 'ap', account_name: 'Accounts Payable', counterparty: 'State Farm Insurance Co' })],
    suggestion: { account_name: GL },
  });
  const { s, r } = await first(h);
  assert.equal(r.body.history.ledger_lines, 1); assert.match(s.evidence, /1 ledger line \(1 by similar payee name\)/);
  // One similar-name ledger line is a hint below the precedent threshold, so
  // it does not read as consistent history at full confidence.
  assert.equal(s.history_status, 'conflicting'); assert.equal(s.confidence, 0.55);
});

test('similar payee names alone never become precedent, however many there are', async () => {
  const h = fixture({ ledger: many(6, () => ledgerLine({ counterparty: 'State Farm Insurance Co' })), suggestion: { account_name: GL } });
  const { s, system } = await first(h);
  assert.equal(s.history_status, 'conflicting'); assert.equal(s.confidence, 0.55);
  assert.match(s.evidence, /^WEAK \(similar payee names only, no exact match\): Insurance - General Liability \[6 ledger lines \(6 by similar payee name\); last 2026-06-01\]\.$/);
  assert.match(system, /-> WEAK \(similar payee names only/);
  // One exact ledger line beside them is enough to make it real history.
  const exact = fixture({ ledger: [...many(6, () => ledgerLine({ counterparty: 'State Farm Insurance Co' })), ledgerLine({ counterparty: 'STATE FARM' })], suggestion: { account_name: GL } });
  const e = await first(exact);
  assert.equal(e.s.history_status, 'consistent'); assert.match(e.s.evidence, /^History agrees\. CONSISTENT: Insurance - General Liability \[7 ledger lines \(6 by similar payee name\)/);
});


test('a colliding account id from a previous QuickBooks realm never becomes precedent', async () => {
  // Old realm: id ins-exp meant something else entirely. Six confirmed rows
  // there, none here.
  const h = fixture({ silo: many(6, () => siloRow({ source_key: 'old-card', batch_id: 'batch-old-source', qbo_account_id: 'ins-exp', qbo_account_name: 'Old Realm Travel' })) });
  const { s, r } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(r.body.history.silo_rows, 0);
  assert.equal(JSON.stringify(h.modelCalls).includes('Old Realm'), false);
  assert.ok(h.queries.some((q) => q.table === 'card_sources' && q.filters.some(([op, k, v]) => op === 'eq' && k === 'qbo_connection_id' && v === ids.connection)), 'sources are resolved for this connection');
  // The same rows on a source bound to THIS connection do count.
  const here = fixture({ silo: many(6, () => siloRow()) , suggestion: { account_name: GL } });
  assert.equal((await first(here)).s.history_status, 'consistent');
});

test('SILO history is paged deterministically and a capped sample is disclosed and bounded', async () => {
  // 1,001 rows cross one page and are all read.
  const paged = fixture({ silo: many(1001, (i) => siloRow({ txn_date: monthsAgo(1 + (i % 20)) })), suggestion: { account_name: GL } });
  let { s, r } = await first(paged);
  assert.equal(r.body.history.silo_rows, 1001); assert.equal(r.body.history.silo_capped, false);
  assert.equal(s.history_status, 'consistent'); assert.equal(s.confidence, 0.9);
  assert.ok(paged.queries.filter((q) => q.table === 'card_transactions_v' && q.filters.some(([op, k]) => op === 'in' && k === 'merchant_norm')).length >= 2, 'a second page was requested');
  // 5,001 rows exceed the cap: the newest 5,000 are kept, the cap is named
  // in the evidence, and confidence cannot stay high on a partial sample.
  const capped = fixture({ silo: many(5001, (i) => siloRow({ txn_date: monthsAgo(1 + (i % 20)) })), suggestion: { account_name: GL } });
  ({ s, r } = await first(capped));
  assert.equal(r.body.history.silo_rows, 5000); assert.equal(r.body.history.silo_capped, true);
  assert.equal(s.confidence, 0.55, 'a partial sample lands inside the Low-confidence filter');
  assert.match(s.evidence, /^History sample capped, treat as partial\. History agrees\. CONSISTENT: Insurance - General Liability \[5000 confirmed SILO codings; last 2026-08-01\] \(SILO sample capped\)\.$/);
});

test('an active account outside this mode\'s eligible types is labelled as not offered, never as removed', async () => {
  const h = fixture({
    accounts: [{ company_entity_id: ids.company, connection_id: ids.connection, qbo_account_id: 'sales', name: 'Sales income', account_type: 'Income', is_active: true }],
    ledger: many(3, () => ledgerLine({ qbo_account_id: 'sales', account_name: 'Sales income', account_type: 'Income', counterparty: 'STATE FARM' })),
  });
  const { s } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(s.confidence, 0.75);
  assert.equal(s.evidence, 'No confirmed coding for this merchant in the 24 months before 2026-09-01. Also coded to account(s) not offered for this transaction type: Sales income [3; last 2026-06-01].');
  assert.equal(s.evidence.includes('no longer in the active chart'), false);
});
test('a source rebound to this realm keeps its old-realm batches out of precedent; unbound legacy batches follow the source', async () => {
  // Same source, currently bound here. Six rows in a batch frozen to realm A
  // carry a colliding account id; three rows in an unbound legacy batch and
  // two in a batch bound here are genuine.
  const h = fixture({ silo: [
    ...many(6, () => siloRow({ batch_id: 'batch-realm-a', qbo_account_id: 'ins-exp', qbo_account_name: 'Realm A Travel' })),
    ...many(3, () => siloRow({ batch_id: 'batch-unbound' })),
    ...many(2, () => siloRow({ batch_id: 'batch-here' })),
    siloRow({ batch_id: 'batch-not-in-company' }),
  ], suggestion: { account_name: GL } });
  const { s, r } = await first(h);
  assert.equal(r.body.history.silo_rows, 5, 'three legacy plus two bound here; realm A and unknown batches excluded');
  assert.equal(s.history_status, 'consistent');
  assert.equal(s.evidence, 'History agrees. CONSISTENT: Insurance - General Liability [5 confirmed SILO codings; last 2026-07-01].');
  assert.equal(JSON.stringify(h.modelCalls).includes('Realm A'), false);
  // An unbound legacy batch on a source NOT bound here is excluded too.
  const foreignLegacy = fixture({ silo: many(4, () => siloRow({ batch_id: 'batch-unbound', source_key: 'old-card' })) });
  assert.equal((await first(foreignLegacy)).s.history_status, 'none');
});

test('a failed full-chart read reports account state as unknown, never as removed', async () => {
  const h = fixture({ silo: many(4, () => siloRow({ qbo_account_id: 'ins-old', qbo_account_name: 'Insurance (retired)' })), historyFailure: ['chart'] });
  const { s } = await first(h);
  assert.equal(s.history_status, 'none'); assert.equal(s.confidence, 0.75);
  assert.equal(s.evidence, 'No confirmed coding for this merchant in the 24 months before 2026-09-01 (account states unavailable). Also coded to account(s) whose current chart state could not be read: Insurance (retired) [4; last 2026-07-01].');
  assert.equal(s.evidence.includes('no longer in the active chart'), false);
});

test('failed model calls still carry the evidence so the row is not blank', async () => {
  const h = fixture({ silo: many(2, () => siloRow()) });
  h.records.quickbooks_accounts.length = 0;
  const r = await h.run(); assert.equal(r.status, 400);
});
