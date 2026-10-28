-- =============================================================================
-- Bookings above shipments, and ONE arrival date every surface can read
--
-- Two problems, measured live on 2026-10-28:
--
--  1. A consolidated container carrying several POs had no object. Each PO got
--     its own `incoming_shipments` row with the dates re-typed, and the column
--     meant to group them (`container_ref`) was set on 0 of 13 production
--     shipments. Live: Incotexco-480 (two rows) and Incotexco-486 all carry
--     `eta 2026-11-06` -- one container, three rows, nothing joining them.
--
--  2. SILO holds two arrival dates and reconciles neither.
--     `po_headers.expected_arrival_date` is a PLAN typed in PO Builder;
--     `incoming_shipments.eta` / `received_date` is what happened. They drift
--     badly (Healong-3: planned 2026-07-15, actually received 2026-10-07 --
--     79 days), and PO status contradicts shipment status in both directions
--     (a PO marked Received whose shipment is still In Transit; shipments
--     marked Not Shipped that carry a ship date).
--     Every downstream surface reads ONLY the plan: the Late Arrivals report
--     and Logistics dashboard compute `days_late` as
--     `current_date - expected_arrival_date` with no shipment join at all, so
--     a PO whose container was delivered still reads "late".
--
-- This migration adds the booking, then publishes plan, actual and the gap
-- between them as columns on the views everything already reads.
--
-- ── What it deliberately does NOT do ─────────────────────────────────────
--  * It never writes `po_headers.expected_arrival_date`. The plan stays the
--    plan; the variance IS the signal, and overwriting it would destroy the
--    only record of what was promised.
--  * It never changes `po_headers.status`. A person still types that. The
--    views expose a derived `arrival_state` beside it so the contradictions
--    above surface instead of hiding.
--  * No inventory, Shopify or QuickBooks posting. Visibility only.
--
-- Additive and idempotent. Existing view columns keep their name, type and
-- position (CREATE OR REPLACE VIEW cannot reorder or drop them); every new
-- column is appended.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. shipment_bookings -- the container / forwarder booking
-- ---------------------------------------------------------------------------
-- One booking, many shipments, each shipment still owned by exactly one PO.
-- The booking carries the dates and the container, so changing an ETA updates
-- every PO inside it once. A booking is OPTIONAL: a parcel from one factory
-- stays a bare shipment with no booking, which is what a smaller SILO
-- customer will do, and every column below is nullable except the ref.

create table if not exists public.shipment_bookings (
  id uuid primary key default gen_random_uuid(),

  booking_ref text not null,
  forwarder text,
  carrier text,
  mode text
    constraint shipment_bookings_mode_chk
    check (mode is null or mode in ('Ocean','Air','Truck','Rail','Parcel','Other')),
  container_ref text,
  origin_port text,
  destination_port text,

  -- The booking's own dates. `etd`/`eta` are the forwarder's plan for the
  -- container; `ata` is the actual arrival. A shipment inside the booking
  -- inherits whichever of these are set (see v_po_arrival).
  etd date,
  eta date,
  ata date,

  status text not null default 'Booked'
    constraint shipment_bookings_status_chk
    check (status in ('Draft','Booked','In Transit','Delayed','Arrived','Closed','Cancelled')),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  company_entity_id uuid references public.entities(id)
);

comment on table public.shipment_bookings is
  'A forwarder booking / container that one or more incoming_shipments ride on. Groups shipments across POs so a consolidated container is one object with one set of dates. Optional: a shipment with booking_id null behaves exactly as before.';
comment on column public.shipment_bookings.ata is
  'Actual arrival. Once set it wins over eta everywhere, because it is what happened.';

-- Unique per company, case-insensitively: two tenants may legitimately use the
-- same forwarder reference, and "BK-1042" and "bk-1042" are one booking.
create unique index if not exists shipment_bookings_ref_company_uidx
  on public.shipment_bookings (company_entity_id, lower(btrim(booking_ref)))
  where booking_ref is not null and btrim(booking_ref) <> '';

create index if not exists shipment_bookings_company_entity_id_idx
  on public.shipment_bookings (company_entity_id);
create index if not exists shipment_bookings_eta_idx
  on public.shipment_bookings (coalesce(ata, eta));
create index if not exists shipment_bookings_status_idx
  on public.shipment_bookings (status);

alter table public.shipment_bookings enable row level security;

