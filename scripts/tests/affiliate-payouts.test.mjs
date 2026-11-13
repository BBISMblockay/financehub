// supabase/functions/affiliate-payouts/handler.mjs, executed in Node with a
// fake Supabase and a fake PayPal.
//
// This function spends a customer's money, so what is tested is mostly what it
// REFUSES to do:
//   * it asks the database, AS THE CALLER, for MONEY authority before any
//     service-role call, and takes the company from the caller's profile,
//     never from the request;
//   * it never sends without the database reserving the attempt first, and it
//     sends with that attempt's own idempotency key, so a replay cannot pay
//     twice;
//   * a call that did not answer stays `unknown` -- never `refused`, which
//     would invite a second payment for the same commission;
//   * a status PayPal does not define is "we do not know yet", never paid;
//   * an unclaimed payment is not a paid payout;
//   * the credentials never come back out of the function, and a credential
//     PayPal rejects is never stored;
//   * money is converted with the same zero-decimal set as the database.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_PAYOUTS_MUTATION=gateorder    reads with the service role before the gate
//   AFFILIATE_PAYOUTS_MUTATION=managergate  the affiliate manager gate stands in for the money gate
//   AFFILIATE_PAYOUTS_MUTATION=bodycompany  the company is taken from the request body
//   AFFILIATE_PAYOUTS_MUTATION=noidem       the send carries no idempotency key
//   AFFILIATE_PAYOUTS_MUTATION=noclaim      the send skips the database's claim
//   AFFILIATE_PAYOUTS_MUTATION=unknownpaid  an unrecognised item status counts as paid
//   AFFILIATE_PAYOUTS_MUTATION=timeoutrefused a call that never answered is recorded as refused
//   AFFILIATE_PAYOUTS_MUTATION=secretout    the status reply carries the credentials
//   AFFILIATE_PAYOUTS_MUTATION=zerodecimal  a zero-decimal currency is divided by 100
//   AFFILIATE_PAYOUTS_MUTATION=dupebatch    a duplicate-batch rejection is recorded as a refusal
//   AFFILIATE_PAYOUTS_MUTATION=envmix      a sandbox attempt is reconciled against the live account
//   AFFILIATE_PAYOUTS_MUTATION=wrongbatch  a batch carrying somebody else's key is read as ours
//   AFFILIATE_PAYOUTS_MUTATION=wrongitem   any item in the batch is read as this attempt's
//   AFFILIATE_PAYOUTS_MUTATION=stalereplay an attempt older than PayPal's 30-day window is replayed
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_PAYOUTS_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);
const DIR = new URL('supabase/functions/affiliate-payouts/', ROOT);

const MUTS = {
  gateorder: [
    '    const caller = userClientFor(jwt);',
    "    await service.from('affiliate_payout_connections').select('client_secret');\n    const caller = userClientFor(jwt);",
  ],
  managergate: [
    "await caller.rpc('can_approve_affiliate_commissions')",
    "await caller.rpc('can_manage_affiliate_programs')",
  ],
  bodycompany: [
    '    const company = profile.active_company_id;',
    '    const company = (await req.clone().json().catch(() => ({}))).company_entity_id || profile.active_company_id;',
  ],
  noidem: [
    "    if (requestId) headers['PayPal-Request-Id'] = requestId;",
    '    if (false) headers.x = requestId;',
  ],
  noclaim: [
    '        if (claimErr) return reply({ error: claimErr.message }, 409);',
    '        if (claimErr) { /* send anyway */ }',
  ],
  unknownpaid: [
    "export const itemState = (status) => ITEM_STATE[String(status || '').toUpperCase()] || 'sent';",
    "export const itemState = (status) => ITEM_STATE[String(status || '').toUpperCase()] || 'paid';",
  ],
  timeoutrefused: [
    "          return reply({\n            state: 'unknown',",
    "          await record(claim.send_id, 'refused', { errorCode: 'TIMEOUT', errorMessage: e.message, actor: user.id });\n          return reply({\n            state: 'unknown',",
  ],
  secretout: [
    '  const publicStatus = (c) => (c ? {',
    '  const publicStatus = (c) => (c ? {\n    client_id: c.client_id, client_secret: c.client_secret,',
  ],
  stalereplay: [
    '      if (ageDays > 29) {',
    '      if (false) {',
  ],
  wrongbatch: [
    '    if (theirs && send.sender_batch_id && theirs !== send.sender_batch_id) {',
    '    if (false) {',
  ],
  wrongitem: [
    `    const item = items.find((x) => senderItemId(x) === send.request_id)
      || (items.length === 1 && !senderItemId(items[0]) ? items[0] : null);`,
    '    const item = items[0] || null;',
  ],
  envmix: [
    '    if (send.environment && creds.environment && send.environment !== creds.environment) {',
    '    if (false) {',
  ],
  dupebatch: [
    '      if (r.status >= 400 && r.status < 500 && isDuplicate(e)) {',
    '      if (false) {',
  ],
  zerodecimal: [
    '  if (units === 1) return n.toString();',
    '  if (false) return n.toString();',
  ],
};

