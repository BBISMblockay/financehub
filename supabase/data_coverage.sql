-- SILO data coverage: what is actually IN the warehouse.
--
-- This is NOT the data dictionary. silo_chat_schema_catalog already answers
-- "what tables exist and what do they mean" -- and on its own that is the
-- wrong tool for the question people actually ask. It would have told you
-- facebook_page_insights_daily exists, which is exactly the misleading
-- answer: the table is real and it holds ZERO rows. Someone checking the
-- dictionary before assuming organic data was available would have come
-- away more confident and still wrong.
--
-- So this answers the other question: is it connected, how far back does it
-- go, how much is there, and what is knowingly missing. Run it in the SQL
-- editor whenever someone asks "do we have X" or "is this current".
--
-- Deliberately a file, not a view or a page: it is a diagnostic, not a
-- product surface, and it costs nothing to leave un-maintained. If it ever
-- needs to answer for Ask SILO too, promoting it to a view is a two-line
-- change.
--
-- One trap this query itself fell into, worth knowing before you edit it:
-- several tables carry BOTH a row-insert timestamp (created_at) and the
-- real business date (shopify_created_at, redo_created_at, payout_date).
-- Reading created_at makes a backfilled table look nine days old. Always
-- use the business date.

with src(ord, area, source, rows, first_at, last_at, note) as (
  values
  (1,'Sales','sales_by_day',
    (select count(*) from public.sales_by_day),
    (select min(day_date)::text from public.sales_by_day),
    (select max(day_date)::text from public.sales_by_day),
    'Per SKU per day. Pre-2026 rows are Better Reports history; shopify_api since. This is the sales source of truth.'),
  (2,'Sales','shopify_orders',
    (select count(*) from public.shopify_orders),
    (select min(shopify_created_at)::date::text from public.shopify_orders),
    (select max(shopify_created_at)::date::text from public.shopify_orders),
    'Order level -- keeps the channel and customer that sales_by_day flattens away. Nightly sync only touches a ~2-day window; older history came from the manual backfill workflow.'),
  (3,'Sales','shopify_order_lines',
    (select count(*) from public.shopify_order_lines), null, null,
    'Line items within each order. Basket-level questions.'),
  (4,'Sales','shopify_payouts',
    (select count(*) from public.shopify_payouts),
    (select min(payout_date)::text from public.shopify_payouts),
    (select max(payout_date)::text from public.shopify_payouts),
    'Deposit register behind Accounting Export.'),
  (5,'Inventory','inventory_on_hand',
    (select count(*) from public.inventory_on_hand),
    (select min(snapshot_at)::date::text from public.inventory_on_hand),
    (select max(snapshot_at)::date::text from public.inventory_on_hand),
    'Nightly snapshot per SKU per location. No history before the first snapshot -- you cannot ask what stock was last year.'),
  (6,'Catalog','products_master',
    (select count(*) from public.products_master), null,
    (select max(updated_at)::date::text from public.products_master),
    'Variant-grained, one row per SKU. product_title IS the product identity -- there is no product-level id. Only Shopify-active products stay refreshed.'),
  (7,'Marketing','marketing_kpis_daily / meta_ads',
    (select count(*) from public.marketing_kpis_daily where platform='meta_ads'),
    (select min(day_date)::text from public.marketing_kpis_daily where platform='meta_ads'),
    (select max(day_date)::text from public.marketing_kpis_daily where platform='meta_ads'),
    'Campaign level. Spend and conversion_value are DOLLARS, not cents.'),
  (8,'Marketing','marketing_kpis_daily / google_ads',
    (select count(*) from public.marketing_kpis_daily where platform='google_ads'),
    (select min(day_date)::text from public.marketing_kpis_daily where platform='google_ads'),
    (select max(day_date)::text from public.marketing_kpis_daily where platform='google_ads'),
    'Campaign level only. NO ad-group or ad-level depth.'),
  (9,'Marketing','marketing_kpis_daily / ga4',
    (select count(*) from public.marketing_kpis_daily where platform='ga4'),
    (select min(day_date)::text from public.marketing_kpis_daily where platform='ga4'),
    (select max(day_date)::text from public.marketing_kpis_daily where platform='ga4'),
    'Sessions and site revenue. Its conversions column counts GA4 KEY EVENTS, not orders -- never feed it into a CPA.'),
  (10,'Marketing','marketing_kpis_daily / tiktok_ads',
    (select count(*) from public.marketing_kpis_daily where platform='tiktok_ads'), null, null,
    'NEVER SYNCED. TikTok appears in the platform vocabulary and has zero rows.'),
  (11,'Marketing','meta_ad_performance_daily',
    (select count(*) from public.meta_ad_performance_daily),
    (select min(day_date)::text from public.meta_ad_performance_daily),
    (select max(day_date)::text from public.meta_ad_performance_daily),
    'Ad and ad-set level, Meta only. History is far shorter than campaign level -- check the first date before any year-over-year.'),
  (12,'Marketing','facebook_page_insights_daily',
    (select count(*) from public.facebook_page_insights_daily), null, null,
    'EMPTY. Blocked on Meta, not on us: token needs pages_read_engagement / instagram_basic / instagram_manage_insights, the System User needs Page admin or analyst, then set facebook_page_id on the Meta connection.'),
  (13,'Marketing','instagram_media_insights',
    (select count(*) from public.instagram_media_insights), null, null,
    'EMPTY. Same Meta permission blocker, plus instagram_business_account_id on the connection.'),
  (14,'Returns','redo_returns',
    (select count(*) from public.redo_returns),
    (select min(redo_created_at)::date::text from public.redo_returns),
    (select max(redo_created_at)::date::text from public.redo_returns),
    'Covers only part of Shopify refund volume. Do NOT read as all returns -- this is why returns-overview is out of the nav.'),
  (15,'Planning','launch_calendar',
    (select count(*) from public.launch_calendar),
    (select min(launch_date)::text from public.launch_calendar),
    (select max(launch_date)::text from public.launch_calendar),
    'Mostly FORWARD-looking -- a planning calendar, not a history. Nothing before 2026-05, so ad history predates it by nine months.'),
  (16,'Planning','launch_product_readiness',
    (select count(*) from public.launch_product_readiness), null, null,
    'Products attached to launches. This is the ONLY thing that makes a launch measurable -- see launch_measurability_v for which ones are.'),
  (17,'Purchasing','po_headers',
    (select count(*) from public.po_headers),
    (select min(order_date)::text from public.po_headers),
    (select max(order_date)::text from public.po_headers), null),
  (18,'Purchasing','product_concepts',
    (select count(*) from public.product_concepts),
    (select min(created_at)::date::text from public.product_concepts),
    (select max(created_at)::date::text from public.product_concepts),
    'Structured brief fields (economics, forecast, unknowns, provenance) only exist on concepts created since 2026-08-25. Older ones are core fields only.')
)
select
  area,
  source,
  case when rows = 0 then 'EMPTY' else to_char(rows, 'FM999,999,999') end as rows,
  coalesce(first_at, '-') as first_date,
  coalesce(last_at,  '-') as last_date,
  coalesce(note, '')      as note
from src
order by ord;

-- Freshness: did last night actually run?
select job_type, status,
       started_at::date  as ran_on,
       round(extract(epoch from (finished_at - started_at)))::text || 's' as took,
       left(coalesce(error_message, ''), 80) as error
from public.sync_jobs
where started_at >= current_date - interval '3 days'
order by started_at desc;
