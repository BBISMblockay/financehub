-- On Deck scans 500 catalog rows per page. Without this lookup index the
-- inventory lateral aggregate scans the entire current snapshot for EACH SKU.
-- Live baseline: 14.52s for 500 rows; indexed: 0.48s (8s API timeout).
-- This index does not alter whole-product grouping, evidence, or tenant filters.
set local lock_timeout = '2s';
create index if not exists inventory_on_hand_current_mv_company_sku_idx
  on public.inventory_on_hand_current_mv (company_entity_id, variant_sku);
