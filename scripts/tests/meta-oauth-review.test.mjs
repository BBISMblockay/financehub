/* Meta App Review test page: the meta-oauth-review gateway EXECUTED with a
 * fake Supabase and a fake Graph API, plus static guards on the page and on
 * what must stay unchanged.
 *
 * Proven:
 *   1. Every action refuses: an unset allow-list (503), no session (401), a
 *      workspace not on the list -- Baseballism's id here -- (403), a member
 *      who is not an admin (403). Refused calls write nothing and reach
 *      neither Meta nor the sync.
 *   2. Every connection action (list_assets, select_assets, verify, sync,
 *      stored) refuses a PASTED-TOKEN row even in the allow-listed workspace,
 *      and a review row of another workspace: 404, nothing written, nothing
 *      fetched. That is the regression guard for manual-token connections.
 *   3. status lists only review rows and never a token.
 *   4. select_assets re-lists server-side: an ad account, Page or Instagram
 *      account the token cannot reach, or an Instagram account not linked to
 *      the chosen Page, is refused; a valid choice is saved to the row of the
 *      active workspace and sync_enabled is left as it was.
 *   5. verify probes each reporting permission with the sync's own Graph
 *      calls, stores nothing, and never returns a token.
 *   6. sync forwards to ad-platform-sync-run with the caller's own JWT.
 *   7. The probe's metrics and discovery fields equal the sync's and
 *      test-ad-platform-connection's (so a recording shows the real calls).
 *   9. Discovery follows paging.next (an asset on page 2 is listed AND
 *      selectable) and never sends the token to a non-Graph host.
 *  10. The page's request plumbing (testing/meta-oauth-client.js, run in a vm):
 *      a rejected fetch becomes { status: 0, data.ok false }; an out-of-order
 *      asset list is dropped so Save targets the connection shown; busy
 *      buttons are restored on success and on failure.
 *   8. Static: the page writes nothing to the database itself and calls only
 *      meta-oauth-start / meta-oauth-review; it is not in the nav, and
 *      v2/integrations.html and v2/nav-config.js do not reference it; the
 *      gateway deploys JWT-verified.
 *
 * Mutations (each must make this file FAIL):
 *   META_REVIEW_MUTATION=open-gate        (skip the review-workspace check)
 *   META_REVIEW_MUTATION=any-row          (skip the review-row check)
 *   META_REVIEW_MUTATION=trust-selection  (accept an ad account without re-listing)
 *   META_REVIEW_MUTATION=no-paging        (discovery stops at the first page)
 *   META_REVIEW_MUTATION=stale-accept     (the chooser accepts any response)
 *   META_REVIEW_MUTATION=no-catch         (a rejected fetch escapes callFunction)
 *
 * Run: node scripts/tests/meta-oauth-review.test.mjs */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.META_REVIEW_MUTATION || '';
assert.ok(['', 'open-gate', 'any-row', 'trust-selection', 'no-paging', 'stale-accept', 'no-catch'].includes(mutation), `Unknown mutation ${mutation}`);

