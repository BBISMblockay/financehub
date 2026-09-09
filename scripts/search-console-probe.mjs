// scripts/search-console-probe.mjs — measure Search Console before designing
// tables for it. READ ONLY: no Supabase writes at all, not even the refreshed
// access token (the tester persists that; a probe should not change state it
// is measuring).
//
// WHY THIS EXISTS. Everything a search_console_*_daily schema needs to get
// right is a property of THIS account's traffic, not a fact about the API
// that can be recalled:
//
//   1. Lag        — how far behind today the newest complete day is, which
//                   decides the ingestion window and what "yesterday" means.
//   2. Retention  — how far back history actually reaches, which decides
//                   whether a backfill is worth writing and bounds every
//                   "compared to last year" claim.
//   3. Row cap    — how many rows one request returns and whether paging
//                   past it yields more, which decides whether the table is
//                   a complete list or a top-N slice.
//   4. ATTRIBUTION COMPLETENESS — what share of a day's clicks Search Console
//                   will attribute to a query at all. This is the one that
//                   matters most. Search Console withholds rare queries to
//                   protect user privacy, so the sum of per-query clicks is
//                   structurally LESS than the day's total clicks. A query
//                   table therefore looks complete and is not, exactly like
//                   shopify_landing_pages_daily's top-250-per-day slice --
//                   and that slice is what produced the false "these eight
//                   collections don't exist" answer that started this work.
//                   Measuring the gap up front is what lets the catalog state
//                   it as a number instead of a warning nobody can act on.
//   5. Cross-dimension loss — query+page together is withheld far more
//                   aggressively than either alone. If that loss is large, a
//                   single query x page table is the wrong shape and the two
//                   grains must stay in separate tables.
//
// Run via .github/workflows/search-console-probe.yml (workflow_dispatch).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID,
//      GOOGLE_CLIENT_SECRET.
// Optional: SC_CONNECTION_ID, SC_COMPANY_ID, SC_SITE_URL (overrides the
//      connection's stored site), SC_WINDOW_DAYS (default 28).

