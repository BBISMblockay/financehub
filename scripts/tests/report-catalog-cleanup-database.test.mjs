process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// The 2026-09-22 SILO report catalog cleanup was applied to production
// directly. apply_all_post_merge.sql re-runs every migration, and three seed
// files UPSERT the catalog -- so a re-run would re-create the four deleted
// reports, restore the long titles, and re-point reconnected widgets at the
// deleted reports. 20260922170000 runs last and re-asserts production.
//
// This executes the REAL seed migrations against PostgreSQL, proves they do
// re-create what the cleanup removed (the risk is real, not assumed), then
// proves the recording migration lands the catalog where production is --
// and still does after a second full re-run.
// Run: node scripts/tests/report-catalog-cleanup-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const read = (f) => readFile(new URL(`supabase/migrations/${f}`, root), 'utf8');
const SEEDS = [
  '20260828150000_seed_system_reports.sql',
  '20260904160000_logistics_reports.sql',
  '20260904180000_logistics_dashboard.sql',
  '20260904240000_ownership_reports.sql',
  '20260904260000_ownership_dashboard.sql',
  '20260920075344_canned_report_accuracy.sql',
];
const RECORD = '20260922170000_record_report_catalog_cleanup.sql';
const RETIRED = [
  'c1000000-0000-4000-a000-000000000009',
  'c1000000-0000-4000-a000-00000000000a',
  'c3000000-0000-4000-a000-000000000002',
  'c3000000-0000-4000-a000-000000000007',
];
// Production, 2026-09-22 (select id, title from silo_chat_saved_reports
// where source = 'system' and company_entity_id is null).
const LIVE_TITLES = {
  '5110de50-0000-4000-a000-000000000001': 'Daily Sales',
  '5110de50-0000-4000-a000-000000000002': 'Top Products',
  '5110de50-0000-4000-a000-000000000003': 'Sales by Location',
  '5110de50-0000-4000-a000-000000000004': 'Open Purchase Orders',
  'c1000000-0000-4000-a000-000000000001': 'Inventory Summary',
  'c1000000-0000-4000-a000-000000000002': 'Overdue Purchase Orders',
  'c1000000-0000-4000-a000-000000000003': 'Monthly Arrivals',
  'c1000000-0000-4000-a000-000000000004': 'PO Units by Factory',
  'c1000000-0000-4000-a000-000000000005': 'Stock Cover',
  'c1000000-0000-4000-a000-000000000006': 'Low Stock',
  'c1000000-0000-4000-a000-000000000007': 'Overstock',
  'c1000000-0000-4000-a000-000000000008': 'Stock Without Sales',
  'c3000000-0000-4000-a000-000000000001': 'Sales vs Last Year',
  'c3000000-0000-4000-a000-000000000003': 'Sales by Channel',
  'c3000000-0000-4000-a000-000000000004': 'Ads by Platform',
  'c3000000-0000-4000-a000-000000000005': 'Attribution vs Sales',
  'c3000000-0000-4000-a000-000000000006': 'Marketing Efficiency',
};

const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const rows = async (sql, params) => (await db.query(sql, params)).rows;

// The columns and constraints the seeds and the recording migration touch,
// shaped as production has them (FK behaviour included -- it is load-bearing:
// a deleted report must null a widget and cascade its tie-outs).
await db.exec(`
  create table public.silo_chat_saved_reports (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid, created_by uuid, source text not null default 'ask_silo',
    visibility text not null default 'company', title text not null, description text,
    question text, answer text, queries_run text[] not null default '{}',
    columns_metadata jsonb, parameters jsonb, updated_at timestamptz default now(),
    constraint global_is_system check (company_entity_id is not null or source = 'system'));
  create table public.dashboards (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, created_by uuid,
    name text not null, description text, visibility text, filter_state jsonb);
  create table public.dashboard_widgets (
    id uuid primary key default gen_random_uuid(),
    dashboard_id uuid references public.dashboards(id) on delete cascade,
    company_entity_id uuid, created_by uuid,
    report_id uuid references public.silo_chat_saved_reports(id) on delete set null,
    query_index int not null default 0, title text, visual_type text,
    visual_config jsonb, layout jsonb, sort_order int);
  create table public.silo_report_tieouts (
    id uuid primary key default gen_random_uuid(),
    report_id uuid references public.silo_chat_saved_reports(id) on delete cascade,
    name text, kind text, check_sql text, tolerance numeric, enabled boolean default true,
    note text, created_at timestamptz default now());
  create function public.refresh_chat_schema_catalog() returns void language sql as $$ select $$;
`);

