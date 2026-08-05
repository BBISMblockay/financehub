-- ============================================================
-- 20260805040000_default_page_bootstrap_profile.sql
--
-- profiles.default_page ("Default page" on /v2/profile.html) was never
-- actually honored at login until 20260805030000's login.html fix landed,
-- so every existing value was set by a user with no real-world effect.
-- Bootstrap everyone to /v2/profile.html for now -- a safe, neutral
-- landing spot -- until each person picks their own via the Profile UI.
-- One-time data backfill, not a schema change; safe to re-run.
-- ============================================================

update public.profiles
   set default_page = '/v2/profile.html',
       updated_at = now()
 where default_page is distinct from '/v2/profile.html';
