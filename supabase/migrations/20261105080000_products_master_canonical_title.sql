-- One canonical product title everywhere, not just in the reports.
--
-- 20261104193000 made the SALES rollup resolve one title per (company, sku)
-- from shopify_product_skus, preferring the published store's copy. It left
-- products_master.product_title alone, and that column is what the Catalog
-- tab, the PO builder, the launch-calendar product picker, SEO Studio and the
-- v3 report builder read. So a product can still be called one thing in a
-- report and another in the tool you act on it with.
--
-- Measured on production 2026-11-05, before this ran:
--
--   company                               skus with canonical   title differs
--   3bd934c9-4cdd-429b-9076-f8f6b45d4eb7               20,934           1,194
--   549324ed-6e36-45c9-bf7b-b9dbb253d6fc                3,567              48
--   b95f2822-0af7-4019-82ec-557b356ae9c0                2,674               9
--   cd1b9ba2-5cf7-46e5-8307-2e6bf1a2ed7c                1,706               8
--   6c31a540-1f16-4595-9abf-81c426e98bcb                  137               0
--
-- 1,259 SKUs across four companies, so this is not one tenant's problem.
--
-- WHY THE COLUMN AND NOT EACH READER: products_master is one row per (company,
-- sku) while a SKU can be published in several stores, so the Shopify sync's
-- upsert leaves whichever store synced last in the column. That is the defect.
-- Teaching five pages to resolve a title each would leave the stored value
-- wrong for the sixth reader nobody remembered, and for Ask SILO and anything
-- a customer builds on the table.
--
-- WHY THIS IS SAFE TO OVERWRITE: product_title is sync-owned. The Shopify
-- sync's own contract (scripts/lib/shopify-sync-core.mjs) keeps the human-owned
-- fields separate -- subcategory, department, tags and notes are edited in the
-- Catalog tab and the sync never touches them, while title, category, status
-- and published-at are Shopify's answer and are rewritten every run. Nothing in
-- SILO writes product_title from the UI. So this changes which STORE's copy of
-- a Shopify-owned title is stored, from "last to sync" to one deterministic
-- choice -- it does not overwrite anyone's edit.
--
-- The function is called at the end of the Shopify sync, after every store in
-- that run has upserted, and recomputes from shopify_product_skus (which holds
-- every shop), so it lands on the same answer whichever store happened to sync
-- last. Re-running it changes nothing.
--
-- Idempotent and safe to re-apply.

create or replace function public.apply_canonical_product_titles()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  -- The SAME resolution as sales_by_product_title_daily_mv (20261104193000):
  -- the published store's copy wins, and every tiebreak is total, so two runs
  -- over the same data cannot pick differently and move a title.
  with canonical_title as (
    select distinct on (ps.company_entity_id, ps.sku)
      ps.company_entity_id,
      ps.sku,
      ps.product_title
    from public.shopify_product_skus ps
    where ps.sku is not null
      and ps.product_title is not null
    order by
      ps.company_entity_id,
      ps.sku,
      (coalesce(ps.shopify_status, '') = 'active') desc,
      (ps.online_published_at is not null) desc,
      ps.last_seen_at desc nulls last,
      ps.shop_domain,
      ps.shopify_product_id desc
  )
  update public.products_master pm
     set product_title = ct.product_title,
         updated_at = now()
    from canonical_title ct
   where ct.company_entity_id = pm.company_entity_id
     and ct.sku = pm.sku
     -- Only a row whose title actually differs is written, so a no-op run
     -- touches nothing and does not move updated_at on 30,000 rows.
     and pm.product_title is distinct from ct.product_title;

  get diagnostics changed = row_count;
  return changed;
end $$;

comment on function public.apply_canonical_product_titles() is
  'Sets products_master.product_title to ONE canonical title per (company, sku) -- the published store''s copy from shopify_product_skus, resolved exactly as sales_by_product_title_daily_mv resolves it. Called at the end of the Shopify sync, after every store in the run has upserted, because products_master is one row per SKU across stores and the upsert otherwise leaves whichever store synced last. A SKU with no catalog row is left as it is, never blanked. Returns how many rows changed; a second run returns 0.';

revoke execute on function public.apply_canonical_product_titles() from public, anon, authenticated;
grant execute on function public.apply_canonical_product_titles() to service_role;

-- Bring the stored column into line now, so the Catalog tab is right before
-- the next sync rather than after it.
do $$
declare
  n integer;
begin
  n := public.apply_canonical_product_titles();
  raise notice 'apply_canonical_product_titles: % row(s) brought into line', n;
end $$;

-- Prove it took. A second call must find nothing left to change; if it does,
-- the resolution is not deterministic and this migration has moved titles
-- rather than settled them.
do $$
declare
  again integer;
begin
  again := public.apply_canonical_product_titles();
  if again <> 0 then
    raise exception 'apply_canonical_product_titles() is not stable: a second call changed % row(s)', again;
  end if;
end $$;
