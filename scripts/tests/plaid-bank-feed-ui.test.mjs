import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Execute the shipped module and Card Coding's actual callbacks. Network,
// Supabase, Link, and DOM are fakes; accounting/UI decision code is not copied.
const moduleSource = await readFile(new URL('../../v2/plaid-bank-feed.js', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('../../v2/bank-workspace.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../v2/transactions.html', import.meta.url), 'utf8');
const inlineSource = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>', html.indexOf('<script>')));
class Element {
  constructor() { this.listeners = {}; this.dataset = {}; this.value = ''; this.options = []; this.disabled = false; this.hidden = false; this.textContent = ''; this.fields = new Map(); this.classList = { toggle() {}, add() {}, remove() {} }; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  querySelectorAll() { return []; }
  querySelector(selector) { return this.fields.get(selector) || new Element(); }
  set innerHTML(value) { this.html = value; }
  get innerHTML() { return this.html || ''; }
  setAttribute() {} removeAttribute() {} appendChild() {} focus() {}
  async fire(type, event = { target: this }) { for (const fn of this.listeners[type] || []) await fn(event); }
}
function dom() {
  const ids = new Map();
  const document = { getElementById(id) { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); },
    querySelectorAll: () => [], querySelector: () => new Element(), createElement: () => new Element(), head: new Element(), addEventListener() {} };
  return { document, ids, el: document.getElementById };
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const chart = [{ id: '1', name: 'Cash', type: 'Bank', connectionId: 'qbo-one' }, { id: '2', name: 'Expense', type: 'Expense', connectionId: 'qbo-one' }];
const source = { id: 'source-one', display_name: 'Checking', source_type: 'bank', ingest_mode: 'plaid', qbo_connection_id: 'qbo-one', authoritative_from: '2026-09-01' };
const transaction = { id: 'txn-one', origin: 'plaid', provider_status: 'posted', amount: 10, currency:'USD', description: 'Merchant', status: 'uncoded', accounting_treatment: 'unknown', txn_date: '2026-09-12' };
function target(row, selector) { return { closest(value) { return value === selector ? this : value === '[data-bank-account]' || value === '[data-bank-exception]' ? row : null; } }; }
function query(data, writes, table) {
  let window = null;
  const q = { select() { return q; }, eq() { return q; }, order() { return q; }, range(start, end) { window = [start, end]; return q; }, limit() { return q; }, single() { return q; },
    upsert(value) { writes.push({ table, value: clone(value) }); return q; },
    then(resolve, reject) { const rows = data[table] || []; return Promise.resolve({ data: window ? rows.slice(window[0], window[1] + 1) : rows, error: null }).then(resolve, reject); } };
  return q;
}
function harness({ dirty = false, invokeError = null, syncResult = { exceptions: 0, batch_ids: ['batch-one'] }, exchangeResult = { connection_id: 'connection-one' } } = {}) {
  const d = dom(), calls = [], writes = [], statuses = [], opened = [], links = [], storageData = new Map();
  const data = {
    plaid_connections: [{ id: 'connection-one', environment: 'sandbox', status: 'active', institution_name: 'Test Bank' }],
    plaid_accounts: [{ id: 'account-one', connection_id: 'connection-one', type: 'depository', name: 'Checking', iso_currency_code: 'USD', source_id: source.id }],
    plaid_sync_exceptions: [], card_transactions: { batch_id: 'batch-one' },
  };
  const user = { id: 'user-one' }, company = { id: 'company-one' };
  const db = { auth: { getSession: async () => ({ data: { session: { user } } }) },
    functions: { invoke: async (name, request) => {
      calls.push({ name, body: clone(request.body) });
      if (invokeError) return { error: new Error(invokeError) };
      const action = request.body.action;
      const result = action === 'link_token' ? { link_token: 'link-token', link_state: 'signed-state', expires_at: '2099-01-01T00:00:00Z', environment: 'sandbox' }
        : action === 'history_preview' ? {account_id:'account-one',earliest_date:'2026-08-01',returned_count:22,history_days_requested:90}
        : action === 'exchange' ? exchangeResult : action === 'sync' ? syncResult : action === 'refresh_accounts' ? { connection_id: 'connection-one' } : {};
      return { data: result, error: null };
    } },
    from: (table) => query(data, writes, table), rpc: async (name, args) => { calls.push({ rpc: name, args: clone(args) }); return { data: { source_id: source.id } }; },
  };
  const window = { location: { href: 'https://silo.test/v2/transactions.html' }, history: { replaceState() {} },
    SiloFinanceDialog:{ask:async()=>true},
    Plaid: { create(options) { links.push(options); return { open() {}, destroy() {} }; } } };
  const storage = { getItem: (key) => storageData.get(key), setItem: (key, value) => storageData.set(key, value), removeItem: (key) => storageData.delete(key) };
  vm.runInNewContext(moduleSource, { window, URL, Date, console });
  vm.runInNewContext(workspaceSource, {window});
  let changed = 0;
  const controller = window.SiloBankFeeds.create({ db, company: () => company,
    references: () => ({ sources: [source], allAccounts: chart }), dirty: () => dirty,
    changed: async () => { changed++; }, openBatch: async (id) => opened.push(id),
    status: (message, kind) => statuses.push({ message, kind }), document: d.document, window, storage });
  const row = new Element(); row.dataset.bankAccount = 'account-one';
  for (const [key, value] of [['qbo', 'qbo-one:1'], ['source', 'source-one'], ['cutover', '2026-09-01']]) {
    const field = new Element(); field.value = value; row.fields.set(`[data-bank-${key}]`, field);
  }
  return { ...d, db, calls, writes, statuses, opened, links, storageData, window, data, user, company, controller, row,
    bank: window.SiloBankFeeds, get changed() { return changed; } };
}
async function pageHarness({ status = 'draft', sourceType = 'bank', origin = 'plaid', amount = 10, treatment = 'unknown', fetchImpl } = {}) {
  const d = dom(), calls = [], writes = [], fetches = [], window = { listeners:{}, addEventListener(type,fn){this.listeners[type]=fn;}, __SILO_CONFIG__: { SUPABASE_URL: 'https://silo.test', SUPABASE_ANON_KEY: 'public-key' } };
  const db = { auth: { getSession: async () => ({ data: { session: { access_token: 'fake-token' } } }) },
    from: (table) => query({}, writes, table), rpc: async (name, args) => { calls.push({ name, args: clone(args) }); return { data: args.p_rows?.length || 0 }; } };
  window.supabase = { createClient: () => db };
  vm.runInNewContext(moduleSource, { window });
  const testable = inlineSource.slice(0, inlineSource.lastIndexOf('  boot().catch('))
    + 'window.testPage = { state, suggestions, acceptSuggestion, doImport, parseCsv, renderSourceSelect, buildEntry, setCompany(v) { _co = v; }, applyRules, aiCategorise, saveCoding, learnRules, ruleMatches, renderCoding, renderEntry, openBatch, discardBatch, loadTxns, loadBatches };\n})();';
  vm.runInNewContext(testable, { window, crypto:webcrypto,TextEncoder, document: d.document, console, setTimeout() {}, clearTimeout() {},
    fetch: async (url, args) => { fetches.push({ url, body: JSON.parse(args.body) }); return fetchImpl ? fetchImpl(url, args) : { ok: true, json: async () => ({ suggestions: [] }) }; },
    confirm() { throw new Error('Unexpected destructive confirmation'); }, prompt() { throw new Error('Unexpected prompt'); } });
  const page = window.testPage;
  page.setCompany({ id: 'company-one' });
  Object.assign(page.state, { sources: [{ ...source, source_type: sourceType }], accounts: chart, allAccounts: chart,
    batch: { id: 'batch-one', source_id: source.id, status, source_name: 'Checking', entry_date: '2026-09-30' },
    txns: [{ ...transaction, origin, amount, accounting_treatment: treatment }] });
  d.el('codeFilter').value = 'all';
  return { ...d, page, db, calls, writes, fetches, window };
}
let tests = 0;
async function test(name, callback) { await callback(); tests++; console.log(`ok - ${name}`); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function attemptConcurrentCoding(h) {
  const row = new Element(); row.dataset.txn = 'txn-one';
  for (const [field, value] of [['account', '1'], ['treatment', 'transfer'], ['location', 'location-other'], ['entity', 'Vendor:other']]) {
    await h.el('tblCoding').fire('change', { target: { dataset: { field }, value, closest: () => row } });
  }
  for (const id of ['bulkAccount', 'bulkLocation', 'bulkEntity']) await h.el(id).fire('change', { target: { value: id === 'bulkEntity' ? 'Vendor:other' : '1' } });
  for (const id of ['btnBulkInclude', 'btnBulkExclude']) await h.el(id).fire('click');
  await h.page.applyRules(true);
  await h.page.saveCoding();
  await h.page.aiCategorise();
  await h.page.learnRules();
  await h.el('btnReloadCoding').fire('click');
}
function assertCodingLocked(h) {
  for (const id of ['btnApplyRules', 'btnSaveCoding', 'btnAiCode', 'btnLearnRules', 'btnReloadCoding',
    'bulkAccount', 'bulkLocation', 'bulkEntity', 'btnBulkInclude', 'btnBulkExclude', 'codeAll']) {
    assert.equal(h.el(id).disabled, true, `${id} must be disabled while coding is pending`);
  }
  assert.match(h.el('tblCoding').innerHTML, /data-field="treatment"[^>]*disabled/);
  assert.match(h.el('codeSub').textContent, /Coding in progress/);
}

await test('new Link forwards signed context and exchange public token once', async () => {
  const h = harness(); await h.el('btnLinkBank').fire('click');
  assert.equal(h.links.length, 1);
  assert.equal(JSON.parse(h.storageData.get('silo-plaid-link')).linkState, 'signed-state');
  await h.links[0].onSuccess('public-token', { institution: { name: 'Test Bank' } });
  assert.deepEqual(h.calls.map((call) => call.body.action), ['link_token', 'exchange']);
  assert.equal(h.calls[1].body.link_state, 'signed-state');
  assert.equal(h.calls[1].body.public_token, 'public-token');
  assert.equal(h.storageData.size, 0);
});
await test('repair refreshes existing account metadata without public token exchange', async () => {
  const h = harness(); const button = { dataset: { bankRepair: 'connection-one' }, closest(selector) { return selector === '[data-bank-repair]' ? this : null; } };
  await h.el('bankConnections').fire('click', { target: button });
  await h.links[0].onSuccess('unused-token', {});
  assert.deepEqual(h.calls.map((call) => call.body.action), ['link_token', 'refresh_accounts']);
  assert.equal(h.calls[0].body.connection_id, 'connection-one');
  assert.equal(h.calls[1].body.resume, true); assert.equal(h.calls[1].body.link_state, 'signed-state');
});
await test('OAuth resumes original Link token and retains full redirect URI', async () => {
  const h = harness(); await h.el('btnLinkBank').fire('click');
  h.window.location.href += '?oauth_state_id=callback';
  assert.equal(await h.controller.resume(), true);
  assert.equal(h.links[1].token, h.links[0].token);
  assert.equal(h.links[1].receivedRedirectUri, h.window.location.href);
});
await test('OAuth company/user mismatch and expired state fail before reopening Link', async () => {
  for (const field of ['companyId', 'userId', 'expiresAt']) {
    const h = harness(); await h.el('btnLinkBank').fire('click');
    const state = JSON.parse(h.storageData.get('silo-plaid-link')); state[field] = 'invalid';
    h.storageData.set('silo-plaid-link', JSON.stringify(state)); h.window.location.href += '?oauth_state_id=callback';
    await assert.rejects(h.controller.resume(), /expired|another company/); assert.equal(h.links.length, 1);
  }
});
await test('company change during Link refuses token exchange', async () => {
  const h = harness(); await h.el('btnLinkBank').fire('click'); h.company.id = 'other-company';
  await h.links[0].onSuccess('public-token', {});
  assert.equal(h.calls.length, 1); assert.match(h.statuses.at(-1).message, /Company or user changed/);
});
await test('durable link with account refresh failure does not claim accounts ready', async () => {
  const h = harness({ exchangeResult: { connection_id: 'connection-one', account_refresh_required: true } });
  await h.el('btnLinkBank').fire('click'); await h.links[0].onSuccess('public-token', {});
  assert.match(h.statuses.at(-1).message, /could not be refreshed/); assert.equal(h.statuses.at(-1).kind, 'info');
});
await test('unsaved coding stops connector changes before API call', async () => {
  const h = harness({ dirty: true }); await h.el('btnLinkBank').fire('click');
  assert.equal(h.calls.length, 0); assert.match(h.statuses.at(-1).message, /Save your coding/);
});
await test('account mapping sends explicit connection, source, account, cutover only', async () => {
  const h = harness();
  await h.el('bankAccounts').fire('click', { target: target(h.row, '[data-bank-preview]') });
  h.calls.length=0;
  await h.el('bankAccounts').fire('click', { target: target(h.row, '[data-bank-map]') });
  assert.deepEqual(h.calls[0], { rpc: 'configure_plaid_account', args: { p_account_id: 'account-one', p_qbo_connection_id: 'qbo-one', p_qbo_account_id: '1', p_authoritative_from: '2026-09-01', p_source_id: 'source-one' } });
  assert.equal(h.calls.length, 1); // Mapping neither syncs nor posts.
});
await test('mapping missing cutover fails before database write', async () => {
  const h = harness(); h.row.fields.get('[data-bank-cutover]').value = '';
  await h.el('bankAccounts').fire('click', { target: target(h.row, '[data-bank-map]') });
  assert.equal(h.calls.length, 0); assert.equal(h.statuses.at(-1).kind, 'neg');
});
await test('sync opens returned batch in the existing coding flow', async () => {
  const h = harness(); await h.el('bankAccounts').fire('click', { target: target(h.row, '[data-bank-sync]') });
  assert.deepEqual(h.calls[0].body, { action: 'sync', account_id: 'account-one' });
  assert.deepEqual(h.opened, ['batch-one']); assert.equal(h.changed, 1);
});
await test('failed or malformed sync never claims success or reloads coding', async () => {
  for (const options of [{ invokeError: 'Sync lease held' }, { syncResult: {} }]) {
    const h = harness(options); await h.el('bankAccounts').fire('click', { target: target(h.row, '[data-bank-sync]') });
    assert.equal(h.opened.length, 0); assert.equal(h.changed, 0); assert.equal(h.statuses.at(-1).kind, 'neg');
  }
});
await test('card inflow and transfer rows never reach card expense AI', async () => {
  for (const options of [{ sourceType: 'card', amount: -10, treatment: 'refund' }, { sourceType: 'card', treatment: 'transfer' }, { sourceType: 'card', treatment: 'card_payment' }]) {
    const h = await pageHarness(options); await h.page.aiCategorise(); assert.equal(h.fetches.length, 0);
  }
});
await test('purchase-only card AI uses existing endpoint and explicit batch context', async () => {
  const h = await pageHarness({ sourceType: 'card', treatment: 'purchase' }); await h.page.aiCategorise();
  assert.equal(h.fetches.length, 1); assert.match(h.fetches[0].url, /card-categorize$/); assert.equal(h.fetches[0].body.batch_id, 'batch-one'); assert.deepEqual(h.fetches[0].body.transaction_ids, ['txn-one']);
});
await test('approved and posted batches cannot mutate via bulk, save, rules, or AI callbacks', async () => {
  for (const status of ['approved', 'posted']) {
    const h = await pageHarness({ status, sourceType: 'card', treatment: 'purchase' });
    const before = clone(h.page.state.txns); h.page.state.dirty.add('txn-one'); h.page.state.selected.add('txn-one');
    for (const id of ['bulkAccount', 'bulkLocation', 'bulkEntity']) await h.el(id).fire('change', { target: { value: '2' } });
    for (const id of ['btnBulkInclude', 'btnBulkExclude']) await h.el(id).fire('click');
    await h.page.saveCoding(); await h.page.applyRules(); await h.page.aiCategorise();
    assert.deepEqual(clone(h.page.state.txns), before); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  }
});
await test('global legacy and opposite-direction rules cannot code Plaid rows', async () => {
  const h = await pageHarness();
  const rule = { pattern: 'merchant', match_type: 'normalized', qbo_account_id: '2', qbo_account_name: 'Expense', is_active: true, priority: 100 };
  for (const invalid of [{}, { source_id: source.id, direction: 'any' }, { source_id: source.id, direction: 'inflow' }, { source_id: 'other-source', direction: 'outflow' }]) {
    h.page.state.rules = [{ ...rule, ...invalid }]; assert.equal(h.page.ruleMatches(h.page.state.txns[0]).rule, null);
  }
  h.page.state.rules = [{ ...rule, source_id: source.id, direction: 'outflow', accounting_treatment: 'purchase' }];
  await h.page.applyRules(true); assert.equal(h.page.state.txns[0].qbo_account_id, '2'); assert.equal(h.page.state.txns[0].accounting_treatment, 'purchase');
});
await test('pending and removed rows cannot be changed by selected-row callbacks', async () => {
  for (const provider_status of ['pending', 'removed']) {
    const h = await pageHarness(); Object.assign(h.page.state.txns[0], { provider_status, status: 'excluded' });
    h.page.state.selected.add('txn-one'); const before = clone(h.page.state.txns);
    await h.el('bulkAccount').fire('change', { target: { value: '2' } }); await h.el('btnBulkInclude').fire('click');
    assert.deepEqual(clone(h.page.state.txns), before);
  }
});
await test('learning same merchant splits inflow/outflow and preserves treatment/source', async () => {
  const h = await pageHarness();
  h.page.state.txns = [
    { ...transaction, status: 'coded', coding_source: 'manual', qbo_account_id: '2', accounting_treatment: 'purchase', amount: 10 },
    { ...transaction, id: 'txn-two', status: 'coded', coding_source: 'manual', qbo_account_id: '2', accounting_treatment: 'refund', amount: -10 },
  ];
  await h.page.learnRules(); const rows = h.writes[0].value;
  assert.equal(rows.length, 2); assert.deepEqual(rows.map((row) => row.direction).sort(), ['inflow', 'outflow']);
  assert.ok(rows.every((row) => row.source_id === source.id)); assert.deepEqual(rows.map((row) => row.accounting_treatment).sort(), ['purchase', 'refund']);
});
await test('CSV cutover includes exact boundary and missing dates fail closed', async () => {
  const { bank } = harness();
  assert.equal(bank.csvOverlaps(source, [{ txn_date: '2026-08-31' }]), false);
  assert.equal(bank.csvOverlaps(source, [{ txn_date: '2026-09-01' }]), true);
  assert.equal(bank.csvOverlaps(source, [{ txn_date: null }]), true);
});
await test('bank batch discard is refused before destructive confirmation or write', async () => {
  const h = await pageHarness(); h.page.state.batches = [h.page.state.batch];
  await h.page.discardBatch('batch-one'); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  assert.match(h.el('status').textContent, /cannot be discarded/);
});
await test('busy coding or unsaved rows preserve the current batch on navigation', async () => {
  for (const busy of [true, false]) {
    const h = await pageHarness(); h.page.state.codingBusy = busy;
    if (!busy) h.page.state.dirty.add('txn-one');
    await h.page.openBatch('other-batch'); assert.equal(h.page.state.batch.id, 'batch-one');
  }
});

await test('malformed Link exchange response cannot claim connection success', async () => {
  const h = harness({ exchangeResult: {} }); await h.el('btnLinkBank').fire('click');
  await h.links[0].onSuccess('public-token', {});
  assert.equal(h.statuses.at(-1).kind, 'neg'); assert.match(h.statuses.at(-1).message, /could not be confirmed/);
});
await test('unsaved Plaid treatment cannot be sent as trusted AI input', async () => {
  const h = await pageHarness({ sourceType: 'card', treatment: 'purchase' }); h.page.state.dirty.add('txn-one');
  await h.page.aiCategorise(); assert.equal(h.fetches.length, 0); assert.match(h.el('status').textContent, /Save coding and treatment/);
});


await test('stale provider save carries revision, preserves unsaved edits and offers reload', async () => {
  const h = await pageHarness(); h.page.state.txns[0].provider_updated_at = '2026-09-12T00:00:00Z';
  h.page.state.dirty.add('txn-one');
  h.db.rpc = async (name, args) => { h.calls.push({ name, args: clone(args) }); return { error: { message: 'provider_transaction_changed' } }; };
  await h.page.saveCoding();
  assert.equal(h.calls[0].args.p_rows[0].expected_provider_updated_at, '2026-09-12T00:00:00Z');
  assert.equal(h.page.state.dirty.size, 1); assert.match(h.el('status').textContent, /unsaved edits are retained/);
  assert.equal(h.el('btnReloadCoding').hidden, false);
});
await test('pending save locks actual row, bulk and rules callbacks until the saved snapshot completes', async () => {
  const h = await pageHarness({ sourceType: 'card', treatment: 'purchase' });
  Object.assign(h.page.state.txns[0], { qbo_account_id: '2', qbo_account_name: 'Expense', coding_source: 'manual', status: 'coded' });
  h.page.state.selected.add('txn-one'); h.page.state.dirty.add('txn-one');
  h.page.state.rules = [{ pattern: 'merchant', match_type: 'normalized', source_id: source.id, direction: 'outflow', accounting_treatment: 'transfer', qbo_account_id: '1', is_active: true }];
  const before = clone(h.page.state.txns), gate = deferred();
  h.db.rpc = async (name, args) => { h.calls.push({ name, args: clone(args) }); return gate.promise; };
  const saving = h.page.saveCoding();
  assert.equal(h.calls.length, 1); assert.equal(h.page.state.codingBusy, true); assertCodingLocked(h);
  await attemptConcurrentCoding(h);
  assert.deepEqual(clone(h.page.state.txns), before); assert.equal(h.page.state.dirty.size, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.fetches.length, 0); assert.equal(h.writes.length, 0);
  gate.resolve({ data: 1 }); await saving;
  assert.deepEqual(clone(h.page.state.txns), before); assert.equal(h.page.state.dirty.size, 0);
  assert.equal(h.calls[0].args.p_rows[0].qbo_account_id, '2'); assert.equal(h.page.state.codingBusy, false);
  assert.equal(h.el('btnSaveCoding').disabled, false); assert.equal(h.el('bulkAccount').disabled, false);
  assert.equal(h.el('btnLearnRules').disabled, false);
});
await test('pending AI prevents manual edits and competing requests before applying its unsaved suggestion', async () => {
  const gate = deferred(), started = deferred();
  const h = await pageHarness({ sourceType: 'card', treatment: 'purchase', fetchImpl: () => { started.resolve(); return gate.promise; } });
  h.page.state.selected.add('txn-one');
  h.page.state.rules = [{ pattern: 'merchant', match_type: 'normalized', source_id: source.id, direction: 'outflow', accounting_treatment: 'transfer', qbo_account_id: '1', is_active: true }];
  const before = clone(h.page.state.txns), categorising = h.page.aiCategorise(); await started.promise;
  assert.equal(h.page.state.codingBusy, true); assertCodingLocked(h);
  await attemptConcurrentCoding(h);
  assert.deepEqual(clone(h.page.state.txns), before); assert.equal(h.page.state.dirty.size, 0);
  assert.equal(h.fetches.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  gate.resolve({ ok: true, json: async () => ({ suggestions: [{ merchant: 'merchant', account_name: 'Expense', confidence: 0.9 }] }) });
  await categorising;
  assert.deepEqual(clone(h.page.state.txns),before); assert.equal(h.page.state.dirty.size,0);
  assert.equal(h.page.suggestions.size,1); h.page.acceptSuggestion('txn-one');
  assert.equal(h.page.state.txns[0].qbo_account_id, '2'); assert.equal(h.page.state.txns[0].coding_source, 'ai');
  assert.equal(h.page.state.txns[0].accounting_treatment, 'purchase'); assert.equal(h.page.state.dirty.size, 1);
  assert.equal(h.page.state.codingBusy, false); assert.equal(h.el('btnSaveCoding').disabled, false);
  assert.equal(h.el('bulkAccount').disabled, false); assert.equal(h.el('btnReloadCoding').disabled, false);
});
await test('monthly bank batch loads beyond the API1000-row limit', async () => {
  const h = await pageHarness(); const rows = Array.from({ length: 1001 }, (_, index) => ({ ...transaction, id: `txn-${index}`, row_no: index + 1 }));
  h.db.from = (table) => query({ card_transactions: rows }, h.writes, table);
  await h.page.loadTxns('batch-one'); assert.equal(h.page.state.txns.length, 1001); assert.equal(h.page.state.txns.at(-1).id, 'txn-1000');
});

await test('list and older-batch requests omit approval payloads while retaining coding fields', async () => {
  const h = await pageHarness(); let single = false; const requests = [];
  const batch = { ...h.page.state.batch, id: 'older-batch' };
  h.db.from = (table) => {
    const q = query({ card_import_batches_v: single ? batch : [batch] }, h.writes, table);
    q.select = (fields) => {
      if (table === 'card_import_batches_v') {
        requests.push(fields);
        assert.ok(!fields.includes('*') && !fields.includes('approval_snapshot'));
        assert.ok(fields.includes('source_id') && fields.includes('entry_date'));
      }
      return q;
    };
    return q;
  };
  await h.page.loadBatches(); assert.equal(h.page.state.batches[0].id, batch.id);
  h.page.state.batches = []; single = true;
  await h.page.openBatch(batch.id);
  assert.equal(h.page.state.batch.id, batch.id); assert.equal(requests.length, 2);
});

await test('mapping unconfirmed or changed date cannot call configure RPC',async()=>{
  for(const answer of [null,false,'changed']){
    const h=harness();
    await h.el('bankAccounts').fire('click',{target:target(h.row,'[data-bank-preview]')});
    h.calls.length=0;
    h.window.SiloFinanceDialog.ask=async()=>{
      if(answer==='changed')h.row.fields.get('[data-bank-cutover]').value='2026-08-01';
      return answer==='changed'?true:answer;
    };
    await h.el('bankAccounts').fire('click',{target:target(h.row,'[data-bank-map]')});
    assert.equal(h.calls.length,0);
  }
});
await test('CSV statement path parses, imports, codes, saves and builds a balanced preview without posting',async()=>{
  const h=await pageHarness({sourceType:'card',origin:'csv'});
  const src=h.page.state.sources[0];src.is_active=true;src.ingest_mode='csv';src.credit_qbo_account_id='1';src.credit_qbo_account_name='Cash';src.posting_enabled=true;
  h.page.renderSourceSelect();assert.match(h.el('impSource').innerHTML,/source-one/);
  h.el('impSource').value=src.id;h.el('impPeriod').value='2026-09';h.el('impEntryDate').value='2026-09-30';
  h.el('impMap').querySelectorAll=()=>['txn_date','description','amount'].map((col,i)=>({dataset:{col},value:['Date','Description','Amount'][i]}));
  h.page.state.parsed={...h.page.parseCsv('Date,Description,Amount\n2026-09-10,Office Depot,25.00\n2026-09-11,Shipping supplies,12.50\n'),file:{name:'statement.csv'}};
  const stored={card_transactions:[],card_import_batches:[]};
  h.db.from=(table)=>{
    const base=table.replace(/_v$/,'');let operation='read',payload,single=false;
    const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},limit(){return q;},range(){return q;},single(){single=true;return q;},
      insert(value){operation='insert';payload=value;return q;},update(value){operation='update';payload=value;return q;},
      then(resolve,reject){
        if(operation==='insert'){
          const rows=(Array.isArray(payload)?payload:[payload]).map((r,i)=>({id:base==='card_import_batches'?'csv-batch':'csv-'+i,status:base==='card_import_batches'?'draft':'uncoded',currency:'USD',source_name:'CSV fixture',...r}));
          stored[base].push(...rows);
        }
        const rows=stored[base]||[];return Promise.resolve({data:single?rows[0]:rows,error:null}).then(resolve,reject);
      }};return q;
  };
  await h.page.doImport();
  assert.equal(stored.card_transactions.length,2,h.el('status').textContent);
  assert.equal(h.page.state.batch.id,'csv-batch');assert.equal(h.page.state.batch.status,'draft');
  for(const row of h.page.state.txns){Object.assign(row,{qbo_account_id:'2',qbo_account_name:'Expense',status:'coded',coding_source:'manual'});h.page.state.dirty.add(row.id);}
  await h.page.saveCoding();assert.equal(h.calls.at(-1).name,'apply_card_coding');
  const entry=h.page.buildEntry(),lines=[...entry.lines,entry.creditLine];
  assert.equal(lines.reduce((n,l)=>n+l.debit,0),37.5);assert.equal(lines.reduce((n,l)=>n+l.credit,0),37.5);
  assert.ok(h.fetches.every(f=>!f.url.includes('quickbooks-post-journal')));
});
console.log(`plaid-bank-feed-ui: ${tests} executed scenarios passed`);

await test('failed history preview permits mapping only after unknown-history acknowledgement', async()=>{
  for (const error of ['sync_page_limit','sync_update_limit','request_timeout']) {
    for (const accepted of [false,true]) {
      const h=harness({invokeError:error});
      await h.el('bankAccounts').fire('click',{target:target(h.row,'[data-bank-preview]')});
      h.calls.length=0;
      h.window.SiloFinanceDialog.ask=async(options)=>{
        assert.match(options.message,/UNKNOWN/);
        assert.match(options.confirmation,/available history is unknown/);
        assert.match(options.confirmation,/2026-09-01/);
        return accepted;
      };
      await h.el('bankAccounts').fire('click',{target:target(h.row,'[data-bank-map]')});
      assert.equal(h.calls.filter(c=>c.rpc==='configure_plaid_account').length,accepted?1:0);
    }
  }
});

await test('expanded review is read-only and retains access to secondary dimensions',async()=>{
  for(const status of ['draft','approved','posted']){
    const h=await pageHarness({status});h.page.renderCoding();
    const before=clone(h.page.state.txns),row=new Element();row.dataset.txn='txn-one';
    const click={target:{closest:s=>s==='[data-txn]'?row:s==='[data-review]'?{}:null,matches:()=>false}};
    assert.match(h.el('tblCoding').innerHTML,/id="txn-detail-txn-one" hidden/);
    await h.el('tblCoding').fire('click',click);
    assert.match(h.el('tblCoding').innerHTML,/id="txn-detail-txn-one" >/);
    assert.match(h.el('tblCoding').innerHTML,/data-cell="location"/);
    assert.match(h.el('tblCoding').innerHTML,/data-cell="entity"/);
    assert.deepEqual(clone(h.page.state.txns),before);assert.equal(h.page.state.dirty.size,0);
    assert.equal(h.calls.length,0);assert.equal(h.fetches.length,0);
    await h.el('tblCoding').fire('click',click);
    assert.match(h.el('tblCoding').innerHTML,/id="txn-detail-txn-one" hidden/);
  }
});
await test('money direction and required entities stay visible in compact rows',async()=>{
  const h=await pageHarness({amount:-45});h.page.renderCoding();
  assert.match(h.el('tblCoding').innerHTML,/\+\$45\.00<span>Money in/);
  h.page.state.allAccounts.push({id:'ap',name:'Payables',type:'Accounts Payable',connectionId:'qbo-one'});
  h.page.state.txns[0].qbo_account_id='ap';h.page.renderCoding();
  assert.match(h.el('tblCoding').innerHTML,/Entity required/);
});

await test('canonical route resumes a matching legacy OAuth callback and rejects unrelated saved URLs',async()=>{
  for(const legacy of ['https://silo.test/v2/card-coding.html?oauth_state_id=callback','https://attacker.invalid/v2/card-coding.html?oauth_state_id=callback','https://silo.test/v2/card-coding.html?oauth_state_id=other']){
    const h=harness();await h.el('btnLinkBank').fire('click');
    h.window.location.href='https://silo.test/v2/transactions.html?oauth_state_id=callback';
    h.storageData.set('silo-plaid-legacy-return',legacy);
    await h.controller.resume();
    assert.equal(h.links[1].receivedRedirectUri,legacy==='https://silo.test/v2/card-coding.html?oauth_state_id=callback'?legacy:h.window.location.href);
  }
});

await test('leaving Transactions protects pending edits and in-flight coding only',async()=>{
  const h=await pageHarness();
  for(const [dirty,busy,blocked] of [[false,false,false],[true,false,true],[false,true,true]]){
    h.page.state.dirty.clear();if(dirty)h.page.state.dirty.add('txn-one');h.page.state.codingBusy=busy;
    let prevented=false;const event={preventDefault(){prevented=true;}};
    h.window.listeners.beforeunload(event);
    assert.equal(prevented,blocked);
    assert.equal(event.returnValue,blocked?'':undefined);
  }
});
