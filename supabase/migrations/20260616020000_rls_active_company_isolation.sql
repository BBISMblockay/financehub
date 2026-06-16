-- ============================================================
-- Active-company isolation via profiles.active_company_id
--
-- Replaces is_entity_member() approach with a server-side
-- "active company" stored per user in profiles. RLS on every
-- company-scoped table checks company_entity_id = active_company_id().
--
-- Multi-company users only see data for the company they picked,
-- not all companies they belong to.
--
-- Apply to Supabase SQL editor (run as postgres / service role).
-- ============================================================

-- ── 1. Add active_company_id to profiles ────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_company_id uuid REFERENCES public.entities(id);

-- Backfill all existing users with Baseballism
UPDATE public.profiles
SET active_company_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
WHERE active_company_id IS NULL;

-- ── 2. Helper: returns current user's active company id ──────
CREATE OR REPLACE FUNCTION public.active_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT active_company_id FROM public.profiles WHERE id = auth.uid();
$$;

-- ── 3. RPC: set active company (validates membership) ────────
CREATE OR REPLACE FUNCTION public.set_active_company(p_entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.entity_memberships
    WHERE entity_id = p_entity_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this company';
  END IF;
  UPDATE public.profiles SET active_company_id = p_entity_id WHERE id = auth.uid();
END;
$$;

-- ── 4. Drop all previous is_entity_member-based policies ─────
-- (replaced below with active_company_id() versions)

-- factories
DROP POLICY IF EXISTS "factories_company_select" ON public.factories;
DROP POLICY IF EXISTS "factories_company_write"  ON public.factories;

-- po_headers
DROP POLICY IF EXISTS "po_headers_company_select" ON public.po_headers;
DROP POLICY IF EXISTS "po_headers_company_insert" ON public.po_headers;
DROP POLICY IF EXISTS "po_headers_company_update" ON public.po_headers;
DROP POLICY IF EXISTS "po_headers_company_delete" ON public.po_headers;

-- po_lines
DROP POLICY IF EXISTS "po_lines_company_select" ON public.po_lines;
DROP POLICY IF EXISTS "po_lines_company_insert" ON public.po_lines;
DROP POLICY IF EXISTS "po_lines_company_update" ON public.po_lines;
DROP POLICY IF EXISTS "po_lines_company_delete" ON public.po_lines;

-- products_master
DROP POLICY IF EXISTS "products_master_company_select" ON public.products_master;
DROP POLICY IF EXISTS "products_master_company_write"  ON public.products_master;

-- locations
DROP POLICY IF EXISTS "locations_company_select" ON public.locations;
DROP POLICY IF EXISTS "locations_company_write"  ON public.locations;
DROP POLICY IF EXISTS "locations_company_insert" ON public.locations;
DROP POLICY IF EXISTS "locations_company_update" ON public.locations;
DROP POLICY IF EXISTS "locations_company_delete" ON public.locations;

-- revenue_projections
DROP POLICY IF EXISTS "revenue_projections_company_select" ON public.revenue_projections;
DROP POLICY IF EXISTS "revenue_projections_company_write"  ON public.revenue_projections;
DROP POLICY IF EXISTS "revenue_projections_company_insert" ON public.revenue_projections;
DROP POLICY IF EXISTS "revenue_projections_company_update" ON public.revenue_projections;
DROP POLICY IF EXISTS "revenue_projections_company_delete" ON public.revenue_projections;

-- revenue_projection_history
DROP POLICY IF EXISTS "revenue_projection_history_company_select" ON public.revenue_projection_history;

-- launch tables
DROP POLICY IF EXISTS "launch_calendar_company_select" ON public.launch_calendar;
DROP POLICY IF EXISTS "launch_calendar_company_insert" ON public.launch_calendar;
DROP POLICY IF EXISTS "launch_calendar_company_update" ON public.launch_calendar;
DROP POLICY IF EXISTS "launch_calendar_company_delete" ON public.launch_calendar;
DROP POLICY IF EXISTS "launch_tasks_company_select"    ON public.launch_tasks;
DROP POLICY IF EXISTS "launch_tasks_company_write"     ON public.launch_tasks;
DROP POLICY IF EXISTS "launch_assets_company_select"   ON public.launch_assets;
DROP POLICY IF EXISTS "launch_assets_company_write"    ON public.launch_assets;
DROP POLICY IF EXISTS "launch_comments_company_select" ON public.launch_comments;
DROP POLICY IF EXISTS "launch_comments_company_insert" ON public.launch_comments;
DROP POLICY IF EXISTS "launch_comments_company_update" ON public.launch_comments;
DROP POLICY IF EXISTS "launch_comments_company_delete" ON public.launch_comments;
DROP POLICY IF EXISTS "launch_channel_items_company_select" ON public.launch_channel_items;
DROP POLICY IF EXISTS "launch_channel_items_company_write"  ON public.launch_channel_items;
DROP POLICY IF EXISTS "launch_system_links_company_select"  ON public.launch_system_links;
DROP POLICY IF EXISTS "launch_system_links_company_write"   ON public.launch_system_links;
DROP POLICY IF EXISTS "launch_product_readiness_company_select" ON public.launch_product_readiness;
DROP POLICY IF EXISTS "launch_product_readiness_company_write"  ON public.launch_product_readiness;

-- payment_requests
DROP POLICY IF EXISTS "payment_requests_company_select" ON public.payment_requests;

-- po_costing
DROP POLICY IF EXISTS "po_costing_company_select" ON public.po_costing;
DROP POLICY IF EXISTS "po_costing_company_write"  ON public.po_costing;
DROP POLICY IF EXISTS "po_costing_lines_company_select" ON public.po_costing_lines;
DROP POLICY IF EXISTS "po_costing_lines_company_write"  ON public.po_costing_lines;

-- ar tables
DROP POLICY IF EXISTS "ar_customers_company_select"  ON public.ar_customers;
DROP POLICY IF EXISTS "ar_customers_company_write"   ON public.ar_customers;
DROP POLICY IF EXISTS "ar_invoices_company_select"   ON public.ar_invoices;
DROP POLICY IF EXISTS "ar_invoices_company_write"    ON public.ar_invoices;
DROP POLICY IF EXISTS "ar_statements_company_select" ON public.ar_statements;
DROP POLICY IF EXISTS "ar_statements_company_write"  ON public.ar_statements;

-- second-batch tables (may or may not exist depending on whether user ran that SQL)
DROP POLICY IF EXISTS "ar_action_queue_company_select"              ON public.ar_action_queue;
DROP POLICY IF EXISTS "ar_action_queue_company_write"               ON public.ar_action_queue;
DROP POLICY IF EXISTS "ar_contact_log_company_select"               ON public.ar_contact_log;
DROP POLICY IF EXISTS "ar_contact_log_company_write"                ON public.ar_contact_log;
DROP POLICY IF EXISTS "incoming_shipments_company_select"           ON public.incoming_shipments;
DROP POLICY IF EXISTS "incoming_shipments_company_insert"           ON public.incoming_shipments;
DROP POLICY IF EXISTS "incoming_shipments_company_update"           ON public.incoming_shipments;
DROP POLICY IF EXISTS "intern_workbench_company_select"             ON public.intern_workbench_items;
DROP POLICY IF EXISTS "intern_workbench_company_write"              ON public.intern_workbench_items;
DROP POLICY IF EXISTS "marketing_campaign_bank_company_select"      ON public.marketing_campaign_bank;
DROP POLICY IF EXISTS "marketing_campaign_bank_company_write"       ON public.marketing_campaign_bank;
DROP POLICY IF EXISTS "payment_request_activity_company_select"     ON public.payment_request_activity;
DROP POLICY IF EXISTS "payment_request_activity_company_insert"     ON public.payment_request_activity;
DROP POLICY IF EXISTS "payment_request_files_company_select"        ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_company_insert"        ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_company_update"        ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_company_delete"        ON public.payment_request_files;
DROP POLICY IF EXISTS "payroll_import_batches_company_all"          ON public.payroll_import_batches;
DROP POLICY IF EXISTS "payroll_register_lines_company_all"          ON public.payroll_register_lines;
DROP POLICY IF EXISTS "payroll_time_lines_company_all"              ON public.payroll_time_lines;
DROP POLICY IF EXISTS "po_sequences_company_all"                    ON public.po_sequences;
DROP POLICY IF EXISTS "po_status_history_company_all"               ON public.po_status_history;
DROP POLICY IF EXISTS "product_samples_company_select"              ON public.product_samples;
DROP POLICY IF EXISTS "product_samples_company_write"               ON public.product_samples;
DROP POLICY IF EXISTS "product_sample_activity_company_all"         ON public.product_sample_activity;
DROP POLICY IF EXISTS "product_tracker_company_select"              ON public.product_tracker;
DROP POLICY IF EXISTS "product_tracker_company_write"               ON public.product_tracker;
DROP POLICY IF EXISTS "sales_verification_company_select"           ON public.sales_verification_store_comp_summary;
DROP POLICY IF EXISTS "saved_views_company_select"                  ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_company_write"                   ON public.saved_views;

-- also drop any leftover broad policies not yet replaced
DROP POLICY IF EXISTS "ar_action_queue_read_authenticated"          ON public.ar_action_queue;
DROP POLICY IF EXISTS "ar_action_queue_write_owner_admin"           ON public.ar_action_queue;
DROP POLICY IF EXISTS "ar_contact_log_read_authenticated"           ON public.ar_contact_log;
DROP POLICY IF EXISTS "ar_contact_log_write_owner_admin"            ON public.ar_contact_log;
DROP POLICY IF EXISTS "incoming_shipments_select"                   ON public.incoming_shipments;
DROP POLICY IF EXISTS "incoming_shipments_insert"                   ON public.incoming_shipments;
DROP POLICY IF EXISTS "incoming_shipments_update"                   ON public.incoming_shipments;
DROP POLICY IF EXISTS "intern workbench select own or admin"        ON public.intern_workbench_items;
DROP POLICY IF EXISTS "intern workbench insert own"                 ON public.intern_workbench_items;
DROP POLICY IF EXISTS "intern workbench update own or admin"        ON public.intern_workbench_items;
DROP POLICY IF EXISTS "intern workbench delete admin only"          ON public.intern_workbench_items;
DROP POLICY IF EXISTS "marketing campaign bank read authenticated"   ON public.marketing_campaign_bank;
DROP POLICY IF EXISTS "marketing campaign bank insert authenticated" ON public.marketing_campaign_bank;
DROP POLICY IF EXISTS "marketing campaign bank update authenticated" ON public.marketing_campaign_bank;
DROP POLICY IF EXISTS "payment_request_activity_select"             ON public.payment_request_activity;
DROP POLICY IF EXISTS "payment_request_activity_insert"             ON public.payment_request_activity;
DROP POLICY IF EXISTS "payment_request_files_select_internal"       ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_insert_own"            ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_update_internal"       ON public.payment_request_files;
DROP POLICY IF EXISTS "payment_request_files_delete_internal"       ON public.payment_request_files;
DROP POLICY IF EXISTS "payroll_batches_finance_all"                 ON public.payroll_import_batches;
DROP POLICY IF EXISTS "payroll_register_lines_finance_all"          ON public.payroll_register_lines;
DROP POLICY IF EXISTS "payroll_time_lines_finance_all"              ON public.payroll_time_lines;
DROP POLICY IF EXISTS "PO sequences admin owner select"             ON public.po_sequences;
DROP POLICY IF EXISTS "PO sequences admin owner insert"             ON public.po_sequences;
DROP POLICY IF EXISTS "PO sequences admin owner update"             ON public.po_sequences;
DROP POLICY IF EXISTS "PO sequences admin owner delete"             ON public.po_sequences;
DROP POLICY IF EXISTS "PO status history admin owner select"        ON public.po_status_history;
DROP POLICY IF EXISTS "Admins can read po status history"           ON public.po_status_history;
DROP POLICY IF EXISTS "PO status history admin owner insert"        ON public.po_status_history;
DROP POLICY IF EXISTS "Admins can insert po status history"         ON public.po_status_history;
DROP POLICY IF EXISTS "PO status history admin owner update"        ON public.po_status_history;
DROP POLICY IF EXISTS "Admins can update po status history"         ON public.po_status_history;
DROP POLICY IF EXISTS "PO status history admin owner delete"        ON public.po_status_history;
DROP POLICY IF EXISTS "Admins can delete po status history"         ON public.po_status_history;
DROP POLICY IF EXISTS "samples_select"                              ON public.product_samples;
DROP POLICY IF EXISTS "samples_write"                               ON public.product_samples;
DROP POLICY IF EXISTS "product_tracker_select"                      ON public.product_tracker;
DROP POLICY IF EXISTS "product_tracker_insert"                      ON public.product_tracker;
DROP POLICY IF EXISTS "product_tracker_update"                      ON public.product_tracker;
DROP POLICY IF EXISTS "product_tracker_delete"                      ON public.product_tracker;
DROP POLICY IF EXISTS "sales_verification_store_comp_summary_select_authenticated" ON public.sales_verification_store_comp_summary;
DROP POLICY IF EXISTS "saved_views_select_own_or_shared_or_admin"   ON public.saved_views;
DROP POLICY IF EXISTS "views_select_creator_or_shared"              ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_insert_self"                     ON public.saved_views;
DROP POLICY IF EXISTS "views_insert_creator"                        ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_update_self_or_admin"            ON public.saved_views;
DROP POLICY IF EXISTS "views_update_creator"                        ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_delete_self_or_admin"            ON public.saved_views;
DROP POLICY IF EXISTS "views_delete_creator"                        ON public.saved_views;

-- ── 5. Recreate ALL policies using active_company_id() ───────
-- Pattern: SELECT USING (company_entity_id = active_company_id())
--          INSERT WITH CHECK (company_entity_id = active_company_id() AND [role])
--          ALL   USING + WITH CHECK both require active company match

-- factories
CREATE POLICY "factories_active_select" ON public.factories
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "factories_active_write"  ON public.factories
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- po_headers
CREATE POLICY "po_headers_active_select" ON public.po_headers
  FOR SELECT USING (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()));
