-- ============================================================================
-- Demand Planner: governed ledger for prospective forecast candidates.
--
-- Source specification: saved report f98754f7-47a6-4eeb-8a8b-eece9a069432
-- ("SILO - Demand Model Workbench"), frozen candidate Candidate_YoY_Shift_v1.
--
-- WHAT THIS IS NOT. It does not touch the production baseline. The workbench
-- report, its locked per-category models, `v_po_*`, `po_headers`/`po_lines`
-- and every 90/180-day purchasing path are untouched by this migration. This
-- adds a SECOND, parallel record that is written prospectively and scored
-- later, so that a candidate can earn promotion instead of being adopted
-- because a backtest flattered it.
--
-- WHY A TABLE AND NOT A REPORT. A saved report re-runs its SQL against live
-- data every time it is opened, so a "forecast" held in one is really a
-- restatement: change the rule, or let another month of sales land, and the
-- number a planner acted on last month is gone with no trace it ever existed.
-- Prospective evaluation needs the opposite property -- a number written
-- BEFORE the outcome and provably not touched afterwards. Hence an
-- append-only ledger, a computation that structurally cannot read past its
-- own cutoff, and a scorer that refuses to grade a cycle whose actuals have
-- not matured.
--
-- THE GRAIN. The candidate is specified as a "30-day horizon", and that is
-- the label kept in `horizon_days`. The measured window is the CALENDAR MONTH
-- beginning at the cutoff, and t-N means N calendar months before the cutoff.
-- That reading is not a choice made here for convenience: it is the only one
-- that reproduces all three frozen inputs of the first run exactly (verified
-- against production 2026-09-17 -- 115,699 / 59,124 / 4,297). A literal
-- 30-day window does not; Jun-Aug 2026 is 92 days, not 90. Every row carries
-- `horizon_start_date` and `horizon_end_date` so the window it was scored on
-- is a stored fact and not an inference from the label.
--
-- ABSENT IS NOT ZERO. `sales_monthly_product_type_rollup_mv` emits a row for a
-- (month, type) only where the sync recorded something, so a month with no
-- row is "no data", never "no sales". The Youth series carries one genuine
-- recorded 0 (2021-01) and twelve genuine NEGATIVE months (returns exceeding
-- sales, all pre-2023). A recorded 0 or negative is data and is kept as-is; a
-- MISSING month makes the cutoff ineligible and nothing is written. The
-- distinction is what keeps "no stockout imputation" true in code rather than
-- only in the methodology note.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Authorization helper
-- ─────────────────────────────────────────────────────────────────────────────
-- Every function below is SECURITY DEFINER, because the calculation reads
-- `sales_monthly_product_type_rollup_mv` -- a MATERIALIZED view, which carries
-- no RLS and is granted to nobody (the same layering `inventory_on_hand_current_v`
-- and `wow_sales_daily_type_v` depend on). A definer function reading it must
-- therefore write its own tenant check by hand, exactly as
-- `seo_capture_measurements` does, because the RLS that would have applied is
-- bypassed. This is that check, in one place, so a new entry point cannot
-- forget it.
--
-- IT CANNOT ASK WHO IS CALLING, and the first version of this file tried to.
-- Inside a SECURITY DEFINER function `current_user` is the function's OWNER,
-- not the caller, so `pg_has_role(current_user, 'service_role', 'member')`
-- is true for EVERY caller -- it was letting any signed-in user compute
-- another company's demand, and the cross-tenant test is what caught it.
-- `session_user` is no better: in Supabase that is `authenticator`, which is
-- granted authenticated, anon AND service_role, so it answers true as well.
--
-- So the split is by GRANT, which Postgres checks against the role that
-- actually made the call:
--   * functions a signed-in user may call are gated on active_company_id()
--     below, and granted to `authenticated`;
--   * functions only the runner may call take an explicit company and are
--     granted to `service_role` ALONE -- the grant IS the authorization.
-- A user-facing definer function may still call a service-role-only one,
-- because it executes as the owner; that is the point of the layering.
-- RE-RUNNABILITY. 20260917180000 REORDERS three of the functions below (the
-- product category moves ahead of the candidate id and loses its default).
-- Re-running this file afterwards -- which apply_all_post_merge.sql does, in
-- order -- would then CREATE OR REPLACE over the newer signature, and Postgres
-- refuses: "cannot remove parameter defaults from existing function". Dropping
-- any existing form first keeps a re-apply safe in either direction; the later
-- migration re-establishes the corrected signatures immediately afterwards.
drop function if exists public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer);
drop function if exists public.forecast_candidate_cycles(uuid, text, text, integer);
drop function if exists public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric);

