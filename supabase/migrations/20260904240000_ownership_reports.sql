-- Ownership report definitions.
--
-- Built from the questions Jon Loomis actually asked Ask SILO -- he
-- requested a "chief of staff style report" twice, and every version wanted
-- the same things: yesterday / last 7 days / MTD measured against the same
-- period a year ago, the channel mix, paid media efficiency, and what is
-- launching next. Those questions were right; the ad-hoc SQL behind them was
-- not reusable, so this is a rebuild rather than a save of his transcripts.
--
-- Three traps found while verifying rather than trusting:
--
--  1. sales_by_day carries ONE ROW PER SKU PER DAY, and each row repeats the
--     order count. Summing total_orders gives 9,995 for a day that had 2,298
--     real orders -- a 4.3x overcount that would print AOV as $27 instead of
--     $116. Order counts come from shopify_orders_v (one row per order).
--
--  2. GA4 is in marketing_kpis_daily with ZERO spend and 517,970
--     "conversions" over 28 days, because it is analytics, not an ad
--     platform. Left in, it makes cost-per-conversion look like $0.75 and
--     ROAS meaningless. Every paid-media report here excludes it, which is
--     also exactly what v_marketing_mer_daily does internally.
--
--  3. Today is always a PARTIAL day -- the sync runs each morning, so
--     current_date holds a few hours of sales. Every period anchors to
--     current_date - 1. A board that silently included today would show a
--     collapse every morning.
insert into public.silo_chat_saved_reports
  (id, source, company_entity_id, created_by, title, description,
   question, answer, queries_run, visibility, columns_metadata, parameters)
values
('c3000000-0000-4000-a000-000000000001','system',null,null,
 'Ownership · Sales vs last year',
 'Yesterday, last 7 days, month to date and year to date, each against the same period a year ago.',
 null,null,
 array[$q$
-- AS MATERIALIZED is load-bearing, not style. Without it Postgres inlines
-- these CTEs and re-scans them once per period per lateral -- twelve scans
-- of twenty months of sales and orders. Measured: 14,949ms inlined,
-- 588ms materialised.
with asof as (select (current_date - 1) as d),
span as (select (date_trunc('year', (select d from asof))::date - interval '1 year')::date as from_d),
daily as materialized (
  select day_date, sum(total_net_sales) as net_sales, sum(total_quantity_sold) as units,
         sum(total_refunds) as refunds
    from wow_sales_daily_type_v
   where day_date >= (select from_d from span) and day_date <= (select d from asof)
   group by 1
),
daily_orders as materialized (
  select o.shopify_processed_at::date as day_date, count(*) as orders
    from shopify_orders_v o
   where o.shopify_processed_at >= (select from_d from span)::timestamptz
     and o.shopify_processed_at <  ((select d from asof) + 1)::timestamptz
     and o.cancelled_at is null
   group by 1
),
periods as (
  select 'Yesterday' as period, 1 as ord, d as start_d, d as end_d from asof
  union all select 'Last 7 days',   2, d - 6, d from asof
  union all select 'Month to date', 3, date_trunc('month', d)::date, d from asof
  union all select 'Year to date',  4, date_trunc('year', d)::date, d from asof
)
select p.period,
       round(dc.net_sales)  as net_sales,
       round(dl.net_sales)  as net_sales_ly,
       round((dc.net_sales / nullif(dl.net_sales,0) - 1) * 100, 1) as vs_last_year,
       o.orders,
       round(dc.net_sales / nullif(o.orders,0), 2) as aov,
       dc.units::bigint     as units,
       round(dc.refunds)    as refunds
  from periods p
  left join lateral (select sum(net_sales) net_sales, sum(units) units, sum(refunds) refunds
                       from daily where day_date between p.start_d and p.end_d) dc on true
  left join lateral (select sum(net_sales) net_sales from daily
                      where day_date between (p.start_d - interval '1 year')::date
                                         and (p.end_d   - interval '1 year')::date) dl on true
  left join lateral (select sum(orders) orders from daily_orders
                      where day_date between p.start_d and p.end_d) o on true
 order by p.ord
$q$],
 'company',
 '{"period":{"semantic":"category","label":"Period"},"net_sales":{"semantic":"currency","label":"Net Sales"},
   "net_sales_ly":{"semantic":"currency","label":"Net Sales LY"},"vs_last_year":{"semantic":"percent","label":"vs Last Year"},
   "orders":{"semantic":"count"},"aov":{"semantic":"currency","label":"AOV"},
   "units":{"semantic":"count"},"refunds":{"semantic":"currency"}}'::jsonb,
 null),

