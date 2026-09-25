// SEO Performance SILO report (20260925160000), executed in a real
// PostgreSQL (PGlite): the deployed SQL from the migration, parameters
// substituted by the browser's own report-params.js, over Search Console
// fixtures whose answers are known. Covers the rules the tables were built
// to: not-returned is blank (never 0), position pooled by impressions, an
// incomplete period blanks the comparison, the unattributed query share,
// grain per property, and every tie-out the migration writes.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/seo-silo-report-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const num = (v) => (v === null || v === undefined ? null : Number(v));

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync('v3/js/report-params.js', 'utf8'), ctx);
const P = ctx.window.SiloReportParams;
const ID = 'c3000000-0000-4000-a000-00000000000b';
const SITE = 'sc-domain:example.com';

// today = 2026-09-20. Default window: today-29d .. today-2d = 08-22 .. 09-18
// (28 days); prior window 07-25 .. 08-21 (28 days).
await db.exec(`
create function active_company_id() returns uuid language sql as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
set test.today = '2026-09-20';
create table silo_chat_saved_reports(id uuid primary key, title text, description text, queries_run text[], parameters jsonb default '[]',
  columns_metadata jsonb, source text, company_entity_id uuid, visibility text);
create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text, check_sql text,
  tolerance numeric, enabled boolean default true, note text, unique(report_id, name));
create table search_console_site_daily(company_entity_id uuid default active_company_id(), site_url text, day_date date,
  clicks bigint, impressions bigint, position numeric, query_rows int, page_attributed_clicks bigint,
  query_attributed_clicks bigint, unattributed_query_click_share numeric);
create table search_console_page_daily(company_entity_id uuid default active_company_id(), site_url text, day_date date,
  page text, page_path text, clicks bigint, impressions bigint, position numeric);
create table search_console_query_daily(company_entity_id uuid default active_company_id(), site_url text, day_date date,
  query text, clicks bigint, impressions bigint, position numeric);

-- Every day of both windows ingested: 10 clicks / 1,000 impressions a day now,
-- 8 / 800 before. Positions differ so pooling is visible.
insert into search_console_site_daily(site_url, day_date, clicks, impressions, position, query_rows, page_attributed_clicks, query_attributed_clicks, unattributed_query_click_share)
select '${SITE}', d::date, 10, 1000, 5, 100, 11, 6, 0.4 from generate_series('2026-08-22'::date, '2026-09-18', '1 day') d;
insert into search_console_site_daily(site_url, day_date, clicks, impressions, position, query_rows, page_attributed_clicks, query_attributed_clicks, unattributed_query_click_share)
select '${SITE}', d::date, 8, 800, 6, 100, 8, 5, 0.375 from generate_series('2026-07-25'::date, '2026-08-21', '1 day') d;
-- Outside every window: final data is not in yet for these days.
insert into search_console_site_daily(site_url, day_date, clicks, impressions, position, query_rows, page_attributed_clicks, query_attributed_clicks)
values ('${SITE}', '2026-09-19', 999, 999, 1, 5000, 999, 999);

-- Pages: /a every current day (7 clicks); /b every current day (4 clicks)
-- -> page total 11/day = page_attributed_clicks. Prior: /a only.
insert into search_console_page_daily(site_url, day_date, page, page_path, clicks, impressions, position)
select '${SITE}', d::date, 'https://example.com/a', '/a', 7, 900, 2 from generate_series('2026-08-22'::date, '2026-09-18', '1 day') d
union all
select '${SITE}', d::date, 'https://example.com/b', '/b', 4, 100, 20 from generate_series('2026-08-22'::date, '2026-09-18', '1 day') d
union all
select '${SITE}', d::date, 'https://example.com/a', '/a', 8, 800, 3 from generate_series('2026-07-25'::date, '2026-08-21', '1 day') d;

-- Queries: 'baseball tees' every current day (6 clicks) = query_attributed_clicks.
-- Prior: only on one day.
insert into search_console_query_daily(site_url, day_date, query, clicks, impressions, position)
select '${SITE}', d::date, 'baseball tees', 6, 300, 4 from generate_series('2026-08-22'::date, '2026-09-18', '1 day') d
union all select '${SITE}', '2026-08-01', 'baseball tees', 5, 250, 5
union all select '${SITE}', '2026-09-01', 'new query', 0, 50, 30;
`);
await db.exec(`update search_console_site_daily set query_attributed_clicks = 5 where day_date = '2026-08-01'`);

await db.exec(readFileSync('supabase/migrations/20260925160000_seo_silo_report.sql', 'utf8'));
const report = (await q(`select * from silo_chat_saved_reports where id = '${ID}'`))[0];
async function run(index, values = {}) {
  const out = P.substitute(report.queries_run[index], report.parameters,
    P.defaultsFor(P.normalizeDeclarations(report.parameters), values));
  assert.ok(out.sql, out.error);
  return q(out.sql);
}

await test('a global SILO report with every token declared and every part titled', async () => {
  assert.equal(report.source, 'system');
  assert.equal(report.company_entity_id, null);
  const keys = new Set(P.normalizeDeclarations(report.parameters).map((d) => d.key));
  for (const sql of report.queries_run) for (const t of P.tokensIn(sql)) assert.ok(keys.has(t), t);
  assert.deepEqual(report.columns_metadata._queries.map((e) => e.index), [0, 1, 2, 3]);
  for (const [k, v] of Object.entries(report.columns_metadata)) if (k !== '_queries') assert.notEqual(v.semantic, 'percent', k);
});

