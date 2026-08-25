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

-- ============================================================
-- 20260707030000_comp_summary_complete_day_anchor.sql
-- Anchor comps to the last COMPLETE business day (Pacific) so the
-- in-progress sync day never skews Day/MTD/YTD vs full PY days.
-- ============================================================

-- Anchor sales_verification_store_comp_summary to the last COMPLETE business
-- day instead of max(day_date).
--
-- Why: the Shopify incremental sync runs after shop-local midnight (nightly
-- 11:00 UTC, plus any manual runs during the day), so sales_by_day always
-- contains a few hours of the in-progress day. Anchoring comps to
-- max(day_date) made the "Day" comp compare a partial current day against a
-- full prior-year day (e.g. $3.4k vs $106k on 2026-07-07), and leaked the
-- partial day into MTD/YTD while the PY windows covered full days. CY/PY can
-- never tie out for an in-progress day at daily grain, so the summary now
-- excludes it: a day only counts once it has ended in America/Los_Angeles —
-- the shop's home timezone, and also the last continental-US zone to roll
-- over, so a "complete" day is complete for every store. MTD/YTD windows
-- derive from the same anchor, so both sides always cover the same number of
-- complete days.
--
-- Everything else matches 20260707010000_store_comp_summary_discounts.sql.

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
      -- Only days that have fully ended (shop-local / Pacific) can anchor the
      -- comps — the in-progress day is partial by definition and would skew
      -- Day, MTD and YTD against full PY days.
      and day_date < (now() at time zone 'America/Los_Angeles')::date
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

-- ============================================================
-- 20260708000000_product_samples_tracker_link.sql
-- product_samples.tracker_id: direct sample -> pipeline item link
-- (backfill via shared products_master link, then exact title match)
-- ============================================================

-- Direct link between a physical sample (product_samples) and its product
-- pipeline item (product_tracker).
--
-- Before this, the only relation between the two was an OPTIONAL shared
-- products_master link — a sample whose product wasn't in the catalog yet
-- (the common case for new development) had no way to reach its pipeline
-- item, so the consolidated Products page couldn't show samples under a
-- product or jump between the two without dead ends.

alter table public.product_samples
  add column if not exists tracker_id uuid references public.product_tracker(id) on delete set null;

create index if not exists product_samples_tracker_id_idx
  on public.product_samples (tracker_id);

-- Backfill 1: samples and tracker items that share a products_master link.
-- distinct on picks the oldest tracker item per (company, master) so an
-- ambiguous match never fans out.
update public.product_samples s
set tracker_id = t.id
from (
  select distinct on (company_entity_id, product_master_id) id, company_entity_id, product_master_id
  from public.product_tracker
  where product_master_id is not null
  order by company_entity_id, product_master_id, created_at asc
) t
where s.tracker_id is null
  and s.product_master_id is not null
  and t.product_master_id = s.product_master_id
  and t.company_entity_id is not distinct from s.company_entity_id;

-- Backfill 2: exact (case-insensitive) title match for the rest.
update public.product_samples s
set tracker_id = t.id
from (
  select distinct on (company_entity_id, lower(product_title)) id, company_entity_id, lower(product_title) as title_key
  from public.product_tracker
  order by company_entity_id, lower(product_title), created_at asc
) t
where s.tracker_id is null
  and t.title_key = lower(s.product_title)
  and t.company_entity_id is not distinct from s.company_entity_id;

-- ============================================================
-- 20260708010000_tasks_evergreen_personal.sql
-- Evergreen (no-launch) tasks + personal list columns + private-task RLS
-- ============================================================

-- Task Manager upgrades: evergreen (no-launch) tasks + personal to-do lists.
--
-- launch_tasks.launch_id was NOT NULL, so every task had to belong to a
-- launch — the marketing team needs standing/evergreen to-dos and personal
-- lists that aren't campaign-bound. Also adds the columns those lists need:
-- estimated effort, a manual per-person sort order, private tasks, and
-- created_by so private visibility can include the author.

alter table public.launch_tasks alter column launch_id drop not null;

alter table public.launch_tasks
  add column if not exists estimated_minutes integer,
  add column if not exists sort_order numeric,
  add column if not exists is_private boolean not null default false,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.launch_tasks alter column created_by set default auth.uid();

-- Seed per-person ordering for existing tasks: priority, then due date,
-- then age — the same heuristic the UI's "Auto-arrange" uses.
update public.launch_tasks lt
set sort_order = ranked.rn
from (
  select id,
         row_number() over (
           partition by company_entity_id, assigned_to_user_id
           order by
             case priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
             due_date asc nulls last,
             created_at asc
         ) as rn
  from public.launch_tasks
) ranked
where lt.id = ranked.id
  and lt.sort_order is null;

-- Private tasks are only visible to their assignee and their creator.
-- (The write policy stays company-scoped: this is a visibility feature for
-- a 7-admin team, not a security boundary.)
drop policy if exists launch_tasks_active_select on public.launch_tasks;
create policy launch_tasks_active_select on public.launch_tasks
  for select to authenticated
  using (
    company_entity_id = active_company_id()
    and (
      not is_private
      or assigned_to_user_id = auth.uid()
      or created_by = auth.uid()
    )
  );

-- ============================================================
-- 20260721000000_fix_launch_tasks_private_select_leak.sql
-- launch_tasks: split the ALL write policy so it no longer implicitly
-- grants unrestricted SELECT, overriding the is_private filter above.
-- ============================================================

drop policy if exists launch_tasks_active_write on public.launch_tasks;

drop policy if exists launch_tasks_active_insert on public.launch_tasks;
create policy launch_tasks_active_insert on public.launch_tasks
  for insert to authenticated
  with check (company_entity_id = active_company_id());

drop policy if exists launch_tasks_active_update on public.launch_tasks;
create policy launch_tasks_active_update on public.launch_tasks
  for update to authenticated
  using (company_entity_id = active_company_id())
  with check (company_entity_id = active_company_id());

drop policy if exists launch_tasks_active_delete on public.launch_tasks;
create policy launch_tasks_active_delete on public.launch_tasks
  for delete to authenticated
  using (company_entity_id = active_company_id());

-- ============================================================
-- 20260708020000_product_tags_company_scope.sql
-- product_tags: company column + backfill + stamp trigger + active-company RLS
-- ============================================================

-- Company-scope product_tags like the rest of the operational tables.
--
-- The table came from a legacy Google Sheet import and was skipped by the
-- 20260616 multi-tenant backfill; its policies were plain
-- authenticated-read / admin-write, so any future second company's users
-- would have seen Baseballism's catalog tags through the Products page's
-- Catalog tab. Tags are now managed in SILO alone, so the table gets the
-- standard treatment: company column, Baseballism backfill, insert stamp
-- trigger, and active-company RLS.

alter table public.product_tags
  add column if not exists company_entity_id uuid;

update public.product_tags
set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where company_entity_id is null;

create index if not exists product_tags_company_entity_id_idx
  on public.product_tags (company_entity_id);

-- Stamp inserts with the active company when the client omits the column
-- (same trigger every other company-scoped table uses).
drop trigger if exists stamp_company_entity_id on public.product_tags;
create trigger stamp_company_entity_id
  before insert on public.product_tags
  for each row
  execute function public.stamp_company_entity_id();

-- Replace the legacy open policies with active-company isolation.
-- Write semantics preserved: admin-only, now additionally company-bound.
drop policy if exists "Allow authenticated read product_tags" on public.product_tags;
drop policy if exists product_tags_select_authenticated on public.product_tags;
drop policy if exists product_tags_insert_admin_only on public.product_tags;
drop policy if exists product_tags_update_admin_only on public.product_tags;
drop policy if exists product_tags_delete_admin_only on public.product_tags;

create policy product_tags_active_select on public.product_tags
  for select to authenticated
  using (company_entity_id = active_company_id());

create policy product_tags_active_write on public.product_tags
  for all to authenticated
  using (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());

-- ============================================================
-- 20260708030000_inventory_on_hand_company_scope.sql
-- inventory_on_hand: backfill NULL company rows + company-bound write policy
-- ============================================================

-- Finish company isolation for inventory_on_hand.
--
-- The column existed and Shopify-sourced snapshots stamped it, but:
-- 1. The Sheets nightly sync never stamped inventory rows (fixed in
--    scripts/sync-silo-inventory-sales.mjs alongside this migration), leaving
--    ~816k legacy rows with NULL company — invisible to the company-scoped
--    select policy and orphaned from any tenant.
-- 2. The old inventory_on_hand_admin_all policy (ALL for any admin-role user)
--    had NO company predicate. Policies are OR'd, so any company's admin
--    could read and write every row, silently bypassing
--    inventory_on_hand_select_company.

-- Backfill legacy Sheets rows to Baseballism.
update public.inventory_on_hand
set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where company_entity_id is null;

create index if not exists inventory_on_hand_company_entity_id_idx
  on public.inventory_on_hand (company_entity_id);

-- Replace the company-blind admin policy with the standard company-bound
-- write policy (same shape as sales_by_day). Select policy already correct.
drop policy if exists inventory_on_hand_admin_all on public.inventory_on_hand;

create policy inventory_on_hand_active_write on public.inventory_on_hand
  for all to authenticated
  using (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());

-- ============================================================
-- 20260708040000_sales_rollup_mv_company_scope.sql
-- Monthly sales rollup MV rebuilt per-company; service_role-only; filtered view
-- ============================================================

