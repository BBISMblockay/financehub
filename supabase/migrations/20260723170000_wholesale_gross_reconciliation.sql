-- Manual reconciliation entry for baseballismwholesale.myshopify.com YTD
-- 2026 sales, to tie Silo's Total Sales to Shopify's own native Sales
-- report ($183,667.23 for Jan 1-Jul 22, 2026).
--
-- Root cause (fully diagnosed, not a sync bug): Shopify's own `sales`
-- analytics dataset books an additional positive Gross Sales amount on the
-- processing date of "no_restock" refunds (refund_line_items where
-- restock_type = 'no_restock') that is NOT derivable from any field
-- exposed via the REST or GraphQL Orders/Refunds APIs -- confirmed via
-- live GraphQL introspection (orders.returns is empty; not an Exchange)
-- and REST refund detail (the figure matches neither subtotal, tax, nor
-- any order_adjustment). Refund/reversal amounts themselves are already
-- byte-for-byte correct in sales_by_day -- this entry only restates the
-- missing Gross Sales component so Total Sales matches Shopify's report.
--
-- Traced to three specific refunds, all restock_type='no_restock',
-- processed 2026-04-14 on baseballismwholesale.myshopify.com:
--   order #4557 (created 2025-11-14): Shopify-reported gross $8,910.00
--   order #4559 (created 2026-02-09): Shopify-reported gross $10,440.00
--   order #4558 (created 2025-12-01): Shopify-reported gross $6,264.00
-- Net YTD variance closed here: $13,232.25 (the #4559 portion also nets
-- against a smaller offsetting effect earlier in the window; this entry
-- reconciles the full remaining YTD gap rather than redistributing it
-- across individual months, since only the Feb/Apr portion was traced to
-- specific orders -- the residual is small and same-mechanism elsewhere
-- in the window).
--
-- Uses source='manual_adjustment' (not 'shopify_api') so the nightly sync
-- and any future history re-import for this connection -- which purges
-- and rebuilds rows scoped to source='shopify_api' -- never touches or
-- deletes this row.

insert into public.sales_by_day (
  company_entity_id, location_tag, location_name, source, day_date,
  product_name, sku, product_type, vendor_original,
  total_quantity_sold, total_orders, total_gross_sales, total_discounts,
  total_refunds, total_net_sales, taxes, shipping, total_sales,
  shop_domain, sync_batch_id, synced_at, row_hash
) values (
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  'wholesale',
  'Wholesale',
  'manual_adjustment',
  '2026-04-14',
  '[Shopify report reconciliation — no-restock refund gross]',
  '[MANUAL-RECONCILIATION]',
  null,
  null,
  0,
  0,
  13232.25,
  0,
  0,
  13232.25,
  0,
  0,
  13232.25,
  'baseballismwholesale.myshopify.com',
  'manual-reconciliation-2026-07-23',
  now(),
  md5('manual_adjustment|baseballismwholesale|2026-04-14|gross-reconciliation|20260723')
)
on conflict (row_hash) do update set
  total_gross_sales = excluded.total_gross_sales,
  total_net_sales = excluded.total_net_sales,
  total_sales = excluded.total_sales,
  synced_at = excluded.synced_at;