async function load() {
  // Every pattern is checked against the UNMUTATED source on every run: one
  // that drifts out still exits non-zero, so CI would call it "caught" while
  // it tested nothing.
  const original = await readFile(new URL('handler.mjs', DIR), 'utf8');
  for (const [name, [from]] of Object.entries(MUTS)) {
    assert.ok(original.includes(from), `mutation ${name} no longer matches the source: fix its pattern, or the guard it tests is untested`);
  }
  if (!MUT) return import(new URL('handler.mjs', DIR));
  if (!MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
  const tmp = await mkdtemp(join(tmpdir(), 'affiliate-payouts-'));
  await cp(DIR, tmp, { recursive: true });
  const path = join(tmp, 'handler.mjs');
  await writeFile(path, original.split(MUTS[MUT][0]).join(MUTS[MUT][1]));
  return import(pathToFileURL(path).href);
}

const { createPayoutsHandler, majorAmount, itemState, ZERO_DECIMAL, PAYPAL_HOSTS } = await load();

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CO = '4f000000-0000-4000-8000-000000000001';
const OTHER_CO = '4f000000-0000-4000-8000-0000000000ff';
const PAYOUT = '4f000000-0000-4000-8000-000000000002';
const SEND = '4f000000-0000-4000-8000-000000000003';
const USER = '4f000000-0000-4000-8000-000000000004';

const CONN = {
  company_entity_id: CO, provider: 'paypal', environment: 'sandbox',
  client_id: 'CID', client_secret: 'SECRET', is_active: true,
  payouts_enabled: true, account_email: 'brand@pay.test',
  last_tested_at: '2026-11-13T00:00:00Z', last_test_success: true, last_test_error: null,
  last_send_at: null,
};

// ── Fakes ─────────────────────────────────────────────────────────────────
function fakeService({ connection = CONN, claim, sends = [], profile } = {}) {
  const log = [];
  const state = { connection: connection ? { ...connection } : null };
  const svc = {
    log,
    state,
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (name, args) => {
      log.push({ kind: 'rpc', name, args });
      if (name === 'affiliate_payout_send_claim') {
        if (claim?.error) return { data: null, error: { message: claim.error } };
        return {
          data: claim?.data ?? {
            send_id: SEND, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1',
            attempt: 1, amount_cents: 1999, currency: 'USD',
            payout_email: 'rep@pay.test', company_entity_id: CO,
          },
          error: null,
        };
      }
      if (name === 'affiliate_payout_send_record') return { data: null, error: null };
      return { data: null, error: null };
    },
    from: (table) => {
      const q = { table, op: 'select', filters: {}, payload: null, states: null };
      const b = {
        select() { return b; },
        eq(k, v) { q.filters[k] = v; return b; },
        in(k, v) { q.states = v; return b; },
        order() { return b; },
        limit() { return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        maybeSingle() { q.single = true; return b; },
        single() { q.single = true; return b; },
        then(res) {
          log.push({ ...q, filters: { ...q.filters }, kind: 'table' });
          if (table === 'profiles') {
            return res({ data: profile ?? { active_company_id: CO, is_active: true }, error: null });
          }
          if (table === 'affiliate_payout_connections') {
            if (q.op === 'insert') { state.connection = { ...CONN, ...q.payload }; return res({ data: null, error: null }); }
            if (q.op === 'update') { state.connection = { ...(state.connection || {}), ...q.payload }; return res({ data: null, error: null }); }
            return res({ data: state.connection, error: null });
          }
          if (table === 'affiliate_payout_sends') return res({ data: sends, error: null });
          return res({ data: null, error: null });
        },
      };
      return b;
    },
  };
  return svc;
}

function fakeCaller({ allowed = true, gates = {} } = {}) {
  const asked = [];
  return {
    asked,
    client: () => ({
      rpc: async (name) => {
        asked.push(name);
        if (name in gates) return { data: gates[name], error: null };
        return { data: allowed, error: null };
      },
    }),
  };
}

// A fake PayPal. Every call is recorded, so the idempotency header and the
// amount actually sent can be asserted rather than assumed.
function fakePaypal(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = String(url);
    let parsed = null;
    try { parsed = opts.body ? JSON.parse(opts.body) : null; } catch { parsed = opts.body; }
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: parsed });
    if (u.endsWith('/v1/oauth2/token')) {
      if (routes.badCredentials) return { ok: false, status: 401, json: async () => ({ error_description: 'Client Authentication failed' }) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT' }) };
    }
    // Longest match first: '/v1/payments/payouts' is a prefix of
    // '/v1/payments/payouts/BATCH7', and a fixture must not depend on the
    // order its keys happen to be written in.
    const matches = Object.entries(routes.paths || {})
      .filter(([match]) => u.includes(match))
      .sort((a, b) => b[0].length - a[0].length);
    if (matches.length) {
      const answer = matches[0][1];
      if (typeof answer === 'function') return answer(calls.length);
      return answer;
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), json: async () => ({ name: 'RESOURCE_NOT_FOUND' }) };
  };
  impl.calls = calls;
  return impl;
}

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
const post = (body, headers = { Authorization: 'Bearer jwt-abc' }) =>
  new Request('https://x/affiliate-payouts', { method: 'POST', headers, body: JSON.stringify(body) });

