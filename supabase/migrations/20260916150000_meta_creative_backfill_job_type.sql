-- Meta creative destination backfill: a new sync_jobs.job_type.
--
-- scripts/meta-creative-backfill.mjs fills in destinations for ads the
-- nightly never asks about. The nightly (runMetaAdLevelSync) requests
-- creatives ONLY for ad ids with insights rows in its trailing window
-- (days_back ?? 30) -- correct for a nightly, and the reason coverage looked
-- thin: measured 2026-09-16, 126 of 4,079 stored creatives had ever been
-- asked about and $5,304,686 of SHARE spend sat on ads never requested.
--
-- It gets its own job_type rather than reusing 'meta_ads_kpis' because the
-- two answer different questions of the same table. A run of this writes no
-- performance rows at all, so folding it into the KPI job type would make
-- "did the nightly run" unanswerable from sync_jobs -- the exact confusion
-- 'search_console_daily' was split out to avoid.
--
-- Idempotent: drops and recreates the CHECK with the value added.

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;

alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis',
    'orders_backfill', 'sessions_sync', 'landing_pages_sync',
    'discount_codes_sync', 'collections_sync', 'search_console_daily',
    'meta_creative_backfill'
  ]));
