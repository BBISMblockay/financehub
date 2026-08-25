-- Make the comp-request role isolation actually work end to end.
--
-- Two defects, found by impersonating real users against production RLS
-- (set request.jwt.claims + set role authenticated, inside a rolled-back
-- transaction) rather than by reading the policies:
--
-- 1. FINANCE OPENED AN EMPTY QUEUE. /v2/comp-requests.html renders
--    comp_adjustment_requests_v, which INNER JOINs employees for the
--    person's name. The view is security_invoker, so employees' own RLS
--    applies inside it -- and employees_active_select grants read only to
--    that employee's manager, the employee themselves, or an exec. A
--    finance reviewer is none of those, so the join dropped every row:
--    Brett (finance) and Ben (exec dept) could read the request rows from
--    the base table but saw 0 rows through the view. Pre-existing; employees
--    visibility never depended on the comp gate.
--
--    Fix: let a comp reviewer read an employee ONLY when that employee has
--    a comp request that has actually been submitted to them. Scoped through
--    a security definer helper so the policy does not recurse back into
--    comp_adjustment_requests' own RLS -- the same pattern is_employee_manager()
--    already uses on this table. This does NOT widen the review roster: an
--    employee with no comp request stays invisible to finance.
--
-- 2. FINANCE COULD READ UNSENT DRAFTS. comp_adjustment_requests_active_select
--    let the finance gate read every row regardless of status, including a
--    manager's 'draft' -- their private working copy, which the UI never shows
--    them (the Finance Queue filters status <> 'draft' client-side). A draft
--    raise proposal should not be readable by the approving team before the
--    manager sends it, exactly as payment_requests treats a draft. Narrowing
--    the finance clause to non-draft also removes the last place where the
--    base table and the view disagreed for a finance reviewer.
--
--    The creator, the employee's manager, and exec/owner are unchanged and
--    still see drafts through their own clauses.

-- ---------------------------------------------------------------------------
-- 1. Helper: does this employee have a comp request that reached finance?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER on purpose: called from employees' select policy, so a
-- plain EXISTS against comp_adjustment_requests would re-enter that table's
-- RLS (which itself joins back through is_employee_manager) and recurse.
-- Company-scoped explicitly since definer rights bypass RLS.

create or replace function public.employee_has_open_comp_request(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.comp_adjustment_requests r
    where r.employee_id = p_employee_id
      and r.company_entity_id = public.active_company_id()
      and r.status <> 'draft'
  );
$function$;

revoke execute on function public.employee_has_open_comp_request(uuid) from public, anon;
grant execute on function public.employee_has_open_comp_request(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. employees: add the narrow comp-reviewer read
-- ---------------------------------------------------------------------------

drop policy if exists employees_active_select on public.employees;

create policy employees_active_select on public.employees for select to authenticated
using (
  company_entity_id = public.active_company_id()
  and (
    public.is_employee_manager(employees.id)
    or public.is_exec_or_owner()
    or profile_id = auth.uid()
    -- A comp reviewer sees this person only because a request about them
    -- is sitting in the queue -- not because they are on the roster.
    or (
      public.current_user_can_manage_comp_requests()
      and public.employee_has_open_comp_request(employees.id)
    )
  )
);

-- ---------------------------------------------------------------------------
-- 3. comp_adjustment_requests: keep unsent drafts away from finance
-- ---------------------------------------------------------------------------

drop policy if exists comp_adjustment_requests_active_select on public.comp_adjustment_requests;

create policy comp_adjustment_requests_active_select on public.comp_adjustment_requests for select to authenticated
using (
  company_entity_id = public.active_company_id()
  and (
    created_by = auth.uid()
    or public.is_employee_manager(employee_id)
    or public.is_exec_or_owner()
    or (public.current_user_can_manage_comp_requests() and status <> 'draft')
  )
);
