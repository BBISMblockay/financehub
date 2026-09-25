-- SEO Performance: Google Search Console as a SILO report.
--
-- Report definition only (no table, view, policy or grant). It reads the
-- three RLS tables written by the Search Console sync
-- (search_console_site_daily / _page_daily / _query_daily, select policy
-- company_entity_id = active_company_id()), so the one global definition
-- scopes itself to each caller's company, like every other SILO report.
--
-- The rules it follows are the ones the tables were built to (CLAUDE.md,
-- 20260910180000, and /v2/seo-overview.html's RPCs):
--   * Final data ends TWO days back, so the default window ends today-2d.
--     A day with no site row is not ingested, never "zero searches".
--   * Three grains, never joined into one figure. Page impressions exceed
--     site impressions (one per URL shown vs one per query), so page and
--     site totals are shown in different parts and never added together.
--   * Query rows cover only part of clicks (anonymised queries are
--     withheld): the summary states the unattributed share beside every
--     total, and the query part says so in its description.
--   * Position is an average: pooled by impressions, never summed or
--     averaged day over day.
--   * A page or query absent from the prior window is NOT RETURNED, never 0:
--     its prior value is blank and its change is blank.
--   * A period comparison is blank unless both periods are fully ingested.
--
-- Every date predicate is written inline against the indexed column. A
-- window CTE joined in (`from t, w where day_date between w.s and w.e`)
-- cannot be pushed into (company_entity_id, day_date) and scanned all 1.3M
-- page rows -- measured 2026-09-25 as a statement timeout, against 0.5s
-- inline.
--
-- Everything is grouped by site_url (the "property"): one today, and a
-- company that later connects a second property gets one row per property
-- rather than two properties silently summed.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
('c3000000-0000-4000-a000-00000000000b', null, 'system', 'company',
 'SEO Performance',
 'Google Search Console clicks, impressions, click-through rate and average position: the site total against the previous period of equal length, a daily trend, and the pages and search queries behind it. Google''s final data ends two days back, so the default window ends then. Query rows cover only part of search clicks (Google withholds anonymised queries); the unattributed share is shown with the totals. Page totals exceed site totals by design (a page counts once per URL shown), so the three are never added together. A page or query missing from the previous period was not returned by Google, not zero. Position is impression-weighted.',
 array[
$q$with cur as materialized (
  select site_url, count(*) days_with_data, max(day_date) data_through,
         sum(clicks) clicks, sum(impressions) impressions, sum(position * impressions) pos_w,
         sum(query_attributed_clicks) qa_clicks,
         sum(clicks) filter (where query_attributed_clicks is not null) qa_measured_clicks,
         count(*) filter (where query_rows = 5000) days_at_5000_query_rows
    from search_console_site_daily
   where day_date between {{date_from}} and {{date_to}}
   group by site_url
), prev as materialized (
  select site_url, count(*) days_with_data,
         sum(clicks) clicks, sum(impressions) impressions, sum(position * impressions) pos_w
    from search_console_site_daily
   where day_date between {{date_from}} - ({{date_to}} - {{date_from}} + 1) and {{date_from}} - 1
   group by site_url
)
select c.site_url as property,
       c.data_through,
       ({{date_to}} - {{date_from}} + 1) as days_in_window,
       c.days_with_data,
       c.clicks,
       p.clicks as prior_clicks,
       case when c.days_with_data = ({{date_to}} - {{date_from}} + 1) and p.days_with_data = ({{date_to}} - {{date_from}} + 1)
            then round((c.clicks - p.clicks)::numeric / nullif(p.clicks, 0), 4) end as clicks_change_pct,
       c.impressions,
       p.impressions as prior_impressions,
       case when c.days_with_data = ({{date_to}} - {{date_from}} + 1) and p.days_with_data = ({{date_to}} - {{date_from}} + 1)
            then round((c.impressions - p.impressions)::numeric / nullif(p.impressions, 0), 4) end as impressions_change,
       round(c.clicks::numeric / nullif(c.impressions, 0), 4) as ctr,
       round(c.pos_w / nullif(c.impressions, 0), 1) as avg_position,
       round(p.pos_w / nullif(p.impressions, 0), 1) as prior_avg_position,
       round(1 - c.qa_clicks::numeric / nullif(c.qa_measured_clicks, 0), 4) as unattributed_query_click_share,
       c.days_at_5000_query_rows
  from cur c left join prev p on p.site_url = c.site_url
 order by c.clicks desc, c.site_url$q$,
$q$select day_date, site_url as property, clicks, impressions,
       round(clicks::numeric / nullif(impressions, 0), 4) as ctr,
       round(position, 1) as avg_position,
       query_rows,
       unattributed_query_click_share
  from search_console_site_daily
 where day_date between {{date_from}} and {{date_to}}
 order by day_date, site_url$q$,
$q$with cur as materialized (
  select site_url, page, min(page_path) page_path,
         sum(clicks) clicks, sum(impressions) impressions, sum(position * impressions) pos_w, count(*) days_present
    from search_console_page_daily
   where day_date between {{date_from}} and {{date_to}}
   group by site_url, page
), prev as materialized (
  select site_url, page, sum(clicks) clicks, sum(impressions) impressions
    from search_console_page_daily
   where day_date between {{date_from}} - ({{date_to}} - {{date_from}} + 1) and {{date_from}} - 1
   group by site_url, page
)
select c.page_path, c.page, c.site_url as property,
       c.clicks, c.impressions,
       round(c.clicks::numeric / nullif(c.impressions, 0), 4) as ctr,
       round(c.pos_w / nullif(c.impressions, 0), 1) as avg_position,
       c.days_present,
       p.clicks as prior_clicks,
       c.clicks - p.clicks as clicks_change
  from cur c left join prev p on p.site_url = c.site_url and p.page = c.page
 order by c.clicks desc, c.impressions desc, c.page$q$,
$q$with cur as materialized (
  select site_url, query,
         sum(clicks) clicks, sum(impressions) impressions, sum(position * impressions) pos_w, count(*) days_present
    from search_console_query_daily
   where day_date between {{date_from}} and {{date_to}}
   group by site_url, query
), prev as materialized (
  select site_url, query, sum(clicks) clicks
    from search_console_query_daily
   where day_date between {{date_from}} - ({{date_to}} - {{date_from}} + 1) and {{date_from}} - 1
   group by site_url, query
)
select c.query, c.site_url as property,
       c.clicks, c.impressions,
       round(c.clicks::numeric / nullif(c.impressions, 0), 4) as ctr,
       round(c.pos_w / nullif(c.impressions, 0), 1) as avg_position,
       c.days_present,
       p.clicks as prior_clicks,
       c.clicks - p.clicks as clicks_change
  from cur c left join prev p on p.site_url = c.site_url and p.query = c.query
 order by c.clicks desc, c.impressions desc, c.query$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-29d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-2d","date_basis":"company"}]'::jsonb,
 '{
   "_queries":[{"index":0,"title":"Site total vs previous period","chart":false},{"index":1,"title":"Daily trend","chart":true},{"index":2,"title":"Pages","chart":true},{"index":3,"title":"Search queries (partial: anonymised queries withheld)","chart":true}],
   "property":{"label":"Property","semantic":"category"},
   "data_through":{"label":"Data Through","semantic":"date"},
   "days_in_window":{"label":"Days in Window","semantic":"count"},
   "days_with_data":{"label":"Days With Data","semantic":"count"},
   "clicks":{"label":"Clicks","semantic":"count","chart_primary":true},
   "prior_clicks":{"label":"Prior Clicks","semantic":"count","blank_reason":"Not returned by Google for the previous period (not zero)."},
   "clicks_change":{"label":"Clicks Change","semantic":"number","blank_reason":"Blank when the page or query was not returned for the previous period."},
   "clicks_change_pct":{"label":"Clicks Change %","semantic":"fraction","blank_reason":"Blank when either period is missing days."},
   "impressions":{"label":"Impressions","semantic":"count"},
   "prior_impressions":{"label":"Prior Impressions","semantic":"count"},
   "impressions_change":{"label":"Impressions Change","semantic":"fraction","blank_reason":"Blank when either period is missing days."},
   "ctr":{"label":"CTR","semantic":"fraction"},
   "avg_position":{"label":"Avg Position","semantic":"number"},
   "prior_avg_position":{"label":"Prior Avg Position","semantic":"number"},
   "unattributed_query_click_share":{"label":"Clicks With No Query Row","semantic":"fraction"},
   "days_at_5000_query_rows":{"label":"Days at 5,000 Query Rows","semantic":"count"},
   "day_date":{"label":"Day","semantic":"date"},
   "query_rows":{"label":"Query Rows Returned","semantic":"count"},
   "page_path":{"label":"Page","semantic":"category","chart_dimension":true},
   "page":{"label":"URL","semantic":"link"},
   "days_present":{"label":"Days Returned","semantic":"count"},
   "query":{"label":"Search Query","semantic":"category","chart_dimension":true}
 }'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- Tie-outs. The page and query parts are checked against the SITE table's
-- page_attributed_clicks / query_attributed_clicks, which the sync records
-- from the same fetch as the detail rows -- a different table, so a detail
-- row lost or duplicated shows up here. The md5 guard makes a later edit to
-- the report read NO DATA until its checks are refreshed.
delete from public.silo_report_tieouts where report_id = 'c3000000-0000-4000-a000-00000000000b';

do $checks$
declare
  from_sql constant text := '((select public.silo_business_today()) - 29)';
  to_sql constant text := '((select public.silo_business_today()) - 2)';
  note constant text := 'Uses deployed default SQL. NO DATA can mean no Search Console rows or a changed definition requiring a refreshed check; never a certification of completeness.';
  r record;
  q text[];
  guard text;
  n int;
  site_sum text;
begin
  select * into r from public.silo_chat_saved_reports where id = 'c3000000-0000-4000-a000-00000000000b';
  q := array[]::text[];
  for n in 1 .. array_length(r.queries_run, 1) loop
    q := q || replace(replace(r.queries_run[n], '{{date_from}}', from_sql), '{{date_to}}', to_sql);
  end loop;
  guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                  md5(r.queries_run::text || r.parameters::text), r.id);
  site_sum := format('from public.search_console_site_daily where company_entity_id = (select public.active_company_id()) and day_date between %s and %s', from_sql, to_sql);

  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
  (r.id, 'Page clicks agree with the site table''s page-attributed clicks', 'reconciliation',
   format('with report as materialized (%s) select case when %s then sum(clicks) end as left_value, '
     || '(select sum(page_attributed_clicks) %s) as right_value from report', q[3], guard, site_sum),
   0, note || ' Page clicks can exceed site clicks; this compares the detail rows with what the same fetch attributed to pages.'),
  (r.id, 'Query clicks agree with the site table''s query-attributed clicks', 'reconciliation',
   format('with report as materialized (%s) select case when %s then sum(clicks) end as left_value, '
     || '(select sum(query_attributed_clicks) %s) as right_value from report', q[4], guard, site_sum),
   0, note || ' Query rows cover only part of clicks by design; this checks none of the returned rows were lost.'),
  (r.id, 'Daily trend adds up to the site total', 'sanity',
   format('with t as materialized (%s), d as materialized (%s) select case when %s then (select sum(clicks) from d) end as left_value, '
     || '(select sum(clicks) from t) as right_value', q[1], q[2], guard),
   0, note);
end $checks$;
