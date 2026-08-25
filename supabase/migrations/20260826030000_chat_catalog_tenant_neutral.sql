-- Make the shared schema catalog tenant-neutral.
--
-- silo_chat_schema_catalog has NO company_entity_id: it is one global row
-- per public relation, read by every tenant's Ask SILO. That is the right
-- shape, because the SCHEMA genuinely is shared -- but it means anything
-- written here is stated to every company, so tenant-specific DATA
-- conventions must never appear in it as universal rules.
--
-- Two rows violated that:
--
-- 1. sales_velocity_by_sku_location_v (from 20260825170000) taught
--    split_part(variant_sku,'-',2) as THE way to get a size curve, with
--    one company's product names as the worked examples. SKU formatting
--    is per-store. For a tenant whose SKUs are laid out differently that
--    silently returns a WRONG size breakdown -- a correctness bug, not a
--    cosmetic one, and one that looks like a real answer. Reworded as an
--    observation to verify against sampled rows, with a stated fallback
--    when SKUs carry no size segment at all.
--
-- 2. launch_actuals_v (from 20260826010000/20260826020000) named a
--    specific PO and its figures, and described the product-vs-variant
--    SKU mismatch as though it were a property of all installs rather
--    than of the store where it was measured.
--
-- The underlying guidance is still worth giving -- it is what stops the
-- model recomputing 90-day sell-through from raw sales, or reading a
-- restock at 141% as a sellout. Only the framing changes: observed here,
-- verify before relying on it.
--
-- Audited at the same time and deliberately left alone:
-- PRODUCT_CONCEPT_TESTERS in the silo-chat function is a hardcoded email
-- allowlist gating an in-testing feature. It is tenant-specific by
-- intent and removed (not widened) when Product Concepts ships.

update public.silo_chat_schema_catalog set
  description = $d$FASTEST path for "how fast does this sell" and "what did a comparable product do in its first 90 days" -- units are PRE-COMPUTED per variant SKU per location, so prefer this over grouping sales_by_day or shopify_order_lines yourself (measured 8x faster on a size-curve question, and it stays in cache instead of hitting disk). Columns: variant_sku, product_name, location_tag, qty_7d/qty_30d/qty_90d/qty_120d/qty_365d, matching avg_day_* rates, last_sold_date. qty_90d already IS the 90-day sell-through figure -- do not recompute it from raw sales. SIZE CURVE: many stores encode the size inside variant_sku as a dash-separated segment, in which case split_part(variant_sku,'-',N) yields a size breakdown without touching order lines -- but SKU formatting is per-store, so sample a handful of variant_sku values for the products in question and confirm which segment holds the size before relying on it; if the SKUs carry no size segment, fall back to the product/variant title fields. STORE/CHANNEL SPLIT: group by location_tag. No day-level detail here -- if you genuinely need per-day movement, fall back to sales_by_day_verification_v.$d$
where relname = 'sales_velocity_by_sku_location_v';

update public.silo_chat_schema_catalog set
  description = $d$What each launch actually sold versus what it planned. Launches come in two shapes and this view measures both: a PERIOD (is_period true, launch_end_date set -- a bounded promotion such as a seasonal or holiday sale) reports units_in_period/net_in_period across [launch_date, launch_end_date]; a POINT drop (launch_end_date null) reports fixed tails units_30d/60d/90d/365d from launch_date. pct_of_po_units_sold and pct_of_projected_revenue automatically use the period when there is one and the 90-day tail otherwise. units_preview/net_preview cover [preview_start_date, launch_date) for launches with a preview.

CRITICAL CAVEAT on pct_of_po_units_sold: it is only meaningful when the linked PO is a NEW-PRODUCT po (po_headers.is_new_product_po = true). For a RESTOCK of SKUs that already existed, sales in the window include units that came from earlier POs, so the percentage can exceed 100% and does NOT mean the buy sold out -- measured on real data, one restock PO showed roughly 780 units committed against 1,099 sold in 90 days (141%). Always check is_new_product_po before presenting this as sell-through, and say plainly that a restock figure mixes inventory from multiple POs.

Measurement runs through launch_calendar.linked_po_id -> po_lines.sku_snapshot -> sales_by_day.sku, joined on exact SKU equality. Do NOT substitute launch_calendar.product_sku: where a store records it at product level while sales and PO lines are variant level, it matches nothing and would report 0 units for a launch that sold well. sku_source = null means NOT MEASURABLE (no PO linked) -- report it that way, never as zero sales. Check period_complete / window_*_complete before treating a figure as final: a partial window is not a result. Note also that a PO's expected_arrival_date is a WAREHOUSE date, not a selling start -- measured POs routinely show zero units in the first 14 days after arrival and thousands over 90, so never treat arrival as a launch date. Finally, a multi-day campaign entered as TWO rows (a start plus a separate "... End" row) rather than one row with launch_end_date will measure as two point launches until merged.$d$
where relname = 'launch_actuals_v';