-- Company-scope the monthly sales rollup (planning-scenarios' baseline data).
--
-- sales_monthly_product_type_rollup_mv aggregated ALL companies' sales_by_day
-- into one blended rollup with no company column, and 20260625140000 granted
-- authenticated direct SELECT on it — materialized views bypass RLS, so
-- test-co users saw Baseballism's numbers in Planning Scenarios (and
-- Baseballism's rollup silently included test-co rows). The identically
-- shaped security-invoker view existed but nothing used it and it computed
-- live over 4.7M rows.
--
-- New shape (same pattern as inventory_on_hand_current_mv):
--   MV: grouped by company_entity_id, service_role-only
--   View: security_invoker, filters company_entity_id = active_company_id()
--   RPC: refresh_sales_monthly_rollup_mv() — called by the nightly Shopify sync

drop view if exists public.sales_monthly_product_type_rollup_v;
drop materialized view if exists public.sales_monthly_product_type_rollup_mv;

create materialized view public.sales_monthly_product_type_rollup_mv as
select
  company_entity_id,
  (date_trunc('month', day_date::timestamptz))::date as month_start,
  to_char(date_trunc('month', day_date::timestamptz), 'YYYY-MM') as month_key,
  location_tag as location,
  case
    when location_tag = 'online' then 'online'
    when location_tag ilike '%wholesale%' then 'wholesale'
    when location_tag ilike '%faire%' then 'wholesale'
    when location_tag ilike '%dsg%' then 'wholesale'
    when location_tag ilike '%popup%' or location_tag ilike '%pop_up%' then 'event'
    else 'retail'
  end as channel,
  coalesce(nullif(product_type, ''), 'Uncategorized') as product_type,
  count(*) as rows,
  count(distinct sku) as unique_skus,
  sum(coalesce(total_quantity_sold, 0))::numeric as units,
  round(sum(coalesce(total_gross_sales, 0)), 2) as gross,
  round(sum(coalesce(total_discounts, 0)), 2) as discounts,
  round(sum(coalesce(total_refunds, 0)), 2) as refunds,
  round(sum(coalesce(total_net_sales, 0)), 2) as net,
  round(sum(coalesce(total_sales, 0)), 2) as total_sales,
  round(sum(coalesce(total_net_sales, 0)) / nullif(sum(coalesce(total_quantity_sold, 0))::numeric, 0), 2) as avg_net_per_unit
from public.sales_by_day
where company_entity_id is not null
group by company_entity_id, 2, 3, location_tag, 5, 6
with no data;

create unique index sales_monthly_rollup_mv_uq
  on public.sales_monthly_product_type_rollup_mv (company_entity_id, month_key, location, product_type);

-- MV bypasses RLS — only the refresh path may touch it directly.
revoke select on public.sales_monthly_product_type_rollup_mv from anon, authenticated;
grant select on public.sales_monthly_product_type_rollup_mv to service_role;

-- Company-filtered reader (what pages use). Same output columns as before.
create view public.sales_monthly_product_type_rollup_v
with (security_invoker = true) as
select month_start, month_key, location, channel, product_type,
       rows, unique_skus, units, gross, discounts, refunds, net,
       total_sales, avg_net_per_unit
from public.sales_monthly_product_type_rollup_mv
where company_entity_id = active_company_id();

grant select on public.sales_monthly_product_type_rollup_v to authenticated;

create or replace function public.refresh_sales_monthly_rollup_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  -- concurrently requires the unique index above and a populated MV;
  -- fall back to a plain refresh the first time (WITH NO DATA above).
  begin
    refresh materialized view concurrently public.sales_monthly_product_type_rollup_mv;
  exception when others then
    refresh materialized view public.sales_monthly_product_type_rollup_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_monthly_rollup_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_monthly_rollup_mv() to service_role;

-- ============================================================
-- 20260708050000_sales_velocity_mv_company_scope.sql
-- Velocity MV rebuilt per-company; workboard join same-company; orphan MV locked
-- ============================================================

-- Company-scope the sales velocity chain (inventory workboard + planning
-- demand math). Completes the MV isolation sweep: inventory_on_hand_current_mv
-- (already scoped), sales_monthly_product_type_rollup_mv (20260708040000),
-- and now sales_velocity_by_sku_location_mv.
--
-- The velocity MV grouped ALL companies' sales_by_day by (location, sku) with
-- no company column, and inventory_workboard_v joined it on location+sku only
-- — so a test-co inventory row whose location/SKU collides with Baseballism's
-- (e.g. 'online' + shared seed SKUs) picked up Baseballism's sell-through.
--
-- Same pattern as the other MVs: company column in the MV, service_role-only
-- access, and the security-invoker view filters active_company_id() so the
-- workboard join becomes same-company by construction (its output columns are
-- unchanged).

drop view if exists public.inventory_workboard_v;
drop view if exists public.sales_velocity_by_sku_location_v;
drop materialized view if exists public.sales_velocity_by_sku_location_mv;

create materialized view public.sales_velocity_by_sku_location_mv as
  select
    company_entity_id,
    lower(trim(location_tag))   as location_tag,
    trim(sku)                   as variant_sku,
    sum(case when day_date >= current_date - interval '7 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_7d,
    sum(case when day_date >= current_date - interval '30 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_30d,
    sum(case when day_date >= current_date - interval '90 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_90d,
    sum(case when day_date >= current_date - interval '120 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_120d,
    sum(case when day_date >= current_date - interval '365 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_365d,
    round(sum(case when day_date >= current_date - interval '7 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 7,   4) as avg_day_7,
    round(sum(case when day_date >= current_date - interval '30 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 30,  4) as avg_day_30,
    round(sum(case when day_date >= current_date - interval '90 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 90,  4) as avg_day_90,
    round(sum(case when day_date >= current_date - interval '120 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 120, 4) as avg_day_120,
    round(sum(case when day_date >= current_date - interval '365 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 365, 4) as avg_day_365,
    max(day_date) filter (where coalesce(total_quantity_sold, 0) <> 0) as last_sold_date
  from public.sales_by_day
  where sku is not null and trim(sku) <> ''
    and company_entity_id is not null
  group by company_entity_id, lower(trim(location_tag)), trim(sku)
with no data;

create unique index sales_velocity_mv_co_loc_sku
  on public.sales_velocity_by_sku_location_mv (company_entity_id, location_tag, variant_sku);

revoke select on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
grant select on public.sales_velocity_by_sku_location_mv to service_role;

-- Company-filtered reader — output columns unchanged (no company col), so the
-- workboard join below and any other consumer keep working as-is.
create view public.sales_velocity_by_sku_location_v
  with (security_invoker = true)
as
  select location_tag, variant_sku, qty_7d, qty_30d, qty_90d, qty_120d,
         qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
         avg_day_365, last_sold_date
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = active_company_id();

grant select on public.sales_velocity_by_sku_location_v to authenticated;

-- Recreate inventory_workboard_v (dropped above) — identical definition;
-- both join sides are now company-filtered.
create view public.inventory_workboard_v
  with (security_invoker = true)
as
  select
    i.id,
    i.location_tag,
    i.source,
    i.location,
    i.product_title,
    i.variant_title,
    i.variant_sku,
    i.shop_domain,
    i.variant_barcode,
    i.est_oos_date,
    i.variant_created_at,
    i.product_type,
    i.product_image,
    i.product_image_url,
    i.retail_price,
    i.total_available_quantity,
    i.total_available_inventory_value,
    i.qty_sold_30d,
    i.avg_qty_sold_per_day,
    i.est_days_before_oos,
    i.snapshot_at,
    i.row_hash,
    i.location_name,
    i.sync_batch_id,
    i.company_entity_id,
    coalesce(v.qty_7d,     0) as qty_7d,
    coalesce(v.qty_30d,    0) as sold_30,
    coalesce(v.qty_90d,    0) as qty_90d,
    coalesce(v.qty_120d,   0) as qty_120d,
    coalesce(v.qty_365d,   0) as qty_365d,
    coalesce(v.avg_day_7,  0) as avg_day_7,
    coalesce(v.avg_day_30, 0) as avg_day_30,
    coalesce(v.avg_day_90, 0) as avg_day_90,
    coalesce(v.avg_day_120,0) as avg_day_120,
    coalesce(v.avg_day_365,0) as avg_day_365,
    v.last_sold_date,
    case
      when coalesce(v.avg_day_30, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_30, 1)
      when coalesce(v.avg_day_7, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_7, 1)
      else null
    end as days_oos,
    case
      when coalesce(v.avg_day_30, 0) > 0 then '30d'
      when coalesce(v.avg_day_7,  0) > 0 then '7d'
      else 'none'
    end as velocity_basis
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku;

grant select on public.inventory_workboard_v to authenticated;

-- Refresh RPC: concurrent when possible, plain fallback for the first
-- populate after a rebuild (WITH NO DATA above).
create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  begin
    refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
  exception when others then
    refresh materialized view public.sales_velocity_by_sku_location_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_velocity_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_velocity_mv() to service_role;

-- sales_sku_location_rollup_mv: orphaned (no dependents, no repo references),
-- no company column — lock it down pending deletion in a later cleanup.
revoke select on public.sales_sku_location_rollup_mv from anon, authenticated, public;

-- ============================================================
-- 20260708060000_mv_reader_views_definer.sql
-- MV reader views → definer; lock ALL direct MV grants (incl. inventory MV)
-- ============================================================

-- The company-filtered MV reader views must be DEFINER views: with
-- security_invoker=true the invoking user needs SELECT on the MV itself,
-- which defeats locking the MVs down (20260708040000/050000 revoked the MV
-- grants and the workbench/planning pages promptly broke with "permission
-- denied for materialized view"). Definer views read the MV with owner
-- rights while the active_company_id() filter in the view body still scopes
-- rows per session user (auth.uid() resolves from the request JWT either
-- way). These views read ONLY materialized views — no RLS-bearing tables —
-- so definer semantics widen nothing.
--
-- Also closes a pre-existing hole found while decoding pg_class.relacl
-- (information_schema does not report matview grants — earlier audits were
-- blind here): inventory_on_hand_current_mv still granted anon AND
-- authenticated FULL privileges, i.e. a direct PostgREST cross-company read
-- path around the filtered view.

alter view public.sales_velocity_by_sku_location_v set (security_invoker = false);
alter view public.sales_monthly_product_type_rollup_v set (security_invoker = false);
alter view public.inventory_on_hand_current_v set (security_invoker = false);

revoke all on public.inventory_on_hand_current_mv from anon, authenticated, public;
revoke all on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
revoke all on public.sales_monthly_product_type_rollup_mv from anon, authenticated, public;
grant select on public.inventory_on_hand_current_mv to service_role;

grant select on public.inventory_on_hand_current_v to authenticated;
grant select on public.sales_velocity_by_sku_location_v to authenticated;
grant select on public.sales_monthly_product_type_rollup_v to authenticated;
grant select on public.inventory_workboard_v to authenticated;

-- ============================================================
-- 20260709000000_launch_task_templates_company_scope.sql
-- Company-scope launch_task_templates (last unscoped app-data table)
-- ============================================================

alter table public.launch_task_templates
  add column if not exists company_entity_id uuid references public.entities(id);

update public.launch_task_templates
   set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
 where company_entity_id is null;

select public.attach_stamp_company_entity_id_triggers();

drop policy if exists "launch task templates read authenticated" on public.launch_task_templates;
drop policy if exists "launch task templates insert authenticated" on public.launch_task_templates;
drop policy if exists "launch task templates update authenticated" on public.launch_task_templates;

drop policy if exists launch_task_templates_active_select on public.launch_task_templates;
create policy launch_task_templates_active_select
  on public.launch_task_templates for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists launch_task_templates_active_insert on public.launch_task_templates;
create policy launch_task_templates_active_insert
  on public.launch_task_templates for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists launch_task_templates_active_update on public.launch_task_templates;
create policy launch_task_templates_active_update
  on public.launch_task_templates for update to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

-- ============================================================
-- 20260709010000_shopify_payouts_accounting.sql
-- Shopify Payments payouts + accounting export (tables, RLS, RPC, COA seed)
-- ============================================================
create table if not exists public.shopify_payouts (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  connection_id uuid references public.shopify_connections(id),
  shop_domain text not null,
  payout_id text not null unique,
  payout_date date not null,
  status text,
  currency text,
  amount_net numeric not null default 0,
  charges_gross numeric not null default 0,
  charges_fee numeric not null default 0,
  refunds_gross numeric not null default 0,
  refunds_fee numeric not null default 0,
  adjustments_gross numeric not null default 0,
  adjustments_fee numeric not null default 0,
  reserved_funds_gross numeric not null default 0,
  reserved_funds_fee numeric not null default 0,
  retried_payouts_gross numeric not null default 0,
  retried_payouts_fee numeric not null default 0,
  synced_at timestamptz,
  sync_batch_id text,
  created_at timestamptz not null default now()
);

create index if not exists shopify_payouts_co_date_idx
  on public.shopify_payouts (company_entity_id, payout_date);
create index if not exists shopify_payouts_shop_date_idx
  on public.shopify_payouts (shop_domain, payout_date);

alter table public.shopify_payouts enable row level security;

-- Clients read their active company's payouts; only the sync (service_role,
-- bypasses RLS) writes.
drop policy if exists shopify_payouts_active_select on public.shopify_payouts;
create policy shopify_payouts_active_select
  on public.shopify_payouts for select to authenticated
  using (company_entity_id = public.active_company_id());

create table if not exists public.accounting_coa_map (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  map_key text not null,
  account_name text not null,
  updated_at timestamptz not null default now(),
  unique (company_entity_id, map_key)
);

alter table public.accounting_coa_map enable row level security;

drop policy if exists accounting_coa_map_active_select on public.accounting_coa_map;
create policy accounting_coa_map_active_select
  on public.accounting_coa_map for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists accounting_coa_map_active_insert on public.accounting_coa_map;
create policy accounting_coa_map_active_insert
  on public.accounting_coa_map for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists accounting_coa_map_active_update on public.accounting_coa_map;
create policy accounting_coa_map_active_update
  on public.accounting_coa_map for update to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop policy if exists accounting_coa_map_active_delete on public.accounting_coa_map;
create policy accounting_coa_map_active_delete
  on public.accounting_coa_map for delete to authenticated
  using (company_entity_id = public.active_company_id());

-- Stamp company on insert like every other company-scoped table.
select public.attach_stamp_company_entity_id_triggers();

-- Baseballism defaults — mirrors the existing Google Sheets journal entries.
insert into public.accounting_coa_map (company_entity_id, map_key, account_name)
values
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'revenue_template',  'In Store Retail Revenue - Shopify ({location})'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'freight',           'Freight Revenue'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'refunds_template',  'Sales Refunds - ({location})'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'discounts',         'COGS - Sales Discounts'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'tax_liability',     'COGS - Sales Tax Liability'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'tax_payable',       'Sales Tax Payable'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'accounts_receivable', 'Accounts Receivable'),
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'processing_fees',   'COGS - Processing Fees')
on conflict (company_entity_id, map_key) do nothing;

-- Server-side bucket aggregation for the Accounting Export page (a month of
-- SKU-level rows is ~50k — aggregate in the DB, not the browser). Security
-- invoker + the invoker verification view keeps company RLS in force.
create or replace function public.accounting_sales_buckets(p_from date, p_to date)
returns table (
  location_tag text,
  location_name text,
  gross numeric,
  discounts numeric,
  refunds numeric,
  shipping numeric,
  taxes numeric,
  total numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    location_tag,
    max(coalesce(location_name, location_tag)) as location_name,
    round(sum(coalesce(total_gross_sales, 0))::numeric, 2) as gross,
    round(sum(coalesce(total_discounts, 0))::numeric, 2) as discounts,
    round(sum(coalesce(total_refunds, 0))::numeric, 2) as refunds,
    round(sum(coalesce(shipping, sum_shipping, 0))::numeric, 2) as shipping,
    round(sum(coalesce(taxes, sum_taxes, 0))::numeric, 2) as taxes,
    round(sum(coalesce(total_sales, sum_total_sales, 0))::numeric, 2) as total
  from public.sales_by_day_verification_v
  where day_date >= p_from and day_date < p_to
  group by location_tag
  order by 8 desc;
$$;

grant execute on function public.accounting_sales_buckets(date, date) to authenticated;

-- ============================================================
-- 20260709020000_sync_jobs_allow_payouts_sync.sql
-- Allow 'payouts_sync' in sync_jobs.job_type CHECK constraint
-- ============================================================

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  -- Full final list (see 20260807000000 block at end of file) — intermediate
  -- narrower lists would fail re-runs once rows with later job types exist.
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis'
  ));

-- ============================================================
-- 20260709030000_slack_po_status_accuracy.sql
-- Slack PO notifications: status-aware wording + PO_SENT transition trigger
-- ============================================================
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'Sent to Factory'
     and old.status is distinct from new.status then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
      body := jsonb_build_object('type', 'PO_SENT', 'record', row_to_json(new))
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_slack_po_sent() from public, anon;

drop trigger if exists trg_slack_po_sent on public.po_headers;
create trigger trg_slack_po_sent
  after update of status on public.po_headers
  for each row execute function public.notify_slack_po_sent();

create or replace function public.send_daily_slack_summary()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _since         timestamptz := now() - interval '24 hours';
  _new_req       int;
  _new_pos       int;
  _new_pos_sent  int;
  _new_pos_draft int;
  _new_samples   int;
  _new_tasks     int;
  _new_launches  int;
  _arriving_7d   int;
  _not_ready     int;
begin
  select count(*) into _new_req     from public.payment_requests where created_at >= _since;
  select count(*) into _new_pos     from public.po_headers       where created_at >= _since;
  select count(*) into _new_pos_sent
    from public.po_headers
    where created_at >= _since and status = 'Sent to Factory';
  _new_pos_draft := _new_pos - _new_pos_sent;
  select count(*) into _new_samples from public.product_samples  where created_at >= _since;
  select count(*) into _new_tasks   from public.launch_tasks     where created_at >= _since;
  select count(*) into _new_launches from public.launch_calendar where created_at >= _since;

  select count(*) into _arriving_7d
    from public.po_headers
    where expected_arrival_date between current_date and current_date + 7
      and coalesce(status, '') not in ('Cancelled', 'Received', 'Draft');

  select count(*) into _not_ready
    from public.launch_calendar
    where launch_date between current_date and current_date + 7
      and (launch_readiness is null or launch_readiness <> 'ready');

  perform net.http_post(
    url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
    body := jsonb_build_object(
      'type',               'DAILY_SUMMARY',
      'new_requests',       _new_req,
      'new_pos',            _new_pos,
      'new_pos_sent',       _new_pos_sent,
      'new_pos_draft',      _new_pos_draft,
      'new_samples',        _new_samples,
      'new_tasks',          _new_tasks,
      'new_launches',       _new_launches,
      'arriving_7d',        _arriving_7d,
      'launches_not_ready', _not_ready
    )
  );
end;
$$;

revoke execute on function public.send_daily_slack_summary() from public, anon;

-- ============================================================
-- 20260709040000_slack_skip_draft_po_posts.sql
-- Don't post Draft POs to Slack (PO_SENT trigger announces the send)
-- ============================================================
create or replace function public.notify_slack_po_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.status, '') <> 'Draft' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
      body := jsonb_build_object('type', 'PO_CREATED', 'record', row_to_json(new))
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_slack_po_created() from public, anon;

-- ============================================================
-- 20260709050000_silo_insights_engine.sql
-- Action Items & Insights: rules engine + digest storage
-- ============================================================
create table if not exists public.silo_insights_digest (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  generated_at timestamptz not null default now(),
  findings jsonb not null default '[]'::jsonb,
  narrative text,
  model text,
  unique (company_entity_id)
);

alter table public.silo_insights_digest enable row level security;

drop policy if exists silo_insights_digest_active_select on public.silo_insights_digest;
create policy silo_insights_digest_active_select
  on public.silo_insights_digest for select to authenticated
  using (company_entity_id = public.active_company_id());

create or replace function public.compute_silo_insights(p_company_entity_id uuid)
returns table (
  domain text,
  severity text,
  title text,
  detail text,
  metric numeric,
  link_href text
)
language sql
stable
security definer
set search_path = public
as $$

  -- ---- SALES: company-wide day/MTD variance vs prior year, from the
  -- already-anchored (complete-day) comp summary. $500 PY floor keeps a
  -- near-zero base from producing a meaningless "-90%".
  with sales_totals as (
    select
      sum(cur_day_net) as cur_day_net, sum(py_day_net) as py_day_net,
      sum(cur_mtd_net) as cur_mtd_net, sum(py_mtd_net) as py_mtd_net
    from public.sales_verification_store_comp_summary
    where company_entity_id = p_company_entity_id
  ),
  sales_findings as (
    select
      'sales'::text as domain,
      case when day_pct <= -0.25 then 'critical' else 'warning' end as severity,
      'Sales pace down ' || round(abs(day_pct)*100)::text || '% vs last year' as title,
      'Yesterday''s net sales were $' || round(cur_day_net)::text || ' vs $' || round(py_day_net)::text || ' the same day last year.' as detail,
      day_pct as metric,
      '/v2/bi-sales-overview.html' as link_href
    from (select cur_day_net, py_day_net, (cur_day_net - py_day_net) / nullif(py_day_net,0) as day_pct from sales_totals) x
    where py_day_net >= 500 and day_pct <= -0.15
    union all
    select
      'sales', case when mtd_pct <= -0.20 then 'critical' else 'warning' end,
      'Month-to-date sales down ' || round(abs(mtd_pct)*100)::text || '% vs last year',
      'MTD net sales are $' || round(cur_mtd_net)::text || ' vs $' || round(py_mtd_net)::text || ' last year through the same date.',
      mtd_pct, '/v2/bi-sales-overview.html'
    from (select cur_mtd_net, py_mtd_net, (cur_mtd_net - py_mtd_net) / nullif(py_mtd_net,0) as mtd_pct from sales_totals) x
    where py_mtd_net >= 500 and mtd_pct <= -0.10
    union all
    select
      'sales', 'info',
      'Month-to-date sales up ' || round(mtd_pct*100)::text || '% vs last year',
      'MTD net sales are $' || round(cur_mtd_net)::text || ' vs $' || round(py_mtd_net)::text || ' last year — keep an eye on inventory cover for what''s driving it.',
      mtd_pct, '/v2/bi-sales-overview.html'
    from (select cur_mtd_net, py_mtd_net, (cur_mtd_net - py_mtd_net) / nullif(py_mtd_net,0) as mtd_pct from sales_totals) x
    where py_mtd_net >= 500 and mtd_pct >= 0.15
  ),

  -- ---- INVENTORY: best-sellers about to stock out, and dead stock tying
  -- up meaningful cash. Same days_oos<=14 threshold as the Top Sellers
  -- "at risk" KPI, for consistency across the app.
  stockout_risk as (
    select count(*) as n,
           min(days_oos) as worst_days,
           (array_agg(product_title order by days_oos))[1:5] as sample
    from public.inventory_workboard_v
    where company_entity_id = p_company_entity_id
      and coalesce(avg_day_30,0) > 0.5 and coalesce(days_oos, 999) <= 14
  ),
  inventory_findings as (
    select
      'inventory'::text, case when worst_days <= 7 then 'critical' else 'warning' end,
      n::text || ' best-seller' || (case when n=1 then '' else 's' end) || ' at risk of stocking out within 14 days',
      'Includes: ' || array_to_string(sample, ', ') || case when n > 5 then ', and ' || (n-5)::text || ' more.' else '.' end,
      worst_days::numeric, '/v2/bi-top-sellers.html'
    from stockout_risk where n > 0
    union all
    select
      'inventory', 'info',
      dead_count::text || ' SKU' || (case when dead_count=1 then '' else 's' end) || ' with no sales in 60+ days tying up $' || round(dead_value)::text,
      'On-hand inventory with $500+ of value and no recorded sale in the last 60 days — candidates for a markdown or bundle.',
      dead_value, '/v2/inventory.html'
    from (
      select count(*) as dead_count, sum(total_available_quantity * coalesce(retail_price,0)) as dead_value
      from public.inventory_workboard_v
      where company_entity_id = p_company_entity_id
        and total_available_quantity > 0
        and (last_sold_date is null or last_sold_date < current_date - 60)
    ) d
    where dead_value >= 500

  -- ---- PURCHASING: draft POs going stale, and overdue arrivals.
  ),
  purchasing_findings as (
    select
      'purchasing'::text, 'warning'::text,
      n::text || ' draft PO' || (case when n=1 then '' else 's' end) || ' sitting 14+ days without being sent to a factory',
      'Oldest: "' || oldest_name || '" created ' || oldest_days::text || ' days ago. Either send it or close it out.',
      oldest_days::numeric, '/v2/po-report.html'
    from (
      select count(*) as n,
             (array_agg(po_name order by created_at))[1] as oldest_name,
             (extract(day from now() - min(created_at)))::int as oldest_days
      from public.po_headers
      where company_entity_id = p_company_entity_id
        and status = 'Draft' and created_at < now() - interval '14 days'
    ) x
    where n > 0
    union all
    select
      'purchasing', case when max_overdue >= 14 then 'critical' else 'warning' end,
      n::text || ' PO' || (case when n=1 then '' else 's' end) || ' past their expected arrival date',
      'Worst is ' || max_overdue::text || ' days overdue. Follow up with the factory on status.',
      max_overdue::numeric, '/v2/po-report.html'
    from (
      select count(*) as n, max((current_date - expected_arrival_date))::int as max_overdue
      from public.po_headers
      where company_entity_id = p_company_entity_id
        and status not in ('Received','Cancelled','Draft')
        and expected_arrival_date < current_date
    ) x
    where n > 0

  -- ---- PLANNING: launches at risk in the next 2 weeks, overdue open tasks.
  ),
  planning_findings as (
    select
      'planning'::text, case when min_days <= 7 then 'critical' else 'warning' end,
      n::text || ' launch' || (case when n=1 then '' else 'es' end) || ' in the next 14 days not marked ready',
      'Soonest: "' || soonest_title || '" in ' || min_days::text || ' day' || (case when min_days=1 then '' else 's' end) || '.',
      min_days::numeric, '/v2/launch-calendar.html'
    from (
      select count(*) as n,
             min(launch_date - current_date) as min_days,
             (array_agg(title order by launch_date))[1] as soonest_title
      from public.launch_calendar
      where company_entity_id = p_company_entity_id
        and launch_date between current_date and current_date + 14
        and coalesce(launch_readiness,'not_reviewed') <> 'ready'
    ) x
    where n > 0
    union all
    select
      'planning', 'warning',
      n::text || ' launch task' || (case when n=1 then '' else 's' end) || ' overdue',
      'Open tasks past their due date across active launches.',
      n::numeric, '/v2/tasks.html'
    from (
      select count(*) as n
      from public.launch_tasks
      where company_entity_id = p_company_entity_id
        and status = 'open' and due_date < current_date
    ) x
    where n > 0

  -- ---- AR: aging receivables. ar_invoices/ar_customers carry
  -- company_entity_id directly even though the reader views don't expose it.
  ),
  ar_findings as (
    select
      'ar'::text, 'critical'::text,
      '$' || round(total_90plus)::text || ' in receivables 90+ days past due',
      'Across ' || cust_count::text || ' customer' || (case when cust_count=1 then '' else 's' end) || '. Worst: ' || worst_name || ' ($' || round(worst_amt)::text || ').',
      total_90plus, '/v2/baseballismwholesale.html'
    from (
      select sum(i.open_amount) as total_90plus,
             count(distinct i.customer_id) as cust_count,
             (array_agg(c.customer_name order by i.open_amount desc))[1] as worst_name,
             max(i.open_amount) as worst_amt
      from public.ar_invoices i join public.ar_customers c on c.id = i.customer_id
      where i.company_entity_id = p_company_entity_id
        and i.is_open and i.aging_bucket = '90+'
    ) x
    where total_90plus >= 1000
    union all
    select
      'ar', 'warning',
      '$' || round(total_6190)::text || ' in receivables 61-90 days past due',
      'Getting close to 90 days — worth a reminder before it ages further.',
      total_6190, '/v2/baseballismwholesale.html'
    from (
      select sum(open_amount) as total_6190
      from public.ar_invoices
      where company_entity_id = p_company_entity_id and is_open and aging_bucket = '61-90'
    ) x
    where total_6190 >= 1000

  -- ---- AP: overdue and large-pending payment requests.
  ),
  ap_findings as (
    select
      'ap'::text, 'critical'::text,
      n::text || ' payment request' || (case when n=1 then '' else 's' end) || ' overdue, totaling $' || round(total)::text,
      'Still open (not completed) past their due date.',
      total, '/v2/request_manager.html'
    from (
      select count(*) as n, sum(amount_due) as total
      from public.payment_requests
      where company_entity_id = p_company_entity_id
        and coalesce(completed,false) = false and due_date < current_date
    ) x
    where n > 0
    union all
    select
      'ap', 'warning',
      n::text || ' payment request' || (case when n=1 then '' else 's' end) || ' over $5,000 awaiting action',
      'Not yet marked complete.',
      total, '/v2/request_manager.html'
    from (
      select count(*) as n, sum(amount_due) as total
      from public.payment_requests
      where company_entity_id = p_company_entity_id
        and coalesce(completed,false) = false and amount_due >= 5000
    ) x
    where n > 0
  )

  select * from sales_findings
  union all select * from inventory_findings
  union all select * from purchasing_findings
  union all select * from planning_findings
  union all select * from ar_findings
  union all select * from ap_findings;
$$;

-- SECURITY DEFINER with a caller-supplied company id — only the nightly
-- job (service_role) may call this directly. End users never call it; they
-- read the pre-computed, RLS-scoped silo_insights_digest row instead.
revoke execute on function public.compute_silo_insights(uuid) from public, anon, authenticated;
grant execute on function public.compute_silo_insights(uuid) to service_role;

-- ============================================================
-- 20260710000000_accounting_tax_income_wash.sql
-- Sales tax income wash: seed tax_income_all COA map key
-- ============================================================

insert into public.accounting_coa_map (company_entity_id, map_key, account_name)
values
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'tax_income_all', 'Sales Tax Income')
on conflict (company_entity_id, map_key) do nothing;

-- ============================================================
-- 20260713200000_performance_reviews_phase1.sql
-- Performance reviews Phase 1: roles, schema, manager-scoped RLS
-- ============================================================

-- Performance Reviews — Phase 1: roles, schema, RLS.
--
-- Visibility model (enforced here, not in the UI):
--   owner/executive  -> every employee, every review in their company
--   admin (manager)  -> only employees where employees.manager_user_id = them
--   authenticated employee -> only their own non-draft reviews (via employees.profile_id)
--   associates (no SILO login) -> nothing here; they go through the token
--     portal edge function (service role) in Phase 4
--   private notes    -> author only, not even exec/owner
--
-- NOTE: 'executive' is added to app_role in this migration but must not be
-- referenced as an enum literal ('executive'::app_role) in this same
-- transaction — all role checks below compare role::text instead.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------
alter type public.app_role add value if not exists 'executive';

-- Executive outranks admin: let it pass the existing admin gate too
-- (backend hub, admin_* RPCs). Text comparison avoids same-transaction
-- enum-literal use.
create or replace function public.is_admin()
returns boolean
language sql stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'admin', 'executive')
  );
$$;

create or replace function public.is_exec_or_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'executive')
  );
$$;

create or replace function public.reviews_can_manage()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'executive', 'admin')
  );
$$;

revoke execute on function public.is_exec_or_owner() from public, anon;
revoke execute on function public.reviews_can_manage() from public, anon;
grant execute on function public.is_exec_or_owner() to authenticated, service_role;
grant execute on function public.reviews_can_manage() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  name text not null,
  email text not null,
  location text,
  job_title text,
  manager_user_id uuid not null references public.profiles(id),
  profile_id uuid references public.profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists employees_company_email_uniq
  on public.employees (company_entity_id, lower(email));
create index if not exists employees_manager_idx on public.employees (manager_user_id);
create index if not exists employees_profile_idx on public.employees (profile_id);

create table if not exists public.review_templates (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_template_questions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.review_templates(id) on delete cascade,
  company_entity_id uuid,
  position integer not null default 0,
  kind text not null check (kind in ('free_text', 'scale_1_10', 'single_choice', 'multi_choice', 'goals')),
  label text not null,
  help_text text,
  options jsonb not null default '[]'::jsonb,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_template_questions_template_idx
  on public.review_template_questions (template_id, position);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  template_id uuid not null references public.review_templates(id),
  employee_id uuid not null references public.employees(id) on delete cascade,
  manager_user_id uuid not null references public.profiles(id),
  period_label text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'finished')),
  sent_at timestamptz,
  employee_response text,
  employee_signed_name text,
  employee_signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reviews_employee_idx on public.reviews (employee_id);
create index if not exists reviews_manager_idx on public.reviews (manager_user_id);

create table if not exists public.review_answers (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  question_id uuid not null references public.review_template_questions(id),
  company_entity_id uuid,
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, question_id)
);

create index if not exists review_answers_review_idx on public.review_answers (review_id);

create table if not exists public.review_private_notes (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  company_entity_id uuid,
  author_user_id uuid not null default auth.uid() references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_private_notes_review_idx on public.review_private_notes (review_id);

create table if not exists public.employee_goals (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  employee_id uuid not null references public.employees(id) on delete cascade,
  review_id uuid references public.reviews(id) on delete set null,
  title text not null,
  description text,
  target_date date,
  status text not null default 'open' check (status in ('open', 'achieved', 'dropped', 'carried')),
  created_by uuid default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_goals_employee_idx on public.employee_goals (employee_id);

create table if not exists public.review_access_tokens (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  company_entity_id uuid,
  token_hash text not null unique,
  expires_at timestamptz not null,
  completed_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists review_access_tokens_review_idx on public.review_access_tokens (review_id);

-- ---------------------------------------------------------------------------
-- 3. Triggers — auto-link SILO profile by email, touch updated_at, stamp company
-- ---------------------------------------------------------------------------

-- profiles is RLS'd to self-select, so the email match runs SECURITY DEFINER.
create or replace function public.employees_autolink_profile()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.profile_id is null and new.email is not null then
    select p.id into new.profile_id
    from public.profiles p
    where lower(p.email) = lower(new.email)
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists employees_autolink_profile on public.employees;
create trigger employees_autolink_profile
  before insert or update of email on public.employees
  for each row execute function public.employees_autolink_profile();

create or replace function public.tg_reviews_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['employees','review_templates','review_template_questions','reviews','review_answers','review_private_notes','employee_goals']
  loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.tg_reviews_touch_updated_at()', t);
  end loop;
end;
$$;

-- Attach the existing company_entity_id stamp trigger to the new tables.
select public.attach_stamp_company_entity_id_triggers();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;
alter table public.review_templates enable row level security;
alter table public.review_template_questions enable row level security;
alter table public.reviews enable row level security;
alter table public.review_answers enable row level security;
alter table public.review_private_notes enable row level security;
alter table public.employee_goals enable row level security;
alter table public.review_access_tokens enable row level security;
-- review_access_tokens: RLS on, NO policies — service-role (edge functions) only.

revoke all on public.employees, public.review_templates, public.review_template_questions,
  public.reviews, public.review_answers, public.review_private_notes,
  public.employee_goals, public.review_access_tokens from anon;

-- employees: manager sees own roster; exec/owner sees all; a linked profile sees itself
drop policy if exists employees_active_select on public.employees;
create policy employees_active_select on public.employees for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner() or profile_id = auth.uid())
  );

drop policy if exists employees_active_insert on public.employees;
create policy employees_active_insert on public.employees for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists employees_active_update on public.employees;
create policy employees_active_update on public.employees for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists employees_active_delete on public.employees;
create policy employees_active_delete on public.employees for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- templates: managers read, exec/owner write
drop policy if exists review_templates_active_select on public.review_templates;
create policy review_templates_active_select on public.review_templates for select to authenticated
  using (company_entity_id = public.active_company_id() and public.reviews_can_manage());

drop policy if exists review_templates_exec_write on public.review_templates;
create policy review_templates_exec_write on public.review_templates for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

drop policy if exists review_template_questions_active_select on public.review_template_questions;
create policy review_template_questions_active_select on public.review_template_questions for select to authenticated
  using (company_entity_id = public.active_company_id() and public.reviews_can_manage());

drop policy if exists review_template_questions_exec_write on public.review_template_questions;
create policy review_template_questions_exec_write on public.review_template_questions for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

-- reviews: manager-scoped; linked employee sees own non-draft reviews
drop policy if exists reviews_active_select on public.reviews;
create policy reviews_active_select on public.reviews for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      manager_user_id = auth.uid()
      or public.is_exec_or_owner()
      or (
        status <> 'draft'
        and exists (
          select 1 from public.employees e
          where e.id = reviews.employee_id and e.profile_id = auth.uid()
        )
      )
    )
  );

drop policy if exists reviews_active_insert on public.reviews;
create policy reviews_active_insert on public.reviews for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists reviews_active_update on public.reviews;
create policy reviews_active_update on public.reviews for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists reviews_active_delete on public.reviews;
create policy reviews_active_delete on public.reviews for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and status = 'draft'
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- answers: visibility inherits the parent review's RLS via the subquery
drop policy if exists review_answers_select on public.review_answers;
create policy review_answers_select on public.review_answers for select to authenticated
  using (exists (select 1 from public.reviews r where r.id = review_answers.review_id));

drop policy if exists review_answers_write on public.review_answers;
create policy review_answers_write on public.review_answers for all to authenticated
  using (
    public.reviews_can_manage()
    and exists (
      select 1 from public.reviews r
      where r.id = review_answers.review_id
        and (r.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  )
  with check (
    public.reviews_can_manage()
    and exists (
      select 1 from public.reviews r
      where r.id = review_answers.review_id
        and (r.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  );

-- private notes: strictly author-only (not exec, not owner)
drop policy if exists review_private_notes_author on public.review_private_notes;
create policy review_private_notes_author on public.review_private_notes for all to authenticated
  using (author_user_id = auth.uid())
  with check (
    author_user_id = auth.uid()
    and public.reviews_can_manage()
    and exists (select 1 from public.reviews r where r.id = review_private_notes.review_id)
  );

-- goals: visibility inherits employees RLS (manager / exec / linked self)
drop policy if exists employee_goals_select on public.employee_goals;
create policy employee_goals_select on public.employee_goals for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and exists (select 1 from public.employees e where e.id = employee_goals.employee_id)
  );

drop policy if exists employee_goals_write on public.employee_goals;
create policy employee_goals_write on public.employee_goals for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (e.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (e.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  );

-- ============================================================
-- 20260713190000_harden_active_company_function_grants.sql
-- Revoke anon execute on active-company / PO-write-gate functions
-- ============================================================

-- Follow-up to 20260625140000_harden_function_grants_and_matview_access.sql,
-- which revoked anon/PUBLIC execute on admin-only functions but missed these
-- six. Security advisor flags them as anon-executable SECURITY DEFINER
-- functions. Each is actually safe by construction (gated on auth.uid(),
-- which is null for an unauthenticated caller, so they no-op/return
-- false/null rather than leak or mutate anything) — this is defense in
-- depth, not a fix for an active exploit.

REVOKE EXECUTE ON FUNCTION public.active_company_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_enabled() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_sync_mode() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.po_builder_can_write() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.po_costing_can_write() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_active_company(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.active_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_company_shopify_enabled() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_company_shopify_sync_mode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.po_builder_can_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.po_costing_can_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_company(uuid) TO authenticated;

-- ============================================================
-- 20260714170000_reviews_employee_template_read.sql
-- Employees read templates/questions of their own non-draft reviews
-- ============================================================

-- Phase 5 (my-review page): a SILO-authenticated employee can already see
-- their own non-draft reviews and answers via RLS, but the template TITLE
-- and QUESTION LABELS were manager-read-only (reviews_can_manage()), so the
-- in-app view couldn't render. Grant employees read access to templates and
-- questions — but only for templates used by one of their own non-draft
-- reviews, so template contents never leak ahead of a sent review.

drop policy if exists review_templates_employee_select on public.review_templates;
create policy review_templates_employee_select on public.review_templates for select to authenticated
  using (
    exists (
      select 1
      from public.reviews r
      join public.employees e on e.id = r.employee_id
      where r.template_id = review_templates.id
        and e.profile_id = auth.uid()
        and r.status <> 'draft'
    )
  );

drop policy if exists review_template_questions_employee_select on public.review_template_questions;
create policy review_template_questions_employee_select on public.review_template_questions for select to authenticated
  using (
    exists (
      select 1
      from public.reviews r
      join public.employees e on e.id = r.employee_id
      where r.template_id = review_template_questions.template_id
        and e.profile_id = auth.uid()
        and r.status <> 'draft'
    )
  );

-- ============================================================
-- 20260714180000_admin_update_profile_entity_membership.sql
-- Backend role toggles ensure an entity membership + backfill
-- ============================================================

-- Direct-signup users granted a role via /v2/backend.html never got an
-- entity_memberships row, so active_company_id stayed NULL and every
-- company-scoped RLS policy locked them out (e.g. couldn't submit a
-- payment request). Mirror of the 20260713180000 approve_access_request
-- fix for the admin_update_profile path, plus a backfill.

CREATE OR REPLACE FUNCTION public.admin_update_profile(p_user_id uuid, p_name text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role app_role;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_membership_role text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_role := case
    when p_role is null or trim(p_role) = '' then null
    when lower(p_role) = 'owner' then 'owner'::app_role
    when lower(p_role) = 'admin' then 'admin'::app_role
    else 'user'::app_role
  end;

  update public.profiles
     set name = coalesce(p_name, name),
         department = coalesce(p_department, department),
         role = coalesce(v_role, role),
         is_active = coalesce(p_is_active, is_active),
         updated_at = now()
   where id = p_user_id
   returning role, is_active into v_final_role, v_final_active;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_final_active then
    v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

    v_membership_role := case v_final_role
                            when 'owner' then 'owner_admin'
                            when 'admin' then 'admin'
                            else 'member'
                          end;

    insert into public.entity_memberships (entity_id, user_id, role)
    values (v_company_id, p_user_id, v_membership_role)
    on conflict (entity_id, user_id) do update
      set role = excluded.role;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) SET search_path = public;

insert into public.entity_memberships (entity_id, user_id, role)
select
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid,
  p.id,
  case p.role::text
    when 'owner' then 'owner_admin'
    when 'admin' then 'admin'
    else 'member'
  end
from public.profiles p
where p.is_active
  and not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
on conflict (entity_id, user_id) do nothing;

update public.profiles p
   set active_company_id = em.entity_id
  from public.entity_memberships em
 where em.user_id = p.id
   and p.active_company_id is null
   and (select count(*) from public.entity_memberships em2 where em2.user_id = p.id) = 1;

-- ============================================================
-- 20260714190000_new_org_signup_flow.sql
-- Create-account = new organization; company-scope admin RPCs
-- ============================================================


CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_name text;
  v_key text;
  v_entity_id uuid;
begin
  v_org_name := nullif(trim(coalesce(new.raw_user_meta_data->>'org_name', '')), '');

  if v_org_name is null then
    -- Invited/legacy path: bare profile, authorized later by an org admin.
    insert into public.profiles (id, email, name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null))
    on conflict (id) do update
      set email = excluded.email;
    return new;
  end if;

  -- Founding path: create the organization and make this user its owner.
  v_key := trim(both '-' from regexp_replace(lower(v_org_name), '[^a-z0-9]+', '-', 'g'));
  if v_key = '' then
    v_key := 'org';
  end if;
  if exists (select 1 from public.entities e where e.entity_type = 'company' and e.entity_key = v_key) then
    v_key := v_key || '-' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;

  insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
  values ('finance_hub', 'company', v_key, 'self_signup', v_org_name, jsonb_build_object('self_signup', true), new.id)
  returning id into v_entity_id;

  insert into public.profiles (id, email, name, role, department, is_active, active_company_id)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null), 'owner'::app_role, 'exec', true, v_entity_id)
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        department = excluded.department,
        is_active = true,
        active_company_id = excluded.active_company_id;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity_id, new.id, 'owner_admin')
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  return new;
end;
$function$;

ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- ── 2. Company-scope the backend admin RPCs ──────────────────
-- Scope rule: an admin can see/manage users who are members of the
-- admin's own active company, plus "unclaimed" profiles that have no
-- membership anywhere (pre-flow signups awaiting adoption). Managing an
-- unclaimed profile pulls it into the caller's company (membership upsert
-- in admin_update_profile).

CREATE OR REPLACE FUNCTION public.admin_list_profiles()
 RETURNS SETOF profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select p.*
  from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
  order by coalesce(p.updated_at, p.created_at) desc nulls last, p.email asc;
end;
$function$;

ALTER FUNCTION public.admin_list_profiles() SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_counts()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_profiles_count int;
  v_profiles_updated_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select count(*)::int, max(p.updated_at)
    into v_profiles_count, v_profiles_updated_at
  from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id);

  return json_build_object(
    'profiles_count', v_profiles_count,
    'profiles_updated_at', v_profiles_updated_at
  );
end;
$function$;

ALTER FUNCTION public.admin_counts() SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_update_profile(p_user_id uuid, p_name text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role app_role;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_membership_role text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- Cross-tenant guard: the target must belong to the caller's active
  -- company, or be unclaimed (no membership anywhere).
  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  v_role := case
    when p_role is null or trim(p_role) = '' then null
    when lower(p_role) = 'owner' then 'owner'::app_role
    when lower(p_role) = 'admin' then 'admin'::app_role
    else 'user'::app_role
  end;

  update public.profiles
     set name = coalesce(p_name, name),
         department = coalesce(p_department, department),
         role = coalesce(v_role, role),
         is_active = coalesce(p_is_active, is_active),
         updated_at = now()
   where id = p_user_id
   returning role, is_active into v_final_role, v_final_active;

  if not found then
    raise exception 'profile not found';
  end if;

  -- Active users must have a company membership or RLS locks them out of
  -- everything (see 20260714180000).
  if v_final_active then
    v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

    v_membership_role := case v_final_role
                            when 'owner' then 'owner_admin'
                            when 'admin' then 'admin'
                            else 'member'
                          end;

    insert into public.entity_memberships (entity_id, user_id, role)
    values (v_company_id, p_user_id, v_membership_role)
    on conflict (entity_id, user_id) do update
      set role = excluded.role;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_list_access_requests(p_status text)
 RETURNS SETOF access_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select ar.*
  from public.access_requests ar
  left join public.profiles p
    on (
      (ar.user_id is not null and p.id = ar.user_id)
      or (ar.user_id is null and lower(p.email) = lower(ar.email))
    )
  where lower(coalesce(ar.status,'')) = lower(coalesce(p_status,'pending'))
    and p.id is null -- only requests without a profile
    and (ar.company_entity_id is null or ar.company_entity_id = public.active_company_id());
end;
$function$;

ALTER FUNCTION public.admin_list_access_requests(text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.approve_access_request(p_request_id uuid, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req public.access_requests%rowtype;
  v_dept text;
  v_role app_role;
  v_membership_role text;
  v_company_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select * into v_req
  from public.access_requests
  where id = p_request_id;

  if not found then
    raise exception 'request not found';
  end if;

  -- Cross-tenant guard: an admin can only approve requests aimed at their
  -- own active company (legacy rows with no company count as the caller's).
  if v_req.company_entity_id is not null
     and v_req.company_entity_id <> public.active_company_id() then
    raise exception 'not authorized';
  end if;

  if v_req.user_id is null then
    raise exception 'request missing user_id (user must authenticate once so we can capture auth.uid())';
  end if;

  v_dept := coalesce(nullif(trim(p_department), ''), v_req.department, 'ops');

  v_role := case lower(coalesce(nullif(trim(p_role), ''), v_req.requested_role, 'user'))
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  insert into public.profiles (id, email, name, role, department, is_active, created_at, updated_at)
  values (v_req.user_id, v_req.email, v_req.full_name, v_role, v_dept, true, now(), now())
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(excluded.name, public.profiles.name),
        role = excluded.role,
        department = excluded.department,
        is_active = true,
        updated_at = now();

  v_company_id := coalesce(v_req.company_entity_id, public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  v_membership_role := case v_role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_company_id, v_req.user_id, v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.access_requests
     set status = 'approved'
   where id = p_request_id;

  return json_build_object(
    'ok', true,
    'user_id', v_req.user_id,
    'role', v_role::text,
    'department', v_dept,
    'company_entity_id', v_company_id
  );
end;
$function$;

ALTER FUNCTION public.approve_access_request(uuid, text, text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.deny_access_request(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select company_entity_id into v_company
  from public.access_requests
  where id = p_request_id;

  if not found then
    raise exception 'request not found';
  end if;

  if v_company is not null and v_company <> public.active_company_id() then
    raise exception 'not authorized';
  end if;

  update public.access_requests
     set status = 'denied'
   where id = p_request_id;

  return json_build_object('ok', true);
end;
$function$;

ALTER FUNCTION public.deny_access_request(uuid) SET search_path = public;

-- ============================================================
-- 20260714200000_org_invites.sql
-- Org invites: token links to join an existing organization
-- ============================================================

create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  email text not null,
  role text not null default 'user',
  department text not null default 'ops',
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid references public.profiles(id),
  accepted_by uuid,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index if not exists org_invites_entity_status_idx on public.org_invites (entity_id, status);

alter table public.org_invites enable row level security;
-- deliberately no policies: RPC-only access

-- ── create_org_invite ─────────────────────────────────────────
-- Admin-only, scoped to the caller's active company. Revokes any prior
-- pending invite for the same email+company so exactly one link is live.

CREATE OR REPLACE FUNCTION public.create_org_invite(p_email text, p_role text DEFAULT 'user', p_department text DEFAULT 'ops')
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_email text;
  v_role text;
  v_token text;
  v_invite public.org_invites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required';
  end if;

  v_role := case lower(coalesce(nullif(trim(p_role), ''), 'user'))
              when 'owner' then 'owner'
              when 'admin' then 'admin'
              else 'user'
            end;

  if exists (
    select 1
    from public.entity_memberships em
    join public.profiles pr on pr.id = em.user_id
    where em.entity_id = v_company and lower(pr.email) = v_email
  ) then
    raise exception 'already a member of this organization';
  end if;

  update public.org_invites
     set status = 'revoked'
   where entity_id = v_company and lower(email) = v_email and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.org_invites (entity_id, email, role, department, token_hash, invited_by)
  values (v_company, v_email, v_role, coalesce(nullif(trim(p_department), ''), 'ops'),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning * into v_invite;

  return json_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'email', v_invite.email,
    'role', v_invite.role,
    'department', v_invite.department,
    'expires_at', v_invite.expires_at,
    'token', v_token
  );
end;
$function$;

-- ── accept_org_invite ─────────────────────────────────────────
-- Called by the invitee themselves after auth. Not admin-gated: the token
-- is the authorization. Bound to the invited email so a leaked link can't
-- be redeemed by a different account.

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite public.org_invites%rowtype;
  v_profile_email text;
  v_role app_role;
  v_membership_role text;
  v_org_title text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.org_invites
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and status = 'pending';

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  if v_invite.expires_at < now() then
    update public.org_invites set status = 'expired' where id = v_invite.id;
    raise exception 'invite has expired — ask your admin for a new one';
  end if;

  select lower(email) into v_profile_email from public.profiles where id = auth.uid();
  if v_profile_email is null then
    raise exception 'profile not found';
  end if;
  if v_profile_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  v_role := case v_invite.role
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  v_membership_role := case v_invite.role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  update public.profiles
     set role = v_role,
         department = v_invite.department,
         is_active = true,
         active_company_id = coalesce(active_company_id, v_invite.entity_id),
         updated_at = now()
   where id = auth.uid();

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_invite.entity_id, auth.uid(), v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.org_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now()
   where id = v_invite.id;

  select title into v_org_title from public.entities where id = v_invite.entity_id;

  return json_build_object(
    'ok', true,
    'entity_id', v_invite.entity_id,
    'org_title', v_org_title,
    'role', v_role::text,
    'department', v_invite.department
  );
end;
$function$;

-- ── list_org_invites / revoke_org_invite ─────────────────────

CREATE OR REPLACE FUNCTION public.list_org_invites()
 RETURNS TABLE(id uuid, email text, role text, department text, status text, expires_at timestamptz, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select i.id, i.email, i.role, i.department, i.status, i.expires_at, i.created_at
  from public.org_invites i
  where i.entity_id = public.active_company_id()
    and i.status = 'pending'
  order by i.created_at desc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_org_invite(p_invite_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  update public.org_invites
     set status = 'revoked'
   where id = p_invite_id
     and entity_id = public.active_company_id()
     and status = 'pending';

  if not found then
    raise exception 'invite not found';
  end if;

  return json_build_object('ok', true);
end;
$function$;

-- ── grants ────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.create_org_invite(text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.accept_org_invite(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_org_invites() FROM public, anon;
REVOKE ALL ON FUNCTION public.revoke_org_invite(uuid) FROM public, anon;

GRANT EXECUTE ON FUNCTION public.create_org_invite(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_org_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_org_invite(uuid) TO authenticated;

ALTER FUNCTION public.create_org_invite(text, text, text) SET search_path = public;
ALTER FUNCTION public.accept_org_invite(text) SET search_path = public;
ALTER FUNCTION public.list_org_invites() SET search_path = public;
ALTER FUNCTION public.revoke_org_invite(uuid) SET search_path = public;

-- ============================================================
-- 20260714210000_per_company_roles.sql
-- Permission gates use per-company membership roles
-- ============================================================

-- ── 1. Gate functions: membership role first, profile fallback ─

-- Caller's membership role in their active company (null = no membership).
CREATE OR REPLACE FUNCTION public.active_membership_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select em.role
  from public.entity_memberships em
  join public.profiles p on p.id = em.user_id
  where em.user_id = auth.uid()
    and em.entity_id = p.active_company_id;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','admin','executive')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_admin_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_owner_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_exec_or_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role = 'owner_admin' or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','executive')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.reviews_can_manage()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','executive','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.po_builder_can_write()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in (
              'owner','admin','finance','exec','executive',
              'buyer','purchasing','operations'
            )
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.po_costing_can_write()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(coalesce(p.role::text, 'user')) in (
              'owner','admin','finance','exec','executive','buyer','purchasing','operations'
            )
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_payment_requests()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role in ('owner_admin','admin')
             else p.role::text = 'admin'
        end
        or p.department in ('finance','admin','exec')
      )
  );
$function$;

-- ── 2. Policies with inline profile-role checks ───────────────

DROP POLICY IF EXISTS "payment_requests_active_select" ON public.payment_requests;
CREATE POLICY "payment_requests_active_select" ON public.payment_requests
  FOR SELECT USING (
    company_entity_id = active_company_id() AND (
      created_by = auth.uid() OR
      current_user_can_manage_payment_requests() OR
      is_admin_user()
    )
  );

-- Was un-scoped (predates company isolation): any admin/finance user of ANY
-- company passed its USING clause. Now company-scoped + membership-aware.
DROP POLICY IF EXISTS "payment_requests_internal_update" ON public.payment_requests;
CREATE POLICY "payment_requests_internal_update" ON public.payment_requests
  FOR UPDATE
  USING      (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests())
  WITH CHECK (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests());

DROP POLICY IF EXISTS "payroll_import_batches_active_all" ON public.payroll_import_batches;
CREATE POLICY "payroll_import_batches_active_all" ON public.payroll_import_batches
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

DROP POLICY IF EXISTS "payroll_register_lines_active_all" ON public.payroll_register_lines;
CREATE POLICY "payroll_register_lines_active_all" ON public.payroll_register_lines
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

DROP POLICY IF EXISTS "payroll_time_lines_active_all" ON public.payroll_time_lines;
CREATE POLICY "payroll_time_lines_active_all" ON public.payroll_time_lines
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

-- ── 3. Stop invite/role grants from bleeding across orgs ──────

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite public.org_invites%rowtype;
  v_profile_email text;
  v_role app_role;
  v_membership_role text;
  v_org_title text;
  v_has_other_org boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.org_invites
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and status = 'pending';

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  if v_invite.expires_at < now() then
    update public.org_invites set status = 'expired' where id = v_invite.id;
    raise exception 'invite has expired — ask your admin for a new one';
  end if;

  select lower(email) into v_profile_email from public.profiles where id = auth.uid();
  if v_profile_email is null then
    raise exception 'profile not found';
  end if;
  if v_profile_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  v_role := case v_invite.role
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  v_membership_role := case v_invite.role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = auth.uid() and em.entity_id <> v_invite.entity_id
  ) into v_has_other_org;

  if v_has_other_org then
    -- Already belongs elsewhere: the membership row carries this org's role;
    -- leave the global profile role/department alone.
    update public.profiles
       set is_active = true,
           active_company_id = coalesce(active_company_id, v_invite.entity_id),
           updated_at = now()
     where id = auth.uid();
  else
    update public.profiles
       set role = v_role,
           department = v_invite.department,
           is_active = true,
           active_company_id = coalesce(active_company_id, v_invite.entity_id),
           updated_at = now()
     where id = auth.uid();
  end if;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_invite.entity_id, auth.uid(), v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.org_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now()
   where id = v_invite.id;

  select title into v_org_title from public.entities where id = v_invite.entity_id;

  return json_build_object(
    'ok', true,
    'entity_id', v_invite.entity_id,
    'org_title', v_org_title,
    'role', v_role::text,
    'department', v_invite.department
  );
end;
$function$;

ALTER FUNCTION public.accept_org_invite(text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_update_profile(p_user_id uuid, p_name text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role app_role;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_membership_role text;
  v_has_other_org boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- Cross-tenant guard: the target must belong to the caller's active
  -- company, or be unclaimed (no membership anywhere).
  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  v_role := case
    when p_role is null or trim(p_role) = '' then null
    when lower(p_role) = 'owner' then 'owner'::app_role
    when lower(p_role) = 'admin' then 'admin'::app_role
    else 'user'::app_role
  end;

  v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = p_user_id and em.entity_id <> v_company_id
  ) into v_has_other_org;

  if v_has_other_org then
    -- Multi-org target: the role change applies to THIS org's membership
    -- only; don't rewrite their global profile role/department.
    update public.profiles
       set name = coalesce(p_name, name),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  else
    update public.profiles
       set name = coalesce(p_name, name),
           department = coalesce(p_department, department),
           role = coalesce(v_role, role),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  end if;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_final_active then
    if v_role is not null then
      -- Explicit role change: apply it to this org's membership.
      v_membership_role := case v_role
                              when 'owner' then 'owner_admin'
                              when 'admin' then 'admin'
                              else 'member'
                            end;
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do update
        set role = excluded.role;
    else
      -- No role change: only ensure a membership exists (seeded from the
      -- profile role); never rewrite an existing membership's role.
      v_membership_role := case v_final_role
                              when 'owner' then 'owner_admin'
                              when 'admin' then 'admin'
                              else 'member'
                            end;
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do nothing;
    end if;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) SET search_path = public;

-- ── 4. Legacy data alignment ──────────────────────────────────
-- Pre-multi-tenant founding owners were seeded with plain 'admin'
-- memberships while their profile role said 'owner'. Under membership-first
-- gates they'd lose owner-level access (is_exec_or_owner), so lift those
-- memberships to owner_admin.

update public.entity_memberships em
   set role = 'owner_admin'
  from public.profiles p
 where p.id = em.user_id
   and p.role::text = 'owner'
   and em.role = 'admin';

-- ── 5. Grants ─────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.active_membership_role() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.active_membership_role() TO authenticated;

-- ============================================================
-- 20260714220000_stamp_created_by.sql
-- Insert-side created_by / changed_by stamping triggers
-- ============================================================

CREATE OR REPLACE FUNCTION public.stamp_created_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stamp_changed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.changed_by IS NULL THEN
    NEW.changed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ar_contact_log',
    'employee_goals',
    'entities',
    'entity_comments',
    'intern_workbench_items',
    'launch_calendar',
    'launch_channel_items',
    'launch_product_readiness',
    'launch_system_links',
    'launch_tasks',
    'locations',
    'marketing_campaign_bank',
    'payment_request_activity',
    'payment_request_files',
    'payment_requests',
    'po_headers',
    'product_samples',
    'revenue_projections',
    'review_templates',
    'saved_views',
    'shopify_connections',
    'sync_jobs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_created_by ON public.%I', t);
    EXECUTE format('CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by()', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'po_status_history',
    'revenue_projection_history'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_changed_by ON public.%I', t);
    EXECUTE format('CREATE TRIGGER stamp_changed_by BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_changed_by()', t);
  END LOOP;
END $$;

-- 20260715120000_fix_refresh_inventory_current_mv_timeout.sql
-- refresh_inventory_current_mv() originally shipped with
-- `set statement_timeout = '120s'` (20260625200000), but a later duplicate
-- migration (20260630200000_add_refresh_inventory_current_mv_rpc.sql)
-- re-created the function without the timeout, search_path pin, or the
-- REVOKEs, silently regressing it back to the caller's default timeout.
-- Same bug class as refresh_sales_verification_store_comp_summary() and
-- refresh_sales_velocity_mv() (fixed earlier): the nightly Shopify sync
-- calls this as service_role after every run and log-and-continues on
-- failure, so a timeout here fails silently instead of crashing the job.

create or replace function public.refresh_inventory_current_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
begin
  refresh materialized view concurrently public.inventory_on_hand_current_mv;
end;
$$;

revoke execute on function public.refresh_inventory_current_mv() from public;
revoke execute on function public.refresh_inventory_current_mv() from authenticated;

-- 20260715130000_slack_task_notify_launch_only.sql
-- notify_slack_task_created() fired for every launch_tasks insert, with no
-- guard — so a private, ad hoc Task Manager assignment between two people
-- (launch_id null, not tied to any marketing launch) posted to the
-- company-wide Slack channel exactly like a real launch project task.
-- Task Manager is for individuals/small teams tracking their own to-dos;
-- it isn't slack-noise-worthy. Only post when the task is actually tied to
-- a launch (launch_id set) and isn't marked private.

create or replace function public.notify_slack_task_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.launch_id is null or coalesce(new.is_private, false) then
    return new;
  end if;
  perform net.http_post(
    url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
    body := jsonb_build_object('type', 'TASK_CREATED', 'record', row_to_json(new))
  );
  return new;
end;
$function$;

-- 20260716000000_supermetrics_kpis.sql
-- Supermetrics integration phase 1: nightly marketing KPI ingestion
-- (Google Ads / Meta Ads / TikTok Ads / GA4) into marketing_kpis_daily,
-- next to sales_by_day for later spend-vs-revenue blending. Config/state
-- lives in supermetrics_connections (API key stays in the GitHub secret
-- SUPERMETRICS_API_KEY, never in the DB).

create table if not exists public.supermetrics_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  display_name text,
  is_active boolean not null default true,
  sync_enabled boolean not null default false,
  days_back integer not null default 30,
  sources jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.marketing_kpis_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.supermetrics_connections(id) on delete set null,
  platform text not null check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4')),
  ds_id text not null,
  account_id text,
  account_name text,
  day_date date not null,
  campaign_id text,
  campaign_name text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14,2) not null default 0,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  sessions bigint,
  extra jsonb not null default '{}'::jsonb,
  row_hash text not null unique,
  source text not null default 'supermetrics',
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create index if not exists idx_marketing_kpis_daily_co_day
  on public.marketing_kpis_daily (company_entity_id, day_date);
create index if not exists idx_marketing_kpis_daily_co_platform_day
  on public.marketing_kpis_daily (company_entity_id, platform, day_date);

-- RLS: reads scoped to the caller's active company (same as sales_by_day);
-- no client-side write policies — only the service-role sync writes.
alter table public.supermetrics_connections enable row level security;
alter table public.marketing_kpis_daily enable row level security;

drop policy if exists supermetrics_connections_active_select on public.supermetrics_connections;
create policy supermetrics_connections_active_select
  on public.supermetrics_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists marketing_kpis_daily_active_select on public.marketing_kpis_daily;
create policy marketing_kpis_daily_active_select
  on public.marketing_kpis_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- Attribution stamp, same as shopify_connections.
drop trigger if exists stamp_created_by on public.supermetrics_connections;
create trigger stamp_created_by
  before insert on public.supermetrics_connections
  for each row execute function public.stamp_created_by();

-- Let the sync log its runs in the shared sync_jobs table.
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  -- Full final list (see 20260807000000 block at end of file).
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis'
  ));

-- 20260717190000_inventory_current_mv_company_index.sql
-- inventory_on_hand_current_mv had no index on company_entity_id (only the
-- unique id index) — every request through inventory_on_hand_current_v /
-- inventory_workboard_v (Planning Scenarios' demand-math load, and the
-- Inventory workboard itself) forces a full sequential scan of the whole
-- MV (69k+ rows and growing) before the company filter. Combined with the
-- authenticated role's 8s statement_timeout, this started failing
-- ("canceling statement due to statement timeout") as row counts grew.
-- sales_velocity_by_sku_location_mv got its company index when it was
-- scoped in 20260708050000_sales_velocity_mv_company_scope.sql; this MV's
-- company column existed already but was never indexed.

create index if not exists inventory_on_hand_current_mv_company_idx
  on public.inventory_on_hand_current_mv (company_entity_id);

-- ============================================================
-- 20260723150000_shopify_draft_orders.sql
-- Shopify draft orders sync (pipeline visibility — see migration file for
-- why draft orders are invisible to sales_by_day today)
-- ============================================================
create table if not exists public.shopify_draft_orders (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  connection_id uuid references public.shopify_connections(id),
  shop_domain text not null,
  draft_order_id text not null,
  name text,
  status text not null,
  customer_id text,
  customer_email text,
  customer_name text,
  total_price numeric not null default 0,
  subtotal_price numeric not null default 0,
  total_tax numeric not null default 0,
  currency text,
  tags text,
  note text,
  order_id text,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  invoice_sent_at timestamptz,
  completed_at timestamptz,
  synced_at timestamptz,
  sync_batch_id text,
  created_at timestamptz not null default now(),
  unique (shop_domain, draft_order_id)
);

create index if not exists shopify_draft_orders_co_status_idx
  on public.shopify_draft_orders (company_entity_id, status);
create index if not exists shopify_draft_orders_co_created_idx
  on public.shopify_draft_orders (company_entity_id, shopify_created_at);

alter table public.shopify_draft_orders enable row level security;

drop policy if exists shopify_draft_orders_active_select on public.shopify_draft_orders;
create policy shopify_draft_orders_active_select
  on public.shopify_draft_orders for select to authenticated
  using (company_entity_id = public.active_company_id());

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  -- Full final list (see 20260807000000 block at end of file).
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis'
  ));

-- ============================================================
-- 20260723160000_mlb_shopify_default_location.sql
-- baseballismmlb was missing the default_location_code fallback that
-- baseballismwholesale already has — orders with no resolvable Shopify
-- location were silently dropped from sales_by_day (~$172k YTD undercount)
-- ============================================================
update public.shopify_connections
   set default_location_code = 'wholesale'
 where shop_domain = 'baseballismmlb.myshopify.com'
   and coalesce(default_location_code, '') = '';

-- ============================================================
-- 20260723170000_wholesale_gross_reconciliation.sql
-- Manual reconciliation entry closing the wholesale YTD gross-sales gap
-- vs. Shopify's own Sales report (no-restock refund gross not exposed via
-- API — see migration file for full root-cause detail)
-- ============================================================
insert into public.sales_by_day (
  company_entity_id, location_tag, location_name, source, day_date,
  product_name, sku, product_type, vendor_original,
  total_quantity_sold, total_orders, total_gross_sales, total_discounts,
  total_refunds, total_net_sales, taxes, shipping, total_sales,
  shop_domain, sync_batch_id, synced_at, row_hash
) values (
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  'wholesale',
  'Wholesale',
  'manual_adjustment',
  '2026-04-14',
  '[Shopify report reconciliation — no-restock refund gross]',
  '[MANUAL-RECONCILIATION]',
  null,
  null,
  0,
  0,
  13232.25,
  0,
  0,
  13232.25,
  0,
  0,
  13232.25,
  'baseballismwholesale.myshopify.com',
  'manual-reconciliation-2026-07-23',
  now(),
  md5('manual_adjustment|baseballismwholesale|2026-04-14|gross-reconciliation|20260723')
)
on conflict (row_hash) do update set
  total_gross_sales = excluded.total_gross_sales,
  total_net_sales = excluded.total_net_sales,
  total_sales = excluded.total_sales,
  synced_at = excluded.synced_at;

-- ============================================================
-- 20260723180000_link_launch_product_readiness_tracker.sql
-- FK linking launch_product_readiness to product_tracker so the two
-- previously-disconnected "launch readiness" tables can be kept in sync
-- ============================================================
alter table public.launch_product_readiness
  add column if not exists product_tracker_id uuid references public.product_tracker(id) on delete set null;

create index if not exists launch_product_readiness_tracker_idx
  on public.launch_product_readiness (product_tracker_id);

-- ============================================================
-- 20260723190000_products_master_legacy_tag_backfill.sql
-- attributes jsonb column + one-time backfill of category/notes/attributes
-- from the retired product_tags import, matched by product_title
-- ============================================================
alter table public.products_master
  add column if not exists attributes jsonb not null default '{}'::jsonb;

with legacy as (
  select
    lower(trim(product_title)) as norm_title,
    (array_agg(product_category order by uploaded_at desc nulls last) filter (where product_category is not null and product_category <> ''))[1] as product_category,
    (array_agg(notes           order by uploaded_at desc nulls last) filter (where notes is not null and notes <> ''))[1] as notes,
    (array_agg(collection      order by uploaded_at desc nulls last) filter (where collection is not null and collection <> ''))[1] as collection,
    (array_agg(indicator_group order by uploaded_at desc nulls last) filter (where indicator_group is not null and indicator_group <> ''))[1] as indicator_group,
    (array_agg(primary_color   order by uploaded_at desc nulls last) filter (where primary_color is not null and primary_color <> ''))[1] as primary_color,
    (array_agg(artwork_side    order by uploaded_at desc nulls last) filter (where artwork_side is not null and artwork_side <> ''))[1] as artwork_side,
    (array_agg(sub_tag         order by uploaded_at desc nulls last) filter (where sub_tag is not null and sub_tag <> ''))[1] as sub_tag
  from public.product_tags
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  group by 1
)
update public.products_master pm
set
  category = coalesce(pm.category, legacy.product_category),
  notes = coalesce(pm.notes, legacy.notes),
  attributes = pm.attributes || jsonb_strip_nulls(jsonb_build_object(
    'legacy_collection', legacy.collection,
    'legacy_indicator_group', legacy.indicator_group,
    'legacy_primary_color', legacy.primary_color,
    'legacy_artwork_side', legacy.artwork_side,
    'legacy_sub_tag', legacy.sub_tag
  ))
from legacy
where pm.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and lower(trim(pm.product_title)) = legacy.norm_title;

-- ============================================================
-- 20260723200000_product_tracker_expected_units.sql
-- expected_units column so PO-created Pipeline items carry qty
-- ============================================================
alter table public.product_tracker
  add column if not exists expected_units integer;

-- ============================================================
-- 20260723210000_launch_readiness_factory_link.sql
-- factory_id FK on launch_product_readiness + v_launch_po_product_lookup
-- exposes factory_id so it carries through as a real link, not just text
-- ============================================================
alter table public.launch_product_readiness
  add column if not exists factory_id uuid references public.factories(id) on delete set null;

create index if not exists launch_product_readiness_factory_idx
  on public.launch_product_readiness (factory_id);

create or replace view public.v_launch_po_product_lookup as
 SELECT h.id AS po_header_id,
    h.po_name,
    h.status AS po_status,
    h.order_date,
    h.req_ship_date,
    h.expected_arrival_date,
    h.date_bucket,
    h.is_new_product_po,
    h.wholesale_triggered,
    h.pdf_url,
    h.notes AS po_notes,
    h.internal_notes,
    f.factory_name,
    l.title_snapshot AS product_title,
    l.product_type_snapshot AS product_type,
    count(*) AS variant_count,
    sum(COALESCE(l.qty, 0))::integer AS total_units,
    sum(COALESCE(l.retail_value, COALESCE(l.qty, 0)::numeric * COALESCE(l.retail_price, 0::numeric))) AS total_retail_value,
    sum(COALESCE(l.qty, 0)::numeric * COALESCE(l.unit_cost, 0::numeric)) AS total_estimated_cost,
    min(l.retail_price) AS min_retail_price,
    max(l.retail_price) AS max_retail_price,
    string_agg(DISTINCT NULLIF(l.variant_title_snapshot, ''::text), ', '::text ORDER BY (NULLIF(l.variant_title_snapshot, ''::text))) AS variants,
    string_agg(DISTINCT NULLIF(l.sku_snapshot, ''::text), ', '::text ORDER BY (NULLIF(l.sku_snapshot, ''::text))) AS sample_skus,
    h.factory_id
   FROM po_lines l
     JOIN po_headers h ON h.id = l.po_header_id
     LEFT JOIN v_po_header_summary f ON f.id = h.id
  WHERE NULLIF(l.title_snapshot, ''::text) IS NOT NULL
  GROUP BY h.id, h.po_name, h.status, h.order_date, h.req_ship_date, h.expected_arrival_date, h.date_bucket, h.is_new_product_po, h.wholesale_triggered, h.pdf_url, h.notes, h.internal_notes, f.factory_name, l.title_snapshot, l.product_type_snapshot, h.factory_id;

alter view public.v_launch_po_product_lookup set (security_invoker = true);

-- ============================================================
-- 20260723220000_products_master_category_from_shopify.sql
-- category now mirrors Shopify's product_type -- one-time correction of
-- existing rows to match (superseding the prior product_tags-derived values)
-- ============================================================
update public.products_master
set category = product_type
where category is distinct from product_type;

-- ============================================================
-- 20260723230000_product_tracker_po_backfill.sql
-- backfill factory/type/eta/units on existing Pipeline items from matching
-- po_lines/po_headers data (blank fields only)
-- ============================================================
with matched as (
  select
    pt.id as tracker_id,
    (array_agg(h.factory_id order by h.order_date desc nulls last, h.created_at desc) filter (where h.factory_id is not null))[1] as factory_id,
    (array_agg(l.product_type_snapshot order by h.order_date desc nulls last, h.created_at desc) filter (where l.product_type_snapshot is not null and l.product_type_snapshot <> ''))[1] as product_type,
    (array_agg(h.expected_arrival_date order by h.order_date desc nulls last, h.created_at desc) filter (where h.expected_arrival_date is not null))[1] as bulk_eta,
    sum(coalesce(l.qty,0)) as total_qty
  from public.product_tracker pt
  join public.po_lines l on lower(trim(l.title_snapshot)) = lower(trim(pt.product_title))
  join public.po_headers h on h.id = l.po_header_id
  group by pt.id
)
update public.product_tracker pt
set
  factory_id = coalesce(pt.factory_id, matched.factory_id),
  manufacturer = coalesce(pt.manufacturer, f.factory_name),
  product_type = coalesce(nullif(pt.product_type,''), matched.product_type),
  bulk_eta = coalesce(pt.bulk_eta, matched.bulk_eta),
  expected_units = coalesce(pt.expected_units, nullif(matched.total_qty,0))
from matched
left join public.factories f on f.id = matched.factory_id
where matched.tracker_id = pt.id
  and (pt.factory_id is null or pt.product_type is null or pt.product_type='' or pt.bulk_eta is null or pt.expected_units is null or pt.manufacturer is null);

-- ============================================================
-- 20260723240000_products_master_surface_legacy_attributes_as_tags.sql
-- fold attributes jsonb legacy fields into tags[] so they're actually
-- visible in the Catalog tab (attributes had zero UI surface before this)
-- ============================================================
update public.products_master pm
set tags = (
  select array_agg(distinct t) from unnest(
    pm.tags || array_remove(ARRAY[
      pm.attributes->>'legacy_collection',
      pm.attributes->>'legacy_primary_color',
      pm.attributes->>'legacy_indicator_group',
      pm.attributes->>'legacy_artwork_side',
      pm.attributes->>'legacy_sub_tag'
    ], NULL)
  ) as t
)
where pm.attributes <> '{}'::jsonb;

-- ============================================================
-- 20260723250000_products_master_subcategory_department_from_tag_book.sql
-- subcategory <- legacy collection; department <- legacy indicator_group
-- (brand pillar). Blanks only; user-editable; sync never writes these.
-- ============================================================
with legacy as (
  select
    lower(trim(product_title)) as norm_title,
    (array_agg(collection order by uploaded_at desc nulls last) filter (where collection is not null and collection <> ''))[1] as collection,
    (array_agg(indicator_group order by uploaded_at desc nulls last) filter (where indicator_group is not null and indicator_group <> ''))[1] as indicator_group
  from public.product_tags
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  group by 1
)
update public.products_master pm
set subcategory = coalesce(pm.subcategory, l.collection),
    department  = coalesce(pm.department, l.indicator_group)
from legacy l
where pm.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and lower(trim(pm.product_title)) = l.norm_title
  and (pm.subcategory is null or pm.department is null);

-- ============================================================
-- 20260723260000_pair_historical_launch_products_with_tracker.sql
-- one-time pairing of pre-#300 launch products <-> Pipeline items, plus
-- creation of missing launch-side rows for launch-linked Pipeline items
-- ============================================================
update public.launch_product_readiness r
set product_tracker_id = t.id
from public.product_tracker t
where r.product_tracker_id is null
  and lower(trim(t.product_title)) = lower(trim(r.product_title))
  and (t.launch_id = r.launch_id or t.launch_id is null);

insert into public.launch_product_readiness (
  product_title, product_type, manufacturer, vendor_name, factory_id,
  bulk_eta, expected_units, launch_id, product_tracker_id,
  readiness_status, product_shot_status, copy_status, company_entity_id
)
select
  t.product_title, t.product_type, t.manufacturer, t.manufacturer, t.factory_id,
  t.bulk_eta, t.expected_units, t.launch_id, t.id,
  'not_reviewed', 'not_started', 'not_started', t.company_entity_id
from public.product_tracker t
where t.launch_id is not null
  and not exists (select 1 from public.launch_product_readiness r where r.product_tracker_id = t.id)
  and not exists (
    select 1 from public.launch_product_readiness r
    where r.launch_id = t.launch_id
      and lower(trim(r.product_title)) = lower(trim(t.product_title))
  );

-- ============================================================
-- 20260803160000_ar_company_entity_backfill.sql
-- stamp company_entity_id on AR sheet-sync rows inserted after the 2026-06
-- multi-tenant backfill (service-role inserts, no default — RLS hid them)
-- ============================================================
update public.ar_invoices i
set company_entity_id = e.id
from public.entities e
where e.entity_type = 'company'
  and e.entity_key = 'baseballism'
  and i.company_entity_id is null;

update public.ar_customers c
set company_entity_id = e.id
from public.entities e
where e.entity_type = 'company'
  and e.entity_key = 'baseballism'
  and c.company_entity_id is null;

-- ============================================================
-- 20260804000000_reviews_can_manage_self_service.sql
-- reviews_can_manage() no longer requires owner/executive/admin role --
-- true for any active SILO user. Per-row scoping (own reports vs.
-- sees-everyone) lives in each policy's own manager_user_id/is_exec_or_owner
-- clause, unchanged. See migration file for full rationale.
-- ============================================================
create or replace function public.reviews_can_manage()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
  );
$function$;

comment on function public.reviews_can_manage() is
  'True for any active SILO user (previously required owner/executive/admin role). The real per-row scoping -- own direct reports vs. sees-everyone -- lives in each policy''s own (manager_user_id = auth.uid() OR is_exec_or_owner()) clause, not here. Do not reintroduce a role check here without updating every caller''s intent.';
-- ============================================================
-- 20260804010000_employee_managers_multi_manager.sql
--
-- Performance Reviews assumed one manager per employee
-- (employees.manager_user_id, NOT NULL, single value), enforced by a
-- unique (company_entity_id, lower(email)) index -- so the same real
-- person could never be rostered under two managers at once (dual
-- reporting, e.g. Loomis AND Brett both needing to review the same
-- employee).
--
-- New public.employee_managers is the real many-to-many relationship:
-- one canonical employees row per person, N manager links. RLS on
-- employees/employee_goals moves from the single column to "does a
-- matching employee_managers row exist". reviews stays untouched --
-- each manager who runs a review for a shared employee creates and
-- owns their OWN reviews row (reviews.manager_user_id already worked
-- this way), except reviews_active_insert is tightened to verify the
-- inserting non-exec user is actually one of the employee's managers
-- (previously it only checked manager_user_id = auth.uid() with no
-- FK-backed relationship check at all -- a latent trust-the-client gap).
--
-- employees.manager_user_id is KEPT (still NOT NULL) as an
-- informational "who originally created this roster entry" marker and
-- as the bootstrap anchor for the first employee_managers self-link
-- (see the insert policy below) -- it is no longer read by any RLS
-- policy or app code as "the" manager. Do not reintroduce it as an
-- authorization source.
-- ============================================================

create table if not exists public.employee_managers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  manager_user_id uuid not null references public.profiles(id),
  company_entity_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (employee_id, manager_user_id)
);

create index if not exists employee_managers_employee_idx on public.employee_managers (employee_id);
create index if not exists employee_managers_manager_idx on public.employee_managers (manager_user_id);

-- Backfill: every existing employee's single manager becomes their first link.
insert into public.employee_managers (employee_id, manager_user_id, company_entity_id, created_by)
select id, manager_user_id, company_entity_id, manager_user_id
from public.employees
on conflict (employee_id, manager_user_id) do nothing;

comment on column public.employees.manager_user_id is
  'Informational only -- who originally created this roster entry. NOT the authorization source for who manages this employee; see employee_managers. Kept for the insert-policy bootstrap self-link and CSV/legacy display.';

-- Attribution + company-scoping safety nets, same pattern as every other table.
drop trigger if exists stamp_created_by on public.employee_managers;
create trigger stamp_created_by before insert on public.employee_managers
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

alter table public.employee_managers enable row level security;
revoke all on public.employee_managers from anon;

-- Any policy that runs an EXISTS subquery against employee_managers from
-- WITHIN a policy on employee_managers itself (or on employees/
-- employee_goals/reviews, which all need the same "is auth.uid() a
-- manager of this employee" check) re-triggers employee_managers' own RLS
-- on every access -- which does the same thing again. That's genuine
-- infinite recursion ("infinite recursion detected in policy for
-- relation"), not just deep nesting. A SECURITY DEFINER function bypasses
-- RLS on its own internal query (same mechanism as active_company_id() /
-- is_exec_or_owner() already used throughout this module -- table owners
-- are exempt from RLS unless FORCE ROW LEVEL SECURITY is set, which it
-- never is here), so it can safely answer the question without
-- re-entering any policy. Use this everywhere instead of a raw EXISTS
-- against employee_managers inside a policy definition.
create or replace function public.is_employee_manager(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.employee_managers em
    where em.employee_id = p_employee_id
      and em.manager_user_id = auth.uid()
  );
$function$;

revoke execute on function public.is_employee_manager(uuid) from public, anon;
grant execute on function public.is_employee_manager(uuid) to authenticated, service_role;

-- select: any manager already linked to this employee (co-managers can see
-- each other), or exec/owner.
drop policy if exists employee_managers_active_select on public.employee_managers;
create policy employee_managers_active_select on public.employee_managers for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or public.is_employee_manager(employee_managers.employee_id)
    )
  );

-- insert: exec/owner can link anyone to anyone; the employee's original
-- creator (employees.manager_user_id) can self-link as their own first
-- manager; any existing co-manager can add another co-manager (including
-- inviting a colleague to share the employee). No path lets an unrelated
-- user attach themselves to an employee they have no relationship to.
-- The creator-check subquery against `employees` is fine as a raw EXISTS
-- -- employees_active_select is itself recursion-safe (uses
-- is_employee_manager() below), so this doesn't loop back into
-- employee_managers' own policy.
drop policy if exists employee_managers_active_insert on public.employee_managers;
create policy employee_managers_active_insert on public.employee_managers for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (
        manager_user_id = auth.uid()
        and exists (
          select 1 from public.employees e
          where e.id = employee_managers.employee_id
            and e.manager_user_id = auth.uid()
        )
      )
      or public.is_employee_manager(employee_managers.employee_id)
    )
  );

