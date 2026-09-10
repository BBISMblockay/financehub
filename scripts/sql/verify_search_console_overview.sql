-- Exercises the three SEO overview RPCs (20260910210000) against a REAL
-- database with fixture rows, then rolls everything back.
--
-- Run in the Supabase SQL editor or any service-role psql session. It ends
-- by RAISING, which is not a failure -- that is what forces the rollback, and
-- the exception message IS the report. Every line should read PASS.
--
-- What it pins, because each one is a way the page could lie:
--   1. the window ends on the NEWEST INGESTED day, not today-2, and the prior
--      window is the same length immediately before it
--   2. ctr is POOLED and position is IMPRESSION-WEIGHTED, never averaged
--   3. the unattributed share is computed over measured days only and is
--      NULL, not 0, when nothing was measured
--   4. query_5000_row_days counts days returning exactly 5,000 rows (not proof of a cap)
--   5. a page/query with no prior-window row has NULL prior_* (not returned),
--      and a prior of 0 clicks yields a NULL percent change, not a division
--   6. prior is NULL as a whole when the prior window has no rows at all
--
-- Runs as service role, where active_company_id() returns NULL (no
-- auth.uid()), so the transaction first REPLACES active_company_id() with a
-- stub returning the fixture company; the ROLLBACK at the end restores the
-- real definition with everything else. Rows for a second company are
-- inserted alongside and asserted never to surface -- that is the company
-- filter inside the RPCs being exercised, not RLS (which service role
-- bypasses). End-to-end RLS still needs impersonation.
--
--   psql "$SUPABASE_DB_URL" -f scripts/sql/verify_search_console_overview.sql

begin;

-- Stub active_company_id() to the fixture company for this transaction only.
-- The original definition is restored by the ROLLBACK at the end.
create or replace function public.active_company_id() returns uuid
language sql stable as $$ select '00000000-0000-4000-8000-00000000c0f1'::uuid $$;

do $test$
declare
  co    uuid := '00000000-0000-4000-8000-00000000c0f1';
  other uuid := '00000000-0000-4000-8000-00000000c0f2';
  site  text := 'https://test.example/';
  o     jsonb;
  r     record;
  out   text := E'\n';
  d     date;
