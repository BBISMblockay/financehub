/* Search performance (/v2/seo-overview.html): the date range it asks Google
 * Search Console for.
 *
 * Why this suite exists. This page is the one Marketing surface whose window
 * does NOT end today: Google finalises its data two to three days back, and
 * `search_console_overview(p_days, p_end)` defaults `p_end` to the newest day
 * SILO has ingested. When the page gained typed calendar dates (2026-11-20,
 * the shared control in v2/silo-date-range.js), that left two cases that must
 * not be confused:
 *
 *   a quick pick  -> p_end null, so the window still ends on the finalised
 *                    day, and the fields are repainted with the window the
 *                    RPC actually read while the quick pick stays lit;
 *   typed dates   -> p_days = the span and p_end = the typed end, exactly as
 *                    asked, and no quick pick claims to be the window.
 *
 * Getting that backwards would report a window whose last days have no rows
 * and read as a decline. Runs the REAL page against a fake Supabase.
 *
 * Mutations (each must fail at least one assertion):
 *   SCR_MUTATION=end-ignored    a typed end is dropped, so the RPC anchors on the newest day
 *   SCR_MUTATION=end-forced     a quick pick sends today as the end instead of null
 *   SCR_MUTATION=fields-stale   the fields keep showing a window that was not read
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('seo-search-performance-range');

const MUTATIONS = {
  'end-ignored': ['/seo-overview.html', '      WINDOW_END = r.rolling ? null : r.end;\n      setUrlParams(dateRange.urlParams());', '      WINDOW_END = null;\n      setUrlParams(dateRange.urlParams());'],
  'end-forced': ['/seo-overview.html', '      WINDOW_END = r.rolling ? null : r.end;\n      setUrlParams(dateRange.urlParams());', '      WINDOW_END = r.end;\n      setUrlParams(dateRange.urlParams());'],
  'fields-stale': ['/seo-overview.html', '      if (w.start && w.end) dateRange.apply({ start: w.start, end: w.end, preset: dateRange.get().preset });', ''],
};
const MUT = process.env.SCR_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT) return source;
  const [file, from, to] = MUTATIONS[MUT];
  if (!rel.endsWith(file)) return source;
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const minus = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
// Google has finalised up to three days ago; today and yesterday are not in.
const FINAL = day(3);

// The real RPC's shape, reduced to what the page reads. The window is computed
// the way the SQL does: end = p_end or the newest ingested day, start = end -
// (p_days - 1). Self-contained on purpose: an RPC fixture is stringified
// across into the page, so it can close over nothing out here.
const overview = (args) => {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const back = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const final = d(3);
  const end = args.p_end || final;
  const start = back(end, (args.p_days || 28) - 1);
  return {
    freshness: { max_day: final, min_day: d(400), days_ingested: 397, lag_days: 3, property_count: 1, last_synced_at: null, site_url: 'https://example.com' },
    window: { start, end, days_requested: args.p_days, days_present: args.p_days, prior_start: back(start, args.p_days), prior_end: back(start, 1) },
    current: { clicks: 120, impressions: 9000, ctr: 0.013, position: 14.2, days_present: args.p_days, query_5000_row_days: 0, unmeasured_days: 0, truncated_days: 0, page_attributed_share: 0.8, query_attributed_share: 0.7 },
    prior: { clicks: 100, impressions: 8000, ctr: 0.0125, position: 15.0 },
    series: [{ day: start, clicks: 10, impressions: 800, ctr: 0.0125, position: 14, query_5000_rows: false }],
  };
};

const ready = () => /days loaded|Load failed/.test(document.getElementById('status')?.textContent || '');
const rpcCalls = (page, name) => page.evaluate((n) => window.__QUERIES__.filter((q) => q.table === 'rpc:' + n).map((q) => q.args), name);
const fields = (page) => page.$$eval('.sdr-range input', (i) => i.map((x) => x.value));
const lit = (page) => page.$$eval('.sdr-presets .bcn-btn.is-active', (b) => b.map((x) => x.textContent));

(async () => {
  const suite = await startSuite({ transform });
  try {
    const rpc = { search_console_overview: overview, search_console_top_pages: () => [], search_console_top_queries: () => [] };

    // ── 1. The default: 28 days ending on the FINALISED day, not today ───
    let page = await suite.open('/v2/seo-overview.html', {}, { rpc, ready });
    R.eq(await page.$$eval('.sdr-presets .bcn-btn', (b) => b.map((x) => x.textContent)), ['7d', '28d', '90d', '1y'], 'quick picks');
    R.eq(await rpcCalls(page, 'search_console_overview'), [{ p_days: 28, p_end: null }], 'a quick pick leaves the end to the RPC');
    R.eq(await lit(page), ['28d'], 'the quick pick is marked');
    R.eq(await fields(page), [minus(FINAL, 27), FINAL], 'and the fields show the window that was read, ending on the final day');

    // ── 2. A quick pick stays a rolling, finalised window ────────────────
    await page.click('.sdr-presets .bcn-btn[data-days="90"]');
    await page.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'rpc:search_console_overview').length === 2);
    R.eq((await rpcCalls(page, 'search_console_overview'))[1], { p_days: 90, p_end: null }, '90d also leaves the end null');
    await page.waitForFunction((d) => document.querySelectorAll('.sdr-range input')[0].value === d, minus(FINAL, 89));
    R.eq(await fields(page), [minus(FINAL, 89), FINAL], 'the fields follow the window that was read');
    R.eq(await lit(page), ['90d'], 'and 90d is still what is marked');
    R.eq(await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search))), { days: '90' },
      'a quick pick is carried as a day count, so a shared link keeps rolling');

    // ── 3. Typed calendar dates are sent exactly as typed ────────────────
    await page.evaluate(([s, e]) => {
      const i = document.querySelectorAll('.sdr-range input');
      i[0].value = s; i[1].value = e;
      i[1].dispatchEvent(new Event('change'));
    }, [day(40), day(20)]);
    await page.waitForFunction(() => window.__QUERIES__.filter((q) => q.table === 'rpc:search_console_overview').length === 3);
    const typed = (await rpcCalls(page, 'search_console_overview'))[2];
    R.eq(typed, { p_days: 21, p_end: day(20) }, 'the span and the typed end, not the newest day');
    R.eq(await lit(page), [], 'no quick pick claims to be the window');
    R.eq(await fields(page), [day(40), day(20)], 'the fields keep the dates that were typed');
    R.eq(await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search))), { start: day(40), end: day(20) },
      'and the range is in the address bar as dates');
    const pages = await rpcCalls(page, 'search_console_top_pages');
    R.ok('the page and query tables read the same window', pages.length > 0 && pages[pages.length - 1].p_end === day(20),
      JSON.stringify(pages[pages.length - 1]));
    await page.close();

    // ── 4. A shared link lands on the same days ──────────────────────────
    page = await suite.open(`/v2/seo-overview.html?start=${day(40)}&end=${day(20)}`, {}, { rpc, ready });
    R.eq(await rpcCalls(page, 'search_console_overview'), [{ p_days: 21, p_end: day(20) }], 'the link is the window, read once');
    R.eq(await fields(page), [day(40), day(20)], 'and it is what the fields show');
    await page.close();

    // ── 5. A range that is not real dates falls back, and is not sent ────
    page = await suite.open('/v2/seo-overview.html?start=2026-02-31&end=2026-03-02', {}, { rpc, ready });
    R.eq(await rpcCalls(page, 'search_console_overview'), [{ p_days: 28, p_end: null }], 'an impossible date is the default window');
    R.eq(await lit(page), ['28d'], 'and says so');
    await page.close();
  } catch (err) {
    R.ok('suite ran to completion', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