-- delete: exec/owner can remove any link; a manager can remove their OWN
-- link (stop managing someone). Removing a co-manager's link is exec-only
-- -- avoids one manager silently cutting another's access.
drop policy if exists employee_managers_active_delete on public.employee_managers;
create policy employee_managers_active_delete on public.employee_managers for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- ---------------------------------------------------------------------------
-- employees: select/insert/update/delete move from the single column to the
-- join table. INSERT no longer requires anything beyond company membership
-- -- the accompanying employee_managers self-link (inserted right after,
-- client-side) is what actually grants the creator visibility/ownership.
-- ---------------------------------------------------------------------------

drop policy if exists employees_active_select on public.employees;
create policy employees_active_select on public.employees for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.is_employee_manager(employees.id)
      or public.is_exec_or_owner()
      or profile_id = auth.uid()
    )
  );

drop policy if exists employees_active_insert on public.employees;
create policy employees_active_insert on public.employees for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists employees_active_update on public.employees;
create policy employees_active_update on public.employees for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.is_employee_manager(employees.id) or public.is_exec_or_owner())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.is_employee_manager(employees.id) or public.is_exec_or_owner())
  );

drop policy if exists employees_active_delete on public.employees;
create policy employees_active_delete on public.employees for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.is_employee_manager(employees.id) or public.is_exec_or_owner())
  );

-- ---------------------------------------------------------------------------
-- employee_goals: same move, via the employees join.
-- ---------------------------------------------------------------------------

drop policy if exists employee_goals_write on public.employee_goals;
create policy employee_goals_write on public.employee_goals for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.is_exec_or_owner() or public.is_employee_manager(employee_goals.employee_id))
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.is_exec_or_owner() or public.is_employee_manager(employee_goals.employee_id))
  );

-- ---------------------------------------------------------------------------
-- reviews: unchanged review ownership model (each manager who runs a review
-- owns their own reviews row), but INSERT now verifies the non-exec caller
-- is actually a manager of the target employee -- previously it only
-- checked manager_user_id = auth.uid() with no relationship check at all.
-- ---------------------------------------------------------------------------

drop policy if exists reviews_active_insert on public.reviews;
create policy reviews_active_insert on public.reviews for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (
        manager_user_id = auth.uid()
        and public.is_employee_manager(reviews.employee_id)
      )
    )
  );

-- ============================================================
-- 20260804020000_employee_managers_creator_link_visibility.sql
--
-- employee_managers_active_insert's "creator self-link" branch did a raw
-- EXISTS subquery against employees to check "am I the recorded creator
-- of this employee". That subquery is itself subject to
-- employees_active_select, which requires is_employee_manager() (needs an
-- employee_managers row to already exist) OR is_exec_or_owner() OR
-- profile_id = auth.uid(). A brand-new employee has NO employee_managers
-- link yet -- that's exactly the row this insert is trying to create --
-- so the creator can't see their own just-inserted employees row via a
-- plain SELECT, the EXISTS returns empty, and the self-link insert's
-- WITH CHECK fails with "new row violates row-level security policy for
-- table employee_managers". This is NOT the infinite-recursion bug fixed
-- in 20260804010000 (different failure mode) -- it's a legitimate access
-- denial on a row that genuinely belongs to the caller, and it fully
-- blocked self-service employee creation for every non-exec user: the
-- employees row would insert fine, but the immediately-following
-- self-link insert (required for the creator to ever see the row again)
-- always failed.
--
-- Same fix pattern as is_employee_manager(): a SECURITY DEFINER function
-- bypasses RLS on its internal query, so it can answer "is auth.uid()
-- the recorded creator of this employee" without going through
-- employees_active_select at all.
--
-- Verified end-to-end under real RLS impersonation (role=authenticated +
-- a real auth.uid()): a non-exec user can create an employee, self-link,
-- add a second manager, and both managers can see the employee back.
-- ============================================================

