-- Logistics report definitions, seeded as `system` (global,
-- company_entity_id null). Safe because every one reads a
-- security_invoker view -- verified before writing these: all six sources
-- (demand_coverage_by_type_v, inventory_workboard_v, v_po_incoming_summary,
-- v_po_incoming_lines, v_po_header_summary, sales_by_product_title_daily_v)
-- are security_invoker = true, so one definition scopes itself per tenant.
-- A `system` report reading a MATERIALIZED view would hand every tenant's
-- rows to every tenant, since Postgres does not enforce RLS on a matview.

insert into public.silo_chat_saved_reports
  (id, source, company_entity_id, created_by, title, description,
   question, answer, queries_run, visibility, columns_metadata, parameters)
values

-- ── 1. Headline: what we hold and what is coming ────────────────────
('c1000000-0000-4000-a000-000000000001','system',null,null,
 'Logistics · Inventory and on order',
 'Units on hand, units on purchase order, and weeks of cover across all merchandise.',
 null,null,
 array[$q$
select sum(units_on_hand)   as units_on_hand,
       sum(units_on_order)  as units_on_order,
       round(sum(units_on_hand + units_on_order)
             / nullif(sum(units_per_week_12m), 0), 1) as weeks_of_cover
  from demand_coverage_by_type_v
 where has_inventory and has_purchase_history
$q$],
 'company',
 '{"units_on_hand":{"semantic":"count"},"units_on_order":{"semantic":"count"},
   "weeks_of_cover":{"semantic":"number","label":"Weeks Of Cover"}}'::jsonb,
 null),

-- ── 2. Overdue POs. The most actionable thing on the board. ─────────
('c1000000-0000-4000-a000-000000000002','system',null,null,
 'Logistics · Purchase orders past their arrival date',
 'Open POs whose expected arrival has passed and which have not been received.',
 null,null,
 array[$q$
select po_name,
       factory_name,
       status,
       expected_arrival_date,
       (current_date - expected_arrival_date) as days_late,
       total_units,
       style_count
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and expected_arrival_date is not null
   and expected_arrival_date < current_date
 order by expected_arrival_date asc
$q$],
 'company',
 '{"po_name":{"semantic":"category","label":"PO"},"factory_name":{"semantic":"category","label":"Factory"},
   "status":{"semantic":"category"},"expected_arrival_date":{"semantic":"date","label":"Expected"},
   "days_late":{"semantic":"count","label":"Days Late"},"total_units":{"semantic":"count","label":"Units"},
   "style_count":{"semantic":"count","label":"Styles"}}'::jsonb,
 null),

-- ── 3. Incoming pipeline by month ───────────────────────────────────
('c1000000-0000-4000-a000-000000000003','system',null,null,
 'Logistics · Units arriving by month',
 'Units on open purchase orders, grouped by expected arrival month.',
 null,null,
 array[$q$
select date_trunc('month', expected_arrival_date)::date as arrival_month,
       sum(total_units)          as units_arriving,
       count(*)                  as purchase_orders
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and expected_arrival_date is not null
 group by 1
 order by 1
$q$],
 'company',
 '{"arrival_month":{"semantic":"date","label":"Arrival Month"},
   "units_arriving":{"semantic":"count","label":"Units Arriving"},
   "purchase_orders":{"semantic":"count","label":"Purchase Orders"}}'::jsonb,
 null),

-- ── 4. Where the open buy sits ──────────────────────────────────────
('c1000000-0000-4000-a000-000000000004','system',null,null,
 'Logistics · Open units by factory',
 'Units on open purchase orders by factory, largest first.',
 null,null,
 array[$q$
select factory_name,
       sum(total_units)  as units_open,
       count(*)          as purchase_orders,
       min(expected_arrival_date) as next_arrival
  from v_po_incoming_summary
 where status in ('Confirmed','Sent to Factory','In Production','In Transit')
   and factory_name is not null
 group by 1
 order by 2 desc
$q$],
 'company',
 '{"factory_name":{"semantic":"category","label":"Factory"},
   "units_open":{"semantic":"count","label":"Units Open"},
   "purchase_orders":{"semantic":"count","label":"Purchase Orders"},
   "next_arrival":{"semantic":"date","label":"Next Arrival"}}'::jsonb,
 null),

