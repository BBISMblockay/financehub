-- Meta ad-level performance + creative metadata.
--
-- marketing_kpis_daily stays at CAMPAIGN grain (one row per campaign per
-- day); ad-level data would explode that table and change its identity, so
-- it gets its own pair:
--   meta_ad_performance_daily — one row per ad per day (spend, impressions,
--     clicks, purchases, purchase value), upserted on identity row_hash
--     (company × account × ad × day; metrics excluded so Meta's restated
--     numbers update in place, same convention as marketing_kpis_daily).
--   meta_ad_creatives — one row per ad: creative metadata (thumbnail, copy,
--     format, status), refreshed on every sync. Joining the two gives the
--     creative report: thumbnail next to its numbers.
--
-- Written by the nightly ad-platforms sync (service role); read-only to
-- clients, scoped to the active company like every marketing table.

create table if not exists public.meta_ad_performance_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  account_id text,
  day_date date not null,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text not null,
  ad_name text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14,2) not null default 0,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  row_hash text not null unique,
  source text not null default 'meta_ads_api',
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create index if not exists idx_meta_ad_perf_co_day
  on public.meta_ad_performance_daily (company_entity_id, day_date);
create index if not exists idx_meta_ad_perf_co_ad_day
  on public.meta_ad_performance_daily (company_entity_id, ad_id, day_date);

create table if not exists public.meta_ad_creatives (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  ad_id text not null,
  account_id text,
  ad_name text,
  campaign_id text,
  adset_id text,
  effective_status text,
  creative_id text,
  thumbnail_url text,
  body text,
  title text,
  object_type text,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, ad_id)
);

alter table public.meta_ad_performance_daily enable row level security;
alter table public.meta_ad_creatives enable row level security;

drop policy if exists meta_ad_performance_daily_active_select on public.meta_ad_performance_daily;
create policy meta_ad_performance_daily_active_select
  on public.meta_ad_performance_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists meta_ad_creatives_active_select on public.meta_ad_creatives;
create policy meta_ad_creatives_active_select
  on public.meta_ad_creatives for select
  to authenticated
  using (company_entity_id = public.active_company_id());
