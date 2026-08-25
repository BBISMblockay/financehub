-- Narrow who can see and decide compensation requests.
--
-- 20260824000000_comp_adjustment_requests.sql copied the approval gate from
-- payment_requests verbatim, which passes for ANY membership role of
-- 'admin'. That is a sensible boundary for AP invoices, but 28 of the 29
-- active Baseballism profiles carry membership 'admin', so in practice the
-- gate let almost the whole company read every comp request --
-- current_compensation, proposed_compensation, titles and justification for
-- any employee -- and decide them, since comp_adjustment_requests_active_select
-- and _active_update both call this function.
--
-- That is exactly the divergence the original migration anticipated when it
-- gave comp its own function instead of reusing the AP one. This narrows it
-- to the people who actually own compensation: owner_admin, plus anyone in
-- the finance or exec department.
--
-- Executives are unaffected either way: every policy that calls this function
-- also ORs in is_exec_or_owner(), so profile-role 'executive' keeps access
-- through that clause and does not need to pass this one.
--
-- Managers are likewise unaffected -- they reach their own rows via
-- created_by = auth.uid() and is_employee_manager(employee_id), not this gate.
--
-- No table or policy changes: the policies already reference this function by
-- name, so replacing the body re-scopes every one of them at once.

create or replace function public.current_user_can_manage_comp_requests()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        -- Owner of the active company, however the role is recorded.
        case when em.role is not null
             then em.role = 'owner_admin'
             else p.role::text = 'owner'
        end
        -- Or the departments that own compensation decisions.
        or p.department in ('finance','exec')
      )
  );
$function$;

revoke execute on function public.current_user_can_manage_comp_requests() from public, anon;
grant execute on function public.current_user_can_manage_comp_requests() to authenticated, service_role;