await test('summary: final data only, pooled position, prior period, unattributed share', async () => {
  const [s] = await run(0);
  assert.equal(s.property, SITE);
  assert.equal(new Date(s.data_through).toISOString().slice(0, 10), '2026-09-18', 'ends two days back; 09-19 is not final');
  assert.equal(num(s.days_in_window), 28);
  assert.equal(num(s.days_with_data), 28);
  assert.equal(num(s.clicks), 280);
  assert.equal(num(s.prior_clicks), 224);
  assert.equal(num(s.clicks_change_pct), 0.25);
  assert.equal(num(s.ctr), 0.01);
  assert.equal(num(s.avg_position), 5);
  assert.equal(num(s.prior_avg_position), 6);
  assert.equal(num(s.unattributed_query_click_share), 0.4, 'query rows cover 6 of 10 clicks a day');
});

await test('a missing day blanks the comparison, never a partial-period change', async () => {
  await db.exec(`delete from search_console_site_daily where day_date = '2026-08-10'`);
  const [s] = await run(0);
  assert.equal(num(s.days_with_data), 28);
  assert.equal(s.clicks_change_pct, null);
  assert.equal(s.impressions_change, null);
  await db.exec(`insert into search_console_site_daily(site_url, day_date, clicks, impressions, position, query_rows, page_attributed_clicks, query_attributed_clicks, unattributed_query_click_share)
    values ('${SITE}', '2026-08-10', 8, 800, 6, 100, 8, 5, 0.375)`);
});

await test('pages: one row per page, position pooled by impressions, not-returned is blank', async () => {
  const rows = await run(2);
  assert.deepEqual(rows.map((r) => r.page_path), ['/a', '/b']);
  const a = rows[0]; const b = rows[1];
  assert.deepEqual([num(a.clicks), num(a.impressions), num(a.days_present)], [196, 25200, 28]);
  assert.equal(num(a.avg_position), 2);
  assert.equal(num(a.prior_clicks), 224);
  assert.equal(num(a.clicks_change), -28);
  assert.equal(b.prior_clicks, null, '/b was not returned before: blank, not 0');
  assert.equal(b.clicks_change, null);
  // Page totals exceed site totals by design (11 vs 10 a day).
  assert.equal(rows.reduce((s, r) => s + num(r.clicks), 0), 308);
});

await test('queries: partial by construction, a zero-click query is still listed', async () => {
  const rows = await run(3);
  assert.deepEqual(rows.map((r) => r.query), ['baseball tees', 'new query']);
  assert.equal(num(rows[0].clicks), 168);
  assert.equal(num(rows[0].prior_clicks), 5);
  assert.equal(rows[1].prior_clicks, null);
  assert.equal(num(rows[1].clicks), 0);
});

await test('two properties are two rows, never summed', async () => {
  await db.exec(`insert into search_console_site_daily(site_url, day_date, clicks, impressions, position, query_rows, page_attributed_clicks, query_attributed_clicks)
    values ('https://shop.example.com/', '2026-09-01', 50, 500, 9, 10, 50, 20)`);
  const rows = await run(0);
  assert.equal(rows.length, 2);
  assert.equal(num(rows.find((r) => r.property === SITE).clicks), 280);
  await db.exec(`delete from search_console_site_daily where site_url = 'https://shop.example.com/'`);
});

await test('a custom window respects its own bounds', async () => {
  const [s] = await run(0, { date_from: '2026-09-01', date_to: '2026-09-10' });
  assert.equal(num(s.days_in_window), 10);
  assert.equal(num(s.clicks), 100);
  assert.equal(num(s.prior_clicks), 100, 'prior 08-22..08-31: ten days at 10 clicks');
});

const checks = await q(`select name, kind, check_sql, tolerance from silo_report_tieouts where report_id = '${ID}'`);
await test('every tie-out passes, and there is a reconciliation', async () => {
  assert.ok(checks.some((c) => c.kind === 'reconciliation'));
  assert.equal(checks.length, 3);
  for (const c of checks) {
    const [r] = await q(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: NO DATA`);
    assert.ok(Math.abs(num(r.left_value) - num(r.right_value)) <= num(c.tolerance), `${c.name}: ${r.left_value} vs ${r.right_value}`);
  }
});

await test('a lost detail row fails its reconciliation', async () => {
  await db.exec(`delete from search_console_page_daily where page_path = '/b' and day_date = '2026-09-01'`);
  const c = checks.find((x) => /Page clicks/.test(x.name));
  const [r] = await q(c.check_sql);
  assert.equal(num(r.right_value) - num(r.left_value), 4);
});

await test('a changed definition turns its tie-outs to NO DATA', async () => {
  await db.exec(`update silo_chat_saved_reports set queries_run = queries_run || array['select 2'] where id = '${ID}'`);
  const [r] = await q(checks[0].check_sql);
  assert.equal(r.left_value, null);
});

console.log(`\n${passed} passed`);
