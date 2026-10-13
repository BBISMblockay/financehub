-- Two-step login, enforced by the server (not just the sign-in page).
--
-- #970 shipped the code step on pages/login.html and pages/set-password.html.
-- A password alone already yields an aal1 session, so someone holding an
-- enrolled user's password could skip the code step by opening an app URL
-- (or calling the API) directly. This closes that, for exactly the accounts
-- that opted in: an account WITH a verified authenticator factor gets no data
-- until its session is aal2; an account without one is untouched.
--
-- WHERE IT IS ENFORCED
--   * Data API (PostgREST): public.silo_check_request() runs before EVERY
--     request (tables, views, RPCs) via pgrst.db_pre_request. One choke point
--     instead of a policy per table, and it also covers the ~117 SECURITY
--     DEFINER functions and the definer views, which bypass RLS and so would
--     slip past a per-table restrictive policy.
--   * Storage: a restrictive policy on storage.objects (Storage does not run
--     the pre-request hook).
--   * Realtime: not used (supabase_realtime publishes no tables, 2026-10-13).
--   * Edge functions that verify the caller and then act with the service
--     role: checked in code (see docs/ops/two-step-login.md).
--
-- Anyone with no factor, the anon role and the service role pass straight
-- through: auth.uid() is null for anon/service, and the factor lookup is one
-- indexed read (auth.mfa_factors_user_id_idx) per request for signed-in users.
--
-- ROLLBACK (one statement, instant):
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
--
-- Idempotent.

-- Is this session good enough for this user? True when the session is aal2,
-- when there is no signed-in user, or when the user has no VERIFIED factor
-- (an unverified one is a half-finished setup and grants nothing).
create or replace function public.mfa_session_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or (select auth.uid()) is null
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified')
$$;

comment on function public.mfa_session_satisfied() is
  'True unless the signed-in user holds a verified MFA factor and this session is not aal2. Used by silo_check_request() (every Data API request) and the storage.objects restrictive policy. 20261014000000.';

-- Called by PostgREST as the request's role, so all three API roles need it.
revoke all on function public.mfa_session_satisfied() from public;
grant execute on function public.mfa_session_satisfied() to anon, authenticated, service_role;

-- The Data API gate. 403 with code mfa_required, so the app can send the user
-- to the code step instead of treating it as signed out.
create or replace function public.silo_check_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.mfa_session_satisfied() then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'mfa_required',
        'message', 'Enter the code from your authenticator app to continue.',
        'hint', 'Sign in again to finish two-step login.')::text,
      detail = json_build_object('status', 403)::text;
  end if;
end;
$$;

comment on function public.silo_check_request() is
  'PostgREST pre-request hook (pgrst.db_pre_request): refuses every Data API request from an aal1 session of a user who has a verified MFA factor. 20261014000000. Rollback: alter role authenticator reset pgrst.db_pre_request; notify pgrst, ''reload config'';';

revoke all on function public.silo_check_request() from public;
grant execute on function public.silo_check_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.silo_check_request';
notify pgrst, 'reload config';

-- Storage does not run the pre-request hook: a restrictive policy refuses
-- every storage.objects read and write for an unsatisfied session, whatever
-- the bucket's own (permissive) policies allow.
drop policy if exists mfa_session_required on storage.objects;
create policy mfa_session_required on storage.objects
  as restrictive
  for all
  to authenticated
  using ((select public.mfa_session_satisfied()))
  with check ((select public.mfa_session_satisfied()));