-- ── 5. Cover and momentum, the buying picture ───────────────────────
('c1000000-0000-4000-a000-000000000005','system',null,null,
 'Logistics · Cover and momentum by product type',
 'Weeks of cover against 3-month vs 12-month momentum, for merchandise only.',
 null,null,
 array[$q$
select product_type,
       units_on_hand,
       units_on_order,
       units_per_week_12m,
       weeks_of_cover,
       momentum_pct
  from demand_coverage_by_type_v
 where has_inventory and has_purchase_history
   and units_12m >= 500
 order by units_per_week_12m desc nulls last
$q$],
 'company',
 '{"product_type":{"semantic":"category","label":"Product Type"},
   "units_on_hand":{"semantic":"count","label":"On Hand"},
   "units_on_order":{"semantic":"count","label":"On Order"},
   "units_per_week_12m":{"semantic":"number","label":"Units Per Week (12m)"},
   "weeks_of_cover":{"semantic":"number","label":"Weeks Of Cover"},
   "momentum_pct":{"semantic":"percent","label":"Momentum"}}'::jsonb,
 null),

-- ── 6. Running thin (parameterised threshold) ───────────────────────
('c1000000-0000-4000-a000-000000000006','system',null,null,
 'Logistics · Running thin',
 'Merchandise types with fewer weeks of cover than the threshold. Empty is a good answer.',
 null,null,
 array[$q$
select product_type,
       units_on_hand,
       units_on_order,
       units_per_week_12m,
       weeks_of_cover,
       momentum_pct
  from demand_coverage_by_type_v
 where has_inventory and has_purchase_history
   and units_12m >= 500
   and weeks_of_cover is not null
   and weeks_of_cover < {{cover_weeks}}
 order by weeks_of_cover asc
$q$],
 'company',
 '{"product_type":{"semantic":"category","label":"Product Type"},
   "units_on_hand":{"semantic":"count","label":"On Hand"},
   "units_on_order":{"semantic":"count","label":"On Order"},
   "units_per_week_12m":{"semantic":"number","label":"Units Per Week (12m)"},
   "weeks_of_cover":{"semantic":"number","label":"Weeks Of Cover"},
   "momentum_pct":{"semantic":"percent","label":"Momentum"}}'::jsonb,
 '[{"key":"cover_weeks","type":"number","label":"Cover under (weeks)","default":26}]'::jsonb),

-- ── 7. Overstocked and slowing ──────────────────────────────────────
('c1000000-0000-4000-a000-000000000007','system',null,null,
 'Logistics · Overstocked and slowing',
 'Merchandise types carrying more than a year of cover while demand is falling.',
 null,null,
 array[$q$
select product_type,
       units_on_hand,
       units_on_order,
       weeks_of_cover,
       momentum_pct,
       units_per_week_12m
  from demand_coverage_by_type_v
 where has_inventory and has_purchase_history
   and units_12m >= 500
   and weeks_of_cover >= 52
   and momentum_pct < 0
 order by weeks_of_cover desc
$q$],
 'company',
 '{"product_type":{"semantic":"category","label":"Product Type"},
   "units_on_hand":{"semantic":"count","label":"On Hand"},
   "units_on_order":{"semantic":"count","label":"On Order"},
   "weeks_of_cover":{"semantic":"number","label":"Weeks Of Cover"},
   "momentum_pct":{"semantic":"percent","label":"Momentum"},
   "units_per_week_12m":{"semantic":"number","label":"Units Per Week (12m)"}}'::jsonb,
 null),