CREATE POLICY "po_headers_active_insert" ON public.po_headers
  FOR INSERT WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()));
CREATE POLICY "po_headers_active_update" ON public.po_headers
  FOR UPDATE USING    (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()))
             WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()));
CREATE POLICY "po_headers_active_delete" ON public.po_headers
  FOR DELETE USING (company_entity_id = active_company_id() AND is_admin_user());

-- po_lines
CREATE POLICY "po_lines_active_select" ON public.po_lines
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "po_lines_active_insert" ON public.po_lines
  FOR INSERT WITH CHECK (
    company_entity_id = active_company_id() AND
    EXISTS (SELECT 1 FROM po_headers ph WHERE ph.id = po_lines.po_header_id AND (is_admin_user() OR ph.created_by = auth.uid()))
  );
CREATE POLICY "po_lines_active_update" ON public.po_lines
  FOR UPDATE USING (company_entity_id = active_company_id()) WITH CHECK (company_entity_id = active_company_id());
CREATE POLICY "po_lines_active_delete" ON public.po_lines
  FOR DELETE USING (company_entity_id = active_company_id() AND is_admin_user());

-- products_master
CREATE POLICY "products_master_active_select" ON public.products_master
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "products_master_active_write"  ON public.products_master
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- locations
CREATE POLICY "locations_active_select" ON public.locations
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "locations_active_write"  ON public.locations
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- revenue_projections
CREATE POLICY "revenue_projections_active_select" ON public.revenue_projections
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "revenue_projections_active_write"  ON public.revenue_projections
  FOR ALL USING    (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()))
  WITH CHECK       (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()));

