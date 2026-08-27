-- Measures the inventory_workboard_v velocity-join failure, to decide how to
-- fix it. Paste into the Supabase SQL editor and run one query at a time.
--
-- RUN NOTES (both learned the hard way, 2026-08-27):
--
-- 1. Do NOT write this against inventory_on_hand_current_v /
--    sales_velocity_by_sku_location_v. Both resolve company through
--    active_company_id(), which reads profiles.active_company_id for
--    auth.uid() -- and the SQL editor has no auth.uid(), so it is NULL.
--    inventory_on_hand_current_v is security_invoker over an RLS'd table, and
--    sales_velocity_by_sku_location_v has the company filter hard-coded in its
--    body. Both return ZERO rows there, so the whole diagnosis reads as
--    "no problem found". These queries hit base tables with an explicit id.
--
-- 2. No \set, no temp views -- the web editor is not psql and may run each
--    statement separately. Each query below is self-contained; the company id
--    is inlined, so change it in each query if you run this for another one.
--
-- Context: 20260821170000 added `product_title = product_name` to the join.
-- It stops SKU-colliding products blending, but an unmatched row silently
-- returns NULL velocity, which coalesce then renders as a hard "0 units sold".
--
-- The question: of the rows that fail to join, how many are TITLE DRIFT (one
-- product, two spellings -- the join is over-strict) versus a GENUINE SKU
-- COLLISION (two real products, one SKU -- the join is right)? Drift
-- dominating argues for a stable-identifier join or a SKU-only fallback.
-- Collisions dominating argues for leaving the join alone.


-- ============================================================
-- 1) How big is the problem?
-- ============================================================
with inv as (
  select ioh.*
  from public.inventory_on_hand ioh
  join (select company_entity_id, max(snapshot_at) as snapshot_at
          from public.inventory_on_hand
         where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
         group by company_entity_id) l
    on ioh.company_entity_id = l.company_entity_id
   and ioh.snapshot_at       = l.snapshot_at
),
vel as (
  select * from public.sales_velocity_by_sku_location_mv
   where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
select
  count(*)                                                    as inventory_rows,
  count(*) filter (where v.variant_sku is null)               as unmatched_rows,
  round(100.0 * count(*) filter (where v.variant_sku is null) / nullif(count(*),0), 1)
                                                              as pct_unmatched,
  round(sum(i.total_available_inventory_value) filter (where v.variant_sku is null)::numeric, 0)
                                                              as unmatched_on_hand_value
from inv i
left join vel v
  on  lower(trim(i.location_tag)) = v.location_tag
  and trim(i.variant_sku)         = v.variant_sku
  and trim(i.product_title)       = v.product_name;


-- ============================================================
-- 2) Title drift vs genuine SKU collision
-- ============================================================
with inv as (
  select ioh.*
  from public.inventory_on_hand ioh
  join (select company_entity_id, max(snapshot_at) as snapshot_at
          from public.inventory_on_hand
         where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
         group by company_entity_id) l
    on ioh.company_entity_id = l.company_entity_id
   and ioh.snapshot_at       = l.snapshot_at
),
vel as (
  select * from public.sales_velocity_by_sku_location_mv
   where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
),
unmatched as (
  select i.location_tag, i.variant_sku, i.product_title,
         i.total_available_inventory_value
  from inv i
  left join vel v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name
  where v.variant_sku is null
),
loose as (
  select u.*,
         (select count(distinct s.product_name) from vel s
           where s.location_tag = lower(trim(u.location_tag))
             and s.variant_sku  = trim(u.variant_sku))   as name_variants,
         (select sum(s.qty_365d) from vel s
           where s.location_tag = lower(trim(u.location_tag))
             and s.variant_sku  = trim(u.variant_sku))   as hidden_qty_365d
  from unmatched u
)
select
  case
    when coalesce(name_variants,0) = 0 then 'genuinely no sales history'
    when name_variants = 1 then 'TITLE DRIFT (one product, two spellings)'
    else 'SKU COLLISION (' || name_variants || ' distinct names)'
  end                                                        as bucket,
  count(*)                                                   as rows,
  round(sum(total_available_inventory_value)::numeric,0)     as on_hand_value,
  sum(hidden_qty_365d)                                       as units_hidden_365d
from loose
group by 1
order by rows desc;


-- ============================================================
-- 3) Worst offenders — reading "never sold" but actually selling
-- ============================================================
with inv as (
  select ioh.*
  from public.inventory_on_hand ioh
  join (select company_entity_id, max(snapshot_at) as snapshot_at
          from public.inventory_on_hand
         where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
         group by company_entity_id) l
    on ioh.company_entity_id = l.company_entity_id
   and ioh.snapshot_at       = l.snapshot_at
),
vel as (
  select * from public.sales_velocity_by_sku_location_mv
   where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
),
unmatched as (
  select i.location_tag, i.variant_sku, i.product_title,
         i.total_available_inventory_value
  from inv i
  left join vel v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name
  where v.variant_sku is null
)
select u.product_title              as inventory_title,
       s.product_name               as as_sold_title,
       u.variant_sku, u.location_tag,
       s.qty_365d                   as units_sold_365d_actually,
       s.last_sold_date,
       round(u.total_available_inventory_value::numeric,0) as on_hand_value
from unmatched u
join vel s
  on  s.location_tag = lower(trim(u.location_tag))
  and s.variant_sku  = trim(u.variant_sku)
where s.qty_365d > 0
order by s.qty_365d desc
limit 40;
