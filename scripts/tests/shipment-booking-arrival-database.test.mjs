process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20261028220000_shipment_bookings_and_po_arrival.sql against a real
// PostgreSQL: a booking groups shipments across POs, its dates win over the
// shipments' own, v_po_arrival publishes plan / actual / variance per PO, and
// the three shared PO views gain the arrival columns WITHOUT disturbing the
// columns every page already reads.
//
// Run: node scripts/tests/shipment-booking-arrival-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
//
// Mutations (each must fail a check):
//   ARRIVAL_MUTATION=min-eta        current_eta takes the EARLIEST shipment ETA
//   ARRIVAL_MUTATION=ignore-ata     actual arrival no longer beats the estimate
//   ARRIVAL_MUTATION=no-tenant-guard  the cross-company booking check never fires
//   ARRIVAL_MUTATION=plan-wins      the plan date beats the shipments' ETA
//   ARRIVAL_MUTATION=cascade-delete deleting a booking deletes its shipments
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20261028220000_shipment_bookings_and_po_arrival.sql';
let migration = await readFile(new URL(MIGRATION, root), 'utf8');

const mutation = process.env.ARRIVAL_MUTATION || '';
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation anchor not found: ${from.slice(0, 60)}`);
  migration = migration.replace(from, to);
};
if (mutation === 'min-eta') mutate('    max(eff_eta)                                      as current_eta,', '    min(eff_eta)                                      as current_eta,');
if (mutation === 'ignore-ata') mutate('    coalesce(b.ata, b.eta, s.eta)                    as eff_eta,', '    coalesce(b.eta, s.eta)                           as eff_eta,');
if (mutation === 'no-tenant-guard') mutate('  if v_booking_company is distinct from new.company_entity_id then', '  if false then');
if (mutation === 'plan-wins') mutate('  coalesce(a.current_eta, h.expected_arrival_date)     as effective_arrival_date,', '  coalesce(h.expected_arrival_date, a.current_eta)     as effective_arrival_date,');
if (mutation === 'cascade-delete') mutate('add column if not exists booking_id uuid references public.shipment_bookings(id) on delete set null;', 'add column if not exists booking_id uuid references public.shipment_bookings(id);');

const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
// PGlite hands back a Date for a date column; compare on the calendar day.
const d = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));

const CO_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CO_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALICE = '11111111-1111-4111-8111-111111111111';   // member of CO_A
const BRUNO = '22222222-2222-4222-8222-222222222222';   // member of CO_B
const asUser = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);

// ── The production shape this migration lands on ───────────────────────────
await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;

  create table public.entities(id uuid primary key, name text);
  insert into public.entities values ('${CO_A}','Company A'), ('${CO_B}','Company B');

  create table public.profiles(id uuid primary key, active_company_id uuid, is_admin boolean default true);
  insert into public.profiles values ('${ALICE}','${CO_A}', true), ('${BRUNO}','${CO_B}', true);

  create function public.active_company_id() returns uuid language sql stable security definer as
    $$ select active_company_id from public.profiles where id = auth.uid() $$;
  create function public.is_admin_user() returns boolean language sql stable security definer as
    $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;
  create function public.set_updated_at() returns trigger language plpgsql as
    $$ begin new.updated_at = now(); return new; end $$;
  create function public.stamp_company_entity_id() returns trigger language plpgsql as
    $$ begin
         if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
         return new;
       end $$;
  create function public.stamp_shipment_audit() returns trigger language plpgsql as
    $$ begin
         if tg_op = 'INSERT' then
           if auth.uid() is not null then new.created_by := auth.uid(); new.updated_by := auth.uid(); end if;
         else
           new.created_by := old.created_by; new.updated_by := auth.uid();
         end if;
         return new;
       end $$;

  create table public.factories(id uuid primary key default gen_random_uuid(), factory_name text,
    company_entity_id uuid references public.entities(id));
  create table public.po_headers(id uuid primary key default gen_random_uuid(), po_name text,
    factory_id uuid references public.factories(id), order_date date, req_ship_date date,
    expected_arrival_date date, date_bucket text, status text not null default 'Draft',
    wholesale_triggered boolean not null default false, is_new_product_po boolean not null default false,
    notes text, internal_notes text, pdf_url text, created_by uuid,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    company_entity_id uuid references public.entities(id));
  create table public.po_lines(id uuid primary key default gen_random_uuid(),
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    product_master_id uuid, product_type_snapshot text, title_snapshot text, variant_title_snapshot text,
    sku_snapshot text, upc_snapshot text, retail_price numeric(12,2), unit_cost numeric(12,4),
    qty numeric(12,2) not null default 0, retail_value numeric(14,2), line_notes text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    company_entity_id uuid references public.entities(id));

  create table public.incoming_shipments(
    id uuid primary key default gen_random_uuid(),
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    shipment_status text not null default 'Not Shipped'
      check (shipment_status in ('Not Shipped','Booked','Shipped','In Transit','Delayed','Delivered','Received')),
    ship_date date, eta date, received_date date,
    tracking_number text, carrier text, container_ref text, warehouse_location text,
    received_by text, notes text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    company_entity_id uuid references public.entities(id),
    created_by uuid references public.profiles(id), updated_by uuid references public.profiles(id));
  create trigger stamp_company_entity_id before insert on public.incoming_shipments
    for each row execute function public.stamp_company_entity_id();
  create trigger trg_incoming_shipments_audit before insert or update on public.incoming_shipments
    for each row execute function public.stamp_shipment_audit();

  create table public.incoming_shipment_lines(
    id uuid primary key default gen_random_uuid(),
    shipment_id uuid not null references public.incoming_shipments(id) on delete cascade,
    po_line_id uuid not null references public.po_lines(id) on delete cascade,
    qty numeric(12,2), notes text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    company_entity_id uuid references public.entities(id),
    created_by uuid references public.profiles(id), updated_by uuid references public.profiles(id),
    unique (shipment_id, po_line_id));
  create trigger stamp_company_entity_id before insert on public.incoming_shipment_lines
    for each row execute function public.stamp_company_entity_id();

  alter table public.po_headers enable row level security;
  alter table public.po_lines enable row level security;
  alter table public.incoming_shipments enable row level security;
  alter table public.incoming_shipment_lines enable row level security;
  create policy p on public.po_headers for all using (company_entity_id = public.active_company_id());
  create policy p on public.po_lines for all using (company_entity_id = public.active_company_id());
  create policy p on public.incoming_shipments for all using (company_entity_id = public.active_company_id());
  create policy p on public.incoming_shipment_lines for all using (company_entity_id = public.active_company_id());

  -- The shared views exactly as they stand on production, so the migration has
  -- to succeed through CREATE OR REPLACE VIEW -- which refuses to rename,
  -- retype or reorder an existing column. This is the check that a page
  -- reading one of them cannot be broken by the new columns.
  create view public.v_po_incoming_lines with (security_invoker = true) as
  select h.id as po_header_id, h.po_name, h.factory_id, f.factory_name, h.status, h.order_date,
         h.req_ship_date, h.expected_arrival_date, h.date_bucket, h.wholesale_triggered,
         h.is_new_product_po, h.created_at as po_created_at, l.id as po_line_id, l.product_master_id,
         l.product_type_snapshot as product_type, l.title_snapshot as product_title,
         l.variant_title_snapshot as variant_title, l.sku_snapshot as sku, l.upc_snapshot as upc,
         l.qty, l.retail_price, l.unit_cost,
         coalesce(l.retail_value, coalesce(l.qty,0)::numeric * coalesce(l.retail_price,0::numeric)) as retail_value,
         coalesce(l.qty,0)::numeric * coalesce(l.unit_cost,0::numeric) as estimated_cost, l.line_notes
    from public.po_headers h
    left join public.factories f on f.id = h.factory_id
    left join public.po_lines l on l.po_header_id = h.id;

  create view public.v_po_incoming_summary with (security_invoker = true) as
  select po_header_id as id, po_name, factory_id, factory_name, status, order_date, req_ship_date,
         expected_arrival_date, date_bucket, wholesale_triggered, is_new_product_po, po_created_at,
         count(po_line_id) as line_count, count(distinct product_title) as style_count,
         sum(coalesce(qty,0)) as total_units, sum(coalesce(retail_value,0::numeric)) as total_retail_value,
         sum(coalesce(estimated_cost,0::numeric)) as total_estimated_cost,
         sum(coalesce(retail_value,0::numeric)) - sum(coalesce(estimated_cost,0::numeric)) as retail_cost_spread
    from public.v_po_incoming_lines
   group by po_header_id, po_name, factory_id, factory_name, status, order_date, req_ship_date,
            expected_arrival_date, date_bucket, wholesale_triggered, is_new_product_po, po_created_at;

  create view public.v_po_header_summary with (security_invoker = true) as
  select ph.id, ph.po_name, ph.factory_id, f.factory_name, ph.order_date, ph.req_ship_date,
         ph.expected_arrival_date, ph.date_bucket, ph.status, ph.wholesale_triggered,
         ph.is_new_product_po, ph.notes, ph.internal_notes, ph.pdf_url, ph.created_by, ph.created_at,
         ph.updated_at, coalesce(sum(pl.qty), 0::bigint) as total_units,
         coalesce(sum(pl.retail_value), 0::numeric)::numeric(14,2) as total_retail_value,
         coalesce(sum(pl.unit_cost * pl.qty::numeric), 0::numeric)::numeric(14,2) as total_estimated_cost
    from public.po_headers ph
    left join public.factories f on f.id = ph.factory_id
    left join public.po_lines pl on pl.po_header_id = ph.id
   group by ph.id, ph.po_name, ph.factory_id, f.factory_name, ph.order_date, ph.req_ship_date,
            ph.expected_arrival_date, ph.date_bucket, ph.status, ph.wholesale_triggered,
            ph.is_new_product_po, ph.notes, ph.internal_notes, ph.pdf_url, ph.created_by,
            ph.created_at, ph.updated_at;

  create view public.v_po_open_planning_lines with (security_invoker = true) as
  select h.id as po_header_id, h.po_name, h.status, h.factory_id, f.factory_name, h.order_date,
         h.req_ship_date, h.expected_arrival_date,
         coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date) as planning_date,
         to_char(coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date)::timestamptz,'YYYY-MM') as month_key,
         h.date_bucket, l.id as po_line_id, l.product_master_id,
         l.product_type_snapshot as product_type, l.title_snapshot as product_title,
         lower(coalesce(l.title_snapshot,'')) as product_key_raw,
         lower(coalesce(l.title_snapshot,'')) as product_key,
         l.variant_title_snapshot as variant_title, l.sku_snapshot as sku, l.upc_snapshot as upc,
         coalesce(l.qty,0) as incoming_units, coalesce(l.retail_price,0::numeric) as retail_price,
         coalesce(l.unit_cost,0::numeric) as unit_cost,
         coalesce(l.retail_value, coalesce(l.qty,0)::numeric * coalesce(l.retail_price,0::numeric)) as incoming_retail_value,
         coalesce(l.qty,0)::numeric * coalesce(l.unit_cost,0::numeric) as incoming_cost
    from public.po_headers h
    left join public.factories f on f.id = h.factory_id
    left join public.po_lines l on l.po_header_id = h.id
   where h.status = any (array['Approved','Sent to Factory','Confirmed','In Production','Shipped','In Transit','Partially Received'])
     and coalesce(l.qty,0) <> 0;

  create view public.v_po_shipment_lines with (security_invoker = true) as
  select s.id as shipment_id, s.po_header_id, s.shipment_status, s.ship_date, s.eta, s.received_date,
         s.tracking_number, s.carrier, s.container_ref, s.warehouse_location, s.received_by,
         s.notes as shipment_notes, s.company_entity_id, sl.id as shipment_line_id, sl.po_line_id,
         sl.qty as assigned_qty, sl.notes as line_notes, pl.title_snapshot, pl.variant_title_snapshot,
         pl.sku_snapshot, pl.qty as line_qty
    from public.incoming_shipments s
    left join public.incoming_shipment_lines sl on sl.shipment_id = s.id
    left join public.po_lines pl on pl.id = sl.po_line_id;

  create view public.v_launch_po_product_lookup with (security_invoker = true) as
  select h.id as po_header_id, h.po_name, h.status as po_status, h.order_date, h.req_ship_date,
         h.expected_arrival_date, h.date_bucket, h.is_new_product_po, h.wholesale_triggered,
         h.pdf_url, h.notes as po_notes, h.internal_notes, f.factory_name,
         l.title_snapshot as product_title, l.product_type_snapshot as product_type,
         count(*) as variant_count, sum(coalesce(l.qty,0))::integer as total_units,
         sum(coalesce(l.retail_value, coalesce(l.qty,0)::numeric * coalesce(l.retail_price,0::numeric))) as total_retail_value,
         sum(coalesce(l.qty,0)::numeric * coalesce(l.unit_cost,0::numeric)) as total_estimated_cost,
         min(l.retail_price) as min_retail_price, max(l.retail_price) as max_retail_price,
         string_agg(distinct nullif(l.variant_title_snapshot,''), ', ' order by (nullif(l.variant_title_snapshot,''))) as variants,
         string_agg(distinct nullif(l.sku_snapshot,''), ', ' order by (nullif(l.sku_snapshot,''))) as sample_skus,
         h.factory_id
    from public.po_lines l
    join public.po_headers h on h.id = l.po_header_id
    left join public.v_po_header_summary f on f.id = h.id
   where nullif(l.title_snapshot,'') is not null
   group by h.id, h.po_name, h.status, h.order_date, h.req_ship_date, h.expected_arrival_date,
            h.date_bucket, h.is_new_product_po, h.wholesale_triggered, h.pdf_url, h.notes,
            h.internal_notes, f.factory_name, l.title_snapshot, l.product_type_snapshot, h.factory_id;

  -- Report / dashboard / catalog surfaces the migration updates.
  create table public.silo_chat_saved_reports(id uuid primary key, source text, company_entity_id uuid,
    created_by uuid, title text, description text, question text, answer text, queries_run text[],
    visibility text, columns_metadata jsonb, parameters jsonb);
  create table public.silo_report_tieouts(id uuid primary key default gen_random_uuid(),
    report_id uuid not null references public.silo_chat_saved_reports(id) on delete cascade,
    name text not null, kind text not null check (kind in ('reconciliation','sanity')),
    check_sql text not null, tolerance numeric not null default 0, enabled boolean not null default true,
    note text, created_at timestamptz not null default now(), unique (report_id, name));
  create table public.dashboard_widgets(id uuid primary key default gen_random_uuid(),
    dashboard_id uuid not null, company_entity_id uuid, title text,
    visual_type text not null default 'table', visual_config jsonb not null default '{}'::jsonb,
    layout jsonb not null default '{}'::jsonb, sort_order integer not null default 0);
  create table public.silo_chat_schema_catalog(relname text primary key, relkind text, columns jsonb,
    auto_refreshed_at timestamptz, is_hidden boolean not null default false,
    reportable boolean not null default false);
  create table public.catalog_refreshes(at timestamptz default now());
  create function public.refresh_chat_schema_catalog() returns void language plpgsql as
    $$ begin
         insert into public.catalog_refreshes default values;
         insert into public.silo_chat_schema_catalog(relname, relkind, auto_refreshed_at)
           select c.relname, c.relkind::text, now() from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','v','m')
           on conflict (relname) do update set relkind = excluded.relkind,
                auto_refreshed_at = excluded.auto_refreshed_at;
       end $$;

  insert into public.silo_chat_saved_reports(id, source, title, queries_run, columns_metadata) values
    ('c1000000-0000-4000-a000-000000000002','system','Logistics · Purchase orders past their arrival date',
     array['select po_name from v_po_incoming_summary where expected_arrival_date < current_date'],
     '{"expected_arrival_date":{"semantic":"date"}}'::jsonb),
    ('c1000000-0000-4000-a000-000000000003','system','Logistics · Units arriving by month',
     array['select date_trunc(''month'', expected_arrival_date) from v_po_incoming_summary'], '{}'::jsonb),
    ('c1000000-0000-4000-a000-000000000004','system','Logistics · Open units by factory',
     array['select min(expected_arrival_date) from v_po_incoming_summary'], '{}'::jsonb);
  insert into public.silo_report_tieouts(report_id, name, kind, check_sql, note) values
    ('c1000000-0000-4000-a000-000000000002','overdue PO count ties to po_headers','reconciliation','select 1, 1','old'),
    ('c1000000-0000-4000-a000-000000000003','arriving units tie to the PO LINE level','reconciliation','select 1, 1','old');
  insert into public.dashboard_widgets(dashboard_id, title, visual_config) values
    (gen_random_uuid(),'Purchase orders past their arrival date',
     '{"limit": 12, "columns": ["po_name","factory_name","status","expected_arrival_date","days_late","total_units"]}'::jsonb),
    (gen_random_uuid(),'Open POs',
     '{"limit": 8, "columns": ["po_name","factory_name","status","expected_arrival_date","total_units"]}'::jsonb),
    (gen_random_uuid(),'Something else', '{"limit": 5, "columns": ["po_name","total_units"]}'::jsonb);
`);

