-- Make all company-scoped views respect RLS by running as the calling user,
-- not the view owner. Without security_invoker, views bypass RLS on underlying
-- tables even when those tables have active_company_id() policies.
-- Requires Postgres 15+ (Supabase supports this).
--
-- NOTE: Materialized views (sales_monthly_product_type_rollup_mv,
-- sales_sku_location_rollup_mv) do NOT support security_invoker — they are
-- excluded here. Those underlying tables (sales_by_day) have no company_entity_id
-- backfill yet so they remain open until that backfill is done.

-- PO views
alter view if exists public.v_po_header_summary           set (security_invoker = true);
alter view if exists public.v_po_incoming_summary         set (security_invoker = true);
alter view if exists public.v_po_incoming_lines           set (security_invoker = true);
alter view if exists public.v_po_incoming_product_rollup  set (security_invoker = true);
alter view if exists public.v_po_open_planning_lines      set (security_invoker = true);
alter view if exists public.v_po_costing_summary          set (security_invoker = true);
alter view if exists public.v_po_sku_prior_cost           set (security_invoker = true);
alter view if exists public.v_open_pos                    set (security_invoker = true);

-- Launch views
alter view if exists public.v_launch_po_product_lookup    set (security_invoker = true);
alter view if exists public.v_launch_workflow_summary     set (security_invoker = true);

-- Payment request views
alter view if exists public.payment_requests_v            set (security_invoker = true);
alter view if exists public.payment_request_activity_v    set (security_invoker = true);

-- Product views
alter view if exists public.v_product_sample_summary      set (security_invoker = true);

-- AR views
alter view if exists public.ar_customer_last_contact_v    set (security_invoker = true);
alter view if exists public.ar_customer_queue_summary_v   set (security_invoker = true);
alter view if exists public.ar_customer_rollup_v          set (security_invoker = true);
alter view if exists public.ar_invoice_workbench_v        set (security_invoker = true);
alter view if exists public.ar_sync_status_v              set (security_invoker = true);

-- Payroll views
alter view if exists public.payroll_combined_cost_v       set (security_invoker = true);
alter view if exists public.payroll_department_cost_v     set (security_invoker = true);
alter view if exists public.payroll_employee_cost_v       set (security_invoker = true);
alter view if exists public.payroll_pay_type_summary_v    set (security_invoker = true);
alter view if exists public.payroll_register_bucket_v     set (security_invoker = true);
alter view if exists public.payroll_register_monthly_v    set (security_invoker = true);
alter view if exists public.payroll_time_daily_summary_v  set (security_invoker = true);

-- Sales views (underlying sales_by_day backfill deferred — security_invoker
-- still set so that once backfill + RLS lands, these views are already correct)
alter view if exists public.sales_exception_summary_v          set (security_invoker = true);
alter view if exists public.sales_location_verification_v      set (security_invoker = true);
alter view if exists public.sales_monthly_location_rollup_v    set (security_invoker = true);
alter view if exists public.sales_monthly_product_type_rollup_v set (security_invoker = true);
alter view if exists public.sales_sku_location_rollup_v        set (security_invoker = true);
alter view if exists public.sales_velocity_by_sku_location_v   set (security_invoker = true);

-- Inventory views (inventory_on_hand backfill also deferred)
alter view if exists public.inventory_workboard_v              set (security_invoker = true);
alter view if exists public.inventory_on_hand_current_v        set (security_invoker = true);
