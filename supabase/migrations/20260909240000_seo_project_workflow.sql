-- The SEO project workflow: baseline, prioritised tasks, drafted copy,
-- approval, publication, and measurement.
--
-- WHY NOT launch_tasks. Checked before building (2026-09-09) rather than
-- assumed: /v2/tasks.html -- the Task Manager -- reads launch_tasks, and there
-- is no generic `tasks` table in this database at all. launch_tasks hangs off
-- launch_id, and carries no target page, no revision history, no approval gate
-- and no concept of publication. Reusing it would mean minting a
-- launch_calendar row per SEO project, and launch_calendar feeds
-- launch_actuals_v, launch_measurability_v and calendar_events_v -- so every
-- SEO project would become a fake "launch" that those views then try to
-- measure. The tables below are new; the PATTERNS are borrowed from
-- product_concepts (immutable revisions via a BEFORE UPDATE trigger) and
-- silo_chat_managers (a narrow grant table beside a role check).
--
-- THE TWO INVARIANTS THIS SCHEMA EXISTS TO ENFORCE
--
-- 1. APPROVAL NEVER PUBLISHES ANYTHING. Publishing is manual and happens in
--    Shopify, by a person. So seo_tasks has NO publication column at all --
--    not a flag someone could set, not a status value the pipeline could
--    advance into. A task is published if and only if a row exists in
--    seo_task_publications recording that it was, and seo_tasks_v derives it
--    from there. This is structural: there is no code path, policy gap or
--    well-meaning UPDATE that can mark something live because it was
--    approved. Approval and publication are different facts with different
--    evidence.
--
-- 2. A BASELINE MUST PREDATE THE CHANGE IT IS A BASELINE FOR. Enforced by
--    trigger on the measurement's REPORTING PERIOD, not on when someone got
--    round to recording it: a baseline measured over a window that overlaps
--    or follows publication is not a baseline, it is a follow-up mislabelled,
--    and it would make any before/after comparison meaningless.
--
-- And one thing this schema deliberately does NOT do: there is no
-- baseline-vs-follow-up delta view. A change between two windows is evidence
-- of MOVEMENT, never proof of causation -- seasonality, promotions, paid spend
-- and site-wide changes all move the same numbers -- and a view that hands
-- back a tidy "+18%" invites exactly the claim the rest of this work exists to
-- prevent. Pair the windows deliberately, in the open, with the caveat
-- attached.

