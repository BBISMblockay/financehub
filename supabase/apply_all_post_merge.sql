-- =============================================================================
-- SILO: apply all PO builder + costing + profile migrations
-- Run entire file in Supabase SQL Editor (safe to re-run).
-- Prerequisite for /v2/po-builder.html and /v2/po-costing.html
-- =============================================================================

-- >>> SECTION 1: PO BUILDER (run first — creates po_headers / po_lines)
-- =============================================================================
-- SILO PO Builder module (prerequisite for PO costing)
-- Run in Supabase SQL Editor BEFORE 20260521120000_po_costing_module.sql
--
-- Creates: factories (if missing), po_headers, po_lines, list/report views,
--          generate_next_po_name(), RLS for purchasing/finance roles.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Factories (PO builder depends on this; skip if you already maintain it)
-- ---------------------------------------------------------------------------

create table if not exists public.factories (
  id uuid primary key default gen_random_uuid(),
  factory_name text not null,
  short_code text,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists factories_factory_name_idx on public.factories (factory_name);
create unique index if not exists factories_short_code_uidx
  on public.factories (lower(short_code))
  where short_code is not null and btrim(short_code) <> '';

-- ---------------------------------------------------------------------------
-- PO headers & lines
-- ---------------------------------------------------------------------------

create table if not exists public.po_headers (
  id uuid primary key default gen_random_uuid(),
  po_name text,
  factory_id uuid references public.factories(id) on delete restrict,

  order_date date,
  req_ship_date date,
  expected_arrival_date date,
  date_bucket text,

  status text not null default 'Draft',
  wholesale_triggered boolean not null default false,
  is_new_product_po boolean not null default false,

  notes text,
  internal_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index if not exists po_headers_factory_id_idx on public.po_headers (factory_id);
create index if not exists po_headers_status_idx on public.po_headers (status);
create index if not exists po_headers_order_date_idx on public.po_headers (order_date desc);
create unique index if not exists po_headers_po_name_uidx
  on public.po_headers (lower(po_name))
  where po_name is not null and btrim(po_name) <> '';

create table if not exists public.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references public.po_headers(id) on delete cascade,

  -- Optional link to catalog (no FK — products_master may pre-exist separately)
  product_master_id uuid,

  product_type_snapshot text,
  title_snapshot text,
  variant_title_snapshot text,
  sku_snapshot text,
  upc_snapshot text,
  barcode_snapshot text,

  retail_price numeric(12, 2),
  unit_cost numeric(12, 4),
  qty numeric(12, 2) not null default 0,
  retail_value numeric(14, 2),

  line_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists po_lines_po_header_id_idx on public.po_lines (po_header_id);
create index if not exists po_lines_sku_snapshot_idx on public.po_lines (sku_snapshot);
create index if not exists po_lines_created_at_idx on public.po_lines (created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers (shared function; safe if already exists)
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists factories_set_updated_at on public.factories;
create trigger factories_set_updated_at
  before update on public.factories
  for each row execute function public.set_updated_at();

drop trigger if exists po_headers_set_updated_at on public.po_headers;
create trigger po_headers_set_updated_at
  before update on public.po_headers
  for each row execute function public.set_updated_at();

drop trigger if exists po_lines_set_updated_at on public.po_lines;
create trigger po_lines_set_updated_at
  before update on public.po_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto PO name: {SHORT}-{YYYY}-{seq}
-- ---------------------------------------------------------------------------

create or replace function public.generate_next_po_name(p_factory_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_year text;
  v_pattern text;
  v_max_seq int;
  v_next int;
begin
  select upper(coalesce(nullif(btrim(f.short_code), ''), left(regexp_replace(f.factory_name, '[^A-Za-z0-9]', '', 'g'), 6)))
  into v_prefix
  from public.factories f
  where f.id = p_factory_id;

  if v_prefix is null or v_prefix = '' then
    raise exception 'Factory not found for id %', p_factory_id;
  end if;

  v_year := to_char(current_date, 'YYYY');
  v_pattern := v_prefix || '-' || v_year || '-%';

  select coalesce(max(
    nullif(regexp_replace(h.po_name, '^.*-([0-9]+)$', '\1'), h.po_name)::int
  ), 0)
  into v_max_seq
  from public.po_headers h
  where h.factory_id = p_factory_id
    and h.po_name ilike v_pattern;

  v_next := v_max_seq + 1;
  return v_prefix || '-' || v_year || '-' || lpad(v_next::text, 3, '0');
end;
$$;

grant execute on function public.generate_next_po_name(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- NOTE (2026-07-02): these three view definitions are synced from the live DB
-- (pg_get_viewdef). The originals predated po_headers.pdf_url / created_by and
-- po_lines.product_master_id / line_notes; CREATE OR REPLACE VIEW cannot
-- reorder columns, so re-running the stale definitions aborted this script
-- ("cannot change name of view column \"pdf_url\" to \"created_at\"").

create or replace view public.v_po_header_summary
with (security_invoker = true) as
select
  ph.id,
  ph.po_name,
  ph.factory_id,
  f.factory_name,
  ph.order_date,
  ph.req_ship_date,
  ph.expected_arrival_date,
  ph.date_bucket,
  ph.status,
  ph.wholesale_triggered,
  ph.is_new_product_po,
  ph.notes,
  ph.internal_notes,
  ph.pdf_url,
  ph.created_by,
  ph.created_at,
  ph.updated_at,
  coalesce(sum(pl.qty), 0::bigint) as total_units,
  coalesce(sum(pl.retail_value), 0::numeric)::numeric(14,2) as total_retail_value,
  coalesce(sum(pl.unit_cost * pl.qty::numeric), 0::numeric)::numeric(14,2) as total_estimated_cost
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
left join public.po_lines pl on pl.po_header_id = ph.id
group by
  ph.id, ph.po_name, ph.factory_id, f.factory_name,
  ph.order_date, ph.req_ship_date, ph.expected_arrival_date, ph.date_bucket,
  ph.status, ph.wholesale_triggered, ph.is_new_product_po,
  ph.notes, ph.internal_notes, ph.pdf_url, ph.created_by, ph.created_at, ph.updated_at;

create or replace view public.v_po_incoming_lines
with (security_invoker = true) as
select
  h.id as po_header_id,
  h.po_name,
  h.factory_id,
  f.factory_name,
  h.status,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  h.date_bucket,
  h.wholesale_triggered,
  h.is_new_product_po,
  h.created_at as po_created_at,
  l.id as po_line_id,
  l.product_master_id,
  l.product_type_snapshot as product_type,
  l.title_snapshot as product_title,
  l.variant_title_snapshot as variant_title,
  l.sku_snapshot as sku,
  l.upc_snapshot as upc,
  l.qty,
  l.retail_price,
  l.unit_cost,
  coalesce(l.retail_value, coalesce(l.qty, 0)::numeric * coalesce(l.retail_price, 0::numeric)) as retail_value,
  coalesce(l.qty, 0)::numeric * coalesce(l.unit_cost, 0::numeric) as estimated_cost,
  l.line_notes
from public.po_headers h
left join public.factories f on f.id = h.factory_id
left join public.po_lines l on l.po_header_id = h.id;

create or replace view public.v_po_incoming_summary
with (security_invoker = true) as
select
  po_header_id as id,
  po_name,
  factory_id,
  factory_name,
  status,
  order_date,
  req_ship_date,
  expected_arrival_date,
  date_bucket,
  wholesale_triggered,
  is_new_product_po,
  po_created_at,
  count(po_line_id) as line_count,
  count(distinct product_title) as style_count,
  sum(coalesce(qty, 0)) as total_units,
  sum(coalesce(retail_value, 0::numeric)) as total_retail_value,
  sum(coalesce(estimated_cost, 0::numeric)) as total_estimated_cost,
  sum(coalesce(retail_value, 0::numeric)) - sum(coalesce(estimated_cost, 0::numeric)) as retail_cost_spread
from public.v_po_incoming_lines
group by
  po_header_id, po_name, factory_id, factory_name, status, order_date,
  req_ship_date, expected_arrival_date, date_bucket, wholesale_triggered,
  is_new_product_po, po_created_at;

-- Open PO lines for planning scenarios (non-closed / non-cancelled)
-- NOTE (2026-07-02): synced from the live DB (pg_get_viewdef) — the original
-- definition predated planning-scenarios v2 columns (factory_id,
-- product_master_id, product_key, retail_price, unit_cost) and the stricter
-- status filter; CREATE OR REPLACE VIEW cannot reorder/drop view columns.
create or replace view public.v_po_open_planning_lines
with (security_invoker = true) as
select
  h.id as po_header_id,
  h.po_name,
  h.status,
  h.factory_id,
  f.factory_name,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date) as planning_date,
  to_char(coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date)::timestamptz, 'YYYY-MM') as month_key,
  h.date_bucket,
  l.id as po_line_id,
  l.product_master_id,
  l.product_type_snapshot as product_type,
  l.title_snapshot as product_title,
  lower(regexp_replace(regexp_replace(regexp_replace(coalesce(l.title_snapshot, ''), '[''"]', '', 'g'), '&', 'and', 'g'), '[^a-zA-Z0-9]+', '-', 'g')) as product_key_raw,
  trim(both '-' from lower(regexp_replace(regexp_replace(regexp_replace(coalesce(l.title_snapshot, ''), '[''"]', '', 'g'), '&', 'and', 'g'), '[^a-zA-Z0-9]+', '-', 'g'))) as product_key,
  l.variant_title_snapshot as variant_title,
  l.sku_snapshot as sku,
  l.upc_snapshot as upc,
  coalesce(l.qty, 0) as incoming_units,
  coalesce(l.retail_price, 0::numeric) as retail_price,
  coalesce(l.unit_cost, 0::numeric) as unit_cost,
  coalesce(l.retail_value, coalesce(l.qty, 0)::numeric * coalesce(l.retail_price, 0::numeric)) as incoming_retail_value,
  coalesce(l.qty, 0)::numeric * coalesce(l.unit_cost, 0::numeric) as incoming_cost
from public.po_headers h
left join public.factories f on f.id = h.factory_id
left join public.po_lines l on l.po_header_id = h.id
where h.status = any (array['Approved', 'Sent to Factory', 'Confirmed', 'In Production', 'Shipped', 'In Transit', 'Partially Received'])
  and coalesce(l.qty, 0) <> 0;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.factories enable row level security;
alter table public.po_headers enable row level security;
alter table public.po_lines enable row level security;

create or replace function public.po_builder_can_write()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(coalesce(role::text, 'user')) in (
        'owner', 'admin'
      )
  );
$$;

drop policy if exists factories_select_auth on public.factories;
create policy factories_select_auth
  on public.factories for select to authenticated
  using (true);

drop policy if exists factories_write_auth on public.factories;
create policy factories_write_auth
  on public.factories for all to authenticated
  using (public.po_builder_can_write())
  with check (public.po_builder_can_write());

drop policy if exists po_headers_select_auth on public.po_headers;
create policy po_headers_select_auth
  on public.po_headers for select to authenticated
  using (true);

drop policy if exists po_headers_write_auth on public.po_headers;
create policy po_headers_write_auth
  on public.po_headers for all to authenticated
  using (public.po_builder_can_write())
  with check (public.po_builder_can_write());

drop policy if exists po_lines_select_auth on public.po_lines;
create policy po_lines_select_auth
  on public.po_lines for select to authenticated
  using (true);

drop policy if exists po_lines_write_auth on public.po_lines;
create policy po_lines_write_auth
  on public.po_lines for all to authenticated
  using (public.po_builder_can_write())
  with check (public.po_builder_can_write());

grant select on public.v_po_header_summary to authenticated;
grant select on public.v_po_incoming_summary to authenticated;
grant select on public.v_po_incoming_lines to authenticated;
grant select on public.v_po_open_planning_lines to authenticated;

-- >>> SECTION 2: PO COSTING
-- =============================================================================
-- SILO PO Costing module
-- Run in Supabase SQL Editor (or via CLI) before using /v2/po-costing.html DB mode.
--
-- Workflow:
--   1. PO created in PO builder (po_headers + po_lines)
--   2. FOB stage: prior SKU costs and/or factory invoice → po_costing (phase=fob)
--   3. Mark shipped → shipped_at set, phase=freight
--   4. Freight stage: split freight/duty/misc to lines → landed_unit persisted
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.po_costing (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references public.po_headers(id) on delete cascade,

  phase text not null default 'fob'
    check (phase in ('fob', 'freight', 'final')),

  cost_source text
    check (cost_source is null or cost_source in ('prior_sku', 'factory_invoice', 'manual', 'mixed')),

  -- Factory invoice (FOB stage)
  factory_invoice_ref text,
  factory_invoice_date date,
  factory_invoice_amount numeric(14, 2),
  fob_notes text,
  fob_locked_at timestamptz,

  -- Freight (after ship)
  freight_amount numeric(14, 2) not null default 0,
  duty_pct numeric(8, 4) not null default 0,
  misc_amount numeric(14, 2) not null default 0,
  alloc_method text not null default 'proportional'
    check (alloc_method in ('proportional', 'per_unit')),
  freight_invoice_ref text,
  freight_notes text,

  shipped_at timestamptz,
  freight_applied_at timestamptz,

  fob_total numeric(14, 2),
  duty_amount numeric(14, 2),
  landed_total numeric(14, 2),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),

  constraint po_costing_po_header_id_key unique (po_header_id)
);

create index if not exists po_costing_po_header_id_idx on public.po_costing (po_header_id);
create index if not exists po_costing_phase_idx on public.po_costing (phase);

create table if not exists public.po_costing_lines (
  id uuid primary key default gen_random_uuid(),
  po_costing_id uuid not null references public.po_costing(id) on delete cascade,
  po_line_id uuid not null references public.po_lines(id) on delete cascade,

  fob_unit numeric(12, 4),
  cost_source text
    check (cost_source is null or cost_source in ('prior_sku', 'factory_invoice', 'manual', 'po_line')),

  prior_po_header_id uuid references public.po_headers(id) on delete set null,
  prior_unit_cost numeric(12, 4),
  prior_landed_unit numeric(12, 4),

  freight_alloc numeric(12, 2),
  duty_alloc numeric(12, 2),
  misc_alloc numeric(12, 2),
  landed_unit numeric(12, 4),
  landed_ext numeric(14, 2),

  line_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint po_costing_lines_costing_line_key unique (po_costing_id, po_line_id),
  constraint po_costing_lines_po_line_id_key unique (po_line_id)
);

create index if not exists po_costing_lines_costing_id_idx on public.po_costing_lines (po_costing_id);
create index if not exists po_costing_lines_po_line_id_idx on public.po_costing_lines (po_line_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists po_costing_set_updated_at on public.po_costing;
create trigger po_costing_set_updated_at
  before update on public.po_costing
  for each row execute function public.set_updated_at();

drop trigger if exists po_costing_lines_set_updated_at on public.po_costing_lines;
create trigger po_costing_lines_set_updated_at
  before update on public.po_costing_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Reporting view (safe to query from PO costing + report pages)
-- ---------------------------------------------------------------------------

create or replace view public.v_po_costing_summary as
select
  ph.id as po_header_id,
  ph.po_name,
  ph.status as po_status,
  ph.order_date,
  ph.req_ship_date,
  pc.id as po_costing_id,
  pc.phase,
  pc.cost_source,
  pc.factory_invoice_ref,
  pc.factory_invoice_date,
  pc.factory_invoice_amount,
  pc.freight_amount,
  pc.duty_pct,
  pc.misc_amount,
  pc.alloc_method,
  pc.freight_invoice_ref,
  pc.shipped_at,
  pc.freight_applied_at,
  pc.fob_total,
  pc.duty_amount,
  pc.landed_total,
  pc.fob_locked_at,
  pc.updated_at as costing_updated_at,
  coalesce(sum(pcl.landed_ext), 0) as line_landed_sum,
  count(pcl.id) as costing_line_count
from public.po_headers ph
left join public.po_costing pc on pc.po_header_id = ph.id
left join public.po_costing_lines pcl on pcl.po_costing_id = pc.id
group by
  ph.id, ph.po_name, ph.status, ph.order_date, ph.req_ship_date,
  pc.id, pc.phase, pc.cost_source, pc.factory_invoice_ref, pc.factory_invoice_date,
  pc.factory_invoice_amount, pc.freight_amount, pc.duty_pct, pc.misc_amount,
  pc.alloc_method, pc.freight_invoice_ref, pc.shipped_at, pc.freight_applied_at,
  pc.fob_total, pc.duty_amount, pc.landed_total, pc.fob_locked_at, pc.updated_at;

-- Prior SKU / landed lookup (latest line per SKU across other POs)
create or replace view public.v_po_sku_prior_cost as
select distinct on (pl.sku_snapshot)
  pl.sku_snapshot,
  pl.unit_cost as fob_unit_cost,
  pcl.landed_unit as prior_landed_unit,
  pcl.fob_unit as prior_costing_fob,
  pl.po_header_id,
  ph.po_name,
  ph.order_date,
  pc.phase as costing_phase,
  pl.created_at as line_created_at
from public.po_lines pl
join public.po_headers ph on ph.id = pl.po_header_id
left join public.po_costing pc on pc.po_header_id = ph.id
left join public.po_costing_lines pcl on pcl.po_line_id = pl.id
where pl.sku_snapshot is not null
  and btrim(pl.sku_snapshot) <> ''
order by pl.sku_snapshot, pl.created_at desc;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.po_costing enable row level security;
alter table public.po_costing_lines enable row level security;

-- Helper: active users with purchasing/finance access
create or replace function public.po_costing_can_write()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(coalesce(role::text, 'user')) in (
        'owner', 'admin'
      )
  );
$$;

drop policy if exists po_costing_select_auth on public.po_costing;
create policy po_costing_select_auth
  on public.po_costing for select to authenticated
  using (true);

drop policy if exists po_costing_write_auth on public.po_costing;
create policy po_costing_write_auth
  on public.po_costing for all to authenticated
  using (public.po_costing_can_write())
  with check (public.po_costing_can_write());

drop policy if exists po_costing_lines_select_auth on public.po_costing_lines;
create policy po_costing_lines_select_auth
  on public.po_costing_lines for select to authenticated
  using (true);

drop policy if exists po_costing_lines_write_auth on public.po_costing_lines;
create policy po_costing_lines_write_auth
  on public.po_costing_lines for all to authenticated
  using (public.po_costing_can_write())
  with check (public.po_costing_can_write());

grant select on public.v_po_costing_summary to authenticated;
grant select on public.v_po_sku_prior_cost to authenticated;

-- ---------------------------------------------------------------------------
-- Optional: extend existing PO list view (run manually if you own the view)
-- ---------------------------------------------------------------------------
-- If you maintain v_po_header_summary, add landed columns, e.g.:
--
-- create or replace view public.v_po_header_summary as
--   select h.*, pc.phase as costing_phase, pc.landed_total, pc.shipped_at
--   from ... existing definition ...
--   left join public.po_costing pc on pc.po_header_id = h.id;

-- ---------------------------------------------------------------------------
-- Migrate legacy [SILO_COSTING] blocks from internal_notes (one-time)
-- ---------------------------------------------------------------------------
-- After deploy, run from SQL or call PoCostingLib.migrateLegacyNotes in app:
--
-- See comment in pages/po-costing-lib.js — migration reads JSON from internal_notes.

-- >>> SECTION 3: PROFILES
-- =============================================================================
-- Profiles: allow signed-in users to read and update their own row
-- Run after po_costing migration (or standalone).
-- =============================================================================

-- Users can read their own profile
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Users can update safe fields on their own profile
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Optional column if missing (safe no-op if exists)
alter table public.profiles
  add column if not exists default_page text;

comment on column public.profiles.default_page is 'Internal path for post-login redirect (e.g. /v2/cashflow.html)';
-- =============================================================================
-- Launch Workbench: allow authenticated CRUD (including DELETE) on child tables
-- Run in Supabase SQL Editor if product/initiative delete fails silently.
-- Safe to re-run (drops/recreates policies).
-- =============================================================================

do $policy$
declare
  t text;
begin
  foreach t in array array[
    'launch_calendar',
    'launch_product_readiness',
    'launch_channel_items',
    'launch_tasks',
    'launch_assets',
    'launch_comments',
    'launch_system_links'
  ]
  loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I_auth_all on public.%I', t, t);
      execute format(
        'create policy %I_auth_all on public.%I for all to authenticated using (true) with check (true)',
        t, t
      );
      raise notice 'Launch Workbench policy applied: %', t;
    else
      raise notice 'Skip (table missing): %', t;
    end if;
  end loop;
end
$policy$;

-- =============================================================================
-- Launch Workbench: storage bucket for launch hero images
-- Fixes: "Save failed: Bucket not found" when uploading in Edit Launch Container
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'launch-images',
  'launch-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects policies (upload path: launches/{launchId}-{timestamp}.ext)
drop policy if exists launch_images_public_read on storage.objects;
create policy launch_images_public_read
  on storage.objects for select
  using (bucket_id = 'launch-images');

drop policy if exists launch_images_auth_insert on storage.objects;
create policy launch_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'launch-images'
    and (storage.foldername(name))[1] = 'launches'
  );

