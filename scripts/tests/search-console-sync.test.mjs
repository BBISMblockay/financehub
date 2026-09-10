/* Search Console sync: window, attribution arithmetic, write order, paging,
 * chunked backfill.
 *
 * These pin the properties that the probe measurements turned into design
 * decisions (docs/ops/seo-project.md, Step 2b) and that a diff does not show:
 *
 *   1. Every request is dataState=final and the window ends LAG days back in
 *      PACIFIC time. Ingesting 'all' writes partial days that restate upward.
 *   2. The site row's attributed sums are computed from the SAME fetch as the
 *      detail rows, per day, and a day with a site total but no query rows
 *      records attributed = 0 (measured), never null (unmeasured).
 *   3. Site rows are written LAST, so a failed detail upsert can never leave
 *      a site row describing rows that are not there.
 *   4. A full page fetches the next page by startRow; a short page stops; the
 *      page guard flags is_truncated instead of pretending completeness.
 *   5. query x page is never requested.
 *   6. The backfill walks newest-first in chunks, keeps completed chunks when
 *      a later one fails, and reports which days landed.
 *
 * Everything is stubbed: a fake fetch and the in-memory fake Supabase. No
 * network, no database, no secrets.
 */

import assert from 'node:assert/strict';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import {
  searchConsoleWindow,
  buildSearchConsoleRows,
  fetchSearchConsoleCut,
  runSearchConsoleSync,
  runSearchConsoleBackfill,
  backfillChunks,
  DEFAULT_LAG_DAYS,
  ROW_LIMIT,
} from '../lib/search-console-sync-core.mjs';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };

const CONNECTION = {
  id: 'conn-sc',
  company_entity_id: 'co-1',
  platform: 'search_console',
  search_console_site_url: 'https://www.baseballism.com/',
  refresh_token: 'rt',
  days_back: 30,
};
const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' };
const SITE = CONNECTION.search_console_site_url;

/** A fake Search Console. `data` maps a dimension key ('date', 'date,page',
 * 'date,query') to the rows Google would return for the whole window; the
 * fake pages them by rowLimit/startRow exactly as the API does. Every request
 * body is recorded so the tests can assert what was asked, not only what
 * came back. */
function fakeSearchConsole(data, { failOn = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url, body });
    if (failOn && failOn(body)) {
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    const key = (body.dimensions || []).join(',');
    const all = (data[key] || []).filter((r) => r.keys[0] >= body.startDate && r.keys[0] <= body.endDate);
    const page = all.slice(body.startRow || 0, (body.startRow || 0) + body.rowLimit);
    return { ok: true, status: 200, text: async () => JSON.stringify({ rows: page }) };
  };
  return { fetchImpl, requests };
}

const row = (keys, clicks, impressions, ctr = 0.05, position = 10) => ({ keys, clicks, impressions, ctr, position });

// ── 1. Window: LAG days back, Pacific ────────────────────────────────────────
{
  // 2026-09-10 03:00 UTC is 2026-09-09 20:00 Pacific. UTC would say today is
  // the 10th and end the window on the 8th; Pacific says the 9th, so the
  // window ends on the 7th. The difference is a provisional day ingested
  // as final.
  const w = searchConsoleWindow(new Date('2026-09-10T03:00:00Z'), 30);
  eq(w, { startDate: '2026-08-08', endDate: '2026-09-07' }, 'window ends LAG days back in PACIFIC, spans daysBack+1 days');
  eq(DEFAULT_LAG_DAYS, 2, 'default lag is the measured 2 days');
  const w1 = searchConsoleWindow(new Date('2026-09-10T20:00:00Z'), 30);
  eq(w1.endDate, '2026-09-08', 'same UTC date later in the day is Pacific the 10th, so the window ends on the 8th');
  const w3 = searchConsoleWindow(new Date('2026-09-10T20:00:00Z'), 0, 3);
  eq(w3, { startDate: '2026-09-07', endDate: '2026-09-07' }, 'lag override and a zero daysBack give a one-day window');
}