// ── Fixture: the production situations this is for ─────────────────────────
const PO = {};
await db.exec(`insert into public.factories(id, factory_name, company_entity_id)
  values ('ffffffff-0000-4000-8000-000000000001','Incotexco','${CO_A}'),
         ('ffffffff-0000-4000-8000-000000000002','Other Co Factory','${CO_B}')`);
for (const [key, name, planned, status, company] of [
  ['slipped',   'Healong-3',     '2026-07-15', 'In Production',   CO_A],  // arrived 79 days late
  ['container', 'Incotexco-480', '2026-09-18', 'Sent to Factory', CO_A],  // two shipments, one booking
  ['noShip',    'Creytex-400',   '2026-07-30', 'In Production',   CO_A],  // nothing logged
  ['noPlan',    'Incotexco-476', null,         'Received',        CO_A],  // no plan date at all
  ['stale',     'Creytex-325',   '2026-07-01', 'Received',        CO_A],  // status says Received, shipment does not
  ['partial',   'ArtiGifts-49',  '2026-08-01', 'In Production',   CO_A],  // one box in, one at sea
  ['otherCo',   'OtherCo-1',     '2026-09-01', 'In Production',   CO_B],
]) {
  const r = await one(
    `insert into public.po_headers(po_name, expected_arrival_date, status, company_entity_id, factory_id)
     values ($1, $2::date, $3, $4::uuid, case when $4::uuid = '${CO_A}'::uuid then 'ffffffff-0000-4000-8000-000000000001'::uuid
                                  else 'ffffffff-0000-4000-8000-000000000002'::uuid end) returning id`,
    [name, planned, status, company]);
  PO[key] = r.id;
  await db.query(`insert into public.po_lines(po_header_id, title_snapshot, qty, company_entity_id)
                  values ($1, $2, 100, $3)`, [r.id, `${name} tee`, company]);
}

