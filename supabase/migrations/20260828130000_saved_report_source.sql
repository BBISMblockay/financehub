-- Make the saved-report layer generic, so Ask SILO is ONE authoring
-- surface rather than the only door into dashboards.
--
-- Context: v3 dashboards (20260828120000) point a widget at a row in
-- silo_chat_saved_reports. That table's NAME is chat-flavoured but its
-- SHAPE never was -- it is title + queries_run[] + visibility +
-- company_entity_id, which is exactly what a standard report needs too.
-- And chat_run_readonly_query, despite its name, is a generic read-only
-- SQL runner (SECURITY INVOKER, single SELECT/WITH, 500-row cap, 30s
-- timeout). So the reporting ENGINE is already shared; what was missing
-- was a way to say where a report came from.
--
-- This adds that and nothing else. Deliberately NOT here: renaming the
-- table (mechanical, bigger diff than the thing it fixes, and a `source`
-- column buys the architecture without it), a separate report-definition
-- table, report parameters, and any actual system report. The point is
-- that when those arrive, no dashboard_widgets row has to migrate.
--
--   source = 'ask_silo'  an answer pinned from chat (every existing row)
--   source = 'manual'    a report a person defined by hand, company-scoped
--   source = 'system'    a central SILO definition, reusable across tenants
--
-- ── The global/system boundary ────────────────────────────────────────
-- A system definition like "Daily Sales" should exist ONCE and be usable
-- by every company, with the underlying query still returning only the
-- caller's RLS-scoped rows -- the SQL is scoped by the reader's own
-- policies, so one definition scopes itself correctly per tenant. That
-- means company_entity_id IS NULL for those rows.
--
-- NULL company is therefore a privileged state, and the policies below
-- treat it as one. Three independent things have to hold for a global row
-- to exist, and no client can satisfy them:
--
--   1. A table CHECK: company_entity_id IS NULL is only legal alongside
--      source = 'system'. A null-company row can never be a user's report.
--   2. INSERT WITH CHECK requires company_entity_id IS NOT NULL and
--      source IN ('ask_silo','manual'). A client cannot create a global
--      row, and cannot create a system row at all.
--   3. UPDATE USING is company_entity_id = active_company_id(), which is
--      NULL (not true) for a global row -- so no client, exec/owner
--      included, can edit or convert one. UPDATE WITH CHECK repeats the
--      insert conditions so a company row cannot be PROMOTED to global or
--      to 'system' by nulling its company or rewriting its source.
--
-- On point 2, one thing worth being accurate about: the OLD policy already
-- rejected this case, and the explicit IS NOT NULL is not a bug fix.
-- A user whose active company is unset (a real state -- sessionStorage is
-- per-tab and profiles.active_company_id can be empty) gets NULL from
-- active_company_id(), stamp_company_entity_id() therefore stamps NULL,
-- and the old `company_entity_id = active_company_id()` then evaluates
-- NULL = NULL -> NULL, which RLS treats as failure. Verified by removing
-- the guard and re-running: the insert is still denied.
--
-- The explicit test earns its place anyway, for two reasons. It states the
-- rule instead of leaving it to emerge from three-valued logic, which is
-- the kind of thing a later "simplification" quietly breaks -- swap that
-- `=` for anything NULL-tolerant (coalesce, IS NOT DISTINCT FROM) and the
-- accidental protection is gone with no visible change to the policy's
-- apparent meaning. And it is testable: verify_v2_schema.sql asserts the
-- clause is present, which it cannot do for an emergent property.
--
-- System rows are consequently writable only by service role / migrations,
-- which is the intent: centrally controlled definitions.

alter table public.silo_chat_saved_reports
  add column if not exists source text not null default 'ask_silo',
  add column if not exists description text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.silo_chat_saved_reports'::regclass
       and conname = 'silo_chat_saved_reports_source_check'
  ) then
    alter table public.silo_chat_saved_reports
      add constraint silo_chat_saved_reports_source_check
      check (source in ('ask_silo', 'system', 'manual'));
  end if;

  -- Structural half of the guardrail: independent of RLS, and it holds
  -- even for a service-role write that gets the source wrong.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.silo_chat_saved_reports'::regclass
       and conname = 'silo_chat_saved_reports_global_is_system_check'
  ) then
    alter table public.silo_chat_saved_reports
      add constraint silo_chat_saved_reports_global_is_system_check
      check (company_entity_id is not null or source = 'system');
  end if;
end $$;

