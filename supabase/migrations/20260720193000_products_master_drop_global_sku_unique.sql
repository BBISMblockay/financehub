-- ============================================================
-- Drop the legacy global-unique-by-sku indexes on products_master.
--
-- products_master_sku_uq / products_master_sku_uidx predate the
-- multi-tenant model and enforced "sku is unique across every company,"
-- which is wrong now: two different companies (e.g. Baseballism and a
-- test/future client) can legitimately have overlapping SKU strings in
-- their own separate catalogs. The correct invariant is
-- products_master_company_sku_key UNIQUE (company_entity_id, sku),
-- added in 20260720190000_products_master_sku_unique.sql, which RLS
-- (products_master_active_select/write, company_entity_id =
-- active_company_id()) already scopes reads/writes by.
--
-- Verified before writing this: nothing references products_master.sku
-- via foreign key (all FKs point at products_master.id), so dropping
-- these is safe -- no referential integrity depends on sku alone being
-- unique.
-- ============================================================

DROP INDEX IF EXISTS public.products_master_sku_uq;
DROP INDEX IF EXISTS public.products_master_sku_uidx;
