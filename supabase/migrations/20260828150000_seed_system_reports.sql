-- Four central SILO report definitions, so dashboards have something to
-- build on that did not come from Ask SILO.
--
-- These are the first source='system' rows: company_entity_id IS NULL, one
-- definition reused by every tenant. That is safe because the stored SQL is
-- executed through chat_run_readonly_query, which is SECURITY INVOKER --
-- each viewer's own RLS decides which rows come back, so one definition
-- scopes itself per company. No client can create, edit or delete these
-- (see the three locks in 20260828130000); they are migration-owned.
--
-- ── Why these four, and why these sources ─────────────────────────────
-- Every definition below reads a `security_invoker` view or an RLS-enabled
-- base table, and NOT a materialized view. That is deliberate and it is
-- the one rule to keep when adding more: **Postgres does not enforce RLS on
-- materialized views**. sales_velocity_by_sku_location_mv,
-- inventory_on_hand_current_mv and sales_monthly_product_type_rollup_mv all
-- carry company_entity_id but none of them can filter on it by policy, so a
-- global definition querying one would return every tenant's rows to every
-- tenant. If a future system report genuinely needs a matview for speed, it
-- must carry an explicit `where company_entity_id = active_company_id()`.
--
-- inventory_workboard_v is avoided for a different reason: it rebuilds a
-- ~3.47M-row snapshot per query and already exceeds the 30s statement
-- timeout (see the CLAUDE.md note). A seeded definition that times out on
-- every load is worse than no definition.
--
-- ── columns_metadata ships with the definition ────────────────────────
-- Each row states what its columns MEAN, so a dashboard formats them right
-- on the first render without waiting on the schema catalog or falling back
-- to guessing from names. This is the "authored" case the column was added
-- for in 20260828140000.
--
-- ── Idempotency ───────────────────────────────────────────────────────
-- Fixed UUIDs plus `on conflict (id) do nothing`. Deliberately NOT
-- `do update`: apply_all_post_merge.sql is re-run for rebuilds, and a
-- do-update would silently discard any correction someone made to a
-- definition's SQL or its column semantics. Changing a shipped definition
-- is its own migration with an explicit UPDATE.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer, queries_run, columns_metadata)
values
  -- 1. Daily Sales — the shape a line chart is for.
  ('5110de50-0000-4000-a000-000000000001', null, null, 'system', 'company',
   'Daily Sales',
   'Net sales, units and orders per day for the last 60 days. Every sales channel.',
   null, null,
   array[$q$
     select day_date,
            sum(net_sales)  as net_sales,
            sum(units_sold) as units_sold,
            sum(orders)     as orders
       from sales_by_product_title_daily_v
      where day_date >= current_date - 60
      group by day_date
      order by day_date
   $q$],
   '{"day_date":{"semantic":"date","source":"authored"},
     "net_sales":{"semantic":"currency","source":"authored"},
     "units_sold":{"semantic":"count","source":"authored"},
     "orders":{"semantic":"count","source":"authored"}}'::jsonb),

  -- 2. Top Products — a ranking, so it wants a bar, not a donut.
  --
  -- Package Protection is excluded: it is the Redo checkout line item
  -- (sku 'x-redo'), not merchandise, and it outsells most real products by
  -- order count. sales_by_product_title_daily_v has already collapsed sku,
  -- so the exclusion is by title. If Redo's line item is ever renamed this
  -- filter stops matching -- that is a visible wrong entry at the top of a
  -- list, not a silent error, and it is fixable in one place.
  ('5110de50-0000-4000-a000-000000000002', null, null, 'system', 'company',
   'Top Products — last 30 days',
   'Best-selling products by units over the last 30 days, excluding Package Protection.',
   null, null,
   array[$q$
     select product_title,
            sum(units_sold) as units_sold,
            sum(net_sales)  as net_sales,
            sum(orders)     as orders
       from sales_by_product_title_daily_v
      where day_date >= current_date - 30
        and product_title not ilike '%package protection%'
      group by product_title
      order by units_sold desc
      limit 50
   $q$],
   '{"product_title":{"semantic":"category","source":"authored"},
     "units_sold":{"semantic":"count","source":"authored"},
     "net_sales":{"semantic":"currency","source":"authored"},
     "orders":{"semantic":"count","source":"authored"}}'::jsonb),

  -- 3. Sales by Location — few categories summing to a whole, which is the
  -- one shape a donut is honestly for.
  ('5110de50-0000-4000-a000-000000000003', null, null, 'system', 'company',
   'Sales by Location — last 30 days',
   'Net sales split by sales channel / location over the last 30 days.',
   null, null,
   array[$q$
     select coalesce(location_tag, 'Unknown') as location_tag,
            sum(net_sales)  as net_sales,
            sum(units_sold) as units_sold
       from sales_by_product_title_daily_v
      where day_date >= current_date - 30
      group by 1
      order by net_sales desc
   $q$],
   '{"location_tag":{"semantic":"category","source":"authored"},
     "net_sales":{"semantic":"currency","source":"authored"},
     "units_sold":{"semantic":"count","source":"authored"}}'::jsonb),

  -- 4. Open Purchase Orders — a list, so it stays a table.
  -- Status vocabulary comes from the PO Builder's own STATUSES array;
  -- "open" is everything that has not landed or been abandoned.
  ('5110de50-0000-4000-a000-000000000004', null, null, 'system', 'company',
   'Open Purchase Orders',
   'Purchase orders not yet received, closed or cancelled, soonest expected arrival first.',
   null, null,
   array[$q$
     select po_name,
            factory_name,
            status,
            order_date,
            expected_arrival_date,
            total_units,
            total_estimated_cost
       from v_po_header_summary
      where coalesce(status, '') not in ('Received', 'Closed', 'Cancelled')
      order by expected_arrival_date nulls last
   $q$],
   '{"po_name":{"semantic":"category","source":"authored"},
     "factory_name":{"semantic":"category","source":"authored"},
     "status":{"semantic":"category","source":"authored"},
     "order_date":{"semantic":"date","source":"authored"},
     "expected_arrival_date":{"semantic":"date","source":"authored"},
     "total_units":{"semantic":"count","source":"authored"},
     "total_estimated_cost":{"semantic":"currency","source":"authored"}}'::jsonb)
on conflict (id) do nothing;