create or replace function public.is_employee_creator(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and e.manager_user_id = auth.uid()
  );
$function$;

revoke execute on function public.is_employee_creator(uuid) from public, anon;
grant execute on function public.is_employee_creator(uuid) to authenticated, service_role;

drop policy if exists employee_managers_active_insert on public.employee_managers;
create policy employee_managers_active_insert on public.employee_managers for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (manager_user_id = auth.uid() and public.is_employee_creator(employee_managers.employee_id))
      or public.is_employee_manager(employee_managers.employee_id)
    )
  );

-- ============================================================
-- 20260804170000_payment_requests_insert_requires_active_company.sql
--
-- payment_requests_insert_own had no company check, while
-- payment_request_files_active_insert does (company_entity_id =
-- active_company_id()). A user in the signup->activation window (no
-- membership yet, so active_company_id() is NULL) could therefore insert
-- the parent request -- stamped with a NULL company, invisible to every
-- user in the app -- and then fail on the file rows with "new row
-- violates row-level security policy for table payment_request_files".
-- Each retry minted another invisible ghost request. Caught live
-- 2026-08-04: the first real member-tier user (marketing, new hire)
-- submitted a reimbursement 4 minutes before their membership was
-- granted; 6 ghost rows were cleaned up alongside this fix.
--
-- Requiring company_entity_id = active_company_id() here makes the FIRST
-- insert fail for a not-yet-activated account (immediate, no ghost data)
-- and is a no-op for every activated user: the stamp_company_entity_id
-- trigger fills the column from active_company_id() before RLS's WITH
-- CHECK runs. v2/purchase_request.html additionally shows a plain-language
-- "account not activated yet" message up front so users never reach the
-- RLS error at all.
--
-- Verified under real RLS impersonation: activated member-tier user's
-- request + file insert passes post-migration.
-- ============================================================

drop policy if exists payment_requests_insert_own on public.payment_requests;
create policy payment_requests_insert_own on public.payment_requests for insert to authenticated
  with check (
    auth.uid() is not null
    and company_entity_id = public.active_company_id()
    and (created_by = auth.uid() or created_by is null or public.current_user_can_manage_payment_requests())
  );

-- ============================================================
-- 20260804200000_admin_update_profile_executive_role.sql
--
-- admin_update_profile()'s role mapping only knew owner/admin -- every
-- other value the backend's Edit dialog offers (executive, member,
-- viewer, and formerly superadmin) was silently coerced to profile role
-- 'user', and the membership sync then set the target's
-- entity_membership to 'member'. Two live consequences, caught
-- 2026-08-04:
--   1. The backend could not actually grant the executive role at all --
--      "promote to executive" quietly produced user/member.
--   2. Attempting it stripped the person's admin membership as a side
--      effect, silently costing them profile-name visibility
--      (is_owner_admin), PO writes, and other membership-admin gates.
--      (Repaired by hand for the affected user alongside this fix.)
--
-- New mapping, covering exactly what the UI offers:
--   owner     -> profile owner,     membership owner_admin
--   admin     -> profile admin,     membership admin
--   executive -> profile executive, membership admin   (executive outranks
--                admin at the profile layer; membership admin preserves the
--                membership-level gates, matching existing executives)
--   member    -> profile user,      membership member
--   viewer    -> profile user,      membership viewer
--   user      -> profile user,      membership member  (legacy value)
-- Anything else now raises instead of silently coercing. 'superadmin'
-- (never a real role) removed from the backend dropdown.
-- ============================================================

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_name text default null,
  p_department text default null,
  p_role text default null,
  p_is_active boolean default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role_in text := lower(nullif(trim(coalesce(p_role, '')), ''));
  v_role app_role;
  v_membership_role text;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_has_other_org boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  if v_role_in is not null then
    case v_role_in
      when 'owner'     then v_role := 'owner';     v_membership_role := 'owner_admin';
      when 'admin'     then v_role := 'admin';     v_membership_role := 'admin';
      when 'executive' then v_role := 'executive'; v_membership_role := 'admin';
      when 'member'    then v_role := 'user';      v_membership_role := 'member';
      when 'viewer'    then v_role := 'user';      v_membership_role := 'viewer';
      when 'user'      then v_role := 'user';      v_membership_role := 'member';
      else raise exception 'unknown role %', p_role;
    end case;
  end if;

  v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = p_user_id and em.entity_id <> v_company_id
  ) into v_has_other_org;

  if v_has_other_org then
    update public.profiles
       set name = coalesce(p_name, name),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  else
    update public.profiles
       set name = coalesce(p_name, name),
           department = coalesce(p_department, department),
           role = coalesce(v_role, role),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  end if;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_final_active then
    if v_membership_role is not null then
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do update
        set role = excluded.role;
    else
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id,
              case v_final_role
                when 'owner' then 'owner_admin'
                when 'admin' then 'admin'
                when 'executive' then 'admin'
                else 'member'
              end)
      on conflict (entity_id, user_id) do nothing;
    end if;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

-- ============================================================
-- 20260805030000_ar_sync_status_v_restore_definer_read.sql
-- ============================================================

alter view public.ar_sync_status_v set (security_invoker = false);

-- ============================================================
-- 20260805040000_default_page_bootstrap_profile.sql
-- ============================================================

update public.profiles
   set default_page = '/v2/profile.html',
       updated_at = now()
 where default_page is distinct from '/v2/profile.html';

-- ============================================================
-- 20260805050000_profile_avatars.sql
-- ============================================================

alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace view public.payment_requests_v as
select
  pr.id,
  pr.vendor_name,
  pr.vendor_name_norm,
  pr.vendor_name_manual,
  pr.vendor_name_manual_norm,
  pr.request_type,
  pr.invoice_number,
  pr.flex_id,
  pr.internal_po_number,
  pr.amount_due,
  pr.due_date,
  pr.requester_email,
  pr.requester_email_norm,
  pr.location_name,
  pr.notes_comments,
  pr.file_name,
  pr.file_path,
  pr.file_url,
  pr.payment_type,
  pr.completed,
  pr.date_completed,
  pr.payment_detail,
  pr.workflow_status,
  pr.assigned_to,
  pr.internal_notes,
  pr.priority,
  pr.created_by,
  pr.updated_by,
  pr.submitted_at,
  pr.created_at,
  pr.updated_at,
  coalesce(nullif(pr.vendor_name_manual, ''), pr.vendor_name) as effective_vendor_name,
  coalesce(nullif(pr.vendor_name_manual_norm, ''), pr.vendor_name_norm) as effective_vendor_name_norm,
  p.name as assigned_to_name,
  p.email as assigned_to_email,
  pr.paid_notification_sent_at,
  pr.paid_notification_sent_by,
  p.avatar_url as assigned_to_avatar_url
from public.payment_requests pr
left join public.profiles p on p.id = pr.assigned_to;

alter view public.payment_requests_v set (security_invoker = true);

-- ============================================================
-- 20260805060000_mail_items_v_avatars.sql
-- ============================================================

create or replace view public.mail_items_v as
select
  mi.id,
  mi.company_entity_id,
  mi.subject,
  mi.sender,
  mi.document_type,
  mi.priority,
  mi.received_date,
  mi.due_date,
  mi.action_needed,
  mi.notes,
  mi.assigned_to,
  mi.processed_by,
  mi.submitted_by,
  mi.status,
  mi.legacy_submission_id,
  mi.legacy_source,
  mi.created_by,
  mi.updated_by,
  mi.created_at,
  mi.updated_at,
  assigned.name as assigned_to_name,
  assigned.email as assigned_to_email,
  submitted.name as submitted_by_name,
  submitted.email as submitted_by_email,
  processed.name as processed_by_name,
  processed.email as processed_by_email,
  assigned.avatar_url as assigned_to_avatar_url,
  submitted.avatar_url as submitted_by_avatar_url,
  processed.avatar_url as processed_by_avatar_url
from public.mail_items mi
left join public.profiles assigned on assigned.id = mi.assigned_to
left join public.profiles submitted on submitted.id = mi.submitted_by
left join public.profiles processed on processed.id = mi.processed_by;

alter view public.mail_items_v set (security_invoker = true);
-- ============================================================
-- 20260805070000_sales_comp_as_of_rpc.sql
--
-- Sales Performance Overview's "Comps as of" was locked to whatever the
-- nightly refresh_sales_verification_store_comp_summary() job last wrote --
-- a single snapshot row per store, overwritten every night, with no history
-- to pick a past date from. This adds a live, parameterized equivalent:
-- same Day/MTD/YTD-vs-prior-year math (mirrored exactly from that refresh
-- function -- same prior-year alignment via literal `interval '1 year'`,
-- same sales_by_day_verification_v source so the shopify_api-over-
-- better_reports dedup stays consistent), computed on demand for whatever
-- date the caller picks.
--
-- Deliberately NOT security definer: sales_by_day already has proper RLS
-- (`company_entity_id = active_company_id()`), so a plain function
-- querying it inherits that automatically. The explicit
-- `company_entity_id = active_company_id()` filter below is for query
-- performance/index use, not because RLS needs the help.
-- ============================================================

create or replace function public.sales_comp_as_of(p_as_of_date date)
returns table (
  location_tag text,
  as_of_date date,
  py_as_of_date date,
  cur_day_qty numeric, cur_day_net numeric, cur_day_total numeric, cur_day_discounts numeric,
  py_day_qty numeric, py_day_net numeric, py_day_total numeric, py_day_discounts numeric,
  cur_mtd_qty numeric, cur_mtd_net numeric, cur_mtd_total numeric, cur_mtd_discounts numeric,
  py_mtd_qty numeric, py_mtd_net numeric, py_mtd_total numeric, py_mtd_discounts numeric,
  cur_ytd_qty numeric, cur_ytd_net numeric, cur_ytd_total numeric, cur_ytd_discounts numeric,
  py_ytd_qty numeric, py_ytd_net numeric, py_ytd_total numeric, py_ytd_discounts numeric,
  day_total_var_pct numeric, mtd_total_var_pct numeric, ytd_total_var_pct numeric,
  day_net_var_pct numeric, mtd_net_var_pct numeric, ytd_net_var_pct numeric,
  day_qty_var_pct numeric, mtd_qty_var_pct numeric, ytd_qty_var_pct numeric,
  day_discounts_var_pct numeric, mtd_discounts_var_pct numeric, ytd_discounts_var_pct numeric,
  refreshed_at timestamptz
)
language sql
stable
set search_path to 'public'
as $function$
  with p as (
    select
      p_as_of_date as as_of_date,
      (p_as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', p_as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (p_as_of_date - interval '1 year'))::int,
        extract(month from p_as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', p_as_of_date)::date as cur_ytd_start,
      make_date(extract(year from (p_as_of_date - interval '1 year'))::int, 1, 1)::date as py_ytd_start
  ),
  base as (
    select
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts
    from public.sales_by_day_verification_v s
    where s.company_entity_id = active_company_id()
      and s.day_date <= (select as_of_date from p)
  ),
  locs as (
    select distinct location_tag from base
  ),
  day_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date = p.as_of_date group by location_tag
  ),
  day_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date = p.py_as_of_date group by location_tag
  ),
  mtd_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.cur_mtd_start and p.as_of_date group by location_tag
  ),
  mtd_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.py_mtd_start and p.py_as_of_date group by location_tag
  ),
  ytd_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.cur_ytd_start and p.as_of_date group by location_tag
  ),
  ytd_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.py_ytd_start and p.py_as_of_date group by location_tag
  )
  select
    l.location_tag,
    p.as_of_date, p.py_as_of_date,
    coalesce(dc.q,0), coalesce(dc.n,0), coalesce(dc.t,0), coalesce(dc.d,0),
    coalesce(dp.q,0), coalesce(dp.n,0), coalesce(dp.t,0), coalesce(dp.d,0),
    coalesce(mc.q,0), coalesce(mc.n,0), coalesce(mc.t,0), coalesce(mc.d,0),
    coalesce(mp.q,0), coalesce(mp.n,0), coalesce(mp.t,0), coalesce(mp.d,0),
    coalesce(yc.q,0), coalesce(yc.n,0), coalesce(yc.t,0), coalesce(yc.d,0),
    coalesce(yp.q,0), coalesce(yp.n,0), coalesce(yp.t,0), coalesce(yp.d,0),
    case when coalesce(dp.t,0)=0 then null else (coalesce(dc.t,0)-coalesce(dp.t,0))/nullif(dp.t,0) end,
    case when coalesce(mp.t,0)=0 then null else (coalesce(mc.t,0)-coalesce(mp.t,0))/nullif(mp.t,0) end,
    case when coalesce(yp.t,0)=0 then null else (coalesce(yc.t,0)-coalesce(yp.t,0))/nullif(yp.t,0) end,
    case when coalesce(dp.n,0)=0 then null else (coalesce(dc.n,0)-coalesce(dp.n,0))/nullif(dp.n,0) end,
    case when coalesce(mp.n,0)=0 then null else (coalesce(mc.n,0)-coalesce(mp.n,0))/nullif(mp.n,0) end,
    case when coalesce(yp.n,0)=0 then null else (coalesce(yc.n,0)-coalesce(yp.n,0))/nullif(yp.n,0) end,
    case when coalesce(dp.q,0)=0 then null else (coalesce(dc.q,0)-coalesce(dp.q,0))/nullif(dp.q,0) end,
    case when coalesce(mp.q,0)=0 then null else (coalesce(mc.q,0)-coalesce(mp.q,0))/nullif(mp.q,0) end,
    case when coalesce(yp.q,0)=0 then null else (coalesce(yc.q,0)-coalesce(yp.q,0))/nullif(yp.q,0) end,
    case when coalesce(dp.d,0)=0 then null else (coalesce(dc.d,0)-coalesce(dp.d,0))/nullif(dp.d,0) end,
    case when coalesce(mp.d,0)=0 then null else (coalesce(mc.d,0)-coalesce(mp.d,0))/nullif(mp.d,0) end,
    case when coalesce(yp.d,0)=0 then null else (coalesce(yc.d,0)-coalesce(yp.d,0))/nullif(yp.d,0) end,
    now()
  from locs l
  cross join p
  left join day_cur dc on dc.location_tag = l.location_tag
  left join day_py dp on dp.location_tag = l.location_tag
  left join mtd_cur mc on mc.location_tag = l.location_tag
  left join mtd_py mp on mp.location_tag = l.location_tag
  left join ytd_cur yc on yc.location_tag = l.location_tag
  left join ytd_py yp on yp.location_tag = l.location_tag
  order by l.location_tag;
$function$;

grant execute on function public.sales_comp_as_of(date) to authenticated;
-- ============================================================
-- 20260805080000_sales_comp_as_of_perf_fix.sql
--
-- sales_comp_as_of() was timing out in production (6.3s / 1.29M buffer
-- hits measured via EXPLAIN ANALYZE for a single date). Two compounding
-- causes:
--
-- 1. The `base` CTE was referenced by six separate downstream CTEs
--    (day_cur/day_py/mtd_cur/mtd_py/ytd_cur/ytd_py), and a plain (non-
--    materialized) CTE gets inlined and re-evaluated per reference in
--    modern Postgres -- so the expensive shopify_api-over-better_reports
--    anti-join in sales_by_day_verification_v ran six times, not once.
-- 2. `base` had no lower date bound (removed in the prior migration to
--    keep a since-defunct pop-up location, bld_houston, showing as a
--    zero row for historical dates) -- so each of those six scans covered
--    the entire multi-million-row sales history, not just the window
--    the comparison actually needs.
--
-- Fix: materialize `base` (computed once) and bound it to as_of_date -
-- ~2 years (covers day/mtd/ytd for the current year and the full prior
-- year needed for YTD comps, with a buffer), then collapse the six
-- GROUP BY passes into one using FILTER. Trade-off: a location with zero
-- activity in that ~2 year window (i.e. genuinely defunct, like
-- bld_houston, whose last sale was mid-2024) won't appear for a custom
-- date picked from before that window -- an acceptable cost for turning
-- a 6+ second query into a sub-second one.
-- ============================================================

create or replace function public.sales_comp_as_of(p_as_of_date date)
returns table (
  location_tag text,
  as_of_date date,
  py_as_of_date date,
  cur_day_qty numeric, cur_day_net numeric, cur_day_total numeric, cur_day_discounts numeric,
  py_day_qty numeric, py_day_net numeric, py_day_total numeric, py_day_discounts numeric,
  cur_mtd_qty numeric, cur_mtd_net numeric, cur_mtd_total numeric, cur_mtd_discounts numeric,
  py_mtd_qty numeric, py_mtd_net numeric, py_mtd_total numeric, py_mtd_discounts numeric,
  cur_ytd_qty numeric, cur_ytd_net numeric, cur_ytd_total numeric, cur_ytd_discounts numeric,
  py_ytd_qty numeric, py_ytd_net numeric, py_ytd_total numeric, py_ytd_discounts numeric,
  day_total_var_pct numeric, mtd_total_var_pct numeric, ytd_total_var_pct numeric,
  day_net_var_pct numeric, mtd_net_var_pct numeric, ytd_net_var_pct numeric,
  day_qty_var_pct numeric, mtd_qty_var_pct numeric, ytd_qty_var_pct numeric,
  day_discounts_var_pct numeric, mtd_discounts_var_pct numeric, ytd_discounts_var_pct numeric,
  refreshed_at timestamptz
)
language sql
stable
set search_path to 'public'
as $function$
  with p as (
    select
      p_as_of_date as as_of_date,
      (p_as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', p_as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (p_as_of_date - interval '1 year'))::int,
        extract(month from p_as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', p_as_of_date)::date as cur_ytd_start,
      make_date(extract(year from (p_as_of_date - interval '1 year'))::int, 1, 1)::date as py_ytd_start,
      (p_as_of_date - interval '2 years' - interval '15 days')::date as scan_floor
  ),
  base as materialized (
    select
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts
    from public.sales_by_day_verification_v s, p
    where s.company_entity_id = active_company_id()
      and s.day_date between p.scan_floor and p.as_of_date
  ),
  agg as (
    select
      b.location_tag,
      sum(b.qty)        filter (where b.day_date = p.as_of_date)                              as day_cur_q,
      sum(b.net_sales)  filter (where b.day_date = p.as_of_date)                              as day_cur_n,
      sum(b.total_sales) filter (where b.day_date = p.as_of_date)                             as day_cur_t,
      sum(b.discounts)  filter (where b.day_date = p.as_of_date)                              as day_cur_d,
      sum(b.qty)        filter (where b.day_date = p.py_as_of_date)                           as day_py_q,
      sum(b.net_sales)  filter (where b.day_date = p.py_as_of_date)                           as day_py_n,
      sum(b.total_sales) filter (where b.day_date = p.py_as_of_date)                          as day_py_t,
      sum(b.discounts)  filter (where b.day_date = p.py_as_of_date)                           as day_py_d,
      sum(b.qty)        filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_q,
      sum(b.net_sales)  filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_n,
      sum(b.total_sales) filter (where b.day_date between p.cur_mtd_start and p.as_of_date)   as mtd_cur_t,
      sum(b.discounts)  filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_d,
      sum(b.qty)        filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_q,
      sum(b.net_sales)  filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_n,
      sum(b.total_sales) filter (where b.day_date between p.py_mtd_start and p.py_as_of_date) as mtd_py_t,
      sum(b.discounts)  filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_d,
      sum(b.qty)        filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_q,
      sum(b.net_sales)  filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_n,
      sum(b.total_sales) filter (where b.day_date between p.cur_ytd_start and p.as_of_date)   as ytd_cur_t,
      sum(b.discounts)  filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_d,
      sum(b.qty)        filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_q,
      sum(b.net_sales)  filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_n,
      sum(b.total_sales) filter (where b.day_date between p.py_ytd_start and p.py_as_of_date) as ytd_py_t,
      sum(b.discounts)  filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_d
    from base b, p
    group by b.location_tag
  )
  select
    a.location_tag,
    p.as_of_date, p.py_as_of_date,
    coalesce(a.day_cur_q,0), coalesce(a.day_cur_n,0), coalesce(a.day_cur_t,0), coalesce(a.day_cur_d,0),
    coalesce(a.day_py_q,0),  coalesce(a.day_py_n,0),  coalesce(a.day_py_t,0),  coalesce(a.day_py_d,0),
    coalesce(a.mtd_cur_q,0), coalesce(a.mtd_cur_n,0), coalesce(a.mtd_cur_t,0), coalesce(a.mtd_cur_d,0),
    coalesce(a.mtd_py_q,0),  coalesce(a.mtd_py_n,0),  coalesce(a.mtd_py_t,0),  coalesce(a.mtd_py_d,0),
    coalesce(a.ytd_cur_q,0), coalesce(a.ytd_cur_n,0), coalesce(a.ytd_cur_t,0), coalesce(a.ytd_cur_d,0),
    coalesce(a.ytd_py_q,0),  coalesce(a.ytd_py_n,0),  coalesce(a.ytd_py_t,0),  coalesce(a.ytd_py_d,0),
    case when coalesce(a.day_py_t,0)=0 then null else (coalesce(a.day_cur_t,0)-a.day_py_t)/nullif(a.day_py_t,0) end,
    case when coalesce(a.mtd_py_t,0)=0 then null else (coalesce(a.mtd_cur_t,0)-a.mtd_py_t)/nullif(a.mtd_py_t,0) end,
    case when coalesce(a.ytd_py_t,0)=0 then null else (coalesce(a.ytd_cur_t,0)-a.ytd_py_t)/nullif(a.ytd_py_t,0) end,
    case when coalesce(a.day_py_n,0)=0 then null else (coalesce(a.day_cur_n,0)-a.day_py_n)/nullif(a.day_py_n,0) end,
    case when coalesce(a.mtd_py_n,0)=0 then null else (coalesce(a.mtd_cur_n,0)-a.mtd_py_n)/nullif(a.mtd_py_n,0) end,
    case when coalesce(a.ytd_py_n,0)=0 then null else (coalesce(a.ytd_cur_n,0)-a.ytd_py_n)/nullif(a.ytd_py_n,0) end,
    case when coalesce(a.day_py_q,0)=0 then null else (coalesce(a.day_cur_q,0)-a.day_py_q)/nullif(a.day_py_q,0) end,
    case when coalesce(a.mtd_py_q,0)=0 then null else (coalesce(a.mtd_cur_q,0)-a.mtd_py_q)/nullif(a.mtd_py_q,0) end,
    case when coalesce(a.ytd_py_q,0)=0 then null else (coalesce(a.ytd_cur_q,0)-a.ytd_py_q)/nullif(a.ytd_py_q,0) end,
    case when coalesce(a.day_py_d,0)=0 then null else (coalesce(a.day_cur_d,0)-a.day_py_d)/nullif(a.day_py_d,0) end,
    case when coalesce(a.mtd_py_d,0)=0 then null else (coalesce(a.mtd_cur_d,0)-a.mtd_py_d)/nullif(a.mtd_py_d,0) end,
    case when coalesce(a.ytd_py_d,0)=0 then null else (coalesce(a.ytd_cur_d,0)-a.ytd_py_d)/nullif(a.ytd_py_d,0) end,
    now()
  from agg a
  cross join p
  order by a.location_tag;
$function$;

-- 20260805090000_backfill_uncategorized_product_types.sql
-- Reclassify the two dominant "Uncategorized" buckets on sales_by_day
-- (Package Protection add-on + promo bundle/mystery-pack SKUs). Idempotent:
-- only touches rows where product_type is still null/blank.

UPDATE public.sales_by_day
SET product_type = 'Package Protection'
WHERE (product_type IS NULL OR trim(product_type) = '')
  AND lower(trim(sku)) = 'x-redo';

UPDATE public.sales_by_day
SET product_type = 'Bundles & Multi-Packs'
WHERE (product_type IS NULL OR trim(product_type) = '')
  AND (
    sku ILIKE '%bundle%' OR product_name ILIKE '%bundle%'
    OR sku ILIKE '%combo%' OR product_name ILIKE '%combo%'
    OR sku ILIKE '%mysterybox%' OR product_name ILIKE '%mystery box%' OR product_name ILIKE '%mystery pack%'
    OR sku ILIKE '%archivetoppack%' OR sku ILIKE '%archiveshortspack%'
    OR product_name ILIKE '%archive top pack%' OR product_name ILIKE '%archive shorts pack%'
    OR product_name ~* 'for \$\d'
  );

SELECT public.refresh_sales_monthly_rollup_mv();

-- 20260805100000_payment_request_melio_forward.sql
-- Forward payment requests to the Melio bill-pay inbox. Adds tracking
-- columns, surfaces them on payment_requests_v, and registers the new
-- 'forwarded_to_melio' activity type.

ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS melio_forwarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS melio_forwarded_by uuid REFERENCES public.profiles(id);

CREATE OR REPLACE VIEW public.payment_requests_v
WITH (security_invoker = true) AS
SELECT
  pr.id,
  pr.vendor_name,
  pr.vendor_name_norm,
  pr.vendor_name_manual,
  pr.vendor_name_manual_norm,
  pr.request_type,
  pr.invoice_number,
  pr.flex_id,
  pr.internal_po_number,
  pr.amount_due,
  pr.due_date,
  pr.requester_email,
  pr.requester_email_norm,
  pr.location_name,
  pr.notes_comments,
  pr.file_name,
  pr.file_path,
  pr.file_url,
  pr.payment_type,
  pr.completed,
  pr.date_completed,
  pr.payment_detail,
  pr.workflow_status,
  pr.assigned_to,
  pr.internal_notes,
  pr.priority,
  pr.created_by,
  pr.updated_by,
  pr.submitted_at,
  pr.created_at,
  pr.updated_at,
  COALESCE(NULLIF(pr.vendor_name_manual, ''), pr.vendor_name) AS effective_vendor_name,
  COALESCE(NULLIF(pr.vendor_name_manual_norm, ''), pr.vendor_name_norm) AS effective_vendor_name_norm,
  p.name AS assigned_to_name,
  p.email AS assigned_to_email,
  pr.paid_notification_sent_at,
  pr.paid_notification_sent_by,
  p.avatar_url AS assigned_to_avatar_url,
  pr.melio_forwarded_at,
  pr.melio_forwarded_by
FROM public.payment_requests pr
LEFT JOIN public.profiles p ON p.id = pr.assigned_to;

ALTER TABLE public.payment_request_activity
  DROP CONSTRAINT IF EXISTS payment_request_activity_activity_type_check;

ALTER TABLE public.payment_request_activity
  ADD CONSTRAINT payment_request_activity_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    'submitted',
    'status_changed',
    'assignment_changed',
    'priority_changed',
    'payment_type_changed',
    'completed_changed',
    'note_added',
    'file_opened',
    'file_uploaded',
    'notification_sent',
    'forwarded_to_melio',
    'updated'
  ]::text[]));

-- 20260807000000_ad_platform_direct_api.sql
-- Direct-API migration: per-platform connections straight to Google Ads,
-- Meta Ads, TikTok Ads, and GA4, replacing the Supermetrics middleman
-- (which never went live — zero rows). NOTE: this block intentionally runs
-- AFTER the 20260716000000 supermetrics block above and drops what it
-- created; that ordering mirrors the migration timeline.

create table if not exists public.ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  platform text not null check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4')),
  display_name text,
  is_active boolean not null default true,
  sync_enabled boolean not null default false,
  days_back integer not null default 30,

  access_token text,
  refresh_token text,
  token_expires_at timestamptz,

  google_customer_id text,
  google_login_customer_id text,
  ga4_property_id text,
  meta_ad_account_id text,
  tiktok_advertiser_id text,

  last_tested_at timestamptz,
  last_test_status text,
  last_test_success boolean,
  last_test_error text,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

-- No uniqueness constraint on (company, platform, account): the OAuth
-- callback inserts a fresh row per "Connect" click (account id is filled in
-- afterward by the admin, once, via the Integrations UI), and a company may
-- legitimately run more than one account per platform. Stale/duplicate rows
-- are an admin cleanup (Remove button), not a DB-level conflict.
create index if not exists idx_ad_platform_connections_company_platform
  on public.ad_platform_connections (company_entity_id, platform);

-- Temporary state table for the Google/TikTok OAuth CSRF handshake. Rows are
-- single-use and expire after 10 minutes (same pattern as
-- shopify_oauth_states). `platform` disambiguates google_ads vs ga4 (shared
-- Google OAuth client, different scope) and selects the TikTok vs Google
-- branch in the callback.
create table if not exists public.ad_platform_oauth_states (
  nonce             text primary key,
  company_entity_id uuid not null references public.entities(id),
  user_id           uuid not null references auth.users(id),
  platform          text not null check (platform in ('google_ads', 'ga4', 'tiktok_ads')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes')
);

alter table public.ad_platform_oauth_states enable row level security;
-- Only service role can read/write (callback uses service role key) —
-- no anon or authenticated policies needed, matching shopify_oauth_states.

alter table public.ad_platform_connections enable row level security;

drop policy if exists ad_platform_connections_active_select on public.ad_platform_connections;
create policy ad_platform_connections_active_select
  on public.ad_platform_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists ad_platform_connections_admin_write on public.ad_platform_connections;
create policy ad_platform_connections_admin_write
  on public.ad_platform_connections for all
  to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

drop trigger if exists stamp_created_by on public.ad_platform_connections;
create trigger stamp_created_by
  before insert on public.ad_platform_connections
  for each row execute function public.stamp_created_by();

-- marketing_kpis_daily now points at ad_platform_connections. Table itself
-- (created by 20260716000000_supermetrics_kpis.sql) is kept — only its
-- connection FK and default source change. Detach any rows still pointing
-- at supermetrics_connections (demo_seed placeholders) or the FK add fails.
update public.marketing_kpis_daily set connection_id = null
  where connection_id is not null
    and not exists (select 1 from public.ad_platform_connections c
                    where c.id = marketing_kpis_daily.connection_id);

alter table public.marketing_kpis_daily
  drop constraint if exists marketing_kpis_daily_connection_id_fkey;
alter table public.marketing_kpis_daily
  add constraint marketing_kpis_daily_connection_id_fkey
  foreign key (connection_id) references public.ad_platform_connections(id) on delete set null;
alter table public.marketing_kpis_daily
  alter column source drop default;
alter table public.marketing_kpis_daily
  alter column source set default 'google_ads_api';

drop table if exists public.supermetrics_connections cascade;

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis'
  ));

-- ============================================================
-- 20260807120000_tiktok_live_schedule.sql
-- TikTok Live schedule/claim board (/v2/live-schedule.html).
-- One live at a time company-wide via the unique index on
-- (company_entity_id, slot_start); finalize links the auto-created
-- payment_requests row. See the migration file for the full rationale.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id uuid REFERENCES public.entities(id),

  slot_start timestamptz NOT NULL,
  live_location text,
  notes text,

  claimed_by uuid NOT NULL REFERENCES public.profiles(id),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'finalized')),

  -- Close-out (finalize) fields
  gross_sales numeric(14,2),
  commission_rate numeric(6,4) NOT NULL DEFAULT 0.03,
  commission_amount numeric(14,2),
  payee_name text,
  payment_request_id uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  finalized_at timestamptz,

  created_by uuid REFERENCES public.profiles(id),
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live at a time, company-wide (see header note about loosening later).
CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_company_slot_key
  ON public.live_sessions (company_entity_id, slot_start);

CREATE INDEX IF NOT EXISTS live_sessions_claimed_by_idx
  ON public.live_sessions (claimed_by);
CREATE INDEX IF NOT EXISTS live_sessions_company_status_idx
  ON public.live_sessions (company_entity_id, status);

-- Enriched view for the board UI (claimer name/email/avatar).
CREATE OR REPLACE VIEW public.live_sessions_v
WITH (security_invoker = true) AS
SELECT
  ls.*,
  claimer.name AS claimed_by_name,
  claimer.email AS claimed_by_email,
  claimer.avatar_url AS claimed_by_avatar_url
