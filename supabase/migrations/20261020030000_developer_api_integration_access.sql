-- The developer platform's permission layer: a third-party application, acting
-- for a person who approved it, can run SILO's global reports for ONE company
-- and reach nothing else.
--
-- Nothing in this migration turns anything on. Supabase's OAuth 2.1 server is
-- off, no OAuth client exists, and the Custom Access Token hook is not pointed
-- at silo_api_access_token_hook() -- all three are dashboard settings and all
-- three are Blake's. Until they are set, no token can ever carry a client_id
-- claim, so every branch added below is unreachable and first-party behaviour
-- is unchanged. That is the deliberate shape of this PR: the boundary lands
-- first, inert, and is reviewed before anything can use it.
--
-- WHY IT IS BUILT THIS WAY
--   An OAuth access token from Supabase is an ORDINARY session token. It
--   reaches PostgREST, Storage and every verify_jwt edge function directly.
--   Enforcement inside one gateway function would not be enforcement, and
--   Supabase's OAuth scopes "control OIDC data, not database access". So the
--   boundary is Postgres privileges plus RLS, in four places:
--
--   1. ROLE. A Custom Access Token hook stamps role=silo_integration on any
--      token carrying client_id. That role holds EXECUTE on exactly one
--      function (silo_api_run_report) and SELECT on nothing. Arbitrary SQL,
--      raw tables and every other RPC are refused by privilege, not policy.
--      A client_id with no usable grant is stamped role=silo_revoked, which
--      holds nothing at all -- a token already issued cannot be relabelled, so
--      the dead end has to be stamped at issuance, including on refresh.
--   2. PRE-REQUEST. silo_check_request() already runs before every Data API
--      request (20261014000000). It gains ONE refusal, decided BEFORE the MFA
--      check: an integration request whose grant is missing, revoked, expired
--      or bound to another session is refused with code integration_revoked.
--      Order matters -- answering mfa_required to a revoked connection tells
--      the app to send the person to a code screen that cannot help.
--   3. COMPANY. active_company_id() branches on client_id and resolves from
--      silo_api_grants, returning NULL when the grant is not usable. It NEVER
--      falls back to profiles.active_company_id: a revoked connection must not
--      inherit whatever company the person last had open in a browser tab.
--   4. SCOPE. silo_api_require_scope() reads the GRANT ROW, not the token's
--      silo_scopes claim. A claim is stamped at issuance and stays stale until
--      the next refresh, so narrowing a connection's permissions has to bite on
--      the next request, the way revocation does.
--
--   Storage and verify_jwt edge functions run none of the above, which is why
--   they get their own refusals. Storage's is a restrictive policy in this
--   migration. The edge functions' is scripts/lib/integration-gate.mjs, the
--   canonical copy of a guard that has to be vendored into each function
--   directory and called the way mfa-gate.mjs is -- that wiring is PR1 and
--   MUST land before the OAuth server is enabled, because until it does an
--   integration token reaching a verify_jwt function is refused only where
--   that function happens to make a PostgREST call with the caller's own
--   token. The one function that may accept an integration token is the MCP
--   endpoint, via that module's explicit allowIntegration flag.
--
-- WHAT IS DELIBERATELY ABSENT
--   * No machine-to-machine access. Supabase supports only authorization_code
--     + PKCE and refresh_token; there is no client_credentials grant, so an
--     unattended client is a human-approved client living on refresh rotation.
--   * No aal2 stamping. A token issued from a genuine two-factor consent still
--     reads aal=aal1 and keeps it across refresh (measured). The MFA policy
--     therefore asks whether the GRANT was consented at aal2 -- recorded and
--     auditable -- and the token stays aal1, so first-party aal2 surfaces keep
--     refusing it.
--   * No writes. One report RPC, SELECT-only, 1000-row pages.
--   * No client registry table and no Developers screen yet.
--
-- VERIFIED ON A DISPOSABLE SUPABASE BRANCH, 2026-10-20, with real GoTrue,
-- PostgREST, Storage and a deployed edge function, synthetic data only:
-- /mnt/project-files/specs/pr0-proof-round4-hosted-2026-10-20.md.
--
-- ROLLBACK: the two replaced functions are the only live-path changes.
--   Point active_company_id() and mfa_session_satisfied()/silo_check_request()
--   back at their 20261014000000 bodies (the first-party branches below are
--   those bodies verbatim), then:
--     drop policy if exists no_third_party_clients on storage.objects;
--   The roles and the grant table are inert without the Auth settings.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------
-- silo_integration  the role an authorized integration token runs as.
-- silo_revoked      the dead end for a client_id with no usable grant.
-- silo_api_exec     owns the report wrapper. It owns NO TABLES and has no
--                   BYPASSRLS, which is what keeps RLS in force inside a
--                   SECURITY DEFINER function (a definer function bypasses RLS
--                   only for tables its owner owns, or if the owner holds
--                   BYPASSRLS). It IS a member of authenticated, deliberately:
--                   a SILO report is defined against what a signed-in user can
--                   read, so the wrapper needs that same read reach, and
--                   mirroring every role-scoped policy onto a bespoke role
--                   instead would silently return empty reports the first time
--                   a policy changed. The boundary is not what the OWNER can
--                   read -- it is that the TOKEN's role holds EXECUTE on one
--                   function and SELECT on nothing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'silo_integration') then
    create role silo_integration nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'silo_revoked') then
    create role silo_revoked nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'silo_api_exec') then
    create role silo_api_exec nologin;
  end if;
end;
$$;

-- PostgREST switches to the role in the token's `role` claim, so authenticator
-- must be a member of both API roles or the request fails before any gate.
grant silo_integration to authenticator;
grant silo_revoked to authenticator;
-- Lets postgres (this migration) change the wrapper's owner, and later replace it.
grant silo_api_exec to postgres;
-- See the note above: read reach, not authority.
grant authenticated to silo_api_exec;

-- Bounded queries. authenticated's 8s browser budget is too tight for a report
-- an API client is waiting on, and no budget at all is how one connection
-- becomes everyone's outage.
alter role silo_integration set statement_timeout = '15s';
alter role silo_revoked set statement_timeout = '5s';

