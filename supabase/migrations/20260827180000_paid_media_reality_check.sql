-- Paid-media reality check: the honest denominators next to the claimed ones.
--
-- wow_paid_media reports `roas = conversion_value / spend` per campaign and
-- per group. conversion_value is what the PLATFORM claims it drove, not
-- revenue -- each platform counts every sale it touched, inside its own
-- attribution window, and none of them subtract each other. Measured on prod
-- for the 30 days ending 2026-08-26:
--
--   meta_ads   claimed  $1,165,333   on   $423,738 spend
--   google_ads claimed  $  213,658   on   $ 37,989 spend
--   -------------------------------------------------
--   claimed total       $1,378,991
--   actual online net   $1,481,772   -> the platforms claim 93.1% of it
--
-- That number is not actionable and no amount of extra API access fixes it;
-- it is what the API returns. This function does not try to re-attribute
-- anything (that is a modelling problem, and guessing at it would produce a
-- confidently wrong number, which is worse than a blank -- same stance as
-- launch_actuals_v's sku_source = null). It reports the metrics that cannot
-- double-count, alongside the claim so the gap is visible rather than hidden:
--
--   ncac        paid spend / NEW customers  -- the metric that actually
--               governs a DTC buy decision
--   mer_online  online net sales / paid spend (aMER)
--   mer_blended all-location net sales / paid spend
--   claim_ratio platform-claimed revenue / online net sales. A diagnostic,
--               not a KPI: at 0.93 the platforms are claiming nearly every
--               online dollar, so per-platform ROAS cannot be summed or
--               trusted as incremental.
--
-- New customers come from shopify_customer_metrics_daily (ShopifyQL), NOT
-- from shopify_orders. shopify_orders is a patchwork of partial backfills --
-- Aug-Oct 2025 and Jan/Mar 2026 are missing -- so deriving "first order ever"
-- from it would count a returning customer as new and understate nCAC.
--
-- ga4 is excluded from spend and claimed revenue: it is analytics, not an ad
-- platform. Its conversion_value is site-wide revenue and its `conversions`
-- are key events (628,511 in 30 days), so summing it alongside the ad
-- platforms produces a meaningless total. Anything grouping
-- marketing_kpis_daily by platform must exclude it -- see the catalog note
-- at the bottom of this migration, which is what stops Ask SILO doing it.
--
-- Every scan is date-bounded so the planner uses sales_by_day_company_day_idx
-- rather than seq-scanning the largest table in the database -- the lesson
-- from 20260827170000, where an unbounded lookup blew the statement timeout
-- and three cards rendered empty as if there were no data.
--
-- Ratios are null, never 0, when the denominator is empty: "nothing spent"
-- and "spent and got nothing" must not render alike.

create or replace function public.wow_paid_media_reality(p_report_date date)
returns jsonb
language sql
stable
as $$
with w as (
  select p_report_date as e, p_report_date - 6 as s
),
paid as (
  -- Ad platforms only. ga4 is deliberately absent; see the header.
  select coalesce(sum(k.spend), 0)            as spend,
         coalesce(sum(k.conversion_value), 0) as claimed_rev,
         coalesce(sum(k.conversions), 0)      as claimed_conv
  from public.marketing_kpis_daily k cross join w
  where k.company_entity_id = public.active_company_id()
    and k.platform in ('meta_ads', 'google_ads', 'tiktok_ads')
    and k.day_date between w.s and w.e
),
online AS (
  -- Same source and predicate wow_kpi_compare uses, so the headline number
  -- and this one can never disagree.
  select coalesce(sum(s.total_net_sales), 0) as online_net
  from public.sales_by_day s cross join w
  where s.company_entity_id = public.active_company_id()
    and s.day_date between w.s and w.e
    and lower(btrim(s.location_tag)) = 'online'
),
all_sales as (
  select coalesce(sum(s.total_net_sales), 0) as total_net
  from public.sales_by_day s cross join w
  where s.company_entity_id = public.active_company_id()
    and s.day_date between w.s and w.e
),
cust as (
  -- Scoped to the domains actually taking online orders; the table spans 20
  -- shop_domains including POS, and paid spend does not buy a POS sale.
  select coalesce(sum(c.new_customers), 0)       as new_customers,
         coalesce(sum(c.returning_customers), 0) as returning_customers
  from public.shopify_customer_metrics_daily c cross join w
  where c.company_entity_id = public.active_company_id()
    and c.day_date between w.s and w.e
    and c.shop_domain in (select shop_domain from public.wow_online_shop_domains())
),
not_synced as (
  -- An ad platform with no rows at all in the window. tiktok_ads has never
  -- written a row despite tiktok_ads_kpis being a valid sync_jobs type, so
  -- whatever it spends is in none of these numbers. Reporting the omission
  -- beats silently averaging it away.
  select coalesce(jsonb_agg(t.platform order by t.platform), '[]'::jsonb) as platforms
  from unnest(array['meta_ads', 'google_ads', 'tiktok_ads']) as t(platform)
  where not exists (
    select 1 from public.marketing_kpis_daily k cross join w
    where k.platform = t.platform
      and k.company_entity_id = public.active_company_id()
      and k.day_date between w.s and w.e
  )
)
select jsonb_build_object(
  'window_start',                 (select s from w),
  'window_end',                   (select e from w),
  'paid_spend',                   round(paid.spend, 2),
  'new_customers',                cust.new_customers,
  'returning_customers',          cust.returning_customers,
  'ncac',                         case when cust.new_customers > 0
                                       then round(paid.spend / cust.new_customers, 2) end,
  'online_net_sales',             round(online.online_net, 2),
  'total_net_sales',              round(all_sales.total_net, 2),
  'mer_online',                   case when paid.spend > 0
                                       then round(online.online_net / paid.spend, 2) end,
  'mer_blended',                  case when paid.spend > 0
                                       then round(all_sales.total_net / paid.spend, 2) end,
  'platform_claimed_revenue',     round(paid.claimed_rev, 2),
  'platform_claimed_conversions', round(paid.claimed_conv, 0),
  'claim_ratio',                  case when online.online_net > 0
                                       then round(paid.claimed_rev / online.online_net, 3) end,
  'platforms_not_synced',         not_synced.platforms
)
from paid, online, all_sales, cust, not_synced;
$$;

grant execute on function public.wow_paid_media_reality(date) to authenticated;

comment on function public.wow_paid_media_reality(date) is
  'Honest paid-media denominators for the 7 days ending p_report_date: nCAC (spend / new customers), online and blended MER, and claim_ratio -- platform-claimed revenue over actual online net sales, which ran 0.93 in Aug 2026. Does not re-attribute anything; it reports what cannot double-count next to what the platforms claim. New customers come from shopify_customer_metrics_daily, never from shopify_orders (partial backfills). ga4 excluded: analytics, not an ad platform.';

-- Stop Ask SILO reading conversion_value as revenue. The catalog is where
-- schema meaning lives now -- never hand-typed into the edge function.
update public.silo_chat_schema_catalog
set description = description || ' '
  || 'CLAIMED, NOT ACTUAL: conversion_value and conversions are what each platform '
  || 'claims it drove within its own attribution window. They overlap across platforms '
  || 'and must never be summed into "revenue" -- measured Aug 2026, the platforms '
  || 'together claimed 93% of all online net sales. For real efficiency use '
  || 'wow_paid_media_reality(date) (nCAC, MER, claim_ratio) or divide spend by outcomes '
  || 'from sales_by_day / shopify_customer_metrics_daily. Also: ga4 rows are NOT an ad '
  || 'platform -- conversion_value is site-wide revenue and conversions are key events -- '
  || 'so exclude platform = ''ga4'' from any spend or revenue rollup. tiktok_ads has never '
  || 'synced a row, so TikTok spend is absent entirely rather than zero.',
    updated_at = now()
where relname = 'marketing_kpis_daily'
  and coalesce(description, '') not like '%CLAIMED, NOT ACTUAL%';