const tmp = mkdtempSync(join(tmpdir(), 'meta-review-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
execFileSync('mkdir', ['-p', join(tmp, 'fn')]);
writeFileSync(join(tmp, 'fn', 'meta-oauth-lib.mjs'), read('supabase/functions/meta-oauth-review/meta-oauth-lib.mjs'));
let src = read('supabase/functions/meta-oauth-review/handler.mjs');
const edit = (from, to) => { assert.ok(src.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`); src = src.replace(from, to); };
if (mutation === 'open-gate') edit('if (!mayUseReviewWorkspace({ allowlist, companyId,', 'if (false && !mayUseReviewWorkspace({ allowlist, companyId,');
if (mutation === 'any-row') edit('if (connErr || !isReviewConnection(conn, companyId))', 'if (connErr || !conn)');
if (mutation === 'trust-selection') edit('if (!assets.ad_accounts.some((a) => a.id === adAccountId))', 'if (false)');
if (mutation === 'no-paging') edit('      url = safe;\n', '      url = null;\n');
writeFileSync(join(tmp, 'fn', 'handler.mjs'), src);
const { META_PERMISSIONS } = await import(pathToFileURL(join(tmp, 'fn', 'meta-oauth-lib.mjs')).href);
const { createReviewHandler, PROBE_PAGE_METRICS, PROBE_IG_METRICS, AD_ACCOUNT_FIELDS, PAGE_FIELDS, REVIEW_ACTIONS } =
  await import(pathToFileURL(join(tmp, 'fn', 'handler.mjs')).href);

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeDb(tables) {
  const log = [];
  const db = {
    log, tables, users: {},
    auth: { getUser: async (jwt) => ({ data: { user: db.users[jwt] ?? null } }) },
    from(table) {
      const rows = (tables[table] ||= []);
      const filters = [];
      let op = 'select', payload = null, head = false, limit = Infinity, order = null;
      const match = (r) => filters.every(([k, v]) => r[k] === v);
      const run = () => {
        if (op === 'update') {
          const hit = rows.filter(match);
          hit.forEach((r) => Object.assign(r, payload));
          log.push(['update', table, payload]); return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        let out = rows.filter(match);
        if (order) out = [...out].sort((a, b) => (String(a[order.col]) < String(b[order.col]) ? 1 : -1) * (order.asc ? -1 : 1));
        out = out.slice(0, limit);
        log.push(['select', table]);
        return head ? { data: null, count: out.length, error: null } : { data: out.map((r) => ({ ...r })), count: out.length, error: null };
      };
      const b = {
        select(_c, opts) { if (opts?.head) head = true; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        insert() { throw new Error('the gateway never inserts'); },
        delete() { throw new Error('the gateway never deletes'); },
        eq(k, v) { filters.push([k, v]); return b; },
        order(col, o) { order = { col, asc: o?.ascending !== false }; return b; },
        limit(k) { limit = k; return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  };
  return db;
}

const CO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASEBALLISM = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const ENV = { META_REVIEW_COMPANY_IDS: CO, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' };
const NOW = Date.parse('2026-10-08T12:00:00Z');

function world({ active = CO, role = 'admin' } = {}) {
  const db = fakeDb({
    profiles: [{ id: 'u1', role: 'user', active_company_id: active, is_active: true }],
    entity_memberships: [{ entity_id: CO, user_id: 'u1', role }, { entity_id: BASEBALLISM, user_id: 'u1', role: 'admin' }],
    entities: [{ id: CO, title: 'Meta App Review' }],
    ad_platform_connections: [
      { id: 'c-rev', company_entity_id: CO, platform: 'meta_ads', display_name: 'Meta Ads (App Review test)', access_token: 'tok-review',
        is_active: true, sync_enabled: false, meta: { oauth: { review_test: true, token_type: 'system_user' } } },
      { id: 'c-manual', company_entity_id: CO, platform: 'meta_ads', access_token: 'tok-manual', meta_ad_account_id: 'act_9',
        is_active: true, sync_enabled: true, meta: { history_backfilled_at: 'x' } },
      { id: 'c-bb', company_entity_id: BASEBALLISM, platform: 'meta_ads', access_token: 'tok-bb', meta_ad_account_id: 'act_bb',
        is_active: true, sync_enabled: true, meta: { oauth: { review_test: true } } },
    ],
    marketing_kpis_daily: [{ connection_id: 'c-rev', company_entity_id: CO, day_date: '2026-10-07', campaign_name: 'Fall', impressions: 10, clicks: 1, spend: 2 }],
    meta_ad_performance_daily: [], facebook_page_insights_daily: [{ company_entity_id: CO }], instagram_media_insights: [],
  });
  db.users = { jwt1: { id: 'u1' } };
  return db;
}

function fakeGraph({ paged = false, evilNext = false } = {}) {
  const calls = [];
  const ok = (body) => new Response(JSON.stringify(body));
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.host === 'x.supabase.co') return ok({ ok: true, kpi_rows_upserted: 30, window: { startDate: 'a', endDate: 'b' } });
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    const fields = u.searchParams.get('fields');
    if (u.host !== 'graph.facebook.com') throw new Error(`token sent to ${u.host}`);
    const after = u.searchParams.get('after');
    const next = (cursor) => ({ next: `${u.origin}${u.pathname}?${new URLSearchParams({ ...Object.fromEntries(u.searchParams), after: cursor })}` });
    if (path === 'me/adaccounts' && paged && !after) return ok({ data: [{ id: 'act_1', name: 'Demo ads', currency: 'USD' }], paging: next('A2') });
    if (path === 'me/adaccounts' && after === 'A2') return ok({ data: [{ id: 'act_2', name: 'Page-two ads', currency: 'EUR' }], ...(evilNext ? { paging: { next: 'https://evil.example/steal?x=1' } } : {}) });
    if (path === 'me/adaccounts') return ok({ data: [{ id: 'act_1', name: 'Demo ads', currency: 'USD' }] });
    if (path === 'me/accounts' && paged && !after && !fields.includes('instagram')) return ok({ data: [{ id: 'p1', name: 'Demo Page' }] });
    if (path === 'me/accounts' && paged && !after) return ok({ data: [{ id: 'p1', name: 'Demo Page', instagram_business_account: { id: 'ig1', username: 'demo' } }], paging: next('P2') });
    if (path === 'me/accounts' && after === 'P2') return ok({ data: [{ id: 'p3', name: 'Page-two Page', instagram_business_account: { id: 'ig3', username: 'two' } }] });
    if (path === 'me/adaccounts') return ok({ data: [{ id: 'act_1', name: 'Demo ads', currency: 'USD' }] });
    if (path === 'me/accounts') return ok({ data: [{ id: 'p1', name: 'Demo Page', instagram_business_account: { id: 'ig1', username: 'demo' } }, { id: 'p2', name: 'Other Page' }] });
    if (path === 'act_1') return ok({ id: 'act_1', name: 'Demo ads', currency: 'USD', account_status: 1 });
    if (path === 'act_1/insights') return ok({ data: [{ spend: '12.34', impressions: '1000', clicks: '20' }] });
    if (path === 'p1' && fields === 'access_token') return ok({ access_token: 'PAGE-TOKEN-SECRET', id: 'p1' });
    if (path === 'p1' && fields === 'fan_count') return ok({ fan_count: 321 });
    if (path === 'p1/insights') {
      assert.equal(u.searchParams.get('access_token'), 'PAGE-TOKEN-SECRET', 'Page insights use the Page token, as the sync does');
      return ok({ data: [{ name: 'page_media_view', values: [{}, {}] }] });
    }
    if (path === 'ig1/media') return ok({ data: [{ id: 'm1', media_type: 'IMAGE', timestamp: 't', permalink: 'https://instagram.com/p/x' }] });
    if (path === 'm1/insights') return ok({ data: [{ name: 'views', values: [{ value: 5 }] }, { name: 'reach', total_value: { value: 4 } }] });
    throw new Error(`unexpected Graph call ${path}`);
  };
  return { calls, fetchImpl };
}

const req = (body, jwt = 'jwt1') => new Request('https://x/functions/v1/meta-oauth-review', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
});
const call = async (h, body, jwt) => { const r = await h(req(body, jwt)); return { status: r.status, body: await r.json() }; };
const writes = (db) => db.log.filter((e) => e[0] === 'update');
const CONNECTION_ACTIONS = [['list_assets', {}], ['select_assets', { ad_account_id: 'act_1' }], ['verify', {}], ['sync', {}], ['stored', {}]];

// ── 1. the gate ─────────────────────────────────────────────────────────────
await test('gate: unset allow-list 503, no session 401, unknown action 400', async () => {
  const db = world();
  const { fetchImpl, calls } = fakeGraph();
  assert.equal((await call(createReviewHandler({ env: { ...ENV, META_REVIEW_COMPANY_IDS: '' }, admin: db, fetchImpl }), { action: 'status' })).status, 503);
  const h = createReviewHandler({ env: ENV, admin: db, fetchImpl });
  assert.equal((await call(h, { action: 'status' }, 'nope')).status, 401);
  assert.equal((await call(h, { action: 'delete_everything' })).status, 400);
  assert.equal(calls.length, 0);
});

await test('gate: a non-review workspace (Baseballism) and a non-admin are refused on EVERY action, with no effect', async () => {
  for (const opts of [{ active: BASEBALLISM }, { role: 'member' }]) {
    const db = world(opts);
    const { fetchImpl, calls } = fakeGraph();
    const h = createReviewHandler({ env: ENV, admin: db, fetchImpl });
    for (const action of REVIEW_ACTIONS) {
      for (const id of ['c-rev', 'c-bb', 'c-manual']) {
        const r = await call(h, { action, connection_id: id, ad_account_id: 'act_1' });
        assert.equal(r.status, 403, `${JSON.stringify(opts)} ${action} ${id}`);
        assert.equal(r.body.code, 'not_review_workspace');
      }
    }
    assert.equal(calls.length, 0, 'neither Meta nor the sync was called');
    assert.equal(writes(db).length, 0);
  }
});

// ── 2. only review rows of the active workspace ─────────────────────────────
await test('a pasted-token row (same workspace) and a review row of another workspace are untouchable', async () => {
  const db = world();
  const { fetchImpl, calls } = fakeGraph();
  const h = createReviewHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW });
  for (const [action, extra] of CONNECTION_ACTIONS) {
    for (const id of ['c-manual', 'c-bb', 'nope']) {
      const r = await call(h, { action, connection_id: id, ...extra });
      assert.equal(r.status, 404, `${action} ${id}`);
    }
  }
  assert.equal(calls.length, 0, 'no token of theirs was used');
  assert.equal(writes(db).length, 0);
  const manual = db.tables.ad_platform_connections.find((r) => r.id === 'c-manual');
  assert.deepEqual([manual.access_token, manual.meta_ad_account_id, manual.sync_enabled], ['tok-manual', 'act_9', true]);
});

// ── 3. status ───────────────────────────────────────────────────────────────
await test('status: the workspace and its review rows only, never a token', async () => {
  const r = await call(createReviewHandler({ env: ENV, admin: world(), fetchImpl: fakeGraph().fetchImpl }), { action: 'status', company_entity_id: BASEBALLISM });
  assert.equal(r.status, 200);
  assert.equal(r.body.company.id, CO, 'the body cannot name the workspace');
  assert.deepEqual(r.body.connections.map((c) => c.id), ['c-rev']);
  assert.equal(r.body.connections[0].oauth.token_type, 'system_user');
  assert.doesNotMatch(JSON.stringify(r.body), /tok-/);
});

// ── 4. asset selection ──────────────────────────────────────────────────────
await test('list_assets: what the token reaches, ad accounts and Pages with linked Instagram', async () => {
  const r = await call(createReviewHandler({ env: ENV, admin: world(), fetchImpl: fakeGraph().fetchImpl }), { action: 'list_assets', connection_id: 'c-rev' });
  assert.deepEqual(r.body.ad_accounts, [{ id: 'act_1', name: 'Demo ads', currency: 'USD' }]);
  assert.deepEqual(r.body.pages.map((p) => [p.page_id, p.instagram_business_account_id]), [['p1', 'ig1'], ['p2', null]]);
  assert.doesNotMatch(JSON.stringify(r.body), /tok-/);
});

await test('select_assets: only reachable assets; Instagram only via its Page; saved without switching sync on', async () => {
  for (const [body, why] of [
    [{ ad_account_id: 'act_bb' }, 'an ad account the token cannot reach'],
    [{ ad_account_id: 'act_1', page_id: 'p9' }, 'a Page the token cannot reach'],
    [{ ad_account_id: 'act_1', page_id: 'p2', instagram_business_account_id: 'ig1' }, 'Instagram not linked to that Page'],
    [{ ad_account_id: 'act_1', instagram_business_account_id: 'ig1' }, 'Instagram without its Page'],
    [{}, 'no ad account'],
  ]) {
    const db = world();
    const r = await call(createReviewHandler({ env: ENV, admin: db, fetchImpl: fakeGraph().fetchImpl, now: () => NOW }), { action: 'select_assets', connection_id: 'c-rev', ...body });
    assert.equal(r.status, 400, why);
    assert.equal(writes(db).length, 0, why);
  }
  const db = world();
  const r = await call(createReviewHandler({ env: ENV, admin: db, fetchImpl: fakeGraph().fetchImpl, now: () => NOW }),
    { action: 'select_assets', connection_id: 'c-rev', ad_account_id: 'act_1', page_id: 'p1', instagram_business_account_id: 'ig1' });
  assert.equal(r.status, 200);
  const row = db.tables.ad_platform_connections.find((x) => x.id === 'c-rev');
  assert.deepEqual([row.meta_ad_account_id, row.facebook_page_id, row.instagram_business_account_id, row.updated_by], ['act_1', 'p1', 'ig1', 'u1']);
  assert.equal(row.sync_enabled, false, 'choosing assets does not switch on the nightly sync');
  assert.equal(writes(db).length, 1);
  assert.ok(!('sync_enabled' in writes(db)[0][2]));
});

// ── 5. verify ───────────────────────────────────────────────────────────────
await test('verify: each reporting permission probed with the sync\'s calls; nothing stored; no token returned', async () => {
  const db = world();
  Object.assign(db.tables.ad_platform_connections[0], { meta_ad_account_id: 'act_1', facebook_page_id: 'p1', instagram_business_account_id: 'ig1' });
  const { fetchImpl } = fakeGraph();
  const r = await call(createReviewHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW }), { action: 'verify', connection_id: 'c-rev' });
  assert.equal(r.status, 200);
  const by = (p) => r.body.checks.filter((c) => c.permission === p);
  for (const p of ['ads_read', 'pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights']) {
    assert.ok(by(p).length && by(p).every((c) => c.ok === true), `${p}: ${JSON.stringify(by(p))}`);
  }
  assert.ok(!r.body.checks.some((c) => /business_management|ads_management/.test(c.permission)), 'no write permission is exercised');
  assert.deepEqual([...new Set(r.body.checks.map((c) => c.permission))].sort(), [...META_PERMISSIONS].sort(),
    'the probe covers exactly the permissions the configuration requests');
  assert.equal(by('pages_read_engagement')[0].detail.page_token_issued, true);
  assert.equal(by('pages_read_engagement')[1].detail.fan_count, 321);
  assert.equal(by('instagram_manage_insights')[0].detail.metrics.reach, 4);
  assert.doesNotMatch(JSON.stringify(r.body), /tok-|PAGE-TOKEN-SECRET|access_token=/);
  assert.equal(writes(db).length, 0);

  // Nothing chosen yet: every asset-bound check says so instead of failing.
  const db2 = world();
  const r2 = await call(createReviewHandler({ env: ENV, admin: db2, fetchImpl: fakeGraph().fetchImpl, now: () => NOW }), { action: 'verify', connection_id: 'c-rev' });
  assert.deepEqual(r2.body.checks.filter((c) => c.ok === null).map((c) => c.permission).sort(),
    ['ads_read', 'instagram_basic', 'instagram_manage_insights', 'pages_read_engagement', 'read_insights']);
});

// ── 6. sync and stored ──────────────────────────────────────────────────────
await test('sync: forwards to ad-platform-sync-run with the caller\'s own JWT, for the review row only', async () => {
  const { fetchImpl, calls } = fakeGraph();
  const r = await call(createReviewHandler({ env: ENV, admin: world(), fetchImpl }), { action: 'sync', connection_id: 'c-rev' });
  assert.equal(r.body.kpi_rows_upserted, 30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.supabase.co/functions/v1/ad-platform-sync-run');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer jwt1');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { connection_id: 'c-rev' });
});

await test('stored: counts for this connection / workspace and its recent campaign days', async () => {
  const r = await call(createReviewHandler({ env: ENV, admin: world(), fetchImpl: fakeGraph().fetchImpl }), { action: 'stored', connection_id: 'c-rev' });
  assert.equal(r.body.stored.marketing_kpis_daily, 1);
  assert.equal(r.body.stored.facebook_page_insights_daily, 1);
  assert.equal(r.body.stored.recent_campaign_days[0].campaign_name, 'Fall');
});

// ── 7. the probe uses the real calls ────────────────────────────────────────
await test('the probe\'s metrics and discovery fields are the sync\'s and the tester\'s own', () => {
  const core = read('scripts/lib/ad-platforms-sync-core.mjs');
  const block = /const PAGE_INSIGHT_METRICS = \[([\s\S]*?)\];/.exec(core)[1];
  assert.deepEqual(PROBE_PAGE_METRICS, [...block.matchAll(/metric: '([^']+)'/g)].map((m) => m[1]));
  assert.ok(core.includes(`metric: '${PROBE_IG_METRICS}'`), 'Instagram media insights metrics');
  const tester = read('supabase/functions/test-ad-platform-connection/index.ts');
  assert.ok(tester.includes(`me/adaccounts?fields=${AD_ACCOUNT_FIELDS}&`), 'ad account discovery fields');
  assert.ok(tester.includes(`fields: '${PAGE_FIELDS}'`), 'Page discovery fields');
});

// ── 9. pagination ───────────────────────────────────────────────────────────
await test('discovery follows paging.next: a page-two ad account and Page are listed and selectable', async () => {
  const db = world();
  const { fetchImpl } = fakeGraph({ paged: true });
  const h = createReviewHandler({ env: ENV, admin: db, fetchImpl, now: () => NOW });
  const list = await call(h, { action: 'list_assets', connection_id: 'c-rev' });
  assert.deepEqual(list.body.ad_accounts.map((a) => a.id), ['act_1', 'act_2']);
  assert.deepEqual(list.body.pages.map((p) => p.page_id), ['p1', 'p3']);
  assert.equal(list.body.truncated, false);
  const r = await call(h, { action: 'select_assets', connection_id: 'c-rev', ad_account_id: 'act_2', page_id: 'p3', instagram_business_account_id: 'ig3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.tables.ad_platform_connections.find((x) => x.id === 'c-rev');
  assert.deepEqual([row.meta_ad_account_id, row.facebook_page_id, row.instagram_business_account_id], ['act_2', 'p3', 'ig3']);
});

await test('discovery never follows a paging.next off graph.facebook.com (the token is in it)', async () => {
  const { fetchImpl, calls } = fakeGraph({ paged: true, evilNext: true });
  const r = await call(createReviewHandler({ env: ENV, admin: world(), fetchImpl }), { action: 'list_assets', connection_id: 'c-rev' });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true, 'reported, not silently cut');
  assert.deepEqual(r.body.ad_accounts.map((a) => a.id), ['act_1', 'act_2']);
  assert.ok(calls.every((c) => new URL(c.url).host === 'graph.facebook.com'));
});

// ── 10. the page's request plumbing ─────────────────────────────────────────
let clientSrc = read('testing/meta-oauth-client.js');
const editClient = (from, to) => { assert.ok(clientSrc.includes(from), `client mutation anchor missing: ${from}`); clientSrc = clientSrc.replace(from, to); };
if (mutation === 'stale-accept') editClient('if (!current || current.token !== token) return false;', 'if (!current) return false;');
if (mutation === 'no-catch') editClient('} catch (err) {\n      return { status: 0,', '} finally {\n      if (0) return { status: 0,');
const sandbox = {};
vm.runInNewContext(clientSrc, sandbox);
const C = sandbox.SiloMetaReviewClient;

await test('client: a rejected fetch or a non-JSON answer still yields { status, data } with an error', async () => {
  const down = await C.callFunction(async () => { throw new TypeError('Failed to fetch'); }, 'u', {});
  assert.equal(down.status, 0);
  assert.equal(down.data.ok, false);
  assert.match(down.data.error, /Network error: Failed to fetch/);
  const html = await C.callFunction(async () => new Response('<html>502</html>', { status: 502 }), 'u', {});
  assert.equal(html.status, 502);
  assert.equal(html.data.ok, false);
  assert.match(html.data.error, /HTTP 502/);
});

await test('client: an out-of-order asset list is dropped; Save targets the connection whose list is shown', () => {
  const s = C.createAssetSession();
  const a = s.begin('conn-A');
  const b = s.begin('conn-B');
  assert.equal(s.accept(b, { ad_accounts: [{ id: 'act_B' }] }), true, 'B answers first');
  assert.equal(s.accept(a, { ad_accounts: [{ id: 'act_A' }] }), false, "A's slower answer is ignored");
  assert.equal(s.isCurrent(a), false);
  const active = s.active();
  assert.equal(active.connectionId, 'conn-B');
  assert.equal(active.data.ad_accounts[0].id, 'act_B', 'list and connection travel together');
  s.clear(a);
  assert.ok(s.active(), "clearing for a stale request leaves the newer chooser");
  s.clear(b);
  assert.equal(s.active(), null);
  const c = s.begin('conn-C');
  assert.equal(s.active(), null, 'nothing to save until the list loads');
  s.accept(c, { ad_accounts: [] });
  assert.equal(s.active().connectionId, 'conn-C');
});

await test('client: busy buttons are restored after success and after failure', async () => {
  const btn = { disabled: false, textContent: 'Sync now' };
  let seen;
  await C.withBusy(btn, 'Syncing…', async () => { seen = [btn.disabled, btn.textContent]; return 1; });
  assert.deepEqual(seen, [true, 'Syncing…']);
  assert.deepEqual([btn.disabled, btn.textContent], [false, 'Sync now']);
  await assert.rejects(C.withBusy(btn, 'Syncing…', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual([btn.disabled, btn.textContent], [false, 'Sync now']);
});

await test('page: every call goes through callFunction, every busy button through withBusy, stale lists are checked', () => {
  const js = read('testing/meta-oauth.js');
  const html = read('testing/meta-oauth.html');
  assert.ok(html.indexOf('meta-oauth-client.js') > 0 && html.indexOf('meta-oauth-client.js') < html.indexOf('src="meta-oauth.js"'), 'client loads first');
  assert.equal((js.match(/\bfetch\(/g) || []).length, 0, 'no raw fetch( call; callFunction is handed fetch');
  assert.match(js, /return callFunction\(fetch,/);
  assert.doesNotMatch(js, /btn\.disabled\s*=|btn\.textContent\s*=/, 'buttons are only toggled by withBusy');
  assert.match(js, /if \(!assets\.isCurrent\(token\)\) return;/);
  assert.match(js, /connection_id: active\.connectionId/);
  assert.doesNotMatch(js, /assetConn|assetData/);
});

// ── 8. static guards ────────────────────────────────────────────────────────
await test('the page writes nothing itself, calls only the two review functions, and is not linked anywhere', () => {
  const js = read('testing/meta-oauth.js');
  const html = read('testing/meta-oauth.html');
  assert.doesNotMatch(js, /\.(from|insert|update|upsert|delete|rpc)\(/, 'no direct database access from the page');
  const fns = [...js.matchAll(/call\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fns)].sort(), ['meta-oauth-review', 'meta-oauth-start']);
  assert.match(js, /return_to: 'review_test'/);
  assert.match(js, /\/pages\/login\.html\?next=/, 'a signed-out visit goes to sign-in');
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /nav-config|silo-chrome/, 'no sidebar, no nav entry');
  for (const f of ['v2/integrations.html', 'v2/nav-config.js', 'v2/silo-chrome.js']) {
    assert.doesNotMatch(read(f), /testing\/meta-oauth|meta-oauth-review|review_test/, `${f} stays unchanged by this flow`);
  }
});

await test('deploy: the review gateway keeps JWT verification', () => {
  const list = /NO_JWT_FUNCTIONS="([^"]*)"/.exec(read('.github/workflows/deploy-edge-function.yml'))[1].split(/\s+/);
  assert.ok(!list.includes('meta-oauth-review'));
  assert.ok(!list.includes('meta-oauth-start'));
});

console.log(`\n${n} passed`);