-- A revoked integration must reach the pre-request gate to be told WHY, so it
-- needs schema usage and EXECUTE on the gate itself. It gets nothing else.
--
-- Not USAGE on schema auth, and not because we would rather not: it cannot be
-- granted (see silo_api_claims() below). One visible consequence, measured: an
-- integration request that touches a table directly is refused either for the
-- table or, when that table's policy calls auth.uid(), for schema auth -- the
-- planner inlines the policy's helper before it checks the table's ACL. Both
-- are refusals; only the wording differs.
grant usage on schema public to silo_integration, silo_revoked;

-- ---------------------------------------------------------------------------
-- 2. The grant: one live connection per (client, person)
-- ---------------------------------------------------------------------------
-- consented_aal records the assurance of the session that approved the
-- connection. It is evidence, not a claim we re-stamp.
--
-- auth_session_id is NULL until the first token is issued, because consent
-- happens before the OAuth session exists; the access-token hook binds it once,
-- and from then on the grant answers for exactly that session. That binding is
-- what makes a replayed token from an earlier connection useless even when the
-- same person reconnects the same application to a different company.
create table if not exists public.silo_api_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id),
  auth_session_id uuid,
  generation integer not null default 1,
  scopes text[] not null default '{}',
  consented_aal text,
  consented_at timestamptz not null default now(),
  expires_at timestamptz,   -- made NOT NULL with a 90-day default below
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.silo_api_grants is
  'One row per authorization a person has given a third-party OAuth client: which company it may read, which scopes, when it expires, and the Auth session it is bound to. The authority for an integration request''s company and scopes -- read live on every request, never from a token claim. 20261020030000.';
comment on column public.silo_api_grants.auth_session_id is
  'The Auth session this grant is bound to. NULL until the first token is issued (consent precedes the session); silo_api_access_token_hook() binds it once. A token from any other session resolves to no grant.';
comment on column public.silo_api_grants.consented_aal is
  'The assurance level of the session that approved this connection. An OAuth token always reads aal1, so this is the only evidence that two-factor approval happened; it is never stamped back onto a token.';

-- EVERY grant expires, and 90 days is the maximum (Blake's decision,
-- 2026-10-19). It is stated here rather than left to whatever writes a row,
-- because a nullable expiry plus a resolver reading NULL as "no expiry" is a
-- permanent connection one missing field away -- the same fail-open shape as
-- coalescing the company back to profiles. The expiry exists at all because an
-- OAuth token reads aal1 and Supabase re-issues it hourly, forever, without
-- asking anyone: two-factor approval is a moment, not a property a connection
-- keeps. Re-consent moves consented_at, which moves the window; it does not
-- extend an existing row. Written as ALTERs so re-applying the migration over
-- an existing table tightens it too (create table if not exists would not).
update public.silo_api_grants
   set expires_at = consented_at + interval '90 days'
 where expires_at is null;
alter table public.silo_api_grants
  alter column expires_at set default (now() + interval '90 days');
alter table public.silo_api_grants
  alter column expires_at set not null;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.silo_api_grants'::regclass
                   and conname = 'silo_api_grants_max_lifetime') then
    alter table public.silo_api_grants
      add constraint silo_api_grants_max_lifetime
      check (expires_at > consented_at
         and expires_at <= consented_at + interval '90 days');
  end if;
end $$;
comment on column public.silo_api_grants.expires_at is
  'When this authorization dies. NOT NULL, defaults to 90 days from now, and silo_api_grants_max_lifetime refuses anything longer than 90 days from consented_at. No silent renewal: at expiry the person reapproves with their second factor.';

-- One LIVE grant per client per person: v1 is one company per (person, client),
-- so a second consent for another company must revoke the first rather than
-- quietly leaving two. A partial index says that in the schema instead of in a
-- comment.
create unique index if not exists silo_api_grants_one_live
  on public.silo_api_grants (client_id, user_id) where revoked_at is null;
-- A session identifies at most one grant, so a bound session cannot be made to
-- answer for two companies.
create unique index if not exists silo_api_grants_session
  on public.silo_api_grants (auth_session_id) where auth_session_id is not null;
create index if not exists silo_api_grants_user on public.silo_api_grants (user_id);
create index if not exists silo_api_grants_company on public.silo_api_grants (company_entity_id);

alter table public.silo_api_grants enable row level security;

-- A person manages their OWN connections for the company they are working in.
-- The integration role is granted nothing here at all: a connection can never
-- read, widen or extend itself.
drop policy if exists silo_api_grants_select on public.silo_api_grants;
create policy silo_api_grants_select on public.silo_api_grants
  for select to authenticated
  using (user_id = auth.uid() and company_entity_id = public.active_company_id());

drop policy if exists silo_api_grants_insert on public.silo_api_grants;
create policy silo_api_grants_insert on public.silo_api_grants
  for insert to authenticated
  with check (user_id = auth.uid() and company_entity_id = public.active_company_id());

-- Revoking is the only field a person changes after the fact. Everything else
-- about a grant is decided at consent; an UPDATE that could move
-- company_entity_id or scopes would be a way to widen an approval without
-- approving anything, so the WITH CHECK pins both.
drop policy if exists silo_api_grants_revoke on public.silo_api_grants;
create policy silo_api_grants_revoke on public.silo_api_grants
  for update to authenticated
  using (user_id = auth.uid() and company_entity_id = public.active_company_id())
  with check (user_id = auth.uid() and company_entity_id = public.active_company_id());

revoke all on public.silo_api_grants from anon, authenticated, silo_integration, silo_revoked;
grant select, insert, update on public.silo_api_grants to authenticated;

-- The access-token hook runs as supabase_auth_admin, inside GoTrue.
grant select, update on public.silo_api_grants to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 3. Reading the request's claims
-- ---------------------------------------------------------------------------
-- From the GUC, not auth.jwt(). auth.jwt() is itself only a wrapper over this
-- setting, and it needs USAGE on schema auth -- which a role other than
-- postgres cannot be given on Supabase: schema auth is owned by
-- supabase_admin, and a GRANT by a role that is neither its owner nor a
-- superuser is accepted and does nothing (measured; the same wall makes the
-- outbound-HTTP revoke a no-op). Reading the GUC needs no schema privilege at
-- all, so every function below works whatever role it runs as.
create or replace function public.silo_api_claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb)
$$;

comment on function public.silo_api_claims() is
  'This request''s JWT claims, read from the request.jwt.claims GUC. Deliberately not auth.jwt(): that needs USAGE on schema auth, which cannot be granted to a non-superuser role on Supabase. 20261020030000.';

