-- Meta Ads gets an OAuth pair (Facebook Login for Business). ADDITIVE: the
-- pasted System User token path is unchanged; this only lets the new
-- meta-oauth-start / meta-oauth-callback functions record their CSRF state.
--
-- Verified before writing (pg_get_constraintdef, 2026-10-07):
--   CHECK (platform = ANY (ARRAY['google_ads','ga4','tiktok_ads','search_console']))
-- Re-typing a constraint list is how a value gets silently dropped: read the
-- live definition first if you extend it again.
alter table public.ad_platform_oauth_states
  drop constraint if exists ad_platform_oauth_states_platform_check;
alter table public.ad_platform_oauth_states
  add constraint ad_platform_oauth_states_platform_check
  check (platform in ('google_ads', 'ga4', 'tiktok_ads', 'search_console', 'meta_ads'));
