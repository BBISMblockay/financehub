-- Business-timezone sweep, part 3 of 5: the Demand Planner forecast ledger and
-- its writers/reader judge the calendar in the company's business timezone.
-- Needs silo_company_timezone() from 20260924130000; see that file's header,
-- including why the ledger stores the timezone on the row.

-- ── 1. Forecast ledger: the timezone a forecast was judged in, on the row ──
alter table public.forecast_candidate_ledger
  add column if not exists business_timezone text not null default 'America/Los_Angeles';
-- The default existed only to backfill the rows written before this column
-- (all Pacific companies). From here the trigger is the only writer.
alter table public.forecast_candidate_ledger
  alter column business_timezone drop default;

comment on column public.forecast_candidate_ledger.business_timezone is
  'The company''s business timezone when the row was frozen, stamped by trg_forecast_ledger_business_timezone (a writer cannot choose it). The CHECK forecast_ledger_frozen_before_outcome and the generated frozen_days_into_horizon both read it, because neither can look anything up. Append-only like the rest of the row: a later change to the company''s timezone does not re-describe a frozen forecast.';

create or replace function public.forecast_ledger_stamp_business_timezone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.business_timezone := public.silo_company_timezone(new.company_entity_id);
  return new;
end;
$$;

revoke execute on function public.forecast_ledger_stamp_business_timezone() from public, anon, authenticated;

-- Named to sort AFTER stamp_company_entity_id (BEFORE triggers fire in name
-- order), so a row whose company is filled by that stamp is resolved against
-- the right company.
drop trigger if exists trg_forecast_ledger_business_timezone on public.forecast_candidate_ledger;
create trigger trg_forecast_ledger_business_timezone
  before insert on public.forecast_candidate_ledger
  for each row execute function public.forecast_ledger_stamp_business_timezone();

alter table public.forecast_candidate_ledger
  alter column frozen_days_into_horizon
  set expression as ((timezone(business_timezone, executed_at))::date - cutoff_date);

alter table public.forecast_candidate_ledger
  drop constraint if exists forecast_ledger_frozen_before_outcome;
alter table public.forecast_candidate_ledger
  add constraint forecast_ledger_frozen_before_outcome
  check (executed_at < timezone(business_timezone, horizon_end_date::timestamp));

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
    when l.executed_at >= timezone(l.business_timezone, l.horizon_end_date::timestamp)
      then 'NOT PROSPECTIVE'
    when l.frozen_days_into_horizon > l.max_issuance_lag_days then 'ISSUED LATE — NOT SCORED'
    when l.horizon_end_date
         <= coalesce(public.forecast_actuals_matured_through_active(), date '0001-01-01') + 1
      then 'SCORABLE'
    else 'PROSPECTIVE — NOT SCORED'
  end as status_label,
  l.inputs_through_date,
  l.method_inputs,
  (l.candidate_spec->>'horizon_months')::integer as horizon_months
from public.forecast_candidate_ledger l;

revoke all on public.forecast_candidate_ledger_v from anon;
grant select on public.forecast_candidate_ledger_v to authenticated, service_role;


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
  if timezone(public.silo_company_timezone(p_company_entity_id), now())::date >= v_horizon_end then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s closed on the calendar before this run (today is %s in the company''s business timezone), whatever the source has synced',
             p_cutoff_date, v_horizon_end - 1, timezone(public.silo_company_timezone(p_company_entity_id), now())::date);
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

  if timezone(public.silo_company_timezone(p_company_entity_id), now())::date >= v_horizon_end then
    return query select 'expired', null::uuid, null::numeric, p_cutoff_date,
      format('horizon %s..%s closed on the calendar before this run (today is %s in the company''s business timezone)',
             p_cutoff_date, v_horizon_end - 1, timezone(public.silo_company_timezone(p_company_entity_id), now())::date);
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

