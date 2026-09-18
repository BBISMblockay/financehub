-- =============================================================================
-- Ordinary demand planning: when to reorder, and how much.
--
-- WHY THIS EXISTS. SILO could forecast but could not PLAN. The three columns a
-- reorder point needs -- products_master.lead_time_days, reorder_point_units,
-- reorder_qty_units -- exist and are populated on 0 of 20,548 SKUs, and
-- `reorderable` is true on all 20,548, which makes it say nothing (the same
-- shape as `is_active`). With no lead time there is no reorder point, and with
-- no reorder point the only computable question is "how accurate is the
-- forecast", which is why weeks went into method bake-offs.
--
-- The lead time was recoverable the whole time. 177 of 190 purchase orders
-- carry both an order date and an expected arrival: median 74 days, quartiles
-- 69-92. That is measured history, not a number somebody has to type in.
--
-- THE MODEL IS DELIBERATELY PLAIN:
--
--     reorder point = daily demand x (lead time + review period + safety)
--     suggested buy = reorder point - on hand - on order
--
-- Demand here is trailing 90-day velocity. Not a chosen forecast method -- the
-- safety period is what absorbs forecast error, and across a lead time of ~74
-- days the difference between a 24% and a 32% WAPE method is mostly swallowed
-- by it. When the challenger work in forecast_method_selections has a forward
-- record worth trusting, the velocity term is the ONE expression to swap.
-- Nothing else here changes.
--
-- THE THREE CONSTANTS ARE POLICY, NOT FITTED VALUES. 90-day velocity window,
-- 30-day review period (how often a buy is placed), 28-day safety stock. They
-- were not searched against this tenant's history, because a parameter tuned on
-- the same data it is scored against is how the earlier round produced 20.2%
-- that became 49.6%. Change them because the business changes, not because a
-- backtest improved.
--
-- WHAT IT REFUSES TO GUESS:
--   * A title with no sales in the window gets NULL velocity and NULL cover,
--     never 0 -- and no suggested quantity. "Nothing sold" and "we have no
--     record" are different facts, and only one of them means stop buying.
--   * A title absent from inventory gets NULL on_hand, not 0, and says so via
--     `has_inventory_row`. Treating absent as zero manufactures a stockout.
--   * Lead time falls back to the company median when a title has fewer than 2
--     of its own purchase orders, and `lead_time_source` always says which.
--   * A purchase order past its expected arrival and still not received is
--     counted in on_order (it is still owed) but surfaced in
--     `on_order_past_due`, because a late PO and an arriving one support very
--     different decisions.
--
-- TENANT SCOPING. Both views are security_invoker and every branch carries an
-- explicit company filter as well, so they are correct under a service-role
-- connection too. on_order is built from po_lines/po_headers directly rather
-- than from v_po_incoming_product_rollup, which exposes no company column and
-- would have to be joined on product_title alone.
--
-- VISIBILITY CAVEAT, worth knowing before reading a number: po_headers_active_select
-- is narrower than company (`is_admin_user() OR created_by = auth.uid()`), so a
-- non-admin sees only the purchase orders they raised. Their on_order, and
-- therefore their suggested buy, is computed from less than the whole book.
-- This is inherited RLS, not something these views can or should widen.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lead time, measured from purchase order history
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.product_lead_time_v
with (security_invoker = true) as
with po_lead as (
  -- DISTINCT on the purchase order, not the line: a PO with fifty lines of one
  -- title is one observation of that title's lead time, not fifty. Without this
  -- the median is weighted by how many sizes a style happens to carry.
  select distinct
         h.company_entity_id,
         l.title_snapshot as product_title,
         h.id as po_header_id,
         (h.expected_arrival_date - h.order_date) as lead_days
  from public.po_lines l
  join public.po_headers h on h.id = l.po_header_id
  where h.order_date is not null
    and h.expected_arrival_date is not null
    and l.title_snapshot is not null
    -- A negative or absurd span is a data-entry artefact, not a lead time.
    -- Bounds are wide on purpose: they exclude nonsense, not slow factories.
    and (h.expected_arrival_date - h.order_date) between 7 and 365
),
company_median as (
  select company_entity_id,
         percentile_cont(0.5) within group (order by lead_days) as lead_days,
         count(*)::int as po_lines_observed
  from po_lead
  group by company_entity_id
),
per_title as (
  select company_entity_id, product_title,
         count(*)::int as pos_observed,
         percentile_cont(0.5) within group (order by lead_days) as median_lead_days,
         percentile_cont(0.75) within group (order by lead_days) as p75_lead_days
  from po_lead
  group by company_entity_id, product_title
)
select
  t.company_entity_id,
  t.product_title,
  t.pos_observed,
  round(t.median_lead_days)::int as median_lead_days,
  round(t.p75_lead_days)::int   as p75_lead_days,
  round(c.lead_days)::int       as company_median_lead_days,
  c.po_lines_observed           as company_pos_observed,
  -- One PO is an anecdote. Two is the minimum that can disagree with itself,
  -- and below that the company median is the better estimate.
  case when t.pos_observed >= 2 then round(t.median_lead_days)::int
       else round(c.lead_days)::int end as lead_days_used,
  case when t.pos_observed >= 2 then 'title history'
       else 'company median' end as lead_time_source
