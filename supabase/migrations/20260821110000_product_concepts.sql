-- Product Concepts: Ask SILO's product-generation branch.
--
-- Working-backward vision (see 2026-08-21 planning thread): a purchase
-- order for a genuinely new product should start life as a concept Ask
-- SILO proposes -- grounded in taught brand notes (silo_chat_notes) and
-- this company's own past launch performance (launch_calendar) -- not as
-- a brief written right before launch, disconnected from the buy
-- decision. This table is step one of that loop: it holds SILO's draft
-- suggestions (buy qty, factory, marketing angle/audience, channel and
-- retail/DTC mix, launch timing, and the reasoning behind them) plus a
-- human approval gate before anything here is treated as real.
--
-- This migration is deliberately scoped to concept generation + approval
-- only. It does NOT touch po_headers, launch_calendar, or PO Builder --
-- wiring an approved concept into a new-product PO is a separate,
-- later change once this stage has been used for a while.
--
-- Read: any active company member (same "shared team infrastructure"
-- stance as silo_chat_saved_reports/silo_chat_notes). Insert: any active
-- company member can generate a draft. Update/approve: the creator can
-- keep editing their own row while it stays a draft; only
-- po_builder_can_write() users (the same population who can already
-- write PO headers/lines) can approve it or edit someone else's --
-- approving a concept is a purchasing-adjacent decision, so it reuses
-- that existing gate rather than inventing a narrower one.

create table if not exists public.product_concepts (
  id                          uuid primary key default gen_random_uuid(),
  company_entity_id           uuid references public.entities(id),
  created_by                  uuid references public.profiles(id),
  approved_by                 uuid references public.profiles(id),
  approved_at                 timestamptz,

  title                       text not null,
  concept_summary             text,
  marketing_angle             text,
  audience                    text,
  audience_tags               text[] not null default '{}',
  suggested_qty               integer,
  suggested_factory_id        uuid references public.factories(id) on delete set null,
  suggested_channels          text[] not null default '{}',
  suggested_retail_dtc_notes  text,
  suggested_launch_date       date,
  suggested_launch_notes      text,
  reasoning                   text,
  notes                       text,

  status                      text not null default 'draft'
                                check (status in ('draft', 'approved', 'archived')),

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists product_concepts_company_status_idx
  on public.product_concepts (company_entity_id, status, created_at desc);

alter table public.product_concepts enable row level security;

drop policy if exists product_concepts_select on public.product_concepts;
create policy product_concepts_select on public.product_concepts
  for select using (company_entity_id = active_company_id());

drop policy if exists product_concepts_insert on public.product_concepts;
create policy product_concepts_insert on public.product_concepts
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
    and status = 'draft'
  );

drop policy if exists product_concepts_update on public.product_concepts;
create policy product_concepts_update on public.product_concepts
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or po_builder_can_write())
  )
  with check (
    company_entity_id = active_company_id()
    and (
      po_builder_can_write()
      or (created_by = auth.uid() and status = 'draft')
    )
  );

drop policy if exists product_concepts_delete on public.product_concepts;
create policy product_concepts_delete on public.product_concepts
  for delete using (
    company_entity_id = active_company_id()
    and (
      (created_by = auth.uid() and status = 'draft')
      or po_builder_can_write()
    )
  );

drop trigger if exists stamp_created_by on public.product_concepts;
create trigger stamp_created_by before insert on public.product_concepts
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.product_concepts;
create trigger set_updated_at before update on public.product_concepts
  for each row execute function public.set_updated_at();

-- Attaches the stamp_company_entity_id BEFORE INSERT trigger here (and
-- refreshes it everywhere else) so callers can omit company_entity_id.
select public.attach_stamp_company_entity_id_triggers();

revoke all on public.product_concepts from anon;
grant select, insert, update, delete on public.product_concepts to authenticated;

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
  c.updated_at
from public.product_concepts c
left join public.profiles creator on creator.id = c.created_by
left join public.profiles approver on approver.id = c.approved_by
left join public.factories f on f.id = c.suggested_factory_id;

revoke all on public.product_concepts_v from anon;
grant select on public.product_concepts_v to authenticated;
