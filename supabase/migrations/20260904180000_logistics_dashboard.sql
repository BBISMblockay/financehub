-- The Logistics dashboard: purchase orders, inventory cover, sell-through.
--
-- Seeded rather than clicked together so the board is reproducible and its
-- reasoning is reviewable. The reports live in 20260904160000.
--
-- Layout note: the board is built around what the DATA actually says, not a
-- generic template. Nothing at Baseballism is running thin -- cover is 27-43
-- weeks across every merchandise type -- so a "reorder now" board would have
-- been empty theatre. What the data does say is that 24 open POs are past
-- their expected arrival (one by 62 days) and that some lines carry years of
-- cover, so the board leads with overdue POs and overstock.
insert into public.dashboards
  (id, company_entity_id, created_by, name, description, visibility, filter_state)
values ('da5b0a2d-0000-4000-a000-00000000000c',
        '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
        '69bd02b7-c711-4d4d-a03b-15d3e88d1932',
        'Logistics',
        'Purchase orders, inventory cover and sell-through.',
        'company',
        '{"cover_weeks":26,"min_units":200,"date_from":"today-28d"}'::jsonb)
on conflict (id) do update set
  name = excluded.name, description = excluded.description,
  visibility = excluded.visibility, filter_state = excluded.filter_state;

-- Widgets. Two visual_config decisions worth keeping, both found by looking
-- at the rendered board rather than by reading the config:
--
--  * The overdue-PO tile carries NO totals. Totals sum every currency/count/
--    number column, which is right far more often than not -- but the tile
--    printed "TOTAL ... 361" under Days Late, and 361 days late across eight
--    POs is a number that does not exist. The one useful total (units late)
--    was not worth printing a meaningless one beside it.
--  * The top-products tile carries no totals either, for a different reason:
--    1,505 products sold in the window and chat_run_readonly_query caps at
--    500 rows, so any total would be of whichever rows survived the cap.
--
--    Dead stock KEEPS its total: 48 rows is the whole answer, so the sum is
--    the real value sitting still ($250,184 at retail).

insert into public.dashboard_widgets
  (id, dashboard_id, company_entity_id, created_by, report_id, query_index,
   title, visual_type, visual_config, layout, sort_order)
values
('c2000000-0000-4000-a000-000000000001','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'Needs a decision','section',
 '{"note": "Overdue POs and cover that has drifted. Everything below this line is current state, not a period."}'::jsonb,'{"h": 1, "w": 12, "x": 0, "y": 0}'::jsonb,0),
('c2000000-0000-4000-a000-000000000002','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000001',0,'Units on hand','kpi',
 '{"y_field": "units_on_hand", "abbreviate": true}'::jsonb,'{"h": 2, "w": 3, "x": 0, "y": 1}'::jsonb,1),
('c2000000-0000-4000-a000-000000000003','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000001',0,'Units on order','kpi',
 '{"y_field": "units_on_order", "abbreviate": true}'::jsonb,'{"h": 2, "w": 3, "x": 3, "y": 1}'::jsonb,2),
('c2000000-0000-4000-a000-000000000004','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000001',0,'Weeks of cover','kpi',
 '{"y_field": "weeks_of_cover"}'::jsonb,'{"h": 2, "w": 3, "x": 6, "y": 1}'::jsonb,3),
('c2000000-0000-4000-a000-000000000005','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000006',0,'Running thin','table',
 '{"limit": 8}'::jsonb,'{"h": 2, "w": 3, "x": 9, "y": 1}'::jsonb,4),
('c2000000-0000-4000-a000-000000000006','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000002',0,'Purchase orders past their arrival date','table',
 '{"limit": 12, "columns": ["po_name", "factory_name", "status", "expected_arrival_date", "days_late", "total_units"]}'::jsonb,'{"h": 4, "w": 12, "x": 0, "y": 3}'::jsonb,5),
('c2000000-0000-4000-a000-000000000007','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'Incoming','section',
 '{}'::jsonb,'{"h": 1, "w": 12, "x": 0, "y": 7}'::jsonb,6),
('c2000000-0000-4000-a000-000000000008','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000003',0,'Units arriving by month','bar',
 '{"sort": "none", "x_field": "arrival_month", "y_field": "units_arriving", "show_values": true}'::jsonb,'{"h": 4, "w": 7, "x": 0, "y": 8}'::jsonb,7),
('c2000000-0000-4000-a000-000000000009','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000004',0,'Open units by factory','table',
 '{"limit": 10}'::jsonb,'{"h": 4, "w": 5, "x": 7, "y": 8}'::jsonb,8),
('c2000000-0000-4000-a000-00000000000a','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 null,0,'Cover and sell-through','section',
 '{}'::jsonb,'{"h": 1, "w": 12, "x": 0, "y": 12}'::jsonb,9),
('c2000000-0000-4000-a000-00000000000b','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000005',0,'Cover and momentum by product type','table',
 '{"limit": 14}'::jsonb,'{"h": 5, "w": 7, "x": 0, "y": 13}'::jsonb,10),
('c2000000-0000-4000-a000-00000000000c','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000009',0,'Sell-through by product type','bar',
 '{"sort": "desc", "limit": 10, "x_field": "product_type", "y_field": "sell_through_pct"}'::jsonb,'{"h": 5, "w": 5, "x": 7, "y": 13}'::jsonb,11),
('c2000000-0000-4000-a000-00000000000d','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000007',0,'Overstocked and slowing','table',
 '{"limit": 10}'::jsonb,'{"h": 4, "w": 6, "x": 0, "y": 18}'::jsonb,12),
('c2000000-0000-4000-a000-00000000000e','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-000000000008',0,'Dead stock (velocity-verified)','table',
 '{"limit": 10, "totals": "row"}'::jsonb,'{"h": 4, "w": 6, "x": 6, "y": 18}'::jsonb,13),
('c2000000-0000-4000-a000-00000000000f','da5b0a2d-0000-4000-a000-00000000000c','3bd934c9-4cdd-429b-9076-f8f6b45d4eb7','69bd02b7-c711-4d4d-a03b-15d3e88d1932',
 'c1000000-0000-4000-a000-00000000000a',0,'Top products by units sold','table',
 '{"limit": 12}'::jsonb,'{"h": 4, "w": 12, "x": 0, "y": 22}'::jsonb,14)
on conflict (id) do update set
  report_id = excluded.report_id, query_index = excluded.query_index,
  title = excluded.title, visual_type = excluded.visual_type,
  visual_config = excluded.visual_config, layout = excluded.layout,
  sort_order = excluded.sort_order;