drop policy if exists launch_images_auth_update on storage.objects;
create policy launch_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'launch-images')
  with check (bucket_id = 'launch-images');

drop policy if exists launch_images_auth_delete on storage.objects;
create policy launch_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'launch-images');

-- >>> SECTION 8: SAMPLE IMAGES BUCKET (migration 20260603170000)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sample-images',
  'sample-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists sample_images_public_read on storage.objects;
create policy sample_images_public_read
  on storage.objects for select
  using (bucket_id = 'sample-images');

drop policy if exists sample_images_auth_insert on storage.objects;
create policy sample_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sample-images'
    and (storage.foldername(name))[1] = 'samples'
  );

drop policy if exists sample_images_auth_update on storage.objects;
create policy sample_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'sample-images')
  with check (bucket_id = 'sample-images');

drop policy if exists sample_images_auth_delete on storage.objects;
create policy sample_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'sample-images');

-- >>> SECTION 9: PRODUCT SAMPLES sample_ref auto-generation (migration 20260603180000)
-- =============================================================================
create sequence if not exists public.product_samples_ref_seq start 1;

create or replace function public.generate_sample_ref()
returns trigger language plpgsql as $$
begin
  if new.sample_ref is null or new.sample_ref = '' then
    new.sample_ref := 'SMPL-' || to_char(now(), 'YYYY') || '-' ||
                      lpad(nextval('public.product_samples_ref_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists product_samples_set_ref on public.product_samples;
create trigger product_samples_set_ref
  before insert on public.product_samples
  for each row execute function public.generate_sample_ref();

-- >>> SECTION 10: PRODUCT SAMPLES date stamps + product link (migration 20260603190000)
-- =============================================================================
alter table public.product_samples
  add column if not exists received_at            date,
  add column if not exists sent_at                date,
  add column if not exists warehouse_ready_at     date,
  add column if not exists picked_up_at           date,
  add column if not exists photo_received_at      date,
  add column if not exists product_title_snapshot text;

-- >>> SECTION 12: PRODUCT TRACKER (migration 20260604000000)
-- =============================================================================
create table if not exists public.product_tracker (
  id                    uuid primary key default gen_random_uuid(),
  product_title         text not null,
  manufacturer          text,
  factory_id            uuid references public.factories(id) on delete set null,
  product_type          text,
  collection            text,
  launch_id             uuid references public.launch_calendar(id) on delete set null,
  product_master_id     uuid references public.products_master(id) on delete set null,
  product_title_snapshot text,
  bulk_eta              date,
  on_hand               text,
  size_requests         text,
  sizes_ready_warehouse text,
  sizes_picked_up       text,
  photo_complete        text not null default 'pending',
  copy_complete         boolean not null default false,
  is_live               boolean not null default false,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists product_tracker_launch_idx on public.product_tracker (launch_id);
create index if not exists product_tracker_master_idx on public.product_tracker (product_master_id);

alter table public.product_tracker enable row level security;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists product_tracker_updated_at on public.product_tracker;
create trigger product_tracker_updated_at
  before update on public.product_tracker
  for each row execute function public.set_updated_at();

drop policy if exists "product_tracker_select" on public.product_tracker;
create policy "product_tracker_select" on public.product_tracker
  for select to authenticated using (true);

drop policy if exists "product_tracker_insert" on public.product_tracker;
create policy "product_tracker_insert" on public.product_tracker
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role::text in ('owner','admin'))
  );

drop policy if exists "product_tracker_update" on public.product_tracker;
create policy "product_tracker_update" on public.product_tracker
  for update to authenticated
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role::text in ('owner','admin'))
  );

