-- A "Start here" tier for the report builder's source rail.
--
-- Curating the rail down to 74 commercial objects removed the finance and HR
-- noise, but it left a second problem: an analyst opening the workbench is
-- choosing between eight sales rollups with no way to tell which is the one
-- to use. sales_by_day, sales_by_day_verification_v,
-- sales_by_product_title_daily_v, sales_sku_location_rollup_v,
-- sales_monthly_*_rollup_v and sales_velocity_* all sound plausible and are
-- for different questions.
--
-- The answer was already written down. The catalog's curated descriptions
-- say which to prefer, in their own words -- "the grain buying decisions are
-- made at. Use this instead of hand-joining", "Use this rather than raw
-- sales_by_day", "Use this (not sales_by_day) for individual orders",
-- "FASTEST path for how fast does this sell". This migration just promotes
-- the objects those descriptions point AT, so the rail leads with them
-- instead of alphabetising everything together.
--
-- Deliberately a soft tier, not another allowlist: priority 0 objects are
-- still listed, still searchable, still usable. This orders the shelf; it
-- does not lock a cupboard. The hard boundary is still RLS, and the
-- commercial-vs-finance line is still `reportable`.

alter table public.silo_chat_schema_catalog
  add column if not exists report_priority smallint not null default 0;

comment on column public.silo_chat_schema_catalog.report_priority is
  'Ordering hint for the /v3/report-builder.html rail: 1 = "Start here", 0 = listed below. Soft -- a 0 object is still offered and searchable. Set from the object''s own curated description, which usually says which source to prefer.';

update public.silo_chat_schema_catalog set report_priority = 0;

update public.silo_chat_schema_catalog set report_priority = 1
 where relname in (
  -- Sales: the four grains worth starting from
  'sales_by_product_title_daily_v',   -- product-title grain, where buying decisions are made
  'sales_by_day_verification_v',      -- de-duped daily, safe across the Better Reports boundary
  'sales_monthly_product_type_rollup_v',
  'sales_velocity_by_sku_location_v',
  'sales_sku_location_rollup_v',
  -- Orders and storefront
  'shopify_orders_v',                 -- order grain with the channel resolved
  'shopify_funnel_daily_v',
  'shopify_discount_codes_daily',     -- affiliate / creator codes
  -- Marketing
  'marketing_daily_totals_v',
  'marketing_campaign_summary_v',
  'marketing_facts_daily_v',
  'v_marketing_mer_daily',            -- ad spend vs online net sales by day
  'meta_ad_performance_v',            -- the only sub-campaign depth there is
  -- Inventory and product
  'inventory_on_hand_current_v',
  'inventory_workboard_v',
  'products_master',
  -- Purchasing and launches
  'v_open_pos',
  'v_po_header_summary',
  'launch_product_actuals_v',
  -- Returns
  'redo_returns'
 );