-- ── 8. Dead stock, velocity-VERIFIED only ───────────────────────────
-- The velocity_matched filter is not optional. 26,966 of 66,659 workboard
-- rows carry velocity_matched = false, where every qty column is a
-- coalesce(...,0) artefact meaning "unknown", not "none". Ranking dead
-- stock without this filter is exactly the bug that put Shopify's #2 and
-- #4 best sellers on a dead-stock list for an exec.
('c1000000-0000-4000-a000-000000000008','system',null,null,
 'Logistics · Dead stock (velocity-verified)',
 'Stocked products with no units sold in 30 days. Only rows whose sales velocity actually matched.',
 null,null,
 array[$q$
select product_title,
       product_type,
       sum(total_available_quantity)                as on_hand,
       round(sum(total_available_inventory_value))  as value_at_retail,
       max(last_sold_date)                          as last_sold
  from inventory_workboard_v
 where velocity_matched
   and total_available_quantity > 0
   and product_type is not null
   and product_type not in ('Package Protection','Bundles & Multi-Packs','Uncategorized','custom_sale')
 group by 1, 2
having sum(sold_30) = 0
   and sum(total_available_quantity) >= {{min_units}}
 order by 4 desc nulls last
$q$],
 'company',
 '{"product_title":{"semantic":"category","label":"Product"},
   "product_type":{"semantic":"category","label":"Product Type"},
   "on_hand":{"semantic":"count","label":"On Hand"},
   "value_at_retail":{"semantic":"currency","label":"Value At Retail"},
   "last_sold":{"semantic":"date","label":"Last Sold"}}'::jsonb,
 '[{"key":"min_units","type":"number","label":"At least (units on hand)","default":200}]'::jsonb),

-- ── 9. Sell-through by product type ─────────────────────────────────
('c1000000-0000-4000-a000-000000000009','system',null,null,
 'Logistics · Sell-through by product type',
 'Units sold in the last 3 months against units still on hand.',
 null,null,
 array[$q$
select product_type,
       units_3m                as units_sold_3m,
       units_on_hand,
       round(units_3m / nullif(units_3m + units_on_hand, 0) * 100, 1) as sell_through_pct
  from demand_coverage_by_type_v
 where has_inventory and has_purchase_history
   and units_12m >= 500
 order by units_3m desc nulls last
$q$],
 'company',
 '{"product_type":{"semantic":"category","label":"Product Type"},
   "units_sold_3m":{"semantic":"count","label":"Units Sold (3m)"},
   "units_on_hand":{"semantic":"count","label":"On Hand"},
   "sell_through_pct":{"semantic":"percent","label":"Sell-Through"}}'::jsonb,
 null),

-- ── 10. What is actually moving ─────────────────────────────────────
-- 'x-redo' is Package Protection, the Redo checkout line item, not
-- merchandise -- it outsells real products and would take the top row.
('c1000000-0000-4000-a000-00000000000a','system',null,null,
 'Logistics · Top products by units sold',
 'Best-selling products over the chosen window, by units.',
 null,null,
 array[$q$
select product_title,
       product_type,
       sum(units_sold) as units_sold,
       sum(net_sales)  as net_sales,
       count(distinct day_date) as days_with_sales
  from sales_by_product_title_daily_v
 where day_date >= {{date_from}}
   and product_title is not null
   and product_title <> 'x-redo'
 group by 1, 2
 order by 3 desc
$q$],
 'company',
 '{"product_title":{"semantic":"category","label":"Product"},
   "product_type":{"semantic":"category","label":"Product Type"},
   "units_sold":{"semantic":"count","label":"Units Sold"},
   "net_sales":{"semantic":"currency","label":"Net Sales"},
   "days_with_sales":{"semantic":"count","label":"Days With Sales"}}'::jsonb,
 '[{"key":"date_from","type":"date","label":"Since","default":"today-29d"}]'::jsonb)

on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, columns_metadata = excluded.columns_metadata,
  parameters = excluded.parameters, updated_at = now();
