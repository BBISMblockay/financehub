-- Affiliate partnership agreement as a file (Blake 2026-11-18: "terms doc
-- upload for partnership agreement").
--
-- A program can carry its own agreement as a PDF next to (or instead of) the
-- written terms. The join page shows it and the affiliate signs against it.
-- Changing the file is a new terms version, exactly like editing the text, so
-- nobody is shown as having accepted a document that changed afterwards and
-- anyone mid-signup is asked to reload (the portal's 40001 refusal).
--
-- Storage: private bucket `affiliate-terms`, path `<program id>/<sha256>.pdf`.
-- The path starts with the PARENT row's id and every policy is an EXISTS on
-- affiliate_programs in the active company (supabase/CLAUDE.md). A new file is
-- a new path, so there is no update or delete policy: a version someone
-- accepted is never overwritten or removed. The join page reads it through the
-- affiliate-portal function (service role, signed URL), never from the browser.
--
-- Idempotent.

alter table public.affiliate_programs
  add column if not exists terms_file_path text,
  add column if not exists terms_file_name text,
  add column if not exists terms_file_sha256 text;

-- Recreated on every run so a rerun always leaves this exact definition. The
-- filled branch names all three columns as NOT NULL: a CHECK passes on NULL,
-- so without them a NULL hash would let any path through (review on #1326).
alter table public.affiliate_programs drop constraint if exists affiliate_programs_terms_file_check;
alter table public.affiliate_programs add constraint affiliate_programs_terms_file_check check (
  (terms_file_path is null and terms_file_sha256 is null and terms_file_name is null)
  or (terms_file_path is not null and terms_file_sha256 is not null and terms_file_name is not null
      and terms_file_sha256 ~ '^[0-9a-f]{64}$'
      and terms_file_path = id::text || '/' || terms_file_sha256 || '.pdf'
      and char_length(terms_file_name) between 1 and 200)
);

-- The version moves with the text OR the file; nothing else moves it.
create or replace function public.affiliate_programs_terms_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.terms_markdown is distinct from old.terms_markdown
     or new.terms_file_sha256 is distinct from old.terms_file_sha256 then
    new.terms_version := old.terms_version + 1;
    new.terms_updated_at := now();
  elsif new.terms_version is distinct from old.terms_version then
    -- The version is not a free-standing field: it only moves with the terms.
    new.terms_version := old.terms_version;
    new.terms_updated_at := old.terms_updated_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('affiliate-terms', 'affiliate-terms', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "affiliate terms readable by its company" on storage.objects;
create policy "affiliate terms readable by its company" on storage.objects
  for select to authenticated using (
    bucket_id = 'affiliate-terms'
    and exists (select 1 from public.affiliate_programs p
                where p.id::text = (storage.foldername(objects.name))[1]
                  and p.company_entity_id = public.active_company_id())
  );

drop policy if exists "affiliate terms written by program managers" on storage.objects;
create policy "affiliate terms written by program managers" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'affiliate-terms'
    and public.can_manage_affiliate_programs()
    and exists (select 1 from public.affiliate_programs p
                where p.id::text = (storage.foldername(objects.name))[1]
                  and p.company_entity_id = public.active_company_id())
  );

-- No delete policy either: a file someone signed against stays as evidence.
-- Removing the agreement in Studio only clears the program's columns.
drop policy if exists "affiliate terms removed by program managers" on storage.objects;