const ship = async (poKey, row) => {
  const { status = 'Not Shipped', ship_date = null, eta = null, received = null, company = CO_A } = row;
  const r = await one(`insert into public.incoming_shipments
      (po_header_id, shipment_status, ship_date, eta, received_date, company_entity_id)
    values ($1,$2,$3,$4,$5,$6) returning id`, [PO[poKey], status, ship_date, eta, received, company]);
  return r.id;
};

const S = {};
S.slipped    = await ship('slipped',   { status: 'Shipped',    ship_date: '2026-09-22', eta: '2026-10-02', received: '2026-10-07' });
S.container1 = await ship('container', { status: 'Not Shipped', ship_date: '2026-10-28' });
S.container2 = await ship('container', { status: 'Not Shipped', ship_date: '2026-10-29' });
S.noPlan     = await ship('noPlan',    { status: 'Delivered',  ship_date: '2026-08-05', eta: '2026-08-19', received: '2026-08-18' });
S.stale      = await ship('stale',     { status: 'In Transit', eta: '2026-11-20' });
S.partialIn  = await ship('partial',   { status: 'Received',   eta: '2026-08-10', received: '2026-08-12' });
S.partialOut = await ship('partial',   { status: 'In Transit', eta: '2026-12-01' });
S.otherCo    = await ship('otherCo',   { status: 'In Transit', eta: '2026-11-11', company: CO_B });

