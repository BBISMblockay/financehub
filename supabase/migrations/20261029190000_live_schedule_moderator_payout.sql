-- ============================================================
-- 20261029190000_live_schedule_moderator_payout.sql
--
-- TikTok Live slots are worked by two people, not one. The host
-- claims the slot and is paid $25/hr + 3% of that slot's net
-- sales (20260807150000). The second person on the stream -- the
-- MODERATOR -- is paid $25/hr for the same hour and nothing else:
-- no commission, because the commission is the host's share of
-- what the stream sold.
--
-- The moderator is named ON THE CLAIM, so the slot carries who is
-- working it before it runs rather than only at close-out, and the
-- payout is filed by the SAME mechanism as the host's: a
-- payment_requests row created at finalize that rides the normal
-- Request Manager pipeline. There is no separate moderator payroll
-- path to keep in step.
--
-- Two pay routes, because a moderator is not always on payroll:
--   'payroll_payment'        a W-2 moderator, same request type as
--                            the host (the default, and what the
--                            page preselects)
--   'invoice_vendor_payment' a contractor invoicing for the hour
-- Both values already exist in payment_requests_request_type_check
-- (20260807150000 added the first; the second is the original
-- default), so NOTHING about payment_requests changes here. That is
-- deliberate: a new request type would need Request Manager, the
-- submitted-notification label map and the AI suggestion allowlist
-- all taught about it, and a moderator's hour is not a new kind of
-- payment -- it is the same payroll run or the same vendor invoice
-- as everything else in those two buckets.
--
-- moderator_hourly_rate / moderator_payout_total are stamped on the
-- row at finalize, same reasoning as commission_rate and
-- payout_total: history survives a future rate change.
--
-- Rows claimed or finalized before this migration carry NULL in
-- every column below, which reads as "no moderator on that slot" --
-- correct, since there was no way to name one.
-- ============================================================

alter table public.live_sessions
  add column if not exists moderator_name text;

-- The moderator is often a SILO user, but need not be (a contractor
-- who has no login still has to be paid), so the name is the field
-- the payout is drawn on and the profile link is optional context.
alter table public.live_sessions
  add column if not exists moderator_user_id uuid references public.profiles(id);

alter table public.live_sessions
  add column if not exists moderator_pay_type text;

alter table public.live_sessions
  add column if not exists moderator_hourly_rate numeric(8,2);

alter table public.live_sessions
  add column if not exists moderator_payout_total numeric(14,2);

alter table public.live_sessions
  add column if not exists moderator_payment_request_id uuid
    references public.payment_requests(id) on delete set null;

-- Only the two routes above, and only alongside a name: a pay route
-- or a filed request with nobody to pay is a bug, not a state.
alter table public.live_sessions
  drop constraint if exists live_sessions_moderator_pay_type_check;
alter table public.live_sessions
  add constraint live_sessions_moderator_pay_type_check
  check (
    moderator_pay_type is null
    or (moderator_name is not null
        and moderator_pay_type in ('payroll_payment', 'invoice_vendor_payment'))
  );

alter table public.live_sessions
  drop constraint if exists live_sessions_moderator_payout_check;
alter table public.live_sessions
  add constraint live_sessions_moderator_payout_check
  check (
    moderator_name is not null
    or (moderator_payout_total is null and moderator_payment_request_id is null)
  );

create index if not exists live_sessions_moderator_user_idx
  on public.live_sessions (moderator_user_id)
  where moderator_user_id is not null;

-- live_sessions_v is `select ls.*`, and a view's column list is frozen at
-- creation -- ls.* puts the new columns BEFORE the claimer fields, which
-- create-or-replace cannot do (it only appends). Drop and recreate, same as
-- 20260807150000 had to.
drop view if exists public.live_sessions_v;
create view public.live_sessions_v
with (security_invoker = true) as
select
  ls.*,
  claimer.name as claimed_by_name,
  claimer.email as claimed_by_email,
  claimer.avatar_url as claimed_by_avatar_url,
  -- The linked profile's CURRENT name/email where there is one. The board
  -- still displays moderator_name, which is what the payout was filed
  -- against; these are for a surface that wants to reach the person.
  moderator.name as moderator_user_name,
  moderator.email as moderator_user_email
from public.live_sessions ls
left join public.profiles claimer on claimer.id = ls.claimed_by
left join public.profiles moderator on moderator.id = ls.moderator_user_id;
