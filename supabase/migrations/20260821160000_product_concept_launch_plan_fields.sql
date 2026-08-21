-- Product Concepts: full launch-plan output fields (Loomis note, 2026-08-21).
--
-- Every concept should default to producing a full launch brief, not just a
-- qty/angle sketch: size-spread breakdown, channel + retail allocation,
-- launch day/time, marketing spend by platform, weekly revenue projection
-- per channel, email/SMS cadence, and draft marketing copy. PO creation
-- (the 8th item on that list) is already covered by
-- resulting_po_header_id (20260821140000) -- nothing new needed for it here.
--
-- jsonb for the structured multi-part fields (size/channel/spend/revenue/
-- cadence are naturally key-value or list shaped, and need to stay
-- queryable/reusable downstream, not just prose in `reasoning`); plain text
-- for launch_time and marketing_copy, which are naturally short strings.
-- All nullable, same as every other suggested_* column -- the model fills
-- in what it can ground, leaves the rest blank rather than guessing.

alter table public.product_concepts
  add column if not exists suggested_size_breakdown jsonb,
  add column if not exists suggested_channel_split jsonb,
  add column if not exists suggested_launch_time text,
  add column if not exists suggested_marketing_spend jsonb,
  add column if not exists suggested_weekly_revenue_projection jsonb,
  add column if not exists suggested_email_sms_plan jsonb,
  add column if not exists suggested_marketing_copy text;

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
  c.suggested_marketing_copy
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id;
