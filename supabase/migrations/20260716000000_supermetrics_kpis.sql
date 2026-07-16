-- Supermetrics integration, phase 1: marketing KPI ingestion.
--
-- Supermetrics is the connector layer for ad/analytics platforms already in
-- use at Baseballism (Google Ads, Meta Ads, TikTok Ads, GA4). A nightly
-- GitHub Action (supermetrics-sync.yml → scripts/supermetrics-sync.mjs)
-- queries the Supermetrics API and lands daily campaign-level KPI rows here,
-- next to sales_by_day, so marketing spend can later be blended with actual
-- online-store revenue (MER / blended ROAS) instead of trusting
-- platform-attributed conversions.
--
-- Mirrors the shopify_connections / sales_by_day architecture:
--   supermetrics_connections — per-company sync config + state (meta jsonb).
--     The API key itself is NOT stored here; it lives in the GitHub Actions
--     secret SUPERMETRICS_API_KEY. `sources` holds per-platform query config
--     (ds_id, accounts, field mapping) so connector codes are data, not code.
--   marketing_kpis_daily — one row per company × platform × account ×
--     campaign × day, upserted on row_hash (identity hash, metrics excluded,
--     so nightly re-pulls of the trailing window update restated metrics
--     in place — ad platforms restate conversions for days after the fact).

create table if not exists public.supermetrics_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  display_name text,
  is_active boolean not null default true,
  sync_enabled boolean not null default false,
  days_back integer not null default 30,
  sources jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.marketing_kpis_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.supermetrics_connections(id) on delete set null,
  platform text not null check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4')),
  ds_id text not null,
  account_id text,
  account_name text,
  day_date date not null,
  campaign_id text,
  campaign_name text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14,2) not null default 0,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  sessions bigint,
  extra jsonb not null default '{}'::jsonb,
  row_hash text not null unique,
  source text not null default 'supermetrics',
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create index if not exists idx_marketing_kpis_daily_co_day
  on public.marketing_kpis_daily (company_entity_id, day_date);
create index if not exists idx_marketing_kpis_daily_co_platform_day
  on public.marketing_kpis_daily (company_entity_id, platform, day_date);

-- RLS: reads scoped to the caller's active company (same as sales_by_day);
-- no client-side write policies — only the service-role sync writes.
alter table public.supermetrics_connections enable row level security;
alter table public.marketing_kpis_daily enable row level security;

drop policy if exists supermetrics_connections_active_select on public.supermetrics_connections;
create policy supermetrics_connections_active_select
  on public.supermetrics_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists marketing_kpis_daily_active_select on public.marketing_kpis_daily;
create policy marketing_kpis_daily_active_select
  on public.marketing_kpis_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- Attribution stamp, same as shopify_connections.
drop trigger if exists stamp_created_by on public.supermetrics_connections;
create trigger stamp_created_by
  before insert on public.supermetrics_connections
  for each row execute function public.stamp_created_by();

-- Let the sync log its runs in the shared sync_jobs table.
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync',
    'supermetrics_kpis'
  ));
