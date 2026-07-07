-- Direct link between a physical sample (product_samples) and its product
-- pipeline item (product_tracker).
--
-- Before this, the only relation between the two was an OPTIONAL shared
-- products_master link — a sample whose product wasn't in the catalog yet
-- (the common case for new development) had no way to reach its pipeline
-- item, so the consolidated Products page couldn't show samples under a
-- product or jump between the two without dead ends.

alter table public.product_samples
  add column if not exists tracker_id uuid references public.product_tracker(id) on delete set null;

create index if not exists product_samples_tracker_id_idx
  on public.product_samples (tracker_id);

-- Backfill 1: samples and tracker items that share a products_master link.
-- distinct on picks the oldest tracker item per (company, master) so an
-- ambiguous match never fans out.
update public.product_samples s
set tracker_id = t.id
from (
  select distinct on (company_entity_id, product_master_id) id, company_entity_id, product_master_id
  from public.product_tracker
  where product_master_id is not null
  order by company_entity_id, product_master_id, created_at asc
) t
where s.tracker_id is null
  and s.product_master_id is not null
  and t.product_master_id = s.product_master_id
  and t.company_entity_id is not distinct from s.company_entity_id;

-- Backfill 2: exact (case-insensitive) title match for the rest.
update public.product_samples s
set tracker_id = t.id
from (
  select distinct on (company_entity_id, lower(product_title)) id, company_entity_id, lower(product_title) as title_key
  from public.product_tracker
  order by company_entity_id, lower(product_title), created_at asc
) t
where s.tracker_id is null
  and t.title_key = lower(s.product_title)
  and t.company_entity_id is not distinct from s.company_entity_id;
