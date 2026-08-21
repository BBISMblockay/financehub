-- Product Concepts: link to the PO it becomes.
--
-- Prep column only -- PO Builder does not yet read/write this (that wiring
-- is a later change, per the 2026-08-21 planning thread: an approved
-- concept becomes selectable in a new, additive PO Builder dropdown that
-- pre-fills po_name from concept.title, factory_id from
-- suggested_factory_id, and auto-checks is_new_product_po). Adding the
-- column now so that future work is a UI + edge-function change, not
-- another migration.

alter table public.product_concepts
  add column if not exists resulting_po_header_id uuid references public.po_headers(id) on delete set null;

create index if not exists product_concepts_resulting_po_header_idx
  on public.product_concepts (resulting_po_header_id);

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
  c.reference_image_urls,
  c.resulting_po_header_id,
  po.po_name as resulting_po_name
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id;
