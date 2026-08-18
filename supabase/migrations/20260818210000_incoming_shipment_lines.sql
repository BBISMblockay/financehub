-- =============================================================================
-- Incoming shipment tracking for /v2/po-report.html
--
-- Harrison's Google Sheets PO tracker logs, per PO, which items shipped when
-- (some POs land in more than one delivery -- e.g. a "2nd half shipment")
-- with a tracking number and status per delivery. This gives PO Report the
-- same capability natively.
--
-- `incoming_shipments` already exists live in prod (applied directly, no
-- migration on file -- see CLAUDE.md "repo drift" notes) with RLS that only
-- let the PO's creator or an admin insert. This migration:
--   1. Adds the table to the repo (idempotent, matches prod schema exactly)
--   2. Widens the write policies to any active company member (any teammate
--      logging tracking info, not just the PO's creator/an admin)
--   3. Adds `incoming_shipment_lines` so a shipment can call out exactly
--      which PO lines (products) it covers, since items on one PO can ship
--      separately. `qty` is nullable: null means "this shipment carries the
--      line's full qty" -- only set it when a line itself is split across
--      more than one shipment.
-- =============================================================================

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

-- Was creator/admin-only; any active company member may log a shipment.
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

-- ---------------------------------------------------------------------------
-- Per-shipment line assignment (which products are in this delivery)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Reporting view for PO Report: one row per (shipment x assigned line)
-- ---------------------------------------------------------------------------

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