drop trigger if exists stamp_company_entity_id on public.shipment_bookings;
create trigger stamp_company_entity_id
  before insert on public.shipment_bookings
  for each row execute function public.stamp_company_entity_id();

drop trigger if exists trg_shipment_bookings_updated_at on public.shipment_bookings;
create trigger trg_shipment_bookings_updated_at
  before update on public.shipment_bookings
  for each row execute function public.set_updated_at();

-- Same audit stamping as incoming_shipments (20260923160000): the database
-- fills created_by / updated_by from the session, so the page cannot get it
-- wrong and a browser cannot attribute a row to someone else.
drop trigger if exists trg_shipment_bookings_audit on public.shipment_bookings;
create trigger trg_shipment_bookings_audit
  before insert or update on public.shipment_bookings
  for each row execute function public.stamp_shipment_audit();

-- Authority matches incoming_shipments exactly, deliberately: logging that a
-- container was booked or has landed is logistics work any teammate does, and
-- splitting it from the shipment it describes would mean a warehouse user
-- could log the delivery but not the container it arrived in. Deletes stay
-- admin-only, as shipment deletes are.
drop policy if exists shipment_bookings_active_select on public.shipment_bookings;
create policy shipment_bookings_active_select on public.shipment_bookings
  for select using (company_entity_id = active_company_id());

drop policy if exists shipment_bookings_active_insert on public.shipment_bookings;
create policy shipment_bookings_active_insert on public.shipment_bookings
  for insert with check (company_entity_id = active_company_id());

drop policy if exists shipment_bookings_active_update on public.shipment_bookings;
create policy shipment_bookings_active_update on public.shipment_bookings
  for update using (company_entity_id = active_company_id())
             with check (company_entity_id = active_company_id());

drop policy if exists shipment_bookings_active_delete on public.shipment_bookings;
create policy shipment_bookings_active_delete on public.shipment_bookings
  for delete using (company_entity_id = active_company_id() and is_admin_user());

-- ---------------------------------------------------------------------------
-- 2. incoming_shipments.booking_id
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL: deleting a booking must never delete the shipments
-- inside it, which are the record of what arrived. They fall back to their own
-- dates, exactly as a shipment with no booking behaves.

alter table public.incoming_shipments
  add column if not exists booking_id uuid references public.shipment_bookings(id) on delete set null;

comment on column public.incoming_shipments.booking_id is
  'The forwarder booking / container this shipment rides on, or NULL for a standalone shipment. When set, the booking''s etd/eta/ata win over the shipment''s own dates (see v_po_arrival).';

create index if not exists incoming_shipments_booking_id_idx
  on public.incoming_shipments (booking_id);

-- A composite FK cannot be used here (ON DELETE SET NULL would have to null
-- company_entity_id too), so the tenant boundary on the link is a trigger.
-- RLS already stops a user from SEEING another company's booking; this stops a
-- service-role or SQL-editor write from pairing rows across companies, which
-- would leak one tenant's container into another's PO report.
create or replace function public.shipment_booking_same_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_booking_company uuid;
begin
  if new.booking_id is null then
    return new;
  end if;
  select company_entity_id into v_booking_company
    from public.shipment_bookings where id = new.booking_id;
  if v_booking_company is distinct from new.company_entity_id then
    raise exception 'booking % belongs to company %, not %',
      new.booking_id, v_booking_company, new.company_entity_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.shipment_booking_same_company() from public, anon, authenticated;

-- AFTER the company stamp (triggers fire alphabetically and `stamp_` sorts
-- before `zz_`), so an insert that lets the stamp fill company_entity_id is
-- compared against the value that will actually be stored.
drop trigger if exists zz_incoming_shipments_booking_company on public.incoming_shipments;
create trigger zz_incoming_shipments_booking_company
  before insert or update of booking_id, company_entity_id on public.incoming_shipments
  for each row execute function public.shipment_booking_same_company();

-- ---------------------------------------------------------------------------
-- 3. v_po_arrival -- plan, actual and the gap, one row per PO
-- ---------------------------------------------------------------------------
-- This is the single object every date reader points at. It is the whole
-- point of the migration: `planned_arrival` is what was promised,
-- `current_eta` is what the shipments say now, `effective_arrival_date` is the
-- one to show and sort by, and `arrival_variance_days` is the slip.
--
-- `arrival_state` is derived from DATES FIRST and only then from status words,
-- because the status words are the part that is wrong in production (four
-- shipments marked 'Not Shipped' carry a ship date). A PO with no shipments
-- logged is 'unknown' -- NOT 'not_shipped', which would claim knowledge the
-- database does not have.

