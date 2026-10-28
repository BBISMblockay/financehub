-- "Redo codes — where those orders came from": the breakout that makes the
-- Redo-vs-SILO disagreement readable on its own page.
--
-- The codes are already in "Discount codes by channel", but that report carries
-- ~680 rows for a week (588 distinct non-Redo codes, 535 of them used exactly
-- once), so the Redo lines are nowhere near the first screen. This report is
-- the same orders, eleven rows, nothing else competing for the eye.
--
-- NOTHING HERE IS ADDITIVE. Every one of these orders is already counted inside
-- its channel's revenue; this is a subset view, which is why each row carries
-- its channel's full net beside it and a share. Do not add "Net on those
-- orders" to anything, and do not read it as revenue Redo produced: SILO
-- credits the order to the journey that brought the customer back, so a Redo
-- code sitting under Meta Ads means Meta brought them, Redo handled the
-- exchange. Redo's own dashboard counts all of these as Redo's.
--
-- The `RE-` prefix is the match (case-insensitive); Redo's codes are single-use
-- with a random suffix, so there is no list to maintain. The same caveat as the
-- main report applies: a campaign code named RE-SOMETHING would be counted here.
--
-- `distinct` in the scope CTE is load-bearing. silo_attribution_ledger_v holds
-- one row per order PER attribution window; window_days is bound by parameter,
-- but the distinct also protects the channel totals from any future duplicate.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, title, description, source, visibility, queries_run, parameters)
values (
  'c1f29d87-4a6b-4e03-9d55-8b0a7c31e642',
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
  'Redo codes — where those orders came from',
  'Orders carrying one of Redo''s single-use RE- return/exchange codes, broken out by the channel SILO attributes them to, with each channel''s full net beside it. A SUBSET, never additive: these orders are already inside their channel''s revenue. A Redo code under Meta Ads means Meta brought the customer back and Redo handled the exchange; Redo''s own dashboard claims every one of them, so the two tools will disagree by design. Companion to "Discount codes by channel", where the same orders sit in one rolled-up line.',
  'manual',
  'company',
  array[$q$with params as (
  select least({{report_end}}::date, (now() at time zone 'America/Los_Angeles')::date - 1) as report_end,
         greatest({{period_days}}::integer, 1) as period_days
), scope as (
  select distinct l.order_id, l.channel, l.net_cents, l.discount_code
  from public.silo_attribution_ledger_v l, params p
  where l.window_days = {{attribution_window}}::integer
    and l.day between p.report_end - (p.period_days - 1) and p.report_end
)
select s.channel as "Channel",
       count(*) filter (where s.discount_code ilike 'RE-%') as "Orders with a Redo code",
       round(sum(s.net_cents) filter (where s.discount_code ilike 'RE-%') / 100.0, 2) as "Net on those orders",
       round(sum(s.net_cents) / 100.0, 2) as "Channel net (all orders)",
       round(100.0 * coalesce(sum(s.net_cents) filter (where s.discount_code ilike 'RE-%'), 0)
             / nullif(sum(s.net_cents), 0), 1) as "% of channel net"
from scope s
group by 1
having count(*) filter (where s.discount_code ilike 'RE-%') > 0
order by 3 desc nulls last$q$],
  $p$[
    {"key":"report_end","type":"date","label":"Through date (defaults to yesterday)","default":"today-1d"},
    {"key":"period_days","type":"enum","label":"Days in period","default":"7","options":["7","14","30"]},
    {"key":"attribution_window","type":"enum","label":"Attribution window (days)","default":"30","options":["7","14","30","60"]}
  ]$p$::jsonb
)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  archived_at = null, updated_at = now();
