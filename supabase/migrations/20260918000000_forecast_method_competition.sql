-- ============================================================================
-- The forecast competition: several methods, frozen side by side, with the
-- SELECTION itself recorded before the cutoff it governs.
--
-- WHAT WAS MISSING. 20260917140000 freezes ONE method's forecast per cutoff.
-- Running a competition needs two more things:
--
--   1. Every method's forecast for the SAME category and window, frozen at the
--      same cutoff -- otherwise the comparison is between different questions.
--   2. A record of WHICH method was chosen, written BEFORE the outcome it will
--      be judged on. Without that, a competition where all four forecasts are
--      frozen but the pick is not is unfalsifiable: any winner can be named
--      afterwards and the ledger cannot contradict it. That is the exact
--      failure mode a week of retrospective testing kept producing.
--
-- WHY THE LEDGER NEEDED LOOSENING. Its provenance columns (recent_demand,
-- raw_ratio, clamped_ratio, ...) are specific to Candidate_YoY_Shift_v1 and are
-- NOT NULL, so a seasonal-naive or run-rate forecast physically could not be
-- stored. They become nullable here and stay as that method's own detail.
--
-- THE GUARANTEE IS NOT WEAKENED, it is generalised. The no-look-ahead CHECK
-- used to key on those method-specific columns; a nullable column in a CHECK
-- passes trivially on NULL, which would have quietly gutted it. So every method
-- must now record `inputs_through_date` -- the newest day of source data it
-- read -- NOT NULL, with `inputs_through_date < cutoff_date` enforced by the
-- table. That is method-agnostic and strictly stronger: a method added later
-- inherits it without anyone remembering to.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Generalise the ledger
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.forecast_candidate_ledger
  add column if not exists inputs_through_date date,
  add column if not exists method_inputs jsonb not null default '{}'::jsonb;

-- Backfill before the NOT NULL. Candidate_YoY_Shift_v1 reads whole months
-- strictly before its cutoff, so the newest day it saw is the day before.
update public.forecast_candidate_ledger
   set inputs_through_date = cutoff_date - 1
 where inputs_through_date is null;

alter table public.forecast_candidate_ledger
  alter column inputs_through_date set not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.forecast_candidate_ledger'::regclass
                    and conname = 'forecast_ledger_inputs_precede_cutoff') then
    alter table public.forecast_candidate_ledger
      add constraint forecast_ledger_inputs_precede_cutoff
      check (inputs_through_date < cutoff_date);
  end if;
end $$;

-- The method-specific columns become optional. The ORIGINAL no-look-ahead CHECK
-- stays exactly as it was: it still binds every row that populates them, and
-- the generic constraint above binds every row regardless.
alter table public.forecast_candidate_ledger
  alter column recent_window_start      drop not null,
  alter column recent_window_end        drop not null,
  alter column recent_demand            drop not null,
  alter column prior_window_start       drop not null,
  alter column prior_window_end         drop not null,
  alter column prior_demand             drop not null,
  alter column prior_year_target_month  drop not null,
  alter column prior_year_target_demand drop not null,
  alter column raw_ratio                drop not null,
  alter column clamped_ratio            drop not null,
  alter column ratio_clamp_low          drop not null,
  alter column ratio_clamp_high         drop not null,
  alter column ratio_was_clamped        drop not null;

comment on column public.forecast_candidate_ledger.inputs_through_date is
  'The newest day of source data this forecast read. Required of EVERY method and bound by forecast_ledger_inputs_precede_cutoff, so the prospective guarantee does not depend on any one method''s provenance columns being populated.';
comment on column public.forecast_candidate_ledger.method_inputs is
  'Per-method provenance as jsonb. The typed columns beside it belong to Candidate_YoY_Shift_v1 and are null for every other method.';

-- The ledger view gains three new columns, APPENDED. A create-or-replace cannot
-- insert a column mid-list ("cannot change name of view column") and cannot
-- remove one at all, so this is dropped first -- which is also what makes THIS
-- migration re-runnable after a later one widens the view again.
drop view if exists public.forecast_candidate_ledger_v;

create or replace view public.forecast_candidate_ledger_v
with (security_invoker = true) as
select
  l.id,
  l.company_entity_id,
  l.candidate_id,
  l.sku_category,
  l.horizon_days,
  l.cutoff_date,
  l.horizon_start_date,
  l.horizon_end_date,
  l.forecast_qty,
  l.recent_window_start,
  l.recent_window_end,
  l.recent_demand,
  l.prior_window_start,
  l.prior_window_end,
  l.prior_demand,
  l.prior_year_target_month,
  l.prior_year_target_demand,
  l.raw_ratio,
  l.clamped_ratio,
  l.ratio_was_clamped,
  l.ratio_clamp_low,
  l.ratio_clamp_high,
  l.method_version,
  l.candidate_spec,
  l.source_relation,
  l.executed_at,
  l.voided_at,
  l.void_reason,
  l.frozen_days_into_horizon,
  l.max_issuance_lag_days,
  case
    when l.voided_at is not null then 'VOIDED'
    when l.executed_at >= timezone('America/Los_Angeles', l.horizon_end_date::timestamp)
      then 'NOT PROSPECTIVE'
    when l.frozen_days_into_horizon > l.max_issuance_lag_days then 'ISSUED LATE — NOT SCORED'
    when l.horizon_end_date
         <= coalesce(public.forecast_actuals_matured_through_active(), date '0001-01-01') + 1
      then 'SCORABLE'
    else 'PROSPECTIVE — NOT SCORED'
  end as status_label,
  l.inputs_through_date,
  l.method_inputs,
  -- The horizon a method was asked for, in the unit the method was specified
  -- in. horizon_days beside it is the same window in days and is what the
  -- identity index uses; a report filtering on months must not have to
  -- rediscover that 3 months is 89, 90, 91 or 92 days depending on where it
  -- starts.
  (l.candidate_spec->>'horizon_months')::integer as horizon_months
