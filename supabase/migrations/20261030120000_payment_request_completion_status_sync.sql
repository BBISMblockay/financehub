-- Payment requests: completion and workflow status are one decision.
--
-- The Request Manager drawer treated "Completed" and "Workflow status" as two
-- independent dropdowns, so a request saved as completed could keep
-- workflow_status = 'new'. The table badge reads the boolean and said
-- "Completed", while every status-sliced surface -- the org calendar feed, any
-- report grouped by workflow_status -- still counted it as New. On Baseballism
-- 2026-10-30 that was 65 rows completed-and-'new', 15 completed-and-'approved',
-- and 5 completed rows with no date_completed at all.
--
-- This migration does two things:
--   1. Normalises the stored rows (all tenants, idempotent).
--   2. Adds a BEFORE trigger so no future write can store the mismatch,
--      whichever surface makes it -- the browser writes payment_requests
--      directly, so the rule cannot live only in page JS.
--
-- Terminal statuses are 'paid', 'rejected' and 'cancelled': a completed request
-- sits in one of them, and completing one that is not in one means paid.
-- 'rejected' and 'cancelled' are preserved, never rewritten to 'paid'.
--
-- The trigger normalises rather than raising, so a write that would previously
-- have stored a contradiction still succeeds -- nothing that works today starts
-- failing.

begin;

create or replace function public.payment_request_sync_completion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  terminal constant text[] := array['paid', 'rejected', 'cancelled'];
  status_changed boolean := tg_op = 'UPDATE'
    and coalesce(new.workflow_status, '') is distinct from coalesce(old.workflow_status, '');
begin
  if status_changed then
    -- The status just written decides whether the request is done.
    new.completed := coalesce(new.workflow_status, '') = any (terminal);
  elsif coalesce(new.completed, false) and coalesce(new.workflow_status, '') <> all (terminal) then
    -- Completing a request always lands it in a terminal status.
    new.workflow_status := 'paid';
  elsif not coalesce(new.completed, false) and coalesce(new.workflow_status, '') = any (terminal) then
    -- Reopening: a terminal status cannot stand on an open request.
    new.workflow_status := 'approved';
  end if;

  if coalesce(new.completed, false) then
    new.date_completed := coalesce(new.date_completed, current_date);
  else
    new.date_completed := null;
  end if;

  return new;
end;
$$;

comment on function public.payment_request_sync_completion() is
  'Keeps payment_requests.completed, workflow_status and date_completed consistent. '
  'Terminal statuses: paid, rejected, cancelled. Mirrors the Request Manager drawer rule.';

drop trigger if exists trg_payment_request_sync_completion on public.payment_requests;
create trigger trg_payment_request_sync_completion
  before insert or update of completed, workflow_status, date_completed
  on public.payment_requests
  for each row
  execute function public.payment_request_sync_completion();

-- 1. Completed rows stranded in a non-terminal status become paid, and keep a
--    historical completion date. The date is set in THIS statement, not a later
--    one: the trigger above is already installed, so a row left with a null
--    date_completed would be stamped current_date here and no longer qualify
--    for step 2 -- moving a September completion to migration day.
update public.payment_requests
   set workflow_status = 'paid',
       date_completed = coalesce(date_completed, updated_at::date, created_at::date, submitted_at::date)
 where completed
   and coalesce(workflow_status, '') <> all (array['paid', 'rejected', 'cancelled']);

-- 2. Any remaining completed row with no completion date (already terminal)
--    gets the best date on the row.
update public.payment_requests
   set date_completed = coalesce(updated_at, created_at, submitted_at)::date
 where completed
   and date_completed is null
   and coalesce(updated_at, created_at, submitted_at) is not null;

-- 3. Open rows must not carry a completion date.
update public.payment_requests
   set date_completed = null
 where not coalesce(completed, false)
   and date_completed is not null;

commit;
