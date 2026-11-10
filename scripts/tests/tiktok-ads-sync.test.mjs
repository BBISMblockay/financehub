// TikTok Ads reporting fetch: the window chunking and the metric mapping.
//
// Both facts under test are TikTok's, not SILO's, and neither is visible from
// the call site: a report whose dimensions include stat_time_day refuses a
// range wider than 30 days, and `total_complete_payment_rate` is a currency
// AMOUNT despite its name. The first-connect bootstrap asks for 90 days, so
// without chunking a new customer's first TikTok import returns an error and
// writes nothing.
//
// Mutations (each must fail at least one assertion):
//   TIKTOK_SYNC_MUTATION=chunk        the 30-day cap is ignored and the whole window asked at once
//   TIKTOK_SYNC_MUTATION=gap          chunks skip a day between them
//   TIKTOK_SYNC_MUTATION=paging       only the first page of a chunk is read
//   TIKTOK_SYNC_MUTATION=valuemetric  purchase value is swapped for the real rate metric
//
// Run: node --test scripts/tests/tiktok-ads-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MUT = process.env.TIKTOK_SYNC_MUTATION || '';
const libUrl = new URL('../lib/ad-platforms-sync-core.mjs', import.meta.url);

async function loadCore() {
  let src = fs.readFileSync(libUrl, 'utf8');
  const sub = (from, to) => {
    assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
    src = src.split(from).join(to);
  };
  if (MUT === 'chunk') sub('{ chunkDays = 30 } = {}', '{ chunkDays = 365 } = {}');
  if (MUT === 'gap') sub('s = new Date(e.getTime() + 86400000);', 's = new Date(e.getTime() + 2 * 86400000);');
  if (MUT === 'paging') sub('totalPages = Number(pageInfo.total_page ?? 1);', 'totalPages = 1;');
  if (MUT === 'valuemetric') sub("'complete_payment', 'total_complete_payment_rate',", "'complete_payment', 'complete_payment_rate',");
  // Imported from a temp file with the one relative import rewritten to an
  // absolute URL, so the copy resolves the repo's own modules.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-sync-'));
  src = src.replace("'./shopify-sync-core.mjs'", `'${new URL('./shopify-sync-core.mjs', libUrl).href}'`);
  const file = path.join(dir, 'ad-platforms-sync-core.mjs');
  fs.writeFileSync(file, src);
  return import(file);
}
const { fetchTiktokAdsRows } = await loadCore();

const conn = (over = {}) => ({
  access_token: 'tt-token', tiktok_advertiser_id: '7012345678901234567',
  display_name: 'Test advertiser', ...over,
});

/** Records every report request and answers with one row per request. */
function fakeTikTok({ pagesByRequest = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get('page'));
    calls.push({
      advertiserId: u.searchParams.get('advertiser_id'),
      start: u.searchParams.get('start_date'),
      end: u.searchParams.get('end_date'),
      page,
      pageSize: u.searchParams.get('page_size'),
      accessToken: opts.headers?.['Access-Token'],
    });
    const key = `${u.searchParams.get('start_date')}`;
    const totalPages = pagesByRequest[key] ?? 1;
    const body = {
      code: 0,
      message: 'OK',
      data: {
        list: [{
          dimensions: { campaign_id: `c-${key}-${page}`, stat_time_day: `${key} 00:00:00` },
          metrics: {
            campaign_name: 'Spring',
            impressions: '1000', clicks: '10', spend: '25.50',
            complete_payment: '3',
            // Answers only the metric that was asked for, so swapping the
            // metric name leaves the value absent rather than silently right.
            ...(JSON.parse(u.searchParams.get('metrics')).includes('total_complete_payment_rate')
              ? { total_complete_payment_rate: '180.75' } : { complete_payment_rate: '0.04' }),
          },
        }],
        page_info: { page, page_size: 1000, total_number: totalPages, total_page: totalPages },
      },
    };
    // The core reads the body with res.text() and parses it itself.
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

await test('a 90-day bootstrap window is split into contiguous chunks of at most 30 days', async () => {
  const calls = fakeTikTok();
  await fetchTiktokAdsRows(conn(), { startDate: '2026-08-12', endDate: '2026-11-09' });
  const windows = calls.map((c) => [c.start, c.end]);
  assert.ok(windows.length >= 3, `expected the window to be chunked, got ${JSON.stringify(windows)}`);
  for (const [start, end] of windows) {
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
    assert.ok(days <= 30, `chunk ${start}..${end} spans ${days} days, over TikTok's 30-day cap`);
  }
  // No gap and no overlap: every day of the asked-for window is covered once.
  assert.equal(windows[0][0], '2026-08-12');
  assert.equal(windows[windows.length - 1][1], '2026-11-09');
  for (let i = 1; i < windows.length; i += 1) {
    const prevEnd = Date.parse(`${windows[i - 1][1]}T00:00:00Z`);
    const thisStart = Date.parse(`${windows[i][0]}T00:00:00Z`);
    assert.equal(thisStart - prevEnd, 86400000,
      `chunks ${windows[i - 1]} and ${windows[i]} are not contiguous`);
  }
});

await test('a 30-day nightly window is one request, as it always was', async () => {
  const calls = fakeTikTok();
  await fetchTiktokAdsRows(conn(), { startDate: '2026-10-11', endDate: '2026-11-09' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].start, '2026-10-11');
  assert.equal(calls[0].end, '2026-11-09');
  assert.equal(calls[0].accessToken, 'tt-token');
  assert.equal(calls[0].pageSize, '1000');
});

await test('every page of every chunk is read', async () => {
  const calls = fakeTikTok({ pagesByRequest: { '2026-10-11': 3 } });
  const rows = await fetchTiktokAdsRows(conn(), { startDate: '2026-10-11', endDate: '2026-11-09' });
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3]);
  assert.equal(rows.length, 3);
});

await test('purchase value maps to conversionValue, purchases to conversions', async () => {
  fakeTikTok();
  const [row] = await fetchTiktokAdsRows(conn(), { startDate: '2026-11-09', endDate: '2026-11-09' });
  assert.equal(row.day, '2026-11-09');
  assert.equal(row.conversions, '3');
  // total_complete_payment_rate is website purchase VALUE in account currency.
  // If this ever reads like a rate (0-1 or 0-100 of something), the metric was
  // swapped for complete_payment_rate and every TikTok ROAS figure is wrong.
  assert.equal(row.conversionValue, '180.75');
  assert.equal(row.spend, '25.50');
  assert.equal(row.accountId, '7012345678901234567');
});

await test('a connection with no advertiser chosen, or no token, fails loudly', async () => {
  fakeTikTok();
  await assert.rejects(() => fetchTiktokAdsRows(conn({ tiktok_advertiser_id: null }), { startDate: '2026-11-01', endDate: '2026-11-09' }),
    /tiktok_advertiser_id/);
  await assert.rejects(() => fetchTiktokAdsRows(conn({ access_token: null }), { startDate: '2026-11-01', endDate: '2026-11-09' }),
    /access token/i);
});
