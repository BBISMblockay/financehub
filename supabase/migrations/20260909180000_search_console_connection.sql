-- Search Console: the CONNECTION only. No metric tables yet, on purpose.
--
-- The SEO audit's gating dependency is Google Search Console -- it is the only
-- source that can say which QUERIES bring people to the site. Everything SILO
-- holds today stops at GA4's Organic Search channel total, which is a session
-- count with no query behind it (see the SEO paragraph in silo-chat's prompt).
--
-- What this migration does NOT do is create search_console_*_daily tables,
-- and that is deliberate. The grain of those tables depends on facts nobody
-- here has measured yet: how far behind "today" the API's newest complete day
-- is, how far back history actually reaches, how many rows come back per
-- request, and -- the one that decides whether a negative claim is ever safe
-- -- what share of clicks Search Console will attribute to a query at all.
-- Search Console withholds rare queries for privacy, so the sum of per-query
-- clicks is STRUCTURALLY less than the day's total clicks, by an amount that
-- is a property of this site's traffic and cannot be recalled or assumed.
-- That is the same shape as shopify_landing_pages_daily's top-250 cap, and
-- getting it wrong the same way would be worse, because a query table looks
-- complete.
--
-- scripts/search-console-probe.mjs measures all five against the live account
-- and prints them. The schema lands after that, built to what was measured.
--
-- So this is the connection plumbing only: the OAuth path already exists and
-- is already scope-parameterised by platform (google-oauth-start's SCOPES
-- map), tokens already live on ad_platform_connections, and the callback
-- already handles the missing-refresh-token case. The one thing that actually
-- blocked reusing all of it was the platform CHECK below.

-- Verified before writing (pg_get_constraintdef, 2026-09-09):
--   CHECK (platform = ANY (ARRAY['google_ads','meta_ads','tiktok_ads','ga4']))
-- Re-typing a constraint list is how a value gets silently dropped, so if you
-- extend this again, read the live definition first rather than trusting the
-- list here to still be current.
alter table public.ad_platform_connections
  drop constraint if exists ad_platform_connections_platform_check;
alter table public.ad_platform_connections
  add constraint ad_platform_connections_platform_check
  check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4', 'search_console'));

-- Same for the OAuth CSRF state table, whose own list was narrower already
-- (meta_ads has no OAuth pair -- its token is pasted in).
--   CHECK (platform = ANY (ARRAY['google_ads','ga4','tiktok_ads']))
alter table public.ad_platform_oauth_states
  drop constraint if exists ad_platform_oauth_states_platform_check;
alter table public.ad_platform_oauth_states
  add constraint ad_platform_oauth_states_platform_check
  check (platform in ('google_ads', 'ga4', 'tiktok_ads', 'search_console'));

-- The account selector for a Search Console connection, alongside
-- google_customer_id / ga4_property_id / meta_ad_account_id / etc. It holds
-- Search Console's own site identifier, and the TWO FORMS ARE NOT
-- INTERCHANGEABLE: a URL-prefix property is 'https://www.baseballism.com/'
-- (trailing slash significant, and it covers only that scheme+host+path),
-- while a domain property is 'sc-domain:baseballism.com' (covers every
-- subdomain and both schemes). They report different traffic, so this stores
-- whatever the sites.list call returned verbatim rather than a normalised
-- host -- normalising it would silently change which property is queried.
alter table public.ad_platform_connections
  add column if not exists search_console_site_url text;

comment on column public.ad_platform_connections.search_console_site_url is
  'Search Console property identifier, exactly as returned by sites.list: '
  'either a URL prefix ("https://www.baseballism.com/") or a domain property '
  '("sc-domain:baseballism.com"). The two cover different traffic; do not '
  'normalise between them.';

-- A search_console row does not feed marketing_kpis_daily and has no
-- job_type in scripts/ad-platforms-sync.mjs, which skips it by name. No
-- sync_jobs CHECK change is needed until the ingestion job exists.

select public.refresh_chat_schema_catalog();