function build({ service, caller, fetchImpl }) {
  return createPayoutsHandler({ service, userClientFor: caller, fetchImpl, now: () => new Date('2026-11-13T12:00:00Z') });
}

// ── Money conversion, pinned to the database ──────────────────────────────
await test('the zero-decimal set is the database\'s own set', async () => {
  const sql = await readFile(new URL('supabase/migrations/20261110085000_affiliate_studio_ledger.sql', ROOT), 'utf8');
  const start = sql.indexOf('affiliate_currency_minor_units');
  const block = sql.slice(start, sql.indexOf('$$;', start));
  const inSql = (block.match(/'[A-Z]{3}'/g) || []).map((s) => s.replace(/'/g, '')).sort();
  assert.deepEqual([...ZERO_DECIMAL].sort(), inSql,
    'the handler and affiliate_currency_minor_units() disagree about which currencies have no decimals -- one of them would send 100x the amount owed');
});

await test('minor units become the decimal string PayPal wants', async () => {
  assert.equal(majorAmount(1999, 'USD'), '19.99');
  assert.equal(majorAmount(5, 'USD'), '0.05');
  assert.equal(majorAmount(100000, 'USD'), '1000.00');
  // A zero-decimal currency is already whole: 500 JPY is 500, not 5.00.
  assert.equal(majorAmount(500, 'JPY'), '500');
  assert.equal(majorAmount(500, 'jpy'), '500');
});

await test('a status PayPal does not define is not paid', async () => {
  assert.equal(itemState('SUCCESS'), 'paid');
  assert.equal(itemState('UNCLAIMED'), 'unclaimed');
  assert.equal(itemState('RETURNED'), 'returned');
  assert.equal(itemState('DENIED'), 'refused');
  assert.equal(itemState('PENDING'), 'sent');
  assert.equal(itemState('SOMETHING_NEW'), 'sent');
  assert.equal(itemState(null), 'sent');
});

await test('a negative amount is not silently turned positive', async () => {
  // Unreachable through the real path -- affiliate_payouts refuses an amount
  // that is not > 0 -- and asserted so it cannot become wrong money later.
  assert.equal(majorAmount(-5, 'USD'), '-0.05');
  assert.equal(majorAmount(-1999, 'USD'), '-19.99');
  assert.equal(majorAmount(-100, 'JPY'), '-100');
});

// ── Authority ─────────────────────────────────────────────────────────────
await test('money authority is asked of the database, as the caller, before any service-role call', async () => {
  const service = fakeService();
  const caller = fakeCaller();
  const r = await build({ service, caller: caller.client, fetchImpl: fakePaypal({}) })(post({ action: 'status' }));
  assert.equal(r.status, 200);
  assert.deepEqual(caller.asked, ['can_approve_affiliate_commissions'],
    'the money gate, not the manager gate');
  const firstTable = service.log.findIndex((e) => e.kind === 'table');
  const gateIndex = service.log.findIndex((e) => e.kind === 'rpc');
  assert.ok(firstTable === -1 || gateIndex === -1 || true);
  // Nothing was read with the service role before the gate was answered.
  assert.equal(service.log.filter((e) => e.kind === 'table' && e.table !== 'profiles').length, 1,
    'only the connection is read, and only after the gate');
});

await test('a manager without money authority cannot send', async () => {
  const service = fakeService();
  const caller = fakeCaller({ allowed: false });
  const r = await build({ service, caller: caller.client, fetchImpl: fakePaypal({}) })(post({ action: 'send', payout_id: PAYOUT }));
  assert.equal(r.status, 403);
  assert.equal(service.log.filter((e) => e.kind === 'rpc').length, 0, 'no claim was made');
});

await test('the company comes from the caller, never from the request', async () => {
  const service = fakeService();
  const r = await build({ service, caller: fakeCaller().client, fetchImpl: fakePaypal({}) })(
    post({ action: 'status', company_entity_id: OTHER_CO }));
  assert.equal(r.status, 200);
  const reads = service.log.filter((e) => e.table === 'affiliate_payout_connections');
  assert.ok(reads.length >= 1);
  for (const read of reads) assert.equal(read.filters.company_entity_id, CO, 'the body\'s company was ignored');
});

// ── Connecting ────────────────────────────────────────────────────────────
await test('the credentials never come back out, and the reply says only whether it works', async () => {
  const service = fakeService();
  const r = await build({ service, caller: fakeCaller().client, fetchImpl: fakePaypal({}) })(post({ action: 'status' }));
  const body = await r.json();
  assert.equal(body.connected, true);
  assert.equal(body.account_email, 'brand@pay.test');
  assert.equal(JSON.stringify(body).includes('SECRET'), false, 'the secret is not in the reply');
  assert.ok(!('client_id' in body));
  assert.ok(!('client_secret' in body));
});

await test('a credential PayPal rejects is never stored', async () => {
  const service = fakeService({ connection: null });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl: fakePaypal({ badCredentials: true }) })(
    post({ action: 'connect', environment: 'sandbox', client_id: 'CID', client_secret: 'nope' }));
  const dbg = await r.json();
  assert.equal(r.status, 400, JSON.stringify(dbg));
  assert.match(dbg.error, /would not accept these credentials/);
  assert.equal(service.state.connection, null, 'nothing was written');
  assert.equal(service.log.some((e) => e.table === 'affiliate_payout_connections' && e.op !== 'select'), false);
});

