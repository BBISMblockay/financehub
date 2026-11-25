// The scheduled QuickBooks ledger read-back: who may call it, that the caller
// chooses nothing, that QuickBooks is only ever READ, and that every outcome
// is recorded so the runner cannot spin. Real handler, real OIDC verifier,
// signed test tokens; a fake database and a fake QuickBooks.
//
// Run: node --import ./scripts/tests/plaid-oidc/register.mjs --test scripts/tests/quickbooks-ledger-mirror-scheduled.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'npm:jose@6.2.12';
import { verifySchedulerIdentity, WORKFLOWS } from '../../supabase/functions/quickbooks-ledger-mirror-scheduled/oidc.mjs';
import { createLedgerMirrorHandler, MONTHS_BACK } from '../../supabase/functions/quickbooks-ledger-mirror-scheduled/handler.mjs';
import { runLedgerMirror, MAX_CALLS, OWNER_SIDE } from '../quickbooks-ledger-mirror.mjs';

const keys = await generateKeyPair('RS256');
const audience = 'https://synthetic.supabase.co/functions/v1/quickbooks-ledger-mirror-scheduled';
const claims = { sub: 'repo:BBISMblockay/financehub:ref:refs/heads/main', repository: 'BBISMblockay/financehub',
  repository_id: '1110494889', repository_owner_id: '227868936', ref: 'refs/heads/main', ref_type: 'branch',
  workflow_ref: 'BBISMblockay/financehub/.github/workflows/quickbooks-ledger-mirror.yml@refs/heads/main',
  event_name: 'schedule', runner_environment: 'github-hosted' };
async function signed(changes = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iss: 'https://token.actions.githubusercontent.com', aud: audience,
    iat: now, nbf: now - 1, exp: now + 300, jti: 'synthetic-run', ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}
const token = await signed();

test('only the read-back workflow on main may call it', async () => {
  assert.deepEqual(WORKFLOWS, ['BBISMblockay/financehub/.github/workflows/quickbooks-ledger-mirror.yml@refs/heads/main']);
  await verifySchedulerIdentity(token, audience, keys.publicKey);
  await verifySchedulerIdentity(await signed({ event_name: 'workflow_dispatch' }), audience, keys.publicKey);
  for (const change of [
    { workflow_ref: 'BBISMblockay/financehub/.github/workflows/card-coding-prepare.yml@refs/heads/main' },
    { workflow_ref: 'BBISMblockay/financehub/.github/workflows/quickbooks-ledger-mirror.yml@refs/heads/feature' },
    { repository: 'fork/financehub' }, { repository_id: '1' }, { repository_owner_id: '2' },
    { sub: 'repo:BBISMblockay/financehub:pull_request' }, { ref: 'refs/heads/feature' }, { ref_type: 'tag' },
    { event_name: 'pull_request_target' }, { event_name: 'workflow_run' }, { runner_environment: 'self-hosted' },
    { aud: 'https://synthetic.supabase.co/functions/v1/card-coding-prepare-scheduled' }, { iss: 'https://attacker.test' }, { exp: 1 },
  ]) await assert.rejects(verifySchedulerIdentity(await signed(change), audience, keys.publicKey), undefined, JSON.stringify(change));
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifySchedulerIdentity(await signed({}, other.privateKey), audience, keys.publicKey));
});

const COMPANY = '00000000-0000-4000-8000-000000000006', CONNECTION = '00000000-0000-4000-8000-000000000007';
const WORK = { company_entity_id: COMPANY, qbo_connection_id: CONNECTION, period_start: '2026-09-01',
  read_through: '2026-09-30', accounting_basis: 'Accrual' };
const CONN = { id: CONNECTION, company_entity_id: COMPANY, realm_id: '9130', environment: 'production',
  access_token: 'live-access', refresh_token: 'live-refresh', is_active: true,
  token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  refresh_token_expires_at: new Date(Date.now() + 86400_000).toISOString() };
const REPORT = { Header: { ReportName: 'GeneralLedger' }, Rows: { Row: [] } };

