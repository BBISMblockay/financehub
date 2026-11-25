// Amazon Ads reporting: the async report flow, the window clamp, and the
// per-product metric mapping.
//
// Every fact under test is Amazon's, and none is visible from the call site:
//
//   * Amazon keeps 95 DAYS and ERRORS on a start date older than that, so the
//     window is clamped rather than asked for in full. This is the one source
//     where the project's "asking for more than a source holds is safe" rule
//     does not apply, and a first import is three months deep, not two years.
//   * Reports are ASYNCHRONOUS. All of them are created BEFORE any is polled,
//     because Amazon builds them concurrently: polling one to completion
//     before creating the next would make a twelve-report first import take
//     twelve build times in series.
//   * Sponsored Products reports purchases7d/sales7d and has NO bare
//     `purchases`; Brands and Display report `purchases`/`sales`. Reading the
//     wrong name gives a column of undefined, which `num()` turns into a
//     silent zero -- an Amazon ROAS of 0 on real spend.
//   * A repeated identical request is answered 425 with the ORIGINAL report's
//     id in `detail`. A re-run that treated that as a failure would throw
//     away a report Amazon is already building.
//
// Mutations (each must fail at least one assertion):
//   AMAZON_SYNC_MUTATION=lookback   the 95-day clamp is dropped
//   AMAZON_SYNC_MUTATION=chunk      the 30-day chunking is dropped
//   AMAZON_SYNC_MUTATION=serial     each report is polled before the next is created
//   AMAZON_SYNC_MUTATION=valuemetric  Sponsored Products sales read from the 1-day window
//   AMAZON_SYNC_MUTATION=duplicate  a 425 duplicate is treated as a failure
//   AMAZON_SYNC_MUTATION=allfail    one failed ad product fails the whole sync
//   AMAZON_SYNC_MUTATION=pending    an unfinished report is reported as success
//
// Run: node --test scripts/tests/amazon-ads-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const MUT = process.env.AMAZON_SYNC_MUTATION || '';
const libUrl = new URL('../lib/ad-platforms-sync-core.mjs', import.meta.url);

async function loadCore() {
  let src = fs.readFileSync(libUrl, 'utf8');
  const sub = (from, to) => {
    assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
    src = src.split(from).join(to);
  };
  if (MUT === 'lookback') sub('const startDate = window.startDate < earliest ? earliest : window.startDate;', 'const startDate = window.startDate;');
  if (MUT === 'chunk') sub('chunkDays = AMAZON_ADS_CHUNK_DAYS,', 'chunkDays = 3650,');
  if (MUT === 'serial') {
    sub(`        jobs.push({ spec, chunk, reportId, label: spec.reportTypeId });`,
      `        jobs.push({ spec, chunk, reportId, label: spec.reportTypeId });
        await amazonReportStatus(host, headers, reportId, spec.reportTypeId);`);
  }
  if (MUT === 'valuemetric') sub("conversionValueColumn: 'sales7d',", "conversionValueColumn: 'sales1d',");
  if (MUT === 'duplicate') sub('    if (existing) return existing;', '');
  if (MUT === 'allfail') sub('if (errors.size === reports.length) {', 'if (errors.size) {');
  if (MUT === 'pending') sub('        stillWaiting.push(job);\n      }\n    }\n    outstanding = stillWaiting;', '        done.push({ ...job, url: `https://example.invalid/not-ready` });\n      }\n    }\n    outstanding = stillWaiting;');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-ads-sync-'));
  src = src.replace("'./shopify-sync-core.mjs'", `'${new URL('./shopify-sync-core.mjs', libUrl).href}'`);
  const file = path.join(dir, 'ad-platforms-sync-core.mjs');
  fs.writeFileSync(file, src);
  return import(file);
}
const {
  fetchAmazonAdsRows, amazonAdsWindows, amazonAdsHost, amazonDuplicateReportId,
  AMAZON_ADS_REPORTS,
} = await loadCore();

const env = { AMAZON_ADS_CLIENT_ID: 'amzn1.application-oa2-client.test', AMAZON_ADS_CLIENT_SECRET: 'secret' };
const conn = (over = {}) => ({
  access_token: 'Atza|test', amazon_profile_id: '3333333333333333',
  amazon_region: 'NA', display_name: 'Test advertiser', ...over,
});
// A fixed "now" so the 95-day clamp is a deterministic date, not today's.
const NOW = new Date('2026-11-20T18:00:00Z');

