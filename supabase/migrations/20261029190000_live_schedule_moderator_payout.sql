-- ============================================================
-- 20261029190000_live_schedule_moderator_payout.sql
--
-- TikTok Live slots are worked by two people, not one. The host
-- claims the slot and is paid $25/hr + 3% of that slot's net
-- sales (20260807150000). The second person on the stream -- the
-- MODERATOR -- is paid $25/hr for the same hour, and a share of
-- the 3% only where the host chooses to split it with them: by
-- default the commission is the host's share of what the stream
-- sold.
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
-- moderator_commission_split is the HOST's decision, recorded on the
-- slot (offered on the claim, confirmable at finalize) rather than
-- inferred from the amounts. commission_amount stays what the SLOT
-- earned -- the whole 3% -- so a report of what a live generated does
-- not change shape depending on who it went to;
-- moderator_commission_amount is the moderator's share of that same
-- number and the host's share is the remainder, so the two always add
-- up to commission_amount exactly, with the odd cent going to the
-- host. payout_total and moderator_payout_total each carry their own
-- person's hour plus their own share.
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

-- Off unless the host says otherwise: the default is the arrangement
-- that was in force before a moderator could be named at all.
alter table public.live_sessions
  add column if not exists moderator_commission_split boolean not null default false;

alter table public.live_sessions
  add column if not exists moderator_commission_amount numeric(14,2);

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
    or (moderator_payout_total is null
        and moderator_payment_request_id is null
        and moderator_commission_amount is null
        and moderator_commission_split = false)
  );

-- A share of the commission only where the host agreed to split it, and
-- never more than the slot earned: either of those quietly pays out money
-- the live did not make.
alter table public.live_sessions
  drop constraint if exists live_sessions_moderator_commission_check;
alter table public.live_sessions
  add constraint live_sessions_moderator_commission_check
  check (
    moderator_commission_amount is null
    or (moderator_commission_split
        and moderator_commission_amount >= 0
        and moderator_commission_amount <= coalesce(commission_amount, 0))
  );

-- The moderator is the OTHER person on the stream. Linking the host's own
-- profile would file the host payout and a $25 moderator payout to the same
-- person for the same hour; the page refuses it by name and email too, but a
-- linked profile is the case the database can see.
alter table public.live_sessions
  drop constraint if exists live_sessions_moderator_not_self_check;
alter table public.live_sessions
  add constraint live_sessions_moderator_not_self_check
  check (moderator_user_id is null or moderator_user_id <> claimed_by);

-- A slot that is CLAIMED may carry the agreement with no share yet: the share
-- is not knowable until net sales are entered. A FINALIZED one may not -- an
-- agreed split with no share recorded is a moderator who was promised half and
-- paid none, and it would read on the board as though nothing was agreed.
alter table public.live_sessions
  drop constraint if exists live_sessions_moderator_split_settled_check;
alter table public.live_sessions
  add constraint live_sessions_moderator_split_settled_check
  check (
    status <> 'finalized'
    or not moderator_commission_split
    or moderator_commission_amount is not null
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
