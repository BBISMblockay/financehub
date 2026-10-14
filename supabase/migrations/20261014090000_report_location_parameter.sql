-- A location filter on the two SILO reports where it is correct.
--
-- Depends on 20261014080000_report_location_filter.sql, which supplies the
-- per-company choices (silo_report_locations_v).
--
-- WHY ONLY TWO OF THE TWENTY-ONE. A location filter is only worth having
-- where every number in the report is location-aware; bolting one onto a
-- report that mixes location-aware and location-blind sources makes the
-- figures wrong rather than narrower:
--
--   Sales by Location, Top Products   -- every column comes from a view
--                                        carrying location_tag. Filtered.
--   Daily Sales                       -- net_sales and units_sold are
--                                        location-aware, but `orders`
--                                        comes from shopify_orders_v,
--                                        which carries location_id and no
--                                        tag. Filtering the first two and
--                                        not the third would show one
--                                        store's sales beside the whole
--                                        company's order count. Left alone
--                                        until that join exists.
--   Marketing Efficiency,             -- deliberately scoped to the ONLINE
--   Attribution vs Sales                 channel, which IS the location
--                                        selection these reports make. A
--                                        second one would contradict it.
--   the rest                          -- inventory, purchasing and SEO
--                                        reports have no location grain.
--
-- THE PARAMETER IS `text`, NOT `enum`. An enum's options are declared in
-- the report, and a SILO report is one global row read by every client,
-- while each company has its own locations. So the report declares
-- options_source = 'location' and the filter bar fetches that company's
-- choices at render time. options_source is a UI hint ONLY: the value is
-- still substituted by text's rules (quoted, quotes doubled, control
-- characters and semicolons refused), so offering a dropdown moves no
-- security boundary. A value that is not one of the company's locations is
-- therefore not an error -- it simply matches no rows.
--
-- 'all' IS THE DEFAULT and means no filter. The predicate reads
-- `{{location}} = 'all' or location_tag = {{location}}`; substituted with
-- the default it becomes the constant `'all' = 'all'`, which the planner
-- folds away, so an unfiltered run plans exactly as it did before.

update public.silo_chat_saved_reports set
  queries_run = array[
    'select coalesce(location_tag,''Unknown'') location_tag,' || chr(13) || chr(10) ||
    'round(sum(total_net_sales),2) net_sales, sum(total_quantity_sold) units_sold' || chr(13) || chr(10) ||
    'from sales_by_day_verification_v where day_date between {{date_from}} and {{date_to}}' || chr(13) || chr(10) ||
    'and ({{location}} = ''all'' or location_tag = {{location}}) group by 1 order by net_sales desc'
  ],
  parameters = '[
    {"key": "date_from", "type": "date", "label": "From", "default": "today-30d", "date_basis": "company"},
    {"key": "date_to", "type": "date", "label": "Through", "default": "today-1d", "date_basis": "company"},
    {"key": "location", "type": "text", "label": "Location", "default": "all", "options_source": "location"}
  ]'::jsonb
where id = '5110de50-0000-4000-a000-000000000003' and source = 'system';

update public.silo_chat_saved_reports set
  queries_run = array[
    'select product_title,' || chr(13) || chr(10) ||
    '            sum(units_sold) as units_sold,' || chr(13) || chr(10) ||
    '            round(sum(net_sales),2) as net_sales,' || chr(13) || chr(10) ||
    '            sum(orders)     as orders' || chr(13) || chr(10) ||
    '       from sales_by_product_title_daily_v' || chr(13) || chr(10) ||
    '      where day_date between {{date_from}} and {{date_to}}' || chr(13) || chr(10) ||
    '        and ({{location}} = ''all'' or location_tag = {{location}})' || chr(13) || chr(10) ||
    '        and lower(product_title) <> ''x-redo''' || chr(13) || chr(10) ||
    '        and product_title not ilike ''%package protection%''' || chr(13) || chr(10) ||
    '      group by product_title' || chr(13) || chr(10) ||
    '      order by units_sold desc' || chr(13) || chr(10) ||
    '      limit 50'
  ],
  parameters = '[
    {"key": "date_from", "type": "date", "label": "From", "default": "today-30d", "date_basis": "company"},
    {"key": "date_to", "type": "date", "label": "Through", "default": "today-1d", "date_basis": "company"},
    {"key": "location", "type": "text", "label": "Location", "default": "all", "options_source": "location"}
  ]'::jsonb
where id = '5110de50-0000-4000-a000-000000000002' and source = 'system';

-- Tie-outs. Each check embeds the report's own SQL with its defaults
-- substituted, guarded by an md5 of (queries_run || parameters) so that a
-- check whose report has since changed reports NO DATA instead of a stale
-- pass. Editing either report therefore invalidates its guard, which is
-- why they are regenerated here, in the same migration, rather than left
-- for report-tieouts-nightly to go red on.
--
-- Both checks run the report AS SHIPPED: location = 'all'. A per-location
-- check would reconcile a slice against a total and always disagree.
do $$
declare
  from_sql constant text := '((select public.silo_business_today()) - 30)';
  to_sql   constant text := '((select public.silo_business_today()) - 1)';
  note     constant text := 'Uses deployed default SQL. NO DATA can mean no source rows or a changed definition requiring a refreshed check; never a certification of completeness.';
  r        record;
  q        text;
  guard    text;
begin
  for r in select * from public.silo_chat_saved_reports
            where id in ('5110de50-0000-4000-a000-000000000003',
                         '5110de50-0000-4000-a000-000000000002') loop
    q := replace(replace(replace(r.queries_run[1],
           '{{date_from}}', from_sql), '{{date_to}}', to_sql), '{{location}}', '''all''');
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);

    delete from public.silo_report_tieouts where report_id = r.id;

    if r.id = '5110de50-0000-4000-a000-000000000003' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Locations agree with canonical total', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(net_sales) end as left_value, '
         || '(select sum(total_net_sales) from public.sales_by_day_verification_v '
         || 'where day_date between %s and %s) as right_value from report', q, guard, from_sql, to_sql),
       0.01, note);
    else
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Product rollup completeness vs canonical sales', 'reconciliation',
       format('select case when %s then (select sum(net_sales) from public.sales_by_product_title_daily_v '
         || 'where day_date between %s and %s) end as left_value, '
         || '(select sum(total_net_sales) from public.sales_by_day_verification_v '
         || 'where day_date between %s and %s) as right_value', guard, from_sql, to_sql, from_sql, to_sql),
       0.01, 'Full source coverage before top-N/merchandise exclusions. Mismatch exposes stale rollups, catalog fan-out or historical source overlap; no large tolerance masks it.');
    end if;
  end loop;
end $$;

-- Ask SILO's schema map: the report text it cites changed.
select public.refresh_chat_schema_catalog();
