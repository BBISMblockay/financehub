-- Proof that 20260827190000 fixed the velocity join. Run AFTER applying it.
--
-- READ THIS FIRST -- it is the trap that ate three attempts on 2026-08-27:
-- do NOT verify by selecting from inventory_workboard_v in the SQL editor. It
-- is security_invoker over inventory_on_hand_current_v, which is RLS'd on
-- active_company_id() -- and the editor has no auth.uid(), so that is NULL and
-- the view returns ZERO ROWS whether the fix worked or not. "Success. No rows
-- returned" there proves nothing.
--
-- Query 1 below therefore reproduces the view's new logic against base tables
-- with an explicit company id. Query 0 confirms the migration applied at all
-- (information_schema is not company-scoped). To see the real view, open
-- /v2/inventory.html in the app, where auth.uid() exists.
--
-- Targets are Shopify's own trailing-365d figures for the online store, pulled
-- 2026-08-27 -- the products that read ZERO before the fix, under the drifted
-- spelling "Doubles and Bubbles":
--   Bubbles and Doubles T-Shirt - Youth            19,362 units   $311,553
--   Bubbles and Doubles Diamond Air Mesh Shorts     13,219 units   $389,889
--   Bubbles and Doubles Cap - Youth                  5,100 units    $97,617
-- SILO counts variant SKUs at a location, Shopify counts the product across
-- channels, so these will not tie to the unit. What must be true: thousands,
-- not zero.


-- ============================================================
-- 0) Did the migration apply? (not company-scoped)
-- ============================================================
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'inventory_workboard_v'
  and column_name in ('velocity_matched', 'velocity_source')
order by column_name;


-- ============================================================
-- 1) The view's new logic, reproduced on base tables
-- ============================================================
with inv as (
  select lower(trim(location_tag)) as lt, trim(variant_sku) as sk,
         trim(product_title) as pt, product_title,
         total_available_quantity as qty,
         total_available_inventory_value as val
  from public.inventory_on_hand_current_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
    and variant_sku is not null and trim(variant_sku) <> ''
),
vel as (
  select location_tag as lt, variant_sku as sk, product_name as pn,
         qty_365d, last_sold_date
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
),
agg as (
  select lt, sk, count(*) as name_variants,
         max(qty_365d) as qty_365d, max(last_sold_date) as last_sold_date
  from vel group by lt, sk
),
j as (
  select i.product_title, i.sk, i.lt, i.qty, i.val,
         coalesce(t.qty_365d, a.qty_365d, 0)          as qty_365d,
         coalesce(t.last_sold_date, a.last_sold_date) as last_sold_date,
         case when t.sk is not null then 'title'
              when a.sk is not null then 'sku_fallback'
              else 'none' end                          as velocity_source
  from inv i
  left join vel t on t.lt = i.lt and t.sk = i.sk and t.pn = i.pt
  left join agg a on a.lt = i.lt and a.sk = i.sk and a.name_variants = 1
)
select product_title, sk as variant_sku, lt as location_tag,
       qty_365d, last_sold_date, velocity_source,
       qty as on_hand_units, round(val::numeric, 0) as on_hand_value
from j
where product_title ilike '%ubbles%'
order by qty_365d desc
limit 30;


-- ============================================================
-- 2) How much did the fallback recover, overall?
-- ============================================================
with inv as (
  select lower(trim(location_tag)) as lt, trim(variant_sku) as sk,
         trim(product_title) as pt, total_available_inventory_value as val
  from public.inventory_on_hand_current_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
    and variant_sku is not null and trim(variant_sku) <> ''
),
vel as (
  select location_tag as lt, variant_sku as sk, product_name as pn, qty_365d
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
),
agg as (
  select lt, sk, count(*) as name_variants, max(qty_365d) as qty_365d
  from vel group by lt, sk
)
select case when t.sk is not null then 'title'
            when a.sk is not null then 'sku_fallback'
            else 'none' end                              as velocity_source,
       count(*)                                          as rows,
       round(sum(i.val)::numeric, 0)                     as on_hand_value,
       sum(coalesce(t.qty_365d, a.qty_365d, 0))          as units_365d
from inv i
left join vel t on t.lt = i.lt and t.sk = i.sk and t.pn = i.pt
left join agg a on a.lt = i.lt and a.sk = i.sk and a.name_variants = 1
group by 1
order by rows desc;