begin
  -- Fixture: 6 days for the fixture company ending 2026-09-08, and 2 rows for
  -- another company in the same window (must never surface).
  -- Current window (3 days): 09-06..09-08. Prior window: 09-03..09-05.
  for d in select generate_series(date '2026-09-03', date '2026-09-08', interval '1 day') loop
    insert into public.search_console_site_daily
      (company_entity_id, site_url, day_date, clicks, impressions, position,
       query_rows, query_attributed_clicks, page_rows, page_attributed_clicks)
    values (co, site, d,
      case when d >= date '2026-09-06' then 100 else 50 end,           -- clicks: cur 300, prior 150
      case when d >= date '2026-09-06' then 1000 else 1000 end,        -- impressions: cur 3000, prior 3000
      case when d = date '2026-09-08' then 4.0 else 8.0 end,           -- position: weighted test
      case when d = date '2026-09-07' then 5000 else 4000 end,         -- one 5,000-row day in cur
      case when d = date '2026-09-06' then null                        -- one UNMEASURED day in cur
           when d >= date '2026-09-06' then 57 else 30 end,
      10, case when d >= date '2026-09-06' then 100 else 50 end);
  end loop;
  insert into public.search_console_site_daily
    (company_entity_id, site_url, day_date, clicks, impressions, query_attributed_clicks)
  values (other, site, date '2026-09-08', 999999, 999999, 1),
         (other, site, date '2026-09-07', 999999, 999999, 1);

  -- Pages: A present both windows, B only current, C prior with 0 clicks.
  insert into public.search_console_page_daily (company_entity_id, site_url, day_date, page, clicks, impressions, position) values
    (co, site, '2026-09-08', 'https://test.example/a', 60, 600, 3.0),
    (co, site, '2026-09-07', 'https://test.example/a', 40, 400, 6.0),
    (co, site, '2026-09-04', 'https://test.example/a', 50, 500, 5.0),
    (co, site, '2026-09-08', 'https://test.example/b', 30, 300, 2.0),
    (co, site, '2026-09-08', 'https://test.example/c', 10, 100, 9.0),
    (co, site, '2026-09-04', 'https://test.example/c', 0,  100, 9.0),
    (other, site, '2026-09-08', 'https://test.example/zzz', 999999, 999999, 1.0);
  insert into public.search_console_query_daily (company_entity_id, site_url, day_date, query, clicks, impressions, position) values
    (co, site, '2026-09-08', 'alpha', 70, 700, 2.0),
    (co, site, '2026-09-05', 'alpha', 35, 350, 4.0),
    (co, site, '2026-09-08', 'beta',  20, 200, 5.0),
    (other, site, '2026-09-08', 'zzz', 999999, 999999, 1.0);

  o := public.search_console_overview(3, null);

  -- 1. window anchored on the newest ingested day, prior adjacent and same length
  out := out || case when (o->'window'->>'end') = '2026-09-08' and (o->'window'->>'start') = '2026-09-06'
                      and (o->'window'->>'prior_end') = '2026-09-05' and (o->'window'->>'prior_start') = '2026-09-03'
                     then 'PASS' else 'FAIL' end
      || ' — window ends on the newest ingested day; prior is adjacent and equal length' || E'\n';
  out := out || case when (o->'freshness'->>'max_day') = '2026-09-08' and (o->'freshness'->>'min_day') = '2026-09-03'
                     then 'PASS' else 'FAIL' end
      || ' — freshness reports min/max ingested day' || E'\n';

  -- 2. company scoping: the other company's 999,999s never surface
  out := out || case when (o->'current'->>'clicks')::bigint = 300 and (o->'current'->>'impressions')::bigint = 3000
                     then 'PASS' else 'FAIL — clicks ' || (o->'current'->>'clicks') end
      || ' — totals are the fixture company''s alone (300 clicks / 3,000 impressions)' || E'\n';

  -- 3. pooled ctr and impression-weighted position
  --    ctr = 300/3000 = 0.1 ; position = (4*1000 + 8*1000 + 8*1000)/3000 = 6.67
  out := out || case when (o->'current'->>'ctr')::numeric = 0.1 then 'PASS' else 'FAIL' end
      || ' — ctr is pooled (0.1)' || E'\n';
  out := out || case when (o->'current'->>'position')::numeric = 6.67 then 'PASS' else 'FAIL — ' || (o->'current'->>'position') end
      || ' — position is impression-weighted (6.67)' || E'\n';

  -- 4. unattributed share over MEASURED days only; one day unmeasured
  --    measured days 09-07 and 09-08: clicks 200, attributed 114 -> 0.43
  out := out || case when (o->'current'->>'unattributed_query_click_share') is null
                      and (o->'current'->>'unmeasured_days')::int = 1
                     then 'PASS' else 'FAIL — ' || (o->'current'->>'unattributed_query_click_share') end
      || ' — window share withheld when 1 day is unmeasured' || E'\n';

  -- 5. 5,000-row observations counted
  out := out || case when (o->'current'->>'query_5000_row_days')::int = 1 then 'PASS' else 'FAIL' end
      || ' — one day returning exactly 5,000 rows (not proof of a cap)' || E'\n';

  -- 6. prior totals present (150 clicks), and the series has 3 days
  out := out || case when (o->'prior'->>'clicks')::bigint = 150 and jsonb_array_length(o->'series') = 3
                     then 'PASS' else 'FAIL' end
      || ' — prior totals and a 3-day series' || E'\n';

  -- 7. top pages: A both windows, B not returned prior, C prior 0 -> pct null
  select * into r from public.search_console_top_pages(3, null, 10) where page = 'https://test.example/a';
  out := out || case when r.clicks = 100 and r.prior_clicks = 50 and r.clicks_change = 50 and r.clicks_change_pct = 1.0
                      and r.position = 4.2 and r.page_path = '/a'
                     then 'PASS' else 'FAIL' end
      || ' — page A: cur 100 vs prior 50 (+100%), weighted position 4.2, page_path /a' || E'\n';
  select * into r from public.search_console_top_pages(3, null, 10) where page = 'https://test.example/b';
  out := out || case when r.clicks = 30 and r.prior_clicks is null and r.clicks_change is null and r.clicks_change_pct is null
                     then 'PASS' else 'FAIL' end
      || ' — page B: no prior row -> prior NULL (not returned), not 0' || E'\n';
  select * into r from public.search_console_top_pages(3, null, 10) where page = 'https://test.example/c';
  out := out || case when r.prior_clicks = 0 and r.clicks_change = 10 and r.clicks_change_pct is null
                     then 'PASS' else 'FAIL' end
      || ' — page C: prior 0 clicks -> change +10, percent NULL (no division by zero)' || E'\n';
  out := out || case when not exists (select 1 from public.search_console_top_pages(3, null, 10) where page like '%zzz%')
                     then 'PASS' else 'FAIL' end
      || ' — the other company''s page never surfaces' || E'\n';

  -- 8. top queries: alpha both windows, beta not returned prior
  select * into r from public.search_console_top_queries(3, null, 10) where query = 'alpha';
  out := out || case when r.clicks = 70 and r.prior_clicks = 35 and r.clicks_change_pct = 1.0 then 'PASS' else 'FAIL' end
      || ' — query alpha: 70 vs 35 (+100%)' || E'\n';
  select * into r from public.search_console_top_queries(3, null, 10) where query = 'beta';
  out := out || case when r.prior_clicks is null and r.clicks_change is null then 'PASS' else 'FAIL' end
      || ' — query beta: not returned in prior -> NULL' || E'\n';

  -- 9. a window with no prior rows returns prior = null (not an object of zeros)
  o := public.search_console_overview(30, null);
  out := out || case when (o->'prior') is null or jsonb_typeof(o->'prior') = 'null' then 'PASS' else 'FAIL' end
      || ' — prior is NULL when the prior window has no rows' || E'\n';

  -- 10. an explicit p_end past the data still reports days_present honestly
  o := public.search_console_overview(3, date '2026-09-30');
  out := out || case when (o->'current'->>'days_present')::int = 0 and (o->'window'->>'end') = '2026-09-30' then 'PASS' else 'FAIL' end
      || ' — a window beyond the data has 0 days present, not zeros dressed as data' || E'\n';

  -- Unequal daily denominators: a window share is not a mean of percentages.
  update public.search_console_site_daily set clicks = 1000, query_attributed_clicks = 570
    where company_entity_id = co and day_date = '2026-09-06';
  update public.search_console_site_daily set query_attributed_clicks = 10, query_rows = 5000
    where company_entity_id = co and day_date = '2026-09-07';
  update public.search_console_site_daily set query_rows = 6000
    where company_entity_id = co and day_date = '2026-09-08';
  o := public.search_console_overview(3, null);
  out := out || case when (o->'current'->>'unattributed_query_click_share')::numeric = 0.4692
    and (o->'current'->>'query_5000_row_days')::int = 1 then 'PASS' else 'FAIL' end
    || ' — pooled coverage and exactly-5000 observation (6000 is not mislabeled)' || E'\n';
  update public.search_console_site_daily set is_truncated = true
    where company_entity_id = co and day_date = '2026-09-07';
  o := public.search_console_overview(3, null);
  out := out || case when (o->'current'->>'unattributed_query_click_share') is null
    and (o->'current'->>'page_attributed_share') is null then 'PASS' else 'FAIL' end
    || ' — locally truncated days withhold coverage ratios' || E'\n';

  -- A second property in the same company must not inflate totals.
  insert into public.search_console_site_daily
    (company_entity_id, site_url, day_date, clicks, impressions)
  values (co, 'sc-domain:test.example', '2026-09-08', 999999, 999999);
  o := public.search_console_overview(3, null);
  out := out || case when (o->'freshness'->>'property_count')::int = 2
    and (o->'current'->>'clicks') is null
    and not exists(select 1 from public.search_console_top_pages(3, null, 10))
    and not exists(select 1 from public.search_console_top_queries(3, null, 10))
    then 'PASS' else 'FAIL' end || ' — ambiguous properties withheld' || E'\n';

  raise exception using message = out;
end $test$;

rollback;
