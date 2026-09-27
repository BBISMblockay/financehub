-- ─────────────────────────────────────────────────────────────────────────────
-- seo_keyword_landscape_v reads its 28-day Search Console figures from a
-- nightly rollup instead of re-aggregating search_console_query_daily on every
-- read.
--
-- WHY. Measured 2026-09-27 as a signed-in Baseballism user (the browser role,
-- 8 s statement_timeout), `select * from seo_recommendations_v`, 118 rows:
-- 6.29 s cold under EXPLAIN ANALYZE, 2.28 s warm. The single biggest cost is
-- the landscape's `gsc` CTE -- a regexp-normalise and hash-aggregate over
-- 116,504 raw query rows -- and seo_recommendations_v reads the landscape TWICE
-- (its base rows and its missing_category cluster), so it ran twice per load.
-- It is also the part that grows with every day of Search Console history.
-- With this migration applied inside a rolled-back transaction on production
-- the same read took 1.23 s warm and returned the identical 118 rows (same md5
-- over every column of every row).
--
-- WHAT. search_console_query_rollup_28d_mv holds EXACTLY the old CTE's rows --
-- same window (the 28 days ending on the company's newest
-- search_console_site_daily day), same normalisation, same expressions and
-- therefore the same column types -- so `create or replace view` on the
-- landscape accepts it (Postgres refuses a replacement that changes a column's
-- type, which is the guard that the swap is shape-identical). It is a SEPARATE
-- matview from search_console_query_rollup_mv on purpose: that one is a
-- 90-day window and additionally requires the site row to be at least as new
-- as the query row (`s.synced_at >= q.synced_at`), which the landscape never
-- did; folding the two together would silently change either the landscape's
-- numbers or Suggest keywords'.
--
-- LAYERING, same as every rollup here (wow_sales_daily_type_v,
-- inventory_on_hand_current_v, search_console_query_rollup_v): a matview has
-- no RLS, so it is granted to nobody and read only through
-- search_console_query_rollup_28d_v, security_invoker = false with an explicit
-- `company_entity_id = active_company_id()` filter. That filter IS the tenant
-- boundary. The landscape (security_invoker = true) reads the wrapper.
--
-- WHAT CHANGES FOR A READER. The figures are as of the last refresh rather
-- than live. refresh_search_console_query_rollup_mv() -- already called by
-- ad-platforms-sync.mjs after every Search Console sync and by
-- search-console-backfill.mjs -- now refreshes both matviews, so the landscape
-- is as fresh as the data it reads unless a refresh fails, in which case the
-- sync logs it. A service-role reader of the landscape (none exists today) sees
-- NULL Search Console columns, because active_company_id() is null for it --
-- the same stance as every other rollup wrapper.
-- ─────────────────────────────────────────────────────────────────────────────

create materialized view if not exists public.search_console_query_rollup_28d_mv as
with gsc_window as (
  select s.company_entity_id, max(s.day_date) as window_end, max(s.day_date) - 27 as window_start
  from public.search_console_site_daily s
  group by s.company_entity_id
)
select q.company_entity_id,
       lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g'))) as keyword_norm,
       sum(q.clicks) as clicks,
       sum(q.impressions) as impressions,
       case when sum(q.impressions) > 0
            then round(sum(q.position * q.impressions)::numeric / sum(q.impressions), 2) end as position,
       min(w.window_start) as window_start,
       min(w.window_end) as window_end
from public.search_console_query_daily q
join gsc_window w on w.company_entity_id = q.company_entity_id
where q.day_date between w.window_start and w.window_end
group by q.company_entity_id, lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g')));

-- CONCURRENTLY needs a unique index; the grouping key is unique by construction.
create unique index if not exists search_console_query_rollup_28d_mv_key
  on public.search_console_query_rollup_28d_mv (company_entity_id, keyword_norm);

create or replace view public.search_console_query_rollup_28d_v
  with (security_invoker = false) as
select company_entity_id, keyword_norm, clicks, impressions, position, window_start, window_end
from public.search_console_query_rollup_28d_mv
where company_entity_id = public.active_company_id();

revoke all on public.search_console_query_rollup_28d_mv from public, anon, authenticated;
revoke all on public.search_console_query_rollup_28d_v from public, anon;
grant select on public.search_console_query_rollup_28d_v to authenticated;

comment on materialized view public.search_console_query_rollup_28d_mv is
  'Search Console query rows summed per company x normalised keyword over the '
  '28 days ending on the company''s newest search_console_site_daily day: '
  'clicks, impressions and the impression-weighted average position. Exactly '
  'what seo_keyword_landscape_v used to compute on every read. Refreshed by '
  'refresh_search_console_query_rollup_mv() after every Search Console sync. No '
  'RLS and no grant to authenticated: read search_console_query_rollup_28d_v.';
comment on view public.search_console_query_rollup_28d_v is
  'The caller''s active company''s rows of search_console_query_rollup_28d_mv. '
  'security_invoker = false on purpose: the active_company_id() filter IS the '
  'tenant boundary, because the matview beneath it has no RLS. As of the last '
  'Search Console sync, not live. A query absent here was not a returned query '
  'in the window -- never zero clicks.';