function fixture({ work = WORK, conn = CONN, disabled, due = 'ok', store = { ok: true, changed: true, lines: 7 },
  storeError = false, failedError = false, quickbooks = {}, environment = 'production', secrets = true,
  mine = 'ok', myWork = { ...WORK, remaining: 3 }, noUserDb = false } = {}) {
  const events = [];
  const db = {
    rpc: async (name, args) => {
      events.push(['rpc', name, args]);
      if (name === 'quickbooks_ledger_mirror_due') {
        return due === 'ok' ? { data: work ? [work] : [], error: null } : { data: null, error: { message: 'down' } };
      }
      if (name === 'quickbooks_ledger_mirror_store') return storeError ? { data: null, error: { message: 'x' } } : { data: store, error: null };
      if (name === 'quickbooks_ledger_mirror_failed') return failedError ? { error: { message: 'x' } } : { data: null, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table) => {
      const filters = {};
      const chain = {
        select: () => chain,
        eq: (column, value) => { filters[column] = value; return chain; },
        maybeSingle: async () => { events.push(['select', table, { ...filters }]); return { data: conn, error: null }; },
        update: (patch) => ({ eq: async (column, value) => { events.push(['update', table, patch, { [column]: value }]); return { error: null }; } }),
      };
      return chain;
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    events.push(['fetch', init.method || 'GET', href, init]);
    const answer = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (href.includes('oauth.platform.intuit.com')) {
      return quickbooks.token ? quickbooks.token() : answer(200, { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600, x_refresh_token_expires_in: 8726400 });
    }
    if (href.includes('/query?')) {
      return quickbooks.accounts ? quickbooks.accounts(href) : answer(200, { QueryResponse: { Account: [{ Id: '10', AccountType: 'Bank' }, { Id: '20', AccountType: 'Income' }] } });
    }
    if (href.includes('/reports/GeneralLedger')) return quickbooks.ledger ? quickbooks.ledger(href) : answer(200, REPORT);
    throw new Error(`unexpected fetch ${href}`);
  };
  const handler = createLedgerMirrorHandler({
    env: (key) => ({ SUPABASE_URL: 'https://synthetic.supabase.co', QBO_ENVIRONMENT: environment,
      QBO_CLIENT_ID: secrets ? 'client' : '', QBO_CLIENT_SECRET: secrets ? 'secret' : '',
      QBO_LEDGER_MIRROR_DISABLED: disabled ? 'true' : '' })[key] ?? '',
    verifyIdentity: (value, aud) => verifySchedulerIdentity(value, aud, keys.publicKey),
    createDb: () => { events.push(['db']); return db; }, fetchImpl,
    // Mirror now: a client that carries the caller's own token.
    ...(noUserDb ? {} : { createUserDb: (userToken) => { events.push(['user-db', userToken]); return { rpc: async (name, args) => {
      events.push(['user-rpc', name, args]);
      if (name !== 'quickbooks_ledger_mirror_my_due') throw new Error(`unexpected user rpc ${name}`);
      return mine === 'ok' ? { data: myWork ? [myWork] : [], error: null } : { data: null, error: { message: 'Finance access is required' } };
    } }; } }),
  });
  return { events, request: (body = '{}', identity = token, method = 'POST') => handler(new Request(audience, { method,
    headers: { 'x-silo-scheduler-token': identity }, ...(method === 'POST' ? { body } : {}) })),
    person: (body = `{"since":"${SINCE}"}`, headers = { authorization: `Bearer ${USER_TOKEN}` }, method = 'POST') =>
      handler(new Request(audience, { method, headers, ...(method === 'POST' ? { body } : {}) })) };
}
const SINCE = '2026-11-25T22:00:00.000Z';
const USER_TOKEN = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
const fetches = (events) => events.filter((e) => e[0] === 'fetch');
const rpcs = (events) => events.filter((e) => e[0] === 'rpc').map((e) => e[1]);

test('nothing is read before the identity, the switch and the request shape all pass', async () => {
  for (const bad of ['', 'not-a-token', await signed({ workflow_ref: 'BBISMblockay/financehub/.github/workflows/other.yml@refs/heads/main' })]) {
    const f = fixture();
    const res = await f.request('{}', bad);
    assert.equal(res.status, 401);
    assert.deepEqual(f.events, []);
  }
  const off = fixture({ disabled: true });
  assert.equal((await off.request()).status, 403);
  assert.deepEqual(off.events, []);
  // The caller names nothing: any key at all is refused.
  for (const body of ['{"company":"x"}', '{"period_start":"2026-09-01"}', '[]', 'nope', `{"x":"${'y'.repeat(80)}"}`]) {
    const f = fixture();
    assert.equal((await f.request(body)).status, 400, body);
    assert.deepEqual(f.events, []);
  }
  const get = fixture();
  assert.equal((await get.request(undefined, token, 'GET')).status, 405);
});

test('one due month is read from QuickBooks and handed to the database whole', async () => {
  const f = fixture();
  const res = await f.request();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { done: false, ok: true, changed: true, lines: 7 });
  assert.deepEqual(rpcs(f.events), ['quickbooks_ledger_mirror_due', 'quickbooks_ledger_mirror_store']);
  assert.deepEqual(f.events.find((e) => e[1] === 'quickbooks_ledger_mirror_due')[2], { p_months_back: MONTHS_BACK, p_limit: 1 });
  // The connection is read for THIS company and THIS connection, never "the first one".
  assert.deepEqual(f.events.find((e) => e[0] === 'select')[2], { id: CONNECTION, company_entity_id: COMPANY });
  const stored = f.events.find((e) => e[1] === 'quickbooks_ledger_mirror_store')[2];
  assert.deepEqual(stored, { p_company: COMPANY, p_connection: CONNECTION, p_period_start: '2026-09-01',
    p_read_through: '2026-09-30', p_report: REPORT, p_account_types: { 10: 'Bank', 20: 'Income' } });
  const ledger = new URL(fetches(f.events).find((e) => e[2].includes('/reports/GeneralLedger'))[2]);
  assert.equal(ledger.origin + ledger.pathname, 'https://quickbooks.api.intuit.com/v3/company/9130/reports/GeneralLedger');
  assert.deepEqual(Object.fromEntries(ledger.searchParams), { start_date: '2026-09-01', end_date: '2026-09-30',
    accounting_method: 'Accrual', minorversion: '75' });
  // A live access token is used as it is: no refresh, and nothing written to the connection.
  assert.equal(fetches(f.events).some((e) => e[2].includes('oauth.platform')), false);
  assert.equal(f.events.some((e) => e[0] === 'update'), false);
});

test('QuickBooks is only ever read', async () => {
  const f = fixture({ conn: { ...CONN, token_expires_at: new Date(Date.now() - 1000).toISOString() } });
  await f.request();
  for (const [, method, href] of fetches(f.events)) {
    // The token refresh is the one POST, and it goes to Intuit's OAuth host, not the books.
    if (href.includes('oauth.platform.intuit.com')) { assert.equal(method, 'POST'); continue; }
    assert.equal(method, 'GET', href);
    assert.match(href, /\/v3\/company\/9130\/(query\?|reports\/GeneralLedger\?)/);
  }
  const source = readFileSync(new URL('../../supabase/functions/quickbooks-ledger-mirror-scheduled/handler.mjs', import.meta.url), 'utf8');
  assert.equal(/journalentry|\/batch|operation=|sparse/i.test(source), false, 'the reader must not contain a QuickBooks write');
  assert.equal(/quickbooks_journal_postings|journal_adjustments|card_import_batches/.test(source), false,
    'the reader must not touch SILO\'s postings or entries');
});

test('an expired access token is refreshed and the rotated refresh token is stored first', async () => {
  const f = fixture({ conn: { ...CONN, token_expires_at: new Date(Date.now() - 1000).toISOString() } });
  assert.deepEqual(await (await f.request()).json(), { done: false, ok: true, changed: true, lines: 7 });
  const update = f.events.find((e) => e[0] === 'update');
  assert.equal(update[1], 'quickbooks_connections');
  assert.equal(update[2].access_token, 'fresh-access');
  assert.equal(update[2].refresh_token, 'fresh-refresh');
  assert.deepEqual(update[3], { id: CONNECTION });
  const order = f.events.map((e) => (e[0] === 'fetch' ? (e[2].includes('oauth') ? 'refresh' : e[2].includes('/query?') ? 'accounts' : 'ledger') : e[0] === 'update' ? 'store-token' : null)).filter(Boolean);
  assert.deepEqual(order, ['refresh', 'store-token', 'accounts', 'ledger']);
  assert.match(fetches(f.events).find((e) => e[2].includes('/query?'))[3].headers.Authorization, /fresh-access/);
});

test('every account is asked for, active or not, across pages', async () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ Id: String(from + i), AccountType: 'Expense' }));
  const seen = [];
  const f = fixture({ quickbooks: { accounts: (href) => {
    const query = new URL(href).searchParams.get('query');
    seen.push(query);
    return new Response(JSON.stringify({ QueryResponse: { Account: seen.length === 1 ? page(1000, 1) : page(3, 1001) } }));
  } } });
  await f.request();
  assert.equal(seen.length, 2);
  assert.match(seen[0], /Active in \(true, false\) startposition 1 maxresults 1000/);
  assert.match(seen[1], /startposition 1001 maxresults 1000/);
  assert.equal(Object.keys(f.events.find((e) => e[1] === 'quickbooks_ledger_mirror_store')[2].p_account_types).length, 1003);
});

