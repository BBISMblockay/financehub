-- ============================================================================
-- Which product types are forecastable, MODELLED rather than hardcoded.
--
-- WHY. The buy report carried a literal exclusion list -- 'package protection',
-- 'gift card', 'shipping', 'tax'. Two problems, both found by measuring rather
-- than by reading it:
--
--   1. It was INCOMPLETE. 'Bundles & Multi-Packs' (10,747 units in the trailing
--      year) and 'custom_sale' (1,100) are not purchasable merchandise either,
--      and custom_sale was being published in the buy report as "Usable with
--      buffer" -- a buy recommendation for a line nobody can buy.
--   2. It was BASEBALLISM'S. 'Package Protection' is the Redo checkout line in
--      this tenant's stack. Another company has different non-merchandise lines
--      and would silently get them forecast as products.
--
-- THE SIGNATURE. A service or fee line SELLS but has never been STOCKED and has
-- never been PURCHASED. That is brand-neutral and it is already in the data:
-- zero rows in inventory_on_hand_current_mv and zero po_lines, against non-zero
-- recorded sales. Verified against this tenant 2026-09-17: it recovers every
-- member of the old hardcoded list that actually occurs, and the two it missed.
--
-- HUMAN OVERRIDE, SPARSE STORAGE. The table holds only EXPLICIT decisions. The
-- effective classification is the override where one exists and the evidence
-- otherwise, so a new tenant is classified correctly on day one with an empty
-- table and a new product type is classified the moment it has evidence --
-- rather than defaulting to a silent inclusion nobody reviewed. Same posture as
-- accounting_coa_map and shopify_channel_map: the machine proposes, a person
-- can correct, and the correction is per company.
--
-- NOT A DELETION. An excluded type is excluded from FORECASTING only. Nothing
-- here changes sales reporting, inventory, or any PO path.
-- ============================================================================

create table if not exists public.product_type_profile (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  product_type text not null,
  -- The human decision. NULL is not stored: a row exists only because somebody
  -- made a call, which is what keeps "evidence said so" and "a person said so"
  -- distinguishable forever.
  is_forecastable boolean not null,
  classification text not null default 'merchandise',
  classification_note text,
  classified_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_type_profile_class_check
    check (classification in ('merchandise', 'service_or_fee', 'bundle', 'other')),
  constraint product_type_profile_type_not_blank check (btrim(product_type) <> '')
);

create unique index if not exists product_type_profile_identity_uq
  on public.product_type_profile (company_entity_id, lower(product_type));

comment on table public.product_type_profile is
  'Explicit human overrides for whether a product type is forecastable. Sparse on purpose: a row exists only where somebody overrode the evidence. Read product_type_forecastable_v for the effective answer.';

drop trigger if exists stamp_company_entity_id on public.product_type_profile;
create trigger stamp_company_entity_id
  before insert on public.product_type_profile
  for each row execute function public.stamp_company_entity_id();

alter table public.product_type_profile enable row level security;

