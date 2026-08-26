-- Sales at PRODUCT TITLE grain -- the missing rung on the ladder.
--
-- The schema jumps straight from SKU (20,453 variants) to product type
-- (129 categories) with nothing in between, but buying decisions are made
-- at product title (4,585): "how did the Bubbles and Doubles Youth Tee do"
-- is a question about a product, not about its Medium.
--
-- Until now every caller rebuilt the same
--   sales_by_day.sku -> products_master.sku -> product_title
-- join by hand. Ask SILO does it on nearly every concept-grounding pass,
-- and that join over 1.14M sales rows is a meaningful slice of the tool
-- time that has been pushing phase 2 into the edge gateway's 150s ceiling.
-- A silo_chat_notes row already tells the model to USE this grain
-- (2026-08-25); this gives it somewhere to read it from.
--
-- Grain: company x product_title x product_type x location_tag x day.
-- Kept at day+location rather than pre-aggregated to a window so it
-- answers both "units over any date range" and the retail-vs-DTC split
-- from one place.
--
-- Measured before building: 99.09% of the last 180 days' rows (97.9% of
-- units) join to products_master by (company_entity_id, sku), and the
-- unique index on that pair means the join cannot fan out. The 0.91% that
-- do not match are NOT dropped -- silently losing 2% of units is exactly
-- the class of bug launch_actuals_v's sku_source column exists to prevent.
-- They fall back to sales_by_day.product_name and are flagged by
-- title_source, so a caller can tell a resolved title from a fallback.
--
-- Why not sales_by_day.product_name alone: it equals products_master's
-- product_title on only 83.6% of matched rows, so grouping by it splits
-- one product across several spellings.
--
-- Plain view, not a materialized one, on purpose: security_invoker keeps
-- RLS scoping every read to the caller's active company (matviews cannot
-- do that -- see the open roadmap item), and there is no refresh to wire
-- into the nightly sync or to go stale between runs.
--
-- Caveat worth knowing before reading a top-sellers list off this: the
-- highest-unit "product" in a recent window is 'x-redo' (product_type
-- 'Package Protection'), the Redo checkout line item, not merchandise.
-- It is not filtered out here -- this view reports what sold; deciding
-- what counts as a product is the caller's judgment, not the data's.

create or replace view public.sales_by_product_title_daily_v
with (security_invoker = true) as
select
  s.company_entity_id,
  coalesce(pm.product_title, s.product_name)             as product_title,
  case when pm.sku is not null then 'products_master'
       else 'sales_fallback' end                         as title_source,
  coalesce(pm.product_type, s.product_type)              as product_type,
  s.location_tag,
  s.day_date,
  count(distinct s.sku)                                  as variant_skus,
  sum(s.total_quantity_sold)                             as units_sold,
  sum(s.total_orders)                                    as orders,
  sum(s.total_gross_sales)                               as gross_sales,
  sum(s.total_discounts)                                 as discounts,
  sum(s.total_refunds)                                   as refunds,
  sum(s.total_net_sales)                                 as net_sales
from public.sales_by_day s
left join public.products_master pm
  on pm.sku = s.sku
 and pm.company_entity_id = s.company_entity_id
group by 1, 2, 3, 4, 5, 6;

comment on view public.sales_by_product_title_daily_v is
  'Sales rolled up from SKU variants to product title, per location per day. The grain buying decisions are made at, and the one place the sales_by_day -> products_master title join is defined. title_source = ''sales_fallback'' means the SKU had no products_master row and the title came from sales_by_day.product_name (about 1% of rows) -- those are still counted, never dropped. SECURITY INVOKER, so RLS scopes it to the caller''s active company. Note ''x-redo'' (Package Protection) is the Redo checkout line item, not merchandise -- filter it when ranking real products.';

grant select on public.sales_by_product_title_daily_v to authenticated;
