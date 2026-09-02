-- Thruplays and leads per AD, not just per campaign.
--
-- The Week over Week creative card splits ads by campaign objective, and for
-- Thruplays / Subscribers / Followers it had to fall back to click cost --
-- because meta_ad_performance_daily carried no thruplays or leads column and
-- the ad-level fetch deliberately did not request them. Its comment said so:
-- "the creative table is scoped to purchase campaigns, which are judged on
-- ROAS", which stopped being true when the card grew an objective split.
--
-- What that costs, measured on the week to 2026-08-31 at campaign level:
--
--   Thruplays     $2,142 -> 364,629 thruplays   $0.0059 each
--   Followers       $694 ->  55,851 thruplays   $0.0124
--   Subscribers  $70,478 ->  16,728 leads       $4.21 per lead
--
-- Subscribers is the largest Meta line, and at $4.21 a lead it is working --
-- but with campaign-grain data only, nobody can say WHICH creative produced
-- those 16,728 leads. That is the whole question the creative card exists to
-- answer, and it was unanswerable for three of the four objectives.
--
-- NULLABLE ON PURPOSE, and different from view_content/add_to_cart/
-- initiate_checkout beside them, which default to 0. Every ad can report those.
-- Not every ad reports these: a video buy has no leads and a lead buy has no
-- thruplays, and writing 0 would rank an ad as the worst performer on a metric
-- it was never bought on -- the same error the report already avoids by
-- printing null rather than a confident zero.
--
-- Leads cost no new API field: they come out of the `actions` array the
-- ad-level request already asks for. Thruplays add
-- video_thruplay_watched_actions, which is why the fetch now carries the same
-- drop-and-retry guard campaign level has -- Meta rejects an ENTIRE insights
-- request over one bad field name, so a wrong guess here would take down
-- ad-level spend, not just a column.

alter table public.meta_ad_performance_daily
  add column if not exists thruplays bigint,
  add column if not exists leads     bigint;

comment on column public.meta_ad_performance_daily.thruplays is
  'Thruplays for this ad on this day, from video_thruplay_watched_actions (falling back to an actions[] thruplay entry). NULL means the ad did not report the metric -- never 0, which would read as "watched by nobody" on an ad never bought for video views.';

comment on column public.meta_ad_performance_daily.leads is
  'Leads for this ad on this day, summed across Meta''s lead action types from the actions[] array the ad-level request already fetches. NULL means not reported, not zero.';

-- The creative card reads these through wow_creatives; without an index the
-- objective rollups scan the window for two more columns each time.
create index if not exists meta_ad_perf_co_day_thruplays_idx
  on public.meta_ad_performance_daily (company_entity_id, day_date)
  where thruplays is not null or leads is not null;
