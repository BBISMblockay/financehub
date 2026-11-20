-- Amazon Ads: the CONNECTION only. No new metric tables, by design.
--
-- Amazon Ads is the fourth ad platform, and it is the fourth to land in
-- `marketing_kpis_daily` beside Google, Meta and TikTok -- so this migration
-- adds no table. `marketing_kpis_daily.platform` has been a name-shape CHECK
-- since 20261103080000 ('^[a-z][a-z0-9_]{1,63}$'), which 'amazon_ads'
-- satisfies, so the KPI table needs nothing at all. What actually blocked
-- reusing the existing plumbing is the three CHECKs and the two account
-- columns below.
--
-- WHAT AMAZON NEEDS THAT NO OTHER AD PLATFORM DOES: a REGION. Amazon Ads has
-- three independent hosts (advertising-api.amazon.com for North America,
-- advertising-api-eu.amazon.com, advertising-api-fe.amazon.com), the
-- Login-with-Amazon token endpoint is regional to match, and a profile exists
-- in exactly ONE of them. A profile id alone is not enough to make a request,
-- which is why `amazon_region` is a column of its own rather than a key in
-- `meta`: the nightly sync reads it on every call, and a missing region is a
-- connection that cannot sync rather than a cosmetic gap.
--
-- Read live before writing (pg_get_constraintdef, 2026-11-20) -- the lists are
-- re-typed, not appended to, so dropping a value while extending them is the
-- real risk, and verify_v2_schema.sql asserts each existing value separately:
--   ad_platform_connections_platform_check:
--     CHECK (platform = ANY (ARRAY['google_ads','meta_ads','tiktok_ads','ga4','search_console']))
--   ad_platform_oauth_states_platform_check:
--     CHECK (platform = ANY (ARRAY['google_ads','ga4','tiktok_ads','search_console','meta_ads']))

alter table public.ad_platform_connections
  drop constraint if exists ad_platform_connections_platform_check;
alter table public.ad_platform_connections
  add constraint ad_platform_connections_platform_check
  check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4', 'search_console', 'amazon_ads'));

alter table public.ad_platform_oauth_states
  drop constraint if exists ad_platform_oauth_states_platform_check;
alter table public.ad_platform_oauth_states
  add constraint ad_platform_oauth_states_platform_check
  check (platform in ('google_ads', 'ga4', 'tiktok_ads', 'search_console', 'meta_ads', 'amazon_ads'));

-- The account selector, alongside google_customer_id / ga4_property_id /
-- meta_ad_account_id / tiktok_advertiser_id / search_console_site_url. Amazon
-- calls it a PROFILE: one advertiser account in one marketplace, and the value
-- travels in the Amazon-Advertising-API-Scope header on every call. It is
-- stored as text, not a bigint, for the same reason every other account id
-- here is: it is an opaque identifier SILO echoes back, never arithmetic.
alter table public.ad_platform_connections
  add column if not exists amazon_profile_id text;

-- Which of Amazon's three regional endpoints that profile lives behind. The
-- CHECK allows NULL because the OAuth callback inserts the row before the
-- profile is chosen -- the same two-step every ad platform here follows -- and
-- because an unset region is a connection awaiting configuration, which the
-- health pass already reports, rather than a row the database should refuse.
alter table public.ad_platform_connections
  add column if not exists amazon_region text;
alter table public.ad_platform_connections
  drop constraint if exists ad_platform_connections_amazon_region_check;
alter table public.ad_platform_connections
  add constraint ad_platform_connections_amazon_region_check
  check (amazon_region is null or amazon_region in ('NA', 'EU', 'FE'));

comment on column public.ad_platform_connections.amazon_profile_id is
  'Amazon Ads profile id: one advertiser account in one marketplace. Sent in the Amazon-Advertising-API-Scope header on every Ads API call. Chosen by the Integrations account picker after OAuth, which is also what switches sync_enabled on.';
comment on column public.ad_platform_connections.amazon_region is
  'NA | EU | FE -- which Amazon Ads regional host serves this profile (advertising-api{,-eu,-fe}.amazon.com), and which Login-with-Amazon host refreshes its token. A profile exists in exactly one region; the wrong one 401s.';

-- The nightly's sync_jobs row for this platform. job_type is a CHECK list, so
-- it is extended the way 20261110180000 extended it: read the LIVE definition,
-- keep every member, add one. Re-typing the list by hand is how a value gets
-- silently dropped, and a dropped value only fails at the next write.
do $$
declare
  cur text;
  members text;
begin
  select pg_get_constraintdef(oid) into cur
    from pg_constraint
   where conname = 'sync_jobs_job_type_check' and conrelid = 'public.sync_jobs'::regclass;
  if cur is null then
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding amazon_ads_kpis';
  end if;
  if cur ~ '''amazon_ads_kpis''' then
    return;
  end if;
  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;
  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'amazon_ads_kpis'
  );
end $$;

-- ── integration_bootstrap_jobs.integration: append 'amazon_ads' ─────────────
-- The first-sync queue refuses an integration it does not know, deliberately:
-- an unknown value must fail at enqueue rather than sit in the queue as a row
-- no drainer claims. Amazon now has a plan (BOOTSTRAP_PLANS in
-- scripts/lib/integration-bootstrap-core.mjs) and the account picker enqueues
-- against it, so it belongs in the list. Without this the picker's "choose the
-- profile" step saves the profile and then fails to queue the first import,
-- which would leave a connection that tests fine and syncs nothing until the
-- nightly. Read live and idempotent, the same way 20261109040000 appended
-- 'klaviyo'.
do $$
declare
  cname text;
  cur text;
  members text;
begin
  select conname, pg_get_constraintdef(oid) into cname, cur
  from pg_constraint
  where conrelid = 'public.integration_bootstrap_jobs'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%integration%'
    and pg_get_constraintdef(oid) like '%shopify%'
  limit 1;

  if cname is null then
    raise exception 'no integration CHECK found on integration_bootstrap_jobs; read the live constraint before adding amazon_ads';
  end if;

  if cur ~ '''amazon_ads''' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'the integration CHECK has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute format('alter table public.integration_bootstrap_jobs drop constraint %I', cname);
  execute format(
    'alter table public.integration_bootstrap_jobs add constraint %I check (integration = any (array[%s, %L::text]))',
    cname, members, 'amazon_ads'
  );
end $$;

-- New columns on a public table: refresh Ask SILO's map.
select public.refresh_chat_schema_catalog();
