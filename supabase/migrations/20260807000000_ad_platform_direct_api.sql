-- Direct-API migration, phase 1: replace the Supermetrics middleman with
-- per-platform connections straight to Google Ads, Meta Ads, TikTok Ads, and
-- GA4. Supermetrics never went live (SUPERMETRICS_API_KEY was never set as a
-- repo secret, so supermetrics_connections/marketing_kpis_daily hold zero
-- rows) — safe to drop and replace rather than migrate data.
--
-- ad_platform_connections replaces supermetrics_connections. Auth shape
-- differs per platform, so this table is a superset of columns, only some of
-- which apply to a given platform row:
--   google_ads / ga4 — OAuth (shared Google Cloud OAuth client; scope alone
--     differentiates the two). access_token/refresh_token/token_expires_at
--     hold the OAuth grant. google_customer_id (Ads) or ga4_property_id
--     (GA4) selects the account to sync; google_login_customer_id is the
--     optional MCC id header for Ads.
--   meta_ads — static long-lived System User token (Meta's recommended
--     server-to-server credential — never expires, unlike OAuth user
--     tokens). Pasted directly into access_token, same trust model as
--     shopify_connections.access_token. meta_ad_account_id holds "act_...".
--   tiktok_ads — OAuth (TikTok for Business Developer app). access_token
--     (24h) + refresh_token (365d, rotates on use) + token_expires_at.
--     tiktok_advertiser_id selects the account.
-- Only the sync (service role) and OAuth callback edge functions write
-- access_token/refresh_token; the client never sees them (select policy
-- below still exposes the columns to the owning company's admins, matching
-- shopify_connections — there is no lower-privilege read role today).

create table if not exists public.ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  platform text not null check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'ga4')),
  display_name text,
  is_active boolean not null default true,
  sync_enabled boolean not null default false,
  days_back integer not null default 30,

  access_token text,
  refresh_token text,
  token_expires_at timestamptz,

  google_customer_id text,
  google_login_customer_id text,
  ga4_property_id text,
  meta_ad_account_id text,
  tiktok_advertiser_id text,

  last_tested_at timestamptz,
  last_test_status text,
  last_test_success boolean,
  last_test_error text,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

-- No uniqueness constraint on (company, platform, account): the OAuth
-- callback inserts a fresh row per "Connect" click (account id is filled in
-- afterward by the admin, once, via the Integrations UI), and a company may
-- legitimately run more than one account per platform. Stale/duplicate rows
-- are an admin cleanup (Remove button), not a DB-level conflict.
create index if not exists idx_ad_platform_connections_company_platform
  on public.ad_platform_connections (company_entity_id, platform);

-- Temporary state table for the Google/TikTok OAuth CSRF handshake. Rows are
-- single-use and expire after 10 minutes (same pattern as
-- shopify_oauth_states). `platform` disambiguates google_ads vs ga4 (shared
-- Google OAuth client, different scope) and selects the TikTok vs Google
-- branch in the callback.
create table if not exists public.ad_platform_oauth_states (
  nonce             text primary key,
  company_entity_id uuid not null references public.entities(id),
  user_id           uuid not null references auth.users(id),
  platform          text not null check (platform in ('google_ads', 'ga4', 'tiktok_ads')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes')
);

alter table public.ad_platform_oauth_states enable row level security;
-- Only service role can read/write (callback uses service role key) —
-- no anon or authenticated policies needed, matching shopify_oauth_states.

alter table public.ad_platform_connections enable row level security;

drop policy if exists ad_platform_connections_active_select on public.ad_platform_connections;
create policy ad_platform_connections_active_select
  on public.ad_platform_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists ad_platform_connections_admin_write on public.ad_platform_connections;
create policy ad_platform_connections_admin_write
  on public.ad_platform_connections for all
  to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

drop trigger if exists stamp_created_by on public.ad_platform_connections;
create trigger stamp_created_by
  before insert on public.ad_platform_connections
  for each row execute function public.stamp_created_by();

-- marketing_kpis_daily now points at ad_platform_connections. Table itself
-- (created by the never-launched 20260716000000_supermetrics_kpis.sql, zero
-- rows) is kept — only its connection FK and default source change.
alter table public.marketing_kpis_daily
  drop constraint if exists marketing_kpis_daily_connection_id_fkey;
alter table public.marketing_kpis_daily
  add constraint marketing_kpis_daily_connection_id_fkey
  foreign key (connection_id) references public.ad_platform_connections(id) on delete set null;
alter table public.marketing_kpis_daily
  alter column source drop default;
alter table public.marketing_kpis_daily
  alter column source set default 'google_ads_api';

drop table if exists public.supermetrics_connections cascade;

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in (
    'test_connection', 'history_import', 'incremental_sales',
    'inventory_snapshot', 'catalog_sync', 'payouts_sync', 'draft_orders_sync',
    'google_ads_kpis', 'meta_ads_kpis', 'tiktok_ads_kpis', 'ga4_kpis'
  ));