create or replace function public.forecast_candidate_may_act(p_company_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_company_entity_id is not null
     and p_company_entity_id = public.active_company_id();
$$;

comment on function public.forecast_candidate_may_act(uuid) is
  'Tenant gate for the user-facing forecast functions: strictly the caller''s own active company. It deliberately does NOT try to recognise the service role -- inside a SECURITY DEFINER function current_user is the owner and session_user is the authenticator, so both answer yes for everyone. Service-role access is granted per function instead.';

-- Refuse a null company anywhere. Service-role-only functions use this in
-- place of the tenant gate: the EXECUTE grant already decided who may call
-- them, and this only stops a null from reaching a query as "no filter".
create or replace function public.forecast_candidate_company_required(p_company_entity_id uuid)
returns boolean
language sql
immutable
as $$ select p_company_entity_id is not null; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The ledger
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.forecast_candidate_ledger (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),

  -- The four columns the specification names, plus the tenant.
  candidate_id text not null,
  cutoff_date date not null,
  sku_category text not null,
  horizon_days integer not null,
  forecast_qty numeric(14,2) not null,
  executed_at timestamptz not null default now(),

  -- The window the forecast covers, stored rather than inferred from
  -- `horizon_days`. `horizon_end_date` is EXCLUSIVE: the first day NOT
  -- forecast. A cycle is matured when that day has been synced.
  horizon_start_date date not null,
  horizon_end_date date not null,

  -- Provenance. A frozen row has to be re-readable years later without
  -- re-running anything, so it carries every input its own arithmetic used.
  recent_window_start date not null,
  recent_window_end date not null,          -- exclusive
  recent_demand numeric(16,2) not null,
  prior_window_start date not null,
  prior_window_end date not null,           -- exclusive
  prior_demand numeric(16,2) not null,
  prior_year_target_month date not null,
  prior_year_target_demand numeric(16,2) not null,
  -- Wide on purpose. The CLAMPED ratio is always within [clamp_low, clamp_high]
  -- and would fit anywhere, but the RAW one is stored unclamped so a reader can
  -- see how far outside the band the series actually was -- and that number is
  -- unbounded. numeric(12,6) leaves only six integer digits, so a legitimate
  -- series with a tiny prior-year window (one unit against two million) would
  -- overflow and fail the INSERT rather than clamping. Found in review, not by
  -- a test; there is one now.
  raw_ratio numeric(20,6) not null,
  clamped_ratio numeric(12,6) not null,
  ratio_clamp_low numeric(12,6) not null,
  ratio_clamp_high numeric(12,6) not null,
  ratio_was_clamped boolean not null,

  -- The parameter set as it stood when the row was written. Stored on the ROW
  -- so that changing the rule later cannot retroactively re-describe a
  -- forecast somebody already acted on -- which is the mechanical half of "no
  -- retrospective parameter tuning".
  method_version text not null,
  candidate_spec jsonb not null,
  source_relation text not null,

  -- How late into its own horizon the row was frozen, in Pacific business
  -- days. 0 means frozen on the cutoff itself. The CHECK below bounds this to
  -- "before the outcome was complete", which is the strongest rule that is
  -- implementable -- the maturity clock means a cutoff cannot be frozen until
  -- a day or two AFTER it, so "before the horizon starts" is impossible by
  -- construction. This column is what makes the residual visible instead of
  -- implicit: a row frozen on day 1 and one frozen on day 27 are both legal
  -- and are not equally good evidence.
  frozen_days_into_horizon integer generated always as
    ((timezone('America/Los_Angeles', executed_at))::date - cutoff_date) stored,

  -- The bound `frozen_days_into_horizon` is judged against, stored PER ROW so
  -- the rule that applied when a forecast was written cannot be changed
  -- afterwards -- the same reason candidate_spec is on the row. Recording the
  -- lag without gating on it protected nothing: a forecast issued on day 16 is
  -- still scored against the WHOLE month, including the half that had already
  -- happened before it existed.
  --
  -- 5 days: the maturity clock cannot clear a cutoff until the day after it at
  -- the earliest, the monthly job runs on the 3rd (lag 2), and this leaves a
  -- couple of days of slack for a re-dispatch. Past that, too much of the
  -- outcome has already elapsed for the row to be evidence -- it is still
  -- WRITTEN, because a late forecast is a real forecast with operational use;
  -- it is just not counted toward promotion.
  max_issuance_lag_days integer not null default 5,

  created_by uuid,

  -- The single permitted mutation. See the append-only trigger below: a
  -- mistaken row is VOIDED with a reason, never edited and never deleted,
  -- the same stance `void_card_posting` takes on a posted journal entry.
  voided_at timestamptz,
  void_reason text,
  voided_by uuid,

  constraint forecast_ledger_cutoff_is_month_start
    check (cutoff_date = date_trunc('month', cutoff_date)::date),
  constraint forecast_ledger_horizon_positive check (horizon_days > 0),
  constraint forecast_ledger_window_ordered check (horizon_end_date > horizon_start_date),
  constraint forecast_ledger_starts_at_cutoff check (horizon_start_date = cutoff_date),
  -- No look-ahead, asserted by the table itself and not only by the function
  -- that fills it: every window a forecast was computed from ends on or
  -- before its own cutoff.
  constraint forecast_ledger_no_lookahead
    check (recent_window_end <= cutoff_date and prior_window_end <= cutoff_date
           and prior_year_target_month < cutoff_date),
  -- THE PROSPECTIVE PROPERTY, enforced by the table rather than by the job
  -- that fills it. Without this, a missed monthly run is not a gap -- it is a
  -- licence: the next run's catch-up loop happily freezes a cutoff whose
  -- 30-day outcome is already complete and known, and the scorer then counts
  -- that row as matured prospective evidence toward promotion. Verified
  -- reachable before the fix (a 2026-06-01 cutoff frozen on 2026-09-17 came
  -- back SCORED with 0% error). A service-role job cannot dodge a CHECK, which
  -- is why it lives here and not only in the writer.
  --
  -- Pacific, not UTC: the business day is the unit everywhere else in SILO
  -- (see silo_business_today), and timezone(text, timestamp) is IMMUTABLE, so
  -- it is usable in a CHECK where a bare ::date cast would not be.
  constraint forecast_ledger_frozen_before_outcome
    check (executed_at < timezone('America/Los_Angeles', horizon_end_date::timestamp)),
  constraint forecast_ledger_issuance_lag_sane check (max_issuance_lag_days >= 0),
  constraint forecast_ledger_qty_not_negative check (forecast_qty >= 0),
  constraint forecast_ledger_clamp_ordered check (ratio_clamp_high >= ratio_clamp_low),
  constraint forecast_ledger_clamped_in_bounds
    check (clamped_ratio >= ratio_clamp_low and clamped_ratio <= ratio_clamp_high),
  constraint forecast_ledger_void_is_complete
    check ((voided_at is null and void_reason is null)
        or (voided_at is not null and void_reason is not null and btrim(void_reason) <> '')),
  constraint forecast_ledger_category_not_blank check (btrim(sku_category) <> ''),
  constraint forecast_ledger_candidate_not_blank check (btrim(candidate_id) <> '')
);