-- revenue_projection_history
CREATE POLICY "revenue_projection_history_active_select" ON public.revenue_projection_history
  FOR SELECT USING (company_entity_id = active_company_id());

-- launch_calendar
CREATE POLICY "launch_calendar_active_select" ON public.launch_calendar
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_calendar_active_write"  ON public.launch_calendar
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- launch_tasks
CREATE POLICY "launch_tasks_active_select" ON public.launch_tasks
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_tasks_active_write"  ON public.launch_tasks
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- launch_assets
CREATE POLICY "launch_assets_active_select" ON public.launch_assets
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_assets_active_write"  ON public.launch_assets
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- launch_comments
CREATE POLICY "launch_comments_active_select" ON public.launch_comments
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_comments_active_insert" ON public.launch_comments
  FOR INSERT WITH CHECK (company_entity_id = active_company_id() AND (COALESCE(user_id, auth.uid()) = auth.uid()));
CREATE POLICY "launch_comments_active_update" ON public.launch_comments
  FOR UPDATE USING (company_entity_id = active_company_id() AND user_id = auth.uid())
             WITH CHECK (company_entity_id = active_company_id() AND user_id = auth.uid());
CREATE POLICY "launch_comments_active_delete" ON public.launch_comments
  FOR DELETE USING (company_entity_id = active_company_id() AND user_id = auth.uid());

