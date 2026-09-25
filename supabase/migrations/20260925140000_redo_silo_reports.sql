-- Email & SMS (Redo) as SILO reports, and a reason on blank cover.
--
-- ── 1. Two SILO reports over the Redo marketing mirror ─────────────────────
-- redo_marketing_* (20260924120000) was in Ask SILO's catalog and on one
-- company's hand-built board, but in no SILO report. These two are built from
-- that board's verified definitions (Redo's own rules: every rate is a count
-- over DELIVERED; open and click-to-open are email-only), read the
-- security_invoker view, and so scope themselves per tenant like every other
-- global report. Rates are percentages (x100), matching the other SILO
-- reports' percent columns.
-- Performance's chart ranks the top 10 messages by credited revenue
-- (chart_dimension/chart_primary, read by v3/js/report-preview.js); without
-- them it grouped 132 messages into two bars, campaign and automation.
--
-- The one thing they must not do is let Redo's revenue read as sales: it is
-- revenue Redo CREDITS to its messages, overlaps the ad platforms' own
-- claims, and is not incremental. Every description says so.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
('c3000000-0000-4000-a000-000000000008', null, 'system', 'company',
 'Email & SMS Performance',
 'Each Redo email and SMS campaign and automation over the period: sends, delivery, opens, clicks, attributed orders and revenue. Revenue is credited by Redo to email and SMS; it may overlap other channels'' attribution and is not incremental sales, so never add it to ad-platform claims or net sales. Rates are counts over delivered messages; opens are email-only. Engagement and orders can land days after a send.',
 array[$q$select kind, coalesce(name, redo_id) as message, channel,
       sum(sends) as sends,
       sum(delivered) as delivered,
       round(100 * sum(delivered)::numeric / nullif(sum(sends), 0), 1) as delivery_rate,
       case when channel = 'EMAIL' then round(100 * sum(unique_opens)::numeric / nullif(sum(delivered), 0), 1) end as open_rate,
       round(100 * sum(unique_clicks)::numeric / nullif(sum(delivered), 0), 1) as click_rate,
       round(100 * sum(orders)::numeric / nullif(sum(delivered), 0), 2) as order_rate,
       sum(unsubscribes) as unsubscribes,
       sum(orders) as attributed_orders,
       round(sum(revenue), 2) as attributed_revenue,
       round(sum(spend), 2) as sending_cost,
       revenue_currency, redo_id
  from redo_marketing_daily_v
 where day_date between {{date_from}} and {{date_to}}
 group by kind, coalesce(name, redo_id), channel, revenue_currency, redo_id
 order by attributed_revenue desc nulls last, redo_id, channel$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"kind":{"label":"Type","semantic":"category"},"message":{"label":"Campaign / automation","semantic":"category","chart_dimension":true},"channel":{"label":"Channel","semantic":"category"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"delivery_rate":{"label":"Delivery Rate","semantic":"percent"},"open_rate":{"label":"Open Rate","semantic":"percent"},"click_rate":{"label":"Click Rate","semantic":"percent"},"order_rate":{"label":"Order Rate","semantic":"percent"},"unsubscribes":{"label":"Unsubscribes","semantic":"count"},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"attributed_revenue":{"label":"Revenue Credited by Redo","semantic":"currency","chart_primary":true},"sending_cost":{"label":"Sending Cost","semantic":"currency"},"revenue_currency":{"label":"Currency","semantic":"category"},"redo_id":{"label":"Redo ID","semantic":"category"}}'::jsonb),
('c3000000-0000-4000-a000-000000000009', null, 'system', 'company',
 'Email & SMS Revenue Trend',
 'Revenue and orders Redo credits to email and SMS, by company-calendar day, with sends and sending cost. Credited revenue may overlap other channels'' attribution and is not incremental sales. It lands on the order day and keeps arriving for weeks, so the latest days are still rising. A missing day is no Redo activity recorded, not verified zero.',
 array[$q$select day_date,
       round(sum(revenue), 2) as attributed_revenue,
       sum(orders) as attributed_orders,
       sum(sends) as sends,
       round(sum(spend), 2) as sending_cost,
       revenue_currency
  from redo_marketing_daily_v
 where day_date between {{date_from}} and {{date_to}}
 group by day_date, revenue_currency
 order by day_date, revenue_currency$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"day_date":{"label":"Day","semantic":"date"},"attributed_revenue":{"label":"Revenue Credited by Redo","semantic":"currency","chart_primary":true},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"sending_cost":{"label":"Sending Cost","semantic":"currency"},"revenue_currency":{"label":"Currency","semantic":"category"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- Tie-outs: the report, run with its own defaults, against the BASE table
-- rather than the view it reads -- a second route to the same total. The md5
-- guard makes a later edit to either report read NO DATA until its check is
-- refreshed (the 20260920075344 convention).
delete from public.silo_report_tieouts
 where report_id in ('c3000000-0000-4000-a000-000000000008', 'c3000000-0000-4000-a000-000000000009');

do $checks$
declare
  r record;
  q text;
  guard text;
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
begin
  for r in select * from public.silo_chat_saved_reports
            where id in ('c3000000-0000-4000-a000-000000000008', 'c3000000-0000-4000-a000-000000000009') loop
    q := replace(replace(r.queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql);
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);
    insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
    values (r.id, 'Credited revenue agrees with the Redo base table', 'reconciliation',
      format('with report as materialized (%s) select case when %s then sum(attributed_revenue) end as left_value, '
          || '(select round(sum(revenue), 2) from public.redo_marketing_daily where company_entity_id = (select public.active_company_id()) '
          || 'and day_date between %s and %s) as right_value from report',
        q, guard, from_sql, to_sql),
      1.00,
      'Uses deployed default SQL. Each row is rounded to the cent, so a board of many messages can drift by cents in total; $1 allows that and still catches a missing message. NO DATA can mean no Redo activity or a changed definition; never a certification of completeness.');
  end loop;
end $checks$;

-- ── 2. Blank cover says why ────────────────────────────────────────────────
-- Inventory Summary leaves weeks of cover blank when any stocked product type
-- has no sales in the last 12 months: cover cannot be computed honestly for
-- the whole, and 0 or infinity would both be wrong. The KPI read "No value"
-- with no explanation; the renderer now shows columns_metadata[col].blank_reason.
update public.silo_chat_saved_reports
   set columns_metadata = columns_metadata
     || jsonb_build_object('weeks_of_cover', coalesce(columns_metadata->'weeks_of_cover', '{}'::jsonb)
          || '{"blank_reason":"Blank while any product type with stock or orders has no sales in the last 12 months, so total cover cannot be computed. See Stock Cover for each type."}'::jsonb)
     || jsonb_build_object('weeks_on_hand', coalesce(columns_metadata->'weeks_on_hand', '{}'::jsonb)
          || '{"blank_reason":"Blank while any product type with stock has no sales in the last 12 months, so total cover cannot be computed. See Stock Cover for each type."}'::jsonb)
 where id = 'c1000000-0000-4000-a000-000000000001';
