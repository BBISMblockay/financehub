-- ─────────────────────────────────────────────────────────────────────────────
-- Keyword candidates inside the browser's statement_timeout.
--
-- Found 2026-09-26 the moment /v2/seo-keywords.html's "Suggest keywords" was
-- pressed on production: seo_derive_keyword_candidates(90) ran 27.9 s against
-- the authenticated role's 8 s statement_timeout, so the page showed no
-- candidates. MEASURED, not guessed, and the first guess was wrong: the
-- per-row regex key looked like the cost, and restructuring the aggregation
-- to group by the verbatim query first still took 27.0 s -- reading
-- Baseballism's 405,057 Search Console query rows for a 90-day window is
-- itself 3.7 s of heap fetches (338,507 of them; the visibility map is cold
-- after 241k dead tuples), before any sort or aggregate, under a 5 MB
-- work_mem that spills every step to disk. No shape of the query answers in
-- 8 s while it reads the rows at click time.
--
-- So the rows are not read at click time. search_console_query_rollup_mv
-- holds, per company and normalised keyword, the trailing 90 days ending on
-- that company's newest ingested day -- the exact aggregate the function
-- computed -- refreshed by the Search Console sync after every run (nightly
-- and backfill), the same way wow_sales_daily_type_mv and
-- sales_by_product_title_daily_mv are kept. The function reads it through
-- search_console_query_rollup_v: security_invoker = false with an explicit
-- active_company_id() filter, because a matview carries no RLS and no grant
-- to authenticated -- the wrapper IS the tenant boundary (the layering
-- CLAUDE.md records for inventory_on_hand_current_v; do not point anything at
-- the matview directly).
--
-- Consequences worth knowing:
--   * The Search Console groups (click leaders, opportunities) are ALWAYS the
--     rollup's 90-day window; p_days still bounds the collection candidates
--     only. Before this the two windows could differ; now the doc's 90 days
--     is the one that runs.
--   * The list is as of the last refresh, so "Suggest keywords" is as fresh as
--     the last Search Console sync (final data already ends 2 days back).
--   * days_present is exact again (count of distinct days across spellings),
--     since the rollup is built from the rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The rollup ──────────────────────────────────────────────────────────────
create materialized view if not exists public.search_console_query_rollup_mv as
with w as (
  select company_entity_id,
         max(day_date) as window_end,
         max(day_date) - 89 as window_start
  from public.search_console_query_daily
  group by company_entity_id
)
select
  q.company_entity_id,
  lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g'))) as keyword_norm,
  min(q.query)                                            as keyword,
  sum(q.clicks)::bigint                                   as clicks,
  sum(q.impressions)::bigint                              as impressions,
  sum(q.position * q.impressions)::numeric                as position_weight,
  count(distinct q.day_date)::integer                     as days_present,
  min(w.window_start)                                     as window_start,
  max(w.window_end)                                       as window_end
from public.search_console_query_daily q
join w on w.company_entity_id = q.company_entity_id
where q.day_date between w.window_start and w.window_end
group by q.company_entity_id, lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g')));

-- CONCURRENTLY needs a unique index, and without CONCURRENTLY the refresh
-- takes an AccessExclusiveLock that blocks every reader while it rebuilds.
create unique index if not exists search_console_query_rollup_mv_key
  on public.search_console_query_rollup_mv (company_entity_id, keyword_norm);
create index if not exists search_console_query_rollup_mv_clicks
  on public.search_console_query_rollup_mv (company_entity_id, clicks desc);

-- ── The tenant boundary ─────────────────────────────────────────────────────
drop view if exists public.search_console_query_rollup_v;
create view public.search_console_query_rollup_v
  with (security_invoker = false) as
select company_entity_id, keyword_norm, keyword, clicks, impressions, position_weight,
       case when impressions > 0 then round(position_weight / impressions, 2) end as position,
       days_present, window_start, window_end
from public.search_console_query_rollup_mv
where company_entity_id = public.active_company_id();

revoke all on public.search_console_query_rollup_mv from public, anon, authenticated;
grant select on public.search_console_query_rollup_v to authenticated;