from public.forecast_candidate_ledger l;

revoke all on public.forecast_candidate_ledger_v from anon;
grant select on public.forecast_candidate_ledger_v to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. The existing writer records the new column
-- ─────────────────────────────────────────────────────────────────────────────
-- inputs_through_date is NOT NULL, and record_forecast_candidate_run() does not
-- know about it -- so without this the monthly job that has been freezing the
-- Youth candidate every month would start failing on its next run, in
-- production, silently until somebody read the Actions log. Caught by the
-- database suite, which drives the real writer rather than a hand-built INSERT.
--
-- The function is reproduced whole rather than patched, because there is no way
-- to add a column to a plpgsql INSERT without replacing the function, and
-- text-editing a stored body would be worse than a copy that is visibly a copy.
-- Copied from 20260917180000, NOT from 20260917140000: the second migration
-- dropped and recreated this function to remove a tenant-specific default on
-- p_sku_category, and copying the older body would have quietly put that
-- default back (create-or-replace cannot remove a default, but it can add one).
-- verify_v2_schema.sql checks for exactly that and caught it.
-- The ONLY difference from 20260917180000 is the inputs_through_date column and
-- its value. If this function changes again, change it there and re-copy it
-- here -- apply_all_post_merge.sql runs the migrations in order, so this
-- version is the one that survives.