('c3000000-0000-4000-a000-000000000002','system',null,null,
 'Ownership · Net sales by day',
 'Daily net sales across every channel. Today is excluded — it is always a partial day.',
 null,null,
 array[$q$
select day_date,
       round(sum(total_net_sales)) as net_sales,
       sum(total_quantity_sold)    as units
  from sales_by_day_verification_v
 where day_date >= {{date_from}}
   and day_date <= current_date - 1
 group by 1
 order by 1
$q$],
 'company',
 '{"day_date":{"semantic":"date","label":"Day"},"net_sales":{"semantic":"currency","label":"Net Sales"},
   "units":{"semantic":"count"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-90d"}]'::jsonb),

('c3000000-0000-4000-a000-000000000003','system',null,null,
 'Ownership · Sales by channel',
 'Orders and revenue by Shopify sales channel, using the admin-maintained channel names.',
 null,null,
 array[$q$
select resolved_channel_name       as channel,
       count(*)                    as orders,
       round(sum(total_price))     as revenue,
       round(avg(total_price), 2)  as aov
  from shopify_orders_v
 where shopify_processed_at >= {{date_from}}::timestamptz
   and shopify_processed_at <  current_date::timestamptz
   and cancelled_at is null
 group by 1
 order by 3 desc
$q$],
 'company',
 '{"channel":{"semantic":"category"},"orders":{"semantic":"count"},
   "revenue":{"semantic":"currency"},"aov":{"semantic":"currency","label":"AOV"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-28d"}]'::jsonb),

('c3000000-0000-4000-a000-000000000004','system',null,null,
 'Ownership · Paid media by platform',
 'Spend, platform-claimed return and cost per claimed conversion. Analytics-only sources are excluded.',
 null,null,
 array[$q$
select platform,
       round(sum(spend))                                      as spend,
       round(sum(conversion_value))                           as platform_claimed_value,
       round(sum(conversion_value) / nullif(sum(spend),0), 2) as claimed_roas,
       round(sum(conversions))                                as claimed_conversions,
       round(sum(spend) / nullif(sum(conversions),0), 2)      as cost_per_conversion,
       sum(clicks)                                            as clicks
  from marketing_kpis_daily
 where day_date >= {{date_from}}
   and day_date <= current_date - 1
   and spend > 0
 group by 1
 order by 2 desc
$q$],
 'company',
 '{"platform":{"semantic":"category"},"spend":{"semantic":"currency"},
   "platform_claimed_value":{"semantic":"currency","label":"Platform Claimed Value"},
   "claimed_roas":{"semantic":"number","label":"Claimed ROAS"},
   "claimed_conversions":{"semantic":"count","label":"Claimed Conversions"},
   "cost_per_conversion":{"semantic":"currency","label":"Cost Per Conversion"},
   "clicks":{"semantic":"count"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-28d"}]'::jsonb),

('c3000000-0000-4000-a000-000000000005','system',null,null,
 'Ownership · What the ad platforms claim vs what actually sold',
 'Platform-reported conversion value against real online net sales over the same days. The ratio is how much of a real dollar the platforms take credit for.',
 null,null,
 array[$q$
-- Rebuilt from the base tables rather than v_marketing_mer_daily: that view
-- aggregates ALL of sales_by_day (1.14M rows) inside a CTE with no date
-- bound, so an outer date filter cannot save it. Same definition, same
-- numbers (verified 375,589 / 924,778 / 1,133,188 over 28 days),
-- 5,622ms -> 501ms. ga4 is excluded exactly as the view does: it reports no
-- spend and half a million events, because it is analytics, not ad spend.
with spend as materialized (
  select day_date, sum(spend) as ad_spend, sum(conversion_value) as claimed
    from marketing_kpis_daily
   where platform <> 'ga4'
     and day_date >= {{date_from}} and day_date <= current_date - 1
   group by 1
),
online as materialized (
  select s.day_date, sum(s.total_net_sales) as online_net_sales
    from sales_by_day s
    join locations l
      on l.company_entity_id = s.company_entity_id
     and l.store_type = 'online'
     and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code,''), l.location_name)),
                      '[^a-z0-9]+','_','g'), '_'), '') = s.location_tag
   where s.day_date >= {{date_from}} and s.day_date <= current_date - 1
   group by 1
)
select round(sum(sp.ad_spend))                                        as ad_spend,
       round(sum(sp.claimed))                                         as platforms_claim,
       round(sum(o.online_net_sales))                                 as actually_sold_online,
       round(sum(sp.claimed) / nullif(sum(sp.ad_spend),0), 2)         as claimed_roas,
       round(sum(o.online_net_sales) / nullif(sum(sp.ad_spend),0), 2) as real_online_roas,
       round(sum(sp.claimed) / nullif(sum(o.online_net_sales),0), 2)  as claim_ratio
  from spend sp full join online o using (day_date)
$q$],
 'company',
 '{"ad_spend":{"semantic":"currency","label":"Ad Spend"},
   "platforms_claim":{"semantic":"currency","label":"Platforms Claim"},
   "actually_sold_online":{"semantic":"currency","label":"Actually Sold Online"},
   "claimed_roas":{"semantic":"number","label":"Claimed ROAS"},
   "real_online_roas":{"semantic":"number","label":"Real Online ROAS"},
   "claim_ratio":{"semantic":"number","label":"Claim Ratio"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-28d"}]'::jsonb),

('c3000000-0000-4000-a000-000000000006','system',null,null,
 'Ownership · Marketing efficiency by day',
 'Daily ad spend against online net sales, and the resulting MER.',
 null,null,
 array[$q$
-- Same rebuild as the claimed-vs-actual report: base tables with real date
-- bounds instead of v_marketing_mer_daily, which scans all of sales_by_day.
with spend as materialized (
  select day_date, sum(spend) as ad_spend
    from marketing_kpis_daily
   where platform <> 'ga4'
     and day_date >= {{date_from}} and day_date <= current_date - 1
   group by 1
),
online as materialized (
  select s.day_date, sum(s.total_net_sales) as online_net_sales
    from sales_by_day s
    join locations l
      on l.company_entity_id = s.company_entity_id
     and l.store_type = 'online'
     and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code,''), l.location_name)),
                      '[^a-z0-9]+','_','g'), '_'), '') = s.location_tag
   where s.day_date >= {{date_from}} and s.day_date <= current_date - 1
   group by 1
)
select coalesce(sp.day_date, o.day_date)                                  as day_date,
       round(coalesce(sp.ad_spend, 0))                                    as ad_spend,
       round(coalesce(o.online_net_sales, 0))                             as online_net_sales,
       round(coalesce(o.online_net_sales,0) / nullif(sp.ad_spend,0), 2)   as mer
  from spend sp full join online o using (day_date)
 order by 1
