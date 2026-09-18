-- SILO — Category Buy Forecast
-- Saved report 1143dcd9-f2f1-4165-a299-ec21952aa465 (private, source = 'manual').
-- Parameter: {{horizon_months}} — the buying window, in months.
--
-- NO SEMICOLONS, not even inside a comment: chat_run_readonly_query refuses the
-- whole statement on a semicolon match, which it tests AFTER stripping only the
-- LEADING comments. Pinned by scripts/tests/forecast-method-competition.test.mjs.
--
-- WHAT IT ANSWERS: for each category worth planning, how many units the window
-- needs, by which of two pre-specified methods, and HOW WRONG that method has
-- been. The forecast is the smaller half of the report. The error columns are
-- the point.
--
-- TWO KINDS OF EVIDENCE, AND THEY ARE NOT INTERCHANGEABLE.
--
--   BACKTEST (err_earlier_pct / err_recent_pct / bias_recent_pct) is computed
--   here, now, over history. It is honest about look-ahead -- every window is
--   built from cumulative sums strictly behind its own origin -- but it is
--   still a measurement taken by the same code that chose the method, and the
--   method rule was chosen while looking at this history. It cannot be
--   anything other than backward-looking.
--
--   FORWARD (fwd_*) comes from public.forecast_candidate_ledger: forecasts
--   FROZEN before their outcome existed, scored only once the outcome matured.
--   A ledger row cannot be edited, and one frozen partway into its own horizon
--   is excluded by the ledger itself. This is the only evidence that answers
--   "does it work", rather than "did it fit".
--
-- Until the ledger has cycles, fwd_cycles_scored is 0 and every fwd_ column is
-- NULL -- NEVER 0. A category with no forward record reads as "no forward
-- record", and the status column says so in words rather than quietly falling
-- back to the backtest and calling it proven.
with hp as (select {{horizon_months}}::int as h),
b as (select (date_trunc('month', silo_business_today())::date - interval '1 month')::date as lc),
ix as (select (extract(year from lc)*12 + extract(month from lc))::int as nl from b),
m as (select product_type as cat,
        (extract(year from day_date)*12 + extract(month from day_date))::int as n,
        sum(units_sold)::numeric as u
      from public.sales_by_product_title_daily_v
      where product_type is not null
        and product_type in (select f.product_type from public.product_type_forecastable_v f where f.is_forecastable)
      group by 1,2),
c as (select cat, min(n) as n0 from m group by 1),
g as (select c.cat, s.n::int as n, coalesce(x.u,0) as u
      from c cross join ix cross join lateral generate_series(c.n0, ix.nl) s(n)
      left join m x on x.cat=c.cat and x.n=s.n),
cs as (select cat, n, sum(u) over (partition by cat order by n) as cum from g),
lk as (select cat, n, cum, lag(cum,1) over w as c1, lag(cum,4) over w as c4,
         lag(cum,13) over w as c13, lag(cum,25) over w as c25
       from cs window w as (partition by cat order by n)),
pick as (select c.cat,
    max(cum) filter (where z.n = ix.nl)          as cN,
    max(cum) filter (where z.n = ix.nl-3)        as cN3,
    max(cum) filter (where z.n = ix.nl-11)       as cN11,
    max(cum) filter (where z.n = ix.nl-11+hp.h)  as cNh,
    max(cum) filter (where z.n = ix.nl-12)       as cN12,
    max(cum) filter (where z.n = ix.nl-24)       as cN24
  from c cross join ix cross join hp join cs z on z.cat=c.cat
  group by c.cat),
rule as (select cat, cN, cN3, cN11, cNh, (cN-cN12)/nullif(cN12-cN24,0) as growth,
    case when (cN-cN12)/nullif(cN12-cN24,0) > 1.5 or (cN-cN12)/nullif(cN12-cN24,0) < 0.67
         then 'run rate' else 'blend' end as method
  from pick where cN12 is not null and cN24 is not null),
o as (select k.cat, k.n, (fw.cum-k.c1) as actual,
        (ly.cum-k.c13) as s_seas, ((k.cum-k.c4)/3.0) as m3,
        case when k.n > ix.nl - hp.h + 1 - 18 then 'recent' else 'earlier' end as blk
      from lk k cross join ix cross join hp
      join cs fw on fw.cat=k.cat and fw.n = k.n + hp.h - 1
      join cs ly on ly.cat=k.cat and ly.n = k.n - 12 + hp.h - 1
      where k.c25 is not null and k.n + hp.h - 1 <= ix.nl
        and k.n > ix.nl - hp.h + 1 - 36),
