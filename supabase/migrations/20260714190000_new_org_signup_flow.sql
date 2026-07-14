-- New-organization signup flow.
--
-- "Create account" on the login page now means founding a NEW organization
-- in SILO, not requesting access to Baseballism. Joining an existing
-- organization is invitation-only: an admin of that org authorizes you
-- (access-request approval or a backend role grant — both of which now
-- create the entity membership).
--
-- Two parts:
--
-- 1. handle_new_user provisions the org when the signup passes an
--    org_name in the auth metadata: entities row (company), profile as
--    owner, entity_memberships row as owner_admin, active_company_id set.
--    Signups without org_name keep today's behavior (bare inactive-ish
--    profile waiting to be authorized into an existing org).
--
-- 2. Because any stranger can now self-provision an `owner` profile, the
--    backend admin RPCs — previously gated only by the GLOBAL is_admin()
--    check — must be company-scoped, or a self-signed-up org owner could
--    list and modify every profile in SILO. admin_list_profiles,
--    admin_counts and admin_update_profile now only see/touch users who
--    are members of the caller's active company (plus unclaimed profiles
--    with no membership anywhere, so pre-flow signups can still be
--    adopted). Access-request RPCs are scoped to the caller's company the
--    same way.

-- ── 1. handle_new_user: provision a new organization ─────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_name text;
  v_key text;
  v_entity_id uuid;
begin
  v_org_name := nullif(trim(coalesce(new.raw_user_meta_data->>'org_name', '')), '');

  if v_org_name is null then
    -- Invited/legacy path: bare profile, authorized later by an org admin.
    insert into public.profiles (id, email, name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null))
    on conflict (id) do update
      set email = excluded.email;
    return new;
  end if;

  -- Founding path: create the organization and make this user its owner.
  v_key := trim(both '-' from regexp_replace(lower(v_org_name), '[^a-z0-9]+', '-', 'g'));
  if v_key = '' then
    v_key := 'org';
  end if;
  if exists (select 1 from public.entities e where e.entity_type = 'company' and e.entity_key = v_key) then
    v_key := v_key || '-' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;

  insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
  values ('finance_hub', 'company', v_key, 'self_signup', v_org_name, jsonb_build_object('self_signup', true), new.id)
  returning id into v_entity_id;

  insert into public.profiles (id, email, name, role, department, is_active, active_company_id)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null), 'owner'::app_role, 'exec', true, v_entity_id)
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        department = excluded.department,
        is_active = true,
        active_company_id = excluded.active_company_id;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity_id, new.id, 'owner_admin')
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  return new;
end;
$function$;

ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- ── 2. Company-scope the backend admin RPCs ──────────────────
-- Scope rule: an admin can see/manage users who are members of the
-- admin's own active company, plus "unclaimed" profiles that have no
-- membership anywhere (pre-flow signups awaiting adoption). Managing an
-- unclaimed profile pulls it into the caller's company (membership upsert
-- in admin_update_profile).

CREATE OR REPLACE FUNCTION public.admin_list_profiles()
 RETURNS SETOF profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select p.*
  from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
  order by coalesce(p.updated_at, p.created_at) desc nulls last, p.email asc;
end;
$function$;

ALTER FUNCTION public.admin_list_profiles() SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_counts()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_profiles_count int;
  v_profiles_updated_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select count(*)::int, max(p.updated_at)
    into v_profiles_count, v_profiles_updated_at
  from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id);

  return json_build_object(
    'profiles_count', v_profiles_count,
    'profiles_updated_at', v_profiles_updated_at
  );
end;
$function$;

ALTER FUNCTION public.admin_counts() SET search_path = public;

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

  -- Cross-tenant guard: the target must belong to the caller's active
  -- company, or be unclaimed (no membership anywhere).
  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
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
  -- everything (see 20260714180000).
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

CREATE OR REPLACE FUNCTION public.admin_list_access_requests(p_status text)
 RETURNS SETOF access_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select ar.*
  from public.access_requests ar
  left join public.profiles p
    on (
      (ar.user_id is not null and p.id = ar.user_id)
      or (ar.user_id is null and lower(p.email) = lower(ar.email))
    )
  where lower(coalesce(ar.status,'')) = lower(coalesce(p_status,'pending'))
    and p.id is null -- only requests without a profile
    and (ar.company_entity_id is null or ar.company_entity_id = public.active_company_id());
end;
$function$;

ALTER FUNCTION public.admin_list_access_requests(text) SET search_path = public;

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

  -- Cross-tenant guard: an admin can only approve requests aimed at their
  -- own active company (legacy rows with no company count as the caller's).
  if v_req.company_entity_id is not null
     and v_req.company_entity_id <> public.active_company_id() then
    raise exception 'not authorized';
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

  v_company_id := coalesce(v_req.company_entity_id, public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

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

CREATE OR REPLACE FUNCTION public.deny_access_request(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select company_entity_id into v_company
  from public.access_requests
  where id = p_request_id;

  if not found then
    raise exception 'request not found';
  end if;

  if v_company is not null and v_company <> public.active_company_id() then
    raise exception 'not authorized';
  end if;

  update public.access_requests
     set status = 'denied'
   where id = p_request_id;

  return json_build_object('ok', true);
end;
$function$;

ALTER FUNCTION public.deny_access_request(uuid) SET search_path = public;
