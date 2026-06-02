-- =============================================================================
-- Launch Workbench: storage bucket for launch hero images
-- Fixes: "Save failed: Bucket not found" when uploading in Edit Launch Container
-- Run in Supabase SQL Editor (safe to re-run).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'launch-images',
  'launch-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects policies (upload path: launches/{launchId}-{timestamp}.ext)
drop policy if exists launch_images_public_read on storage.objects;
create policy launch_images_public_read
  on storage.objects for select
  using (bucket_id = 'launch-images');

drop policy if exists launch_images_auth_insert on storage.objects;
create policy launch_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'launch-images'
    and (storage.foldername(name))[1] = 'launches'
  );

drop policy if exists launch_images_auth_update on storage.objects;
create policy launch_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'launch-images')
  with check (bucket_id = 'launch-images');

drop policy if exists launch_images_auth_delete on storage.objects;
create policy launch_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'launch-images');
