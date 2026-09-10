// Google Search Console → search_console_{site,page,query}_daily.
// Called by scripts/ad-platforms-sync.mjs (nightly) and
// scripts/search-console-backfill.mjs (manual history), both through
// runSearchConsoleSync(); the backfill wraps it in runSearchConsoleBackfill()
// to walk a long range in chunks so a failure keeps what it already wrote.
//
// THREE GRAINS, THREE TABLES, NEVER ONE FIGURE. Everything about this shape
// was MEASURED against the live property on 2026-09-10 by
// scripts/search-console-probe.mjs rather than recalled, and the numbers are
// the reason for each decision:
//
//   site  (dimensions: date)        the undimensioned daily total -- the
//                                   DENOMINATOR that makes the other two
//                                   honest.
//   page  (dimensions: date, page)  recovered 102.8% of clicks IN AGGREGATE
//                                   over 28 days. That is NOT a per-row
//                                   guarantee: Google documents that the API
//                                   does not return every row, even when
//                                   paging, so a page absent on a day is
//                                   "not returned", never "zero clicks".
//                                   Over 100% because Google counts one site
//                                   impression per QUERY but one page
//                                   impression per URL shown, so page-level
//                                   impressions/CTR/position are a different
//                                   measure from site-level ones, not a
//                                   breakdown of them.
//   query (dimensions: date, query) recovered 56.9% of site clicks in the
//                                   probe window. The remainder has no
//                                   returned query row; anonymisation and
//                                   internal API limits may both contribute.
//                                   Repeated 5,000-row daily averages in the
//                                   backfill are an observed pattern, not a
//                                   confirmed cap or proof of a top-N day.
//                                   Google documents a 50,000-row daily
//                                   maximum per search type, without a
//                                   completeness guarantee.
// https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data
//
// So each sync computes, PER DAY, how many clicks and impressions the page
// and query cuts recovered, and writes those sums onto the site row next to
// the day's total. The unattributed remainder is then a stored fact on the
// row a reader is already looking at, computed from the same fetch that
// produced the detail rows -- not a number a reader has to know to derive,
// and not one a later query can get wrong by summing a table that has since
// gained or lost rows.
//
// Query x page is deliberately NOT ingested. The probe showed it recovers no
// more than query alone (58.2% vs 56.9%), so it adds no measurement, and a
// table shaped that way invites exactly the "this query brought traffic to
// this page" inference the withheld rows make unsupportable.
//
// Windowing: Search Console's newest FINAL day was 2 days back on the day it
// was measured, and `dataState: 'all'` reaches today with partial days that
// restate upward. Every request here is dataState 'final' and the window
// ends LAG_DAYS back in PACIFIC time (the business day; see pacificDateOnly).
// Ingesting 'all' would write days that later change and make a baseline
// unreliable, which is the one thing seo_measurements cannot tolerate.

import {
  isoDateOnly,
  addDays,
  pacificDateOnly,
  upsertInChunks,
  fetchWithRetry,
} from './shopify-sync-core.mjs';
import { refreshGoogleAccessToken } from './ad-platforms-sync-core.mjs';

export const SEARCH_CONSOLE_API = 'https://www.googleapis.com/webmasters/v3';
export const SEARCH_CONSOLE_SOURCE = 'search_console_api';
export const SEARCH_CONSOLE_JOB_TYPE = 'search_console_daily';

/** Days behind Pacific today that the newest FINAL day sits. Measured 2 on
 * 2026-09-10 (final ended 2026-09-08). Overridable per run because the lag
 * is Google's to change, and a run that ends its window too early is merely
 * late while one that ends it too late writes provisional days. */
export const DEFAULT_LAG_DAYS = 2;

/** The API accepted 25,000 rows per page on the probe (it documents this as
 * the maximum). Paging is by startRow until a short page comes back. */
export const ROW_LIMIT = 25000;