-- A system/manual definition has a description, not a chat question, and
-- no model-written answer. Ask SILO still writes both on every save, so
-- this changes nothing about existing behaviour -- it only stops the two
-- chat-specific columns from being mandatory for a report that was never
-- a conversation.
alter table public.silo_chat_saved_reports
  alter column question drop not null,
  alter column answer   drop not null;

comment on column public.silo_chat_saved_reports.source is
  'Which authoring surface produced this report: ask_silo (pinned from chat), manual (hand-defined, company-scoped), or system (central SILO definition, company_entity_id IS NULL, reusable across tenants and writable only by service role/migrations).';
comment on column public.silo_chat_saved_reports.description is
  'Plain-language description for reports that were not a chat question. Ask SILO rows carry `question` instead.';

-- ── Policies ──────────────────────────────────────────────────────────
-- SELECT: unchanged for company rows. The new branch is narrow on purpose
-- -- it requires BOTH a null company AND source = 'system', so a
-- null-company row that somehow carried source='ask_silo' would still be
-- visible to nobody rather than to everybody. (The table CHECK above makes
-- that row impossible; this is the second lock on the same door.)
drop policy if exists silo_chat_saved_reports_select on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports
  for select using (
    (
      company_entity_id = active_company_id()
      and (visibility = 'company' or created_by = auth.uid())
    )
    or (
      company_entity_id is null and source = 'system'
    )
  );

-- INSERT: tightened, not widened. Previously "company_entity_id =
-- active_company_id()", which is satisfied by NULL = NULL being... not
-- true, actually -- but the row never reached the check as NULL because
-- the trigger had already stamped it. Now the requirement is explicit and
-- does not depend on a trigger, and 'system' is closed to clients.
drop policy if exists silo_chat_saved_reports_insert on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_insert on public.silo_chat_saved_reports
  for insert with check (
    company_entity_id is not null
    and company_entity_id = active_company_id()
    and source in ('ask_silo', 'manual')
    and (created_by = auth.uid() or created_by is null)
  );

-- UPDATE: USING already denied global rows (NULL = active_company_id() is
-- NULL, not true) -- restated explicitly here because this boundary is the
-- point of the migration and should be readable, not inferred. WITH CHECK
-- now also blocks promotion: a user cannot null their report's company or
-- rewrite its source to 'system' to make it globally visible.
drop policy if exists silo_chat_saved_reports_update on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_update on public.silo_chat_saved_reports
  for update using (
    company_entity_id is not null
    and company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  )
  with check (
    company_entity_id is not null
    and company_entity_id = active_company_id()
    and source in ('ask_silo', 'manual')
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop policy if exists silo_chat_saved_reports_delete on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_delete on public.silo_chat_saved_reports
  for delete using (
    company_entity_id is not null
    and company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

-- ── Views ─────────────────────────────────────────────────────────────
-- `drop view` + `create view`, not `create or replace view`: Postgres can
-- only APPEND columns to an existing view, so replacing one whose column
-- list changed shape fails with "cannot change name of view column". These
-- three v3 migrations each reshape the same views, and
-- apply_all_post_merge.sql runs all of them in sequence -- so a plain
-- replace breaks a fresh rebuild at the second migration, and breaks a
-- re-run of apply_all at the first. Nothing depends on these views, so the
-- drop is safe and no cascade is needed.
drop view if exists public.silo_chat_saved_reports_v;
create view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select
  r.id,
  r.company_entity_id,
  r.created_by,
  p.name as created_by_name,
  r.source,
  r.title,
  r.description,
  r.question,
  r.answer,
  r.queries_run,
  r.visibility,
  r.created_at,
  r.updated_at
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

-- dashboard_widgets_v carries the source through so a tile can say where
-- its data came from without a second query. The widget table itself is
-- untouched by this migration -- that is the whole point: whatever a
-- future report source turns out to be, no widget row migrates.
drop view if exists public.dashboard_widgets_v;
create view public.dashboard_widgets_v
with (security_invoker = true) as
select
  w.id,
  w.dashboard_id,
  w.company_entity_id,
  w.created_by,
  w.report_id,
  w.query_index,
  w.title,
  w.visual_type,
  w.visual_config,
  w.layout,
  w.sort_order,
  w.created_at,
  w.updated_at,
  r.title       as report_title,
  r.question    as report_question,
  r.description as report_description,
  r.source      as report_source,
  r.visibility  as report_visibility,
  r.queries_run[w.query_index + 1] as query_sql,
  coalesce(array_length(r.queries_run, 1), 0) as report_query_count
from public.dashboard_widgets w
left join public.silo_chat_saved_reports r on r.id = w.report_id;

revoke all on public.dashboard_widgets_v from anon;
grant select on public.dashboard_widgets_v to authenticated;
