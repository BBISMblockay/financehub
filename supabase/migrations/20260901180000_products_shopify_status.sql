-- Is this product actually live on the website?
--
-- Sammie has now asked this six different ways in the Ask SILO log --
-- "is there a category for Live products", "active producst we are selling vs
-- not active", "a status or visibility field (active, published,
-- storefront_visible, shopify_status)", "any other date/status field --
-- discontinued_date, archived_date" -- because she is trying to move stale
-- inventory and find the products whose page is still up but only has XL/2XL
-- left. Ask SILO kept saying no, and it was right to:
--
--   is_active         24,056 of 24,056 rows TRUE  -- a constant, not a signal
--   is_discontinued   0 of 24,056 TRUE            -- never set once
--   lifecycle_status  only 'Idea' / 'Ready for PO' -- the PO pipeline, not the storefront
--
-- created_at is NOT a workaround for it either, which matters because it looks
-- like one: 12,121 rows are stamped 2026-04-28 and 11,514 are stamped
-- 2026-07-20 -- 98% of the catalog on two bulk-load dates. It records when
-- SILO first saw the row, not when Shopify created the product, so "products
-- created in the last 120 days" returns the July backfill and reads as a
-- brand-new catalog.
--
-- Shopify has the real answer and the sync ALREADY FETCHES IT. runCatalogSync
-- pulls products.json once per status (active, archived, draft) and holds the
-- whole product object at the line where it builds each row -- it simply never
-- wrote status or published_at down. This adds the two columns; the sync
-- change is one line each.
--
-- SYNC-OWNED, DELIBERATELY SEPARATE FROM is_active. The catalog sync's own
-- contract is that it "never touches the human-curated merchandising fields",
-- so these are new columns rather than a backfill of is_active: Shopify owns
-- these two, a person owns is_active/lifecycle_status, and neither overwrites
-- the other. Reusing is_active would have the nightly sync silently reverse a
-- merchandiser's edit.
--
-- online_published_at is Shopify's published_at, which for a single-storefront
-- shop means published to the Online Store channel -- so "live on the site" is
-- shopify_status = 'active' AND online_published_at IS NOT NULL. With several
-- sales channels the fully authoritative source is the product_publications
-- resource, which this does not fetch; the column comment says so rather than
-- letting a reader assume more precision than it has.

alter table public.products_master
  add column if not exists shopify_status      text,
  add column if not exists online_published_at timestamptz;

comment on column public.products_master.shopify_status is
  'Shopify product status: active | draft | archived. Written by runCatalogSync from the product object it already fetches -- NOT the same as is_active, which is human-owned and currently true on every row. Null until the next catalog sync runs.';

comment on column public.products_master.online_published_at is
  'Shopify published_at -- when the product was published to the online store; null means unpublished. "Live on the website" is shopify_status = ''active'' AND online_published_at IS NOT NULL. For a multi-channel shop the authoritative source is product_publications, which the sync does not fetch, so treat this as the online-store publication rather than a per-channel answer.';

create index if not exists products_master_shopify_status_idx
  on public.products_master (company_entity_id, shopify_status)
  where shopify_status is not null;

-- Tell Ask SILO the columns exist and what they mean, so the next person to
-- ask gets the field instead of six rounds of "no such thing". The catalog is
-- where schema meaning belongs -- never hand-typed into the edge function.
update public.silo_chat_schema_catalog
   set description = coalesce(description,'') ||
       case when coalesce(description,'') = '' then '' else ' ' end ||
       'Storefront status lives in shopify_status (active|draft|archived) and online_published_at, both written by the Shopify catalog sync. A product is LIVE ON THE WEBSITE when shopify_status = ''active'' and online_published_at is not null. Do NOT use is_active (true on every row), is_discontinued (never set) or lifecycle_status (''Idea''/''Ready for PO'' -- the PO pipeline) to answer whether a product is on the site, and do NOT use created_at as a proxy for catalog age: 98% of rows carry one of two bulk-load dates.'
 where relname = 'products_master'
   and coalesce(description,'') not like '%shopify_status%';
