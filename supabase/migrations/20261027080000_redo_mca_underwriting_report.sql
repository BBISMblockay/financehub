-- "Redo MCA underwriting" — the inputs for a merchant cash advance against
-- future Redo package-protection revenue, as one saved report.
--
-- WHY THIS IS A REPORT AND NOT A PROMPT. Asked as a question, this took four
-- minutes, exhausted the budget before the loan math, and got the central
-- figure wrong by about eleven times: it read 290,764 protection units against
-- a true 26,629, and divided them by all 85,918 orders of every channel, which
-- produced "3.38 protection charges per order" and then spent the remaining
-- rounds trying to explain a ratio that cannot exist. None of that is a model
-- failure to prompt around -- it is four joins and a channel rule that belong
-- in SQL, where they can be read, checked and run in under a second.
--
-- THE TWO FACTS THE QUESTION KEPT GETTING WRONG, both measured from
-- shopify_order_lines on 2026-10-27 over the 90 days to 2026-10-26:
--
--   * Protection is ONE line per order. 24,445 Online Store orders carried
--     24,447 units. An answer implying several charges per order has a scoping
--     error, not a finding.
--   * Only FOUR channels can carry it: Online Store, AfterSell Upsell,
--     Shop App and Draft Orders (26,627 orders in total). Retail (POS),
--     TikTok Shop, Amazon, Faire and Instagram / Facebook never do. They are
--     the denominator's whole problem: including them halves the take rate,
--     and counting protection units from every channel against orders from
--     every channel is what made the ratio impossible.
--
-- The channel list is written out rather than derived. Deriving it means
-- scanning shopify_order_lines, which is the query that times out at the
-- browser's 8s ceiling -- the reason query 2 reads sales_by_day instead. The
-- cost of writing it out is that a fifth channel offering protection would go
-- uncounted; VERIFY THIS LIST when Redo is enabled on a new sales channel.
--
-- Company-scoped to Baseballism and source = 'manual', deliberately NOT
-- 'system': a global report owes run_report_tieouts() a nightly reconciliation,
-- and there is nothing to tie a forward-looking forecast to. No company filter
-- in the SQL -- chat_run_readonly_query is SECURITY INVOKER, so RLS scopes every
-- read to the active company, and a hardcoded id would be a second, weaker copy
-- of that boundary.
--
-- WHAT THE REPORT DOES NOT DO: decide. It produces the inputs and the one test
-- that matters (can the weakest stretch of the term actually service a flat
-- weekly payment), and leaves the credit decision to a person. On today's data
-- it cannot: November alone is over a third of the six-month pool, and the
-- weakest thirteen weeks cover only about two thirds of the flat payment the
-- full advance implies.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, title, description, source, visibility, queries_run, parameters)
values (
  'c4f1d2a7-8b36-4e50-9a1d-7e5c3b9f2d41',
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
  'Redo MCA underwriting',
  'Underwriting inputs for a merchant cash advance repaid out of Redo package-protection revenue (the "x-redo" line item). Four results: the take rate and surplus per unit over the chosen window; protection units by month with the same month a year earlier; a six-month forecast; and the offer -- advance at the lender''s factor rate, flat weekly payment, and the same advance sized to the weakest thirteen weeks of the term. Protection is one charge per order and only four channels can carry it (Online Store, AfterSell Upsell, Shop App, Draft Orders), so orders on Retail (POS), TikTok Shop, Amazon, Faire and Instagram / Facebook are excluded from the denominator. Redo went live in February 2025, so months before April 2025 are a ramp rather than a season. Forecast figures are arithmetic on history, not a commitment, and the report does not make the credit decision.',
  'manual',
  'company',
  array[
$q$-- 1. Take rate and surplus per unit, over the chosen window.
with p as (
  select {{through_date}}::date as d_to,
         greatest({{window_days}}::integer, 1) as n,
         {{cost_per_unit}}::numeric as cost
), span as (
  select d_to, (d_to - (n - 1)) as d_from, cost from p
), redo as (
  select coalesce(sum(s.total_quantity_sold), 0) as units,
         coalesce(sum(s.total_net_sales), 0)::numeric as net
  from public.sales_by_day s, span
  where s.sku = 'x-redo' and s.day_date between span.d_from and span.d_to
), eligible as (
  select count(*) as orders
  from public.shopify_orders o
  left join public.shopify_channel_map m
    on m.company_entity_id = o.company_entity_id and m.source_name = o.source_name
  cross join span
  where o.cancelled_at is null
    and o.shopify_created_at >= span.d_from
    and o.shopify_created_at < span.d_to + 1
    and coalesce(m.display_name, o.source_name)
        in ('Online Store', 'AfterSell Upsell', 'Shop App', 'Draft Orders')
)
select span.d_from as "From",
       span.d_to as "Through",
       redo.units as "Protection units",
       round(redo.net, 2) as "Protection net sales",
       eligible.orders as "Eligible orders",
       round(100.0 * redo.units / nullif(eligible.orders, 0), 1) as "Take rate %",
       round(redo.net / nullif(redo.units, 0), 2) as "Avg net price",
       round(redo.net / nullif(redo.units, 0) - span.cost, 2) as "Surplus per unit"
from span, redo, eligible$q$,
$q$-- 2. Protection units by month, against the same month a year earlier.
--    The current month is partial and is labelled as such rather than dropped.
with p as (
  select {{through_date}}::date as d_to
), m as (
  select date_trunc('month', s.day_date)::date as mon,
         sum(s.total_quantity_sold)::numeric as units,
         sum(s.total_net_sales)::numeric as net
  from public.sales_by_day s, p
  where s.sku = 'x-redo'
    and s.day_date >= (date_trunc('month', p.d_to) - interval '23 months')::date
    and s.day_date <= p.d_to
  group by 1
), prior as (
  select date_trunc('month', s.day_date)::date as mon,
         sum(s.total_quantity_sold)::numeric as units
  from public.sales_by_day s
  where s.sku = 'x-redo'
  group by 1
)
select to_char(m.mon, 'Mon YYYY') as "Month",
       m.units as "Protection units",
       round(m.net, 2) as "Protection net sales",
       pr.units as "Units same month last year",
       round(m.units / nullif(pr.units, 0), 3) as "Year on year",
       case when m.mon = date_trunc('month', p.d_to)::date then 'partial month' else '' end as "Note"
from m
left join prior pr on pr.mon = (m.mon - interval '1 year')::date
cross join p
order by m.mon$q$,
$q$-- 3. Six-month forecast: the same month a year earlier, scaled by the
--    like-for-like ratio of the last six COMPLETE months.
with p as (
  select {{through_date}}::date as d_to, {{cost_per_unit}}::numeric as cost
), m as (
  select date_trunc('month', s.day_date)::date as mon,
         sum(s.total_quantity_sold)::numeric as units
  from public.sales_by_day s, p
  where s.sku = 'x-redo' and s.day_date < date_trunc('month', p.d_to)
  group by 1
), price as (
  select sum(s.total_net_sales)::numeric / nullif(sum(s.total_quantity_sold), 0) as avg_net
  from public.sales_by_day s, p
  where s.sku = 'x-redo' and s.day_date between p.d_to - 89 and p.d_to
), yoy as (
  select sum(cur.units) / nullif(sum(prior.units), 0) as ratio
  from m cur
  join m prior on prior.mon = (cur.mon - interval '1 year')::date,
       p
  where cur.mon >= (date_trunc('month', p.d_to) - interval '6 months')::date
    and prior.units > 0
)
select to_char(gs.mon, 'Mon YYYY') as "Month",
       round(coalesce(base.units, 0) * (select ratio from yoy)) as "Forecast units",
       round(round(coalesce(base.units, 0) * (select ratio from yoy))
             * ((select avg_net from price) - p.cost), 2) as "Repayable surplus",
       coalesce(base.units, 0) as "Actual units, a year earlier",
       round((select ratio from yoy), 3) as "Year-on-year ratio applied"
from p,
     generate_series(date_trunc('month', p.d_to) + interval '1 month',
                     date_trunc('month', p.d_to) + interval '6 months',
                     interval '1 month') gs(mon)
left join m base on base.mon = (gs.mon - interval '1 year')::date
order by gs.mon$q$,
$q$-- 4. The offer, and the test that decides whether it is safe at that size.
with p as (
  select {{through_date}}::date as d_to,
         {{cost_per_unit}}::numeric as cost,
         {{factor_rate}}::numeric as factor,
         greatest({{term_weeks}}::integer, 1) as weeks
), m as (
  select date_trunc('month', s.day_date)::date as mon,
         sum(s.total_quantity_sold)::numeric as units
  from public.sales_by_day s, p
  where s.sku = 'x-redo' and s.day_date < date_trunc('month', p.d_to)
  group by 1
), price as (
  select sum(s.total_net_sales)::numeric / nullif(sum(s.total_quantity_sold), 0) as avg_net
  from public.sales_by_day s, p
  where s.sku = 'x-redo' and s.day_date between p.d_to - 89 and p.d_to
), yoy as (
  select sum(cur.units) / nullif(sum(prior.units), 0) as ratio
  from m cur
  join m prior on prior.mon = (cur.mon - interval '1 year')::date,
       p
  where cur.mon >= (date_trunc('month', p.d_to) - interval '6 months')::date
    and prior.units > 0
), fc as (
  select gs.mon::date as mon,
         round(coalesce(base.units, 0) * (select ratio from yoy))
           * ((select avg_net from price) - p.cost) as surplus
  from p,
       generate_series(date_trunc('month', p.d_to) + interval '1 month',
                       date_trunc('month', p.d_to) + interval '6 months',
                       interval '1 month') gs(mon)
  left join m base on base.mon = (gs.mon - interval '1 year')::date
), roll as (
  -- Every three-month stretch of the term, as a weekly rate. The worst one is
  -- what a flat weekly payment actually has to survive.
  select mon,
         sum(surplus) over (order by mon rows between current row and 2 following) as s3,
         count(*) over (order by mon rows between current row and 2 following) as n3
  from fc
), pool as (
  select sum(surplus) as total from fc
)
select round((select total from pool), 2) as "Repayable surplus, 6 months",
       round((select total from pool) / p.factor, 2) as "Advance at factor rate",
       round((select total from pool) / p.weeks, 2) as "Flat weekly payment",
       round(min(roll.s3) / 13.0, 2) as "Weakest 13-week weekly surplus",
       round(min(roll.s3) / 13.0 * p.weeks / p.factor, 2) as "Advance sized to the trough",
       round(min(roll.s3) / 13.0 / nullif((select total from pool) / p.weeks, 0), 2) as "Trough coverage"
from roll, p
where roll.n3 = 3
group by p.factor, p.weeks$q$
  ],
  $p$[
    {"key":"through_date","type":"date","date_basis":"company","label":"Through date (defaults to yesterday)","default":"today-1d"},
    {"key":"window_days","type":"enum","label":"Take-rate window (days)","default":"90","options":["30","60","90"]},
    {"key":"cost_per_unit","type":"number","label":"Redo cost per protection unit","default":"1.98"},
    {"key":"factor_rate","type":"number","label":"Lender factor rate","default":"1.3"},
    {"key":"term_weeks","type":"number","label":"Term, in weekly payments","default":"26"}
  ]$p$::jsonb
)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  archived_at = null, updated_at = now();