/** Amazon's three endpoints, faked: create (POST), status (GET) and the
 * pre-signed gzip download. `rowsFor` decides what each report contains, and
 * every request is recorded IN ORDER so the create-then-poll shape is
 * testable, not just the end result. */
function fakeAmazon({
  rowsFor = () => [],
  statusSequence = () => ['COMPLETED'],
  createStatus = () => 200,
} = {}) {
  const calls = [];
  const polls = new Map();
  const jobs = new Map();
  let n = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const res = (status, body, extra = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      ...extra,
    });
    if (u.endsWith('/reporting/reports') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const key = `${body.configuration.reportTypeId}|${body.startDate}`;
      calls.push({ kind: 'create', key, body, headers: opts.headers });
      const status = createStatus(body);
      if (status !== 200) {
        // Amazon's 425 names the report already building, which is the id a
        // previous identical request was given.
        const existing = jobs.get(key) || `00000000-0000-4000-8000-${String(n += 1).padStart(12, '0')}`;
        jobs.set(key, existing);
        jobs.set(existing, key);
        return res(status, { code: '425', detail: `The Request is a duplicate of : ${existing}` });
      }
      const id = `00000000-0000-4000-8000-${String(n += 1).padStart(12, '0')}`;
      jobs.set(key, id);
      jobs.set(id, key);
      return res(200, { reportId: id, status: 'PENDING' });
    }
    const statusMatch = /\/reporting\/reports\/([^/?]+)$/.exec(u);
    if (statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const key = jobs.get(id);
      calls.push({ kind: 'status', id, key });
      const seq = statusSequence(key);
      const i = polls.get(id) ?? 0;
      polls.set(id, i + 1);
      const status = seq[Math.min(i, seq.length - 1)];
      if (status === 'COMPLETED') {
        return res(200, { reportId: id, status, url: `https://report.invalid/${encodeURIComponent(key)}` });
      }
      if (status === 'FAILED') {
        return res(200, { reportId: id, status, failureReason: 'no data for this ad product' });
      }
      return res(200, { reportId: id, status });
    }
    if (u.startsWith('https://report.invalid/')) {
      const key = decodeURIComponent(u.slice('https://report.invalid/'.length));
      calls.push({ kind: 'download', key });
      const gz = gzipSync(Buffer.from(JSON.stringify(rowsFor(key))));
      return res(200, '', { arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const noSleep = async () => {};
const spRow = (day) => ({
  date: day, campaignId: 101, campaignName: 'Gloves',
  impressions: '1000', clicks: '40', cost: '12.34',
  purchases7d: '5', sales7d: '210.50', purchases1d: '1', sales1d: '19.99',
});

await test('the window is clamped to Amazon’s 95-day retention and chunked to 30 days', () => {
  // A two-year first-connect window: adsDaysBack asks for 730 days.
  const chunks = amazonAdsWindows({ startDate: '2024-11-20', endDate: '2026-11-20' }, { now: NOW });
  assert.ok(chunks.length, 'expected at least one chunk');
  assert.equal(chunks[0].startDate, '2026-08-18', 'the first chunk must start at the 95-day boundary, not two years back');
  assert.equal(chunks[chunks.length - 1].endDate, '2026-11-20');
  for (const c of chunks) {
    const days = (Date.parse(`${c.endDate}T00:00:00Z`) - Date.parse(`${c.startDate}T00:00:00Z`)) / 86400000 + 1;
    assert.ok(days <= 30, `chunk ${c.startDate}..${c.endDate} spans ${days} days`);
  }
  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(
      Date.parse(`${chunks[i].startDate}T00:00:00Z`) - Date.parse(`${chunks[i - 1].endDate}T00:00:00Z`),
      86400000,
      `chunks ${JSON.stringify(chunks[i - 1])} and ${JSON.stringify(chunks[i])} are not contiguous`,
    );
  }
});

await test('a window entirely older than the retention asks for nothing at all', () => {
  assert.deepEqual(amazonAdsWindows({ startDate: '2025-01-01', endDate: '2025-02-01' }, { now: NOW }), []);
});

await test('every report is created before any is polled', async () => {
  const calls = fakeAmazon({ rowsFor: () => [] });
  // 60 days over three ad products: two chunks each, six reports.
  await fetchAmazonAdsRows(conn(), env, { startDate: '2026-09-22', endDate: '2026-11-20' },
    { now: NOW, sleepFn: noSleep });
  const creates = calls.filter((c) => c.kind === 'create').length;
  assert.equal(creates, 6, `expected 6 creates, got ${creates}`);
  const firstStatus = calls.findIndex((c) => c.kind === 'status');
  const lastCreate = calls.map((c) => c.kind).lastIndexOf('create');
  assert.ok(firstStatus > lastCreate,
    'a status call was made before every report had been requested — the batch then costs one build time per report, in series');
});

await test('Sponsored Products maps the 7-day attribution columns; cost is the spend', async () => {
  fakeAmazon({ rowsFor: (key) => (key.startsWith('spCampaigns') ? [spRow('2026-11-19')] : []) });
  const out = await fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
    { now: NOW, sleepFn: noSleep });
  assert.equal(out.rows.length, 1);
  const [row] = out.rows;
  assert.equal(row.day, '2026-11-19');
  assert.equal(row.campaignId, '101');
  assert.equal(row.campaignName, 'Gloves');
  assert.equal(row.spend, '12.34');
  assert.equal(row.conversions, '5');
  // sales7d, not sales1d: Amazon's console default, and the window every
  // product's figures must share to be addable.
  assert.equal(row.conversionValue, '210.50');
  assert.equal(row.accountId, '3333333333333333');
});

await test('Brands and Display map their bare purchases and sales columns', async () => {
  fakeAmazon({
    rowsFor: (key) => (key.startsWith('sbCampaigns')
      ? [{ date: '2026-11-19', campaignId: 202, campaignName: 'Brand', impressions: '50', clicks: '2', cost: '3.00', purchases: '1', sales: '44.00' }]
      : []),
  });
  const out = await fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
    { now: NOW, sleepFn: noSleep });
  const [row] = out.rows;
  assert.equal(row.conversions, '1');
  assert.equal(row.conversionValue, '44.00');
  // Every product asks only for columns that product supports: a column a
  // report type does not know refuses the WHOLE report with a 422.
  for (const spec of AMAZON_ADS_REPORTS) {
    const windowed = spec.columns.filter((c) => /\d+d$/.test(c));
    if (spec.reportTypeId === 'spCampaigns') assert.ok(windowed.length, 'Sponsored Products has no bare purchases column');
    else assert.equal(windowed.length, 0, `${spec.reportTypeId} does not take attribution-windowed columns`);
  }
});