create or replace function public.record_forecast_candidate_run(
  p_company_entity_id uuid,
  p_cutoff_date date,
  p_sku_category text,
  p_candidate_id text default 'Candidate_YoY_Shift_v1',
  p_horizon_days integer default 30,
  p_clamp_low numeric default 0.60,
  p_clamp_high numeric default 1.80,
  p_max_issuance_lag_days integer default 5
)
returns table (
  action text,
  ledger_id uuid,
  forecast_qty numeric,
  cutoff_date date,
  reason text
)
language plpgsql
volatile
security definer
set search_path = public
as $$
-- The OUT columns of this function (cutoff_date, forecast_qty, ...) share
-- names with the ledger's own columns, which makes a bare reference inside
-- the INSERT -- notably the ON CONFLICT target -- ambiguous. Resolve in
-- favour of the column; every variable here is p_* or v_* and so unaffected.
#variable_conflict use_column
declare
  v_existing public.forecast_candidate_ledger;
  v_calc record;
  v_id uuid;
  v_matured_through date;
  v_horizon_end date := (p_cutoff_date + interval '1 month')::date;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'record_forecast_candidate_run: a company is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing
  from public.forecast_candidate_ledger l
  where l.company_entity_id = p_company_entity_id
    and l.candidate_id = p_candidate_id
    and l.sku_category = p_sku_category
    and l.horizon_days = p_horizon_days
    and l.cutoff_date = p_cutoff_date;

  if found then
    return query select
      case when v_existing.voided_at is null then 'existing' else 'existing_voided' end,
      v_existing.id, v_existing.forecast_qty, v_existing.cutoff_date,
      'frozen at ' || v_existing.executed_at::text || '; not recalculated';
    return;
  end if;

  -- A cutoff may only be frozen once the source has synced through the day
  -- BEFORE it. Without this a job firing at 00:05 on the first of the month
  -- reads a t-1 that is still landing, understates the recent window, and
  -- freezes that understatement forever -- the ledger has no second chance by
  -- design. This is the same maturity clock the scorer uses, so a forecast is
  -- never written from data the scorer would refuse to grade.
  v_matured_through := public.forecast_actuals_matured_through(p_company_entity_id);
  if v_matured_through is null or v_matured_through < p_cutoff_date - 1 then
    return query select 'deferred', null::uuid, null::numeric, p_cutoff_date,
      format('source is synced through %s; cutoff %s needs complete data through %s',
             coalesce(v_matured_through::text, 'never measured'), p_cutoff_date, p_cutoff_date - 1);
    return;
  end if;

  -- EXPIRED: the horizon this cutoff covers has already finished, so a
  -- forecast written now would be a retrodiction wearing a prospective label.
  -- Refused, and deliberately refused rather than written-and-flagged: the
  -- honest record of a month nobody forecast is an ABSENT row, not a row
  -- claiming a forecast was made. The catch-up loop stays useful for a horizon
  -- still open; it just cannot reach back past one that closed.
  -- `v_horizon_end` is EXCLUSIVE -- the first day NOT covered -- so the outcome
  -- is complete once the source has synced through `v_horizon_end - 1`, a day
  -- EARLIER. Getting this comparison wrong by that one day is not cosmetic: it
  -- let the August cutoff be frozen on 17 September, with August's outcome
  -- fully in hand, which is precisely the retrodiction this guard exists to
  -- refuse. Caught by the integrated runner test, not by reading the line.
  if v_matured_through >= v_horizon_end - 1 then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s is already fully synced (through %s); a forecast written now would not be prospective',
             p_cutoff_date, v_horizon_end - 1, v_matured_through);
    return;
  end if;

  -- The SAME question asked of the CALENDAR rather than of the data, because
  -- the table's CHECK is written in wall-clock terms and the two can disagree.
  -- Concretely: on 3 November with October synced only through the 30th, the
  -- maturity test above passes, the row is computed, and then the INSERT
  -- violates the constraint -- so a lagging sync surfaced as a raised
  -- exception, counted by the runner as a failure and exiting nonzero. A late
  -- sync is not a job failure; it is an expired cutoff. Matching the
  -- constraint's own expression here means that path can no longer be reached.
  if timezone('America/Los_Angeles', now())::date >= v_horizon_end then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s closed on the calendar before this run (today is %s Pacific), whatever the source has synced',
             p_cutoff_date, v_horizon_end - 1, timezone('America/Los_Angeles', now())::date);
    return;
  end if;

  select * into v_calc
  from public.forecast_yoy_shift_v1(
    p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_days, p_clamp_low, p_clamp_high);

  if not v_calc.eligible then
    -- Nothing is written. An ineligible cutoff must stay absent from the
    -- ledger: a row carrying a null or a zero would be indistinguishable
    -- from a real forecast of nothing when the evaluator reads it back.
    return query select 'skipped', null::uuid, null::numeric, p_cutoff_date, v_calc.ineligible_reason;
    return;
  end if;

  insert into public.forecast_candidate_ledger (
    company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
    forecast_qty, horizon_start_date, horizon_end_date,
    recent_window_start, recent_window_end, recent_demand,
    prior_window_start, prior_window_end, prior_demand,
    prior_year_target_month, prior_year_target_demand,
    raw_ratio, clamped_ratio, ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
    inputs_through_date,
    method_version, candidate_spec, source_relation, max_issuance_lag_days)
  values (
    p_company_entity_id, p_candidate_id, p_cutoff_date, p_sku_category, p_horizon_days,
    v_calc.forecast_qty, p_cutoff_date, v_horizon_end,
    v_calc.recent_window_start, v_calc.recent_window_end, v_calc.recent_demand,
    v_calc.prior_window_start, v_calc.prior_window_end, v_calc.prior_demand,
    v_calc.prior_year_target_month, v_calc.prior_year_target_demand,
    v_calc.raw_ratio, v_calc.clamped_ratio, p_clamp_low, p_clamp_high, v_calc.ratio_was_clamped,
    -- The newest day this method read. Its windows are whole months strictly
    -- before the cutoff, so the newest day it could have seen is the day
    -- before -- the same value the backfill above wrote for every existing row.
    (p_cutoff_date - 1),
    'yoy_shift_v1',
    jsonb_build_object(
      'candidate_id', p_candidate_id,
      'recent_window_months', 3, 'recent_window_offset_months', 3,
      'prior_window_months', 3, 'prior_window_offset_months', 15,
      'target_offset_months', 12,
      'clamp_low', p_clamp_low, 'clamp_high', p_clamp_high,
      'rounding', 'round_half_up_to_whole_units',
      'stockout_imputation', false, 'launch_adjustment', false,
      'max_issuance_lag_days', p_max_issuance_lag_days,
      'source_report_id', 'f98754f7-47a6-4eeb-8a8b-eece9a069432'),
    'sales_monthly_product_type_rollup_mv', p_max_issuance_lag_days)
  -- Two runners racing at the same cutoff: the loser writes nothing and reads
  -- the winner's row back, so a race produces one frozen number, not two.
  on conflict (company_entity_id, candidate_id, sku_category, horizon_days, cutoff_date)
  do nothing
  returning id into v_id;

  if v_id is null then
    select l.id into v_id
    from public.forecast_candidate_ledger l
    where l.company_entity_id = p_company_entity_id
      and l.candidate_id = p_candidate_id
      and l.sku_category = p_sku_category
      and l.horizon_days = p_horizon_days
      and l.cutoff_date = p_cutoff_date;
    return query select 'existing', v_id, v_calc.forecast_qty, p_cutoff_date,
      'written concurrently by another run; not recalculated';
    return;
  end if;

  return query select 'inserted', v_id, v_calc.forecast_qty, p_cutoff_date, null::text;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The selection record
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (company, category, horizon, the cutoff it starts governing).
-- Append-only, like the ledger: a selection that can be revised after the fact
-- proves nothing, which is the whole reason this table exists rather than a
-- column on some settings row.
create table if not exists public.forecast_method_selections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  sku_category text not null,
  horizon_months integer not null,
  selected_method text not null,
  -- The first cutoff this selection governs. Every ledger row at or after it,
  -- for this category and horizon, is judged against this method.
  effective_from_cutoff date not null,
  -- The window the choice was made FROM. Both ends stored so the claim is
  -- checkable years later without re-deriving anything.
  evidence_from date not null,
  evidence_to date not null,
  -- The rule, the knob it was run with, and every method's score over the
  -- window -- not just the winner's. A pick recorded without its runner-up is
  -- unfalsifiable: the claim being made is "this was the lowest WAPE", and
  -- checking it needs the others. `evidence_months` is stored because it is the
  -- ONLY knob in the selection, and re-running with different values until a
  -- preferred method wins is the one way this procedure could be gamed.
  selection_basis jsonb not null,
  selected_at timestamptz not null default now(),
  selected_by uuid,
  note text,

  constraint fms_horizon_positive check (horizon_months > 0),
  constraint fms_evidence_ordered check (evidence_to >= evidence_from),
  constraint fms_cutoff_is_month_start
    check (effective_from_cutoff = date_trunc('month', effective_from_cutoff)::date),
  -- THE POINT OF THE TABLE. The evidence a selection was made from must END
  -- BEFORE the first cutoff it governs. Without this the table records a
  -- decision that could have been made after seeing the result it is used to
  -- justify, which is indistinguishable from no record at all. Enforced here
  -- rather than in the job, because a service-role writer cannot dodge a CHECK.
  constraint fms_evidence_precedes_cutoff check (evidence_to < effective_from_cutoff),
  constraint fms_method_not_blank check (btrim(selected_method) <> ''),
  constraint fms_category_not_blank check (btrim(sku_category) <> '')
);