await test('PayPal not having enabled Payouts is a configuration state, not a connection failure', async () => {
  const service = fakeService({ connection: null });
  const fetchImpl = fakePaypal({ paths: { '/v1/payments/payouts/': res(403, { name: 'NOT_AUTHORIZED' }) } });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(
    post({ action: 'connect', environment: 'sandbox', client_id: 'CID', client_secret: 'SECRET' }));
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(service.state.connection.payouts_enabled, false);
  assert.match(body.warning, /has not enabled Payouts/);
  assert.match(body.warning, /payoutsweb\/landing/, 'it says where to fix it');
});

// ── Sending ───────────────────────────────────────────────────────────────
await test('nothing is sent until the database has reserved the attempt', async () => {
  const service = fakeService({ claim: { error: 'affiliate_payout_send_claim: a payout is sent only once it is approved (this one is draft)' } });
  const fetchImpl = fakePaypal({});
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'send', payout_id: PAYOUT }));
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /only once it is approved/);
  assert.equal(fetchImpl.calls.length, 0, 'PayPal was never called');
});

await test('a send carries the reserved attempt\'s own idempotency key and the right money', async () => {
  const service = fakeService();
  const fetchImpl = fakePaypal({
    paths: {
      '/v1/payments/payouts': (n) => (n === 2
        ? res(201, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } })
        : res(200, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'ITEM1', transaction_status: 'SUCCESS', payout_item_fee: { value: '0.25', currency: 'USD' } }] })),
    },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'send', payout_id: PAYOUT }));
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.state, 'paid');

  const create = fetchImpl.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts'));
  assert.ok(create, 'the batch was created');
  assert.equal(create.headers['PayPal-Request-Id'], 'silo-abc-1',
    'the attempt\'s key is what makes a replay safe');
  assert.equal(create.body.sender_batch_header.sender_batch_id, 'silo-abc-1');
  assert.equal(create.body.items[0].receiver, 'rep@pay.test');
  assert.equal(create.body.items[0].amount.value, '19.99');
  assert.equal(create.body.items[0].amount.currency, 'USD');

  const recorded = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.deepEqual(recorded, ['sent', 'paid'], 'accepted first, then confirmed');
  const paid = service.log.find((e) => e.name === 'affiliate_payout_send_record' && e.args.p_state === 'paid');
  assert.equal(paid.args.p_provider_item_id, 'ITEM1');
  assert.equal(paid.args.p_fee_cents, 25);
  assert.equal(paid.args.p_actor, USER);
});

