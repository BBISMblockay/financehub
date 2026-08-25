-- Product Concepts: structured template, evidence classification, and
-- revision lineage.
--
-- Why: Ask SILO got good at grounding a concept in real data, but the
-- interaction stayed free-form. Two problems showed up in real use:
--
--   1. Repeated refinement of ONE idea stamped several unrelated-looking
--      product_concepts rows. There was no way to tell "revision 3 of the
--      Black Friday youth cap" from "a second, different youth cap idea."
--   2. The concept row had no place to record HOW SOLID each value was.
--      A qty derived from a real comparable's 90-day sell-through and a
--      qty guessed from a thin analogy looked identical once saved.
--
-- This migration is additive only. Every existing column, policy, view,
-- and row keeps working exactly as before -- legacy concepts simply have
-- no revisions and empty evidence metadata, which every consumer treats
-- as "not recorded" rather than an error. No column is dropped, no type
-- changed, no historical row rewritten, and no fuzzy de-duplication is
-- attempted across concepts already saved (per the brief: ambiguous
-- historical duplicates are left intact -- this makes FUTURE revisions
-- clean rather than retroactively rewriting the past).
--
-- Two axes now exist on product_concepts and they are deliberately
-- separate -- conflating them was the main design risk here:
--   parent_concept_id  -- COLLECTION axis (20260821170000): sibling
--                         products sharing one strategic brief.
--   product_concept_revisions -- HISTORY axis (this migration): earlier
--                         states of the SAME concept over time.
-- A child of a collection has its own independent revision history; a
-- revision is never a child concept. Keeping history in its own table
-- (rather than as more product_concepts rows behind an is_current flag)
-- means every existing query -- product_concepts_v, the Ask SILO run_sql
-- reads, the future PO Builder dropdown -- keeps returning exactly one
-- row per real concept with no is_current filter to remember. That was
-- the deciding factor: an is_current design silently turns every
-- pre-existing concept query into a duplicate-row bug.

-- ---------------------------------------------------------------------------
-- 1. Structured template fields (all nullable, all additive)
-- ---------------------------------------------------------------------------
-- The pre-existing suggested_* columns stay exactly as they are and keep
-- their meaning; these sit alongside them and cover the parts of a real
-- concept brief that previously had nowhere to go except prose inside
-- `reasoning`. jsonb where the shape is naturally a list or key-value and
-- needs to stay queryable downstream; plain text where it is genuinely a
-- sentence.