// ── 2. Attribution arithmetic, per day, measured-zero vs unmeasured ─────────
{
  const cuts = {
    site: [row(['2026-09-01'], 100, 1000), row(['2026-09-02'], 50, 500), row(['2026-09-03'], 0, 20)],
    page: [
      row(['2026-09-01', 'https://www.baseballism.com/'], 60, 800),
      row(['2026-09-01', 'https://www.baseballism.com/collections/mlb'], 45, 900),
      row(['2026-09-02', 'https://www.baseballism.com/'], 50, 600),
    ],
    query: [
      row(['2026-09-01', 'baseballism'], 40, 300),
      row(['2026-09-01', 'baseball shirts'], 17, 200),
      // day 2 has NO query rows: Google attributed nothing -> measured zero
    ],
  };
  const { siteRows, pageRows, queryRows } = buildSearchConsoleRows(CONNECTION, SITE, cuts,
    { syncedAt: 'T', batchId: 'b', truncated: { site: false, page: false, query: false } });

  eq(siteRows.length, 3, 'one site row per day the site cut returned');
  const d1 = siteRows.find((r) => r.day_date === '2026-09-01');
  eq([d1.clicks, d1.query_attributed_clicks, d1.query_rows], [100, 57, 2], 'query attribution is the per-day sum of query rows');
  eq([d1.page_attributed_clicks, d1.page_attributed_impressions, d1.page_rows], [105, 1700, 2],
    'page attribution can exceed the site total (page-level impressions count per URL)');
  const d2 = siteRows.find((r) => r.day_date === '2026-09-02');
  eq([d2.query_attributed_clicks, d2.query_rows], [0, 0], 'a day with a total and no query rows is attributed ZERO -- measured, not null');
  ok(d2.query_attributed_clicks !== null && d2.query_attributed_clicks !== undefined, 'never null for a fetched day');
  eq(siteRows.every((r) => r.data_state === 'final'), true, 'every site row says final');
  eq(pageRows.length, 3, 'page rows pass through');
  eq(queryRows.length, 2, 'query rows pass through');
  eq(pageRows[0].page, 'https://www.baseballism.com/', 'page keeps the full URL; page_path is generated in the database');
  ok(!('page_path' in pageRows[0]), 'the sync never writes page_path -- it is a generated column');
  ok(!('unattributed_query_clicks' in d1), 'the sync never writes unattributed_query_clicks -- generated from the two stored facts');
  eq(siteRows.every((r) => r.company_entity_id === 'co-1' && r.site_url === SITE), true, 'company and site stamped explicitly (service-role path)');
}

// ── 3. Full sync: final everywhere, write order, no query x page ─────────────
{
  const data = {
    'date': [row(['2026-09-07'], 10, 100)],
    'date,page': [row(['2026-09-07', 'https://www.baseballism.com/'], 10, 120)],
    'date,query': [row(['2026-09-07', 'baseballism'], 6, 50)],
  };
  const sc = fakeSearchConsole(data);
  const db = createFakeSupabase();
  const result = await runSearchConsoleSync(db, ENV, CONNECTION, {
    now: new Date('2026-09-10T20:00:00Z'), accessToken: 'tok', fetchImpl: sc.fetchImpl, batchId: 'b1',
  });

  ok(sc.requests.every((r) => r.body.dataState === 'final'), 'every request is dataState=final');
  ok(sc.requests.every((r) => r.body.startDate === '2026-08-09' && r.body.endDate === '2026-09-08'), 'every request carries the same window');
  const dims = sc.requests.map((r) => r.body.dimensions.join(','));
  eq([...new Set(dims)].sort(), ['date', 'date,page', 'date,query'], 'exactly the three cuts -- never query x page');
  ok(sc.requests.every((r) => r.url.includes(encodeURIComponent(SITE))), 'property identifier sent verbatim, URL-encoded');
  ok(sc.requests.every((r) => r.body.rowLimit === ROW_LIMIT), 'requests ask for the measured 25k page');

  const tables = db.calls.upserts.map((u) => u.table);
  eq(tables, ['search_console_page_daily', 'search_console_query_daily', 'search_console_site_daily'],
    'page, then query, then SITE LAST');
  eq(db.rows('search_console_site_daily').length, 1, 'site row written');
  const site = db.rows('search_console_site_daily')[0];
  eq([site.clicks, site.query_attributed_clicks, site.page_attributed_clicks, site.is_truncated], [10, 6, 10, false], 'site row carries the stored attribution');
  eq(result.query_attributed_click_share, 0.6, 'the run reports the window share so the log states it');
  eq(result.days_with_data, 1, 'coverage reported');
  eq(result.window, { startDate: '2026-08-09', endDate: '2026-09-08' }, 'window reported');
}

// ── 3b. A failed detail upsert leaves the site table untouched ───────────────
{
  const data = {
    'date': [row(['2026-09-07'], 10, 100)],
    'date,page': [row(['2026-09-07', 'https://www.baseballism.com/'], 10, 120)],
    'date,query': [row(['2026-09-07', 'baseballism'], 6, 50)],
  };
  const sc = fakeSearchConsole(data);
  const db = createFakeSupabase();
  const realFrom = db.from.bind(db);
  db.from = (table) => {
    const b = realFrom(table);
    if (table === 'search_console_query_daily') {
      b.upsert = async () => ({ error: { message: 'permission denied for table search_console_query_daily' } });
    }
    return b;
  };
  let threw = null;
  try {
    await runSearchConsoleSync(db, ENV, CONNECTION, { now: new Date('2026-09-10T20:00:00Z'), accessToken: 'tok', fetchImpl: sc.fetchImpl });
  } catch (err) { threw = err; }
  ok(threw, 'a detail upsert failure fails the run');
  eq(db.rows('search_console_site_daily').length, 0, 'no site row was written for a window whose detail rows did not land');
  eq(db.rows('search_console_page_daily').length, 1, 'the page rows that did land stay (idempotent re-run completes them)');
}