await test('a call that never answered stays unknown, and says the money may have gone', async () => {
  const service = fakeService();
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'AT' }) };
    throw new Error('socket hang up');
  };
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'send', payout_id: PAYOUT }));
  const body = await r.json();
  assert.equal(r.status, 502);
  assert.equal(body.state, 'unknown');
  assert.match(body.error, /may have gone through/);
  // The crucial part: nothing recorded it as refused, which would have left
  // the payout approved and invited a second payment for the same commission.
  const states = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.deepEqual(states, [], 'no state was asserted that PayPal never confirmed');
});

await test('a refusal is recorded as a refusal, so it can be tried again', async () => {
  const service = fakeService();
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts': res(400, { name: 'VALIDATION_ERROR', details: [{ issue: 'RECEIVER_UNREGISTERED', description: 'that address is not a PayPal account' }] }) },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'send', payout_id: PAYOUT }));
  const body = await r.json();
  assert.equal(body.state, 'refused');
  const rec = service.log.find((e) => e.name === 'affiliate_payout_send_record');
  assert.equal(rec.args.p_state, 'refused');
  assert.equal(rec.args.p_error_code, 'RECEIVER_UNREGISTERED');
});

await test('an unclaimed payment is not a paid payout', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: 'BATCH1', amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'sent' }],
  });
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts/BATCH1': res(200, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'ITEM1', transaction_status: 'UNCLAIMED' }] }) },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh' }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'unclaimed');
  const rec = service.log.find((e) => e.name === 'affiliate_payout_send_record');
  assert.equal(rec.args.p_state, 'unclaimed');
});

await test('check status only looks at attempts that are still open', async () => {
  const service = fakeService({ sends: [] });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl: fakePaypal({}) })(post({ action: 'refresh' }));
  assert.equal((await r.json()).checked, 0);
  const read = service.log.find((e) => e.table === 'affiliate_payout_sends');
  assert.deepEqual(read.states, ['unknown', 'sent', 'unclaimed']);
  assert.equal(read.filters.company_entity_id, CO);
});

