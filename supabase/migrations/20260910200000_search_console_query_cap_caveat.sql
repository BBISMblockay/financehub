-- Clarify observed backfill counts without claiming an undocumented API cap.
-- No local truncation means pagination exhausted offered rows, not all Google data.
-- Google documents 50,000 rows/day/search type, but no complete row guarantee.
-- https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' QUERY ROW OBSERVATION: the 2026-09-10 backfill returned 140,000 query rows '
  'in several 28-day chunks and 110,000 in a 22-day chunk. A 5,000-row daily '
  'average is an observed pattern, NOT A CONFIRMED CAP. Even a day with exactly '
  '5,000 rows does not establish truncation or a top-5,000 ranking. Google '
  'documents up to 50,000 rows per day per search type, without guaranteeing '
  'all rows. Missing queries may be anonymised or omitted by internal limits; '
  'the cause of any missing row is unknown. No local truncation means the '
  'walk exhausted rows Google offered, not rows it withheld. Describe the '
  'unattributed share as clicks with no returned query row, not anonymised '
  'clicks alone. For a window use sums on the SAME company, property and dates '
  '(sum(unattributed_query_clicks)/nullif(sum(clicks),0)), never average daily '
  'percentages. Withhold the window share if any included day is unmeasured '
  'or locally truncated.',
    updated_at = now()
where relname in ('search_console_query_daily', 'search_console_site_daily')
  and coalesce(description, '') not like '%QUERY ROW OBSERVATION%';
