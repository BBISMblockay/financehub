-- Amazon inventory extract -- ONLINE store location only.
--
-- Grain: one row per sellable variant SKU currently in stock at location_tag='online'.
--
-- Three non-obvious decisions are baked in here; read them before editing:
--
-- 1. DUPLICATE SKUs COLLAPSE WITH max(), NOT sum(). 182 online SKUs appear on
--    more than one row because two different Shopify products share one SKU
--    (a "Free with Purchase" twin of a paid listing, or the Toddler/Youth cap
--    collision documented in shopify-sync-core.mjs). Both rows report the SAME
--    shared inventory pool -- FM-Snap-DoublesandBubbles-YouthCap reads 1,862 on
--    the Toddler listing AND 1,862 on the Youth listing -- so summing doubles
--    real stock. max() is the only correct collapse.
--
-- 2. PRICE IS DERIVED, NOT READ. products_master.msrp is 100% NULL for this
--    company, so retail price comes from
--    total_available_inventory_value / total_available_quantity, which is the
--    Shopify variant price the snapshot was built from. It is therefore only
--    derivable where qty > 0 -- another reason this extract is in-stock only.
--    The paid twin is preferred over the $0 "Free with Purchase" twin.
--
-- 3. UPC COMES FROM inventory_on_hand.variant_barcode, not products_master.upc.
--    The former is the live Shopify variant barcode refreshed nightly (10,016 of
--    10,035 online rows); the latter is a legacy column that is emptier (8,774)
--    and disagrees on 145 rows. upc_status flags rows Amazon will reject.
--
-- Titles and variant names are passed through EXACTLY as Shopify holds them,
-- typos included (double spaces, mixed S/M/L vs Small/Medium/Large size
-- vocabulary, promo phrasing like "Free with $100 Purchase"). That is
-- deliberate: this file has to reconcile against POS, so cleaning it here
-- would make the two disagree. Fix them in Shopify if they need fixing.
--
-- Reads the MV directly with an explicit company filter because
-- inventory_on_hand_current_v applies active_company_id(), which is NULL on a
-- service-role / SQL-editor connection and would return zero rows.
with inv as (
  select *
  from public.inventory_on_hand_current_mv
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
    and location_tag = 'online'
), px as (
  select i.*,
    round((i.total_available_inventory_value / nullif(i.total_available_quantity, 0))::numeric, 2) as unit_price
  from inv i
), ranked as (
  select p.*,
    count(*)       over (partition by p.variant_sku) as sku_row_ct,
    max(p.total_available_quantity) over (partition by p.variant_sku) as sku_max_qty,
    max(p.unit_price)               over (partition by p.variant_sku) as sku_max_price,
    row_number()   over (
      partition by p.variant_sku
      order by (coalesce(p.unit_price, 0) > 0) desc,   -- prefer the paid listing
               p.total_available_quantity desc,
               p.product_title
    ) as rn
  from px p
)
select
  r.variant_sku                                        as sku,
  r.product_title,
  r.variant_title,
  coalesce(nullif(trim(r.product_type), ''), nullif(trim(pm.product_type), '')) as product_type,
  nullif(trim(r.variant_barcode), '')                  as upc,
  case
    when nullif(trim(r.variant_barcode), '') is null then 'missing'
    when length(trim(r.variant_barcode)) = 12
     and trim(r.variant_barcode) ~ '^[0-9]+$'         then 'valid_upc_a'
    else 'invalid_not_gtin'
  end                                                  as upc_status,
  nullif(r.sku_max_price, 0)                           as retail_price,
  r.sku_max_qty                                        as qty_available,
  coalesce(nullif(trim(r.product_image_url), ''), nullif(trim(pm.image_url), '')) as image_url,
  case when r.sku_row_ct > 1 then 'yes' else '' end    as sku_shared_by_multiple_products
from ranked r
left join public.products_master pm
  on pm.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
 and pm.sku = r.variant_sku
where r.rn = 1
  and r.sku_max_qty > 0
order by r.product_title, r.variant_title nulls first, r.variant_sku;
