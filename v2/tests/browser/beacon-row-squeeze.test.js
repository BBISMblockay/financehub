/* A page's own rows must never be squeezed by the scrolling column.
 *
 * Why this suite exists. `.silo-main` is a flex COLUMN with `overflow-y: auto`
 * (v2/beacon.css). Every block a page puts in it is therefore a flex item, and
 * a flex item shrinks by default: once the blocks together are taller than the
 * window, the browser compresses them rather than scrolling. A block with its
 * own `overflow: hidden` -- any `.bcn-card`, and a status strip in particular --
 * is then cut through the middle of a line of text, which reads as a rendering
 * bug and hides real numbers.
 *
 * Reported 2026-11-20 on SEO: Search performance and Keywords both showed a
 * strip clipped from ~102px to 22px on a short window. beacon.css now sets
 * `flex-shrink: 0` on the Beacon blocks whose height IS their content. A page's
 * own scrolling content area still sets `flex: 1` for itself and keeps it.
 *
 * Deliberately short viewport (900x620): the bug only appears when the rows
 * together do not fit.
 *
 * Mutations (each must fail at least one assertion):
 *   SQUEEZE_MUTATION=shrinkable   the Beacon rows go back to shrinking
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('beacon-row-squeeze');

const MUTATIONS = {
  shrinkable: ['/beacon.css', '.silo-main > .bcn-card {\n  flex-shrink: 0;\n}', '.silo-main > .bcn-card {\n  flex-shrink: 1;\n}'],
};
const MUT = process.env.SQUEEZE_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT) return source;
  const [file, from, to] = MUTATIONS[MUT];
  if (!rel.endsWith(file)) return source;
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

const CO = 'test-company';
// Enough keywords that the page is taller than the window, which is what makes
// the browser look for something to shrink.
const KEYWORDS = Array.from({ length: 150 }, (_, i) => ({
  id: `k${i}`, company_entity_id: CO, keyword: `baseball keyword ${i}`, keyword_norm: `baseball keyword ${i}`,
  source: 'manual', is_active: true, priority: 1, created_at: '2026-09-26',
}));
const KEYWORD_TABLES = {
  seo_keyword_set: KEYWORDS,
  seo_keyword_landscape_v: [], seo_serp_features_v: [], seo_competitor_domains: [], seo_competitor_share_v: [],
  seo_competitor_page_types_v: [], seo_serp_schedules: [], seo_serp_runs: [], seo_serp_provider_tasks: [],
  seo_projects: [], seo_tasks: [], seo_recommendations_v: [],
};

// Search performance builds its strip from this RPC. Self-contained: an RPC
// fixture is stringified across into the page.
const overview = (args) => {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const back = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const end = args.p_end || d(3);
  const start = back(end, (args.p_days || 28) - 1);
  return {
    freshness: { max_day: d(3), min_day: d(400), days_ingested: 397, lag_days: 3, property_count: 1, last_synced_at: null, site_url: 'https://example.com' },
    window: { start, end, days_requested: args.p_days, days_present: args.p_days - 1, prior_start: back(start, args.p_days), prior_end: back(start, 1) },
    current: { clicks: 120, impressions: 9000, ctr: 0.013, position: 14.2, days_present: args.p_days - 1, query_5000_row_days: 2, unmeasured_days: 1, truncated_days: 1, page_attributed_share: 0.8, query_attributed_share: 0.7 },
    prior: { clicks: 100, impressions: 8000, ctr: 0.0125, position: 15.0 },
    series: [{ day: start, clicks: 10, impressions: 800, ctr: 0.0125, position: 14, query_5000_rows: false }],
  };
};

// Every Beacon row the page owns, with what it renders against what it holds.
const rows = (page) => page.evaluate(() => {
  const main = document.querySelector('.silo-main');
  const want = ['bcn-header', 'bcn-kpi-band', 'bcn-filter-bar', 'bcn-status', 'bcn-tabs', 'bcn-card'];
  return [...main.children]
    .filter((c) => want.some((w) => c.classList.contains(w)) && !c.hidden && c.scrollHeight > 0)
    .map((c) => ({
      name: c.tagName.toLowerCase() + '.' + [...c.classList].join('.'),
      shown: Math.round(c.getBoundingClientRect().height),
      holds: c.scrollHeight,
    }));
});
const clipped = (list) => list.filter((r) => r.holds - r.shown > 2);

(async () => {
  // Short on purpose: these rows fit at 900px tall and do not at 620.
  const suite = await startSuite({ transform, viewport: { width: 1100, height: 620 } });
  try {
    let page = await suite.open('/v2/seo-keywords.html', KEYWORD_TABLES, {
      rpc: { can_approve_seo_tasks: false },
      ready: () => !!document.querySelector('#strip span') && !/Loading/.test(document.getElementById('strip').textContent),
    });
    let seen = await rows(page);
    R.ok('Keywords has rows to measure', seen.length >= 3, JSON.stringify(seen));
    R.eq(clipped(seen), [], 'no Beacon row on Keywords is cut short of what it holds');
    await page.close();

    page = await suite.open('/v2/seo-overview.html', {}, {
      rpc: { search_console_overview: overview, search_console_top_pages: () => [], search_console_top_queries: () => [] },
      ready: () => /days loaded|Load failed/.test(document.getElementById('status')?.textContent || ''),
    });
    seen = await rows(page);
    const strip = seen.find((r) => r.name.includes('seo-strip'));
    R.ok('Search performance draws its freshness strip', !!strip, JSON.stringify(seen));
    R.ok('and it is at least two lines tall, not a clipped sliver', strip && strip.shown >= 40, JSON.stringify(strip));
    R.eq(clipped(seen), [], 'no Beacon row on Search performance is cut short of what it holds');
    await page.close();
  } catch (err) {
    R.ok('suite ran to completion', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
