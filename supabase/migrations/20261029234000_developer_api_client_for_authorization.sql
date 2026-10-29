-- Resolve an OAuth authorization to the application that asked for it.
--
-- WHY THIS EXISTS
--
-- Supabase AUTO-APPROVES a repeat authorization. When a person has consented
-- to a client before, getAuthorizationDetails() comes back with no
-- authorization_id -- only a redirect_url to follow -- and Supabase's own
-- example code follows it at once. Crucially, that response does NOT name the
-- client.
--
-- SILO keeps its own grant row, and every boundary in the database reads it.
-- So on that path v2/api-consent.html must still call silo_api_consent(), or a
-- connection that went idle (30 days unused), expired (90 days), or that an
-- owner disconnected for someone else can never be restored: the person
-- reconnects from the application, and SILO has nothing to write the grant
-- against. Measured in production on 2026-10-29: the page refused with "This
-- request did not name an application" rather than redirecting, which is the
-- honest failure, but the restore could not complete.
--
-- Those three cases are the ones where nothing revokes the Supabase consent.
-- Disconnecting your OWN connection also revokes it, so the next connect gets
-- a real consent screen and never reaches this path.
--
-- The database knows the answer -- auth.oauth_authorizations carries both the
-- authorization_id and the client_id -- and the browser cannot read schema
-- auth. This is that one lookup, and nothing more.
--
-- Idempotent. No table, no policy, no grant to any integration role.

-- ---------------------------------------------------------------------------
-- silo_api_client_for_authorization(authorization_id) -> client_id
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because schema auth is not readable by `authenticated`.
-- Scoped to the CALLER'S OWN authorizations: the row must carry their user_id.
--
-- Returns NULL both when no such authorization exists and when it belongs to
-- someone else. Deliberately the same answer: distinguishing them would turn
-- this into an oracle for whether an authorization id is real, and the caller
-- has nothing to do differently in either case.
--
-- Reads the subject from request.jwt.claims rather than auth.uid(). auth.uid()
-- is itself a wrapper over that setting and needs USAGE on schema auth, which
-- on Supabase cannot be granted to a role that is neither the schema's owner
-- nor a superuser -- the GRANT is accepted and does nothing (measured during
-- PR0, same wall as the outbound-HTTP revoke). Reading the GUC needs no schema
-- privilege at all, so this works whatever role ends up owning the function.
create or replace function public.silo_api_client_for_authorization(
  p_authorization_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user   uuid;
  v_client uuid;
begin
  -- A connection can never resolve an authorization, least of all to approve
  -- something for itself. Same first line as silo_api_consent().
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot read an authorization'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := nullif(public.silo_api_claims() ->> 'sub', '')::uuid;
  if v_user is null then
    raise exception 'not_authenticated: sign in to continue'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_authorization_id), '') = '' then
    return null;
  end if;

  select a.client_id
    into v_client
  from auth.oauth_authorizations a
  where a.authorization_id = trim(p_authorization_id)
    and a.user_id = v_user;

  return v_client::text;
end;
$$;

comment on function public.silo_api_client_for_authorization(text) is
  'Resolves one of the CALLER''S OWN OAuth authorizations to the client_id that asked for it, so the consent screen can write a grant on the path where Supabase auto-approves a repeat authorization and does not name the client. NULL when absent or not theirs -- the same answer on purpose, so it is not an oracle. 20261029234000.';

revoke all on function public.silo_api_client_for_authorization(text)
  from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_api_client_for_authorization(text)
  to authenticated;

-- The migration's own guards. A silent no-op here would leave the consent
-- screen unable to restore a connection and nothing would say so until
-- somebody's app stopped working 30 days later.
do $$
begin
  if not has_function_privilege('authenticated',
       'public.silo_api_client_for_authorization(text)', 'execute') then
    raise exception 'silo_api_client_for_authorization: authenticated cannot execute it';
  end if;
  if has_function_privilege('silo_integration',
       'public.silo_api_client_for_authorization(text)', 'execute')
     or has_function_privilege('silo_revoked',
       'public.silo_api_client_for_authorization(text)', 'execute')
     or has_function_privilege('anon',
       'public.silo_api_client_for_authorization(text)', 'execute') then
    raise exception 'silo_api_client_for_authorization: a role that must not reach it can';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'silo_api_client_for_authorization'
      and p.prosecdef) then
    raise exception 'silo_api_client_for_authorization: must be SECURITY DEFINER';
  end if;
end $$;
