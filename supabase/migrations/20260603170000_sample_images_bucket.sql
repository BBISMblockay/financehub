-- =============================================================================
-- Product Samples: storage bucket for sample photos
-- Upload path: samples/{sampleId}/{filename}
-- Safe to re-run.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sample-images',
  'sample-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read (same as launch-images — photos need to display in the UI)
drop policy if exists sample_images_public_read on storage.objects;
create policy sample_images_public_read
  on storage.objects for select
  using (bucket_id = 'sample-images');

-- Auth insert — enforce samples/ folder prefix
drop policy if exists sample_images_auth_insert on storage.objects;
create policy sample_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sample-images'
    and (storage.foldername(name))[1] = 'samples'
  );

drop policy if exists sample_images_auth_update on storage.objects;
create policy sample_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'sample-images')
  with check (bucket_id = 'sample-images');

drop policy if exists sample_images_auth_delete on storage.objects;
create policy sample_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'sample-images');
