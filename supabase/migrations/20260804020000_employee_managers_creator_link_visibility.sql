-- ============================================================
-- 20260804020000_employee_managers_creator_link_visibility.sql
--
-- employee_managers_active_insert's "creator self-link" branch did a raw
-- EXISTS subquery against employees to check "am I the recorded creator
-- of this employee". That subquery is itself subject to
-- employees_active_select, which requires is_employee_manager() (needs an
-- employee_managers row to already exist) OR is_exec_or_owner() OR
-- profile_id = auth.uid(). A brand-new employee has NO employee_managers
-- link yet -- that's exactly the row this insert is trying to create --
-- so the creator can't see their own just-inserted employees row via a
-- plain SELECT, the EXISTS returns empty, and the self-link insert's
-- WITH CHECK fails with "new row violates row-level security policy for
-- table employee_managers". This is NOT the infinite-recursion bug fixed
-- in 20260804010000 (different failure mode) -- it's a legitimate access
-- denial on a row that genuinely belongs to the caller, and it fully
-- blocked self-service employee creation for every non-exec user: the
-- employees row would insert fine, but the immediately-following
-- self-link insert (required for the creator to ever see the row again)
-- always failed.
--
-- Same fix pattern as is_employee_manager(): a SECURITY DEFINER function
-- bypasses RLS on its internal query, so it can answer "is auth.uid()
-- the recorded creator of this employee" without going through
-- employees_active_select at all.
--
-- Verified end-to-end under real RLS impersonation (role=authenticated +
-- a real auth.uid()): a non-exec user can create an employee, self-link,
-- add a second manager, and both managers can see the employee back.
-- ============================================================

create or replace function public.is_employee_creator(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and e.manager_user_id = auth.uid()
  );
$function$;

revoke execute on function public.is_employee_creator(uuid) from public, anon;
grant execute on function public.is_employee_creator(uuid) to authenticated, service_role;

drop policy if exists employee_managers_active_insert on public.employee_managers;
create policy employee_managers_active_insert on public.employee_managers for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (manager_user_id = auth.uid() and public.is_employee_creator(employee_managers.employee_id))
      or public.is_employee_manager(employee_managers.employee_id)
    )
  );