-- launch_channel_items
CREATE POLICY "launch_channel_items_active_select" ON public.launch_channel_items
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_channel_items_active_write"  ON public.launch_channel_items
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- launch_system_links
CREATE POLICY "launch_system_links_active_select" ON public.launch_system_links
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_system_links_active_write"  ON public.launch_system_links
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- launch_product_readiness
CREATE POLICY "launch_product_readiness_active_select" ON public.launch_product_readiness
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "launch_product_readiness_active_write"  ON public.launch_product_readiness
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- payment_requests
CREATE POLICY "payment_requests_active_select" ON public.payment_requests
  FOR SELECT USING (
    company_entity_id = active_company_id() AND (
      created_by = auth.uid() OR
      current_user_can_manage_payment_requests() OR
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role::text = ANY(ARRAY['owner','admin']) OR p.department = ANY(ARRAY['finance','admin','exec'])))
    )
  );

-- payment_request_activity
CREATE POLICY "payment_request_activity_active_select" ON public.payment_request_activity
  FOR SELECT USING (
    company_entity_id = active_company_id() AND
    EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.id = payment_request_activity.payment_request_id AND (is_admin_user() OR pr.created_by = auth.uid() OR pr.assigned_to = auth.uid()))
  );
CREATE POLICY "payment_request_activity_active_insert" ON public.payment_request_activity
  FOR INSERT WITH CHECK (
    company_entity_id = active_company_id() AND
    EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.id = payment_request_activity.payment_request_id AND (is_admin_user() OR pr.created_by = auth.uid() OR pr.assigned_to = auth.uid()))
  );

