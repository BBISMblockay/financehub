-- Canned report accuracy: stable IDs, rolling company-calendar defaults.
-- Deploy frontend company-date support before applying. No policies or source data change.
-- See docs/ops/canned-report-accuracy.md for test evidence and source freshness limits.
begin;

-- Daily Sales
update public.silo_chat_saved_reports
set title = 'Daily Sales',
    description = 'Daily canonical net sales, units and distinct non-cancelled orders. Defaults to 60 completed company-calendar days. A blank measure means that source has no rows for the day.',
    queries_run = jsonb_build_array($report$with sales as materialized (
 select day_date, sum(total_net_sales) net_sales, sum(total_quantity_sold) units_sold
 from sales_by_day_verification_v where day_date between {{date_from}} and {{date_to}} group by 1
), ord as materialized (
 select (shopify_processed_at at time zone (select public.silo_business_timezone()))::date day_date, count(*) orders
 from shopify_orders_v where shopify_processed_at >= ({{date_from}}::timestamp at time zone (select public.silo_business_timezone()))
 and shopify_processed_at < (({{date_to}} + 1)::timestamp at time zone (select public.silo_business_timezone())) and cancelled_at is null group by 1
)
select coalesce(s.day_date,o.day_date) day_date, round(s.net_sales,2) net_sales,s.units_sold,o.orders
from sales s full join ord o using(day_date) order by 1$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-60d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"orders":{"semantic":"count"},"day_date":{"label":"Day","semantic":"date"},"net_sales":{"label":"Net Sales","semantic":"currency"},"units_sold":{"label":"Units Sold","semantic":"count"}}'::jsonb
where id = '5110de50-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;

-- Top Products — last 30 days
update public.silo_chat_saved_reports
set title = 'Top Products — last 30 days',
    description = 'Top 50 products by units over 30 completed company-calendar days by default. Product-title data reflects the last rollup refresh. Order counts are summed product-line counts, not distinct customer orders.',
    queries_run = jsonb_build_array($report$select product_title,
            sum(units_sold) as units_sold,
            round(sum(net_sales),2) as net_sales,
            sum(orders)     as orders
       from sales_by_product_title_daily_v
      where day_date between {{date_from}} and {{date_to}}
        and lower(product_title) <> 'x-redo'
        and product_title not ilike '%package protection%'
      group by product_title
      order by units_sold desc
      limit 50$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-30d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"orders":{"label":"Product-line orders (not distinct)","semantic":"count"},"net_sales":{"source":"authored","semantic":"currency"},"units_sold":{"source":"authored","semantic":"count"},"product_title":{"source":"authored","semantic":"category"}}'::jsonb
where id = '5110de50-0000-4000-a000-000000000002' and source = 'system' and company_entity_id is null;

-- Sales by Location — last 30 days
update public.silo_chat_saved_reports
set title = 'Sales by Location — last 30 days',
    description = 'Canonical net sales and units by location. Defaults to 30 completed company-calendar days.',
    queries_run = jsonb_build_array($report$select coalesce(location_tag,'Unknown') location_tag,
round(sum(total_net_sales),2) net_sales, sum(total_quantity_sold) units_sold
from sales_by_day_verification_v where day_date between {{date_from}} and {{date_to}} group by 1 order by net_sales desc$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-30d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"net_sales":{"source":"authored","semantic":"currency"},"units_sold":{"source":"authored","semantic":"count"},"location_tag":{"source":"authored","semantic":"category"}}'::jsonb
where id = '5110de50-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;

