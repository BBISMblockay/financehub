-- Proof that 20260827190000 fixed the velocity join. Run AFTER applying it.
--
-- Targets are Shopify's own trailing-365d figures for the online store,
-- pulled 2026-08-27. These are the products that were reading ZERO before the
-- fix, under the drifted spelling "Doubles and Bubbles":
--
--   Bubbles and Doubles T-Shirt - Youth            19,362 units   $311,553
--   Bubbles and Doubles Diamond Air Mesh Shorts     13,219 units   $389,889
--   Bubbles and Doubles Cap - Youth                  5,100 units    $97,617
--
-- SILO counts variant SKUs at a location while Shopify counts the product
-- across all channels, so these will not tie to the unit. What must be true is
-- that they are THOUSANDS, not zero, and that velocity_source says how each
-- row got its number.

-- 1) The three products that were wrong. Expect qty_365d in the thousands.
select product_title, variant_sku, location_tag,
       qty_365d, last_sold_date, velocity_matched, velocity_source,
       total_available_quantity, round(total_available_inventory_value::numeric,0) as on_hand_value
from public.inventory_workboard_v
where product_title ilike '%ubbles%and%oubles%'
order by qty_365d desc
limit 30;

-- 2) How much did the fallback recover overall, and did anything stay
--    genuinely unmatched? Expect 'none' to shrink to real collisions only.
select velocity_source,
       count(*)                                                as rows,
       round(sum(total_available_inventory_value)::numeric, 0)  as on_hand_value,
       sum(qty_365d)                                            as units_365d
from public.inventory_workboard_v
group by velocity_source
order by rows desc;

-- 3) The guard is doing its job: rows still unmatched because the SKU has
--    two or more distinct as-sold names. These SHOULD stay unmatched -- a
--    fallback here would blend two real products, which is the bug
--    20260821170000 was written to remove. Expect this to be small.
select i.product_title, i.variant_sku, i.location_tag,
       (select count(distinct v.product_name)
          from public.sales_velocity_by_sku_location_v v
         where v.location_tag = lower(trim(i.location_tag))
           and v.variant_sku  = trim(i.variant_sku))            as name_variants,
       round(i.total_available_inventory_value::numeric,0)      as on_hand_value
from public.inventory_workboard_v i
where i.velocity_source = 'none'
  and i.total_available_inventory_value > 0
order by i.total_available_inventory_value desc
limit 25;