create unique index if not exists forecast_method_selections_identity_uq
  on public.forecast_method_selections
  (company_entity_id, sku_category, horizon_months, effective_from_cutoff);

create index if not exists forecast_method_selections_lookup_idx
  on public.forecast_method_selections
  (company_entity_id, sku_category, horizon_months, effective_from_cutoff desc);

comment on table public.forecast_method_selections is
  'Which forecasting method was chosen for a category and horizon, and the evidence window it was chosen from. Append-only. fms_evidence_precedes_cutoff is the constraint that makes a selection prospective: the evidence must end before the first cutoff the selection governs.';

create or replace function public.forecast_method_selections_append_only()
returns trigger language plpgsql as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'forecast_method_selections is append-only: the selection for % / %-month at cutoff % cannot be deleted',
      old.sku_category, old.horizon_months, old.effective_from_cutoff
      using errcode = 'restrict_violation';
  end if;
  raise exception 'forecast_method_selections is append-only: record a NEW selection for a later cutoff instead of editing row %',
    old.id using errcode = 'restrict_violation';
end;
$fn$;

drop trigger if exists forecast_method_selections_append_only on public.forecast_method_selections;
create trigger forecast_method_selections_append_only
  before update or delete on public.forecast_method_selections
  for each row execute function public.forecast_method_selections_append_only();

drop trigger if exists stamp_company_entity_id on public.forecast_method_selections;
create trigger stamp_company_entity_id
  before insert on public.forecast_method_selections
  for each row execute function public.stamp_company_entity_id();

alter table public.forecast_method_selections enable row level security;

drop policy if exists forecast_method_selections_select on public.forecast_method_selections;
create policy forecast_method_selections_select on public.forecast_method_selections
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Supabase grants ALL on a new public table by default, and RLS with no write
-- policy turns a client write into a SUCCESS WITH ZERO ROWS rather than an
-- error. Revoke first, grant second.
revoke all on public.forecast_method_selections from anon, authenticated;
grant select on public.forecast_method_selections to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The competing methods
-- ─────────────────────────────────────────────────────────────────────────────
-- One function per method, all with the same signature and the same return
-- shape, so the writer dispatches on a name and a method added later needs no
-- change to anything above it.
--
-- Every one of them:
--   * bounds its base read at `month_start < p_cutoff_date`, so no method can
--     read its own outcome even if its window arithmetic is wrong;
--   * requires its months to be PRESENT, never summing what happens to be there
--     -- an absent month in the rollup means "not recorded", not "sold none",
--     and treating it as zero reports a data gap as a collapse in demand;
--   * reports inputs_through_date, which the ledger's CHECK then binds.
--
-- The parameters are fixed in advance and are conventional defaults, NOT values
-- searched against this tenant's history: a 3-month recent window, a 12-month
-- seasonal lookback, an even blend. Searching them is what produced a week of
-- results that did not survive their own holdout.

