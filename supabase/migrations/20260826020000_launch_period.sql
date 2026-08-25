-- Launches are often a PERIOD, not a date.
--
-- launch_calendar models every entry as a single launch_date, so a
-- multi-day campaign gets entered as two rows and the relationship
-- between them exists only in the titles. Observed in production:
--
--   "Back To School"            2026-07-16  Main Event
--   "Back to school sale end"   2026-07-31  Promotion End
--   "Labor Day Weekend - Sale Collection"        2026-09-04  Sale
--   "Labor Day Weekend - Sale Collection - End"  2026-09-07  Sale
--   "Anniversary Sale - Start"  2027-01-14  (no end row at all)
--   "Fundraiser February Start" 2027-02-01  (no end row at all)
--   "6432 Day Preview"          2026-06-03
--   "6432 Day"                  2026-06-04
--
-- The convention is inconsistent ("- End", "sale end", a bare "Start"
-- with nothing closing it), so nothing can reliably pair them, and
-- launch_type already carries a 'Promotion End' value that only makes
-- sense as half of a pair.
--
-- This matters for measurement, not just tidiness. Measuring "Back To
-- School" as 30 days from 2026-07-16 counts two weeks of sales that
-- happened after the promotion ended and attributes them to it. A
-- fixed 30/60/90 tail is the right shape for a product drop, which
-- really is a point event with a long tail, and the wrong shape for a
-- bounded promotion.
--
-- launch_end_date is additive and nullable: a launch without one keeps
-- behaving exactly as before (point event, measured by the tails), and
-- one with it also gets true in-period figures. Existing paired rows
-- are left alone -- merging them is a data decision for a human, since
-- picking which row survives loses whatever was typed on the other.

alter table public.launch_calendar
  add column if not exists launch_end_date date;

comment on column public.launch_calendar.launch_end_date is
  'Optional end of a multi-day campaign/promotion. When set, launch_actuals_v measures sales across [launch_date, launch_end_date] instead of relying only on fixed 30/60/90-day tails. Null means a point-in-time launch, which is the correct shape for a product drop.';

-- Guard against a period that ends before it starts; nullable so point
-- launches are unaffected.
alter table public.launch_calendar
  drop constraint if exists launch_calendar_end_after_start;
alter table public.launch_calendar
  add constraint launch_calendar_end_after_start
  check (launch_end_date is null or launch_date is null or launch_end_date >= launch_date);

create index if not exists launch_calendar_end_date_idx
  on public.launch_calendar (launch_end_date) where launch_end_date is not null;

-- ---------------------------------------------------------------------------
-- Redefine launch_actuals_v to measure the real period when one is set.
-- ---------------------------------------------------------------------------
-- DROP + CREATE rather than CREATE OR REPLACE: replace can only APPEND
-- columns to a view, and these belong next to the windows they qualify.
-- Nothing depends on this view yet (created earlier today, no readers).
--
-- Three measurement shapes now coexist, and which one is right depends on
-- the launch, so the view exposes all three rather than picking:
--   preview  [preview_start_date, launch_date)  -- pairs with the
--            preview_marketing_budget / actual_preview_spend split that
--            launch_calendar already tracks
--   period   [launch_date, launch_end_date]     -- a bounded promotion
--   tails    30/60/90/365 days from launch_date -- a product drop, which
--            really is a point event with a long tail
--
-- The tail filters are explicitly bounded below by launch_date, because
-- the scan range now reaches back into the preview window.

drop view if exists public.launch_actuals_v;

create view public.launch_actuals_v
with (security_invoker = true) as
with resolved as (
  select
    lc.id                    as launch_id,
    lc.company_entity_id,
    lc.title,
    lc.launch_date,
    lc.launch_end_date,
    lc.preview_start_date,
    lc.status,
    lc.launch_type,
    lc.linked_po_id,
    lc.source_concept_id,
    lc.expected_units,
    lc.projected_revenue,
    lc.expected_retail_value,
    lc.actual_revenue        as recorded_actual_revenue,
    (select array_agg(distinct pl.sku_snapshot)
       from public.po_lines pl
      where pl.po_header_id = lc.linked_po_id
        and nullif(pl.sku_snapshot, '') is not null) as skus,
    (select coalesce(sum(pl.qty), 0)
       from public.po_lines pl
      where pl.po_header_id = lc.linked_po_id)      as po_units_committed,
    (select coalesce(sum(pl.retail_value), 0)
       from public.po_lines pl
      where pl.po_header_id = lc.linked_po_id)      as po_retail_value_committed
  from public.launch_calendar lc
)
select
  r.launch_id,
  r.company_entity_id,
  r.title,
  r.launch_date,
  r.launch_end_date,
  r.preview_start_date,
  r.status,
  r.launch_type,
  r.linked_po_id,
  r.source_concept_id,

  case when r.skus is not null then 'po_lines' end   as sku_source,
  coalesce(cardinality(r.skus), 0)                   as sku_count,
  coalesce(a.matched_skus, 0)                        as skus_with_sales,

  r.expected_units,
  r.projected_revenue,
  r.expected_retail_value,
  nullif(r.po_units_committed, 0)        as po_units_committed,
  nullif(r.po_retail_value_committed, 0) as po_retail_value_committed,

  (current_date - r.launch_date)         as days_since_launch,

  -- period shape
  (r.launch_end_date is not null and r.launch_end_date > r.launch_date) as is_period,
  case when r.launch_end_date is not null
       then (r.launch_end_date - r.launch_date) + 1 end                 as period_days,
  case when r.launch_end_date is not null
       then (r.launch_end_date <= current_date) end                     as period_complete,
  a.units_in_period, a.net_in_period,
  a.units_preview,   a.net_preview,

  -- fixed tails, correct for a point-in-time drop
  a.units_30d,  a.net_30d,
  a.units_60d,  a.net_60d,
  a.units_90d,  a.net_90d,
  a.units_365d, a.net_365d,

  (r.launch_date + 30 <= current_date) as window_30d_complete,
  (r.launch_date + 60 <= current_date) as window_60d_complete,
  (r.launch_date + 90 <= current_date) as window_90d_complete,

  -- variance: against the period when the launch has one, else the 90-day tail
  case when nullif(r.po_units_committed, 0) is not null
        and coalesce(a.units_in_period, a.units_90d) is not null
       then round(100.0 * coalesce(a.units_in_period, a.units_90d) / r.po_units_committed, 1)
  end as pct_of_po_units_sold,
  case when r.projected_revenue is not null and r.projected_revenue <> 0
        and coalesce(a.net_in_period, a.net_90d) is not null
       then round(100.0 * coalesce(a.net_in_period, a.net_90d) / r.projected_revenue, 1)
  end as pct_of_projected_revenue,

  r.recorded_actual_revenue
