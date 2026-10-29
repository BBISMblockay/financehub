-- ============================================================
-- Payment requests: allow 'payroll_payment' as a payment type
--
-- payment_requests.payment_type records HOW a request was paid
-- (check / wire / flexfin / credit_card / other). Payroll runs
-- were previously only expressible as 'other', which loses them
-- in the payment-type breakdown. This adds the value; it does not
-- touch payment_requests_request_type_check, which has carried a
-- separate 'payroll_payment' REQUEST type since 20260807150000.
--
-- Idempotent: the constraint is dropped and recreated, and every
-- value already stored ('check', 'wire', 'flexfin', 'credit_card',
-- 'other', or null) stays valid, so no row can fail validation.
-- ============================================================

alter table public.payment_requests
  drop constraint if exists payment_requests_payment_type_check;

alter table public.payment_requests
  add constraint payment_requests_payment_type_check
  check (payment_type in (
    'check',
    'wire',
    'flexfin',
    'credit_card',
    'payroll_payment',
    'other'
  ));
