-- Reporting fixes from the 2026-09-25 UI walkthrough.
--
-- ── 1. Two indexes: the Overview's sales tiles were timing out ─────────────
-- `authenticated` runs with an 8s statement_timeout, and the SILO Overview
-- fires several sales queries at once. Measured on production as a
-- Baseballism admin, before -> after (applied by hand 2026-09-25 with
-- CREATE INDEX CONCURRENTLY; `if not exists` makes this file a no-op there):
--
--   shopify_orders by processed time, 21 months      9.9s -> 0.7s
--     No index covered shopify_processed_at, so every order count (Daily
--     Sales, Sales vs Last Year, Sales by Channel) scanned the company's
--     ~660k orders through the (company, source_name) index and filtered.
--   sales_by_day_verification_v, 21 months           9.9s -> 0.34s
--     Sales vs Last Year reads ~800k daily rows. The covering index turns
--     that into an index-only scan; it carries exactly the columns the view's
--     dedupe filter (source, location_tag) and the SILO sales reports read.
--
-- A VACUUM ANALYZE on shopify_orders was also needed for the first to reach
-- its speed (an index-only-style read wants a current visibility map);
-- autovacuum keeps that current from here.
create index if not exists shopify_orders_co_processed_idx
  on public.shopify_orders (company_entity_id, shopify_processed_at) include (cancelled_at);

create index if not exists sales_by_day_co_day_cover_idx
  on public.sales_by_day (company_entity_id, day_date)
  include (source, location_tag, total_net_sales, total_quantity_sold, total_refunds);

-- ── 2. Marketing Efficiency charts MER, not ad spend ───────────────────────
-- The automatic recommendation ranks money above plain numbers, so the
-- report's preview chart plotted Ad Spend under a title about efficiency.
-- `chart_primary` (read by v3/js/report-preview.js) names the column to plot.
update public.silo_chat_saved_reports
   set columns_metadata = jsonb_set(coalesce(columns_metadata, '{}'::jsonb), '{mer,chart_primary}', 'true'::jsonb, true)
 where id = 'c3000000-0000-4000-a000-000000000006'
   and columns_metadata ? 'mer'
   and coalesce((columns_metadata #>> '{mer,chart_primary}')::boolean, false) is distinct from true;

-- ── 3. The Overview's sales note says what the dates actually drive ────────
-- From/Through move the period tiles; Sales vs Last Year compares fixed
-- periods (yesterday, 7 days, MTD, YTD) ending on its own As of date. The
-- note claimed one control moved every tile.
update public.dashboard_widgets
   set visual_config = jsonb_set(visual_config, '{note}',
         to_jsonb('Completed days only. From and Through move the period tiles; Sales vs last year compares yesterday, 7 days, month and year to date, ending on As of.'::text))
 where id = '5110da5b-0000-4000-a001-000000000001';