// ── Apply twice: a migration has to be re-runnable ────────────────────────
await db.exec(migration);
await db.exec(migration);

const arrival = async (poKey) => one(`select * from public.v_po_arrival where po_header_id = $1`, [PO[poKey]]);

await test('applies twice: table, link column, guard trigger and both new views exist once', async () => {
  const r = await one(`select
      (select count(*)::int from information_schema.tables where table_schema='public' and table_name='shipment_bookings') t,
      (select count(*)::int from information_schema.columns where table_schema='public' and table_name='incoming_shipments' and column_name='booking_id') c,
      (select count(*)::int from pg_trigger where tgname='zz_incoming_shipments_booking_company' and not tgisinternal) g,
      (select count(*)::int from information_schema.views where table_schema='public' and table_name in ('v_po_arrival','v_shipment_booking_summary')) v,
      (select count(*)::int from public.catalog_refreshes) refreshes`);
  assert.equal(r.t, 1); assert.equal(r.c, 1); assert.equal(r.v, 2);
  assert.equal(r.g, 1);
  assert.equal(r.refreshes, 2, 'the catalog is refreshed on every apply');
});

await test('every column the pages already read keeps its name, type and position', async () => {
  // CREATE OR REPLACE VIEW would have refused a rename or a retype, so the
  // migration applying at all is most of this check; this pins the prefix and
  // that the arrival columns were APPENDED rather than inserted.
  const expect = {
    v_po_incoming_summary: ['id','po_name','factory_id','factory_name','status','order_date','req_ship_date',
      'expected_arrival_date','date_bucket','wholesale_triggered','is_new_product_po','po_created_at',
      'line_count','style_count','total_units','total_retail_value','total_estimated_cost','retail_cost_spread'],
    v_po_header_summary: ['id','po_name','factory_id','factory_name','order_date','req_ship_date',
      'expected_arrival_date','date_bucket','status','wholesale_triggered','is_new_product_po','notes',
      'internal_notes','pdf_url','created_by','created_at','updated_at','total_units','total_retail_value',
      'total_estimated_cost'],
    v_po_shipment_lines: ['shipment_id','po_header_id','shipment_status','ship_date','eta','received_date',
      'tracking_number','carrier','container_ref','warehouse_location','received_by','shipment_notes',
      'company_entity_id','shipment_line_id','po_line_id','assigned_qty','line_notes','title_snapshot',
      'variant_title_snapshot','sku_snapshot','line_qty'],
    v_launch_po_product_lookup: ['po_header_id','po_name','po_status','order_date','req_ship_date',
      'expected_arrival_date','date_bucket','is_new_product_po','wholesale_triggered','pdf_url','po_notes',
      'internal_notes','factory_name','product_title','product_type','variant_count','total_units',
      'total_retail_value','total_estimated_cost','min_retail_price','max_retail_price','variants',
      'sample_skus','factory_id'],
  };
  for (const [view, prefix] of Object.entries(expect)) {
    const cols = (await all(`select column_name from information_schema.columns
      where table_schema='public' and table_name=$1 order by ordinal_position`, [view])).map(r => r.column_name);
    assert.deepEqual(cols.slice(0, prefix.length), prefix, `${view} prefix`);
    assert.ok(cols.length > prefix.length, `${view} gained arrival columns`);
  }
  const added = (await all(`select column_name from information_schema.columns
    where table_schema='public' and table_name='v_po_incoming_summary' order by ordinal_position offset 18`)).map(r => r.column_name);
  assert.deepEqual(added, ['current_eta','effective_arrival_date','arrival_variance_days','arrival_state','shipment_count','status_conflicts_with_shipments']);
});

