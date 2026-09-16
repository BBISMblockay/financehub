// supabase/functions/silo-chat/evidence-fixtures.mjs
//
// FROZEN fixtures reproducing the two traced Ask SILO answers of 2026-09-16
// (silo_chat_audit_log c0b642ca-3bc4-4703-be94-995cb7f0a7b9 and
// 7c90b2cd-84a2-4ce8-888f-a2186ba0927c), used by the deterministic tests and
// by the model evaluation in evals/.
//
// WHAT IS REAL AND WHAT IS NOT:
//   * The SQL strings are the statements those requests actually ran, copied
//     from queries_run.
//   * The column lists are the real public-schema shapes, which is what makes
//     the scope derivation meaningful -- marketing_daily_totals_v genuinely
//     has no platform column, and that is the whole point.
//   * The ROWS are synthetic and hand-written. They carry the same figures the
//     independent read-only checks returned on 2026-09-16, because the failure
//     is about how those figures get LABELLED, so the shapes must match. No
//     customer, employee or order-level record appears anywhere here.
//
// These figures are CAPTURED OBSERVATIONS, not constants. Historical
// attribution and synced data move; if a re-check disagrees with a number
// here, the fixture is stale, not production. Nothing in the repo reads them
// as truth about the business -- they exist to hold a claim/evidence shape
// still while the code that must respect it is tested.

/** silo_chat_schema_catalog rows, trimmed to the relations these traces
 *  touched. Column lists as of 2026-09-16. */
