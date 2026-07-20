-- ============================================================
-- Unique constraint on products_master(company_entity_id, sku)
-- so the nightly catalog sync (scripts/lib/shopify-sync-core.mjs
-- runCatalogSync) can upsert on conflict instead of duplicating rows.
--
-- Safe to apply: no duplicate (company_entity_id, sku) pairs exist as of
-- this migration (verified prior to writing it).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_master_company_sku_key'
  ) THEN
    ALTER TABLE public.products_master
      ADD CONSTRAINT products_master_company_sku_key UNIQUE (company_entity_id, sku);
  END IF;
END $$;