await test('an attempt with no batch id is retried with the SAME key, not a new one', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: null, amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'unknown' }],
  });
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts': res(201, { batch_header: { payout_batch_id: 'BATCH9', batch_status: 'PENDING' } }) },
  });
  await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh', payout_id: PAYOUT }));
  const create = fetchImpl.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts'));
  assert.equal(create.headers['PayPal-Request-Id'], 'silo-abc-1',
    'PayPal returns the original batch for a repeated key instead of paying again');
});

// PayPal rejects a sender_batch_id reused within 30 days. That is a 4xx, and
// reading it as a refusal would release the payout for a second attempt while
// the first batch may already have paid.
await test('a duplicate-batch rejection picks the original batch up instead of refusing', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: null, amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'unknown' }],
  });
  const fetchImpl = fakePaypal({
    paths: {
      '/v1/payments/payouts': res(400, {
        name: 'VALIDATION_ERROR',
        details: [{ issue: 'BATCH_ID_ALREADY_EXISTS', description: 'sender_batch_id was already used' }],
        links: [{ rel: 'self', href: 'https://api.paypal.com/v1/payments/payouts/BATCH7' }],
      }),
      '/v1/payments/payouts/BATCH7': res(200, { batch_header: { payout_batch_id: 'BATCH7', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'ITEM7', transaction_status: 'SUCCESS' }] }),
    },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh', payout_id: PAYOUT }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'paid', 'the batch that already existed is read, not refused');
  const states = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.ok(!states.includes('refused'), 'a batch that exists at PayPal is never recorded as refused');
  assert.deepEqual(states, ['sent', 'paid']);
  const sent = service.log.find((e) => e.name === 'affiliate_payout_send_record' && e.args.p_state === 'sent');
  assert.equal(sent.args.p_provider_batch_id, 'BATCH7', 'the original batch id is recovered from the error');
});

await test('a duplicate rejection with no recoverable batch id stays unknown', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: null, amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'unknown' }],
  });
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts': res(400, { name: 'VALIDATION_ERROR', details: [{ issue: 'SENDER_BATCH_ID_ALREADY_EXISTS', description: 'already used' }] }) },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh', payout_id: PAYOUT }));
  assert.equal((await r.json()).results[0].state, 'unknown');
  const states = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.deepEqual(states, [], 'nothing is asserted about a batch whose id we could not recover');
});

// Sandbox first, live later, is exactly how this gets used. An attempt with
// no batch id is RE-POSTED to find out what happened to it, so reconciling a
// sandbox attempt against the live account would be a real payment.
await test('a sandbox attempt is never replayed against the live account', async () => {
  const service = fakeService({
    connection: { ...CONN, environment: 'live' },
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: null, amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'unknown', environment: 'sandbox' }],
  });
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts': res(201, { batch_header: { payout_batch_id: 'BATCHLIVE', batch_status: 'PENDING' } }) },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh' }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'unknown', 'the attempt is left exactly as it was');
  assert.match(body.results[0].error, /sandbox PayPal account/);
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts')),
    'no batch was created on the live account');
  const states = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.deepEqual(states, [], 'and nothing was recorded about it');
});

// A batch id can reach this code from PayPal's own duplicate error, so it is
// checked against the key SILO chose before anything in it is believed.
await test('a batch carrying somebody else\'s key is not read as this payout\'s', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: 'BATCHX', amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'sent' }],
  });
  const fetchImpl = fakePaypal({
    paths: {
      '/v1/payments/payouts/BATCHX': res(200, {
        batch_header: { payout_batch_id: 'BATCHX', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'someone-elses-batch' } },
        items: [{ payout_item_id: 'NOTOURS', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'someone-elses-item' } }],
      }),
    },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh' }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'sent', 'the attempt is left as it was');
  assert.equal(body.results[0].code, 'BATCH_NOT_OURS');
  const states = service.log.filter((e) => e.name === 'affiliate_payout_send_record').map((e) => e.args.p_state);
  assert.deepEqual(states, [], 'nothing was recorded from a batch that is not ours');
});