drop policy if exists "product_tracker_delete" on public.product_tracker;
create policy "product_tracker_delete" on public.product_tracker
  for delete to authenticated
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role::text in ('owner','admin'))
  );

-- >>> SECTION 11: LAUNCH TASK ASSIGNEE (migration 20260603140000)
-- =============================================================================
alter table public.launch_tasks
  add column if not exists assigned_to_user_id uuid references auth.users(id) on delete set null,
  add column if not exists assigned_to_name text;

-- >>> SECTION 12: PAYMENT REQUESTS LEGACY IMPORT (migration 20260609000000)
-- =============================================================================
alter table public.payment_requests
  add column if not exists legacy_source text,
  add column if not exists legacy_url text,
  add column if not exists legacy_external_id text,
  add column if not exists imported_at timestamptz;

create unique index if not exists payment_requests_legacy_dedupe_uidx
  on public.payment_requests (legacy_source, legacy_external_id)
  where legacy_source is not null
    and legacy_external_id is not null
    and btrim(legacy_external_id) <> '';

-- >>> SECTION 13: INSERT COMPANY STAMP (migration 20260616060000)
-- =============================================================================
create or replace function public.stamp_company_entity_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.company_entity_id is null then
    new.company_entity_id := public.active_company_id();
  end if;
  return new;
end;
$$;

create or replace function public.attach_stamp_company_entity_id_triggers()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'company_entity_id'
      and t.table_type = 'BASE TABLE'
      and c.table_name not in ('inventory_on_hand', 'sales_by_day')
  loop
    execute format('drop trigger if exists stamp_company_entity_id on public.%I', r.table_name);
    execute format(
      'create trigger stamp_company_entity_id
         before insert on public.%I
         for each row
         execute function public.stamp_company_entity_id()',
      r.table_name
    );
  end loop;
end;
$$;

select public.attach_stamp_company_entity_id_triggers();


-- >>> SECTION 14: SHOPIFY INTEGRATION
-- =============================================================================
-- Creates: shopify_connections, sync_jobs, locations.shopify_location_id
-- =============================================================================

create table if not exists public.shopify_connections (
  id                    uuid primary key default gen_random_uuid(),
  company_entity_id     uuid not null references public.entities(id) on delete cascade,
  shop_domain           text not null,
  display_name          text,
  location_tag_prefix   text,
  credential_ref        text,
  access_token          text,
  api_version           text not null default '2025-01',
  sync_enabled          boolean not null default false,
  history_days_default  integer not null default 90,
  meta                  jsonb not null default '{}',
  is_active             boolean not null default true,
  location_id           bigint,
  last_tested_at        timestamptz,
  last_test_success     boolean,
  last_test_status      text check (last_test_status in ('ok', 'error')),
  last_test_error       text,
  shop_name             text,
  shop_currency         text,
  scopes_granted        jsonb not null default '[]',
  scopes_missing        jsonb not null default '[]',
  scopes_checked_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references auth.users(id),
  updated_by            uuid references auth.users(id),
  unique (company_entity_id, shop_domain)
);

alter table public.shopify_connections enable row level security;

drop policy if exists "shopify_connections_select" on public.shopify_connections;
drop policy if exists "shopify_connections_write"  on public.shopify_connections;

create policy "shopify_connections_select" on public.shopify_connections
  for select using (company_entity_id = active_company_id());

create policy "shopify_connections_write" on public.shopify_connections
  for all using    (company_entity_id = active_company_id() and is_admin_user())
  with check       (company_entity_id = active_company_id() and is_admin_user());

create or replace function public.set_shopify_connections_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_shopify_connections_updated_at on public.shopify_connections;
create trigger trg_shopify_connections_updated_at
  before update on public.shopify_connections
  for each row execute function public.set_shopify_connections_updated_at();

create table if not exists public.sync_jobs (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  connection_id       uuid references public.shopify_connections(id) on delete set null,
  job_type            text not null,
  status              text not null default 'pending'
                        check (status in ('pending', 'running', 'success', 'error')),
  started_at          timestamptz,
  finished_at         timestamptz,
  result              jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id)
);

alter table public.sync_jobs enable row level security;

drop policy if exists "sync_jobs_select" on public.sync_jobs;
drop policy if exists "sync_jobs_write"  on public.sync_jobs;

create policy "sync_jobs_select" on public.sync_jobs
  for select using (company_entity_id = active_company_id());

create policy "sync_jobs_write" on public.sync_jobs
  for all using    (company_entity_id = active_company_id() and is_admin_user())
  with check       (company_entity_id = active_company_id() and is_admin_user());

alter table public.locations
  add column if not exists shopify_location_id text;

-- >>> SECTION 15: SHOPIFY SCHEMA ALIGN (migration 20260623110000)
-- =============================================================================
alter table public.shopify_connections
  add column if not exists access_token        text,
  add column if not exists last_test_status    text,
  add column if not exists last_test_error     text,
  add column if not exists shop_name           text,
  add column if not exists shop_currency       text,
  add column if not exists is_active           boolean not null default true,
  add column if not exists updated_by          uuid references auth.users(id);

alter table public.shopify_connections
  drop constraint if exists shopify_connections_last_test_status_check;

alter table public.shopify_connections
  add constraint shopify_connections_last_test_status_check
  check (last_test_status is null or last_test_status in ('ok', 'error'));

alter table public.sync_jobs
  add column if not exists result jsonb,
  add column if not exists error  text;

alter table public.sync_jobs
  drop constraint if exists sync_jobs_status_check;

alter table public.sync_jobs
  add constraint sync_jobs_status_check
  check (status in (
    'pending', 'running', 'success', 'error',
    'completed', 'failed', 'cancelled'
  ));

notify pgrst, 'reload schema';

-- >>> SECTION 16: SHOPIFY SCOPES (migration 20260623120000)
-- =============================================================================
alter table public.shopify_connections
  add column if not exists scopes_granted    jsonb not null default '[]'::jsonb,
  add column if not exists scopes_missing    jsonb not null default '[]'::jsonb,
  add column if not exists scopes_checked_at timestamptz;