await test('the PO picker that Products and the launch calendar use offers the real arrival', async () => {
  const r = await one(`select expected_arrival_date, current_eta, effective_arrival_date, arrival_state
    from public.v_launch_po_product_lookup where po_header_id = $1`, [PO.slipped]);
  assert.equal(d(r.expected_arrival_date), '2026-07-15', 'the plan is still offered');
  assert.equal(d(r.current_eta), '2026-10-02');
  assert.equal(d(r.effective_arrival_date), '2026-10-02', 'copying this into a launch ETA copies the real one');
  assert.equal(r.arrival_state, 'received');
});

await test('a PO with no shipments reads its plan and says so, rather than claiming it has not shipped', async () => {
  const r = await arrival('noShip');
  assert.equal(r.current_eta, null);
  assert.equal(d(r.effective_arrival_date), '2026-07-30');
  assert.equal(r.arrival_variance_days, null, 'no shipment is not "on time"');
  assert.equal(r.arrival_state, 'unknown');
  assert.equal(r.shipment_count, 0);
  assert.equal(r.status_conflicts_with_shipments, false);
});

await test('the 79-day slip is visible as a slip, and the plan is not overwritten', async () => {
  const r = await arrival('slipped');
  assert.equal(d(r.planned_arrival), '2026-07-15');
  assert.equal(d(r.current_eta), '2026-10-02');
  assert.equal(d(r.effective_arrival_date), '2026-10-02');
  assert.equal(Number(r.arrival_variance_days), 79);
  assert.equal(r.arrival_state, 'received');
  const h = await one(`select expected_arrival_date from public.po_headers where id = $1`, [PO.slipped]);
  assert.equal(d(h.expected_arrival_date), '2026-07-15', 'the PO plan is never written');
});