/** A guard, not a budget: 400 pages x 25,000 rows is 10M rows in one cut,
 * far beyond a 30-day window on this property (date x query was 6 pages for
 * 28 days). Hitting it means the window is far too wide for one call, and
 * the site rows for the window are flagged is_truncated rather than the
 * fetch being silently treated as complete. */
export const MAX_PAGES_PER_CUT = 400;

/** The window for one sync: `daysBack + 1` days ending LAG_DAYS back in
 * Pacific time. Same start/end convention as computeWindow() in
 * ad-platforms-sync-core (start = end - daysBack), so a days_back of 30 on
 * the connection means the same thing for every Google platform. */
export function searchConsoleWindow(now, daysBack, lagDays = DEFAULT_LAG_DAYS) {
  const today = pacificDateOnly(new Date(now));
  const end = addDays(new Date(`${today}T00:00:00Z`), -Number(lagDays));
  // `?? 30`, not `|| 30`: a daysBack of 0 is a one-day window (the backfill
  // passes days - 1), and `||` would silently turn it into 31 days.
  const back = Number.isFinite(Number(daysBack)) && daysBack !== null && daysBack !== '' ? Number(daysBack) : 30;
  const start = addDays(end, -back);
  return { startDate: isoDateOnly(start), endDate: isoDateOnly(end) };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** One searchAnalytics.query request. `dataState: 'final'` is set HERE, on
 * every request, and not left to the caller -- a request that omits it gets
 * Google's default, which is also final today, but a future default change
 * or a copied body with 'all' in it would silently start ingesting partial
 * days. Pinning it at the one place requests are built is the guard. */
async function scQuery(site, body, accessToken, label, fetchImpl) {
  const url = `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, dataState: 'final' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Search Console ${label} → ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text || '{}'); } catch {
    throw new Error(`Search Console ${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** Page through one dimension cut until a short page comes back. Returns the
 * rows and whether the page guard cut the walk short -- a caller must not
 * treat a guarded fetch as complete. */
export async function fetchSearchConsoleCut(site, window, dimensions, accessToken, {
  fetchImpl = fetchWithRetry,
  rowLimit = ROW_LIMIT,
  maxPages = MAX_PAGES_PER_CUT,
} = {}) {
  const rows = [];
  let startRow = 0;
  let pages = 0;
  const label = dimensions.join('x');
  while (pages < maxPages) {
    const page = await scQuery(site, {
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions,
      rowLimit,
      startRow,
    }, accessToken, label, fetchImpl);
    const batch = page.rows ?? [];
    rows.push(...batch);
    pages += 1;
    if (batch.length < rowLimit) return { rows, pages, truncated: false };
    startRow += rowLimit;
  }
  return { rows, pages, truncated: true };
}

/** Turn the three fetched cuts into the three tables' rows. Pure, so the
 * arithmetic that decides the unattributed share is testable without a
 * network: given these cuts, these are the rows. */
export function buildSearchConsoleRows(connection, site, cuts, { syncedAt, batchId, truncated }) {
  const base = {
    company_entity_id: connection.company_entity_id,
    connection_id: connection.id,
    site_url: site,
    synced_at: syncedAt,
    sync_batch_id: batchId ?? null,
  };
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''));

  const pageRows = [];
  const pageSums = new Map(); // day -> { rows, clicks, impressions }
  for (const r of cuts.page) {
    const [day, page] = r.keys ?? [];
    if (!isDay(day) || !page) continue;
    pageRows.push({
      ...base, day_date: day, page: String(page),
      clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)),
      ctr: num(r.ctr), position: num(r.position),
    });
    const s = pageSums.get(day) || { rows: 0, clicks: 0, impressions: 0 };
    s.rows += 1; s.clicks += Math.round(num(r.clicks)); s.impressions += Math.round(num(r.impressions));
    pageSums.set(day, s);
  }

  const queryRows = [];
  const querySums = new Map();
  for (const r of cuts.query) {
    const [day, query] = r.keys ?? [];
    if (!isDay(day) || query == null || query === '') continue;
    queryRows.push({
      ...base, day_date: day, query: String(query),
      clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)),
      ctr: num(r.ctr), position: num(r.position),
    });
    const s = querySums.get(day) || { rows: 0, clicks: 0, impressions: 0 };
    s.rows += 1; s.clicks += Math.round(num(r.clicks)); s.impressions += Math.round(num(r.impressions));
    querySums.set(day, s);
  }

  // A day with a site total and NO query rows is a day Google attributed
  // nothing to any query -- attributed = 0, a measured fact -- not a day
  // nobody measured (null). The || {rows:0,...} default below is what keeps
  // those two apart: the site row is only built from days the site cut
  // returned, and for each of those the detail cuts were fetched in the same
  // run, so an absent detail day IS zero attribution.
  const siteRows = [];
  for (const r of cuts.site) {
    const [day] = r.keys ?? [];
    if (!isDay(day)) continue;
    const p = pageSums.get(day) || { rows: 0, clicks: 0, impressions: 0 };
    const q = querySums.get(day) || { rows: 0, clicks: 0, impressions: 0 };
    siteRows.push({
      ...base, day_date: day,
      clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)),
      ctr: num(r.ctr), position: num(r.position),
      page_rows: p.rows, page_attributed_clicks: p.clicks, page_attributed_impressions: p.impressions,
      query_rows: q.rows, query_attributed_clicks: q.clicks, query_attributed_impressions: q.impressions,
      data_state: 'final',
      is_truncated: Boolean(truncated.page || truncated.query || truncated.site),
    });
  }

  return { siteRows, pageRows, queryRows };
}