create or replace function public.forecast_candidate_cycles(
  p_company_entity_id uuid,
  p_sku_category text,
  p_candidate_id text default 'Candidate_YoY_Shift_v1',
  p_horizon_days integer default 30
)
returns table (
  ledger_id uuid,
  cutoff_date date,
  horizon_start_date date,
  horizon_end_date date,
  forecast_qty numeric,
  actual_qty numeric,
  matured boolean,
  scorable boolean,
  frozen_days_into_horizon integer,
  max_issuance_lag_days integer,
  issued_late boolean,
  status_label text,
  not_scorable_reason text,
  abs_error numeric,
  signed_error numeric,
  cycle_wape numeric,
  cycle_bias numeric,
  voided boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_matured_through date;
begin
  if not public.forecast_candidate_may_act(p_company_entity_id) then
    raise exception 'forecast_candidate_cycles: not authorized for company %', p_company_entity_id
      using errcode = 'insufficient_privilege';
  end if;

  v_matured_through := public.forecast_actuals_matured_through(p_company_entity_id);

  return query
  with rows_ as (
    select l.*
    from public.forecast_candidate_ledger l
    where l.company_entity_id = p_company_entity_id
      and l.candidate_id = p_candidate_id
      and l.sku_category = p_sku_category
      and l.horizon_days = p_horizon_days
  ),
  actuals as (
    select r.id,
           (select sum(m.units)::numeric
              from public.sales_monthly_product_type_rollup_mv m
             where m.company_entity_id = p_company_entity_id
               and m.product_type = p_sku_category
               and m.month_start >= r.horizon_start_date
               and m.month_start <  r.horizon_end_date) as actual_qty,
           (v_matured_through is not null and r.horizon_end_date <= v_matured_through + 1) as matured
    from rows_ r
  ),
  joined as (
    select r.*, a.actual_qty, a.matured,
      case
        when r.voided_at is not null then false
        -- Backstop for the CHECK above. A row frozen at or after its own
        -- horizon ended is not prospective evidence and is never scored,
        -- whatever else is true of it. Redundant while the constraint holds,
        -- and deliberately so: this is the assertion that keeps the promotion
        -- gate honest if the constraint is ever relaxed, or if a row arrives
        -- through some entry point that does not exist yet.
        when r.executed_at >= timezone(r.business_timezone, r.horizon_end_date::timestamp) then false
        -- ISSUED LATE. A forecast frozen partway through its own month is
        -- scored against the WHOLE month, including the part that had already
        -- happened before the forecast existed. Recording the lag and not
        -- gating on it left the promotion gate open to exactly that, so the
        -- bound the row was written under is enforced here.
        when r.frozen_days_into_horizon > r.max_issuance_lag_days then false
        when not a.matured then false
        when a.actual_qty is null then false
        -- A cycle whose actual is zero or negative has no denominator: a
        -- percentage error against it is undefined, not infinite. It is
        -- reported as unscorable and counted, never silently dropped.
        when a.actual_qty <= 0 then false
        else true
      end as scorable
    from rows_ r join actuals a on a.id = r.id
  )
  select
    j.id, j.cutoff_date, j.horizon_start_date, j.horizon_end_date,
    j.forecast_qty,
    case when j.matured then j.actual_qty else null end,
    j.matured, j.scorable,
    j.frozen_days_into_horizon, j.max_issuance_lag_days,
    (j.frozen_days_into_horizon > j.max_issuance_lag_days),
    case
      when j.voided_at is not null then 'VOIDED'
      when j.executed_at >= timezone(j.business_timezone, j.horizon_end_date::timestamp)
        then 'NOT PROSPECTIVE'
      -- Ahead of the maturity label on purpose: being issued late is PERMANENT
      -- and already known, where "not scored yet" reads as "and one day it
      -- will be". This row never will be.
      when j.frozen_days_into_horizon > j.max_issuance_lag_days then 'ISSUED LATE — NOT SCORED'
      when not j.matured then 'PROSPECTIVE — NOT SCORED'
      when j.scorable then 'SCORED'
      else 'NOT SCORABLE'
    end,
    case
      when j.voided_at is not null then 'voided: ' || coalesce(j.void_reason, '')
      when j.executed_at >= timezone(j.business_timezone, j.horizon_end_date::timestamp)
        then format('frozen %s, after the horizon closed on %s; not prospective evidence',
                    (timezone(j.business_timezone, j.executed_at))::date, j.horizon_end_date - 1)
      when j.frozen_days_into_horizon > j.max_issuance_lag_days
        then format('frozen %s day(s) into its own horizon, past the %s-day issuance bound; the outcome would be scored over days that had already elapsed',
                    j.frozen_days_into_horizon, j.max_issuance_lag_days)
      when not j.matured then
        'actuals mature after ' || (j.horizon_end_date - 1)::text
        || '; source synced through ' || coalesce(v_matured_through::text, 'never measured')
      when j.actual_qty is null then 'no recorded demand for ' || j.horizon_start_date::text
        || ' (absent from the rollup, which is not the same as zero)'
      when j.actual_qty <= 0 then 'recorded demand is ' || j.actual_qty::text
        || '; a percentage error needs a positive denominator'
      else null
    end,
    case when j.scorable then abs(j.forecast_qty - j.actual_qty) else null end,
    case when j.scorable then (j.forecast_qty - j.actual_qty) else null end,
    case when j.scorable then abs(j.forecast_qty - j.actual_qty) / j.actual_qty else null end,
    case when j.scorable then (j.forecast_qty - j.actual_qty) / j.actual_qty else null end,
    (j.voided_at is not null)
  from joined j
  order by j.cutoff_date;
end;
$$;

-- ── 2. Ask SILO's catalog ──────────────────────────────────────────────────
-- The ledger gained a column, so the catalog's column list must be refreshed
-- (CLAUDE.md: re-run it after any migration that changes a public table).
-- Guarded because the forecast suite's fixture has no catalog.
do $$
begin
  if to_regclass('public.silo_chat_schema_catalog') is not null then
    update public.silo_chat_schema_catalog
       set description = coalesce(description, '')
           || ' Frozen in the company''s business timezone, stored per row as business_timezone (20260924130200).'
     where relname = 'forecast_candidate_ledger'
       and coalesce(description, '') not like '%business_timezone (20260924130200)%';
  end if;
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
