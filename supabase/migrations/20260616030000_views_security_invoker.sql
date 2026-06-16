-- Make all company-scoped views respect RLS by running as the calling user,
-- not the view owner. Without security_invoker, views bypass RLS on underlying
-- tables even when those tables have active_company_id() policies.
-- Requires Postgres 15+ (Supabase supports this).

alter view if exists public.v_po_header_summary         set (security_invoker = true);
alter view if exists public.v_po_incoming_summary       set (security_invoker = true);
alter view if exists public.v_po_open_planning_lines    set (security_invoker = true);
alter view if exists public.v_po_costing_summary        set (security_invoker = true);
alter view if exists public.v_po_sku_prior_cost         set (security_invoker = true);
alter view if exists public.v_launch_po_product_lookup  set (security_invoker = true);
alter view if exists public.payment_requests_v          set (security_invoker = true);
alter view if exists public.payment_request_activity_v  set (security_invoker = true);
alter view if exists public.inventory_workboard_v       set (security_invoker = true);
