-- launch_actuals_v: what a launch actually did, measured against what it planned.
--
-- This is the last hop of concept -> PO -> launch -> actuals. The three
-- earlier hops are links (20260825210000); this one is the measurement,
-- and it is the reason the links matter.
--
-- WHY SKUs COME ONLY FROM THE PO
--
-- launch_calendar has a product_sku column, and resolving SKUs from it
-- would have been the obvious shortcut. Measured against production, it
-- does not work: launch_calendar.product_sku is a PRODUCT-level
-- identifier ("TTHoodie(Navy)-Mens", "LAGlovesAWHoodie(Dodgers)-Mens")
-- while sales_by_day.sku and po_lines.sku_snapshot are SIZE-PREFIXED
-- VARIANT identifiers ("M-SwingingSantaHoodie-Mens", "YS-DodgeballLegend-Y").
-- Of the 2 launches carrying a product_sku, 0 match sales_by_day.sku --
-- and 0 match even as a suffix. By contrast 1,022 of 2,033 distinct
-- po_lines.sku_snapshot values are present in sales_by_day.
--
-- So this view resolves SKUs ONLY through linked_po_id -> po_lines, and
-- deliberately does NOT fall back to product_sku. A fallback would join
-- on a vocabulary that never matches and return 0 units for a launch that
-- actually sold well -- silently indistinguishable from a flop, which is
-- the single worst failure mode a performance view can have. A launch
-- with no PO link reports sku_source = null and NULL actuals, which reads
-- as "not measurable" rather than "sold nothing".
--
-- This makes linked_po_id load-bearing rather than decorative: it is the
-- only path by which a launch can ever be measured. Today 0 of 51
-- launches have it set, so this view returns NULL actuals for every
-- existing row. That is the honest current state, not a defect -- it
-- lights up for launches created through the concept -> PO -> launch
-- chain going forward.
--
-- WINDOW COMPLETENESS
--
-- A launch 5 days old has a "30-day" number that is not a 30-day number.
-- Each window carries a *_window_complete flag so a partial figure is
-- never read as final -- the same reason product_concepts records
-- evidence strength instead of a confidence percentage.

create or replace view public.launch_actuals_v
with (security_invoker = true) as
with resolved as (
  select
    lc.id                    as launch_id,
    lc.company_entity_id,
    lc.title,
    lc.launch_date,
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
  r.status,
  r.launch_type,
  r.linked_po_id,
  r.source_concept_id,

  -- provenance: how (and whether) this launch can be measured at all
  case when r.skus is not null then 'po_lines' end   as sku_source,
  coalesce(cardinality(r.skus), 0)                   as sku_count,
  coalesce(a.matched_skus, 0)                        as skus_with_sales,

  -- the plan. po_* are the COMMITTED numbers a human approved on the PO;
  -- expected_units/projected_revenue are whatever was typed on the launch.
  -- Both are exposed because they disagree in practice, and which one an
  -- actual is judged against is the reader's call, not this view's.
  r.expected_units,
  r.projected_revenue,
  r.expected_retail_value,
  nullif(r.po_units_committed, 0)        as po_units_committed,
  nullif(r.po_retail_value_committed, 0) as po_retail_value_committed,

  (current_date - r.launch_date)         as days_since_launch,

  a.units_30d,  a.net_30d,
  a.units_60d,  a.net_60d,
  a.units_90d,  a.net_90d,
  a.units_365d, a.net_365d,

  (r.launch_date + 30 <= current_date) as window_30d_complete,
  (r.launch_date + 60 <= current_date) as window_60d_complete,
  (r.launch_date + 90 <= current_date) as window_90d_complete,

  -- variance against the committed buy, the number a reviewer actually
  -- signed. Null when either side is missing rather than 0, so "no data"
  -- never renders as "sold none of it".
  case when nullif(r.po_units_committed, 0) is not null and a.units_90d is not null
       then round(100.0 * a.units_90d / r.po_units_committed, 1) end as pct_of_po_units_sold_90d,
  case when r.projected_revenue is not null and r.projected_revenue <> 0 and a.net_90d is not null
       then round(100.0 * a.net_90d / r.projected_revenue, 1) end    as pct_of_projected_revenue_90d,

  r.recorded_actual_revenue
from resolved r
left join lateral (
  select
    count(distinct s.sku)                                                          as matched_skus,
    sum(s.total_quantity_sold) filter (where s.day_date < r.launch_date + 30)      as units_30d,
    round(sum(s.total_net_sales) filter (where s.day_date < r.launch_date + 30), 2) as net_30d,
    sum(s.total_quantity_sold) filter (where s.day_date < r.launch_date + 60)      as units_60d,
    round(sum(s.total_net_sales) filter (where s.day_date < r.launch_date + 60), 2) as net_60d,
    sum(s.total_quantity_sold) filter (where s.day_date < r.launch_date + 90)      as units_90d,
    round(sum(s.total_net_sales) filter (where s.day_date < r.launch_date + 90), 2) as net_90d,
    sum(s.total_quantity_sold)                                                     as units_365d,
    round(sum(s.total_net_sales), 2)                                               as net_365d
  from public.sales_by_day s
  where r.skus is not null
    and s.sku = any (r.skus)
    -- sales_by_day IS fully company-stamped (1,137,938/1,137,938 across 2
    -- companies) despite CLAUDE.md still listing the backfill as deferred.
    -- Scoped explicitly here rather than relying on that, since a wrong
    -- answer crossing tenants is worse than a redundant predicate.
    and s.company_entity_id = r.company_entity_id
    and s.day_date >= r.launch_date
    and s.day_date <  r.launch_date + 365
) a on true;

revoke all on public.launch_actuals_v from anon;
grant select on public.launch_actuals_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['launch','actuals','performance','vs plan','variance','sell-through','did it work'],
  description = $d$What each launch actually sold versus what it planned: units and net sales at 30/60/90/365 days from launch_date, the committed PO buy (po_units_committed), and percent-of-plan variance. Measurement runs through launch_calendar.linked_po_id -> po_lines.sku_snapshot -> sales_by_day.sku; launch_calendar.product_sku is a PRODUCT-level id that does NOT match sales_by_day's size-prefixed variant SKUs (0 of 2 match), so it is deliberately not used. A launch with sku_source = null is NOT MEASURABLE (no PO linked) -- report it that way, never as zero sales. Check window_30d/60d/90d_complete before treating a figure as final: a launch 5 days old has a partial 30-day number. As of this writing 0 of 51 launches have linked_po_id set, so actuals are null across the board until launches start coming through the concept -> PO -> launch chain.$d$
where relname = 'launch_actuals_v';
