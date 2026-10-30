-- Name the application and the person behind each connection on Connect AI.
--
-- WHY THIS EXISTS
--
-- silo_api_grants stores only a client_id and a user_id. The page named an
-- application from Supabase's own list of what the VIEWER authorized
-- (/auth/v1/user/oauth/grants), which has nothing for anyone else's
-- connection. So an owner looking at "Everyone's apps" saw "Application
-- 8d035da1" for a ChatGPT connection and "Approved by 35539e42-..." for a
-- colleague (Blake, 2026-10-30, the first connections made by other people).
-- The names exist -- auth.oauth_clients.client_name is "ChatGPT" / "Claude",
-- set by the application when it registered -- but schema auth is not
-- readable by `authenticated`.
--
-- This is that lookup, for exactly the grants the caller can already SELECT
-- under silo_api_grants' own policy, and nothing more.
--
-- Idempotent. No table, no policy, no grant to any integration role.

-- ---------------------------------------------------------------------------
-- silo_api_connection_labels(grant_ids) -> (grant_id, client_name,
--                                            approver_name, approver_email)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because auth.oauth_clients is not readable by
-- `authenticated`, and a colleague's profile may not be either.
--
-- Scope mirrors the live silo_api_grants_select policy, so this reveals labels
-- only for rows the caller could already read: their own grants, and the
-- grants of a company where they are owner_admin. A grant id outside that is
-- simply absent from the result -- the same answer as one that does not exist,
-- so it is not an oracle.
--
-- Subject from request.jwt.claims, not auth.uid(): same reason as
-- silo_api_client_for_authorization (20261029234000).
create or replace function public.silo_api_connection_labels(
  p_grant_ids uuid[])
returns table (
  grant_id       uuid,
  client_name    text,
  approver_name  text,
  approver_email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  -- A connection has no business listing other connections.
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot list connections'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := nullif(public.silo_api_claims() ->> 'sub', '')::uuid;
  if v_user is null then
    raise exception 'not_authenticated: sign in to continue'
      using errcode = 'insufficient_privilege';
  end if;

  -- The page asks for what it shows; a screen is never this long.
  if coalesce(cardinality(p_grant_ids), 0) = 0 then
    return;
  end if;
  if cardinality(p_grant_ids) > 500 then
    raise exception 'too_many: ask for at most 500 connections at once'
      using errcode = 'program_limit_exceeded';
  end if;

  return query
  select g.id,
         nullif(trim(c.client_name), ''),
         nullif(trim(p.name), ''),
         nullif(trim(p.email), '')
  from public.silo_api_grants g
  left join auth.oauth_clients c on c.id::text = g.client_id
  left join public.profiles p on p.id = g.user_id
  where g.id = any(p_grant_ids)
    and (g.user_id = v_user
         or exists (
           select 1 from public.entity_memberships em
           where em.user_id = v_user
             and em.entity_id = g.company_entity_id
             and em.role = 'owner_admin'));
end;
$$;

comment on function public.silo_api_connection_labels(uuid[]) is
  'Application name (auth.oauth_clients.client_name) and approver name/email for the given grant ids, limited to grants the caller can already read under silo_api_grants_select (their own, or their owner_admin company''s). Others are absent, not refused. For Connect AI. 20261030190000.';

revoke all on function public.silo_api_connection_labels(uuid[])
  from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_api_connection_labels(uuid[])
  to authenticated;

-- The migration's own guards.
do $$
begin
  if not has_function_privilege('authenticated',
       'public.silo_api_connection_labels(uuid[])', 'execute') then
    raise exception 'silo_api_connection_labels: authenticated cannot execute it';
  end if;
  if has_function_privilege('silo_integration',
       'public.silo_api_connection_labels(uuid[])', 'execute')
     or has_function_privilege('silo_revoked',
       'public.silo_api_connection_labels(uuid[])', 'execute')
     or has_function_privilege('anon',
       'public.silo_api_connection_labels(uuid[])', 'execute') then
    raise exception 'silo_api_connection_labels: a role that must not reach it can';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'silo_api_connection_labels'
      and p.prosecdef) then
    raise exception 'silo_api_connection_labels: must be SECURITY DEFINER';
  end if;
end $$;
