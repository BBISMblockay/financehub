-- Organic Instagram + Facebook Page insights — separate from the paid ad
-- tables (marketing_kpis_daily / meta_ad_performance_daily) because organic
-- content has no spend/conversion-value concept; the shape here is
-- posts/reels + reach/engagement, not campaigns + attribution.
--
-- Reuses the existing meta_ads connection's access_token — Instagram/Page
-- insights ride the same Meta App and (once granted) the same System User
-- token, just with additional scopes (pages_read_engagement, instagram_basic,
-- instagram_manage_insights) and the System User assigned as an admin/
-- analyst on the Page in Business Manager. No new OAuth flow needed.
--
--   instagram_media_insights   — one row per post/reel, refreshed nightly
--     (lifetime snapshot, not a daily time series — that's how Meta's own
--     media-level insights work: cumulative counters, not day-bucketed).
--     Metric name is `views` (Meta deprecated `impressions` on IG media
--     insights in 2024, unified across photo/video/reel as `views`).
--   facebook_page_insights_daily — page-level daily rollup (impressions,
--     reach, engaged users, follower delta) — genuinely a daily series,
--     unlike media insights.

alter table public.ad_platform_connections
  add column if not exists facebook_page_id text,
  add column if not exists instagram_business_account_id text;

create table if not exists public.instagram_media_insights (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  media_id text not null,
  media_type text,
  caption text,
  permalink text,
  thumbnail_url text,
  posted_at timestamptz,
  views bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saved bigint,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, media_id)
);

create index if not exists idx_ig_media_insights_co_posted
  on public.instagram_media_insights (company_entity_id, posted_at desc);

create table if not exists public.facebook_page_insights_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  day_date date not null,
  page_impressions bigint,
  page_reach bigint,
  page_engaged_users bigint,
  page_post_engagements bigint,
  page_fan_count bigint,
  row_hash text not null unique,
  synced_at timestamptz not null default now()
);

create index if not exists idx_fb_page_insights_co_day
  on public.facebook_page_insights_daily (company_entity_id, day_date);

alter table public.instagram_media_insights enable row level security;
alter table public.facebook_page_insights_daily enable row level security;

drop policy if exists instagram_media_insights_active_select on public.instagram_media_insights;
create policy instagram_media_insights_active_select
  on public.instagram_media_insights for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists facebook_page_insights_daily_active_select on public.facebook_page_insights_daily;
create policy facebook_page_insights_daily_active_select
  on public.facebook_page_insights_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());
