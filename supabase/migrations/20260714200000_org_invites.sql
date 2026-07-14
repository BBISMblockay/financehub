-- Organization invites — the "join an existing org" half of onboarding.
--
-- An admin creates an invite for an email address (scoped to their active
-- company). The invitee opens the link (/pages/login.html?invite=TOKEN),
-- signs in or creates an account with that email, and the login page calls
-- accept_org_invite(token) — which activates their profile, applies the
-- invited role/department, and creates the entity membership. The raw
-- token is returned exactly once at creation (the admin copies the link);
-- only a sha256 hash is stored, and the table is RLS deny-all — every
-- access goes through the SECURITY DEFINER RPCs below.

create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  email text not null,
  role text not null default 'user',
  department text not null default 'ops',
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid references public.profiles(id),
  accepted_by uuid,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index if not exists org_invites_entity_status_idx on public.org_invites (entity_id, status);

alter table public.org_invites enable row level security;
-- deliberately no policies: RPC-only access

-- ── create_org_invite ─────────────────────────────────────────
-- Admin-only, scoped to the caller's active company. Revokes any prior
-- pending invite for the same email+company so exactly one link is live.

CREATE OR REPLACE FUNCTION public.create_org_invite(p_email text, p_role text DEFAULT 'user', p_department text DEFAULT 'ops')
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_email text;
  v_role text;
  v_token text;
  v_invite public.org_invites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required';
  end if;

  v_role := case lower(coalesce(nullif(trim(p_role), ''), 'user'))
              when 'owner' then 'owner'
              when 'admin' then 'admin'
              else 'user'
            end;

  if exists (
    select 1
    from public.entity_memberships em
    join public.profiles pr on pr.id = em.user_id
    where em.entity_id = v_company and lower(pr.email) = v_email
  ) then
    raise exception 'already a member of this organization';
  end if;

  update public.org_invites
     set status = 'revoked'
   where entity_id = v_company and lower(email) = v_email and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.org_invites (entity_id, email, role, department, token_hash, invited_by)
  values (v_company, v_email, v_role, coalesce(nullif(trim(p_department), ''), 'ops'),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning * into v_invite;

  return json_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'email', v_invite.email,
    'role', v_invite.role,
    'department', v_invite.department,
    'expires_at', v_invite.expires_at,
    'token', v_token
  );
end;
$function$;

-- ── accept_org_invite ─────────────────────────────────────────
-- Called by the invitee themselves after auth. Not admin-gated: the token
-- is the authorization. Bound to the invited email so a leaked link can't
-- be redeemed by a different account.

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite public.org_invites%rowtype;
  v_profile_email text;
  v_role app_role;
  v_membership_role text;
  v_org_title text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.org_invites
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and status = 'pending';

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  if v_invite.expires_at < now() then
    update public.org_invites set status = 'expired' where id = v_invite.id;
    raise exception 'invite has expired — ask your admin for a new one';
  end if;

  select lower(email) into v_profile_email from public.profiles where id = auth.uid();
  if v_profile_email is null then
    raise exception 'profile not found';
  end if;
  if v_profile_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  v_role := case v_invite.role
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  v_membership_role := case v_invite.role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  update public.profiles
     set role = v_role,
         department = v_invite.department,
         is_active = true,
         active_company_id = coalesce(active_company_id, v_invite.entity_id),
         updated_at = now()
   where id = auth.uid();

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_invite.entity_id, auth.uid(), v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.org_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now()
   where id = v_invite.id;

  select title into v_org_title from public.entities where id = v_invite.entity_id;

  return json_build_object(
    'ok', true,
    'entity_id', v_invite.entity_id,
    'org_title', v_org_title,
    'role', v_role::text,
    'department', v_invite.department
  );
end;
$function$;

-- ── list_org_invites / revoke_org_invite ─────────────────────

CREATE OR REPLACE FUNCTION public.list_org_invites()
 RETURNS TABLE(id uuid, email text, role text, department text, status text, expires_at timestamptz, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select i.id, i.email, i.role, i.department, i.status, i.expires_at, i.created_at
  from public.org_invites i
  where i.entity_id = public.active_company_id()
    and i.status = 'pending'
  order by i.created_at desc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_org_invite(p_invite_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  update public.org_invites
     set status = 'revoked'
   where id = p_invite_id
     and entity_id = public.active_company_id()
     and status = 'pending';

  if not found then
    raise exception 'invite not found';
  end if;

  return json_build_object('ok', true);
end;
$function$;

-- ── grants ────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.create_org_invite(text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.accept_org_invite(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_org_invites() FROM public, anon;
REVOKE ALL ON FUNCTION public.revoke_org_invite(uuid) FROM public, anon;

GRANT EXECUTE ON FUNCTION public.create_org_invite(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_org_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_org_invite(uuid) TO authenticated;

ALTER FUNCTION public.create_org_invite(text, text, text) SET search_path = public;
ALTER FUNCTION public.accept_org_invite(text) SET search_path = public;
ALTER FUNCTION public.list_org_invites() SET search_path = public;
ALTER FUNCTION public.revoke_org_invite(uuid) SET search_path = public;
