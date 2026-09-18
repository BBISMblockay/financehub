# Buying-horizon forecast scorecard — Baseballism, 2026-09-18

**What this measures:** cumulative demand over the next 3 and 6 months — the
quantity the buy report actually forecasts. An earlier version of this work
scored *lead 6* (the single month six months out), which is a different
question and is not what anyone buys against. Those numbers are superseded.

**Not a deployment.** `20260918120000` is unapplied. Nothing here changes what a
buyer sees until `select_forecast_method` is run.

---

## Method

- **Unit of evaluation:** one (category, window-start, horizon) cell. Actual =
  summed units over `[s, s+h)`; forecast is made at `s` from data strictly
  before `s`.
- **Selection is rolling and strictly prior.** For a window starting at `s`, the
  method is chosen using only training windows whose outcome was *complete
  before `s`* (`t + h <= s`), requiring at least 8 of them. An earlier pass
  selected on outcomes through Feb 2026 while testing windows that began in Oct
  2025 — the selection knew things the forecast could not.
- **Test period:** window starts 2025-09-01 onward. History runs back to
  2017-11 (107 months), so training is not the binding constraint.
- **Windows overlap.** Starts are monthly and windows are 6 months long, so the
  7 test windows per category share months and are correlated. This is
  rolling-origin evaluation, not 7 independent trials.
- **Incumbent** is the rule the buy report actually applies per category, not a
  single method: trailing-12 ÷ prior-12 outside `[0.67, 1.5]` → `run_rate_v1`,
  otherwise `blend_v1` (`scripts/sql/category_buy_forecast.sql`). Several
  categories display blend; run rate is not the universal incumbent.
- **Eligibility is one predicate for every method**, so all methods are scored
  on identical cells: 3 complete recent months, 12 months of history, every
  prior-year month of the window present, and a complete positive actual.

## Pooled result

Categories that receive a selection, both strategies on identical cells:

| Horizon | Strategy | Windows | WAPE | Bias |
|---|---|---|---|---|
| 6 | rolling selection | 65 | **23.4%** | +1.8% |
| 6 | adaptive_model (fixed) | 70 | 24.9% | +2.5% |
| 6 | growth_model (fixed) | 70 | 25.0% | −8.8% |
| 6 | blend_v1 | 70 | 30.6% | −23.2% |
| 6 | **incumbent rule** | 70 | **34.0%** | −12.2% |
| 6 | run_rate_v1 | 70 | 34.8% | −12.3% |
| 6 | seasonal_naive_v1 | 70 | 36.9% | −34.0% |
| 3 | rolling selection | 109 | **24.4%** | −0.2% |
| 3 | adaptive_model (fixed) | 130 | 28.7% | +4.2% |
| 3 | **incumbent rule** | 130 | **35.2%** | −11.7% |
| 3 | run_rate_v1 | 130 | 36.2% | −12.3% |

## The number that matters

The pooled figure above covers only the categories that qualify. Across **every
scorable test window**, with the incumbent used wherever no selection exists:

| Strategy | Windows | Units | WAPE | Bias |
|---|---|---|---|---|
| A. Incumbent everywhere | 111 | 3,804,289 | 39.4% | −9.6% |
| B. Rolling where available + incumbent fallback | 111 | 3,804,289 | **32.5%** | **−0.1%** |
| — B's covered part | 65 | 2,590,647 | 23.4% | +1.8% |
| — B's fallback part | 46 | 1,213,642 | 52.1% | −4.2% |

**6.9 points, not 10.6**, and the systematic under-call goes away. The uncovered
third of the book is unimproved and runs at 52.1% WAPE.

## Excluded demand

**Eight of eighteen categories receive no selection — 32.8% of trailing-12-month
units.** They fall back to the incumbent.

| Category | 12m units | Share | Test windows scorable | Incumbent WAPE |
|---|---|---|---|---|
| Youth Shorts | 192,947 | 17.4% | 7 of 7 | 34.9% |
| Youth Sweatshirt | 51,568 | 4.7% | 7 of 7 | 108.0% |
| Shorts | 45,851 | 4.1% | 7 of 7 | 26.6% |
| Youth Cap | 28,380 | 2.6% | 6 of 7 | 101.1% |
| Draw String Bag | 17,525 | 1.6% | **0 of 7** | not scorable |
| Youth Swim Trunks | 13,419 | 1.2% | 7 of 7 | 76.6% |
| Bracelet | 8,931 | 0.8% | 7 of 7 | 86.9% |
| Stuffed Animal | 4,572 | 0.4% | **0 of 7** | not scorable |

These are not scorable-but-unselected: they have scorable *test* windows but
fewer than 8 *training* windows where every method was eligible, so no
selection can be made from prior information alone. Youth Shorts alone is 17.4%
of units. Draw String Bag and Stuffed Animal (2.0%) have no scorable test
window at all — neither strategy can be measured on them.

## Per category, 6-month horizon

