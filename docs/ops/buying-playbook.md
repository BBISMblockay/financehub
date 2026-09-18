# Buying playbook — how to use the Category Buy Forecast

**Status: the forecast is not proven. Read this before acting on a number in it.**

Baseballism has never had a forecast. Buying has been judgment plus whatever the
last season felt like. This report is the first attempt at a measured one, and
the honest summary of where it stands is: it produces a number, it tells you how
wrong that number has been, and on most categories "how wrong" is still too wide
to buy on without a human deciding the buffer.

---

## The one report

**SILO - Category Buy Forecast** (`1143dcd9-f2f1-4165-a299-ec21952aa465`),
private, run from Ask SILO's saved-reports list. Set **Buying window (months)**
to the window you are actually ordering for — 3 or 6.

Everything else from the model work is archived (`zz ARCHIVED - …`). Nothing was
deleted, and none of it is a buying tool.

## Reading a row

| Column | What it is |
|--------|-----------|
| `forecast_units` | The window's demand, by the method named in `method_used` |
| `buy_to_cover_worst` | `forecast_units` scaled up by the worst shortfall seen in the recent backtest block. Not a recommendation — a floor if being short is the expensive failure |
| `err_recent_pct` / `err_earlier_pct` | Backtest error over two blocks. **Read both.** A category that is good in one and bad in the other has not been measured, it has been sampled |
| `bias_recent_pct` | Signed. Negative means the method UNDER-forecast |
| `worst_short_pct` | The worst single window it came in under |
| `governing_method` | The method recorded as governing the next buy, or `none recorded` |
| `fwd_cycles_frozen` / `fwd_cycles_scored` | How much genuinely prospective evidence exists |
| `fwd_err_pct` / `fwd_bias_pct` | Error over frozen-before-the-outcome forecasts. **NULL means never measured — it never means 0** |
| `status` | The verdict, in words |

## What the statuses mean

- **`no forward record yet` / `Backtest only - …`** — every number in the row was
  computed today over history. Treat it as a starting point for a conversation,
  not an order quantity. This is where almost everything sits right now.
- **`Forward record started - too few cycles to judge`** — forecasts are being
  frozen and scored, but there are fewer than six. Still a conversation.
- **`Proven forward - use with buffer`** — six or more matured cycles, pooled
  error at or under 30%, bias within ±10%. This is the only status that means
  the system has earned some trust, and it still says *buffer*.
- **`Measured forward and too wide to buy on`** — measured, and the answer is no.
  That is a useful result, not a failure.

## The rules that are not negotiable

1. **A missing number is not zero.** Every blank in this report means "not
   measured" or "not recorded". Nothing in it reports an absence as a zero, and
   nothing built on it should either.
2. **`sales` means recorded sales.** Demand lost to a stockout is not in any of
   these figures and cannot be recovered from them. A category that sold out
   looks like a category that stopped selling.
3. **The backtest is not performance.** The same unchanged rule scores 20.2%
   over the six months the original specification quoted and 49.6% over the long
   run. Both are the same rule on the same data. That gap is the entire reason
   for the ledger.
4. **Do not tune the method to improve a number.** Ninety-four variants were
   tried. None survived its own holdout. The parameters in use — a 3-month
   recent window, a 12-month seasonal lookback, an even blend — are conventional
   defaults chosen in advance, and that is what makes them worth measuring.
5. **Youth is the hardest case and the most tempting one.** It has grown so fast
   that every method under-forecasts it, and it has **zero** months in a stable
   regime — the last time year-on-year was under 2× was August 2026. Backward
   evidence for Youth is exhausted. Only forward recording will add more.

## How the evidence accrues

On the 3rd of each month, `forecast-candidate-run.yml` does two things per
forecastable category, in this order:

1. **Records which method will govern the coming cutoff**, chosen by lowest WAPE
   over the previous 18 months — with every method's score stored beside the
   winner's. The database refuses a selection whose evidence reaches the cutoff
   it governs.
2. **Freezes each method's forecast** for 3 and 6 months. A frozen row cannot be
   edited or deleted by anyone, including the job that wrote it.

Once a window closes and the sales for it have synced, those forecasts are
scored against what actually happened, and the `fwd_` columns fill in. Nothing
is retro-fitted: a forecast written in October is judged on October's decision
with October's information.

**So the report gets more useful by being left alone.** Six months of freezes is
what turns "unproven" into an answer either way.

## What this does not do

- It does not write a purchase order, change a PO, or touch any production
  purchasing path.
- It does not know about promotions, launches, or anything in the launch
  calendar. A planned drop is not in the forecast.
- It does not forecast service and fee lines. Which types count as merchandise
  is per company in `product_type_profile`, and a type the evidence cannot
  classify is flagged on every run rather than silently dropped.
- It does not adjust for stockouts.

## When to override it

Always, if you have a reason. The forecast is an input with an error bar
attached, and the error bar is the part that was built carefully. A buyer who
looks at `err_recent_pct` of 40% and buys something else is using the report
correctly.