-- The pieces above land through `create table if not exists`, which does
-- NOTHING on a table that already exists. Anything added to this migration
-- after it has been applied somewhere therefore needs an explicit guard, or a
-- re-apply silently produces a table missing it -- which is the exact drift
-- apply_all_post_merge.sql exists to prevent. These two came out of the
-- cycle-1 review and are written this way for that reason.
alter table public.forecast_candidate_ledger
  add column if not exists frozen_days_into_horizon integer generated always as
    ((timezone('America/Los_Angeles', executed_at))::date - cutoff_date) stored;

alter table public.forecast_candidate_ledger
  add column if not exists max_issuance_lag_days integer not null default 5;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.forecast_candidate_ledger'::regclass
      and conname = 'forecast_ledger_frozen_before_outcome'
  ) then
    alter table public.forecast_candidate_ledger
      add constraint forecast_ledger_frozen_before_outcome
      check (executed_at < timezone('America/Los_Angeles', horizon_end_date::timestamp));
  end if;
end $$;

-- IDEMPOTENCY. One forecast per candidate, per category, per horizon, per
-- cutoff, per tenant. This is what makes the runner safe to re-run: a second
-- execution at the same cutoff collides here instead of writing a second,
-- differently-computed number for the same decision.
create unique index if not exists forecast_candidate_ledger_identity_uq
  on public.forecast_candidate_ledger
  (company_entity_id, candidate_id, sku_category, horizon_days, cutoff_date);

-- Evaluation walks a candidate's cycles in cutoff order; the runner asks for
-- the newest cutoff already written.
create index if not exists forecast_candidate_ledger_scan_idx
  on public.forecast_candidate_ledger
  (company_entity_id, candidate_id, sku_category, horizon_days, cutoff_date desc);

comment on table public.forecast_candidate_ledger is
  'Append-only record of prospective demand forecasts, written at a cutoff and scored only once actuals mature. Parallel to the production baseline; nothing here feeds live forecasts or purchase orders. Source spec: saved report f98754f7-47a6-4eeb-8a8b-eece9a069432.';
comment on column public.forecast_candidate_ledger.horizon_days is
  'The horizon LABEL in days (30 for the frozen candidate). The measured window is horizon_start_date .. horizon_end_date (exclusive), which is the calendar month beginning at the cutoff -- the reading that reproduces the frozen run exactly.';
comment on column public.forecast_candidate_ledger.horizon_end_date is
  'Exclusive: the first day NOT covered. A cycle is matured once this day has been synced, so the comparison never grades a partial month.';
comment on column public.forecast_candidate_ledger.candidate_spec is
  'The parameter set as it stood when this row was written, so a later change to the rule cannot retroactively re-describe a forecast somebody already acted on.';
comment on column public.forecast_candidate_ledger.voided_at is
  'The only permitted mutation, through void_forecast_candidate_run(). A voided row keeps its numbers, is excluded from scoring, and is counted in the evaluation output so a void is never silent.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Append-only enforcement
-- ─────────────────────────────────────────────────────────────────────────────
-- RLS below gives clients SELECT and nothing else, but the runner writes with
-- the service role, which bypasses RLS entirely. A trigger does not care about
-- the role, so the immutability guarantee has to live here or it does not
-- exist. Deliberately a trigger and not just "no policy".
create or replace function public.forecast_candidate_ledger_append_only()
returns trigger
language plpgsql
as $$
declare
  -- The void columns, plus every GENERATED column on this table. Generated
  -- columns are computed AFTER before-triggers run, so `new` carries a null
  -- for them here while `old` carries the stored value -- a whole-row
  -- comparison therefore sees a phantom change and rejects a legitimate void.
  -- Read from the catalog rather than listed, so the comparison keeps covering
  -- a column added later without also breaking on a derived one.
  v_ignored text[];