FROM public.live_sessions ls
LEFT JOIN public.profiles claimer ON claimer.id = ls.claimed_by;

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_sessions_active_select" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_insert" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_update" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_delete" ON public.live_sessions;

CREATE POLICY "live_sessions_active_select" ON public.live_sessions
  FOR SELECT USING (company_entity_id = active_company_id());

-- Claim your own slot; admins may also assign a slot to someone else
-- (the sheet's "Assigned to / Claimed by" column).
CREATE POLICY "live_sessions_active_insert" ON public.live_sessions
  FOR INSERT WITH CHECK (
    company_entity_id = active_company_id()
    AND (claimed_by = auth.uid() OR is_admin_user())
  );

CREATE POLICY "live_sessions_active_update" ON public.live_sessions
  FOR UPDATE
  USING (
    company_entity_id = active_company_id()
    AND (claimed_by = auth.uid() OR is_admin_user())
  )
  WITH CHECK (company_entity_id = active_company_id());

-- Unclaim: claimer while still 'claimed'; admins can release anything.
CREATE POLICY "live_sessions_active_delete" ON public.live_sessions
  FOR DELETE USING (
    company_entity_id = active_company_id()
    AND ((claimed_by = auth.uid() AND status = 'claimed') OR is_admin_user())
  );

-- Attribution + company-scoping safety nets (same pattern as every
-- other table — see stamp_created_by / stamp_company_entity_id).
DROP TRIGGER IF EXISTS stamp_created_by ON public.live_sessions;
CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.live_sessions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by();

SELECT public.attach_stamp_company_entity_id_triggers();

-- ============================================================
-- 20260807150000_live_schedule_payroll_payout.sql
-- Live hosts are W-2: payouts file as 'payroll_payment' and pay
-- $25/hour per slot on top of the 3% commission. See migration file.
-- ============================================================

alter table public.payment_requests
  drop constraint if exists payment_requests_request_type_check;

alter table public.payment_requests
  add constraint payment_requests_request_type_check
  check (request_type in (
    'invoice_vendor_payment',
    'inventory_deposit',
    'inventory_balance',
    'inventory_freight',
    'employee_reimbursement',
    'customer_refund',
    'payroll_payment'
  ));

alter table public.live_sessions
  add column if not exists hourly_rate numeric(8,2) not null default 25.00;

alter table public.live_sessions
  add column if not exists payout_total numeric(14,2);

-- live_sessions_v is `select ls.*` so the new columns should flow through,
-- but a view's column list is frozen at creation — and since ls.* places
-- the new columns BEFORE the claimer fields, create-or-replace would fail
-- (it only allows appending at the end). Drop and recreate.
drop view if exists public.live_sessions_v;
create view public.live_sessions_v
with (security_invoker = true) as
select
  ls.*,
  claimer.name as claimed_by_name,
  claimer.email as claimed_by_email,
  claimer.avatar_url as claimed_by_avatar_url
from public.live_sessions ls
left join public.profiles claimer on claimer.id = ls.claimed_by;

-- ============================================================
-- 20260810120000_org_calendar.sql
-- Organization Calendar V1: calendar_events (manual events, RLS) +
-- calendar_events_v (security_invoker UNION projection over launches,
-- campaign sends, task/mail/AP due dates, PO ship/arrival, paydays,
-- live slots). See migration file + docs/ops/org-calendar.md.
-- ============================================================

-- =============================================================================
-- Organization Calendar (V1 foundation)
--
-- Hybrid architecture (see docs/ops/org-calendar.md):
--   1. calendar_events — a real table for MANUAL events only (meetings,
--      holidays, deadlines, milestones). Manual events are the only dates
--      with no other system of record.
--   2. calendar_events_v — a security_invoker UNION ALL view that projects
--      system-generated dates from their source tables into one standard
--      event contract. Sources stay authoritative; nothing is copied.
--
-- Security model: because the view is security_invoker, every branch runs
-- under the caller's own RLS. A member-tier user gets no po_headers or
-- payment_requests rows, a non-finance user gets no payroll rows, private
-- launch_tasks stay private — with zero calendar-specific ACL code. The
-- calendar can never show more than the source tool does.
--
-- Query contract: clients MUST range-bound on start_on
--   (.gte('start_on', from).lte('start_on', to)); the date predicate pushes
-- down into each UNION branch and hits the indexes created below.
-- =============================================================================

-- ── 1. Manual events table ──────────────────────────────────────────────────

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  title text not null,
  description text,
  -- Manual taxonomy only; system events get their type from the view.
  event_type text not null default 'company_event'
    check (event_type in ('company_event', 'meeting', 'holiday', 'deadline', 'milestone')),
  start_on date not null,
  end_on date,                -- inclusive; null = single-day event
  start_time time,            -- null = all-day
  location text,
  url text,                   -- optional external link (agenda doc, zoom, …)
  -- company  = every active member of the company
  -- finance  = AP-manager tier (admin membership or finance/admin/exec dept)
  -- private  = creator only
  visibility text not null default 'company'
    check (visibility in ('company', 'finance', 'private')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_events_range_check check (end_on is null or end_on >= start_on)
);

create index if not exists calendar_events_company_start_idx
  on public.calendar_events (company_entity_id, start_on);
-- Multi-day events are found by their end date too.
create index if not exists calendar_events_company_end_idx
  on public.calendar_events (company_entity_id, end_on)
  where end_on is not null;

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_active_select on public.calendar_events;
create policy calendar_events_active_select on public.calendar_events
  for select using (
    company_entity_id = active_company_id()
    and (
      visibility = 'company'
      or (visibility = 'finance' and current_user_can_manage_payment_requests())
      or (visibility = 'private' and created_by = auth.uid())
    )
  );

-- Any active company member may create events (stamp triggers fill
-- company_entity_id / created_by before the WITH CHECK runs).
drop policy if exists calendar_events_active_insert on public.calendar_events;
create policy calendar_events_active_insert on public.calendar_events
  for insert with check (company_entity_id = active_company_id());

drop policy if exists calendar_events_active_update on public.calendar_events;
create policy calendar_events_active_update on public.calendar_events
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_admin_user())
  )
  with check (company_entity_id = active_company_id());

drop policy if exists calendar_events_active_delete on public.calendar_events;
create policy calendar_events_active_delete on public.calendar_events
  for delete using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_admin_user())
  );

-- updated_at maintenance (same shape as product_tracker_updated_at).
create or replace function public.calendar_events_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists calendar_events_touch_updated_at on public.calendar_events;
create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.calendar_events_touch_updated_at();

-- Attribution + company-scoping safety nets (standard pattern).
drop trigger if exists stamp_created_by on public.calendar_events;
create trigger stamp_created_by before insert on public.calendar_events
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

-- ── 2. Source-date indexes for the projection branches ──────────────────────
-- (po_headers.order_date is already indexed; live_sessions has the unique
--  (company_entity_id, slot_start) index.)

create index if not exists launch_calendar_company_launch_date_idx
  on public.launch_calendar (company_entity_id, launch_date);
create index if not exists launch_channel_items_company_sched_idx
  on public.launch_channel_items (company_entity_id, scheduled_date);
create index if not exists launch_tasks_company_due_idx
  on public.launch_tasks (company_entity_id, due_date)
  where due_date is not null;
create index if not exists po_headers_company_ship_idx
  on public.po_headers (company_entity_id, req_ship_date)
  where req_ship_date is not null;
create index if not exists po_headers_company_arrival_idx
  on public.po_headers (company_entity_id, expected_arrival_date)
  where expected_arrival_date is not null;
create index if not exists payment_requests_company_due_idx
  on public.payment_requests (company_entity_id, due_date)
  where due_date is not null;
create index if not exists payroll_import_batches_company_check_idx
  on public.payroll_import_batches (company_entity_id, check_date)
  where check_date is not null;
create index if not exists mail_items_company_due_idx
  on public.mail_items (company_entity_id, due_date)
  where due_date is not null;

-- ── 3. The organization calendar projection ─────────────────────────────────
--
-- One row per calendar-worthy date. Standard contract (every branch must
-- emit every column, same order, same types):
--   event_id     text   '<source_type>:<uuid>' — stable + unique
--   source_type  text   manual | launch | launch_channel_item | launch_task
--                       | po | payment_request | payroll_batch
--                       | live_session | mail_item
--   source_id    uuid   PK of the source row
--   event_type   text   taxonomy leaf (launch, payment_due, po_arrival, …)
--   category     text   product | supply_chain | finance | people
--                       | operations | company
--   title/detail text
--   start_on     date   the calendar day (range queries bind on this)
--   end_on       date   inclusive; null = single-day
--   start_time   time   null = all-day
--   all_day      bool
--   status       text   source status verbatim
--   amount       numeric only where source RLS already gates it (AP due)
--   owner_id     uuid   assignee / claimer / creator where meaningful
--   url          text   deep link into the source tool
--   source_label text
--   company_entity_id uuid
--
-- Timezone note: all-day sources are plain `date` columns, projected as-is.
-- The one timed source (live_sessions.slot_start, timestamptz UTC) is
-- rendered in Pacific time — the anchor zone the live slot grid is designed
-- around. If a company ever needs a different home zone, swap the constant
-- for an entities.meta lookup here (single point of change).

drop view if exists public.calendar_events_v;
create view public.calendar_events_v
with (security_invoker = true) as

-- Manual events -------------------------------------------------------------
select
  'manual:' || ce.id::text                       as event_id,
  'manual'                                       as source_type,
  ce.id                                          as source_id,
  ce.event_type                                  as event_type,
  case ce.event_type
    when 'deadline'  then 'finance'
    when 'milestone' then 'operations'
    else 'company'
  end                                            as category,
  ce.title                                       as title,
  coalesce(ce.description, ce.location)          as detail,
  ce.start_on                                    as start_on,
  ce.end_on                                      as end_on,
  ce.start_time                                  as start_time,
  (ce.start_time is null)                        as all_day,
  ce.visibility                                  as status,
  null::numeric                                  as amount,
  ce.created_by                                  as owner_id,
  ce.url                                         as url,
  'Org Calendar'                                 as source_label,
  ce.company_entity_id                           as company_entity_id
from public.calendar_events ce

union all

-- Product launches ----------------------------------------------------------
select
  'launch:' || lc.id::text,
  'launch',
  lc.id,
  'launch',
  'product',
  lc.title,
  nullif(concat_ws(' · ', nullif(lc.launch_type, ''), nullif(lc.designer, '')), ''),
  lc.launch_date,
  null::date,
  nullif(lc.launch_time, '00:00:00'::time),
  (lc.launch_time is null or lc.launch_time = '00:00:00'::time),
  lc.status,
  null::numeric,
  lc.created_by,
  '/v2/launch-calendar.html?launch=' || lc.id::text,
  'Launch Workbench',
  lc.company_entity_id
from public.launch_calendar lc
where lc.launch_date is not null

union all

-- Campaign sends (email/SMS initiatives) ------------------------------------
select
  'campaign:' || ci.id::text,
  'launch_channel_item',
  ci.id,
  'campaign_send',
  'product',
  coalesce(nullif(ci.item_title, ''), initcap(coalesce(ci.channel, 'campaign')) || ' send'),
  nullif(concat_ws(' · ', upper(nullif(ci.channel, '')), lc.title), ''),
  ci.scheduled_date,
  null::date,
  nullif(ci.scheduled_time, '00:00:00'::time),
  (ci.scheduled_time is null or ci.scheduled_time = '00:00:00'::time),
  ci.status,
  null::numeric,
  null::uuid,
  case when ci.launch_id is null then '/v2/launch-calendar.html'
       else '/v2/launch-calendar.html?launch=' || ci.launch_id::text end,
  'Launch Workbench',
  ci.company_entity_id
from public.launch_channel_items ci
left join public.launch_calendar lc on lc.id = ci.launch_id
where ci.scheduled_date is not null

union all

-- Open task deadlines (RLS already hides other users' private tasks) --------
select
  'task:' || t.id::text,
  'launch_task',
  t.id,
  'task_due',
  'operations',
  t.task_title,
  nullif(concat_ws(' · ', nullif(t.assigned_to_name, ''), lc.title), ''),
  t.due_date,
  null::date,
  null::time,
  true,
  t.status,
  null::numeric,
  t.assigned_to_user_id,
  '/v2/tasks.html',
  'Task Manager',
  t.company_entity_id
from public.launch_tasks t
left join public.launch_calendar lc on lc.id = t.launch_id
where t.due_date is not null
  and t.status is distinct from 'done'

union all

-- PO requested ship dates (active POs; RLS: admins + creator only) ----------
select
  'po_ship:' || ph.id::text,
  'po',
  ph.id,
  'po_ship',
  'supply_chain',
  ph.po_name,
  nullif(concat_ws(' · ', f.factory_name, 'Requested ship'), ''),
  ph.req_ship_date,
  null::date,
  null::time,
  true,
  ph.status,
  null::numeric,
  null::uuid,
  '/v2/po-builder.html?po_id=' || ph.id::text,
  'PO Builder',
  ph.company_entity_id
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
where ph.req_ship_date is not null
  and ph.status not in ('Draft', 'Cancelled')

union all

-- PO expected arrivals ------------------------------------------------------
select
  'po_arrival:' || ph.id::text,
  'po',
  ph.id,
  'po_arrival',
  'supply_chain',
  ph.po_name,
  nullif(concat_ws(' · ', f.factory_name, 'Expected arrival'), ''),
  ph.expected_arrival_date,
  null::date,
  null::time,
  true,
  ph.status,
  null::numeric,
  null::uuid,
  '/v2/po-builder.html?po_id=' || ph.id::text,
  'PO Builder',
  ph.company_entity_id
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
where ph.expected_arrival_date is not null
  and ph.status not in ('Draft', 'Cancelled')

union all

-- Open vendor payments due (RLS: AP managers + own requests) ----------------
select
  'ap:' || pr.id::text,
  'payment_request',
  pr.id,
  'payment_due',
  'finance',
  coalesce(nullif(pr.vendor_name, ''), 'Payment request'),
  nullif(concat_ws(' · ',
    case when pr.invoice_number is not null and pr.invoice_number <> ''
         then 'Inv ' || pr.invoice_number end,
    nullif(pr.request_type, '')), ''),
  pr.due_date,
  null::date,
  null::time,
  true,
  coalesce(nullif(pr.workflow_status, ''), 'open'),
  pr.amount_due,
  pr.assigned_to,
  '/v2/request_manager.html',
  'Request Manager',
  pr.company_entity_id
from public.payment_requests pr
where pr.due_date is not null
  and coalesce(pr.completed, false) = false

union all

-- Paydays (RLS: admins + finance department only) ---------------------------
select
  'payroll:' || pb.id::text,
  'payroll_batch',
  pb.id,
  'payroll_payday',
  'finance',
  'Payroll payday',
  nullif(pb.batch_name, ''),
  pb.check_date,
  null::date,
  null::time,
  true,
  'scheduled',
  null::numeric,
  null::uuid,
  '/payroll.html',
  'Payroll',
  pb.company_entity_id
from public.payroll_import_batches pb
where pb.check_date is not null

union all

-- Claimed TikTok Live slots (timed; slot_start is UTC → shown in Pacific) ---
select
  'live:' || ls.id::text,
  'live_session',
  ls.id,
  'live_session',
  'operations',
  'TikTok Live — ' || coalesce(nullif(p.name, ''), nullif(ls.payee_name, ''), 'claimed slot'),
  nullif(ls.live_location, ''),
  (ls.slot_start at time zone 'America/Los_Angeles')::date,
  null::date,
  (ls.slot_start at time zone 'America/Los_Angeles')::time,
  false,
  ls.status,
  null::numeric,
  ls.claimed_by,
  '/v2/live-schedule.html',
  'Live Schedule',
  ls.company_entity_id
from public.live_sessions ls
left join public.profiles p on p.id = ls.claimed_by

union all

-- Open mailroom action deadlines --------------------------------------------
select
  'mail:' || mi.id::text,
  'mail_item',
  mi.id,
  'mail_due',
  'operations',
  mi.subject,
  nullif(concat_ws(' · ', nullif(mi.sender, ''), nullif(mi.action_needed, '')), ''),
  mi.due_date,
  null::date,
  null::time,
  true,
  mi.status,
  null::numeric,
  mi.assigned_to,
  '/v2/mailroom.html?item=' || mi.id::text,
  'Mailroom',
  mi.company_entity_id
from public.mail_items mi
where mi.due_date is not null
  and mi.status = 'open';

-- 20260810230000_marketing_mer_view.sql
-- Ledger MER view: blended paid ad spend x Shopify online net revenue per
-- company per day. See the migration file header for rationale.

create or replace view public.v_marketing_mer_daily
with (security_invoker = true) as
with spend as (
  select
    company_entity_id,
    day_date,
    sum(spend) as ad_spend,
    sum(conversions) as platform_conversions,
    sum(conversion_value) as platform_conv_value
  from public.marketing_kpis_daily
  where platform <> 'ga4'
  group by 1, 2
),
online_rev as (
  select
    s.company_entity_id,
    s.day_date,
    sum(s.total_net_sales) as online_net_sales,
    -- sales_by_day is one row per ORDER LINE (order x SKU; total_orders=1 on
    -- sale rows), so this sum counts lines, not distinct orders (~2.8 SKUs
    -- per order baseline, ~6x during sales). True order counts are not
    -- derivable from this table's grain -- named accordingly.
    sum(s.total_orders) as online_order_lines
  from public.sales_by_day s
  join public.locations l
    on l.company_entity_id = s.company_entity_id
   and l.store_type = 'online'
   -- slugify(), in SQL: lowercase, non-alphanumeric runs -> '_', trim '_'
   and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code, ''), l.location_name)), '[^a-z0-9]+', '_', 'g'), '_'), '')
       = s.location_tag
  group by 1, 2
)
select
  coalesce(sp.company_entity_id, r.company_entity_id) as company_entity_id,
  coalesce(sp.day_date, r.day_date) as day_date,
  coalesce(sp.ad_spend, 0) as ad_spend,
  coalesce(sp.platform_conversions, 0) as platform_conversions,
  coalesce(sp.platform_conv_value, 0) as platform_conv_value,
  coalesce(r.online_net_sales, 0) as online_net_sales,
  coalesce(r.online_order_lines, 0) as online_order_lines
from spend sp
full outer join online_rev r
  on r.company_entity_id = sp.company_entity_id
 and r.day_date = sp.day_date;

-- 20260811000000_meta_ad_creative_performance.sql
-- Meta ad-level performance + creative metadata (see migration header).

create table if not exists public.meta_ad_performance_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  account_id text,
  day_date date not null,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text not null,
  ad_name text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14,2) not null default 0,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  row_hash text not null unique,
  source text not null default 'meta_ads_api',
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create index if not exists idx_meta_ad_perf_co_day
  on public.meta_ad_performance_daily (company_entity_id, day_date);
create index if not exists idx_meta_ad_perf_co_ad_day
  on public.meta_ad_performance_daily (company_entity_id, ad_id, day_date);

create table if not exists public.meta_ad_creatives (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  ad_id text not null,
  account_id text,
  ad_name text,
  campaign_id text,
  adset_id text,
  effective_status text,
  creative_id text,
  thumbnail_url text,
  body text,
  title text,
  object_type text,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, ad_id)
);

alter table public.meta_ad_performance_daily enable row level security;
alter table public.meta_ad_creatives enable row level security;

drop policy if exists meta_ad_performance_daily_active_select on public.meta_ad_performance_daily;
create policy meta_ad_performance_daily_active_select
  on public.meta_ad_performance_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists meta_ad_creatives_active_select on public.meta_ad_creatives;
create policy meta_ad_creatives_active_select
  on public.meta_ad_creatives for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- 20260811120000_meta_funnel_events.sql
-- Meta full-funnel columns (view_content/add_to_cart/initiate_checkout)
-- on marketing_kpis_daily + meta_ad_performance_daily. See migration header.

alter table public.marketing_kpis_daily
  add column if not exists view_content bigint,
  add column if not exists add_to_cart bigint,
  add column if not exists initiate_checkout bigint;

alter table public.meta_ad_performance_daily
  add column if not exists view_content bigint,
  add column if not exists add_to_cart bigint,
  add column if not exists initiate_checkout bigint;

-- 20260812000000_meta_organic_insights.sql
-- Organic Instagram + Facebook Page insights. See migration header.

alter table public.ad_platform_connections
  add column if not exists facebook_page_id text,
  add column if not exists instagram_business_account_id text;

create table if not exists public.instagram_media_insights (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  media_id text not null,
  media_type text,
  caption text,
  permalink text,
  thumbnail_url text,
  posted_at timestamptz,
  views bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saved bigint,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, media_id)
);

create index if not exists idx_ig_media_insights_co_posted
  on public.instagram_media_insights (company_entity_id, posted_at desc);

create table if not exists public.facebook_page_insights_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  day_date date not null,
  page_impressions bigint,
  page_reach bigint,
  page_engaged_users bigint,
  page_post_engagements bigint,
  page_fan_count bigint,
  row_hash text not null unique,
  synced_at timestamptz not null default now()
);

create index if not exists idx_fb_page_insights_co_day
  on public.facebook_page_insights_daily (company_entity_id, day_date);

alter table public.instagram_media_insights enable row level security;
alter table public.facebook_page_insights_daily enable row level security;

drop policy if exists instagram_media_insights_active_select on public.instagram_media_insights;
create policy instagram_media_insights_active_select
  on public.instagram_media_insights for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists facebook_page_insights_daily_active_select on public.facebook_page_insights_daily;
create policy facebook_page_insights_daily_active_select
  on public.facebook_page_insights_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- ============================================================
-- 20260812000000_product_sample_tracker_links.sql
-- Many-to-many sample <-> pipeline item links (a sample can now
-- attach to more than one product_tracker row)
-- ============================================================

create table if not exists public.product_sample_tracker_links (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid,
  sample_id          uuid not null references public.product_samples(id) on delete cascade,
  tracker_id         uuid not null references public.product_tracker(id) on delete cascade,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  unique (sample_id, tracker_id)
);

create index if not exists product_sample_tracker_links_sample_idx  on public.product_sample_tracker_links (sample_id);
create index if not exists product_sample_tracker_links_tracker_idx on public.product_sample_tracker_links (tracker_id);

insert into public.product_sample_tracker_links (company_entity_id, sample_id, tracker_id)
select s.company_entity_id, s.id, s.tracker_id
from public.product_samples s
where s.tracker_id is not null
on conflict (sample_id, tracker_id) do nothing;

drop trigger if exists stamp_created_by on public.product_sample_tracker_links;
create trigger stamp_created_by before insert on public.product_sample_tracker_links
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

alter table public.product_sample_tracker_links enable row level security;
revoke all on public.product_sample_tracker_links from anon;

drop policy if exists product_sample_tracker_links_active_select on public.product_sample_tracker_links;
create policy product_sample_tracker_links_active_select on public.product_sample_tracker_links
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists product_sample_tracker_links_active_write on public.product_sample_tracker_links;
create policy product_sample_tracker_links_active_write on public.product_sample_tracker_links
  for all to authenticated
  using      (company_entity_id = public.active_company_id() and public.po_builder_can_write())
  with check (company_entity_id = public.active_company_id() and public.po_builder_can_write());