| Category | Share | Incumbent | Inc. WAPE / bias | Rolling pick | Roll WAPE / bias | Δ pts |
|---|---|---|---|---|---|---|
| Youth | 26.7% | run_rate | 29.9 / −17.6 | adaptive | 23.1 / −16.8 | **+6.8** |
| T-Shirts | 21.9% | run_rate | 30.5 / −16.9 | adaptive | 14.9 / +2.9 | **+15.7** |
| Cap | 9.0% | run_rate | 25.5 / −5.4 | adaptive | 28.2 / +28.2 | −2.7 |
| Sweatshirt | 3.7% | run_rate | 66.1 / +12.9 | adaptive | 39.4 / +30.8 | **+26.7** |
| Stickers | 1.9% | run_rate | 38.9 / +20.3 | run_rate | 38.9 / +20.3 | 0.0 |
| Women | 1.4% | run_rate | 60.0 / −39.3 | adaptive | 36.0 / +3.9 | **+23.9** |
| Pin | 0.9% | run_rate | 93.3 / +23.2 | adaptive | 151.3 / +151.3 | **−58.0** |
| Baseball | 0.7% | blend | 100.4 / +36.3 | seasonal | 25.2 / +20.4 | **+75.2** |
| Toddler | 0.6% | blend/run_rate | 22.6 / −2.1 | adaptive/blend | 26.5 / +26.3 | −3.9 |
| Swim Trunks | 0.5% | blend/run_rate | 61.1 / +17.6 | adaptive/seasonal | 61.2 / +37.2 | −0.1 |

Nearly all of the gain is Youth and T-Shirts — 48.6% of units. Cap, Pin,
Toddler and Swim Trunks get worse; Pin substantially so, and it flips to a
+151% over-call. Six categories show bias equal to WAPE under rolling selection
(Cap, Pin, Toddler, and the seasonal ones), meaning every test window was
over-called in the same direction.

## Why the uncovered third is uncovered

The 8-training-window requirement was the obvious suspect. It is not the cause.

**Eligible training windows per method, per excluded category** (6-month
horizon, windows completing before 2025-09):

| Category | run_rate | seasonal | blend | growth family |
|---|---|---|---|---|
| Youth Shorts | 9 | **0** | 0 | 0 |
| Shorts | 9 | **0** | 0 | 0 |
| Youth Cap | 8 | **0** | 0 | 0 |
| Draw String Bag | 0 | 0 | 0 | 0 |
| Stuffed Animal | 0 | 0 | 0 | 0 |
| Youth Swim Trunks | 12 | 3 | 3 | 3 |
| Youth Sweatshirt | 12 | 4 | 3 | 3 |
| Bracelet | 14 | 5 | 5 | 5 |

`run_rate_v1` is the only method that does not require a prior year. For the
first five categories every other method has **zero** eligible training windows,
so no pair of methods can be compared at any threshold — the "choice" is one
method, which is not a choice.

**Relaxing the threshold, measured:**

| Min training windows | Categories covered | Units covered | Whole-book WAPE | Covered WAPE |
|---|---|---|---|---|
| 8 | 10 | 68.1% | 32.5% | 23.4% |
| 5 | 11 | 68.9% | 32.4% | 24.0% |
| 4 | 13 | 69.9% | 32.1% | 24.2% |
| 3 | 13 | 70.9% | **31.9%** | 25.2% |

Going from 8 to 3 buys 2.8 points of unit coverage and 0.6 points of whole-book
WAPE, while degrading the covered part from 23.4% to 25.2% — selecting from
three windows is exactly the small-sample fitting that turned 20.2% into 49.6%.
Not worth taking.

**These are genuinely new products, not renamed categories.** `product_type` is
stored per row on `sales_by_day` (as-sold, frozen at sync), so a catalog rename
would *not* restate history and would look identical to a new category. Checked
at SKU level instead: of Youth Shorts' **706 SKUs, zero** have any sales history
under another product type. Shorts: 7 of 801 SKUs, 199 units. Youth Cap: 2 of
42, 13 units. There is no history to recover by aliasing.

Nor is it a split from an existing category: `Youth` does not step down when
Youth Shorts appears in 2024-09 — it grows from 947 to 13,219 units/month over
the same period, while total volume goes 23k to 126k. New categories in a
business that scaled roughly 5x.

So the uncovered demand splits into:

- **~26.1% of units** (Youth Shorts 17.4, Shorts 4.1, Youth Cap 2.6, Draw String
  Bag 1.6, Stuffed Animal 0.4) — no prior year exists. Every method except run
  rate is *undefined*, not merely unselected. No threshold or method-subset
  change reaches these.
- **~6.7% of units** (Youth Sweatshirt 4.7, Youth Swim Trunks 1.2, Bracelet 0.8)
  — reachable only at 3–5 training windows, at the cost above.

The gain for the first group has to come from a method that works without a
prior year — borrowing a seasonal shape from a related category (Youth Shorts
from Youth or Shorts) is the obvious candidate. **That is untested.** It is a
modelling question, not a selection or threshold question.

## What is not established

- These are backtests over 7 overlapping windows per category in a single
  12-month test period. The forward record (`fwd_cycles_scored` /
  `fwd_err_pct`) remains the only thing that settles method choice.
- `adaptive_model` wins most categories it is picked for, but it was selected
  *by* this procedure; its fixed-method score (24.9%) is the honest standalone
  figure and is barely better than `growth_model` (25.0%).
- Aggregate bias near zero does **not** mean reliable buys. Category over- and
  under-calls cancel: at the 6-month horizon Cap (+28.2), Pin (+151.3), Toddler
  (+26.3) and Swim Trunks (+37.2) all over-call while Youth under-calls
  (−16.8). A book-level bias of −0.1% is consistent with every individual buy
  being wrong.
- The uncovered third is the largest *unimproved* segment. It is **not**
  established that it offers the largest achievable improvement — an earlier
  version of this document claimed that and had no evidence for it. What is
  established is that selection cannot reach it.
- These methods have **no forward record**. They should run as challengers
  alongside the incumbent, with their forecasts frozen and scored later, before
  any of them changes a buying recommendation. Youth and T-Shirts look
  promising; Pin flipping to a +151% over-call is why a blanket switch is not
  justified.
