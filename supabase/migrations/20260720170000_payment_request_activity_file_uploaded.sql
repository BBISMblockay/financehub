-- ============================================================
-- Add 'file_uploaded' to the payment_request_activity activity_type
-- check constraint.
--
-- v2/request_manager.html has logged activity_type: "file_uploaded"
-- since the confirmation-document upload feature was added, but the
-- check constraint never included it. Every confirmation-document
-- upload succeeded (storage + payment_request_files insert both
-- landed) but the follow-up activity-log insert threw a constraint
-- violation, aborting the UI refresh before the newly saved file
-- could render -- making a successful upload look like a silent
-- failure.
-- ============================================================

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
    'updated'
  ]::text[]));