alter table public.product_concepts
  -- Product/category, in products_master.product_type's own vocabulary
  -- (e.g. "Youth Cap", "Women"). Concept identity carried this only
  -- implicitly, inside the title/summary prose, which breaks the handoff
  -- into the rest of SILO: po_lines.product_type_snapshot feeds
  -- product_tracker.product_type via PO Builder's new-product tracker
  -- sync, and every comparable-launch query groups by product_type. A
  -- concept that cannot name its own category loses that categorization
  -- at the first hop out of chat.
  add column if not exists suggested_product_type text,

  -- Objective: why this product should exist at all.
  add column if not exists objective text,
  add column if not exists primary_goal text,

  -- Target customer beyond the existing audience/audience_tags columns.
  add column if not exists secondary_audience text,
  add column if not exists audience_rationale text,

  -- Historical evidence actually consulted, as structured items rather
  -- than prose, e.g.
  --   [{"label":"Youth food shorts", "metric":"units, first 90 days",
  --     "value":"2400", "source":"sales_by_day", "strength":"strong"}]
  add column if not exists historical_evidence jsonb,

  -- Overall qualitative confidence in the concept as a whole. Deliberately
  -- NOT a percentage -- see the evidence_strength check below.
  add column if not exists evidence_strength text,

  -- Recommended buy: the existing suggested_qty holds the number, this
  -- holds why that number and not another.
  add column if not exists buy_rationale text,

  -- Supply / factory reasoning beyond just suggested_factory_id.
  add column if not exists supply_notes text,
  add column if not exists supply_constraints text,

  -- Economics, e.g. {"unit_cost":12.40,"msrp":48,"gross_margin_pct":74,
  --                  "inventory_investment":22320,"revenue_expectation":86400}
  -- Any key absent means "not supported by data" -- never a guessed number.
  add column if not exists economics jsonb,

  -- Three-scenario forecast with the assumptions behind each, e.g.
  --   {"conservative":{"units":900,"revenue":43200,"assumptions":"..."},
  --    "base":{...}, "upside":{...}}
  add column if not exists forecast jsonb,

  -- Creative direction (distinct from marketing_angle, which is the
  -- one-line hook, and suggested_marketing_copy, which is draft copy).
  add column if not exists creative_story text,
  add column if not exists visual_direction text,
  add column if not exists brand_fit text,

  -- Risks/unknowns, e.g.
  --   [{"category":"data","detail":"no comparable launch with week-level revenue"}]
  add column if not exists risks jsonb,

  -- Fields the template asks for but data could not support, with the
  -- reason. Exists so "we don't know" is recorded explicitly instead of
  -- being indistinguishable from "nobody filled this in yet", e.g.
  --   [{"field":"economics.unit_cost","why":"no prior PO for this factory + product type"}]
  add column if not exists unknowns jsonb,

  -- Overall call + the next HUMAN decision needed to move this forward.
  add column if not exists recommendation text,
  add column if not exists recommendation_reasoning text,
  add column if not exists next_decision text,

  -- Per-field evidence classification: which of the four classes each
  -- important value belongs to, and how strong it is, e.g.
  --   {"suggested_qty":{"class":"RECOMMENDATION","strength":"moderate",
  --                     "note":"derived from youth cap 90-day sell-through"},
  --    "title":{"class":"INPUT"}}
  -- Keyed by concept column name so the UI can badge a value without a
  -- lookup table. A field absent from this object simply has no recorded
  -- classification -- which is exactly the state every legacy row is in.
  add column if not exists field_evidence jsonb,

  -- Provenance: enough metadata to answer "why did SILO recommend 1,800
  -- units?" later without exposing raw SQL by default, e.g.
  --   [{"claim":"suggested_qty","tables":["sales_by_day","launch_calendar"],
  --     "date_range":"2025-09-01..2026-08-01","metrics":["units_90d"],
  --     "skus":["YTH-CAP-001"],"note":"..."}]
  add column if not exists provenance jsonb,

  -- Set by whoever performs an UPDATE to describe that change in one
  -- line; the revision trigger below copies it onto the revision row it
  -- creates and it is then overwritten by the next change. Reading this
  -- column on the live row tells you what the most recent change was.
  add column if not exists revision_note text,

  -- Always equals the number of the revision the live row represents.
  -- Starts at 1; the trigger below increments it on every real change.
  add column if not exists current_revision_number integer not null default 1;

-- Qualitative strength labels only. The brief is explicit that fake
-- confidence percentages are worse than no number, because a computed-
-- looking "72% confident" invites exactly the false precision the whole
-- evidence-classification idea exists to prevent.
alter table public.product_concepts
  drop constraint if exists product_concepts_evidence_strength_check;
alter table public.product_concepts
  add constraint product_concepts_evidence_strength_check
  check (evidence_strength is null or evidence_strength in ('strong', 'moderate', 'early'));

alter table public.product_concepts
  drop constraint if exists product_concepts_primary_goal_check;
alter table public.product_concepts
  add constraint product_concepts_primary_goal_check
  check (primary_goal is null or primary_goal in (
    'revenue', 'margin', 'brand', 'acquisition', 'existing_demand', 'experiment'
  ));

alter table public.product_concepts
  drop constraint if exists product_concepts_recommendation_check;
alter table public.product_concepts
  add constraint product_concepts_recommendation_check
  check (recommendation is null or recommendation in (
    'proceed', 'proceed_with_changes', 'refine', 'hold', 'reject'
  ));

-- ---------------------------------------------------------------------------
-- 2. Revision history
-- ---------------------------------------------------------------------------
-- One row per SUPERSEDED state of a concept. The live product_concepts row
-- is always the current revision and is never duplicated in here, so
-- "give me the current concept" stays a plain select on product_concepts
-- with no filtering -- the property that makes this design non-breaking.
--
-- Immutable by construction: there are no insert/update/delete policies on
-- this table at all, and the only writer is the SECURITY DEFINER trigger
-- below. Same stance as sample_notification_log (function-written, never
-- client-written). Preserving prior concept work is a hard requirement of
-- the brief, so it is enforced in the schema rather than by convention.