await test('a 425 duplicate is polled, not failed: the report is already building', async () => {
  // Every create answers 425, as a re-run of an identical request does.
  const calls = fakeAmazon({
    createStatus: () => 425,
    rowsFor: (key) => (key.startsWith('spCampaigns') ? [spRow('2026-11-19')] : []),
  });
  const out = await fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
    { now: NOW, sleepFn: noSleep });
  assert.equal(out.errors, undefined, `a duplicate must not be an error: ${JSON.stringify(out.errors)}`);
  assert.equal(out.rows.length, 1);
  assert.ok(calls.some((c) => c.kind === 'status'), 'the report named by the 425 was never polled');
});

await test('the report id is read out of Amazon’s duplicate message', () => {
  assert.equal(
    amazonDuplicateReportId('The Request is a duplicate of : 1b0f1d9c-4a4f-4f0e-9b2a-2f7c3d4e5a6b'),
    '1b0f1d9c-4a4f-4f0e-9b2a-2f7c3d4e5a6b',
  );
  assert.equal(amazonDuplicateReportId('no id here'), null);
});

await test('one ad product failing keeps the others; every product failing throws', async () => {
  fakeAmazon({
    statusSequence: (key) => (key.startsWith('sdCampaigns') ? ['FAILED'] : ['COMPLETED']),
    rowsFor: (key) => (key.startsWith('spCampaigns') ? [spRow('2026-11-19')] : []),
  });
  const out = await fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
    { now: NOW, sleepFn: noSleep });
  assert.equal(out.rows.length, 1, 'Sponsored Products spend was lost because Display failed');
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /sdCampaigns/);

  fakeAmazon({ statusSequence: () => ['FAILED'] });
  await assert.rejects(
    () => fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
      { now: NOW, sleepFn: noSleep }),
    /every ad product failed/,
  );
});

await test('a report still building is reported as pending, never as an empty success', async () => {
  fakeAmazon({ statusSequence: () => ['PROCESSING'] });
  const out = await fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
    { now: NOW, sleepFn: noSleep, pollAttempts: 2, pollIntervalMs: 1 });
  assert.equal(out.rows.length, 0);
  assert.equal(out.errors, undefined, 'a slow report is not a failure');
  assert.equal(out.pending.length, 3, 'all three products should be named as still building');
  assert.match(out.pending[0], /spCampaigns 2026-11-19\.\.2026-11-19/);
});

