-- A SILO report: gross sales and discounts by location, last 10 days.
--
-- WHY THIS REPORT. Sales by Location (5110de50-...-0003) reports NET sales and
-- units only, so there is no surface anywhere in SILO -- page, API or MCP --
-- that shows what a location discounted to get there. Discount rate is the
-- number a store manager acts on, and gross without it is not readable: two
-- locations can post the same net on very different markdown.
--
-- WHY sales_by_day_verification_v AND NOT sales_by_day. The verification view
-- is `select s.*` over sales_by_day with the better_reports rows dropped where
-- a shopify_api row exists for the same (company, location, day). Reading the
-- base table double-counts every cutover day. Sales by Location already reads
-- the view, so this report ties to it by construction rather than by
-- coincidence; every column here comes from the same row.
--
-- WHY 10 DAYS AND NOT 28 OR 30. The other sales reports default to 28-60 days
-- because they are trend surfaces. This one is for "what did we discount this
-- week", so it defaults to the last 10 completed company-calendar days.
-- date_from / date_to still take any window.
--
-- THE LOCATION PARAMETER is `text` with options_source = 'location', exactly
-- as on reports 0002 and 0003 and for the same reason: a SILO report is one
-- global row read by every tenant, while locations are per company, so the
-- choices are fetched at render time. options_source is a UI hint ONLY -- the
-- value is substituted by text's rules -- so the dropdown moves no security
-- boundary. 'all' is the default and folds to the constant `'all' = 'all'`,
-- which the planner removes, so an unfiltered run plans as if the predicate
-- were absent. See 20261014090000_report_location_parameter.sql.
--
-- DISCOUNT RATE IS DISCOUNTS OVER GROSS, not over net, and is null rather than
-- zero when gross is zero -- a location with no gross sales has no discount
-- rate, and 0% would read as "sold at full price".
--
-- REFUNDS ARE NOT NETTED out of gross. gross_sales - discounts does not equal
-- net_sales, because net also carries refunds; the report therefore shows
-- refunds as its own column so the three reconcile on screen and nobody has to
-- guess at the gap.
--
-- Idempotent: insert ... on conflict do update, and the tie-out is deleted and
-- re-inserted.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer,
   queries_run, parameters, columns_metadata)
values
  ('5110de50-0000-4000-a000-000000000005', null, null, 'system', 'company',
   'Gross Sales and Discounts by Location',
   'Gross merchandise sales, the discounts taken off them, refunds and the net that remains, by location, over the last 10 completed company-calendar days by default. Discount rate is discounts over gross, and is blank for a location with no gross sales. Gross minus discounts does not equal net because net also carries refunds, which is why refunds are shown beside them. Deduplicated across the Shopify API and Better Reports sources, so it ties to Sales by Location.',
   null, null,
   array[$q$select coalesce(location_tag, 'Unknown') as location_tag,
       round(sum(total_gross_sales), 2) as gross_sales,
       round(sum(total_discounts), 2) as discounts,
       case when sum(total_gross_sales) > 0
            then round(sum(total_discounts) / sum(total_gross_sales), 4)
       end as discount_rate,
       round(sum(total_refunds), 2) as refunds,
       round(sum(total_net_sales), 2) as net_sales,
       sum(total_quantity_sold) as units_sold
  from sales_by_day_verification_v
 where day_date between {{date_from}} and {{date_to}}
   and ({{location}} = 'all' or location_tag = {{location}})
 group by 1
 order by gross_sales desc nulls last$q$],
   '[
     {"key": "date_from", "type": "date", "label": "From", "default": "today-10d", "date_basis": "company"},
     {"key": "date_to", "type": "date", "label": "Through", "default": "today-1d", "date_basis": "company"},
     {"key": "location", "type": "text", "label": "Location", "default": "all", "options_source": "location"}
   ]'::jsonb,
   '{
     "location_tag":  {"label": "Location", "semantic": "category", "chart_dimension": true},
     "gross_sales":   {"label": "Gross Sales", "semantic": "currency", "chart_primary": true},
     "discounts":     {"label": "Discounts", "semantic": "currency"},
     "discount_rate": {"label": "Discount Rate", "semantic": "fraction",
                       "blank_reason": "Blank when the location had no gross sales in the window, so no rate can be computed."},
     "refunds":       {"label": "Refunds", "semantic": "currency"},
     "net_sales":     {"label": "Net Sales", "semantic": "currency"},
     "units_sold":    {"label": "Units Sold", "semantic": "count"}
   }'::jsonb)
on conflict (id) do update set
  source            = excluded.source,
  visibility        = excluded.visibility,
  title             = excluded.title,
  description       = excluded.description,
  queries_run       = excluded.queries_run,
  parameters        = excluded.parameters,
  columns_metadata  = excluded.columns_metadata;

-- Tie-out. Runs the report AS SHIPPED (location = 'all') and reconciles its
-- gross against the same window read straight from the view, at zero
-- tolerance: both sides are the same column over the same rows, so any
-- difference is the report's grouping or its dedupe, not rounding.
--
-- A per-location check is deliberately absent: it would compare a slice with a
-- total and always disagree.
--
-- The guard is an md5 of (queries_run || parameters) read back from the row
-- this migration just wrote. Editing the report invalidates it and the nightly
-- check reports NO DATA instead of a stale pass, which is why any later edit
-- must regenerate the tie-out in the same migration.
do $$
declare
  from_sql constant text := '((select public.silo_business_today()) - 10)';
  to_sql   constant text := '((select public.silo_business_today()) - 1)';
  r        record;
  q        text;
  guard    text;
begin
  select * into r from public.silo_chat_saved_reports
   where id = '5110de50-0000-4000-a000-000000000005';

  q := replace(replace(replace(r.queries_run[1],
         '{{date_from}}', from_sql), '{{date_to}}', to_sql), '{{location}}', '''all''');
  guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                  md5(r.queries_run::text || r.parameters::text), r.id);

  delete from public.silo_report_tieouts where report_id = r.id;

  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
  (r.id, 'Location gross agrees with canonical gross', 'reconciliation',
   format('with report as materialized (%s) select case when %s then sum(gross_sales) end as left_value, '
     || '(select sum(total_gross_sales) from public.sales_by_day_verification_v '
     || 'where day_date between %s and %s) as right_value from report', q, guard, from_sql, to_sql),
   0.01,
   'Uses deployed default SQL. NO DATA can mean no source rows or a changed definition requiring a refreshed check; never a certification of completeness.'),
  (r.id, 'Gross less discounts less refunds equals net', 'reconciliation',
   format('with report as materialized (%s) select case when %s then '
     || 'round(sum(gross_sales) - sum(discounts) - sum(refunds), 2) end as left_value, '
     || 'round(sum(net_sales), 2) as right_value from report', q, guard),
   0.01,
   'The report''s own columns must add up. A mismatch means sales_by_day''s gross, discount, refund and net no longer describe the same transactions, which would make every column here unreadable rather than merely wrong.');
end $$;

-- Ask SILO's schema map: there is a new report for it to cite.
select public.refresh_chat_schema_catalog();
