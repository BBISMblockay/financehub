-- Meta full-funnel events: view_content, add_to_cart, initiate_checkout,
-- alongside the purchase data already synced.
--
-- Meta's insights API already returns these action_types in the same
-- `actions`/`action_values` array the sync was pulling purchase out of — the
-- prior sync discarded everything except omni_purchase. No new API surface,
-- just stop throwing data away and add columns to hold it, at both grains
-- already in place (campaign-level marketing_kpis_daily, ad-level
-- meta_ad_performance_daily) so funnel drop-off is queryable per campaign or
-- per creative.
--
-- omni_* action_types cover on+offsite events (matches the purchase
-- convention already used); falls back to the bare event name for accounts
-- where omni_* isn't populated.

alter table public.marketing_kpis_daily
  add column if not exists view_content bigint,
  add column if not exists add_to_cart bigint,
  add column if not exists initiate_checkout bigint;

alter table public.meta_ad_performance_daily
  add column if not exists view_content bigint,
  add column if not exists add_to_cart bigint,
  add column if not exists initiate_checkout bigint;

comment on column public.marketing_kpis_daily.view_content is
  'Meta omni_view_content action count (meta_ads rows only) — funnel stage 1';
comment on column public.marketing_kpis_daily.add_to_cart is
  'Meta omni_add_to_cart action count (meta_ads rows only) — funnel stage 2';
comment on column public.marketing_kpis_daily.initiate_checkout is
  'Meta omni_initiate_checkout action count (meta_ads rows only) — funnel stage 3 (stage 4 = conversions column, i.e. purchase)';
