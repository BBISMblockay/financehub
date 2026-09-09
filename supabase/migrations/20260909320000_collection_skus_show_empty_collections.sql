-- Forward-corrective for 20260909200000, already applied.
--
-- shopify_collection_skus_v used a LEFT JOIN from product to SKU (so an
-- unmapped product stays visible) but an INNER JOIN from collection to
-- membership -- so a collection with NO products vanished from the view
-- entirely. That is the same absence-semantics mistake, one join further up:
-- an empty collection read as a collection that does not exist.
--
-- Measured after the first full multi-shop nightly (2026-09-09):
--   636 collections in the registry (missing_since null)
--   582 visible in the view
--    45 invisible because they have no membership rows
--    42 of those 45 are PUBLISHED TO THE ONLINE STORE
--
-- Forty-two live, published collection pages with nothing on them is exactly
-- the kind of thing this project exists to surface, and the view was hiding
-- all of them. It was found because Ask SILO answered "all 341 collections"
-- from the view while the registry held 349 -- the model reported the view
-- faithfully; the view was wrong.
--
-- TWO FLAGS, EACH MEANING ONE THING. Overloading a single "unresolved" flag
-- would merge two different facts that need different responses:
--   collection_is_empty -- the collection has no products at all. A
--                          merchandising/SEO question about the page.
--   sku_unresolved      -- the collection HAS a product but we have no SKU
--                          mapping for it yet. A sync-coverage question.
-- On an empty collection sku_unresolved is FALSE, because there is nothing to
-- resolve -- not "resolved". Read collection_is_empty first.

drop view if exists public.shopify_collection_skus_v;
create view public.shopify_collection_skus_v
with (security_invoker = true) as
select
  c.company_entity_id,
  c.shop_domain,
  c.shopify_collection_id,
  c.handle                as collection_handle,
  c.title                 as collection_title,
  c.published_to_online_store,
  c.products_count        as collection_products_count,
  cp.shopify_product_id,
  cp.position             as position_in_collection,
  ps.shopify_variant_id,
  ps.sku,
  ps.product_handle,
  ps.product_title,
  ps.variant_title,
  ps.shopify_status,
  ps.online_published_at,
  ps.last_seen_at         as sku_mapping_last_seen_at,
  -- A live page with nothing on it. Distinct from "we could not map its SKUs".
  (cp.shopify_product_id is null)                                    as collection_is_empty,
  -- Strictly: there IS a product here and no mapping row for it.
  (cp.shopify_product_id is not null and ps.shopify_variant_id is null) as sku_unresolved
from public.shopify_collections c
-- LEFT, with the missing_since filter moved INTO the join condition. Left in
-- the WHERE clause it would silently make this an inner join again and undo
-- the fix.
left join public.shopify_collection_products cp
  on  cp.company_entity_id     = c.company_entity_id
  and cp.shop_domain           = c.shop_domain
  and cp.shopify_collection_id = c.shopify_collection_id
  and cp.missing_since is null
left join public.shopify_product_skus ps
  on  ps.company_entity_id    = cp.company_entity_id
  and ps.shop_domain          = cp.shop_domain
  and ps.shopify_product_id   = cp.shopify_product_id
where c.missing_since is null;

comment on view public.shopify_collection_skus_v is
  'Collection -> product -> SKU, scoped by company AND shop. EVERY collection '
  'in the registry appears, including ones with no products: read '
  'collection_is_empty (a live page with nothing on it) separately from '
  'sku_unresolved (it has a product but no SKU mapping yet). On an empty '
  'collection sku_unresolved is false because there is nothing to resolve. '
  'Counting distinct collections here now matches the registry, so it is safe '
  'to answer "how many collections" from this view.';

update public.silo_chat_schema_catalog
set description =
  'Collection -> product -> SKU per shop, the intended way to ask what a '
  'Shopify collection actually contains and then reach sales or inventory by '
  'sku. TWO FLAGS, read both: collection_is_empty means the collection has NO '
  'products at all -- a live page with nothing on it, which is a real '
  'merchandising/SEO finding, not a data gap; sku_unresolved means it HAS a '
  'product but no SKU mapping row yet, which IS a sync-coverage gap, so the '
  'collection has more products than this view can name. On an empty '
  'collection sku_unresolved is false because there is nothing to resolve. '
  'Every registry collection appears here, so a distinct count of collections '
  'matches shopify_collections. Excludes rows marked missing_since.',
    updated_at = now()
where relname = 'shopify_collection_skus_v';

select public.refresh_chat_schema_catalog();
