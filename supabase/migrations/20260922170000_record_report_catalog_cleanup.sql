-- Record the 2026-09-22 SILO report catalog cleanup, and stop a re-run of the
-- seed migrations from undoing it.
--
-- The cleanup was applied to production directly: 21 global SILO reports
-- became 17, three dashboard widgets were reconnected to retained reports,
-- two obsolete widgets were removed, and titles were shortened. Nothing in
-- the repo recorded it, and three seed migrations would reverse it the next
-- time supabase/apply_all_post_merge.sql is re-run (it is re-run for
-- rebuilds and is documented as safe to re-run):
--
--   20260904160000_logistics_reports.sql / 20260904240000_ownership_reports.sql
--     INSERT ... ON CONFLICT (id) DO UPDATE SET title, description, ...
--     -> re-creates the four deleted reports and restores every long title.
--   20260904180000_logistics_dashboard.sql / 20260904260000_ownership_dashboard.sql
--     upsert the seeded widgets (report_id, title, visual_config, layout ...)
--     -> re-creates removed widgets and re-points the reconnected ones at
--        the deleted reports.
--   20260920075344_canned_report_accuracy.sql
--     sets the long "Ownership · ..." / "Logistics · ..." titles by id.
--
-- Editing those files would rewrite history that production already ran.
-- Instead this file runs LAST and re-asserts the production state as of
-- 2026-09-22, so apply_all ends where production is. Every statement is
-- keyed by fixed id and is a no-op against production today.
--
-- Order matters: widgets are re-pointed and pruned BEFORE the retired
-- reports are deleted, so no widget is left pointing at one (the FK is ON
-- DELETE SET NULL, which would otherwise leave a blank tile).

