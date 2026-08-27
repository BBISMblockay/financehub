-- Make inventory_workboard_v's velocity numbers match what Shopify reports.
--
-- WHY THIS EXISTS. 20260821170000 added `product_title = product_name` to the
-- velocity join, to stop two products sharing one SKU from blending. That part
-- was right. But those two fields are not the same thing --
-- inventory_on_hand.product_title is Shopify's CURRENT title,
-- sales_by_day.product_name is the AS-SOLD line-item title frozen at order
-- time -- and it is a LEFT JOIN, so any drift between them returns NULL
-- velocity, which coalesce then renders as a hard "0 units sold".
--
-- Measured 2026-08-27: of the top 40 unmatched rows, 40 were title drift and
-- ZERO were real SKU collisions. Drift comes from promo suffixes ("Gingy
-- Teddy Bear" vs "Gingy Teddy Bear (Free With $100 Purchase)"), word order
-- ("Cali Bear T-Shirt (Kelly Green)" vs "Cali Bear (Kelly Green) T-Shirt"),
-- spacing ("IronPigs" vs "Iron Pigs"), and mystery-box relabelling ("Adult
-- Mystery T-Shirt" vs "Hardball Hunter Hunting Badge T-Shirt - Blaze Orange").
--
-- The cost was not theoretical. Verified against Shopify's own analytics for
-- the trailing 365 days:
--   Bubbles and Doubles T-Shirt - Youth          19,362 units  $311,553  (#2 seller)
--   Bubbles and Doubles Diamond Air Mesh Shorts  13,219 units  $389,889  (#4 seller)
--   Bubbles and Doubles Cap - Youth               5,100 units   $97,617
-- All three read as ZERO units sold here, under the drifted spelling "Doubles
-- and Bubbles", and Ask SILO put the store's #2 and #4 best sellers on a
-- dead-stock list for an executive -- then invented a "returns offset sales"
-- explanation for the zeros. (Shopify's net_items_sold is already net of
-- refunds, so that explanation was false as well as unprompted.)
--
-- THE FIX, and the guard on it. Title match is still PREFERRED. When no title
-- matches, fall back to the SKU+location velocity -- but ONLY when that
-- (location, sku) has exactly ONE distinct product_name in the sales history.
-- That is the drift case: one product, one as-sold name, a stale title on the
-- inventory side. When there are TWO OR MORE distinct names and none matches,
-- there is no non-arbitrary answer, so the row stays unmatched rather than
-- being handed a guess -- which is precisely the blending 20260821170000
-- removed, and it is not reintroduced here.
--
-- velocity_source records which path produced the numbers, so a fallback is
-- never mistaken for a direct match:
--   'title'        exact product-title match; highest confidence
--   'sku_fallback' matched on SKU+location, unambiguous single name
--   'none'         no velocity at all; velocity_matched is false and every
--                  qty/avg column is a coalesce artefact meaning UNKNOWN
--
-- NOT FIXED HERE, on purpose: this view still reads
-- inventory_on_hand_current_v, which rebuilds the current snapshot from
-- inventory_on_hand (~3.47M rows) on every query rather than using
-- inventory_on_hand_current_mv (66,513 rows, refreshed nightly). That is why
-- queries against this view are slow enough to hit Ask SILO's 30s statement
-- timeout. Switching sources needs the MV to carry an explicit
-- active_company_id() filter and the right grants, since materialized views
-- do not support RLS -- a separate change that should be measured, not
-- bundled into a correctness fix.

create or replace view public.inventory_workboard_v
  with (security_invoker = true)
as
  select
    i.id, i.location_tag, i.source, i.location, i.product_title,
    i.variant_title, i.variant_sku, i.shop_domain, i.variant_barcode,
    i.est_oos_date, i.variant_created_at, i.product_type, i.product_image,
    i.product_image_url, i.retail_price, i.total_available_quantity,
    i.total_available_inventory_value, i.qty_sold_30d, i.avg_qty_sold_per_day,
    i.est_days_before_oos, i.snapshot_at, i.row_hash, i.location_name,
    i.sync_batch_id, i.company_entity_id,
    -- Title match first, unambiguous SKU fallback second, 0 only if neither.
    coalesce(t.qty_7d,      a.qty_7d,      0) as qty_7d,
    coalesce(t.qty_30d,     a.qty_30d,     0) as sold_30,
    coalesce(t.qty_90d,     a.qty_90d,     0) as qty_90d,
    coalesce(t.qty_120d,    a.qty_120d,    0) as qty_120d,
    coalesce(t.qty_365d,    a.qty_365d,    0) as qty_365d,
    coalesce(t.avg_day_7,   a.avg_day_7,   0) as avg_day_7,
    coalesce(t.avg_day_30,  a.avg_day_30,  0) as avg_day_30,
    coalesce(t.avg_day_90,  a.avg_day_90,  0) as avg_day_90,
    coalesce(t.avg_day_120, a.avg_day_120, 0) as avg_day_120,
    coalesce(t.avg_day_365, a.avg_day_365, 0) as avg_day_365,
    coalesce(t.last_sold_date, a.last_sold_date) as last_sold_date,
    case
      when coalesce(t.avg_day_30, a.avg_day_30, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric
                   / coalesce(t.avg_day_30, a.avg_day_30), 1)
      when coalesce(t.avg_day_7, a.avg_day_7, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric
                   / coalesce(t.avg_day_7, a.avg_day_7), 1)
      else null
    end as days_oos,
    case
      when coalesce(t.avg_day_30, a.avg_day_30, 0) > 0 then '30d'
      when coalesce(t.avg_day_7,  a.avg_day_7,  0) > 0 then '7d'
      else 'none'
    end as velocity_basis,
    -- APPEND-ONLY BELOW. `create or replace view` cannot insert a column
    -- mid-list; it reports "cannot change name of view column X to Y" and
    -- names an innocent column, which sends you looking in the wrong place.
    -- Any future column goes after these.
    (t.variant_sku is not null or a.variant_sku is not null) as velocity_matched,
    case when t.variant_sku is not null then 'title'
         when a.variant_sku is not null then 'sku_fallback'
         else 'none' end as velocity_source
  from public.inventory_on_hand_current_v i
  -- Exact as-sold-title match. Highest confidence, always preferred.
  left join public.sales_velocity_by_sku_location_v t
    on  t.location_tag  = lower(trim(i.location_tag))
    and t.variant_sku   = trim(i.variant_sku)
    and t.product_name  = trim(i.product_title)
  -- Unambiguous SKU fallback. Aggregated ONCE (not per row -- a correlated
  -- count(distinct) here is what made an earlier version of this too slow to
  -- finish). The MV is already unique on (location, sku, product_name), so
  -- count(*) is the distinct-name count, and the max()s below collapse to the
  -- single row's own values because the join only accepts name_variants = 1.
  left join (
    select location_tag, variant_sku,
           count(*)            as name_variants,
           max(qty_7d)         as qty_7d,
           max(qty_30d)        as qty_30d,
           max(qty_90d)        as qty_90d,
           max(qty_120d)       as qty_120d,
           max(qty_365d)       as qty_365d,
           max(avg_day_7)      as avg_day_7,
           max(avg_day_30)     as avg_day_30,
           max(avg_day_90)     as avg_day_90,
           max(avg_day_120)    as avg_day_120,
           max(avg_day_365)    as avg_day_365,
           max(last_sold_date) as last_sold_date
    from public.sales_velocity_by_sku_location_v
    group by location_tag, variant_sku
  ) a
    on  a.location_tag  = lower(trim(i.location_tag))
    and a.variant_sku   = trim(i.variant_sku)
    -- The guard. Two or more distinct as-sold names for one location+sku is a
    -- real collision, and there is no non-arbitrary way to pick -- so the row
    -- stays unmatched rather than being handed a guess. This is the blending
    -- 20260821170000 removed, and it is not reintroduced.
    and a.name_variants = 1;

grant select on public.inventory_workboard_v to authenticated;