-- payment_request_files
CREATE POLICY "payment_request_files_active_select" ON public.payment_request_files
  FOR SELECT USING (company_entity_id = active_company_id() AND (current_user_can_manage_payment_requests() OR created_by = auth.uid()));
CREATE POLICY "payment_request_files_active_insert" ON public.payment_request_files
  FOR INSERT WITH CHECK (company_entity_id = active_company_id() AND created_by = auth.uid());
CREATE POLICY "payment_request_files_active_update" ON public.payment_request_files
  FOR UPDATE USING    (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests())
             WITH CHECK (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests());
CREATE POLICY "payment_request_files_active_delete" ON public.payment_request_files
  FOR DELETE USING (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests());

-- po_costing
CREATE POLICY "po_costing_active_select" ON public.po_costing
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "po_costing_active_write"  ON public.po_costing
  FOR ALL USING    (company_entity_id = active_company_id() AND po_costing_can_write())
  WITH CHECK       (company_entity_id = active_company_id() AND po_costing_can_write());

-- po_costing_lines
CREATE POLICY "po_costing_lines_active_select" ON public.po_costing_lines
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "po_costing_lines_active_write"  ON public.po_costing_lines
  FOR ALL USING    (company_entity_id = active_company_id() AND po_costing_can_write())
  WITH CHECK       (company_entity_id = active_company_id() AND po_costing_can_write());

-- po_sequences
CREATE POLICY "po_sequences_active_all" ON public.po_sequences
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- po_status_history
CREATE POLICY "po_status_history_active_all" ON public.po_status_history
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- incoming_shipments
CREATE POLICY "incoming_shipments_active_select" ON public.incoming_shipments
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "incoming_shipments_active_insert" ON public.incoming_shipments
  FOR INSERT WITH CHECK (
    company_entity_id = active_company_id() AND
    EXISTS (SELECT 1 FROM po_headers ph WHERE ph.id = incoming_shipments.po_header_id AND (is_admin_user() OR ph.created_by = auth.uid()))
  );
CREATE POLICY "incoming_shipments_active_update" ON public.incoming_shipments
  FOR UPDATE USING (company_entity_id = active_company_id()) WITH CHECK (company_entity_id = active_company_id());

