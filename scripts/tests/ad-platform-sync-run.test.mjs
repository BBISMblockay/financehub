/** "Sync now" for Google Ads / GA4 / Meta Ads (supabase/functions/ad-platform-sync-run).
 *
 * Runs the REAL handler wired to the REAL sync core (the function's own copy),
 * with Google answered by a fake fetch and Supabase by an in-memory fake, so
 * the path a click takes is the path tested -- not a helper in isolation.
 *
 * Run: node scripts/tests/ad-platform-sync-run.test.mjs
 * Mutations (each must fail the suite): AD_SYNC_RUN_MUTATION=
 *   no-rls-check | no-account-check | no-clamp | job-not-failed |
 *   unchecked-token | unchecked-meta | unchecked-job-success | silent-unrecorded |
 *   no-act-prefix | google-env-for-meta | no-fail-stamp | stale-success |
 *   unclassified-failure
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
  'unchecked-meta': ["check(await service.from('ad_platform_connections')\n        .update({\n          meta:", "(await service.from('ad_platform_connections')\n        .update({\n          meta:"],
  'unchecked-job-success': ["check(await service.from('sync_jobs')\n        .update({ status: 'success'", "(await service.from('sync_jobs')\n        .update({ status: 'success'"],
  'silent-unrecorded': ["const unrecorded = res?.error", "const unrecorded = false"],
  'no-act-prefix': ["meta_ad_account_id: metaAccountId(conn.meta_ad_account_id)", "meta_ad_account_id: conn.meta_ad_account_id"],
  'google-env-for-meta': ["if (GOOGLE_PLATFORMS.includes(conn.platform) && (!googleEnv.GOOGLE_CLIENT_ID", "if (true && (!googleEnv.GOOGLE_CLIENT_ID"],
  // The failure reaches sync_jobs but not the connection, so the page cannot
  // tell WHICH connection broke and shows nothing.
  'no-fail-stamp': ["      await stampOutcome({\n        last_sync: syncOutcome({ at: now().toISOString(), ok: false, error: message, clientBlock }),\n      });\n", ''],
  // A success leaves the previous failure standing, so the card goes on
  // saying the feed is broken after it has healed.
  // A manual failure stores no client_block, so the card offers a Retry for
  // an account only its owner can fix.
  'unclassified-failure': ['const clientBlock = clientSideReason?.(message) ?? null;', 'const clientBlock = null;'],
  'stale-success': ['            last_sync: syncOutcome({ at: result.synced_at, ok: true }),\n', ''],
};
assert.ok(mutation === '' || MUTATIONS[mutation], `Unknown mutation ${mutation}`);

let handlerSrc = read(`${FN}/handler.mjs`);

// EVERY pattern is checked on EVERY run, not just the one being applied.
//
// A mutation whose pattern has drifted out of the source still exits
// non-zero -- on this setup assertion, before the handler is even imported --
// and the CI loop reads any non-zero exit as "the guard is tested". So a
// stale pattern leaves a guard silently unguarded while the step stays
// green. Checking all of them here moves that failure into the ORDINARY run,
// which is the one CI reads for its own sake. (Found by review cycle 2 of
// #1224, where no-fail-stamp had drifted a commit earlier.)
for (const [name, [from]] of Object.entries(MUTATIONS)) {
  assert.ok(handlerSrc.includes(from), `mutation ${name} no longer matches the source: fix its pattern, or the guard it tests is untested`);
}

if (MUTATIONS[mutation]) {
  const [from, to] = MUTATIONS[mutation];
  handlerSrc = handlerSrc.replace(from, to);
}
const H = await import('data:text/javascript,' + encodeURIComponent(handlerSrc));
const core = await import(join(ROOT, FN, 'lib/ad-platforms-sync-core.mjs'));
const { clientSideReason } = await import(join(ROOT, FN, 'lib/ad-sync-client-errors.mjs'));

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
const metaConn = (over = {}) => ({
  id: 'c-meta', company_entity_id: CO, platform: 'meta_ads', is_active: true, sync_enabled: true,
  access_token: 'EAAtoken', meta_ad_account_id: '28476042445410282', days_back: null,
  meta: { history_backfill_pending: true }, ...over,
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
  syncOutcome: core.syncOutcome, clientSideReason,
  now: () => new Date('2026-09-30T20:00:00Z'),
});

// ── tests ───────────────────────────────────────────────────────────────────
await test('the function ships exact copies of the nightly sync libraries', () => {
  for (const f of ['ad-platforms-sync-core.mjs', 'shopify-sync-core.mjs', 'shopify-scopes.mjs', 'ad-sync-client-errors.mjs']) {
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
    [adsConn({ platform: 'search_console' }), 400, /Google Ads, GA4, Meta Ads and TikTok Ads/],
    [adsConn({ platform: 'tiktok_ads', refresh_token: null, access_token: null }), 409, /Connect TikTok again/],
    [adsConn({ platform: 'tiktok_ads', refresh_token: null, access_token: 'tt', tiktok_advertiser_id: null }), 409,
      /Choose a TikTok advertiser/],
    [metaConn({ access_token: null }), 409, /Replace token/],
    [metaConn({ meta_ad_account_id: null }), 409, /Choose a Meta ad account/],
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

await test('a fully configured TikTok connection is sync-now eligible, and records tiktok_ads_kpis', () => {
  const tiktok = adsConn({
    id: 'c-tt', platform: 'tiktok_ads', refresh_token: null,
    access_token: 'tt-token', google_customer_id: null, tiktok_advertiser_id: '7012345678901234567',
  });
  const plan = H.planSyncRun(tiktok);
  assert.equal(plan.ok, true);
  assert.equal(plan.daysBack, H.DEFAULT_DAYS_BACK);
  // TikTok has no refresh token by design, so the Google branch must not
  // demand one of it: that is what used to make this connection unsyncable.
  assert.equal(H.JOB_TYPES.tiktok_ads, 'tiktok_ads_kpis');
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

// Meta's Graph insights, in the shape fetchMetaAdsRows reads: one campaign row
// per day in the first chunk, empty after.
const metaCalls = [];
function fakeMeta({ status = 200 } = {}) {
  metaCalls.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    metaCalls.push(u);
    if (!u.startsWith('https://graph.facebook.com/')) throw new Error(`unexpected fetch ${u}`);
    if (status !== 200) return new Response('{"error":{"message":"(#200) no ads_read","code":200}}', { status });
    // The custom-conversion NAME lookup (20261104000500) is a different edge
    // with no time_range. It is answered empty here: this suite is about the
    // KPI sync, and the names are a label the sync degrades without.
    if (u.includes('/customconversions?')) return new Response('{"data":[]}', { status: 200 });
    const range = JSON.parse(new URL(u).searchParams.get('time_range'));
    const data = range.since === '2026-08-31' ? [
      { account_id: '28476042445410282', account_name: 'Bat Nutz', campaign_id: '9', campaign_name: 'Launch',
        date_start: '2026-08-31', date_stop: '2026-08-31', impressions: '1000', clicks: '20', spend: '12.50' },
    ] : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

await test('Meta: a click syncs the daily campaign totals, with no Google configuration needed', async () => {
  fakeMeta();
  const db = makeDb({ rows: [metaConn()], visibleIds: ['c-meta'] });
  const res = await handlerFor(db, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_ADS_DEVELOPER_TOKEN: '' })(req({ connection_id: 'c-meta' }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.kpi_rows_upserted, 1);
  assert.equal(body.scope, 'campaign_totals');
  assert.deepEqual(body.nightly_only, ['ad-level rows', 'creative images', 'Page posts']);
  // Every Graph call must carry the act_ prefix the stored id lacks -- the
  // insights calls and the custom-conversion name lookup alike.
  assert.ok(metaCalls.length > 0 && metaCalls.every((u) => u.includes('/act_28476042445410282/')),
    'the stored id has no act_ prefix; the request must carry one');
  const insightCalls = metaCalls.filter((u) => u.includes('/insights?'));
  assert.ok(insightCalls.length > 0, 'insights were requested');
  assert.ok(insightCalls.every((u) => new URL(u).searchParams.get('level') === 'campaign'), 'campaign totals only, never ad level');
  const row = db.tables.marketing_kpis_daily[0];
  assert.equal(row.platform, 'meta_ads');
  assert.equal(row.company_entity_id, CO);
  const job = db.tables.sync_jobs[0];
  assert.equal(job.job_type, 'meta_ads_kpis');
  assert.equal(job.status, 'success');
  const conn = db.tables.ad_platform_connections[0];
  assert.equal(conn.meta_ad_account_id, '28476042445410282', 'the stored id is not rewritten');
  assert.equal(conn.meta.history_backfill_pending, true, 'Sync now does not consume the nightly history import');
  assert.ok(conn.meta.last_sync_at);
});

await test('Meta: an id already carrying act_ is used as is', () => {
  assert.equal(H.metaAccountId('act_123'), 'act_123');
  assert.equal(H.metaAccountId('123'), 'act_123');
  assert.equal(H.metaAccountId(' 123 '), 'act_123');
  assert.equal(H.metaAccountId(null), '');
});

await test('Meta: a refusal marks the job failed and says why', async () => {
  fakeMeta({ status: 403 });
  const db = makeDb({ rows: [metaConn()], visibleIds: ['c-meta'] });
  const res = await handlerFor(db)(req({ connection_id: 'c-meta' }));
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.error, /ads_read/);
  assert.equal(db.tables.sync_jobs[0].status, 'error');
});

await test('Integrations offers Sync now on every platform this function runs, calling this function', () => {
  const page = read('v2/integrations.html');
  assert.match(page, /const SYNC_NOW_PLATFORMS = \['google_ads', 'ga4', 'meta_ads', 'tiktok_ads'\];/);
  assert.match(page, /SYNC_NOW_PLATFORMS\.includes\(row\.platform\) \? `<button[^`]*syncAdConnection\('\$\{row\.id\}', this\)/);
  assert.match(page, /\$\{FUNCTIONS_URL\}\/ad-platform-sync-run`/);
  // The page's list and the function's must stay equal: a platform offered
  // here that the handler refuses is a button that can only fail, and one the
  // handler runs but the page hides is a connection that waits for the
  // nightly for no reason.
  const inPage = page.match(/const SYNC_NOW_PLATFORMS = \[([^\]]*)\]/)[1]
    .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(inPage, H.SYNC_RUN_PLATFORMS);
  // Every ad card draws its rows through the one row template above, so these
  // guards are the whole rule -- no card may grow a Sync now button of its own
  // that this list does not govern. Exactly two call sites: the row's action
  // and the Retry on a failed-sync line, and the second is additionally
  // withheld when the failure is the client's to fix, where a retry can only
  // fail again.
  assert.match(page, /const canRetrySync = SYNC_NOW_PLATFORMS\.includes\(row\.platform\) && !clientBlock;/);
  assert.match(page, /\$\{canRetrySync\s*\n?\s*\? `<div[^`]*syncAdConnection\('\$\{row\.id\}', this\)/);
  assert.equal((page.match(/syncAdConnection\('\$\{row\.id\}', this\)/g) || []).length, 2);
});

await test('a failed sync is recorded on the connection, not only in sync_jobs', async () => {
  // sync_jobs carries company + job_type and no connection id, so with two
  // Google Ads accounts in one company it cannot say which one failed. The
  // page renders meta.last_sync; without this stamp a nightly or manual
  // failure is invisible to the customer.
  fakeGoogle({ adsStatus: 403 });
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  assert.equal(res.status, 502);
  const stamped = db.tables.ad_platform_connections.find((r) => r.id === 'c-ads');
  assert.equal(stamped.meta.last_sync.ok, false);
  assert.match(stamped.meta.last_sync.error, /PERMISSION_DENIED/);
  assert.ok(stamped.meta.last_sync.at, 'the stamp says when, so a stale failure can be told from a fresh one');
  assert.equal(stamped.meta.keep, 1, 'the rest of meta survives the stamp');
  // The existing audit record is untouched: this is the customer-facing half.
  assert.equal(db.tables.sync_jobs[0].status, 'error');
});

await test('a sync that succeeds clears the failure the page is showing', async () => {
  fakeGoogle();
  const db = makeDb({
    rows: [adsConn({ meta: { last_sync: { at: '2026-09-29T00:00:00Z', ok: false, error: 'older failure' } } })],
    visibleIds: ['c-ads'],
  });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  assert.equal(res.status, 200);
  const stamped = db.tables.ad_platform_connections.find((r) => r.id === 'c-ads');
  assert.equal(stamped.meta.last_sync.ok, true);
  assert.equal(stamped.meta.last_sync.error, undefined,
    'a success must not keep the old error text, or the card goes on saying the feed is broken');
});

await test('a manual failure the CLIENT owns is classified, as the nightly classifies it', async () => {
  // Otherwise the card offers "Retry sync now" for an account that was
  // cancelled or whose access was revoked -- a button that can only fail
  // again -- and a manual attempt can downgrade a nightly failure that the
  // same allowlist HAD classified.
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{"error":{"message":"CUSTOMER_NOT_ENABLED"}}', { status: 403 });
  };
  const db = makeDb({ rows: [adsConn()], visibleIds: ['c-ads'] });
  const res = await handlerFor(db)(req({ connection_id: 'c-ads' }));
  assert.equal(res.status, 502);
  const stamped = db.tables.ad_platform_connections.find((r) => r.id === 'c-ads');
  assert.equal(stamped.meta.last_sync.ok, false);
  assert.match(stamped.meta.last_sync.client_block, /not enabled/,
    'the same reason the nightly would have recorded');
});

console.log(`\n${n} passed`);
