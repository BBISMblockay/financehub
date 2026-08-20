-- Trigram indexes for name/SKU substring search on sales_by_day.
--
-- Ask SILO's product questions ("uncrustables restock", "sonic launch
-- history") generate `product_name ilike '%uncrustable%'`-style SQL, and the
-- BI Product Search page filters by SKU/name substring the same way. Only
-- btree indexes existed on sales_by_day (1.1M rows), and a btree cannot
-- serve a leading-wildcard ILIKE — every such query was a full sequential
-- scan. That blew through chat_run_readonly_query's 10s statement_timeout,
-- the model retried until it burned all 12 tool rounds, and the user saw
-- "A couple of these queries timed out..." (every error row in
-- silo_chat_audit_log has tool_rounds = 12; the failures reproduce on
-- immediate retry, so it was never a transient background-sync issue).
-- Trigram GIN indexes serve ILIKE '%...%' directly and close this.
--
-- Plain CREATE INDEX, not CONCURRENTLY, so this stays runnable inside the
-- SQL editor / apply_all_post_merge.sql transaction. The build briefly
-- blocks writes on sales_by_day (reads are unaffected); only the nightly
-- Shopify sync writes this table (08:30 UTC), so applying at any other
-- time of day is safe.

create extension if not exists pg_trgm with schema extensions;

create index if not exists sales_by_day_product_name_trgm_idx
  on public.sales_by_day using gin (product_name extensions.gin_trgm_ops);

create index if not exists sales_by_day_sku_trgm_idx
  on public.sales_by_day using gin (sku extensions.gin_trgm_ops);
