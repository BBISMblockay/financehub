-- Company-scope launch_task_templates — the last public base table holding
-- app data without company isolation (found in the 2026-07-09 audit of tables
-- missing company_entity_id; every other hit was correct by design: the
-- entity_* registry scopes by membership, profiles is per-user, job_sync_state
-- is service_role-only, and all flagged views are security_invoker over
-- scoped tables or DEFINER readers filtering active_company_id()).
--
-- Its policies were `true` for all authenticated users, so one company's
-- launch checklist templates would have been readable/editable by every
-- other company's users. The table is empty today (0 rows), so this is a
-- latent gap, not a leak — closed with the standard pattern before it ships.

alter table public.launch_task_templates
  add column if not exists company_entity_id uuid references public.entities(id);

-- Repo convention: legacy NULLs belong to Baseballism (no-op while empty,
-- keeps the migration idempotent if rows ever predate it in an environment).
update public.launch_task_templates
   set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
 where company_entity_id is null;

-- Stamp company on insert like every other company-scoped table.
select public.attach_stamp_company_entity_id_triggers();

-- Replace the company-blind policies with active-company isolation.
-- Write access stays open to authenticated users (matching the old
-- semantics — templates are team-editable), but bound to their company.
-- There was no DELETE policy before; that deny stays.
drop policy if exists "launch task templates read authenticated" on public.launch_task_templates;
drop policy if exists "launch task templates insert authenticated" on public.launch_task_templates;
drop policy if exists "launch task templates update authenticated" on public.launch_task_templates;

drop policy if exists launch_task_templates_active_select on public.launch_task_templates;
create policy launch_task_templates_active_select
  on public.launch_task_templates for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists launch_task_templates_active_insert on public.launch_task_templates;
create policy launch_task_templates_active_insert
  on public.launch_task_templates for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists launch_task_templates_active_update on public.launch_task_templates;
create policy launch_task_templates_active_update
  on public.launch_task_templates for update to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());
