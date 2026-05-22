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
      and lower(coalesce(p.role::text, 'user')) in (
        'owner', 'admin', 'finance', 'exec', 'executive', 'buyer', 'purchasing', 'operations'
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