comment on materialized view public.search_console_query_rollup_mv is
  'Per company and normalised keyword, the trailing 90 days of Search Console '
  'query rows ending on the company''s newest ingested day: clicks, impressions, '
  'the impression-weighted position numerator, distinct days present. Refreshed '
  'by refresh_search_console_query_rollup_mv() after every Search Console sync. '
  'No RLS and no grant to authenticated: read search_console_query_rollup_v.';
comment on view public.search_console_query_rollup_v is
  'search_console_query_rollup_mv filtered to the caller''s active company. '
  'security_invoker = false on purpose: the filter IS the tenant boundary. '
  'position is the impression-weighted AVERAGE over the window, never a rank.';

-- ── The refresh, service role only ──────────────────────────────────────────
create or replace function public.refresh_search_console_query_rollup_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  -- Concurrent where possible; the plain refresh is the fallback for the very
  -- first populate, when CONCURRENTLY is not allowed. Same shape as
  -- refresh_wow_sales_daily_mv().
  begin
    refresh materialized view concurrently public.search_console_query_rollup_mv;
  exception when others then
    refresh materialized view public.search_console_query_rollup_mv;
  end;
end;
$$;

revoke execute on function public.refresh_search_console_query_rollup_mv() from public, anon, authenticated;
grant execute on function public.refresh_search_console_query_rollup_mv() to service_role;

comment on function public.refresh_search_console_query_rollup_mv() is
  'Rebuilds search_console_query_rollup_mv (concurrently once populated). Called '
  'by scripts/ad-platforms-sync.mjs after the Search Console connections and by '
  'scripts/search-console-backfill.mjs. Service role only.';

