-- Allow 'orders_backfill' in sync_jobs.job_type.
--
-- The nightly incremental sync only writes shopify_orders /
-- shopify_order_lines for orders touched in its ~2-day window, so history
-- before each store's first post-20260817210000 sync doesn't exist in
-- those tables. scripts/shopify-orders-backfill.mjs (manual GHA:
-- shopify-orders-backfill.yml) walks the same history windows the sales
-- history import uses but writes ONLY order facts -- no sales_by_day
-- involvement -- and logs its runs under this job type.

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis',
    'orders_backfill'
  ));