await test('a PO is not "arrived" until its LAST shipment is: the latest ETA wins', async () => {
  const r = await arrival('partial');
  assert.equal(d(r.current_eta), '2026-12-01');
  assert.equal(r.arrival_state, 'partially_received');
});

await test('a typed status that contradicts the shipments is flagged, never corrected', async () => {
  const stale = await arrival('stale');
  assert.equal(stale.po_status, 'Received');
  assert.equal(stale.arrival_state, 'in_transit');
  assert.equal(stale.status_conflicts_with_shipments, true);
  const h = await one(`select status from public.po_headers where id = $1`, [PO.stale]);
  assert.equal(h.status, 'Received', 'the migration never rewrites a status');
  const ok = await arrival('slipped');
  assert.equal(ok.status_conflicts_with_shipments, true, 'goods in, PO still In Production -- also a conflict');
  const quiet = await arrival('noShip');
  assert.equal(quiet.status_conflicts_with_shipments, false, 'no shipments cannot contradict anything');
});

await test('a PO with no plan date reports its ETA and no variance', async () => {
  const r = await arrival('noPlan');
  assert.equal(r.planned_arrival, null);
  assert.equal(d(r.current_eta), '2026-08-19');
  assert.equal(r.arrival_variance_days, null);
  assert.equal(r.arrival_state, 'received');
});

