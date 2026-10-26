-- "Discount codes by channel": roll Redo's return/exchange codes into one line.
--
-- Redo issues a single-use code per customer, `RE-XXXXXX`. In one week that was
-- 81 orders under 81 distinct codes -- every real campaign code pushed off the
-- first screen by rows that each describe one shopper. They are bucketed, not
-- dropped: the line keeps its channel split, which is the interesting part,
-- because SILO credits these orders to the journey that brought the customer
-- back, not to the code. Only ~60% of them land on Redo Email/SMS; the rest sit
-- under Meta Ads, Organic Search, Referral and the Shop apps. Redo's own
-- dashboard claims all of them, so the two tools will disagree by design.
--
-- Matched on the `RE-` prefix (case-insensitive) rather than a list, since the
-- suffix is random per order. A campaign code someone names RE-SOMETHING would
-- fall in here too; nothing in the last week looks like that, and the bucket is
-- one line to read rather than a silent exclusion.
--
-- Everything else about the report is unchanged. Sort order now has three tiers:
-- real codes, then the Redo bucket, then '(no code)' and '(not captured yet)'.

update public.silo_chat_saved_reports
   set queries_run = array[$q$with params as (
  select least({{report_end}}::date, (now() at time zone 'America/Los_Angeles')::date - 1) as report_end,
         greatest({{period_days}}::integer, 1) as period_days
), scope as (
  select l.order_id, l.channel, l.net_cents,
         case when l.discount_codes is null then '(not captured yet)'
              when l.discount_code is null then '(no code)'
              when l.discount_code ilike 'RE-%' then 'Redo return/exchange codes'
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
order by case when s.discount_code like '(%' then 2
              when s.discount_code = 'Redo return/exchange codes' then 1
              else 0 end,
         sum(s.net_cents) desc$q$],
       description = 'Which channel the orders on each discount code actually came from, for the chosen period and attribution window. A code is what the customer typed, not where they came from: an affiliate code proxies for that partner, a sitewide code appears under every channel. Redo''s single-use RE- return/exchange codes are rolled into one line, keeping their channel split -- SILO credits those orders to the journey that brought the customer back, so Redo''s own dashboard will claim more of them than this does. "(no code)" is an order that used none; "(not captured yet)" is an order collected before 2026-10-26, when codes began to be recorded. Net sales are the ledger''s net cents, which will not tie to the gross figures in shopify_discount_codes_daily.',
       updated_at = now()
 where id = '7b3a0c4e-5d21-4f68-9c0a-2f1b8e6d4a90';
