-- =============================================================================
-- Forecast scoring: compare methods on IDENTICAL cutoffs, and report the
-- windows a method could not compute instead of quietly dropping them.
--
-- THE BUG. score_forecast_methods built one row set per method and filtered it
-- with `where ... f.eligible` BEFORE grouping by method. A method that could
-- not compute an origin simply lost that origin, then its WAPE was pooled over
-- whatever remained. So two methods in the same result could be scored over
-- DIFFERENT cutoff dates and the numbers printed side by side as if they were
-- comparable. Equal `windows` counts did not rule this out either: two methods
-- can each score six windows and not the same six.
--
-- MEASURED ON PRODUCTION, 2026-09-18, Baseballism, horizon 6, cutoffs
-- 2024-09-01..2026-08-01 -- the exact call whose output was being read as a
-- ranking:
--
--   Shorts        blend_v1 6 windows (WAPE 29.6) vs run_rate_v1 15 (34.4)
--   Youth Shorts  blend_v1 6 windows (WAPE 38.0) vs run_rate_v1 15 (42.4)
--   Youth Sweatshirt  blend_v1 9 vs run_rate_v1 18
--
-- blend_v1 "won" Shorts and Youth Shorts on nine and nine fewer windows than
-- the method it beat. That is not a close call between two methods, it is two
-- different questions with one answer printed.
--
-- THE FIX. Scoring now happens on the COMMON SET: the origins where every
-- APPLICABLE method is eligible. `wape`/`bias` are computed there and are the
-- only numbers that may be compared or selected on. A method's own-set score is
-- still returned as `wape_own`/`bias_own` for diagnosis, deliberately under a
-- different name so the comparable number keeps the plain one and an existing
-- caller reading `wape` gets the corrected figure rather than the old one.
--
-- "APPLICABLE" is doing real work. Candidate_YoY_Shift_v1 is a one-month method
-- by specification and is eligible at NO origin when the horizon is longer, so
-- requiring literally every method to be eligible would empty the common set at
-- every horizon above 1 and score nothing at all. A method eligible at no
-- origin is therefore not applicable at this horizon: it is reported with
-- coverage 0 and excluded from the intersection, rather than destroying it.
--
-- FAIL CLOSED. If the common set is empty, every `wape` is null.
-- select_forecast_method filters on `wape is not null`, so it records NO
-- selection and says why, instead of picking whichever method happened to have
-- the easiest windows. That is the intended behaviour: an unselectable category
-- is a fact about the evidence, and the previous code hid it by construction.
--
-- Coverage is now first-class. `windows_offered` (origins with a complete,
-- positive actual window -- identical for every method), `windows_eligible`
-- (what this method could actually compute) and `coverage_pct` make a method
-- that answers half the time visible as such. Measured on the same production
-- call, 45% of lead-6 category-months are not scorable at all: 89 have no
-- prior-year month and 69 have no target month. None of that was reported
-- anywhere before.
--
-- REVERSIBLE: this migration only replaces function bodies and adds new
-- functions. Re-running 20260918000000 restores the previous scorer exactly.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The growth candidates from the bake-off, as first-class methods
-- ─────────────────────────────────────────────────────────────────────────────
-- These four are the models the September formula search actually produced, the
-- ones behind the results that prompted this work. They lived only in the SQL
-- of an archived saved report, which means they could not be scored by the same
-- harness as the shipped methods and could not be selected by anything. Porting
-- them here is what makes the comparison possible; it does NOT put them in
-- front of a buyer. Nothing selects them until select_forecast_method is run.
--
-- The archived report forecasts ONE target month at a lead. These functions
-- forecast a CUMULATIVE horizon window, because that is what the scorer and the
-- buy report mean by a horizon. The generalization is the faithful one: sum the
-- per-month model over the h months of the window, with each month carrying the
-- trend confidence of ITS OWN distance from the cutoff -- month 1 is a 1-month
-- forecast, month 6 is a 6-month forecast, and collapsing them to a single
-- horizon-wide confidence would make the first month of a long window as
-- uncertain as its last.
--
-- The PARAMETERS ARE NOT RE-SEARCHED. The weights (0.40/0.30/0.20/0.10), the
-- growth clip (0.75..1.75), the confidence steps, the 0.90 floor and the
-- segment thresholds are transcribed from the archived report unchanged. The
-- whole point of scoring them here is to find out whether they survive a
-- holdout; re-tuning them against the same history first is how the earlier
-- round produced 20.2% that became 49.6%.

