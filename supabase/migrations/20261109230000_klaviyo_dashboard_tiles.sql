-- Klaviyo on the Marketing dashboard, the way Redo streams in: a KPI row, the
-- daily trend and the message table, plus the one-row totals report the KPI
-- tiles need (20261109210000 gave Klaviyo per-message, per-day and per-channel
-- reports; none of them returns a single row, and a KPI card must show one
-- number).
--
-- WHY THE TOTALS REPORT IS SHAPED THE WAY IT IS. A KPI tile rolls its report's
-- rows up (chart-adapter kpiHtml -> SiloMetrics.aggregate, sum by default), and
-- Klaviyo measurements are NOT summable across conversion metrics: two metrics
-- are counts of different events, and each metric's widest-window pick can be a
-- different window, so even the sends differ. Summing them would double count
-- and averaging the rates would be wrong.
--
-- So query 0 returns ONE row -- the most recently measured conversion metric,
-- by the newest window end, a stated rule rather than an arbitrary pick -- and
-- carries metrics_in_period beside it, so a board showing one metric's numbers
-- says out loud when there is another. Query 1 is one row per metric, which is
-- what the by-metric tile shows: normally a single line, and two when the
-- account changed metric inside the period, which is exactly when a reader
-- needs to see both rather than one.
--
-- Data only. No deploy. Needs 20261109210000 (the three reports the tiles read)
-- and 20260925193000 (the Marketing dashboard the tiles are added to).

insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
('c9000000-0000-4000-a000-000000000004', null, 'system', 'company',
 'Email & SMS Totals (Klaviyo)',
 'One line of Klaviyo totals for the period, for KPI tiles: messages, sends, delivery, attributed orders and revenue, and SMS sending cost. Built from the same one-window-per-message measurements as Email & SMS Performance (Klaviyo), so the numbers agree with it. Klaviyo measures conversions against ONE metric the account chooses, and measurements under two metrics are counts of DIFFERENT events that must never be added, so the first result is the most recently measured metric alone -- the newest window end -- with Metrics In Period beside it to say whether there is another. The second result is one row per metric, which is the honest total when there is more than one. Revenue is attributed by Klaviyo against that metric; it overlaps the ad platforms'' claims and Shopify net sales and is not incremental, so never add it to either. Rates are counts over delivered. A blank statistic is one Klaviyo did not report, not zero.',
 array[$q$with measured as (
  select distinct on (kind, klaviyo_id, channel, conversion_metric_id)
         kind, klaviyo_id, channel, conversion_metric_id,
         (timeframe_end at time zone 'UTC')::date as window_through,
         recipients, delivered, clicks_unique, conversions,
         conversion_value, unsubscribe_uniques, text_message_spend
    from klaviyo_message_performance_v
   where (timeframe_end at time zone 'UTC')::date between {{date_from}} and {{date_to}}
   order by kind, klaviyo_id, channel, conversion_metric_id,
            ((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) desc,
            timeframe_end desc
), latest as (
  select conversion_metric_id
    from measured
   group by conversion_metric_id
   order by max(window_through) desc, conversion_metric_id
   limit 1
)
select m.conversion_metric_id,
       (select count(distinct conversion_metric_id) from measured) as metrics_in_period,
       count(*) as messages,
       sum(m.recipients) as sends,
       sum(m.delivered) as delivered,
       round(100 * sum(m.delivered)::numeric / nullif(sum(m.recipients), 0), 1) as delivery_rate,
       round(100 * sum(m.clicks_unique)::numeric / nullif(sum(m.delivered), 0), 1) as click_rate,
       sum(m.unsubscribe_uniques) as unsubscribes,
       sum(m.conversions) as attributed_orders,
       round(sum(m.conversion_value), 2) as attributed_revenue,
       round(sum(m.text_message_spend), 2) as sending_cost
  from measured m
  join latest l on l.conversion_metric_id = m.conversion_metric_id
 group by m.conversion_metric_id$q$,
$q$with measured as (
  select distinct on (kind, klaviyo_id, channel, conversion_metric_id)
         kind, klaviyo_id, channel, conversion_metric_id,
         (timeframe_end at time zone 'UTC')::date as window_through,
         recipients, delivered, clicks_unique, conversions,
         conversion_value, unsubscribe_uniques, text_message_spend
    from klaviyo_message_performance_v
   where (timeframe_end at time zone 'UTC')::date between {{date_from}} and {{date_to}}
   order by kind, klaviyo_id, channel, conversion_metric_id,
            ((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) desc,
            timeframe_end desc
)
select conversion_metric_id,
       max(window_through) as measured_through,
       count(*) as messages,
       sum(recipients) as sends,
       sum(delivered) as delivered,
       sum(conversions) as attributed_orders,
       round(sum(conversion_value), 2) as attributed_revenue,
       round(sum(text_message_spend), 2) as sending_cost
  from measured
 group by conversion_metric_id
 order by max(window_through) desc, conversion_metric_id$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"conversion_metric_id":{"label":"Conversion Metric","semantic":"category"},"metrics_in_period":{"label":"Metrics In Period","semantic":"count"},"measured_through":{"label":"Measured Through","semantic":"date"},"messages":{"label":"Messages","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"delivery_rate":{"label":"Delivery Rate","semantic":"percent"},"click_rate":{"label":"Click Rate","semantic":"percent"},"unsubscribes":{"label":"Unsubscribes","semantic":"count"},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"attributed_revenue":{"label":"Revenue Attributed by Klaviyo","semantic":"currency","chart_primary":true},"sending_cost":{"label":"SMS Sending Cost","semantic":"currency"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- ── Tie-outs for the totals report ─────────────────────────────────────────
-- Same convention as 20261109210000: run the DEPLOYED default SQL and reach
-- the number a second way, behind an md5 guard so an edit reads NO DATA
-- instead of silently checking the old shape.
delete from public.silo_report_tieouts
 where report_id = 'c9000000-0000-4000-a000-000000000004';

do $checks$
declare
  totals_sql text;
  by_metric_sql text;
  totals_guard text;
  perf_sql text;
  perf_guard text;
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
begin
  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         replace(replace(queries_run[2], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into totals_sql, by_metric_sql, totals_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000004';

  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into perf_sql, perf_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000001';

  -- 1. The KPI query must return EXACTLY ONE ROW whenever there is anything to
  -- measure, and none when there is not. A KPI tile sums its rows, so a second
  -- row here would silently add two conversion metrics together on the card --
  -- the one failure this report's shape exists to prevent.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000004',
    'The KPI query returns one row, or none when nothing was measured', 'sanity',
    format('with report as materialized (%s) select case when %s then count(*) end as left_value, '
        || '(select case when exists (select 1 from public.klaviyo_message_performance '
        || 'where company_entity_id = (select public.active_company_id()) '
        || 'and (timeframe_end at time zone ''UTC'')::date between %s and %s) then 1 else 0 end) as right_value '
        || 'from report',
      totals_sql, totals_guard, from_sql, to_sql),
    0,
    'Uses deployed default SQL. Exact: one row when Klaviyo measured anything whose window ends in the period, none when it did not. Above one means a second conversion metric reached the KPI tiles, which would add counts of different events on one card. NO DATA can mean no Klaviyo measurement in the period or a changed definition; never a certification of completeness.');

  -- 2. The per-metric result must add up to the message list, which is the
  -- same assertion the channel split carries: two reports built from the same
  -- pick that disagree mean one of them changed.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000004',
    'Totals by conversion metric add up to Email & SMS Performance', 'reconciliation',
    format('with by_metric as materialized (%s), perf as materialized (%s) '
        || 'select case when %s and %s then (select sum(attributed_revenue) from by_metric) end as left_value, '
        || '(select sum(attributed_revenue) from perf) as right_value',
      by_metric_sql, perf_sql, totals_guard, perf_guard),
    1.00,
    'Uses both reports'' deployed default SQL. Each rounds to the cent at a different grain, so a board of many messages can drift by cents; $1 allows that and still catches a metric or a message dropped. Compares the SECOND result, by conversion metric, because that one covers every metric; the KPI row deliberately covers only the latest. NO DATA can mean no Klaviyo measurement in the period or a changed definition in either report.');
end $checks$;

-- ── Marketing dashboard tiles ──────────────────────────────────────────────
-- Appended BELOW the existing sections (y 24 and down), so no tile that is
-- already on the board moves. Redo's section keeps its place and gains the
-- vendor in its title, because with two vendors on one board "Email and SMS"
-- no longer says whose numbers a reader is looking at.
update public.dashboard_widgets
   set title = 'Email and SMS (Redo)'
 where id = 'd0000000-0000-4000-a00c-000000000007'
   and title = 'Email and SMS';

insert into public.dashboard_widgets
  (id, dashboard_id, company_entity_id, created_by, report_id, query_index, title, visual_type, visual_config, layout, sort_order)
values
('d0000000-0000-4000-a00c-00000000000d','5110da5b-0000-4000-a000-000000000012',null,null,null,0,
 'Email and SMS (Klaviyo)','section',
 '{"note":"Klaviyo attributes this revenue against the account''s own conversion metric. It overlaps the ad platforms'' claims, Shopify net sales and Redo''s attribution, so it is never added to any of them -- a company running Redo and Klaviyo has two vendors claiming the same orders. The KPI row covers the most recently measured conversion metric; By conversion metric below says whether there was another."}'::jsonb,
 '{"x":0,"y":24,"w":12,"h":1}'::jsonb, 12),
('d0000000-0000-4000-a00c-00000000000e','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000004',0,
 'Klaviyo sends','kpi','{"y_field":"sends","abbreviate":true,"empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":0,"y":25,"w":3,"h":2}'::jsonb, 13),
('d0000000-0000-4000-a00c-00000000000f','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000004',0,
 'Klaviyo-attributed revenue','kpi','{"y_field":"attributed_revenue","empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":3,"y":25,"w":3,"h":2}'::jsonb, 14),
('d0000000-0000-4000-a00c-000000000010','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000004',0,
 'Klaviyo-attributed orders','kpi','{"y_field":"attributed_orders","empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":6,"y":25,"w":3,"h":2}'::jsonb, 15),
('d0000000-0000-4000-a00c-000000000011','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000004',0,
 'Klaviyo delivery rate','kpi','{"y_field":"delivery_rate","empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":9,"y":25,"w":3,"h":2}'::jsonb, 16),
('d0000000-0000-4000-a00c-000000000012','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000002',0,
 'Klaviyo flow revenue by day','line',
 '{"x_field":"day_date","y_field":"attributed_revenue","sort":"x_asc","limit":0,"empty_message":"No Klaviyo flow days in this window. Flows only -- Klaviyo cannot report a campaign by day."}'::jsonb,
 '{"x":0,"y":27,"w":7,"h":4}'::jsonb, 17),
('d0000000-0000-4000-a00c-000000000013','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000001',0,
 'Klaviyo email and SMS by message','table',
 '{"limit":15,"columns":["message","channel","conversion_metric_id","window_days","sends","attributed_orders","attributed_revenue"],"empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":7,"y":27,"w":5,"h":4}'::jsonb, 18),
('d0000000-0000-4000-a00c-000000000014','5110da5b-0000-4000-a000-000000000012',null,null,'c9000000-0000-4000-a000-000000000004',1,
 'Klaviyo by conversion metric','table',
 '{"columns":["conversion_metric_id","measured_through","messages","sends","attributed_orders","attributed_revenue"],"empty_message":"No Klaviyo measurements in this window. Connect Klaviyo or widen the dates."}'::jsonb,
 '{"x":0,"y":31,"w":12,"h":3}'::jsonb, 19)
on conflict (id) do update set
  dashboard_id = excluded.dashboard_id, company_entity_id = null, created_by = null,
  report_id = excluded.report_id, query_index = excluded.query_index, title = excluded.title,
  visual_type = excluded.visual_type, visual_config = excluded.visual_config,
  layout = excluded.layout, sort_order = excluded.sort_order;