create or replace function public.forecast_seasonal_naive_v1(
  p_company_entity_id uuid, p_cutoff_date date, p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_from date := (p_cutoff_date - interval '12 months')::date;
  v_to   date := (p_cutoff_date - interval '12 months' + make_interval(months => p_horizon_months))::date;
  v_units numeric; v_n integer;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'forecast_seasonal_naive_v1: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(sum(units), 0), count(*)::integer into v_units, v_n
  from (select r.month_start, sum(r.units)::numeric as units
          from public.sales_monthly_product_type_rollup_mv r
         where r.company_entity_id = p_company_entity_id
           and r.product_type = p_sku_category
           and r.month_start < p_cutoff_date
         group by r.month_start) v
  where v.month_start >= v_from and v.month_start < v_to;

  if v_n <> p_horizon_months then
    return query select false,
      format('last year''s matching window %s..%s has %s of %s months recorded', v_from, v_to, v_n, p_horizon_months),
      null::numeric, (p_cutoff_date - 1),
      jsonb_build_object('window_from', v_from, 'window_to', v_to, 'months_present', v_n);
    return;
  end if;
  return query select true, null::text, round(greatest(v_units, 0)), (p_cutoff_date - 1),
    jsonb_build_object('method', 'seasonal_naive_v1', 'window_from', v_from, 'window_to', v_to,
                       'last_year_units', v_units, 'months_present', v_n);
end;
$fn$;

create or replace function public.forecast_run_rate_v1(
  p_company_entity_id uuid, p_cutoff_date date, p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_from date := (p_cutoff_date - interval '3 months')::date;
  v_units numeric; v_n integer;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'forecast_run_rate_v1: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(sum(units), 0), count(*)::integer into v_units, v_n
  from (select r.month_start, sum(r.units)::numeric as units
          from public.sales_monthly_product_type_rollup_mv r
         where r.company_entity_id = p_company_entity_id
           and r.product_type = p_sku_category
           and r.month_start < p_cutoff_date
         group by r.month_start) v
  where v.month_start >= v_from and v.month_start < p_cutoff_date;

  if v_n <> 3 then
    return query select false,
      format('recent window %s..%s has %s of 3 months recorded', v_from, p_cutoff_date, v_n),
      null::numeric, (p_cutoff_date - 1),
      jsonb_build_object('window_from', v_from, 'months_present', v_n);
    return;
  end if;
  return query select true, null::text,
    round(greatest(v_units / 3.0 * p_horizon_months, 0)), (p_cutoff_date - 1),
    jsonb_build_object('method', 'run_rate_v1', 'window_from', v_from, 'window_to', p_cutoff_date,
                       'recent_3m_units', v_units, 'monthly_pace', round(v_units / 3.0, 4));
end;
$fn$;

create or replace function public.forecast_blend_v1(
  p_company_entity_id uuid, p_cutoff_date date, p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
declare s record; r record;
begin
  -- Composed from the two above rather than re-deriving their windows, so the
  -- blend cannot drift away from the methods it is a blend OF.
  select * into s from public.forecast_seasonal_naive_v1(p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  select * into r from public.forecast_run_rate_v1(p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  if not s.eligible or not r.eligible then
    return query select false,
      format('blend needs both halves: seasonal %s / run rate %s',
             coalesce(s.ineligible_reason, 'ok'), coalesce(r.ineligible_reason, 'ok')),
      null::numeric, (p_cutoff_date - 1),
      jsonb_build_object('seasonal', s.method_inputs, 'run_rate', r.method_inputs);
    return;
  end if;
  return query select true, null::text,
    round(0.5 * s.forecast_qty + 0.5 * r.forecast_qty), (p_cutoff_date - 1),
    jsonb_build_object('method', 'blend_v1', 'weight_seasonal', 0.5, 'weight_run_rate', 0.5,
                       'seasonal_qty', s.forecast_qty, 'run_rate_qty', r.forecast_qty,
                       'seasonal', s.method_inputs, 'run_rate', r.method_inputs);
end;
$fn$;

do $$
declare f text;
begin
  foreach f in array array['forecast_seasonal_naive_v1', 'forecast_run_rate_v1', 'forecast_blend_v1'] loop
    execute format('revoke all on function public.%I(uuid, date, text, integer) from public, anon, authenticated', f);
    execute format('grant execute on function public.%I(uuid, date, text, integer) to service_role', f);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Scoring, selection, and a writer that works for any method
-- ─────────────────────────────────────────────────────────────────────────────
-- One dispatcher, so every caller below names a method by string and
-- a method added later is one branch, not a change in five places.
create or replace function public.forecast_for_method(
  p_method text, p_company_entity_id uuid, p_cutoff_date date,
  p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if p_method = 'Candidate_YoY_Shift_v1' then
    -- The frozen candidate is a ONE-MONTH method by specification. It is scored
    -- alongside the others only at that horizon; asking it for a longer window
    -- would be inventing a method nobody froze.
    if p_horizon_months <> 1 then
      return query select false,
        'Candidate_YoY_Shift_v1 is specified for a single month only'::text,
        null::numeric, (p_cutoff_date - 1), '{}'::jsonb;
      return;
    end if;
    return query
      select y.eligible, y.ineligible_reason, y.forecast_qty, (p_cutoff_date - 1),
             jsonb_build_object('method', 'Candidate_YoY_Shift_v1',
                                'recent_demand', y.recent_demand, 'prior_demand', y.prior_demand,
                                'raw_ratio', y.raw_ratio, 'clamped_ratio', y.clamped_ratio)
      from public.forecast_yoy_shift_v1(p_company_entity_id, p_cutoff_date, p_sku_category, 30) y;
  elsif p_method = 'seasonal_naive_v1' then
    return query select * from public.forecast_seasonal_naive_v1(p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  elsif p_method = 'run_rate_v1' then
    return query select * from public.forecast_run_rate_v1(p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  elsif p_method = 'blend_v1' then
    return query select * from public.forecast_blend_v1(p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  else
    raise exception 'forecast_for_method: unknown method %', p_method using errcode = 'invalid_parameter_value';
  end if;
end;
$fn$;

revoke all on function public.forecast_for_method(text, uuid, date, text, integer) from public, anon, authenticated;
grant execute on function public.forecast_for_method(text, uuid, date, text, integer) to service_role;

-- Score every method at historical origins. Each origin's forecast is computed
-- by that method's own function, which is bounded at `month_start < cutoff`, so
-- no score here can be inflated by data the forecast would not have had. The
-- caller bounds the origins themselves, and the selection table's CHECK then
-- bounds the whole window against the cutoff it governs.
create or replace function public.score_forecast_methods(
  p_company_entity_id uuid, p_sku_category text, p_horizon_months integer,
  p_from date, p_to date
) returns table (method text, windows integer, actual_units numeric,
                 forecast_units numeric, wape numeric, bias numeric)
language plpgsql stable security definer set search_path = public as $fn$
begin
  -- A refusal, not an empty result. The SQL-bodied first draft folded this into
  -- a WHERE clause, so a null company returned "no methods could be scored" --
  -- indistinguishable from a category with no history.
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'score_forecast_methods: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  return query
  with methods(m) as (
    values ('Candidate_YoY_Shift_v1'), ('seasonal_naive_v1'), ('run_rate_v1'), ('blend_v1')
  ),
  origins as (
    select g::date as o
    from generate_series(date_trunc('month', p_from)::date, p_to, interval '1 month') g
    -- the whole outcome window must sit inside the evidence range, so a method
    -- is never credited for a window whose tail had not happened yet
    where (g::date + make_interval(months => p_horizon_months))::date <= (p_to + 1)
  ),
  -- Collapsed to one row per MONTH before anything counts them. The rollup is
  -- grained by (company, month, location_tag, channel, product_type) -- measured
  -- on production 2026-09-18, Youth carries 12 to 14 location rows in every
  -- month -- so counting raw rows as months made `months_present` 72 for a
  -- six-month window and dropped every window as incomplete. Nothing would ever
  -- have been scored or selected, in production, with every test passing: the
  -- fixture was one row per month and hid the real grain. This mirrors
  -- forecast_yoy_shift_v1's `visible` CTE, which is the established idiom here
  -- and is why the shipped candidate was never affected.
  monthly as (
    select r.month_start, sum(r.units)::numeric as units
    from public.sales_monthly_product_type_rollup_mv r
    where r.company_entity_id = p_company_entity_id
      and r.product_type = p_sku_category
    group by r.month_start
  ),
  actuals as (
    select o.o,
           sum(m.units)::numeric as actual,
           count(*)::integer as months_present
    from origins o
    join monthly m
      on m.month_start >= o.o
     and m.month_start < (o.o + make_interval(months => p_horizon_months))::date
    group by o.o
  ),
  scored as (
    select m.m as method, a.actual, f.forecast_qty
    from methods m
    cross join actuals a
    cross join lateral public.forecast_for_method(
      m.m, p_company_entity_id, a.o, p_sku_category, p_horizon_months) f
    -- an absent month makes the window unscorable: a partial actual would
    -- flatter whichever method happened to forecast low
    where a.months_present = p_horizon_months
      and a.actual > 0
      and f.eligible
  )
  select s.method, count(*)::integer, sum(s.actual), sum(s.forecast_qty),
         sum(abs(s.forecast_qty - s.actual)) / nullif(sum(s.actual), 0),
         sum(s.forecast_qty - s.actual) / nullif(sum(s.actual), 0)
  from scored s
  group by s.method
  order by 5;
end;
$fn$;


-- Service role only. It takes a company id and reads that company's sales, and
-- inside a SECURITY DEFINER function there is no way to tell a service-role
-- caller from a user -- so an `authenticated` grant here would be a tenant leak
-- dressed as a research tool. Users read the RESULT of a selection through
-- forecast_method_selections, whose RLS scopes it to their own company.
revoke all on function public.score_forecast_methods(uuid, text, integer, date, date) from public, anon, authenticated;
grant execute on function public.score_forecast_methods(uuid, text, integer, date, date) to service_role;

-- Choose a method and RECORD the choice, with the evidence it was chosen from.
-- The table's fms_evidence_precedes_cutoff CHECK is what makes the record
-- meaningful; this function additionally refuses to score a window that reaches
-- the cutoff, so the refusal is legible rather than a constraint violation.
create or replace function public.select_forecast_method(
  p_company_entity_id uuid, p_sku_category text, p_horizon_months integer,
  p_effective_from_cutoff date, p_evidence_months integer default 18,
  p_note text default null
) returns table (selected_method text, evidence_from date, evidence_to date,
                 windows integer, wape numeric, basis jsonb)
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_to   date := (p_effective_from_cutoff - 1);
  v_from date := (p_effective_from_cutoff - make_interval(months => p_evidence_months))::date;
  v_basis jsonb;
  v_best_method text;
  v_stored_method text; v_stored_from date; v_stored_to date; v_stored_basis jsonb;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'select_forecast_method: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_effective_from_cutoff <> date_trunc('month', p_effective_from_cutoff)::date then
    raise exception 'select_forecast_method: the cutoff must be the first of a month, got %',
      p_effective_from_cutoff using errcode = 'invalid_parameter_value';
  end if;

  -- BEFORE scoring anything. A selection for this exact key is already frozen
  -- and append-only, so nothing computed below can change it -- and reaching
  -- for the scorer first was a real defect: a late deletion or a source gap can
  -- leave today's scores empty, and the empty-score path returned NULL and
  -- logged "NO SELECTION" while the durable selection was sitting right there.
  -- Reading first also makes a re-run free, which matters when the monthly job
  -- scores four methods over eighteen origins for every category at every
  -- horizon.
  select s.selected_method, s.evidence_from, s.evidence_to, s.selection_basis
    into v_stored_method, v_stored_from, v_stored_to, v_stored_basis
  from public.forecast_method_selections s
  where s.company_entity_id = p_company_entity_id
    and s.sku_category = p_sku_category
    and s.horizon_months = p_horizon_months
    and s.effective_from_cutoff = p_effective_from_cutoff;

  if v_stored_method is not null then
    return query select
      v_stored_method, v_stored_from, v_stored_to,
      (v_stored_basis->'scores'->0->>'windows')::integer,
      (v_stored_basis->'scores'->0->>'wape')::numeric,
      coalesce(v_stored_basis, '{}'::jsonb);
    return;
  end if;

  -- Scored ONCE. The first version called the scorer twice -- once to build the
  -- basis and once to take the winner -- which is the same work done twice and
  -- would double a monthly run that already scores four methods over eighteen
  -- origins for every category at every horizon. The winner is read back out of
  -- the basis instead, which also makes it impossible for the two to disagree.
  select jsonb_build_object(
           'rule', 'lowest WAPE over the evidence window, no tie-break and no weighting',
           'evidence_months', p_evidence_months,
           'evidence_from', v_from, 'evidence_to', v_to,
           'scores', coalesce(jsonb_agg(jsonb_build_object(
             'method', s.method, 'windows', s.windows, 'wape', round(s.wape, 6),
             'bias', round(s.bias, 6), 'actual_units', s.actual_units)
             order by s.wape) filter (where s.wape is not null),
             '[]'::jsonb))
    into v_basis
  from public.score_forecast_methods(
    p_company_entity_id, p_sku_category, p_horizon_months, v_from, v_to) s;

  -- Element 0 is the lowest WAPE: the aggregate above is ordered by it and
  -- unscorable methods are filtered out rather than sorted to the end.
  if jsonb_array_length(coalesce(v_basis->'scores', '[]'::jsonb)) > 0 then
    v_best_method := v_basis->'scores'->0->>'method';
  end if;

  if v_best_method is null then
    -- No method could be scored over the evidence window. Recording a pick
    -- anyway would be a guess wearing a selection's clothes.
    return query select null::text, v_from, v_to, 0, null::numeric,
      coalesce(v_basis, '{}'::jsonb);
    return;
  end if;

  insert into public.forecast_method_selections
    (company_entity_id, sku_category, horizon_months, selected_method,
     effective_from_cutoff, evidence_from, evidence_to, selection_basis, selected_by, note)
  values
    (p_company_entity_id, p_sku_category, p_horizon_months, v_best_method,
     p_effective_from_cutoff, v_from, v_to, coalesce(v_basis, '{}'::jsonb), auth.uid(), p_note)
  on conflict (company_entity_id, sku_category, horizon_months, effective_from_cutoff)
  do nothing
  -- Table-qualified: this function's RETURNS TABLE declares columns with the
  -- same names, and an unqualified reference here is ambiguous.
  returning forecast_method_selections.selected_method,
            forecast_method_selections.evidence_from,
            forecast_method_selections.evidence_to,
            forecast_method_selections.selection_basis
       into v_stored_method, v_stored_from, v_stored_to, v_stored_basis;

  -- ON CONFLICT DO NOTHING returns no row. The read at the top of this function
  -- already covers a selection frozen by an earlier run, so reaching here with
  -- a conflict means a CONCURRENT run inserted one in between. The recomputed
  -- winner is still not what governs the cutoff -- the frozen one is -- so read
  -- it back rather than returning what this call happened to compute.
  if v_stored_method is null then
    select s.selected_method, s.evidence_from, s.evidence_to, s.selection_basis
      into v_stored_method, v_stored_from, v_stored_to, v_stored_basis
    from public.forecast_method_selections s
    where s.company_entity_id = p_company_entity_id
      and s.sku_category = p_sku_category
      and s.horizon_months = p_horizon_months
      and s.effective_from_cutoff = p_effective_from_cutoff;
  end if;

  -- The windows and WAPE reported alongside belong to the STORED basis, for the
  -- same reason. A basis written before this column existed, or by a future
  -- writer, may not carry them -- absent reads NULL, never 0.
  return query select
    v_stored_method, v_stored_from, v_stored_to,
    (v_stored_basis->'scores'->0->>'windows')::integer,
    (v_stored_basis->'scores'->0->>'wape')::numeric,
    coalesce(v_stored_basis, '{}'::jsonb);
end;
$fn$;

revoke all on function public.select_forecast_method(uuid, text, integer, date, integer, text) from public, anon, authenticated;
grant execute on function public.select_forecast_method(uuid, text, integer, date, integer, text) to service_role;

-- The method governing a cutoff: the newest selection whose effective_from is
-- at or before it. NULL means nothing was ever selected, which a caller must
-- treat as "do not forecast", never as a default.
create or replace function public.forecast_method_for_cutoff(
  p_company_entity_id uuid, p_sku_category text, p_horizon_months integer, p_cutoff_date date
) returns text
language sql stable security definer set search_path = public as $fn$
  select s.selected_method
  from public.forecast_method_selections s
  where s.company_entity_id = p_company_entity_id
    and s.sku_category = p_sku_category
    and s.horizon_months = p_horizon_months
    and s.effective_from_cutoff <= p_cutoff_date
  order by s.effective_from_cutoff desc
  limit 1;
$fn$;

-- Same reasoning as the scorer: service role only, users read the table.
revoke all on function public.forecast_method_for_cutoff(uuid, text, integer, date) from public, anon, authenticated;
grant execute on function public.forecast_method_for_cutoff(uuid, text, integer, date) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A writer for any method
-- ─────────────────────────────────────────────────────────────────────────────
-- record_forecast_candidate_run() stays exactly as it is -- it is what wrote the
-- existing ledger rows and its behaviour is pinned by tests. This is its
-- generalisation: same guards, in the same order, for any method and any
-- horizon in months. The guards are repeated rather than shared because each
-- one is a refusal with its own reason string, and collapsing them would make
-- "deferred" and "expired" indistinguishable to whoever reads the job log.
create or replace function public.record_forecast_method_run(
  p_company_entity_id uuid,
  p_cutoff_date date,
  p_sku_category text,
  p_method text,
  p_horizon_months integer,
  p_max_issuance_lag_days integer default 5
) returns table (action text, ledger_id uuid, forecast_qty numeric, cutoff_date date, reason text)
language plpgsql volatile security definer set search_path = public as $fn$
#variable_conflict use_column
declare
  v_existing public.forecast_candidate_ledger;
  v_calc record;
  v_id uuid;
  v_matured_through date;
  v_horizon_end date := (p_cutoff_date + make_interval(months => p_horizon_months))::date;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'record_forecast_method_run: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_sku_category is null or btrim(p_sku_category) = '' then
    raise exception 'record_forecast_method_run: a product category is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_horizon_months is null or p_horizon_months < 1 then
    raise exception 'record_forecast_method_run: a positive horizon in months is required' using errcode = 'invalid_parameter_value';
  end if;
  -- Candidate_YoY_Shift_v1 keeps its own writer. Its horizon is a fixed 30 DAYS
  -- and this one derives horizon_days from a calendar month, so October would
  -- be 31 here and 30 there -- two rows for one forecast, and
  -- forecast_candidate_cycles(horizon_days => 30) would see only one of them.
  -- Two writers minting rows for one candidate is how a ledger stops being
  -- evidence, so this refuses rather than reconciles.
  if p_method = 'Candidate_YoY_Shift_v1' then
    raise exception 'record_forecast_method_run: Candidate_YoY_Shift_v1 is written by record_forecast_candidate_run (fixed 30-day horizon); it is scored here but not written here'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing
  from public.forecast_candidate_ledger l
  where l.company_entity_id = p_company_entity_id
    and l.candidate_id = p_method
    and l.sku_category = p_sku_category
    and l.horizon_days = (v_horizon_end - p_cutoff_date)
    and l.cutoff_date = p_cutoff_date;

  if found then
    return query select
      case when v_existing.voided_at is null then 'existing' else 'existing_voided' end,
      v_existing.id, v_existing.forecast_qty, v_existing.cutoff_date,
      'frozen at ' || v_existing.executed_at::text || '; not recalculated';
    return;
  end if;

  v_matured_through := public.forecast_actuals_matured_through(p_company_entity_id);
  if v_matured_through is null or v_matured_through < p_cutoff_date - 1 then
    return query select 'deferred', null::uuid, null::numeric, p_cutoff_date,
      format('source is synced through %s; cutoff %s needs complete data through %s',
             coalesce(v_matured_through::text, 'never measured'), p_cutoff_date, p_cutoff_date - 1);
    return;
  end if;

  if v_matured_through >= v_horizon_end - 1 then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s is already fully synced (through %s); a forecast written now would not be prospective',
             p_cutoff_date, v_horizon_end - 1, v_matured_through);
    return;
  end if;

  if timezone('America/Los_Angeles', now())::date >= v_horizon_end then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s closed on the calendar before this run (today is %s Pacific)',
             p_cutoff_date, v_horizon_end - 1, timezone('America/Los_Angeles', now())::date);
    return;
  end if;

  select * into v_calc from public.forecast_for_method(
    p_method, p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);

  if not v_calc.eligible then
    return query select 'skipped', null::uuid, null::numeric, p_cutoff_date, v_calc.ineligible_reason;
    return;
  end if;

  insert into public.forecast_candidate_ledger (
    company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
    forecast_qty, horizon_start_date, horizon_end_date,
    inputs_through_date, method_inputs,
    method_version, candidate_spec, source_relation, max_issuance_lag_days)
  values (
    p_company_entity_id, p_method, p_cutoff_date, p_sku_category,
    (v_horizon_end - p_cutoff_date),
    v_calc.forecast_qty, p_cutoff_date, v_horizon_end,
    v_calc.inputs_through_date, v_calc.method_inputs,
    p_method,
    jsonb_build_object('method', p_method, 'horizon_months', p_horizon_months,
                       'stockout_imputation', false, 'launch_adjustment', false,
                       'max_issuance_lag_days', p_max_issuance_lag_days),
    'sales_monthly_product_type_rollup_mv', p_max_issuance_lag_days)
  on conflict (company_entity_id, candidate_id, sku_category, horizon_days, cutoff_date)
  do nothing
  returning id into v_id;

  if v_id is null then
    select l.id into v_id from public.forecast_candidate_ledger l
    where l.company_entity_id = p_company_entity_id and l.candidate_id = p_method
      and l.sku_category = p_sku_category and l.horizon_days = (v_horizon_end - p_cutoff_date)
      and l.cutoff_date = p_cutoff_date;
    return query select 'existing', v_id, v_calc.forecast_qty, p_cutoff_date,
      'written concurrently by another run; not recalculated';
    return;
  end if;

  return query select 'inserted', v_id, v_calc.forecast_qty, p_cutoff_date, null::text;
end;
$fn$;

comment on function public.record_forecast_method_run(uuid, date, text, text, integer, integer) is
  'Idempotent writer for one method at one cutoff, for any horizon in months. Same guards as record_forecast_candidate_run: returns an existing frozen row untouched, defers an unsynced cutoff, refuses a closed horizon, writes nothing for an ineligible one, and never updates.';

revoke all on function public.record_forecast_method_run(uuid, date, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_forecast_method_run(uuid, date, text, text, integer, integer) to service_role;