export const CATALOG_FIXTURE = [
  {
    relname: 'marketing_daily_totals_v',
    relkind: 'view',
    keywords: ['marketing', 'spend', 'blended'],
    description:
      'One row per day: total paid ad spend, impressions, clicks, platform-attributed conversions and value, plus GA4 sessions and site revenue. Use for spend trend over time.',
    columns: [
      { name: 'company_entity_id', type: 'uuid' },
      { name: 'day_date', type: 'date' },
      { name: 'ad_spend', type: 'numeric' },
      { name: 'impressions', type: 'numeric' },
      { name: 'clicks', type: 'numeric' },
      { name: 'platform_conversions', type: 'numeric' },
      { name: 'platform_conversion_value', type: 'numeric' },
      { name: 'sessions', type: 'numeric' },
      { name: 'ga4_revenue', type: 'numeric' },
      { name: 'blended_roas', type: 'numeric' },
      { name: 'blended_cpa', type: 'numeric' },
    ],
  },
  {
    relname: 'marketing_kpis_daily',
    relkind: 'table',
    keywords: ['marketing', 'ads', 'spend', 'campaign'],
    description:
      "Daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), CAMPAIGN-level. The authoritative ledger for spend. CLAIMED, NOT ACTUAL: conversion_value is what each PLATFORM claims it drove.",
    columns: [
      { name: 'id', type: 'uuid' }, { name: 'company_entity_id', type: 'uuid' },
      { name: 'connection_id', type: 'uuid' }, { name: 'platform', type: 'text' },
      { name: 'ds_id', type: 'text' }, { name: 'account_id', type: 'text' },
      { name: 'account_name', type: 'text' }, { name: 'day_date', type: 'date' },
      { name: 'campaign_id', type: 'text' }, { name: 'campaign_name', type: 'text' },
      { name: 'impressions', type: 'bigint' }, { name: 'clicks', type: 'bigint' },
      { name: 'spend', type: 'numeric(14,2)' }, { name: 'conversions', type: 'numeric(14,2)' },
      { name: 'conversion_value', type: 'numeric(14,2)' }, { name: 'sessions', type: 'bigint' },
      { name: 'leads', type: 'bigint' },
    ],
  },
  {
    relname: 'meta_ad_performance_daily',
    relkind: 'table',
    keywords: ['meta', 'ad', 'creative'],
    description: 'Ad-level (not just campaign-level) Meta performance.',
    columns: [
      { name: 'id', type: 'uuid' }, { name: 'company_entity_id', type: 'uuid' },
      { name: 'account_id', type: 'text' }, { name: 'day_date', type: 'date' },
      { name: 'campaign_id', type: 'text' }, { name: 'campaign_name', type: 'text' },
      { name: 'adset_id', type: 'text' }, { name: 'adset_name', type: 'text' },
      { name: 'ad_id', type: 'text' }, { name: 'ad_name', type: 'text' },
      { name: 'impressions', type: 'bigint' }, { name: 'clicks', type: 'bigint' },
      { name: 'spend', type: 'numeric(14,2)' }, { name: 'conversions', type: 'numeric(14,2)' },
      { name: 'conversion_value', type: 'numeric(14,2)' }, { name: 'leads', type: 'bigint' },
    ],
  },
  {
    relname: 'meta_ad_creatives',
    relkind: 'table',
    keywords: ['meta', 'creative', 'copy'],
    description:
      'Meta ad creative metadata as it stands NOW -- one row per ad, overwritten by each sync.',
    columns: [
      { name: 'company_entity_id', type: 'uuid' }, { name: 'ad_id', type: 'text' },
      { name: 'account_id', type: 'text' }, { name: 'ad_name', type: 'text' },
      { name: 'campaign_id', type: 'text' }, { name: 'adset_id', type: 'text' },
      { name: 'effective_status', type: 'text' }, { name: 'creative_id', type: 'text' },
      { name: 'thumbnail_url', type: 'text' }, { name: 'body', type: 'text' },
      { name: 'title', type: 'text' }, { name: 'object_type', type: 'text' },
      { name: 'link_url', type: 'text' }, { name: 'link_path', type: 'text' },
    ],
  },
  {
    relname: 'sales_by_day',
    relkind: 'table',
    keywords: ['sales', 'revenue'],
    description: 'Per-SKU per-day sales aggregates.',
    columns: [
      { name: 'id', type: 'bigint' }, { name: 'location_tag', type: 'text' },
      { name: 'source', type: 'text' }, { name: 'day_date', type: 'date' },
      { name: 'product_name', type: 'text' }, { name: 'sku', type: 'text' },
      { name: 'product_type', type: 'text' }, { name: 'total_quantity_sold', type: 'integer' },
      { name: 'total_net_sales', type: 'numeric(12,2)' }, { name: 'shop_domain', type: 'text' },
      { name: 'location_name', type: 'text' }, { name: 'company_entity_id', type: 'uuid' },
    ],
  },
  {
    relname: 'sales_by_product_title_daily_v',
    relkind: 'view',
    keywords: ['sales', 'product', 'title'],
    description:
      'Sales rolled up from SKU variants to product title, per location per day.',
    columns: [
      { name: 'company_entity_id', type: 'uuid' }, { name: 'product_title', type: 'text' },
      { name: 'title_source', type: 'text' }, { name: 'product_type', type: 'text' },
      { name: 'location_tag', type: 'text' }, { name: 'day_date', type: 'date' },
      { name: 'variant_skus', type: 'bigint' }, { name: 'units_sold', type: 'bigint' },
      { name: 'orders', type: 'bigint' }, { name: 'gross_sales', type: 'numeric' },
      { name: 'discounts', type: 'numeric' }, { name: 'refunds', type: 'numeric' },
      { name: 'net_sales', type: 'numeric' },
    ],
  },
  {
    relname: 'launch_calendar',
    relkind: 'table',
    keywords: ['launch', 'drop', 'campaign'],
    description: 'Marketing launches. launch_date is the drop date.',
    columns: [
      { name: 'id', type: 'uuid' }, { name: 'company_entity_id', type: 'uuid' },
      { name: 'launch_name', type: 'text' }, { name: 'launch_date', type: 'date' },
      { name: 'launch_end_date', type: 'date' }, { name: 'launch_type', type: 'text' },
    ],
  },
];

/** Trace 1, query 8. Weekly spend vs online sales. Reads
 *  marketing_daily_totals_v, which carries NO platform column -- the sum is
 *  every platform. The answer called it "Meta ad spend". */