create or replace view public.v_po_arrival
with (security_invoker = true) as
with ship as (
  select
    s.po_header_id,
    s.company_entity_id,
    -- The booking's dates win when present; ata (actual) wins over eta.
    coalesce(b.etd, s.ship_date)                     as eff_ship_date,
    coalesce(b.ata, b.eta, s.eta)                    as eff_eta,
    s.received_date,
    s.shipment_status,
    s.booking_id,
    coalesce(b.ata, s.received_date)                 as eff_arrived
  from public.incoming_shipments s
  left join public.shipment_bookings b on b.id = s.booking_id
),
agg as (
  select
    po_header_id,
    count(*)                                          as shipment_count,
    count(distinct booking_id)                        as booking_count,
    min(eff_ship_date)                                as first_ship_date,
    -- The LATEST eta across a PO's shipments: a PO is not fully here until its
    -- last box is. min() would read "arrived" while half the order is at sea.
    max(eff_eta)                                      as current_eta,
    min(eff_arrived)                                  as first_received,
    max(eff_arrived)                                  as last_received,
    count(*) filter (where eff_arrived is not null
                        or shipment_status in ('Received','Delivered'))
                                                      as received_count,
    count(*) filter (where eff_ship_date is not null and eff_ship_date <= current_date)
                                                      as departed_count,
    count(*) filter (where shipment_status in ('Shipped','In Transit','Delayed'))
                                                      as in_transit_count,
    count(*) filter (where booking_id is not null
                        or shipment_status = 'Booked') as booked_count
  from ship
  group by po_header_id
)
select
  h.id                                                as po_header_id,
  h.po_name,
  h.status                                            as po_status,
  h.factory_id,
  h.expected_arrival_date                             as planned_arrival,
  a.current_eta,
  coalesce(a.current_eta, h.expected_arrival_date)     as effective_arrival_date,
  -- Positive = later than planned. NULL when either side is unknown, never 0:
  -- "no shipment logged" is not "on time".
  (a.current_eta - h.expected_arrival_date)            as arrival_variance_days,
  a.first_ship_date,
  a.first_received,
  a.last_received,
  coalesce(a.shipment_count, 0)                        as shipment_count,
  coalesce(a.booking_count, 0)                         as booking_count,
  case
    when a.po_header_id is null                               then 'unknown'
    when a.received_count >= a.shipment_count                 then 'received'
    when a.received_count > 0                                 then 'partially_received'
    when a.departed_count > 0 or a.in_transit_count > 0       then 'in_transit'
    when a.booked_count > 0                                   then 'booked'
    else 'not_shipped'
  end                                                  as arrival_state,
  -- True when the typed PO status and the shipments disagree. This is what
  -- PO Report badges; it is a prompt to look, never an automatic correction.
  case
    when a.po_header_id is null then false
    when h.status in ('Received','Closed','Cancelled')
         and a.received_count < a.shipment_count then true
    when h.status not in ('Received','Partially Received','Closed','Cancelled')
         and a.received_count >= a.shipment_count then true
    else false
  end                                                  as status_conflicts_with_shipments,
  h.company_entity_id
from public.po_headers h
left join agg a on a.po_header_id = h.id;

comment on view public.v_po_arrival is
  'One row per PO: planned_arrival (the PO''s own typed date), current_eta (the latest ETA across its shipments and their bookings, actual arrival winning over estimate), effective_arrival_date (current_eta falling back to the plan -- the one to display and sort by), arrival_variance_days (the slip) and arrival_state derived from dates first. Never writes to po_headers.';

-- ---------------------------------------------------------------------------
-- 4. v_shipment_booking_summary -- one row per booking, with its POs
-- ---------------------------------------------------------------------------

