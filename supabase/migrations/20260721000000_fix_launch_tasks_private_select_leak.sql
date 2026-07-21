-- Fix: launch_tasks private-task visibility leak.
--
-- 20260616020000_rls_active_company_isolation.sql created launch_tasks_active_write
-- as `FOR ALL USING (company_entity_id = active_company_id())` — "ALL" also covers
-- SELECT. Postgres OR's every applicable policy for a given command, so this
-- policy's unrestricted SELECT silently overrode the is_private filter that
-- 20260708010000_tasks_evergreen_personal.sql added to launch_tasks_active_select:
-- any user in the company could see every private task in the Task Manager /
-- Launch Workbench lists, regardless of assignee/creator, since the day
-- is_private shipped.
--
-- Fix: split the write policy into INSERT/UPDATE/DELETE-only policies (same
-- qual as before — this is a visibility feature, not a write-security boundary,
-- so write access stays company-wide) so it no longer implicitly grants SELECT.

drop policy if exists launch_tasks_active_write on public.launch_tasks;

drop policy if exists launch_tasks_active_insert on public.launch_tasks;
create policy launch_tasks_active_insert on public.launch_tasks
  for insert to authenticated
  with check (company_entity_id = active_company_id());

drop policy if exists launch_tasks_active_update on public.launch_tasks;
create policy launch_tasks_active_update on public.launch_tasks
  for update to authenticated
  using (company_entity_id = active_company_id())
  with check (company_entity_id = active_company_id());

drop policy if exists launch_tasks_active_delete on public.launch_tasks;
create policy launch_tasks_active_delete on public.launch_tasks
  for delete to authenticated
  using (company_entity_id = active_company_id());

-- Re-affirm the select policy (idempotent) so this migration is self-contained.
drop policy if exists launch_tasks_active_select on public.launch_tasks;
create policy launch_tasks_active_select on public.launch_tasks
  for select to authenticated
  using (
    company_entity_id = active_company_id()
    and (
      not is_private
      or assigned_to_user_id = auth.uid()
      or created_by = auth.uid()
    )
  );
