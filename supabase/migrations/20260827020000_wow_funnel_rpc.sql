-- Week-over-week storefront funnel for /v2/wow-report.html.
--
-- Additive to wow_report(): kept as its own function rather than rewriting
-- that 176-line body, so a transcription slip cannot break the sales figures
-- the report is already trusted for.
--
-- Source is shopify_sessions_daily (ShopifyQL), which lands sitewide session
-- counts -- the report previously carried a note saying these did not exist
-- and to pull them from GA4 by hand. They exist now.
--
-- Rates are recomputed as sum(numerator)/sum(denominator) over the window,
-- never an average of daily rates.

create or replace function public.wow_funnel(p_report_date date)
returns jsonb
language sql
stable
as $$
with w as (
  select p_report_date       as e,   p_report_date - 6   as s,
         p_report_date - 7   as pe,  p_report_date - 13  as ps,
         p_report_date - 364 as lye, p_report_date - 370 as lys
),
f as (
  select v.* from public.shopify_funnel_daily_v v
  where v.company_entity_id = public.active_company_id()
),
b as (
  select case
           when f.day_date between (select s from w)   and (select e from w)   then 'this'
           when f.day_date between (select ps from w)  and (select pe from w)  then 'prev'
           when f.day_date between (select lys from w) and (select lye from w) then 'ly'
         end as bucket,
         f.*
  from f
),
agg as (
  select bucket,
         count(*)                            as days,
         coalesce(sum(sessions),0)           as sessions,
         coalesce(sum(added_to_cart),0)      as added_to_cart,
         coalesce(sum(reached_checkout),0)   as reached_checkout,
         coalesce(sum(completed_checkout),0) as completed_checkout,
         coalesce(sum(new_customers),0)      as new_customers,
         coalesce(sum(returning_customers),0) as returning_customers
  from b where bucket is not null group by bucket
)
select coalesce(jsonb_object_agg(bucket, jsonb_build_object(
         'days',               days,
         'sessions',           sessions,
         'added_to_cart',      added_to_cart,
         'reached_checkout',   reached_checkout,
         'completed_checkout', completed_checkout,
         'new_customers',      new_customers,
         'returning_customers', returning_customers,
         -- ratios derived at the window grain, not averaged from daily rates
         'cart_rate',     round(100.0 * added_to_cart      / nullif(sessions,0), 2),
         'checkout_rate', round(100.0 * reached_checkout   / nullif(sessions,0), 2),
         'cvr',           round(100.0 * completed_checkout / nullif(sessions,0), 2),
         'cart_to_checkout', round(100.0 * reached_checkout / nullif(added_to_cart,0), 2),
         'checkout_completion', round(100.0 * completed_checkout / nullif(reached_checkout,0), 2)
       )), '{}'::jsonb)
from agg;
$$;

grant execute on function public.wow_funnel(date) to authenticated;
