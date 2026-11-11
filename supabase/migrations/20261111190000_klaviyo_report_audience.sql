-- The audience a Klaviyo campaign went to, on the report that already exists.
--
-- Blake, 2026-11-11: "Wouldn't just add to the current report and tiles" --
-- so this adds columns to "Email & SMS Performance (Klaviyo)"
-- (c9000000-...-001) and to its Marketing-board tile, rather than standing up
-- a fifth Klaviyo report. A list-and-segment inventory on its own would be
-- names and dates: Klaviyo exposes no profile count on those endpoints, so
-- there is no size to report. What is worth reporting is WHICH audience each
-- measured campaign was sent to, beside its sends and its attributed revenue
-- -- the question the audience sync (20261110010000) was built to answer and
-- that nothing has asked since.
--
-- Three pieces, in this order, because each needs the one before it:
--
--   1. klaviyo_message_performance_v gains the audience columns. The view
--      already joins klaviyo_messages but stopped short of `audiences`, so the
--      report could not see it at all.
--   2. The report selects two of them.
--   3. The report's two tie-outs are REGENERATED. They pin an md5 of the
--      report's SQL, so editing the report without re-deriving them turns the
--      nightly run STALE -- which is the whole point of the pin, and the
--      reason this is one migration and not two.
--
-- Generic: nothing here names a company, a list or a Klaviyo account. A
-- company with no Klaviyo sees the same empty report it sees today.
--
-- Additive and idempotent: no column changes type, no row is deleted but the
-- two tie-outs this file rewrites, and re-running it is a no-op.

-- ── 1. The view learns the audience ────────────────────────────────────────
-- `create or replace view` keeps the existing grants and reloptions, and the
-- four new columns are APPENDED, so every existing reader keeps its column
-- positions. security_invoker stays true -- restated rather than assumed,
-- because a replace that omitted it would silently turn the view into a
-- definer one and verify_v2_schema would (rightly) call that CRITICAL.
--
-- Resolution rules, all three of them load-bearing:
--
--   * An id is resolved against klaviyo_audiences ON ID ALONE, regardless of
--     kind. Klaviyo calls a campaign's audience entries "group ids" and does
--     not say whether each is a list or a segment (20261110010000), so
--     matching on kind as well would drop half the names.
--   * An id that resolves to NOTHING shows as the RAW ID, never as blank. The
--     lists/segments read needs its own scopes and can be refused for a
--     connection granted before SILO asked for them -- the sync records that
--     as audiences_skipped and leaves the table empty. A blank audience would
--     then read as "sent to nobody"; the id reads as "SILO has no name for
--     this", which is what happened.
--   * NULL means Klaviyo reported no audience: a flow message, which has none,
--     or a campaign whose message could not be tied to one audience without
--     guessing. NULL is never "sent to nobody".
--
-- A SCALAR subquery, not a join, so the row count cannot change. That is not
-- a style choice: this report's shape rule is one row per message, channel and
-- conversion metric, a join to a multi-id audience would fan each row out into
-- several, and the sanity tie-out below would catch it -- after the numbers on
-- the tile had already doubled. The de-duplicating inner select matters for
-- the same reason: a list and a segment may share an id, so an id can match
-- two klaviyo_audiences rows and name itself twice.
create or replace view public.klaviyo_message_performance_v
with (security_invoker = true) as
select p.id,
    p.company_entity_id,
    p.connection_id,
    p.kind,
    p.klaviyo_id,
    coalesce(nullif(p.channel, ''::text), m.channel) as channel,
    m.name as message_name,
    m.subject,
    m.parent_id,
    m.parent_name,
    m.status,
    m.send_time,
    m.trigger_type,
    m.archived,
    p.timeframe_start,
    p.timeframe_end,
    p.conversion_metric_id,
    p.recipients,
    p.delivered,
    p.opens,
    p.opens_unique,
    p.clicks,
    p.clicks_unique,
    p.conversions,
    p.conversion_uniques,
    p.conversion_value,
    p.average_order_value,
    p.revenue_per_recipient,
    p.unsubscribes,
    p.unsubscribe_uniques,
    p.bounced,
    p.bounced_or_failed,
    p.failed,
    p.spam_complaints,
    p.text_message_spend,
    p.text_message_credit_usage_amount,
    p.message_segment_count_sum,
    p.metrics,
    p.source,
    p.synced_at,
    -- Klaviyo's own label for the campaign-audience object. Often null: the
    -- audience is usually identified by its lists, not by a name.
    m.audiences ->> 'name' as audience_name,
    (select string_agg(nm, ', ' order by nm)
       from (select distinct coalesce(a.name, g.gid) as nm
               from jsonb_array_elements_text(
                      case when jsonb_typeof(m.audiences -> 'included') = 'array'
                           then m.audiences -> 'included' else '[]'::jsonb end) as g(gid)
               left join public.klaviyo_audiences a
                      on a.company_entity_id = m.company_entity_id
                     and a.klaviyo_id = g.gid) u) as audience_included,
    (select string_agg(nm, ', ' order by nm)
       from (select distinct coalesce(a.name, g.gid) as nm
               from jsonb_array_elements_text(
                      case when jsonb_typeof(m.audiences -> 'excluded') = 'array'
                           then m.audiences -> 'excluded' else '[]'::jsonb end) as g(gid)
               left join public.klaviyo_audiences a
                      on a.company_entity_id = m.company_entity_id
                     and a.klaviyo_id = g.gid) u) as audience_excluded,
    -- The raw object too, so a later surface does not need another view change
    -- to see a field this migration did not think of.
    m.audiences
   from klaviyo_message_performance p
     left join klaviyo_messages m on m.company_entity_id = p.company_entity_id
       and m.kind = p.kind and m.klaviyo_id = p.klaviyo_id;

