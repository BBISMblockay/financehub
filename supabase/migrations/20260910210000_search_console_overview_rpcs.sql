-- 20260910210000_search_console_overview_rpcs.sql
-- ---------------------------------------------------------------------------
-- Three read-only RPCs behind /v2/seo-overview.html. They exist because a
-- browser cannot aggregate 2.4M query rows through PostgREST, and because the
-- freshness and coverage facts every SEO view must show (data through which
-- day, how far behind today, what share of clicks the returned query rows
-- account for, how many days hit the 5,000-row cap) belong NEXT TO the
-- numbers they qualify, computed in the same statement, not assembled by the
-- page from separate calls that can disagree.
--
-- All three are SECURITY INVOKER (the default) and read the search_console_*
-- tables through their own RLS -- company scoping is the tables' select
-- policy, restated here as a WHERE for clarity, never widened. `stable`,
-- `language sql`, granted to authenticated and explicitly revoked from anon
-- and public: Supabase's default privileges re-grant EXECUTE on new public
-- functions to anon, which is how chat_run_readonly_query was once callable
-- unauthenticated (20260904330000).
--
-- Window semantics, shared by all three:
--   end   = p_end, else the NEWEST INGESTED day for this company -- not
--           "today minus 2". If a nightly is missed the page shows what
--           exists and says how far behind it is, rather than a window of
--           empty days that reads as a collapse.
--   start = end - (p_days - 1)
--   prior = the p_days immediately before start (same length, adjacent)
-- Prior-period figures are NULL, never 0, when the prior window has no rows:
-- "no prior data" and "flat" must not render alike.
--
-- Rates are POOLED, never averaged: ctr = sum(clicks)/sum(impressions), and
-- position is impression-weighted (a position on 3 impressions cannot
-- count as much as one on 3,000).
-- ---------------------------------------------------------------------------

create or replace function public.search_console_overview(
  p_days integer default 28,
  p_end date default null
)
returns jsonb
language sql
stable
as $$
with n as (
  select greatest(coalesce(p_days, 28), 1) as days
),
bounds as (
  select min(day_date) as min_day, max(day_date) as max_day,
         max(synced_at) as last_synced_at, count(*) as days_ingested,
         min(site_url) as site_url
  from public.search_console_site_daily
  where company_entity_id = public.active_company_id()
),
w as (
  select coalesce(p_end, b.max_day) as e,
         coalesce(p_end, b.max_day) - (n.days - 1) as s,
         coalesce(p_end, b.max_day) - n.days as pe,
         coalesce(p_end, b.max_day) - (2 * n.days - 1) as ps,
         n.days
  from bounds b cross join n
),
cur as (
  select count(*) as days_present,
         sum(d.clicks) as clicks, sum(d.impressions) as impressions,
         sum(d.position * d.impressions) as pos_w,
         sum(d.query_attributed_clicks) as qa_clicks,
         sum(d.clicks) filter (where d.query_attributed_clicks is not null) as clicks_measured,
         sum(d.page_attributed_clicks) as pa_clicks,
         count(*) filter (where d.query_attributed_clicks is null) as unmeasured_days,
         count(*) filter (where d.query_rows >= 5000) as capped_days,
         count(*) filter (where d.is_truncated) as truncated_days
  from public.search_console_site_daily d cross join w
  where d.company_entity_id = public.active_company_id()
    and d.day_date between w.s and w.e
),
prev as (
  select count(*) as days_present,
         sum(d.clicks) as clicks, sum(d.impressions) as impressions,
         sum(d.position * d.impressions) as pos_w,
         sum(d.query_attributed_clicks) as qa_clicks,
         sum(d.clicks) filter (where d.query_attributed_clicks is not null) as clicks_measured,
         sum(d.page_attributed_clicks) as pa_clicks,
         count(*) filter (where d.query_attributed_clicks is null) as unmeasured_days,
         count(*) filter (where d.query_rows >= 5000) as capped_days,
         count(*) filter (where d.is_truncated) as truncated_days
  from public.search_console_site_daily d cross join w
  where d.company_entity_id = public.active_company_id()
    and d.day_date between w.ps and w.pe
),
series as (
  select jsonb_agg(jsonb_build_object(
           'day', d.day_date,
           'clicks', d.clicks,
           'impressions', d.impressions,
           'ctr', case when d.impressions > 0 then round(d.clicks::numeric / d.impressions, 6) end,
           'position', d.position,
           'query_rows', d.query_rows,
           'capped', d.query_rows >= 5000,
           'unattributed_query_click_share', d.unattributed_query_click_share
         ) order by d.day_date) as rows
  from public.search_console_site_daily d cross join w
  where d.company_entity_id = public.active_company_id()
    and d.day_date between w.s and w.e
)
select jsonb_build_object(
  'freshness', jsonb_build_object(
    'site_url', b.site_url,
    'min_day', b.min_day,
    'max_day', b.max_day,
    'days_ingested', b.days_ingested,
    'last_synced_at', b.last_synced_at,
    'business_today', public.silo_business_today(),
    'lag_days', case when b.max_day is null then null else public.silo_business_today() - b.max_day end,
    'data_state', 'final'
  ),
  'window', jsonb_build_object(
    'start', w.s, 'end', w.e, 'days_requested', w.days, 'days_present', cur.days_present,
    'prior_start', w.ps, 'prior_end', w.pe, 'prior_days_present', prev.days_present
  ),
  'current', jsonb_build_object(
    'days_present', cur.days_present,
    'clicks', cur.clicks, 'impressions', cur.impressions,
    'ctr', case when cur.impressions > 0 then round(cur.clicks::numeric / cur.impressions, 6) end,
    'position', case when cur.impressions > 0 then round(cur.pos_w / cur.impressions, 2) end,
    'query_attributed_clicks', cur.qa_clicks,
    'unattributed_query_clicks', case when cur.qa_clicks is null then null else cur.clicks_measured - cur.qa_clicks end,
    'unattributed_query_click_share',
      case when cur.qa_clicks is null or coalesce(cur.clicks_measured, 0) = 0 then null
           else round((cur.clicks_measured - cur.qa_clicks)::numeric / cur.clicks_measured, 4) end,
    'page_attributed_clicks', cur.pa_clicks,
    'page_attributed_share',
      case when cur.pa_clicks is null or coalesce(cur.clicks, 0) = 0 then null
           else round(cur.pa_clicks::numeric / cur.clicks, 4) end,
    'unmeasured_days', cur.unmeasured_days,
    'capped_days', cur.capped_days,
    'truncated_days', cur.truncated_days
  ),
  'prior', case when coalesce(prev.days_present, 0) = 0 then null else jsonb_build_object(
    'days_present', prev.days_present,
    'clicks', prev.clicks, 'impressions', prev.impressions,
    'ctr', case when prev.impressions > 0 then round(prev.clicks::numeric / prev.impressions, 6) end,
    'position', case when prev.impressions > 0 then round(prev.pos_w / prev.impressions, 2) end,
    'query_attributed_clicks', prev.qa_clicks,
    'unattributed_query_click_share',
      case when prev.qa_clicks is null or coalesce(prev.clicks_measured, 0) = 0 then null
           else round((prev.clicks_measured - prev.qa_clicks)::numeric / prev.clicks_measured, 4) end,
    'capped_days', prev.capped_days
  ) end,
  'series', coalesce(s.rows, '[]'::jsonb)
)
from bounds b cross join w cross join cur cross join prev cross join series s;
$$;