create table if not exists public.product_concept_revisions (
  id                     uuid primary key default gen_random_uuid(),
  concept_id             uuid not null references public.product_concepts(id) on delete cascade,
  company_entity_id      uuid references public.entities(id),

  -- The revision number this snapshot represents (i.e. the number the
  -- concept carried BEFORE the change that created this row).
  revision_number        integer not null,

  -- The immediately-previous revision row, giving an explicit chain in
  -- addition to the implicit revision_number ordering.
  supersedes_revision_id uuid references public.product_concept_revisions(id) on delete set null,

  -- Full to_jsonb() of the concept row as it was at this revision.
  snapshot               jsonb not null,

  -- Column names whose values actually changed in the update that
  -- superseded this snapshot -- lets a diff view avoid re-comparing blobs.
  changed_fields         text[] not null default '{}',

  -- One-line description of the change, sourced from the concept's
  -- revision_note at update time.
  change_summary         text,

  created_by             uuid references public.profiles(id),
  created_at             timestamptz not null default now(),

  unique (concept_id, revision_number)
);

create index if not exists product_concept_revisions_concept_idx
  on public.product_concept_revisions (concept_id, revision_number desc);

create index if not exists product_concept_revisions_company_idx
  on public.product_concept_revisions (company_entity_id, created_at desc);

alter table public.product_concept_revisions enable row level security;

-- Read follows the parent concept's own visibility. No write policies
-- exist on purpose: history is written only by the trigger below.
drop policy if exists product_concept_revisions_select on public.product_concept_revisions;
create policy product_concept_revisions_select on public.product_concept_revisions
  for select using (company_entity_id = active_company_id());

revoke all on public.product_concept_revisions from anon;
grant select on public.product_concept_revisions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Revision trigger
-- ---------------------------------------------------------------------------
-- Fires on every real UPDATE of a concept: snapshots the OLD state into
-- product_concept_revisions and advances the live row's revision number.
--
-- SECURITY DEFINER because product_concept_revisions intentionally has no
-- INSERT policy for anyone -- history must be recorded whether the update
-- came from the Ask SILO edge function, a page, or hand-written SQL, and
-- must not be suppressible by the person making the change. It only ever
-- writes a copy of a row the caller was already permitted to update (RLS
-- on product_concepts has already passed by the time this runs), so it
-- grants no read or write reach the caller did not already have.
--
-- BEFORE UPDATE rather than AFTER so it can set NEW.current_revision_number
-- in the same pass; the inserted snapshot is of OLD, which is complete and
-- final at this point regardless.

create or replace function public.record_product_concept_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed  text[];
  v_previous uuid;
begin
  -- Ignore no-op updates (a PostgREST patch that sets a column to the
  -- value it already had would otherwise mint an empty revision).
  if to_jsonb(old.*) - 'updated_at' - 'current_revision_number' - 'revision_note'
     = to_jsonb(new.*) - 'updated_at' - 'current_revision_number' - 'revision_note' then
    return new;
  end if;

  select coalesce(array_agg(n.key order by n.key), '{}'::text[])
    into v_changed
  from jsonb_each(to_jsonb(new.*)) n(key, value)
  where n.key not in ('updated_at', 'current_revision_number', 'revision_note')
    and n.value is distinct from (to_jsonb(old.*) -> n.key);

  select id into v_previous
  from public.product_concept_revisions
  where concept_id = old.id
  order by revision_number desc
  limit 1;

  insert into public.product_concept_revisions (
    concept_id, company_entity_id, revision_number, supersedes_revision_id,
    snapshot, changed_fields, change_summary, created_by
  ) values (
    old.id,
    old.company_entity_id,
    old.current_revision_number,
    v_previous,
    to_jsonb(old.*),
    v_changed,
    new.revision_note,
    auth.uid()
  );

  new.current_revision_number := old.current_revision_number + 1;
  return new;
end;
$$;

-- Named with the trg_ prefix used elsewhere in this schema. Ordering
-- against the existing set_updated_at BEFORE UPDATE trigger does not
-- matter: this one ignores updated_at entirely when diffing.
drop trigger if exists trg_product_concept_revision on public.product_concepts;
create trigger trg_product_concept_revision
  before update on public.product_concepts
  for each row execute function public.record_product_concept_revision();