begin
  if tg_op = 'DELETE' then
    raise exception
      'forecast_candidate_ledger is append-only: % at cutoff % (%, %d-day) cannot be deleted; void it with void_forecast_candidate_run() instead',
      old.candidate_id, old.cutoff_date, old.sku_category, old.horizon_days
      using errcode = 'restrict_violation';
  end if;

  -- An UPDATE may do exactly one thing: void a row that is not already void.
  if old.voided_at is not null then
    raise exception
      'forecast_candidate_ledger row % is already voided and cannot be changed again',
      old.id
      using errcode = 'restrict_violation';
  end if;

  if new.voided_at is null then
    raise exception
      'forecast_candidate_ledger is append-only: the frozen forecast for % at cutoff % (%) cannot be updated',
      old.candidate_id, old.cutoff_date, old.sku_category
      using errcode = 'restrict_violation';
  end if;

  -- Everything except the void columns must be byte-identical. Written as a
  -- whole-row comparison rather than a column list on purpose: a column added
  -- to this table later is covered automatically, where a list would silently
  -- stop protecting it. Generated columns are excluded because they are
  -- derived -- if every source column is unchanged, so are they.
  select array['voided_at', 'void_reason', 'voided_by']
         || coalesce(array_agg(a.attname::text), '{}'::text[])
    into v_ignored
  from pg_attribute a
  where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped
    and a.attgenerated <> '';

  if to_jsonb(new) - v_ignored is distinct from to_jsonb(old) - v_ignored then
    raise exception
      'forecast_candidate_ledger: voiding row % may not alter any other column',
      old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists forecast_candidate_ledger_append_only on public.forecast_candidate_ledger;
create trigger forecast_candidate_ledger_append_only
  before update or delete on public.forecast_candidate_ledger
  for each row execute function public.forecast_candidate_ledger_append_only();

-- Attach the repo's standard company stamp (the attach function skips tables
-- created after it last ran, so name it explicitly).
drop trigger if exists stamp_company_entity_id on public.forecast_candidate_ledger;
create trigger stamp_company_entity_id
  before insert on public.forecast_candidate_ledger
  for each row execute function public.stamp_company_entity_id();

alter table public.forecast_candidate_ledger enable row level security;

-- Read: any active member of the owning company. Write: nobody client-side.
-- The runner is service-role, and the only supported mutation is the void
-- RPC, so there is deliberately no insert, update or delete policy at all --
-- the same stance as sample_notification_log and product_concept_revisions.
drop policy if exists forecast_candidate_ledger_select on public.forecast_candidate_ledger;
create policy forecast_candidate_ledger_select on public.forecast_candidate_ledger
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Supabase's default privileges on the public schema grant ALL on a new table
-- to anon, authenticated and service_role, and a later `grant select` does NOT
-- take the others away. Without this revoke, `authenticated` keeps INSERT,
-- UPDATE and DELETE -- and because RLS denies with no matching policy, an
-- UPDATE from the browser then SUCCEEDS WITH ZERO ROWS rather than erroring,
-- which is indistinguishable from a write that worked. Revoke first, grant
-- second, so a client write is a hard permission denial.
revoke all on public.forecast_candidate_ledger from anon, authenticated;
grant select on public.forecast_candidate_ledger to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Measured baselines the candidate has to beat
-- ─────────────────────────────────────────────────────────────────────────────
-- The 34.5% portfolio figure is a MEASUREMENT, not a constant, so it is stored
-- with the window and the report that produced it rather than typed into the
-- evaluation logic. A tenant with no baseline row gets "no baseline recorded"
-- from the evaluator and no promotion recommendation -- never a comparison
-- against another company's number.
create table if not exists public.forecast_model_baselines (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  baseline_key text not null,
  sku_category text not null,
  horizon_days integer not null,
  wape numeric(8,4) not null,
  bias numeric(8,4) not null,
  measurement_windows integer not null,
  measured_from date not null,
  measured_to date not null,
  source_report_id uuid,
  note text,
  recorded_at timestamptz not null default now(),
  constraint forecast_model_baselines_key_check
    check (baseline_key in ('portfolio', 'category')),
  constraint forecast_model_baselines_wape_not_negative check (wape >= 0),
  constraint forecast_model_baselines_windows_positive check (measurement_windows > 0),
  constraint forecast_model_baselines_range_ordered check (measured_to >= measured_from)
);

create unique index if not exists forecast_model_baselines_identity_uq
  on public.forecast_model_baselines
  (company_entity_id, baseline_key, sku_category, horizon_days);

comment on table public.forecast_model_baselines is
  'Measured holdout accuracy of the EXISTING production baseline, per company. Stored with its measurement window and source report so a promotion gate compares against a reproducible measurement rather than a hardcoded number.';