drop policy if exists product_type_profile_select on public.product_type_profile;
create policy product_type_profile_select on public.product_type_profile
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists product_type_profile_write on public.product_type_profile;
create policy product_type_profile_write on public.product_type_profile
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, and a later narrower grant does NOT take that away. Without
-- the revoke, anon keeps write privileges and an RLS-denied write returns
-- SUCCESS WITH ZERO ROWS rather than an error.
revoke all on public.product_type_profile from anon, authenticated;
grant select, insert, update, delete on public.product_type_profile to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The evidence, and the effective answer
-- ─────────────────────────────────────────────────────────────────────────────
-- security_invoker = FALSE with an explicit active_company_id() filter, NOT an
-- invoker view. That is deliberate and it is not the usual choice here, so:
-- po_headers/po_lines RLS is NARROWER than company (is_admin_user() OR
-- created_by = auth.uid()), so an invoker view would show a non-admin fewer PO
-- lines -- and "has never been purchased" is exactly what distinguishes a
-- service line from merchandise. A buyer and an admin would get DIFFERENT
-- classifications for the same product type, which makes the answer a property
-- of the reader rather than of the company. The same reasoning applies to the
-- two matviews, which carry no RLS at all and so must be filtered by hand.
create or replace view public.product_type_forecastable_v
with (security_invoker = false) as
with co as (select public.active_company_id() as cid),
sales as (
  select s.product_type,
         sum(s.units_sold)::numeric as units_365d,
         max(s.day_date) as last_sold_date
  from public.sales_by_product_title_daily_mv s, co
  where s.company_entity_id = co.cid
    and s.product_type is not null
    and s.day_date >= (public.silo_business_today() - 365)
  group by s.product_type
),
stock as (
  select i.product_type, sum(i.total_available_quantity)::numeric as on_hand
  from public.inventory_on_hand_current_mv i, co
  where i.company_entity_id = co.cid and i.product_type is not null
  group by i.product_type
),
purchased as (
  select l.product_type_snapshot as product_type, count(*)::integer as po_lines
  from public.po_lines l, co
  where l.company_entity_id = co.cid and l.product_type_snapshot is not null
  group by l.product_type_snapshot
)
select
  s.product_type,
  round(s.units_365d)                       as units_365d,
  coalesce(round(st.on_hand), 0)            as on_hand,
  coalesce(p.po_lines, 0)                   as po_lines,
  s.last_sold_date,
  -- What the evidence alone says. A line that sells but has NEVER been stocked
  -- and NEVER been purchased is a service, a fee or a virtual bundle -- not a
  -- unit anybody can order. Requires real sales, so a dormant type with no
  -- history is left as merchandise rather than being reclassified by silence.
  -- `<> 0`, not `> 0`: negative on-hand is OVERSOLD stock, which is evidence the
  -- type IS stocked. Found by reading real output -- Canvas Totes sits at -253 and
  -- was being classified a service line. Only never-stocked AND never-purchased
  -- is a service line.
  (coalesce(st.on_hand, 0) <> 0 or coalesce(p.po_lines, 0) > 0) as evidence_says_forecastable,
  pr.is_forecastable                        as human_override,
  pr.classification_note,
  -- The effective answer: the override where a person made one, the evidence
  -- otherwise.
  coalesce(pr.is_forecastable,
           (coalesce(st.on_hand, 0) <> 0 or coalesce(p.po_lines, 0) > 0)) as is_forecastable,
  case
    when pr.is_forecastable is not null then 'set by a person'
    when coalesce(st.on_hand, 0) <> 0 or coalesce(p.po_lines, 0) > 0
      then 'has stock or purchase history'
    else 'sells but never stocked and never purchased'
  end                                       as reason,
  -- Surfaced so a disagreement is visible rather than silently overridden.
  (pr.is_forecastable is not null
   and pr.is_forecastable <> (coalesce(st.on_hand, 0) <> 0 or coalesce(p.po_lines, 0) > 0))
                                            as override_contradicts_evidence
from sales s
left join stock st on st.product_type = s.product_type
left join purchased p on p.product_type = s.product_type
left join public.product_type_profile pr
       on lower(pr.product_type) = lower(s.product_type)
      and pr.company_entity_id = (select cid from co);

comment on view public.product_type_forecastable_v is
  'Effective per-type forecastability: a human override where one exists, otherwise the evidence (sells but never stocked and never purchased = not merchandise). security_invoker=false with an explicit tenant filter on purpose -- po_lines RLS is narrower than company, so an invoker view would hand a non-admin a different classification than an admin.';

