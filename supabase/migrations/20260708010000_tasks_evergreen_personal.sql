-- Task Manager upgrades: evergreen (no-launch) tasks + personal to-do lists.
--
-- launch_tasks.launch_id was NOT NULL, so every task had to belong to a
-- launch — the marketing team needs standing/evergreen to-dos and personal
-- lists that aren't campaign-bound. Also adds the columns those lists need:
-- estimated effort, a manual per-person sort order, private tasks, and
-- created_by so private visibility can include the author.

alter table public.launch_tasks alter column launch_id drop not null;

alter table public.launch_tasks
  add column if not exists estimated_minutes integer,
  add column if not exists sort_order numeric,
  add column if not exists is_private boolean not null default false,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.launch_tasks alter column created_by set default auth.uid();

-- Seed per-person ordering for existing tasks: priority, then due date,
-- then age — the same heuristic the UI's "Auto-arrange" uses.
update public.launch_tasks lt
set sort_order = ranked.rn
from (
  select id,
         row_number() over (
           partition by company_entity_id, assigned_to_user_id
           order by
             case priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
             due_date asc nulls last,
             created_at asc
         ) as rn
  from public.launch_tasks
) ranked
where lt.id = ranked.id
  and lt.sort_order is null;

-- Private tasks are only visible to their assignee and their creator.
-- (The write policy stays company-scoped: this is a visibility feature for
-- a 7-admin team, not a security boundary.)
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
