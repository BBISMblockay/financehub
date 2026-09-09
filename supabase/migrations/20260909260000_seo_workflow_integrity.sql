-- Forward-corrective migration for 20260909220000 and 20260909240000, both of
-- which are already applied to production. Nothing here edits those files;
-- this is additive and re-runnable, so a rebuild from apply_all_post_merge.sql
-- lands in the same place as prod.
--
-- Fixes three things review found.
--
-- A. TENANT IDENTITY WAS NOT TIED TO THE PARENT ROW. Every child table carried
--    its own company_entity_id and a plain single-column foreign key to its
--    parent. Those two facts were never checked against each other, so a task
--    could carry company A while pointing at company B's project, and a
--    publication could cite another tenant's page_inspection as its evidence.
--    RLS hid the parent from the caller but did not stop the reference being
--    written, and every downstream read joins on the child's own company id --
--    so the row would look native. Composite foreign keys make the pair itself
--    the thing being referenced, which is the only version that cannot drift.
--
-- B. THE BASELINE INVARIANT WAS ONE-SIDED. The trigger fired on measurements
--    only, so the ordering could be established and then invalidated:
--    insert a baseline while no publication exists (passes, correctly), then
--    record a publication dated inside that baseline's window (nothing
--    checks). The guarantee needs both directions, because either row can
--    arrive second.
--
-- C. SAME-DAY WINDOWS WERE ACCEPTED. The check was period_end > published,
--    so a baseline ending ON the publication date passed. Publication has a
--    time; a daily window does not. A baseline ending the day the change went
--    live contains hours on both sides of it, which is precisely the
--    contamination the invariant exists to prevent.

-- ── A. Composite, company-scoped foreign keys ───────────────────────────────
-- The parents first: a composite FK needs the referenced pair to be unique.
alter table public.seo_projects
  drop constraint if exists seo_projects_id_company_key;
alter table public.seo_projects
  add constraint seo_projects_id_company_key unique (id, company_entity_id);

alter table public.seo_tasks
  drop constraint if exists seo_tasks_id_company_key;
alter table public.seo_tasks
  add constraint seo_tasks_id_company_key unique (id, company_entity_id);

alter table public.page_inspections
  drop constraint if exists page_inspections_id_company_key;
alter table public.page_inspections
  add constraint page_inspections_id_company_key unique (id, company_entity_id);

-- seo_tasks -> seo_projects
alter table public.seo_tasks
  drop constraint if exists seo_tasks_project_id_fkey;
alter table public.seo_tasks
  drop constraint if exists seo_tasks_project_company_fkey;
alter table public.seo_tasks
  add constraint seo_tasks_project_company_fkey
  foreign key (project_id, company_entity_id)
  references public.seo_projects (id, company_entity_id) on delete cascade;

-- seo_task_revisions -> seo_tasks
alter table public.seo_task_revisions
  drop constraint if exists seo_task_revisions_task_id_fkey;
alter table public.seo_task_revisions
  drop constraint if exists seo_task_revisions_task_company_fkey;
alter table public.seo_task_revisions
  add constraint seo_task_revisions_task_company_fkey
  foreign key (task_id, company_entity_id)
  references public.seo_tasks (id, company_entity_id) on delete cascade;

-- seo_task_publications -> seo_tasks
alter table public.seo_task_publications
  drop constraint if exists seo_task_publications_task_id_fkey;
alter table public.seo_task_publications
  drop constraint if exists seo_task_publications_task_company_fkey;
alter table public.seo_task_publications
  add constraint seo_task_publications_task_company_fkey
  foreign key (task_id, company_entity_id)
  references public.seo_tasks (id, company_entity_id) on delete cascade;

-- seo_task_publications -> page_inspections (the evidence).
-- ON DELETE RESTRICT, not SET NULL, and the change is deliberate twice over:
-- SET NULL is impossible on a composite key whose second column is NOT NULL,
-- and quietly detaching a publication from the capture that verified it would
-- turn verified evidence into an unbacked claim without anyone editing the
-- publication. Evidence that is cited cannot be deleted out from under the
-- citation. (MATCH SIMPLE: a NULL inspection id skips the check entirely, so
-- manual_confirmation publications are unaffected.)
alter table public.seo_task_publications
  drop constraint if exists seo_task_publications_verification_inspection_id_fkey;
alter table public.seo_task_publications
  drop constraint if exists seo_task_publications_inspection_company_fkey;
alter table public.seo_task_publications
  add constraint seo_task_publications_inspection_company_fkey
  foreign key (verification_inspection_id, company_entity_id)
  references public.page_inspections (id, company_entity_id) on delete restrict;