test('a read that fails is recorded on the month, and nothing is stored', async () => {
  const cases = [
    ['reconnect_required', { conn: null }],
    ['reconnect_required', { conn: { ...CONN, is_active: false } }],
    ['reconnect_required', { conn: { ...CONN, access_token: null, refresh_token: null } }],
    ['reconnect_required', { conn: { ...CONN, token_expires_at: null, refresh_token_expires_at: new Date(Date.now() - 1000).toISOString() } }],
    ['reconnect_required', { conn: { ...CONN, token_expires_at: null }, quickbooks: { token: () => new Response('{"error":"invalid_grant"}', { status: 400 }) } }],
    ['token_refresh_failed', { conn: { ...CONN, token_expires_at: null }, quickbooks: { token: () => new Response('busy', { status: 503 }) } }],
    ['not_configured', { conn: { ...CONN, token_expires_at: null }, secrets: false }],
    ['environment_mismatch', { environment: 'sandbox' }],
    ['reconnect_required', { quickbooks: { ledger: () => new Response('{}', { status: 401 }) } }],
    ['quickbooks_busy', { quickbooks: { ledger: () => new Response('{}', { status: 429 }) } }],
    ['quickbooks_read_failed', { quickbooks: { ledger: () => new Response('<html>', { status: 200 }) } }],
    ['quickbooks_read_failed', { quickbooks: { accounts: () => new Response('{}', { status: 500 }) } }],
    ['quickbooks_unreachable', { quickbooks: { ledger: () => { throw new Error('socket'); } } }],
    ['store_failed', { storeError: true }],
  ];
  for (const [code, options] of cases) {
    const f = fixture(options);
    const res = await f.request();
    assert.equal(res.status, 200, code);
    assert.deepEqual(await res.json(), { done: false, ok: false, changed: false, lines: 0, error_code: code }, code);
    const noted = f.events.find((e) => e[1] === 'quickbooks_ledger_mirror_failed');
    assert.deepEqual(noted[2], { p_company: COMPANY, p_connection: CONNECTION, p_period_start: '2026-09-01', p_error: code }, code);
    if (code !== 'store_failed') assert.equal(rpcs(f.events).includes('quickbooks_ledger_mirror_store'), false, code);
  }
});

