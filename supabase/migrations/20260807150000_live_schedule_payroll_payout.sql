-- ============================================================
-- 20260807150000_live_schedule_payroll_payout.sql
--
-- TikTok Live payout follow-up (PR #342 shipped the board):
--
-- 1. The live hosts are W-2 employees, so the auto-filed AP request
--    is payroll, not a vendor invoice — add 'payroll_payment' to the
--    payment_requests request_type check constraint and file live
--    payouts under it.
--
-- 2. Pay structure is $25/hour on top of the 3% commission. Slots are
--    one hour each, so every finalized slot pays hourly_rate + 3% of
--    that slot's gross (a 2-hour live = 2 claimed slots = 2 × $25 plus
--    each slot's own commission). Both the rate and the computed total
--    are stamped on the row at finalize time, same reasoning as
--    commission_rate: history survives a future rate change.
--
-- Rows finalized before this migration have payout_total NULL (their
-- AP requests were commission-only, filed as invoice_vendor_payment);
-- the board falls back to commission_amount when rendering them.
-- ============================================================

alter table public.payment_requests
  drop constraint if exists payment_requests_request_type_check;

alter table public.payment_requests
  add constraint payment_requests_request_type_check
  check (request_type in (
    'invoice_vendor_payment',
    'inventory_deposit',
    'inventory_balance',
    'inventory_freight',
    'employee_reimbursement',
    'customer_refund',
    'payroll_payment'
  ));

alter table public.live_sessions
  add column if not exists hourly_rate numeric(8,2) not null default 25.00;

alter table public.live_sessions
  add column if not exists payout_total numeric(14,2);

-- live_sessions_v is `select ls.*` so the new columns should flow through,
-- but a view's column list is frozen at creation — and since ls.* places
-- the new columns BEFORE the claimer fields, create-or-replace would fail
-- (it only allows appending at the end). Drop and recreate.
drop view if exists public.live_sessions_v;
create view public.live_sessions_v
with (security_invoker = true) as
select
  ls.*,
  claimer.name as claimed_by_name,
  claimer.email as claimed_by_email,
  claimer.avatar_url as claimed_by_avatar_url
from public.live_sessions ls
left join public.profiles claimer on claimer.id = ls.claimed_by;