import { createClient } from '@supabase/supabase-js';
import { refreshGoogleAccessToken, pacificDateOnly } from './lib/ad-platforms-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
};
const WINDOW_DAYS = Number(process.env.SC_WINDOW_DAYS || 28);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
if (!GOOGLE_ENV.GOOGLE_CLIENT_ID || !GOOGLE_ENV.GOOGLE_CLIENT_SECRET) {
  throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const API = 'https://www.googleapis.com/webmasters/v3';
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a');
const num = (n) => Number(n ?? 0).toLocaleString('en-US');

let accessToken = null;

async function scPost(site, body, label) {
  const url = `${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${label} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text || '{}');
}

/** Page through searchAnalytics until a short page comes back. Returns the
 * rows AND the paging facts, because "did paging past the first page yield
 * more" is one of the things being measured, not an implementation detail. */
async function fetchAllRows(site, body, label, { rowLimit = 25000, maxPages = 20 } = {}) {
  const rows = [];
  let startRow = 0;
  let pages = 0;
  let effectiveLimit = rowLimit;

  while (pages < maxPages) {
    let page;
    try {
      page = await scPost(site, { ...body, rowLimit: effectiveLimit, startRow }, label);
    } catch (err) {
      // Measure the cap rather than assuming it: if the requested rowLimit is
      // rejected, halve it once and record what the API actually accepted.
      if (err.status === 400 && effectiveLimit > 1000) {
        effectiveLimit = Math.floor(effectiveLimit / 5);
        console.log(`    (rowLimit ${rowLimit} rejected; retrying at ${effectiveLimit})`);
        continue;
      }
      throw err;
    }
    const batch = page.rows ?? [];
    rows.push(...batch);
    pages += 1;
    if (batch.length < effectiveLimit) break;
    startRow += effectiveLimit;
  }
  return { rows, pages, effectiveLimit, hitMaxPages: pages >= maxPages };
}

const sumClicks = (rows) => rows.reduce((a, r) => a + Number(r.clicks ?? 0), 0);
const sumImpressions = (rows) => rows.reduce((a, r) => a + Number(r.impressions ?? 0), 0);

async function main() {
  // ── connection ───────────────────────────────────────────────────────────
  let q = supabase.from('ad_platform_connections').select('*').eq('platform', 'search_console');
  if (process.env.SC_CONNECTION_ID) q = q.eq('id', process.env.SC_CONNECTION_ID);
  if (process.env.SC_COMPANY_ID) q = q.eq('company_entity_id', process.env.SC_COMPANY_ID);
  const { data: conns, error } = await q.order('created_at');
  if (error) throw new Error(`connection load failed: ${error.message}`);
  if (!conns?.length) {
    console.log('No search_console connection found. Connect one in /v2/integrations.html first.');
    process.exit(1);
  }
  const conn = conns[0];
  console.log(`Connection: ${conn.display_name || conn.id} (company ${conn.company_entity_id})`);

  if (!conn.refresh_token) {
    console.log('No refresh token on the connection — reconnect via OAuth.');
    process.exit(1);
  }
  ({ accessToken } = await refreshGoogleAccessToken(GOOGLE_ENV, conn.refresh_token));

  // ── verified properties ──────────────────────────────────────────────────
  console.log('\n=== VERIFIED PROPERTIES ===');
  const sitesRes = await fetch(`${API}/sites`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!sitesRes.ok) {
    // The most likely failure here is the scope: a refresh token minted
    // before webmasters.readonly was added to google-oauth-start's SCOPES map
    // carries only what it was granted, and Google returns 403 for the rest.
    // Say that plainly rather than printing a bare status.
    const body = (await sitesRes.text()).slice(0, 400);
    console.log(`sites.list failed ${sitesRes.status}: ${body}`);
    if (sitesRes.status === 403) {
      console.log('\n403 here usually means the refresh token predates the Search Console scope.');
      console.log('Reconnect Search Console in /v2/integrations.html to mint a token that carries it.');
    }
    process.exit(1);
  }
  const sitesData = await sitesRes.json();
  const sites = sitesData.siteEntry ?? [];
  for (const s of sites) console.log(`  ${s.siteUrl}   [${s.permissionLevel}]`);
  if (!sites.length) console.log('  (none — this Google account has no verified Search Console properties)');

  const site = process.env.SC_SITE_URL || conn.search_console_site_url;
  if (!site) {
    console.log('\nNo site selected. Set search_console_site_url on the connection (or SC_SITE_URL)');
    console.log('to one of the identifiers above, VERBATIM — a URL-prefix property and a domain');
    console.log('property cover different traffic and are not interchangeable.');
    process.exit(0);
  }
  const known = sites.find((s) => s.siteUrl === site);
  console.log(`\nProbing: ${site}${known ? '' : '   ** not in the verified list above **'}`);

  // ── 1 & 2: lag and retention, in one date-dimension call ─────────────────
  // Also compares dataState 'final' (Google's default) against 'all', which
  // includes fresh partial days. The difference IS the lag: ingesting 'all'
  // would write incomplete days that later restate upward.
  console.log('\n=== FRESHNESS AND HISTORY ===');
  const today = pacificDateOnly();
  const wide = { startDate: daysAgo(600), endDate: today, dimensions: ['date'] };

  const final = await fetchAllRows(site, { ...wide, dataState: 'final' }, 'date/final');
  const all = await fetchAllRows(site, { ...wide, dataState: 'all' }, 'date/all');

  const dates = (r) => r.rows.map((x) => x.keys[0]).sort();
  const fDates = dates(final);
  const aDates = dates(all);
  const lagDays = (d) => (d ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400_000) : null);

  console.log(`  Pacific today:            ${today}`);
  console.log(`  final: ${fDates.length} days, ${fDates[0] ?? '-'} .. ${fDates.at(-1) ?? '-'}  (newest is ${lagDays(fDates.at(-1))} days back)`);
  console.log(`  all:   ${aDates.length} days, ${aDates[0] ?? '-'} .. ${aDates.at(-1) ?? '-'}  (newest is ${lagDays(aDates.at(-1))} days back)`);
  console.log(`  → ingestion window should end ${lagDays(fDates.at(-1))} days back and use dataState=final`);
  console.log(`  → history reaches back ${fDates.length ? Math.round((Date.parse(today) - Date.parse(fDates[0])) / 86400_000) : 0} days;`);
  console.log('    any comparison older than that is unmeasurable, not flat');
  if (fDates.length) {
    const span = Math.round((Date.parse(fDates.at(-1)) - Date.parse(fDates[0])) / 86400_000) + 1;
    if (span !== fDates.length) {
      console.log(`  → NOTE: ${span - fDates.length} day(s) inside that span returned NO row.`);
      console.log('    A missing day is a day with no clicks AND no impressions, not a gap in the feed.');
    }
  }

  // ── 3, 4, 5: coverage over a real window ─────────────────────────────────
  const endDate = fDates.at(-1) || daysAgo(3);
  const startDate = daysAgo(lagDays(endDate) + WINDOW_DAYS - 1);
  console.log(`\n=== COVERAGE over ${WINDOW_DAYS} days (${startDate} .. ${endDate}, dataState=final) ===`);
  const base = { startDate, endDate, dataState: 'final' };

  const totals = await scPost(site, { ...base }, 'totals');
  const totalClicks = sumClicks(totals.rows ?? []);
  const totalImpr = sumImpressions(totals.rows ?? []);
  console.log(`  TOTAL (no dimensions):  ${num(totalClicks)} clicks, ${num(totalImpr)} impressions`);

  const cuts = [
    ['query', ['query']],
    ['page', ['page']],
    ['query x page', ['query', 'page']],
    ['date x query', ['date', 'query']],
    ['date x page', ['date', 'page']],
  ];

  for (const [label, dimensions] of cuts) {
    const t0 = Date.now();
    const { rows, pages, effectiveLimit, hitMaxPages } = await fetchAllRows(site, { ...base, dimensions }, label);
    const c = sumClicks(rows);
    const i = sumImpressions(rows);
    console.log(
      `\n  ${label}: ${num(rows.length)} rows in ${pages} page(s) of ${num(effectiveLimit)}` +
      `${hitMaxPages ? ' [HIT PAGE GUARD — there are more]' : ''}  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    console.log(`      clicks ${num(c)} = ${pct(c, totalClicks)} of total   |   impressions ${num(i)} = ${pct(i, totalImpr)} of total`);
    if (totalClicks > 0 && c < totalClicks) {
      console.log(`      → ${num(totalClicks - c)} clicks (${pct(totalClicks - c, totalClicks)}) are NOT attributable to any ${label} row.`);
      console.log('      → a "no query brought traffic to X" claim over this cut is unsafe by that margin.');
    }
  }

  console.log('\n=== WHAT THIS MEANS FOR THE SCHEMA ===');
  console.log('  Read the percentages above, not the row counts. If query and page each recover');
  console.log('  most of the clicks but query x page recovers far less, the two grains belong in');
  console.log('  SEPARATE tables and must never be joined to claim "this query brought traffic to');
  console.log('  this page" — that inference is exactly what the withheld rows make unsupportable.');
}

main().catch((err) => {
  console.error(`\nprobe failed: ${err.message}`);
  process.exit(1);
});
