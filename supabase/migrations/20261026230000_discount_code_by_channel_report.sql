-- "Discount codes by channel" — the saved report that reads the codes
-- 20261026180000 put on the attribution ledger, plus the one flag that lets the
-- report builder offer that view as a source at all.
--
-- Company-scoped (Baseballism) and source = 'manual', deliberately NOT a
-- 'system' report: a global report owes a tie-out reconciliation that
-- run_report_tieouts() checks nightly, and there is nothing to tie this to --
-- shopify_discount_codes_daily is a ShopifyQL GROSS measure while the ledger is
-- net/total cents, so the two legitimately disagree. Any other company can save
-- its own copy from the builder once its codes start arriving.
--
-- Three buckets the report keeps apart, which is the whole reason it is written
-- out rather than clicked together: a real code; '(no code)', meaning the order
-- was collected and used none; and '(not captured yet)', meaning the evidence
-- predates the capture. Merging the last two would read as "no code used" for
-- every order before 2026-10-26.
--
-- window_days is a parameter rather than a filter on one value because the view
-- carries one row per order PER attribution window (7/14/30/60). Leaving it
-- unbound would count every order four times.
--
-- Real codes sort above the two bracketed buckets: uncoded sales are the larger
-- number by far, and sorting on money alone pushes every code off the first
-- screen. The buckets stay in the table because they are the denominator.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, title, description, source, visibility, queries_run, parameters)
values (
  '7b3a0c4e-5d21-4f68-9c0a-2f1b8e6d4a90',
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
  'Discount codes by channel',
  'Which channel the orders on each discount code actually came from, for the chosen period and attribution window. A code is what the customer typed, not where they came from: an affiliate code proxies for that partner, a sitewide code appears under every channel. "(no code)" is an order that used none; "(not captured yet)" is an order collected before 2026-10-26, when codes began to be recorded. Net sales are the ledger''s net cents, which will not tie to the gross figures in shopify_discount_codes_daily.',
  'manual',
  'company',
  array[$q$with params as (
  select least({{report_end}}::date, (now() at time zone 'America/Los_Angeles')::date - 1) as report_end,
         greatest({{period_days}}::integer, 1) as period_days
), scope as (
  select l.order_id, l.channel, l.net_cents,
         case when l.discount_codes is null then '(not captured yet)'
              when l.discount_code is null then '(no code)'
              else l.discount_code end as discount_code
  from public.silo_attribution_ledger_v l, params p
  where l.window_days = {{attribution_window}}::integer
    and l.day between p.report_end - (p.period_days - 1) and p.report_end
), totals as (
  select sum(net_cents) as period_net from scope
)
select s.discount_code as "Discount code",
       s.channel as "Channel",
       count(distinct s.order_id) as "Orders",
       round(sum(s.net_cents) / 100.0, 2) as "Net sales",
       round(100.0 * sum(s.net_cents) / nullif((select period_net from totals), 0), 1) as "% of period net"
from scope s
group by 1, 2
having sum(s.net_cents) <> 0
order by case when s.discount_code like '(%' then 1 else 0 end, sum(s.net_cents) desc$q$],
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

-- The source rail is an allowlist (20260902110000); without this the ledger view
-- can only be reached from the builder's SQL tab. Curation only -- RLS is still
-- the boundary, and the view is security_invoker.
update public.silo_chat_schema_catalog
   set reportable = true, updated_at = now()
 where relname = 'silo_attribution_ledger_v';