from per_title t
join company_median c on c.company_entity_id = t.company_entity_id;

comment on view public.product_lead_time_v is
  'Lead time per product title, measured from purchase orders carrying both an order date and an expected arrival. One observation per PO, not per line. Falls back to the company median below 2 POs and always reports which via lead_time_source.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The reorder plan
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP then CREATE, not CREATE OR REPLACE: a replace cannot insert a column
-- into the middle of a view's column list ("cannot change name of view column"),
-- and this one gained `not_planned_because`. Nothing depends on the view, so
-- dropping it is safe -- but anything that later builds on it will need the
-- same treatment, or a cascade.
drop view if exists public.reorder_plan_v;

create view public.reorder_plan_v
with (security_invoker = true) as
with params as (
  select 90::numeric  as velocity_days,
         30::numeric  as review_days,
         28::numeric  as safety_days
),
co as (select public.active_company_id() as cid),
today as (select public.silo_business_today() as d),
-- The company-wide median, available to EVERY title rather than only to titles
-- that have appeared on a SILO purchase order. Without this, a title stocked
-- before the PO tool existed -- or bought outside it -- has no lead time and
-- therefore no plan at all: measured on first run, 1,772 titles holding 273,962
-- units came back 'no lead time', which is most of the warehouse reporting as
-- unplannable because of how the PO history happens to be recorded.
-- product_lead_time_v already carries this figure on every row; one row of it
-- is enough.
co_lead as (
  select max(lt.company_median_lead_days) as lead_days
  from public.product_lead_time_v lt, co
  where lt.company_entity_id = co.cid
),
-- On hand: current snapshot, summed over every location.
onhand as (
  select i.company_entity_id, i.product_title,
         min(i.product_type) as product_type,
         sum(coalesce(i.total_available_quantity, 0))::numeric as on_hand
  from public.inventory_on_hand_current_v i, co
  where i.product_title is not null
    and i.company_entity_id = co.cid
  group by 1, 2
),
-- Velocity: trailing window, ending YESTERDAY. Today is partial and would
-- read as a slow day for the last few hours of every afternoon.
vel as (
  select s.company_entity_id, s.product_title,
         min(s.product_type) as product_type,
         sum(s.units_sold)::numeric as units_window,
         count(distinct s.day_date)::int as days_with_sales,
         max(s.day_date) as last_sold_date
  from public.sales_by_product_title_daily_v s, params p, today t, co
  where s.company_entity_id = co.cid
    and s.day_date >= (t.d - p.velocity_days::int)
    and s.day_date <  t.d
  group by 1, 2
),
-- Which product types are real, buyable merchandise is ALREADY a decision a
-- person has made, in product_type_profile.is_forecastable. Reuse it rather
-- than hardcoding a list here: Package Protection (the Redo checkout fee, and
-- the highest-unit "product" in the catalogue) and Bundles & Multi-Packs (not
-- manufactured -- assembled from SKUs that are themselves planned here, so
-- buying it would double-count) are both already marked false by hand. A
-- hardcoded list would drift away from theirs the first time they change it.
-- The row is KEPT and labelled rather than dropped, so a buyer can see that a
-- type was deliberately excluded instead of wondering where it went.
not_planned as (
  select p.product_type, p.classification_note
  from public.product_type_profile p, co
  where p.company_entity_id = co.cid and p.is_forecastable is false
),
-- On order: open purchase orders only, same status rule the PO views use.
onorder as (
  select h.company_entity_id,
         l.title_snapshot as product_title,
         sum(coalesce(l.qty, 0))::numeric as on_order,
         min(h.expected_arrival_date) filter (where h.expected_arrival_date >= (select d from today)) as next_arrival,
         sum(coalesce(l.qty, 0)) filter (
           where h.expected_arrival_date is not null
             and h.expected_arrival_date < (select d from today))::numeric as on_order_past_due
  from public.po_lines l
  join public.po_headers h on h.id = l.po_header_id, co
  where h.company_entity_id = co.cid
    and l.title_snapshot is not null
    and coalesce(h.status, '') not in ('Draft', 'Cancelled', 'Closed', 'Received')
  group by 1, 2
),
-- The universe is every title we stock, sell, or have on order. A title that
-- sells but was never stocked still needs buying; a title sitting in a
-- warehouse with no sales still needs looking at.
universe as (
  select company_entity_id, product_title from onhand
  union
  select company_entity_id, product_title from vel
  union
  select company_entity_id, product_title from onorder
),
base as (
  select u.company_entity_id, u.product_title,
         coalesce(oh.product_type, v.product_type) as product_type,
         oh.on_hand,
         (oh.product_title is not null) as has_inventory_row,
         v.units_window, v.days_with_sales, v.last_sold_date,
         coalesce(oo.on_order, 0) as on_order,
         oo.next_arrival,
         coalesce(oo.on_order_past_due, 0) as on_order_past_due,
         coalesce(lt.lead_days_used, cl.lead_days) as lead_days_used,
         coalesce(lt.lead_time_source,
                  case when cl.lead_days is not null
                       then 'company median (no PO history for this title)' end) as lead_time_source,
         coalesce(lt.pos_observed, 0) as pos_observed
  from universe u
  cross join co_lead cl
  left join onhand oh on oh.company_entity_id = u.company_entity_id and oh.product_title = u.product_title
  left join vel     v  on v.company_entity_id  = u.company_entity_id and v.product_title  = u.product_title
  left join onorder oo on oo.company_entity_id = u.company_entity_id and oo.product_title = u.product_title
  left join public.product_lead_time_v lt
         on lt.company_entity_id = u.company_entity_id and lt.product_title = u.product_title
),
calc as (
  select b.*,
         p.velocity_days, p.review_days, p.safety_days,
         t.d as as_of,
         -- NULL, not 0, when nothing sold: see the header. A zero here would
         -- make every dormant title report infinite cover and never reorder,
         -- which is right, and would also make a title with no sales RECORD
         -- report the same thing, which is not.
         case when b.units_window > 0 then b.units_window / p.velocity_days end as daily_velocity
  from base b, params p, today t
),
plan as (
  select c.*,
         (c.daily_velocity * 7) as weekly_velocity,
         case when c.daily_velocity > 0 and c.on_hand is not null
              then c.on_hand / c.daily_velocity end as days_of_cover,
         case when c.daily_velocity > 0 and c.lead_days_used is not null
              then c.daily_velocity * (c.lead_days_used + c.review_days + c.safety_days)
         end as reorder_point
  from calc c
)
select
  p.company_entity_id,
  p.product_title,
  p.product_type,
  p.as_of,
  -- position
  p.on_hand,
  p.has_inventory_row,
  p.on_order,
  p.next_arrival,
  nullif(p.on_order_past_due, 0) as on_order_past_due,
  -- demand
  p.units_window                       as units_90d,
  p.days_with_sales,
  p.last_sold_date,
  round(p.daily_velocity, 2)           as daily_velocity,
  round(p.weekly_velocity, 1)          as weekly_velocity,
  -- supply timing
  p.lead_days_used                     as lead_days,
  p.lead_time_source,
  p.pos_observed                       as lead_time_pos_observed,
  round(p.days_of_cover)               as days_of_cover,
  round(p.reorder_point)               as reorder_point,
  -- the decision
  case when np.product_type is not null then null
       when p.reorder_point is null then null
       else greatest(0, round(p.reorder_point - coalesce(p.on_hand, 0) - p.on_order))
  end as suggested_order_qty,
  -- The date stock falls to the reorder point: order later than this and it
  -- arrives after the safety buffer is already spent.
  case when p.days_of_cover is null or p.lead_days_used is null then null
       else p.as_of + greatest(0, floor(p.days_of_cover - p.lead_days_used - p.safety_days))::int
  end as order_by_date,
  case
    when np.product_type is not null then 'not planned: type excluded by hand'
    when p.daily_velocity is null then 'no sales in window'
    when p.lead_days_used is null then 'no lead time'
    when coalesce(p.on_hand, 0) + p.on_order <= p.reorder_point then 'ORDER NOW'
    when p.as_of + greatest(0, floor(p.days_of_cover - p.lead_days_used - p.safety_days))::int
         <= p.as_of + 30 then 'order within 30 days'
    else 'ok'
  end as status,
  np.classification_note as not_planned_because,
  p.velocity_days, p.review_days, p.safety_days
from plan p
left join not_planned np on np.product_type = p.product_type;

comment on view public.reorder_plan_v is
  'Ordinary reorder planning per product title: reorder point = daily velocity x (lead time + review period + safety), suggested buy = reorder point - on hand - on order. Velocity is trailing 90 days, NOT a selected forecast method -- the safety period absorbs forecast error. NULL velocity means no sales record in the window, never zero demand; NULL on_hand means the title is absent from the inventory snapshot, never zero stock. Read status and lead_time_source before acting on a quantity.';

-- Both views are security_invoker over RLS-enabled tables and additionally
-- filter on active_company_id(), so ordinary grants are correct here.
grant select on public.product_lead_time_v to authenticated;
grant select on public.reorder_plan_v      to authenticated;