-- ar tables
CREATE POLICY "ar_customers_active_select" ON public.ar_customers
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "ar_customers_active_write"  ON public.ar_customers
  FOR ALL USING    (company_entity_id = active_company_id() AND is_owner_or_admin())
  WITH CHECK       (company_entity_id = active_company_id() AND is_owner_or_admin());

CREATE POLICY "ar_invoices_active_select" ON public.ar_invoices
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "ar_invoices_active_write"  ON public.ar_invoices
  FOR ALL USING    (company_entity_id = active_company_id() AND is_owner_or_admin())
  WITH CHECK       (company_entity_id = active_company_id() AND is_owner_or_admin());

CREATE POLICY "ar_statements_active_select" ON public.ar_statements
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "ar_statements_active_write"  ON public.ar_statements
  FOR ALL USING    (company_entity_id = active_company_id() AND is_owner_or_admin())
  WITH CHECK       (company_entity_id = active_company_id() AND is_owner_or_admin());

CREATE POLICY "ar_action_queue_active_select" ON public.ar_action_queue
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "ar_action_queue_active_write"  ON public.ar_action_queue
  FOR ALL USING    (company_entity_id = active_company_id() AND is_owner_or_admin())
  WITH CHECK       (company_entity_id = active_company_id() AND is_owner_or_admin());

CREATE POLICY "ar_contact_log_active_select" ON public.ar_contact_log
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "ar_contact_log_active_write"  ON public.ar_contact_log
  FOR ALL USING    (company_entity_id = active_company_id() AND is_owner_or_admin())
  WITH CHECK       (company_entity_id = active_company_id() AND is_owner_or_admin());

-- intern_workbench_items
CREATE POLICY "intern_workbench_active_select" ON public.intern_workbench_items
  FOR SELECT USING (company_entity_id = active_company_id() AND (created_by = auth.uid() OR is_admin_user()));
CREATE POLICY "intern_workbench_active_write"  ON public.intern_workbench_items
  FOR ALL USING    (company_entity_id = active_company_id() AND (created_by = auth.uid() OR is_admin_user()))
  WITH CHECK       (company_entity_id = active_company_id() AND (created_by = auth.uid() OR is_admin_user()));

-- marketing_campaign_bank
CREATE POLICY "marketing_campaign_bank_active_select" ON public.marketing_campaign_bank
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "marketing_campaign_bank_active_write"  ON public.marketing_campaign_bank
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- payroll tables
CREATE POLICY "payroll_import_batches_active_all" ON public.payroll_import_batches
  FOR ALL USING    (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')))
  WITH CHECK       (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')));

CREATE POLICY "payroll_register_lines_active_all" ON public.payroll_register_lines
  FOR ALL USING    (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')))
  WITH CHECK       (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')));

CREATE POLICY "payroll_time_lines_active_all" ON public.payroll_time_lines
  FOR ALL USING    (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')))
  WITH CHECK       (company_entity_id = active_company_id() AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND (p.role = 'admin'::app_role OR p.department = 'finance')));

-- product_samples
CREATE POLICY "product_samples_active_select" ON public.product_samples
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "product_samples_active_write"  ON public.product_samples
  FOR ALL USING    (company_entity_id = active_company_id() AND po_builder_can_write())
  WITH CHECK       (company_entity_id = active_company_id() AND po_builder_can_write());

-- product_sample_activity
ALTER TABLE public.product_sample_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_sample_activity_company_all" ON public.product_sample_activity;
CREATE POLICY "product_sample_activity_active_all" ON public.product_sample_activity
  FOR ALL USING    (company_entity_id = active_company_id())
  WITH CHECK       (company_entity_id = active_company_id());

-- product_tracker
CREATE POLICY "product_tracker_active_select" ON public.product_tracker
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "product_tracker_active_write"  ON public.product_tracker
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

-- sales_verification_store_comp_summary
CREATE POLICY "sales_verification_active_select" ON public.sales_verification_store_comp_summary
  FOR SELECT USING (company_entity_id = active_company_id());

-- saved_views
CREATE POLICY "saved_views_active_select" ON public.saved_views
  FOR SELECT USING (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid() OR is_shared = true));
CREATE POLICY "saved_views_active_write"  ON public.saved_views
  FOR ALL USING    (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()))
  WITH CHECK       (company_entity_id = active_company_id() AND (is_admin_user() OR created_by = auth.uid()));
