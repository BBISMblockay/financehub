-- Meta custom conversions and custom pixel events, kept instead of discarded.
--
-- The problem. Meta's insights `actions` array carries EVERY event an ad
-- fired, but the sync (scripts/lib/ad-platforms-sync-core.mjs) reads a fixed
-- list of names out of it -- purchase, view_content, add_to_cart,
-- initiate_checkout, thruplays, leads -- and drops the rest. A custom
-- conversion such as Baseballism's "Black Friday 2026 Sign ups" arrives as
-- `offsite_conversion.custom.<numeric id>`, matches none of those names, and
-- is thrown away on every run. Nothing in SILO has ever been able to show it,
-- and the numbers it reports exist nowhere but Ads Manager.
--
-- Why a new table rather than new columns. Custom conversions are defined per
-- advertiser and created at will -- a column per conversion is a migration per
-- marketing idea. This is long-format instead: one row per
-- company x account x object x day x action_type, which costs nothing when an
-- account has none and needs no schema change when the next one is created.
--
-- ADDITIVE BY CONSTRUCTION. This migration adds two tables and one view and
-- alters nothing that exists. marketing_kpis_daily and
-- meta_ad_performance_daily keep every column, every policy and every row they
-- have; the sync writes these tables in their own try/catch, so a failure here
-- -- a missing table before the migration is applied, a permission error, a
-- rejected request -- leaves spend, purchases and ROAS exactly as they are
-- today. The page reads the view through the same unavailable-table guard the
-- rest of marketing-overview.html uses, so it is an empty card until applied.
--
-- Grain and double counting. A row is written at BOTH campaign level and ad
-- level (`level` column), because the two syncs are separate passes over
-- separate insights requests. Summing across levels double counts: every
-- consumer filters to one level. The view does not aggregate for this reason.
--
-- Values. `conversions` is the count Meta reports and `conversion_value` the
-- matching entry from `action_values` (0 when the conversion carries no value,
-- which is the normal case for a sign-up). Both are Meta's own attributed
-- numbers on the account's attribution setting -- credited, not earned, and
-- never to be added to net sales.

create table if not exists public.meta_custom_conversion_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  account_id text,
  day_date date not null,
  -- 'campaign' rows come from the nightly campaign-grain sync, 'ad' rows from
  -- the ad-level creative pass. They cover the same spend; never sum both.
  level text not null check (level in ('campaign', 'ad')),
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text,
  ad_name text,
  -- Meta's raw action_type, kept verbatim: 'offsite_conversion.custom.<id>'
  -- for a custom conversion, 'offsite_conversion.fb_pixel_custom.<event>' for
  -- a custom pixel event. Stored unparsed so a shape we have not seen is
  -- preserved rather than dropped.
  action_type text not null,
  -- The numeric id parsed out of action_type when it is a custom conversion;
  -- null for custom pixel events, which are named by event, not by id.
  custom_conversion_id text,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  row_hash text not null unique,
  source text not null default 'meta_ads_api',
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create index if not exists idx_meta_custom_conv_co_day
  on public.meta_custom_conversion_daily (company_entity_id, day_date);
create index if not exists idx_meta_custom_conv_co_level_day
  on public.meta_custom_conversion_daily (company_entity_id, level, day_date);
create index if not exists idx_meta_custom_conv_co_conv
  on public.meta_custom_conversion_daily (company_entity_id, custom_conversion_id);

-- The id -> name lookup. Meta's insights response carries the id only, so
-- without this the column reads "offsite_conversion.custom.1234567890" to a
-- human and to a bot. Filled from GET /act_<id>/customconversions, which is
-- best effort: a token without ads_read, or a request that fails, leaves the
-- table as it was and the view falls back to the id.
create table if not exists public.meta_custom_conversions (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  custom_conversion_id text not null,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  account_id text,
  name text,
  custom_event_type text,
  is_archived boolean,
  synced_at timestamptz not null default now(),
  primary key (company_entity_id, custom_conversion_id)
);

alter table public.meta_custom_conversion_daily enable row level security;
alter table public.meta_custom_conversions enable row level security;

drop policy if exists meta_custom_conversion_daily_active_select on public.meta_custom_conversion_daily;
create policy meta_custom_conversion_daily_active_select
  on public.meta_custom_conversion_daily for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists meta_custom_conversions_active_select on public.meta_custom_conversions;
create policy meta_custom_conversions_active_select
  on public.meta_custom_conversions for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- No client write policies on either table: only the service-role sync writes,
