// Executes the actual Edge Function and real crypto/protocol helpers. Only
// Supabase and Plaid IO are synthetic; SQL/RLS semantics have a separate suite.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as core from '../../supabase/functions/plaid-finance/plaid-core.mjs';

const source = await readFile(new URL('../../supabase/functions/plaid-finance/handler.ts', import.meta.url), 'utf8');
const mutations = {
  tenant: s => s.replaceAll(".eq('company_entity_id', companyId)", ''),
  state: s => s.replace('await verifyLinkState(input.link_state, key, { userId, companyId })', '{ connectionId: null }'),
  cursor: s => s.replace('p_expected_cursor: claim.cursor', 'p_expected_cursor: null'),
  context: s => s.replace('companyId = context.data;', "companyId = (await db.from('profiles').select('active_company_id').eq('id', userId).maybeSingle()).data.active_company_id;"),
};
const selectedMutation = process.env.PLAID_HANDLER_MUTATION;
const effectiveSource = (selectedMutation ? mutations[selectedMutation](source) : source)
  .replace('export async function handlePlaidFinance', 'async function handlePlaidFinance') + '\nDeno.serve(handlePlaidFinance);';
const runnable = stripTypeScriptTypes(effectiveSource
  .replace(/import \{ createClient \} from 'https:[^']+';/, '')
  .replace(/import \{[\s\S]*?\} from '\.\/plaid-core\.mjs';/, ''), { mode: 'strip' });
const ids = {
  user: '10000000-0000-0000-0000-000000000001',
  company: '20000000-0000-0000-0000-000000000001',
  otherCompany: '20000000-0000-0000-0000-000000000002',
  connection: '30000000-0000-0000-0000-000000000001',
  account: '40000000-0000-0000-0000-000000000001',
  source: '50000000-0000-0000-0000-000000000001',
};
const encryptionKey = Buffer.alloc(32, 61).toString('base64');
const accessToken = 'synthetic-access-token-must-never-reach-browser';
const providerAccount = {
  account_id: 'provider-account-1', name: 'Synthetic checking', mask: '1111',
  type: 'depository', subtype: 'checking', balances: { current: 100, available: 80, iso_currency_code: 'USD' },
};
const transaction = (id, changes = {}) => ({ transaction_id: id, account_id: providerAccount.account_id,
  name: 'Synthetic merchant', merchant_name: 'Synthetic merchant', amount: 25,
  date: '2026-09-01', pending: false, iso_currency_code: 'USD', ...changes });
const page = (changes = {}) => ({ added: [], modified: [], removed: [], has_more: false, next_cursor: 'cursor-next', ...changes });
const clone = value => JSON.parse(JSON.stringify(value));
let scenarios = 0;