-- 20260812120000_redo_returns_integration.sql
-- Redo returns integration, phase 1: webhook-driven ingestion of Redo return
-- data (refund / exchange / store-credit dollar amounts) so the BI-vs-Shopify
-- variance noted in docs/ops/bugs.md ("Redo exchange/store-credit returns
-- with $0 refund subtotals") can be reconciled against real numbers instead
-- of inferred from Shopify's own refund records, which only ever see the
-- `refund` slice of a Redo return -- exchanges and store credit settle
-- entirely inside Redo.
--
-- Ingestion is push-based: Redo's "Return event" webhook POSTs the full
-- return object (same shape as GET /returns/{id}) on every status change,
-- delivered in order per return, retried on non-2xx. That's simpler and
-- more current than polling, so there is no GitHub Action here -- the
-- redo-webhook edge function (deployed separately, see
-- docs/ops/redo-integration.md) is the entire pipeline.

-- redo_connections: one row per company. api_secret is the REDO_API_SECRET
-- (Bearer token Redo issues for calling api.getredo.com -- not used by the
-- webhook path itself, kept for a future GET /returns/{id} backfill/verify
-- script). webhook_secret is generated by SILO and pasted into Redo's
-- per-store webhook config; the edge function checks incoming
-- `Authorization: Bearer <webhook_secret>` against this column to confirm
-- the request actually came from that company's Redo store.
create table if not exists public.redo_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  display_name text,
  is_active boolean not null default true,

  api_secret text,
  webhook_secret text,

  last_event_at timestamptz,
  last_event_type text,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

-- One Redo store account per company (unlike ad_platform_connections, which
-- allows multiple ad accounts per platform) -- Redo's API secret already
-- scopes to a single store, so a second row would just be a duplicate.
create unique index if not exists idx_redo_connections_company
  on public.redo_connections (company_entity_id);

alter table public.redo_connections enable row level security;
revoke all on public.redo_connections from anon;

drop policy if exists redo_connections_active_select on public.redo_connections;
create policy redo_connections_active_select
  on public.redo_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists redo_connections_admin_write on public.redo_connections;
create policy redo_connections_admin_write
  on public.redo_connections for all
  to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

drop trigger if exists stamp_created_by on public.redo_connections;
create trigger stamp_created_by
  before insert on public.redo_connections
  for each row execute function public.stamp_created_by();

-- redo_returns: one row per Redo return, upserted on every webhook event for
-- that return's lifetime (open -> ... -> complete/rejected/deleted). `raw`
-- keeps the full payload from the latest event so fields not yet
-- columnized (line items, shipment tracking, tags, notes) aren't lost.
create table if not exists public.redo_returns (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  redo_return_id text not null,
  redo_order_id text,
  shopify_order_name text,
  shopify_order_id text,

  return_type text,
  status text,
  compensation_methods text[] not null default '{}',

  refund_amount numeric(12,2) not null default 0,
  exchange_amount numeric(12,2) not null default 0,
  store_credit_amount numeric(12,2) not null default 0,
  charge_amount numeric(12,2) not null default 0,
  shipping_fee_amount numeric(12,2) not null default 0,
  currency text not null default 'USD',

  last_event_type text,
  redo_created_at timestamptz,
  redo_updated_at timestamptz,
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_redo_returns_company_return
  on public.redo_returns (company_entity_id, redo_return_id);
create index if not exists idx_redo_returns_company_order_name
  on public.redo_returns (company_entity_id, shopify_order_name);
create index if not exists idx_redo_returns_company_shopify_order
  on public.redo_returns (company_entity_id, shopify_order_id);
create index if not exists idx_redo_returns_company_status
  on public.redo_returns (company_entity_id, status);

alter table public.redo_returns enable row level security;
revoke all on public.redo_returns from anon;

-- Read-only to the app: only the service-role webhook edge function writes
-- this table (same trust model as marketing_kpis_daily / ad_platform sync
-- writes -- no authenticated insert/update/delete policy).
drop policy if exists redo_returns_active_select on public.redo_returns;
create policy redo_returns_active_select
  on public.redo_returns for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- 20260812130000_redo_return_items.sql
-- Redo returns integration, phase 2: parse the per-item detail that phase 1
-- (20260812120000_redo_returns_integration.sql) left in redo_returns.raw --
-- SKU, return reason, grade/outcome, and exchange item detail are exactly
-- the fields a returns-analytics view needs (top return reasons, which SKUs
-- come back most) and none of it was queryable without picking apart jsonb.
-- Also promotes the returning customer's email/name onto redo_returns
-- itself (single value per return, unlike items -- no child table needed).

alter table public.redo_returns
  add column if not exists customer_email text,
  add column if not exists customer_name text;

create index if not exists idx_redo_returns_company_customer_email
  on public.redo_returns (company_entity_id, customer_email);

-- One row per Redo return line item. Delete+reinsert per return on every
-- webhook event (see redo-webhook), not upserted item-by-item, so removed
-- items don't linger -- return items are set once at creation and rarely
-- change count afterward, so this is cheap and always exactly matches the
-- latest event's item list.
create table if not exists public.redo_return_items (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  return_id uuid not null references public.redo_returns(id) on delete cascade,

  redo_item_id text not null,
  sku text,
  upc text,
  product_id text,
  variant_id text,
  product_name text,
  variant_name text,

  quantity integer,
  status text,
  reason text,
  reason_code text,
  reasons text[] not null default '{}',
  reason_codes text[] not null default '{}',
  customer_comment text,
  grade text,
  outcome text,
  green_return boolean not null default false,

  refund_amount numeric(12,2),
  refund_type text,
  product_value numeric(12,2),

  is_exchange boolean not null default false,
  exchange_product_name text,
  exchange_variant_name text,
  exchange_quantity integer,

  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_redo_return_items_return_item
  on public.redo_return_items (return_id, redo_item_id);
create index if not exists idx_redo_return_items_company_sku
  on public.redo_return_items (company_entity_id, sku);
create index if not exists idx_redo_return_items_company_reason_code
  on public.redo_return_items (company_entity_id, reason_code);

alter table public.redo_return_items enable row level security;
revoke all on public.redo_return_items from anon;

-- Read-only to the app, same trust model as redo_returns -- only the
-- service-role webhook edge function writes this table.
drop policy if exists redo_return_items_active_select on public.redo_return_items;
create policy redo_return_items_active_select
  on public.redo_return_items for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- 20260813180000_silo_chat_readonly_query.sql
create or replace function public.chat_run_readonly_query(query text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
  trimmed text := trim(query);
begin
  if trimmed !~* '^(select|with)\s' then
    raise exception 'Only a single SELECT or WITH (read-only) statement is allowed';
  end if;
  if trimmed ~ ';' then
    raise exception 'Statement must not contain a semicolon (single statement only)';
  end if;

  set local statement_timeout = '10s';

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) user_query limit 500) t',
    trimmed
  ) into result;

  return result;
end;
$$;

revoke all on function public.chat_run_readonly_query(text) from public, anon;
grant execute on function public.chat_run_readonly_query(text) to authenticated;

-- 20260813210000_silo_chat_notes.sql
create table if not exists public.silo_chat_notes (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  note text not null check (length(trim(note)) > 0),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists silo_chat_notes_company_created_idx
  on public.silo_chat_notes (company_entity_id, created_at);

alter table public.silo_chat_notes enable row level security;

drop policy if exists silo_chat_notes_active_select on public.silo_chat_notes;
create policy silo_chat_notes_active_select on public.silo_chat_notes
  for select using (company_entity_id = active_company_id());

drop policy if exists silo_chat_notes_exec_insert on public.silo_chat_notes;
create policy silo_chat_notes_exec_insert on public.silo_chat_notes
  for insert with check (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

drop policy if exists silo_chat_notes_exec_delete on public.silo_chat_notes;
create policy silo_chat_notes_exec_delete on public.silo_chat_notes
  for delete using (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

drop trigger if exists stamp_created_by on public.silo_chat_notes;
create trigger stamp_created_by before insert on public.silo_chat_notes
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

drop view if exists public.silo_chat_notes_v;
create view public.silo_chat_notes_v
with (security_invoker = true) as
select
  n.id,
  n.note,
  n.created_at,
  n.created_by,
  p.name as created_by_name,
  n.company_entity_id
from public.silo_chat_notes n
left join public.profiles p on p.id = n.created_by;

revoke all on public.silo_chat_notes from anon;
revoke all on public.silo_chat_notes_v from anon;
grant select, insert, delete on public.silo_chat_notes to authenticated;
grant select on public.silo_chat_notes_v to authenticated;

-- 20260813220000_silo_chat_notes_category.sql
alter table public.silo_chat_notes
  add column if not exists category text not null default 'general'
  check (category in ('general', 'brand'));

drop view if exists public.silo_chat_notes_v;
create view public.silo_chat_notes_v
with (security_invoker = true) as
select
  n.id,
  n.note,
  n.category,
  n.created_at,
  n.created_by,
  p.name as created_by_name,
  n.company_entity_id
from public.silo_chat_notes n
left join public.profiles p on p.id = n.created_by;

grant select on public.silo_chat_notes_v to authenticated;

insert into public.silo_chat_notes (company_entity_id, note, category, created_by)
select
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid,
  seed.note,
  'brand',
  (select id from public.profiles where email = 'blake@baseballism.com')
from (values
  ('Baseballism is a baseball lifestyle apparel brand -- vintage/retro-inspired designs and MLB-licensed product (Ken Griffey Jr., Babe Ruth, Roberto Clemente, Cubs, Dodgers, and others) built for people who live baseball on and off the field, not just players. Tagline: "The Original Baseball Lifestyle Brand. Built For Ballplayers, Worn By All."'),
  ('Brand personality is nostalgic and rooted in the game''s history, but playful and pun-driven rather than corporate -- collection names like "Bat Bros," "Money Ball," "Hardball Hunter," and "Doubles and Bubbles" are typical, and holidays get a baseball spin (Valentine''s -> "For Love of the Game"). Comfortable crossing into pop culture (Sonic the Hedgehog, Fortnite collabs) without losing the baseball-first identity.'),
  ('Retail footprint includes a flagship barn store on the actual Field of Dreams Movie Site in Dyersville, Iowa (Universal-licensed) -- a defining piece of brand identity, not just another wholesale account.'),
  ('Merch calendar leans on family/community moments (Father''s/Mother''s Day, Back to School, Toddler/Youth lines) alongside signature promo events (Anniversary Sale, "6432 Day").'),
  ('Voice: warm and knowledgeable, like someone who''s actually into baseball -- not generic-corporate. The playful/pun energy belongs to product and marketing copy, not to a data answer -- when answering a data question, keep the personality as tone, not as bits: lead with the number, stay direct, and only lean into the brand''s playfulness if the user is literally asking for campaign name ideas or marketing copy.')
) as seed(note)
where exists (select 1 from public.entities where id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid)
  and not exists (
    select 1 from public.silo_chat_notes
    where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid
      and category = 'brand'
  );

-- 20260813230000_silo_chat_managers.sql
create table if not exists public.silo_chat_managers (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  user_id uuid not null references public.profiles(id),
  granted_by uuid references public.profiles(id) default auth.uid(),
  granted_at timestamptz not null default now(),
  unique (company_entity_id, user_id)
);

alter table public.silo_chat_managers enable row level security;

drop policy if exists silo_chat_managers_select on public.silo_chat_managers;
create policy silo_chat_managers_select on public.silo_chat_managers
  for select using (
    company_entity_id = active_company_id()
    and (is_exec_or_owner() or user_id = auth.uid())
  );

drop policy if exists silo_chat_managers_exec_insert on public.silo_chat_managers;
create policy silo_chat_managers_exec_insert on public.silo_chat_managers
  for insert with check (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

drop policy if exists silo_chat_managers_exec_delete on public.silo_chat_managers;
create policy silo_chat_managers_exec_delete on public.silo_chat_managers
  for delete using (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

select public.attach_stamp_company_entity_id_triggers();

create or replace function public.can_manage_silo_notes()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select public.is_exec_or_owner()
    or exists (
      select 1 from public.silo_chat_managers m
      where m.user_id = auth.uid()
        and m.company_entity_id = public.active_company_id()
    );
$$;

revoke all on function public.can_manage_silo_notes() from public, anon;
grant execute on function public.can_manage_silo_notes() to authenticated, service_role;

drop policy if exists silo_chat_notes_exec_insert on public.silo_chat_notes;
create policy silo_chat_notes_managers_insert on public.silo_chat_notes
  for insert with check (
    company_entity_id = active_company_id()
    and can_manage_silo_notes()
  );

drop policy if exists silo_chat_notes_exec_delete on public.silo_chat_notes;
create policy silo_chat_notes_managers_delete on public.silo_chat_notes
  for delete using (
    company_entity_id = active_company_id()
    and can_manage_silo_notes()
  );

drop view if exists public.silo_chat_managers_v;
create view public.silo_chat_managers_v
with (security_invoker = true) as
select
  m.id,
  m.user_id,
  u.name as user_name,
  u.email as user_email,
  m.granted_by,
  g.name as granted_by_name,
  m.granted_at,
  m.company_entity_id
from public.silo_chat_managers m
left join public.profiles u on u.id = m.user_id
left join public.profiles g on g.id = m.granted_by;

revoke all on public.silo_chat_managers from anon;
revoke all on public.silo_chat_managers_v from anon;
grant select, insert, delete on public.silo_chat_managers to authenticated;
grant select on public.silo_chat_managers_v to authenticated;

-- 20260814000000_lock_connection_secrets_to_admin.sql
drop policy if exists redo_connections_active_select on public.redo_connections;
create policy redo_connections_admin_select on public.redo_connections
  for select using (
    company_entity_id = active_company_id()
    and is_admin_user()
  );

drop policy if exists ad_platform_connections_active_select on public.ad_platform_connections;
create policy ad_platform_connections_admin_select on public.ad_platform_connections
  for select using (
    company_entity_id = active_company_id()
    and is_admin_user()
  );

-- ============================================================
-- 20260814130000_payment_request_activity_amount_and_removed.sql
--
-- Request Manager is gaining AP-side amount corrections and document
-- removal. Both need their own activity_type so the activity feed
-- doesn't lump them into the generic "updated" bucket.
-- ============================================================

alter table public.payment_request_activity
  drop constraint if exists payment_request_activity_activity_type_check;

alter table public.payment_request_activity
  add constraint payment_request_activity_activity_type_check
  check (activity_type = any (array[
    'submitted', 'status_changed', 'assignment_changed', 'priority_changed',
    'payment_type_changed', 'completed_changed', 'note_added', 'file_opened',
    'file_uploaded', 'file_removed', 'notification_sent', 'forwarded_to_melio',
    'updated', 'amount_changed'
  ]));

-- ============================================================
-- 20260814150000_launch_calendar_release_brief.sql
--
-- Launch Workbench is gaining a structured "release brief" so creative
-- direction, marketing story, budget, and post-launch performance live on
-- the launch itself instead of scattered notes fields nobody can find.
-- ============================================================

alter table public.launch_calendar
  add column if not exists preview_start_date date,
  add column if not exists preview_start_time time,
  add column if not exists release_pdf_url text,
  add column if not exists landing_page_url text,
  add column if not exists design_intent text,
  add column if not exists product_callouts text,
  add column if not exists marketing_angle text,
  add column if not exists audience text,
  add column if not exists special_callouts text,
  add column if not exists copy_dos text,
  add column if not exists copy_donts text,
  add column if not exists creative_dos text,
  add column if not exists creative_donts text,
  add column if not exists preview_marketing_budget numeric,
  add column if not exists post_launch_budget numeric,
  add column if not exists projected_revenue numeric,
  add column if not exists actual_preview_spend numeric,
  add column if not exists actual_post_launch_spend numeric,
  add column if not exists actual_revenue numeric,
  add column if not exists performance_comparison text,
  add column if not exists overperformed_notes text,
  add column if not exists underperformed_notes text;

-- ============================================================
-- 20260814170000_launch_calendar_audience_tags.sql
--
-- Free-text audience on the launch brief is hard for Ask SILO (or anyone)
-- to pattern-match across launches. Adds a structured, repeatable tag
-- array alongside the existing free-text audience column.
-- ============================================================

alter table public.launch_calendar
  add column if not exists audience_tags text[] not null default '{}';

create index if not exists launch_calendar_audience_tags_gin
  on public.launch_calendar using gin (audience_tags);

-- ---------------------------------------------------------------------------
-- 20260817180000_launch_calendar_approved_copy_creatives.sql
-- Approved Copy / Approved Creatives — the signed-off assets themselves,
-- separate from the do's/don'ts guardrail columns added in 20260814150000.
-- ---------------------------------------------------------------------------
alter table public.launch_calendar
  add column if not exists approved_copy      text,
  add column if not exists approved_creatives text;

-- ---------------------------------------------------------------------------
-- 20260817190000_sample_notifications.sql
-- Samples: email + Slack notification on a sample transitioning to received,
-- or a size request being set/changed. See sample-notify edge function.
-- ---------------------------------------------------------------------------
create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260817200000_product_samples_request_source.sql
-- Tags which flow created a sample draft, so sample-notify can phrase the
-- size-request notification correctly (catalog photo-shoot pull vs
-- pre-production sample).
-- ---------------------------------------------------------------------------
alter table public.product_samples
  add column if not exists request_source text;

-- ============================================================
-- 20260814190000_silo_chat_audit_log.sql
--
-- Ask SILO audit log: every question, the SQL it actually ran, and the
-- answer it gave, per request -- prerequisite for a feedback loop and a
-- future eval set.
-- ============================================================

create table if not exists public.silo_chat_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references auth.users(id) on delete set null,
  question text not null,
  history_snapshot jsonb,
  answer text,
  queries_run text[] not null default '{}',
  tool_rounds integer,
  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists silo_chat_audit_log_company_created_idx
  on public.silo_chat_audit_log (company_entity_id, created_at desc);

alter table public.silo_chat_audit_log enable row level security;

drop policy if exists silo_chat_audit_log_select on public.silo_chat_audit_log;
create policy silo_chat_audit_log_select on public.silo_chat_audit_log
  for select using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop policy if exists silo_chat_audit_log_insert on public.silo_chat_audit_log;
create policy silo_chat_audit_log_insert on public.silo_chat_audit_log
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
  );

drop trigger if exists stamp_created_by on public.silo_chat_audit_log;
create trigger stamp_created_by before insert on public.silo_chat_audit_log
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

revoke all on public.silo_chat_audit_log from anon;
grant select, insert on public.silo_chat_audit_log to authenticated;

create or replace view public.silo_chat_audit_log_v
with (security_invoker = true) as
select
  l.id,
  l.company_entity_id,
  l.created_by,
  p.name as created_by_name,
  p.email as created_by_email,
  l.question,
  l.answer,
  l.queries_run,
  l.tool_rounds,
  l.status,
  l.error_message,
  l.model,
  l.created_at
from public.silo_chat_audit_log l
left join public.profiles p on p.id = l.created_by;

revoke all on public.silo_chat_audit_log_v from anon;
grant select on public.silo_chat_audit_log_v to authenticated;

-- ============================================================
-- 20260817210000_shopify_order_level_analytics.sql
-- Order-level and line-item-level Shopify sales facts, captured alongside
-- (not instead of) the flattened sales_by_day aggregate — see migration
-- file for why.
-- ============================================================
create table if not exists public.shopify_orders (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  connection_id uuid references public.shopify_connections(id),
  shop_domain text not null,
  order_id text not null,
  order_number text,
  source_name text,
  financial_status text,
  fulfillment_status text,
  cancelled_at timestamptz,
  cancel_reason text,
  customer_id text,
  customer_email text,
  customer_name text,
  currency text,
  subtotal_price numeric not null default 0,
  total_discounts numeric not null default 0,
  total_tax numeric not null default 0,
  total_shipping numeric not null default 0,
  total_price numeric not null default 0,
  tags text,
  location_id text,
  line_item_count integer not null default 0,
  shopify_created_at timestamptz,
  shopify_processed_at timestamptz,
  shopify_updated_at timestamptz,
  synced_at timestamptz,
  sync_batch_id text,
  created_at timestamptz not null default now(),
  unique (shop_domain, order_id)
);

create index if not exists shopify_orders_co_created_idx
  on public.shopify_orders (company_entity_id, shopify_created_at);
create index if not exists shopify_orders_co_source_idx
  on public.shopify_orders (company_entity_id, source_name);

alter table public.shopify_orders enable row level security;

drop policy if exists shopify_orders_active_select on public.shopify_orders;
create policy shopify_orders_active_select
  on public.shopify_orders for select to authenticated
  using (company_entity_id = public.active_company_id());

create table if not exists public.shopify_order_lines (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  connection_id uuid references public.shopify_connections(id),
  shop_domain text not null,
  order_id text not null,
  line_item_id text not null,
  sku text,
  product_id text,
  variant_id text,
  title text,
  variant_title text,
  quantity integer not null default 0,
  price numeric not null default 0,
  discount_allocated numeric not null default 0,
  tax_allocated numeric not null default 0,
  fulfillable_quantity integer not null default 0,
  fulfillment_status text,
  gift_card boolean not null default false,
  vendor text,
  product_type text,
  synced_at timestamptz,
  sync_batch_id text,
  created_at timestamptz not null default now(),
  unique (shop_domain, order_id, line_item_id)
);

create index if not exists shopify_order_lines_co_order_idx
  on public.shopify_order_lines (company_entity_id, order_id);
create index if not exists shopify_order_lines_co_sku_idx
  on public.shopify_order_lines (company_entity_id, sku);

alter table public.shopify_order_lines enable row level security;

drop policy if exists shopify_order_lines_active_select on public.shopify_order_lines;
create policy shopify_order_lines_active_select
  on public.shopify_order_lines for select to authenticated
  using (company_entity_id = public.active_company_id());

create table if not exists public.shopify_channel_map (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null references public.entities(id),
  source_name text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_entity_id, source_name)
);

alter table public.shopify_channel_map enable row level security;

drop policy if exists shopify_channel_map_select on public.shopify_channel_map;
create policy shopify_channel_map_select
  on public.shopify_channel_map for select using (company_entity_id = active_company_id());

drop policy if exists shopify_channel_map_write on public.shopify_channel_map;
create policy shopify_channel_map_write
  on public.shopify_channel_map for all
  using    (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());

drop trigger if exists set_updated_at on public.shopify_channel_map;
create trigger set_updated_at before update on public.shopify_channel_map
  for each row execute function public.set_updated_at();

select public.attach_stamp_company_entity_id_triggers();

create or replace view public.shopify_orders_v
with (security_invoker = true) as
select
  o.*,
  coalesce(m.display_name, o.source_name) as resolved_channel_name
from public.shopify_orders o
left join public.shopify_channel_map m
  on m.company_entity_id = o.company_entity_id
  and m.source_name = o.source_name;

revoke all on public.shopify_orders_v from anon;
grant select on public.shopify_orders_v to authenticated;

-- ============================================================
-- 20260818050000_silo_chat_saved_reports.sql
-- Saved Ask SILO reports — pinned answers with their SQL, re-runnable
-- from the chat UI at zero LLM cost (see migration file).
-- ============================================================
create table if not exists public.silo_chat_saved_reports (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  title text not null,
  question text not null,
  answer text not null,
  queries_run text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists silo_chat_saved_reports_company_created_idx
  on public.silo_chat_saved_reports (company_entity_id, created_at desc);

alter table public.silo_chat_saved_reports enable row level security;

drop policy if exists silo_chat_saved_reports_select on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports
  for select using (company_entity_id = active_company_id());

drop policy if exists silo_chat_saved_reports_insert on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_insert on public.silo_chat_saved_reports
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
  );

drop policy if exists silo_chat_saved_reports_update on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_update on public.silo_chat_saved_reports
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  )
  with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop policy if exists silo_chat_saved_reports_delete on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_delete on public.silo_chat_saved_reports
  for delete using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop trigger if exists stamp_created_by on public.silo_chat_saved_reports;
create trigger stamp_created_by before insert on public.silo_chat_saved_reports
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.silo_chat_saved_reports;
create trigger set_updated_at before update on public.silo_chat_saved_reports
  for each row execute function public.set_updated_at();

select public.attach_stamp_company_entity_id_triggers();

revoke all on public.silo_chat_saved_reports from anon;
grant select, insert, update, delete on public.silo_chat_saved_reports to authenticated;

create or replace view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select
  r.id,
  r.company_entity_id,
  r.created_by,
  p.name as created_by_name,
  r.title,
  r.question,
  r.answer,
  r.queries_run,
  r.created_at,
  r.updated_at
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

-- ============================================================
-- 20260818060000_orders_backfill_job_type.sql
-- Allow 'orders_backfill' in sync_jobs.job_type (see migration file —
-- logged by scripts/shopify-orders-backfill.mjs).
-- ============================================================
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis',
    'orders_backfill'
  ));

-- ---------------------------------------------------------------------------
-- 20260818130000_product_samples_assignee_notifications.sql
-- Samples: a stored single-person assignee (mirrors mail_items.assigned_to)
-- plus SAMPLE_REQUESTED / SAMPLE_WAREHOUSE_READY / SAMPLE_ASSIGNED trigger
-- events. sample-notify emails the assignee directly when one is set,
-- falling back to the logistics department broadcast otherwise.
-- ---------------------------------------------------------------------------
alter table public.product_samples
  add column if not exists assigned_to uuid references public.profiles(id);

create index if not exists product_samples_assigned_to_idx
  on public.product_samples (assigned_to);

create or replace view public.product_samples_v
with (security_invoker = true) as
select
  s.*,
  assigned.name  as assigned_to_name,
  assigned.email as assigned_to_email,
  creator.name   as created_by_name,
  creator.email  as created_by_email
from public.product_samples s
left join public.profiles assigned on assigned.id = s.assigned_to
left join public.profiles creator  on creator.id  = s.created_by;

revoke all on public.product_samples_v from anon;
grant select on public.product_samples_v to authenticated;

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and (new.assigned_to is not null or new.request_source is not null) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_REQUESTED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260818150000_sample_notification_log.sql
-- One row per sample-notify send attempt (auto trigger-fired or manual
-- "Notify now"), written by the service-role client inside sample-notify.
-- Backs the Samples tab's Notification Log panel and the post-save poll
-- that turns the async DB-trigger notification into a visible toast.
-- ---------------------------------------------------------------------------
create table if not exists public.sample_notification_log (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  sample_id         uuid references public.product_samples(id) on delete cascade,
  event_type        text not null,
  recipient_label   text,
  email_sent        boolean not null default false,
  email_reason      text,
  slack_sent        boolean not null default false,
  slack_reason      text,
  slack_dm_sent     boolean not null default false,
  slack_dm_reason   text,
  recipients_count  integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists sample_notification_log_sample_id_idx
  on public.sample_notification_log (sample_id, created_at desc);

create index if not exists sample_notification_log_company_created_idx
  on public.sample_notification_log (company_entity_id, created_at desc);

alter table public.sample_notification_log enable row level security;

drop policy if exists sample_notification_log_active_select on public.sample_notification_log;
create policy sample_notification_log_active_select on public.sample_notification_log
  for select using (company_entity_id = active_company_id());

revoke all on public.sample_notification_log from anon;
grant select on public.sample_notification_log to authenticated;

create or replace view public.sample_notification_log_v
with (security_invoker = true) as
select
  l.*,
  s.product_title,
  s.sample_ref
from public.sample_notification_log l
left join public.product_samples s on s.id = l.sample_id;

revoke all on public.sample_notification_log_v from anon;
grant select on public.sample_notification_log_v to authenticated;

-- ---------------------------------------------------------------------------
-- 20260818170000_sample_requested_vs_received_on_insert.sql
-- INSERT-time notification now routes by the row's actual sample_status:
-- 'received' (the default, and the common case) -> SAMPLE_RECEIVED instead
-- of the previously-always SAMPLE_REQUESTED, which was factually wrong for
-- most real samples (already in hand, not pending).
-- ---------------------------------------------------------------------------
create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and (new.assigned_to is not null or new.request_source is not null) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') = 'received' then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260818180000_sample_insert_no_double_fire.sql
-- INSERT-time SAMPLE_REQUESTED/SAMPLE_RECEIVED now only fires when
-- size_requests is NOT already set at creation -- avoids double-posting
-- with SAMPLE_SIZE_REQUEST when the Catalog "+ Request Sample" flow sets
-- both request_source and size_requests in the same insert.
-- ---------------------------------------------------------------------------
create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and (new.assigned_to is not null or new.request_source is not null)
     and (new.size_requests is null or btrim(new.size_requests) = '') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') = 'received' then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260818190000_sample_pps_full_run_received.sql
-- 'received' split into 'pps_received' / 'full_run_received' in the UI;
-- trigger updated so SAMPLE_RECEIVED still fires for both (and legacy
-- plain 'received' rows), not just the exact old string.
-- ---------------------------------------------------------------------------
create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and (new.assigned_to is not null or new.request_source is not null)
     and (new.size_requests is null or btrim(new.size_requests) = '') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
                     then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') not in ('received','pps_received','full_run_received')
     and coalesce(new.sample_status,'') in ('received','pps_received','full_run_received') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260818200000_sample_received_transition_within_family.sql
-- SAMPLE_RECEIVED now fires on any sample_status change landing on a
-- received-family value, not just first entry into the family -- fixes
-- pps_received -> full_run_received (a direct within-family jump) never
-- firing a notification.
-- ---------------------------------------------------------------------------
create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and (new.assigned_to is not null or new.request_source is not null)
     and (new.size_requests is null or btrim(new.size_requests) = '') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
                     then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
     and old.sample_status is distinct from new.sample_status then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();

-- ---------------------------------------------------------------------------
-- 20260818210000_incoming_shipment_lines.sql
-- Incoming shipment tracking for /v2/po-report.html: incoming_shipments
-- (widens its write RLS from creator/admin-only to any active company
-- member) + new incoming_shipment_lines join table so a shipment can call
-- out exactly which PO lines (products) it covers, since items on one PO
-- can ship separately.
-- ---------------------------------------------------------------------------
create table if not exists public.incoming_shipments (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references public.po_headers(id) on delete cascade,

  shipment_status text not null default 'Not Shipped'
    constraint incoming_shipments_status_chk
    check (shipment_status in ('Not Shipped','Booked','Shipped','In Transit','Delayed','Delivered','Received')),

  ship_date date,
  eta date,
  received_date date,

  tracking_number text,
  carrier text,
  container_ref text,
  warehouse_location text,
  received_by text,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company_entity_id uuid references public.entities(id)
);

create index if not exists incoming_shipments_po_header_id_idx on public.incoming_shipments (po_header_id);
create index if not exists incoming_shipments_company_entity_id_idx on public.incoming_shipments (company_entity_id);

alter table public.incoming_shipments enable row level security;

drop trigger if exists stamp_company_entity_id on public.incoming_shipments;
create trigger stamp_company_entity_id
  before insert on public.incoming_shipments
  for each row execute function public.stamp_company_entity_id();

drop trigger if exists trg_incoming_shipments_updated_at on public.incoming_shipments;
create trigger trg_incoming_shipments_updated_at
  before update on public.incoming_shipments
  for each row execute function public.set_updated_at();

drop policy if exists incoming_shipments_active_select on public.incoming_shipments;
create policy incoming_shipments_active_select on public.incoming_shipments
  for select using (company_entity_id = active_company_id());

drop policy if exists incoming_shipments_active_insert on public.incoming_shipments;
create policy incoming_shipments_active_insert on public.incoming_shipments
  for insert with check (company_entity_id = active_company_id());

drop policy if exists incoming_shipments_active_update on public.incoming_shipments;
create policy incoming_shipments_active_update on public.incoming_shipments
  for update using (company_entity_id = active_company_id())
             with check (company_entity_id = active_company_id());

drop policy if exists incoming_shipments_active_delete on public.incoming_shipments;
create policy incoming_shipments_active_delete on public.incoming_shipments
  for delete using (company_entity_id = active_company_id() and is_admin_user());

create table if not exists public.incoming_shipment_lines (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.incoming_shipments(id) on delete cascade,
  po_line_id uuid not null references public.po_lines(id) on delete cascade,

  qty numeric(12, 2),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company_entity_id uuid references public.entities(id),

  constraint incoming_shipment_lines_unique unique (shipment_id, po_line_id)
);

create index if not exists incoming_shipment_lines_shipment_id_idx on public.incoming_shipment_lines (shipment_id);
create index if not exists incoming_shipment_lines_po_line_id_idx on public.incoming_shipment_lines (po_line_id);
create index if not exists incoming_shipment_lines_company_entity_id_idx on public.incoming_shipment_lines (company_entity_id);

alter table public.incoming_shipment_lines enable row level security;

drop trigger if exists stamp_company_entity_id on public.incoming_shipment_lines;
create trigger stamp_company_entity_id
  before insert on public.incoming_shipment_lines
  for each row execute function public.stamp_company_entity_id();

drop trigger if exists trg_incoming_shipment_lines_updated_at on public.incoming_shipment_lines;
create trigger trg_incoming_shipment_lines_updated_at
  before update on public.incoming_shipment_lines
  for each row execute function public.set_updated_at();

drop policy if exists incoming_shipment_lines_active_select on public.incoming_shipment_lines;
create policy incoming_shipment_lines_active_select on public.incoming_shipment_lines
  for select using (company_entity_id = active_company_id());

drop policy if exists incoming_shipment_lines_active_insert on public.incoming_shipment_lines;
create policy incoming_shipment_lines_active_insert on public.incoming_shipment_lines
  for insert with check (company_entity_id = active_company_id());

drop policy if exists incoming_shipment_lines_active_update on public.incoming_shipment_lines;
create policy incoming_shipment_lines_active_update on public.incoming_shipment_lines
  for update using (company_entity_id = active_company_id())
             with check (company_entity_id = active_company_id());

drop policy if exists incoming_shipment_lines_active_delete on public.incoming_shipment_lines;
create policy incoming_shipment_lines_active_delete on public.incoming_shipment_lines
  for delete using (company_entity_id = active_company_id());

create or replace view public.v_po_shipment_lines
  with (security_invoker = true) as
select
  s.id as shipment_id,
  s.po_header_id,
  s.shipment_status,
  s.ship_date,
  s.eta,
  s.received_date,
  s.tracking_number,
  s.carrier,
  s.container_ref,
  s.warehouse_location,
  s.received_by,
  s.notes as shipment_notes,
  s.company_entity_id,
  sl.id as shipment_line_id,
  sl.po_line_id,
  sl.qty as assigned_qty,
  sl.notes as line_notes,
  pl.title_snapshot,
  pl.variant_title_snapshot,
  pl.sku_snapshot,
  pl.qty as line_qty
from public.incoming_shipments s
left join public.incoming_shipment_lines sl on sl.shipment_id = s.id
left join public.po_lines pl on pl.id = sl.po_line_id;

-- ---------------------------------------------------------------------------
-- 20260818220000_factories_country.sql
-- factories.country — powers the shipment status map on /v2/po-report.html.
-- ---------------------------------------------------------------------------
alter table public.factories add column if not exists country text;

-- ---------------------------------------------------------------------------
-- 20260820130000_sales_by_day_trgm_search_indexes.sql
-- Trigram GIN indexes so Ask SILO's and BI Product Search's leading-wildcard
-- ILIKE searches on product_name/sku stop seq-scanning 1.1M rows into the
-- 10s chat statement_timeout.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

create index if not exists sales_by_day_product_name_trgm_idx
  on public.sales_by_day using gin (product_name extensions.gin_trgm_ops);

create index if not exists sales_by_day_sku_trgm_idx
  on public.sales_by_day using gin (sku extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 20260820140000_inventory_on_hand_trgm_search_indexes.sql
-- Companion trigram indexes on inventory_on_hand (product_title/variant_sku)
-- so Ask SILO's restock questions don't seq-scan 3.5M rows into the 10s
-- chat statement_timeout.
-- ---------------------------------------------------------------------------
create index if not exists inventory_on_hand_product_title_trgm_idx
  on public.inventory_on_hand using gin (product_title extensions.gin_trgm_ops);

create index if not exists inventory_on_hand_variant_sku_trgm_idx
  on public.inventory_on_hand using gin (variant_sku extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 20260821090000_silo_chat_saved_reports_visibility.sql
-- "My reports" vs "Company reports" on Ask SILO saved reports: visibility
-- column ('company' default | 'private'), creator-only select on private
-- rows (hidden from exec/owner too, like review_private_notes), view
-- updated to expose it.
-- ---------------------------------------------------------------------------
alter table public.silo_chat_saved_reports
  add column if not exists visibility text not null default 'company';

do $$ begin
  alter table public.silo_chat_saved_reports
    add constraint silo_chat_saved_reports_visibility_check
    check (visibility in ('company', 'private'));
exception when duplicate_object then null; end $$;

drop policy if exists silo_chat_saved_reports_select on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports
  for select using (
    company_entity_id = active_company_id()
    and (visibility = 'company' or created_by = auth.uid())
  );

create or replace view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select
  r.id,
  r.company_entity_id,
  r.created_by,
  p.name as created_by_name,
  r.title,
  r.question,
  r.answer,
  r.queries_run,
  r.created_at,
  r.updated_at,
  r.visibility
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

-- ---------------------------------------------------------------------------
-- 20260821110000_product_concepts.sql
-- Product Concepts: Ask SILO's product-generation branch. Still gated to
-- PRODUCT_CONCEPT_TESTERS in the silo-chat edge function while it's tested;
-- scoped to concept generation + approval only, does not touch po_headers,
-- launch_calendar, or PO Builder.

create table if not exists public.product_concepts (
  id                          uuid primary key default gen_random_uuid(),
  company_entity_id           uuid references public.entities(id),
  created_by                  uuid references public.profiles(id),
  approved_by                 uuid references public.profiles(id),
  approved_at                 timestamptz,

  title                       text not null,
  concept_summary             text,
  marketing_angle             text,
  audience                    text,
  audience_tags               text[] not null default '{}',
  suggested_qty               integer,
  suggested_factory_id        uuid references public.factories(id) on delete set null,
  suggested_channels          text[] not null default '{}',
  suggested_retail_dtc_notes  text,
  suggested_launch_date       date,
  suggested_launch_notes      text,
  reasoning                   text,
  notes                       text,

  status                      text not null default 'draft'
                                check (status in ('draft', 'approved', 'archived')),

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists product_concepts_company_status_idx
  on public.product_concepts (company_entity_id, status, created_at desc);

alter table public.product_concepts enable row level security;

drop policy if exists product_concepts_select on public.product_concepts;
create policy product_concepts_select on public.product_concepts
  for select using (company_entity_id = active_company_id());

drop policy if exists product_concepts_insert on public.product_concepts;
create policy product_concepts_insert on public.product_concepts
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
    and status = 'draft'
  );

drop policy if exists product_concepts_update on public.product_concepts;
create policy product_concepts_update on public.product_concepts
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or po_builder_can_write())
  )
  with check (
    company_entity_id = active_company_id()
    and (
      po_builder_can_write()
      or (created_by = auth.uid() and status = 'draft')
    )
  );

drop policy if exists product_concepts_delete on public.product_concepts;
create policy product_concepts_delete on public.product_concepts
  for delete using (
    company_entity_id = active_company_id()
    and (
      (created_by = auth.uid() and status = 'draft')
      or po_builder_can_write()
    )
  );

drop trigger if exists stamp_created_by on public.product_concepts;
create trigger stamp_created_by before insert on public.product_concepts
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.product_concepts;
create trigger set_updated_at before update on public.product_concepts
  for each row execute function public.set_updated_at();

select public.attach_stamp_company_entity_id_triggers();

revoke all on public.product_concepts from anon;
grant select, insert, update, delete on public.product_concepts to authenticated;

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;

-- ---------------------------------------------------------------------------
-- 20260821130000_product_concept_images.sql
-- Product Concepts: reference image upload (still in testing, gated to
-- PRODUCT_CONCEPT_TESTERS). Bucket mirrors sample-images/launch-images.

alter table public.product_concepts
  add column if not exists reference_image_urls text[] not null default '{}';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-concept-images',
  'product-concept-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_concept_images_public_read on storage.objects;
create policy product_concept_images_public_read
  on storage.objects for select
  using (bucket_id = 'product-concept-images');

drop policy if exists product_concept_images_auth_insert on storage.objects;
create policy product_concept_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-concept-images'
    and (storage.foldername(name))[1] = 'concepts'
  );

drop policy if exists product_concept_images_auth_update on storage.objects;
create policy product_concept_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'product-concept-images')
  with check (bucket_id = 'product-concept-images');

drop policy if exists product_concept_images_auth_delete on storage.objects;
create policy product_concept_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-concept-images');

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id;

-- 20260821140000_product_concept_po_link.sql
-- Product Concepts: link to the PO it becomes (prep column only -- PO
-- Builder does not yet read/write this).

alter table public.product_concepts
  add column if not exists resulting_po_header_id uuid references public.po_headers(id) on delete set null;

create index if not exists product_concepts_resulting_po_header_idx
  on public.product_concepts (resulting_po_header_id);

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id;

-- 20260821160000_product_concept_launch_plan_fields.sql
-- Product Concepts: full launch-plan output fields (Loomis note,
-- 2026-08-21) -- size breakdown, channel split, launch time, marketing
-- spend, weekly revenue projection, email/SMS plan, marketing copy.

