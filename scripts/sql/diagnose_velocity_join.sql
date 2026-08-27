-- Measures the inventory_workboard_v velocity-join failure, to decide how to
-- fix it. Two queries. Run them ONE AT A TIME (highlight + Run selection) --
-- the Supabase editor only shows the last statement's result.
--
-- RUN NOTES, all three learned the hard way on 2026-08-27:
--
-- 1. Do NOT go through inventory_on_hand_current_v /
--    sales_velocity_by_sku_location_v. Both resolve company through
--    active_company_id(), which reads profiles.active_company_id for
--    auth.uid() -- and the SQL editor has no auth.uid(), so it is NULL. One
--    is security_invoker over an RLS'd table, the other hard-codes the filter
--    in its body. Both return ZERO rows there even as service_role, so the
--    diagnosis reads "no problem found" while measuring nothing.
--
-- 2. Do NOT rebuild the current snapshot from inventory_on_hand. That table is
--    ~3.4M rows; computing max(snapshot_at) and joining back scans it twice
--    and times out. inventory_on_hand_current_mv already holds exactly that
--    snapshot and is refreshed by the nightly sync. (Its CREATE is not in any
--    migration -- it is one of the objects applied straight to prod.)
--
-- 3. Do NOT use correlated subqueries per unmatched row. Pre-aggregate the
--    velocity MV once and hash join. The correlated version timed out too.
--
-- Context: 20260821170000 added `product_title = product_name` to the join.
-- It stops SKU-colliding products blending, but an unmatched row silently
-- returns NULL velocity, which coalesce renders as a hard "0 units sold".
--
-- What query 1 decides: of the rows failing to join, how many are TITLE DRIFT
-- (one product, two spellings -- join is over-strict) vs GENUINE SKU COLLISION
-- (two real products, one SKU -- join is right)? Drift dominating argues for a
-- stable-identifier join or a SKU-only fallback. Collisions argue for leaving
-- the join alone and only surfacing velocity_matched.


-- ============================================================
-- 1) Size + drift-vs-collision split, in one pass
-- ============================================================
with inv as (
  select lower(trim(location_tag)) as lt,
         trim(variant_sku)         as sk,
         trim(product_title)       as pt,
         total_available_inventory_value as val
  from public.inventory_on_hand_current_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
    and variant_sku is not null and trim(variant_sku) <> ''
),
vel as (
  select location_tag as lt, variant_sku as sk, product_name as pn,
         qty_365d
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
),
-- One pass over the velocity MV. This is what the correlated subqueries were
-- recomputing per row.
velagg as (
  select lt, sk, count(*) as name_variants, sum(qty_365d) as qty_365d_all
  from vel group by lt, sk
),
-- The MV's unique index is (company, location_tag, variant_sku, product_name),
-- so this left join matches at most one row -- no fan-out.
j as (
  select i.lt, i.sk, i.pt, i.val, (v.sk is not null) as title_matched
  from inv i
  left join vel v on v.lt = i.lt and v.sk = i.sk and v.pn = i.pt
)
select
  case
    when j.title_matched            then 'MATCHED — numbers are real'
    when a.sk is null               then 'no sales history at all (real zero)'
    when a.name_variants = 1        then 'TITLE DRIFT — one product, two spellings'
    else 'SKU COLLISION — ' || a.name_variants || ' distinct names'
  end                                                as bucket,
  count(*)                                           as rows,
  round(sum(j.val)::numeric, 0)                      as on_hand_value,
  sum(a.qty_365d_all) filter (where not j.title_matched)
                                                     as units_hidden_365d
from j
left join velagg a on a.lt = j.lt and a.sk = j.sk
group by 1
order by rows desc;


-- ============================================================
-- 2) Worst offenders — reading "never sold" but actually selling
-- ============================================================
with inv as (
  select lower(trim(location_tag)) as lt,
         trim(variant_sku)         as sk,
         trim(product_title)       as pt,
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
unmatched as (
  select i.lt, i.sk, i.pt, i.val
  from inv i
  left join vel v on v.lt = i.lt and v.sk = i.sk and v.pn = i.pt
  where v.sk is null
)
select u.pt                        as inventory_title,
       s.pn                        as as_sold_title,
       u.sk                        as variant_sku,
       u.lt                        as location_tag,
       s.qty_365d                  as units_sold_365d_actually,
       s.last_sold_date,
       round(u.val::numeric, 0)    as on_hand_value
from unmatched u
join vel s on s.lt = u.lt and s.sk = u.sk
where s.qty_365d > 0
order by s.qty_365d desc
limit 40;
