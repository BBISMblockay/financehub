-- 20261009120000_workspace_admin_member_scope.sql
--
-- The Backend hub's Users panel listed people who belong to no company at all,
-- in EVERY company's backend, and let any company's admin pull them in.
--
-- admin_list_profiles / admin_counts / admin_update_profile were scoped in
-- 20260714190000 to "members of the caller's active company, plus unclaimed
-- profiles with no membership anywhere, so pre-flow signups can still be
-- adopted". That adoption path predates invitations. Since 20260918120000 a
-- signup with no invite yields a bare profile, and joining a company is an
-- invite (accept_org_invite works for an existing account too), so the
-- "unclaimed" branch no longer adopts anybody legitimately. What it did
-- instead, measured on production 2026-10-09:
--
--   * Two founders who were sent a company-creation invite, created an
--     account, and lost the invite on the email-confirmation round trip
--     (joel@thegreatpnw.com, erik@misefootwear.com) were listed by name and
--     email in Baseballism's backend -- and in every other tenant's.
--   * admin_update_profile let ANY company's admin set a role on such a
--     profile, which upserts a membership into the ADMIN's company: a
--     stranger's account, invited to found their own company, claimable into
--     somebody else's tenant by one click.
--
-- After this migration all three are members-of-the-active-company only.
-- People who belong to no company are a PLATFORM concern and are listed by
-- platform_list_accounts() (is_platform_admin() only), on Silo Admin.
--
-- Idempotent: create or replace throughout. `create or replace` keeps existing
-- grants, so the new function's grants are stated explicitly.

-- ── 1. Backend Users panel: members of the active company only ─────────────
create or replace function public.admin_list_profiles()
returns setof public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- No company resolved -> no rows. active_company_id() is NULL, the EXISTS
  -- matches nothing, and nobody is listed: an ambiguous tenant shows nothing
  -- rather than everything.
  return query
  select p.*
  from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
  order by coalesce(p.updated_at, p.created_at) desc nulls last, p.email asc;
end;
$function$;

create or replace function public.admin_counts()
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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
                where em.user_id = p.id and em.entity_id = public.active_company_id());

  return json_build_object(
    'profiles_count', v_profiles_count,
    'profiles_updated_at', v_profiles_updated_at
  );
end;
$function$;

-- ── 2. admin_update_profile: a member of THIS company, or nothing ──────────
-- Body unchanged from production (pg_get_functiondef, 2026-10-09) except the
-- first guard. It used to refuse only "a member of some OTHER company and not
-- this one", so a profile with no membership anywhere passed and the upsert
-- below made it a member of the caller's company.
create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_name text default null::text,
  p_department text default null::text,
  p_role text default null::text,
  p_is_active boolean default null::boolean,
  p_notes text default null::text
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

  -- Only somebody who already belongs to the caller's active company. Adding
  -- a person to a company is an invitation (create_org_invite ->
  -- accept_org_invite), never a side effect of editing a profile. A NULL
  -- active company matches nothing and is refused here too.
  if not exists (select 1 from public.entity_memberships em
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

  -- WAS: coalesce(public.active_company_id(), '3bd934c9-...'::uuid).
  -- An admin whose own active company is unresolved has not told us which org
  -- this person is being added to, and the answer is not "Baseballism". The
  -- membership insert below is a grant of access to a tenant's data, so an
  -- ambiguous tenant has to stop the call, not pick one.
  v_company_id := public.active_company_id();
  if v_company_id is null then
    raise exception 'no active company: cannot resolve which organization this profile belongs to'
      using errcode = '22004';
  end if;

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

-- ── 3. Silo Admin: every account, and which ones are stranded ──────────────
-- One row per auth user. `state` names why an account with no company has
-- none, because the three cases need different follow-up:
--   founder_invite_pending  sent a company-creation invite, never redeemed it
--   team_invite_pending     sent a team invite, never accepted it
--   unconfirmed             never confirmed their email
--   no_company              none of the above
--   member                  belongs to at least one company
-- Operational facts only: no tokens, no hashes, no auth metadata.
create or replace function public.platform_list_accounts()
returns table (
  user_id uuid,
  email text,
  name text,
  created_at timestamptz,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  is_active boolean,
  companies jsonb,
  state text,
  founder_invite_expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized';
  end if;

  return query
  with acct as (
    select u.id,
           coalesce(p.email, u.email)::text as email,
           p.name,
           u.created_at,
           u.email_confirmed_at,
           u.last_sign_in_at,
           p.is_active,
           coalesce((
             select jsonb_agg(jsonb_build_object('entity_id', e.id, 'title', e.title, 'role', em.role)
                              order by e.title)
               from public.entity_memberships em
               join public.entities e on e.id = em.entity_id and e.entity_type = 'company'
              where em.user_id = u.id), '[]'::jsonb) as companies,
           (select max(pi.expires_at) from public.platform_invites pi
             where lower(pi.email) = lower(coalesce(p.email, u.email))
               and pi.status = 'pending' and pi.expires_at > now()) as founder_exp,
           exists (select 1 from public.org_invites oi
                    where lower(oi.email) = lower(coalesce(p.email, u.email))
                      and oi.status = 'pending' and oi.expires_at > now()) as team_pending
      from auth.users u
      left join public.profiles p on p.id = u.id
  )
  select a.id, a.email, a.name, a.created_at, a.email_confirmed_at, a.last_sign_in_at,
         a.is_active, a.companies,
         case
           when jsonb_array_length(a.companies) > 0 then 'member'
           when a.founder_exp is not null then 'founder_invite_pending'
           when a.team_pending then 'team_invite_pending'
           when a.email_confirmed_at is null then 'unconfirmed'
           else 'no_company'
         end,
         a.founder_exp
    from acct a
   order by (jsonb_array_length(a.companies) > 0), a.created_at desc nulls last, a.email;
end;
$function$;

revoke all on function public.platform_list_accounts() from public, anon;
grant execute on function public.platform_list_accounts() to authenticated;