alter table public.product_concepts
  add column if not exists suggested_size_breakdown jsonb,
  add column if not exists suggested_channel_split jsonb,
  add column if not exists suggested_launch_time text,
  add column if not exists suggested_marketing_spend jsonb,
  add column if not exists suggested_weekly_revenue_projection jsonb,
  add column if not exists suggested_email_sms_plan jsonb,
  add column if not exists suggested_marketing_copy text;

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name,
  c.suggested_size_breakdown,
  c.suggested_channel_split,
  c.suggested_launch_time,
  c.suggested_marketing_spend,
  c.suggested_weekly_revenue_projection,
  c.suggested_email_sms_plan,
  c.suggested_marketing_copy
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id;

-- 20260821170000_product_concept_collections.sql
-- Product Concepts: collection grouping (parent + per-product children).
-- parent_concept_id is a self-referencing FK -- a parent concept (unset)
-- holds the shared strategic brief, a child concept (set) holds only
-- what's genuinely per-product.

alter table public.product_concepts
  add column if not exists parent_concept_id uuid references public.product_concepts(id) on delete set null;

create index if not exists product_concepts_parent_concept_idx
  on public.product_concepts (parent_concept_id);

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name,
  c.suggested_size_breakdown,
  c.suggested_channel_split,
  c.suggested_launch_time,
  c.suggested_marketing_spend,
  c.suggested_weekly_revenue_projection,
  c.suggested_email_sms_plan,
  c.suggested_marketing_copy,
  c.parent_concept_id,
  parent.title as parent_title
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;

-- === 20260821170000_sku_collision_velocity_fix.sql ===
-- Fixes the "Doubles and Bubbles Cap - Toddler" misattribution (Kalin,
-- 2026-08-21): a never-launched Shopify listing shared its SKU with the real
-- "Bubbles and Doubles Cap - Youth" product. sales_velocity_by_sku_location_mv
-- grouped sales_by_day by (company, location, sku) ALONE, with no product
-- identity in the key, so two different products sharing one SKU had their
-- sales summed into a single velocity row -- and inventory_workboard_v's
-- location+sku join then attached that blended number to BOTH products'
-- inventory rows.
--
-- The companion sync-code fix (scripts/lib/shopify-sync-core.mjs and its
-- supabase/functions/shopify-sync-run mirror) already stopped collapsing
-- sales_by_day rows and inventory_on_hand rows across different products
-- that happen to share a SKU. This migration widens the velocity MV and the
-- workboard join to match: (location, sku, product_name) instead of
-- (location, sku) alone, so the two products' numbers stay separated all
-- the way through to the report.
--
-- Known tradeoff: sales_by_day.product_name is the AS-SOLD line-item title,
-- frozen at order time, while inventory_on_hand.product_title reflects
-- Shopify's CURRENT product title. A product renamed within the trailing
-- velocity window (7/30/90/365d) will show reduced velocity for the days
-- still under its old title until the rename ages out of that window. This
-- is a narrow, self-healing edge case -- and a much smaller blast radius
-- than the SKU-collision misattribution it replaces, which silently blended
-- unrelated products' numbers together with no self-healing at all.

drop view if exists public.inventory_workboard_v;
drop view if exists public.sales_velocity_by_sku_location_v;
drop materialized view if exists public.sales_velocity_by_sku_location_mv;