-- seo_measurements -> project / task / evidence
alter table public.seo_measurements
  drop constraint if exists seo_measurements_project_id_fkey;
alter table public.seo_measurements
  drop constraint if exists seo_measurements_project_company_fkey;
alter table public.seo_measurements
  add constraint seo_measurements_project_company_fkey
  foreign key (project_id, company_entity_id)
  references public.seo_projects (id, company_entity_id) on delete cascade;

alter table public.seo_measurements
  drop constraint if exists seo_measurements_task_id_fkey;
alter table public.seo_measurements
  drop constraint if exists seo_measurements_task_company_fkey;
alter table public.seo_measurements
  add constraint seo_measurements_task_company_fkey
  foreign key (task_id, company_entity_id)
  references public.seo_tasks (id, company_entity_id) on delete cascade;

alter table public.seo_measurements
  drop constraint if exists seo_measurements_evidence_inspection_id_fkey;
alter table public.seo_measurements
  drop constraint if exists seo_measurements_evidence_company_fkey;
alter table public.seo_measurements
  add constraint seo_measurements_evidence_company_fkey
  foreign key (evidence_inspection_id, company_entity_id)
  references public.page_inspections (id, company_entity_id) on delete restrict;

-- ── B + C. The baseline invariant, both directions and same-day ─────────────
-- Shared so the two triggers cannot drift into disagreeing about what "before"
-- means. A baseline whose window ends on or after the publication DATE is
-- rejected: publication has a time of day, a daily window does not, and a
-- window ending that day straddles the change.
create or replace function public.seo_baseline_conflicts(
  p_period_end date,
  p_published timestamptz
) returns boolean
language sql
immutable
as $$
  select p_published is not null and p_period_end >= p_published::date;
$$;

comment on function public.seo_baseline_conflicts(date, timestamptz) is
  'True when a baseline window ending p_period_end cannot be a baseline for a '
  'change published at p_published. Uses >= deliberately: a daily window '
  'ending on the publication date contains hours on both sides of the change.';

create or replace function public.check_seo_baseline_precedes_publication()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_published timestamptz;
begin
  if new.window_kind <> 'baseline' or new.task_id is null then
    return new;
  end if;

  select min(p.published_at) into v_published
  from public.seo_task_publications p
  where p.task_id = new.task_id;

  if public.seo_baseline_conflicts(new.period_end, v_published) then
    raise exception
      'baseline period ends % but the task was published % -- a window ending on or after the change is a follow-up, not a baseline',
      new.period_end, v_published
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- The reciprocal half. Without it the ordering can be established and then
-- invalidated by a later publication, which is the same guarantee arriving in
-- the other order.
create or replace function public.check_publication_after_baselines()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bad date;
begin
  select max(m.period_end) into v_bad
  from public.seo_measurements m
  where m.task_id = new.task_id
    and m.window_kind = 'baseline'
    and public.seo_baseline_conflicts(m.period_end, new.published_at);

  if v_bad is not null then
    raise exception
      'cannot record publication at % -- this task already has a baseline whose window ends %, which would then straddle the change',
      new.published_at, v_bad
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_check_publication_after_baselines on public.seo_task_publications;
create trigger trg_check_publication_after_baselines
  before insert or update on public.seo_task_publications
  for each row execute function public.check_publication_after_baselines();

-- ── The overstated claim, corrected where it was made ───────────────────────
-- 20260909220000's comment said an exact-match host allowlist excluded
-- private-range access "structurally". It does not: it stops an attacker
-- NAMING an internal address, and says nothing about an allowlisted name
-- RESOLVING to one. Address validation now happens at the fetch layer on every
-- hop, and the comment should not keep claiming otherwise.
comment on table public.shopify_shop_domains is
  'Storefront hosts SILO is permitted to fetch, learned from Shopify itself '
  '(the shop object''s domain + myshopify_domain) for each connected shop, and '
  'RETIRED by the same sync when a shop stops serving them -- an allowlist '
  'that only grows keeps authorising domains that were sold or transferred. '
  'THIS IS A SECURITY BOUNDARY for the page-inspect edge function: no client '
  'write policy, because a row here authorises an outbound fetch. It is '
  'necessary and NOT sufficient -- an allowlisted name can still resolve to a '
  'private or link-local address, so page-inspect additionally requires HTTPS '
  'and validates that every resolved address is public unicast, on every '
  'redirect hop.';

select public.refresh_chat_schema_catalog();
