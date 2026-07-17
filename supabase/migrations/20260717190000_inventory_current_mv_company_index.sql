-- inventory_on_hand_current_mv had no index on company_entity_id (only the
-- unique id index) — every request through inventory_on_hand_current_v /
-- inventory_workboard_v (Planning Scenarios' demand-math load, and the
-- Inventory workboard itself) forces a full sequential scan of the whole
-- MV (69k+ rows and growing) before the company filter. Combined with the
-- authenticated role's 8s statement_timeout, this started failing
-- ("canceling statement due to statement timeout") as row counts grew.
--
-- sales_velocity_by_sku_location_mv got its company index when it was
-- scoped in 20260708050000_sales_velocity_mv_company_scope.sql; this MV's
-- company column existed already but was never indexed — this was missed
-- at the time.

create index if not exists inventory_on_hand_current_mv_company_idx
  on public.inventory_on_hand_current_mv (company_entity_id);