comment on view public.klaviyo_message_performance_v is
  'KLAVIYO: each campaign or flow message''s measured performance, with the message''s '
  'own name, status and the audience it was sent to. One row per message per '
  'measurement window per conversion metric -- rows from different windows are '
  'different measurements of the same sends and must never be added together. '
  'audience_included / audience_excluded name the lists and segments Klaviyo reported '
  'for the campaign, an unnamed id shown as the id itself; NULL means Klaviyo reported '
  'no audience (every flow message, and any campaign whose audience was ambiguous), '
  'never that nobody was sent to.';

-- ── 2. The report selects them ─────────────────────────────────────────────
-- Both new columns go in the DISTINCT ON projection alongside the other
-- message attributes, so the window pick is untouched: the ORDER BY that
-- chooses the widest window per message is unchanged, and so is the grain.
--
-- `audience_excluded` is here and not left out as noise. A campaign sent to
-- "All subscribers" minus a suppression segment did not go to all subscribers,
-- and a reader comparing sends between two campaigns needs to see that.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
  ('c9000000-0000-4000-a000-000000000001', null, 'system', 'company',
   'Email & SMS Performance (Klaviyo)',
   'Each Klaviyo campaign and flow message, as Klaviyo measured it: sends, delivery, opens, clicks, attributed orders and revenue, and the audience it was sent to. Klaviyo reports a campaign only as a TOTAL over a measurement window, never by day, so each message appears once, for the widest window SILO holds whose window ends in the period, and the Window columns say which. Rows from different windows are different measurements of the same sends and must never be added together. Revenue is attributed against the account''s conversion metric; it overlaps the ad platforms'' claims and Shopify net sales and is not incremental, so never add it to either. Klaviyo measures conversions against ONE metric the account chooses, and changing it does not restate what was already measured, so the metric is part of this report''s grain: a message measured under two metrics is two labelled rows, and they must never be added together. Rates are counts over delivered; opens are email-only, because Klaviyo reports none for SMS. A blank statistic is one Klaviyo did not report, not zero. Audience names the lists and segments Klaviyo reported for the campaign, with Excluded for any it suppressed; a flow message has no audience of its own and is blank, which never means nobody was sent to. Sending cost is Klaviyo''s SMS cost, not ad spend.',
   array[$q$with measured as (
  select distinct on (kind, klaviyo_id, channel, conversion_metric_id)
         kind, klaviyo_id, channel, conversion_metric_id, message_name, parent_name, status,
         audience_included, audience_excluded,
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
       audience_included as audience,
       audience_excluded as audience_excluded,
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
   '{"kind":{"label":"Type","semantic":"category"},"message":{"label":"Campaign / flow message","semantic":"category","chart_dimension":true},"channel":{"label":"Channel","semantic":"category"},"conversion_metric_id":{"label":"Conversion Metric","semantic":"category"},"flow":{"label":"Flow","semantic":"category"},"status":{"label":"Status","semantic":"category"},"audience":{"label":"Audience","semantic":"category","blank_reason":"Klaviyo reported no audience for this message. Every flow message is blank (a flow has no audience of its own), as is a campaign whose audience Klaviyo did not tie to the message. Blank never means nobody was sent to. A name SILO does not hold shows as the Klaviyo id."},"audience_excluded":{"label":"Audience Excluded","semantic":"category","blank_reason":"Klaviyo reported no exclusions for this message."},"window_from":{"label":"Window From","semantic":"date"},"window_through":{"label":"Window Through","semantic":"date"},"window_days":{"label":"Window Days","semantic":"count"},"sends":{"label":"Sends","semantic":"count"},"delivered":{"label":"Delivered","semantic":"count"},"delivery_rate":{"label":"Delivery Rate","semantic":"percent"},"open_rate":{"label":"Open Rate","semantic":"percent","blank_reason":"Klaviyo reports no opens for SMS, so an SMS row is blank rather than 0%."},"click_rate":{"label":"Click Rate","semantic":"percent"},"order_rate":{"label":"Order Rate","semantic":"percent"},"unsubscribes":{"label":"Unsubscribes","semantic":"count"},"attributed_orders":{"label":"Attributed Orders","semantic":"count"},"attributed_revenue":{"label":"Revenue Attributed by Klaviyo","semantic":"currency","chart_primary":true},"sending_cost":{"label":"SMS Sending Cost","semantic":"currency"},"klaviyo_id":{"label":"Klaviyo ID","semantic":"category"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- ── 3. Its tie-outs, regenerated against the report as it now stands ───────
-- Same two checks, same routes, same tolerances as 20261109210000. Only the
-- pinned md5 and the embedded report SQL change, and both are DERIVED from the
-- row just written rather than typed, so this file cannot pin a hash that
-- disagrees with the report it ships.
--
-- A THIRD check is added, and the reason is worth writing down because the
-- obvious assumption is wrong. The audience columns are scalar subqueries so
-- that the view cannot fan out; the tempting claim is that the existing
-- "one row per message" check would catch it if they ever became a join. It
-- would NOT. A join fans the VIEW out to one row per audience id, and then the
-- report's own DISTINCT ON collapses it straight back to one row per message
-- -- same row count, same revenue, but the audience shown is whichever id
-- happened to sort first, so a campaign sent to three lists would be labelled
-- with one of them and nothing would go red. Measured on a fixture
-- 2026-11-11: 3 fanned rows in, 1 row out, "VIP Buyers" shown, revenue
-- unchanged.
--
-- So the invariant has to be checked where it actually lives -- on the view,
-- not on the report -- by counting the view's rows against its own base
-- table's. That is the check that fails the night anybody turns one of these
-- subqueries into a join.
delete from public.silo_report_tieouts
 where report_id = 'c9000000-0000-4000-a000-000000000001';

do $checks$
declare
  perf_sql text;
  perf_guard text;
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
begin
  select replace(replace(queries_run[1], '{{date_from}}', from_sql), '{{date_to}}', to_sql),
         format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                md5(queries_run::text || parameters::text), id)
    into perf_sql, perf_guard
    from public.silo_chat_saved_reports where id = 'c9000000-0000-4000-a000-000000000001';

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

  -- The audience columns must stay per-row lookups. This is the only check
  -- that can tell: a join would fan the view out and the report's DISTINCT ON
  -- would hide it, leaving the row count and the revenue right and the
  -- audience name wrong. One row of klaviyo_message_performance must still be
  -- one row of the view it is read through.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note)
  values ('c9000000-0000-4000-a000-000000000001',
    'The audience lookup does not multiply the measured rows', 'sanity',
    format('select case when %s then (select count(*) from public.klaviyo_message_performance_v '
        || 'where (timeframe_end at time zone ''UTC'')::date between %s and %s) end as left_value, '
        || '(select count(*) from public.klaviyo_message_performance '
        || 'where company_entity_id = (select public.active_company_id()) '
        || 'and (timeframe_end at time zone ''UTC'')::date between %s and %s) as right_value',
      perf_guard, from_sql, to_sql, from_sql, to_sql),
    0,
    'Exact. klaviyo_message_performance_v reads one measurement per row and resolves the audience with per-row subqueries; above the right value means an audience lookup became a join, which the report''s DISTINCT ON would otherwise hide behind a correct row count and a wrong audience name. NO DATA can mean no Klaviyo measurement in the period or a changed report definition; never a certification of completeness.');

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
end
$checks$;

-- ── 4. The tile shows the column ───────────────────────────────────────────
-- The Marketing board's Klaviyo table tile lists its columns EXPLICITLY, so a
-- new report column does not appear on it on its own. Audience goes after
-- Channel, where a reader asking "who got this" is already looking, and the
-- tile's own empty message is left alone.
--
-- Written as a surgical jsonb edit rather than a replacement object so that
-- any limit, empty message or column a later migration added to this tile
-- survives, and re-running the file does not insert Audience twice.
--
-- Addressed by the tile's OWN id, not by its report: a tenant that cloned this
-- tile onto a board of its own owns that copy, and a system migration has no
-- business rewriting a column list somebody chose.
update public.dashboard_widgets w
   set visual_config = jsonb_set(
         w.visual_config,
         '{columns}',
         (select jsonb_agg(col order by ord)
            from (select t.col, t.ord::numeric as ord
                    from jsonb_array_elements_text(w.visual_config -> 'columns')
                         with ordinality as t(col, ord)
                  union all
                  select 'audience',
                         coalesce((select t.ord + 0.5
                                     from jsonb_array_elements_text(w.visual_config -> 'columns')
                                          with ordinality as t(col, ord)
                                    where t.col = 'channel'
                                    limit 1), 0.5)) ranked)),
       updated_at = now()
 where w.id = 'd0000000-0000-4000-a00c-000000000013'
   and jsonb_typeof(w.visual_config -> 'columns') = 'array'
   and not (w.visual_config -> 'columns' ? 'audience');

-- ── 5. Ask SILO's map ──────────────────────────────────────────────────────
-- The view gained columns, and the catalog stores each relation's column list.
-- refresh_chat_schema_catalog() rewrites columns only and preserves every
-- description, keyword list and is_hidden flag, so it runs FIRST and the text
-- below is written after it.
select public.refresh_chat_schema_catalog();

-- klaviyo_audiences has been visible to bots since 20261110010000 with NO
-- description, which means it can win a card only when a question happens to
-- use its table name. It gets one, plus the keywords that are the actual
-- ranking lever (name +5, keyword +3, description text +1).
--
-- No dates and no staleness verdicts in catalog text: these rows are global
-- across tenants and nothing rewrites them when a feed resumes, so a note
-- about what is or is not synced would rot silently.
update public.silo_chat_schema_catalog
   set description = 'Klaviyo lists and segments in the connected account, by name. One row per audience; kind is ''list'' or ''segment''. '
                  || 'Klaviyo''s list and segment endpoints expose no profile count, so there is no audience size here and a count cannot be derived. '
                  || 'Use it to NAME the audience ids on klaviyo_messages.audiences, matching on klaviyo_id alone: Klaviyo calls those entries group ids '
                  || 'and does not say whether each is a list or a segment. klaviyo_message_performance_v already does that join and exposes '
                  || 'audience_included / audience_excluded, which is the easier route for a question about a campaign''s audience.',
       keywords = array['klaviyo', 'list', 'segment', 'audience', 'subscribers', 'email', 'sms', 'marketing']
 where relname = 'klaviyo_audiences';

-- And the view's description learns the new columns, since that is the route a
-- question about a campaign's audience should take.
update public.silo_chat_schema_catalog
   set description = description
                  || ' audience_included and audience_excluded name the lists and segments Klaviyo reported for a campaign, '
                  || 'comma separated, an id SILO holds no name for shown as the id itself; both are NULL when Klaviyo reported no audience '
                  || '(every flow message, which has none of its own, and any campaign whose audience was ambiguous), which never means nobody was sent to. '
                  || 'audience_name is Klaviyo''s own label for that audience object and is usually null. '
                  || 'Names come from klaviyo_audiences, which carries no profile count, so audience SIZE cannot be answered from here.',
       keywords = (select array(select distinct unnest(keywords || array['audience', 'list', 'segment'])))
 where relname = 'klaviyo_message_performance_v'
   and description is not null
   and description not like '%audience_included%';