let booking;
await test('one booking carries two POs, and its dates replace the per-shipment ones', async () => {
  await asUser(ALICE);
  const b = await one(`insert into public.shipment_bookings
      (booking_ref, forwarder, mode, container_ref, etd, eta, status)
    values ('BK-1042','Flexport','Ocean','MSKU7654321','2026-10-29','2026-11-06','Booked') returning *`);
  booking = b.id;
  assert.equal(b.company_entity_id, CO_A, 'stamped from the active company');
  assert.equal(b.created_by, ALICE, 'stamped from the session');
  await db.query(`update public.incoming_shipments set booking_id = $1 where id in ($2,$3,$4)`,
    [booking, S.container1, S.container2, S.stale]);

  const r = await arrival('container');
  assert.equal(d(r.current_eta), '2026-11-06', "the booking's ETA, not the shipments' empty one");
  assert.equal(d(r.first_ship_date), '2026-10-29', "the booking's ETD replaces two typed ship dates");
  assert.equal(Number(r.arrival_variance_days), 49);
  assert.equal(r.shipment_count, 2);
  assert.equal(r.booking_count, 1);

  const s = await one(`select * from public.v_shipment_booking_summary where booking_id = $1`, [booking]);
  assert.equal(Number(s.po_count), 2, 'the container spans two POs -- the thing that had no object before');
  assert.equal(Number(s.shipment_count), 3);
  assert.equal(s.po_names, 'Creytex-325, Incotexco-480');
  assert.equal(d(s.effective_eta), '2026-11-06');
});

await test('actual arrival beats the estimate, for every PO in the container at once', async () => {
  await db.query(`update public.shipment_bookings set ata = '2026-11-02', status = 'Arrived' where id = $1`, [booking]);
  const r = await arrival('container');
  assert.equal(d(r.current_eta), '2026-11-02');
  assert.equal(r.arrival_state, 'received', 'the container landed, so both POs did');
  const s = await one(`select * from public.v_shipment_booking_summary where booking_id = $1`, [booking]);
  assert.equal(d(s.effective_eta), '2026-11-02');
  await db.query(`update public.shipment_bookings set ata = null, status = 'Booked' where id = $1`, [booking]);
});

await test('deleting a booking keeps the shipments and falls back to their own dates', async () => {
  const b = await one(`insert into public.shipment_bookings (booking_ref, eta) values ('BK-DOOMED','2026-12-25') returning id`);
  await db.query(`update public.incoming_shipments set booking_id = $1 where id = $2`, [b.id, S.slipped]);
  assert.equal(d((await arrival('slipped')).current_eta), '2026-12-25');
  await db.query(`delete from public.shipment_bookings where id = $1`, [b.id]);
  const kept = await one(`select booking_id, eta from public.incoming_shipments where id = $1`, [S.slipped]);
  assert.ok(kept, 'the shipment survives its booking');
  assert.equal(kept.booking_id, null);
  assert.equal(d((await arrival('slipped')).current_eta), '2026-10-02', 'back to its own ETA');
});

await test('a shipment cannot be joined to another company\'s booking', async () => {
  await asUser(BRUNO);
  const other = await one(`insert into public.shipment_bookings (booking_ref, eta) values ('BK-OTHERCO','2026-11-30') returning id`);
  assert.equal(other.company_entity_id ?? CO_B, CO_B);
  await asUser(null);
  await assert.rejects(
    db.query(`update public.incoming_shipments set booking_id = $1 where id = $2`, [other.id, S.container1]),
    /belongs to company/,
    'the tenant guard refuses it even for a service-role write that RLS does not see');
});

await test('RLS keeps bookings and arrival rows inside the active company', async () => {
  await db.exec(`grant select on public.shipment_bookings, public.v_po_arrival, public.v_shipment_booking_summary,
    public.v_po_incoming_summary, public.po_headers, public.incoming_shipments, public.po_lines,
    public.factories, public.v_po_incoming_lines to authenticated`);
  await asUser(ALICE);
  await db.exec('set role authenticated');
  try {
    const mine = await all(`select booking_ref from public.shipment_bookings order by booking_ref`);
    assert.deepEqual(mine.map(r => r.booking_ref), ['BK-1042'], 'not the other company\'s booking');
    const pos = await all(`select po_name from public.v_po_arrival order by po_name`);
    assert.ok(!pos.some(r => r.po_name === 'OtherCo-1'), 'arrival view is scoped by the caller\'s own RLS');
    assert.ok(pos.some(r => r.po_name === 'Incotexco-480'));
  } finally { await db.exec('reset role'); }
  await asUser(BRUNO);
  await db.exec('set role authenticated');
  try {
    const theirs = await all(`select po_name, current_eta from public.v_po_arrival`);
    assert.deepEqual(theirs.map(r => r.po_name), ['OtherCo-1']);
    assert.equal(d(theirs[0].current_eta), '2026-11-11');
  } finally { await db.exec('reset role'); }
  await asUser(null);
});

