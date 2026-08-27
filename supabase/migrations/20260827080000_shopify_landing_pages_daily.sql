-- Landing-page sessions per day, from ShopifyQL.
--
-- Replaces a manual table on the WoW report: ShopifyQL exposes
-- `GROUP BY landing_page_path` with the full session funnel, so this never
-- needed typing in.
--
-- Stored as top-N per day, not the full tail. ShopifyQL truncates a result
-- set at 1000 rows with no error, and a busy store has more distinct landing
-- paths per day than that, so a wide ungrouped query would silently clip.
-- rank_in_day and is_truncated record that this is a top slice rather than
-- everything, so nobody sums it and calls it total sessions --
-- shopify_sessions_daily is the source for that.
create table if not exists public.shopify_landing_pages_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  shop_domain text not null,
  day_date date not null,
  landing_page_path text not null,
  rank_in_day int,
  sessions bigint,
  sessions_with_cart_additions bigint,
  sessions_that_reached_checkout bigint,
  sessions_that_completed_checkout bigint,
  is_truncated boolean not null default false,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  unique (company_entity_id, shop_domain, day_date, landing_page_path)
);

create index if not exists shopify_landing_pages_daily_day_idx
  on public.shopify_landing_pages_daily (company_entity_id, day_date desc);

alter table public.shopify_landing_pages_daily enable row level security;

drop policy if exists shopify_landing_pages_daily_select on public.shopify_landing_pages_daily;
create policy shopify_landing_pages_daily_select on public.shopify_landing_pages_daily
  for select using (company_entity_id = public.active_company_id());

-- Writes are service-role only (the sync); no client insert/update/delete
-- policy, same stance as the other sync-owned tables.

-- Extend the job_type CHECK. Read the constraint's current definition before
-- editing it -- a hand-written list dropped four existing values on the first
-- attempt here and Postgres refused to apply it.
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection','history_import','incremental_sales','inventory_snapshot',
    'catalog_sync','payouts_sync','draft_orders_sync','google_ads_kpis',
    'meta_ads_kpis','tiktok_ads_kpis','ga4_kpis','orders_backfill',
    'sessions_sync','landing_pages_sync'
  ]));