-- Shared feature block, so the four models below cannot drift apart in how they
-- read history. Bounded at `month_start < cutoff` like every other method here.
create or replace function public.forecast_features_at_cutoff(
  p_company_entity_id uuid, p_cutoff_date date, p_sku_category text
) returns table (u1 numeric, u3 numeric, n3 integer, u6 numeric, u12 numeric,
                 n12 integer, avg_month numeric, sd_month numeric, peak_month numeric,
                 median_growth numeric, comparable_months integer)
language sql stable security definer set search_path = public as $fn$
  with monthly as (
    -- Collapsed to one row per month FIRST. The rollup is grained by
    -- (company, month, location, channel, product_type), so counting raw rows
    -- as months is the bug 20260918000000 documents at length.
    select r.month_start, sum(r.units)::numeric as units
    from public.sales_monthly_product_type_rollup_mv r
    where r.company_entity_id = p_company_entity_id
      and r.product_type = p_sku_category
    group by r.month_start
  ),
  win as (
    select * from monthly
    where month_start >= (p_cutoff_date - interval '12 months')::date
      and month_start <  p_cutoff_date
  ),
  pairs as (
    select cur.units / nullif(pri.units, 0) as g
    from monthly cur
    join monthly pri on pri.month_start = (cur.month_start - interval '1 year')::date
    -- A prior-year month under 10 units makes the ratio a division by noise:
    -- 2 units against 1 is a 100% "growth" that says nothing.
    where pri.units >= 10
      and cur.month_start >= (p_cutoff_date - interval '6 months')::date
      and cur.month_start <  p_cutoff_date
  )
  select
    (select coalesce(sum(units),0) from win where month_start >= (p_cutoff_date - interval '1 month')::date),
    (select coalesce(sum(units),0) from win where month_start >= (p_cutoff_date - interval '3 months')::date),
    (select count(*)::integer     from win where month_start >= (p_cutoff_date - interval '3 months')::date),
    (select coalesce(sum(units),0) from win where month_start >= (p_cutoff_date - interval '6 months')::date),
    (select coalesce(sum(units),0) from win),
    (select count(*)::integer from win),
    (select avg(units) from win),
    (select stddev_pop(units) from win),
    (select max(units) from win),
    (select percentile_cont(0.5) within group (order by g) from pairs where g is not null),
    (select count(*)::integer from pairs where g is not null);
$fn$;