-- exactly like marketing_kpis_daily and meta_ad_performance_daily.

-- The readable version. security_invoker so RLS on the two tables below is the
-- boundary, and a LEFT join so an unnamed conversion still appears with its id
-- rather than vanishing from the report the moment the name lookup fails.
create or replace view public.meta_custom_conversion_daily_v
with (security_invoker = true) as
select
  -- id is carried so a paging reader has a stable tiebreaker to order on;
  -- every page in v2 pages day_date then id.
  d.id,
  d.company_entity_id,
  d.connection_id,
  d.account_id,
  d.day_date,
  d.level,
  d.campaign_id,
  d.campaign_name,
  d.adset_id,
  d.adset_name,
  d.ad_id,
  d.ad_name,
  d.action_type,
  d.custom_conversion_id,
  coalesce(
    nullif(c.name, ''),
    case
      when d.custom_conversion_id is not null
        then 'Custom conversion ' || d.custom_conversion_id
      else d.action_type
    end
  ) as conversion_name,
  c.custom_event_type,
  coalesce(c.is_archived, false) as is_archived,
  d.conversions,
  d.conversion_value,
  d.source,
  d.synced_at
from public.meta_custom_conversion_daily d
left join public.meta_custom_conversions c
  on c.company_entity_id = d.company_entity_id
 and c.custom_conversion_id = d.custom_conversion_id;

grant select on public.meta_custom_conversion_daily to authenticated;
grant select on public.meta_custom_conversions to authenticated;
grant select on public.meta_custom_conversion_daily_v to authenticated;
revoke all on public.meta_custom_conversion_daily from anon;
revoke all on public.meta_custom_conversions from anon;
revoke all on public.meta_custom_conversion_daily_v from anon;

-- Make the new relations findable by Ask SILO and by MCP bots. Without a
-- description and keywords a relation ranks on its name alone and is close to
-- unfindable over MCP (see 20261103190000_chat_catalog_coverage.sql). Written
-- only where the catalog already has the row -- refresh_chat_schema_catalog()
-- inserts it -- and only where the description is still null, so a human edit
-- is never clobbered and a re-apply is a no-op.
do $$
begin
  if to_regclass('public.silo_chat_schema_catalog') is not null then
    perform public.refresh_chat_schema_catalog();

    update public.silo_chat_schema_catalog
       set description = coalesce(description,
             'Meta custom conversions and custom pixel events per day. '
             || 'One row per account x object x day x action_type; level is '
             || '''campaign'' or ''ad'' and the two levels cover the same spend, '
             || 'so never sum across them. Prefer the view '
             || 'meta_custom_conversion_daily_v, which adds conversion_name. '
             || 'These are Meta''s own credited counts, not SILO sales.'),
           keywords = coalesce(keywords, array[
             'meta', 'facebook', 'custom conversion', 'custom event', 'pixel',
             'sign ups', 'signups', 'ads', 'conversions'])
     where relname = 'meta_custom_conversion_daily';

    update public.silo_chat_schema_catalog
       set description = coalesce(description,
             'Names for Meta custom conversions, keyed by custom_conversion_id. '
             || 'Lookup only, filled best effort from Meta; a missing row means '
             || 'the name could not be read, not that the conversion is gone.'),
           keywords = coalesce(keywords, array[
             'meta', 'facebook', 'custom conversion', 'name', 'lookup', 'ads'])
     where relname = 'meta_custom_conversions';

    update public.silo_chat_schema_catalog
       set description = coalesce(description,
             'Meta custom conversions per day with their names. '
             || 'Use this rather than meta_custom_conversion_daily: it adds '
             || 'conversion_name (falling back to the id when the name is '
             || 'unknown). Filter level to ''campaign'' or ''ad'' -- the two '
             || 'levels cover the same spend and must never be summed together.'),
           keywords = coalesce(keywords, array[
             'meta', 'facebook', 'custom conversion', 'custom event', 'pixel',
             'sign ups', 'signups', 'ads', 'conversions', 'conversion name'])
     where relname = 'meta_custom_conversion_daily_v';

    -- Offer the view in the report builder's source rail (allowlist; a newly
    -- synced relation stays out until opted in, 20260902110000). The raw
    -- tables stay out: the view is the one with the names on it.
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'silo_chat_schema_catalog'
                  and column_name = 'reportable') then
      update public.silo_chat_schema_catalog
         set reportable = true
       where relname = 'meta_custom_conversion_daily_v';
    end if;
  end if;
end $$;

select public.attach_stamp_company_entity_id_triggers();
