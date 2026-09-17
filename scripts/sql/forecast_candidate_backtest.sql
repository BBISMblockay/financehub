-- Retrospective backtest of Candidate_YoY_Shift_v1.
--
-- READ THIS BEFORE READING THE NUMBER. What this produces is a RETROSPECTIVE
-- score over cutoffs that had already happened when the rule was written. It
-- is NOT prospective performance and must never be quoted as the candidate's
-- expected accuracy. The report that froze the candidate
-- (f98754f7-47a6-4eeb-8a8b-eece9a069432) labels the September 2026 run
-- 'PROSPECTIVE — NOT SCORED' for exactly this reason.
--
-- How window-dependent it is, measured against production on 2026-09-17 for
-- Youth at the 1-month horizon:
--
--     cutoffs 2026-03-01 .. 2026-08-01   (6)   WAPE 20.2%   bias -13.9%
--     cutoffs 2025-09-01 .. 2026-08-01  (12)   WAPE 37.5%   bias -33.8%
--     cutoffs 2024-01-01 .. 2026-08-01  (31)   WAPE 49.6%   bias -44.9%
--        (31 of 32: 2024-01-01 is ineligible -- its prior-year window is
--         missing 2022-10, and an absent month is not a zero)
--
-- The headline 20.2% is the first of those. The same rule, unchanged, scores
-- nearly two and a half times worse over the trailing year. That spread is the
-- argument for the prospective ledger: a six-window retrospective figure is
-- not evidence the rule works, and the only way to find out is to write
-- forecasts down before the outcome and score them later.
--
-- The forecast itself is NOT recomputed here. Each cutoff calls
-- public.forecast_yoy_shift_v1, the single definition of the candidate, so
-- this file cannot drift away from what the runner freezes.
--
-- Substitute :company, :from_cutoff and :to_cutoff (scripts/forecast-candidate-backtest.mjs
-- does it for you, after validating both shapes). In the Supabase SQL editor,
-- replace them by hand.
with cutoffs as (
  select generate_series(:from_cutoff::date, :to_cutoff::date, interval '1 month')::date as cutoff_date
),
scored as (
  select
    c.cutoff_date,
    f.eligible,
    f.ineligible_reason,
    f.recent_demand,
    f.prior_demand,
    f.prior_year_target_demand,
    f.raw_ratio,
    f.clamped_ratio,
    f.ratio_was_clamped,
    f.forecast_qty,
    (select sum(m.units)::numeric
       from public.sales_monthly_product_type_rollup_mv m
      where m.company_entity_id = :company::uuid
        and m.product_type = 'Youth'
        and m.month_start = c.cutoff_date) as actual_qty
  from cutoffs c
  cross join lateral public.forecast_yoy_shift_v1(:company::uuid, c.cutoff_date, 'Youth') f
),
-- A cutoff the candidate cannot compute, or a month whose actual is absent or
-- non-positive, is NOT scored as a miss. It is reported separately, because
-- scoring it as zero error or as total error would both be inventions.
usable as (
  select * from scored where eligible and actual_qty is not null and actual_qty > 0
)
select
  'Candidate_YoY_Shift_v1' as candidate_id,
  'Youth' as sku_category,
  :from_cutoff::date as first_cutoff,
  :to_cutoff::date as last_cutoff,
  (select count(*) from scored) as cutoffs_in_range,
  (select count(*) from usable) as cutoffs_scored,
  (select count(*) from scored where not eligible) as cutoffs_not_computable,
  (select count(*) from scored where eligible and (actual_qty is null or actual_qty <= 0)) as cutoffs_without_scorable_actual,
  (select count(*) from usable where ratio_was_clamped) as cutoffs_where_ratio_clamped,
  (select round(sum(actual_qty), 0) from usable) as actual_units,
  (select round(sum(forecast_qty), 0) from usable) as forecast_units,
  (select round(100 * sum(abs(forecast_qty - actual_qty)) / nullif(sum(actual_qty), 0), 1) from usable) as wape_pct,
  (select round(100 * sum(forecast_qty - actual_qty) / nullif(sum(actual_qty), 0), 1) from usable) as bias_pct,
  'RETROSPECTIVE — NOT PROSPECTIVE PERFORMANCE' as caveat;
