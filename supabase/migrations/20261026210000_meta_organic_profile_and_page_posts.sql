-- Instagram account profile + account-level insights, and Facebook Page posts.
--
-- Why these three tables exist: SILO's organic Meta reporting has only ever
-- held MEDIA-level Instagram rows (instagram_media_insights) and Page-level
-- DAILY rows (facebook_page_insights_daily). Three things it never read:
--   * the Instagram account itself -- @handle, name, bio, follower and post
--     counts. Reporting showed posts with no account they belong to.
--   * Instagram ACCOUNT-level insights. Media insights are per post; account
--     reach is a different measurement and cannot be summed from them
--     (the same person reached by two posts is one account-level reach).
--   * the Page's own published posts. The follower count and the daily
--     insight series said how the Page performed, never what it posted.
--
-- Meta's App Review (2026-10-26) rejected instagram_basic,
-- instagram_manage_insights and pages_read_engagement for exactly these gaps:
-- the reviewer could not see profile fields, account-level insights, or Page
-- content on screen. These tables are what the product stores so that the
-- screencast shows real reporting rather than a verification-only surface.
--
-- Shapes deliberately mirror what is already here, so the reporting pages read
-- them the same way:
--   instagram_account_profile       -- one CURRENT row per IG account, like a
--     snapshot; no history, because a follower count has no honest backfill
--     (the same reason facebook_page_insights_daily.page_fan_count is stamped
--     only on the day it was read).
--   instagram_account_insights_daily -- a genuine daily series, same shape as
--     facebook_page_insights_daily, with row_hash as the upsert key.
--   facebook_page_posts             -- one row per post, same shape as
--     instagram_media_insights: a lifetime snapshot of cumulative counters,
--     not a day-bucketed series.

-- ── Instagram account profile ───────────────────────────────────────────────
-- The window columns hold Meta's total_value metrics, which are a TOTAL over a
-- window rather than a per-day number, so the window they cover is stored with
-- them. Reporting that shows "views" without the window it totals is wrong by
-- however wide the window happens to be.
create table if not exists public.instagram_account_profile (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  ig_user_id text not null,
  username text,
  name text,
  biography text,
  followers_count bigint,
  media_count bigint,
  views_window bigint,
  accounts_engaged_window bigint,
  total_interactions_window bigint,
  window_start date,
  window_end date,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, ig_user_id)
);

-- ── Instagram account-level daily insights ──────────────────────────────────
-- `reach` is the only account metric Meta still serves as a time series
-- (period=day, metric_type=time_series). Everything else on that edge is
-- total_value only, which is why it lives on the profile row above and not
-- here: a window total written into a daily table would read as a daily value.
create table if not exists public.instagram_account_insights_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  day_date date not null,
  reach bigint,
  row_hash text not null unique,
  synced_at timestamptz not null default now()
);

create index if not exists idx_ig_account_insights_co_day
  on public.instagram_account_insights_daily (company_entity_id, day_date);

-- ── Facebook Page posts ─────────────────────────────────────────────────────
-- From /{page}/published_posts with a Page access token: the Page's OWN posts.
-- Not /{page}/feed, which also returns posts by visitors and needs
-- pages_read_user_content -- a permission SILO neither has nor wants.
create table if not exists public.facebook_page_posts (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  post_id text not null,
  page_id text,
  message text,
  permalink text,
  full_picture text,
  posted_at timestamptz,
  likes bigint,
  comments bigint,
  shares bigint,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, post_id)
);

create index if not exists idx_fb_page_posts_co_posted
  on public.facebook_page_posts (company_entity_id, posted_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read-only to the tenant, exactly like instagram_media_insights and
-- facebook_page_insights_daily: the syncs write as the service role.
alter table public.instagram_account_profile enable row level security;
alter table public.instagram_account_insights_daily enable row level security;
alter table public.facebook_page_posts enable row level security;

drop policy if exists instagram_account_profile_active_select on public.instagram_account_profile;
create policy instagram_account_profile_active_select
  on public.instagram_account_profile for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists instagram_account_insights_daily_active_select on public.instagram_account_insights_daily;
create policy instagram_account_insights_daily_active_select
  on public.instagram_account_insights_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists facebook_page_posts_active_select on public.facebook_page_posts;
create policy facebook_page_posts_active_select
  on public.facebook_page_posts for select
  to authenticated
  using (company_entity_id = public.active_company_id());

select public.attach_stamp_company_entity_id_triggers();
