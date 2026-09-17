# Candidate_YoY_Shift_v1 — methodology note

**Source specification:** saved report `f98754f7-47a6-4eeb-8a8b-eece9a069432`
("SILO - Demand Model Workbench"). Frozen candidate: `Candidate_YoY_Shift_v1`,
Youth product type, 30-day horizon.

**Status: PROSPECTIVE — NOT SCORED.** Nothing here is in production use. No live
forecast, purchase order, or the existing 90/180-day purchasing logic is
affected by any of it.

---

## The rule

At a cutoff `t` (the first of a month), over the Youth product type, all
locations pooled:

```
ratio     = demand[t-3 .. t-1] / demand[t-15 .. t-13]
clamped   = clamp(ratio, 0.60, 1.80)
forecast  = demand[t-12] × clamped            (rounded to whole units)
```

No stockout imputation. No launch adjustment. No retrospective parameter
tuning: the clamp bounds and window offsets are stored on every ledger row in
`candidate_spec`, so a later change to the rule cannot retroactively
re-describe a forecast somebody already acted on.

### The grain is a calendar month

"30-day horizon" is the *label* (kept in `horizon_days`). The measured window is
the calendar month beginning at the cutoff, and `t-N` means N calendar months
back. That is not a convenience — it is the only reading that reproduces the
frozen run's three inputs exactly. A literal 30-day window does not: June to
August 2026 is 92 days, not 90. Every ledger row carries `horizon_start_date`
and `horizon_end_date` so the window it will be scored on is a stored fact
rather than an inference from the label.

### The first frozen run

Cutoff `2026-09-01`, reproduced from `sales_monthly_product_type_rollup_mv`
against production on 2026-09-17 and again in CI from the committed fixture:

| | |
|---|---|
| Recent comparable demand (Jun–Aug 2026) | **115,699** |
| Prior-year comparable demand (Jun–Aug 2025) | **59,124** |
| Raw ratio | 1.9569 — **exceeds the 1.80 cap** |
| Frozen ratio | **1.80** |
| Prior-year target month demand (Sep 2025) | **4,297** |
| **Frozen 30-day forecast** | **7,735 units** |

4,297 × 1.80 = 7,734.6 → 7,735.

---

## The retrospective backtest, and why it is not evidence

Applying the rule to cutoffs that had already happened gives, for Youth at the
1-month horizon (measured 2026-09-17; reproduced in CI by
`scripts/tests/forecast-candidate-database.test.mjs` executing
`scripts/sql/forecast_candidate_backtest.sql` over the real series):

| Cutoff range | Cutoffs scored | WAPE | Bias |
|---|---|---|---|
| 2026-03-01 … 2026-08-01 | 6 | **20.2%** | **−13.9%** |
| 2025-09-01 … 2026-08-01 | 12 | 37.5% | −33.8% |
| 2024-01-01 … 2026-08-01 | 31 | 49.6% | −44.9% |

The 20.2% / −13.9% figure in the specification is the first row, reproduced
exactly. **It is a retrospective score over six windows and must not be quoted
as prospective performance.** The same unchanged rule scores nearly two and a
half times worse over the trailing year, and worse still over the full span.
That spread is the entire argument for evaluating this prospectively: a
six-window backtest is not evidence that a rule works, and the only way to find
out is to write forecasts down before the outcome and score them later.

(31 of 32 cutoffs, not 32, in the long range: `2024-01-01` is ineligible because
its prior-year window `2022-10 … 2022-12` has no `2022-10` row at all. A first
pass at that figure summed the two months that were present and reported 32 at
49.7% — which is exactly the mistake the eligibility rule exists to prevent,
made while measuring the rule.)

---

## What "no imputation" means in code

`sales_monthly_product_type_rollup_mv` emits a row for a `(month, product_type)`
only where the sync recorded something. A month with no row is **"no data"**,
never "no sales". The Youth series contains all three cases, which is why each
is handled explicitly:

| Case | Behaviour |
|---|---|
| Month **absent** from a window | Cutoff is **ineligible**; nothing is written, and the reason says which window and how many of three months were found |
| Month **recorded as 0** (2021-01) | Kept as 0. A zero base forecasts zero, and that is the answer |
| Month **recorded negative** (twelve months, all pre-2023 — returns exceeding sales) | Refused as a ratio denominator or as a forecast base; a negative cannot be scaled into a forecast |
| Prior-year window sums to **≤ 0** | Refused. A ratio against a window that net sold nothing is undefined, not large — clamping it to the ceiling would turn "we cannot tell" into "demand is up 80%" |

A skipped cutoff is **absent** from the ledger rather than present as a row of
nulls, so "this cutoff was not forecastable" and "this cutoff forecast nothing"
stay different facts.

---

## Freezing, and what cannot change afterwards

`forecast_candidate_ledger` is append-only, enforced by a trigger rather than by
RLS alone — the runner writes with the service role, which bypasses RLS, so a
policy would guarantee nothing. A frozen row cannot be updated or deleted by
anyone, including the service role. The single permitted mutation is
`void_forecast_candidate_run(id, reason)`: it requires a written reason, keeps
every number, excludes the row from scoring, and is counted in the evaluation
output so a void is never silent. Corrections are new candidate ids, not edits.

