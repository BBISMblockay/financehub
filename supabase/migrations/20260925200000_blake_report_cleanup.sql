-- Reorganize Blake-owned reporting without changing Sammie's work or backtests.
-- Preserve the original Ask SILO answers as historical records; point live tiles at
-- reusable SILO/manual definitions instead of rewriting an answer's saved queries.
do $$ begin
 if not exists (select 1 from public.dashboards where id='418a1d1c-8cc7-4e19-b49f-49bb7d34d757' and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932')
 or not exists (select 1 from public.dashboards where id='da5b0a2d-0000-4000-a000-00000000000e' and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932')
 or not exists (select 1 from public.dashboards where id='ca069f1b-1eda-4805-a4a9-53d6c28dc2b0' and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932')
 then raise exception 'Expected Blake-owned boards are missing'; end if;
end $$;

-- MTD tile now uses the canonical SILO efficiency report with explicit month-to-yesterday filters.
update public.dashboards
   set filter_state=coalesce(filter_state,'{}'::jsonb) ||
       '{"date_from":"month_start","date_to":"today-1d"}'::jsonb,
       updated_at=now()
 where id='418a1d1c-8cc7-4e19-b49f-49bb7d34d757'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';
update public.dashboard_widgets
   set report_id='c3000000-0000-4000-a000-000000000006',
       title='Paid spend vs online sales — MTD',
       visual_config=jsonb_set(jsonb_set(visual_config,'{y_field}','"ad_spend"'::jsonb),
                               '{measures}','["ad_spend","online_net_sales"]'::jsonb),
       updated_at=now()
 where id='a30c56ea-de62-41da-97e3-bf5beb2e3dbd'
   and dashboard_id='418a1d1c-8cc7-4e19-b49f-49bb7d34d757'
   and report_id='40f1cb12-b1a1-4e99-9276-494b125e36c9';

-- A new private, rolling report replaces only Ownership's stale top-five tile.
insert into public.silo_chat_saved_reports
  (id,company_entity_id,created_by,title,description,queries_run,visibility,source,columns_metadata)
values
  ('bc250925-0000-4000-a000-000000000001','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
   '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
   'Top Products by Revenue — Last 30 Completed Days',
   'Five products ranked by net sales over the last 30 completed company-calendar days. Uses the pre-aggregated product-title daily view and excludes the x-redo product title; refreshes with the Baseballism calendar. The ranking uses net sales from the daily summary.',
   ARRAY['select product_title as product_name,
       sum(net_sales) as net_sales
  from sales_by_product_title_daily_v
 where day_date >= (now() at time zone ''America/Los_Angeles'')::date - 30
   and day_date < (now() at time zone ''America/Los_Angeles'')::date
   and product_title <> ''x-redo''
 group by product_title
 order by net_sales desc
 limit 5']::text[],'private','manual',
   '{"product_name":{"semantic":"text"},"net_sales":{"semantic":"currency"}}'::jsonb)
on conflict (id) do update set title=excluded.title,description=excluded.description,
  queries_run=excluded.queries_run,columns_metadata=excluded.columns_metadata
  where public.silo_chat_saved_reports.created_by=excluded.created_by
    and public.silo_chat_saved_reports.company_entity_id=excluded.company_entity_id;
update public.dashboard_widgets
   set report_id='bc250925-0000-4000-a000-000000000001',query_index=0,
       title='Top 5 products by revenue · last 30 completed days',
       updated_at=now()
 where id='0871688d-ceac-49ec-937d-7b2caf95d854'
   and dashboard_id='da5b0a2d-0000-4000-a000-00000000000e'
   and report_id='d79212f7-4767-4eda-abb7-9813a2a0a540';
update public.dashboards set updated_at=now()
 where id='da5b0a2d-0000-4000-a000-00000000000e'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';

-- Provider attribution is an overlap claim, not generated/incremental sales.
update public.dashboard_widgets
   set visual_config=jsonb_set(visual_config,'{note}',
     to_jsonb('Revenue attributed by Redo using a 5-day window. Revenue / spend is Redo-attributed revenue per dollar spent, not incremental sales or profit. Do not add it to sales or other platform claims. All amounts in USD.'::text)),
       updated_at=now()
 where id='7ee36cb9-c84a-44cc-8802-0b6c7ca40ff9'
   and dashboard_id='0f611814-1e8d-4dac-9b1b-d39ad339dc51';
update public.dashboards set updated_at=now()
 where id='0f611814-1e8d-4dac-9b1b-d39ad339dc51'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';

-- Move the two private operational demand tables to Blake's private Demand Planner.
update public.dashboard_widgets
   set dashboard_id='ca069f1b-1eda-4805-a4a9-53d6c28dc2b0',
       layout='{"x":0,"y":32,"w":12,"h":4}'::jsonb,
       sort_order=10,updated_at=now()
 where id='29a349e8-2e2d-469e-bdd4-19462d4a67ca'
   and dashboard_id='2486431f-3c55-48c1-a320-e7de86e1df79'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';
update public.dashboard_widgets
   set dashboard_id='ca069f1b-1eda-4805-a4a9-53d6c28dc2b0',
       layout='{"x":0,"y":36,"w":12,"h":4}'::jsonb,
       sort_order=11,updated_at=now()
 where id='97607144-5629-4c16-9916-1e948d9732a0'
   and dashboard_id='2486431f-3c55-48c1-a320-e7de86e1df79'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';
update public.dashboards
   set filter_state=coalesce(filter_state,'{}'::jsonb) ||
       '{"demand_basis":"recent_3m","product_type":"all"}'::jsonb,
       updated_at=now()
 where id='ca069f1b-1eda-4805-a4a9-53d6c28dc2b0'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';
update public.dashboards
   set filter_state=(coalesce(filter_state,'{}'::jsonb)-'demand_basis') ||
         '{"date_from":"today-90d","date_to":"today-1d"}'::jsonb,
       description=replace(description,
         'Current SILO data may differ from historic exports.',
         'Current SILO data may differ from historic exports. Defaults to the last 90 completed company-calendar days; widening to YTD may time out.') || ' Demand-planning tiles are now on the private Demand Planner.',
       updated_at=now()
 where id='2486431f-3c55-48c1-a320-e7de86e1df79'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932';

-- Distinguish the company-specific board from the protected global Overview.
update public.dashboards
   set name='Baseballism operating view',
       description='Baseballism-specific operating layout, including the launches scorecard. SILO Overview is the global standard board; this company board remains available for its custom arrangement.',
       updated_at=now()
 where id='861ca4aa-7c5e-4c83-a5c5-043e79fc64ac'
   and created_by='69bd02b7-c711-4d4d-a03b-15d3e88d1932'
   and name='SILO Overview';

-- Verify the intended state before the migration commits.
do $$ begin
 if (select count(*) from public.dashboard_widgets where dashboard_id='2486431f-3c55-48c1-a320-e7de86e1df79') <> 5
 or (select count(*) from public.dashboard_widgets where dashboard_id='ca069f1b-1eda-4805-a4a9-53d6c28dc2b0') <> 12
 or not exists (select 1 from public.dashboard_widgets where id='a30c56ea-de62-41da-97e3-bf5beb2e3dbd' and report_id='c3000000-0000-4000-a000-000000000006')
 or not exists (select 1 from public.dashboard_widgets where id='0871688d-ceac-49ec-937d-7b2caf95d854' and report_id='bc250925-0000-4000-a000-000000000001')
 then raise exception 'Reporting cleanup did not reach intended board state'; end if;
end $$;
