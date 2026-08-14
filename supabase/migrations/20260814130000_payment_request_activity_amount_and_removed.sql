-- Request Manager is gaining AP-side amount corrections and document removal.
-- Both need their own activity_type so the activity feed doesn't lump them
-- into the generic "updated" bucket; the check constraint has to widen first.
alter table public.payment_request_activity
  drop constraint if exists payment_request_activity_activity_type_check;

alter table public.payment_request_activity
  add constraint payment_request_activity_activity_type_check
  check (activity_type = any (array[
    'submitted', 'status_changed', 'assignment_changed', 'priority_changed',
    'payment_type_changed', 'completed_changed', 'note_added', 'file_opened',
    'file_uploaded', 'file_removed', 'notification_sent', 'forwarded_to_melio',
    'updated', 'amount_changed'
  ]));