sc as (select o.cat, o.blk, o.actual,
        greatest(case when r.method='run rate' then (select h from hp)*o.m3
                      else 0.5*o.s_seas + 0.5*(select h from hp)*o.m3 end, 0) as fc
       from o join rule r on r.cat=o.cat where o.actual > 0),
agg as (select cat,
    sum(abs(fc-actual)) filter (where blk='earlier')/nullif(sum(actual) filter (where blk='earlier'),0) as we,
    sum(abs(fc-actual)) filter (where blk='recent') /nullif(sum(actual) filter (where blk='recent'),0)  as wr,
    sum(fc-actual)      filter (where blk='recent') /nullif(sum(actual) filter (where blk='recent'),0)  as br,
    max((actual-fc)/nullif(actual,0)) filter (where blk='recent') as ws,
    count(*) as nw, sum(actual) as vol
  from sc group by 1),

-- ── The forward record ──────────────────────────────────────────────────────
-- The method that governs the NEXT buy at this horizon: the newest recorded
-- selection. Recorded before the cutoff it governs, and append-only, so it
-- cannot have been chosen after seeing the result it is judged on.
sel as (select distinct on (s.sku_category) s.sku_category as cat, s.selected_method
        from public.forecast_method_selections s cross join hp
        where s.horizon_months = hp.h
        order by s.sku_category, s.effective_from_cutoff desc),
-- Every frozen forecast, WITH THE METHOD THAT MADE IT. The method is carried
-- all the way through to the metrics below, and the row's forward record is
-- joined to the method its own figure came from.
--
-- This is the second attempt at this block and the first one was subtly wrong.
-- It kept only the forecasts the selection in force at their own cutoff had
-- named, then pooled them by category, discarding which method each came from.
-- That measures how the SELECTION PROCEDURE has performed -- a real question,
-- but not this one. Its failure mode is precise: six accurate seasonal-naive
-- cycles, then a switch to the run rate, and a run-rate figure inherits six
-- cycles of somebody else's accuracy and reads "Proven forward". Comparing the
-- displayed method to the CURRENT selection did not help, because in that
-- story they agree.
--
-- A forward record can only belong to the method it measured. Every frozen row
-- is prospective evidence for ITS OWN method whether or not that method was the
-- one selected, so there is no selection filter here at all: a larger honest
-- sample beats a smaller one, and the selection is surfaced separately as
-- governing_method. For the procedure-level record, query
-- forecast_candidate_ledger against forecast_method_selections directly.
led as (select l.sku_category as cat, l.candidate_id as method_id,
          l.forecast_qty, l.status_label,
          l.horizon_start_date, l.horizon_end_date,
          ((extract(year from l.horizon_end_date)*12 + extract(month from l.horizon_end_date))
           - (extract(year from l.horizon_start_date)*12 + extract(month from l.horizon_start_date)))::int as months_expected
        from public.forecast_candidate_ledger_v l
        cross join hp
        where l.horizon_months = hp.h and l.voided_at is null),
-- count(DISTINCT month_start), not count(*). This rollup is grained by
-- (month, location, channel, product_type) -- measured on production
-- 2026-09-18, Youth carries 12 to 14 location rows in every month -- so a raw
-- row count made a complete six-month window look like 72 months and marked
-- every matured cycle unscorable. The sum is unaffected: summing across
-- locations is what the actual IS.
act as (select d.cat, d.method_id, d.forecast_qty, d.status_label, d.months_expected,
          (select sum(r.units) from public.sales_monthly_product_type_rollup_v r
            where r.product_type = d.cat and r.month_start >= d.horizon_start_date
              and r.month_start < d.horizon_end_date) as actual,
          (select count(distinct r.month_start) from public.sales_monthly_product_type_rollup_v r
            where r.product_type = d.cat and r.month_start >= d.horizon_start_date
              and r.month_start < d.horizon_end_date) as months_present
        from led d),
