-- Shopify orders: when the order was actually paid (2026-10-05).
--
-- The Wholesale Tracking report read payment_terms_completed_at as its
-- "Paid Date", and Shopify leaves that blank: all 18 paid Klein / Daniel
-- Gottsch orders had it NULL (measured 2026-10-05). Order #1606165 was paid by
-- a successful SALE transaction at 2026-10-05T16:57:14Z with the column still
-- empty. The created/updated dates are not payment dates either.
--
-- paid_at is read from Shopify's payment TRANSACTIONS by the sync
-- (scripts/lib/shopify-sync-core.mjs settledPaidAt / fetchOrderPaidDates):
-- the processed_at of the successful sale or capture that brought the money
-- collected up to the order total. Refunds never move it.
--
-- Only orders paid AFTER they were placed are looked up -- draft orders and
-- orders with payment terms. A checkout order is paid at checkout, and one
-- transactions call per web/POS order would buy nothing. So:
--   paid_at_checked_at NULL      not looked up (a checkout order, or not
--                                synced since this migration). paid_at is
--                                then NULL and means NOTHING.
--   checked, paid_at NULL        looked up: not settled (pending, partially
--                                paid, voided) or no successful payment.
--   checked, paid_at set         the settling payment's time.
-- A failed lookup writes neither column, so a stored date is never blanked
-- by a transient Shopify error; the next sync or backfill retries.
--
-- Existing orders fill on their next sync; older ones need
-- shopify-orders-backfill.yml for the range wanted.

alter table public.shopify_orders
  add column if not exists paid_at timestamptz,
  add column if not exists paid_at_checked_at timestamptz;

comment on column public.shopify_orders.paid_at is
  'When the order was settled: processed_at of the successful sale/capture that brought payments up to the order total, from Shopify transactions. Only looked up for draft orders and orders with payment terms -- read paid_at_checked_at before reading NULL.';
comment on column public.shopify_orders.paid_at_checked_at is
  'When the sync last looked up this order''s payment transactions. NULL = never looked up (checkout orders are not), so paid_at NULL means nothing.';

-- shopify_orders_v: every existing column unchanged and in place (create or
-- replace view only accepts new columns at the END), then the two new ones.
create or replace view public.shopify_orders_v with (security_invoker = true) as
 SELECT o.id,
    o.company_entity_id,
    o.connection_id,
    o.shop_domain,
    o.order_id,
    o.order_number,
    o.source_name,
    o.financial_status,
    o.fulfillment_status,
    o.cancelled_at,
    o.cancel_reason,
    o.customer_id,
    o.customer_email,
    o.customer_name,
    o.currency,
    o.subtotal_price,
    o.total_discounts,
    o.total_tax,
    o.total_shipping,
    o.total_price,
    o.tags,
    o.location_id,
    o.line_item_count,
    o.shopify_created_at,
    o.shopify_processed_at,
    o.shopify_updated_at,
    o.synced_at,
    o.sync_batch_id,
    o.created_at,
    COALESCE(m.display_name, o.source_name) AS resolved_channel_name,
    o.payment_terms_status,
    o.payment_terms_name,
    o.payment_terms_type,
    o.payment_due_in_days,
    o.payment_due_at,
    o.payment_terms_completed_at,
    o.total_outstanding,
    -- true/false only when terms were returned; NULL means SILO cannot tell.
    CASE WHEN o.payment_terms_status IS DISTINCT FROM 'present' THEN NULL
         ELSE o.payment_due_at IS NOT NULL
          AND o.payment_due_at < now()
          AND o.payment_terms_completed_at IS NULL
          AND o.cancelled_at IS NULL
          AND COALESCE(o.financial_status, '') NOT IN ('paid', 'refunded', 'partially_refunded', 'voided')
          AND (o.total_outstanding IS NULL OR o.total_outstanding > 0)
    END AS payment_overdue,
    CASE WHEN o.payment_terms_status = 'present'
          AND o.payment_due_at IS NOT NULL AND o.payment_due_at < now()
          AND o.payment_terms_completed_at IS NULL AND o.cancelled_at IS NULL
          AND COALESCE(o.financial_status, '') NOT IN ('paid', 'refunded', 'partially_refunded', 'voided')
          AND (o.total_outstanding IS NULL OR o.total_outstanding > 0)
         THEN GREATEST(0, b.today - (o.payment_due_at AT TIME ZONE b.tz)::date)
    END AS payment_days_overdue,
    o.paid_at,
    o.paid_at_checked_at
   FROM public.shopify_orders o
     LEFT JOIN public.shopify_channel_map m ON m.company_entity_id = o.company_entity_id AND m.source_name = o.source_name
     CROSS JOIN LATERAL (SELECT public.silo_business_today() AS today, public.silo_business_timezone() AS tz) b;


comment on view public.shopify_orders_v is
  'shopify_orders with the resolved channel name, payment terms, two read-time fields: payment_overdue (NULL when terms were not returned -- unknown, not "not overdue") and payment_days_overdue in the company''s business days, and paid_at from Shopify payment transactions (NULL with paid_at_checked_at NULL = never looked up).';

-- Ask SILO's catalog: APPEND, never replace, guarded so a re-run adds nothing.
update public.silo_chat_schema_catalog
   set description = coalesce(description, '')
     || ' Paid date (20261005130000): paid_at is when Shopify payment transactions settled the order (the successful sale/capture reaching the order total), looked up ONLY for draft orders and orders with payment terms. paid_at_checked_at NULL means never looked up, so paid_at NULL then means nothing -- never "unpaid". Use paid_at, not payment_terms_completed_at, for when an invoice was paid.'
 where relname in ('shopify_orders', 'shopify_orders_v')
   and position('Paid date (20261005130000)' in coalesce(description, '')) = 0;

select public.refresh_chat_schema_catalog();