-- Top pages by clicks in the window, each with the same page's prior-window
-- figures beside it. prior_* is NULL when the page has no prior-window row:
-- that reads "not returned by Search Console in the prior window", never 0,
-- because Google does not guarantee every page row is returned.
create or replace function public.search_console_top_pages(
  p_days integer default 28,
  p_end date default null,
  p_limit integer default 25
)
returns table (
  page text,
  page_path text,
  clicks bigint,
  impressions bigint,
  ctr numeric,
  "position" numeric,
  days_present integer,
  prior_clicks bigint,
  prior_impressions bigint,
  prior_ctr numeric,
  prior_position numeric,
  prior_days_present integer,
  clicks_change bigint,
  clicks_change_pct numeric
)
language sql
stable
as $$
with n as (select greatest(coalesce(p_days, 28), 1) as days, least(greatest(coalesce(p_limit, 25), 1), 200) as lim),
bounds as (
  select max(day_date) as max_day from public.search_console_site_daily
  where company_entity_id = public.active_company_id()
),
w as (
  select coalesce(p_end, b.max_day) as e, coalesce(p_end, b.max_day) - (n.days - 1) as s,
         coalesce(p_end, b.max_day) - n.days as pe, coalesce(p_end, b.max_day) - (2 * n.days - 1) as ps
  from bounds b cross join n
),
cur as (
  select p.page, min(p.page_path) as page_path,
         sum(p.clicks) as clicks, sum(p.impressions) as impressions,
         sum(p.position * p.impressions) as pos_w, count(*) as days_present
  from public.search_console_page_daily p cross join w
  where p.company_entity_id = public.active_company_id() and p.day_date between w.s and w.e
  group by p.page
),
prev as (
  select p.page, sum(p.clicks) as clicks, sum(p.impressions) as impressions,
         sum(p.position * p.impressions) as pos_w, count(*) as days_present
  from public.search_console_page_daily p cross join w
  where p.company_entity_id = public.active_company_id() and p.day_date between w.ps and w.pe
  group by p.page
)
select c.page, c.page_path, c.clicks, c.impressions,
       case when c.impressions > 0 then round(c.clicks::numeric / c.impressions, 6) end as ctr,
       case when c.impressions > 0 then round(c.pos_w / c.impressions, 2) end as "position",
       c.days_present::integer,
       v.clicks as prior_clicks, v.impressions as prior_impressions,
       case when v.impressions > 0 then round(v.clicks::numeric / v.impressions, 6) end as prior_ctr,
       case when v.impressions > 0 then round(v.pos_w / v.impressions, 2) end as prior_position,
       v.days_present::integer as prior_days_present,
       case when v.clicks is null then null else c.clicks - v.clicks end as clicks_change,
       case when v.clicks is null or v.clicks = 0 then null
            else round((c.clicks - v.clicks)::numeric / v.clicks, 4) end as clicks_change_pct
