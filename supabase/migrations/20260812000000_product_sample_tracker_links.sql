-- Allow a sample to link to more than one pipeline item.
--
-- product_samples.tracker_id was a single scalar FK -- a sample could only
-- ever attach to one product_tracker row, even though a sample run
-- sometimes covers more than one pipeline item (e.g. a combined sample
-- request across two related SKUs). New product_sample_tracker_links is
-- the real many-to-many relationship, same pattern as employee_managers.
--
-- product_samples.tracker_id is KEPT as the original/primary link -- it's
-- still read by the products_master fallback in samplesForTracker() and by
-- any legacy query -- but it is no longer the only source of truth for
-- "which pipeline items is this sample linked to." Do not treat it as
-- exhaustive; check product_sample_tracker_links instead.

create table if not exists public.product_sample_tracker_links (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid,
  sample_id          uuid not null references public.product_samples(id) on delete cascade,
  tracker_id         uuid not null references public.product_tracker(id) on delete cascade,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  unique (sample_id, tracker_id)
);

create index if not exists product_sample_tracker_links_sample_idx  on public.product_sample_tracker_links (sample_id);
create index if not exists product_sample_tracker_links_tracker_idx on public.product_sample_tracker_links (tracker_id);

-- Backfill: every sample's existing single tracker_id becomes its first link.
insert into public.product_sample_tracker_links (company_entity_id, sample_id, tracker_id)
select s.company_entity_id, s.id, s.tracker_id
from public.product_samples s
where s.tracker_id is not null
on conflict (sample_id, tracker_id) do nothing;

drop trigger if exists stamp_created_by on public.product_sample_tracker_links;
create trigger stamp_created_by before insert on public.product_sample_tracker_links
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

alter table public.product_sample_tracker_links enable row level security;
revoke all on public.product_sample_tracker_links from anon;

-- select: same visibility as the samples/tracker items themselves.
drop policy if exists product_sample_tracker_links_active_select on public.product_sample_tracker_links;
create policy product_sample_tracker_links_active_select on public.product_sample_tracker_links
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- write: same gate as editing the sample itself (po_builder_can_write(),
-- matching product_samples_active_write).
drop policy if exists product_sample_tracker_links_active_write on public.product_sample_tracker_links;
create policy product_sample_tracker_links_active_write on public.product_sample_tracker_links
  for all to authenticated
  using      (company_entity_id = public.active_company_id() and public.po_builder_can_write())
  with check (company_entity_id = public.active_company_id() and public.po_builder_can_write());
