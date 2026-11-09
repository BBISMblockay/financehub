-- Klaviyo email and SMS as SILO reports.
--
-- Blake, 2026-11-09: "it should slide into similar kpis and reporting as SMS
-- Email REDO, id assume? reporting wise?" -- yes, and these are built from the
-- Redo pair's verified definitions (20260925140000) so the columns, the rate
-- rules and the warnings read the same. They read the security_invoker views,
-- so they scope per tenant like every other system report, and rates are
-- percentages (x100) like every other SILO report.
--
-- PER VENDOR, NOT MERGED, and that is the whole design decision. Redo credits
-- revenue by its own rules; Klaviyo attributes against the account's chosen
-- conversion metric. The two measure different things over different windows,
-- so one combined "Email & SMS" report would silently sum two vendors'
-- attribution for any company running both, and double count the same orders.
-- A company that runs both sees two sets of reports, each honest about its
-- source. A cross-vendor rollup is a separate decision, not a default.
--
-- THE ONE THING KLAVIYO CANNOT DO, and why there are three reports rather than
-- Redo's two: Klaviyo has no campaign-SERIES endpoint. A campaign exists only
-- as a TOTAL over a measurement window (klaviyo_message_performance, keyed by
-- the window's own bounds); only flows have a daily grain
-- (klaviyo_flow_daily). So:
--
--   * Performance shows each message's widest stored window, with the bounds
--     as columns. Rows from different windows are different measurements of
--     the same sends and must never be summed -- which is exactly what a
--     free date range over that table would invite, so the report picks ONE
--     window per message instead of aggregating.
--   * The daily trend is FLOWS ONLY, and says so in its title. A campaign
--     cannot appear in it, because Klaviyo will not report a campaign by day.
--   * Email vs SMS splits the same one-window-per-message pick, so its totals
--     agree with Performance by construction (a tie-out asserts it).
--
-- THE CONVERSION METRIC IS PART OF THE GRAIN, not a detail. Klaviyo measures
-- conversions and attributed revenue against ONE metric the account chooses,
-- and changing it does not restate what SILO already stored: the performance
-- sweep is scoped to a window, so a year-long measurement made under the old
-- metric survives a switch while the next nightly writes a 60-day one under
-- the new. Those are counts of DIFFERENT EVENTS. So every report carries
-- conversion_metric_id in its grain and as a column: a message measured under
-- two metrics is two labelled rows, never one picked arbitrarily and never two
-- summed. Dropping the older metric's measurement instead would be worse --
-- a campaign's best measurement would vanish with no explanation.
--
-- Every rate is a count over DELIVERED (Redo's rule, and Klaviyo's own
-- denominator), pooled inside the one window; opens are EMAIL-only, because
-- Klaviyo reports no opens for SMS and 0% would be a lie. A statistic Klaviyo
-- did not report is NULL and stays blank, never 0. `sending_cost` is Klaviyo's
-- SMS sending cost, not ad spend.
--
-- And the warning that matters most, in every description: Klaviyo's revenue
-- is ATTRIBUTED against the conversion metric. It overlaps Meta, Google and
-- TikTok's claims and Shopify net sales, and it is not incremental, so it must
-- never be added to any of them.
--
-- Idempotent: insert ... on conflict do update, like the Redo pair.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
('c9000000-0000-4000-a000-000000000001', null, 'system', 'company',
 'Email & SMS Performance (Klaviyo)',
 'Each Klaviyo campaign and flow message, as Klaviyo measured it: sends, delivery, opens, clicks, attributed orders and revenue. Klaviyo reports a campaign only as a TOTAL over a measurement window, never by day, so each message appears once, for the widest window SILO holds whose window ends in the period, and the Window columns say which. Rows from different windows are different measurements of the same sends and must never be added together. Revenue is attributed against the account''s conversion metric; it overlaps the ad platforms'' claims and Shopify net sales and is not incremental, so never add it to either. Klaviyo measures conversions against ONE metric the account chooses, and changing it does not restate what was already measured, so the metric is part of this report''s grain: a message measured under two metrics is two labelled rows, and they must never be added together. Rates are counts over delivered; opens are email-only, because Klaviyo reports none for SMS. A blank statistic is one Klaviyo did not report, not zero. Sending cost is Klaviyo''s SMS cost, not ad spend.',
 array[$q$with measured as (
  select distinct on (kind, klaviyo_id, channel, conversion_metric_id)
         kind, klaviyo_id, channel, conversion_metric_id, message_name, parent_name, status,
         (timeframe_start at time zone 'UTC')::date as window_from,
         (timeframe_end at time zone 'UTC')::date as window_through,
         ((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) + 1 as window_days,
         recipients, delivered, opens_unique, clicks_unique, conversions,
         conversion_value, unsubscribe_uniques, text_message_spend
    from klaviyo_message_performance_v
   where (timeframe_end at time zone 'UTC')::date between {{date_from}} and {{date_to}}
   order by kind, klaviyo_id, channel, conversion_metric_id,
            ((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) desc,
            timeframe_end desc
)
select kind,
       coalesce(message_name, klaviyo_id) as message,
       channel,
       conversion_metric_id,
       parent_name as flow,
       status,
       window_from,
       window_through,
       window_days,
       recipients as sends,
       delivered,
       round(100 * delivered::numeric / nullif(recipients, 0), 1) as delivery_rate,
       case when lower(channel) = 'email'
            then round(100 * opens_unique::numeric / nullif(delivered, 0), 1) end as open_rate,
       round(100 * clicks_unique::numeric / nullif(delivered, 0), 1) as click_rate,
       round(100 * conversions / nullif(delivered, 0), 2) as order_rate,
       unsubscribe_uniques as unsubscribes,
       conversions as attributed_orders,
       round(conversion_value, 2) as attributed_revenue,
       round(text_message_spend, 2) as sending_cost,
       klaviyo_id
  from measured
 order by attributed_revenue desc nulls last, klaviyo_id, channel, conversion_metric_id$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"kind":{"label":"Type","semantic":"category"},"message":{"label":"Campaign / flow message","semantic":"category","chart_dimension":true},"channel":{"label":"Channel","semantic":"category"},"conversion_metric_id":{"label":"Conversion Metric","semantic":"category"},"flow":{"label":"Flow","semantic":"category"},"status":{"label":"Status","semantic":"category"},"window_from":{"label":"Window From","semantic":"date"},"window_through":{"label":"Window Through","semantic":"date"},"window_days":{"label":"Window Days","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"delivery_rate":{"label":"Delivery Rate","semantic":"percent"},"open_rate":{"label":"Open Rate","semantic":"percent","blank_reason":"Klaviyo reports no opens for SMS, so an SMS row is blank rather than 0%."},"click_rate":{"label":"Click Rate","semantic":"percent"},"order_rate":{"label":"Order Rate","semantic":"percent"},"unsubscribes":{"label":"Unsubscribes","semantic":"count"},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"attributed_revenue":{"label":"Revenue Attributed by Klaviyo","semantic":"currency","chart_primary":true},"sending_cost":{"label":"SMS Sending Cost","semantic":"currency"},"klaviyo_id":{"label":"Klaviyo ID","semantic":"category"}}'::jsonb),
('c9000000-0000-4000-a000-000000000002', null, 'system', 'company',
 'Email & SMS Revenue Trend (Klaviyo flows)',
 'Revenue and orders Klaviyo attributes to FLOW messages, by day, with sends and SMS sending cost. Flows only, and not an oversight: Klaviyo has no campaign series endpoint, so a campaign cannot be reported by day at all and campaign revenue is missing from this trend by construction -- see Email & SMS Performance (Klaviyo) for campaigns. Revenue is attributed against the account''s conversion metric; it overlaps the ad platforms'' claims and Shopify net sales and is not incremental. A day measured under two conversion metrics is two labelled rows, because those are counts of different events. Attribution lands on the conversion day and keeps arriving, so the latest days are still rising. A missing day is no flow activity recorded, not a verified zero.',
 array[$q$select day_date,
       conversion_metric_id,
       round(sum(conversion_value), 2) as attributed_revenue,
       sum(conversions) as attributed_orders,
       sum(recipients) as sends,
       sum(delivered) as delivered,
       round(sum(text_message_spend), 2) as sending_cost
  from klaviyo_flow_daily_v
 where day_date between {{date_from}} and {{date_to}}
 group by day_date, conversion_metric_id
 order by day_date, conversion_metric_id$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"day_date":{"label":"Day","semantic":"date"},"conversion_metric_id":{"label":"Conversion Metric","semantic":"category"},"attributed_revenue":{"label":"Revenue Attributed by Klaviyo","semantic":"currency","chart_primary":true},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"sending_cost":{"label":"SMS Sending Cost","semantic":"currency"}}'::jsonb),
('c9000000-0000-4000-a000-000000000003', null, 'system', 'company',
 'Email vs SMS (Klaviyo)',
 'Klaviyo email against Klaviyo SMS over the period: how many messages, sends, delivery, attributed orders and revenue, and what the SMS actually cost to send. Built from the same one-window-per-message measurements as Email & SMS Performance (Klaviyo), so the two reports agree; a tie-out checks that they do. Split by conversion metric as well as channel, because a metric change makes two measurements of different events that must never be summed. Revenue is attributed against the account''s conversion metric, overlaps the ad platforms'' claims and Shopify net sales, and is not incremental. SMS sending cost is Klaviyo''s own charge for sending, not ad spend, so cost per order here is a delivery cost and not a CAC.',
 array[$q$with measured as (
  select distinct on (kind, klaviyo_id, channel, conversion_metric_id)
         kind, klaviyo_id, channel, conversion_metric_id,
         recipients, delivered, clicks_unique, conversions,
         conversion_value, unsubscribe_uniques, text_message_spend
    from klaviyo_message_performance_v
   where (timeframe_end at time zone 'UTC')::date between {{date_from}} and {{date_to}}
   order by kind, klaviyo_id, channel, conversion_metric_id,
            ((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) desc,
            timeframe_end desc
)
select case when lower(channel) = 'email' then 'Email'
            when lower(channel) = 'sms' then 'SMS'
            else coalesce(nullif(channel, ''), 'Unknown') end as channel,
       conversion_metric_id,
       count(*) as messages,
       sum(recipients) as sends,
       sum(delivered) as delivered,
       round(100 * sum(delivered)::numeric / nullif(sum(recipients), 0), 1) as delivery_rate,
       round(100 * sum(clicks_unique)::numeric / nullif(sum(delivered), 0), 1) as click_rate,
       sum(unsubscribe_uniques) as unsubscribes,
       sum(conversions) as attributed_orders,
       round(sum(conversion_value), 2) as attributed_revenue,
       round(sum(text_message_spend), 2) as sending_cost
  from measured
 group by 1, conversion_metric_id
 order by attributed_revenue desc nulls last, channel, conversion_metric_id$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
 '{"channel":{"label":"Channel","semantic":"category","chart_dimension":true},"conversion_metric_id":{"label":"Conversion Metric","semantic":"category"},"messages":{"label":"Messages","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"delivery_rate":{"label":"Delivery Rate","semantic":"percent"},"click_rate":{"label":"Click Rate","semantic":"percent"},"unsubscribes":{"label":"Unsubscribes","semantic":"count"},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"attributed_revenue":{"label":"Revenue Attributed by Klaviyo","semantic":"currency","chart_primary":true},"sending_cost":{"label":"SMS Sending Cost","semantic":"currency"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- ── Tie-outs ───────────────────────────────────────────────────────────────
-- Each runs the DEPLOYED default SQL and compares it with a second route to
-- the same number. The md5 guard makes a later edit to a report read NO DATA
-- until its check is refreshed, rather than silently checking the old shape
-- (the 20260920075344 convention).
delete from public.silo_report_tieouts
 where report_id in ('c9000000-0000-4000-a000-000000000001',
                     'c9000000-0000-4000-a000-000000000002',
                     'c9000000-0000-4000-a000-000000000003');

do $checks$
declare
  perf_sql text;
  trend_sql text;
  split_sql text;
  perf_guard text;
  trend_guard text;
  split_guard text;
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
begin
  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into perf_sql, perf_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000001';

  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into trend_sql, trend_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000002';

  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into split_sql, split_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000003';

  -- 1. Performance must hold each message once. Summing two windows of the
  -- same sends is the one failure this report is shaped to prevent, and a row
  -- count against the base table's distinct messages is a different route to
  -- it than the query's own DISTINCT ON.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000001',
    'One row per message, channel and metric, never one per window', 'sanity',
    format('with report as materialized (%s) select case when %s then count(*) end as left_value, '
        || '(select count(*) from (select distinct kind, klaviyo_id, channel, conversion_metric_id from public.klaviyo_message_performance '
        || 'where company_entity_id = (select public.active_company_id()) '
        || 'and (timeframe_end at time zone ''UTC'')::date between %s and %s) d) as right_value from report',
      perf_sql, perf_guard, from_sql, to_sql),
    0,
    'Uses deployed default SQL. Exact: one row per message, channel and conversion metric, whatever windows are stored. Above the right value means windows were summed, which double counts the same sends. NO DATA can mean no Klaviyo measurement in the period or a changed definition; never a certification of completeness.');

  -- 1b. Performance needs a NUMERIC reconciliation of its own, not only the
  -- row count: a wrong money value with the row count unchanged would pass
  -- the check above, and verify_v2_schema reports any system report with no
  -- enabled reconciliation as WEAK. The second route reaches the same total a
  -- different way -- the BASE tables with a window function, where the report
  -- uses the view with DISTINCT ON. The join to klaviyo_messages is not
  -- decoration: the view coalesces an empty performance channel to the
  -- message's, so partitioning on the raw column would split one group in two
  -- and raise a false alarm.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000001',
    'Attributed revenue agrees with the base tables, ranked a different way', 'reconciliation',
    format('with report as materialized (%s) select case when %s then sum(attributed_revenue) end as left_value, '
        || '(select round(sum(conversion_value), 2) from ('
        || 'select p.conversion_value, row_number() over ('
        || 'partition by p.kind, p.klaviyo_id, coalesce(nullif(p.channel, ''''), m.channel), p.conversion_metric_id '
        || 'order by (p.timeframe_end at time zone ''UTC'')::date - (p.timeframe_start at time zone ''UTC'')::date desc, '
        || 'p.timeframe_end desc) as rn '
        || 'from public.klaviyo_message_performance p '
        || 'left join public.klaviyo_messages m on m.company_entity_id = p.company_entity_id '
        || 'and m.kind = p.kind and m.klaviyo_id = p.klaviyo_id '
        || 'where p.company_entity_id = (select public.active_company_id()) '
        || 'and (p.timeframe_end at time zone ''UTC'')::date between %s and %s) ranked '
        || 'where rn = 1) as right_value from report',
      perf_sql, perf_guard, from_sql, to_sql),
    1.00,
    'Uses deployed default SQL. The report rounds each message to the cent, so a board of many messages can drift by cents in total; $1 allows that and still catches a message dropped, duplicated or measured under the wrong window. NO DATA can mean no Klaviyo measurement in the period or a changed definition; never a certification of completeness.');

  -- 2. Flow revenue against the base table rather than the view it reads.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000002',
    'Attributed flow revenue agrees with the Klaviyo base table', 'reconciliation',
    format('with report as materialized (%s) select case when %s then sum(attributed_revenue) end as left_value, '
        || '(select round(sum(conversion_value), 2) from public.klaviyo_flow_daily '
        || 'where company_entity_id = (select public.active_company_id()) '
        || 'and day_date between %s and %s) as right_value from report',
      trend_sql, trend_guard, from_sql, to_sql),
    1.00,
    'Uses deployed default SQL. Each day is rounded to the cent, so a long period can drift by cents in total; $1 allows that and still catches a missing day. Flows only, by design -- Klaviyo cannot report a campaign by day. NO DATA can mean no flow activity or a changed definition; never a certification of completeness.');

  -- 3. The channel split must add up to the message list. Two reports built
  -- from the same pick that disagree would mean one of them changed.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000003',
    'Channel totals add up to Email & SMS Performance', 'reconciliation',
    format('with split as materialized (%s), perf as materialized (%s) '
        || 'select case when %s and %s then (select sum(attributed_revenue) from split) end as left_value, '
        || '(select sum(attributed_revenue) from perf) as right_value',
      split_sql, perf_sql, split_guard, perf_guard),
    1.00,
    'Uses both reports'' deployed default SQL. The split rounds once per channel and the message list once per message, so a board of many messages can drift by cents; $1 allows that and still catches a channel dropped or counted twice. NO DATA can mean no Klaviyo measurement in the period or a changed definition in either report.');
end $checks$;
