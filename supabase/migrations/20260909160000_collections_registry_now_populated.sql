-- The collections registry has a sync now, so its catalog description must
-- stop saying "NOT POPULATED YET".
--
-- 20260909120000 shipped that warning deliberately: an EMPTY registry read
-- as authoritative turns "not in the table" into "does not exist", which is
-- a worse version of the landing-page mistake it was built to prevent.
-- Removing the warning without replacing it would swap one wrong default
-- for another, so the replacement does not say "this table is now correct"
-- either -- it says how to CHECK, because the table is correct only for a
-- shop whose most recent run actually finished, and only as of when it did.
--
-- Caught in review of PR #634: the sync PR updated the landing-page
-- description and left this one stale.

update public.silo_chat_schema_catalog
set description =
  'THE REGISTRY OF WHICH SHOPIFY COLLECTION PAGES EXIST -- use this, never '
  'shopify_landing_pages_daily, to answer whether a collection or '
  '/collections/ URL exists. BEFORE ANY CLAIM THAT A COLLECTION IS MISSING, '
  'check shopify_collection_sync_runs for that shop: you need a row with '
  'completed_at set (a run that walked every page), and you must read how '
  'recent it is. No completed run means the registry is unsynced or '
  'mid-repair and proves nothing either way; a completed run from weeks ago '
  'proves what was true weeks ago. Say which. A row whose missing_since is '
  'set was absent from a completed run; a collection absent from the table '
  'entirely may simply never have synced. handle is the URL segment '
  '(/collections/{handle}) and is a lookup key, NOT identity -- a rename '
  'changes the handle and keeps the id, so join on shopify_collection_id '
  'scoped by company_entity_id + shop_domain. published_to_online_store is '
  'TRI-STATE: true = published, false = confirmed not published, NULL = '
  'UNKNOWN (publication could not be checked; see publication_error). Never '
  'read null as false. seo_title_override / seo_description_override hold '
  'OVERRIDES ONLY -- null means the collection inherits its title/description '
  'as the page SEO, which is normal and is NOT a missing-SEO defect.',
    updated_at = now()
where relname = 'shopify_collections';

update public.silo_chat_schema_catalog
set description =
  'Which products belong to which Shopify collection. shopify_product_id is '
  'Shopify''s NUMERIC id, matching products_master.shopify_product_id (both '
  'written since 2026-09-09) -- join on that, scoped by company_entity_id + '
  'shop_domain. Rows synced before the catalog sync backfilled '
  'products_master may not find a match yet, which is a coverage gap, not '
  'evidence the product is gone. Same completeness rule as '
  'shopify_collections: missing_since is only ever set by a run with '
  'completed_at.',
    updated_at = now()
where relname = 'shopify_collection_products';
