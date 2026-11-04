-- One product, one title: stop a non-storefront catalog renaming a product in
-- every report.
--
-- WHAT WAS WRONG. sales_by_product_title_daily_mv resolved its title with
--
--     coalesce(pm.product_title, s.product_name)
--     ... left join products_master pm on pm.sku = s.sku
--
-- and products_master is UNIQUE (company_entity_id, sku) while runCatalogSync
-- runs ONCE PER SHOP CONNECTION. For any SKU carried by more than one store
-- the stored title is therefore whichever store synced LAST, and the order is
-- alphabetical by shop_domain (scripts/shopify-sync.mjs loadConnections()
-- `.order('shop_domain')`) -- which is not a statement about anything.
-- shopify-sync-core.mjs says so itself where it builds the per-shop variant
-- map: products_master "cannot in any case represent the same SKU being a
-- different product in another store -- measured at 26.9% of SKUs that have
-- ever sold".
--
-- Measured on production 2026-11-04. Baseballism's "Short Sleeve Youth Hoodie
-- - New York Yankees" (online product 7779394519110) is one product with four
-- youth sizes. Three of the four SKUs are also in the wholesale catalog, whose
-- draft product 14662555697519 spells it "Short Sleeve Hoodie Youth - New York
-- Yankees" (word order swapped), and wholesale sorts after the storefront, so
-- those three SKUs carried the wholesale wording. Every title-grouped report
-- then split one product in two: for 2025-11-19..2025-12-01, online, an
-- exact-title read returned 151 units / $5,796 gross, where the product
-- actually sold 430 units / $17,166 gross / $17,430.24 total sales. Both
-- numbers were "right" against their own query, which is the whole problem --
-- it is not a Shopify catalog duplicate, and there is nothing to merge in
-- Shopify. The order lines themselves never disagreed: all four SKUs were sold
-- under the storefront title in that window.
--
-- Scale, same measurement, sales since 2025-11-01: 1,901 SKUs that have sold
-- carry a products_master title the selling store does not use; 56 of 8,081
-- store-products were split across two or more titles.
--
-- THE FIX. Resolve the title per (company, sku) from the per-shop catalog map
-- shopify_product_skus -- which exists precisely because products_master
-- collapses a SKU across stores -- and prefer the store copy that is actually
-- published:
--
--     active before draft/archived, then published-at present, then most
--     recently seen, then shop_domain, then product id
--
-- Deliberately a title per SKU rather than per selling store. Resolving
-- per-store would be more "literal" and makes the within-store splitting
-- worse, not better: 796 SKUs that sold since 2025-11-01 are carried by two
-- stores that name them differently, so a company-wide "top products" read
-- would split 796 products to un-split 56. One canonical title per SKU keeps
-- every cross-store rollup whole.
--
-- No tenant-specific signal is used -- no shop name, no default_location_code
-- (free text, and set per-store by migration for one company). "Published in
-- Shopify" is a property every tenant's catalog carries. Measured effect on
-- Baseballism: store-products split across titles 56 -> 15; the residual 15
-- are products whose own SKUs are published in two stores that genuinely
-- disagree on the name, which no rule keyed on a single SKU can collapse.
-- products_master stays the fallback (8,361 of 562,520 sales rows since
-- 2025-11-01 resolve only through it) and sales_by_day.product_name stays the
-- last resort, still counted, never dropped -- same as before.
--
-- NOT CHANGED, on purpose: the select list, column order, column names, grain,
-- the two title_source values, the unique index, the day index, the grants,
-- the refresh function, and products_master itself. Callers -- six saved
-- reports, four tie-outs, the report-builder start-here list, Ask SILO's
-- schema catalog, product_type_profile and the SEO candidate function -- are
-- untouched. product_type still comes from products_master: shopify_product_skus
-- does not carry one.
--
-- HOW THIS IS APPLIED. A matview cannot be redefined in place, and two views
-- read this one (sales_by_product_title_daily_v, product_type_forecastable_v),
-- so the new rollup is BUILT FIRST under a temporary name and verified while
-- the live one still serves reads; the swap is then a drop + rename inside one
-- transaction, which is the only moment a read can fail. Both views are
-- recreated from their live definitions, character for character apart from
-- the comment.

set statement_timeout = '900s';

-- 1. Build the new rollup alongside the old one. ------------------------------
drop materialized view if exists public.sales_by_product_title_daily_mv_new;

