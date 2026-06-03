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

create or replace view public.v_po_header_summary as
select
  h.id,
  h.po_name,
  h.factory_id,
  f.factory_name,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  h.date_bucket,
  h.status,
  h.wholesale_triggered,
  h.is_new_product_po,
  h.notes,
  h.internal_notes,
  h.created_at,
  h.updated_at,
  coalesce(sum(l.qty), 0) as total_units,
  coalesce(sum(l.retail_value), 0) as total_retail_value,
  coalesce(sum(coalesce(l.unit_cost, 0) * coalesce(l.qty, 0)), 0) as total_estimated_cost,
  count(l.id) as line_count,
  count(distinct nullif(btrim(l.title_snapshot), '')) as style_count
from public.po_headers h
left join public.factories f on f.id = h.factory_id
left join public.po_lines l on l.po_header_id = h.id
group by
  h.id, h.po_name, h.factory_id, f.factory_name,
  h.order_date, h.req_ship_date, h.expected_arrival_date, h.date_bucket,
  h.status, h.wholesale_triggered, h.is_new_product_po,
  h.notes, h.internal_notes, h.created_at, h.updated_at;

create or replace view public.v_po_incoming_summary as
select
  s.*,
  s.created_at as po_created_at,
  (s.total_retail_value - s.total_estimated_cost) as retail_cost_spread
from public.v_po_header_summary s;

create or replace view public.v_po_incoming_lines as
select
  h.id as po_header_id,
  l.id as po_line_id,
  h.po_name,
  f.factory_name,
  h.status,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  h.date_bucket,
  h.created_at as po_created_at,
  l.product_type_snapshot as product_type,
  l.title_snapshot as product_title,
  l.variant_title_snapshot as variant_title,
  l.sku_snapshot as sku,
  l.upc_snapshot as upc,
  l.qty,
  l.retail_price,
  l.unit_cost,
  l.retail_value,
  (coalesce(l.unit_cost, 0) * coalesce(l.qty, 0)) as estimated_cost
from public.po_headers h
join public.po_lines l on l.po_header_id = h.id
left join public.factories f on f.id = h.factory_id;

-- Open PO lines for planning scenarios (non-closed / non-cancelled)
create or replace view public.v_po_open_planning_lines as
select
  l.po_header_id,
  l.id as po_line_id,
  h.po_name,
  h.status,
  f.factory_name,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date) as planning_date,
  to_char(coalesce(h.expected_arrival_date, h.req_ship_date, h.order_date), 'YYYY-MM') as month_key,
  h.date_bucket,
  l.product_type_snapshot as product_type,
  l.title_snapshot as product_title,
  l.variant_title_snapshot as variant_title,
  l.sku_snapshot as sku,
  l.qty as incoming_units,
  l.retail_value as incoming_retail_value,
  (coalesce(l.unit_cost, 0) * coalesce(l.qty, 0)) as incoming_cost
from public.po_headers h
join public.po_lines l on l.po_header_id = h.id
left join public.factories f on f.id = h.factory_id
where coalesce(h.status, 'Draft') not in ('Closed', 'Cancelled', 'Received');

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

