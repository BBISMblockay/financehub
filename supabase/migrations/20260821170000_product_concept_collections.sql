-- Product Concepts: collection grouping (parent + per-product children).
--
-- Real usage showed most releases are a themed collection of a few
-- products sharing one strategic brief (angle, audience, timing, channel
-- split, spend, cadence, copy), not one product at a time -- confirmed by
-- launch_calendar's own Sonic collab row (one collection_name, one
-- aggregate expected_units, no per-SKU rows). Ask SILO's own analysis
-- proposed grouping by a shared title prefix since there was no link
-- column; that's fragile (breaks on a retitle, not reliably queryable) --
-- this adds a real self-referencing FK instead.
--
-- A parent concept (parent_concept_id is null) holds the shared strategic
-- fields; a child concept (parent_concept_id set) holds only what's
-- genuinely per-product (title, suggested_qty, suggested_factory_id,
-- suggested_size_breakdown). A standalone single-product concept (no
-- collection around it) just leaves parent_concept_id unset, exactly like
-- every concept before this migration.

alter table public.product_concepts
  add column if not exists parent_concept_id uuid references public.product_concepts(id) on delete set null;

create index if not exists product_concepts_parent_concept_idx
  on public.product_concepts (parent_concept_id);

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
  po.po_name as resulting_po_name,
  c.suggested_size_breakdown,
  c.suggested_channel_split,
  c.suggested_launch_time,
  c.suggested_marketing_spend,
  c.suggested_weekly_revenue_projection,
  c.suggested_email_sms_plan,
  c.suggested_marketing_copy,
  c.parent_concept_id,
  parent.title as parent_title
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;