-- A request is an integration request when its token carries a client_id.
-- First-party tokens never do.
create or replace function public.silo_api_is_integration()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.silo_api_claims() ->> 'client_id', '') <> ''
$$;

comment on function public.silo_api_is_integration() is
  'True when this request comes from a third-party OAuth client (its token carries client_id). 20261020030000.';

revoke all on function public.silo_api_claims() from public;
revoke all on function public.silo_api_is_integration() from public;
-- Both are needed by the storage.objects policies, which are evaluated as
-- whatever role the request runs as -- including anon.
grant execute on function public.silo_api_claims()
  to anon, authenticated, service_role, silo_integration, silo_revoked, silo_api_exec;
grant execute on function public.silo_api_is_integration()
  to anon, authenticated, service_role, silo_integration, silo_revoked, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 4. The resolver
-- ---------------------------------------------------------------------------
-- RETURNS SETOF, not the composite type. A function declared to return a bare
-- composite yields ONE all-NULL row when nothing matches, which makes
-- `not exists (select 1 from silo_api_grant())` permanently false -- every
-- refusal built on it would fail OPEN. That is not hypothetical: it is a defect
-- this design had, found by the proof harness.
--
-- SECURITY DEFINER because the caller's role is granted nothing on
-- silo_api_grants. Owned by postgres, which is safe here only because the body
-- is a single lookup keyed entirely by the caller's own claims and it returns
-- nothing else.
--
-- Five conditions, all required: the client matches, the person matches, the
-- SESSION matches, the grant is not revoked, it has not expired. Plus a live
-- membership check, so losing access to a company ends the integration's
-- access to it without anyone revoking anything.
create or replace function public.silo_api_grant()
returns setof public.silo_api_grants
language sql
stable
security definer
set search_path = ''
as $$
  select g.*
  from public.silo_api_grants g
  where g.client_id = (public.silo_api_claims() ->> 'client_id')
    and g.user_id = nullif(public.silo_api_claims() ->> 'sub', '')::uuid
    and g.auth_session_id = nullif(public.silo_api_claims() ->> 'session_id', '')::uuid
    and g.revoked_at is null
    and g.expires_at > now()
    and exists (
      select 1 from public.entity_memberships em
      where em.user_id = g.user_id and em.entity_id = g.company_entity_id)
$$;

comment on function public.silo_api_grant() is
  'The live grant for this request, or NO ROWS. Returns SETOF on purpose: a composite-returning version yields one all-NULL row when nothing matches, which makes every `not exists` refusal built on it fail open. 20261020030000.';

-- Supabase's default privileges re-grant EXECUTE on every new public function
-- to anon and authenticated, so anon is revoked by name, not just via PUBLIC.
revoke all on function public.silo_api_grant() from public, anon;
grant execute on function public.silo_api_grant()
  to authenticated, silo_integration, silo_revoked, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 5. The company
-- ---------------------------------------------------------------------------
-- The first-party branch is the pre-existing body, verbatim. The integration
-- branch resolves from the grant and returns NULL when there is no usable one:
-- every company-scoped policy compares against this, and NULL = NULL is never
-- true, so an unusable connection sees nothing rather than inheriting whatever
-- company the person last opened in a browser tab.
create or replace function public.active_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.silo_api_is_integration()
      then (select g.company_entity_id from public.silo_api_grant() g)
    else (select p.active_company_id from public.profiles p where p.id = auth.uid())
  end
$$;

comment on function public.active_company_id() is
  'The company this request is scoped to. First-party: profiles.active_company_id (set by set_active_company()). Integration (token carries client_id): the company recorded on its live grant, and NULL if the grant is missing, revoked, expired or bound to another session -- never a fallback to profiles. 20261020030000 (was 20260612, company branch added).';

-- ---------------------------------------------------------------------------
-- 6. Two-factor assurance for a connection
-- ---------------------------------------------------------------------------
-- The first-party branch is 20261014000000's body, verbatim.
--
-- The integration branch cannot read the token: an OAuth token issued from a
-- genuine two-factor consent still says aal1, and says aal1 again after every
-- refresh (measured on real GoTrue). Relabelling it would be forging the one
-- fact MFA is supposed to establish. So the question becomes the honest one --
-- was this CONNECTION approved in a two-factor session? -- answered from the
-- grant, which also means revoking the grant removes the assurance with it.
create or replace function public.mfa_session_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.silo_api_is_integration()
      then exists (select 1 from public.silo_api_grant() g where g.consented_aal = 'aal2')
    else
      coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or (select auth.uid()) is null
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified')
  end
$$;

comment on function public.mfa_session_satisfied() is
  'True unless the request needs two-factor assurance and does not have it. First-party: the session is aal2, or there is no signed-in user, or the user holds no verified factor. Integration: the GRANT was consented at aal2 -- an OAuth token always reads aal1, so the token is never the evidence. Used by silo_check_request() and the storage.objects restrictive policies. 20261014000000, integration branch 20261020030000.';

revoke all on function public.mfa_session_satisfied() from public;
grant execute on function public.mfa_session_satisfied()
  to anon, authenticated, service_role, silo_integration, silo_revoked;

-- ---------------------------------------------------------------------------
-- 7. The pre-request gate
-- ---------------------------------------------------------------------------
-- Grant state is decided BEFORE assurance. A revoked connection answered
-- mfa_required would send the application to a two-factor screen that cannot
-- fix anything, and would hide the real reason from whoever is debugging it.
-- The paths an integration may reach. One entry, deliberately: the developer
-- API is the report RPC and nothing else.
--
-- This is also what covers the EDGE FUNCTIONS, which run none of this
-- machinery themselves. A function that uses the caller's token for PostgREST
-- is refused here; and the sixteen that check the caller and then act with the
-- service role all ask PostgREST, as the caller, whether the session is good
-- enough (scripts/lib/mfa-gate.mjs) before their first service-role call --
-- that ask is an RPC, so it is refused here too, and the gate fails closed.
-- Without this list a valid integration token would reach any of them and read
-- its granted company's data through surfaces that are not reports at all.
create or replace function public.silo_api_path_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('request.path', true), '') in ('/rpc/silo_api_run_report')
$$;

comment on function public.silo_api_path_allowed() is
  'True when the Data API path this request is on is one an integration may use. One path: the report RPC. 20261020030000.';

revoke all on function public.silo_api_path_allowed() from public, anon;
grant execute on function public.silo_api_path_allowed()
  to authenticated, silo_integration, silo_revoked;