create materialized view public.sales_by_product_title_daily_mv_new as
with canonical_title as (
  -- One title per (company, sku): the published store copy wins. distinct on
  -- needs every tiebreak to be total, or a refresh could pick differently from
  -- the same data and silently move numbers between titles.
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
select
  s.company_entity_id,
  coalesce(ct.product_title, pm.product_title, s.product_name) as product_title,
  case when ct.sku is not null or pm.sku is not null then 'products_master'
       else 'sales_fallback' end                               as title_source,
  coalesce(pm.product_type, s.product_type)                    as product_type,
  s.location_tag,
  s.day_date,
  count(distinct s.sku)                                        as variant_skus,
  sum(s.total_quantity_sold)                                   as units_sold,
  sum(s.total_orders)                                          as orders,
  sum(s.total_gross_sales)                                     as gross_sales,
  sum(s.total_discounts)                                       as discounts,
  sum(s.total_refunds)                                         as refunds,
  sum(s.total_net_sales)                                       as net_sales
from public.sales_by_day s
left join public.products_master pm
  on pm.sku = s.sku
 and pm.company_entity_id = s.company_entity_id
left join canonical_title ct
  on ct.sku = s.sku
 and ct.company_entity_id = s.company_entity_id
group by 1, 2, 3, 4, 5, 6;

-- Same two indexes, same NULLS NOT DISTINCT reasoning as the original: three
-- of the six grain columns are nullable, and a plain unique index both fails to
-- be unique over this grain and disqualifies REFRESH ... CONCURRENTLY.
create unique index sales_by_product_title_daily_mv_new_key
  on public.sales_by_product_title_daily_mv_new
     (company_entity_id, product_title, title_source, product_type, location_tag, day_date)
  nulls not distinct;

create index sales_by_product_title_daily_mv_new_day_idx
  on public.sales_by_product_title_daily_mv_new (company_entity_id, day_date);

analyze public.sales_by_product_title_daily_mv_new;

-- 2. Verify before swapping. --------------------------------------------------
-- The rollup must still be sales_by_day, only grouped differently: a title
-- rule that dropped or duplicated a row would move money, which is exactly
-- what this migration exists to stop.
do $$
declare
  s_qty numeric; s_ord numeric; s_gross numeric; s_disc numeric; s_ref numeric; s_net numeric;
  m_qty numeric; m_ord numeric; m_gross numeric; m_disc numeric; m_ref numeric; m_net numeric;
  n_rows bigint;
  n_null bigint;
begin
  select coalesce(sum(total_quantity_sold),0), coalesce(sum(total_orders),0),
         coalesce(sum(total_gross_sales),0), coalesce(sum(total_discounts),0),
         coalesce(sum(total_refunds),0), coalesce(sum(total_net_sales),0)
    into s_qty, s_ord, s_gross, s_disc, s_ref, s_net
    from public.sales_by_day;

  select coalesce(sum(units_sold),0), coalesce(sum(orders),0),
         coalesce(sum(gross_sales),0), coalesce(sum(discounts),0),
         coalesce(sum(refunds),0), coalesce(sum(net_sales),0), count(*)
    into m_qty, m_ord, m_gross, m_disc, m_ref, m_net, n_rows
    from public.sales_by_product_title_daily_mv_new;

  if (s_qty, s_ord, s_gross, s_disc, s_ref, s_net)
     is distinct from (m_qty, m_ord, m_gross, m_disc, m_ref, m_net) then
    raise exception
      'product-title rollup does not tie to sales_by_day: qty %/%, orders %/%, gross %/%, disc %/%, refunds %/%, net %/%',
      m_qty, s_qty, m_ord, s_ord, m_gross, s_gross, m_disc, s_disc, m_ref, s_ref, m_net, s_net;
  end if;

  if n_rows = 0 then
    raise exception 'product-title rollup built empty';
  end if;

  -- A null title would be a product nobody can name or filter. The old
  -- definition could only produce one if all three sources were null; so can
  -- this one, and it must not have started doing it more often.
  select count(*) into n_null
    from public.sales_by_product_title_daily_mv_new where product_title is null;
  if n_null > (select count(*) from public.sales_by_product_title_daily_mv where product_title is null) then
    raise exception 'product-title rollup produced % untitled rows, more than before', n_null;
  end if;

  raise notice 'product-title rollup verified: % rows, % units, % net', n_rows, m_qty, m_net;
end $$;

-- Titles must not fragment a product MORE than before. Counted over
-- store-products (a shop's own Shopify product) that have sold in the last
-- year, which is the grain a buyer reads a title at.
do $$
declare
  before_split bigint;
  after_split bigint;
begin
  with sold as (
    select distinct s.company_entity_id, s.shop_domain, s.sku
      from public.sales_by_day s
     where s.sku is not null
       and s.day_date >= current_date - 365
  ), prod as (
    select distinct ps.company_entity_id, ps.shop_domain, ps.shopify_product_id, ps.sku
      from public.shopify_product_skus ps
     where ps.sku is not null
  ), canonical_title as (
    select distinct on (ps.company_entity_id, ps.sku)
           ps.company_entity_id, ps.sku, ps.product_title
      from public.shopify_product_skus ps
     where ps.sku is not null and ps.product_title is not null
     order by ps.company_entity_id, ps.sku,
              (coalesce(ps.shopify_status, '') = 'active') desc,
              (ps.online_published_at is not null) desc,
              ps.last_seen_at desc nulls last,
              ps.shop_domain, ps.shopify_product_id desc
  ), g as (
    select p.company_entity_id, p.shop_domain, p.shopify_product_id,
           count(distinct pm.product_title) as old_titles,
           count(distinct ct.product_title) as new_titles
      from sold
      join prod p using (company_entity_id, shop_domain, sku)
      left join public.products_master pm
        on pm.company_entity_id = p.company_entity_id and pm.sku = p.sku
      left join canonical_title ct
        on ct.company_entity_id = p.company_entity_id and ct.sku = p.sku
     group by 1, 2, 3
  )
  select count(*) filter (where old_titles > 1),
         count(*) filter (where new_titles > 1)
    into before_split, after_split
    from g;

  if after_split > before_split then
    raise exception 'canonical title splits MORE products than products_master did (% -> %)',
      before_split, after_split;
  end if;
  raise notice 'store-products split across titles: % -> %', before_split, after_split;
end $$;

-- 3. Swap. The only window where a read can fail is this transaction. ---------
begin;

drop view if exists public.product_type_forecastable_v;
drop view if exists public.sales_by_product_title_daily_v;
drop materialized view if exists public.sales_by_product_title_daily_mv;

alter materialized view public.sales_by_product_title_daily_mv_new
  rename to sales_by_product_title_daily_mv;
alter index public.sales_by_product_title_daily_mv_new_key
  rename to sales_by_product_title_daily_mv_key;
alter index public.sales_by_product_title_daily_mv_new_day_idx
  rename to sales_by_product_title_daily_mv_day_idx;

comment on materialized view public.sales_by_product_title_daily_mv is
  'Stored form of sales_by_product_title_daily_v -- identical select list and grain, not a further aggregation. Exists because the unbounded reads (max(day_date) inside the Top products report, open-ended date_from on the Logistics tile) had to build the entire 700k-group rollup to answer, measured 6,890ms. The title is resolved per (company, sku) from shopify_product_skus, preferring the published store copy (active, then published-at present, then most recently seen), and falls back to products_master then sales_by_day.product_name -- products_master alone is one row per SKU across every store, so it carried whichever store synced last. Refreshed by refresh_sales_by_product_title_mv() at the end of the Shopify sync. READ THROUGH sales_by_product_title_daily_v, NEVER DIRECTLY: this carries no RLS and no grant, so a direct read raises 42501 and a granted one would leak across companies.';

-- No RLS on a matview, so the tenant filter lives in the definer-owned
-- wrapper, with the same predicate the SELECT policies on sales_by_day,
-- products_master and shopify_product_skus all carry.
revoke all on public.sales_by_product_title_daily_mv from public, anon, authenticated;

create view public.sales_by_product_title_daily_v
  with (security_invoker = false) as
select
  company_entity_id,
  product_title,
  title_source,
  product_type,
  location_tag,
  day_date,
  variant_skus,
  units_sold,
  orders,
  gross_sales,
  discounts,
  refunds,
  net_sales
from public.sales_by_product_title_daily_mv
where company_entity_id = public.active_company_id();

comment on view public.sales_by_product_title_daily_v is
  'Sales rolled up from SKU variants to product title, per location per day. The grain buying decisions are made at, and the one place the title join is defined. The title is ONE canonical title per (company, sku): the published store copy from shopify_product_skus (active, then published-at present, then most recently seen, then shop_domain, then product id), falling back to products_master.product_title and then sales_by_day.product_name. It is deliberately not the selling store''s own title -- 796 SKUs are published in two stores under different names, so a per-store title would split a product in company-wide rollups. title_source = ''sales_fallback'' means no catalog row resolved the SKU at all and the title came from sales_by_day.product_name -- those are still counted, never dropped. Reads sales_by_product_title_daily_mv, so it is as of the last Shopify sync rather than live; security_invoker = false with an explicit company_entity_id = active_company_id() filter, which is the same predicate the RLS policies on the base tables carry. Note ''x-redo'' (Package Protection) is the Redo checkout line item, not merchandise -- filter it when ranking real products.';

revoke all on public.sales_by_product_title_daily_v from anon;
grant select on public.sales_by_product_title_daily_v to authenticated;

-- Recreated unchanged; it only has to be dropped because it reads the matview.
create view public.product_type_forecastable_v
  with (security_invoker = false) as
 WITH co AS (
         SELECT active_company_id() AS cid
        ), sales AS (
         SELECT s_1.product_type,
            sum(s_1.units_sold) AS units_365d,
            max(s_1.day_date) AS last_sold_date
           FROM sales_by_product_title_daily_mv s_1,
            co
          WHERE s_1.company_entity_id = co.cid AND s_1.product_type IS NOT NULL AND s_1.day_date >= (silo_business_today() - 365)
          GROUP BY s_1.product_type
        ), stock AS (
         SELECT i.product_type,
            count(*)::integer AS inventory_rows,
            sum(i.total_available_quantity)::numeric AS on_hand
           FROM inventory_on_hand_current_mv i,
            co
          WHERE i.company_entity_id = co.cid AND i.product_type IS NOT NULL
          GROUP BY i.product_type
        ), purchased AS (
         SELECT l.product_type_snapshot AS product_type,
            count(*)::integer AS po_lines
           FROM po_lines l,
            co
          WHERE l.company_entity_id = co.cid AND l.product_type_snapshot IS NOT NULL
          GROUP BY l.product_type_snapshot
        )
 SELECT s.product_type,
    round(s.units_365d) AS units_365d,
    COALESCE(round(st.on_hand), 0::numeric) AS on_hand,
    COALESCE(st.inventory_rows, 0) AS inventory_rows,
    COALESCE(p.po_lines, 0) AS po_lines,
    s.last_sold_date,
    COALESCE(st.inventory_rows, 0) > 0 OR COALESCE(p.po_lines, 0) > 0 AS evidence_says_forecastable,
    pr.is_forecastable AS human_override,
    pr.classification_note,
    COALESCE(pr.is_forecastable, COALESCE(st.inventory_rows, 0) > 0 OR COALESCE(p.po_lines, 0) > 0) AS is_forecastable,
        CASE
            WHEN pr.is_forecastable IS NOT NULL THEN 'set by a person'::text
            WHEN COALESCE(st.inventory_rows, 0) > 0 THEN 'inventory-tracked'::text
            WHEN COALESCE(p.po_lines, 0) > 0 THEN 'has purchase history'::text
            ELSE 'sells but is not inventory-tracked and was never purchased'::text
        END AS reason,
    pr.is_forecastable IS NULL AND COALESCE(st.inventory_rows, 0) = 0 AND COALESCE(p.po_lines, 0) = 0 AS needs_review,
    pr.is_forecastable IS NOT NULL AND pr.is_forecastable <> (COALESCE(st.inventory_rows, 0) > 0 OR COALESCE(p.po_lines, 0) > 0) AS override_contradicts_evidence
   FROM sales s
     LEFT JOIN stock st ON st.product_type = s.product_type
     LEFT JOIN purchased p ON p.product_type = s.product_type
     LEFT JOIN product_type_profile pr ON lower(pr.product_type) = lower(s.product_type) AND pr.company_entity_id = (( SELECT co.cid
           FROM co));

comment on view public.product_type_forecastable_v is
  'Effective per-type forecastability: a human override where one exists, otherwise the evidence. Classification keys on the PRESENCE of an inventory row (inventory-tracked), never on summed quantity -- a sold-out or offsetting-location type is merchandise. security_invoker=false on purpose: po_lines RLS is narrower than company, so an invoker view would hand a non-admin a different classification than an admin.';

revoke all on public.product_type_forecastable_v from anon;
grant select on public.product_type_forecastable_v to authenticated;

commit;

-- 4. Prove the swap landed whole. --------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
begin
  if to_regclass('public.sales_by_product_title_daily_mv') is null then
    missing := missing || 'sales_by_product_title_daily_mv';
  end if;
  if to_regclass('public.sales_by_product_title_daily_v') is null then
    missing := missing || 'sales_by_product_title_daily_v';
  end if;
  if to_regclass('public.product_type_forecastable_v') is null then
    missing := missing || 'product_type_forecastable_v';
  end if;
  if to_regclass('public.sales_by_product_title_daily_mv_new') is not null then
    missing := missing || 'temporary matview still present';
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'swap incomplete: %', array_to_string(missing, ', ');
  end if;

  -- The matview must stay unreadable except through the wrapper.
  if has_table_privilege('authenticated', 'public.sales_by_product_title_daily_mv', 'select') then
    raise exception 'sales_by_product_title_daily_mv is readable by authenticated; the tenant filter would be bypassable';
  end if;
  if not has_table_privilege('authenticated', 'public.sales_by_product_title_daily_v', 'select') then
    raise exception 'sales_by_product_title_daily_v is not readable by authenticated; every report would 42501';
  end if;
  if not has_table_privilege('authenticated', 'public.product_type_forecastable_v', 'select') then
    raise exception 'product_type_forecastable_v is not readable by authenticated';
  end if;

  -- The refresh path the Shopify sync calls must still resolve.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'refresh_sales_by_product_title_mv'
  ) then
    raise exception 'refresh_sales_by_product_title_mv() is missing';
  end if;

  raise notice 'product-title rollup swapped: both views and the refresh function present';
end $$;
