-- Storage: scope object access to the company that owns the file.
--
-- Found 2026-09-04 auditing multi-tenancy. The database tier is solid --
-- every operational table carries company_entity_id and every policy checks
-- active_company_id(). Storage had 27 policies and NOT ONE of them mentioned
-- a company. Every private-bucket policy read, in full:
--
--     using (bucket_id = 'payment-request-files')
--
-- which is "any authenticated user, of any company, may read or DELETE any
-- object in this bucket". That covered 375 payment-request attachments --
-- invoices, commission statements, AP confirmations -- and 51 mailroom
-- scans. The bucket being private bought nothing: private means the CDN will
-- not serve it anonymously, and RLS is what decides who may.
--
-- The `schedule-item-files` policies are the clearest evidence it was copied
-- rather than decided: they are NAMED "readable by company" / "writable by
-- company" and carry no company clause at all, because they were modelled on
-- the payment-request ones.
--
-- ── The key ─────────────────────────────────────────────────────────
-- Every private bucket already writes its parent row's id as the first path
-- segment -- `<payment_request_id>/<file>`, `<mail_item_id>/<file>` -- and
-- the parent tables are the ones with correct RLS. So the object inherits
-- the row's visibility through a plain EXISTS: no SECURITY DEFINER, no path
-- rewriting, no backfill, and no second definition of who may see what.
--
-- For payment requests that is STRICTER than company scoping and is the
-- right answer: payment_requests_active_select is "your own request, or you
-- manage AP, or you are an admin", so an attachment is now exactly as
-- visible as the request it belongs to. Files should follow the row, not
-- invent a parallel rule that drifts from it.
--
-- Compared as TEXT, never cast to uuid: a malformed first segment would make
-- the cast raise, and an erroring policy is a broken bucket rather than a
-- denied read.
--
-- ── Why the parent row and not the metadata row ─────────────────────
-- `payment_request_files.file_path` would be an exact match, but the object
-- is uploaded BEFORE its metadata row is inserted. Keying on the metadata
-- row would make an upload whose insert then failed permanently
-- undeletable -- and Request Manager's cleanup path calls .remove() on
-- exactly those. The parent row exists before the upload starts, so the
-- folder-segment check works for INSERT too.
--
-- Service-role bypasses RLS entirely, so edge functions and syncs are
-- unaffected by everything below.

-- ── payment-request-files (private, 375 objects) ────────────────────
drop policy if exists "payment request reads by authenticated users" on storage.objects;
drop policy if exists "payment request updates by authenticated users" on storage.objects;
drop policy if exists "payment request deletes by authenticated users" on storage.objects;
drop policy if exists "payment request uploads by authenticated users" on storage.objects;

create policy "payment request files readable with the request"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-request-files'
    and exists (
      select 1 from public.payment_requests pr
       where pr.id::text = (storage.foldername(name))[1]
    )
  );

create policy "payment request files writable with the request"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-request-files'
    and exists (
      select 1 from public.payment_requests pr
       where pr.id::text = (storage.foldername(name))[1]
    )
  );

create policy "payment request files updatable with the request"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'payment-request-files'
    and exists (
      select 1 from public.payment_requests pr
       where pr.id::text = (storage.foldername(name))[1]
    )
  )
  with check (
    bucket_id = 'payment-request-files'
    and exists (
      select 1 from public.payment_requests pr
       where pr.id::text = (storage.foldername(name))[1]
    )
  );

create policy "payment request files deletable with the request"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'payment-request-files'
    and exists (
      select 1 from public.payment_requests pr
       where pr.id::text = (storage.foldername(name))[1]
    )
  );

-- ── mail-item-files (private, 51 objects) ───────────────────────────
drop policy if exists "mail item files read by authenticated users" on storage.objects;
drop policy if exists "mail item files update by authenticated users" on storage.objects;
drop policy if exists "mail item files delete by authenticated users" on storage.objects;
drop policy if exists "mail item files upload by authenticated users" on storage.objects;

create policy "mail item files readable with the item"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'mail-item-files'
    and exists (
      select 1 from public.mail_items mi
       where mi.id::text = (storage.foldername(name))[1]
    )
  );

create policy "mail item files writable with the item"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'mail-item-files'
    and exists (
      select 1 from public.mail_items mi
       where mi.id::text = (storage.foldername(name))[1]
    )
  );

create policy "mail item files updatable with the item"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'mail-item-files'
    and exists (
      select 1 from public.mail_items mi
       where mi.id::text = (storage.foldername(name))[1]
    )
  )
  with check (
    bucket_id = 'mail-item-files'
    and exists (
      select 1 from public.mail_items mi
       where mi.id::text = (storage.foldername(name))[1]
    )
  );

