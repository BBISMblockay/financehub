-- Which Shopify stores feed Attribution reporting, chosen in Workspace Settings.
--
-- Why a setting and not a heuristic: /v2/silo-attribution.html picked the stores
-- to offer by looking for any day that carried money (PR #1016). That guess is
-- wrong for Baseballism -- a store with one funded day months ago stays in the
-- picker forever, and the store holding most of the revenue sorts wherever its
-- domain happens to fall -- and it would be wrong in a different way for every
-- other tenant. An explicit list is an answer instead of a guess.
--
-- REPORTING ONLY. This does NOT gate collection. Collection stays the coverage
-- allowlist (ATTRIBUTION_COVERAGE_COMPANIES) and ATTRIBUTION_EXCLUDED_CONNECTIONS.
-- Clearing a store here must never stop its history being gathered, or a
-- workspace would quietly lose days it cannot get back past Shopify's 60-day
-- order-access limit.
--
-- An empty array means "not configured" and the page keeps its current
-- behaviour. It never means "no stores", so an unconfigured workspace is not a
-- blank report.

alter table public.company_settings
  add column if not exists attribution_store_ids uuid[] not null default '{}'::uuid[];

comment on column public.company_settings.attribution_store_ids is
  'Shopify connection ids offered on the Attribution page, chosen in Workspace Settings. Empty = not configured, so the page falls back to every store with collected sales. Reporting only: never gates collection.';

-- No new policies: company_settings already has RLS, its SELECT is
-- company_entity_id = active_company_id() and its UPDATE additionally requires
-- is_owner_admin_of_active_company(), which is the gate a workspace setting
-- should carry. A new column inherits both. Verified live against pg_policy
-- before writing this, not read from a migration file.

-- Ask SILO's schema map has to learn the column, or it answers questions about
-- the Attribution page from a stale catalogue. Guarded: the function does not
-- exist in every environment this file is replayed into.
do $$
begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
