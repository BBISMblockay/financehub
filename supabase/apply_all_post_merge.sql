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
  check (job_type = any (array[
    'test_connection'::text,
    'history_import'::text,
    'incremental_sales'::text,
    'inventory_snapshot'::text,
    'catalog_sync'::text,
    'payouts_sync'::text
  ]));

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
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync',
    'supermetrics_kpis'
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
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync',
    'supermetrics_kpis', 'draft_orders_sync'
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
