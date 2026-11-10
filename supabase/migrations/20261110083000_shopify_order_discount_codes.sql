-- Order-level discount codes and refunded subtotal on shopify_orders.
--
-- WHY THIS EXISTS
--
-- Affiliate Studio has to answer "which orders ran through this affiliate's
-- code, and what is commissionable after refunds" for ANY tenant with a
-- Shopify connection. Nothing in the schema could answer that generically:
--
--   * shopify_discount_codes_daily is a ShopifyQL day/code aggregate of GROSS
--     sales with no order ids, so it cannot carry a per-order precedence
--     decision, cannot be reduced by a refund, and cannot be audited back to
--     an order.
--   * silo_attribution_ledger_v IS order-level and does carry the codes, but
--     it is derived from the attribution journey sync, which runs for the two
--     companies that have it enabled -- not for every tenant -- and it fans
--     each order across four attribution windows.
--
-- shopify_orders is the one order-grain table every Shopify tenant already
-- gets. Both fields ride on the REST order object the sync ALREADY fetches:
-- `discount_codes` and `refunds[].refund_line_items[]`. No new request, no new
-- scope (read_orders covers both), no write to Shopify.
--
-- NULL MEANS NOT MEASURED, as everywhere else in SILO. An order synced before
-- this column existed reads NULL, which is not "no code was used" and not
-- "nothing was refunded". An order collected after it reads '[]' when the
-- customer typed no code, and 0 when nothing was refunded. Coalescing either
-- NULL to its empty value turns all of history into a measurement nobody took,
-- and in the refund case it would pay commission on refunded revenue.
--
-- The sync degrades gracefully if this migration has not been applied yet
-- (scripts/lib/shopify-sync-core.mjs strips the keys and records that it did),
-- so the repo change is safe to merge before the apply.

alter table public.shopify_orders
  add column if not exists discount_codes jsonb,
  add column if not exists refunded_subtotal numeric;

comment on column public.shopify_orders.discount_codes is
  'The discount codes applied to this order, as a jsonb array of uppercase strings, de-duplicated. NULL means NOT MEASURED (synced before 20261110083000); [] means collected and no code was used. Shopify matches a code case-insensitively, which is why these are stored folded -- compare folded, never raw.';

comment on column public.shopify_orders.refunded_subtotal is
  'Sum of this order''s refund_line_items subtotals: after line discounts, BEFORE tax and shipping, in the order currency. NULL means NOT MEASURED. The commissionable base for a code-attributed order is subtotal_price - refunded_subtotal, which is the "after discounts and refunds, before tax and shipping" definition Affiliate Studio commissions on.';

-- Code lookup is "find every order that used code X in a window", so the index
-- is on the array, not on a first element. jsonb_path_ops is the smaller,
-- faster choice and supports the @> containment the lookup uses.
create index if not exists shopify_orders_discount_codes_idx
  on public.shopify_orders using gin (discount_codes jsonb_path_ops)
  where discount_codes is not null;

-- One row per (order, code). An order can carry several codes, so this view
-- MULTIPLIES revenue if summed naively -- it exists to decide which single
-- code owns an order (affiliate_resolve_attributions does that), never to
-- total money. Every money column is therefore the ORDER's amount, repeated,
-- and the view says so in its comment rather than pre-dividing it: splitting
-- an order's revenue between two codes is a policy decision, and the one place
-- that decision is made is the attribution resolver.
--
-- security_invoker: RLS on shopify_orders is what scopes this to the caller's
-- active company.
create or replace view public.shopify_order_discount_codes_v
  with (security_invoker = true) as
select
  o.company_entity_id,
  o.connection_id,
  o.shop_domain,
  o.order_id,
  o.order_number,
  o.currency,
  o.financial_status,
  o.cancelled_at,
  o.shopify_created_at,
  o.shopify_processed_at,
  -- The business day the order belongs to, in the company's own timezone --
  -- never current_date, and never UTC truncation, which moves a Pacific
  -- evening order into the next day.
  (coalesce(o.shopify_processed_at, o.shopify_created_at)
     at time zone public.silo_company_timezone(o.company_entity_id))::date as order_day,
  upper(btrim(code.value)) as discount_code,
  jsonb_array_length(o.discount_codes) as codes_on_order,
  o.subtotal_price,
  o.total_discounts,
  o.total_tax,
  o.total_shipping,
  o.total_price,
  o.refunded_subtotal,
  -- NULL-preserving on purpose: an order whose refunds were never measured
  -- has an UNKNOWN commissionable base, not subtotal_price.
  o.subtotal_price - o.refunded_subtotal as net_subtotal
from public.shopify_orders o
cross join lateral jsonb_array_elements_text(o.discount_codes) as code(value)
where o.discount_codes is not null
  and btrim(code.value) <> '';

comment on view public.shopify_order_discount_codes_v is
  'One row per (Shopify order, discount code) for the active company. Money columns are the ORDER total repeated on each of its codes, so summing them across rows multiplies a multi-code order -- use it to DECIDE which code owns an order, not to total revenue. net_subtotal is NULL when refunds were never measured for that order. order_day is computed, so it cannot use an index: filter a window on shopify_created_at / shopify_processed_at (both indexed on company_entity_id) and let order_day label the rows that come back.';

revoke all on public.shopify_order_discount_codes_v from anon;
grant select on public.shopify_order_discount_codes_v to authenticated, service_role;

do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