const runSeeds = async () => { for (const f of SEEDS) await db.exec(await read(f)); };
const runRecord = async () => db.exec(await read(RECORD));
const systemTitles = async () => Object.fromEntries((await rows(
  `select id::text, title from public.silo_chat_saved_reports where source = 'system' and company_entity_id is null`))
  .map((r) => [r.id, r.title]));

await runSeeds();

await test('the risk is real: the seeds alone re-create all four retired reports with long titles', async () => {
  const t = await systemTitles();
  for (const id of RETIRED) assert.ok(t[id], `seed re-created ${id}`);
  assert.equal(Object.keys(t).length, 21);
  assert.notEqual(t['c1000000-0000-4000-a000-000000000001'], 'Inventory Summary', 'seeds restore the long title');
});

await runRecord();

async function assertCleaned(label) {
  await test(`${label}: exactly the 17 retained SILO reports, with production's titles`, async () => {
    assert.deepEqual(await systemTitles(), LIVE_TITLES);
  });
  await test(`${label}: no widget points at a missing report, and none lost its report`, async () => {
    const dangling = await rows(`select w.id from public.dashboard_widgets w
      where w.visual_type <> 'section' and (w.report_id is null
        or not exists (select 1 from public.silo_chat_saved_reports r where r.id = w.report_id))`);
    assert.deepEqual(dangling, []);
  });
  await test(`${label}: the reconnected widgets read the retained reports`, async () => {
    const w = Object.fromEntries((await rows(`select id::text, report_id::text, title from public.dashboard_widgets
      where id in ('c2000000-0000-4000-a000-00000000000f','c4000000-0000-4000-a000-000000000003')`)).map((r) => [r.id, r]));
    assert.equal(w['c2000000-0000-4000-a000-00000000000f'].report_id, '5110de50-0000-4000-a000-000000000002');
    assert.equal(w['c2000000-0000-4000-a000-00000000000f'].title, 'Top Products');
    assert.equal(w['c4000000-0000-4000-a000-000000000003'].report_id, '5110de50-0000-4000-a000-000000000001');
    assert.equal(w['c4000000-0000-4000-a000-000000000003'].title, 'Net Sales by Day');
  });
  await test(`${label}: removed widgets stay removed; the boards keep production's widget count`, async () => {
    const gone = await rows(`select id from public.dashboard_widgets where id in (
      'c2000000-0000-4000-a000-00000000000c','c4000000-0000-4000-a000-000000000001',
      'c4000000-0000-4000-a000-000000000005','c4000000-0000-4000-a000-00000000000a')`);
    assert.deepEqual(gone, []);
    const counts = Object.fromEntries((await rows(`select dashboard_id::text, count(*)::int n from public.dashboard_widgets group by 1`))
      .map((r) => [r.dashboard_id, r.n]));
    // Production 2026-09-22: Logistics 14 widgets, Ownership 10 seeded widgets.
    assert.equal(counts['da5b0a2d-0000-4000-a000-00000000000c'], 14);
    assert.equal(counts['da5b0a2d-0000-4000-a000-00000000000e'], 10);
  });
  await test(`${label}: retired reports took their tie-outs with them`, async () => {
    assert.deepEqual(await rows(`select id from public.silo_report_tieouts where report_id = any($1::uuid[])`, [RETIRED]), []);
  });
}

await assertCleaned('after seeds + record');

// apply_all_post_merge.sql re-run: every seed again, then the record again.
await runSeeds();
await runRecord();
await assertCleaned('after a full re-run');

await test('the record migration is the last file apply_all_post_merge.sql includes', async () => {
  const all = await readFile(new URL('supabase/apply_all_post_merge.sql', root), 'utf8');
  const includes = [...all.matchAll(/^\\i migrations\/(\S+)/gm)].map((m) => m[1]);
  assert.equal(includes.at(-1), RECORD, 'anything seeding the catalog after it would undo it again');
});

console.log(`\n${checks} checks passed`);