-- ── Who may approve ─────────────────────────────────────────────────────────
-- A narrow grant beside the role check, the silo_chat_managers pattern.
-- Promoting someone to `executive` to let them approve SEO copy would also
-- hand them review-template building and whole-company roster visibility;
-- and inheriting is_admin_user() would be worse still, since 28 of 29
-- Baseballism profiles carry membership 'admin'.
create table if not exists public.seo_approvers (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  granted_by        uuid references auth.users(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now()
);

create unique index if not exists seo_approvers_identity
  on public.seo_approvers (company_entity_id, user_id);

alter table public.seo_approvers enable row level security;

-- A granted user may see their own row to self-check; only exec/owner see the
-- whole list or change it.
drop policy if exists seo_approvers_select on public.seo_approvers;
create policy seo_approvers_select on public.seo_approvers
  for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists seo_approvers_write on public.seo_approvers;
create policy seo_approvers_write on public.seo_approvers
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

-- SECURITY DEFINER + explicit search_path, same shape as
-- can_manage_silo_notes: it reads the caller's own rows, and as INVOKER every
-- call would re-evaluate the policies on the tables it reads.
--
-- Company isolation is in the function itself, not left to the caller: the
-- grant only counts for the caller's ACTIVE company, so an approver at one
-- tenant cannot approve at another.
create or replace function public.can_approve_seo_tasks()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_exec_or_owner()
    or exists (
      select 1 from public.seo_approvers a
      where a.user_id = auth.uid()
        and a.company_entity_id = public.active_company_id()
    );
$$;

comment on function public.can_approve_seo_tasks() is
  'May the caller approve SEO tasks for their ACTIVE company: exec/owner, or '
  'an explicit seo_approvers grant. Deliberately narrower than is_admin_user() '
  '-- nearly every profile here carries membership admin.';

-- ── Projects ────────────────────────────────────────────────────────────────
create table if not exists public.seo_projects (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  name              text not null,
  objective         text,
  status            text not null default 'draft'
                    check (status in ('draft', 'active', 'complete', 'abandoned')),
  -- What evidence was available when this project was scoped. Recorded so a
  -- project run before Search Console existed is not later read as though it
  -- had search data.
  evidence_note     text,
  created_by        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists seo_projects_company on public.seo_projects (company_entity_id, status);

alter table public.seo_projects enable row level security;

drop policy if exists seo_projects_select on public.seo_projects;
create policy seo_projects_select on public.seo_projects
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists seo_projects_write on public.seo_projects;
create policy seo_projects_write on public.seo_projects
  for all to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

-- ── Tasks ───────────────────────────────────────────────────────────────────
-- NOTE THE ABSENCE. There is no published/live/publication_status column here,
-- and adding one would defeat invariant 1 above. Read seo_tasks_v.
create table if not exists public.seo_tasks (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  project_id        uuid not null references public.seo_projects(id) on delete cascade,

  title             text not null,
  -- What the change is aimed at. target_url is free text on purpose: a task
  -- may name a page that does not exist yet, which the page-inspect allowlist
  -- would (correctly) refuse to fetch.
  target_type       text check (target_type in ('product', 'collection', 'page', 'blog', 'site', 'other')),
  target_url        text,
  target_handle     text,

  rationale         text,
  -- The drafted change itself.
  proposed_title    text,
  proposed_meta_description text,
  proposed_body     text,

  priority          integer,
  -- Approval ONLY. Not publication.
  approval_status   text not null default 'draft'
                    check (approval_status in ('draft', 'proposed', 'approved', 'rejected')),
  approved_by       uuid references auth.users(id) on delete set null,
  approved_at       timestamptz,
  rejection_reason  text,

  current_revision_number integer not null default 0,
  revision_note     text,

  created_by        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists seo_tasks_project on public.seo_tasks (project_id, approval_status);
create index if not exists seo_tasks_company on public.seo_tasks (company_entity_id, approval_status);

alter table public.seo_tasks enable row level security;

drop policy if exists seo_tasks_select on public.seo_tasks;
create policy seo_tasks_select on public.seo_tasks
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists seo_tasks_insert on public.seo_tasks;
create policy seo_tasks_insert on public.seo_tasks
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    -- A task cannot be born approved.
    and (approval_status <> 'approved' or public.can_approve_seo_tasks())
  );

-- The creator keeps editing their own draft; an approver may edit anyone's.
-- The WITH CHECK is where approval is actually enforced: RLS sees only the NEW
-- row, and "you may not leave this row in the approved state unless you can
-- approve" is exactly the right rule to express that way -- it holds no matter
-- which column the writer touched or what the row said before.
drop policy if exists seo_tasks_update on public.seo_tasks;
create policy seo_tasks_update on public.seo_tasks
  for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (created_by = auth.uid() or public.can_approve_seo_tasks())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (created_by = auth.uid() or public.can_approve_seo_tasks())
    and (approval_status <> 'approved' or public.can_approve_seo_tasks())
  );

drop policy if exists seo_tasks_delete on public.seo_tasks;
create policy seo_tasks_delete on public.seo_tasks
  for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (created_by = auth.uid() or public.can_approve_seo_tasks())
  );

