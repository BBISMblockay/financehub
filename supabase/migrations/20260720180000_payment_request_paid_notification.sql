-- ============================================================
-- Payment request "paid" notification support.
--
-- Adds tracking columns for when AP notifies the requester that
-- their payment request was paid (auto-fired from the Request
-- Manager drawer when a request is marked completed/paid, and
-- re-triggerable via a "Resend notification" button), surfaces
-- them on payment_requests_v, and registers the new
-- 'notification_sent' payment_request_activity type up front so
-- we don't repeat the file_uploaded constraint miss.
-- ============================================================

ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS paid_notification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_notification_sent_by uuid REFERENCES public.profiles(id);

CREATE OR REPLACE VIEW public.payment_requests_v
WITH (security_invoker = true) AS
SELECT
  pr.id,
  pr.vendor_name,
  pr.vendor_name_norm,
  pr.vendor_name_manual,
  pr.vendor_name_manual_norm,
  pr.request_type,
  pr.invoice_number,
  pr.flex_id,
  pr.internal_po_number,
  pr.amount_due,
  pr.due_date,
  pr.requester_email,
  pr.requester_email_norm,
  pr.location_name,
  pr.notes_comments,
  pr.file_name,
  pr.file_path,
  pr.file_url,
  pr.payment_type,
  pr.completed,
  pr.date_completed,
  pr.payment_detail,
  pr.workflow_status,
  pr.assigned_to,
  pr.internal_notes,
  pr.priority,
  pr.created_by,
  pr.updated_by,
  pr.submitted_at,
  pr.created_at,
  pr.updated_at,
  COALESCE(NULLIF(pr.vendor_name_manual, ''), pr.vendor_name) AS effective_vendor_name,
  COALESCE(NULLIF(pr.vendor_name_manual_norm, ''), pr.vendor_name_norm) AS effective_vendor_name_norm,
  p.name AS assigned_to_name,
  p.email AS assigned_to_email,
  pr.paid_notification_sent_at,
  pr.paid_notification_sent_by
FROM public.payment_requests pr
LEFT JOIN public.profiles p ON p.id = pr.assigned_to;

ALTER TABLE public.payment_request_activity
  DROP CONSTRAINT IF EXISTS payment_request_activity_activity_type_check;

ALTER TABLE public.payment_request_activity
  ADD CONSTRAINT payment_request_activity_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    'submitted',
    'status_changed',
    'assignment_changed',
    'priority_changed',
    'payment_type_changed',
    'completed_changed',
    'note_added',
    'file_opened',
    'file_uploaded',
    'notification_sent',
    'updated'
  ]::text[]));
