/* Launch product readiness: live_status derived from the catalog.
 *
 * Why this exists. launch_product_readiness.live_status has no writer anywhere
 * in the codebase -- it is set to its default on insert and never updated -- so
 * on production 2026-10-30 all 224 Baseballism rows read 'not_live' while 46 of
 * those products were published and selling. 20261030140000 derives the answer
 * in launch_product_readiness_v instead.
 *
 * The traps this guards, each with a mutation below:
 *   * reporting an unresolvable title as 'not_live' rather than 'unknown',
 *     which is the "blank is not zero" mistake and is what the stored column
 *     already does wrong (`unknown-as-not-live`);
 *   * calling a product live because it was once published, ignoring whether
 *     it is still active (`published-only`);
 *   * resolving a title across tenants (`no-company-scope`);
 *   * dropping unresolved rows out of the view entirely, so a launch silently
 *     loses products (`inner-join`).
 *
 * Runs on PGlite against stand-in tables carrying only the columns the view
 * reads.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const MIGRATION = '20261030140000_launch_product_readiness_live_derived.sql';
const MUTATIONS = ['', 'unknown-as-not-live', 'published-only', 'no-company-scope', 'inner-join'];
const mutation = process.env.LAUNCH_LIVE_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];

let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

const US = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

await db.exec(`
  create table public.launch_product_readiness (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid,
    launch_id uuid,
    product_tracker_id uuid,
    factory_id uuid,
    product_title text,
    product_type text,
    collection_name text,
    manufacturer text,
    po_number text,
    vendor_name text,
    bulk_eta date,
    expected_units integer,
    expected_retail_value numeric,
    on_hand_status text default 'unknown',
    size_requests text,
    sizes_ready text,
    sizes_picked_up text,
    product_shot_status text default 'not_started',
    copy_status text default 'not_started',
    website_status text default 'not_started',
    readiness_status text default 'not_reviewed',
    live_status text default 'not_live',
    notes text,
    created_by uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );

  create table public.products_master (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid,
    product_title text,
    sku text,
    shopify_status text,
    online_published_at timestamptz
  );

  create table public.silo_chat_schema_catalog (
    relname text primary key,
    relkind text not null,
    columns jsonb not null default '[]'::jsonb,
    description text,
    keywords text[],
    is_hidden boolean not null default false,
    reportable boolean not null default false,
    report_priority smallint not null default 0,
    auto_refreshed_at timestamptz,
    updated_at timestamptz not null default now()
  );

  -- Stand-in for the real definer function: same signature, enumerates the
  -- same public relations.
  create or replace function public.refresh_chat_schema_catalog()
  returns integer language plpgsql as $$
  declare v_count integer;
  begin
    insert into public.silo_chat_schema_catalog (relname, relkind, auto_refreshed_at)
    select c.relname,
           case c.relkind when 'r' then 'table' when 'v' then 'view' end,
           now()
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v')
    on conflict (relname) do update set auto_refreshed_at = excluded.auto_refreshed_at;
    select count(*) into v_count from public.silo_chat_schema_catalog;
    return v_count;
  end; $$;
`);

// The description the base table already carries (20261029230000), so the
// append-once guard has something real to append to.
await q(`insert into public.silo_chat_schema_catalog (relname, relkind, description)
         values ('launch_product_readiness', 'table', 'Per-product readiness checklist for a launch.')`);

// One readiness row per case, all stored live_status 'not_live' as production
// has them.
const readiness = [
  ['Cooperstown Tee', US],        // published + active        -> live
  ['Dugout Chatter Hoodie', US],  // published, now archived   -> not_live
  ['Velocity Raptor Toddler', US],// active, never published   -> not_live
  ['Ghost Product', US],          // no catalog row            -> unknown
  ['Shared Title', US],           // only the OTHER tenant has it published -> unknown
  ['Mixed Variants', US]          // one variant live, others not -> live
];
for (const [title, company] of readiness) {
  await q(`insert into public.launch_product_readiness (company_entity_id, product_title)
           values ($1, $2)`, [company, title]);
}

// Catalog rows. products_master is variant-grained: one row per SKU.
const catalog = [
  ['Cooperstown Tee', US, 'CT-S', 'active', '2026-09-01T00:00:00Z'],
  ['Cooperstown Tee', US, 'CT-M', 'active', '2026-09-01T00:00:00Z'],
  ['Dugout Chatter Hoodie', US, 'DCH-M', 'archived', '2026-08-01T00:00:00Z'],
  ['Velocity Raptor Toddler', US, 'VRT-2T', 'active', null],
  ['Shared Title', OTHER, 'ST-M', 'active', '2026-09-15T00:00:00Z'],
  ['Mixed Variants', US, 'MV-S', 'draft', null],
  ['Mixed Variants', US, 'MV-M', 'active', '2026-10-01T00:00:00Z'],
  // Title that differs only by case and padding: the resolver must match it.
  ['  cooperstown tee  ', US, 'CT-L', 'active', '2026-09-02T00:00:00Z']
];
for (const [title, company, sku, status, published] of catalog) {
  await q(`insert into public.products_master
             (company_entity_id, product_title, sku, shopify_status, online_published_at)
           values ($1, $2, $3, $4, $5)`, [company, title, sku, status, published]);
}

// ── Apply the migration, optionally mutated ────────────────────────────────
const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
let sql = original;
if (mutation === 'unknown-as-not-live') {
  sql = sql.replace("when d.catalog_variants = 0 then 'unknown'", "when false then 'unknown'");
}
if (mutation === 'published-only') {
  sql = sql.replace("where pm.online_published_at is not null and pm.shopify_status = 'active'",
    'where pm.online_published_at is not null');
}
if (mutation === 'no-company-scope') {
  sql = sql.replace('   and pm.company_entity_id = r.company_entity_id\n', '');
}
if (mutation === 'inner-join') {
  sql = sql.replace('  left join public.products_master pm', '  join public.products_master pm');
}
assert.ok(!mutation || sql !== original,
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}

const view = (title) =>
  first('select * from public.launch_product_readiness_v where product_title = $1', [title]);

// ── 1. The derived state ──────────────────────────────────────────────────
// First, before anything reads a single row: an unresolved product must still
// be IN the view. A view that drops them answers every other question here
// correctly and silently loses products off a launch.
check('every readiness row survives into the view');
assert.equal(
  Number((await first('select count(*) n from public.launch_product_readiness_v')).n),
  Number((await first('select count(*) n from public.launch_product_readiness')).n),
  'an unresolved product must appear as unknown, not vanish');

check('a published, active product reads live');
let r = await view('Cooperstown Tee');
assert.equal(r.live_status, 'live');
assert.equal(r.is_live, true);
assert.equal(r.is_resolved, true);

check('title matching ignores case and surrounding space');
assert.equal(Number(r.catalog_variants), 3, 'the padded, lower-cased variant must resolve too');

check('first_published_at is the earliest active publish');
assert.equal(r.first_published_at.toISOString().slice(0, 10), '2026-09-01');

check('a product published but no longer active is not live');
r = await view('Dugout Chatter Hoodie');
assert.equal(r.live_status, 'not_live');
assert.equal(r.is_resolved, true, 'it resolved -- it just is not live');

check('an active product that was never published is not live');
assert.equal((await view('Velocity Raptor Toddler')).live_status, 'not_live');

check('one live variant is enough');
r = await view('Mixed Variants');
assert.equal(r.live_status, 'live');
assert.equal(Number(r.live_variants), 1);
assert.equal(Number(r.catalog_variants), 2);

check('a title with no catalog row is unknown, NOT not_live');
r = await view('Ghost Product');
assert.equal(r.live_status, 'unknown');
assert.equal(r.is_resolved, false);
assert.equal(r.is_live, false, 'is_live is false, but live_status must say unknown');
assert.equal(Number(r.catalog_variants), 0);

check('another tenant having the product does not make it live here');
r = await view('Shared Title');
assert.equal(r.live_status, 'unknown');
assert.equal(Number(r.catalog_variants), 0);

check('the stored column is reachable and unchanged');
for (const [title] of readiness) {
  assert.equal((await view(title)).live_status_stored, 'not_live');
}
assert.equal(Number((await first(
  `select count(*) n from public.launch_product_readiness where live_status <> 'not_live'`)).n), 0,
  'the migration must not rewrite the stored column');

check('the derived answer disagrees with the stored one, which is the point');
assert.equal(Number((await first(
  `select count(*) n from public.launch_product_readiness_v
    where live_status <> live_status_stored`)).n), 4,
  'live x2 and unknown x2 differ from the stored not_live');

check('the human-judgement columns are passed through untouched');
r = await view('Cooperstown Tee');
assert.equal(r.readiness_status, 'not_reviewed');
assert.equal(r.copy_status, 'not_started');
assert.equal(r.website_status, 'not_started');
assert.equal(r.on_hand_status, 'unknown');

// ── 2. The catalog entries the model reads ────────────────────────────────
const cat = (relname) =>
  first('select * from public.silo_chat_schema_catalog where relname = $1', [relname]);

check('the new view is registered and described');
r = await cat('launch_product_readiness_v');
assert.ok(r, 'the view did not enter the catalog');
assert.match(r.description, /USE THIS, not the base table/);
assert.match(r.description, /never report unknown as not live/);
assert.ok(r.keywords.includes('is it live'));

check('the base table carries the unwritten-columns warning');
r = await cat('launch_product_readiness');
assert.match(r.description, /UNWRITTEN COLUMNS/);
assert.match(r.description, /Per-product readiness checklist/, 'the existing description must be kept');

check('the view is offered to the report builder, like the base table');
r = await cat('launch_product_readiness_v');
assert.equal(r.reportable, true,
  'a saved report must be able to reach the fixed column, not only the broken one');
assert.equal(Number(r.report_priority), 1,
  'the derived view should be offered above the raw table it corrects');

check('the view carries a comment for anyone reading the schema directly');
assert.match(
  (await first(`select obj_description('public.launch_product_readiness_v'::regclass, 'pg_class') as c`)).c,
  /unknown is NOT not_live/);

// ── 3. Idempotence ────────────────────────────────────────────────────────
check('re-running the migration changes nothing');
const snap = async () => ({
  rows: await q(`select product_title, live_status, live_status_stored, catalog_variants
                   from public.launch_product_readiness_v order by product_title`),
  desc: (await cat('launch_product_readiness')).description
});
const before = await snap();
for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}
const after = await snap();
assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)),
  'the description must be appended once, not on every apply');

console.log(`${checks} launch readiness live-status checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
