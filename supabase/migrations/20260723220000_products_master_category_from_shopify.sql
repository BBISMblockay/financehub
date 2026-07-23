-- One-time correction: category now mirrors Shopify's product_type going
-- forward (see runCatalogSync in scripts/lib/shopify-sync-core.mjs). Bring
-- existing rows in line immediately rather than waiting for the next sync,
-- superseding the product_tags-derived category values from the prior
-- legacy backfill (20260723190000) -- Shopify is the authority now.
-- Safe to re-run (no-op once converged).

update public.products_master
set category = product_type
where category is distinct from product_type;