test('a failure that cannot be recorded stops the run instead of spinning', async () => {
  const f = fixture({ failedError: true, quickbooks: { ledger: () => new Response('{}', { status: 500 }) } });
  const res = await f.request();
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error_code: 'failure_not_recorded' });
});

test('a report the database refuses is reported by code only', async () => {
  const f = fixture({ store: { ok: false, error: 'the rows of Sales do not add up to its total' } });
  const body = await (await f.request()).json();
  assert.deepEqual(body, { done: false, ok: false, changed: false, lines: 0, error_code: 'report_refused' });
  // The database already wrote the reason on the month; it is not noted twice.
  assert.equal(rpcs(f.events).includes('quickbooks_ledger_mirror_failed'), false);
});

test('nothing due ends the run, and a broken work list fails closed', async () => {
  const none = fixture({ work: null });
  assert.deepEqual(await (await none.request()).json(), { done: true });
  assert.deepEqual(fetches(none.events), []);
  const down = fixture({ due: 'down' });
  assert.equal((await down.request()).status, 503);
  for (const bad of [{ ...WORK, company_entity_id: 'x' }, { ...WORK, period_start: '09/01/2026' }, { ...WORK, read_through: null }]) {
    const f = fixture({ work: bad });
    assert.equal((await f.request()).status, 503);
    assert.deepEqual(fetches(f.events), []);
  }
});