revoke all on public.product_type_forecastable_v from anon, authenticated;
grant select on public.product_type_forecastable_v to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- De-brand the candidate signatures
-- ─────────────────────────────────────────────────────────────────────────────
-- 'Youth' was a DEFAULT on three functions. Nothing depended on it -- the runner
-- has always passed it explicitly -- but a default is a claim about what is
-- normal, and in a component meant to serve any tenant the normal category is
-- not Youth. The candidate id KEEPS its default: it names the METHOD, not the
-- tenant, and a caller omitting it means "the one implemented here".
--
-- Two mechanics, both checked against a real Postgres rather than assumed:
--   * CREATE OR REPLACE cannot remove a parameter default ("cannot remove
--     parameter defaults from existing function"), so these are DROP + CREATE.
--   * A parameter without a default may not follow one that has a default, so
--     p_sku_category MOVES AHEAD of p_candidate_id on the two functions where it
--     sat after it. Callers use named parameters (PostgREST rpc and the report
--     SQL both do), so the reorder is invisible to them; a positional caller
--     would have to be updated, and there are none in this repo.
drop function if exists public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer);
drop function if exists public.forecast_candidate_cycles(uuid, text, text, integer);
drop function if exists public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric);

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
    method_version, candidate_spec, source_relation, max_issuance_lag_days)
  values (
    p_company_entity_id, p_candidate_id, p_cutoff_date, p_sku_category, p_horizon_days,
    v_calc.forecast_qty, p_cutoff_date, v_horizon_end,
    v_calc.recent_window_start, v_calc.recent_window_end, v_calc.recent_demand,
    v_calc.prior_window_start, v_calc.prior_window_end, v_calc.prior_demand,
    v_calc.prior_year_target_month, v_calc.prior_year_target_demand,
    v_calc.raw_ratio, v_calc.clamped_ratio, p_clamp_low, p_clamp_high, v_calc.ratio_was_clamped,
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
        when r.executed_at >= timezone('America/Los_Angeles', r.horizon_end_date::timestamp) then false
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
      when j.executed_at >= timezone('America/Los_Angeles', j.horizon_end_date::timestamp)
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
      when j.executed_at >= timezone('America/Los_Angeles', j.horizon_end_date::timestamp)
        then format('frozen %s, after the horizon closed on %s; not prospective evidence',
                    (timezone('America/Los_Angeles', j.executed_at))::date, j.horizon_end_date - 1)
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

create or replace function public.evaluate_forecast_candidate(
  p_company_entity_id uuid,
  p_sku_category text,
  p_candidate_id text default 'Candidate_YoY_Shift_v1',
  p_horizon_days integer default 30,
  p_min_cycles integer default 3,
  p_bias_tolerance numeric default 0.10
)
returns table (
  candidate_id text,
  sku_category text,
  horizon_days integer,
  cycles_written integer,
  cycles_matured integer,
  cycles_voided integer,
  cycles_scorable integer,
  cycles_issued_late integer,
  consecutive_scorable_cycles integer,
  voids_around_window integer,
  worst_issuance_lag_days integer,
  evaluated_from date,
  evaluated_to date,
  actual_units numeric,
  forecast_units numeric,
  pooled_wape numeric,
  pooled_bias numeric,
  mean_bias numeric,
  worst_cycle_wape numeric,
  category_baseline_wape numeric,
  portfolio_baseline_wape numeric,
  gate_min_cycles boolean,
  gate_beats_category_every_cycle boolean,
  gate_beats_both_pooled boolean,
  gate_bias_within_tolerance boolean,
  recommendation text,
  requires_planner_approval boolean,
  rationale text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.forecast_candidate_may_act(p_company_entity_id) then
    raise exception 'evaluate_forecast_candidate: not authorized for company %', p_company_entity_id
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with cy as (
    select * from public.forecast_candidate_cycles(
      p_company_entity_id, p_candidate_id, p_sku_category, p_horizon_days)
  ),
  counts as (
    select count(*)::integer as written,
           count(*) filter (where cy.matured)::integer as matured,
           count(*) filter (where cy.voided)::integer as voided,
           count(*) filter (where cy.scorable)::integer as scorable,
           count(*) filter (where cy.issued_late)::integer as issued_late
    from cy
  ),
  s as (select * from cy where cy.scorable),
  -- Gaps and islands: subtracting one month per row from the cutoff makes
  -- every run of consecutive months collapse to a constant key.
  islands as (
    select s.*,
      (s.cutoff_date - (row_number() over (order by s.cutoff_date) * interval '1 month'))::date as island
    from s
  ),
  runs as (
    select island, count(*)::integer as n, min(cutoff_date) as run_from, max(cutoff_date) as run_to
    from islands group by island
  ),
  -- Longest run; the most recent one wins a tie, because a candidate's recent
  -- behaviour is the thing a promotion decision is actually about.
  best as (select n, run_from, run_to from runs order by n desc, run_to desc limit 1),
  -- Voids sitting INSIDE the evaluated run, or immediately on either side of
  -- it. Those are the ones that could have created the run: a void breaks a
  -- run it sits inside, and a void just outside removes the cycle that would
  -- otherwise have been part of a longer, worse-scoring one. Exec/owner is now
  -- required to void and every void carries an actor and a reason, so this is
  -- surfaced rather than blocked -- promotion is never automatic, and the
  -- planner approving it should not have to go looking.
  voids_near as (
    select count(*)::integer as n
    from cy, best
    where cy.voided
      and cy.cutoff_date >= (best.run_from - interval '1 month')::date
      and cy.cutoff_date <= (best.run_to + interval '1 month')::date
  ),
  agg as (
    select sum(s.actual_qty) as actual_units,
           sum(s.forecast_qty) as forecast_units,
           sum(s.abs_error) / nullif(sum(s.actual_qty), 0) as pooled_wape,
           sum(s.signed_error) / nullif(sum(s.actual_qty), 0) as pooled_bias,
           avg(s.cycle_bias) as mean_bias,
           max(s.cycle_wape) as worst_cycle_wape,
           max(s.frozen_days_into_horizon) as worst_lag
    from s join best on s.cutoff_date between best.run_from and best.run_to
  ),
  base_cat as (
    select b.wape, b.bias from public.forecast_model_baselines b
    where b.company_entity_id = p_company_entity_id and b.baseline_key = 'category'
      and b.sku_category = p_sku_category and b.horizon_days = p_horizon_days
  ),
  base_port as (
    select b.wape from public.forecast_model_baselines b
    where b.company_entity_id = p_company_entity_id and b.baseline_key = 'portfolio'
      and b.horizon_days = p_horizon_days
  ),
  gated as (
    select
      c.written, c.matured, c.voided, c.scorable, c.issued_late,
      a.worst_lag,
      coalesce(b.n, 0) as run_n, b.run_from, b.run_to, coalesce(vn.n, 0) as voids_near,
      a.actual_units, a.forecast_units, a.pooled_wape, a.pooled_bias, a.mean_bias, a.worst_cycle_wape,
      bc.wape as cat_wape, bp.wape as port_wape,
      coalesce(b.n, 0) >= p_min_cycles as g_cycles,
      -- An absent baseline is NOT a pass. A tenant that never recorded one
      -- gets a refusal to compare, not a comparison against nothing.
      (bc.wape is not null and a.worst_cycle_wape is not null and a.worst_cycle_wape < bc.wape) as g_every,
      (bc.wape is not null and bp.wape is not null and a.pooled_wape is not null
        and a.pooled_wape < bc.wape and a.pooled_wape < bp.wape) as g_pooled,
      (a.mean_bias is not null and a.mean_bias >= -p_bias_tolerance and a.mean_bias <= p_bias_tolerance) as g_bias
    from counts c
    left join best b on true
    left join voids_near vn on true
    left join agg a on true
    left join base_cat bc on true
    left join base_port bp on true
  )
  select
    p_candidate_id, p_sku_category, p_horizon_days,
    g.written, g.matured, g.voided, g.scorable, g.issued_late, g.run_n, g.voids_near, g.worst_lag,
    g.run_from, g.run_to, g.actual_units, g.forecast_units,
    g.pooled_wape, g.pooled_bias, g.mean_bias, g.worst_cycle_wape,
    g.cat_wape, g.port_wape,
    g.g_cycles, g.g_every, g.g_pooled, g.g_bias,
    case
      when g.run_n = 0 then 'INSUFFICIENT_DATA'
      when g.g_cycles and g.g_every and g.g_pooled and g.g_bias
        then 'RECOMMEND_PROMOTION_FOR_PLANNER_APPROVAL'
      when not g.g_cycles then 'INSUFFICIENT_DATA'
      else 'HOLD'
    end,
    true,
    case when g.run_n = 0 then
      format('No scorable cycle yet: %s forecast(s) written, %s matured, %s voided, %s issued too late to score. Nothing is measured until a full cycle has elapsed and synced.',
             g.written, g.matured, g.voided, g.issued_late)
    else
      format('%s consecutive scorable cycle(s) %s..%s. Pooled WAPE %s%% vs category baseline %s%% and portfolio baseline %s%%; worst cycle %s%%; mean directional bias %s%% (tolerance +/-%s%%). Gates: cycles=%s, every-cycle-beats-category=%s, pooled-beats-both=%s, bias=%s.%s%s%s%s Promotion is never automatic: this is a recommendation for planner approval, and nothing in production changes until a planner acts on it.',
             g.run_n, g.run_from, g.run_to,
             round(100 * g.pooled_wape, 1),
             coalesce(round(100 * g.cat_wape, 1)::text, 'NOT RECORDED'),
             coalesce(round(100 * g.port_wape, 1)::text, 'NOT RECORDED'),
             round(100 * g.worst_cycle_wape, 1),
             round(100 * g.mean_bias, 1),
             round(100 * p_bias_tolerance, 1),
             g.g_cycles, g.g_every, g.g_pooled, g.g_bias,
             case when g.cat_wape is null or g.port_wape is null
               then ' A baseline is NOT RECORDED for this company; an absent baseline is never treated as passed.' else '' end,
             case when g.voided > 0
               then format(' %s voided forecast(s) excluded from scoring.', g.voided) else '' end,
             case when g.issued_late > 0
               then format(' %s forecast(s) were issued too late into their horizon to be scored and are excluded; worst lag inside the window is %s day(s).', g.issued_late, coalesce(g.worst_lag, 0))
               else format(' Worst issuance lag inside the window: %s day(s).', coalesce(g.worst_lag, 0)) end,
             case when g.voids_near > 0
               then format(' WARNING: %s voided cycle(s) sit inside or immediately beside this window. A void can turn a HOLD into a pass by removing the cycle that broke the streak -- read their reasons and actors before approving.', g.voids_near)
               else '' end)
    end
  from gated g;
end;
$$;

comment on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) is
  'Idempotent writer for one candidate cutoff. The product category is REQUIRED -- no tenant-specific default. Returns the existing frozen row untouched if one exists, writes nothing for an ineligible cutoff, and never updates.';
revoke all on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) to service_role;