await test('one campaign reported by two ad products is a hard failure, never deduplicated', async () => {
  // The same campaign id and day from two products: Amazon's model forbids
  // this, and silently keeping one would halve the day's spend.
  fakeAmazon({
    rowsFor: (key) => (key.startsWith('spCampaigns') || key.startsWith('sbCampaigns')
      ? [{ date: '2026-11-19', campaignId: 999, campaignName: 'Shared', impressions: '1', clicks: '1', cost: '1', purchases: '0', sales: '0', purchases7d: '0', sales7d: '0' }]
      : []),
  });
  await assert.rejects(
    () => fetchAmazonAdsRows(conn(), env, { startDate: '2026-11-19', endDate: '2026-11-19' },
      { now: NOW, sleepFn: noSleep }),
    /reported by both/,
  );
});

await test('the Amazon headers and the regional host are what Amazon documents', async () => {
  const calls = fakeAmazon();
  await fetchAmazonAdsRows(conn({ amazon_region: 'EU' }), env,
    { startDate: '2026-11-19', endDate: '2026-11-19' }, { now: NOW, sleepFn: noSleep });
  const [create] = calls.filter((c) => c.kind === 'create');
  assert.equal(create.headers['Amazon-Advertising-API-ClientId'], env.AMAZON_ADS_CLIENT_ID);
  assert.equal(create.headers['Amazon-Advertising-API-Scope'], '3333333333333333');
  assert.equal(create.headers.Authorization, 'Bearer Atza|test');
  assert.equal(create.headers['Content-Type'], 'application/vnd.createasyncreportrequest.v3+json');
  assert.equal(create.body.configuration.timeUnit, 'DAILY');
  assert.equal(create.body.configuration.format, 'GZIP_JSON');
  assert.deepEqual(create.body.configuration.groupBy, ['campaign']);
  assert.equal(amazonAdsHost('EU'), 'https://advertising-api-eu.amazon.com');
  assert.equal(amazonAdsHost('fe'), 'https://advertising-api-fe.amazon.com');
  assert.throws(() => amazonAdsHost('UK'), /NA, EU or FE/);
});

await test('a connection with no profile, no region or no token fails loudly', async () => {
  fakeAmazon();
  const w = { startDate: '2026-11-19', endDate: '2026-11-19' };
  await assert.rejects(() => fetchAmazonAdsRows(conn({ amazon_profile_id: null }), env, w, { now: NOW, sleepFn: noSleep }),
    /amazon_profile_id/);
  await assert.rejects(() => fetchAmazonAdsRows(conn({ access_token: null }), env, w, { now: NOW, sleepFn: noSleep }),
    /access token/i);
  await assert.rejects(() => fetchAmazonAdsRows(conn({ amazon_region: null }), env, w, { now: NOW, sleepFn: noSleep }),
    /NA, EU or FE/);
  await assert.rejects(() => fetchAmazonAdsRows(conn(), {}, w, { now: NOW, sleepFn: noSleep }),
    /AMAZON_ADS_CLIENT_ID/);
});

// ── The real wiring ─────────────────────────────────────────────────────────
// Everything above tests the fetcher. These run runConnectionSync itself --
// the function the nightly and the bootstrap both call -- so the token
// refresh, the row mapping, the stored identity and the partial-import
// warning are proved on the integrated path rather than on the helper.

const { runConnectionSync } = await loadCore();

/** Just enough Supabase for runConnectionSync: it upserts marketing_kpis_daily
 * and nothing else for a non-Meta platform. */
function fakeSupabase() {
  const writes = [];
  return {
    writes,
    from(table) {
      return {
        upsert: async (rows, opts) => { writes.push({ table, rows, opts }); return { error: null }; },
      };
    },
  };
}

