-- Affiliate Studio: make the order -> affiliate-code match finish inside the
-- 8s API statement timeout on a high-volume store.
--
-- `affiliate_resolve_attributions` (20261110180000) scans a company's orders
-- for the window it is asked for and keeps the ones that carry a discount
-- code:
--
--   where company_entity_id = :company
--     and discount_codes is not null
--     and jsonb_array_length(discount_codes) > 0
--     and shopify_created_at >= ... and < ...
--
-- `shopify_orders_co_created_idx` serves the first and last conditions, so the
-- code test runs as a FILTER -- which DETOASTS `discount_codes` for every
-- order in the window, not just the ones that used a code. Measured on
-- production 2026-11-12 over 48 days of one company's orders: 8,744 rows kept,
-- 35,593 removed by the filter, 12.3s cold and 6.8s warm for the scan ALONE.
-- Every caller is capped at 8s (PostgREST connects as `authenticator`, which
-- sets statement_timeout=8s, and SET ROLE service_role does not lift it), so
-- both the nightly job (scripts/affiliate-commissions.mjs) and Studio's
-- "Update commissions" were cancelled every time on that store: an affiliate
-- order could never appear. It looked like it worked only while no order had
-- ever matched an affiliate code, because the scan is the whole cost.
--
-- This partial index pre-evaluates the code test, so the scan touches and
-- detoasts only the orders that actually carry a code. Nothing is rewritten
-- and no existing index changes; the gin index on `discount_codes` stays (it
-- answers containment lookups, not this range scan).
--
-- The predicate is written to MATCH the function's WHERE clause exactly --
-- both conditions, same order -- or the planner cannot use the index.
-- `jsonb_array_length` is immutable, so it is allowed in a predicate.
--
-- Generic: no company, store or code appears here.
--
-- Idempotent. Takes a brief ACCESS EXCLUSIVE lock on shopify_orders while it
-- builds (a few seconds), so apply it when a Shopify sync is not mid-run.

create index if not exists shopify_orders_co_created_coded_idx
  on public.shopify_orders (company_entity_id, shopify_created_at)
  where discount_codes is not null and jsonb_array_length(discount_codes) > 0;

comment on index public.shopify_orders_co_created_coded_idx is
  'Partial index for affiliate_resolve_attributions: orders carrying at least one discount code, by company and order time. Its predicate must stay identical to that function''s WHERE clause.';
