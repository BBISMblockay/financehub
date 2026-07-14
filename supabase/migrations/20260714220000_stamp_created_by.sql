-- Insert-side created_by stamping.
--
-- 24 tables carry a created_by/changed_by column but no form or trigger ever
-- filled most of them — all 79 po_headers rows are anonymous even though the
-- team created them by hand in the PO builder, and the same silent
-- attribution loss applies across launches, projections, locations, etc.
-- History can't be recovered (po_status_history.changed_by is empty too),
-- but from now on the DB stamps authorship itself, same safety-net pattern
-- as stamp_company_entity_id: coalesce keeps any explicitly-passed value,
-- and service-role syncs (auth.uid() is null) are left untouched.

CREATE OR REPLACE FUNCTION public.stamp_created_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stamp_changed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.changed_by IS NULL THEN
    NEW.changed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ar_contact_log',
    'employee_goals',
    'entities',
    'entity_comments',
    'intern_workbench_items',
    'launch_calendar',
    'launch_channel_items',
    'launch_product_readiness',
    'launch_system_links',
    'launch_tasks',
    'locations',
    'marketing_campaign_bank',
    'payment_request_activity',
    'payment_request_files',
    'payment_requests',
    'po_headers',
    'product_samples',
    'revenue_projections',
    'review_templates',
    'saved_views',
    'shopify_connections',
    'sync_jobs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_created_by ON public.%I', t);
    EXECUTE format('CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by()', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'po_status_history',
    'revenue_projection_history'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_changed_by ON public.%I', t);
    EXECUTE format('CREATE TRIGGER stamp_changed_by BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_changed_by()', t);
  END LOOP;
END $$;