$q$],
 'company',
 '{"mer":{"semantic":"number","label":"MER"},"ad_spend":{"semantic":"currency","label":"Ad Spend"},
   "day_date":{"semantic":"date","label":"Day"},
   "online_net_sales":{"semantic":"currency","label":"Online Net Sales"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-28d"}]'::jsonb),

('c3000000-0000-4000-a000-000000000007','system',null,null,
 'Ownership · Upcoming launches',
 'Everything on the launch calendar from today forward.',
 null,null,
 array[$q$
select launch_date,
       title,
       coalesce(launch_type, '—')     as launch_type,
       expected_units,
       launch_readiness,
       (launch_date - current_date)   as days_away
  from launch_calendar
 where launch_date >= current_date
 order by launch_date
$q$],
 'company',
 '{"launch_date":{"semantic":"date","label":"Launch Date"},"title":{"semantic":"category","label":"Launch"},
   "launch_type":{"semantic":"category","label":"Type"},"expected_units":{"semantic":"count","label":"Expected Units"},
   "launch_readiness":{"semantic":"category","label":"Readiness"},
   "days_away":{"semantic":"count","label":"Days Away"}}'::jsonb,
 null)
on conflict (id) do update set
  title=excluded.title, description=excluded.description, queries_run=excluded.queries_run,
  columns_metadata=excluded.columns_metadata, parameters=excluded.parameters, updated_at=now();