notify pgrst, 'reload schema';

-- >>> SECTION 17: SALES VERIFICATION COMPANY SCOPE (migration 20260624000000)
-- =============================================================================
-- See supabase/migrations/20260624000000_sales_verification_company_scope.sql

-- Sales verification + sales_by_day company isolation
--
-- 1. Backfill NULL company_entity_id on sales_by_day (Baseballism)
-- 2. Fix sales_verification_store_comp_summary PK for multi-tenant
-- 3. Rewrite refresh RPC to aggregate per company_entity_id
-- 4. RLS on sales_by_day via active_company_id()
-- ============================================================

-- Baseballism entity (Sheets / Better Reports sync)
DO $$
DECLARE
  v_baseballism uuid := '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
BEGIN
  UPDATE public.sales_by_day
  SET company_entity_id = v_baseballism
  WHERE company_entity_id IS NULL;
END;
$$;

-- Summary table: PK was location_tag only — not tenant-safe
TRUNCATE TABLE public.sales_verification_store_comp_summary;

ALTER TABLE public.sales_verification_store_comp_summary
  DROP CONSTRAINT IF EXISTS sales_verification_store_comp_summary_pkey;

DROP INDEX IF EXISTS public.sales_verification_store_comp_summary_pkey;

ALTER TABLE public.sales_verification_store_comp_summary
  ALTER COLUMN company_entity_id SET NOT NULL;

ALTER TABLE public.sales_verification_store_comp_summary
  ADD CONSTRAINT sales_verification_store_comp_summary_pkey
  PRIMARY KEY (company_entity_id, location_tag);

