-- Trigram indexes for title/SKU substring search on shopify_order_lines.
--
-- Same disease, third table: Ask SILO's MLB lockout-exposure question
-- (2026-08-22) needed licensed-vs-non-licensed revenue share from
-- shopify_order_lines via title ilike matching, and the query timed out
-- repeatedly -- 705K rows, no index that can serve a leading-wildcard
-- ILIKE, full sequential scan into the 10s chat statement_timeout. The
-- sales_by_day (20260820130000) and inventory_on_hand (20260820140000)
-- trigram indexes fixed exactly this for those tables; shopify_order_lines
-- is the one big name-searchable table that was still uncovered, and it's
-- the fastest-growing table in the schema (one row per order line).
--
-- Plain CREATE INDEX, not CONCURRENTLY, so this stays runnable inside the
-- SQL editor / apply_all_post_merge.sql transaction. The build briefly
-- blocks writes; only the nightly Shopify sync (08:30 UTC) and manual
-- backfills write this table, so applying at any other time is safe.

create extension if not exists pg_trgm with schema extensions;

create index if not exists shopify_order_lines_title_trgm_idx
  on public.shopify_order_lines using gin (title extensions.gin_trgm_ops);

create index if not exists shopify_order_lines_sku_trgm_idx
  on public.shopify_order_lines using gin (sku extensions.gin_trgm_ops);