-- The four models. Each returns the standard method shape so forecast_for_method
-- can dispatch to it and score_forecast_methods can rank it beside the others.
create or replace function public.forecast_growth_family_v1(
  p_model text, p_company_entity_id uuid, p_cutoff_date date,
  p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
declare
  f record;
  v_cg numeric; v_cv numeric; v_si numeric; v_modeled numeric;
  v_total numeric := 0; v_k integer; v_tc numeric; v_ly numeric;
  v_target date; v_mlf numeric; v_month numeric; v_ly_missing integer := 0;
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'forecast_growth_family_v1: a company is required' using errcode = 'invalid_parameter_value';
  end if;

  -- NO LOOK-AHEAD. Month k of the window has target `cutoff + k - 1`, whose
  -- prior-year month is `cutoff + k - 13`. At k = 14 that is one month AFTER
  -- the cutoff, so a horizon past 13 would read demand the forecast could not
  -- have seen and score itself on its own outcome. Refused rather than clamped:
  -- a silently shortened window is a different forecast wearing the same name.
  -- (forecast_seasonal_naive_v1 has the same arithmetic and the same limit; no
  -- caller here exceeds 12, and widening either is a deliberate change.)
  if p_horizon_months > 12 then
    return query select false,
      format('horizon %s months would read prior-year demand from after the cutoff',
             p_horizon_months),
      null::numeric, (p_cutoff_date - 1),
      jsonb_build_object('horizon_months', p_horizon_months, 'max_horizon_months', 12);
    return;
  end if;

  select * into f from public.forecast_features_at_cutoff(p_company_entity_id, p_cutoff_date, p_sku_category);

  -- Same eligibility bar for all four, and it is the bar the bake-off used:
  -- three complete recent months and twelve months of history. A model that
  -- quietly ran on less would be scored on windows the others were refused.
  if coalesce(f.n3, 0) <> 3 then
    return query select false,
      format('recent window has %s of 3 months recorded', coalesce(f.n3,0)),
      null::numeric, (p_cutoff_date - 1), jsonb_build_object('n3', f.n3);
    return;
  end if;
  if coalesce(f.n12, 0) < 12 then
    return query select false,
      format('history window has %s of 12 months recorded', coalesce(f.n12,0)),
      null::numeric, (p_cutoff_date - 1), jsonb_build_object('n12', f.n12);
    return;
  end if;

  -- Fewer than three comparable year-on-year pairs means no growth signal, so
  -- the growth multiple is 1.0 -- NOT a guess at one. Every model below then
  -- degenerates to its seasonal/run-rate part, which is the honest behaviour.
  v_cg      := case when coalesce(f.comparable_months,0) >= 3
                    then least(1.75, greatest(0.75, f.median_growth)) else 1.0 end;
  v_cv      := coalesce(f.sd_month / nullif(f.avg_month, 0), 0);
  v_si      := coalesce(f.peak_month / nullif(f.avg_month, 0), 1);
  v_modeled := 0.40*coalesce(f.u1,0) + 0.30*coalesce(f.u3,0)/3.0
             + 0.20*coalesce(f.u6,0)/6.0 + 0.10*coalesce(f.u12,0)/12.0;

  for v_k in 1 .. p_horizon_months loop
    v_target := (p_cutoff_date + make_interval(months => v_k - 1))::date;
    v_tc     := case when v_k <= 3 then 1.0 when v_k <= 6 then 0.75 else 0.50 end;
    v_mlf    := (((v_target + interval '1 month')::date - v_target)::numeric / 30.4375);

    select sum(r.units)::numeric into v_ly
    from public.sales_monthly_product_type_rollup_mv r
    where r.company_entity_id = p_company_entity_id
      and r.product_type = p_sku_category
      and r.month_start = (v_target - interval '1 year')::date;

    -- An absent prior-year month is NOT zero demand. Every model here reads
    -- last year, so a missing month makes the window unforecastable rather
    -- than forecastable-and-low.
    --
    -- BACKSTOP, not the primary guard: for any horizon this function accepts,
    -- the prior-year months it needs are a SUBSET of the 12-month history
    -- window, so the n12 check above already refuses every case that would
    -- reach here. Kept because it is the check that states the rule locally,
    -- and because the two guards would have to be wrong together for a zero to
    -- be invented.
    if v_ly is null then
      v_ly_missing := v_ly_missing + 1;
      continue;
    end if;

    v_month := case p_model
      when 'current_model' then
        0.55*v_ly + 0.45*v_modeled*v_mlf
      when 'growth_model' then
        0.65*v_ly*(1+(v_cg-1)*v_tc) + 0.35*v_modeled*v_mlf
      when 'seasonal_growth_model' then
        v_ly*(1+(v_cg-1)*v_tc)
      when 'adaptive_model' then
        greatest(
          case when v_si >= 1.8 and v_ly > 0
                    then 0.75*v_ly*(1+(v_cg-1)*v_tc) + 0.25*v_modeled*v_mlf
               when v_cv <= 0.35 then v_modeled*v_mlf
               when v_cg < 0.85 or v_cg > 1.15
                    then 0.60*(0.65*v_ly*(1+(v_cg-1)*v_tc) + 0.35*v_modeled*v_mlf)
                       + 0.40*v_modeled*v_mlf
               else 0.50*v_ly + 0.50*v_modeled*v_mlf end,
          0.90*(f.u3/3.0)*v_mlf)
      else
        null
    end;

    if v_month is null then
      raise exception 'forecast_growth_family_v1: unknown model %', p_model
        using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_total + greatest(v_month, 0);
  end loop;

  if v_ly_missing > 0 then
    return query select false,
      format('prior-year demand missing for %s of %s months in the window',
             v_ly_missing, p_horizon_months),
      null::numeric, (p_cutoff_date - 1),
      jsonb_build_object('months_missing_prior_year', v_ly_missing);
    return;
  end if;

  return query select true, null::text, round(v_total), (p_cutoff_date - 1),
    jsonb_build_object('method', p_model, 'clipped_growth', round(v_cg, 4),
                       'comparable_months', f.comparable_months, 'cv', round(v_cv, 4),
                       'seasonality_index', round(v_si, 4),
                       'modeled_monthly', round(v_modeled, 4),
                       'recent_3m_units', f.u3);
end;
$fn$;

do $$
declare f text;
begin
  execute 'revoke all on function public.forecast_features_at_cutoff(uuid, date, text) from public, anon, authenticated';
  execute 'grant execute on function public.forecast_features_at_cutoff(uuid, date, text) to service_role';
  execute 'revoke all on function public.forecast_growth_family_v1(text, uuid, date, text, integer) from public, anon, authenticated';
  execute 'grant execute on function public.forecast_growth_family_v1(text, uuid, date, text, integer) to service_role';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Dispatch: the four new models join the existing three
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.forecast_for_method(
  p_method text, p_company_entity_id uuid, p_cutoff_date date,
  p_sku_category text, p_horizon_months integer
) returns table (eligible boolean, ineligible_reason text, forecast_qty numeric,
                 inputs_through_date date, method_inputs jsonb)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if p_method = 'Candidate_YoY_Shift_v1' then
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
  elsif p_method in ('current_model', 'growth_model', 'seasonal_growth_model', 'adaptive_model') then
    return query select * from public.forecast_growth_family_v1(p_method, p_company_entity_id, p_cutoff_date, p_sku_category, p_horizon_months);
  else
    raise exception 'forecast_for_method: unknown method %', p_method using errcode = 'invalid_parameter_value';
  end if;
end;
$fn$;

revoke all on function public.forecast_for_method(text, uuid, date, text, integer) from public, anon, authenticated;
grant execute on function public.forecast_for_method(text, uuid, date, text, integer) to service_role;

-- One list, so adding a method is one edit rather than three.
create or replace function public.forecast_known_methods()
returns table (method text)
language sql immutable as $fn$
  values ('Candidate_YoY_Shift_v1'), ('seasonal_naive_v1'), ('run_rate_v1'), ('blend_v1'),
         ('current_model'), ('growth_model'), ('seasonal_growth_model'), ('adaptive_model');
$fn$;

revoke all on function public.forecast_known_methods() from public, anon, authenticated;
grant execute on function public.forecast_known_methods() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The scorer, on the common set, with coverage
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP rather than CREATE OR REPLACE: the return type gains columns, and
-- Postgres refuses to change a function's OUT parameters in place.
drop function if exists public.score_forecast_methods(uuid, text, integer, date, date);

create or replace function public.score_forecast_methods(
  p_company_entity_id uuid, p_sku_category text, p_horizon_months integer,
  p_from date, p_to date
) returns table (method text, windows integer, windows_offered integer,
                 windows_eligible integer, coverage_pct numeric,
                 actual_units numeric, forecast_units numeric,
                 wape numeric, bias numeric, wape_own numeric, bias_own numeric)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not public.forecast_candidate_company_required(p_company_entity_id) then
    raise exception 'score_forecast_methods: a company is required' using errcode = 'invalid_parameter_value';
  end if;
  return query
  -- Every internal column is named `meth`, never `method`: this function's
  -- RETURNS TABLE declares a `method` OUT parameter and plpgsql resolves a bare
  -- reference to the variable, so a CTE column of that name is ambiguous and
  -- the whole query is refused at first call.
  with methods as (select k.method as meth from public.forecast_known_methods() k),
  origins as (
    select g::date as o
    from generate_series(date_trunc('month', p_from)::date, p_to, interval '1 month') g
    where (g::date + make_interval(months => p_horizon_months))::date <= (p_to + 1)
  ),
  monthly as (
    select r.month_start, sum(r.units)::numeric as units
    from public.sales_monthly_product_type_rollup_mv r
    where r.company_entity_id = p_company_entity_id
      and r.product_type = p_sku_category
    group by r.month_start
  ),
  -- Identical for every method: the origins whose OUTCOME is scorable at all.
  -- A method is never penalised for a window nobody could be scored on.
  offered as (
    select o.o, sum(m.units)::numeric as actual
    from origins o
    join monthly m
      on m.month_start >= o.o
     and m.month_start < (o.o + make_interval(months => p_horizon_months))::date
    group by o.o
    having count(*) = p_horizon_months and sum(m.units) > 0
  ),
  computed as (
    select mm.meth, f.o, f.actual, f.forecast_qty, f.eligible
    from methods mm
    cross join lateral (
      select ofd.o, ofd.actual, x.forecast_qty, x.eligible
      from offered ofd
      cross join lateral public.forecast_for_method(
        mm.meth, p_company_entity_id, ofd.o, p_sku_category, p_horizon_months) x
    ) f
  ),
  per_method as (
    select c.meth,
           count(*) filter (where c.eligible)::integer as n_elig
    from computed c group by c.meth
  ),
  -- A method eligible at NO origin is not applicable at this horizon (see the
  -- header on Candidate_YoY_Shift_v1) and must not empty the intersection.
  applicable as (select pm2.meth from per_method pm2 where pm2.n_elig > 0),
  common as (
    select c.o
    from computed c
    join applicable a on a.meth = c.meth
    group by c.o
    having bool_and(c.eligible)
  )
  select
    c.meth,
    count(*) filter (where k.o is not null)::integer,
    (select count(*)::integer from offered),
    pm.n_elig,
    round(100.0 * pm.n_elig / nullif((select count(*) from offered), 0), 1),
    sum(c.actual) filter (where k.o is not null),
    sum(c.forecast_qty) filter (where k.o is not null),
    sum(abs(c.forecast_qty - c.actual)) filter (where k.o is not null)
      / nullif(sum(c.actual) filter (where k.o is not null), 0),
    sum(c.forecast_qty - c.actual) filter (where k.o is not null)
      / nullif(sum(c.actual) filter (where k.o is not null), 0),
    sum(abs(c.forecast_qty - c.actual)) filter (where c.eligible)
      / nullif(sum(c.actual) filter (where c.eligible), 0),
    sum(c.forecast_qty - c.actual) filter (where c.eligible)
      / nullif(sum(c.actual) filter (where c.eligible), 0)
  from computed c
  join per_method pm on pm.meth = c.meth
  left join common k on k.o = c.o
  group by c.meth, pm.n_elig
  -- nulls last so an inapplicable method sorts after every scored one; the
  -- selector reads element 0 and must never land on an unscored method.
  order by 8 nulls last;
end;
$fn$;

revoke all on function public.score_forecast_methods(uuid, text, integer, date, date) from public, anon, authenticated;
grant execute on function public.score_forecast_methods(uuid, text, integer, date, date) to service_role;

comment on function public.score_forecast_methods(uuid, text, integer, date, date) is
  'Scores every known forecast method over the same origins. wape/bias are computed on the COMMON SET -- the origins where every applicable method is eligible -- and are the only comparable numbers. wape_own/bias_own are each method''s score on its own eligible windows and must not be compared across methods. windows_offered/windows_eligible/coverage_pct report what each method could not compute.';

comment on function public.forecast_growth_family_v1(text, uuid, date, text, integer) is
  'The four growth models from the September 2026 formula search (current_model, growth_model, seasonal_growth_model, adaptive_model), ported from an archived saved report so they can be scored by the same harness as the shipped methods. Parameters are transcribed unchanged and deliberately not re-searched. A cumulative horizon is the sum of the per-month model, each month at the trend confidence of its own distance from the cutoff.';
