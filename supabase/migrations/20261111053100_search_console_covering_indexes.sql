-- Search Console detail tables: covering indexes for date-window reads, and
-- vacuum settings that keep them index-only.
--
-- WHY. SEO Performance's Pages and Search queries parts (and their tie-outs)
-- sum every detail row in the window. For Baseballism a 28-day window is
-- ~103k query rows and ~59k page rows, read through the
-- (company_entity_id, day_date desc) index and then FETCHED FROM THE HEAP:
-- search_console_query_daily is 2.9M rows / 1.7 GB and the nightly sync
-- re-upserts the trailing 31 days, so a window's rows sit ~3.5 per heap page,
-- and the query part alone touches ~52k buffers (cur + prior). Measured on
-- production 2026-11-11 as a Baseballism admin through chat_run_readonly_query:
--   Pages          4.06 s cold   0.41 s warm
--   Search queries 6.75 s cold   0.47 s warm
-- `authenticated` has 8 s, so the default window passes only when the pages
-- happen to be cached, and any longer window (90 days is three times the rows)
-- times out.
--
-- WHAT. One index per table keyed (company_entity_id, day_date) -- the RLS
-- predicate and the window -- that INCLUDES every column the report reads,
-- so the window becomes a contiguous index-only range instead of scattered
-- heap pages. Estimated from pg_stats widths: ~110 B per query entry and
-- ~250 B per page entry, so a 28-day window is ~1.5k + ~2k index pages against
-- ~29k + ~25k heap pages today. Cost: roughly 330 MB + 410 MB of disk (the
-- database is 10 GB) and a little write amplification on the nightly upsert.
-- Purely additive: no query, view, report, policy or grant changes, so every
-- report row and every tie-out fingerprint is unchanged.
--
-- An index-only scan skips the heap only on pages the visibility map marks
-- all-visible, and the nightly sync rewrites exactly the newest month. At the
-- default autovacuum_vacuum_scale_factor (0.2) these tables needed ~590k dead
-- rows before a vacuum: search_console_page_daily has NEVER been autovacuumed
-- and search_console_query_daily last was 2026-11-05. 0.01 (~29k rows for the
-- query table) makes autovacuum follow each nightly sync.
--
-- APPLYING. `create index` (not CONCURRENTLY, which cannot run inside the
-- transaction a migration file runs in) blocks WRITES to the table -- not
-- reads -- while it builds, about a minute on production. Apply outside the
-- 10:30-12:00 UTC sync window; a sync that does arrive simply waits. The same
-- statements can be run first with CREATE INDEX CONCURRENTLY, one per run, and
-- `if not exists` then makes this file a no-op for them (the 20260925130000
-- precedent).
create index if not exists search_console_query_daily_co_day_cover_idx
  on public.search_console_query_daily (company_entity_id, day_date)
  include (site_url, query, clicks, impressions, position);

create index if not exists search_console_page_daily_co_day_cover_idx
  on public.search_console_page_daily (company_entity_id, day_date)
  include (site_url, page, page_path, clicks, impressions, position);

alter table public.search_console_query_daily set (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.02
);
alter table public.search_console_page_daily set (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.02
);
