-- Tasks can hang off an INITIATIVE, not only a launch.
--
-- Today `launch_tasks` is the one and only task table -- /v2/tasks.html writes
-- it as the company's general task list, and the launch drawer writes it as a
-- launch checklist. Its `launch_id` is already nullable and Task Manager
-- already calls those rows "Evergreen", so a parentless task is an existing,
-- working concept. What was missing is a SECOND kind of parent.
--
-- "Initiative" is the UI's word for `launch_channel_items` -- one dated channel
-- touch (an email send, a social post). Initiatives and tasks were SIBLINGS,
-- both children of a launch, so a task could never point at one.
--
-- The table keeps its `launch_` name deliberately. Renaming it would mean
-- rewriting calendar_events_v, v_launch_workflow_summary, four RLS policies,
-- two pages, verify/apply SQL and Ask SILO's schema catalog -- real blast
-- radius for a cosmetic win. `tasks_v` below is the clean name to read.

-- ── The second parent ──────────────────────────────────────────────────────
-- ON DELETE SET NULL, never CASCADE: deleting an initiative must not silently
-- delete somebody's task, nor block the delete. The task keeps its own title,
-- so an orphaned one can still say what it was for. Same stance
-- dashboard_widgets.report_id already takes.
alter table public.launch_tasks
  add column if not exists channel_item_id uuid
    references public.launch_channel_items(id) on delete set null;

create index if not exists launch_tasks_channel_item_idx
  on public.launch_tasks (channel_item_id)
  where channel_item_id is not null;

-- ── One answer to "which launch is this task on" ───────────────────────────
-- A task on an initiative is also a task on that initiative's launch. Storing
-- both columns freely lets them DISAGREE -- the task says launch A while its
-- initiative belongs to launch B -- and then "tasks for this launch" returns
-- two different answers depending on which column you ask. So launch_id is
-- DERIVED whenever an initiative is set, and the derivation lives here rather
-- than in the two pages that write this table.
--
-- SECURITY INVOKER on purpose: the lookup runs under the caller's own RLS, so
-- attaching a task to an initiative you cannot see fails loudly instead of
-- quietly resolving a launch from another company's row.
create or replace function public.sync_task_launch_from_initiative()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_launch uuid;
  v_found boolean := false;
begin
  if new.channel_item_id is null then
    return new;
  end if;

  select ci.launch_id, true into v_launch, v_found
  from public.launch_channel_items ci
  where ci.id = new.channel_item_id;

  if not v_found then
    raise exception 'initiative % not found, or not visible to you', new.channel_item_id
      using errcode = 'foreign_key_violation';
  end if;

  -- An initiative may itself have no launch (launch_id is nullable there), and
  -- that is a legitimate state: the task then inherits "no launch" rather than
  -- keeping a stale one.
  new.launch_id := v_launch;
  return new;
end;
$$;

drop trigger if exists trg_task_launch_from_initiative on public.launch_tasks;
create trigger trg_task_launch_from_initiative
  before insert or update of channel_item_id, launch_id on public.launch_tasks
  for each row execute function public.sync_task_launch_from_initiative();

-- If an initiative is MOVED to a different launch, its tasks have to move with
-- it, or the derivation above is only true at write time and rots afterwards.
create or replace function public.resync_tasks_on_initiative_move()
returns trigger
language plpgsql
security definer          -- tasks of colleagues, including private ones, must
set search_path to 'public'  -- follow the move; the caller may not see them all
as $$
begin
  if new.launch_id is distinct from old.launch_id then
    update public.launch_tasks
       set launch_id = new.launch_id
     where channel_item_id = new.id
       and launch_id is distinct from new.launch_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_initiative_move_resyncs_tasks on public.launch_channel_items;
create trigger trg_initiative_move_resyncs_tasks
  after update of launch_id on public.launch_channel_items
  for each row execute function public.resync_tasks_on_initiative_move();

-- ── The readable name ──────────────────────────────────────────────────────
-- security_invoker is NOT optional here. launch_tasks' select policy hides
-- private tasks from everyone but their assignee and creator; a definer view
-- would hand every private task to the whole company.
create or replace view public.tasks_v
with (security_invoker = true) as
select
  t.id,
  t.company_entity_id,
  t.task_title,
  t.task_type,
  t.status,
  t.priority,
  t.due_date,
  t.notes,
  t.is_private,
  t.estimated_minutes,
  t.sort_order,
  t.assigned_to_user_id,
  t.assigned_to_name,
  t.created_by,
  t.created_at,
  t.updated_at,
  t.completed_at,
  t.completed_by,
  t.launch_id,
  lc.title            as launch_title,
  lc.launch_date,
  t.channel_item_id,
  ci.item_title       as initiative_title,
  ci.channel          as initiative_channel,
  ci.scheduled_date   as initiative_date,
  -- What a person would call this task's parent, in one column, so a list can
  -- group by it without re-deciding the precedence rule per page.
  case
    when t.channel_item_id is not null then 'initiative'
    when t.launch_id is not null       then 'launch'
    else 'evergreen'
  end as parent_kind,
  coalesce(ci.item_title, lc.title, 'Evergreen') as parent_title
from public.launch_tasks t
left join public.launch_calendar lc      on lc.id = t.launch_id
left join public.launch_channel_items ci on ci.id = t.channel_item_id;

comment on view public.tasks_v is
  'Tasks with their parent resolved: an initiative, a launch, or evergreen. '
  'security_invoker, so private tasks stay private and company scoping holds.';

grant select on public.tasks_v to authenticated;
