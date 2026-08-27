-- inventory_workboard_v: distinguish "sold nothing" from "we could not match
-- this row to any sales history at all".
--
-- The 20260821170000 SKU-collision fix added product_title = product_name to
-- the velocity join. It correctly stopped two different products sharing one
-- SKU from blending -- but it made the join depend on exact equality between
-- two fields that are not the same thing, and says so in its own comment:
-- sales_by_day.product_name is the AS-SOLD line-item title frozen at order
-- time, while inventory_on_hand.product_title is Shopify's CURRENT title.
--
-- That comment calls the mismatch "a narrow, self-healing edge case". It is
-- neither. Title drift is common (CLAUDE.md already records product_name
-- matching the catalog title on only ~83.6% of rows), and a permanent
-- difference never ages out. It is a LEFT JOIN, so an unmatched row does not
-- come back partial -- it comes back with NULL velocity.
--
-- The damage is done by the coalesce, not the join: coalesce(v.qty_365d, 0)
-- turns "we have no idea" into "0 units sold", which is a definite factual
-- claim and a false one. The same row then reports a hard zero AND a NULL
-- last_sold_date from the identical missing data. Ask SILO surfaced this
-- 2026-08-27 as a slow-moving-inventory list populated by products that sell
-- fine -- including one SKU (FM-Snap-DoublesandBubbles-YouthCap, 10,087
-- lifetime units, sold that same day) split across two spellings of its OWN
-- name by the very join meant to separate two different products.
--
-- This migration does NOT change the join -- that decision (join on a stable
-- identifier vs. a SKU-only fallback) is still open and needs measuring
-- first. It adds the one thing every option needs regardless: a flag saying
-- whether the velocity numbers on this row mean anything. Existing coalesced
-- columns are left exactly as they are, so no current consumer changes
-- behaviour; readers that RANK rows (slow-mover lists) can now exclude or
-- mark unmatched rows instead of ranking them as dead stock.

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
    coalesce(v.qty_7d,     0) as qty_7d,
    coalesce(v.qty_30d,    0) as sold_30,
    coalesce(v.qty_90d,    0) as qty_90d,
    coalesce(v.qty_120d,   0) as qty_120d,
    coalesce(v.qty_365d,   0) as qty_365d,
    coalesce(v.avg_day_7,  0) as avg_day_7,
    coalesce(v.avg_day_30, 0) as avg_day_30,
    coalesce(v.avg_day_90, 0) as avg_day_90,
    coalesce(v.avg_day_120,0) as avg_day_120,
    coalesce(v.avg_day_365,0) as avg_day_365,
    v.last_sold_date,
    case
      when coalesce(v.avg_day_30, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_30, 1)
      when coalesce(v.avg_day_7, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_7, 1)
      else null
    end as days_oos,
    case
      when coalesce(v.avg_day_30, 0) > 0 then '30d'
      when coalesce(v.avg_day_7,  0) > 0 then '7d'
      else 'none'
    end as velocity_basis,
    -- MUST STAY LAST. `create or replace view` can only APPEND columns -- it
    -- cannot insert one mid-list, and trying to does not error usefully: it
    -- reports "cannot change name of view column days_oos to
    -- velocity_matched", because positionally that is what it sees. Any future
    -- column goes after this one, or the statement has to become a drop +
    -- recreate (which loses grants and breaks dependents).
    --
    -- TRUE  = this row joined to sales history; its zeros are real zeros.
    -- FALSE = no velocity row matched; every qty/avg column above is a
    --         coalesce artefact and means "unknown", not "none". Never rank,
    --         sort or flag a row as slow-moving on a FALSE.
    (v.variant_sku is not null) as velocity_matched
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name;

grant select on public.inventory_workboard_v to authenticated;