create materialized view public.sales_velocity_by_sku_location_mv as
  select
    company_entity_id,
    lower(trim(location_tag))          as location_tag,
    trim(sku)                          as variant_sku,
    coalesce(trim(product_name), '')   as product_name,
    sum(case when day_date >= current_date - interval '7 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_7d,
    sum(case when day_date >= current_date - interval '30 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_30d,
    sum(case when day_date >= current_date - interval '90 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_90d,
    sum(case when day_date >= current_date - interval '120 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_120d,
    sum(case when day_date >= current_date - interval '365 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_365d,
    round(sum(case when day_date >= current_date - interval '7 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 7,   4) as avg_day_7,
    round(sum(case when day_date >= current_date - interval '30 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 30,  4) as avg_day_30,
    round(sum(case when day_date >= current_date - interval '90 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 90,  4) as avg_day_90,
    round(sum(case when day_date >= current_date - interval '120 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 120, 4) as avg_day_120,
    round(sum(case when day_date >= current_date - interval '365 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 365, 4) as avg_day_365,
    max(day_date) filter (where coalesce(total_quantity_sold, 0) <> 0) as last_sold_date
  from public.sales_by_day
  where sku is not null and trim(sku) <> ''
    and company_entity_id is not null
  group by company_entity_id, lower(trim(location_tag)), trim(sku), coalesce(trim(product_name), '')
with no data;

create unique index sales_velocity_mv_co_loc_sku_name
  on public.sales_velocity_by_sku_location_mv (company_entity_id, location_tag, variant_sku, product_name);

revoke all on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
grant select on public.sales_velocity_by_sku_location_mv to service_role;

-- Company-filtered reader. DEFINER (security_invoker = false), matching the
-- 20260708060000 fix -- an invoker view here needs SELECT on the locked-down
-- MV directly, which is exactly what that migration closed off.
create view public.sales_velocity_by_sku_location_v
  with (security_invoker = false)
as
  select location_tag, variant_sku, product_name, qty_7d, qty_30d, qty_90d, qty_120d,
         qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
         avg_day_365, last_sold_date
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = active_company_id();

grant select on public.sales_velocity_by_sku_location_v to authenticated;

-- Recreate inventory_workboard_v (dropped above) — join now also requires
-- product_name to match, so two products sharing a SKU each get their own
-- velocity numbers instead of one blended row attached to both.
create view public.inventory_workboard_v
  with (security_invoker = true)
as
  select
    i.id,
    i.location_tag,
    i.source,
    i.location,
    i.product_title,
    i.variant_title,
    i.variant_sku,
    i.shop_domain,
    i.variant_barcode,
    i.est_oos_date,
    i.variant_created_at,
    i.product_type,
    i.product_image,
    i.product_image_url,
    i.retail_price,
    i.total_available_quantity,
    i.total_available_inventory_value,
    i.qty_sold_30d,
    i.avg_qty_sold_per_day,
    i.est_days_before_oos,
    i.snapshot_at,
    i.row_hash,
    i.location_name,
    i.sync_batch_id,
    i.company_entity_id,
    coalesce(v.qty_7d,     0) as qty_7d,
    coalesce(v.qty_30d,    0) as sold_30,
    coalesce(v.qty_90d,    0) as qty_90d,
    coalesce(v.qty_120d,   0) as qty_120d,
    coalesce(v.qty_365d,   0) as qty_365d,
    coalesce(v.avg_day_7,  0) as avg_day_7,
    coalesce(v.avg_day_30, 0) as avg_day_30,
    coalesce(v.avg_day_90, 0) as avg_day_90,
    coalesce(v.avg_day_120,0) as avg_day_120,
    coalesce(v.avg_day_365,0) as avg_day_365,
    v.last_sold_date,
    case
      when coalesce(v.avg_day_30, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_30, 1)
      when coalesce(v.avg_day_7, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_7, 1)
      else null
    end as days_oos,
    case
      when coalesce(v.avg_day_30, 0) > 0 then '30d'
      when coalesce(v.avg_day_7,  0) > 0 then '7d'
      else 'none'
    end as velocity_basis
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name;

grant select on public.inventory_workboard_v to authenticated;

-- refresh_sales_velocity_mv() is unchanged (still refreshes this MV by name)
-- but is recreated here anyway since CONCURRENTLY refresh depends on the new
-- unique index existing under its new definition.
create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  begin
    refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
  exception when others then
    refresh materialized view public.sales_velocity_by_sku_location_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_velocity_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_velocity_mv() to service_role;

-- === 20260821180000_product_search_rollup_rpc.sql ===
-- Product Search (v2/bi-product-search.html) was fetching every raw
-- sales_by_day_verification_v row for the selected date range and doing
-- the product/type rollup client-side in JS -- 50,502 rows for the default
-- 30-day window, 159,167 for 90d, 291,092 for 180d. That's what "loading is
-- still pretty heavy" is: shipping and re-aggregating tens/hundreds of
-- thousands of rows in the browser on every load and every filter change.
-- This was already flagged as a known follow-up in the 2026-08-20 CHANGELOG
-- entry ("a server-side aggregate RPC for the BI suite is the scoped-out
-- follow-up").
--
-- This RPC does the day-level SUM in Postgres instead of in the browser,
-- collapsing to one row per (location, sku, product, [month]) instead of
-- one row per (location, sku, product, day) -- e.g. 90d drops from 159,167
-- rows to 18,102 (no month) since row count is now bounded by the catalog
-- size, not the date range. Location is always kept (so the existing
-- client-side store-group filter and "Add Store column" toggle need no
-- refetch); month is optional (p_group_month) since "Add Store column"
-- stays instant but "Add Month column" now triggers one refetch at the
-- finer grain, matching the window-selector refetch pattern already used
-- elsewhere in the BI suite (bi-top-sellers.html).
--
-- security invoker (the default for a plain function, stated explicitly):
-- runs with the caller's own RLS, so it only ever sees sales_by_day rows
-- the caller's active company can already see -- no company_id parameter
-- needed, same as every other view in this schema.
create or replace function public.product_search_rollup(
  p_date_from date,
  p_date_to date,
  p_name_term text default null,
  p_sku_term text default null,
  p_group_month boolean default false
)
returns table (
  location_tag text,
  location_name text,
  sku text,
  product_name text,
  product_type text,
  month text,
  total_quantity_sold numeric,
  total_gross_sales numeric,
  total_discounts numeric,
  total_refunds numeric,
  total_net_sales numeric,
  total_sales numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.location_tag,
    s.location_name,
    s.sku,
    s.product_name,
    coalesce(s.product_type, 'Uncategorized') as product_type,
    case when p_group_month then to_char(s.day_date, 'YYYY-MM') else null end as month,
    sum(s.total_quantity_sold) as total_quantity_sold,
    sum(s.total_gross_sales) as total_gross_sales,
    sum(s.total_discounts) as total_discounts,
    sum(s.total_refunds) as total_refunds,
    sum(s.total_net_sales) as total_net_sales,
    sum(s.total_sales) as total_sales
  from public.sales_by_day_verification_v s
  where s.day_date >= p_date_from
    and s.day_date <= p_date_to
    and (
      p_name_term is null or p_name_term = ''
      or s.product_name ilike '%' || replace(replace(replace(p_name_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
    and (
      p_sku_term is null or p_sku_term = ''
      or s.sku ilike '%' || replace(replace(replace(p_sku_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  group by
    s.location_tag, s.location_name, s.sku, s.product_name, coalesce(s.product_type, 'Uncategorized'),
    case when p_group_month then to_char(s.day_date, 'YYYY-MM') else null end
$$;

revoke all on function public.product_search_rollup(date, date, text, text, boolean) from public, anon;
grant execute on function public.product_search_rollup(date, date, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 20260821210000_silo_chat_schema_catalog.sql
-- Ask SILO schema catalog (auto-generated column map + curated meaning,
-- replaces the hand-typed cheat sheet in silo-chat's prompt) + the
-- silo_chat_health_v per-day reliability scoreboard.
-- ---------------------------------------------------------------------------
create table if not exists public.silo_chat_schema_catalog (
  relname text primary key,
  relkind text not null,
  columns jsonb not null default '[]'::jsonb,
  description text,
  keywords text[],
  is_hidden boolean not null default false,
  auto_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.silo_chat_schema_catalog enable row level security;

-- Read-only for signed-in users (the edge function reads with the caller's
-- JWT). Schema *names* are not secrets -- any authenticated user can
-- already enumerate them via information_schema through chat SQL; RLS on
-- the actual tables remains the data boundary. No insert/update/delete
-- policies: client writes are denied outright.
drop policy if exists silo_chat_schema_catalog_select on public.silo_chat_schema_catalog;
create policy silo_chat_schema_catalog_select on public.silo_chat_schema_catalog
  for select using (auth.role() = 'authenticated');

revoke all on public.silo_chat_schema_catalog from anon;
grant select on public.silo_chat_schema_catalog to authenticated;

create or replace function public.refresh_chat_schema_catalog()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.silo_chat_schema_catalog (relname, relkind, columns, auto_refreshed_at)
  select
    c.relname,
    case c.relkind when 'r' then 'table' when 'p' then 'table'
                   when 'v' then 'view' when 'm' then 'matview' end,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', a.attname,
               'type', format_type(a.atttypid, a.atttypmod)
             ) order by a.attnum)
      from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ), '[]'::jsonb),
    now()
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  on conflict (relname) do update
    set relkind = excluded.relkind,
        columns = excluded.columns,
        auto_refreshed_at = excluded.auto_refreshed_at,
        updated_at = now();

  delete from public.silo_chat_schema_catalog s
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = s.relname
      and c.relkind in ('r', 'p', 'v', 'm')
  );

  select count(*) into v_count from public.silo_chat_schema_catalog;
  return v_count;
end;
$$;

revoke execute on function public.refresh_chat_schema_catalog() from public, anon, authenticated;
grant execute on function public.refresh_chat_schema_catalog() to service_role;

select public.refresh_chat_schema_catalog();

-- Hide secret-carrying / token / internal-plumbing tables from the model's
-- index. This is noise reduction and not-advertising-secret-stores, NOT
-- security -- their RLS already denies or scopes reads regardless.
update public.silo_chat_schema_catalog set is_hidden = true
where relname in (
  'org_invites', 'review_access_tokens', 'ad_platform_oauth_states',
  'shopify_oauth_states', 'ad_platform_connections', 'shopify_connections',
  'redo_connections', 'job_sync_state', 'silo_chat_schema_catalog'
);

-- ---------------------------------------------------------------------------
-- Curated business meaning, ported VERBATIM from the cheat-sheet block that
-- lived in silo-chat/index.ts's BASE_SYSTEM_PROMPT (removed there in the
-- same PR). Preserved across refreshes; edit here (or directly in the
-- table) rather than in the edge function from now on.
-- ---------------------------------------------------------------------------

update public.silo_chat_schema_catalog set
  keywords = array['sales','revenue','sold','units','daily','net','gross','refunds'],
  description = $d$Daily sales rollup by location/SKU. One row per day x location x SKU. Prefer sales_by_day_verification_v (de-duped) for cross-source date ranges.$d$
where relname = 'sales_by_day';

update public.silo_chat_schema_catalog set
  keywords = array['sales','revenue','sold','units','daily','dedupe'],
  description = $d$De-duped view over sales_by_day (prefers shopify_api source). Use this rather than raw sales_by_day when a date range may span both Better Reports history and Shopify API rows.$d$
where relname = 'sales_by_day_verification_v';

update public.silo_chat_schema_catalog set
  keywords = array['velocity','sell-through','rollup','monthly'],
  description = $d$Pre-aggregated sales rollups (with sales_monthly_location_rollup_v / sales_monthly_product_type_rollup_v) -- faster than grouping sales_by_day yourself for monthly/SKU-level questions.$d$
where relname = 'sales_velocity_by_sku_location_v';

update public.silo_chat_schema_catalog set
  keywords = array['inventory','stock','on-hand','restock','oos','warehouse'],
  description = $d$Current inventory by SKU/location with sell-through metrics -- already the LATEST snapshot only (one row per variant_sku x location, no need to dedupe by snapshot_at). The SKU column is variant_sku, not sku. There is no on_hand or sell_through_rate column -- on-hand is total_available_quantity; compute sell-through from qty_sold_30d and total_available_quantity. Velocity windows: qty_7d/qty_30d/qty_90d/qty_365d and avg_day_7/avg_day_30/avg_day_90/avg_day_365, plus est_days_before_oos and last_sold_date. When computing velocity or days-of-supply for a recently launched product, bound the window at the product's first sale date -- a fixed lookback longer than the product's life makes new launches read as dead stock.$d$
where relname = 'inventory_workboard_v';

update public.silo_chat_schema_catalog set
  keywords = array['inventory','stock','snapshot','history'],
  description = $d$Raw inventory snapshots over time (large -- 3.5M+ rows). The SKU column is variant_sku. For "current inventory" questions use inventory_workboard_v or inventory_on_hand_current_v instead; only query this directly for snapshot history.$d$
where relname = 'inventory_on_hand';

update public.silo_chat_schema_catalog set
  keywords = array['catalog','product','sku','cost','msrp','lifecycle'],
  description = $d$Product catalog. The vendor column is vendor_original (not vendor); cost is unit_cost (not cost). category and product_type are always identical (fully redundant) -- use either, don't waste a round checking both. department is sparse (~7% populated) -- don't rely on it for filtering. category/product_type hold granular values (e.g. "Youth Cap", "Youth Jacket") -- match a broad group with ilike 'Youth%' rather than = 'Youth'. Exception: Women's product_type is the bare exact value 'Women' -- go straight to product_type = 'Women' and narrow with product_title.$d$
where relname = 'products_master';

update public.silo_chat_schema_catalog set
  keywords = array['purchase','order','po','factory','incoming','buy'],
  description = $d$Purchase order headers. po_lines joins on po_lines.po_header_id = po_headers.id (not po_id). See also v_po_header_summary / v_open_pos and incoming_shipments for inbound tracking.$d$
where relname = 'po_headers';

update public.silo_chat_schema_catalog set
  keywords = array['purchase','order','po','lines','sku','qty'],
  description = $d$PO line items. Joins to po_headers on po_header_id. The SKU column is sku_snapshot (there is no sku column); quantity is qty; the title columns are title_snapshot / variant_title_snapshot.$d$
where relname = 'po_lines';

update public.silo_chat_schema_catalog set
  keywords = array['supplier','factory','vendor'],
  description = $d$Supplier/factory directory. The name column is factory_name (not name).$d$
where relname = 'factories';

update public.silo_chat_schema_catalog set
  keywords = array['payables','ap','payment','request','invoice','reimbursement'],
  description = $d$AP payment/approval requests and status. Prefer payment_requests_v for names/enrichment.$d$
where relname = 'payment_requests';

update public.silo_chat_schema_catalog set
  keywords = array['receivables','ar','invoice','wholesale','aging','customer'],
  description = $d$Accounts receivable -- wholesale customer balances and aging (with ar_invoices / ar_customer_rollup_v).$d$
where relname = 'ar_customers';

update public.silo_chat_schema_catalog set
  keywords = array['marketing','ads','spend','campaign','google','meta','tiktok','ga4','roas'],
  description = $d$Daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), campaign-level. The authoritative ledger for real ad spend by platform/day.$d$
where relname = 'marketing_kpis_daily';

update public.silo_chat_schema_catalog set
  keywords = array['meta','facebook','ads','creative','cpm','cac','ad-level'],
  description = $d$Ad-level (not just campaign-level) Meta performance. Joins to meta_ad_creatives(ad_id, creative_id, thumbnail_url, body, title, object_type, effective_status) on ad_id for creative metadata. object_type observed values are SHARE (single image/link ad), VIDEO, and STATUS (text-only) -- not a literal image/video/carousel taxonomy. body is the ad copy, title is the headline. For actual visual design call view_ad_creative_image with the ad_id -- sparingly, only for the specific ads the question is about. Compute CPM as spend/impressions*1000 and CAC as spend/conversions.$d$
where relname = 'meta_ad_performance_daily';

update public.silo_chat_schema_catalog set
  keywords = array['mer','marketing','efficiency','spend','blended'],
  description = $d$Ad spend vs. Shopify online net sales by day. This view's spend column is ad_spend, but meta_ad_performance_daily's is just spend -- same concept, different name per table; don't assume a column name carries over between tables.$d$
where relname = 'v_marketing_mer_daily';

update public.silo_chat_schema_catalog set
  keywords = array['orders','shopify','channel','customer','aov','pos','order'],
  description = $d$One row per Shopify order -- the pre-aggregation counterpart to sales_by_day. Use this (not sales_by_day) for individual orders, sales channel/source, customer-level order history, or AOV by channel. source_name is Shopify's raw channel field ("web", "pos", or an app id/slug for TikTok/Faire/Instagram); resolved_channel_name is the human-readable name from shopify_channel_map when mapped. total_price is the order's full total (subtotal + shipping + tax, before refunds) -- NOT the same metric as sales_by_day's total_gross_sales (pre-discount merchandise only) or Shopify Analytics' "Total sales"/"Gross sales" cards; never call total_price "gross sales", describe it as "order total" and flag the difference when a user compares against a Shopify Analytics screenshot. Coverage caveat: rows before a store's first full backfill are sparse, not absent -- min(shopify_created_at) alone does NOT prove continuous coverage; check for gaps (count distinct order dates vs. calendar days in range) before trusting a range wider than a few months, and say so if coverage looks discontinuous. If a source_name shows up unmapped, say so and suggest adding it to shopify_channel_map rather than guessing.$d$
where relname = 'shopify_orders_v';

update public.silo_chat_schema_catalog set
  keywords = array['basket','line','items','attach','together','order'],
  description = $d$Per-SKU line items within each Shopify order (quantity, price, discount_allocated, tax_allocated, vendor, product_type) -- for basket-level questions (attach rate, what's bought together). title is the as-sold line-item title, reliable even where SKUs are shared across products.$d$
where relname = 'shopify_order_lines';

update public.silo_chat_schema_catalog set
  keywords = array['returns','exchanges','refund','redo','store-credit','reason'],
  description = $d$Returns/exchanges/store-credit data from Redo (refund_amount, exchange_amount, store_credit_amount, status, reason; line items in redo_return_items). Covers only a recent slice of total Shopify refund volume -- not complete returns history.$d$
where relname = 'redo_returns';

update public.silo_chat_schema_catalog set
  keywords = array['projection','plan','forecast','budget','revenue'],
  description = $d$Monthly revenue plan by location + type (history in revenue_projection_history).$d$
where relname = 'revenue_projections';

update public.silo_chat_schema_catalog set
  keywords = array['launch','marketing','campaign','drop','collab','brief','angle','audience'],
  description = $d$Marketing launch pipeline. The name column is title (not launch_name or name); date columns are launch_date and preview_start_date -- there is no launch_window_start/launch_window_end or start_date/end_date. Other real columns: product_sku, product_title, collection_name, expected_units, status, launch_type. Holds each launch's release brief -- design_intent, product_callouts, marketing_angle, audience_tags (text[] -- prefer over the free-text audience column for comparing/grouping, e.g. unnest(audience_tags)), audience, special_callouts, copy_dos/copy_donts, creative_dos/creative_donts -- plus budget/forecast (preview_marketing_budget, post_launch_budget, projected_revenue) and after-the-fact performance (actual_preview_spend, actual_post_launch_spend, actual_revenue, performance_comparison, overperformed_notes, underperformed_notes). The primary source for "what angle/audience has this brand actually used, and did it work" -- more authoritative than inferring strategy from sales data alone. Note: actual_preview_spend/actual_post_launch_spend are hand-typed estimates, NOT synced from ad platforms -- marketing_kpis_daily is the authoritative spend ledger; if a question is specifically about ad spend accuracy, prefer marketing_kpis_daily and say so if the two differ. Related: launch_tasks / launch_channel_items / launch_product_readiness.$d$
where relname = 'launch_calendar';

update public.silo_chat_schema_catalog set
  keywords = array['locations','stores','channels'],
  description = $d$Sales channels/store locations.$d$
where relname = 'locations';

update public.silo_chat_schema_catalog set
  keywords = array['mail','mailroom','queue'],
  description = $d$Mailroom queue (mail_items_v joins assignee/submitter names).$d$
where relname = 'mail_items';

update public.silo_chat_schema_catalog set
  keywords = array['tiktok','live','schedule','payout','host'],
  description = $d$TikTok Live schedule and payouts (live_sessions_v joins claimer name).$d$
where relname = 'live_sessions';

update public.silo_chat_schema_catalog set
  keywords = array['calendar','events','dates','deadline'],
  description = $d$Org calendar -- one time layer over launches, tasks, POs, AP, paydays, live slots and mail.$d$
where relname = 'calendar_events_v';

update public.silo_chat_schema_catalog set
  keywords = array['employees','reviews','roster','performance'],
  description = $d$Performance review roster (with reviews). Careful: private_notes and similar are RLS-gated to the author only, so zero rows can come back even with a correct query -- expected, not a bug.$d$
where relname = 'employees';

update public.silo_chat_schema_catalog set
  keywords = array['notes','taught','knowledge','corrections','brand'],
  description = $d$Everything the team has taught Ask SILO -- brand context and specific corrections (see the save_note tool). silo_chat_notes_v joins author names.$d$
where relname = 'silo_chat_notes';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief'],
  description = $d$Ask SILO's Product Concepts drafts (parent/child collections, launch-plan brief fields, approval status). product_concepts_v joins parent title and resulting PO name.$d$
where relname = 'product_concepts';

-- ---------------------------------------------------------------------------
-- Ask SILO health scoreboard -- one row per day. security_invoker: each
-- caller sees stats over exactly the audit rows their RLS lets them see.
-- ---------------------------------------------------------------------------
create or replace view public.silo_chat_health_v
with (security_invoker = true) as
select
  date_trunc('day', created_at)::date as day,
  count(*) as questions,
  count(*) filter (where status = 'error') as errors,
  round(100.0 * count(*) filter (where status = 'error') / count(*), 1) as error_pct,
  count(*) filter (where error_message = 'forced final answer at round cap') as forced_finals,
  round(avg(tool_rounds), 1) as avg_rounds,
  (percentile_cont(0.9) within group (order by tool_rounds))::numeric(6,1) as p90_rounds,
  count(distinct created_by) as distinct_users
from public.silo_chat_audit_log
group by 1;

revoke all on public.silo_chat_health_v from anon;
grant select on public.silo_chat_health_v to authenticated;

-- ---------------------------------------------------------------------------
-- 20260822010000_shopify_order_lines_trgm_indexes.sql
-- Trigram indexes on shopify_order_lines (title/sku) — same ILIKE-speed fix
-- as sales_by_day/inventory_on_hand, for Ask SILO licensed-product and
-- basket-level name searches (MLB lockout question timed out here).
-- ---------------------------------------------------------------------------

create extension if not exists pg_trgm with schema extensions;

create index if not exists shopify_order_lines_title_trgm_idx
  on public.shopify_order_lines using gin (title extensions.gin_trgm_ops);

create index if not exists shopify_order_lines_sku_trgm_idx
  on public.shopify_order_lines using gin (sku extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 20260824000000_comp_adjustment_requests.sql
-- Compensation Adjustment Requests — Team module phase 2: raise / bonus /
-- promotion / equity requests, manager-submitted, routed to finance for
-- review and decision. See migrations/20260824000000_comp_adjustment_requests.sql
-- for the full commentary.
-- ---------------------------------------------------------------------------

create or replace function public.current_user_can_manage_comp_requests()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role in ('owner_admin','admin')
             else p.role::text = 'admin'
        end
        or p.department in ('finance','admin','exec')
      )
  );
$function$;

revoke execute on function public.current_user_can_manage_comp_requests() from public, anon;
grant execute on function public.current_user_can_manage_comp_requests() to authenticated, service_role;

create table if not exists public.comp_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  employee_id uuid not null references public.employees(id) on delete cascade,
  adjustment_type text not null check (adjustment_type in ('raise', 'bonus', 'promotion', 'equity', 'other')),
  current_compensation numeric(12,2),
  proposed_compensation numeric(12,2),
  current_title text,
  proposed_title text,
  effective_date date,
  justification text not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'in_review', 'needs_info', 'approved', 'denied')),
  finance_notes text,
  reviewed_by uuid references public.profiles(id),
  decided_at timestamptz,
  submitted_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comp_adjustment_requests_employee_idx on public.comp_adjustment_requests (employee_id);
create index if not exists comp_adjustment_requests_created_by_idx on public.comp_adjustment_requests (created_by);
create index if not exists comp_adjustment_requests_status_idx on public.comp_adjustment_requests (company_entity_id, status);

create table if not exists public.comp_adjustment_request_activity (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.comp_adjustment_requests(id) on delete cascade,
  company_entity_id uuid,
  activity_type text not null,
  message text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists comp_adjustment_request_activity_request_idx
  on public.comp_adjustment_request_activity (request_id);

create or replace function public.tg_comp_adjustment_requests_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_updated_at on public.comp_adjustment_requests;
create trigger touch_updated_at before update on public.comp_adjustment_requests
  for each row execute function public.tg_comp_adjustment_requests_touch_updated_at();

drop trigger if exists stamp_created_by on public.comp_adjustment_requests;
create trigger stamp_created_by before insert on public.comp_adjustment_requests
  for each row execute function public.stamp_created_by();

drop trigger if exists stamp_created_by on public.comp_adjustment_request_activity;
create trigger stamp_created_by before insert on public.comp_adjustment_request_activity
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

alter table public.comp_adjustment_requests enable row level security;
alter table public.comp_adjustment_request_activity enable row level security;

revoke all on public.comp_adjustment_requests, public.comp_adjustment_request_activity from anon;

drop policy if exists comp_adjustment_requests_active_select on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_select on public.comp_adjustment_requests for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      created_by = auth.uid()
      or public.is_employee_manager(employee_id)
      or public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
    )
  );

drop policy if exists comp_adjustment_requests_active_insert on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_insert on public.comp_adjustment_requests for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and created_by = auth.uid()
    and (public.is_employee_manager(employee_id) or public.is_exec_or_owner())
  );

drop policy if exists comp_adjustment_requests_active_update on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_update on public.comp_adjustment_requests for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
      or (created_by = auth.uid() and public.is_employee_manager(employee_id) and status = 'draft')
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
      or (created_by = auth.uid() and public.is_employee_manager(employee_id) and status in ('draft', 'submitted'))
    )
  );

drop policy if exists comp_adjustment_requests_active_delete on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_delete on public.comp_adjustment_requests for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (created_by = auth.uid() and status = 'draft')
    )
  );

drop policy if exists comp_adjustment_request_activity_select on public.comp_adjustment_request_activity;
create policy comp_adjustment_request_activity_select on public.comp_adjustment_request_activity for select to authenticated
  using (exists (select 1 from public.comp_adjustment_requests r where r.id = comp_adjustment_request_activity.request_id));

drop policy if exists comp_adjustment_request_activity_insert on public.comp_adjustment_request_activity;
create policy comp_adjustment_request_activity_insert on public.comp_adjustment_request_activity for insert to authenticated
  with check (exists (select 1 from public.comp_adjustment_requests r where r.id = comp_adjustment_request_activity.request_id));

create or replace view public.comp_adjustment_requests_v
with (security_invoker = true) as
select
  r.*,
  e.name as employee_name,
  e.email as employee_email,
  e.job_title as employee_job_title,
  rp.name as requested_by_name,
  rp.email as requested_by_email,
  vp.name as reviewed_by_name,
  vp.email as reviewed_by_email
from public.comp_adjustment_requests r
join public.employees e on e.id = r.employee_id
left join public.profiles rp on rp.id = r.created_by
left join public.profiles vp on vp.id = r.reviewed_by;

revoke all on public.comp_adjustment_requests_v from anon;
grant select on public.comp_adjustment_requests_v to authenticated;


-- ---------------------------------------------------------------------------
-- 20260825120000_product_concept_structured_workflow.sql
-- Product Concepts: structured brief template, per-field evidence
-- classification (INPUT/DATA/ASSUMPTION/RECOMMENDATION with a qualitative
-- strength), provenance, and immutable revision history. Fully additive --
-- existing concepts, policies, and views keep working untouched; legacy
-- rows simply have the new columns null and no revisions.
-- ---------------------------------------------------------------------------
-- Product Concepts: structured template, evidence classification, and
-- revision lineage.
--
-- Why: Ask SILO got good at grounding a concept in real data, but the
-- interaction stayed free-form. Two problems showed up in real use:
--
--   1. Repeated refinement of ONE idea stamped several unrelated-looking
--      product_concepts rows. There was no way to tell "revision 3 of the
--      Black Friday youth cap" from "a second, different youth cap idea."
--   2. The concept row had no place to record HOW SOLID each value was.
--      A qty derived from a real comparable's 90-day sell-through and a
--      qty guessed from a thin analogy looked identical once saved.
--
-- This migration is additive only. Every existing column, policy, view,
-- and row keeps working exactly as before -- legacy concepts simply have
-- no revisions and empty evidence metadata, which every consumer treats
-- as "not recorded" rather than an error. No column is dropped, no type
-- changed, no historical row rewritten, and no fuzzy de-duplication is
-- attempted across concepts already saved (per the brief: ambiguous
-- historical duplicates are left intact -- this makes FUTURE revisions
-- clean rather than retroactively rewriting the past).
--
-- Two axes now exist on product_concepts and they are deliberately
-- separate -- conflating them was the main design risk here:
--   parent_concept_id  -- COLLECTION axis (20260821170000): sibling
--                         products sharing one strategic brief.
--   product_concept_revisions -- HISTORY axis (this migration): earlier
--                         states of the SAME concept over time.
-- A child of a collection has its own independent revision history; a
-- revision is never a child concept. Keeping history in its own table
-- (rather than as more product_concepts rows behind an is_current flag)
-- means every existing query -- product_concepts_v, the Ask SILO run_sql
-- reads, the future PO Builder dropdown -- keeps returning exactly one
-- row per real concept with no is_current filter to remember. That was
-- the deciding factor: an is_current design silently turns every
-- pre-existing concept query into a duplicate-row bug.

-- ---------------------------------------------------------------------------
-- 1. Structured template fields (all nullable, all additive)
-- ---------------------------------------------------------------------------
-- The pre-existing suggested_* columns stay exactly as they are and keep
-- their meaning; these sit alongside them and cover the parts of a real
-- concept brief that previously had nowhere to go except prose inside
-- `reasoning`. jsonb where the shape is naturally a list or key-value and
-- needs to stay queryable downstream; plain text where it is genuinely a
-- sentence.

alter table public.product_concepts
  -- Product/category, in products_master.product_type's own vocabulary
  -- (e.g. "Youth Cap", "Women"). Concept identity carried this only
  -- implicitly, inside the title/summary prose, which breaks the handoff
  -- into the rest of SILO: po_lines.product_type_snapshot feeds
  -- product_tracker.product_type via PO Builder's new-product tracker
  -- sync, and every comparable-launch query groups by product_type. A
  -- concept that cannot name its own category loses that categorization
  -- at the first hop out of chat.
  add column if not exists suggested_product_type text,

  -- Objective: why this product should exist at all.
  add column if not exists objective text,
  add column if not exists primary_goal text,

  -- Target customer beyond the existing audience/audience_tags columns.
  add column if not exists secondary_audience text,
  add column if not exists audience_rationale text,

  -- Historical evidence actually consulted, as structured items rather
  -- than prose, e.g.
  --   [{"label":"Youth food shorts", "metric":"units, first 90 days",
  --     "value":"2400", "source":"sales_by_day", "strength":"strong"}]
  add column if not exists historical_evidence jsonb,

  -- Overall qualitative confidence in the concept as a whole. Deliberately
  -- NOT a percentage -- see the evidence_strength check below.
  add column if not exists evidence_strength text,

  -- Recommended buy: the existing suggested_qty holds the number, this
  -- holds why that number and not another.
  add column if not exists buy_rationale text,

  -- Supply / factory reasoning beyond just suggested_factory_id.
  add column if not exists supply_notes text,
  add column if not exists supply_constraints text,

  -- Economics, e.g. {"unit_cost":12.40,"msrp":48,"gross_margin_pct":74,
  --                  "inventory_investment":22320,"revenue_expectation":86400}
  -- Any key absent means "not supported by data" -- never a guessed number.
  add column if not exists economics jsonb,

  -- Three-scenario forecast with the assumptions behind each, e.g.
  --   {"conservative":{"units":900,"revenue":43200,"assumptions":"..."},
  --    "base":{...}, "upside":{...}}
  add column if not exists forecast jsonb,

  -- Creative direction (distinct from marketing_angle, which is the
  -- one-line hook, and suggested_marketing_copy, which is draft copy).
  add column if not exists creative_story text,
  add column if not exists visual_direction text,
  add column if not exists brand_fit text,

  -- Risks/unknowns, e.g.
  --   [{"category":"data","detail":"no comparable launch with week-level revenue"}]
  add column if not exists risks jsonb,

  -- Fields the template asks for but data could not support, with the
  -- reason. Exists so "we don't know" is recorded explicitly instead of
  -- being indistinguishable from "nobody filled this in yet", e.g.
  --   [{"field":"economics.unit_cost","why":"no prior PO for this factory + product type"}]
  add column if not exists unknowns jsonb,

  -- Overall call + the next HUMAN decision needed to move this forward.
  add column if not exists recommendation text,
  add column if not exists recommendation_reasoning text,
  add column if not exists next_decision text,

  -- Per-field evidence classification: which of the four classes each
  -- important value belongs to, and how strong it is, e.g.
  --   {"suggested_qty":{"class":"RECOMMENDATION","strength":"moderate",
  --                     "note":"derived from youth cap 90-day sell-through"},
  --    "title":{"class":"INPUT"}}
  -- Keyed by concept column name so the UI can badge a value without a
  -- lookup table. A field absent from this object simply has no recorded
  -- classification -- which is exactly the state every legacy row is in.
  add column if not exists field_evidence jsonb,

  -- Provenance: enough metadata to answer "why did SILO recommend 1,800
  -- units?" later without exposing raw SQL by default, e.g.
  --   [{"claim":"suggested_qty","tables":["sales_by_day","launch_calendar"],
  --     "date_range":"2025-09-01..2026-08-01","metrics":["units_90d"],
  --     "skus":["YTH-CAP-001"],"note":"..."}]
  add column if not exists provenance jsonb,

  -- Set by whoever performs an UPDATE to describe that change in one
  -- line; the revision trigger below copies it onto the revision row it
  -- creates and it is then overwritten by the next change. Reading this
  -- column on the live row tells you what the most recent change was.
  add column if not exists revision_note text,

  -- Always equals the number of the revision the live row represents.
  -- Starts at 1; the trigger below increments it on every real change.
  add column if not exists current_revision_number integer not null default 1;

-- Qualitative strength labels only. The brief is explicit that fake
-- confidence percentages are worse than no number, because a computed-
-- looking "72% confident" invites exactly the false precision the whole
-- evidence-classification idea exists to prevent.
alter table public.product_concepts
  drop constraint if exists product_concepts_evidence_strength_check;
alter table public.product_concepts
  add constraint product_concepts_evidence_strength_check
  check (evidence_strength is null or evidence_strength in ('strong', 'moderate', 'early'));

alter table public.product_concepts
  drop constraint if exists product_concepts_primary_goal_check;
alter table public.product_concepts
  add constraint product_concepts_primary_goal_check
  check (primary_goal is null or primary_goal in (
    'revenue', 'margin', 'brand', 'acquisition', 'existing_demand', 'experiment'
  ));

alter table public.product_concepts
  drop constraint if exists product_concepts_recommendation_check;
alter table public.product_concepts
  add constraint product_concepts_recommendation_check
  check (recommendation is null or recommendation in (
    'proceed', 'proceed_with_changes', 'refine', 'hold', 'reject'
  ));

-- ---------------------------------------------------------------------------
-- 2. Revision history
-- ---------------------------------------------------------------------------
-- One row per SUPERSEDED state of a concept. The live product_concepts row
-- is always the current revision and is never duplicated in here, so
-- "give me the current concept" stays a plain select on product_concepts
-- with no filtering -- the property that makes this design non-breaking.
--
-- Immutable by construction: there are no insert/update/delete policies on
-- this table at all, and the only writer is the SECURITY DEFINER trigger
-- below. Same stance as sample_notification_log (function-written, never
-- client-written). Preserving prior concept work is a hard requirement of
-- the brief, so it is enforced in the schema rather than by convention.

create table if not exists public.product_concept_revisions (
  id                     uuid primary key default gen_random_uuid(),
  concept_id             uuid not null references public.product_concepts(id) on delete cascade,
  company_entity_id      uuid references public.entities(id),

  -- The revision number this snapshot represents (i.e. the number the
  -- concept carried BEFORE the change that created this row).
  revision_number        integer not null,

  -- The immediately-previous revision row, giving an explicit chain in
  -- addition to the implicit revision_number ordering.
  supersedes_revision_id uuid references public.product_concept_revisions(id) on delete set null,

  -- Full to_jsonb() of the concept row as it was at this revision.
  snapshot               jsonb not null,

  -- Column names whose values actually changed in the update that
  -- superseded this snapshot -- lets a diff view avoid re-comparing blobs.
  changed_fields         text[] not null default '{}',

  -- One-line description of the change, sourced from the concept's
  -- revision_note at update time.
  change_summary         text,

  created_by             uuid references public.profiles(id),
  created_at             timestamptz not null default now(),

  unique (concept_id, revision_number)
);

create index if not exists product_concept_revisions_concept_idx
  on public.product_concept_revisions (concept_id, revision_number desc);

create index if not exists product_concept_revisions_company_idx
  on public.product_concept_revisions (company_entity_id, created_at desc);

alter table public.product_concept_revisions enable row level security;

-- Read follows the parent concept's own visibility. No write policies
-- exist on purpose: history is written only by the trigger below.
drop policy if exists product_concept_revisions_select on public.product_concept_revisions;
create policy product_concept_revisions_select on public.product_concept_revisions
  for select using (company_entity_id = active_company_id());

revoke all on public.product_concept_revisions from anon;
grant select on public.product_concept_revisions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Revision trigger
-- ---------------------------------------------------------------------------
-- Fires on every real UPDATE of a concept: snapshots the OLD state into
-- product_concept_revisions and advances the live row's revision number.
--
-- SECURITY DEFINER because product_concept_revisions intentionally has no
-- INSERT policy for anyone -- history must be recorded whether the update
-- came from the Ask SILO edge function, a page, or hand-written SQL, and
-- must not be suppressible by the person making the change. It only ever
-- writes a copy of a row the caller was already permitted to update (RLS
-- on product_concepts has already passed by the time this runs), so it
-- grants no read or write reach the caller did not already have.
--
-- BEFORE UPDATE rather than AFTER so it can set NEW.current_revision_number
-- in the same pass; the inserted snapshot is of OLD, which is complete and
-- final at this point regardless.

create or replace function public.record_product_concept_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed  text[];
  v_previous uuid;
begin
  -- Ignore no-op updates (a PostgREST patch that sets a column to the
  -- value it already had would otherwise mint an empty revision).
  if to_jsonb(old.*) - 'updated_at' - 'current_revision_number' - 'revision_note'
     = to_jsonb(new.*) - 'updated_at' - 'current_revision_number' - 'revision_note' then
    return new;
  end if;

  select coalesce(array_agg(n.key order by n.key), '{}'::text[])
    into v_changed
  from jsonb_each(to_jsonb(new.*)) n(key, value)
  where n.key not in ('updated_at', 'current_revision_number', 'revision_note')
    and n.value is distinct from (to_jsonb(old.*) -> n.key);

  select id into v_previous
  from public.product_concept_revisions
  where concept_id = old.id
  order by revision_number desc
  limit 1;

  insert into public.product_concept_revisions (
    concept_id, company_entity_id, revision_number, supersedes_revision_id,
    snapshot, changed_fields, change_summary, created_by
  ) values (
    old.id,
    old.company_entity_id,
    old.current_revision_number,
    v_previous,
    to_jsonb(old.*),
    v_changed,
    new.revision_note,
    auth.uid()
  );

  new.current_revision_number := old.current_revision_number + 1;
  return new;
end;
$$;

-- Named with the trg_ prefix used elsewhere in this schema. Ordering
-- against the existing set_updated_at BEFORE UPDATE trigger does not
-- matter: this one ignores updated_at entirely when diffing.
drop trigger if exists trg_product_concept_revision on public.product_concepts;
create trigger trg_product_concept_revision
  before update on public.product_concepts
  for each row execute function public.record_product_concept_revision();

-- ---------------------------------------------------------------------------
-- 4. Views
-- ---------------------------------------------------------------------------
-- product_concepts_v gains the new columns.
--
-- DROP then CREATE rather than CREATE OR REPLACE: replace can only APPEND
-- columns, never insert one into the middle, so re-running this migration
-- after adding a column anywhere but the end fails with "cannot change
-- name of view column X to Y" -- hit for real while adding
-- suggested_product_type here. Dropping first makes the migration
-- re-runnable no matter how the column list is later reordered. Safe
-- because nothing in the database depends on this view (it is read by
-- Ask SILO queries and the UI, not by other views/matviews), and the
-- grants below are reissued immediately after.

drop view if exists public.product_concepts_v;
create view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name,
  c.suggested_size_breakdown,
  c.suggested_channel_split,
  c.suggested_launch_time,
  c.suggested_marketing_spend,
  c.suggested_weekly_revenue_projection,
  c.suggested_email_sms_plan,
  c.suggested_marketing_copy,
  c.parent_concept_id,
  parent.title as parent_title,
  -- structured template (20260825120000)
  c.suggested_product_type,
  c.objective,
  c.primary_goal,
  c.secondary_audience,
  c.audience_rationale,
  c.historical_evidence,
  c.evidence_strength,
  c.buy_rationale,
  c.supply_notes,
  c.supply_constraints,
  c.economics,
  c.forecast,
  c.creative_story,
  c.visual_direction,
  c.brand_fit,
  c.risks,
  c.unknowns,
  c.recommendation,
  c.recommendation_reasoning,
  c.next_decision,
  c.field_evidence,
  c.provenance,
  c.revision_note,
  c.current_revision_number,
  (select count(*) from public.product_concept_revisions r where r.concept_id = c.id) as revision_count
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;

-- History with author names and the concept's title, for a revision
-- drawer or an "how did this concept evolve" question in chat.
drop view if exists public.product_concept_revisions_v;
create view public.product_concept_revisions_v
with (security_invoker = true) as
select
  r.id,
  r.concept_id,
  c.title as concept_title,
  r.company_entity_id,
  r.revision_number,
  r.supersedes_revision_id,
  r.changed_fields,
  r.change_summary,
  r.snapshot,
  r.created_by,
  p.name as created_by_name,
  r.created_at
from public.product_concept_revisions r
left join public.product_concepts c on c.id = r.concept_id
left join public.profiles p on p.id = r.created_by;

revoke all on public.product_concept_revisions_v from anon;
grant select on public.product_concept_revisions_v to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Ask SILO schema catalog
-- ---------------------------------------------------------------------------
-- Required after any migration that changes public tables/views, per
-- 20260821210000_silo_chat_schema_catalog.sql. Auto-generates the column
-- lists for the new table/views and refreshes the changed ones; the
-- curated descriptions below are what the model actually reads for
-- meaning, so they are set explicitly rather than left to drift.

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief','revision','evidence'],
  description = $d$Ask SILO's Product Concepts. ONE row per real concept, always the CURRENT state -- superseded states live in product_concept_revisions, so this table never needs an is_current filter and never returns the same concept twice. Two independent axes: parent_concept_id groups a COLLECTION (sibling products sharing one strategic brief -- parent holds angle/audience/timing/spend, children hold title/qty/factory/size), while revision history is the separate time axis. suggested_product_type names the category in products_master.product_type's own vocabulary (e.g. "Youth Cap") and is what carries into po_lines.product_type_snapshot when a concept becomes a PO. Beyond the suggested_* draft fields it carries a structured brief: objective/primary_goal, historical_evidence, economics, forecast (conservative/base/upside), risks, unknowns, recommendation/next_decision, plus field_evidence (per-field INPUT/DATA/ASSUMPTION/RECOMMENDATION classification with a qualitative strength) and provenance (which tables/date ranges/metrics backed each claim). evidence_strength is qualitative -- strong/moderate/early, never a percentage. Legacy concepts created before 2026-08-25 have these columns null and no revisions; that means "not recorded", not "zero". product_concepts_v adds creator/approver/factory/parent names and revision_count.$d$
where relname = 'product_concepts';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','revision','history','lineage','version','changes'],
  description = $d$Immutable history for product_concepts -- one row per SUPERSEDED state, written only by a database trigger (no client can insert, update, or delete). snapshot is the full concept row as it was; revision_number is the number the concept carried at that point; changed_fields/change_summary describe the edit that replaced it; supersedes_revision_id chains to the prior revision. The CURRENT state is never in here -- it is the live product_concepts row. Query this only when a user explicitly asks about history/how a concept changed; product_concept_revisions_v adds the concept title and author name.$d$
where relname = 'product_concept_revisions';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','revision','history','lineage','version'],
  description = $d$product_concept_revisions with the concept's title and the author's name joined in. Same rule as the base table: superseded states only, never the current one.$d$
where relname = 'product_concept_revisions_v';


-- ---------------------------------------------------------------------------
-- 20260825150000_chat_readonly_query_whitespace_fix.sql
-- Ask SILO run_sql guard: trim() strips spaces only, so a query beginning
-- with a newline (how a model formats a multi-line CTE) was rejected as
-- "not a SELECT". Normalises leading whitespace/comments and a single
-- trailing semicolon before the check; rejections and limits unchanged.
-- ---------------------------------------------------------------------------
-- Ask SILO run_sql: stop rejecting valid queries over leading whitespace.
--
-- Bug: the guard in chat_run_readonly_query used `trim(query)`, and
-- Postgres `trim()` strips SPACES ONLY -- not newlines or tabs. A query
-- beginning with a newline (exactly how a model formats a multi-line CTE,
-- which the system prompt explicitly instructs it to write) therefore
-- failed the `^(select|with)` check and was rejected with:
--
--     Only a single SELECT or WITH (read-only) statement is allowed
--
-- That message describes the wrong problem. The caller reads it as "your
-- statement isn't a SELECT", rewrites the query, formats it across lines
-- again, and fails identically -- a loop that burns tool rounds and ends
-- with the model correctly refusing to guess.
--
-- Observed live 2026-08-25: a Product Concepts phase-2 pass recorded six
-- fields (size breakdown, channel split, marketing spend, weekly revenue,
-- marketing copy, unit cost) as unknown, each citing "repeated query
-- tooling error" / "query not completed this session". Verified by
-- reproduction: 'select 1 as ok' succeeds, E'\nselect 1 as ok' does not.
--
-- Also handled here, same class of false rejection:
--   - leading SQL comments (`-- what this does` before the SELECT)
--   - a single trailing semicolon, which is natural to write and harmless
--     once stripped
--
-- Security posture is unchanged, and if anything tightened: the statement
-- is normalised BEFORE the ^(select|with) test, so the test now sees the
-- real first keyword instead of being defeated by whitespace. Anything
-- that does not genuinely begin with SELECT/WITH after normalisation is
-- still rejected, internal semicolons are still rejected, the 10s
-- statement timeout and 500-row cap are untouched, and the function
-- remains non-SECURITY-DEFINER so RLS continues to scope every read to
-- the calling user.

create or replace function public.chat_run_readonly_query(query text)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  result  jsonb;
  trimmed text;
begin
  -- Normalise: strip any leading run of whitespace and/or SQL comments,
  -- then trailing whitespace. btrim with an explicit character set --
  -- the bare trim()/btrim() default is a space, which was the bug.
  trimmed := btrim(
    regexp_replace(query, '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''),
    E' \t\r\n'
  );

  -- One trailing semicolon is fine; strip it rather than rejecting the
  -- whole statement over it. Anything beyond that still trips the
  -- multi-statement guard below.
  if right(trimmed, 1) = ';' then
    trimmed := btrim(left(trimmed, length(trimmed) - 1), E' \t\r\n');
  end if;

  if trimmed !~* '^(select|with)\s' then
    -- Echo what was actually parsed. The old message named the wrong
    -- problem and gave the caller nothing to correct against.
    raise exception
      'Only a single SELECT or WITH (read-only) statement is allowed (parsed statement began: %)',
      left(coalesce(nullif(trimmed, ''), '<empty>'), 40);
  end if;

  if trimmed ~ ';' then
    raise exception 'Statement must not contain a semicolon (single statement only)';
  end if;

  set local statement_timeout = '10s';

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) user_query limit 500) t',
    trimmed
  ) into result;

  return result;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 20260825140000_product_concept_phase.sql
-- Product Concepts: phase ('core_draft' | 'full_brief') as real state
-- rather than system-prompt text, orthogonal to status. Deterministic
-- backfill from existing launch-plan columns, with the revision trigger
-- suspended for that one statement so migration bookkeeping does not
-- appear as edit history.
-- ---------------------------------------------------------------------------
-- Product Concepts: phase as real state, not model discretion.
--
-- Why: the two-phase flow (fast core draft, then the full launch-plan
-- brief only once asked) existed ONLY as system-prompt text. Nothing
-- recorded which phase a concept was at, so:
--   - the UI could not offer "build out the full plan" as a control; the
--     model had to remember to ask, and live it sometimes asked for
--     permission it had already been told not to ask for
--   - a concepts list has no way to show a sketch vs. a finished brief
--   - "is this done?" was answerable only by eyeballing which columns
--     happen to be null
--
-- phase is deliberately ORTHOGONAL to status. status is the approval axis
-- (draft -> approved -> archived); phase is the completeness axis
-- (core_draft -> full_brief). A concept can be an approved core draft, or
-- a full brief still awaiting sign-off. Collapsing them into one column
-- would make both meanings worse.

alter table public.product_concepts
  add column if not exists phase text not null default 'core_draft';

alter table public.product_concepts
  drop constraint if exists product_concepts_phase_check;
alter table public.product_concepts
  add constraint product_concepts_phase_check
  check (phase in ('core_draft', 'full_brief'));

-- Deterministic, additive backfill (the brief permits exactly this, and
-- forbids fuzzy rewriting of history): a concept that already carries any
-- phase-2 launch-plan field was, by definition, built out.
--
-- The revision trigger is suspended for this one statement. A backfill is
-- bookkeeping, not a human editing a concept -- minting a revision on
-- every historical row would bury real edit history under migration
-- noise, and auth.uid() is null in migration context so those revisions
-- would be unattributed anyway. Ordinary phase changes made later by a
-- person or the edge function DO record a revision, which is correct:
-- core_draft -> full_brief is a real state change worth keeping.
alter table public.product_concepts disable trigger trg_product_concept_revision;

update public.product_concepts
set phase = 'full_brief'
where phase = 'core_draft'
  and (
    suggested_size_breakdown is not null
    or suggested_channel_split is not null
    or suggested_marketing_spend is not null
    or suggested_weekly_revenue_projection is not null
    or suggested_email_sms_plan is not null
    or suggested_marketing_copy is not null
  );

alter table public.product_concepts enable trigger trg_product_concept_revision;

create index if not exists product_concepts_company_phase_idx
  on public.product_concepts (company_entity_id, phase, status, updated_at desc);

-- DROP + CREATE, not CREATE OR REPLACE -- replace cannot insert a column
-- into the middle of a view's select list, and this migration must stay
-- re-runnable regardless of future column ordering (see the note in
-- 20260825120000). Nothing in the database depends on these views.
drop view if exists public.product_concepts_v;
create view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.phase,
  c.created_at,
  c.updated_at,
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name,
  c.suggested_size_breakdown,
  c.suggested_channel_split,
  c.suggested_launch_time,
  c.suggested_marketing_spend,
  c.suggested_weekly_revenue_projection,
  c.suggested_email_sms_plan,
  c.suggested_marketing_copy,
  c.parent_concept_id,
  parent.title as parent_title,
  c.suggested_product_type,
  c.objective,
  c.primary_goal,
  c.secondary_audience,
  c.audience_rationale,
  c.historical_evidence,
  c.evidence_strength,
  c.buy_rationale,
  c.supply_notes,
  c.supply_constraints,
  c.economics,
  c.forecast,
  c.creative_story,
  c.visual_direction,
  c.brand_fit,
  c.risks,
  c.unknowns,
  c.recommendation,
  c.recommendation_reasoning,
  c.next_decision,
  c.field_evidence,
  c.provenance,
  c.revision_note,
  c.current_revision_number,
  (select count(*) from public.product_concept_revisions r where r.concept_id = c.id) as revision_count,
  (select count(*) from public.product_concepts ch where ch.parent_concept_id = c.id) as child_count
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief','revision','evidence','phase'],
  description = $d$Ask SILO's Product Concepts. ONE row per real concept, always the CURRENT state -- superseded states live in product_concept_revisions, so this table never needs an is_current filter and never returns the same concept twice. TWO ORTHOGONAL AXES OF STATE: status is approval (draft -> approved -> archived); phase is completeness (core_draft = title/angle/qty/factory/timing only; full_brief = the launch-plan fields are filled in too). An approved core_draft and an unapproved full_brief are both normal. A third axis, parent_concept_id, groups a COLLECTION (sibling products sharing one strategic brief -- parent holds angle/audience/timing/spend, children hold title/qty/factory/size); revision history is a fourth, time axis. suggested_product_type names the category in products_master.product_type's own vocabulary (e.g. "Youth Cap") and is what carries into po_lines.product_type_snapshot when a concept becomes a PO. Beyond the suggested_* draft fields it carries a structured brief: objective/primary_goal, historical_evidence, economics, forecast (conservative/base/upside), risks, unknowns, recommendation/next_decision, plus field_evidence (per-field INPUT/DATA/ASSUMPTION/RECOMMENDATION classification with a qualitative strength) and provenance (which tables/date ranges/metrics backed each claim). evidence_strength is qualitative -- strong/moderate/early, never a percentage. Legacy concepts created before 2026-08-25 have these columns null and no revisions; that means "not recorded", not "zero". product_concepts_v adds creator/approver/factory/parent names, revision_count and child_count.$d$
where relname = 'product_concepts';


-- ---------------------------------------------------------------------------
-- 20260825170000_chat_catalog_rollup_descriptions.sql
-- Ask SILO schema catalog: describe the pre-aggregated rollups so the model
-- can find them (5 of 6 had no description and no keywords, so they were
-- unscoreable and it fell back to the 567 MB / 2 GB raw tables), and hide
-- the matviews, which authenticated cannot select at all.
-- ---------------------------------------------------------------------------
-- Ask SILO: teach the schema catalog about the pre-aggregated rollups.
--
-- Observed live: asked for a size curve and a store split, the model went
-- to shopify_order_lines (567 MB) and sales_by_day (2 GB) every time,
-- never to the rollups built for exactly those questions. Measured on the
-- same size-curve question:
--
--   sales_velocity_by_sku_location_v      96.7 ms   (1,805 buffers, all cached)
--   shopify_order_lines + shopify_orders  795.3 ms  (8,377 buffers, 1,334 disk reads)
--
-- 8x, and the slow path touches disk -- which on a colder cache or a
-- broader product match is how a query reaches the 10s statement timeout
-- and gets abandoned.
--
-- Root cause is in this table, not in the model. buildSchemaSection()
-- scores a relation by name (+5), keywords (+3) and description (+1). Five
-- of the six rollups had NO description and NO keywords, so they could
-- only ever match on their own name -- never surfacing for "size",
-- "channel", "velocity" or "sell-through". They fell through to the
-- one-line index, where their line renders effectively blank because it is
-- built from the description. The model was shown
-- "- sales_sku_location_rollup_mv (matview)" and nothing else, while
-- shopify_order_lines carried a rich keyworded entry. It picked the only
-- thing it could see described.
--
-- Two fixes here:
--   1. Hide the three _mv entries. `authenticated` has no SELECT on any
--      matview (correctly -- matviews cannot carry RLS, so direct access
--      would bypass tenant scoping). Advertising them can only produce a
--      permission error and a wasted tool round. The _v wrappers are the
--      supported path; they are security_invoker and filter on
--      active_company_id().
--   2. Give the _v rollups descriptions that say what grain they hold,
--      how fast they are, and when NOT to use them.
--
-- Deliberately honest about which are actually fast: only
-- sales_velocity_by_sku_location_v and sales_monthly_product_type_rollup_v
-- read from a materialized view. sales_sku_location_rollup_v and
-- sales_monthly_location_rollup_v aggregate live from sales_by_day despite
-- the matching _mv names (228 ms on an indexed SKU filter, worse
-- unfiltered) -- telling the model they are "fast rollups" would just
-- move the problem.

-- 1. Matviews are not client-selectable; keep them out of the model's index.
update public.silo_chat_schema_catalog set is_hidden = true
where relname in (
  'sales_velocity_by_sku_location_mv',
  'sales_sku_location_rollup_mv',
  'sales_monthly_product_type_rollup_mv',
  'inventory_on_hand_current_mv'
);

-- 2. The genuinely pre-computed paths.

update public.silo_chat_schema_catalog set
  keywords = array['velocity','sell-through','size','size curve','sizes','store','location','channel','split','90 days','fast','rollup'],
  description = $d$FASTEST path for "how fast does this sell" and "what did a comparable product do in its first 90 days" -- units are PRE-COMPUTED per variant SKU per location, so prefer this over grouping sales_by_day or shopify_order_lines yourself (measured 8x faster on a size-curve question, and it stays in cache instead of hitting disk). Columns: variant_sku, product_name, location_tag, qty_7d/qty_30d/qty_90d/qty_120d/qty_365d, matching avg_day_* rates, last_sold_date. qty_90d already IS the 90-day sell-through figure -- do not recompute it from raw sales. SIZE CURVE: variant_sku encodes size as its second dash-separated segment (01-M-CoopClassicBlack, 01-2XL-CoopClassicBlack, 12-L-CoopClassic-Youth), so split_part(variant_sku,'-',2) gives a size breakdown directly, with no need to touch order lines. STORE/CHANNEL SPLIT: group by location_tag. No day-level detail here -- if you genuinely need per-day movement, fall back to sales_by_day_verification_v.$d$
where relname = 'sales_velocity_by_sku_location_v';

update public.silo_chat_schema_catalog set
  keywords = array['monthly','seasonality','season','product type','category','channel','mix','trend','rollup','fast'],
  description = $d$Pre-computed monthly sales by location, channel and product_type: units, gross, discounts, refunds, net, total_sales, unique_skus, avg_net_per_unit, month_start/month_key. FASTEST path for seasonality by category ("when does this product type actually sell"), channel mix over time, and month-over-month movement -- prefer it over grouping sales_by_day yourself. Note this is real observed seasonality: when products_master has no peak_start_month/peak_end_month for a category, this view can still answer the timing question from what actually sold, rather than reporting the season as unknown.$d$
where relname = 'sales_monthly_product_type_rollup_v';

-- 3. The live-aggregating ones -- useful, but not the fast path. Saying so
--    explicitly matters: their _mv-sounding names imply otherwise.

update public.silo_chat_schema_catalog set
  keywords = array['sku','location','lifetime','totals','first sold','last sold'],
  description = $d$All-time units/gross/net per SKU per location, with first_sold_date and last_sold_date -- useful for lifetime totals and for finding when a product actually started selling (e.g. to bound a launch window). Aggregates LIVE from sales_by_day despite the name, so it is not pre-computed: filter it (sku/location) rather than scanning it whole. For velocity or a size curve prefer sales_velocity_by_sku_location_v, which is genuinely pre-computed.$d$
where relname = 'sales_sku_location_rollup_v';

update public.silo_chat_schema_catalog set
  keywords = array['monthly','location','store','totals','trend'],
  description = $d$Monthly units/gross/net per location. Aggregates LIVE from sales_by_day, so it is not pre-computed -- for category or channel seasonality prefer sales_monthly_product_type_rollup_v, which is.$d$
where relname = 'sales_monthly_location_rollup_v';

-- 4. Point the raw tables at the faster alternative, so the model has the
--    comparison in front of it at the moment it is choosing.

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ SPEED: this is the raw 567 MB line-item table. For a size curve, unit velocity or a store/channel split, sales_velocity_by_sku_location_v answers the same question from pre-computed figures roughly 8x faster -- come here only for genuinely basket-level questions (what was bought together, attach rate, per-order discounting) that no rollup can answer.$d$
where relname = 'shopify_order_lines'
  and coalesce(description, '') not like '%SPEED:%';

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ SPEED: 2 GB and day-grain. If you only need totals, velocity or a size curve, sales_velocity_by_sku_location_v is pre-computed and far faster; come here for per-day detail or for date ranges spanning the pre-API history.$d$
where relname = 'sales_by_day'
  and coalesce(description, '') not like '%SPEED:%';


-- ---------------------------------------------------------------------------
-- 20260825190000_chat_catalog_source_coverage_reality.sql
-- Ask SILO schema catalog: describe what each source ACTUALLY contains
-- today. launch_calendar's brief fields are empty across all 51 rows, so
-- grounding angle/audience/revenue there costs a round and returns nothing
-- -- and reporting their absence as a concept risk is noise. Also records
-- the ad-data coverage boundaries (marketing_kpis_daily from 2025-08-14;
-- meta_ad_performance_daily only ~7 weeks).
-- ---------------------------------------------------------------------------
