-- 20260910190000_search_console_page_absence_caveat.sql
-- ---------------------------------------------------------------------------
-- Forward-corrective. 20260910180000 was already applied to production when
-- review of PR #666 found that its catalog text for search_console_page_daily
-- taught Ask SILO the one inference this whole project exists to forbid:
--
--   "COMPLETE on clicks ... so a page with no row on a day genuinely had no
--    search clicks and no impressions that day"
--
-- That is wrong. The probe's 102.8% is an AGGREGATE over 28 days: the page
-- cut recovered at least the site total IN SUM. It says nothing about any
-- individual row, and Google's documentation states that the Search
-- Analytics API does not guarantee every row is returned, even when paging.
-- A page absent from the returned data is "not in the returned data" -- the
-- same absence-is-not-zero rule shopify_landing_pages_daily carries, and
-- the same class of error (a negative claim from a partial list) that
-- produced the false "these collections don't exist" answer on 2026-09-08.
--
-- The site row's text carried a softer version of the same claim ("Page
-- attribution is complete on clicks"). Both are corrected here by replacing
-- the specific wrong sentence, not the whole description, so any text
-- appended by a later migration survives. Idempotent: a second run finds
-- nothing to replace.
-- ---------------------------------------------------------------------------

update public.silo_chat_schema_catalog
set description = replace(description,
  'COMPLETE on clicks (the page cut recovered 102.8% of site clicks when '
  'measured) -- so a page with no row on a day genuinely had no search '
  'clicks and no impressions that day, PROVIDED the day is inside the '
  'ingested range (check search_console_site_daily for the day first).',
  'ABSENCE IS NOT ZERO: Google does not guarantee that every row is '
  'returned by the Search Analytics API, even with pagination, so a page '
  'with no row on a day is "not in the returned data" and NEVER "had no '
  'search clicks". The page cut recovered 102.8% of site clicks IN '
  'AGGREGATE over 28 days when measured (2026-09-10) -- evidence that little '
  'is missing in sum, not a per-row guarantee. Before reading any page''s '
  'absence: check search_console_site_daily for that day (no site row = the '
  'day is not ingested), then compare that day''s page_attributed_clicks to '
  'clicks to see how much of the day the page rows account for, and say so.'),
    updated_at = now()
where relname = 'search_console_page_daily'
  and description like '%genuinely had no search clicks%';

update public.silo_chat_schema_catalog
set description = replace(description,
  'Page attribution is complete on clicks (page_attributed_clicks ~= '
  'clicks), but page ',
  'Page attribution recovered ~100% of clicks IN AGGREGATE when measured '
  '(page_attributed_clicks ~= clicks) -- not a per-row guarantee, since '
  'Google does not promise every row is returned; a page absent from '
  'search_console_page_daily is not-returned, never zero. Page '),
    updated_at = now()
where relname = 'search_console_site_daily'
  and description like '%Page attribution is complete on clicks%';
