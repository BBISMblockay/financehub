-- ============================================================
-- 20260804200000_admin_update_profile_executive_role.sql
--
-- admin_update_profile()'s role mapping only knew owner/admin -- every
-- other value the backend's Edit dialog offers (executive, member,
-- viewer, and formerly superadmin) was silently coerced to profile role
-- 'user', and the membership sync then set the target's
-- entity_membership to 'member'. Two live consequences, caught
-- 2026-08-04:
--   1. The backend could not actually grant the executive role at all --
--      "promote to executive" quietly produced user/member.
--   2. Attempting it stripped the person's admin membership as a side
--      effect, silently costing them profile-name visibility
--      (is_owner_admin), PO writes, and other membership-admin gates.
--      (Repaired by hand for the affected user alongside this fix.)
--
-- New mapping, covering exactly what the UI offers:
--   owner     -> profile owner,     membership owner_admin
--   admin     -> profile admin,     membership admin
--   executive -> profile executive, membership admin   (executive outranks
--                admin at the profile layer; membership admin preserves the
--                membership-level gates, matching existing executives)
--   member    -> profile user,      membership member
--   viewer    -> profile user,      membership viewer
--   user      -> profile user,      membership member  (legacy value)
-- Anything else now raises instead of silently coercing. 'superadmin'
-- (never a real role) removed from the backend dropdown.
-- ============================================================

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_name text default null,
  p_department text default null,
  p_role text default null,
  p_is_active boolean default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role_in text := lower(nullif(trim(coalesce(p_role, '')), ''));
  v_role app_role;
  v_membership_role text;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_has_other_org boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  if v_role_in is not null then
    case v_role_in
      when 'owner'     then v_role := 'owner';     v_membership_role := 'owner_admin';
      when 'admin'     then v_role := 'admin';     v_membership_role := 'admin';
      when 'executive' then v_role := 'executive'; v_membership_role := 'admin';
      when 'member'    then v_role := 'user';      v_membership_role := 'member';
      when 'viewer'    then v_role := 'user';      v_membership_role := 'viewer';
      when 'user'      then v_role := 'user';      v_membership_role := 'member';
      else raise exception 'unknown role %', p_role;
    end case;
  end if;

  v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = p_user_id and em.entity_id <> v_company_id
  ) into v_has_other_org;

  if v_has_other_org then
    update public.profiles
       set name = coalesce(p_name, name),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  else
    update public.profiles
       set name = coalesce(p_name, name),
           department = coalesce(p_department, department),
           role = coalesce(v_role, role),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  end if;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_final_active then
    if v_membership_role is not null then
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do update
        set role = excluded.role;
    else
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id,
              case v_final_role
                when 'owner' then 'owner_admin'
                when 'admin' then 'admin'
                when 'executive' then 'admin'
                else 'member'
              end)
      on conflict (entity_id, user_id) do nothing;
    end if;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;
