-- Concept -> PO -> Launch: the first hop, and the links the rest hangs off.
--
-- The intended lifecycle is concept (strategy) -> PO (committed reality,
-- with a human approving and ADJUSTING the buy) -> launch (brief =
-- strategy + committed numbers) -> actuals measured against it. The PO
-- gate is load-bearing, not a formality: quantity, factory and dates all
-- move during it. Pre-filling a launch straight from a concept would
-- record draft numbers as the objective and then measure actuals against
-- a target the PO had already changed.
--
-- Cardinality, learned the hard way earlier in this design: a single
-- back-pointer (po_headers.source_concept_id) cannot express "combine
-- three concepts into one buy", which is the normal case for a collection
-- whose products share a factory. po_headers.factory_id is a single FK --
-- one PO is one factory -- so a collection spanning two factories is
-- necessarily two POs no matter how this is modelled. Hence a join table
-- with two real foreign keys. This is NOT the polymorphic
-- (target_table, target_id) shape that cannot carry referential
-- integrity; both sides are typed.
--
-- product_concepts.resulting_po_header_id (20260821140000) is left alone
-- and stays unused: it encodes one-PO-per-concept, the wrong direction and
-- the wrong cardinality. Deliberately not dropped here -- removing it is a
-- separate decision, and nothing reads it today.

-- ---------------------------------------------------------------------------
-- 1. Which concepts a PO was built from
-- ---------------------------------------------------------------------------
create table if not exists public.po_concept_links (
  id                uuid primary key default gen_random_uuid(),
  po_header_id      uuid not null references public.po_headers(id) on delete cascade,
  concept_id        uuid not null references public.product_concepts(id) on delete restrict,
  company_entity_id uuid references public.entities(id),
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  unique (po_header_id, concept_id)
);

-- on delete restrict on concept_id, not cascade: once a concept has become
-- a real buy, deleting it would silently erase why that PO exists. The
-- concept can still be archived.

create index if not exists po_concept_links_po_idx on public.po_concept_links (po_header_id);
create index if not exists po_concept_links_concept_idx on public.po_concept_links (concept_id);

alter table public.po_concept_links enable row level security;

drop policy if exists po_concept_links_select on public.po_concept_links;
create policy po_concept_links_select on public.po_concept_links
  for select using (company_entity_id = active_company_id());

-- Writes follow the PO's own gate: creating this link is part of building
-- a PO, so it uses the same permission PO Builder already requires.
drop policy if exists po_concept_links_insert on public.po_concept_links;
create policy po_concept_links_insert on public.po_concept_links
  for insert with check (company_entity_id = active_company_id() and po_builder_can_write());

drop policy if exists po_concept_links_delete on public.po_concept_links;
create policy po_concept_links_delete on public.po_concept_links
  for delete using (company_entity_id = active_company_id() and po_builder_can_write());

drop trigger if exists stamp_created_by on public.po_concept_links;
create trigger stamp_created_by before insert on public.po_concept_links
  for each row execute function public.stamp_created_by();

revoke all on public.po_concept_links from anon;
grant select, insert, delete on public.po_concept_links to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Line-level attribution
-- ---------------------------------------------------------------------------
-- Which concept produced this specific PO line. The header link says which
-- concepts fed the buy; this says which line came from which -- needed
-- because when three concepts combine into one PO their evidence strength
-- differs per line, and a reviewer approving the buy should be able to see
-- that line 3 came from an 'early'-evidence concept.
alter table public.po_lines
  add column if not exists source_concept_id uuid references public.product_concepts(id) on delete set null;

create index if not exists po_lines_source_concept_idx on public.po_lines (source_concept_id);

-- ---------------------------------------------------------------------------
-- 3. Launch <- concept
-- ---------------------------------------------------------------------------
-- launch_calendar.linked_po_id already exists (and is used by 0 of 51
-- rows). For a collection the launch corresponds to the PARENT concept --
-- one themed drop, several products, potentially several POs -- so the
-- launch links to the concept directly rather than being inferred through
-- whichever PO happened to be first.
alter table public.launch_calendar
  add column if not exists source_concept_id uuid references public.product_concepts(id) on delete set null;

create index if not exists launch_calendar_source_concept_idx on public.launch_calendar (source_concept_id);

-- ---------------------------------------------------------------------------
-- 4. What a concept became
-- ---------------------------------------------------------------------------
-- Answers "did this idea ever turn into anything" without the caller
-- needing to know the link topology.
create or replace view public.product_concept_outcomes_v
with (security_invoker = true) as
select
  c.id as concept_id,
  c.title,
  c.status,
  c.phase,
  c.parent_concept_id,
  (select count(*) from public.po_concept_links l where l.concept_id = c.id) as po_count,
  (select count(*) from public.po_lines pl where pl.source_concept_id = c.id) as po_line_count,
  (select coalesce(sum(pl.qty), 0) from public.po_lines pl where pl.source_concept_id = c.id) as units_ordered,
  (select min(h.expected_arrival_date)
     from public.po_concept_links l join public.po_headers h on h.id = l.po_header_id
    where l.concept_id = c.id) as earliest_expected_arrival,
  (select count(*) from public.launch_calendar lc where lc.source_concept_id = c.id) as launch_count
from public.product_concepts c;

revoke all on public.product_concept_outcomes_v from anon;
grant select on public.product_concept_outcomes_v to authenticated;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['concept','po','purchase order','link','became','origin'],
  description = $d$Join table recording which product concepts a purchase order was built from. Many-to-one on purpose: several concepts can combine into ONE PO when they share a factory (po_headers.factory_id is a single FK, so one PO is always one factory, and a collection spanning two factories is necessarily two POs). po_lines.source_concept_id gives the finer, per-line attribution. Use product_concept_outcomes_v to ask "what did this concept become" without joining these yourself.$d$
where relname = 'po_concept_links';

update public.silo_chat_schema_catalog set
  keywords = array['concept','outcome','became','po','launch','units ordered'],
  description = $d$What each product concept actually turned into: how many POs it fed, how many PO lines and units were ordered from it, the earliest expected arrival across those POs, and how many launches reference it. The quickest way to answer "did this idea ever become a real buy" or "which concepts are still just drafts".$d$
where relname = 'product_concept_outcomes_v';