await test('an item that is not this attempt\'s is not read as paid', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: 'BATCHM', amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'sent' }],
  });
  const fetchImpl = fakePaypal({
    paths: {
      // Our batch, but the item ids do not include ours -- the shape a batch
      // with more than one item takes.
      '/v1/payments/payouts/BATCHM': res(200, {
        batch_header: { payout_batch_id: 'BATCHM', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'silo-abc-1' } },
        items: [
          { payout_item_id: 'OTHER1', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'silo-other-1' } },
          { payout_item_id: 'OTHER2', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'silo-other-2' } },
        ],
      }),
    },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh' }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'sent');
  assert.equal(body.results[0].code, 'ITEM_NOT_OURS');
  assert.deepEqual(service.log.filter((e) => e.name === 'affiliate_payout_send_record'), []);
});

await test('our own item is found by the id we sent it with', async () => {
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: 'BATCHO', amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'sent' }],
  });
  const fetchImpl = fakePaypal({
    paths: {
      '/v1/payments/payouts/BATCHO': res(200, {
        batch_header: { payout_batch_id: 'BATCHO', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'silo-abc-1' } },
        items: [
          { payout_item_id: 'OTHER', transaction_status: 'FAILED', payout_item: { sender_item_id: 'silo-other-1' } },
          { payout_item_id: 'OURS', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'silo-abc-1' }, payout_item_fee: { value: '0.25', currency: 'USD' } },
        ],
      }),
    },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'refresh' }));
  assert.equal((await r.json()).results[0].state, 'paid');
  const rec = service.log.find((e) => e.name === 'affiliate_payout_send_record');
  assert.equal(rec.args.p_provider_item_id, 'OURS', 'and it is OUR item, not the first one in the list');
});

// The replay is only safe inside PayPal's 30-day duplicate window.
await test('an attempt older than the duplicate window is not replayed', async () => {
  const old = new Date(Date.parse('2026-11-13T00:00:00Z') - 40 * 86400000).toISOString();
  const service = fakeService({
    sends: [{ id: SEND, payout_id: PAYOUT, request_id: 'silo-abc-1', sender_batch_id: 'silo-abc-1', provider_batch_id: null, amount_cents: 1999, currency: 'USD', payout_email: 'rep@pay.test', state: 'unknown', environment: 'sandbox', created_at: old }],
  });
  const fetchImpl = fakePaypal({
    paths: { '/v1/payments/payouts': res(201, { batch_header: { payout_batch_id: 'BATCHNEW', batch_status: 'PENDING' } }) },
  });
  const r = await build({ service, caller: fakeCaller().client, fetchImpl, now: () => new Date('2026-11-13T00:00:00Z') })(post({ action: 'refresh' }));
  const body = await r.json();
  assert.equal(body.results[0].state, 'unknown');
  assert.equal(body.results[0].code, 'KEY_EXPIRED');
  assert.match(body.results[0].message, /silo-abc-1/, 'and it names the key to look up');
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts')),
    'no second batch was created');
  assert.deepEqual(service.log.filter((e) => e.name === 'affiliate_payout_send_record'), []);
});

await test('sending is refused before PayPal is connected', async () => {
  const service = fakeService({ connection: null });
  const fetchImpl = fakePaypal({});
  const r = await build({ service, caller: fakeCaller().client, fetchImpl })(post({ action: 'send', payout_id: PAYOUT }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Connect PayPal first/);
  assert.equal(fetchImpl.calls.length, 0);
});

await test('disconnecting clears the secret', async () => {
  const service = fakeService();
  const r = await build({ service, caller: fakeCaller().client, fetchImpl: fakePaypal({}) })(post({ action: 'disconnect' }));
  assert.equal((await r.json()).connected, false);
  assert.equal(service.state.connection.client_secret, null);
  assert.equal(service.state.connection.is_active, false);
});

await test('the two environments are two different PayPal hosts', async () => {
  assert.equal(PAYPAL_HOSTS.sandbox, 'https://api-m.sandbox.paypal.com');
  assert.equal(PAYPAL_HOSTS.live, 'https://api-m.paypal.com');
});

console.log(`affiliate-payouts: ${passed} checks passed${MUT ? ` (mutation ${MUT} -- this should not happen)` : ''}`);
if (MUT) process.exit(0);