-- ── Revisions (immutable) ───────────────────────────────────────────────────
-- product_concept_revisions' stance exactly: written ONLY by the trigger, with
-- a select policy and no insert/update/delete policy at all, so no client can
-- rewrite or erase the history of what a page was asked to say.
create table if not exists public.seo_task_revisions (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  task_id           uuid not null references public.seo_tasks(id) on delete cascade,
  revision_number   integer not null,
  snapshot          jsonb not null,
  changed_fields    text[],
  change_summary    text,
  changed_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists seo_task_revisions_task
  on public.seo_task_revisions (task_id, revision_number desc);

alter table public.seo_task_revisions enable row level security;

drop policy if exists seo_task_revisions_select on public.seo_task_revisions;
create policy seo_task_revisions_select on public.seo_task_revisions
  for select to authenticated
  using (company_entity_id = public.active_company_id());

create or replace function public.record_seo_task_revision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_changed text[];
begin
  -- Ignore bookkeeping columns when deciding whether anything changed, so a
  -- patch that alters nothing mints no revision.
  select array_agg(key)
    into v_changed
  from jsonb_each(to_jsonb(old))
  where key not in ('updated_at', 'current_revision_number', 'revision_note')
    and to_jsonb(old) -> key is distinct from to_jsonb(new) -> key;

  if v_changed is null or array_length(v_changed, 1) is null then
    return new;
  end if;

  insert into public.seo_task_revisions (
    company_entity_id, task_id, revision_number, snapshot,
    changed_fields, change_summary, changed_by
  ) values (
    old.company_entity_id, old.id, old.current_revision_number,
    to_jsonb(old), v_changed, new.revision_note, auth.uid()
  );

  new.current_revision_number := old.current_revision_number + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_record_seo_task_revision on public.seo_tasks;
create trigger trg_record_seo_task_revision
  before update on public.seo_tasks
  for each row execute function public.record_seo_task_revision();

-- ── Publication: the only way a task becomes live ───────────────────────────
create table if not exists public.seo_task_publications (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  task_id           uuid not null references public.seo_tasks(id) on delete cascade,

  -- The date the change ACTUALLY went live, supplied by the person who did it.
  -- Separate from recorded_at, because those differ and every follow-up window
  -- must be measured from the former.
  published_at      timestamptz not null,
  recorded_at       timestamptz not null default now(),
  published_by      uuid references auth.users(id) on delete set null default auth.uid(),

  --  manual_confirmation — a person states they made the change live
  --  verified_capture    — a page_inspections row shows the change on the page
  method            text not null check (method in ('manual_confirmation', 'verified_capture')),
  verification_inspection_id uuid references public.page_inspections(id) on delete set null,
  note              text,

  -- A "verified" publication with nothing to verify against is just a claim
  -- wearing a stronger word.
  constraint seo_task_publications_verified_needs_evidence
    check (method <> 'verified_capture' or verification_inspection_id is not null)
);

create index if not exists seo_task_publications_task
  on public.seo_task_publications (task_id, published_at desc);

alter table public.seo_task_publications enable row level security;

drop policy if exists seo_task_publications_select on public.seo_task_publications;
create policy seo_task_publications_select on public.seo_task_publications
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Any active member may record that they published something -- it is a
-- statement of fact by the person who did the work, not a permission.
drop policy if exists seo_task_publications_insert on public.seo_task_publications;
create policy seo_task_publications_insert on public.seo_task_publications
  for insert to authenticated
  with check (company_entity_id = public.active_company_id());

-- No update policy: a publication record is an event, and events are not
-- edited. A correction is a delete by an approver plus a new row, so the
-- correction is itself attributable.
drop policy if exists seo_task_publications_delete on public.seo_task_publications;
create policy seo_task_publications_delete on public.seo_task_publications
  for delete to authenticated
  using (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks());

-- ── Measurements ────────────────────────────────────────────────────────────
create table if not exists public.seo_measurements (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  project_id        uuid references public.seo_projects(id) on delete cascade,
  task_id           uuid references public.seo_tasks(id) on delete cascade,

  -- WHERE THE NUMBER CAME FROM. Constrained rather than free text so a
  -- measurement can never quietly become source-less, and so the two search
  -- sources stay nameable and separable.
  source            text not null check (source in (
                      'ga4_landing_pages', 'ga4_channel',
                      'shopify_sessions', 'shopify_landing_pages',
                      'shopify_sales', 'shopify_inventory',
                      'search_console_query', 'search_console_page',
                      'page_inspection', 'manual'
                    )),
  metric            text not null,
  value             numeric,
  unit              text,

  -- Which side of the change this window sits on.
  window_kind       text not null check (window_kind in ('baseline', 'follow_up')),
  period_start      date not null,
  period_end        date not null,
  captured_at       timestamptz not null default now(),

  -- What this number is actually OF. A sessions figure for one landing page
  -- filtered to organic is a different measurement from site-wide sessions,
  -- and without these two columns they are indistinguishable rows.
  dimensions        jsonb not null default '{}'::jsonb,
  filters           jsonb not null default '{}'::jsonb,

  -- Tri-state: null means nobody established whether the source was complete
  -- for this window, which is NOT the same as knowing it was incomplete.
  is_complete       boolean,
  completeness_note text,
  evidence_inspection_id uuid references public.page_inspections(id) on delete set null,

  created_by        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),

  constraint seo_measurements_period_ordered check (period_end >= period_start),
  constraint seo_measurements_has_subject check (project_id is not null or task_id is not null)
);

create index if not exists seo_measurements_task
  on public.seo_measurements (task_id, window_kind, period_start);
create index if not exists seo_measurements_project
  on public.seo_measurements (project_id, window_kind, period_start);

alter table public.seo_measurements enable row level security;

drop policy if exists seo_measurements_select on public.seo_measurements;
create policy seo_measurements_select on public.seo_measurements
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists seo_measurements_insert on public.seo_measurements;
create policy seo_measurements_insert on public.seo_measurements
  for insert to authenticated
  with check (company_entity_id = public.active_company_id());

-- Measurements are not edited into agreement with a story. Correcting one is a
-- delete by an approver plus a fresh row.
drop policy if exists seo_measurements_delete on public.seo_measurements;
create policy seo_measurements_delete on public.seo_measurements
  for delete to authenticated
  using (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks());