await test('runConnectionSync stores Amazon rows as marketing_kpis_daily, keyed on identity alone', async () => {
  fakeAmazon({ rowsFor: (key) => (key.startsWith('spCampaigns') ? [spRow('2026-11-19')] : []) });
  const db = fakeSupabase();
  const refreshed = [];
  // The LwA refresh is part of the path, so it is answered here rather than
  // stubbed out: the sync mints an access token on every run because Amazon's
  // last sixty minutes.
  const realFakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.amazon.com/auth/o2/token')) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'Atzr|stored');
      assert.equal(body.get('client_id'), env.AMAZON_ADS_CLIENT_ID);
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'Atza|fresh', expires_in: 3600 }),
        json: async () => ({ access_token: 'Atza|fresh', expires_in: 3600 }),
      };
    }
    return realFakeFetch(url, opts);
  };

  const connection = {
    id: 'conn-1', company_entity_id: 'co-1', platform: 'amazon_ads',
    display_name: 'Acme US', amazon_profile_id: '3333333333333333', amazon_region: 'NA',
    refresh_token: 'Atzr|stored', days_back: 1,
  };
  const result = await runConnectionSync(db, env, connection, {
    batchId: 'batch-1',
    now: NOW,
    onTokenRefresh: async (token, expiresAt) => refreshed.push({ token, expiresAt }),
  });

  assert.equal(refreshed.length, 1, 'the rotated access token must be handed back to the orchestrator to store');
  assert.equal(refreshed[0].token, 'Atza|fresh');
  assert.equal(result.platform, 'amazon_ads');
  assert.equal(result.kpi_rows_upserted, 1);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].table, 'marketing_kpis_daily');
  assert.equal(db.writes[0].opts.onConflict, 'row_hash');
  const [stored] = db.writes[0].rows;
  assert.equal(stored.platform, 'amazon_ads');
  assert.equal(stored.source, 'amazon_ads_api');
  assert.equal(stored.company_entity_id, 'co-1');
  assert.equal(stored.connection_id, 'conn-1');
  assert.equal(stored.account_id, '3333333333333333');
  assert.equal(stored.campaign_id, '101');
  assert.equal(stored.day_date, '2026-11-19');
  assert.equal(stored.spend, 12.34);
  assert.equal(stored.conversions, 5);
  assert.equal(stored.conversion_value, 210.5);
  assert.ok(stored.row_hash, 'rows are upserted on a row_hash');
  globalThis.fetch = realFakeFetch;

  // Identity only: Amazon restates purchases and sales for weeks after the
  // day, so a restated figure has to update the SAME row. Proved by running
  // the same day again with every metric changed and comparing the hash --
  // not by looking for the numbers inside it, which a one-digit metric would
  // match by chance.
  const restated = {
    ...spRow('2026-11-19'), impressions: '2000', clicks: '80', cost: '99.99',
    purchases7d: '11', sales7d: '999.00',
  };
  fakeAmazon({ rowsFor: (key) => (key.startsWith('spCampaigns') ? [restated] : []) });
  const again = fakeSupabase();
  const afterFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.amazon.com/auth/o2/token')) {
      const body = { access_token: 'Atza|fresh', expires_in: 3600 };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
    }
    return afterFetch(url, opts);
  };
  await runConnectionSync(again, env, connection, { batchId: 'batch-2', now: NOW });
  const [restoredRow] = again.writes[0].rows;
  assert.equal(restoredRow.row_hash, stored.row_hash,
    'a restated day must upsert the same row, so no metric may be part of the identity');
  assert.equal(restoredRow.spend, 99.99);
  globalThis.fetch = afterFetch;
});

await test('a partial Amazon import says so on the sync’s own report', async () => {
  fakeAmazon({
    statusSequence: (key) => (key.startsWith('sdCampaigns') ? ['FAILED'] : ['COMPLETED']),
    rowsFor: (key) => (key.startsWith('spCampaigns') ? [spRow('2026-11-19')] : []),
  });
  const db = fakeSupabase();
  const realFakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.amazon.com/auth/o2/token')) {
      const body = { access_token: 'Atza|fresh', expires_in: 3600 };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
    }
    return realFakeFetch(url, opts);
  };
  const result = await runConnectionSync(db, env, {
    id: 'conn-1', company_entity_id: 'co-1', platform: 'amazon_ads',
    amazon_profile_id: '3333333333333333', amazon_region: 'NA', refresh_token: 'Atzr|stored', days_back: 1,
  }, { batchId: 'b', now: NOW });
  // The Sponsored Products rows still landed -- that is the point of not
  // failing the run -- and the report names what did not.
  assert.equal(result.kpi_rows_upserted, 1);
  assert.match(result.warning, /sdCampaigns/);
  assert.match(result.warning, /ad products not read/);
  globalThis.fetch = realFakeFetch;
});

await test('an Amazon connection with no refresh token fails before any report is requested', async () => {
  const calls = fakeAmazon();
  await assert.rejects(() => runConnectionSync(fakeSupabase(), env, {
    id: 'conn-1', company_entity_id: 'co-1', platform: 'amazon_ads',
    amazon_profile_id: '1', amazon_region: 'NA', refresh_token: null, days_back: 1,
  }, { batchId: 'b', now: NOW }), /refresh token/i);
  assert.equal(calls.length, 0, 'nothing should have been asked of Amazon');
});