export const COMBINED_SPEND_SQL = `WITH weeks AS (
  SELECT day_date,
    CASE
      WHEN day_date BETWEEN '2026-08-17' AND '2026-08-23' THEN 1
      WHEN day_date BETWEEN '2026-08-24' AND '2026-08-30' THEN 2
      WHEN day_date BETWEEN '2026-08-31' AND '2026-09-06' THEN 3
      WHEN day_date BETWEEN '2026-09-07' AND '2026-09-13' THEN 4
    END as wk_num
  FROM marketing_daily_totals_v
  WHERE day_date BETWEEN '2026-08-17' AND '2026-09-13'
),
mkt AS (
  SELECT w.wk_num, sum(m.ad_spend) as ad_spend, sum(m.platform_conversion_value) as platform_value
  FROM marketing_daily_totals_v m JOIN weeks w ON w.day_date = m.day_date
  GROUP BY w.wk_num
),
sales AS (
  SELECT CASE
      WHEN day_date BETWEEN '2026-08-31' AND '2026-09-06' THEN 3
      ELSE 0
    END as wk_num,
    sum(total_net_sales) as online_net_sales
  FROM sales_by_day
  WHERE day_date BETWEEN '2026-08-17' AND '2026-09-13' AND location_tag='online'
  GROUP BY 1
)
SELECT s.wk_num, s.online_net_sales, m.ad_spend, m.platform_value
FROM sales s JOIN mkt m ON m.wk_num = s.wk_num
ORDER BY s.wk_num`;

/** Combined spend for Aug 24-30 across every platform. */
export const COMBINED_SPEND_ROWS = [
  { wk_num: 2, online_net_sales: 165326.0, ad_spend: 118945.91, platform_value: 262266.81 },
];

/** Trace 1, query 9 -- the per-platform split, which the same request had in
 *  hand one round later. Meta was $114,334.99, not $118,945.91. */
export const PER_PLATFORM_SQL = `SELECT platform, sum(spend) as spend, sum(conversion_value) as platform_value,
  round(sum(conversion_value)/nullif(sum(spend),0),2) as platform_roas
FROM marketing_kpis_daily
WHERE day_date BETWEEN '2026-08-24' AND '2026-08-30'
GROUP BY platform
ORDER BY spend DESC`;

export const PER_PLATFORM_ROWS = [
  { platform: 'meta_ads', spend: 114334.99, platform_value: 115638.28, platform_roas: 1.01 },
  { platform: 'google_ads', spend: 4610.92, platform_value: 16132.2, platform_roas: 3.5 },
  { platform: 'ga4', spend: 0.0, platform_value: 130496.33, platform_roas: null },
];

/** Trace 1, query 12. Weekly buckets over a campaign. Bucket 3 runs
 *  Aug 31 - Sep 6 and therefore STRADDLES the Sep 1 launch: the $17,500 in it
 *  was spent on Aug 31, before launch, while the $85,120 of attributed value
 *  landed Sep 1 onward. The answer read bucket 3 as "post-launch spend" and
 *  built a recommendation on the 4.86 that produced. */
export const WEEKLY_BUCKET_SQL = `SELECT
  CASE
    WHEN day_date BETWEEN '2026-08-17' AND '2026-08-23' THEN 1
    WHEN day_date BETWEEN '2026-08-24' AND '2026-08-30' THEN 2
    WHEN day_date BETWEEN '2026-08-31' AND '2026-09-06' THEN 3
    WHEN day_date BETWEEN '2026-09-07' AND '2026-09-13' THEN 4
  END as wk_num,
  campaign_name, sum(spend) as spend, sum(conversion_value) as value,
  round(sum(conversion_value)/nullif(sum(spend),0),2) as roas
FROM marketing_kpis_daily
WHERE day_date BETWEEN '2026-08-17' AND '2026-09-13' AND platform='meta_ads' AND campaign_name='Subscribers'
GROUP BY 1, campaign_name
ORDER BY 1`;

