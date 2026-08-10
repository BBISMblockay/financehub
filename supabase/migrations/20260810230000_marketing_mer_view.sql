-- Marketing MER ledger view: blended paid ad spend (marketing_kpis_daily,
-- ad platforms only — GA4 excluded) joined to Shopify ONLINE net revenue
-- (sales_by_day rows whose location is store_type='online') per company per
-- day. Both sides are ledgers — platforms bill what was spent, Shopify
-- records actual orders — so online_net_sales / ad_spend is a true MER,
-- immune to platform attribution inflation. Channel-level credit stays in
-- marketing_kpis_daily (platform-attributed) and GA4 rows (directional).
--
-- sales_by_day.location_tag is written by the Shopify sync as
-- slugify(location_code || location_name) (see shopify-sync-core.mjs and the
-- matching join comment in bi-sales-overview.html), so the join must apply
-- the same slugification to the locations side — a raw location_code match
-- only works when the code already happens to be slug-form.
--
-- full outer join: days with revenue but no spend (and vice versa) still
-- appear — consumers window by day_date.

create or replace view public.v_marketing_mer_daily
with (security_invoker = true) as
with spend as (
  select
    company_entity_id,
    day_date,
    sum(spend) as ad_spend,
    sum(conversions) as platform_conversions,
    sum(conversion_value) as platform_conv_value
  from public.marketing_kpis_daily
  where platform <> 'ga4'
  group by 1, 2
),
online_rev as (
  select
    s.company_entity_id,
    s.day_date,
    sum(s.total_net_sales) as online_net_sales,
    -- sales_by_day is one row per ORDER LINE (order x SKU; total_orders=1 on
    -- sale rows), so this sum counts lines, not distinct orders (~2.8 SKUs
    -- per order baseline, ~6x during sales). True order counts are not
    -- derivable from this table's grain -- named accordingly.
    sum(s.total_orders) as online_order_lines
  from public.sales_by_day s
  join public.locations l
    on l.company_entity_id = s.company_entity_id
   and l.store_type = 'online'
   -- slugify(), in SQL: lowercase, non-alphanumeric runs → '_', trim '_'
   and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code, ''), l.location_name)), '[^a-z0-9]+', '_', 'g'), '_'), '')
       = s.location_tag
  group by 1, 2
)
select
  coalesce(sp.company_entity_id, r.company_entity_id) as company_entity_id,
  coalesce(sp.day_date, r.day_date) as day_date,
  coalesce(sp.ad_spend, 0) as ad_spend,
  coalesce(sp.platform_conversions, 0) as platform_conversions,
  coalesce(sp.platform_conv_value, 0) as platform_conv_value,
  coalesce(r.online_net_sales, 0) as online_net_sales,
  coalesce(r.online_order_lines, 0) as online_order_lines
from spend sp
full outer join online_rev r
  on r.company_entity_id = sp.company_entity_id
 and r.day_date = sp.day_date;
