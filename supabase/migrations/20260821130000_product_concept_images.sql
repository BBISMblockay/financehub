-- Product Concepts: reference image upload (still in testing, gated to
-- PRODUCT_CONCEPT_TESTERS in the silo-chat edge function).
--
-- Path A from the 2026-08-21 planning thread: images the user attaches as
-- inspiration/support while drafting a concept in Ask SILO -- not AI-
-- generated art (a separate, bigger vendor decision, deliberately not
-- built here). Bucket mirrors sample-images/launch-images exactly (public
-- read, authenticated write, folder-prefix enforced). URLs are stored as
-- a plain array on product_concepts, same shape as audience_tags/
-- suggested_channels -- no join table needed since the model always saves
-- the URLs it saw straight onto the concept row it's drafting.

alter table public.product_concepts
  add column if not exists reference_image_urls text[] not null default '{}';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-concept-images',
  'product-concept-images',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_concept_images_public_read on storage.objects;
create policy product_concept_images_public_read
  on storage.objects for select
  using (bucket_id = 'product-concept-images');

drop policy if exists product_concept_images_auth_insert on storage.objects;
create policy product_concept_images_auth_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-concept-images'
    and (storage.foldername(name))[1] = 'concepts'
  );

drop policy if exists product_concept_images_auth_update on storage.objects;
create policy product_concept_images_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'product-concept-images')
  with check (bucket_id = 'product-concept-images');

drop policy if exists product_concept_images_auth_delete on storage.objects;
create policy product_concept_images_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-concept-images');

create or replace view public.product_concepts_v
with (security_invoker = true) as
select
  c.id,
  c.company_entity_id,
  c.created_by,
  creator.name as created_by_name,
  c.approved_by,
  approver.name as approved_by_name,
  c.approved_at,
  c.title,
  c.concept_summary,
  c.marketing_angle,
  c.audience,
  c.audience_tags,
  c.suggested_qty,
  c.suggested_factory_id,
  f.factory_name as suggested_factory_name,
  c.suggested_channels,
  c.suggested_retail_dtc_notes,
  c.suggested_launch_date,
  c.suggested_launch_notes,
  c.reasoning,
  c.notes,
  c.status,
  c.created_at,
  c.updated_at,
  c.reference_image_urls
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id;