drop trigger if exists stamp_company_entity_id on public.forecast_model_baselines;
create trigger stamp_company_entity_id
  before insert on public.forecast_model_baselines
  for each row execute function public.stamp_company_entity_id();

alter table public.forecast_model_baselines enable row level security;

drop policy if exists forecast_model_baselines_select on public.forecast_model_baselines;
create policy forecast_model_baselines_select on public.forecast_model_baselines
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.forecast_model_baselines from anon, authenticated;
grant select on public.forecast_model_baselines to authenticated;

-- Seed the two figures measured from report f98754f7 on 2026-09-17, guarded on
-- the entity existing so this migration stays applicable to a fresh project.
-- ON CONFLICT DO NOTHING, never DO UPDATE: re-applying apply_all_post_merge.sql
-- must not overwrite a baseline somebody has since re-measured.
insert into public.forecast_model_baselines
  (company_entity_id, baseline_key, sku_category, horizon_days, wape, bias,
   measurement_windows, measured_from, measured_to, source_report_id, note)
select e.id, v.baseline_key, v.sku_category, 30, v.wape, v.bias,
       v.windows, date '2026-03-01', date '2026-09-01',
       'f98754f7-47a6-4eeb-8a8b-eece9a069432'::uuid, v.note
from public.entities e
cross join (values
  ('portfolio', 'ALL TESTED TYPES', 0.3450::numeric, -0.0530::numeric, 216,
   'Units-weighted holdout across every tested product type at the 1-month horizon, locked per-category models. 637,508 actual units over 216 decisions.'),
  ('category', 'Youth', 0.4290::numeric, -0.2600::numeric, 6,
   'Youth at the 1-month horizon: locked model "Balanced" (0.50*seasonal + 0.50*recent3) with its development calibration. 172,032 actual units over 6 decisions.')
) as v(baseline_key, sku_category, wape, bias, windows, note)
where e.id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid
on conflict (company_entity_id, baseline_key, sku_category, horizon_days) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The frozen candidate
-- ─────────────────────────────────────────────────────────────────────────────
-- Candidate_YoY_Shift_v1, exactly as frozen:
--   ratio    = demand[t-3 .. t-1] / demand[t-15 .. t-13]
--   clamped  = clamp(ratio, 0.60, 1.80)
--   forecast = demand[t-12] * clamped, rounded to whole units
-- Verified against production for cutoff 2026-09-01: 115,699 / 59,124 gives a
-- raw 1.956941, clamped to the 1.80 cap, times the 4,297 units Youth sold in
-- September 2025 = 7,734.6 -> 7,735 units.
create or replace function public.forecast_yoy_shift_v1(
  p_company_entity_id uuid,
  p_cutoff_date date,
  p_sku_category text,
  p_horizon_days integer default 30,
  p_clamp_low numeric default 0.60,
  p_clamp_high numeric default 1.80
)
returns table (
  eligible boolean,
  ineligible_reason text,
  recent_window_start date,
  recent_window_end date,
  recent_demand numeric,
  recent_months_present integer,
  prior_window_start date,
  prior_window_end date,
  prior_demand numeric,
  prior_months_present integer,
  prior_year_target_month date,
  prior_year_target_demand numeric,
  raw_ratio numeric,
  clamped_ratio numeric,
  ratio_was_clamped boolean,
  forecast_qty numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_recent_start date := (p_cutoff_date - interval '3 months')::date;
  v_prior_start  date := (p_cutoff_date - interval '15 months')::date;
  v_prior_end    date := (p_cutoff_date - interval '12 months')::date;
  v_py_month     date := (p_cutoff_date - interval '12 months')::date;
  v_recent numeric; v_recent_n integer;
  v_prior  numeric; v_prior_n  integer;
  v_py     numeric;
  v_raw numeric; v_clamped numeric;
begin
  -- Authorization is the EXECUTE grant below (service_role only): this
  -- function takes an explicit company and is not reachable from a browser.
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'forecast_yoy_shift_v1: a company is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_cutoff_date is null or p_cutoff_date <> date_trunc('month', p_cutoff_date)::date then
    raise exception 'forecast_yoy_shift_v1: cutoff must be the first of a month, got %', p_cutoff_date
      using errcode = 'invalid_parameter_value';
  end if;
  if p_clamp_high < p_clamp_low then
    raise exception 'forecast_yoy_shift_v1: clamp bounds inverted (% .. %)', p_clamp_low, p_clamp_high
      using errcode = 'invalid_parameter_value';
  end if;

  -- TWO layers, both bounded at the cutoff: one base CTE filtered
  -- `month_start < p_cutoff_date`, and each window's own predicate below. That
  -- is redundant on purpose -- mutation testing confirms either one alone still
  -- refuses the cutoff month, so leaking requires removing BOTH. The base CTE
  -- is the part that scales: a window added later inherits the bound even if
  -- its own predicate is written carelessly, because a future month is not in
  -- scope at all rather than merely unselected.
  with visible as (
    select r.month_start, sum(r.units)::numeric as units
    from public.sales_monthly_product_type_rollup_mv r
    where r.company_entity_id = p_company_entity_id
      and r.product_type = p_sku_category
      and r.month_start < p_cutoff_date
    group by r.month_start
  )
  select
    (select coalesce(sum(units), 0) from visible where month_start >= v_recent_start and month_start < p_cutoff_date),
    (select count(*)::integer      from visible where month_start >= v_recent_start and month_start < p_cutoff_date),
    (select coalesce(sum(units), 0) from visible where month_start >= v_prior_start  and month_start < v_prior_end),
    (select count(*)::integer      from visible where month_start >= v_prior_start  and month_start < v_prior_end),
    (select units                   from visible where month_start = v_py_month)
  into v_recent, v_recent_n, v_prior, v_prior_n, v_py;

  -- Absent is not zero. Three months are required in each window and the
  -- prior-year target month must exist; a gap makes the cutoff ineligible and
  -- writes nothing, rather than summing what happens to be there and calling
  -- the shortfall a decline.
  if v_recent_n <> 3 then
    return query select false, format('recent window %s..%s has %s of 3 months recorded', v_recent_start, p_cutoff_date, v_recent_n),
      v_recent_start, p_cutoff_date, v_recent, v_recent_n,
      v_prior_start, v_prior_end, v_prior, v_prior_n,
      v_py_month, v_py, null::numeric, null::numeric, null::boolean, null::numeric;
    return;
  end if;
  if v_prior_n <> 3 then
    return query select false, format('prior-year window %s..%s has %s of 3 months recorded', v_prior_start, v_prior_end, v_prior_n),
      v_recent_start, p_cutoff_date, v_recent, v_recent_n,
      v_prior_start, v_prior_end, v_prior, v_prior_n,
      v_py_month, v_py, null::numeric, null::numeric, null::boolean, null::numeric;
    return;
  end if;
  if v_py is null then
    return query select false, format('prior-year target month %s has no recorded demand', v_py_month),
      v_recent_start, p_cutoff_date, v_recent, v_recent_n,
      v_prior_start, v_prior_end, v_prior, v_prior_n,
      v_py_month, v_py, null::numeric, null::numeric, null::boolean, null::numeric;
    return;
  end if;
  -- Zero (or negative) denominator. A ratio against a window that net sold
  -- nothing is not a large number, it is undefined; clamping it to the cap
  -- would turn "we cannot tell" into "demand is up 80%".
  if v_prior <= 0 then
    return query select false, format('prior-year window demand is %s; a ratio needs a positive denominator', v_prior),
      v_recent_start, p_cutoff_date, v_recent, v_recent_n,
      v_prior_start, v_prior_end, v_prior, v_prior_n,
      v_py_month, v_py, null::numeric, null::numeric, null::boolean, null::numeric;
    return;
  end if;
  -- A negative prior-year target (returns exceeded sales that month -- twelve
  -- such months exist in the Youth series, all pre-2023) cannot be scaled into
  -- a forecast. A recorded ZERO can, and stays zero: that is the
  -- "keep recorded zero-sales periods unchanged" rule.
  if v_py < 0 then
    return query select false, format('prior-year target month %s recorded %s units (net returns); not a forecastable base', v_py_month, v_py),
      v_recent_start, p_cutoff_date, v_recent, v_recent_n,
      v_prior_start, v_prior_end, v_prior, v_prior_n,
      v_py_month, v_py, null::numeric, null::numeric, null::boolean, null::numeric;
    return;
  end if;

  v_raw := v_recent / v_prior;
  v_clamped := least(p_clamp_high, greatest(p_clamp_low, v_raw));

  return query select
    true, null::text,
    v_recent_start, p_cutoff_date, v_recent, v_recent_n,
    v_prior_start, v_prior_end, v_prior, v_prior_n,
    v_py_month, v_py,
    v_raw, v_clamped, (v_clamped <> v_raw),
    round(v_py * v_clamped);
end;
$$;

comment on function public.forecast_yoy_shift_v1(uuid, date, text, integer, numeric, numeric) is
  'Candidate_YoY_Shift_v1, read-only: clamp(demand[t-3..t-1] / demand[t-15..t-13], 0.60, 1.80) * demand[t-12]. Reads nothing at or after the cutoff. Returns eligible=false with a reason rather than imputing a missing month or dividing by a non-positive window.';

-- SERVICE ROLE ONLY. A signed-in user has no business computing a forecast for
-- an arbitrary company id, and the grant is what stops them -- see the note on
-- forecast_candidate_may_act for why an in-function role check cannot.
revoke all on function public.forecast_yoy_shift_v1(uuid, date, text, integer, numeric, numeric) from public, anon, authenticated;
grant execute on function public.forecast_yoy_shift_v1(uuid, date, text, integer, numeric, numeric) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The operational writer
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-running is the normal case (a monthly job, a re-dispatch, a catch-up
-- backfill), so the first thing this does is look for an existing row and
-- RETURN it. It does not recompute and compare, and it does not upsert: a
-- frozen forecast is not refreshed, and the cheapest way to guarantee that is
-- for the recompute never to happen. `forecast_candidate_drift(...)` below is
-- the explicit, read-only way to ask "would today's data give a different
-- number", which is a question worth being able to ask and never worth
-- answering by overwriting the record.
create or replace function public.record_forecast_candidate_run(
  p_company_entity_id uuid,
  p_cutoff_date date,
  p_sku_category text default 'Youth',
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

comment on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) is
  'Idempotent writer for one candidate cutoff. Returns the existing frozen row untouched if one exists (without recomputing), writes nothing at all for an ineligible cutoff, and never updates.';

revoke all on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric, integer) to service_role;
-- The pre-lag signature, if an earlier version of this migration created it.
drop function if exists public.record_forecast_candidate_run(uuid, date, text, text, integer, numeric, numeric);