// ── 4. Paging: full page -> next startRow; short page -> stop; guard flags ──
{
  const many = Array.from({ length: 7 }, (_, i) => row(['2026-09-07', `https://www.baseballism.com/p${i}`], 1, 1));
  const sc = fakeSearchConsole({ 'date,page': many });
  const cut = await fetchSearchConsoleCut(SITE, { startDate: '2026-09-07', endDate: '2026-09-07' }, ['date', 'page'], 'tok',
    { fetchImpl: sc.fetchImpl, rowLimit: 3 });
  eq(cut.rows.length, 7, 'all rows across pages');
  eq(sc.requests.map((r) => r.body.startRow), [0, 3, 6], 'pages advance by rowLimit');
  eq([cut.pages, cut.truncated], [3, false], 'a short final page ends the walk as complete');

  const sc2 = fakeSearchConsole({ 'date,page': many });
  const guarded = await fetchSearchConsoleCut(SITE, { startDate: '2026-09-07', endDate: '2026-09-07' }, ['date', 'page'], 'tok',
    { fetchImpl: sc2.fetchImpl, rowLimit: 3, maxPages: 2 });
  eq([guarded.rows.length, guarded.pages, guarded.truncated], [6, 2, true], 'the page guard reports truncation instead of completeness');

  // Exactly rowLimit rows: the API returns a full page, so one more request
  // (empty) is needed to learn there is no more. Complete, not truncated.
  const exact = fakeSearchConsole({ 'date,page': many.slice(0, 3) });
  const e = await fetchSearchConsoleCut(SITE, { startDate: '2026-09-07', endDate: '2026-09-07' }, ['date', 'page'], 'tok',
    { fetchImpl: exact.fetchImpl, rowLimit: 3 });
  eq([e.rows.length, e.pages, e.truncated], [3, 2, false], 'an exactly-full page is confirmed complete by the empty page after it');

  // Truncation reaches the site rows.
  const db = createFakeSupabase();
  const sc3 = fakeSearchConsole({ 'date': [row(['2026-09-07'], 10, 100)], 'date,page': many, 'date,query': [] });
  const r = await runSearchConsoleSync(db, ENV, CONNECTION, {
    now: new Date('2026-09-10T20:00:00Z'), accessToken: 'tok', fetchImpl: sc3.fetchImpl, maxPages: 1,
  });
  // maxPages 1 with the real 25k limit: 7 rows < 25k, so NOT truncated. Use a
  // window with more rows than one page would need a 25k fixture; assert
  // the flag plumbing through buildSearchConsoleRows instead.
  eq(r.truncated, { site: false, page: false, query: false }, 'a 7-row cut under the 25k page is complete even with maxPages=1');
  const built = buildSearchConsoleRows(CONNECTION, SITE, { site: [row(['2026-09-07'], 10, 100)], page: [], query: [] },
    { syncedAt: 'T', batchId: null, truncated: { site: false, page: true, query: false } });
  eq(built.siteRows[0].is_truncated, true, 'a truncated page cut marks the site row is_truncated');
}

// ── 5. Refuses without a property; refuses an empty window ──────────────────
{
  const db = createFakeSupabase();
  let msg = '';
  try { await runSearchConsoleSync(db, ENV, { ...CONNECTION, search_console_site_url: null }, { accessToken: 'tok' }); } catch (e) { msg = e.message; }
  ok(/search_console_site_url not set/.test(msg), 'a connection with no property fails before any request');
  eq(db.calls.upserts.length, 0, 'and writes nothing');
  let msg2 = '';
  try {
    await runSearchConsoleSync(db, ENV, CONNECTION, { accessToken: 'tok', window: { startDate: '2026-09-09', endDate: '2026-09-08' } });
  } catch (e) { msg2 = e.message; }
  ok(/window is empty/.test(msg2), 'an inverted window is refused');
}

