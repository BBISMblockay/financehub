-- Thruplays and leads on marketing_kpis_daily.
--
-- These are the denominators Meta's non-purchase objectives are actually
-- judged on -- cost per thruplay for upper-funnel video, cost per lead for
-- subscriber buys -- and until now they were the one part of the weekly
-- report still hand-copied out of Ads Manager.
--
-- Leads needed no new Meta API field at all: `lead` is an action_type inside
-- the actions[] array the sync already fetches and already parses for
-- view_content / add_to_cart / initiate_checkout. It was simply never
-- extracted. Thruplays come from video_thruplay_watched_actions, which is one
-- added field on the insights request.
--
-- Nullable on purpose, and distinct from 0: null means "this platform or
-- objective does not report the metric", 0 means "reported, and it was zero".
-- Google rows stay null. Collapsing the two would make an unreported metric
-- look like a failed campaign -- the same misread that split this report in
-- the first place.
alter table public.marketing_kpis_daily
  add column if not exists thruplays bigint,
  add column if not exists leads bigint;

comment on column public.marketing_kpis_daily.thruplays is
  'Meta video thruplays (video_thruplay_watched_actions). Null = not reported by this platform, 0 = reported as zero.';
comment on column public.marketing_kpis_daily.leads is
  'Meta leads (actions[] action_type lead / onsite_conversion.lead_grouped). Null = not reported, 0 = reported as zero.';
