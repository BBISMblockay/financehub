-- Product Concepts: phase as real state, not model discretion.
--
-- Why: the two-phase flow (fast core draft, then the full launch-plan
-- brief only once asked) existed ONLY as system-prompt text. Nothing
-- recorded which phase a concept was at, so:
--   - the UI could not offer "build out the full plan" as a control; the
--     model had to remember to ask, and live it sometimes asked for
--     permission it had already been told not to ask for
--   - a concepts list has no way to show a sketch vs. a finished brief
--   - "is this done?" was answerable only by eyeballing which columns
--     happen to be null
--
-- phase is deliberately ORTHOGONAL to status. status is the approval axis
-- (draft -> approved -> archived); phase is the completeness axis
-- (core_draft -> full_brief). A concept can be an approved core draft, or
-- a full brief still awaiting sign-off. Collapsing them into one column
-- would make both meanings worse.

alter table public.product_concepts
  add column if not exists phase text not null default 'core_draft';

alter table public.product_concepts
  drop constraint if exists product_concepts_phase_check;
alter table public.product_concepts
  add constraint product_concepts_phase_check
  check (phase in ('core_draft', 'full_brief'));

-- Deterministic, additive backfill (the brief permits exactly this, and
-- forbids fuzzy rewriting of history): a concept that already carries any
-- phase-2 launch-plan field was, by definition, built out.
--
-- The revision trigger is suspended for this one statement. A backfill is
-- bookkeeping, not a human editing a concept -- minting a revision on
-- every historical row would bury real edit history under migration
-- noise, and auth.uid() is null in migration context so those revisions
-- would be unattributed anyway. Ordinary phase changes made later by a
-- person or the edge function DO record a revision, which is correct:
-- core_draft -> full_brief is a real state change worth keeping.
alter table public.product_concepts disable trigger trg_product_concept_revision;

update public.product_concepts
set phase = 'full_brief'
where phase = 'core_draft'
  and (
    suggested_size_breakdown is not null
    or suggested_channel_split is not null
    or suggested_marketing_spend is not null
    or suggested_weekly_revenue_projection is not null
    or suggested_email_sms_plan is not null
    or suggested_marketing_copy is not null
  );

alter table public.product_concepts enable trigger trg_product_concept_revision;

create index if not exists product_concepts_company_phase_idx
  on public.product_concepts (company_entity_id, phase, status, updated_at desc);

-- DROP + CREATE, not CREATE OR REPLACE -- replace cannot insert a column
-- into the middle of a view's select list, and this migration must stay
-- re-runnable regardless of future column ordering (see the note in
-- 20260825120000). Nothing in the database depends on these views.
drop view if exists public.product_concepts_v;
create view public.product_concepts_v
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
  c.phase,
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
  parent.title as parent_title,
  c.suggested_product_type,
  c.objective,
  c.primary_goal,
  c.secondary_audience,
  c.audience_rationale,
  c.historical_evidence,
  c.evidence_strength,
  c.buy_rationale,
  c.supply_notes,
  c.supply_constraints,
  c.economics,
  c.forecast,
  c.creative_story,
  c.visual_direction,
  c.brand_fit,
  c.risks,
  c.unknowns,
  c.recommendation,
  c.recommendation_reasoning,
  c.next_decision,
  c.field_evidence,
  c.provenance,
  c.revision_note,
  c.current_revision_number,
  (select count(*) from public.product_concept_revisions r where r.concept_id = c.id) as revision_count,
  (select count(*) from public.product_concepts ch where ch.parent_concept_id = c.id) as child_count
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief','revision','evidence','phase'],
  description = $d$Ask SILO's Product Concepts. ONE row per real concept, always the CURRENT state -- superseded states live in product_concept_revisions, so this table never needs an is_current filter and never returns the same concept twice. TWO ORTHOGONAL AXES OF STATE: status is approval (draft -> approved -> archived); phase is completeness (core_draft = title/angle/qty/factory/timing only; full_brief = the launch-plan fields are filled in too). An approved core_draft and an unapproved full_brief are both normal. A third axis, parent_concept_id, groups a COLLECTION (sibling products sharing one strategic brief -- parent holds angle/audience/timing/spend, children hold title/qty/factory/size); revision history is a fourth, time axis. suggested_product_type names the category in products_master.product_type's own vocabulary (e.g. "Youth Cap") and is what carries into po_lines.product_type_snapshot when a concept becomes a PO. Beyond the suggested_* draft fields it carries a structured brief: objective/primary_goal, historical_evidence, economics, forecast (conservative/base/upside), risks, unknowns, recommendation/next_decision, plus field_evidence (per-field INPUT/DATA/ASSUMPTION/RECOMMENDATION classification with a qualitative strength) and provenance (which tables/date ranges/metrics backed each claim). evidence_strength is qualitative -- strong/moderate/early, never a percentage. Legacy concepts created before 2026-08-25 have these columns null and no revisions; that means "not recorded", not "zero". product_concepts_v adds creator/approver/factory/parent names, revision_count and child_count.$d$
where relname = 'product_concepts';