comment on function public.forecast_candidate_cycles(uuid, text, text, integer) is
  'One row per frozen forecast with its actual attached only once matured. The product category is REQUIRED and comes first.';
revoke all on function public.forecast_candidate_cycles(uuid, text, text, integer) from public, anon;
grant execute on function public.forecast_candidate_cycles(uuid, text, text, integer) to authenticated, service_role;

comment on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) is
  'Read-only promotion gate. The product category is REQUIRED and comes first. Writes nothing and promotes nothing.';
revoke all on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) from public, anon;
grant execute on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Service-role counterpart
-- ─────────────────────────────────────────────────────────────────────────────
-- product_type_forecastable_v keys on active_company_id(), which is NULL for the
-- runner -- so the monthly job could never enumerate categories from it. Same
-- grant split as forecast_yoy_shift_v1: an explicit company id, granted to
-- service_role ALONE, because an in-function role check cannot work inside a
-- SECURITY DEFINER (current_user is the owner, session_user is the authenticator).
create or replace function public.forecastable_product_types(p_company_entity_id uuid)
returns table (product_type text, units_365d numeric, on_hand numeric, po_lines integer,
               is_forecastable boolean, reason text)
language plpgsql stable security definer set search_path = public
as $fn$
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'forecastable_product_types: a company is required'
      using errcode = 'invalid_parameter_value';
  end if;
  return query
  with sales as (
    select s.product_type, sum(s.units_sold)::numeric as u, max(s.day_date) as last_day
    from public.sales_by_product_title_daily_mv s
    where s.company_entity_id = p_company_entity_id and s.product_type is not null
      and s.day_date >= (public.silo_business_today() - 365)
    group by s.product_type
  ),
  stock as (
    select i.product_type, sum(i.total_available_quantity)::numeric as oh
    from public.inventory_on_hand_current_mv i
    where i.company_entity_id = p_company_entity_id and i.product_type is not null
    group by i.product_type
  ),
  po as (
    select l.product_type_snapshot as product_type, count(*)::integer as n
    from public.po_lines l
    where l.company_entity_id = p_company_entity_id and l.product_type_snapshot is not null
    group by l.product_type_snapshot
  )
  select s.product_type, round(s.u), coalesce(round(st.oh),0), coalesce(p.n,0),
    coalesce(pr.is_forecastable, (coalesce(st.oh,0) <> 0 or coalesce(p.n,0) > 0)),
    case when pr.is_forecastable is not null then 'set by a person'
         when coalesce(st.oh,0) <> 0 or coalesce(p.n,0) > 0 then 'has stock or purchase history'
         else 'sells but never stocked and never purchased' end
  from sales s
  left join stock st on st.product_type = s.product_type
  left join po p on p.product_type = s.product_type
  left join public.product_type_profile pr
         on lower(pr.product_type) = lower(s.product_type)
        and pr.company_entity_id = p_company_entity_id
  order by s.u desc;
end;
$fn$;

comment on function public.forecastable_product_types(uuid) is
  'Service-role counterpart to product_type_forecastable_v, taking an explicit company because active_company_id() is null for the runner. Same effective rule: a human override where one exists, the evidence otherwise.';

revoke all on function public.forecastable_product_types(uuid) from public, anon, authenticated;
grant execute on function public.forecastable_product_types(uuid) to service_role;