create or replace function public.silo_check_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.silo_api_is_integration() then
    if not exists (select 1 from public.silo_api_grant()) then
      raise sqlstate 'PGRST' using
        message = json_build_object(
          'code', 'integration_revoked',
          'message', 'This connection is no longer authorized.',
          'hint', 'Reconnect the application in SILO to continue.')::text,
        detail = json_build_object('status', 403, 'headers', json_build_object())::text;
    end if;
    if not public.silo_api_path_allowed() then
      raise sqlstate 'PGRST' using
        message = json_build_object(
          'code', 'integration_not_allowed',
          'message', 'This connection cannot use that feature.',
          'hint', 'The SILO API serves reports; see the API documentation.')::text,
        detail = json_build_object('status', 403, 'headers', json_build_object())::text;
    end if;
  end if;

  if not public.mfa_session_satisfied() then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'mfa_required',
        'message', 'Enter the code from your authenticator app to continue.',
        'hint', 'Sign in again to finish two-step login.')::text,
      -- PostgREST parses DETAIL with `status` AND `headers` both required
      -- (PgRaiseErrDetails, v12-v14); without headers it answers 500 PGRST121
      -- instead of this 403.
      detail = json_build_object('status', 403, 'headers', json_build_object())::text;
  end if;
end;
$$;

comment on function public.silo_check_request() is
  'PostgREST pre-request hook (pgrst.db_pre_request). Refuses an integration request with no usable grant (integration_revoked), then any request lacking the two-factor assurance it needs (mfa_required). Grant state first: a revoked connection must not be told to go and enter a code. 20261014000000, integration refusal 20261020030000. Rollback: alter role authenticator reset pgrst.db_pre_request; notify pgrst, ''reload config'';';

revoke all on function public.silo_check_request() from public;
grant execute on function public.silo_check_request()
  to anon, authenticated, service_role, silo_integration, silo_revoked;

-- ---------------------------------------------------------------------------
-- 8. The access-token hook
-- ---------------------------------------------------------------------------
-- Runs inside GoTrue for every token it issues, including every refresh. It is
-- inert until the Custom Access Token hook is pointed at it in the dashboard.
--
-- Three outcomes:
--   no client_id            -> the event is returned untouched. First-party
--                              tokens are not altered in any way.
--   client_id with a grant  -> role=silo_integration, plus the company and
--                              scopes as claims. The claims are CONVENIENCE
--                              (logging, the client's own display); nothing in
--                              the database trusts them -- every refusal reads
--                              the grant row live.
--   client_id, no grant     -> role=silo_revoked. It must be stamped here,
--                              because a token already issued cannot be
--                              relabelled afterwards; a grantless client token
--                              left as role=authenticated would carry a real
--                              user's privileges to Storage and to every
--                              verify_jwt function, neither of which runs the
--                              pre-request gate.
--
-- It also performs the one-time session binding: consent happens before the
-- OAuth session exists, so the first issuance writes session_id onto the
-- grant. Only a grant with auth_session_id IS NULL can be bound, so this can
-- never move a grant from one session to another.
create or replace function public.silo_api_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb;
  v_client_id text;
  v_user_id uuid;
  v_session_id uuid;
  v_grant public.silo_api_grants;
begin
  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_client_id := coalesce(v_claims ->> 'client_id', event ->> 'oauth_client_id');

  -- First-party: untouched.
  if v_client_id is null or v_client_id = '' then
    return event;
  end if;

  v_user_id := nullif(event ->> 'user_id', '')::uuid;
  v_session_id := nullif(v_claims ->> 'session_id', '')::uuid;

  -- Already bound to this session?
  select * into v_grant
  from public.silo_api_grants
  where client_id = v_client_id
    and user_id = v_user_id
    and auth_session_id = v_session_id
    and revoked_at is null
    and expires_at > now();

  -- Otherwise the first issuance for a fresh consent, which binds it.
  if v_grant.id is null then
    select * into v_grant
    from public.silo_api_grants
    where client_id = v_client_id
      and user_id = v_user_id
      and auth_session_id is null
      and revoked_at is null
      and expires_at > now()
    for update;

    if v_grant.id is null then
      return jsonb_set(event, '{claims}',
        v_claims || jsonb_build_object('role', 'silo_revoked'));
    end if;

    update public.silo_api_grants
      set auth_session_id = v_session_id, updated_at = now()
      where id = v_grant.id;
  end if;

  return jsonb_set(event, '{claims}',
    v_claims
    || jsonb_build_object('role', 'silo_integration')
    || jsonb_build_object('silo_company', v_grant.company_entity_id)
    || jsonb_build_object('silo_scopes', to_jsonb(v_grant.scopes)));
end;
$$;

comment on function public.silo_api_access_token_hook(jsonb) is
  'Supabase Custom Access Token hook. Stamps role=silo_integration (plus company and scope claims, for display only) on a token carrying client_id when its grant is usable, role=silo_revoked when it is not, and leaves first-party tokens untouched. Also binds a fresh grant to its Auth session on first issuance. Runs on every refresh too. Inert until pointed at in Authentication settings. 20261020030000.';

-- Only GoTrue may call it. In particular not anon or authenticated: it writes.
revoke all on function public.silo_api_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.silo_api_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 9. Scopes
-- ---------------------------------------------------------------------------
-- Reads the GRANT, never the token's silo_scopes claim. The claim is stamped at
-- issuance and would stay stale for up to an hour after a person narrowed a
-- connection's permissions; a narrowed scope has to take effect on the next
-- request, the way revocation does.
--
-- First-party requests pass straight through: scopes are a property of a
-- third-party connection, not of a person.
create or replace function public.silo_api_require_scope(p_scope text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.silo_api_is_integration() then
    return;
  end if;
  -- Grant state before scope, for the same reason the pre-request gate decides
  -- it before assurance: a revoked connection told "insufficient scope" would
  -- send whoever is debugging it to widen permissions that no longer exist.
  -- The gate normally answers this first, but a caller that reaches this
  -- function by another route must get the same answer it would have got there.
  if not exists (select 1 from public.silo_api_grant()) then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'integration_revoked',
        'message', 'This connection is no longer authorized.',
        'hint', 'Reconnect the application in SILO to continue.')::text,
      detail = json_build_object('status', 403, 'headers', json_build_object())::text;
  end if;
  if not exists (
    select 1 from public.silo_api_grant() g where p_scope = any(g.scopes)
  ) then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'insufficient_scope',
        'message', 'This connection is not allowed to do that.',
        'hint', 'Reconnect the application in SILO and approve the access it needs.')::text,
      detail = json_build_object('status', 403, 'headers', json_build_object())::text;
  end if;