// ── 6. Backfill: newest first, partial progress kept, honest report ──────────
{
  eq(backfillChunks('2026-01-01', '2026-01-10', 4), [
    { startDate: '2026-01-07', endDate: '2026-01-10' },
    { startDate: '2026-01-03', endDate: '2026-01-06' },
    { startDate: '2026-01-01', endDate: '2026-01-02' },
  ], 'chunks are newest-first and the oldest is clipped to the range start');
  eq(backfillChunks('2026-01-05', '2026-01-05', 28), [{ startDate: '2026-01-05', endDate: '2026-01-05' }], 'a one-day range is one chunk');

  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'];
  const data = {
    'date': days.map((d) => row([d], 10, 100)),
    'date,page': days.map((d) => row([d, 'https://www.baseballism.com/'], 10, 100)),
    'date,query': days.map((d) => row([d, 'q'], 5, 50)),
  };
  // Fail the SECOND chunk (days 1-2... newest-first: chunk1 = 05-06, chunk2 = 03-04, chunk3 = 01-02)
  const sc = fakeSearchConsole(data, { failOn: (b) => b.startDate === '2026-01-03' && b.dimensions.join() === 'date,query' });
  const db = createFakeSupabase();
  const chunksSeen = [];
  const r = await runSearchConsoleBackfill(db, ENV, { ...CONNECTION, refresh_token: null }, {
    startDate: '2026-01-01', endDate: '2026-01-06', chunkDays: 2, fetchImpl: sc.fetchImpl,
    onChunk: (c) => chunksSeen.push(c.window),
  });
  // refresh_token null would throw in runSearchConsoleSync without an access
  // token... but the backfill has no accessToken option by design (it
  // refreshes per chunk). So stub the token endpoint via a fetch that
  // handles it: covered in 6b below. Here we expect the first chunk to fail
  // on the token refresh instead -- assert that shape honestly.
  eq(r.chunks_completed, 0, 'no refresh token: nothing completes');
  ok(/No refresh token/.test(r.failed.error), 'and the reported failure names it');
  eq(chunksSeen, [], 'onChunk never fired');
}

// ── 6b. Backfill with a working token: partial progress + report ─────────────
{
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'];
  const data = {
    'date': days.map((d) => row([d], 10, 100)),
    'date,page': days.map((d) => row([d, 'https://www.baseballism.com/'], 10, 100)),
    'date,query': days.map((d) => row([d, 'q'], 5, 50)),
  };
  const sc = fakeSearchConsole(data, { failOn: (b) => b.startDate === '2026-01-03' && b.dimensions.join() === 'date,query' });
  // The token refresh goes through refreshGoogleAccessToken -> global fetch.
  // Stub the global for the oauth endpoint only; everything else routes to
  // the fake Search Console through fetchImpl.
  const realFetch = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      refreshes += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `tok${refreshes}`, expires_in: 3600 }) };
    }
    throw new Error(`unexpected global fetch ${url}`);
  };
  const db = createFakeSupabase();
  const tokens = [];
  let r;
  try {
    r = await runSearchConsoleBackfill(db, ENV, CONNECTION, {
      startDate: '2026-01-01', endDate: '2026-01-06', chunkDays: 2, fetchImpl: sc.fetchImpl,
      onTokenRefresh: (t) => tokens.push(t),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  eq([r.chunks_planned, r.chunks_completed], [3, 1], 'newest chunk completed, second failed, third never attempted');
  eq(r.covered, { startDate: '2026-01-05', endDate: '2026-01-06' }, 'the report names the days that landed');
  eq(r.failed.window, { startDate: '2026-01-03', endDate: '2026-01-04' }, 'and the chunk that failed');
  ok(/boom|500/.test(r.failed.error), 'with the error');
  eq(db.rows('search_console_site_daily').map((x) => x.day_date).sort(), ['2026-01-05', '2026-01-06'], 'the completed chunk is in the database');
  eq(db.rows('search_console_site_daily').every((x) => x.query_attributed_clicks === 5), true, 'with attribution');
  // All three cuts are FETCHED before anything is written, so a chunk whose
  // query fetch fails writes nothing at all -- not even the page rows it had
  // already fetched. A chunk is either fully in or fully out.
  eq(db.rows('search_console_page_daily').map((x) => x.day_date).sort(), ['2026-01-05', '2026-01-06'],
    'a chunk that fails mid-FETCH writes no rows of any grain');
  eq(db.rows('search_console_query_daily').map((x) => x.day_date).sort(), ['2026-01-05', '2026-01-06'], 'query rows likewise');
  ok(!db.rows('search_console_site_daily').some((x) => x.day_date === '2026-01-03' || x.day_date === '2026-01-04'),
    'and no site row for the failed chunk -- site is written last');
  eq(refreshes, 2, 'the token is refreshed per attempted chunk');
  eq(tokens, ['tok1', 'tok2'], 'and each rotation is handed back for persisting');
  eq(r.days_with_data, 2, 'coverage sums only completed chunks');
}

console.log(`search-console-sync: ${passed} assertions passed`);
