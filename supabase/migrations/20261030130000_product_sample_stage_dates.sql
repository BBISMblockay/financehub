-- Product samples: a pipeline stage and its date are one event.
--
-- The Products page sample drawer has an 11-stage pipeline (the pills) and a
-- separate set of free-text date inputs -- "Received", "Whs Ready", "Picked
-- Up". Nothing ties them, so clicking a pill moves the stage and leaves the
-- date blank. Measured on production 2026-10-30 (211 sample rows):
--
--   sample_status         rows   paired date present
--   warehouse_ready        171   2      (warehouse_ready_at)
--   picked_up                6   0      (picked_up_at)
--   received / pps_received /
--     full_run_received     34   34     (received_at)
--
-- So "Received" -- the one date sitting directly beside the pipeline at the
-- top of the drawer -- is kept at 99%, and every later stage's date is
-- effectively never captured. The consequence is not a contradiction like
-- payment_requests had (20261030120000); it is that sample lead time cannot
-- be measured at all. "How long from received to warehouse-ready" has 2
-- answers out of 171, which reads as "we have no data" rather than "the date
-- is not being typed in".
--
-- This migration:
--   1. Stamps the paired date when a sample ENTERS a stage and that date is
--      empty, in a BEFORE trigger -- the browser writes product_samples
--      directly (v2/products.html), so the rule cannot live in page JS.
--   2. Backfills the stranded rows from product_sample_activity, which logged
--      every status change since 2026-08-11 and covers all 169 + 6 of them.
--
-- Three deliberate differences from the payment_requests trigger:
--
-- * It fires only on ENTERING a stage (insert, or sample_status actually
--   changing). An ordinary save that happens to carry a cleared date leaves it
--   cleared, so someone who deliberately empties a date is not overruled.
-- * It never clears a date. A sample pipeline is not reversible the way a
--   payment request is: moving a sample back to an earlier stage does not
--   un-happen its arrival, and the date is a historical fact.
-- * It does not backfill earlier stages. A sample that jumped straight to
--   warehouse_ready has no warehouse_ready date to infer and no received date
--   to invent -- 5 of the 6 picked_up rows have no received_at, and guessing
--   one would be fabrication, not a fix.
--
-- Dates are in the company's own business timezone, not UTC: a pill clicked at
-- 17:30 Pacific is that day's date, not tomorrow's.

begin;

create or replace function public.product_sample_stamp_stage_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- 'received' is the pre-split legacy value, still carried by rows saved
  -- before PPS / Full Run were separated. See v2/products.html
  -- RECEIVED_STATUSES, which lists the same three.
  received_statuses constant text[] := array['received', 'pps_received', 'full_run_received'];
  today date;
begin
  -- Written as a statement, not a DECLARE default of
  -- `tg_op = 'INSERT' or new.sample_status is distinct from old.sample_status`:
  -- that form reads old.sample_status on an INSERT, where OLD is not assigned,
  -- and only survives because `or` happens to short-circuit. Nothing promises
  -- it will.
  if tg_op = 'UPDATE'
     and coalesce(new.sample_status, '') is not distinct from coalesce(old.sample_status, '') then
    return new;
  end if;

  -- Null company falls back to Pacific inside silo_company_timezone(). On
  -- INSERT, stamp_company_entity_id has already run (BEFORE row triggers fire
  -- in alphabetical name order, and 'stamp_' sorts before 'trg_'), so this is
  -- normally the real company anyway.
  today := (now() at time zone public.silo_company_timezone(new.company_entity_id))::date;

  if coalesce(new.sample_status, '') = any (received_statuses) then
    new.received_at := coalesce(new.received_at, today);
  elsif coalesce(new.sample_status, '') = 'warehouse_ready' then
    new.warehouse_ready_at := coalesce(new.warehouse_ready_at, today);
  elsif coalesce(new.sample_status, '') = 'picked_up' then
    new.picked_up_at := coalesce(new.picked_up_at, today);
  end if;

  return new;
end;
$$;

comment on function public.product_sample_stamp_stage_date() is
  'Stamps a product sample''s paired stage date (received_at / warehouse_ready_at / '
  'picked_up_at) in the company''s business timezone when the sample enters that stage '
  'with the date empty. Only on entering a stage, never overwrites a date, never clears '
  'one, and never infers a date for a stage that was skipped. See 20261030130000.';

drop trigger if exists trg_product_sample_stage_date on public.product_samples;
create trigger trg_product_sample_stage_date
  before insert or update of sample_status
  on public.product_samples
  for each row
  execute function public.product_sample_stamp_stage_date();

-- ── Backfill from the activity log ─────────────────────────────────────────
-- product_sample_activity has logged every status change since 2026-08-11
-- (411 rows, actions 'created' and 'status_changed'), and every one of the 169
-- warehouse_ready rows and all 6 picked_up rows missing a date has a row in it.
-- So this is evidence, not a guess, and nothing is stamped with migration day
-- -- the mistake the payment_requests backfill had to be corrected for.
--
-- MAX(created_at), not MIN: 5 samples re-entered a stage (4 of them on a
-- different day), and for a row that IS warehouse_ready now, the date wanted
-- is when it last became so.
--
-- A row with no activity evidence is left NULL on purpose. NULL means "not
-- captured"; a fabricated date would mean "captured, and wrong".
update public.product_samples s
   set warehouse_ready_at = a.stage_date
  from (
    select act.sample_id,
           (max(act.created_at) at time zone public.silo_company_timezone(smp.company_entity_id))::date as stage_date
      from public.product_sample_activity act
      join public.product_samples smp on smp.id = act.sample_id
     where act.to_value = 'warehouse_ready'
     group by act.sample_id, smp.company_entity_id
  ) a
 where a.sample_id = s.id
   and s.sample_status = 'warehouse_ready'
   and s.warehouse_ready_at is null;

update public.product_samples s
   set picked_up_at = a.stage_date
  from (
    select act.sample_id,
           (max(act.created_at) at time zone public.silo_company_timezone(smp.company_entity_id))::date as stage_date
      from public.product_sample_activity act
      join public.product_samples smp on smp.id = act.sample_id
     where act.to_value = 'picked_up'
     group by act.sample_id, smp.company_entity_id
  ) a
 where a.sample_id = s.id
   and s.sample_status = 'picked_up'
   and s.picked_up_at is null;

update public.product_samples s
   set received_at = a.stage_date
  from (
    select act.sample_id,
           (max(act.created_at) at time zone public.silo_company_timezone(smp.company_entity_id))::date as stage_date
      from public.product_sample_activity act
      join public.product_samples smp on smp.id = act.sample_id
     where act.to_value in ('received', 'pps_received', 'full_run_received')
     group by act.sample_id, smp.company_entity_id
  ) a
 where a.sample_id = s.id
   and s.sample_status in ('received', 'pps_received', 'full_run_received')
   and s.received_at is null;

commit;