-- The one permitted mutation, with a reason attached.
create or replace function public.void_forecast_candidate_run(
  p_ledger_id uuid,
  p_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_company uuid;
begin
  select company_entity_id into v_company from public.forecast_candidate_ledger where id = p_ledger_id;
  if v_company is null then
    raise exception 'void_forecast_candidate_run: no such ledger row %', p_ledger_id
      using errcode = 'no_data_found';
  end if;
  if not public.forecast_candidate_may_act(v_company) then
    raise exception 'void_forecast_candidate_run: not authorized for company %', v_company
      using errcode = 'insufficient_privilege';
  end if;
  -- Same company is NOT enough. Voiding removes a result from scoring, and a
  -- void can flip a HOLD into a promotion recommendation: with cycles
  -- (bad, good, good, good) the gate holds, because the longest scorable run
  -- includes the bad one and "every cycle beats the baseline" fails -- void the
  -- bad one and the remaining three pass. The first version granted this to
  -- every `authenticated` member, which in this org is ~29 people, so anyone
  -- could have quietly manufactured a passing streak.
  --
  -- is_exec_or_owner(), deliberately NOT is_admin_user(): 28 of 29 Baseballism
  -- profiles are membership 'admin', so that gate is the whole company again --
  -- the same reason can_manage_journal_entries() exists. There is no planner
  -- role yet and no UI; starting narrow is the reversible direction, since
  -- widening this later is additive and narrowing it would not be.
  if not public.is_exec_or_owner() then
    raise exception 'void_forecast_candidate_run: voiding a frozen forecast requires executive or owner'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'void_forecast_candidate_run: a reason is required'
      using errcode = 'invalid_parameter_value';
  end if;
  update public.forecast_candidate_ledger
     set voided_at = now(), void_reason = btrim(p_reason), voided_by = auth.uid()
   where id = p_ledger_id;
  return true;
end;
$$;

comment on function public.void_forecast_candidate_run(uuid, text) is
  'Voids one frozen forecast with a required reason. The row keeps every number, is excluded from scoring, and is counted in the evaluation output -- a void is recorded, never silent.';

-- Authenticated only, for a row in the caller's own active company, AND only
-- exec/owner (checked inside). Voiding is a human act with a written reason
-- attached; a background job has no business deciding a frozen forecast was
-- wrong, and neither does an arbitrary member -- see the note in the body.
revoke all on function public.void_forecast_candidate_run(uuid, text) from public, anon, service_role;
grant execute on function public.void_forecast_candidate_run(uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Maturity
-- ─────────────────────────────────────────────────────────────────────────────
-- A month is safe to read only when it has been SYNCED, not merely when the
-- calendar has passed it. Two bounds, because the two sources can disagree:
-- `sales_by_day` must hold the month's last day, AND the monthly matview --
-- refreshed at the end of the Shopify sync, and able to lag it -- must already
-- carry a LATER month.
--
-- That second condition is deliberately conservative and worth defending,
-- because it costs latency. The matview carries no refresh timestamp, so
-- nothing on it distinguishes "August is complete" from "August is in progress
-- and this is how far the last refresh got". The existence of a September row
-- is the only available evidence that the August rows are final. Reading a
-- newest month as complete when it is still filling would understate an actual
-- and flatter the forecast being graded -- and on the writing side it would
-- freeze an understated recent window permanently, since the ledger has no
-- second chance by design.
--
-- The cost: a company whose sync has produced nothing in the current month
-- cannot mature the previous one. That is the right failure -- a feed that
-- stopped arriving is not a month that finished.
create or replace function public.forecast_actuals_matured_through(p_company_entity_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_last_synced_day date;
  v_matview_max_month date;
  v_complete_through_day date;
begin
  -- A null company returns NULL rather than raising: the parameterless
  -- wrapper below passes active_company_id(), which is null in any tab that
  -- did not go through login.html, and a status label is not worth an error.
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    return null;
  end if;

  select max(day_date) into v_last_synced_day
  from public.sales_by_day where company_entity_id = p_company_entity_id;

  select max(month_start) into v_matview_max_month
  from public.sales_monthly_product_type_rollup_mv where company_entity_id = p_company_entity_id;

  if v_last_synced_day is null or v_matview_max_month is null then
    return null;   -- never measured. NOT "nothing has matured yet".
  end if;

  -- The last day of the newest month the matview has not yet moved past.
  v_complete_through_day := least(v_last_synced_day, (v_matview_max_month - 1));
  return v_complete_through_day;
end;
$$;

comment on function public.forecast_actuals_matured_through(uuid) is
  'The last day whose actuals are safe to score: bounded by both sales_by_day coverage and the monthly matview''s refresh, which can lag it. NULL means never measured, never "nothing has matured".';

-- Service role only, like the calculation. forecast_candidate_cycles() and the
-- ledger view call it as the owner, so a signed-in user still gets the maturity
-- clock applied to their OWN rows without being able to ask about a company id
-- they picked.
revoke all on function public.forecast_actuals_matured_through(uuid) from public, anon, authenticated;
grant execute on function public.forecast_actuals_matured_through(uuid) to service_role;

-- The same clock for the CALLER'S OWN company, with no parameter to point
-- somewhere else. `forecast_candidate_ledger_v` is security_invoker -- its RLS
-- is the point -- so it cannot call the service-role-only function above, and
-- handing it a company-id parameter granted to `authenticated` would create
-- exactly the probe the grant split just closed. No argument, nothing to abuse.
create or replace function public.forecast_actuals_matured_through_active()
returns date
language sql
stable
security definer
set search_path = public
as $$ select public.forecast_actuals_matured_through(public.active_company_id()); $$;

comment on function public.forecast_actuals_matured_through_active() is
  'forecast_actuals_matured_through() for the caller''s own active company. Parameterless on purpose: the user-facing view needs the clock, not the ability to ask about an arbitrary company.';

revoke all on function public.forecast_actuals_matured_through_active() from public, anon;
grant execute on function public.forecast_actuals_matured_through_active() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Per-cycle scoring
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per frozen forecast, with its actual attached only where the actual
-- has matured. An unmatured cycle keeps the label the specification requires
-- -- 'PROSPECTIVE — NOT SCORED' -- and carries no error columns at all, so a
-- reader cannot mistake a partial month for a miss.
create or replace function public.forecast_candidate_cycles(
  p_company_entity_id uuid,
  p_candidate_id text default 'Candidate_YoY_Shift_v1',
  p_sku_category text default 'Youth',
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

comment on function public.forecast_candidate_cycles(uuid, text, text, integer) is
  'One row per frozen forecast with its actual attached only once matured. An unmatured cycle is labelled PROSPECTIVE — NOT SCORED and carries no error columns.';

revoke all on function public.forecast_candidate_cycles(uuid, text, text, integer) from public, anon;
grant execute on function public.forecast_candidate_cycles(uuid, text, text, integer) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. The promotion gate
-- ─────────────────────────────────────────────────────────────────────────────
-- Reads only. It writes nothing, promotes nothing, and changes no production
-- path: the output is a RECOMMENDATION for a planner, which is the whole point
-- of the exercise. `requires_planner_approval` is a literal true so a caller
-- rendering this cannot present it as a decision.
--
-- The four gates, as specified:
--   1. at least three CONSECUTIVE matured, unvoided, scorable cycles
--   2. every one of those cycles beats the category baseline WAPE
--      ("consistently improve", judged per cycle -- a pooled win can hide one
--      cycle that lost badly next to one that won bigger)
--   3. pooled WAPE beats BOTH the category and the portfolio baseline
--   4. MEAN directional bias within [-10%, +10%]
--
-- The consecutive run is found by gaps-and-islands rather than a loop, and the
-- whole body is one query: a STABLE function may not create a temporary table,
-- and this function must stay STABLE so that nothing about grading a candidate
-- can write.
create or replace function public.evaluate_forecast_candidate(
  p_company_entity_id uuid,
  p_candidate_id text default 'Candidate_YoY_Shift_v1',
  p_sku_category text default 'Youth',
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

comment on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) is
  'Read-only promotion gate: >=3 CONSECUTIVE matured scorable cycles, every cycle beating the category baseline WAPE, pooled WAPE beating both baselines, and mean directional bias within +/-10 percent. Writes nothing and promotes nothing -- it produces a recommendation for planner approval.';

revoke all on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) from public, anon;
grant execute on function public.evaluate_forecast_candidate(uuid, text, text, integer, integer, numeric) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Reader view
-- ─────────────────────────────────────────────────────────────────────────────
-- security_invoker, so the ledger's own RLS decides what a caller sees. The
-- status label is DERIVED on read rather than stored: a stored label would go
-- stale the moment the month it describes finished syncing, and the one thing
-- this ledger must never do is call a number scored when it is not.
-- Dropped first, not replaced. A LATER migration (20260917200000) appends
-- columns to this view, and `create or replace view` cannot drop a column --
-- so on a re-run of apply_all_post_merge.sql this statement would hit the
-- widened view and fail with "cannot drop columns from view", taking the whole
-- re-apply with it. Same reason as the drop-function guards at the top of this
-- file: this migration has to survive being re-run after the ones that come
-- after it.
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
  end as status_label
from public.forecast_candidate_ledger l;

comment on view public.forecast_candidate_ledger_v is
  'Frozen candidate forecasts with a DERIVED status label. security_invoker, so the ledger''s RLS applies. The label is computed on read because a stored one would go stale the moment its month finished syncing.';

revoke all on public.forecast_candidate_ledger_v from anon, authenticated;
grant select on public.forecast_candidate_ledger_v to authenticated;
