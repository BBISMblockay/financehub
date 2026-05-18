-- Run in Supabase SQL Editor to find where titles are lost.
-- Compare raw sync table vs workboard view for the same SKU.

-- 1) Latest inventory_on_hand row per location+sku (Silo CSV sync)
select distinct on (location_tag, variant_sku)
  location_tag,
  variant_sku,
  product_title,
  variant_title,
  source,
  snapshot_at
from public.inventory_on_hand
where variant_sku in (
  '71/2-MoneyBall-Cap',
  'FM-M-HomeoftheBrave2.0-Mens'
)
order by location_tag, variant_sku, snapshot_at desc;

-- 2) What the inventory UI reads
select
  location_tag,
  variant_sku,
  product_title,
  variant_title,
  product_type
from public.inventory_workboard_v
where variant_sku in (
  '71/2-MoneyBall-Cap',
  'FM-M-HomeoftheBrave2.0-Mens'
);

-- 3) If (1) has titles but (2) is null, inspect the view definition:
select pg_get_viewdef('public.inventory_workboard_v'::regclass, true);

-- 4) Count null titles in latest snapshot vs workboard
select
  count(*) filter (where product_title is null) as null_titles_on_hand,
  count(*) as total_latest
from (
  select distinct on (location_tag, variant_sku)
    product_title
  from public.inventory_on_hand
  order by location_tag, variant_sku, snapshot_at desc
) latest;

select
  count(*) filter (where product_title is null) as null_titles_workboard,
  count(*) as total_workboard
from public.inventory_workboard_v;