test('no response ever carries a company, an account or a QuickBooks message', async () => {
  for (const options of [{}, { store: { ok: false, error: 'the rows of Wholesale Income do not add up' } },
    { quickbooks: { ledger: () => new Response('{"Fault":{"Error":[{"Detail":"Acme Corp realm 9130"}]}}', { status: 400 }) } }]) {
    const text = await (await fixture(options).request()).text();
    assert.equal(/9130|Acme|Wholesale|live-|fresh-|00000000-0000-4000-8000/.test(text), false, text);
  }
});

test('Mirror now: the database is asked AS the caller first, and its refusal ends everything', async () => {
  // Refused by the database (not finance, no company, a token it does not accept).
  const refused = fixture({ mine: 'down' });
  const res = await refused.person();
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error_code: 'not_allowed' });
  assert.deepEqual(refused.events.map((e) => e[0]), ['user-db', 'user-rpc']);
  assert.equal(refused.events[0][1], USER_TOKEN);
  // No way to ask as the caller: refuse, never fall back to the service role.
  const unwired = fixture({ noUserDb: true });
  assert.equal((await unwired.person()).status, 403);
  assert.deepEqual(unwired.events, []);
  // The switch stops a person too, and nothing is read before the body is right.
  const off = fixture({ disabled: true });
  assert.equal((await off.person()).status, 403);
  assert.deepEqual(off.events, []);
  for (const body of ['{}', '{"since":"yesterday"}', `{"since":"${SINCE}","company":"x"}`, '{"company":"x"}', `{"since":123}`, '[]', 'nope']) {
    const f = fixture();
    assert.equal((await f.person(body)).status, 400, body);
    assert.deepEqual(f.events, []);
  }
  // No scheduler token and nothing usable as a person's token: 401, nothing read.
  for (const headers of [{}, { authorization: 'Bearer short' }, { authorization: `Basic ${USER_TOKEN}` }]) {
    const f = fixture();
    assert.equal((await f.person(undefined, headers)).status, 401);
    assert.deepEqual(f.events, []);
  }
  // A request that carries the scheduler header is judged as the scheduler only.
  const both = fixture();
  assert.equal((await both.person('{}', { authorization: `Bearer ${USER_TOKEN}`, 'x-silo-scheduler-token': 'not-a-token' })).status, 401);
  assert.deepEqual(both.events, []);
});

test('Mirror now: the month the database hands the caller is read and stored, and the count to go comes back', async () => {
  const f = fixture();
  const res = await f.person();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { done: false, ok: true, changed: true, lines: 7, remaining: 2 });
  assert.deepEqual(f.events.slice(0, 2).map((e) => e[0]), ['user-db', 'user-rpc']);
  assert.deepEqual(f.events[1][2], { p_since: SINCE, p_months_back: MONTHS_BACK });
  // The scheduler's own work list is never consulted for a person.
  assert.deepEqual(rpcs(f.events), ['quickbooks_ledger_mirror_store']);
  const stored = f.events.find((e) => e[0] === 'rpc')[2];
  assert.equal(stored.p_company, COMPANY); assert.equal(stored.p_connection, CONNECTION); assert.equal(stored.p_period_start, '2026-09-01');
  // The person's token never goes to QuickBooks.
  for (const e of fetches(f.events)) assert.ok(!JSON.stringify(e[3].headers || {}).includes(USER_TOKEN));
  // Nothing left: done. A broken row from the database fails closed.
  const none = fixture({ myWork: null });
  assert.deepEqual(await (await none.person()).json(), { done: true });
  assert.deepEqual(none.events.map((e) => e[0]), ['user-db', 'user-rpc']);
  const broken = fixture({ myWork: { ...WORK, company_entity_id: 'x', remaining: 1 } });
  assert.equal((await broken.person()).status, 503);
  assert.deepEqual(fetches(broken.events), []);
  // A failed read is recorded on the month, so the same press is not handed it again.
  const failing = fixture({ quickbooks: { ledger: () => new Response('{}', { status: 500 }) } });
  assert.deepEqual(await (await failing.person()).json(), { done: false, ok: false, changed: false, lines: 0, error_code: 'quickbooks_read_failed', remaining: 2 });
  assert.deepEqual(rpcs(failing.events), ['quickbooks_ledger_mirror_failed']);
  // The browser's preflight is answered without reading anything.
  const pre = fixture();
  const opt = await pre.person(undefined, { origin: 'https://example.test' }, 'OPTIONS');
  assert.equal(opt.status, 204);
  assert.match(opt.headers.get('access-control-allow-headers'), /authorization/);
  assert.deepEqual(pre.events, []);
});