-- ---------------------------------------------------------------------------
-- 4. Views
-- ---------------------------------------------------------------------------
-- product_concepts_v gains the new columns.
--
-- DROP then CREATE rather than CREATE OR REPLACE: replace can only APPEND
-- columns, never insert one into the middle, so re-running this migration
-- after adding a column anywhere but the end fails with "cannot change
-- name of view column X to Y" -- hit for real while adding
-- suggested_product_type here. Dropping first makes the migration
-- re-runnable no matter how the column list is later reordered. Safe
-- because nothing in the database depends on this view (it is read by
-- Ask SILO queries and the UI, not by other views/matviews), and the
-- grants below are reissued immediately after.

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
  -- structured template (20260825120000)
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
  (select count(*) from public.product_concept_revisions r where r.concept_id = c.id) as revision_count
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id
left join public.po_headers po on po.id = c.resulting_po_header_id
left join public.product_concepts parent on parent.id = c.parent_concept_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;

-- History with author names and the concept's title, for a revision
-- drawer or an "how did this concept evolve" question in chat.
drop view if exists public.product_concept_revisions_v;
create view public.product_concept_revisions_v
with (security_invoker = true) as
select
  r.id,
  r.concept_id,
  c.title as concept_title,
  r.company_entity_id,
  r.revision_number,
  r.supersedes_revision_id,
  r.changed_fields,
  r.change_summary,
  r.snapshot,
  r.created_by,
  p.name as created_by_name,
  r.created_at
from public.product_concept_revisions r
left join public.product_concepts c on c.id = r.concept_id
left join public.profiles p on p.id = r.created_by;

revoke all on public.product_concept_revisions_v from anon;
grant select on public.product_concept_revisions_v to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Ask SILO schema catalog
-- ---------------------------------------------------------------------------
-- Required after any migration that changes public tables/views, per
-- 20260821210000_silo_chat_schema_catalog.sql. Auto-generates the column
-- lists for the new table/views and refreshes the changed ones; the
-- curated descriptions below are what the model actually reads for
-- meaning, so they are set explicitly rather than left to drift.

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief','revision','evidence'],
  description = $d$Ask SILO's Product Concepts. ONE row per real concept, always the CURRENT state -- superseded states live in product_concept_revisions, so this table never needs an is_current filter and never returns the same concept twice. Two independent axes: parent_concept_id groups a COLLECTION (sibling products sharing one strategic brief -- parent holds angle/audience/timing/spend, children hold title/qty/factory/size), while revision history is the separate time axis. suggested_product_type names the category in products_master.product_type's own vocabulary (e.g. "Youth Cap") and is what carries into po_lines.product_type_snapshot when a concept becomes a PO. Beyond the suggested_* draft fields it carries a structured brief: objective/primary_goal, historical_evidence, economics, forecast (conservative/base/upside), risks, unknowns, recommendation/next_decision, plus field_evidence (per-field INPUT/DATA/ASSUMPTION/RECOMMENDATION classification with a qualitative strength) and provenance (which tables/date ranges/metrics backed each claim). evidence_strength is qualitative -- strong/moderate/early, never a percentage. Legacy concepts created before 2026-08-25 have these columns null and no revisions; that means "not recorded", not "zero". product_concepts_v adds creator/approver/factory/parent names and revision_count.$d$
where relname = 'product_concepts';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','revision','history','lineage','version','changes'],
  description = $d$Immutable history for product_concepts -- one row per SUPERSEDED state, written only by a database trigger (no client can insert, update, or delete). snapshot is the full concept row as it was; revision_number is the number the concept carried at that point; changed_fields/change_summary describe the edit that replaced it; supersedes_revision_id chains to the prior revision. The CURRENT state is never in here -- it is the live product_concepts row. Query this only when a user explicitly asks about history/how a concept changed; product_concept_revisions_v adds the concept title and author name.$d$
where relname = 'product_concept_revisions';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','revision','history','lineage','version'],
  description = $d$product_concept_revisions with the concept's title and the author's name joined in. Same rule as the base table: superseded states only, never the current one.$d$
where relname = 'product_concept_revisions_v';
