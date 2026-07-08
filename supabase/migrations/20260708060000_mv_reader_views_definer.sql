-- The company-filtered MV reader views must be DEFINER views: with
-- security_invoker=true the invoking user needs SELECT on the MV itself,
-- which defeats locking the MVs down (20260708040000/050000 revoked the MV
-- grants and the workbench/planning pages promptly broke with "permission
-- denied for materialized view"). Definer views read the MV with owner
-- rights while the active_company_id() filter in the view body still scopes
-- rows per session user (auth.uid() resolves from the request JWT either
-- way). These views read ONLY materialized views — no RLS-bearing tables —
-- so definer semantics widen nothing.
--
-- Also closes a pre-existing hole found while decoding pg_class.relacl
-- (information_schema does not report matview grants — earlier audits were
-- blind here): inventory_on_hand_current_mv still granted anon AND
-- authenticated FULL privileges, i.e. a direct PostgREST cross-company read
-- path around the filtered view.

alter view public.sales_velocity_by_sku_location_v set (security_invoker = false);
alter view public.sales_monthly_product_type_rollup_v set (security_invoker = false);
alter view public.inventory_on_hand_current_v set (security_invoker = false);

revoke all on public.inventory_on_hand_current_mv from anon, authenticated, public;
revoke all on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
revoke all on public.sales_monthly_product_type_rollup_mv from anon, authenticated, public;
grant select on public.inventory_on_hand_current_mv to service_role;

grant select on public.inventory_on_hand_current_v to authenticated;
grant select on public.sales_velocity_by_sku_location_v to authenticated;
grant select on public.sales_monthly_product_type_rollup_v to authenticated;
grant select on public.inventory_workboard_v to authenticated;