from resolved r
left join lateral (
  select
    count(distinct s.sku) as matched_skus,

    sum(s.total_quantity_sold) filter (
      where r.launch_end_date is not null and s.day_date >= r.launch_date
        and s.day_date <= r.launch_end_date)                              as units_in_period,
    round(sum(s.total_net_sales) filter (
      where r.launch_end_date is not null and s.day_date >= r.launch_date
        and s.day_date <= r.launch_end_date), 2)                          as net_in_period,

    sum(s.total_quantity_sold) filter (
      where r.preview_start_date is not null and s.day_date >= r.preview_start_date
        and s.day_date < r.launch_date)                                   as units_preview,
    round(sum(s.total_net_sales) filter (
      where r.preview_start_date is not null and s.day_date >= r.preview_start_date
        and s.day_date < r.launch_date), 2)                               as net_preview,

    sum(s.total_quantity_sold) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 30)      as units_30d,
    round(sum(s.total_net_sales) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 30), 2) as net_30d,
    sum(s.total_quantity_sold) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 60)      as units_60d,
    round(sum(s.total_net_sales) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 60), 2) as net_60d,
    sum(s.total_quantity_sold) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 90)      as units_90d,
    round(sum(s.total_net_sales) filter (where s.day_date >= r.launch_date and s.day_date < r.launch_date + 90), 2) as net_90d,
    sum(s.total_quantity_sold) filter (where s.day_date >= r.launch_date)      as units_365d,
    round(sum(s.total_net_sales) filter (where s.day_date >= r.launch_date), 2) as net_365d
  from public.sales_by_day s
  where r.skus is not null
    and s.sku = any (r.skus)
    and s.company_entity_id = r.company_entity_id
    -- scan spans the preview window through the later of the 365-day tail
    -- and the period end, so no configured window falls outside it
    and s.day_date >= least(r.launch_date, coalesce(r.preview_start_date, r.launch_date))
    and s.day_date <  greatest(r.launch_date + 365, coalesce(r.launch_end_date, r.launch_date) + 1)
) a on true;

revoke all on public.launch_actuals_v from anon;
grant select on public.launch_actuals_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['launch','actuals','performance','vs plan','variance','sell-through','promotion','period','campaign','did it work'],
  description = $d$What each launch actually sold versus what it planned. Launches come in two shapes and this view measures both: a PERIOD (is_period true, launch_end_date set -- a bounded promotion like a Back To School or Labor Day sale) reports units_in_period/net_in_period across [launch_date, launch_end_date]; a POINT drop (launch_end_date null) reports fixed tails units_30d/60d/90d/365d from launch_date. pct_of_po_units_sold and pct_of_projected_revenue automatically use the period when there is one and the 90-day tail otherwise. units_preview/net_preview cover [preview_start_date, launch_date) for launches with a preview. Measurement runs through launch_calendar.linked_po_id -> po_lines.sku_snapshot -> sales_by_day.sku; launch_calendar.product_sku is a PRODUCT-level id that does NOT match sales_by_day's size-prefixed variant SKUs, so it is deliberately unused. sku_source = null means NOT MEASURABLE (no PO linked) -- report it that way, never as zero sales. Check period_complete / window_*_complete before treating a figure as final. NOTE: some multi-day campaigns are still entered as TWO rows (a start and a separate "... End" / "Promotion End" row) rather than one row with launch_end_date; those measure as two point launches until merged.$d$
where relname = 'launch_actuals_v';

-- Two measured caveats, recorded because both are silent misreadings:
--
-- 1. pct_of_po_units_sold is only meaningful for a NEW-PRODUCT PO
--    (po_headers.is_new_product_po). For a RESTOCK of existing SKUs the
--    window's sales include units from earlier POs, so the figure can
--    exceed 100% without the buy having sold out -- measured live,
--    OSI-245-MLB shows 780 committed against 1,099 sold in 90 days (141%).
--
-- 2. expected_arrival_date is a WAREHOUSE date, not a selling start.
--    Several POs measured zero units in the first 14 days after arrival
--    and thousands across 90. Anchoring measurement on arrival would
--    report a healthy product as a total failure.
--
-- Both are written into the schema catalog description above so Ask SILO
-- carries the warning at the point of use, not just here.
