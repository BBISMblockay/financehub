-- baseballismmlb.myshopify.com is missing the same default_location_code
-- fallback that 20260702170000_shopify_sync_variance_fixes.sql already gave
-- baseballismwholesale — orders with no resolvable Shopify location_id (the
-- same "unfulfilled wholesale-style order" pattern diagnosed there) are
-- silently dropped from sales_by_day instead of landing under a fallback
-- location. sync_jobs.result->'rows_skipped'->'no_location_lines' has been
-- consistently non-zero (14-88/day) on every recent incremental_sales run
-- for this connection. Every line that DOES resolve for this shop already
-- lands under location_tag 'wholesale' (100% of its sales_by_day rows), so
-- the same fallback used for baseballismwholesale is the correct default
-- here too — this was a YTD sales undercount of roughly $172k for this shop
-- (Shopify-reported total vs. what actually made it into sales_by_day).
--
-- This fixes new/incremental syncs going forward. The historical shortfall
-- needs a one-time history re-import for this connection (it purges and
-- rebuilds the shop's sales_by_day rows from scratch) to recover the orders
-- that were already dropped.

update public.shopify_connections
   set default_location_code = 'wholesale'
 where shop_domain = 'baseballismmlb.myshopify.com'
   and coalesce(default_location_code, '') = '';