-- The note that sends Ask SILO to the report instead of rediscovering it.
--
-- APPENDED, not edited: Loomis's own note of 2026-10-27 05:53Z states the
-- business steps and is his to change. This one adds the data, and says first
-- that the arithmetic is already a saved report -- a question that runs it
-- answers in a second or two, where rebuilding it from the tables took four
-- minutes and still ran out of time.
--
-- Fixed id so re-applying updates the row rather than stacking a third copy
-- of the same instructions into the prompt.
insert into public.silo_chat_notes (id, company_entity_id, created_by, category, note)
values (
  'f2e81c57-4a93-4d16-b0c7-9d53e8a7b614',
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
  'general',
  $note$REDO MCA UNDERWRITING -- where the data is. Use with the REDO MCA parameters note.

RUN THE SAVED REPORT "Redo MCA underwriting" FIRST. It returns all four pieces -- take rate and surplus per unit, protection units by month against last year, the six-month forecast, and the offer (advance at the factor rate, flat weekly payment, and the advance sized to the weakest 13 weeks). Its parameters are the through date, the take-rate window, the cost per unit, the factor rate and the term in weeks. Do not rebuild any of it from the tables; read the report's numbers and write the assessment.

If you do need the underlying data:
* Package protection is the line item sku 'x-redo' -- a Redo shipping protection charge, never a product. Units and revenue come from sales_by_day (sku = 'x-redo', filter on day_date). Do NOT scan shopify_order_lines for it; that query times out.
* Protection is ONE charge per order. An order either carries it or does not. Any figure implying several per order is a scoping mistake, not a finding.
* Only four channels can carry it: Online Store, AfterSell Upsell, Shop App, Draft Orders. Retail (POS), TikTok Shop, Amazon, Faire and Instagram / Facebook never do, so they must be left out of the take-rate denominator. Counting every channel is what produces a rate that cannot be true.
* Orders by channel: shopify_orders left joined to shopify_channel_map on (company_entity_id, source_name); the channel is coalesce(m.display_name, o.source_name); exclude cancelled_at is not null.
* Redo went live in February 2025, so any month before April 2025 is a ramp, not a season. Say so rather than reading it as a trend.
* Company-wide sales trend: sales_monthly_product_type_rollup_v, which answers in one query. Do not rebuild it from orders.

Two things worth saying in any REDO MCA answer, because both are true today and neither is visible in a single number: protection revenue is heavily seasonal (November alone is over a third of a six-month pool, so a flat weekly repayment is hardest to service in January through March), and protection units are running below last year on a like-for-like basis while company sales grow -- TikTok Shop is taking order share and carries no protection.$note$
)
on conflict (id) do update set note = excluded.note, category = excluded.category;
