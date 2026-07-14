-- A user who signs up directly (handle_new_user creates a bare profiles row)
-- and is then granted a role from /v2/backend.html gets their profile updated
-- by admin_update_profile — but no entity_memberships row is ever created.
-- Without one, resolveCompany() in pages/login.html finds no company,
-- profiles.active_company_id stays NULL, the stamp_company_entity_id trigger
-- has nothing to stamp, and every company-scoped RLS policy
-- (company_entity_id = active_company_id()) fails — the user can't read any
-- data or submit a payment request, regardless of role/department.
--
-- 20260713180000 fixed this for the access-request approval path; this
-- migration fixes the direct-signup + backend-role-toggle path the same way,
-- and backfills any active profile already stuck without a membership.

-- ── 1. admin_update_profile: ensure entity membership ────────
-- After updating the profile, upsert a membership in the calling admin's
-- active company (falling back to Baseballism), mapping app_role to the
-- entity_memberships.role values (owner_admin | admin | member | viewer),
-- and fill the target's active_company_id if it was never set.

CREATE OR REPLACE FUNCTION public.admin_update_profile(p_user_id uuid, p_name text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role app_role;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_membership_role text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_role := case
    when p_role is null or trim(p_role) = '' then null
    when lower(p_role) = 'owner' then 'owner'::app_role
    when lower(p_role) = 'admin' then 'admin'::app_role
    else 'user'::app_role
  end;

  update public.profiles
     set name = coalesce(p_name, name),
         department = coalesce(p_department, department),
         role = coalesce(v_role, role),
         is_active = coalesce(p_is_active, is_active),
         updated_at = now()
   where id = p_user_id
   returning role, is_active into v_final_role, v_final_active;

  if not found then
    raise exception 'profile not found';
  end if;

  -- Active users must have a company membership or RLS locks them out of
  -- everything. Scope it to the admin's own active company so a multi-tenant
  -- admin never grants access to a company they aren't operating in.
  if v_final_active then
    v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

    v_membership_role := case v_final_role
                            when 'owner' then 'owner_admin'
                            when 'admin' then 'admin'
                            else 'member'
                          end;

    insert into public.entity_memberships (entity_id, user_id, role)
    values (v_company_id, p_user_id, v_membership_role)
    on conflict (entity_id, user_id) do update
      set role = excluded.role;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) SET search_path = public;

-- ── 2. Backfill profiles already stuck without a membership ──
-- Every current active user without a membership predates multi-company
-- support, so Baseballism is the correct company for all of them.

insert into public.entity_memberships (entity_id, user_id, role)
select
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid,
  p.id,
  case p.role::text
    when 'owner' then 'owner_admin'
    when 'admin' then 'admin'
    else 'member'
  end
from public.profiles p
where p.is_active
  and not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
on conflict (entity_id, user_id) do nothing;

-- Single-company users get their active company set immediately (login's
-- resolveCompany() would also do this, but this unblocks sessions that are
-- already signed in without forcing a re-login).
update public.profiles p
   set active_company_id = em.entity_id
  from public.entity_memberships em
 where em.user_id = p.id
   and p.active_company_id is null
   and (select count(*) from public.entity_memberships em2 where em2.user_id = p.id) = 1;