/** Sync one window for one connection. Fetches all three cuts, builds the
 * rows, then upserts page → query → SITE LAST: the site row carries the
 * attributed sums, so it must never describe detail rows that a failed
 * upsert did not write. A failure in either detail upsert leaves the site
 * rows for the window untouched (previous run's values, or absent), which
 * reads as "not yet measured" rather than as a share of rows that are not
 * there. */
export async function runSearchConsoleSync(supabase, env, connection, {
  batchId = null,
  now = new Date(),
  daysBackOverride = null,
  lagDays = DEFAULT_LAG_DAYS,
  window = null,
  accessToken = null,
  onTokenRefresh = null,
  fetchImpl = fetchWithRetry,
  maxPages = MAX_PAGES_PER_CUT,
} = {}) {
  const site = connection.search_console_site_url;
  if (!site) {
    throw new Error('search_console_site_url not set on connection — Test the connection in Integrations and paste a property from the list');
  }
  const win = window || searchConsoleWindow(now, daysBackOverride ?? connection.days_back ?? 30, lagDays);
  if (win.startDate > win.endDate) throw new Error(`Search Console window is empty: ${win.startDate}..${win.endDate}`);
  const syncedAt = new Date().toISOString();

  let token = accessToken;
  if (!token) {
    if (!connection.refresh_token) throw new Error('No refresh token — reconnect via OAuth');
    const fresh = await refreshGoogleAccessToken(env, connection.refresh_token);
    token = fresh.accessToken;
    if (onTokenRefresh) await onTokenRefresh(fresh.accessToken, fresh.expiresAt);
  }

  const opts = { fetchImpl, maxPages };
  const siteCut = await fetchSearchConsoleCut(site, win, ['date'], token, opts);
  const pageCut = await fetchSearchConsoleCut(site, win, ['date', 'page'], token, opts);
  const queryCut = await fetchSearchConsoleCut(site, win, ['date', 'query'], token, opts);

  const truncated = { site: siteCut.truncated, page: pageCut.truncated, query: queryCut.truncated };
  const { siteRows, pageRows, queryRows } = buildSearchConsoleRows(
    connection, site,
    { site: siteCut.rows, page: pageCut.rows, query: queryCut.rows },
    { syncedAt, batchId, truncated },
  );

  const pageUpserted = await upsertInChunks(supabase, 'search_console_page_daily', pageRows,
    'company_entity_id,site_url,day_date,page');
  const queryUpserted = await upsertInChunks(supabase, 'search_console_query_daily', queryRows,
    'company_entity_id,site_url,day_date,query');
  const siteUpserted = await upsertInChunks(supabase, 'search_console_site_daily', siteRows,
    'company_entity_id,site_url,day_date');

  const totalClicks = siteRows.reduce((a, r) => a + r.clicks, 0);
  const share = (n) => (totalClicks > 0 ? Number((n / totalClicks).toFixed(4)) : null);

  return {
    platform: 'search_console',
    site_url: site,
    window: win,
    data_state: 'final',
    days_with_data: siteRows.length,
    site_rows_upserted: siteUpserted,
    page_rows_upserted: pageUpserted,
    query_rows_upserted: queryUpserted,
    total_clicks: totalClicks,
    // The window's attribution shares, so a run log states the 43% rather
    // than leaving it to be discovered again by the next person.
    query_attributed_click_share: share(siteRows.reduce((a, r) => a + r.query_attributed_clicks, 0)),
    page_attributed_click_share: share(siteRows.reduce((a, r) => a + r.page_attributed_clicks, 0)),
    truncated,
    pages_fetched: { site: siteCut.pages, page: pageCut.pages, query: queryCut.pages },
    synced_at: syncedAt,
  };
}