create or replace view public.v_shipment_booking_summary
with (security_invoker = true) as
select
  b.id                                                as booking_id,
  b.booking_ref,
  b.forwarder,
  b.carrier,
  b.mode,
  b.container_ref,
  b.origin_port,
  b.destination_port,
  b.etd,
  b.eta,
  b.ata,
  coalesce(b.ata, b.eta)                              as effective_eta,
  b.status,
  b.notes,
  -- count(distinct h.id), not s.po_header_id: po_headers' select policy is
  -- narrower than company (admin OR creator), so a PO the caller cannot see
  -- contributes no name -- and must contribute no count either, or the tab
  -- reads "2 POs" beside one name.
  count(distinct h.id)                                as po_count,
  count(s.id)                                         as shipment_count,
  -- Alphabetical so the label is stable between reloads.
  string_agg(distinct h.po_name, ', ' order by h.po_name) as po_names,
  sum(coalesce(sl.assigned_units, 0))                 as assigned_units,
  b.created_at,
  b.updated_at,
  b.created_by,
  b.updated_by,
  b.company_entity_id
from public.shipment_bookings b
left join public.incoming_shipments s on s.booking_id = b.id
left join public.po_headers h on h.id = s.po_header_id
left join (
  -- Assigned units per shipment: a line with NULL qty carries the PO line's
  -- full quantity, which is what the NULL means (20260818210000).
  select l.shipment_id, sum(coalesce(l.qty, pl.qty, 0)) as assigned_units
    from public.incoming_shipment_lines l
    left join public.po_lines pl on pl.id = l.po_line_id
   group by l.shipment_id
) sl on sl.shipment_id = s.id
group by b.id;

comment on view public.v_shipment_booking_summary is
  'One row per forwarder booking with the POs riding on it, for PO Report''s Bookings tab. effective_eta is the actual arrival when known, otherwise the estimate.';

-- ---------------------------------------------------------------------------
-- 5. Append booking and effective dates to v_po_shipment_lines
-- ---------------------------------------------------------------------------
-- The existing 21 columns keep their names, types and order; eight are added.

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
  pl.qty as line_qty,
  -- ── appended 2026-10-28 ──
  s.booking_id,
  b.booking_ref,
  b.forwarder,
  b.container_ref as booking_container_ref,
  b.status as booking_status,
  coalesce(b.etd, s.ship_date) as effective_ship_date,
  coalesce(b.ata, b.eta, s.eta) as effective_eta,
  coalesce(b.ata, s.received_date) as effective_arrived_date
from public.incoming_shipments s
left join public.incoming_shipment_lines sl on sl.shipment_id = s.id
left join public.po_lines pl on pl.id = sl.po_line_id
left join public.shipment_bookings b on b.id = s.booking_id;

-- ---------------------------------------------------------------------------
-- 6. Append the arrival columns to the three shared PO views
-- ---------------------------------------------------------------------------
-- Everything in v2/ and v3/ reads one of these. Appending here is what makes
-- the new date available to every surface without each one growing its own
-- shipment join.

-- 6a. v_po_incoming_summary -- 18 existing columns, 6 appended.
create or replace view public.v_po_incoming_summary
with (security_invoker = true) as
select
  s.id,
  s.po_name,
  s.factory_id,
  s.factory_name,
  s.status,
  s.order_date,
  s.req_ship_date,
  s.expected_arrival_date,
  s.date_bucket,
  s.wholesale_triggered,
  s.is_new_product_po,
  s.po_created_at,
  s.line_count,
  s.style_count,
  s.total_units,
  s.total_retail_value,
  s.total_estimated_cost,
  s.retail_cost_spread,
  -- ── appended 2026-10-28 ──
  a.current_eta,
  a.effective_arrival_date,
  a.arrival_variance_days,
  a.arrival_state,
  a.shipment_count,
  a.status_conflicts_with_shipments
from (
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
    is_new_product_po, po_created_at
) s
left join public.v_po_arrival a on a.po_header_id = s.id;

-- 6b. v_po_header_summary -- 20 existing columns, 5 appended.
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
  coalesce(sum(pl.unit_cost * pl.qty::numeric), 0::numeric)::numeric(14,2) as total_estimated_cost,
  -- ── appended 2026-10-28 ──
  a.current_eta,
  a.effective_arrival_date,
  a.arrival_variance_days,
  a.arrival_state,
  a.shipment_count
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
left join public.po_lines pl on pl.po_header_id = ph.id
left join public.v_po_arrival a on a.po_header_id = ph.id
group by
  ph.id, ph.po_name, ph.factory_id, f.factory_name,
  ph.order_date, ph.req_ship_date, ph.expected_arrival_date, ph.date_bucket,
  ph.status, ph.wholesale_triggered, ph.is_new_product_po,
  ph.notes, ph.internal_notes, ph.pdf_url, ph.created_by, ph.created_at, ph.updated_at,
  a.current_eta, a.effective_arrival_date, a.arrival_variance_days,
  a.arrival_state, a.shipment_count;

