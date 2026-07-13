-- Follow-up to 20260625140000_harden_function_grants_and_matview_access.sql,
-- which revoked anon/PUBLIC execute on admin-only functions but missed these
-- six. Security advisor flags them as anon-executable SECURITY DEFINER
-- functions. Each is actually safe by construction (gated on auth.uid(),
-- which is null for an unauthenticated caller, so they no-op/return
-- false/null rather than leak or mutate anything) — this is defense in
-- depth, not a fix for an active exploit.

REVOKE EXECUTE ON FUNCTION public.active_company_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_enabled() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_sync_mode() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.po_builder_can_write() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.po_costing_can_write() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_active_company(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.active_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_company_shopify_enabled() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_company_shopify_sync_mode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.po_builder_can_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.po_costing_can_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_company(uuid) TO authenticated;
