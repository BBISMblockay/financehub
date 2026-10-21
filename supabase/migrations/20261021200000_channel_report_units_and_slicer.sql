-- Sales by Channel (c3000000-...-0003) gains a units column and a channel
-- slicer, plus the per-company channel choices the slicer offers.
--
-- WHY THE UNITS COME FROM shopify_order_lines. The report reads
-- shopify_orders_v, which is order grain. Its `line_item_count` is the
-- number of DISTINCT line items on the order, not units: over Baseballism's
-- last 28 completed days it reads 66,877 against 69,477 actual units, so
-- using it would understate every channel by a different amount (Faire's
-- 1,062 units arrive on 677 lines). Units therefore come from a LATERAL sum
-- of shopify_order_lines.quantity keyed on (company, shop_domain, order_id),
-- which is backed by shopify_order_lines_shop_order_line_company_key.
-- shop_domain is part of the key deliberately: the unique index is
-- (shop_domain, order_id, line_item_id, company_entity_id), so a company
-- running several stores can hold the same Shopify order_id twice and a
-- join on (company, order_id) alone would double-count it.
--
-- THE UNITS ARE GROSS, like the revenue beside them. Refunds are separate
-- transactions in shopify_orders and cannot be netted at this grain, which
-- is already why merch_revenue is not net sales. Measured on production as
-- an authenticated member of Baseballism, 28 completed company days to
-- 2026-10-20: 69,477 units here against 63,182 canonical net units in
-- sales_by_day_verification_v. The ~9% gap is refunds. The column is
-- labelled "Units Ordered" and the description says so, because a column
-- called Units sitting next to a net figure elsewhere on the same board is
-- how two numbers end up being compared that never tied.
--
-- COST. The lateral adds one index lookup per order in the window. Measured
-- the same way, 28 days / 24,542 orders: 2.07s, against 30s inside
-- chat_run_readonly_query. The alternative shape (aggregate the lines in a
-- CTE and hash-join) performs the same lookups and measured 3.6s, so the
-- lateral is kept.
--
-- THE SLICER IS `text` WITH options_source, NOT `enum`, for the same reason
-- the location slicer is (20261014090000): this is ONE global report row
-- read by every client, and each company has its own channels.
-- options_source is a UI hint only -- the value is still substituted by
-- text's rules (quoted, quotes doubled, control characters and semicolons
-- refused) -- so offering a dropdown moves no security boundary, and a
-- value that is not one of the company's channels simply matches no rows.
-- 'all' is the default and means no filter: substituted, the predicate
-- becomes the constant `'all' = 'all'`, which the planner folds away, so an
-- unfiltered run plans exactly as it did before.

-- ---------------------------------------------------------------------------
-- The choices.
-- ---------------------------------------------------------------------------
-- Scoped to 90 days ON PURPOSE. The slicer's value is matched against
-- resolved_channel_name, so the choices have to be the resolved names a
-- company has actually sold under, not the channel map alone (an unmapped
-- source_name resolves to itself and would never be offered). Distinct over
-- the whole table is what that costs: measured under RLS as Blake,
-- 365 days = 393,269 rows / 3.5s, which blows the browser's 8s cap once a
-- page holds more than one of these; 90 days = 89,678 rows / 147ms and
-- returned 11 of the 12 mapped channels. A channel last sold under more
-- than 90 days ago is therefore not in the dropdown, and typing it still
-- filters correctly, which is the trade this bound buys.
--
-- No company filter of its own, like silo_report_locations_v: RLS on
-- shopify_orders and shopify_channel_map is the tenant boundary, which is
-- what security_invoker is for here.
create or replace view public.silo_report_channels_v with (security_invoker = true) as
select o.company_entity_id,
       coalesce(m.display_name, o.source_name) as channel,
       coalesce(m.display_name, o.source_name) as label
  from public.shopify_orders o
  left join public.shopify_channel_map m
    on m.company_entity_id = o.company_entity_id
   and m.source_name = o.source_name
 where o.shopify_processed_at >= now() - interval '90 days'
   -- Matching the report: a channel with nothing but cancelled orders in the
   -- window would offer a slice the report cannot show.
   and o.cancelled_at is null
   and coalesce(m.display_name, o.source_name) is not null
 group by 1, 2;

revoke all on public.silo_report_channels_v from anon;
grant select on public.silo_report_channels_v to authenticated, service_role;

comment on view public.silo_report_channels_v is
  'Per-company channel choices for a report channel slicer. channel is the value a query filters on '
  '(it is matched against shopify_orders_v.resolved_channel_name) and label is for display; they are '
  'the same string, since a resolved channel name is already the display name. security_invoker: RLS '
  'on shopify_orders and shopify_channel_map is the tenant boundary, so this view must NOT grow a '
  'company filter of its own. Bounded to 90 days of processed orders for speed (20261021200000): a '
  'channel not sold under in that window is absent from the dropdown but still filters if typed.';