-- 1. Seeded widgets absent in production on 2026-09-22. c2..0c (Logistics
--    "Sell-through by product type") and c4..0a (Ownership "Upcoming
--    launches") are the two the cleanup removed; c4..01 and c4..05 were
--    already gone from the Ownership board, and a seed re-run would have
--    brought them back too.
delete from public.dashboard_widgets
 where id in ('c2000000-0000-4000-a000-00000000000c',
              'c4000000-0000-4000-a000-000000000001',
              'c4000000-0000-4000-a000-000000000005',
              'c4000000-0000-4000-a000-00000000000a');

-- 2. Every remaining seeded widget, exactly as production holds it. Includes
--    the reconnections: c2..0f (Logistics) now reads Top Products
--    5110de50..02, and c4..03 (Ownership) now reads Daily Sales 5110de50..01.
update public.dashboard_widgets set report_id = null, query_index = 0, title = 'Needs a decision', visual_type = 'section', visual_config = '{"note": "Overdue POs and cover that has drifted. Everything below this line is current state, not a period."}'::jsonb, layout = '{"h": 1, "w": 12, "x": 0, "y": 0}'::jsonb, sort_order = 0 where id = 'c2000000-0000-4000-a000-000000000001';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000001', query_index = 0, title = 'Units on hand', visual_type = 'kpi', visual_config = '{"y_field": "units_on_hand", "abbreviate": true}'::jsonb, layout = '{"h": 2, "w": 3, "x": 0, "y": 1}'::jsonb, sort_order = 1 where id = 'c2000000-0000-4000-a000-000000000002';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000001', query_index = 0, title = 'Units on order', visual_type = 'kpi', visual_config = '{"y_field": "units_on_order", "abbreviate": true}'::jsonb, layout = '{"h": 2, "w": 3, "x": 3, "y": 1}'::jsonb, sort_order = 2 where id = 'c2000000-0000-4000-a000-000000000003';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000001', query_index = 0, title = 'Weeks of cover', visual_type = 'kpi', visual_config = '{"y_field": "weeks_of_cover"}'::jsonb, layout = '{"h": 2, "w": 3, "x": 6, "y": 1}'::jsonb, sort_order = 3 where id = 'c2000000-0000-4000-a000-000000000004';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000006', query_index = 0, title = 'Low Stock', visual_type = 'table', visual_config = '{"limit": 8}'::jsonb, layout = '{"h": 2, "w": 3, "x": 9, "y": 1}'::jsonb, sort_order = 4 where id = 'c2000000-0000-4000-a000-000000000005';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000002', query_index = 0, title = 'Overdue Purchase Orders', visual_type = 'table', visual_config = '{"limit": 12, "columns": ["po_name", "factory_name", "status", "expected_arrival_date", "days_late", "total_units"]}'::jsonb, layout = '{"h": 4, "w": 12, "x": 0, "y": 3}'::jsonb, sort_order = 5 where id = 'c2000000-0000-4000-a000-000000000006';
update public.dashboard_widgets set report_id = null, query_index = 0, title = 'Incoming', visual_type = 'section', visual_config = '{}'::jsonb, layout = '{"h": 1, "w": 12, "x": 0, "y": 7}'::jsonb, sort_order = 6 where id = 'c2000000-0000-4000-a000-000000000007';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000003', query_index = 0, title = 'Monthly Arrivals', visual_type = 'bar', visual_config = '{"sort": "none", "x_field": "arrival_month", "y_field": "units_arriving", "show_values": true}'::jsonb, layout = '{"h": 4, "w": 7, "x": 0, "y": 8}'::jsonb, sort_order = 7 where id = 'c2000000-0000-4000-a000-000000000008';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000004', query_index = 0, title = 'PO Units by Factory', visual_type = 'table', visual_config = '{"limit": 10}'::jsonb, layout = '{"h": 4, "w": 5, "x": 7, "y": 8}'::jsonb, sort_order = 8 where id = 'c2000000-0000-4000-a000-000000000009';
update public.dashboard_widgets set report_id = null, query_index = 0, title = 'Cover and sell-through', visual_type = 'section', visual_config = '{}'::jsonb, layout = '{"h": 1, "w": 12, "x": 0, "y": 12}'::jsonb, sort_order = 9 where id = 'c2000000-0000-4000-a000-00000000000a';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000005', query_index = 0, title = 'Stock Cover', visual_type = 'table', visual_config = '{"limit": 14}'::jsonb, layout = '{"h": 5, "w": 7, "x": 0, "y": 13}'::jsonb, sort_order = 10 where id = 'c2000000-0000-4000-a000-00000000000b';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000007', query_index = 0, title = 'Overstock', visual_type = 'table', visual_config = '{"limit": 10}'::jsonb, layout = '{"h": 4, "w": 6, "x": 0, "y": 18}'::jsonb, sort_order = 12 where id = 'c2000000-0000-4000-a000-00000000000d';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000008', query_index = 0, title = 'Stock Without Sales', visual_type = 'table', visual_config = '{"limit": 10, "totals": "row"}'::jsonb, layout = '{"h": 4, "w": 6, "x": 6, "y": 18}'::jsonb, sort_order = 13 where id = 'c2000000-0000-4000-a000-00000000000e';
update public.dashboard_widgets set report_id = '5110de50-0000-4000-a000-000000000002', query_index = 0, title = 'Top Products', visual_type = 'table', visual_config = '{"limit": 12}'::jsonb, layout = '{"h": 4, "w": 12, "x": 0, "y": 22}'::jsonb, sort_order = 14 where id = 'c2000000-0000-4000-a000-00000000000f';
update public.dashboard_widgets set report_id = 'c3000000-0000-4000-a000-000000000001', query_index = 0, title = 'Sales vs Last Year', visual_type = 'table', visual_config = '{"totals": "none"}'::jsonb, layout = '{"h": 4, "w": 8, "x": 0, "y": 0}'::jsonb, sort_order = 0 where id = 'c4000000-0000-4000-a000-000000000002';
update public.dashboard_widgets set report_id = '5110de50-0000-4000-a000-000000000001', query_index = 0, title = 'Net Sales by Day', visual_type = 'line', visual_config = '{"sort": "none", "limit": 0, "x_field": "day_date", "y_field": "net_sales", "aggregate": "sum"}'::jsonb, layout = '{"h": 4, "w": 12, "x": 0, "y": 4}'::jsonb, sort_order = 1 where id = 'c4000000-0000-4000-a000-000000000003';
update public.dashboard_widgets set report_id = 'c3000000-0000-4000-a000-000000000003', query_index = 0, title = 'Sales by Channel', visual_type = 'table', visual_config = '{"limit": 8}'::jsonb, layout = '{"h": 4, "w": 4, "x": 8, "y": 0}'::jsonb, sort_order = 2 where id = 'c4000000-0000-4000-a000-000000000004';
update public.dashboard_widgets set report_id = 'c3000000-0000-4000-a000-000000000005', query_index = 0, title = 'Attribution vs Sales', visual_type = 'table', visual_config = '{}'::jsonb, layout = '{"h": 3, "w": 6, "x": 4, "y": 8}'::jsonb, sort_order = 3 where id = 'c4000000-0000-4000-a000-000000000006';
update public.dashboard_widgets set report_id = 'c3000000-0000-4000-a000-000000000004', query_index = 0, title = 'Ads by Platform', visual_type = 'kpi', visual_config = '{"sort": "desc", "limit": 8, "x_field": "platform", "y_field": "spend", "aggregate": "sum", "abbreviate": true}'::jsonb, layout = '{"h": 3, "w": 4, "x": 0, "y": 8}'::jsonb, sort_order = 4 where id = 'c4000000-0000-4000-a000-000000000007';
update public.dashboard_widgets set report_id = 'c3000000-0000-4000-a000-000000000006', query_index = 0, title = 'Marketing Efficiency', visual_type = 'line', visual_config = '{"sort": "none", "limit": 0, "x_field": "day_date", "y_field": "online_net_sales", "measures": ["ad_spend", "online_net_sales"]}'::jsonb, layout = '{"h": 4, "w": 12, "x": 0, "y": 11}'::jsonb, sort_order = 5 where id = 'c4000000-0000-4000-a000-000000000008';
update public.dashboard_widgets set report_id = null, query_index = 0, title = 'What is coming', visual_type = 'section', visual_config = '{"note": "Launches ahead, and the stock and purchase orders behind them. Detail lives on the Logistics board."}'::jsonb, layout = '{"h": 1, "w": 12, "x": 0, "y": 15}'::jsonb, sort_order = 6 where id = 'c4000000-0000-4000-a000-000000000009';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000001', query_index = 0, title = 'Units on hand', visual_type = 'kpi', visual_config = '{"y_field": "units_on_hand", "abbreviate": true}'::jsonb, layout = '{"h": 2, "w": 3, "x": 7, "y": 16}'::jsonb, sort_order = 8 where id = 'c4000000-0000-4000-a000-00000000000b';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000001', query_index = 0, title = 'Units on order', visual_type = 'kpi', visual_config = '{"y_field": "units_on_order", "abbreviate": true}'::jsonb, layout = '{"h": 2, "w": 2, "x": 10, "y": 16}'::jsonb, sort_order = 9 where id = 'c4000000-0000-4000-a000-00000000000c';
update public.dashboard_widgets set report_id = 'c1000000-0000-4000-a000-000000000002', query_index = 0, title = 'Overdue Purchase Orders', visual_type = 'table', visual_config = '{"limit": 5, "columns": ["po_name", "factory_name", "days_late", "total_units"]}'::jsonb, layout = '{"h": 7, "w": 5, "x": 7, "y": 18}'::jsonb, sort_order = 10 where id = 'c4000000-0000-4000-a000-00000000000d';

-- 3. The four retired SILO reports. Their tie-outs go with them (ON DELETE
--    CASCADE). Scoped to global system rows so a same-id row of any other
--    kind is never touched.
--
--    Deleted ONLY while no widget references them. Step 2 re-points every
--    SEEDED widget, but any user can add one of these reports to their own
--    board (the Add insight picker stores the report id directly), and the
--    FK is ON DELETE SET NULL -- deleting under such a widget would blank it
--    with "No saved report attached". A still-used definition is KEPT, and
--    verify_v2_schema.sql's retired_silo_reports check names it as STALE
--    until those widgets are moved. Production had no such widget on
--    2026-09-22 (measured), so there this deletes nothing (the rows are
--    already gone) and on a re-run it deletes exactly what the seeds
--    re-created.
--      c1..09  Sales Relative to Current Stock (Logistics · Sell-through by product type)
--      c1..0a  Logistics Top Products          (Top products by units sold)
--      c3..02  Ownership Net Sales by Day      (Daily Sales covers it)
--      c3..07  Upcoming Launches
delete from public.silo_chat_saved_reports
 where id in ('c1000000-0000-4000-a000-000000000009',
              'c1000000-0000-4000-a000-00000000000a',
              'c3000000-0000-4000-a000-000000000002',
              'c3000000-0000-4000-a000-000000000007')
   and source = 'system' and company_entity_id is null
   and not exists (select 1 from public.dashboard_widgets w
                    where w.report_id = silo_chat_saved_reports.id);

-- 4. The 17 retained SILO reports' shortened titles and current definitions.
update public.silo_chat_saved_reports set title = 'Daily Sales', description = 'Daily canonical net sales, units and distinct non-cancelled orders. Defaults to 60 completed company-calendar days. A blank measure means that source has no rows for the day.' where id = '5110de50-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Top Products', description = 'Top 50 products by units over 30 completed company-calendar days by default. Product-title data reflects the last rollup refresh. Order counts are summed product-line counts, not distinct customer orders.' where id = '5110de50-0000-4000-a000-000000000002' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Sales by Location', description = 'Canonical net sales and units by location. Defaults to 30 completed company-calendar days.' where id = '5110de50-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Open Purchase Orders', description = 'Purchase orders not yet received, closed or cancelled, soonest expected arrival first.' where id = '5110de50-0000-4000-a000-000000000004' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Inventory Summary', description = 'Current on-hand and confirmed incoming stock, including types without PO history. Cover uses trailing annual demand; combined cover includes incoming units. Blank cover means velocity is unknown or nonpositive.' where id = 'c1000000-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Overdue Purchase Orders', description = 'Open POs whose expected arrival has passed and which have not been received.' where id = 'c1000000-0000-4000-a000-000000000002' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Monthly Arrivals', description = 'Units on open purchase orders, grouped by expected arrival month.' where id = 'c1000000-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'PO Units by Factory', description = 'Units on open purchase orders by factory, largest first.' where id = 'c1000000-0000-4000-a000-000000000004' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Stock Cover', description = 'Stock by product type, including types without PO history or a minimum sales threshold. On-hand cover excludes incoming stock; combined cover includes it. Blank cover means unknown demand.' where id = 'c1000000-0000-4000-a000-000000000005' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Low Stock', description = 'Types with less than the selected weeks of stock on hand at trailing annual demand. Incoming stock is shown separately and cannot hide a current shortage. Unknown-demand types remain in Stock Cover.' where id = 'c1000000-0000-4000-a000-000000000006' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Overstock', description = 'Types with at least a year of stock on hand and declining demand. Incoming stock is shown separately. Includes types without PO history.' where id = 'c1000000-0000-4000-a000-000000000007' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Stock Without Sales', description = 'Stock with no recorded sales in the source’s rolling 30-day window. Every included product/location row must have matched velocity. Includes sales at zero-stock locations when qualifying products; this is not a stock-age or write-off recommendation.' where id = 'c1000000-0000-4000-a000-000000000008' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Sales vs Last Year', description = 'Canonical sales vs the same calendar dates last year, through the selected completed day (yesterday by default). Orders follow the company time zone. Leap-day comparisons use PostgreSQL calendar-year arithmetic.' where id = 'c3000000-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Sales by Channel', description = 'Distinct orders and discounted merchandise subtotal by channel, excluding cancelled orders, tax and shipping. Refunds are not netted here; this is not net sales. Defaults to 28 completed company-calendar days.' where id = 'c3000000-0000-4000-a000-000000000003' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Ads by Platform', description = 'Paid-platform claims including attribution received on zero-spend days; GA4 excluded. Platforms may claim the same sale. Defaults to 28 completed company-calendar days.' where id = 'c3000000-0000-4000-a000-000000000004' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Attribution vs Sales', description = 'Platform-attributed sales compared with canonical online net sales. Attribution is not additive across platforms. Cross-source ratios stay blank when days are missing from either source. Defaults to 28 completed company-calendar days.' where id = 'c3000000-0000-4000-a000-000000000005' and source = 'system' and company_entity_id is null;
update public.silo_chat_saved_reports set title = 'Marketing Efficiency', description = 'Canonical online net sales divided by paid ad spend, by company-calendar day. Missing source rows remain blank, not zero. Defaults to 28 completed days.' where id = 'c3000000-0000-4000-a000-000000000006' and source = 'system' and company_entity_id is null;

-- 5. The two seeded dashboards' names and settings (the seeds upsert these too).
update public.dashboards set name = 'Logistics', description = 'Purchase orders, inventory cover and sell-through.', visibility = 'company', filter_state = '{"date_from": "today-28d", "min_units": 200, "cover_weeks": 26}'::jsonb where id = 'da5b0a2d-0000-4000-a000-00000000000c';
update public.dashboards set name = 'Ownership', description = 'How the business is tracking: sales against last year, channel mix, paid media, what is coming.', visibility = 'private', filter_state = '{"date_from": "month_start"}'::jsonb where id = 'da5b0a2d-0000-4000-a000-00000000000e';
