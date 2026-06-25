-- Revoke broad PUBLIC/anon grants on admin functions
REVOKE EXECUTE ON FUNCTION public.admin_counts() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_profiles() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_access_requests(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_access_request(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.deny_access_request(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.refresh_inventory_current_mv() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.refresh_sales_verification_store_comp_summary() FROM PUBLIC, anon;

-- Re-grant only to authenticated (is_admin() check inside still gates actual use)
GRANT EXECUTE ON FUNCTION public.admin_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_access_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_access_request(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_access_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_inventory_current_mv() TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_sales_verification_store_comp_summary() TO authenticated;

-- Block direct access to raw materialized views — use security wrapper views instead
REVOKE SELECT ON public.inventory_on_hand_current_mv FROM anon;
GRANT SELECT ON public.inventory_on_hand_current_mv TO authenticated;
REVOKE SELECT ON public.sales_sku_location_rollup_mv FROM anon;
GRANT SELECT ON public.sales_sku_location_rollup_mv TO authenticated;
REVOKE SELECT ON public.sales_monthly_product_type_rollup_mv FROM anon;
GRANT SELECT ON public.sales_monthly_product_type_rollup_mv TO authenticated;
