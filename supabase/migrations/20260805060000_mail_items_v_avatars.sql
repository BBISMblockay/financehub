-- ============================================================
-- 20260805060000_mail_items_v_avatars.sql
--
-- Mailroom: assignee/submitter/processor avatars, same treatment as
-- payment_requests_v in 20260805050000. New columns appended at the end
-- (CREATE OR REPLACE VIEW requires this); security_invoker explicitly
-- re-set to true afterward.
-- ============================================================

create or replace view public.mail_items_v as
select
  mi.id,
  mi.company_entity_id,
  mi.subject,
  mi.sender,
  mi.document_type,
  mi.priority,
  mi.received_date,
  mi.due_date,
  mi.action_needed,
  mi.notes,
  mi.assigned_to,
  mi.processed_by,
  mi.submitted_by,
  mi.status,
  mi.legacy_submission_id,
  mi.legacy_source,
  mi.created_by,
  mi.updated_by,
  mi.created_at,
  mi.updated_at,
  assigned.name as assigned_to_name,
  assigned.email as assigned_to_email,
  submitted.name as submitted_by_name,
  submitted.email as submitted_by_email,
  processed.name as processed_by_name,
  processed.email as processed_by_email,
  assigned.avatar_url as assigned_to_avatar_url,
  submitted.avatar_url as submitted_by_avatar_url,
  processed.avatar_url as processed_by_avatar_url
from public.mail_items mi
left join public.profiles assigned on assigned.id = mi.assigned_to
left join public.profiles submitted on submitted.id = mi.submitted_by
left join public.profiles processed on processed.id = mi.processed_by;

alter view public.mail_items_v set (security_invoker = true);