-- 6c. v_po_open_planning_lines -- 25 existing columns, 4 appended.
-- `planning_date` and `month_key` keep their names and types but now prefer
-- the shipments' ETA over the PO's plan. This is the change Planning Scenarios
-- and the launch calendar feel: a PO whose container slipped eleven weeks now
-- plans into the month it will actually land in.
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
  coalesce(a.current_eta, h.expected_arrival_date, h.req_ship_date, h.order_date) as planning_date,
  to_char(coalesce(a.current_eta, h.expected_arrival_date, h.req_ship_date, h.order_date)::timestamptz, 'YYYY-MM'::text) as month_key,
  h.date_bucket,
  l.id as po_line_id,
  l.product_master_id,
  l.product_type_snapshot as product_type,
  l.title_snapshot as product_title,
  lower(regexp_replace(regexp_replace(regexp_replace(coalesce(l.title_snapshot, ''::text), '[''"]'::text, ''::text, 'g'::text), '&'::text, 'and'::text, 'g'::text), '[^a-zA-Z0-9]+'::text, '-'::text, 'g'::text)) as product_key_raw,
  trim(both '-'::text from lower(regexp_replace(regexp_replace(regexp_replace(coalesce(l.title_snapshot, ''::text), '[''"]'::text, ''::text, 'g'::text), '&'::text, 'and'::text, 'g'::text), '[^a-zA-Z0-9]+'::text, '-'::text, 'g'::text))) as product_key,
  l.variant_title_snapshot as variant_title,
  l.sku_snapshot as sku,
  l.upc_snapshot as upc,
  coalesce(l.qty, 0) as incoming_units,
  coalesce(l.retail_price, 0::numeric) as retail_price,
  coalesce(l.unit_cost, 0::numeric) as unit_cost,
  coalesce(l.retail_value, coalesce(l.qty, 0)::numeric * coalesce(l.retail_price, 0::numeric)) as incoming_retail_value,
  coalesce(l.qty, 0)::numeric * coalesce(l.unit_cost, 0::numeric) as incoming_cost,
  -- ── appended 2026-10-28 ──
  a.current_eta,
  a.effective_arrival_date,
  a.arrival_variance_days,
  a.arrival_state
from public.po_headers h
  left join public.factories f on f.id = h.factory_id
  left join public.po_lines l on l.po_header_id = h.id
  left join public.v_po_arrival a on a.po_header_id = h.id
where h.status = any (array['Approved'::text, 'Sent to Factory'::text, 'Confirmed'::text, 'In Production'::text, 'Shipped'::text, 'In Transit'::text, 'Partially Received'::text])
  and coalesce(l.qty, 0) <> 0;

-- 6d. v_launch_po_product_lookup -- 24 existing columns, 4 appended.
-- Products and the launch calendar pick a PO through this view and copy its
-- arrival into a launch's bulk ETA, so it has to offer the real one. It
-- already joins v_po_header_summary, which carries the arrival columns now.
create or replace view public.v_launch_po_product_lookup
with (security_invoker = true) as
select
  h.id as po_header_id,
  h.po_name,
  h.status as po_status,
  h.order_date,
  h.req_ship_date,
  h.expected_arrival_date,
  h.date_bucket,
  h.is_new_product_po,
  h.wholesale_triggered,
  h.pdf_url,
  h.notes as po_notes,
  h.internal_notes,
  f.factory_name,
  l.title_snapshot as product_title,
  l.product_type_snapshot as product_type,
  count(*) as variant_count,
  sum(coalesce(l.qty, 0))::integer as total_units,
  sum(coalesce(l.retail_value, coalesce(l.qty, 0)::numeric * coalesce(l.retail_price, 0::numeric))) as total_retail_value,
  sum(coalesce(l.qty, 0)::numeric * coalesce(l.unit_cost, 0::numeric)) as total_estimated_cost,
  min(l.retail_price) as min_retail_price,
  max(l.retail_price) as max_retail_price,
  string_agg(distinct nullif(l.variant_title_snapshot, ''::text), ', '::text order by (nullif(l.variant_title_snapshot, ''::text))) as variants,
  string_agg(distinct nullif(l.sku_snapshot, ''::text), ', '::text order by (nullif(l.sku_snapshot, ''::text))) as sample_skus,
  h.factory_id,
  -- ââ appended 2026-10-28 ââ
  f.current_eta,
  f.effective_arrival_date,
  f.arrival_variance_days,
  f.arrival_state
