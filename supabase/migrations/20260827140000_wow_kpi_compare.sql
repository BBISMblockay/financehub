-- Week-over-week and year-over-year deltas for the KPI band.
--
-- The band showed this week's values with no comparison, so a reader had no
-- way to tell a good week from a bad one without scrolling to the funnel.
-- Sammie asked for "a % change for the time period being looked at" at the
-- top; this is that.
--
-- Sources are copied EXACTLY from wow_report's own CTEs, not re-derived:
--   sales  -> sales_by_day, lower(btrim(location_tag)) = 'online'
--   orders -> shopify_orders, cancelled_at is null,
--             source_name not in ('pos','faire','shopify_draft_order')
-- If these drifted from wow_report, the headline number and its own delta
-- would disagree, which is worse than showing no delta at all.
--
-- A percent change is null, never 0, when the base period is empty: "no
-- prior data" and "flat" are different answers and must not render alike.
create or replace function public.wow_kpi_compare(p_report_date date)
returns jsonb
language sql
stable
as $$
with w as (
  select p_report_date as e, p_report_date - 6 as s,
         p_report_date - 7 as pe, p_report_date - 13 as ps,
         p_report_date - 364 as lye, p_report_date - 370 as lys
),
sbd as (
  select s.* from public.sales_by_day s cross join w
  where s.day_date between w.lys and w.e
    and lower(btrim(s.location_tag)) = 'online'
),
sales as (
  select
    coalesce(sum(total_sales)     filter (where day_date between (select s from w)   and (select e from w)),0)   as tot_cur,
    coalesce(sum(total_sales)     filter (where day_date between (select ps from w)  and (select pe from w)),0)  as tot_prev,
    coalesce(sum(total_sales)     filter (where day_date between (select lys from w) and (select lye from w)),0) as tot_ly,
    coalesce(sum(total_net_sales) filter (where day_date between (select s from w)   and (select e from w)),0)   as net_cur,
    coalesce(sum(total_net_sales) filter (where day_date between (select ps from w)  and (select pe from w)),0)  as net_prev,
    coalesce(sum(total_net_sales) filter (where day_date between (select lys from w) and (select lye from w)),0) as net_ly
  from sbd
),
ordc as (
  select
    count(*) filter (where o.shopify_created_at::date between (select s from w)   and (select e from w))   as ord_cur,
    count(*) filter (where o.shopify_created_at::date between (select ps from w)  and (select pe from w))  as ord_prev,
    count(*) filter (where o.shopify_created_at::date between (select lys from w) and (select lye from w)) as ord_ly
  from public.shopify_orders o cross join w
  where o.shopify_created_at::date between w.lys and w.e
    and o.cancelled_at is null
    and o.source_name not in ('pos','faire','shopify_draft_order')
)
select jsonb_build_object(
  'total_sales', jsonb_build_object(
     'cur', round(s.tot_cur::numeric,0), 'prev', round(s.tot_prev::numeric,0), 'ly', round(s.tot_ly::numeric,0),
     'wow', case when s.tot_prev > 0 then round(100.0*(s.tot_cur - s.tot_prev)/s.tot_prev,1) end,
     'yoy', case when s.tot_ly   > 0 then round(100.0*(s.tot_cur - s.tot_ly)/s.tot_ly,1) end),
  'net_sales', jsonb_build_object(
     'cur', round(s.net_cur::numeric,0), 'prev', round(s.net_prev::numeric,0), 'ly', round(s.net_ly::numeric,0),
     'wow', case when s.net_prev > 0 then round(100.0*(s.net_cur - s.net_prev)/s.net_prev,1) end,
     'yoy', case when s.net_ly   > 0 then round(100.0*(s.net_cur - s.net_ly)/s.net_ly,1) end),
  'orders', jsonb_build_object(
     'cur', o.ord_cur, 'prev', o.ord_prev, 'ly', o.ord_ly,
     'wow', case when o.ord_prev > 0 then round(100.0*(o.ord_cur - o.ord_prev)::numeric/o.ord_prev,1) end,
     'yoy', case when o.ord_ly   > 0 then round(100.0*(o.ord_cur - o.ord_ly)::numeric/o.ord_ly,1) end),
  'aov', jsonb_build_object(
     'cur',  case when o.ord_cur  > 0 then round((s.tot_cur/o.ord_cur)::numeric,2) end,
     'prev', case when o.ord_prev > 0 then round((s.tot_prev/o.ord_prev)::numeric,2) end,
     'ly',   case when o.ord_ly   > 0 then round((s.tot_ly/o.ord_ly)::numeric,2) end,
     'wow',  case when o.ord_cur > 0 and o.ord_prev > 0 and s.tot_prev > 0
                  then round(100.0*((s.tot_cur/o.ord_cur) - (s.tot_prev/o.ord_prev))/(s.tot_prev/o.ord_prev),1) end,
     'yoy',  case when o.ord_cur > 0 and o.ord_ly > 0 and s.tot_ly > 0
                  then round(100.0*((s.tot_cur/o.ord_cur) - (s.tot_ly/o.ord_ly))/(s.tot_ly/o.ord_ly),1) end)
)
from sales s cross join ordc o;
$$;

grant execute on function public.wow_kpi_compare(date) to authenticated;