export const WEEKLY_BUCKET_ROWS = [
  { wk_num: 2, campaign_name: 'Subscribers', spend: 52978.18, value: 5961.4, roas: 0.11 },
  { wk_num: 3, campaign_name: 'Subscribers', spend: 17500.0, value: 85120.14, roas: 4.86 },
];

/** The day grain under bucket 3, which is where the straddle is visible. */
export const DAILY_STRADDLE_ROWS = [
  { day_date: '2026-08-31', spend: 17500.0, value: 1076.65 },
  { day_date: '2026-09-01', spend: 0.0, value: 74258.36 },
  { day_date: '2026-09-02', spend: 0.0, value: 5545.93 },
];

/** Trace 2, query 8. Ads selected by CURRENT creative body text, with no
 *  campaign predicate and no date predicate. The answer described the result
 *  as one campaign shifting off lead generation. */
export const CREATIVE_MATCH_SQL = `with sonic_ads as (
  select ad_id from meta_ad_creatives where body ilike '%sonic%'
)
select m.day_date, sum(m.spend) spend, sum(m.leads) leads, sum(m.conversion_value) conv_val
from meta_ad_performance_daily m
join sonic_ads s on s.ad_id = m.ad_id
group by m.day_date
order by m.day_date`;

/** What that population really contained over Sep 1-7: two campaigns. */
export const CREATIVE_MATCH_BY_CAMPAIGN_ROWS = [
  { campaign_name: 'Purchase Campaigns', spend: 25488.06, leads: 650 },
  { campaign_name: 'Subscribers', spend: 0.0, leads: 8 },
];

/** Trace b44e03ab (2026-09-16), R1: the planning record. It ANSWERS the launch
 *  date and is SILENT on when prelaunch began -- `preview_start_date` is null on
 *  every Sonic row, as are the budget fields the question asked about. The
 *  answer went on to treat 2026-08-01 as the prelaunch boundary. */
export const SONIC_LAUNCH_SQL = `select id, title, launch_date, launch_end_date, preview_start_date, status,
  expected_units, preview_marketing_budget, actual_preview_spend
from launch_calendar
where title ilike '%sonic%' or collection_name ilike '%sonic%'
order by launch_date`;

export const SONIC_LAUNCH_ROWS = [
  { id: 'l1', title: 'Baseballism x Sonic the Hedgehog', launch_date: '2026-09-01', launch_end_date: null, preview_start_date: null, status: 'Launched', expected_units: 8000, preview_marketing_budget: null, actual_preview_spend: null },
  { id: 'l2', title: 'Sonic ICYMI', launch_date: '2026-09-03', launch_end_date: null, preview_start_date: null, status: 'Launched', expected_units: null, preview_marketing_budget: null, actual_preview_spend: null },
];

/** R8: 192 rows of Sonic sales with NO channel predicate. The live envelope
 *  reported location_tag pooled; the answer called the figures "online". */
export const SONIC_TITLE_SALES_SQL = `select product_title, day_date, sum(units_sold) as units, sum(net_sales) as net, sum(orders) as orders
from sales_by_product_title_daily_v
where product_title ilike '%sonic%' and day_date between '2026-08-01' and '2026-09-15'
group by product_title, day_date
order by product_title, day_date`;

/** R13: the statement that would have isolated Sonic ad spend, with the column
 *  guess that killed it. meta_ad_performance_daily's date column is day_date. */
export const SONIC_AD_SPEND_SQL = `select ad_id, campaign_id, min(date) as first_day, max(date) as last_day,
  sum(spend) as spend, sum(conversions) as conversions
from meta_ad_performance_daily
where ad_id in ('52607262852549','52608143563949')
group by ad_id, campaign_id`;

/** The sentence the 2026-09-16 answer actually published, trimmed. */
export const SONIC_ANSWER_CHANNEL_CLAIM =
  'Sales \u2014 14 Sonic products, online sales_by_day, Aug 1 \u2013 Sep 15 2026: sales are overwhelmingly '
  + 'concentrated on launch day itself, with 924 units on 9/1 falling to single digits within a week.';
