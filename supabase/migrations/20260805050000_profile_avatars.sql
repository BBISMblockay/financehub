-- ============================================================
-- 20260805050000_profile_avatars.sql
--
-- Real profile photos instead of bold initial blocks. Path convention:
-- avatars/{auth.uid()}/avatar.{ext} -- each user can only touch their own
-- folder; the bucket is public-read so avatars render in lists other
-- people view (Request Manager, Tasks, the sidebar), not just the owner's
-- own profile page.
-- ============================================================

alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- payment_requests_v: add assignee avatar so Request Manager can put a
-- face to who's working a request. CREATE OR REPLACE VIEW preserves column
-- order for existing columns as long as they're not removed/retyped; the
-- new column is appended at the end.
create or replace view public.payment_requests_v as
select
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
  coalesce(nullif(pr.vendor_name_manual, ''), pr.vendor_name) as effective_vendor_name,
  coalesce(nullif(pr.vendor_name_manual_norm, ''), pr.vendor_name_norm) as effective_vendor_name_norm,
  p.name as assigned_to_name,
  p.email as assigned_to_email,
  pr.paid_notification_sent_at,
  pr.paid_notification_sent_by,
  p.avatar_url as assigned_to_avatar_url
from public.payment_requests pr
left join public.profiles p on p.id = pr.assigned_to;

alter view public.payment_requests_v set (security_invoker = true);