-- ── The candidate function, reading the rollup ──────────────────────────────
create or replace function public.seo_derive_keyword_candidates(p_days integer default 90)
returns table (
  company_entity_id uuid,
  keyword           text,
  keyword_norm      text,
  source            text,
  clicks            bigint,
  impressions       bigint,
  our_position      numeric,
  evidence          jsonb,
  already_in_set    boolean,
  coverage_note     text
)
language sql
stable
as $$
with co as (
  select public.active_company_id() as id
),
-- The Search Console window is the ROLLUP's (trailing 90 days ending on the
-- newest ingested day), whatever p_days says: the rows are not read here.
q as (
  select r.company_entity_id, r.keyword_norm, r.keyword, r.clicks, r.impressions,
         r.position, r.days_present, r.window_start, r.window_end
  from public.search_console_query_rollup_v r
),
w as (
  select company_entity_id, min(window_start) as window_start, max(window_end) as window_end
  from q
  group by company_entity_id
),
coverage as (
  select s.company_entity_id,
         sum(s.clicks) as clicks,
         sum(s.unattributed_query_clicks) as unattributed,
         case when sum(s.clicks) > 0 and bool_and(s.unattributed_query_clicks is not null)
              then round(100.0 * sum(s.unattributed_query_clicks) / sum(s.clicks), 1) end as unattributed_pct,
         min(w.window_start) as window_start, min(w.window_end) as window_end
  from public.search_console_site_daily s
  join w on w.company_entity_id = s.company_entity_id
  where s.day_date between w.window_start and w.window_end
  group by s.company_entity_id
),
note as (
  select c.company_entity_id,
         case when c.unattributed_pct is null
              then format('Search Console window %s to %s: unattributed query share NOT MEASURED for every day, so a query absent here may still bring traffic', c.window_start, c.window_end)
              else format('Search Console window %s to %s: %s%% of clicks belong to no returned query row (unattributed), so a query absent here may still bring traffic', c.window_start, c.window_end, c.unattributed_pct)
         end as coverage_note
  from coverage c
),
-- Click leaders are queries we already rank on page one for (position <= 10,
-- or unmeasured); a query at position 14 with a trickle of clicks is an
-- OPPORTUNITY, not a leader, and the doc's two groups would otherwise fight
-- over it in a small set.
g1 as (
  select q.*, 'search_console_clicks'::text as source
  from q
  where q.position is null or q.position <= 10
  order by q.clicks desc, q.impressions desc
  limit 60
),
g2 as (
  select q.*, 'search_console_opportunity'::text as source
  from q
  where q.position > 10
    and q.keyword_norm not in (select keyword_norm from g1)
  order by q.impressions desc
  limit 30
),
g3_raw as (
  select co.id as company_entity_id,
         lower(btrim(regexp_replace(c.collection_title, '\s+', ' ', 'g'))) as keyword_norm,
         c.collection_title as keyword,
         'collection'::text as source,
         jsonb_build_object('collection_handle', c.collection_handle, 'sessions', c.sessions, 'products_count', c.products_count) as evidence
  from co, public.seo_collection_candidates(greatest(coalesce(p_days, 90), 1)) c
  where c.candidate_status = 'reviewable'
    and nullif(btrim(coalesce(c.collection_title, '')), '') is not null
  union all
  select pm.company_entity_id,
         lower(btrim(regexp_replace(pm.product_type, '\s+', ' ', 'g'))),
         min(pm.product_type),
         'product_type'::text,
         jsonb_build_object('live_skus', count(*))
  from public.products_master pm, co
  where pm.company_entity_id = co.id
    and pm.shopify_status = 'active'
    and pm.online_published_at is not null
    and nullif(btrim(coalesce(pm.product_type, '')), '') is not null
  group by pm.company_entity_id, lower(btrim(regexp_replace(pm.product_type, '\s+', ' ', 'g')))
),
g3 as (
  select distinct on (r.keyword_norm) r.*
  from g3_raw r
  where r.keyword_norm not in (select keyword_norm from g1 union select keyword_norm from g2)
  order by r.keyword_norm, r.source
  limit 40
),
g4 as (
  select lc.company_entity_id,
         lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g'))) as keyword_norm,
         min(lc.title) as keyword,
         'launch'::text as source,
         jsonb_build_object('launch_date', min(lc.launch_date)) as evidence
  from public.launch_calendar lc, co
  where lc.company_entity_id = co.id
    and lc.launch_date between public.silo_business_today() and public.silo_business_today() + 183
    and nullif(btrim(coalesce(lc.title, '')), '') is not null
    and lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g'))) not in (
      select keyword_norm from g1 union select keyword_norm from g2 union select keyword_norm from g3)
  group by lc.company_entity_id, lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g')))
  order by min(lc.launch_date)
  limit 20
),
candidates as (
  select company_entity_id, keyword, keyword_norm, source,
         jsonb_build_object('days_present', days_present) as evidence
  from g1
  union all
  select company_entity_id, keyword, keyword_norm, source,
         jsonb_build_object('days_present', days_present)
  from g2
  union all
  select company_entity_id, keyword, keyword_norm, source, evidence from g3
  union all
  select company_entity_id, keyword, keyword_norm, source, evidence from g4
)
select
  c.company_entity_id,
  c.keyword,
  c.keyword_norm,
  c.source,
  q.clicks::bigint,
  q.impressions::bigint,
  q.position as our_position,
  c.evidence,
  exists (select 1 from public.seo_keyword_set k
          where k.company_entity_id = c.company_entity_id and k.keyword_norm = c.keyword_norm) as already_in_set,
  case when c.source like 'search_console%' then n.coverage_note end as coverage_note
from candidates c
left join q on q.company_entity_id = c.company_entity_id and q.keyword_norm = c.keyword_norm
left join note n on n.company_entity_id = c.company_entity_id
order by case c.source
           when 'search_console_clicks' then 1
           when 'search_console_opportunity' then 2
           when 'collection' then 3
           when 'product_type' then 4
           else 5 end,
         q.clicks desc nulls last, c.keyword_norm;
$$;

comment on function public.seo_derive_keyword_candidates(integer) is
  'The bounded keyword-set candidates from docs/ops/seo-competitors.md, for the '
  'caller''s active company: up to 60 Search Console queries by clicks, 30 by '
  'impressions with position worse than 10, 40 collection and live product-type '
  'head terms, 20 upcoming launches. A reviewable list, never an auto-insert. '
  'our_position is the Search Console impression-weighted average where the '
  'term is a returned query; NULL otherwise, never 0. coverage_note carries the '
  'window''s unattributed share beside every Search Console-derived row. '
  'Since 20260926150000 the Search Console groups read '
  'search_console_query_rollup_v (the trailing 90 days as of the last Search '
  'Console sync), so the call answers inside the browser role''s 8 s '
  'statement_timeout; p_days bounds the collection candidates only.';

-- ── Populate now, so the page works the moment this applies ─────────────────
select public.refresh_search_console_query_rollup_mv();