**Idempotency.** One row per `(company, candidate, category, horizon, cutoff)`.
Re-running a cutoff returns the existing row **without recomputing it** — the
short-circuit is the guarantee, because a recompute that happened to agree
would be indistinguishable from one that quietly restated the number.

**No look-ahead.** The calculation reads nothing at or after its own cutoff.
Two layers enforce it (one base CTE bounded at the cutoff, plus each window's
own predicate), and the table carries a CHECK constraint that refuses a row
whose windows reach past its cutoff. Mutation testing confirms either layer
alone still refuses the cutoff month.

**Maturity.** A cutoff may only be frozen once the source has synced through the
day *before* it. Without that, a job firing at 00:05 on the first of the month
reads a `t-1` still landing, understates the recent window, and freezes that
understatement forever. The same clock decides when a cycle may be scored, so a
forecast is never written from data the scorer would refuse to grade. It is
bounded by both `sales_by_day` coverage and the monthly matview's refresh, which
can lag it.

---

## Promotion gate

`evaluate_forecast_candidate()` is read-only. It writes nothing, promotes
nothing, and returns `requires_planner_approval = true` always. Four gates:

1. **At least three consecutive matured, unvoided, scorable cycles.** Consecutive
   matters: three wins picked out of eight months is a different claim from
   three in a row, and only the second is evidence while nobody is choosing the
   window.
2. **Every one of those cycles beats the category baseline WAPE.** Judged per
   cycle, not pooled — a pooled win can hide one cycle that lost badly next to
   one that won bigger. There is a regression test for exactly that case
   (0% / 55% / 55% against a 50% baseline pools to 36.7% and is still held).
3. **Pooled WAPE beats both baselines** — the Youth category baseline and the
   34.5% portfolio baseline.
4. **Mean directional bias within [−10%, +10%].**

Baselines are **measured, not hardcoded**: `forecast_model_baselines` stores
each with its measurement window and source report id, per company.
Baseballism's two seeded rows come from report `f98754f7`:

| Baseline | WAPE | Bias | Window |
|---|---|---|---|
| Portfolio, all tested types, 1 month | 34.5% | −5.3% | 216 decisions, 637,508 units |
| Youth, 1 month (locked model "Balanced") | 42.9% | −26.0% | 6 decisions, 172,032 units |

A company with no baseline row gets **"NOT RECORDED"** and no recommendation —
an absent baseline is never treated as beaten.

---

## Operating it

| | |
|---|---|
| Runner | `scripts/forecast-candidate-run.mjs` — `.github/workflows/forecast-candidate-run.yml`, monthly on the **3rd** (not the 1st: the last day of the month syncs on the 1st at 08:30 UTC, so a job on the 1st would spend every attempt on a `deferred`) |
| Backtest | `scripts/forecast-candidate-backtest.mjs` / `scripts/sql/forecast_candidate_backtest.sql` — read-only, writes nothing |
| Read the ledger | `forecast_candidate_ledger_v` (status label derived on read, never stored — a stored label would go stale the moment its month finished syncing) |
| Per-cycle scores | `forecast_candidate_cycles(company)` |
| Recommendation | `evaluate_forecast_candidate(company)` |
| Tests | `scripts/tests/forecast-candidate.test.mjs` (unit), `scripts/tests/forecast-candidate-database.test.mjs` (real PostgreSQL, 10 mutations) |
| Schema check | `supabase/verify_v2_schema.sql` — three checks, above the Plaid marker |

### Authorization

By **GRANT**, not by an in-function role check. The engine functions
(`forecast_yoy_shift_v1`, `forecast_actuals_matured_through`,
`record_forecast_candidate_run`) take an explicit company id and are granted to
`service_role` alone. The planner-facing ones (`forecast_candidate_cycles`,
`evaluate_forecast_candidate`, `void_forecast_candidate_run`, and the ledger view
through RLS) are gated on `active_company_id()` and granted to `authenticated`.

An earlier version of this migration asked
`pg_has_role(current_user, 'service_role', 'member')` inside a SECURITY DEFINER
function. Inside a definer function `current_user` is the function's **owner**,
so that answered yes for every caller — any signed-in user could have computed
another company's demand. `session_user` is no better: in Supabase that is
`authenticator`, which holds `anon`, `authenticated` and `service_role` alike.
The cross-tenant test caught it; `verify_v2_schema.sql` fails CRITICAL if the
check ever returns.

### Open items

- Nothing surfaces this in the UI. Reading it means SQL or Ask SILO.
- One candidate, one category, one horizon. Widening is additive (the ledger is
  keyed for it) but has not been done or tested.
- Pacific/UTC: the maturity clock compares dates from `sales_by_day.day_date`,
  which the Shopify sync writes in business-day terms. It does not go through
  `silo_business_today()`. At the monthly grain this cannot change an answer,
  but a daily-grain candidate would need it.