from cur c
left join prev v on v.page = c.page
cross join n
order by c.clicks desc, c.impressions desc, c.page
limit (select lim from n);
$$;

-- Top RETURNED queries by clicks. The window-level coverage facts (what share
-- of clicks these rows account for, how many days hit the 5,000-row cap) are
-- on search_console_overview() and must be rendered beside this list; a
-- query absent from the prior window is "not returned", never 0.
create or replace function public.search_console_top_queries(
  p_days integer default 28,
  p_end date default null,
  p_limit integer default 25
)
returns table (
  query text,
  clicks bigint,
  impressions bigint,
  ctr numeric,
  "position" numeric,
  days_present integer,
  prior_clicks bigint,
  prior_impressions bigint,
  prior_ctr numeric,
  prior_position numeric,
  prior_days_present integer,
  clicks_change bigint,
  clicks_change_pct numeric
)
language sql
stable
as $$
with n as (select greatest(coalesce(p_days, 28), 1) as days, least(greatest(coalesce(p_limit, 25), 1), 200) as lim),
bounds as (
  select max(day_date) as max_day from public.search_console_site_daily
  where company_entity_id = public.active_company_id()
),
w as (
  select coalesce(p_end, b.max_day) as e, coalesce(p_end, b.max_day) - (n.days - 1) as s,
         coalesce(p_end, b.max_day) - n.days as pe, coalesce(p_end, b.max_day) - (2 * n.days - 1) as ps
  from bounds b cross join n
),
cur as (
  select q.query, sum(q.clicks) as clicks, sum(q.impressions) as impressions,
         sum(q.position * q.impressions) as pos_w, count(*) as days_present
  from public.search_console_query_daily q cross join w
  where q.company_entity_id = public.active_company_id() and q.day_date between w.s and w.e
  group by q.query
),
prev as (
  select q.query, sum(q.clicks) as clicks, sum(q.impressions) as impressions,
         sum(q.position * q.impressions) as pos_w, count(*) as days_present
  from public.search_console_query_daily q cross join w
  where q.company_entity_id = public.active_company_id() and q.day_date between w.ps and w.pe
  group by q.query
)
select c.query, c.clicks, c.impressions,
       case when c.impressions > 0 then round(c.clicks::numeric / c.impressions, 6) end as ctr,
       case when c.impressions > 0 then round(c.pos_w / c.impressions, 2) end as "position",
       c.days_present::integer,
       v.clicks as prior_clicks, v.impressions as prior_impressions,
       case when v.impressions > 0 then round(v.clicks::numeric / v.impressions, 6) end as prior_ctr,
       case when v.impressions > 0 then round(v.pos_w / v.impressions, 2) end as prior_position,
       v.days_present::integer as prior_days_present,
       case when v.clicks is null then null else c.clicks - v.clicks end as clicks_change,
       case when v.clicks is null or v.clicks = 0 then null
            else round((c.clicks - v.clicks)::numeric / v.clicks, 4) end as clicks_change_pct
from cur c
left join prev v on v.query = c.query
cross join n
order by c.clicks desc, c.impressions desc, c.query
limit (select lim from n);
$$;

revoke all on function public.search_console_overview(integer, date) from public, anon;
revoke all on function public.search_console_top_pages(integer, date, integer) from public, anon;
revoke all on function public.search_console_top_queries(integer, date, integer) from public, anon;
grant execute on function public.search_console_overview(integer, date) to authenticated;
grant execute on function public.search_console_top_pages(integer, date, integer) to authenticated;
grant execute on function public.search_console_top_queries(integer, date, integer) to authenticated;

-- The RPCs are reachable from Ask SILO's read-only SQL too; describe them
-- where the model reads. Guarded append on the site row, which is the one
-- the model reaches first for any overview question.
update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' OVERVIEW RPCS: search_console_overview(p_days, p_end) returns one jsonb '
  'with freshness (max_day, lag_days), the window, current and prior-period '
  'totals (pooled ctr, impression-weighted position, unattributed share, '
  'capped_days) and a daily series; search_console_top_pages(p_days, p_end, '
  'p_limit) and search_console_top_queries(...) return the top rows with the '
  'same row''s prior-window figures beside them (prior_* NULL = not returned '
  'in the prior window, never 0). Prefer these to hand-rolled aggregates so '
  'the coverage facts travel with the numbers.',
    updated_at = now()
where relname = 'search_console_site_daily'
  and coalesce(description, '') not like '%OVERVIEW RPCS%';
