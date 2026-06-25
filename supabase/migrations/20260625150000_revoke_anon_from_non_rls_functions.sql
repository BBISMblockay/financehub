-- Revoke anon from admin/migration/slack functions not needed by unauthenticated callers
-- RLS helper functions (active_company_id, is_admin, etc.) intentionally kept callable
REVOKE EXECUTE ON FUNCTION public.backfill_company_entity_batch(text, uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.attach_stamp_company_entity_id_triggers() FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_entity_with_owner(text, text, text, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ensure_entity_state() FROM anon;
REVOKE EXECUTE ON FUNCTION public.send_daily_slack_summary() FROM anon;
REVOKE EXECUTE ON FUNCTION public.audit_revenue_projections() FROM anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_enabled() FROM anon;
REVOKE EXECUTE ON FUNCTION public.active_company_shopify_sync_mode() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_launch_comment() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_launch_created() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_payment_request() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_po_created() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_sample_created() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_slack_task_created() FROM anon;
