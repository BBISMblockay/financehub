-- Shopify orders: payment terms and due dates (2026-09-30).
--
-- Wholesale orders are placed as Shopify draft orders with payment terms
-- (Net 30 and the like). SILO kept none of it: shopify_orders had no terms or
-- due-date column, so "which wholesale orders are overdue" could only be
-- answered by guessing a due date from the order date. Measured the same
-- day: 12 of the 28 orders tagged Klein or Daniel Gottsch (all 10 Gottsch
-- orders, $11,038.17) were financial_status 'pending' with nothing in SILO
-- saying when they were due.
--
-- The nightly REST fetch (/orders.json, no fields filter) already receives
-- `payment_terms` and `total_outstanding` on every order. This stores them.
-- scripts/lib/shopify-sync-core.mjs orderPaymentTerms() is the one reader.
--
-- payment_terms_status is three states on purpose, because two different
-- facts look the same as an empty column:
--   'present'  Shopify returned terms
--   'none'     Shopify returned payment_terms = null (the order has none)
--   NULL       not returned: the key was absent. Shopify sends terms only to
--              an app holding read_payment_terms, and every row synced before
--              this migration is NULL too. Never read NULL as "no terms".
--
-- Overdue is DERIVED in shopify_orders_v, never stored: it changes every day
-- with no sync, and a stored flag would be stale the morning after.
--
-- Rows already stored get these columns on their next sync. Orders nobody
-- has touched recently need shopify-orders-backfill.yml for the range wanted.

alter table public.shopify_orders
  add column if not exists payment_terms_status text,
  add column if not exists payment_terms_name text,
  add column if not exists payment_terms_type text,
  add column if not exists payment_due_in_days integer,
  add column if not exists payment_due_at timestamptz,
  add column if not exists payment_terms_completed_at timestamptz,
  add column if not exists total_outstanding numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shopify_orders_payment_terms_status_check'
                   and conrelid = 'public.shopify_orders'::regclass) then
    alter table public.shopify_orders add constraint shopify_orders_payment_terms_status_check
      check (payment_terms_status is null or payment_terms_status in ('present', 'none'));
  end if;
end $$;

comment on column public.shopify_orders.payment_terms_status is
  'present = Shopify returned payment terms; none = Shopify said the order has none; NULL = not returned (no read_payment_terms scope, or synced before 20260930150000). NULL is never "no terms".';
comment on column public.shopify_orders.payment_due_at is
  'Due date of the earliest OPEN payment schedule; once every schedule is complete, the last one''s. See payment_terms_completed_at.';
comment on column public.shopify_orders.payment_terms_completed_at is
  'When the last payment schedule was completed (all schedules complete). NULL while anything is still owed, or when there are no terms.';
comment on column public.shopify_orders.total_outstanding is
  'Shopify''s total_outstanding for the order at the last sync: what the customer still owes. NULL = not synced since 20260930150000.';

-- shopify_orders_v: the existing columns unchanged and in order (create or
-- replace view only accepts new columns at the END), then the terms, then the
-- two read-time fields. The business date is read ONCE through an
-- uncorrelated lateral, not per row -- the same hoisting rule as
-- silo_channel_location_tags(), since a filter on payment_overdue otherwise
-- calls it for every order the company has.
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
    END AS payment_days_overdue
   FROM public.shopify_orders o
     LEFT JOIN public.shopify_channel_map m ON m.company_entity_id = o.company_entity_id AND m.source_name = o.source_name
     CROSS JOIN LATERAL (SELECT public.silo_business_today() AS today, public.silo_business_timezone() AS tz) b;

comment on view public.shopify_orders_v is
  'shopify_orders with the resolved channel name, payment terms, and two read-time fields: payment_overdue (NULL when terms were not returned -- unknown, not "not overdue") and payment_days_overdue in the company''s business days.';

-- Ask SILO's catalog: APPEND, never replace, guarded so a re-run adds nothing.
update public.silo_chat_schema_catalog
   set description = coalesce(description, '')
     || ' Payment terms (20260930150000): payment_terms_status is present / none / NULL, and NULL means NOT RETURNED (no read_payment_terms scope, or not synced since), never "no terms". payment_due_at is the earliest open schedule''s due date; total_outstanding is what is still owed at the last sync. Overdue is derived in shopify_orders_v (payment_overdue, payment_days_overdue), not stored.'
 where relname in ('shopify_orders', 'shopify_orders_v')
   and position('Payment terms (20260930150000)' in coalesce(description, '')) = 0;

select public.refresh_chat_schema_catalog();
