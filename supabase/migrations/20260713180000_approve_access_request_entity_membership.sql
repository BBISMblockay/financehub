-- approve_access_request currently creates the profiles row for a newly
-- approved employee but never creates a matching entity_memberships row.
-- Without that row, resolveCompany() in pages/login.html finds no company
-- for the user, profiles.active_company_id is never set, and every
-- company-scoped RLS policy (company_entity_id = active_company_id())
-- returns zero rows — the employee sees no data anywhere, in any
-- department, even though their profile/role/department are correct.
--
-- Fix: upsert an entity_memberships row using the request's
-- company_entity_id (falling back to Baseballism), mapping the app_role
-- enum to the entity_memberships.role check constraint values
-- (owner_admin | admin | member | viewer).

CREATE OR REPLACE FUNCTION public.approve_access_request(p_request_id uuid, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req public.access_requests%rowtype;
  v_dept text;
  v_role app_role;
  v_membership_role text;
  v_company_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select * into v_req
  from public.access_requests
  where id = p_request_id;

  if not found then
    raise exception 'request not found';
  end if;

  if v_req.user_id is null then
    raise exception 'request missing user_id (user must authenticate once so we can capture auth.uid())';
  end if;

  v_dept := coalesce(nullif(trim(p_department), ''), v_req.department, 'ops');

  v_role := case lower(coalesce(nullif(trim(p_role), ''), v_req.requested_role, 'user'))
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  insert into public.profiles (id, email, name, role, department, is_active, created_at, updated_at)
  values (v_req.user_id, v_req.email, v_req.full_name, v_role, v_dept, true, now(), now())
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(excluded.name, public.profiles.name),
        role = excluded.role,
        department = excluded.department,
        is_active = true,
        updated_at = now();

  v_company_id := coalesce(v_req.company_entity_id, '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  v_membership_role := case v_role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_company_id, v_req.user_id, v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.access_requests
     set status = 'approved'
   where id = p_request_id;

  return json_build_object(
    'ok', true,
    'user_id', v_req.user_id,
    'role', v_role::text,
    'department', v_dept,
    'company_entity_id', v_company_id
  );
end;
$function$;

ALTER FUNCTION public.approve_access_request(uuid, text, text) SET search_path = public;