-- Invariant 2. Checked on the REPORTING PERIOD, not on captured_at: recording
-- a baseline late is fine and normal, measuring one over a window that runs
-- past the change is not a baseline at all.
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

  if v_published is not null and new.period_end > v_published::date then
    raise exception
      'baseline period ends % but the task was published % — a window that '
      'reaches past the change is a follow-up, not a baseline',
      new.period_end, v_published::date
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_seo_baseline_precedes_publication on public.seo_measurements;
create trigger trg_seo_baseline_precedes_publication
  before insert or update on public.seo_measurements
  for each row execute function public.check_seo_baseline_precedes_publication();

-- ── The read model ──────────────────────────────────────────────────────────
drop view if exists public.seo_tasks_v;
create view public.seo_tasks_v
with (security_invoker = true) as
select
  t.*,
  p.name                as project_name,
  p.status              as project_status,
  creator.name          as created_by_name,
  approver.name         as approved_by_name,
  pub.published_at,
  pub.method            as publication_method,
  pub.verification_inspection_id,
  -- Derived from evidence, never stored. Approving a task cannot change this
  -- column because nothing about approval writes seo_task_publications.
  (pub.id is not null)  as is_published,
  (select count(*) from public.seo_task_revisions r where r.task_id = t.id) as revision_count
from public.seo_tasks t
join public.seo_projects p on p.id = t.project_id
left join public.profiles creator  on creator.id  = t.created_by
left join public.profiles approver on approver.id = t.approved_by
left join lateral (
  select pp.* from public.seo_task_publications pp
  where pp.task_id = t.id
  order by pp.published_at desc
  limit 1
) pub on true;

comment on view public.seo_tasks_v is
  'SEO tasks with project, names, revision count and publication state. '
  'is_published/published_at are DERIVED from seo_task_publications and are '
  'not columns on seo_tasks -- approval alone can never make a task look '
  'live. approval_status = ''approved'' means someone signed off on the copy; '
  'it says nothing about whether the change is on the site.';

insert into public.silo_chat_schema_catalog (relname, relkind, description, keywords, columns)
values
  ('seo_projects', 'r',
   'An SEO workstream: objective, status, and what evidence was available when '
   'it was scoped. Tasks hang off this.',
   array['seo','project','workflow'], '[]'::jsonb),
  ('seo_tasks', 'r',
   'One proposed SEO change: target page, rationale, and the drafted title / '
   'meta description / body. approval_status is APPROVAL ONLY (draft, '
   'proposed, approved, rejected). THERE IS NO PUBLICATION COLUMN HERE ON '
   'PURPOSE -- publishing is manual and a task counts as live only when a row '
   'exists in seo_task_publications. Never describe an approved task as live, '
   'published or done; read seo_tasks_v.is_published.',
   array['seo','task','copy','approval','draft'], '[]'::jsonb),
  ('seo_task_revisions', 'r',
   'Immutable history of seo_tasks, one row per superseded state, written only '
   'by a trigger. Query when asked how a draft changed, not for current state.',
   array['seo','revision','history','audit'], '[]'::jsonb),
  ('seo_task_publications', 'r',
   'The record that a change actually went live. published_at is the REAL '
   'publication date (recorded_at is when someone typed it in) and every '
   'follow-up window must be measured from published_at. method '
   'verified_capture requires a page_inspections row showing the change; '
   'manual_confirmation is a person''s statement. This table -- not approval '
   '-- is what makes a task published.',
   array['seo','publication','published','live','evidence'], '[]'::jsonb),
  ('seo_measurements', 'r',
   'Numbers attached to an SEO project or task, each carrying its source, '
   'reporting period, capture time, dimensions, filters and completeness. '
   'window_kind says which side of the change it sits on; a baseline is '
   'enforced to end on or before publication. TWO RULES WHEN READING THESE: '
   '(1) never combine search_console_query rows with ga4/shopify session '
   'rows, and NEVER attribute sessions to an individual search query -- no '
   'source here supports that link; (2) a difference between a baseline and a '
   'follow-up is evidence of MOVEMENT, not proof that the change caused it. '
   'Seasonality, promotions, paid spend and site-wide changes move the same '
   'numbers. Say what moved and over which windows; do not claim the task did '
   'it. is_complete is TRI-STATE: null means nobody established completeness, '
   'which is not the same as incomplete.',
   array['seo','measurement','baseline','followup','evidence','period'], '[]'::jsonb),
  ('seo_tasks_v', 'v',
   'Read model for SEO tasks: adds project, creator/approver names, revision '
   'count, and publication state DERIVED from seo_task_publications. Use '
   'is_published, never approval_status, to answer whether a change is live.',
   array['seo','task','published','approval'], '[]'::jsonb)
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

select public.refresh_chat_schema_catalog();