await test('two companies may use the same booking reference; one company may not reuse it', async () => {
  await asUser(BRUNO);
  const dup = await one(`insert into public.shipment_bookings (booking_ref) values ('BK-1042') returning id`);
  assert.ok(dup.id, 'the other company gets its own BK-1042');
  await asUser(ALICE);
  await assert.rejects(db.query(`insert into public.shipment_bookings (booking_ref) values ('bk-1042')`),
    /duplicate key|unique/, 'same company, same ref, different case -- one booking');
  await asUser(null);
});

await test('planning now plans against the shipments, not the plan nobody updated', async () => {
  const r = await one(`select planning_date, month_key, current_eta, arrival_state
    from public.v_po_open_planning_lines where po_header_id = $1`, [PO.container]);
  assert.equal(d(r.planning_date), '2026-11-06');
  assert.equal(r.month_key, '2026-11', 'was 2026-09, the month it was never going to land in');
  const noShip = await one(`select planning_date from public.v_po_open_planning_lines where po_header_id = $1`, [PO.noShip]);
  assert.equal(d(noShip.planning_date), '2026-07-30', 'no shipment: unchanged from today');
});

await test('the overdue report counts what is actually late, and the tie-outs follow it', async () => {
  const rep = await one(`select queries_run[1] q, columns_metadata from public.silo_chat_saved_reports
    where id = 'c1000000-0000-4000-a000-000000000002'`);
  assert.ok(rep.q.includes('effective_arrival_date'), 'the report measures against the effective date');
  assert.ok(rep.q.includes('arrival_state'), 'and shows what the shipments say');
  assert.ok(rep.columns_metadata.current_eta, 'the new columns are labelled');
  const t = await all(`select name, check_sql from public.silo_report_tieouts order by name`);
  assert.equal(t.length, 3, 'two rebuilt, one added for the new join');
  for (const row of t) assert.ok(!row.check_sql.includes('select 1, 1'), `${row.name} was rebuilt`);
  assert.ok(t.some(r => r.name.includes('ETAs tie to the shipments')));
});

await test('the overdue report actually runs, and its number moved for the right reason', async () => {
  const late = await all(`select po_name, effective_arrival_date, (current_date - effective_arrival_date) days_late, arrival_state
      from public.v_po_incoming_summary
     where status in ('Confirmed','Sent to Factory','In Production','In Transit')
       and effective_arrival_date is not null and effective_arrival_date < current_date
     order by effective_arrival_date`);
  const names = late.map(r => r.po_name);
  assert.ok(names.includes('Healong-3'), 'received 2026-10-07, so still past its date -- and arrival_state says received');
  assert.ok(!names.includes('Incotexco-480'), 'no longer late: its container is due 2026-11-06, not 2026-09-18');
  const slipped = late.find(r => r.po_name === 'Healong-3');
  assert.equal(slipped.arrival_state, 'received', 'the row says it is a stale status, not a missing container');
});

await test('dashboard tiles that showed the plan now show the current ETA beside it', async () => {
  const rows = await all(`select title, visual_config->'columns' cols from public.dashboard_widgets order by title`);
  const po = rows.find(r => r.title === 'Purchase orders past their arrival date');
  assert.deepEqual(po.cols, ['po_name','factory_name','status','expected_arrival_date','current_eta','arrival_state','days_late','total_units']);
  const open = rows.find(r => r.title === 'Open POs');
  assert.deepEqual(open.cols, ['po_name','factory_name','status','expected_arrival_date','current_eta','arrival_state','total_units']);
  const other = rows.find(r => r.title === 'Something else');
  assert.deepEqual(other.cols, ['po_name','total_units'], 'a tile that never showed the date is untouched');
});

await test('Ask SILO and the report builder are offered the new objects', async () => {
  const r = await all(`select relname, reportable from public.silo_chat_schema_catalog
    where relname in ('shipment_bookings','v_po_arrival','v_shipment_booking_summary') order by relname`);
  assert.equal(r.length, 3, 'the catalog refresh picked them up');
  for (const row of r) assert.equal(row.reportable, true, `${row.relname} is offered in the source rail`);
});

await test('nobody can call the tenant guard directly', async () => {
  const r = await one(`select has_function_privilege('authenticated','public.shipment_booking_same_company()','execute') a,
    has_function_privilege('anon','public.shipment_booking_same_company()','execute') b`);
  assert.equal(r.a, false); assert.equal(r.b, false);
});

console.log(`\n${checks} checks passed`);