from public.po_lines l
  join public.po_headers h on h.id = l.po_header_id
  left join public.v_po_header_summary f on f.id = h.id
where nullif(l.title_snapshot, ''::text) is not null
group by h.id, h.po_name, h.status, h.order_date, h.req_ship_date, h.expected_arrival_date,
         h.date_bucket, h.is_new_product_po, h.wholesale_triggered, h.pdf_url, h.notes,
         h.internal_notes, f.factory_name, l.title_snapshot, l.product_type_snapshot, h.factory_id,
         f.current_eta, f.effective_arrival_date, f.arrival_variance_days, f.arrival_state;

-- ---------------------------------------------------------------------------
-- 7. The logistics reports stop measuring lateness against a plan nobody
--    updated
-- ---------------------------------------------------------------------------
-- These are `system` reports (company_entity_id null), read by Ask SILO, the
-- saved-report list and the Logistics dashboard. Each still reads a
-- security_invoker view, so one definition stays scoped per tenant.
--
-- A PO whose shipments are all received but whose typed status still says
-- In Transit is NOT filtered out of the overdue report. It is a decision that
-- needs making (fix the status), and `arrival_state` in the row says which
-- kind of problem it is -- hiding it is how the status got stale.

update public.silo_chat_saved_reports set
  description = 'Open POs whose arrival has passed, measured against the shipments'' own ETA where one is logged and the PO''s planned date otherwise.',
  queries_run = array[$q$
select po_name,
       factory_name,
       status,
       arrival_state,
       expected_arrival_date as planned_arrival,
       current_eta,
       effective_arrival_date,
       (current_date - effective_arrival_date) as days_late,
       arrival_variance_days,
       total_units,
       style_count
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and effective_arrival_date is not null
   and effective_arrival_date < current_date
 order by effective_arrival_date asc
$q$],
  columns_metadata = '{"po_name":{"semantic":"category","label":"PO"},"factory_name":{"semantic":"category","label":"Factory"},
   "status":{"semantic":"category"},"arrival_state":{"semantic":"category","label":"Shipments Say"},
   "planned_arrival":{"semantic":"date","label":"Planned"},"current_eta":{"semantic":"date","label":"Current ETA"},
   "effective_arrival_date":{"semantic":"date","label":"Arrival Used"},
   "days_late":{"semantic":"count","label":"Days Late"},
   "arrival_variance_days":{"semantic":"count","label":"Slip vs Plan"},
   "total_units":{"semantic":"count","label":"Units"},
   "style_count":{"semantic":"count","label":"Styles"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000002';

update public.silo_chat_saved_reports set
  description = 'Units on open purchase orders, grouped by the month they are now expected to arrive.',
  queries_run = array[$q$
select date_trunc('month', effective_arrival_date)::date as arrival_month,
       sum(total_units)          as units_arriving,
       count(*)                  as purchase_orders
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and effective_arrival_date is not null
 group by 1
 order by 1
$q$]
where id = 'c1000000-0000-4000-a000-000000000003';

update public.silo_chat_saved_reports set
  queries_run = array[$q$
select factory_name,
       sum(total_units)  as units_open,
       count(*)          as purchase_orders,
       min(effective_arrival_date) as next_arrival
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and factory_name is not null
 group by 1
 order by 2 desc
$q$]
where id = 'c1000000-0000-4000-a000-000000000004';

-- ---------------------------------------------------------------------------
-- 8. Tie-outs follow the reports
-- ---------------------------------------------------------------------------
-- Blake, 2026-10-28: the dates were not being used properly, so re-baselining
-- these two is the point rather than a cost. Each still recomputes the number
-- independently of the view it checks -- the second leg builds the effective
-- date from the base tables by hand, so a mistake in v_po_arrival fails here.

update public.silo_report_tieouts set
  check_sql = $c$select (select count(*) from v_po_incoming_summary
          where status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and effective_arrival_date is not null
            and effective_arrival_date < silo_business_today()),
        (select count(*) from po_headers h
          left join (select s.po_header_id,
                            max(coalesce(b.ata, b.eta, s.eta)) as current_eta
                       from incoming_shipments s
                       left join shipment_bookings b on b.id = s.booking_id
                      group by s.po_header_id) x on x.po_header_id = h.id
          where h.company_entity_id = active_company_id()
            and h.status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and coalesce(x.current_eta, h.expected_arrival_date) is not null
            and coalesce(x.current_eta, h.expected_arrival_date) < silo_business_today())$c$,
  note = 'Summary view vs the header table, both measured on the effective arrival date (the shipments'' latest ETA, actual arrival winning, falling back to the PO plan). The right leg rebuilds that date from the base tables by hand, so a mistake in v_po_arrival fails here. Rebuilt 2026-10-28.'
where report_id = 'c1000000-0000-4000-a000-000000000002'
  and name = 'overdue PO count ties to po_headers';

update public.silo_report_tieouts set
  check_sql = $c$select (select sum(total_units) from v_po_incoming_summary
          where status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and effective_arrival_date is not null),
        (select sum(l.qty) from v_po_incoming_lines l
          join v_po_arrival a on a.po_header_id = l.po_header_id
          where l.status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and a.effective_arrival_date is not null)$c$,
  note = 'Header-level rollup against the sum of its own lines -- genuinely different grains -- both restricted to POs with an effective arrival date. Rebuilt 2026-10-28.'
where report_id = 'c1000000-0000-4000-a000-000000000003'
  and name = 'arriving units tie to the PO LINE level';

-- A new tie-out: the arrival view must agree with the shipments it reads.
-- This is what catches a booking joined to the wrong shipment, or a shipment
-- counted twice, which is the failure mode of the join added above.
insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
values
('c1000000-0000-4000-a000-000000000002','PO arrival ETAs tie to the shipments they come from','reconciliation',
 $c$select (select count(*) from v_po_arrival where current_eta is not null),
        (select count(distinct s.po_header_id) from incoming_shipments s
          left join shipment_bookings b on b.id = s.booking_id
          where s.company_entity_id = active_company_id()
            and coalesce(b.ata, b.eta, s.eta) is not null)$c$,
 0,'Every PO the arrival view gives an ETA for must be a PO with at least one shipment carrying a date, and no more. A mismatch means the booking join fans out or drops rows.')
on conflict (report_id, name) do update set
  kind = excluded.kind, check_sql = excluded.check_sql,
  tolerance = excluded.tolerance, note = excluded.note;

-- ---------------------------------------------------------------------------
-- 9. Dashboard tiles show the new date beside the old one
-- ---------------------------------------------------------------------------
-- Driven off the stored column list rather than a tile id, so every tenant's
-- copy of a PO table tile is updated, not only Baseballism's. Idempotent: a
-- list that already names current_eta is left alone.

-- The two new columns are inserted immediately after expected_arrival_date,
-- wherever that sits in a given tile's list, so plan and current ETA read side
-- by side. Idempotent: a list that already names current_eta is skipped.
update public.dashboard_widgets w set
  visual_config = jsonb_set(w.visual_config, '{columns}', nu.cols)
from (
  select w2.id,
         (select jsonb_agg(col order by ord)
            from (
              select col, ord::numeric as ord
                from jsonb_array_elements(w2.visual_config->'columns') with ordinality as t(col, ord)
              union all
              select to_jsonb('current_eta'::text), p.pos + 0.1
              union all
              select to_jsonb('arrival_state'::text), p.pos + 0.2
            ) z) as cols
    from public.dashboard_widgets w2,
         lateral (select ord::numeric as pos
                    from jsonb_array_elements(w2.visual_config->'columns') with ordinality as t(col, ord)
                   where col = '"expected_arrival_date"'::jsonb
                   limit 1) p
   where w2.visual_config->'columns' @> '["expected_arrival_date"]'::jsonb
     and not (w2.visual_config->'columns' @> '["current_eta"]'::jsonb)
) nu
where w.id = nu.id;

-- ---------------------------------------------------------------------------
-- 10. Let Ask SILO and the report builder see the new objects
-- ---------------------------------------------------------------------------

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set reportable = true
 where relname in ('shipment_bookings','v_po_arrival','v_shipment_booking_summary');
