-- Measures the inventory_workboard_v velocity-join failure, to decide how to
-- fix it. Run in the Supabase SQL editor as service_role (or with an active
-- company set, since the views are company-scoped).
--
-- Context: 20260821170000 added `product_title = product_name` to the join.
-- It stops SKU-colliding products blending, but an unmatched row silently
-- returns NULL velocity, which coalesce then renders as a hard "0 units sold".
--
-- The question this answers: of the rows that fail to join, how many are
-- TITLE DRIFT (one product, two spellings -- the join is over-strict) versus
-- a GENUINE SKU COLLISION (two real products, one SKU -- the join is right)?
-- Title drift dominating argues for joining on a stable identifier or adding
-- a SKU-only fallback. Collisions dominating argues for leaving it alone.

-- 1) How big is the problem?
select
  count(*)                                              as inventory_rows,
  count(*) filter (where v.variant_sku is null)         as unmatched_rows,
  round(100.0 * count(*) filter (where v.variant_sku is null) / nullif(count(*),0), 1)
                                                        as pct_unmatched,
  sum(i.total_available_inventory_value) filter (where v.variant_sku is null)
                                                        as unmatched_on_hand_value
from public.inventory_on_hand_current_v i
left join public.sales_velocity_by_sku_location_v v
  on  lower(trim(i.location_tag)) = v.location_tag
  and trim(i.variant_sku)         = v.variant_sku
  and trim(i.product_title)       = v.product_name;

-- 2) Of the unmatched rows, which would match on SKU+location ALONE?
--    Those are the ones the title condition is rejecting. Split them by
--    whether that looser join finds ONE product name (title drift -- safe to
--    fall back) or MORE THAN ONE (genuine collision -- fallback would blend).
with unmatched as (
  select i.location_tag, i.variant_sku, i.product_title,
         i.total_available_quantity, i.total_available_inventory_value
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name
  where v.variant_sku is null
),
loose as (
  select u.*,
         (select count(distinct s.product_name)
            from public.sales_velocity_by_sku_location_v s
           where s.location_tag = lower(trim(u.location_tag))
             and s.variant_sku  = trim(u.variant_sku))        as name_variants,
         (select sum(s.qty_365d)
            from public.sales_velocity_by_sku_location_v s
           where s.location_tag = lower(trim(u.location_tag))
             and s.variant_sku  = trim(u.variant_sku))        as hidden_qty_365d
  from unmatched u
)
select
  case
    when name_variants = 0 then 'genuinely no sales history'
    when name_variants = 1 then 'TITLE DRIFT (one product, two spellings)'
    else 'SKU COLLISION (' || name_variants || ' distinct names)'
  end                                          as bucket,
  count(*)                                     as rows,
  sum(total_available_inventory_value)         as on_hand_value,
  sum(hidden_qty_365d)                         as units_hidden_365d
from loose
group by 1
order by rows desc;

-- 3) The worst offenders: rows currently reading "0 units / never sold" that
--    actually have sales under a different spelling of the same name.
with unmatched as (
  select i.location_tag, i.variant_sku, i.product_title,
         i.total_available_inventory_value
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name
  where v.variant_sku is null
)
select u.product_title            as inventory_title,
       s.product_name             as as_sold_title,
       u.variant_sku, u.location_tag,
       s.qty_365d                 as units_sold_365d_actually,
       s.last_sold_date,
       u.total_available_inventory_value
from unmatched u
join public.sales_velocity_by_sku_location_v s
  on  s.location_tag = lower(trim(u.location_tag))
  and s.variant_sku  = trim(u.variant_sku)
where s.qty_365d > 0
order by s.qty_365d desc
limit 40;