/** Split [startDate, endDate] into chunks of `chunkDays`, NEWEST FIRST, so a
 * backfill that dies part-way leaves the most recent history in place --
 * the part every follow-up window reads first. */
export function backfillChunks(startDate, endDate, chunkDays) {
  const chunks = [];
  let end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(`${startDate}T00:00:00Z`);
  const size = Math.max(1, Number(chunkDays) || 28);
  while (end >= start) {
    let chunkStart = addDays(end, -(size - 1));
    if (chunkStart < start) chunkStart = start;
    chunks.push({ startDate: isoDateOnly(chunkStart), endDate: isoDateOnly(end) });
    end = addDays(chunkStart, -1);
  }
  return chunks;
}

/** Walk a range chunk by chunk, each chunk a full fetch+upsert through
 * runSearchConsoleSync, so progress persists per chunk. Stops at the first
 * failing chunk and REPORTS it, with the chunks that completed -- a
 * backfill that wrote 400 days and then failed must not print the same
 * shape as one that wrote nothing (the landing-pages backfill lesson,
 * run #354). The token is refreshed per chunk: a long backfill can outlive
 * a one-hour access token, and refreshing is one cheap request. */
export async function runSearchConsoleBackfill(supabase, env, connection, {
  startDate,
  endDate,
  chunkDays = 28,
  batchId = null,
  fetchImpl = fetchWithRetry,
  onChunk = null,
  onTokenRefresh = null,
} = {}) {
  const chunks = backfillChunks(startDate, endDate, chunkDays);
  const completed = [];
  let failed = null;
  for (const chunk of chunks) {
    try {
      const result = await runSearchConsoleSync(supabase, env, connection, {
        batchId, window: chunk, fetchImpl, onTokenRefresh,
      });
      completed.push(result);
      if (onChunk) await onChunk(result);
    } catch (err) {
      failed = { window: chunk, error: String(err?.message || err) };
      break;
    }
  }
  const sum = (k) => completed.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    platform: 'search_console',
    site_url: connection.search_console_site_url,
    range: { startDate, endDate },
    chunk_days: chunkDays,
    chunks_planned: chunks.length,
    chunks_completed: completed.length,
    days_with_data: sum('days_with_data'),
    site_rows_upserted: sum('site_rows_upserted'),
    page_rows_upserted: sum('page_rows_upserted'),
    query_rows_upserted: sum('query_rows_upserted'),
    covered: completed.length
      ? { startDate: completed.at(-1).window.startDate, endDate: completed[0].window.endDate }
      : null,
    failed,
  };
}