end;
$$;

comment on function public.silo_api_require_scope(text) is
  'Refuses an integration request whose live grant does not carry p_scope (403 insufficient_scope); first-party requests pass through. Reads the grant row, not the token''s silo_scopes claim, so narrowing a connection takes effect on the next request. Every API surface calls this -- one implementation, not one per endpoint. 20261020030000.';

revoke all on function public.silo_api_require_scope(text) from public, anon;
grant execute on function public.silo_api_require_scope(text)
  to authenticated, silo_integration, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 10. Typed parameter substitution, server side
-- ---------------------------------------------------------------------------
-- The browser's copy of this lives in v3/js/report-params.js and is the
-- authority on the rules; this is the same contract for callers that have no
-- browser (the API, and in time the scheduled CSVs). The two must agree, so
-- the pieces that can drift are asserted against each other in
-- verify_v2_schema.sql: the period tokens here and the PERIOD_SQL map there.
--
-- A value never reaches the SQL as text. It becomes a LITERAL by type:
--   number  cast to numeric, emitted as digits. A string that is not a number
--           cannot survive the cast at all.
--   date    'today', 'today-27d' and the sixteen period boundaries become
--           GENERATED expressions over silo_business_today(), so the company's
--           calendar decides -- not the caller's. Anything else must be an
--           exact YYYY-MM-DD that round-trips (2026-02-31 is rejected).
--   enum    compared against the DECLARED options. Not sanitised, compared.
--   text    quoted via quote_literal, after refusing control characters and
--           semicolons.
--
-- And a {{token}} the report does not declare is an ERROR, never a
-- passthrough: the declaration list is the allowlist.
--
-- The substitution itself is deliberately NOT regexp_replace(): its replacement
-- argument interprets \1-\9 and \&, so a perfectly escaped literal is not inert
-- there and a value containing a backslash comes out mangled (found in the
-- proof harness, where 'a\b' silently became a backspace). Each token is first
-- replaced by an opaque placeholder, then the placeholder by the literal using
-- replace(), which interprets nothing.
create or replace function public.silo_api_period_sql(p_token text, p_today text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_token
    when 'week_start'          then format('date_trunc(''week'', %s)::date', p_today)
    when 'week_end'            then format('(date_trunc(''week'', %s) + interval ''6 days'')::date', p_today)
    when 'prior_week_start'    then format('(date_trunc(''week'', %s) - interval ''7 days'')::date', p_today)
    when 'prior_week_end'      then format('(date_trunc(''week'', %s) - interval ''1 day'')::date', p_today)
    when 'month_start'         then format('date_trunc(''month'', %s)::date', p_today)
    when 'month_end'           then format('(date_trunc(''month'', %s) + interval ''1 month - 1 day'')::date', p_today)
    when 'prior_month_start'   then format('(date_trunc(''month'', %s) - interval ''1 month'')::date', p_today)
    when 'prior_month_end'     then format('(date_trunc(''month'', %s) - interval ''1 day'')::date', p_today)
    when 'quarter_start'       then format('date_trunc(''quarter'', %s)::date', p_today)
    when 'quarter_end'         then format('(date_trunc(''quarter'', %s) + interval ''3 months - 1 day'')::date', p_today)
    when 'prior_quarter_start' then format('(date_trunc(''quarter'', %s) - interval ''3 months'')::date', p_today)
    when 'prior_quarter_end'   then format('(date_trunc(''quarter'', %s) - interval ''1 day'')::date', p_today)
    when 'year_start'          then format('date_trunc(''year'', %s)::date', p_today)
    when 'year_end'            then format('(date_trunc(''year'', %s) + interval ''1 year - 1 day'')::date', p_today)
    when 'prior_year_start'    then format('(date_trunc(''year'', %s) - interval ''1 year'')::date', p_today)
    when 'prior_year_end'      then format('(date_trunc(''year'', %s) - interval ''1 day'')::date', p_today)
    else null
  end
$$;

comment on function public.silo_api_period_sql(text, text) is
  'One period boundary token rendered as SQL over an expression for the company''s today. The server-side half of PERIOD_SQL in v3/js/report-params.js; verify_v2_schema.sql asserts the two token sets are identical. NULL for an unknown token -- callers treat that as "not a boundary", never as a passthrough. 20261020030000.';

revoke all on function public.silo_api_period_sql(text, text) from public, anon;
grant execute on function public.silo_api_period_sql(text, text)
  to authenticated, silo_api_exec;

create or replace function public.silo_api_substitute(
  p_sql text,
  p_declared jsonb,
  p_values jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  c_today  constant text := '(select public.silo_business_today())';
  v_out    text := coalesce(p_sql, '');
  v_decl   jsonb := '{}'::jsonb;   -- key -> declaration
  v_keys   text[] := '{}';         -- tokens used, in order of appearance
  v_key    text;
  v_d      jsonb;
  v_type   text;
  v_raw    text;
  v_label  text;
  v_lit    text;
  v_ph     text;
  v_i      integer := 0;
  v_phs    text[] := '{}';   -- placeholder per token, in the same order
  v_lits   text[] := '{}';   -- its literal
  v_j      integer;
  v_n      numeric;
  v_iso    date;
  v_rel    text[];
  v_period text;
  v_item   jsonb;
  v_dkey   text;
begin
  -- Normalize the declarations. Anything malformed is DROPPED rather than
  -- half-honoured: a declaration that cannot be understood must not become a
  -- token that substitutes something unintended. First declaration of a key
  -- wins, matching the browser.
  for v_item in
    select value from jsonb_array_elements(
      case when jsonb_typeof(coalesce(p_declared, 'null'::jsonb)) = 'array'
           then p_declared else '[]'::jsonb end)
  loop
    if jsonb_typeof(v_item) <> 'object' then continue; end if;
    v_dkey := lower(trim(coalesce(v_item ->> 'key', '')));
    v_type := lower(trim(coalesce(v_item ->> 'type', '')));
    if v_dkey !~ '^[a-z][a-z0-9_]*$' then continue; end if;
    if v_type not in ('date', 'number', 'enum', 'text') then continue; end if;
    if v_decl ? v_dkey then continue; end if;
    -- An enum with nothing to choose from can never resolve, so it is not a
    -- usable declaration.
    if v_type = 'enum' and coalesce(jsonb_array_length(
         case when jsonb_typeof(coalesce(v_item -> 'options','null'::jsonb)) = 'array'
              then v_item -> 'options' else '[]'::jsonb end), 0) = 0 then
      continue;
    end if;
    v_decl := v_decl || jsonb_build_object(v_dkey, v_item);
  end loop;

  -- Every distinct {{token}}, in order of appearance.
  select coalesce(array_agg(distinct_key order by first_at), '{}')
    into v_keys
  from (
    select lower(m.match[1]) as distinct_key, min(m.ord) as first_at
    from (
      select t.match, row_number() over () as ord
      from regexp_matches(v_out, '\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}', 'g') as t(match)
    ) m
    group by lower(m.match[1])
  ) s;

  if array_length(v_keys, 1) is null then
    return v_out;
  end if;

  foreach v_key in array v_keys loop
    if not (v_decl ? v_key) then
      raise exception 'report_parameter_undeclared: {{%}} is not a declared parameter of this report', v_key
        using errcode = 'check_violation';
    end if;
    v_d := v_decl -> v_key;
    v_type := lower(trim(v_d ->> 'type'));
    v_label := coalesce(nullif(trim(coalesce(v_d ->> 'label', '')), ''), v_key);

    -- Supplied value if there is one, otherwise the declared default. An empty
    -- string counts as "not supplied", so clearing a control falls back to the
    -- report's own default rather than erroring.
    v_raw := nullif(coalesce(p_values, '{}'::jsonb) ->> v_key, '');
    if v_raw is null then
      v_raw := nullif(coalesce(v_d ->> 'default', ''), '');
    end if;
    if v_raw is null then
      raise exception 'report_parameter_missing: "%" needs a value', v_label
        using errcode = 'check_violation';
    end if;

    if v_type = 'number' then
      begin
        v_n := trim(v_raw)::numeric;
      exception when others then
        raise exception 'report_parameter_invalid: "%" must be a number', v_label
          using errcode = 'check_violation';
      end;
      if v_n is null or v_n = 'NaN'::numeric then
        raise exception 'report_parameter_invalid: "%" must be a number', v_label
          using errcode = 'check_violation';
      end if;
      v_lit := v_n::text;

    elsif v_type = 'date' then
      v_lit := null;
      -- Company calendar: only generated, allowlisted expressions cross this
      -- boundary, and they resolve at execution in the company's timezone.
      if coalesce(v_d ->> 'date_basis', '') = 'company' then
        v_rel := regexp_match(lower(trim(v_raw)), '^today(?:\s*-\s*([0-9]{1,5})d)?$');
        if v_rel is not null then
          v_lit := format('(%s - %s)', c_today, coalesce(v_rel[1], '0')::integer);
        else
          v_period := public.silo_api_period_sql(lower(trim(v_raw)), c_today);
          if v_period is not null then
            v_lit := format('(%s)', v_period);
          end if;
        end if;
      end if;
      if v_lit is null then
        -- A literal date, and it must round-trip: the shape test alone accepts
        -- 2026-02-31.
        if lower(trim(v_raw)) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception 'report_parameter_invalid: "%" must be a date (YYYY-MM-DD) or a period boundary', v_label
            using errcode = 'check_violation';
        end if;
        begin
          v_iso := trim(v_raw)::date;
        exception when others then
          raise exception 'report_parameter_invalid: "%" is not a real date', v_label
            using errcode = 'check_violation';
        end;
        if to_char(v_iso, 'YYYY-MM-DD') <> trim(v_raw) then
          raise exception 'report_parameter_invalid: "%" is not a real date', v_label
            using errcode = 'check_violation';
        end if;
        v_lit := format('date %s', quote_literal(to_char(v_iso, 'YYYY-MM-DD')));
      end if;

    elsif v_type = 'enum' then
      -- Compared, not sanitised. An option list is an allowlist.
      if not exists (
        select 1 from jsonb_array_elements_text(v_d -> 'options') o
        where o = v_raw
      ) then
        raise exception 'report_parameter_invalid: "%" must be one of the report''s options', v_label
          using errcode = 'check_violation';
      end if;
      v_lit := quote_literal(v_raw);

    else  -- text
      if v_raw ~ '[\x00-\x1f\x7f]' then
        raise exception 'report_parameter_invalid: "%" contains a control character', v_label
          using errcode = 'check_violation';
      end if;
      -- chat_run_readonly_query refuses a semicolon anywhere in the query as
      -- its single-statement guard, so say the true thing about the field here
      -- rather than letting the runner complain about the statement.
      if position(';' in v_raw) > 0 then
        raise exception 'report_parameter_invalid: "%" cannot contain a semicolon', v_label
          using errcode = 'check_violation';
      end if;
      v_lit := quote_literal(v_raw);
    end if;

    -- Every token becomes an opaque placeholder FIRST, and only once every
    -- token in the original SQL has been replaced do the placeholders become
    -- literals. Two passes, not one per parameter: a literal substituted in
    -- the first pass must never be rescanned, or a text value of "{{other}}"
    -- would be rewritten into another parameter's literal -- which is what an
    -- interleaved loop did here, and which the browser's single-pass
    -- String.replace() never does.
    v_i := v_i + 1;
    v_ph := format('$silo_ph_%s$', v_i);
    if position(v_ph in v_out) > 0 then
      raise exception 'report_parameter_placeholder_collision: the report''s SQL contains %', v_ph
        using errcode = 'check_violation';
    end if;
    v_out := regexp_replace(v_out, '\{\{\s*' || v_key || '\s*\}\}', v_ph, 'gi');
    v_phs := v_phs || v_ph;
    v_lits := v_lits || v_lit;
  end loop;

  -- replace(), never regexp_replace(): its replacement argument interprets
  -- \1-\9 and \&, so a correctly escaped literal is not inert there.
  for v_j in 1 .. coalesce(array_length(v_phs, 1), 0) loop
    v_out := replace(v_out, v_phs[v_j], v_lits[v_j]);
  end loop;

  return v_out;
end;
$$;

comment on function public.silo_api_substitute(text, jsonb, jsonb) is
  'Substitutes a saved report''s declared parameters into its SQL as typed literals, or raises. The server-side twin of substitute() in v3/js/report-params.js. An undeclared {{token}} is fatal. Replacement goes through an opaque placeholder because regexp_replace() interprets backslash escapes in its replacement argument. 20261020030000.';

revoke all on function public.silo_api_substitute(text, jsonb, jsonb) from public, anon;
-- Only the report wrapper needs it. Not the integration role: it is a helper,
-- and an API client has no reason to render SQL it cannot run.
grant execute on function public.silo_api_substitute(text, jsonb, jsonb)
  to authenticated, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 11. The one API surface
-- ---------------------------------------------------------------------------
-- Runs one of SILO's GLOBAL reports (source = 'system') and returns its rows
-- with the metadata a caller needs to know what it is holding: which company,
-- which calendar, when it ran, and whether the page was cut short.
--
-- `json`, not `jsonb`, for the same reason chat_run_readonly_query is: jsonb
-- sorts object keys, which silently reorders a report's columns.
--
-- SECURITY DEFINER owned by silo_api_exec. That role owns no tables and holds
-- no BYPASSRLS, so RLS is fully in force inside this function: the rows a
-- report returns are the rows the grant's company is entitled to, decided by
-- the same policies that decide it for a person. What the ownership buys is
-- that the TOKEN's role (silo_integration) needs no privilege on any report
-- table -- it holds EXECUTE on this function and nothing else, which is what
-- makes "reports only" true by privilege rather than by promise.
--
-- Only `system` reports, by design: those are curated, in the catalog, and
-- tied out nightly. A company's own saved report is not part of the API
-- contract in v1.
create or replace function public.silo_api_run_report(
  p_report_id uuid,
  p_params jsonb default '{}'::jsonb,
  p_query_index integer default 0,
  p_offset integer default 0)
returns json
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c_page_size constant integer := 1000;
  v_r         record;
  v_sql       text;
  v_final     text;
  v_rows      json;
  v_count     integer;
  v_company   uuid;
begin
  perform public.silo_api_require_scope('reports:read');

  if p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset: offset must be between 0 and 1000000'
      using errcode = 'check_violation';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    -- Belt to the pre-request gate's braces: a request that somehow arrives
    -- with no resolvable company must not run a report against whatever RLS
    -- would allow.
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  select r.id, r.title, r.updated_at, r.queries_run, r.parameters, r.columns_metadata
    into v_r
  from public.silo_chat_saved_reports_v r
  where r.id = p_report_id
    and r.source = 'system'
    and r.archived_at is null;

  if v_r.id is null then
    raise exception 'report_not_found: no approved report with that id'
      using errcode = 'no_data_found';
  end if;

  if p_query_index < 0
     or p_query_index >= coalesce(array_length(v_r.queries_run, 1), 0) then
    raise exception 'invalid_query_index: this report has % queries',
      coalesce(array_length(v_r.queries_run, 1), 0)
      using errcode = 'check_violation';
  end if;

  v_sql := v_r.queries_run[p_query_index + 1];
  v_final := public.silo_api_substitute(v_sql, v_r.parameters, coalesce(p_params, '{}'::jsonb));

  execute format(
    'select coalesce(json_agg(t), ''[]''::json), count(*)::integer
       from (select * from (%s) q limit %s offset %s) t',
    v_final, c_page_size, p_offset)
    into v_rows, v_count;

  return json_build_object(
    'report', json_build_object(
      'id', v_r.id,
      'title', v_r.title,
      'updated_at', v_r.updated_at,
      'query_index', p_query_index,
      'query_count', coalesce(array_length(v_r.queries_run, 1), 0),
      'columns', v_r.columns_metadata),
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now(),
    'offset', p_offset,
    'page_size', c_page_size,
    'row_count', v_count,
    -- A full page means there may be more. It does not mean there are: the
    -- caller asks for the next page and gets an empty one. Saying "maybe" is
    -- the honest answer without a second count over the whole report.
    'has_more', v_count = c_page_size,
    'rows', v_rows);
end;
$function$;

comment on function public.silo_api_run_report(uuid, jsonb, integer, integer) is
  'The developer API''s only data surface: runs one query of one GLOBAL (source = ''system'') report with typed parameters and returns a page of rows plus company, timezone, paging and generated_at. Requires the reports:read scope. SECURITY DEFINER owned by silo_api_exec, which owns no tables -- RLS decides the rows; the ownership only spares the integration role from needing privileges of its own. 20261020030000.';

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the
-- schema, so it is granted for exactly this statement and taken back.
grant create on schema public to silo_api_exec;
alter function public.silo_api_run_report(uuid, jsonb, integer, integer) owner to silo_api_exec;
revoke create on schema public from silo_api_exec;

revoke all on function public.silo_api_run_report(uuid, jsonb, integer, integer) from public, anon;
grant execute on function public.silo_api_run_report(uuid, jsonb, integer, integer)
  to silo_integration, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Storage
-- ---------------------------------------------------------------------------
-- Storage runs neither the pre-request gate nor any of the above, so a
-- third-party token would otherwise reach every bucket its person can reach.
-- Restrictive, so it ANDs with each bucket's own policies and cannot be
-- widened by adding another permissive one.
--
-- Today this is the second of two layers: silo_integration has no USAGE on
-- schema storage, so such a request is refused before any policy is consulted.
-- The policy is what holds if that ever changes, and it is also what holds for
-- a token that carries client_id while claiming an ordinary role -- which is
-- exactly the shape a bug in the access-token hook would produce.
drop policy if exists no_third_party_clients on storage.objects;
create policy no_third_party_clients on storage.objects
  as restrictive
  for all
  to public
  using ((select public.silo_api_claims() ->> 'client_id') is null)
  with check ((select public.silo_api_claims() ->> 'client_id') is null);

comment on policy no_third_party_clients on storage.objects is
  'Refuses every Storage read and write from a third-party OAuth client, whatever the bucket''s own policies allow. Storage does not run the Data API pre-request gate. 20261020030000.';

-- ---------------------------------------------------------------------------
-- 13. Assert what cannot be assumed
-- ---------------------------------------------------------------------------
-- Every statement above could be accepted and do nothing. On Supabase a GRANT
-- or REVOKE issued by a role that is neither the object's owner nor a
-- superuser is accepted with a warning and changes NOTHING -- which is how an
-- earlier version of this design carried a "fix" that had never taken effect.
-- So the migration refuses to finish quietly if any of it did not land.
do $$
declare
  v_missing text[] := '{}';
begin
  if not pg_has_role('authenticator', 'silo_integration', 'member') then
    v_missing := v_missing || 'authenticator is not a member of silo_integration';
  end if;
  if not pg_has_role('authenticator', 'silo_revoked', 'member') then
    v_missing := v_missing || 'authenticator is not a member of silo_revoked';
  end if;
  -- The wrapper's read reach. Without it every report returns an empty page,
  -- because the policies on most report tables are granted to a named role.
  if not pg_has_role('silo_api_exec', 'authenticated', 'member') then
    v_missing := v_missing || 'silo_api_exec is not a member of authenticated';
  end if;

  -- The whole reason a SECURITY DEFINER wrapper is acceptable here.
  if exists (select 1 from pg_roles where rolname = 'silo_api_exec' and rolbypassrls) then
    v_missing := v_missing || 'silo_api_exec holds BYPASSRLS';
  end if;
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relowner = 'silo_api_exec'::regrole and c.relkind in ('r','p','v','m','f')
  ) then
    v_missing := v_missing || 'silo_api_exec owns a relation, so SECURITY DEFINER would bypass RLS on it';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc
       where oid = 'public.silo_api_run_report(uuid,jsonb,integer,integer)'::regprocedure)
     <> 'silo_api_exec' then
    v_missing := v_missing || 'silo_api_run_report is not owned by silo_api_exec';
  end if;

  -- The token's role must be able to run exactly one thing and read nothing.
  if not has_function_privilege('silo_integration',
       'public.silo_api_run_report(uuid,jsonb,integer,integer)'::regprocedure, 'execute') then
    v_missing := v_missing || 'silo_integration cannot execute silo_api_run_report';
  end if;
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
      and has_table_privilege('silo_integration', c.oid, 'SELECT')
  ) then
    v_missing := v_missing || 'silo_integration can SELECT from a public relation: '
      || (select string_agg(c.relname, ', ' order by c.relname)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p','v','m')
            and has_table_privilege('silo_integration', c.oid, 'SELECT'));
  end if;
  if has_schema_privilege('silo_integration', 'storage', 'usage') then
    v_missing := v_missing || 'silo_integration has USAGE on schema storage';
  end if;

  -- GoTrue's side of the hook.
  if not has_schema_privilege('supabase_auth_admin', 'public', 'usage') then
    v_missing := v_missing || 'supabase_auth_admin has no USAGE on schema public';
  end if;
  if not has_table_privilege('supabase_auth_admin', 'public.silo_api_grants', 'SELECT,UPDATE') then
    v_missing := v_missing || 'supabase_auth_admin cannot read/update silo_api_grants';
  end if;
  if not has_function_privilege('supabase_auth_admin',
       'public.silo_api_access_token_hook(jsonb)'::regprocedure, 'execute') then
    v_missing := v_missing || 'supabase_auth_admin cannot execute silo_api_access_token_hook';
  end if;
  if has_function_privilege('authenticated',
       'public.silo_api_access_token_hook(jsonb)'::regprocedure, 'execute') then
    v_missing := v_missing || 'authenticated can execute silo_api_access_token_hook';
  end if;

  -- The path allowlist must be reachable too, and must not be empty: an empty
  -- list would refuse the report RPC as well, and a list that accepts
  -- everything would be no list at all.
  if not has_function_privilege('silo_integration',
       'public.silo_api_path_allowed()'::regprocedure, 'execute') then
    v_missing := v_missing || 'silo_integration cannot execute silo_api_path_allowed';
  end if;
  if pg_get_functiondef('public.silo_api_path_allowed()'::regprocedure)
       not like '%request.path%'
     or pg_get_functiondef('public.silo_api_path_allowed()'::regprocedure)
       not like '%/rpc/silo_api_run_report%' then
    v_missing := v_missing || 'silo_api_path_allowed does not read the path and name the report RPC';
  end if;

  -- The pre-request gate has to be reachable AS the integration roles, or a
  -- refused connection gets "permission denied for function" instead of being
  -- told what is wrong.
  if not has_function_privilege('silo_integration',
       'public.silo_check_request()'::regprocedure, 'execute')
     or not has_function_privilege('silo_revoked',
       'public.silo_check_request()'::regprocedure, 'execute') then
    v_missing := v_missing || 'an integration role cannot execute silo_check_request';
  end if;

  -- The period tokens have to match the browser's PERIOD_SQL map, or a report
  -- means one thing on a dashboard and another through the API. The names are
  -- asserted here; verify_v2_schema.sql asserts the set against the JS file.
  if exists (
    select 1 from unnest(array[
      'week_start','week_end','prior_week_start','prior_week_end',
      'month_start','month_end','prior_month_start','prior_month_end',
      'quarter_start','quarter_end','prior_quarter_start','prior_quarter_end',
      'year_start','year_end','prior_year_start','prior_year_end']) t(tok)
    where public.silo_api_period_sql(t.tok, 'X') is null
  ) then
    v_missing := v_missing || 'silo_api_period_sql is missing a period boundary';
  end if;

  -- Every grant expires, and nothing may outlive 90 days from its consent.
  -- A nullable expiry is a permanent connection one missing field away.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'silo_api_grants'
               and column_name = 'expires_at' and is_nullable = 'YES') then
    v_missing := v_missing || 'silo_api_grants.expires_at is nullable';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.silo_api_grants'::regclass
                   and conname = 'silo_api_grants_max_lifetime') then
    v_missing := v_missing || 'the 90-day lifetime ceiling is missing';
  end if;
  -- And the resolver must not have been left reading NULL as live.
  if pg_get_functiondef('public.silo_api_grant()'::regprocedure) like '%expires_at is null%' then
    v_missing := v_missing || 'silo_api_grant() still treats a null expiry as live';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception E'20261020030000 did not fully apply:\n  - %',
      array_to_string(v_missing, E'\n  - ');
  end if;
end;
$$;

-- The company stamp backstop, per supabase/CLAUDE.md. The consent path always
-- supplies company_entity_id explicitly -- a grant's company is an
-- authorization decision, not a default -- and silo_api_grant() re-checks
-- membership on every request, so the trigger is never the authority here.
select public.attach_stamp_company_entity_id_triggers();

-- Ask SILO's schema map, after adding a public table.
select public.refresh_chat_schema_catalog();

-- Policies on silo_api_grants and storage.objects are evaluated as the
-- request's own role, so every API role needs EXECUTE on what they call.
grant execute on function public.active_company_id() to silo_integration, silo_revoked;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