-- A cycle is scored only when its whole window is present. A month absent from
-- the rollup means "not recorded", not "sold none", and summing around the hole
-- reports a data gap as an over-forecast.
scored as (select cat, method_id, forecast_qty, actual,
             (status_label = 'SCORABLE' and actual > 0 and months_present = months_expected) as ok
           from act),
fwd as (select cat, method_id,
    count(*) as cycles_frozen,
    count(*) filter (where ok) as cycles_scored,
    sum(abs(forecast_qty-actual)) filter (where ok)/nullif(sum(actual) filter (where ok),0) as fw,
    sum(forecast_qty-actual)      filter (where ok)/nullif(sum(actual) filter (where ok),0) as fb
  from scored group by 1, 2),

-- The report's own method rule, expressed in the ledger's vocabulary so the two
-- can be joined. Spelled out once, here, rather than repeated at each use.
ruled as (select r.*,
    case when r.method = 'run rate' then 'run_rate_v1'
         when r.method = 'blend'    then 'blend_v1' end as method_id
  from rule r),

fx as (select r.cat, r.method, r.method_id, r.growth, a.we, a.wr, a.br, a.ws, a.nw, a.vol,
    sel.selected_method,
    coalesce(f.cycles_frozen,0) as cycles_frozen, coalesce(f.cycles_scored,0) as cycles_scored,
    f.fw, f.fb,
    case when r.method='run rate' then (r.cN-r.cN3)/3.0*(select h from hp)
         else 0.5*(r.cNh-r.cN11) + 0.5*((r.cN-r.cN3)/3.0*(select h from hp)) end as fc_units
  from ruled r join agg a on a.cat=r.cat
  left join sel on sel.cat = r.cat
  -- THE join that makes the forward columns belong to the figure beside them.
  left join fwd f on f.cat = r.cat and f.method_id = r.method_id
  where a.vol >= 5000)
select cat as category, method as method_used, round(growth::numeric,2) as yoy_growth_x,
  round(fc_units) as forecast_units,
  round(fc_units * (1 + greatest(ws,0))) as buy_to_cover_worst,
  round(we*100,0) as err_earlier_pct, round(wr*100,0) as err_recent_pct,
  round(br*100,0) as bias_recent_pct, round(greatest(ws,0)*100,0) as worst_short_pct,
  -- Which method the recorded selection says will govern the NEXT cutoff. It is
  -- not what the fwd_ columns measure -- those belong to the method of the
  -- figure on this row, whatever the selection currently says -- so when the
  -- two differ the record line says so, because next month's frozen forecast
  -- will not be the shape of the one shown here.
  coalesce(selected_method, 'none recorded') as governing_method,
  -- Every fwd_ column below is the record of THIS ROW'S method, joined on it.
  cycles_frozen as fwd_cycles_frozen,
  cycles_scored as fwd_cycles_scored,
  -- NULL, never 0, until something has actually matured.
  round(fw*100,0) as fwd_err_pct,
  round(fb*100,0) as fwd_bias_pct,
  (case when cycles_scored = 0 and cycles_frozen = 0 then 'no forward record for ' || method
        when cycles_scored = 0 then cycles_frozen || ' ' || method || ' forecast(s) frozen, none matured yet'
        else cycles_scored || ' of ' || cycles_frozen || ' ' || method || ' forecast(s) matured and scored' end
   || case when selected_method is not null and selected_method is distinct from method_id
           then ' -- the next cutoff is set to ' || selected_method
           else '' end) as forward_record,
  case
    -- Forward evidence leads once there is enough of it to mean anything. Six
    -- cycles is a bar, not a proof, and the word "proven" is reserved for it
    -- precisely so the backtest below can never claim it.
    when cycles_scored >= 6 and fw <= 0.30 and abs(fb) <= 0.10 then 'Proven forward - use with buffer'
    when cycles_scored >= 6 and fw <= 0.45 then 'Proven forward - directional'
    when cycles_scored >= 6 then 'Measured forward and too wide to buy on'
    when cycles_scored > 0 then 'Forward record started - too few cycles to judge'
    when nw < 24 then 'Unproven - too little history'
    when greatest(we,wr) <= 0.30 and abs(br) <= 0.10 then 'Backtest only - use with buffer'
    when greatest(we,wr) <= 0.45 then 'Backtest only - directional'
    else 'Unproven - judgment call' end as status
from fx order by fc_units desc
