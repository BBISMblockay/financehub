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