CREATE OR REPLACE FUNCTION public.refresh_sales_verification_store_comp_summary()
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  TRUNCATE TABLE public.sales_verification_store_comp_summary;

  INSERT INTO public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    refreshed_at
  )
  WITH max_day AS (
    SELECT
      company_entity_id,
      max(day_date)::date AS as_of_date
    FROM public.sales_by_day
    WHERE company_entity_id IS NOT NULL
    GROUP BY company_entity_id
  ),
  periods AS (
    SELECT
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date AS py_as_of_date,
      date_trunc('month', as_of_date)::date AS cur_mtd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        extract(month FROM as_of_date)::int,
        1
      )::date AS py_mtd_start,
      date_trunc('year', as_of_date)::date AS cur_ytd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date AS py_ytd_start
    FROM max_day
  ),
  base AS (
    SELECT
      s.company_entity_id,
      s.location_tag,
      s.day_date::date AS day_date,
      coalesce(s.total_quantity_sold, 0)::numeric AS qty,
      coalesce(s.total_net_sales, 0)::numeric AS net_sales,
      coalesce(s.total_refunds, 0)::numeric AS refunds,
      CASE
        WHEN coalesce(trim(s.sku), '') = '' THEN 1
        ELSE 0
      END AS blank_sku_row,
      CASE
        WHEN lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        THEN 1
        ELSE 0
      END AS refund_discrepancy_row
    FROM public.sales_by_day s
    WHERE s.company_entity_id IS NOT NULL
  ),
  location_dates AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) AS min_day_date,
      max(b.day_date) AS max_day_date,
      count(*) AS row_count,
      sum(b.blank_sku_row) AS blank_sku_rows,
      sum(b.refund_discrepancy_row) AS refund_discrepancy_rows
    FROM base b
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_day_qty,
      sum(b.net_sales) AS cur_day_net,
      sum(b.refunds) AS cur_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_day_qty,
      sum(b.net_sales) AS py_day_net,
      sum(b.refunds) AS py_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_mtd_qty,
      sum(b.net_sales) AS cur_mtd_net,
      sum(b.refunds) AS cur_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_mtd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_mtd_qty,
      sum(b.net_sales) AS py_mtd_net,
      sum(b.refunds) AS py_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_mtd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_ytd_qty,
      sum(b.net_sales) AS cur_ytd_net,
      sum(b.refunds) AS cur_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_ytd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_ytd_qty,
      sum(b.net_sales) AS py_ytd_net,
      sum(b.refunds) AS py_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_ytd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  )
  SELECT
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    CASE
      WHEN coalesce(dp.py_day_net, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    END,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    CASE
      WHEN coalesce(mp.py_mtd_net, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    END,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    CASE
      WHEN coalesce(yp.py_ytd_net, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    END,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    CASE
      WHEN coalesce(dp.py_day_qty, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    END,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    CASE
      WHEN coalesce(mp.py_mtd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    END,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    CASE
      WHEN coalesce(yp.py_ytd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    END,

    now()
  FROM location_dates ld
  JOIN periods p
    ON p.company_entity_id = ld.company_entity_id
  LEFT JOIN day_cur dc
    ON ld.company_entity_id = dc.company_entity_id
   AND ld.location_tag = dc.location_tag
  LEFT JOIN day_py dp
    ON ld.company_entity_id = dp.company_entity_id
   AND ld.location_tag = dp.location_tag
  LEFT JOIN mtd_cur mc
    ON ld.company_entity_id = mc.company_entity_id
   AND ld.location_tag = mc.location_tag
  LEFT JOIN mtd_py mp
    ON ld.company_entity_id = mp.company_entity_id
   AND ld.location_tag = mp.location_tag
  LEFT JOIN ytd_cur yc
    ON ld.company_entity_id = yc.company_entity_id
   AND ld.location_tag = yc.location_tag
  LEFT JOIN ytd_py yp
    ON ld.company_entity_id = yp.company_entity_id
   AND ld.location_tag = yp.location_tag
  ORDER BY ld.company_entity_id, ld.location_tag;
END;
$function$;

-- Repopulate summary with per-company rows
SELECT public.refresh_sales_verification_store_comp_summary();

-- sales_by_day: replace open read policies with active-company isolation
ALTER TABLE public.sales_by_day ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read sales_by_day" ON public.sales_by_day;
DROP POLICY IF EXISTS "sales_by_day_select_authenticated" ON public.sales_by_day;
DROP POLICY IF EXISTS "sales_by_day_admin_all" ON public.sales_by_day;

CREATE POLICY "sales_by_day_active_select" ON public.sales_by_day
  FOR SELECT USING (company_entity_id = active_company_id());

CREATE POLICY "sales_by_day_active_write" ON public.sales_by_day
  FOR ALL
  USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK (company_entity_id = active_company_id() AND is_admin_user());

notify pgrst, 'reload schema';

-- >>> SECTION 18: SALES VERIFICATION FILTERED SUMMARY RPC (migration 20260624100000)
-- =============================================================================
-- Replaces client-side 2k-row chunk scans that timeout on large histories.

CREATE INDEX IF NOT EXISTS sales_by_day_company_day_idx
  ON public.sales_by_day (company_entity_id, day_date);

CREATE OR REPLACE FUNCTION public.sales_verification_filtered_summary(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_location_tag text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_quick text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_search text;
  v_result jsonb;
BEGIN
  v_company := active_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object(
      'total_rows', 0,
      'total_units', 0,
      'total_net', 0,
      'total_refunds', 0,
      'min_date', NULL,
      'max_date', NULL,
      'refund_discrepancy_count', 0,
      'blank_sku_count', 0,
      'negative_net_count', 0,
      'batch_count', 0,
      'location_count', 0,
      'locations', '[]'::jsonb
    );
  END IF;

  v_search := NULLIF(trim(p_search), '');
  IF v_search IS NOT NULL THEN
    v_search := '%' || v_search || '%';
  END IF;

  WITH filtered AS (
    SELECT
      s.location_tag,
      s.day_date,
      s.product_name,
      s.sku,
      s.sync_batch_id,
      s.total_quantity_sold,
      s.total_gross_sales,
      s.total_discounts,
      s.total_refunds,
      s.total_net_sales,
      s.total_sales
    FROM public.sales_by_day s
    WHERE s.company_entity_id = v_company
      AND (p_location_tag IS NULL OR p_location_tag = '' OR s.location_tag = p_location_tag)
      AND (p_date_from IS NULL OR s.day_date >= p_date_from)
      AND (p_date_to IS NULL OR s.day_date <= p_date_to)
      AND (
        v_search IS NULL
        OR s.product_name ILIKE v_search
        OR s.sku ILIKE v_search
        OR s.vendor_original ILIKE v_search
        OR s.product_type ILIKE v_search
      )
      AND (
        coalesce(p_quick, 'all') = 'all'
        OR (
          p_quick = 'refund_discrepancy'
          AND (
            lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
            OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
          )
        )
        OR (p_quick = 'blank_sku' AND coalesce(trim(s.sku), '') = '')
        OR (p_quick = 'negative_net' AND coalesce(s.total_net_sales, 0) < 0)
      )
  ),
  totals AS (
    SELECT
      count(*)::bigint AS total_rows,
      coalesce(sum(total_quantity_sold), 0)::bigint AS total_units,
      coalesce(sum(total_net_sales), 0) AS total_net,
      coalesce(sum(total_refunds), 0) AS total_refunds,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      count(*) FILTER (
        WHERE lower(coalesce(product_name, '')) = '[refund discrepancy]'
           OR lower(coalesce(sku, '')) = '[refund discrepancy]'
      )::bigint AS refund_discrepancy_count,
      count(*) FILTER (WHERE coalesce(trim(sku), '') = '')::bigint AS blank_sku_count,
      count(*) FILTER (WHERE coalesce(total_net_sales, 0) < 0)::bigint AS negative_net_count,
      count(DISTINCT sync_batch_id) FILTER (WHERE sync_batch_id IS NOT NULL)::bigint AS batch_count
    FROM filtered
  ),
  by_location AS (
    SELECT
      coalesce(location_tag, 'unknown') AS location_tag,
      count(*)::bigint AS row_count,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      coalesce(sum(total_quantity_sold), 0)::bigint AS units,
      coalesce(sum(total_gross_sales), 0) AS gross,
      coalesce(sum(total_discounts), 0) AS discounts,
      coalesce(sum(total_refunds), 0) AS refunds,
      coalesce(sum(total_net_sales), 0) AS net,
      coalesce(sum(total_sales), 0) AS total_sales
    FROM filtered
    GROUP BY coalesce(location_tag, 'unknown')
    ORDER BY location_tag
  )
  SELECT jsonb_build_object(
    'total_rows', t.total_rows,
    'total_units', t.total_units,
    'total_net', t.total_net,
    'total_refunds', t.total_refunds,
    'min_date', t.min_date,
    'max_date', t.max_date,
    'refund_discrepancy_count', t.refund_discrepancy_count,
    'blank_sku_count', t.blank_sku_count,
    'negative_net_count', t.negative_net_count,
    'batch_count', t.batch_count,
    'location_count', (SELECT count(*)::bigint FROM by_location),
    'locations', coalesce((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.location_tag) FROM by_location bl), '[]'::jsonb)
  )
  INTO v_result
  FROM totals t;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sales_verification_filtered_summary(date, date, text, text, text)
  TO authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 19. next_location_id() — global id allocator for locations inserts
-- ---------------------------------------------------------------------------

create or replace function public.next_location_id()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin_user() then
    raise exception 'Admin access required';
  end if;

  return (select coalesce(max(id), 0) + 1 from public.locations);
end;
$$;

revoke all on function public.next_location_id() from public;
grant execute on function public.next_location_id() to authenticated;

comment on function public.next_location_id() is
  'Returns next global locations.id for admin inserts (bypasses per-company RLS visibility).';

notify pgrst, 'reload schema';

-- >>> SECTION 20: SHOPIFY SALES VERIFICATION DEDUPE (migration 20260629120000)
-- See supabase/migrations/20260629120000_shopify_sales_verification_dedupe.sql
-- Fixes double-counting during Shopify cutover and wires purge_better_reports_overlap.

-- View used by Sales Verification UI + summary RPCs (RLS propagates via security_invoker).
CREATE OR REPLACE VIEW public.sales_by_day_verification_v
WITH (security_invoker = true) AS
SELECT s.*
FROM public.sales_by_day s
WHERE NOT (
  s.source = 'better_reports'
  AND EXISTS (
    SELECT 1
    FROM public.sales_by_day api
    WHERE api.company_entity_id = s.company_entity_id
      AND api.location_tag = s.location_tag
      AND api.day_date = s.day_date
      AND api.source = 'shopify_api'
  )
);

GRANT SELECT ON public.sales_by_day_verification_v TO authenticated;

-- Purge RPC (idempotent re-create for apply_all / fresh installs)
CREATE OR REPLACE FUNCTION public.purge_better_reports_overlap(
  p_company_entity_id uuid DEFAULT '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
RETURNS TABLE(deleted_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.sales_by_day br
  USING public.sales_by_day api
  WHERE br.source = 'better_reports'
    AND api.source = 'shopify_api'
    AND br.location_tag = api.location_tag
    AND br.day_date = api.day_date
    AND br.company_entity_id = p_company_entity_id
    AND api.company_entity_id = p_company_entity_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_better_reports_overlap(uuid) TO service_role;

-- Filtered summary: read deduped rows + coalesce total_sales columns
CREATE OR REPLACE FUNCTION public.sales_verification_filtered_summary(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_location_tag text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_quick text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_search text;
  v_result jsonb;
BEGIN
  v_company := active_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object(
      'total_rows', 0,
      'total_units', 0,
      'total_net', 0,
      'total_refunds', 0,
      'min_date', NULL,
      'max_date', NULL,
      'refund_discrepancy_count', 0,
      'blank_sku_count', 0,
      'negative_net_count', 0,
      'batch_count', 0,
      'location_count', 0,
      'locations', '[]'::jsonb
    );
  END IF;

  v_search := NULLIF(trim(p_search), '');
  IF v_search IS NOT NULL THEN
    v_search := '%' || v_search || '%';
  END IF;

  WITH filtered AS (
    SELECT
      s.location_tag,
      s.day_date,
      s.product_name,
      s.sku,
      s.sync_batch_id,
      s.total_quantity_sold,
      s.total_gross_sales,
      s.total_discounts,
      s.total_refunds,
      s.total_net_sales,
      coalesce(s.sum_total_sales, s.total_sales) AS total_sales
    FROM public.sales_by_day_verification_v s
    WHERE s.company_entity_id = v_company
      AND (p_location_tag IS NULL OR p_location_tag = '' OR s.location_tag = p_location_tag)
      AND (p_date_from IS NULL OR s.day_date >= p_date_from)
      AND (p_date_to IS NULL OR s.day_date <= p_date_to)
      AND (
        v_search IS NULL
        OR s.product_name ILIKE v_search
        OR s.sku ILIKE v_search
        OR s.vendor_original ILIKE v_search
        OR s.product_type ILIKE v_search
      )
      AND (
        coalesce(p_quick, 'all') = 'all'
        OR (
          p_quick = 'refund_discrepancy'
          AND (
            lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
            OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
          )
        )
        OR (p_quick = 'blank_sku' AND coalesce(trim(s.sku), '') = '')
        OR (p_quick = 'negative_net' AND coalesce(s.total_net_sales, 0) < 0)
      )
  ),
  totals AS (
    SELECT
      count(*)::bigint AS total_rows,
      coalesce(sum(total_quantity_sold), 0)::bigint AS total_units,
      coalesce(sum(total_net_sales), 0) AS total_net,
      coalesce(sum(total_refunds), 0) AS total_refunds,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      count(*) FILTER (
        WHERE lower(coalesce(product_name, '')) = '[refund discrepancy]'
           OR lower(coalesce(sku, '')) = '[refund discrepancy]'
      )::bigint AS refund_discrepancy_count,
      count(*) FILTER (WHERE coalesce(trim(sku), '') = '')::bigint AS blank_sku_count,
      count(*) FILTER (WHERE coalesce(total_net_sales, 0) < 0)::bigint AS negative_net_count,
      count(DISTINCT sync_batch_id) FILTER (WHERE sync_batch_id IS NOT NULL)::bigint AS batch_count
    FROM filtered
  ),
  by_location AS (
    SELECT
      coalesce(location_tag, 'unknown') AS location_tag,
      count(*)::bigint AS row_count,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      coalesce(sum(total_quantity_sold), 0)::bigint AS units,
      coalesce(sum(total_gross_sales), 0) AS gross,
      coalesce(sum(total_discounts), 0) AS discounts,
      coalesce(sum(total_refunds), 0) AS refunds,
      coalesce(sum(total_net_sales), 0) AS net,
      coalesce(sum(total_sales), 0) AS total_sales
    FROM filtered
    GROUP BY coalesce(location_tag, 'unknown')
    ORDER BY location_tag
  )
  SELECT jsonb_build_object(
    'total_rows', t.total_rows,
    'total_units', t.total_units,
    'total_net', t.total_net,
    'total_refunds', t.total_refunds,
    'min_date', t.min_date,
    'max_date', t.max_date,
    'refund_discrepancy_count', t.refund_discrepancy_count,
    'blank_sku_count', t.blank_sku_count,
    'negative_net_count', t.negative_net_count,
    'batch_count', t.batch_count,
    'location_count', (SELECT count(*)::bigint FROM by_location),
    'locations', coalesce((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.location_tag) FROM by_location bl), '[]'::jsonb)
  )
  INTO v_result
  FROM totals t;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sales_verification_filtered_summary(date, date, text, text, text)
  TO authenticated;

-- Store comp summary refresh: aggregate deduped rows only
CREATE OR REPLACE FUNCTION public.refresh_sales_verification_store_comp_summary()
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  TRUNCATE TABLE public.sales_verification_store_comp_summary;

  INSERT INTO public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    refreshed_at
  )
  WITH max_day AS (
    SELECT
      company_entity_id,
      max(day_date)::date AS as_of_date
    FROM public.sales_by_day_verification_v
    WHERE company_entity_id IS NOT NULL
    GROUP BY company_entity_id
  ),
  periods AS (
    SELECT
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date AS py_as_of_date,
      date_trunc('month', as_of_date)::date AS cur_mtd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        extract(month FROM as_of_date)::int,
        1
      )::date AS py_mtd_start,
      date_trunc('year', as_of_date)::date AS cur_ytd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date AS py_ytd_start
    FROM max_day
  ),
  base AS (
    SELECT
      s.company_entity_id,
      s.location_tag,
      s.day_date::date AS day_date,
      coalesce(s.total_quantity_sold, 0)::numeric AS qty,
      coalesce(s.total_net_sales, 0)::numeric AS net_sales,
      coalesce(s.total_refunds, 0)::numeric AS refunds,
      CASE
        WHEN coalesce(trim(s.sku), '') = '' THEN 1
        ELSE 0
      END AS blank_sku_row,
      CASE
        WHEN lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        THEN 1
        ELSE 0
      END AS refund_discrepancy_row
    FROM public.sales_by_day_verification_v s
    WHERE s.company_entity_id IS NOT NULL
  ),
  location_dates AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) AS min_day_date,
      max(b.day_date) AS max_day_date,
      count(*) AS row_count,
      sum(b.blank_sku_row) AS blank_sku_rows,
      sum(b.refund_discrepancy_row) AS refund_discrepancy_rows
    FROM base b
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_day_qty,
      sum(b.net_sales) AS cur_day_net,
      sum(b.refunds) AS cur_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_day_qty,
      sum(b.net_sales) AS py_day_net,
      sum(b.refunds) AS py_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_mtd_qty,
      sum(b.net_sales) AS cur_mtd_net,
      sum(b.refunds) AS cur_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_mtd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_mtd_qty,
      sum(b.net_sales) AS py_mtd_net,
      sum(b.refunds) AS py_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_mtd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_ytd_qty,
      sum(b.net_sales) AS cur_ytd_net,
      sum(b.refunds) AS cur_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_ytd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_ytd_qty,
      sum(b.net_sales) AS py_ytd_net,
      sum(b.refunds) AS py_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_ytd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  )
  SELECT
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    CASE
      WHEN coalesce(dp.py_day_net, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    END,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    CASE
      WHEN coalesce(mp.py_mtd_net, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    END,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    CASE
      WHEN coalesce(yp.py_ytd_net, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    END,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    CASE
      WHEN coalesce(dp.py_day_qty, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    END,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    CASE
      WHEN coalesce(mp.py_mtd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    END,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    CASE
      WHEN coalesce(yp.py_ytd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    END,

    now()
  FROM location_dates ld
  JOIN periods p
    ON p.company_entity_id = ld.company_entity_id
  LEFT JOIN day_cur dc
    ON ld.company_entity_id = dc.company_entity_id
   AND ld.location_tag = dc.location_tag
  LEFT JOIN day_py dp
    ON ld.company_entity_id = dp.company_entity_id
   AND ld.location_tag = dp.location_tag
  LEFT JOIN mtd_cur mc
    ON ld.company_entity_id = mc.company_entity_id
   AND ld.location_tag = mc.location_tag
  LEFT JOIN mtd_py mp
    ON ld.company_entity_id = mp.company_entity_id
   AND ld.location_tag = mp.location_tag
  LEFT JOIN ytd_cur yc
    ON ld.company_entity_id = yc.company_entity_id
   AND ld.location_tag = yc.location_tag
  LEFT JOIN ytd_py yp
    ON ld.company_entity_id = yp.company_entity_id
   AND ld.location_tag = yp.location_tag
  ORDER BY ld.company_entity_id, ld.location_tag;
END;
$function$;

SELECT public.refresh_sales_verification_store_comp_summary();

-- 20260630120000_locations_company_scoped_unique.sql
ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_location_code_key;
ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_location_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS locations_company_location_code_key
  ON public.locations (company_entity_id, location_code);

CREATE UNIQUE INDEX IF NOT EXISTS locations_company_location_name_key
  ON public.locations (company_entity_id, location_name);

-- 20260702170000_shopify_sync_variance_fixes.sql
-- Shopify sync variance fixes (BR vs shopify_api reconciliation).
--
-- 1. row_hash for shopify_api rows now includes shop_domain, matching the
--    updated sync code — without it, two shops feeding the same SILO
--    location_tag (e.g. main-store "Baseballism Atlanta" + the Atlanta shop)
--    overwrite each other's (day, location, sku) aggregates on upsert.
-- 2. purge_better_reports_overlap rewritten as an indexed semi-join. The old
--    DELETE ... USING self-join fanned out on a ~1M-row table and timed out,
--    which is why better_reports and shopify_api rows currently coexist for
--    recent days (double-counted by pages that don't filter on source).
-- 3. default_location_code for the main + wholesale shops, so orders with no
--    location on them yet (unfulfilled online/wholesale orders) are attributed
--    instead of dropped.
-- 4. Deactivate duplicate active connections per shop_domain (chicago + dsg
--    each had two); a history backfill purges by shop_domain, so duplicate
--    connections stomp each other's imported ranges.
--
-- Note: the row_hash recompute updates every shopify_api row; if the SQL
-- editor times out, run this file via psql or re-run — it is idempotent.

-- ── 1. row_hash includes shop_domain ────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

set statement_timeout = '600s';

do $$
begin
  perform set_config('search_path', 'public, extensions', true);

  -- Mirrors hashRow() in scripts/lib/shopify-sync-core.mjs:
  -- [company, location_tag, day, sku, product_name, shop_domain, source] joined by '|'
  update public.sales_by_day
     set row_hash = encode(digest(
           company_entity_id::text        || '|' ||
           location_tag                   || '|' ||
           to_char(day_date, 'YYYY-MM-DD') || '|' ||
           coalesce(sku, '')              || '|' ||
           coalesce(product_name, '')     || '|' ||
           coalesce(shop_domain, '')      || '|' ||
           source, 'sha256'), 'hex')
   where source = 'shopify_api';
end $$;

-- ── 2. fast overlap purge + supporting indexes ──────────────────────────────

create index if not exists sales_by_day_shopify_api_loc_day_idx
  on public.sales_by_day (company_entity_id, location_tag, day_date)
  where source = 'shopify_api';

-- speeds the per-shop day-rebuild delete in runIncrementalSales
create index if not exists sales_by_day_shop_domain_day_idx
  on public.sales_by_day (shop_domain, day_date)
  where source = 'shopify_api';

create or replace function public.purge_better_reports_overlap(
  p_company_entity_id uuid default '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
returns table(deleted_rows bigint)
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_deleted bigint;
begin
  delete from public.sales_by_day br
  where br.source = 'better_reports'
    and br.company_entity_id = p_company_entity_id
    and exists (
      select 1
      from public.sales_by_day api
      where api.source            = 'shopify_api'
        and api.company_entity_id = br.company_entity_id
        and api.location_tag      = br.location_tag
        and api.day_date          = br.day_date
    );

  get diagnostics v_deleted = row_count;
  return query select v_deleted;
end;
$$;

grant execute on function public.purge_better_reports_overlap(uuid) to service_role;

-- ── 3. default location for order rows with no resolvable location ──────────

update public.shopify_connections
   set default_location_code = 'online'
 where shop_domain = 'baseballism.myshopify.com'
   and coalesce(default_location_code, '') = '';

update public.shopify_connections
   set default_location_code = 'wholesale'
 where shop_domain = 'baseballismwholesale.myshopify.com'
   and coalesce(default_location_code, '') = '';

-- ── 4. deactivate duplicate connections per shop ────────────────────────────

with ranked as (
  select id,
         row_number() over (
           partition by company_entity_id, shop_domain
           order by (meta -> 'history_backfill' ->> 'range_end') desc nulls last,
                    created_at desc,
                    id desc
         ) as rn
  from public.shopify_connections
  where is_active
)
update public.shopify_connections c
   set is_active    = false,
       sync_enabled = false,
       updated_at   = now()
  from ranked r
 where c.id = r.id
   and r.rn > 1;

-- 20260706220000_store_comp_summary_total_sales.sql
-- Adds tax/shipping/duties/fees-inclusive Total Sales tracking to
-- sales_verification_store_comp_summary, alongside the existing tax-exclusive
-- Net Sales columns.
--
-- Discovered while reconciling the new Sales Performance Overview page
-- against the legacy Power BI dashboard: PBI's Day/MTD/YTD figures are
-- total_sales (net + taxes + shipping + duties + fees), not total_net_sales.
-- Five of six spot-checked stores matched PBI to the dollar once compared
-- against total_sales instead of net_sales — the "variance" was a column
-- mismatch, not a data discrepancy. sales_verification_store_comp_summary
-- only tracked net_sales, so there was no tax-inclusive figure to show.

alter table public.sales_verification_store_comp_summary
  add column if not exists cur_day_total numeric,
  add column if not exists py_day_total numeric,
  add column if not exists cur_mtd_total numeric,
  add column if not exists py_mtd_total numeric,
  add column if not exists cur_ytd_total numeric,
  add column if not exists py_ytd_total numeric,
  add column if not exists day_total_var numeric,
  add column if not exists day_total_var_pct numeric,
  add column if not exists mtd_total_var numeric,
  add column if not exists mtd_total_var_pct numeric,
  add column if not exists ytd_total_var numeric,
  add column if not exists ytd_total_var_pct numeric;

create or replace function public.refresh_sales_verification_store_comp_summary()
returns void
language plpgsql
as $function$
begin
  truncate table public.sales_verification_store_comp_summary;

  insert into public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    cur_day_total,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    py_day_total,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    cur_mtd_total,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    py_mtd_total,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    cur_ytd_total,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    py_ytd_total,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    day_total_var,
    day_total_var_pct,
    mtd_total_var,
    mtd_total_var_pct,
    ytd_total_var,
    ytd_total_var_pct,
    refreshed_at
  )
  with max_day as (
    select
      company_entity_id,
      max(day_date)::date as as_of_date
    from public.sales_by_day_verification_v
    where company_entity_id is not null
    group by company_entity_id
  ),
  periods as (
    select
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        extract(month from as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', as_of_date)::date as cur_ytd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date as py_ytd_start
    from max_day
  ),
  base as (
    select
      s.company_entity_id,
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_refunds, 0)::numeric as refunds,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      case
        when coalesce(trim(s.sku), '') = '' then 1
        else 0
      end as blank_sku_row,
      case
        when lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        then 1
        else 0
      end as refund_discrepancy_row
    from public.sales_by_day_verification_v s
    where s.company_entity_id is not null
  ),
  location_dates as (
    select
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) as min_day_date,
      max(b.day_date) as max_day_date,
      count(*) as row_count,
      sum(b.blank_sku_row) as blank_sku_rows,
      sum(b.refund_discrepancy_row) as refund_discrepancy_rows
    from base b
    group by b.company_entity_id, b.location_tag
  ),
  day_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_day_qty,
      sum(b.net_sales) as cur_day_net,
      sum(b.refunds) as cur_day_refunds,
      sum(b.total_sales) as cur_day_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  day_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_day_qty,
      sum(b.net_sales) as py_day_net,
      sum(b.refunds) as py_day_refunds,
      sum(b.total_sales) as py_day_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_mtd_qty,
      sum(b.net_sales) as cur_mtd_net,
      sum(b.refunds) as cur_mtd_refunds,
      sum(b.total_sales) as cur_mtd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_mtd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_mtd_qty,
      sum(b.net_sales) as py_mtd_net,
      sum(b.refunds) as py_mtd_refunds,
      sum(b.total_sales) as py_mtd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_mtd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_ytd_qty,
      sum(b.net_sales) as cur_ytd_net,
      sum(b.refunds) as cur_ytd_refunds,
      sum(b.total_sales) as cur_ytd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_ytd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_ytd_qty,
      sum(b.net_sales) as py_ytd_net,
      sum(b.refunds) as py_ytd_refunds,
      sum(b.total_sales) as py_ytd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_ytd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  )
  select
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dc.cur_day_total, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),
    coalesce(dp.py_day_total, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mc.cur_mtd_total, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),
    coalesce(mp.py_mtd_total, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yc.cur_ytd_total, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),
    coalesce(yp.py_ytd_total, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    case
      when coalesce(dp.py_day_net, 0) = 0 then null
      else (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    end,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    case
      when coalesce(mp.py_mtd_net, 0) = 0 then null
      else (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    end,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    case
      when coalesce(yp.py_ytd_net, 0) = 0 then null
      else (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    end,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    case
      when coalesce(dp.py_day_qty, 0) = 0 then null
      else (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    end,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    case
      when coalesce(mp.py_mtd_qty, 0) = 0 then null
      else (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    end,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    case
      when coalesce(yp.py_ytd_qty, 0) = 0 then null
      else (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    end,

    coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0),
    case
      when coalesce(dp.py_day_total, 0) = 0 then null
      else (coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0)) / nullif(dp.py_day_total, 0)
    end,

    coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0),
    case
      when coalesce(mp.py_mtd_total, 0) = 0 then null
      else (coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0)) / nullif(mp.py_mtd_total, 0)
    end,

    coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0),
    case
      when coalesce(yp.py_ytd_total, 0) = 0 then null
      else (coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0)) / nullif(yp.py_ytd_total, 0)
    end,

    now()
  from location_dates ld
  join periods p
    on p.company_entity_id = ld.company_entity_id
  left join day_cur dc
    on ld.company_entity_id = dc.company_entity_id
   and ld.location_tag = dc.location_tag
  left join day_py dp
    on ld.company_entity_id = dp.company_entity_id
   and ld.location_tag = dp.location_tag
  left join mtd_cur mc
    on ld.company_entity_id = mc.company_entity_id
   and ld.location_tag = mc.location_tag
  left join mtd_py mp
    on ld.company_entity_id = mp.company_entity_id
   and ld.location_tag = mp.location_tag
  left join ytd_cur yc
    on ld.company_entity_id = yc.company_entity_id
   and ld.location_tag = yc.location_tag
  left join ytd_py yp
    on ld.company_entity_id = yp.company_entity_id
   and ld.location_tag = yp.location_tag
  order by ld.company_entity_id, ld.location_tag;
end;
$function$;

select public.refresh_sales_verification_store_comp_summary();

-- 20260706230000_fix_store_comp_summary_refresh_timeout.sql
-- refresh_sales_verification_store_comp_summary() truncates and fully
-- recomputes over sales_by_day_verification_v (1.1M+ rows and growing) with
-- no statement_timeout override, so it inherits whatever the calling role's
-- default is when invoked via PostgREST (both nightly sync scripts call it
-- as `service_role` through supabase.rpc(...)). Measured runtime is already
-- ~15s and rising as more history accumulates; both scripts log-and-continue
-- on failure rather than crashing, so a timeout here fails silently — the
-- user had to run it manually to see current data. Same fix already applied
-- to purge_better_reports_overlap in 20260702170000_shopify_sync_variance_fixes.sql.

create or replace function public.refresh_sales_verification_store_comp_summary()
returns void
language plpgsql
set statement_timeout = '120s'
as $function$
begin
  truncate table public.sales_verification_store_comp_summary;

  insert into public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    cur_day_total,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    py_day_total,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    cur_mtd_total,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    py_mtd_total,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    cur_ytd_total,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    py_ytd_total,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    day_total_var,
    day_total_var_pct,
    mtd_total_var,
    mtd_total_var_pct,
    ytd_total_var,
    ytd_total_var_pct,
    refreshed_at
  )
  with max_day as (
    select
      company_entity_id,
      max(day_date)::date as as_of_date
    from public.sales_by_day_verification_v
    where company_entity_id is not null
    group by company_entity_id
  ),
  periods as (
    select
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        extract(month from as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', as_of_date)::date as cur_ytd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date as py_ytd_start
    from max_day
  ),
  base as (
    select
      s.company_entity_id,
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_refunds, 0)::numeric as refunds,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      case
        when coalesce(trim(s.sku), '') = '' then 1
        else 0
      end as blank_sku_row,
      case
        when lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        then 1
        else 0
      end as refund_discrepancy_row
    from public.sales_by_day_verification_v s
    where s.company_entity_id is not null
  ),
  location_dates as (
    select
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) as min_day_date,
      max(b.day_date) as max_day_date,
      count(*) as row_count,
      sum(b.blank_sku_row) as blank_sku_rows,
      sum(b.refund_discrepancy_row) as refund_discrepancy_rows
    from base b
    group by b.company_entity_id, b.location_tag
  ),
  day_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_day_qty,
      sum(b.net_sales) as cur_day_net,
      sum(b.refunds) as cur_day_refunds,
      sum(b.total_sales) as cur_day_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  day_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_day_qty,
      sum(b.net_sales) as py_day_net,
      sum(b.refunds) as py_day_refunds,
      sum(b.total_sales) as py_day_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_mtd_qty,
      sum(b.net_sales) as cur_mtd_net,
      sum(b.refunds) as cur_mtd_refunds,
      sum(b.total_sales) as cur_mtd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_mtd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_mtd_qty,
      sum(b.net_sales) as py_mtd_net,
      sum(b.refunds) as py_mtd_refunds,
      sum(b.total_sales) as py_mtd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_mtd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_ytd_qty,
      sum(b.net_sales) as cur_ytd_net,
      sum(b.refunds) as cur_ytd_refunds,
      sum(b.total_sales) as cur_ytd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_ytd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_ytd_qty,
      sum(b.net_sales) as py_ytd_net,
      sum(b.refunds) as py_ytd_refunds,
      sum(b.total_sales) as py_ytd_total
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_ytd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  )
  select
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dc.cur_day_total, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),
    coalesce(dp.py_day_total, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mc.cur_mtd_total, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),
    coalesce(mp.py_mtd_total, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yc.cur_ytd_total, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),
    coalesce(yp.py_ytd_total, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    case
      when coalesce(dp.py_day_net, 0) = 0 then null
      else (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    end,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    case
      when coalesce(mp.py_mtd_net, 0) = 0 then null
      else (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    end,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    case
      when coalesce(yp.py_ytd_net, 0) = 0 then null
      else (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    end,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    case
      when coalesce(dp.py_day_qty, 0) = 0 then null
      else (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    end,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    case
      when coalesce(mp.py_mtd_qty, 0) = 0 then null
      else (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    end,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    case
      when coalesce(yp.py_ytd_qty, 0) = 0 then null
      else (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    end,

    coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0),
    case
      when coalesce(dp.py_day_total, 0) = 0 then null
      else (coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0)) / nullif(dp.py_day_total, 0)
    end,

    coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0),
    case
      when coalesce(mp.py_mtd_total, 0) = 0 then null
      else (coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0)) / nullif(mp.py_mtd_total, 0)
    end,

    coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0),
    case
      when coalesce(yp.py_ytd_total, 0) = 0 then null
      else (coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0)) / nullif(yp.py_ytd_total, 0)
    end,

    now()
  from location_dates ld
  join periods p
    on p.company_entity_id = ld.company_entity_id
  left join day_cur dc
    on ld.company_entity_id = dc.company_entity_id
   and ld.location_tag = dc.location_tag
  left join day_py dp
    on ld.company_entity_id = dp.company_entity_id
   and ld.location_tag = dp.location_tag
  left join mtd_cur mc
    on ld.company_entity_id = mc.company_entity_id
   and ld.location_tag = mc.location_tag
  left join mtd_py mp
    on ld.company_entity_id = mp.company_entity_id
   and ld.location_tag = mp.location_tag
  left join ytd_cur yc
    on ld.company_entity_id = yc.company_entity_id
   and ld.location_tag = yc.location_tag
  left join ytd_py yp
    on ld.company_entity_id = yp.company_entity_id
   and ld.location_tag = yp.location_tag
  order by ld.company_entity_id, ld.location_tag;
end;
$function$;

-- 20260707000000_wire_sales_velocity_mv_refresh.sql
-- sales_velocity_by_sku_location_mv backs the Top Sellers report but had no
-- refresh call site anywhere in the codebase (confirmed by grep across all
-- sync scripts and workflows) — it was last refreshed at MV-creation time
-- and had drifted ~5-6 days stale. Fix:
--   1. Same statement_timeout guard already applied to
--      refresh_sales_verification_store_comp_summary (measured runtime ~7s
--      today; will grow as sales_by_day grows, same class of silent-failure
--      risk under PostgREST's role-level timeout).
--   2. Wired the RPC call into both nightly sync scripts
--      (scripts/shopify-sync.mjs, scripts/sync-silo-inventory-sales.mjs) —
--      see those files for the call sites, no DB-side change needed for that.

create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set statement_timeout = '120s'
as $function$
begin
  refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
end;
$function$;

-- 20260707010000_store_comp_summary_discounts.sql
-- Adds Total Discounts tracking to sales_verification_store_comp_summary,
-- alongside the existing Net/Total Sales columns.
--
-- Discovered while comparing SILO's BI suite against the legacy Power BI
-- reports: every PBI table (product-level, order-line, store-level) leads
-- with a Total discounts column, and it's material (~11.5% of gross in a
-- recent quarter). sales_by_day_verification_v already has total_discounts;
-- the comp summary just never picked it up.

alter table public.sales_verification_store_comp_summary
  add column if not exists cur_day_discounts numeric,
  add column if not exists py_day_discounts numeric,
  add column if not exists cur_mtd_discounts numeric,
  add column if not exists py_mtd_discounts numeric,
  add column if not exists cur_ytd_discounts numeric,
  add column if not exists py_ytd_discounts numeric,
  add column if not exists day_discounts_var numeric,
  add column if not exists day_discounts_var_pct numeric,
  add column if not exists mtd_discounts_var numeric,
  add column if not exists mtd_discounts_var_pct numeric,
  add column if not exists ytd_discounts_var numeric,
  add column if not exists ytd_discounts_var_pct numeric;

create or replace function public.refresh_sales_verification_store_comp_summary()
returns void
language plpgsql
set statement_timeout to '120s'
as $function$
begin
  truncate table public.sales_verification_store_comp_summary;

  insert into public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    cur_day_total,
    cur_day_discounts,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    py_day_total,
    py_day_discounts,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    cur_mtd_total,
    cur_mtd_discounts,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    py_mtd_total,
    py_mtd_discounts,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    cur_ytd_total,
    cur_ytd_discounts,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    py_ytd_total,
    py_ytd_discounts,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    day_total_var,
    day_total_var_pct,
    mtd_total_var,
    mtd_total_var_pct,
    ytd_total_var,
    ytd_total_var_pct,
    day_discounts_var,
    day_discounts_var_pct,
    mtd_discounts_var,
    mtd_discounts_var_pct,
    ytd_discounts_var,
    ytd_discounts_var_pct,
    refreshed_at
  )
  with max_day as (
    select
      company_entity_id,
      max(day_date)::date as as_of_date
    from public.sales_by_day_verification_v
    where company_entity_id is not null
    group by company_entity_id
  ),
  periods as (
    select
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        extract(month from as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', as_of_date)::date as cur_ytd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date as py_ytd_start
    from max_day
  ),
  base as (
    select
      s.company_entity_id,
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_refunds, 0)::numeric as refunds,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts,
      case
        when coalesce(trim(s.sku), '') = '' then 1
        else 0
      end as blank_sku_row,
      case
        when lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        then 1
        else 0
      end as refund_discrepancy_row
    from public.sales_by_day_verification_v s
    where s.company_entity_id is not null
  ),
  location_dates as (
    select
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) as min_day_date,
      max(b.day_date) as max_day_date,
      count(*) as row_count,
      sum(b.blank_sku_row) as blank_sku_rows,
      sum(b.refund_discrepancy_row) as refund_discrepancy_rows
    from base b
    group by b.company_entity_id, b.location_tag
  ),
  day_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_day_qty,
      sum(b.net_sales) as cur_day_net,
      sum(b.refunds) as cur_day_refunds,
      sum(b.total_sales) as cur_day_total,
      sum(b.discounts) as cur_day_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  day_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_day_qty,
      sum(b.net_sales) as py_day_net,
      sum(b.refunds) as py_day_refunds,
      sum(b.total_sales) as py_day_total,
      sum(b.discounts) as py_day_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_mtd_qty,
      sum(b.net_sales) as cur_mtd_net,
      sum(b.refunds) as cur_mtd_refunds,
      sum(b.total_sales) as cur_mtd_total,
      sum(b.discounts) as cur_mtd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_mtd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_mtd_qty,
      sum(b.net_sales) as py_mtd_net,
      sum(b.refunds) as py_mtd_refunds,
      sum(b.total_sales) as py_mtd_total,
      sum(b.discounts) as py_mtd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_mtd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_ytd_qty,
      sum(b.net_sales) as cur_ytd_net,
      sum(b.refunds) as cur_ytd_refunds,
      sum(b.total_sales) as cur_ytd_total,
      sum(b.discounts) as cur_ytd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_ytd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_ytd_qty,
      sum(b.net_sales) as py_ytd_net,
      sum(b.refunds) as py_ytd_refunds,
      sum(b.total_sales) as py_ytd_total,
      sum(b.discounts) as py_ytd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_ytd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  )
  select
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dc.cur_day_total, 0),
    coalesce(dc.cur_day_discounts, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),
    coalesce(dp.py_day_total, 0),
    coalesce(dp.py_day_discounts, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mc.cur_mtd_total, 0),
    coalesce(mc.cur_mtd_discounts, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),
    coalesce(mp.py_mtd_total, 0),
    coalesce(mp.py_mtd_discounts, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yc.cur_ytd_total, 0),
    coalesce(yc.cur_ytd_discounts, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),
    coalesce(yp.py_ytd_total, 0),
    coalesce(yp.py_ytd_discounts, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    case
      when coalesce(dp.py_day_net, 0) = 0 then null
      else (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    end,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    case
      when coalesce(mp.py_mtd_net, 0) = 0 then null
      else (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    end,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    case
      when coalesce(yp.py_ytd_net, 0) = 0 then null
      else (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    end,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    case
      when coalesce(dp.py_day_qty, 0) = 0 then null
      else (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    end,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    case
      when coalesce(mp.py_mtd_qty, 0) = 0 then null
      else (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    end,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    case
      when coalesce(yp.py_ytd_qty, 0) = 0 then null
      else (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    end,

    coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0),
    case
      when coalesce(dp.py_day_total, 0) = 0 then null
      else (coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0)) / nullif(dp.py_day_total, 0)
    end,

    coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0),
    case
      when coalesce(mp.py_mtd_total, 0) = 0 then null
      else (coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0)) / nullif(mp.py_mtd_total, 0)
    end,

    coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0),
    case
      when coalesce(yp.py_ytd_total, 0) = 0 then null
      else (coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0)) / nullif(yp.py_ytd_total, 0)
    end,

    coalesce(dc.cur_day_discounts, 0) - coalesce(dp.py_day_discounts, 0),
    case
      when coalesce(dp.py_day_discounts, 0) = 0 then null
      else (coalesce(dc.cur_day_discounts, 0) - coalesce(dp.py_day_discounts, 0)) / nullif(dp.py_day_discounts, 0)
    end,

    coalesce(mc.cur_mtd_discounts, 0) - coalesce(mp.py_mtd_discounts, 0),
    case
      when coalesce(mp.py_mtd_discounts, 0) = 0 then null
      else (coalesce(mc.cur_mtd_discounts, 0) - coalesce(mp.py_mtd_discounts, 0)) / nullif(mp.py_mtd_discounts, 0)
    end,

    coalesce(yc.cur_ytd_discounts, 0) - coalesce(yp.py_ytd_discounts, 0),
    case
      when coalesce(yp.py_ytd_discounts, 0) = 0 then null
      else (coalesce(yc.cur_ytd_discounts, 0) - coalesce(yp.py_ytd_discounts, 0)) / nullif(yp.py_ytd_discounts, 0)
    end,

    now()
  from location_dates ld
  join periods p
    on p.company_entity_id = ld.company_entity_id
  left join day_cur dc
    on ld.company_entity_id = dc.company_entity_id
   and ld.location_tag = dc.location_tag
  left join day_py dp
    on ld.company_entity_id = dp.company_entity_id
   and ld.location_tag = dp.location_tag
  left join mtd_cur mc
    on ld.company_entity_id = mc.company_entity_id
   and ld.location_tag = mc.location_tag
  left join mtd_py mp
    on ld.company_entity_id = mp.company_entity_id
   and ld.location_tag = mp.location_tag
  left join ytd_cur yc
    on ld.company_entity_id = yc.company_entity_id
   and ld.location_tag = yc.location_tag
  left join ytd_py yp
    on ld.company_entity_id = yp.company_entity_id
   and ld.location_tag = yp.location_tag
  order by ld.company_entity_id, ld.location_tag;
end;
$function$;

select public.refresh_sales_verification_store_comp_summary();

-- 20260707020000_sales_verification_summary_tax_shipping.sql
-- Adds Taxes/Shipping sums to sales_verification_filtered_summary()'s
-- by-location breakdown, for the Sales Report page's "By location" table
-- and its CSV export.
--
-- Line detail (row-level) already showed taxes/shipping per row; the
-- location rollup never summed them. Needed for accounting reconciliation
-- (matches the legacy Power BI store-level report's SUM Taxes / SUM
-- Shipping columns).

create or replace function public.sales_verification_filtered_summary(
  p_date_from date default null,
  p_date_to date default null,
  p_location_tag text default null,
  p_search text default null,
  p_quick text default 'all'
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_search text;
  v_result jsonb;
begin
  v_company := active_company_id();
  if v_company is null then
    return jsonb_build_object(
      'total_rows', 0, 'total_units', 0, 'total_net', 0, 'total_refunds', 0,
      'min_date', null, 'max_date', null, 'refund_discrepancy_count', 0,
      'blank_sku_count', 0, 'negative_net_count', 0, 'batch_count', 0,
      'location_count', 0, 'locations', '[]'::jsonb
    );
  end if;
  v_search := nullif(trim(p_search), '');
  if v_search is not null then v_search := '%' || v_search || '%'; end if;
  with filtered as (
    select s.location_tag, s.day_date, s.product_name, s.sku, s.sync_batch_id,
      s.total_quantity_sold, s.total_gross_sales, s.total_discounts, s.total_refunds,
      s.total_net_sales, s.taxes, s.shipping,
      coalesce(s.sum_total_sales, s.total_sales) as total_sales
    from public.sales_by_day_verification_v s
    where s.company_entity_id = v_company
      and (p_location_tag is null or p_location_tag = '' or s.location_tag = p_location_tag)
      and (p_date_from is null or s.day_date >= p_date_from)
      and (p_date_to is null or s.day_date <= p_date_to)
      and (v_search is null or s.product_name ilike v_search or s.sku ilike v_search
        or s.vendor_original ilike v_search or s.product_type ilike v_search)
      and (coalesce(p_quick, 'all') = 'all'
        or (p_quick = 'refund_discrepancy' and (lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'))
        or (p_quick = 'blank_sku' and coalesce(trim(s.sku), '') = '')
        or (p_quick = 'negative_net' and coalesce(s.total_net_sales, 0) < 0))
  ), totals as (
    select count(*)::bigint as total_rows,
      coalesce(sum(total_quantity_sold), 0)::bigint as total_units,
      coalesce(sum(total_net_sales), 0) as total_net,
      coalesce(sum(total_refunds), 0) as total_refunds,
      min(day_date) as min_date, max(day_date) as max_date,
      count(*) filter (where lower(coalesce(product_name, '')) = '[refund discrepancy]'
        or lower(coalesce(sku, '')) = '[refund discrepancy]')::bigint as refund_discrepancy_count,
      count(*) filter (where coalesce(trim(sku), '') = '')::bigint as blank_sku_count,
      count(*) filter (where coalesce(total_net_sales, 0) < 0)::bigint as negative_net_count,
      count(distinct sync_batch_id) filter (where sync_batch_id is not null)::bigint as batch_count
    from filtered
  ), by_location as (
    select coalesce(location_tag, 'unknown') as location_tag, count(*)::bigint as row_count,
      min(day_date) as min_date, max(day_date) as max_date,
      coalesce(sum(total_quantity_sold), 0)::bigint as units,
      coalesce(sum(total_gross_sales), 0) as gross,
      coalesce(sum(total_discounts), 0) as discounts,
      coalesce(sum(total_refunds), 0) as refunds,
      coalesce(sum(taxes), 0) as taxes,
      coalesce(sum(shipping), 0) as shipping,
      coalesce(sum(total_net_sales), 0) as net,
      coalesce(sum(total_sales), 0) as total_sales
    from filtered group by coalesce(location_tag, 'unknown') order by location_tag
  )
  select jsonb_build_object(
    'total_rows', t.total_rows, 'total_units', t.total_units, 'total_net', t.total_net,
    'total_refunds', t.total_refunds, 'min_date', t.min_date, 'max_date', t.max_date,
    'refund_discrepancy_count', t.refund_discrepancy_count, 'blank_sku_count', t.blank_sku_count,
    'negative_net_count', t.negative_net_count, 'batch_count', t.batch_count,
    'location_count', (select count(*)::bigint from by_location),
    'locations', coalesce((select jsonb_agg(to_jsonb(bl) order by bl.location_tag) from by_location bl), '[]'::jsonb)
  ) into v_result from totals t;
  return v_result;
end;
$function$;