-- ---------------------------------------------------------------------------
-- The report.
-- ---------------------------------------------------------------------------
update public.silo_chat_saved_reports set
  description = 'Distinct orders, units ordered and discounted merchandise subtotal by channel, '
                'excluding cancelled orders, tax and shipping. Units and revenue are both gross: '
                'refunds are separate transactions and are not netted here, so this is neither net '
                'sales nor net units. Defaults to every channel over 28 completed company-calendar days.',
  queries_run = array[
    'select v.resolved_channel_name as channel,' || chr(13) || chr(10) ||
    '       count(*)                as orders,' || chr(13) || chr(10) ||
    '       sum(li.units)           as units,' || chr(13) || chr(10) ||
    '       round(sum(v.subtotal_price), 2) as merch_revenue,' || chr(13) || chr(10) ||
    '       round(avg(v.subtotal_price), 2) as aov' || chr(13) || chr(10) ||
    '  from shopify_orders_v v' || chr(13) || chr(10) ||
    '  left join lateral (' || chr(13) || chr(10) ||
    '       select sum(l.quantity) as units' || chr(13) || chr(10) ||
    '         from shopify_order_lines l' || chr(13) || chr(10) ||
    '        where l.company_entity_id = v.company_entity_id' || chr(13) || chr(10) ||
    '          and l.shop_domain      = v.shop_domain' || chr(13) || chr(10) ||
    '          and l.order_id         = v.order_id) li on true' || chr(13) || chr(10) ||
    ' where v.shopify_processed_at >= ({{date_from}}::timestamp at time zone (select public.silo_business_timezone()))' || chr(13) || chr(10) ||
    '   and v.shopify_processed_at < (({{date_to}} + 1)::timestamp at time zone (select public.silo_business_timezone()))' || chr(13) || chr(10) ||
    '   and v.cancelled_at is null' || chr(13) || chr(10) ||
    '   and ({{channel}} = ''all'' or v.resolved_channel_name = {{channel}})' || chr(13) || chr(10) ||
    ' group by 1 order by merch_revenue desc'
  ],
  parameters = '[
    {"key": "date_from", "type": "date", "label": "From", "default": "today-28d", "date_basis": "company"},
    {"key": "date_to", "type": "date", "label": "Through", "default": "today-1d", "date_basis": "company"},
    {"key": "channel", "type": "text", "label": "Channel", "default": "all", "options_source": "channel"}
  ]'::jsonb,
  columns_metadata = '{"aov":{"label":"AOV","semantic":"currency"},
                      "units":{"label":"Units Ordered","semantic":"count"},
                      "orders":{"semantic":"count"},
                      "channel":{"semantic":"category"},
                      "merch_revenue":{"label":"Merch Revenue","semantic":"currency"}}'::jsonb
where id = 'c3000000-0000-4000-a000-000000000003'
  and source = 'system'
  and company_entity_id is null;

-- ---------------------------------------------------------------------------
-- Tie-outs.
-- ---------------------------------------------------------------------------
-- Each check embeds the report's own SQL with its defaults substituted,
-- guarded by an md5 of (queries_run || parameters) so a check whose report
-- has since changed reports NO DATA instead of a stale pass. Editing the
-- report therefore invalidates the existing guard, which is why the checks
-- are regenerated HERE, in the same migration, rather than left for
-- report-tieouts-nightly to go amber on.
--
-- Both run the report AS SHIPPED, channel = 'all'. A per-channel check would
-- reconcile a slice against a total and always disagree.
do $$
declare
  from_sql  constant text := '((select public.silo_business_today()) - 28)';
  to_sql    constant text := '((select public.silo_business_today()) - 1)';
  window_tz constant text :=
    '(o.shopify_processed_at at time zone (select public.silo_business_timezone()))::date '
    || 'between ((select public.silo_business_today()) - 28) and ((select public.silo_business_today()) - 1)';
  note      constant text := 'Uses deployed default SQL. NO DATA can mean no source rows or a changed '
                             'definition requiring a refreshed check; never a certification of completeness.';
  r         record;
  q         text;
  guard     text;
begin
  select * into r from public.silo_chat_saved_reports
   where id = 'c3000000-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;
  if not found then
    raise exception 'Sales by Channel (c3000000-0000-4000-a000-000000000003) is missing; run the seed migrations first';
  end if;

  q := replace(replace(replace(r.queries_run[1],
         '{{date_from}}', from_sql), '{{date_to}}', to_sql), '{{channel}}', '''all''');
  guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                  md5(r.queries_run::text || r.parameters::text), r.id);

  delete from public.silo_report_tieouts where report_id = r.id;

  -- Unchanged in substance from 20260920075344: the order count has to agree
  -- with the orders table counted on the company's own calendar date, which
  -- is the one thing a timezone mistake in the window breaks.
  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
  (r.id, 'Channel orders reconcile by company-local date', 'reconciliation',
   format('with report as materialized (%s) select case when %s then sum(orders) end as left_value, '
     || '(select count(distinct o.order_id) from public.shopify_orders o '
     || 'where o.company_entity_id = (select public.active_company_id()) and o.cancelled_at is null '
     || 'and %s) as right_value from report', q, guard, window_tz),
   0, note),

  -- New (20261021200000). Zero tolerance: both sides read the same line rows
  -- through the same keys, so any gap is the join losing or duplicating
  -- orders -- exactly the failure a multi-store company would hit if
  -- shop_domain were dropped from the key.
  (r.id, 'Channel units reconcile with order lines', 'reconciliation',
   format('with report as materialized (%s) select case when %s then sum(units) end as left_value, '
     || '(select sum(l.quantity) from public.shopify_order_lines l '
     || 'join public.shopify_orders o on o.company_entity_id = l.company_entity_id '
     || 'and o.shop_domain = l.shop_domain and o.order_id = l.order_id '
     || 'where o.company_entity_id = (select public.active_company_id()) and o.cancelled_at is null '
     || 'and %s) as right_value from report', q, guard, window_tz),
   0, note);
end $$;

-- Ask SILO's schema map: the report text it cites changed, and there is a new
-- view it may be asked about.
select public.refresh_chat_schema_catalog();
