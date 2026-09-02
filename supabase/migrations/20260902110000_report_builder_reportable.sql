-- Curate what the report builder's source rail offers.
--
-- /v3/report-builder.html listed every non-hidden object in the schema
-- catalog -- 189 of them, including AR, payroll, comp adjustments, journals,
-- fixed assets, QuickBooks, performance reviews and the chat audit log. That
-- is a workbench for commercial reporting, not a database browser, and the
-- finance and HR surfaces do not belong in it.
--
-- ── Why a new column and not is_hidden ────────────────────────────────
-- is_hidden means "noise or credentials -- keep it out of the model's
-- index". Ask SILO still NEEDS payroll and comp tables: someone legitimately
-- asks it about headcount cost. Reusing is_hidden here would blind Ask SILO
-- to answer questions it is supposed to answer. Two different intents, so
-- two different flags.
--
-- ── Why the default is FALSE ──────────────────────────────────────────
-- An allowlist, not a denylist. A denylist means the next finance or HR
-- table someone adds shows up in the workbench automatically and nobody
-- notices until it is on a dashboard. Defaulting to false means a new object
-- stays out until someone deliberately lets it in -- one UPDATE, and the
-- failure mode is "a useful table is missing" (visible, someone asks) rather
-- than "payroll is browsable" (invisible until it is not).
--
-- refresh_chat_schema_catalog() only updates relkind/columns/timestamps on
-- conflict, so this curation survives every refresh. New objects it inserts
-- take the default and stay out.
--
-- ── This is curation, not a security boundary ─────────────────────────
-- RLS remains the boundary, as everywhere else. The SQL tab can still name
-- any object, and a person who does gets exactly the rows their own policies
-- allow -- comp_adjustment_requests returns nothing to someone who is not
-- finance or the employee's manager. This flag decides what is OFFERED, so
-- the rail reads like a reporting tool instead of a schema dump.

alter table public.silo_chat_schema_catalog
  add column if not exists reportable boolean not null default false;

comment on column public.silo_chat_schema_catalog.reportable is
  'Offer this object in the /v3/report-builder.html source rail. Allowlist: default false, so a newly synced table stays out until someone opts it in. Curation only -- RLS is still the boundary, and the SQL tab can name anything. Distinct from is_hidden, which controls what Ask SILO''s model index sees.';

update public.silo_chat_schema_catalog set reportable = false;

update public.silo_chat_schema_catalog set reportable = true
 where relname in (
  -- Sales
  'sales_by_day', 'sales_by_day_verification_v', 'sales_by_product_title_daily_v',
  'sales_exception_summary_v', 'sales_location_verification_v',
  'sales_monthly_location_rollup_v', 'sales_monthly_product_type_rollup_v',
  'sales_sku_location_rollup_v', 'sales_velocity_by_sku_location_v',
  'sales_verification_store_comp_summary',
  'wow_sales_daily_type_v', 'wow_sales_daily_type_mv', 'wow_report_entries',
  -- Shopify order/session/funnel detail
  'shopify_orders', 'shopify_orders_v', 'shopify_order_lines',
  'shopify_customer_metrics_daily', 'shopify_discount_codes_daily',
  'shopify_draft_orders', 'shopify_funnel_daily_v', 'shopify_landing_pages_daily',
  'shopify_sessions_daily', 'shopify_channel_map',
  -- Marketing, paid and organic
  'marketing_kpis_daily', 'marketing_campaign_bank', 'marketing_campaign_summary_v',
  'marketing_daily_totals_v', 'marketing_facts_daily_v', 'v_marketing_mer_daily',
  'meta_ad_creatives', 'meta_ad_performance_daily', 'meta_ad_performance_v',
  'facebook_page_insights_daily', 'instagram_media_insights',
  -- Product and inventory
  'products_master', 'product_tags', 'product_tracker',
  'product_samples_v', 'v_product_sample_summary',
  'inventory_on_hand', 'inventory_on_hand_current_v', 'inventory_workboard_v',
  'demand_coverage_by_type_v',
  -- Launches
  'launch_calendar', 'launch_actuals_v', 'launch_product_actuals_v',
  'launch_product_sales_v', 'launch_measurability_v', 'launch_product_readiness',
  'launch_channel_items', 'launch_tasks',
  'v_launch_po_product_lookup', 'v_launch_workflow_summary',
  -- Purchasing and landed cost: product operations, not accounting
  'po_headers', 'po_lines', 'factories', 'po_costing', 'po_costing_lines',
  'v_po_header_summary', 'v_open_pos', 'v_po_incoming_lines', 'v_po_incoming_summary',
  'v_po_incoming_product_rollup', 'v_po_open_planning_lines', 'v_po_shipment_lines',
  'v_po_costing_summary', 'v_po_sku_prior_cost',
  'incoming_shipments', 'incoming_shipment_lines',
  -- Returns, channels, planning
  'redo_returns', 'redo_return_items',
  'locations', 'revenue_projections', 'live_sessions_v'
 );