-- Ownership · Sales vs last year
update public.silo_chat_saved_reports
set title = 'Ownership · Sales vs last year',
    description = 'Canonical sales vs the same calendar dates last year, through the selected completed day (yesterday by default). Orders follow the company time zone. Leap-day comparisons use PostgreSQL calendar-year arithmetic.',
    queries_run = jsonb_build_array($report$with asof as (select {{as_of}} as d),
span as (select least((date_trunc('year', d)::date - interval '1 year')::date,
                     ((d - 6) - interval '1 year')::date) as from_d from asof),
daily as materialized (
  select day_date, sum(total_net_sales) as net_sales, sum(total_quantity_sold) as units,
         sum(total_refunds) as refunds
    from sales_by_day_verification_v
   where day_date >= (select from_d from span) and day_date <= (select d from asof)
   group by 1
),
daily_orders as materialized (
  select (o.shopify_processed_at at time zone (select public.silo_business_timezone()))::date as day_date, count(*) as orders
    from shopify_orders_v o
   where o.shopify_processed_at >= ((select from_d from span)::timestamp at time zone (select public.silo_business_timezone()))
     and o.shopify_processed_at <  (((select d from asof) + 1)::timestamp at time zone (select public.silo_business_timezone()))
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
       round(dc.net_sales,2)  as net_sales,
       round(dl.net_sales,2)  as net_sales_ly,
       round((dc.net_sales / nullif(dl.net_sales,0) - 1) * 100, 1) as vs_last_year,
       o.orders,
       round(dc.net_sales / nullif(o.orders,0), 2) as aov,
       dc.units::bigint     as units,
       round(dc.refunds,2)    as refunds
  from periods p
  left join lateral (select sum(net_sales) net_sales, sum(units) units, sum(refunds) refunds
                       from daily where day_date between p.start_d and p.end_d) dc on true
  left join lateral (select sum(net_sales) net_sales from daily
                      where day_date between (p.start_d - interval '1 year')::date
                                         and (p.end_d   - interval '1 year')::date) dl on true
  left join lateral (select sum(orders) orders from daily_orders
                      where day_date between p.start_d and p.end_d) o on true
 order by p.ord$report$),
    parameters = '[{"key":"as_of","type":"date","label":"As of","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"aov":{"label":"AOV","semantic":"currency"},"units":{"semantic":"count"},"orders":{"semantic":"count"},"period":{"label":"Period","semantic":"category"},"refunds":{"semantic":"currency"},"net_sales":{"label":"Net Sales","semantic":"currency"},"net_sales_ly":{"label":"Net Sales LY","semantic":"currency"},"vs_last_year":{"label":"vs Last Year","semantic":"percent"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;

-- Ownership · Net sales by day
update public.silo_chat_saved_reports
set title = 'Ownership · Net sales by day',
    description = 'Canonical net sales and units. Defaults to 90 completed company-calendar days.',
    queries_run = jsonb_build_array($report$select day_date,round(sum(total_net_sales),2) net_sales,sum(total_quantity_sold) units
from sales_by_day_verification_v where day_date between {{date_from}} and {{date_to}} group by 1 order by 1$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-90d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"units":{"semantic":"count"},"day_date":{"label":"Day","semantic":"date"},"net_sales":{"label":"Net Sales","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000002' and source = 'system' and company_entity_id is null;

-- Ownership · Sales by channel
update public.silo_chat_saved_reports
set title = 'Ownership · Sales by channel',
    description = 'Distinct orders and discounted merchandise subtotal by channel, excluding cancelled orders, tax and shipping. Refunds are not netted here; this is not net sales. Defaults to 28 completed company-calendar days.',
    queries_run = jsonb_build_array($report$select resolved_channel_name channel,count(*) orders,
round(sum(subtotal_price),2) merch_revenue,round(avg(subtotal_price),2) aov
from shopify_orders_v where shopify_processed_at >= ({{date_from}}::timestamp at time zone (select public.silo_business_timezone())) and shopify_processed_at < (({{date_to}} + 1)::timestamp at time zone (select public.silo_business_timezone()))
and cancelled_at is null group by 1 order by 3 desc$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"aov":{"label":"AOV","semantic":"currency"},"orders":{"semantic":"count"},"channel":{"semantic":"category"},"merch_revenue":{"label":"Merch Revenue","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;

-- Ownership · Paid media by platform
update public.silo_chat_saved_reports
set title = 'Ownership · Paid media by platform',
    description = 'Paid-platform claims including attribution received on zero-spend days; GA4 excluded. Platforms may claim the same sale. Defaults to 28 completed company-calendar days.',
    queries_run = jsonb_build_array($report$select platform,round(sum(spend),2) spend,
round(sum(conversion_value),2) platform_claimed_value,
round(sum(conversion_value)/nullif(sum(spend),0),2) claimed_roas,
sum(conversions) claimed_conversions,
round(sum(spend)/nullif(sum(conversions),0),2) cost_per_conversion,sum(clicks) clicks
from marketing_kpis_daily where day_date between {{date_from}} and {{date_to}} and platform <> 'ga4' group by 1 order by 2 desc$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"spend":{"semantic":"currency"},"clicks":{"semantic":"count"},"platform":{"semantic":"category"},"claimed_roas":{"label":"Claimed ROAS","semantic":"number"},"claimed_conversions":{"label":"Claimed Conversions","semantic":"count"},"cost_per_conversion":{"label":"Cost Per Conversion","semantic":"currency"},"platform_claimed_value":{"label":"Platform Claimed Value","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000004' and source = 'system' and company_entity_id is null;

-- Ownership · What the ad platforms claim vs what actually sold
update public.silo_chat_saved_reports
set title = 'Ownership · What the ad platforms claim vs what actually sold',
    description = 'Platform-attributed sales compared with canonical online net sales. Attribution is not additive across platforms. Cross-source ratios stay blank when days are missing from either source. Defaults to 28 completed company-calendar days.',
    queries_run = jsonb_build_array($report$with spend as materialized (
select day_date,sum(spend) ad_spend,sum(conversion_value) claimed
from marketing_kpis_daily where platform <> 'ga4' and day_date between {{date_from}} and {{date_to}} group by 1
), online as materialized (
select s.day_date,sum(s.total_net_sales) online_net_sales
from sales_by_day_verification_v s where s.day_date between {{date_from}} and {{date_to}}
and exists (select 1 from locations l where l.company_entity_id=s.company_entity_id
and l.store_type='online' and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code,''),l.location_name)),
'[^a-z0-9]+','_','g'),'_'),'')=s.location_tag) group by 1
)
select round(sum(sp.ad_spend),2) ad_spend,round(sum(sp.claimed),2) platforms_claim,
round(sum(o.online_net_sales),2) actually_sold_online,
round(sum(sp.claimed)/nullif(sum(sp.ad_spend),0),2) claimed_roas,
case when bool_and(sp.day_date is not null and o.day_date is not null)
then round(sum(o.online_net_sales)/nullif(sum(sp.ad_spend),0),2) end real_online_roas,
case when bool_and(sp.day_date is not null and o.day_date is not null)
then round(sum(sp.claimed)/nullif(sum(o.online_net_sales),0),2) end claim_ratio
from spend sp full join online o using(day_date)$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"ad_spend":{"label":"Ad Spend","semantic":"currency"},"claim_ratio":{"label":"Claim Ratio","semantic":"number"},"claimed_roas":{"label":"Claimed ROAS","semantic":"number"},"platforms_claim":{"label":"Platforms Claim","semantic":"currency"},"real_online_roas":{"label":"Real Online ROAS","semantic":"number"},"actually_sold_online":{"label":"Actually Sold Online","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000005' and source = 'system' and company_entity_id is null;

-- Ownership · Marketing efficiency by day
update public.silo_chat_saved_reports
set title = 'Ownership · Marketing efficiency by day',
    description = 'Canonical online net sales divided by paid ad spend, by company-calendar day. Missing source rows remain blank, not zero. Defaults to 28 completed days.',
    queries_run = jsonb_build_array($report$with spend as materialized (
select day_date,sum(spend) ad_spend,sum(conversion_value) claimed
from marketing_kpis_daily where platform <> 'ga4' and day_date between {{date_from}} and {{date_to}} group by 1
), online as materialized (
select s.day_date,sum(s.total_net_sales) online_net_sales
from sales_by_day_verification_v s where s.day_date between {{date_from}} and {{date_to}}
and exists (select 1 from locations l where l.company_entity_id=s.company_entity_id
and l.store_type='online' and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code,''),l.location_name)),
'[^a-z0-9]+','_','g'),'_'),'')=s.location_tag) group by 1
)
select coalesce(sp.day_date,o.day_date) day_date,round(sp.ad_spend,2) ad_spend,
round(o.online_net_sales,2) online_net_sales,
round(o.online_net_sales/nullif(sp.ad_spend,0),2) mer
from spend sp full join online o using(day_date) order by 1$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"mer":{"label":"MER","semantic":"number"},"ad_spend":{"label":"Ad Spend","semantic":"currency"},"day_date":{"label":"Day","semantic":"date"},"online_net_sales":{"label":"Online Net Sales","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000006' and source = 'system' and company_entity_id is null;

-- Logistics · Inventory and on order
update public.silo_chat_saved_reports
set title = 'Logistics · Inventory and on order',
    description = 'Current on-hand and confirmed incoming stock, including types without PO history. Cover uses trailing annual demand; combined cover includes incoming units. Blank cover means velocity is unknown or nonpositive.',
    queries_run = jsonb_build_array($report$select sum(units_on_hand) units_on_hand,sum(units_on_order) units_on_order,
case when count(*) filter (where (units_on_hand>0 or units_on_order>0) and (units_12m is null or units_12m<=0))=0
then round(sum(units_on_hand+units_on_order)/nullif(sum(units_12m)/52.0,0),1) end weeks_of_cover,
case when count(*) filter (where units_on_hand>0 and (units_12m is null or units_12m<=0))=0
then round(sum(units_on_hand)/nullif(sum(units_12m)/52.0,0),1) end weeks_on_hand
from demand_coverage_by_type_v where has_inventory or units_on_order>0$report$),
    parameters = '[]'::jsonb,
    columns_metadata = '{"units_on_hand":{"semantic":"count"},"units_on_order":{"semantic":"count"},"weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number"},"weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;

-- Logistics · Cover and momentum by product type
update public.silo_chat_saved_reports
set title = 'Logistics · Cover and momentum by product type',
    description = 'Stock by product type, including types without PO history or a minimum sales threshold. On-hand cover excludes incoming stock; combined cover includes it. Blank cover means unknown demand.',
    queries_run = jsonb_build_array($report$with coverage as (
select *,case when units_12m>0 then units_on_hand/(units_12m/52.0) end as onhand_cover
from demand_coverage_by_type_v
)
select product_type,units_on_hand,units_on_order,units_per_week_12m,weeks_of_cover,momentum_pct,
round(onhand_cover,1) weeks_on_hand
from coverage where has_inventory
order by onhand_cover asc nulls last$report$),
    parameters = '[]'::jsonb,
    columns_metadata = '{"momentum_pct":{"label":"Momentum","semantic":"percent"},"product_type":{"label":"Product Type","semantic":"category"},"units_on_hand":{"label":"On Hand","semantic":"count"},"units_on_order":{"label":"On Order","semantic":"count"},"weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number"},"units_per_week_12m":{"label":"Units Per Week (12m)","semantic":"number"},"weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000005' and source = 'system' and company_entity_id is null;

-- Logistics · Running thin
update public.silo_chat_saved_reports
set title = 'Logistics · Running thin',
    description = 'Types with less than the selected weeks of stock on hand at trailing annual demand. Incoming stock is shown separately and cannot hide a current shortage. Unknown-demand types remain in Stock Cover.',
    queries_run = jsonb_build_array($report$with coverage as (
select *,case when units_12m>0 then units_on_hand/(units_12m/52.0) end as onhand_cover
from demand_coverage_by_type_v
)
select product_type,units_on_hand,units_on_order,units_per_week_12m,weeks_of_cover,momentum_pct,
round(onhand_cover,1) weeks_on_hand
from coverage where has_inventory and onhand_cover < {{cover_weeks}}
order by onhand_cover asc nulls last$report$),
    parameters = '[{"key":"cover_weeks","type":"number","label":"Cover under (weeks)","default":26}]'::jsonb,
    columns_metadata = '{"momentum_pct":{"label":"Momentum","semantic":"percent"},"product_type":{"label":"Product Type","semantic":"category"},"units_on_hand":{"label":"On Hand","semantic":"count"},"units_on_order":{"label":"On Order","semantic":"count"},"weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number"},"units_per_week_12m":{"label":"Units Per Week (12m)","semantic":"number"},"weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000006' and source = 'system' and company_entity_id is null;

-- Logistics · Overstocked and slowing
update public.silo_chat_saved_reports
set title = 'Logistics · Overstocked and slowing',
    description = 'Types with at least a year of stock on hand and declining demand. Incoming stock is shown separately. Includes types without PO history.',
    queries_run = jsonb_build_array($report$with coverage as (
select *,case when units_12m>0 then units_on_hand/(units_12m/52.0) end as onhand_cover
from demand_coverage_by_type_v
)
select product_type,units_on_hand,units_on_order,units_per_week_12m,weeks_of_cover,momentum_pct,
round(onhand_cover,1) weeks_on_hand
from coverage where has_inventory and onhand_cover >= 52 and momentum_pct < 0
order by onhand_cover desc$report$),
    parameters = '[]'::jsonb,
    columns_metadata = '{"momentum_pct":{"label":"Momentum","semantic":"percent"},"product_type":{"label":"Product Type","semantic":"category"},"units_on_hand":{"label":"On Hand","semantic":"count"},"units_on_order":{"label":"On Order","semantic":"count"},"weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number"},"units_per_week_12m":{"label":"Units Per Week (12m)","semantic":"number"},"weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000007' and source = 'system' and company_entity_id is null;

-- Logistics · Stock with no recent sales
update public.silo_chat_saved_reports
set title = 'Logistics · Stock with no recent sales',
    description = 'Stock with no recorded sales in the source’s rolling 30-day window. Every included product/location row must have matched velocity. Includes sales at zero-stock locations when qualifying products; this is not a stock-age or write-off recommendation.',
    queries_run = jsonb_build_array($report$select product_title,product_type,sum(total_available_quantity) on_hand,
round(sum(total_available_inventory_value),2) value_at_retail,max(last_sold_date) last_sold
from inventory_workboard_v
where product_type is not null and product_type not in ('Package Protection','Bundles & Multi-Packs','Uncategorized','custom_sale')
group by 1,2
having bool_and(coalesce(velocity_matched,false)) and count(*) filter(where sold_30 is null)=0
and bool_and(sold_30=0) and sum(total_available_quantity)>0 and sum(total_available_quantity)>={{min_units}}
order by value_at_retail desc$report$),
    parameters = '[{"key":"min_units","type":"number","label":"At least (units on hand)","default":200}]'::jsonb,
    columns_metadata = '{"on_hand":{"label":"On Hand","semantic":"count"},"last_sold":{"label":"Last Sold","semantic":"date"},"product_type":{"label":"Product Type","semantic":"category"},"product_title":{"label":"Product","semantic":"category"},"value_at_retail":{"label":"Value At Retail","semantic":"currency"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000008' and source = 'system' and company_entity_id is null;

-- Logistics · Sales relative to current stock
update public.silo_chat_saved_reports
set title = 'Logistics · Sales relative to current stock',
    description = 'Trailing three-month units divided by those units plus current stock. A sales-to-current-stock indicator, not historical receipt-based sell-through. Includes stock without PO history.',
    queries_run = jsonb_build_array($report$select product_type,
       units_3m                as units_sold_3m,
       units_on_hand,
       round(units_3m / nullif(units_3m + units_on_hand, 0) * 100, 1) as sell_through_pct
  from demand_coverage_by_type_v
 where has_inventory
 order by units_3m desc nulls last$report$),
    parameters = '[]'::jsonb,
    columns_metadata = '{"product_type":{"label":"Product Type","semantic":"category"},"units_on_hand":{"label":"On Hand","semantic":"count"},"units_sold_3m":{"label":"Units Sold (3m)","semantic":"count"},"sell_through_pct":{"label":"Sales / (sales + current stock)","semantic":"percent"}}'::jsonb
where id = 'c1000000-0000-4000-a000-000000000009' and source = 'system' and company_entity_id is null;

-- Logistics · Top products by units sold
update public.silo_chat_saved_reports
set title = 'Logistics · Top products by units sold',
    description = 'Products ranked by units in the last 28 completed company-calendar days by default. Uses the last product-title rollup refresh.',
    queries_run = jsonb_build_array($report$select product_title,
       product_type,
       sum(units_sold) as units_sold,
       sum(net_sales)  as net_sales,
       count(distinct day_date) as days_with_sales
  from sales_by_product_title_daily_v
 where day_date between {{date_from}} and {{date_to}}
   and product_title is not null
   and product_title <> 'x-redo'
 group by 1, 2
 order by 3 desc$report$),
    parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
    columns_metadata = '{"net_sales":{"label":"Net Sales","semantic":"currency"},"units_sold":{"label":"Units Sold","semantic":"count"},"product_type":{"label":"Product Type","semantic":"category"},"product_title":{"label":"Product","semantic":"category"},"days_with_sales":{"label":"Days With Sales","semantic":"count"}}'::jsonb
where id = 'c1000000-0000-4000-a000-00000000000a' and source = 'system' and company_entity_id is null;

-- Replace obsolete checks only for these global templates. Private reports are untouched.
delete from public.silo_report_tieouts t using public.silo_chat_saved_reports r
where t.report_id=r.id and r.source='system' and r.company_entity_id is null
and r.id in ('5110de50-0000-4000-a000-000000000001','5110de50-0000-4000-a000-000000000002','5110de50-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000001','c3000000-0000-4000-a000-000000000002','c3000000-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000004','c3000000-0000-4000-a000-000000000005','c3000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000001','c1000000-0000-4000-a000-000000000005','c1000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000007','c1000000-0000-4000-a000-000000000008','c1000000-0000-4000-a000-000000000009','c1000000-0000-4000-a000-00000000000a');

-- Checks execute a snapshot of the deployed report with its real defaults.
-- Any later query/default edit produces NO DATA rather than silently passing
-- a check of an obsolete query. The SQL remains SECURITY INVOKER via the existing runner.
do $checks$
declare r record; p jsonb; q text; literal text; lhs text; rhs text; check_name text; guard text; date_from_sql text; date_to_sql text;
begin
for r in select * from public.silo_chat_saved_reports where source='system' and company_entity_id is null
and id in ('5110de50-0000-4000-a000-000000000001','5110de50-0000-4000-a000-000000000002','5110de50-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000001','c3000000-0000-4000-a000-000000000002','c3000000-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000004','c3000000-0000-4000-a000-000000000005','c3000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000001','c1000000-0000-4000-a000-000000000005','c1000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000007','c1000000-0000-4000-a000-000000000008','c1000000-0000-4000-a000-000000000009','c1000000-0000-4000-a000-00000000000a') loop
 q := r.queries_run->>0;
 date_from_sql := null; date_to_sql := null;
 for p in select value from jsonb_array_elements(r.parameters) loop
  if p->>'type'='date' then
   if p->>'default' ~ '^today-[0-9]+d$' then
    literal := format('((select public.silo_business_today()) - %s)', substring(p->>'default' from '[0-9]+'));
   else raise exception 'Unsupported canned date default'; end if;
  elsif p->>'type'='number' then literal := ((p->>'default')::numeric)::text;
  else raise exception 'Unsupported canned parameter'; end if;
  q := replace(q, '{{'||(p->>'key')||'}}',literal);
  if p->>'key'='date_from' then date_from_sql := literal; end if;
  if p->>'key'='date_to' then date_to_sql := literal; end if;
 end loop;
 guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id=%L)',
 md5(r.queries_run::text || r.parameters::text),r.id);
 lhs := null; rhs := null;
 case r.id::text
 when '5110de50-0000-4000-a000-000000000001' then lhs := 'sum(net_sales)'; rhs := '(select sum(total_net_sales) from sales_by_day_verification_v where day_date between (select silo_business_today())-60 and (select silo_business_today())-1)'; check_name := 'Daily sales agree with canonical total';
 when '5110de50-0000-4000-a000-000000000003' then lhs := 'sum(net_sales)'; rhs := '(select sum(total_net_sales) from sales_by_day_verification_v where day_date between (select silo_business_today())-30 and (select silo_business_today())-1)'; check_name := 'Locations agree with canonical total';
 when 'c3000000-0000-4000-a000-000000000002' then lhs := 'sum(net_sales)'; rhs := '(select sum(total_net_sales) from sales_by_day_verification_v where day_date between (select silo_business_today())-90 and (select silo_business_today())-1)'; check_name := 'Daily series agrees with canonical total';
 when 'c3000000-0000-4000-a000-000000000001' then lhs := 'max(orders) filter(where period=''Yesterday'')'; rhs := '(select count(distinct order_id) from shopify_orders where company_entity_id=(select active_company_id()) and cancelled_at is null and (shopify_processed_at at time zone (select silo_business_timezone()))::date=(select silo_business_today())-1)'; check_name := 'Yesterday orders reconcile by company-local date';
 when 'c3000000-0000-4000-a000-000000000003' then lhs := 'sum(orders)'; rhs := '(select count(distinct order_id) from shopify_orders where company_entity_id=(select active_company_id()) and cancelled_at is null and (shopify_processed_at at time zone (select silo_business_timezone()))::date between (select silo_business_today())-28 and (select silo_business_today())-1)'; check_name := 'Channel orders reconcile by company-local date';
 when 'c3000000-0000-4000-a000-000000000004' then lhs := 'sum(spend)'; rhs := '(select sum(ad_spend) from v_marketing_mer_daily where day_date between (select silo_business_today())-28 and (select silo_business_today())-1)'; check_name := 'Paid spend agrees with shared marketing view';
 when 'c3000000-0000-4000-a000-000000000005' then lhs := 'sum(ad_spend)'; rhs := '(select sum(ad_spend) from v_marketing_mer_daily where day_date between (select silo_business_today())-28 and (select silo_business_today())-1)'; check_name := 'Paid spend agrees with shared marketing view';
 when 'c3000000-0000-4000-a000-000000000006' then lhs := 'sum(ad_spend)'; rhs := '(select sum(ad_spend) from v_marketing_mer_daily where day_date between (select silo_business_today())-28 and (select silo_business_today())-1)'; check_name := 'Paid spend agrees with shared marketing view';
 when 'c1000000-0000-4000-a000-000000000001' then lhs := 'sum(units_on_hand)'; rhs := '(select sum(total_available_quantity) from inventory_on_hand_current_v where company_entity_id=(select active_company_id()) and nullif(product_type,'''') is not null)'; check_name := 'On-hand units agree with live inventory';
 when 'c1000000-0000-4000-a000-000000000005' then lhs := 'sum(units_on_hand)'; rhs := '(select sum(total_available_quantity) from inventory_on_hand_current_v where company_entity_id=(select active_company_id()) and product_type in (select product_type from report))'; check_name := 'On-hand units agree with live inventory';
 when 'c1000000-0000-4000-a000-000000000006' then lhs := 'sum(units_on_hand)'; rhs := '(select sum(total_available_quantity) from inventory_on_hand_current_v where company_entity_id=(select active_company_id()) and product_type in (select product_type from report))'; check_name := 'On-hand units agree with live inventory';
 when 'c1000000-0000-4000-a000-000000000007' then lhs := 'sum(units_on_hand)'; rhs := '(select sum(total_available_quantity) from inventory_on_hand_current_v where company_entity_id=(select active_company_id()) and product_type in (select product_type from report))'; check_name := 'On-hand units agree with live inventory';
 when 'c1000000-0000-4000-a000-000000000009' then lhs := 'sum(units_sold_3m)'; rhs := '(select sum(units) from sales_monthly_product_type_rollup_v where month_start >= date_trunc(''month'',(select silo_business_today()))::date - interval ''3 months'' and month_start < date_trunc(''month'',(select silo_business_today()))::date and product_type in (select product_type from report))'; check_name := 'Three-month units agree with monthly sales';
 else null;
 end case;
 if lhs is not null then
 insert into public.silo_report_tieouts(report_id,name,kind,check_sql,tolerance,note)
 values(r.id,check_name,'reconciliation',
 format('with report as materialized (%s) select case when %s then %s end as left_value, %s as right_value from report',q,guard,lhs,rhs),
 case when r.id::text like 'c100%%' or r.id::text in ('c3000000-0000-4000-a000-000000000001','c3000000-0000-4000-a000-000000000003') then 0 else 0.01 end,
 'Uses deployed default SQL. NO DATA can mean no source rows or a changed definition requiring a refreshed check; never a certification of completeness.');
 end if;
 -- Separate source reconciliation for title-ranked reports and verified no-sales stock.
 if r.id::text in ('5110de50-0000-4000-a000-000000000002','c1000000-0000-4000-a000-00000000000a') then
 if date_from_sql is null or date_to_sql is null then raise exception 'Product report date bounds are required'; end if;
 insert into public.silo_report_tieouts(report_id,name,kind,check_sql,tolerance,note)
 values(r.id,'Product rollup completeness vs canonical sales','reconciliation',format(
 'select case when %s then (select sum(net_sales) from sales_by_product_title_daily_v where day_date between %s and %s) end,
 (select sum(total_net_sales) from sales_by_day_verification_v where day_date between %s and %s)',guard,date_from_sql,date_to_sql,date_from_sql,date_to_sql),0.01,
 'Full source coverage before top-N/merchandise exclusions. Mismatch exposes stale rollups, catalog fan-out or historical source overlap; no large tolerance masks it.');
 end if;
 if r.id::text='c1000000-0000-4000-a000-000000000008' then
 insert into public.silo_report_tieouts(report_id,name,kind,check_sql,tolerance,note) values
 (r.id,'Velocity join preserves inventory units','reconciliation',format('select case when %s then (select sum(total_available_quantity) from inventory_workboard_v) end, (select sum(total_available_quantity) from inventory_on_hand_current_v where company_entity_id=(select active_company_id()))',guard),0,'Source-level completeness; unknown velocity remains excluded from no-sales recommendations.'),
 (r.id,'Every no-sales product has complete zero-sales evidence','sanity',format(
 'with report as materialized (%s) select case when %s then count(*) end,0 from report r where exists
 (select 1 from inventory_workboard_v i where i.product_title is not distinct from r.product_title and i.product_type is not distinct from r.product_type and (i.velocity_matched is not true or i.sold_30 is null or i.sold_30<>0))',q,guard),0,'Checks the returned products, including zero-stock and unknown-velocity rows.');
 end if;
end loop;
end $checks$;
commit;
