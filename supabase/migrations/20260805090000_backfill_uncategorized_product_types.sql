-- Backfill: reclassify the two dominant "Uncategorized" buckets on
-- sales_by_day (Package Protection add-on + promo bundle/mystery-pack SKUs).
-- These are synthetic line items that never existed as real Shopify catalog
-- products, so they never got a product_type from the sync -- they don't
-- need a Shopify-side catalog fix, they need this explicit classification.
-- Idempotent: only touches rows where product_type is still null/blank, so
-- safe to re-run (matches new incoming rows the sync's own fallback misses,
-- e.g. spelling variants). See scripts/lib/shopify-sync-core.mjs
-- inferFallbackProductType() for the equivalent logic applied to new syncs.

UPDATE public.sales_by_day
SET product_type = 'Package Protection'
WHERE (product_type IS NULL OR trim(product_type) = '')
  AND lower(trim(sku)) = 'x-redo';

UPDATE public.sales_by_day
SET product_type = 'Bundles & Multi-Packs'
WHERE (product_type IS NULL OR trim(product_type) = '')
  AND (
    sku ILIKE '%bundle%' OR product_name ILIKE '%bundle%'
    OR sku ILIKE '%combo%' OR product_name ILIKE '%combo%'
    OR sku ILIKE '%mysterybox%' OR product_name ILIKE '%mystery box%' OR product_name ILIKE '%mystery pack%'
    OR sku ILIKE '%archivetoppack%' OR sku ILIKE '%archiveshortspack%'
    OR product_name ILIKE '%archive top pack%' OR product_name ILIKE '%archive shorts pack%'
    OR product_name ~* 'for \$\d'
  );