create policy "mail item files deletable with the item"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'mail-item-files'
    and exists (
      select 1 from public.mail_items mi
       where mi.id::text = (storage.foldername(name))[1]
    )
  );

-- ── schedule-item-files (private, 0 objects) ────────────────────────
-- Nothing writes this bucket yet, so the convention is FIXED here to match
-- its siblings: <schedule_item_id>/<file>. Any page that later uploads a
-- signed agreement must use that path or the policy will refuse it -- which
-- is the intended failure mode, not a bug to work around.
drop policy if exists "schedule files readable by company" on storage.objects;
drop policy if exists "schedule files writable by company" on storage.objects;
drop policy if exists "schedule files deletable by company" on storage.objects;

create policy "schedule files readable with the item"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'schedule-item-files'
    and exists (
      select 1 from public.schedule_items si
       where si.id::text = (storage.foldername(name))[1]
    )
  );

create policy "schedule files writable with the item"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'schedule-item-files'
    and exists (
      select 1 from public.schedule_items si
       where si.id::text = (storage.foldername(name))[1]
    )
  );

create policy "schedule files deletable with the item"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'schedule-item-files'
    and exists (
      select 1 from public.schedule_items si
       where si.id::text = (storage.foldername(name))[1]
    )
  );

-- ── sample-images (PUBLIC bucket, 89 objects) ───────────────────────
-- Read stays open, and tightening it would be theatre: a public bucket is
-- served by the CDN at /object/public/... with no RLS evaluated at all, so a
-- policy here cannot hide a file whose URL someone already has. What a
-- policy CAN do is stop another company's user DELETING it.
--
-- The path is samples/<sample_id>/<file>, so segment 2 is the parent id and
-- product_samples is company-scoped.
drop policy if exists sample_images_auth_update on storage.objects;
drop policy if exists sample_images_auth_delete on storage.objects;
drop policy if exists sample_images_auth_insert on storage.objects;

create policy sample_images_insert_with_sample
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sample-images'
    and (storage.foldername(name))[1] = 'samples'
    and exists (
      select 1 from public.product_samples ps
       where ps.id::text = (storage.foldername(name))[2]
    )
  );

create policy sample_images_update_with_sample
  on storage.objects for update to authenticated
  using (
    bucket_id = 'sample-images'
    and exists (
      select 1 from public.product_samples ps
       where ps.id::text = (storage.foldername(name))[2]
    )
  )
  with check (
    bucket_id = 'sample-images'
    and exists (
      select 1 from public.product_samples ps
       where ps.id::text = (storage.foldername(name))[2]
    )
  );

create policy sample_images_delete_with_sample
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'sample-images'
    and exists (
      select 1 from public.product_samples ps
       where ps.id::text = (storage.foldername(name))[2]
    )
  );

-- ── launch-images / product-concept-images (PUBLIC) ─────────────────
-- These two have NO usable key. `launches/<launchId>-<ts>.png` is not a
-- folder, and the id is literally the string `new` for an image attached
-- before the launch row is saved -- 3 of the 10 objects. Inventing a parent
-- join here would break that upload, and the honest scoping (put the company
-- id in the path) is a page change, not a policy change.
--
-- So writes narrow to the UPLOADER, which storage records itself in
-- `owner`. That closes the actual cross-tenant hole -- another company's
-- user deleting Baseballism's launch artwork -- and breaks nothing, because
-- nothing in the app deletes from either bucket today (both pages only
-- upload and getPublicUrl). Insert stays open to any authenticated user:
-- an unsaved launch has no row to check against, and a stray image in a
-- public marketing bucket is not the risk worth blocking an upload over.
drop policy if exists launch_images_auth_update on storage.objects;
drop policy if exists launch_images_auth_delete on storage.objects;

create policy launch_images_owner_update
  on storage.objects for update to authenticated
  using (bucket_id = 'launch-images' and owner = auth.uid())
  with check (bucket_id = 'launch-images' and owner = auth.uid());

create policy launch_images_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'launch-images' and owner = auth.uid());

drop policy if exists product_concept_images_auth_update on storage.objects;
drop policy if exists product_concept_images_auth_delete on storage.objects;

create policy product_concept_images_owner_update
  on storage.objects for update to authenticated
  using (bucket_id = 'product-concept-images' and owner = auth.uid())
  with check (bucket_id = 'product-concept-images' and owner = auth.uid());

create policy product_concept_images_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-concept-images' and owner = auth.uid());

-- ── avatars ─────────────────────────────────────────────────────────
-- Left exactly as they are. `avatars` was already the one bucket scoped to
-- anything: <auth.uid()>/avatar.png, with writes gated on the folder being
-- your own id. That is narrower than company scoping and correct as it
-- stands.
