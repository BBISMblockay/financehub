-- Trigram indexes for name/SKU substring search on inventory_on_hand.
--
-- Companion to 20260820130000_sales_by_day_trgm_search_indexes.sql: Ask
-- SILO's restock-style questions ("how many uncrustables should we
-- reorder") hit inventory alongside sales, and inventory_on_hand (3.5M
-- rows) had the same gap -- btree-only indexes that can't serve a
-- leading-wildcard ILIKE on product_title/variant_sku, so those scans ran
-- straight into chat_run_readonly_query's 10s statement timeout. Verified
-- post-index: `product_title ilike '%uncrustable%'` aggregates in ~70ms
-- via a bitmap scan on the trigram index.
--
-- Column names differ from sales_by_day on purpose (product_title /
-- variant_sku here vs product_name / sku there) -- match the table.
-- pg_trgm itself is installed by 20260820130000; this only adds indexes.
--
-- Already applied to production 2026-08-20 (built one at a time -- the
-- pair together exceeded the 60s tooling window; each alone fits).

create index if not exists inventory_on_hand_product_title_trgm_idx
  on public.inventory_on_hand using gin (product_title extensions.gin_trgm_ops);

create index if not exists inventory_on_hand_variant_sku_trgm_idx
  on public.inventory_on_hand using gin (variant_sku extensions.gin_trgm_ops);
