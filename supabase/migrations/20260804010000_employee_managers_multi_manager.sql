-- ============================================================
-- 20260804010000_employee_managers_multi_manager.sql
--
-- Performance Reviews assumed one manager per employee
-- (employees.manager_user_id, NOT NULL, single value), enforced by a
-- unique (company_entity_id, lower(email)) index -- so the same real
-- person could never be rostered under two managers at once (dual
-- reporting, e.g. Loomis AND Brett both needing to review the same
-- employee).
--
-- New public.employee_managers is the real many-to-many relationship:
-- one canonical employees row per person, N manager links. RLS on
-- employees/employee_goals moves from the single column to "does a
-- matching employee_managers row exist". reviews stays untouched --
-- each manager who runs a review for a shared employee creates and
-- owns their OWN reviews row (reviews.manager_user_id already worked
-- this way), except reviews_active_insert is tightened to verify the
-- inserting non-exec user is actually one of the employee's managers
-- (previously it only checked manager_user_id = auth.uid() with no
-- FK-backed relationship check at all -- a latent trust-the-client gap).
--
-- employees.manager_user_id is KEPT (still NOT NULL) as an
-- informational "who originally created this roster entry" marker and
-- as the bootstrap anchor for the first employee_managers self-link
-- (see the insert policy below) -- it is no longer read by any RLS
-- policy or app code as "the" manager. Do not reintroduce it as an
-- authorization source.
-- ============================================================

create table if not exists public.employee_managers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  manager_user_id uuid not null references public.profiles(id),
  company_entity_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (employee_id, manager_user_id)
);

create index if not exists employee_managers_employee_idx on public.employee_managers (employee_id);
create index if not exists employee_managers_manager_idx on public.employee_managers (manager_user_id);

-- Backfill: every existing employee's single manager becomes their first link.
insert into public.employee_managers (employee_id, manager_user_id, company_entity_id, created_by)
select id, manager_user_id, company_entity_id, manager_user_id
from public.employees
on conflict (employee_id, manager_user_id) do nothing;

comment on column public.employees.manager_user_id is
  'Informational only -- who originally created this roster entry. NOT the authorization source for who manages this employee; see employee_managers. Kept for the insert-policy bootstrap self-link and CSV/legacy display.';

-- Attribution + company-scoping safety nets, same pattern as every other table.
drop trigger if exists stamp_created_by on public.employee_managers;
create trigger stamp_created_by before insert on public.employee_managers
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

alter table public.employee_managers enable row level security;
revoke all on public.employee_managers from anon;

-- select: any manager already linked to this employee (co-managers can see
-- each other), or exec/owner.
drop policy if exists employee_managers_active_select on public.employee_managers;
create policy employee_managers_active_select on public.employee_managers for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      manager_user_id = auth.uid()
      or public.is_exec_or_owner()
      or exists (
        select 1 from public.employee_managers em2
        where em2.employee_id = employee_managers.employee_id
          and em2.manager_user_id = auth.uid()
      )
    )
  );

-- insert: exec/owner can link anyone to anyone; the employee's original
-- creator (employees.manager_user_id) can self-link as their own first
-- manager; any existing co-manager can add another co-manager (including
-- inviting a colleague to share the employee). No path lets an unrelated
-- user attach themselves to an employee they have no relationship to.
drop policy if exists employee_managers_active_insert on public.employee_managers;
create policy employee_managers_active_insert on public.employee_managers for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (
        manager_user_id = auth.uid()
        and exists (
          select 1 from public.employees e
          where e.id = employee_managers.employee_id
            and e.manager_user_id = auth.uid()
        )
      )
      or exists (
        select 1 from public.employee_managers em2
        where em2.employee_id = employee_managers.employee_id
          and em2.manager_user_id = auth.uid()
      )
    )
  );

-- delete: exec/owner can remove any link; a manager can remove their OWN
-- link (stop managing someone). Removing a co-manager's link is exec-only
-- -- avoids one manager silently cutting another's access.
drop policy if exists employee_managers_active_delete on public.employee_managers;
create policy employee_managers_active_delete on public.employee_managers for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- ---------------------------------------------------------------------------
-- employees: select/insert/update/delete move from the single column to the
-- join table. INSERT no longer requires anything beyond company membership
-- -- the accompanying employee_managers self-link (inserted right after,
-- client-side) is what actually grants the creator visibility/ownership.
-- ---------------------------------------------------------------------------

drop policy if exists employees_active_select on public.employees;
create policy employees_active_select on public.employees for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      exists (
        select 1 from public.employee_managers em
        where em.employee_id = employees.id and em.manager_user_id = auth.uid()
      )
      or public.is_exec_or_owner()
      or profile_id = auth.uid()
    )
  );

drop policy if exists employees_active_insert on public.employees;
create policy employees_active_insert on public.employees for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists employees_active_update on public.employees;
create policy employees_active_update on public.employees for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      exists (
        select 1 from public.employee_managers em
        where em.employee_id = employees.id and em.manager_user_id = auth.uid()
      )
      or public.is_exec_or_owner()
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (
      exists (
        select 1 from public.employee_managers em
        where em.employee_id = employees.id and em.manager_user_id = auth.uid()
      )
      or public.is_exec_or_owner()
    )
  );

drop policy if exists employees_active_delete on public.employees;
create policy employees_active_delete on public.employees for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      exists (
        select 1 from public.employee_managers em
        where em.employee_id = employees.id and em.manager_user_id = auth.uid()
      )
      or public.is_exec_or_owner()
    )
  );

-- ---------------------------------------------------------------------------
-- employee_goals: same move, via the employees join.
-- ---------------------------------------------------------------------------

drop policy if exists employee_goals_write on public.employee_goals;
create policy employee_goals_write on public.employee_goals for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (
          public.is_exec_or_owner()
          or exists (
            select 1 from public.employee_managers em
            where em.employee_id = e.id and em.manager_user_id = auth.uid()
          )
        )
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (
          public.is_exec_or_owner()
          or exists (
            select 1 from public.employee_managers em
            where em.employee_id = e.id and em.manager_user_id = auth.uid()
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- reviews: unchanged review ownership model (each manager who runs a review
-- owns their own reviews row), but INSERT now verifies the non-exec caller
-- is actually a manager of the target employee -- previously it only
-- checked manager_user_id = auth.uid() with no relationship check at all.
-- ---------------------------------------------------------------------------

drop policy if exists reviews_active_insert on public.reviews;
create policy reviews_active_insert on public.reviews for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (
        manager_user_id = auth.uid()
        and exists (
          select 1 from public.employee_managers em
          where em.employee_id = reviews.employee_id and em.manager_user_id = auth.uid()
        )
      )
    )
  );