-- ── The landscape: identical, except its gsc step reads the rollup ─────────
create or replace view public.seo_keyword_landscape_v
with (security_invoker = true) as
with identities as (
  select distinct r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine
  from public.seo_serp_runs r
  where r.completed_at is not null
),
gsc as (
  select g.company_entity_id, g.keyword_norm, g.clicks, g.impressions, g.position, g.window_start, g.window_end
  from public.search_console_query_rollup_28d_v g
)
select
  k.id                       as keyword_id,
  k.company_entity_id,
  k.keyword,
  k.keyword_norm,
  k.source,
  k.priority,
  k.is_active,
  k.commercial_note,
  i.provider,
  i.device,
  i.location_name,
  i.language_code,
  i.search_engine,
  coalesce(runs.observation_runs, 0)::integer as observation_runs,
  latest.observed_on         as latest_observed_on,
  latest.run_id              as latest_run_id,
  case when latest.run_id is not null then coalesce(latest_results.n, 0) end as results_in_latest_run,
  case when latest.run_id is not null then coalesce(latest_results.results, '[]'::jsonb) end as latest_top_results,
  latest_results.our_position as our_serp_position,
  previous.observed_on       as previous_observed_on,
  previous_results.our_position as our_previous_serp_position,
  case when latest_results.our_position is not null and previous_results.our_position is not null
       then previous_results.our_position - latest_results.our_position end as our_serp_movement,
  g.position                 as search_console_avg_position_28d,
  g.clicks                   as search_console_clicks_28d,
  g.impressions              as search_console_impressions_28d,
  g.window_start             as search_console_window_start,
  g.window_end               as search_console_window_end
from public.seo_keyword_set k
left join identities i on i.company_entity_id = k.company_entity_id
left join lateral (
  select count(*) as observation_runs
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and i.provider is not null
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
) runs on true
left join lateral (
  select r.id as run_id, r.observed_on
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and i.provider is not null
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
  order by r.observed_on desc, r.synced_at desc
  limit 1
) latest on true
left join lateral (
  select r.id as run_id, r.observed_on
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and latest.run_id is not null and r.id <> latest.run_id
    and r.observed_on < latest.observed_on
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
  order by r.observed_on desc, r.synced_at desc
  limit 1
) previous on true
left join lateral (
  select count(*) as n,
         jsonb_agg(jsonb_build_object(
           'position', v.position, 'domain', v.domain, 'url', v.url, 'title', v.title,
           'result_type', v.result_type, 'relationship', v.relationship, 'is_own_domain', v.is_own_domain
         ) order by v.position) as results,
         min(v.position) filter (where v.is_own_domain and v.result_type = 'organic') as our_position
  from public.seo_serp_observations_v v
  where v.run_id = latest.run_id and v.keyword_id = k.id
) latest_results on true
left join lateral (
  select min(v.position) filter (where v.is_own_domain and v.result_type = 'organic') as our_position
  from public.seo_serp_observations_v v
  where v.run_id = previous.run_id and v.keyword_id = k.id
) previous_results on true
left join gsc g on g.company_entity_id = k.company_entity_id and g.keyword_norm = k.keyword_norm;

comment on view public.seo_keyword_landscape_v is
  'Every keyword in seo_keyword_set, per run identity (provider x device x '
  'location), with the LATEST observed SERP and our position in it, the '
  'previous run''s position, the movement between them, and -- as two different '
  'measures on one row -- our Search Console impression-weighted average '
  'position over the last 28 ingested days. results_in_latest_run 0 means the '
  'run asked and nothing came back within depth; NULL means never observed. '
  'our_serp_position NULL means our storefront was not in the observed results. '
  'The Search Console columns are as of the last Search Console sync '
  '(search_console_query_rollup_28d_v), not live.';

-- ── One refresh for both Search Console rollups ─────────────────────────────
create or replace function public.refresh_search_console_query_rollup_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
begin
  begin
    refresh materialized view concurrently public.search_console_query_rollup_mv;
  exception when others then
    refresh materialized view public.search_console_query_rollup_mv;
  end;
  begin
    refresh materialized view concurrently public.search_console_query_rollup_28d_mv;
  exception when others then
    refresh materialized view public.search_console_query_rollup_28d_mv;
  end;
end;
$$;

revoke execute on function public.refresh_search_console_query_rollup_mv() from public, anon, authenticated;
grant execute on function public.refresh_search_console_query_rollup_mv() to service_role;

comment on function public.refresh_search_console_query_rollup_mv() is
  'Refreshes both Search Console rollups -- search_console_query_rollup_mv '
  '(90 days, Suggest keywords) and search_console_query_rollup_28d_mv (28 days, '
  'seo_keyword_landscape_v and everything reading it). Concurrently where '
  'possible. Service role only; called after every Search Console sync.';

-- Populate now, so the landscape has figures the moment this applies.
select public.refresh_search_console_query_rollup_mv();

select public.refresh_chat_schema_catalog();