// ── The runner ─────────────────────────────────────────────────────────────
const runner = (answers, { maxCalls } = {}) => {
  const calls = [];
  let i = 0;
  return { calls, run: () => runLedgerMirror({ url: 'https://synthetic.supabase.co', maxCalls,
    getToken: async (aud) => { calls.push(['token', aud]); return 'identity'; },
    fetchImpl: async (url, init) => {
      calls.push(['post', String(url), init.body, init.headers['x-silo-scheduler-token']]);
      const next = answers[Math.min(i++, answers.length - 1)];
      if (next === 'throw') throw new Error('socket');
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    } }) };
};
const ok = (changed, lines) => ({ body: { done: false, ok: true, changed, lines } });
const bad = (code) => ({ body: { done: false, ok: false, changed: false, lines: 0, error_code: code } });

test('the runner reads until nothing is due and names nothing', async () => {
  const r = runner([ok(true, 100), ok(false, 40), bad('report_refused'), bad('reconnect_required'), { body: { done: true } }]);
  const summary = await r.run();
  assert.deepEqual(summary, { calls: 5, read: 2, changed: 1, unchanged: 1, lines: 140, failed: 1, owner_side: 1,
    errors: { report_refused: 1, reconnect_required: 1 }, stopped: null });
  const posts = r.calls.filter((c) => c[0] === 'post');
  assert.ok(posts.every((c) => c[1] === audience && c[2] === '{}' && c[3] === 'identity'));
  assert.equal(r.calls.filter((c) => c[0] === 'token').length, 5, 'a fresh identity for every call');
  assert.ok(OWNER_SIDE.has('reconnect_required') && !OWNER_SIDE.has('report_refused'));
});

test('the runner stops at its call limit, and on anything it cannot confirm', async () => {
  const capped = await runner([ok(true, 1)], { maxCalls: 3 }).run();
  assert.equal(capped.calls, 3);
  assert.equal(capped.stopped, 'call_limit');
  assert.ok(MAX_CALLS >= 13 * 4 && MAX_CALLS <= 500);
  await assert.rejects(runner(['throw']).run(), /unconfirmed/);
  await assert.rejects(runner([{ status: 401, body: { error_code: 'scheduler_identity_rejected' } }]).run(), /rejected \(401\): scheduler_identity_rejected/);
  await assert.rejects(runner([{ status: 503, body: { error_code: 'DROP TABLE' } }]).run(), /request_failed/);
  await assert.rejects(runner([{ body: { done: false, ok: true } }]).run(), /Invalid ledger mirror response/);
  await assert.rejects(runLedgerMirror({ url: 'http://synthetic.supabase.co' }), /Invalid Supabase URL/);
});

test('the workflow runs nightly on main with an identity and no database key', async () => {
  const yml = readFileSync(new URL('../../.github/workflows/quickbooks-ledger-mirror.yml', import.meta.url), 'utf8');
  assert.match(yml, /cron: '\d+ \d+ \* \* \*'/);
  assert.match(yml, /id-token: write/);
  assert.match(yml, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /node scripts\/quickbooks-ledger-mirror\.mjs/);
  assert.equal(/SERVICE_ROLE|QBO_CLIENT|concurrency:/.test(yml), false);
  const deploy = readFileSync(new URL('../../.github/workflows/deploy-edge-function.yml', import.meta.url), 'utf8');
  assert.match(deploy.match(/NO_JWT_FUNCTIONS="([^"]*)"/)[1], /(^| )quickbooks-ledger-mirror-scheduled( |$)/,
    'the function has no Supabase JWT to present, so it must be deployed without JWT verification');
});
