-- shopify_product_skus: the per-SHOP product <-> SKU mapping that
-- products_master structurally cannot hold.
--
-- WHY THIS EXISTS, measured rather than assumed (2026-09-09):
--
--   products_master is ONE ROW PER (company_entity_id, sku) -- 24,082 rows,
--   24,082 distinct pairs. Its shop_domain and shopify_product_id therefore
--   describe whichever store synced that SKU LAST. That is fine for the
--   merchandising fields it exists to carry, and wrong as a join key:
--
--     * 4,147 of 15,398 SKUs that have ever sold (26.9%) appear in MORE THAN
--       ONE shop; one appears in 14. For those, products_master's
--       shopify_product_id is decided by nightly sync ORDER, not by fact.
--     * Measured the morning this shipped, shopify_product_id was populated
--       on 9,868 rows and every one of them was baseballism.myshopify.com,
--       with zero for the other 18 shops -- an artefact of manual
--       single-shop test runs. A full nightly reassigns those rows, and
--       collection-join coverage moves without any underlying data changing.
--     * runCatalogSync additionally keeps only the FIRST variant per SKU
--       within a shop (`rowBySku.has(v.sku)`), so even within one store a
--       SKU carried by two products collapses to one.
--
-- Collection membership (shopify_collection_products) is per shop and
-- product-level. Joining it through products_master to reach sales or
-- inventory therefore silently drops rows for a quarter of the catalogue,
-- and the amount dropped changes night to night. That is the failure this
-- table removes: it is the grain the data actually has.
--
-- IDENTITY is the VARIANT, not the SKU. A variant belongs to exactly one
-- product and carries exactly one SKU, so (company, shop_domain,
-- shopify_variant_id) is the only key that never has to discard a row. SKU
-- is an attribute here, deliberately not unique.
--
-- THIS IS NOT A REGISTRY, and must not be read as one. Unlike
-- shopify_collections there is no completeness-gated run table behind the
-- catalog sync, so nothing here can prove a product was REMOVED from a shop
-- -- only that it has not been seen since last_seen_at. There is deliberately
-- no missing_since sweep: a sweep that cannot tell a partial fetch from a
-- deletion is the same absent-from-what-I-fetched-means-gone error the
-- collections work was built to avoid, and adding one without the gating
-- would look authoritative while being unfounded. Read last_seen_at and say
-- "not seen since", never "deleted".

create table if not exists public.shopify_product_skus (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  shop_domain         text not null,

  -- Shopify REST numeric ids, as text. The membership side stores the same
  -- dialect via shopifyNumericId(); a GID here would join to nothing while
  -- looking correct.
  shopify_product_id  text not null,
  shopify_variant_id  text not null,

  sku                 text,
  product_handle      text,
  product_title       text,
  variant_title       text,

  -- Per-SHOP storefront state. products_master carries one answer for the
  -- whole company; a product can be active in the main store and archived in
  -- wholesale, and that difference is exactly what a per-shop table is for.
  shopify_status      text,
  online_published_at timestamptz,

  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create unique index if not exists shopify_product_skus_identity
  on public.shopify_product_skus (company_entity_id, shop_domain, shopify_variant_id);

-- The collection-membership join: given a shop's product id, which SKUs.
create index if not exists shopify_product_skus_product
  on public.shopify_product_skus (company_entity_id, shop_domain, shopify_product_id);

-- The reverse: given a SKU (from sales or inventory), which products carry it.
create index if not exists shopify_product_skus_sku
  on public.shopify_product_skus (company_entity_id, sku);

-- Landing-page paths are /products/{handle}; this is what makes a traffic row
-- resolvable to real SKUs.
create index if not exists shopify_product_skus_handle
  on public.shopify_product_skus (company_entity_id, shop_domain, product_handle);

alter table public.shopify_product_skus enable row level security;

drop policy if exists shopify_product_skus_select on public.shopify_product_skus;
create policy shopify_product_skus_select on public.shopify_product_skus
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Written by the nightly catalog sync under the service role only. No client
-- write policy, same stance as shopify_collections.

comment on table public.shopify_product_skus is
  'Per-shop Shopify product <-> variant <-> SKU mapping, written by the '
  'catalog sync. Exists because products_master is one row per (company, sku) '
  'and so cannot represent a SKU that is a different product id in a '
  'different store -- true for 26.9% of SKUs that have sold. NOT a registry: '
  'no completeness gating, so absence means not-seen-since-last_seen_at, '
  'never deleted.';

-- ── The join, done once, correctly ──────────────────────────────────────────
-- LEFT JOIN on purpose: a collection product with no mapped SKU yet must show
-- up as a row with a null sku, not vanish. A disappearing row is
-- indistinguishable from a collection that genuinely has fewer products, and
-- that is the difference between "we cannot see this" and "this is not there".
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
  (ps.shopify_variant_id is null) as sku_unresolved
from public.shopify_collections c
join public.shopify_collection_products cp
  on  cp.company_entity_id     = c.company_entity_id
  and cp.shop_domain           = c.shop_domain
  and cp.shopify_collection_id = c.shopify_collection_id
left join public.shopify_product_skus ps
  on  ps.company_entity_id    = cp.company_entity_id
  and ps.shop_domain          = cp.shop_domain
  and ps.shopify_product_id   = cp.shopify_product_id
where c.missing_since is null
  and cp.missing_since is null;

comment on view public.shopify_collection_skus_v is
  'Collection -> product -> SKU, scoped by company AND shop. Read '
  'sku_unresolved before drawing any conclusion: true means the product has '
  'no mapping row yet (the catalog sync has not covered that shop since '
  'shopify_product_skus shipped), NOT that the product has no SKUs. Excludes '
  'rows the collections sync has marked missing_since.';

-- Seed the catalog so Ask SILO knows both objects exist and what they mean;
-- refresh_chat_schema_catalog() below fills in columns from pg_catalog.
insert into public.silo_chat_schema_catalog (relname, relkind, description, keywords, columns)
values
  ('shopify_product_skus', 'r',
   'Per-shop Shopify product/variant/SKU mapping from the catalog sync. USE '
   'THIS, not products_master.shopify_product_id, to join collection '
   'membership or landing-page handles to SKUs: products_master holds one row '
   'per (company, sku) so its shopify_product_id is whichever store synced '
   'last, and 26.9% of sold SKUs exist in more than one store. Identity is '
   'the VARIANT; sku is deliberately not unique here. NOT A REGISTRY -- there '
   'is no completeness-gated run table behind the catalog sync, so a product '
   'absent here has NOT BEEN SEEN since its last_seen_at, which is not '
   'evidence it was removed from the shop. Only shopify_collections (with a '
   'completed shopify_collection_sync_runs row) supports a "does not exist" '
   'claim.',
   array['shopify','product','sku','variant','mapping','collection','handle','join'],
   '[]'::jsonb),
  ('shopify_collection_skus_v', 'v',
   'Collection -> product -> SKU per shop, the intended way to ask what a '
   'Shopify collection actually contains and then reach sales or inventory by '
   'sku. ALWAYS check sku_unresolved: true means no mapping row exists for '
   'that product yet, so the collection has MORE products than this view can '
   'name -- never count resolved rows and report them as the collection size. '
   'Excludes rows marked missing_since by the collections sync.',
   array['collection','sku','product','shopify','membership','seo','merchandising'],
   '[]'::jsonb)
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

select public.refresh_chat_schema_catalog();