async function fixture(options = {}) {
  const environment = options.environment || 'sandbox';
  const ciphertext = await core.encryptToken(accessToken, encryptionKey, {
    companyId: ids.company, itemId: 'item-1', environment: options.connectionEnvironment || environment,
  });
  const records = {
    profiles: [{ id: ids.user, active_company_id: ids.company, is_active: true, ...options.profile }],
    plaid_connections: options.noConnection ? [] : [{ id: ids.connection, company_entity_id: ids.company,
      item_id: 'item-1', environment, status: 'active', updated_at: '2026-09-01T00:00:00Z', institution_name: 'Synthetic bank', ...options.connection }],
    plaid_accounts: [{ id: ids.account, company_entity_id: ids.company, connection_id: ids.connection,
      provider_account_id: providerAccount.account_id, source_id: ids.source, cursor: 'cursor-saved', ...options.account }],
    plaid_connection_secrets: [{ company_entity_id: ids.company, connection_id: ids.connection, token_ciphertext: ciphertext }],
  };
  const events = [];
  let handler;
  let registerCalls = 0;
  let syncCalls = 0;
  let applyCalls = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    update(values) { this.op = 'update'; this.values = values; return this; }
    execute(single = false) {
      events.push({ query: this.table, op: this.op, filters: clone(this.filters), values: this.values && clone(this.values) });
      if (options.lookupFails && this.table === 'plaid_connections' && this.op === 'select') return { data: null, error: { message: 'synthetic lookup failed' } };
      if (options.repairRace && this.table === 'plaid_connections' && this.op === 'update' && this.values.status === 'active') records.plaid_connections[0].updated_at = '2026-09-02T00:00:00Z';
      const selected = (records[this.table] || []).filter(row => this.filters.every(([key, value]) => row[key] === value));
      if (this.op === 'update') {
        if (options.connectionUpdateFails) return { data: null, error: { message: 'synthetic write failed' } };
        selected.forEach(row => Object.assign(row, this.values));
      }
      return { data: clone(single ? selected[0] || null : selected), error: null };
    }
    maybeSingle() { return Promise.resolve(this.execute(true)); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  const service = {
    auth: { getUser: async token => {
      events.push({ auth: token });
      return { data: { user: options.invalidUser ? null : { id: ids.user } }, error: options.authError ? { message: 'invalid' } : null };
    } },
    from: table => new Query(table),
    rpc: async (name, args) => {
      events.push({ rpc: name, args: clone(args) });
      if (name === 'plaid_register_connection') {
        registerCalls++;
        if (options.registerFailure === 'before-commit') return { data: null, error: { code: options.registerCode || '23514', message: 'synthetic database failure' } };
        if (options.registerFailure === 'transport') throw new TypeError('synthetic database response lost');
        if (options.registerFailure === 'malformed') return { data: null, error: null };
        if (!records.plaid_connections.length) records.plaid_connections.push({ id: ids.connection,
          company_entity_id: args.p_company_id, item_id: args.p_item_id, environment: args.p_environment,
          institution_name: args.p_institution_name, status: 'active' });
        records.plaid_connection_secrets[0].token_ciphertext = clone(args.p_token_ciphertext);
        if (registerCalls === 1 && options.registerFailure === 'after-commit') return { data: null, error: { message: 'synthetic lost response' } };
        if (registerCalls === 2 && options.accountRegistrationFails) return { data: null, error: { message: 'synthetic accounts save failure' } };
        records.plaid_connections[0].status = 'active';
        return { data: { connection_id: ids.connection }, error: null };
      }
      if (name === 'plaid_claim_sync') {
        if (options.claimFails) return { data: null, error: { message: 'synthetic lease already held' } };
        return { data: { cursor: records.plaid_accounts[0].cursor, lease_id: args.p_lease_id,
          provider_account_id: providerAccount.account_id, connection_id: ids.connection,
          ...options.claim }, error: null };
      }
      if (name === 'plaid_apply_sync') {
        applyCalls++;
        if (options.applyFails) return { data: null, error: { message: 'synthetic cursor compare failed' } };
        records.plaid_accounts[0].cursor = args.p_next_cursor;
        if (options.applyResponseLost && applyCalls === 1) throw new TypeError('synthetic committed apply response lost');
        return { data: { added: args.p_added.length, modified: args.p_modified.length,
          removed: args.p_removed.length, batch_ids: ['batch-1'], exceptions: 0 }, error: null };
      }
      if (name === 'plaid_release_sync') return { data: null,
        error: options.releaseFails ? { message: 'synthetic release failure' } : null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const fetchFake = async (url, init) => {
    const parsed = new URL(url);
    const body = JSON.parse(init.body);
    events.push({ fetch: parsed.pathname, host: parsed.origin, body: clone(body) });
    assert.equal(parsed.origin, `https://${environment}.plaid.com`, 'provider host is fixed by server environment');
    assert.equal(body.client_id, 'synthetic-client');
    assert.equal(body.secret, 'synthetic-provider-secret');
    assert.equal(init.headers['Plaid-Version'], '2020-09-14');
    assert.equal(init.redirect, 'error', 'provider redirects cannot forward credentials to another host');
    assert.ok(init.signal instanceof AbortSignal, 'provider requests have a timeout');
    if (options.networkFails) throw new Error(`${accessToken} private account data`);
    if (options.providerError) return Response.json({ error_code: options.providerError,
      error_message: `${accessToken} private data`, display_message: 'must not echo', request_id: 'private-id' }, { status: 400 });
    if (parsed.pathname === '/link/token/create') return Response.json({ link_token: 'synthetic-link-token', expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    if (parsed.pathname === '/item/public_token/exchange') return Response.json({ item_id: 'item-1', access_token: accessToken });
    if (parsed.pathname === '/item/remove') {
      if (options.cleanupFails) throw new Error('synthetic cleanup response lost');
      return Response.json({ removed: true });
    }
    if (parsed.pathname === '/accounts/get') {
      if (options.accountsFail) return Response.json({ error_code: 'PRODUCT_NOT_READY', error_message: accessToken }, { status: 400 });
      return Response.json({ item: { item_id: options.wrongItem ? 'wrong-item' : 'item-1' },
        accounts: options.accounts || [providerAccount] });
    }
    if (parsed.pathname === '/transactions/sync') {
      const next = (options.pages || [page({ added: [transaction('new-1')] })])[syncCalls++];
      assert.ok(next, 'no unexpected provider retry');
      if (next.error_code) return Response.json(next, { status: 400 });
      return Response.json(next);
    }
    throw new Error(`Unexpected network path ${parsed.pathname}`);
  };
  const config = { SUPABASE_URL: 'https://silo.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    SUPABASE_ANON_KEY: 'synthetic-anon-key', PLAID_ENVIRONMENT: environment,
    PLAID_TOKEN_ENCRYPTION_KEY: encryptionKey, PLAID_CLIENT_ID: 'synthetic-client', PLAID_SECRET: 'synthetic-provider-secret',
    PLAID_REDIRECT_URI: 'https://silo.test/v2/card-coding.html', ...options.config };
  vm.runInNewContext(runnable, { ...core, Request, Response, URL, AbortSignal, crypto: webcrypto,
    fetch: fetchFake, createClient: (_url, key, opts) => opts ? {
      rpc: async name => {
        events.push({ permission: name, authorization: opts.global.headers.Authorization });
        assert.equal(key, 'synthetic-anon-key');
        assert.equal(name, 'plaid_finance_context', 'company and finance authority must come from one database snapshot');
        const profile = records.profiles[0];
        const company = options.canManage !== false && profile.is_active !== false ? profile.active_company_id : null;
        if (options.switchAfterContext) profile.active_company_id = ids.otherCompany;
        return { data: company, error: options.permissionError ? { message: 'RPC error' } : null };
      },
    } : service,
    Deno: { env: { get: key => config[key] }, serve: callback => { handler = callback; } },
  }, { filename: 'plaid-finance/handler.ts' });
  return {
    records, events,
    calls: path => events.filter(event => event.fetch === path),
    rpcs: name => events.filter(event => event.rpc === name),
    async state(changes = {}) { return core.createLinkState({ userId: ids.user, companyId: ids.company,
      expiresAt: Date.now() + 60 * 60 * 1000, ...changes }, encryptionKey); },
    async request(body, overrides = {}) {
      const eventStart = events.length;
      const response = await handler(new Request('https://silo.test/plaid-finance', {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-user-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body), ...overrides,
      }));
      const text = await response.text();
      assert.ok(!text.includes(accessToken), 'plaintext access tokens never reach the browser');
      assert.ok(!text.includes('synthetic-provider-secret'), 'provider secrets never reach the browser');
      assert.ok(!text.includes('ciphertext'), 'token envelopes never reach the browser');
      assert.equal(events.some(event => event.query === 'profiles'), false, 'a second profile read must not split finance authority from company identity');
      assert.ok(events.slice(eventStart).filter(event => event.permission).length <= 1, 'one context query authorizes a browser request');
      assert.equal(events.some(event => event.rpc && !['plaid_register_connection', 'plaid_claim_sync',
        'plaid_apply_sync', 'plaid_release_sync'].includes(event.rpc)), false, 'ingestion invokes no approval or posting RPC');
      return { status: response.status, body: JSON.parse(text) };
    },
  };
}

for (const options of [{ invalidUser: true }, { authError: true }, { canManage: false }, { permissionError: true },
  { profile: { is_active: false } }, { profile: { active_company_id: null } }]) {
  const f = await fixture(options);
  const out = await f.request({ action: 'link_token' });
  assert.ok([401, 403].includes(out.status));
  assert.equal(f.events.filter(event => event.fetch).length, 0);
  scenarios++;
}
{
  const f = await fixture({ switchAfterContext: true });
  const out = await f.request({ action: 'link_token', company_id: ids.otherCompany });
  assert.equal(out.status, 200);
  assert.equal(f.records.profiles[0].active_company_id, ids.otherCompany);
  assert.equal(f.calls('/link/token/create')[0].body.user.client_user_id, `${ids.company}:${ids.user}`,
    'a switch after authorization cannot redirect the request into a company with no finance grant');
  const context = await core.verifyLinkState(out.body.link_state, encryptionKey, { userId: ids.user, companyId: ids.company });
  assert.equal(context.companyId, ids.company);
  assert.equal(f.events.filter(event => event.permission).length, 1);
  scenarios++;
}
{
  const f = await fixture({ switchAfterContext: true, account: { company_entity_id: ids.otherCompany } });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.ok(out.status >= 400);
  assert.equal(f.rpcs('plaid_claim_sync').length, 0, 'switching to a viewer company cannot authorize its account through the prior finance grant');
  assert.equal(f.calls('/accounts/get').length, 0);
  scenarios++;
}
{
  const f = await fixture({ pages: [
    page({ added: [transaction('discard-this-page')], next_cursor: 'cursor-abandoned', has_more: true }),
    { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' },
    page({ added: [transaction('authoritative-restart')], next_cursor: 'cursor-restarted' }),
  ] });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.status, 200);
  assert.deepEqual(f.calls('/transactions/sync').map(event => event.body.cursor), ['cursor-saved', 'cursor-abandoned', 'cursor-saved']);
  assert.equal(f.rpcs('plaid_apply_sync').length, 1);
  assert.deepEqual(f.rpcs('plaid_apply_sync')[0].args.p_added.map(tx => tx.transaction_id), ['authoritative-restart']);
  scenarios++;
}
{
  const f = await fixture({ applyResponseLost: true, pages: [
    page({ added: [transaction('durably-ingested')], next_cursor: 'cursor-committed' }),
    page({ next_cursor: 'cursor-committed' }),
  ] });
  const first = await f.request({ action: 'sync', account_id: ids.account });
  assert.ok(first.status >= 400, 'an unconfirmed local response never reports success');
  assert.equal(f.records.plaid_accounts[0].cursor, 'cursor-committed');
  const second = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(second.status, 200);
  assert.deepEqual(f.calls('/transactions/sync').map(event => event.body.cursor), ['cursor-saved', 'cursor-committed']);
  assert.equal(f.rpcs('plaid_apply_sync')[1].args.p_expected_cursor, 'cursor-committed');
  assert.deepEqual(f.rpcs('plaid_apply_sync')[1].args.p_added, []);
  scenarios++;
}
{
  const f = await fixture();
  const out = await f.request({ action: 'link_token' }, { headers: {} });
  assert.equal(out.status, 401);
  assert.equal(f.events.length, 0);
  scenarios++;
}
for (const [body, options] of [
  [{ action: 'link_token', connection_id: ids.connection }, { connection: { company_entity_id: ids.otherCompany } }],
  [{ action: 'refresh_accounts', connection_id: ids.connection }, { connection: { company_entity_id: ids.otherCompany } }],
  [{ action: 'disconnect', connection_id: ids.connection }, { connection: { company_entity_id: ids.otherCompany } }],
  [{ action: 'sync', account_id: ids.account, company_entity_id: ids.otherCompany }, { account: { company_entity_id: ids.otherCompany } }],
]) {
  const f = await fixture(options);
  const out = await f.request(body);
  assert.ok(out.status >= 400, 'cross-company identifiers cannot use the service client');
  assert.equal(f.events.filter(event => event.fetch || event.rpc || event.op === 'update').length, 0);
  scenarios++;
}
for (const update of [false, true]) {
  const f = await fixture();
  const out = await f.request({ action: 'link_token', ...(update ? { connection_id: ids.connection } : {}),
    host: 'https://untrusted.test', environment: 'production', company_id: ids.otherCompany });
  assert.equal(out.status, 200);
  const request = f.calls('/link/token/create')[0].body;
  assert.equal(request.user.client_user_id, `${ids.company}:${ids.user}`);
  assert.equal(request.redirect_uri, 'https://silo.test/v2/card-coding.html');
  const state = await core.verifyLinkState(out.body.link_state, encryptionKey, { userId: ids.user, companyId: ids.company });
  assert.equal(state.connectionId, update ? ids.connection : null);
  if (update) {
    assert.equal(request.access_token, accessToken);
    assert.equal(request.products, undefined);
    assert.equal(request.transactions, undefined);
  } else {
    assert.deepEqual(request.products, ['transactions']);
    assert.equal(request.transactions.days_requested, 90);
    assert.equal(request.access_token, undefined);
  }
  scenarios++;
}
for (const stateClaims of [{ companyId: ids.otherCompany }, { userId: 'other-user' }, { connectionId: ids.connection }]) {
  const f = await fixture();
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state(stateClaims) });
  assert.ok(out.status >= 400);
  assert.equal(f.calls('/item/public_token/exchange').length, 0, 'signed context is checked before consuming a one-use token');
  scenarios++;
}
{
  const f = await fixture({ noConnection: true });
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state(),
    institution_name: ' Synthetic bank ', accounts: [{ account_id: 'browser-forged-account' }], company_id: ids.otherCompany });
  assert.equal(out.status, 200);
  assert.equal(out.body.connection_id, ids.connection);
  const registers = f.rpcs('plaid_register_connection');
  assert.equal(registers.length, 2);
  assert.deepEqual(registers[0].args.p_accounts, []);
  assert.equal(registers[0].args.p_company_id, ids.company);
  assert.equal(registers[0].args.p_actor_user_id, ids.user);
  assert.equal(await core.decryptToken(registers[0].args.p_token_ciphertext, encryptionKey,
    { companyId: ids.company, itemId: 'item-1', environment: 'sandbox' }), accessToken);
  assert.ok(f.events.indexOf(registers[0]) < f.events.findIndex(event => event.fetch === '/accounts/get'));
  assert.deepEqual(registers[1].args.p_accounts, [providerAccount]);
  scenarios++;
}
for (const options of [{ accountsFail: true }, { accountRegistrationFails: true }, { wrongItem: true }]) {
  const f = await fixture({ noConnection: true, ...options });
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state() });
  assert.equal(out.status, 200);
  assert.equal(out.body.connection_id, ids.connection);
  assert.equal(out.body.account_refresh_required, true, 'saved credentials remain recoverable after account setup failure');
  assert.equal(f.records.plaid_connections.length, 1);
  assert.equal(f.calls('/item/public_token/exchange').length, 1);
  scenarios++;
}
for (const registerFailure of ['before-commit', 'after-commit']) {
  const f = await fixture({ noConnection: true, registerFailure });
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state() });
  assert.equal(out.status, registerFailure === 'after-commit' ? 200 : 503);
  if (registerFailure === 'before-commit') {
    assert.equal(out.body.code, 'connection_save_failed');
    assert.equal(f.calls('/accounts/get').length, 0);
  } else assert.equal(out.body.connection_id, ids.connection);
  assert.equal(f.calls('/item/public_token/exchange').length, 1);
  assert.equal(f.calls('/item/remove').length, registerFailure === 'before-commit' ? 1 : 0);
  scenarios++;
}
for (const options of [{ lookupFails: true }, { cleanupFails: true }]) {
  const f = await fixture({ noConnection: true, registerFailure: 'before-commit', ...options });
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state() });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, options.lookupFails ? 'connection_save_unknown' : 'connection_cleanup_unknown');
  assert.equal(f.calls('/item/remove').length, options.lookupFails ? 0 : 1, 'unavailable persistence status cannot justify revoking an Item');
  scenarios++;
}
for (const registerFailure of ['transport', 'malformed']) {
  const f = await fixture({ noConnection: true, registerFailure });
  const out = await f.request({ action: 'exchange', public_token: 'synthetic-public-token', link_state: await f.state() });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'connection_save_unknown');
  assert.equal(f.calls('/item/remove').length, 0, 'an absent read cannot rule out an in-flight registration commit');
  assert.equal(f.calls('/accounts/get').length, 0);
  scenarios++;
}
{
  const f = await fixture({ pages: [
    page({ added: [transaction('pending-1', { pending: true })], next_cursor: 'cursor-middle', has_more: true }),
    page({ added: [transaction('posted-1', { pending_transaction_id: 'pending-1' })],
      removed: [{ transaction_id: 'pending-1', account_id: providerAccount.account_id }], next_cursor: 'cursor-final' }),
  ] });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.status, 200);
  assert.equal(f.calls('/transactions/sync').length, 2);
  assert.deepEqual(f.calls('/transactions/sync').map(event => event.body.cursor), ['cursor-saved', 'cursor-middle']);
  for (const call of f.calls('/transactions/sync')) assert.equal(call.body.options.account_id, providerAccount.account_id);
  const apply = f.rpcs('plaid_apply_sync');
  assert.equal(apply.length, 1, 'cursor and all provider pages commit together');
  assert.equal(apply[0].args.p_expected_cursor, 'cursor-saved');
  assert.equal(apply[0].args.p_next_cursor, 'cursor-final');
  assert.equal(apply[0].args.p_lease_id, f.rpcs('plaid_claim_sync')[0].args.p_lease_id);
  assert.deepEqual(apply[0].args.p_added.map(tx => tx.transaction_id), ['pending-1', 'posted-1']);
  assert.deepEqual(apply[0].args.p_removed, [{ transaction_id: 'pending-1', account_id: providerAccount.account_id }]);
  assert.deepEqual(apply[0].args.p_accounts, [providerAccount]);
  assert.equal(f.records.plaid_accounts[0].cursor, 'cursor-final');
  assert.equal(f.rpcs('plaid_release_sync').length, 0);
  scenarios++;
}
for (const options of [
  { applyFails: true }, { accountsFail: true }, { accounts: [] },
  { pages: [page({ added: [transaction('foreign-1', { account_id: 'foreign-account' })] })] },
  { pages: [page({ added: [transaction('partial')], has_more: true, next_cursor: 'cursor-middle' }), { error_code: 'INSTITUTION_DOWN' }] },
]) {
  const f = await fixture(options);
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.ok(out.status >= 400);
  assert.equal(f.records.plaid_accounts[0].cursor, 'cursor-saved', 'failed cycles retain the committed cursor');
  assert.equal(f.rpcs('plaid_release_sync').length, 1);
  assert.equal(f.rpcs('plaid_release_sync')[0].args.p_lease_id, f.rpcs('plaid_claim_sync')[0].args.p_lease_id);
  if (!options.applyFails) assert.equal(f.rpcs('plaid_apply_sync').length, 0);
  scenarios++;
}
{
  const f = await fixture({ claimFails: true });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.ok(out.status >= 400);
  assert.equal(f.events.filter(event => event.fetch).length, 0, 'losing the lease does not contact Plaid');
  assert.equal(f.rpcs('plaid_release_sync').length, 0, 'a request cannot release another request\'s lease');
  scenarios++;
}
{
  const f = await fixture({ applyFails: true, releaseFails: true });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'sync_recovery_required');
  scenarios++;
}
for (const providerError of ['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN']) {
  const f = await fixture({ providerError });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.body.code, providerError);
  assert.equal(f.rpcs('plaid_release_sync')[0].args.p_error_code, providerError);
  assert.equal(f.events.filter(event => event.op === 'update').length, 0, 'atomic SQL release owns error status without undoing a concurrent pause');
  assert.equal(f.rpcs('plaid_apply_sync').length, 0);
  scenarios++;
}
{
  const f = await fixture({ connection: { status: 'login_required' } });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.status, 200);
  assert.equal(f.rpcs('plaid_apply_sync').length, 1, 'manual sync can resume a repaired Item');
  scenarios++;
}
for (const claim of [{ provider_account_id: 'another-account' }, { connection_id: 'another-connection' }]) {
  const f = await fixture({ claim });
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.ok(out.status >= 400);
  assert.equal(f.calls('/accounts/get').length, 0);
  assert.equal(f.rpcs('plaid_release_sync').length, 1, 'a rejected acquired claim is released');
  assert.equal(f.rpcs('plaid_release_sync')[0].args.p_lease_id, f.rpcs('plaid_claim_sync')[0].args.p_lease_id);
  scenarios++;
}
for (const stateClaims of [{ companyId: ids.otherCompany, connectionId: ids.connection }, { connectionId: null }]) {
  const f = await fixture({ connection: { status: 'disconnected' } });
  const out = await f.request({ action: 'refresh_accounts', connection_id: ids.connection, resume: true,
    link_state: await f.state(stateClaims) });
  assert.ok(out.status >= 400);
  assert.equal(f.calls('/accounts/get').length, 0);
  assert.equal(f.rpcs('plaid_register_connection').length, 0);
  scenarios++;
}
for (const repairRace of [false, true]) {
  const f = await fixture({ connection: { status: 'disconnected' }, repairRace });
  const out = await f.request({ action: 'refresh_accounts', connection_id: ids.connection, resume: true,
    link_state: await f.state({ connectionId: ids.connection }) });
  assert.equal(out.status, repairRace ? 502 : 200);
  assert.equal(f.rpcs('plaid_register_connection').length, repairRace ? 0 : 1);
  const update = f.events.find(event => event.op === 'update');
  assert.ok(update.filters.some(([key, value]) => key === 'updated_at' && value === '2026-09-01T00:00:00Z'));
  assert.equal(f.calls('/item/public_token/exchange').length, 0, 'update Link retains its existing access token');
  scenarios++;
}
{
  const f = await fixture({ connection: { status: 'disconnected' } });
  const out = await f.request({ action: 'refresh_accounts', connection_id: ids.connection });
  assert.equal(out.status, 409);
  assert.equal(f.calls('/accounts/get').length, 0);
  scenarios++;
}
for (const options of [{ connection: { status: 'disconnected' } }, { account: { source_id: null } }]) {
  const f = await fixture(options);
  const out = await f.request({ action: 'sync', account_id: ids.account });
  assert.equal(out.status, 409);
  assert.equal(f.rpcs('plaid_claim_sync').length, 0);
  scenarios++;
}
for (const [body, options, service] of [
  [{ action: 'sync_background', account_id: ids.account }, {}, false],
  [{ action: 'sync_background', account_id: ids.account }, {}, true],
  [{ action: 'link_token' }, { config: { PLAID_BACKGROUND_SYNC_ENABLED: 'true' } }, true],
  [{ action: 'sync_background', account_id: ids.account }, { config: { PLAID_BACKGROUND_SYNC_ENABLED: 'true' }, connection: { status: 'login_required' } }, true],
]) {
  const f = await fixture(options);
  const out = await f.request(body, service ? { headers: { Authorization: 'Bearer synthetic-service-key' } } : {});
  assert.ok([403, 409].includes(out.status));
  assert.equal(f.rpcs('plaid_claim_sync').length, 0);
  scenarios++;
}
{
  const f = await fixture({ config: { PLAID_BACKGROUND_SYNC_ENABLED: 'true' } });
  const out = await f.request({ action: 'sync_background', account_id: ids.account }, { headers: { Authorization: 'Bearer synthetic-service-key' } });
  assert.equal(out.status, 200);
  assert.equal(f.events.filter(event => event.auth || event.permission).length, 0);
  assert.equal(f.rpcs('plaid_apply_sync').length, 1);
  scenarios++;
}
{
  const f = await fixture({ connection: { environment: 'production' } });
  const out = await f.request({ action: 'link_token', connection_id: ids.connection });
  assert.equal(out.status, 409);
  assert.equal(f.events.filter(event => event.fetch).length, 0);
  scenarios++;
}
for (const options of [{ providerError: `UNRECOGNIZED_${accessToken}` }, { networkFails: true },
  { config: { PLAID_ENVIRONMENT: 'https://untrusted.test' } }, { config: { PLAID_SECRET: '' } }]) {
  const f = await fixture(options);
  const out = await f.request({ action: 'link_token' });
  assert.ok(out.status >= 400);
  assert.equal(JSON.stringify(out.body).includes('private'), false);
  scenarios++;
}
{
  const f = await fixture();
  const out = await f.request({ action: 'disconnect', connection_id: ids.connection });
  assert.equal(out.status, 200);
  assert.equal(out.body.paused, true);
  assert.equal(f.records.plaid_connections[0].status, 'disconnected');
  assert.equal(f.calls('/item/remove').length, 0, 'pause is explicitly local and preserves provider credentials');
  scenarios++;
}
{
  const f = await fixture();
  const malformed = '12345678-' + '-'.repeat(27);
  const out = await f.request({ action: 'sync', account_id: malformed });
  assert.equal(out.status, 400);
  assert.equal(f.events.filter(event => event.rpc === 'plaid_claim_sync').length, 0);
  scenarios++;
}
{
  const f = await fixture({ connection: {history_days_requested:180} });
  const out=await f.request({action:'history_preview',account_id:ids.account});
  assert.equal(out.status,200);assert.equal(out.body.history_days_requested,180);
  assert.equal(f.calls('/transactions/sync')[0].body.cursor,undefined);
  assert.equal(f.records.plaid_accounts[0].cursor,'cursor-saved');
  assert.equal(f.rpcs('plaid_apply_sync').length,0);assert.equal(f.rpcs('plaid_claim_sync').length,0);
  assert.equal(f.events.filter(e=>e.op==='update').length,0);
  scenarios++;
}
{
  const f=await fixture({account:{sync_lease_expires_at:'2099-01-01T00:00:00Z'}});
  const out=await f.request({action:'history_preview',account_id:ids.account});
  assert.equal(out.status,409);assert.equal(f.calls('/transactions/sync').length,0);
  assert.equal(f.rpcs('plaid_claim_sync').length,0);scenarios++;
}
{
  const f=await fixture();
  const out=await f.request({action:'exchange',public_token:'public-token',link_state:await f.state({daysRequested:180})});
  assert.equal(out.status,200);assert.equal(f.records.plaid_connections[0].history_days_requested,180);
  scenarios++;
}
if (!selectedMutation) {
  for (const mutation of Object.keys(mutations)) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, PLAID_HANDLER_MUTATION: mutation }, encoding: 'utf8', timeout: 30000,
    });
    assert.notEqual(result.status, 0, `suite must fail with deliberate ${mutation} regression`);
    assert.match(result.stderr, /AssertionError/, `mutation ${mutation} must fail an assertion, not crash the harness`);
  }
}
console.log(`plaid-finance-handler: ${scenarios} executed scenarios passed${selectedMutation ? '' : `; ${Object.keys(mutations).length} deliberate regressions rejected`}`);
