-- 20260910200000_search_console_query_cap_caveat.sql
-- ---------------------------------------------------------------------------
-- The first full backfill (2026-09-10, 498 days in 18 chunks) showed a limit
-- the probe could not: nine 28-day chunks returned EXACTLY 140,000 query rows
-- (28 x 5,000) and the 22-day tail returned exactly 110,000 (22 x 5,000).
-- Google caps the query cut at ~5,000 rows per day. The probe's recent
-- window sat under it (~4,500/day), so it measured only the anonymisation.
-- The sync's page guard never fired, because the API returns a short final
-- page at the cap -- which is indistinguishable from completeness, exactly
-- the point review made on PR #666.
--
-- What does NOT change: the per-day unattributed share on the site row is
-- total clicks minus RETURNED clicks, whichever reason rows are missing, so
-- it was honest all along. What changes is the stated CAUSE (anonymised OR
-- beyond the per-day row limit) and a named signal: a day whose query_rows is
-- exactly 5,000 hit the cap, and its query list is a top-N slice.
--
-- Appended, guarded on a marker, never `set description = ...`.
-- ---------------------------------------------------------------------------

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' PER-DAY ROW CAP: besides anonymisation, the Search Analytics API returns at '
  'most about 5,000 query rows per day (observed 2026-09-10: nine 28-day '
  'backfill chunks came back at exactly 28 x 5,000 rows). On days with more '
  'distinct queries than that, this table holds the TOP 5,000 by clicks and '
  'the rest are cut off silently. Read query_rows on search_console_site_daily '
  'for the day: exactly 5,000 means the day hit the cap and a query absent '
  'that day may simply have fallen below the cut. The unattributed share on '
  'the site row already counts both causes (it is total minus RETURNED '
  'clicks), so cite it as "clicks belonging to no returned query row", not '
  'as "anonymised clicks".',
    updated_at = now()
where relname = 'search_console_query_daily'
  and coalesce(description, '') not like '%PER-DAY ROW CAP%';

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' PER-DAY ROW CAP: query_rows at exactly 5,000 means that day hit the Search '
  'Analytics API''s per-day row limit for the query cut (observed on the '
  '2026-09-10 backfill), so search_console_query_daily holds a TOP-5,000 slice '
  'for that day and unattributed_query_clicks includes clicks cut off by the '
  'limit as well as anonymised ones. The share stays honest -- it is total '
  'minus returned -- but describe it as "not returned", never as "anonymised" '
  'alone. Recent days (~4,500 rows) sit under the cap; busier historical '
  'days do not.',
    updated_at = now()
where relname = 'search_console_site_daily'
  and coalesce(description, '') not like '%PER-DAY ROW CAP%';
