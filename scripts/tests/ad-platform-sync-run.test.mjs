/** "Sync now" for Google Ads / GA4 (supabase/functions/ad-platform-sync-run).
 *
 * Runs the REAL handler wired to the REAL sync core (the function's own copy),
 * with Google answered by a fake fetch and Supabase by an in-memory fake, so
 * the path a click takes is the path tested -- not a helper in isolation.
 *
 * Run: node scripts/tests/ad-platform-sync-run.test.mjs
 * Mutations (each must fail the suite): AD_SYNC_RUN_MUTATION=
 *   no-rls-check | no-account-check | no-clamp | job-not-failed |
 *   unchecked-token | unchecked-meta | unchecked-job-success | silent-unrecorded
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = 'supabase/functions/ad-platform-sync-run';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.AD_SYNC_RUN_MUTATION || '';
const MUTATIONS = {
  'no-rls-check': ["if (visErr || !visible) return json({ error: 'Connection not found' }, 404);", ''],
  'no-account-check': ['if (!conn[ACCOUNT_FIELD[conn.platform]]) {', 'if (false) {'],
  'no-clamp': ['Math.min(days, MAX_DAYS_BACK)', 'days'],
  'job-not-failed': ["update({ status: 'error',", "update({ status: 'running',"],
  'unchecked-token': ["check(await service.from('ad_platform_connections')\n            .update({ access_token", "(await service.from('ad_platform_connections')\n            .update({ access_token"],
  'unchecked-meta': ["check(await service.from('ad_platform_connections')\n        .update({ meta", "(await service.from('ad_platform_connections')\n        .update({ meta"],
  'unchecked-job-success': ["check(await service.from('sync_jobs')\n        .update({ status: 'success'", "(await service.from('sync_jobs')\n        .update({ status: 'success'"],
  'silent-unrecorded': ["const unrecorded = res?.error", "const unrecorded = false"],
};
assert.ok(mutation === '' || MUTATIONS[mutation], `Unknown mutation ${mutation}`);

let handlerSrc = read(`${FN}/handler.mjs`);
if (MUTATIONS[mutation]) {
  const [from, to] = MUTATIONS[mutation];
  assert.ok(handlerSrc.includes(from), `mutation ${mutation} no longer matches the source`);
  handlerSrc = handlerSrc.replace(from, to);
}
const H = await import('data:text/javascript,' + encodeURIComponent(handlerSrc));
const core = await import(join(ROOT, FN, 'lib/ad-platforms-sync-core.mjs'));

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

// ── fakes ───────────────────────────────────────────────────────────────────
const CO = 'co-1';
const USER = { id: 'user-1' };
// failUpdate(table, patch) -> true makes that write return { error } the way
// PostgREST does: resolved, never thrown.
function makeDb({ rows, visibleIds = null, failUpdate = () => false }) {
  const log = { inserts: [], updates: [], upserts: [] };
  const tables = { ad_platform_connections: rows, sync_jobs: [], marketing_kpis_daily: [] };
  function query(table, { rls }) {
    const filters = [];
    const api = {
      select() { return api; },
      eq(col, val) { filters.push([col, val]); return api; },
      async maybeSingle() {
        let found = (tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v));
        if (rls && table === 'ad_platform_connections') found = found.filter((r) => (visibleIds ?? []).includes(r.id));
        return { data: found[0] ?? null, error: null };
      },
      insert(row) {
        const rec = { id: `job-${tables.sync_jobs.length + 1}`, ...row };
        tables[table].push(rec); log.inserts.push({ table, row: rec });
        return { select: () => ({ single: async () => ({ data: { id: rec.id }, error: null }) }) };
      },
      update(patch) {
        return {
          async eq(col, val) {
            log.updates.push({ table, patch, where: [col, val] });
            if (failUpdate(table, patch)) return { data: null, error: { message: `injected ${table} failure` } };
            for (const r of tables[table] || []) if (r[col] === val) Object.assign(r, patch);
            return { error: null };
          },
        };
      },
      async upsert(piece) { log.upserts.push({ table, rows: piece }); tables[table].push(...piece); return { error: null }; },
    };
    return api;
  }
  const service = {
    auth: { getUser: async (t) => (t === 'good-jwt' ? { data: { user: USER }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (t) => query(t, { rls: false }),
  };
  const userClientFor = () => ({ from: (t) => query(t, { rls: true }) });
  return { service, userClientFor, tables, log };
}

const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev' };
const adsConn = (over = {}) => ({
  id: 'c-ads', company_entity_id: CO, platform: 'google_ads', is_active: true, sync_enabled: true,
  refresh_token: 'rt', google_customer_id: '123-456-7890', days_back: null, meta: { keep: 1 }, ...over,
});
const req = (body, jwt = 'good-jwt') => new Request('https://x/functions/v1/ad-platform-sync-run', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Google, answered in the shapes the core reads.
const googleCalls = [];
function fakeGoogle({ adsStatus = 200 } = {}) {
  googleCalls.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    googleCalls.push({ url: String(url), method: opts.method, body: opts.body });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes('googleAds:search')) {
      if (adsStatus !== 200) return new Response('{"error":{"message":"PERMISSION_DENIED"}}', { status: adsStatus });
      return new Response(JSON.stringify({ results: [
        { customer: { id: '1234567890', descriptiveName: 'Demo' }, campaign: { id: '11', name: 'Brand' },
          segments: { date: '2026-09-28' }, metrics: { impressions: '100', clicks: '7', costMicros: '2500000', conversions: 1, conversionsValue: 40 } },
        { customer: { id: '1234567890', descriptiveName: 'Demo' }, campaign: { id: '11', name: 'Brand' },
          segments: { date: '2026-09-29' }, metrics: { impressions: '90', clicks: '5', costMicros: '1000000', conversions: 0, conversionsValue: 0 } },
      ] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}
const handlerFor = (db, env = ENV) => H.createHandler({
  service: db.service, userClientFor: db.userClientFor, googleEnv: env, runConnectionSync: core.runConnectionSync,
  now: () => new Date('2026-09-30T20:00:00Z'),
});

// ── tests ───────────────────────────────────────────────────────────────────
await test('the function ships exact copies of the nightly sync libraries', () => {
  for (const f of ['ad-platforms-sync-core.mjs', 'shopify-sync-core.mjs', 'shopify-scopes.mjs']) {
    assert.equal(read(`${FN}/lib/${f}`), read(`scripts/lib/${f}`), `${FN}/lib/${f} has drifted from scripts/lib/${f}`);
  }
});

await test('a click syncs the account through the real core and records the job', async () => {
  fakeGoogle();
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.kpi_rows_upserted, 2);
  assert.deepEqual(body.window, { startDate: '2026-08-31', endDate: '2026-09-30' });
  // Rows landed where the nightly writes them, on its identity key.
  assert.equal(db.tables.marketing_kpis_daily.length, 2);
  assert.ok(db.tables.marketing_kpis_daily.every((r) => r.company_entity_id === CO && r.platform === 'google_ads' && r.row_hash));
  // Read-only against Google: only a token refresh and searches.
  assert.ok(googleCalls.every((c) => c.url.startsWith('https://oauth2.googleapis.com/token') || c.url.includes('googleAds:search')));
  assert.ok(!googleCalls.some((c) => /:mutate/.test(c.url)));
  const job = db.tables.sync_jobs[0];
  assert.equal(job.job_type, 'google_ads_kpis');
  assert.equal(job.status, 'success');
  assert.equal(job.created_by, USER.id);
  assert.deepEqual(job.params, { trigger: 'manual', ad_connection_id: 'c-ads', days_back: 30 });
  const conn = db.tables.ad_platform_connections[0];
  assert.equal(conn.access_token, 'at-fresh');
  assert.equal(conn.meta.keep, 1);
  assert.ok(conn.meta.last_sync_at);
});

await test('a connection the caller cannot read through RLS is refused before anything runs', async () => {
  fakeGoogle();
  const db = makeDb({ rows: [adsConn()], visibleIds: [] });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  assert.equal(res.status, 404);
  assert.equal(db.tables.sync_jobs.length, 0);
  assert.equal(googleCalls.length, 0);
});

await test('no or bad token is 401', async () => {
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  assert.equal((await handlerFor(db)(req({ connection_id: 'c-ads' }, 'nope'))).status, 401);
  const noAuth = new Request('https://x', { method: 'POST', body: '{}' });
  assert.equal((await handlerFor(db)(noAuth)).status, 401);
});

await test('refusals name what to do, and record no job', async () => {
  const cases = [
    [adsConn({ platform: 'search_console' }), 400, /Google Ads and GA4/],
    [adsConn({ platform: 'meta_ads' }), 400, /Google Ads and GA4/],
    [adsConn({ is_active: false }), 409, /inactive/],
    [adsConn({ refresh_token: null }), 409, /Reconnect/],
    [adsConn({ google_customer_id: null }), 409, /Choose a Google Ads account/],
    [adsConn({ platform: 'ga4', google_customer_id: null, ga4_property_id: null }), 409, /Choose a GA4 property/],
  ];
  for (const [conn, status, re] of cases) {
    fakeGoogle();
    const db = makeDb({ rows: [conn], visibleIds: [conn.id] });
    const res = await handlerFor(db)(req({ connection_id: conn.id }));
    const body = await res.json();
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(body.error, re);
    assert.equal(db.tables.sync_jobs.length, 0);
    assert.equal(googleCalls.length, 0);
  }
});

await test('missing server configuration is 503, not a failed job', async () => {
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  const res = await handlerFor(db, { ...ENV, GOOGLE_ADS_DEVELOPER_TOKEN: '' })(req({ connection_id: 'c-ads' }));
  assert.equal(res.status, 503);
  assert.equal(db.tables.sync_jobs.length, 0);
});

await test('a wide configured window is clamped to fit the request', () => {
  assert.equal(H.planSyncRun(adsConn({ days_back: 400 })).daysBack, H.MAX_DAYS_BACK);
  assert.equal(H.planSyncRun(adsConn({ days_back: 7 })).daysBack, 7);
  assert.equal(H.planSyncRun(adsConn({ days_back: 0 })).daysBack, H.DEFAULT_DAYS_BACK);
  assert.equal(H.planSyncRun(adsConn({ days_back: 'x' })).daysBack, H.DEFAULT_DAYS_BACK);
});

await test('a Google refusal marks the job failed and says why', async () => {
  fakeGoogle({ adsStatus: 403 });
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.ok, false);
  assert.match(body.error, /PERMISSION_DENIED/);
  const job = db.tables.sync_jobs[0];
  assert.equal(job.status, 'error');
  assert.match(job.error, /PERMISSION_DENIED/);
  assert.ok(job.finished_at);
  assert.equal(db.tables.marketing_kpis_daily.length, 0);
});

await test('a failed write never answers ok, and never leaves the job silently running', async () => {
  const cases = [
    ['refreshed token', (t, p) => t === 'ad_platform_connections' && 'access_token' in p, /refreshed Google token/, 502],
    ['last sync time', (t, p) => t === 'ad_platform_connections' && 'meta' in p, /Synced 2 rows, but Could not record the sync time/, 500],
    ['job success', (t, p) => t === 'sync_jobs' && p.status === 'success', /Synced 2 rows, but Could not record the sync job as finished/, 500],
  ];
  for (const [what, failUpdate, re, status] of cases) {
    fakeGoogle();
    const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'], failUpdate });
    const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
    const body = await res.json();
    assert.equal(res.status, status, `${what}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false, what);
    assert.match(body.error, re, what);
    assert.equal(db.tables.sync_jobs[0].status, 'error', `${what}: job must end as error`);
  }
});

await test('when the failure itself cannot be recorded, the answer says the job may still read running', async () => {
  // Google refuses, then the error write fails too.
  fakeGoogle({ adsStatus: 403 });
  let db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'], failUpdate: (t) => t === 'sync_jobs' });
  let res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  let body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /PERMISSION_DENIED/);
  assert.match(body.error, /could not be recorded.*may still read as running/);
  assert.equal(db.tables.sync_jobs[0].status, 'running');
  // Rows land, then every job write fails: still never ok.
  fakeGoogle();
  db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'], failUpdate: (t) => t === 'sync_jobs' });
  res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.match(body.error, /could not be recorded.*may still read as running/);
});

await test('Integrations offers Sync now on Google Ads and GA4 rows only, calling this function', () => {
  const page = read('v2/integrations.html');
  assert.match(page, /const SYNC_NOW_PLATFORMS = \['google_ads', 'ga4'\];/);
  assert.match(page, /SYNC_NOW_PLATFORMS\.includes\(row\.platform\) \? `<button[^`]*syncAdConnection\('\$\{row\.id\}', this\)/);
  assert.match(page, /\$\{FUNCTIONS_URL\}\/ad-platform-sync-run`/);
});

console.log(`\n${n} passed`);
