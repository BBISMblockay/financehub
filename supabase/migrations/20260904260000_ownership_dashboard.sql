
-- The Ownership dashboard: how the business is tracking.
--
-- Three tiles reuse the Logistics report definitions rather than restating
-- them -- the inventory position belongs next to the sales picture, and one
-- definition means one place to correct it.
insert into public.dashboards
  (id, company_entity_id, created_by, name, description, visibility, filter_state)
values ('da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
        'Ownership',
        'How the business is tracking: sales against last year, channel mix, paid media, what is coming.',
        'company',
        '{"date_from":"today-28d"}'::jsonb)
on conflict (id) do update set
  name = excluded.name, description = excluded.description,
  visibility = excluded.visibility, filter_state = excluded.filter_state;

insert into public.dashboard_widgets
  (id, dashboard_id, company_entity_id, created_by, report_id, query_index,
   title, visual_type, visual_config, layout, sort_order)
values
('c4000000-0000-4000-a000-000000000001','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'How we are tracking','section',
 '{"note": "Every period is measured against the same period a year ago. Today is never included — it is always a partial day."}'::jsonb,'{"h":1,"w":12,"x":0,"y":0}'::jsonb,0),
('c4000000-0000-4000-a000-000000000002','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000001',0,'Sales vs last year','table',
 '{"totals":"none"}'::jsonb,'{"h":4,"w":12,"x":0,"y":1}'::jsonb,1),
('c4000000-0000-4000-a000-000000000003','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000002',0,'Net sales by day','line',
 '{"x_field":"day_date","y_field":"net_sales","sort":"none","limit":0}'::jsonb,'{"h":4,"w":8,"x":0,"y":5}'::jsonb,2),
('c4000000-0000-4000-a000-000000000004','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000003',0,'Sales by channel','table',
 '{"limit":8}'::jsonb,'{"h":4,"w":4,"x":8,"y":5}'::jsonb,3),
('c4000000-0000-4000-a000-000000000005','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'Paid media','section',
 '{"note": "Analytics-only platforms are excluded — GA4 reports no spend and half a million events."}'::jsonb,'{"h":1,"w":12,"x":0,"y":9}'::jsonb,4),
('c4000000-0000-4000-a000-000000000006','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000005',0,'Claimed vs actually sold','table',
 '{}'::jsonb,'{"h":3,"w":6,"x":0,"y":10}'::jsonb,5),
('c4000000-0000-4000-a000-000000000007','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000004',0,'Paid media by platform','table',
 '{"limit":8}'::jsonb,'{"h":3,"w":6,"x":6,"y":10}'::jsonb,6),
('c4000000-0000-4000-a000-000000000008','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000006',0,'Marketing efficiency by day','line',
 '{"x_field":"day_date","measures":["ad_spend","online_net_sales"],"y_field":"online_net_sales","sort":"none","limit":0}'::jsonb,'{"h":4,"w":12,"x":0,"y":13}'::jsonb,7),
('c4000000-0000-4000-a000-000000000009','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'What is coming','section',
 '{"note": "Launches ahead, and the stock and purchase orders behind them. Detail lives on the Logistics board."}'::jsonb,'{"h":1,"w":12,"x":0,"y":17}'::jsonb,8),
('c4000000-0000-4000-a000-00000000000a','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c3000000-0000-4000-a000-000000000007',0,'Upcoming launches','table',
 '{"limit":10}'::jsonb,'{"h":4,"w":7,"x":0,"y":18}'::jsonb,9),
('c4000000-0000-4000-a000-00000000000b','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000001',0,'Units on hand','kpi',
 '{"y_field":"units_on_hand","abbreviate":true}'::jsonb,'{"h":2,"w":3,"x":7,"y":18}'::jsonb,10),
('c4000000-0000-4000-a000-00000000000c','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000001',0,'Units on order','kpi',
 '{"y_field":"units_on_order","abbreviate":true}'::jsonb,'{"h":2,"w":2,"x":10,"y":18}'::jsonb,11),
('c4000000-0000-4000-a000-00000000000d','da5b0a2d-0000-4000-a000-00000000000e','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000002',0,'Purchase orders running late','table',
 '{"limit":5,"columns":["po_name","factory_name","days_late","total_units"]}'::jsonb,'{"h":2,"w":5,"x":7,"y":20}'::jsonb,12)
on conflict (id) do update set
  report_id = excluded.report_id, query_index = excluded.query_index,
  title = excluded.title, visual_type = excluded.visual_type,
  visual_config = excluded.visual_config, layout = excluded.layout,
  sort_order = excluded.sort_order;
