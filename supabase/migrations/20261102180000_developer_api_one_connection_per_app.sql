-- One live connection per person per APPLICATION.
--
-- WHY THIS EXISTS
--
-- silo_api_grants has always allowed only one live grant per
-- (client_id, user_id): silo_api_grants_one_live says so, and
-- silo_api_consent() revokes the previous row before inserting a new one. That
-- rule has never once fired in production, because client_id is not the
-- application.
--
-- Every MCP client registers itself through OAuth Dynamic Client Registration.
-- Measured on production 2026-11-02: every row in auth.oauth_clients is
-- registration_type = 'dynamic', and Cursor, Claude, Codex, ChatGPT and Grok
-- each hand SILO a BRAND NEW client_id on every connect. So the dedupe key is
-- fresh every time, the revoke matches nothing, and each reconnect leaves
-- another live grant behind. Travis held four live Cursor connections, only
-- the newest of which had ever been used.
--
-- The dedupe key is per USER, never per company (Blake, 2026-11-02): two
-- people in the same company must each be able to connect Cursor. And it is
-- per application, not per client registration, so one person can hold a
-- Claude, a ChatGPT, a Cursor and a Codex connection at the same time -- what
-- they cannot hold is two of the same application. Reconnecting replaces
-- (Blake's decision on the same date, having been shown that it also ends that
-- application's connection on a second machine).
--
-- WHAT IDENTIFIES AN APPLICATION
--
-- Its registered name plus the HOSTS of its redirect URIs. Not the URIs
-- themselves: Codex redirects to an ephemeral localhost port
-- (http://127.0.0.1:59105/callback/...) and ChatGPT and Codex both carry a
-- per-install token in the path, so a full-URI key would be as fresh as
-- client_id is. Hosts are stable -- cursor.com, claude.ai, chatgpt.com,
-- grok.com, 127.0.0.1 -- and name plus hosts is what a person means when they
-- say "the same app". Two genuinely different applications would have to share
-- both a name and a redirect host to collide, at which point they are
-- indistinguishable from the outside anyway.
--
-- When the client registration cannot be read -- deleted, or a client_id that
-- is not a uuid, as the tests use -- the key falls back to 'client:<id>',
-- which is unique per registration and therefore dedupes nothing. The failure
-- mode of this migration is the behaviour we have today, never a collapse of
-- two connections that might not be the same app.
--
-- WHAT IS NOT CHANGED
--
-- silo_api_access_token_hook() still resolves a token by its own client_id, so
-- a replaced connection's token finds no live grant and is stamped
-- silo_revoked on its very next refresh: fail closed, as before. Nothing here
-- widens a gate, grants a role anything, or touches the integration roles.
--
-- Idempotent. No deploy. Needs no edge-function change.

-- ---------------------------------------------------------------------------
-- 1. silo_api_app_key(client_id) -> stable identity of the application
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because schema auth is not readable by anyone else, and
-- executable by NOBODY: silo_api_consent() and silo_api_prior_company() below
-- are themselves SECURITY DEFINER owned by this migration's role, so they can
-- call it, and no client can. A person has no use for this value; only the
-- server does.
create or replace function public.silo_api_app_key(p_client_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cid   uuid;
  v_name  text;
  v_uris  text;
  v_hosts text;
  v_key   text;
begin
  if coalesce(trim(p_client_id), '') = '' then
    return null;
  end if;

  -- A client_id that is not a uuid can never match a registration, so it is
  -- its own application. No exception escapes into consent over a bad cast.
  begin
    v_cid := trim(p_client_id)::uuid;
  exception when others then
    return 'client:' || trim(p_client_id);
  end;

  select nullif(trim(c.client_name), ''), c.redirect_uris
    into v_name, v_uris
  from auth.oauth_clients c
  where c.id = v_cid
    and c.deleted_at is null;

  -- Scheme, path, query, fragment and port all come off; the host is what is
  -- stable across one application's registrations.
  select string_agg(h, ',' order by h)
    into v_hosts
  from (
    select distinct lower(split_part(
             split_part(
               split_part(
                 split_part(
                   regexp_replace(trim(u), '^[A-Za-z][A-Za-z0-9+.-]*://', ''),
                 '/', 1),
               '?', 1),
             '#', 1),
           ':', 1)) as h
    from unnest(string_to_array(coalesce(v_uris, ''), ',')) u
    where coalesce(trim(u), '') <> ''
  ) s
  where coalesce(h, '') <> '';

  v_key := lower(coalesce(v_name, '')) || '|' || coalesce(v_hosts, '');

  -- Nothing identifying at all: fall back to the registration itself rather
  -- than collapsing every nameless client into one connection.
  if v_key = '|' then
    return 'client:' || trim(p_client_id);
  end if;
  return v_key;
end;
$$;

comment on function public.silo_api_app_key(text) is
  'The stable identity of the application behind an OAuth client registration: its name plus the hosts of its redirect URIs. Dynamic client registration gives every connect a fresh client_id, so this -- not client_id -- is what one live connection per person is counted against. Falls back to client:<id>, which dedupes nothing, when the registration cannot be read. Executable only by the server. 20261102180000.';

revoke all on function public.silo_api_app_key(text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ---------------------------------------------------------------------------
-- 2. The column, and the duplicates that already exist
-- ---------------------------------------------------------------------------
alter table public.silo_api_grants
  add column if not exists app_key text;

comment on column public.silo_api_grants.app_key is
  'silo_api_app_key(client_id) as it was at consent: the application this grant is for, independent of which dynamic client registration asked. The dedupe key -- one live grant per (app_key, user_id). Frozen for the life of the row. 20261102180000.';

-- Stamp what is already there. Written before the unique index exists,
-- because the rows it is about to judge are the ones that motivated it.
update public.silo_api_grants
   set app_key = public.silo_api_app_key(client_id)
 where app_key is null;

-- Blake chose "always replace" (2026-11-02), so the duplicates that already
-- exist collapse here rather than waiting for each person to reconnect. The
-- survivor is the one that has actually been USED most recently; consent time
-- only breaks a tie among connections nobody has ever used. For Travis's four
-- Cursor rows that is the only one with a last_used_at.
--
-- Use is ranked ahead of consent rather than through
-- coalesce(last_used_at, consented_at), which compares a never-used row's
-- consent time against another row's actual use and so revokes a WORKING
-- connection in favour of an unused one consented five minutes later (review
-- of #1095, cycle 1; the test has a fixture for exactly that shape). A
-- revocation is monotonic, so getting this backwards is not recoverable.
with ranked as (
  select id,
         row_number() over (
           partition by app_key, user_id
           order by last_used_at desc nulls last, consented_at desc, id) as rn
  from public.silo_api_grants
  where revoked_at is null
)
update public.silo_api_grants g
   set revoked_at = now()
  from ranked r
 where r.id = g.id
   and r.rn > 1;

alter table public.silo_api_grants
  alter column app_key set not null;

-- The rule, in the schema. The client_id index stays: it is now strictly
-- weaker than this one and costs nothing, and dropping a uniqueness
-- constraint is not something this migration needs to do to be correct.
create unique index if not exists silo_api_grants_one_live_app
  on public.silo_api_grants (app_key, user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. app_key is frozen, like everything else consent decided
-- ---------------------------------------------------------------------------
-- Recreated whole rather than patched, so the function body is the whole rule.
create or replace function public.silo_api_grants_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_id        is distinct from old.client_id
     or new.app_key       is distinct from old.app_key
     or new.user_id       is distinct from old.user_id
     or new.company_entity_id is distinct from old.company_entity_id
     or new.scopes        is distinct from old.scopes
     or new.consented_aal is distinct from old.consented_aal
     or new.consented_at  is distinct from old.consented_at
     or new.expires_at    is distinct from old.expires_at
     or new.generation    is distinct from old.generation
     or new.created_at    is distinct from old.created_at then
    raise exception 'silo_api_grant_frozen: a granted authorization cannot be changed; approve a new one'
      using errcode = 'check_violation';
  end if;
  -- Revocation is monotonic: it cannot be undone, and it cannot be moved.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'silo_api_grant_frozen: a revocation cannot be undone or moved'
      using errcode = 'check_violation';
  end if;
  -- The session binding happens once, at first issuance.
  if old.auth_session_id is not null
     and new.auth_session_id is distinct from old.auth_session_id then
    raise exception 'silo_api_grant_frozen: a grant cannot be rebound to another session'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.silo_api_grants_frozen() is
  'Keeps silo_api_grants revoke-only and bind-once for every writer, not just for the browser: the consented fields, the application, scopes, company and expiry are frozen, a revocation cannot be undone, and a session binding cannot be moved. 20261020030000, app_key 20261102180000.';

revoke all on function public.silo_api_grants_frozen() from public, anon, authenticated;

drop trigger if exists silo_api_grants_frozen on public.silo_api_grants;
create trigger silo_api_grants_frozen
  before update on public.silo_api_grants
  for each row execute function public.silo_api_grants_frozen();

-- ---------------------------------------------------------------------------
-- 4. Consent counts against the application, not the registration
-- ---------------------------------------------------------------------------
-- Identical to 20261030110000's version except for the three places the
-- dedupe key appears. Recreated whole because that is how this function has
-- been carried forward each time, and a diff of the key alone would hide
-- which generation and which revoke it belongs to.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000: the MCP query tool (read-only SQL under
  -- the person's own RLS). Granted alongside reports:read, never instead.
  c_offered constant text[] := array['reports:read', 'data:read'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_app     text;
  v_gen     integer;
  v_id      uuid;
begin
  -- A connection can never approve anything, least of all itself.
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := auth.uid();
  if v_user is null then
    raise exception 'not_authenticated: sign in to approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: open the company you are approving access for'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_user and em.entity_id = v_company) then
    raise exception 'not_a_member: you are not a member of that company'
      using errcode = 'insufficient_privilege';
  end if;

  -- The assurance of the session doing the approving, as the session itself
  -- reports it. This is the whole reason consented_aal exists: an OAuth token
  -- reads aal1 forever, so the only evidence two-factor approval happened is
  -- what was true HERE, at this moment, recorded by the server. A grant
  -- consented below aal2 can never be used -- mfa_session_satisfied() refuses
  -- it -- so it is refused now, loudly, rather than left to fail silently on
  -- first use.
  v_aal := coalesce(nullif(public.silo_api_claims() ->> 'aal', ''), 'aal1');
  if v_aal <> 'aal2' then
    raise exception 'mfa_required: finish two-step login before approving API access'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_client_id), '') = '' then
    raise exception 'invalid_client: no application was named'
      using errcode = 'check_violation';
  end if;

  -- Scopes are an allowlist, deduplicated, and never empty.
  select coalesce(array_agg(distinct sc), '{}')
    into v_scopes
  from unnest(coalesce(p_scopes, '{}'::text[])) sc
  where sc = any(c_offered);
  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- One live connection per person per APPLICATION. Keyed on the application
  -- rather than on the client registration, because dynamic registration makes
  -- a fresh client_id on every connect and the old key never matched
  -- (20261102180000). Keyed on user_id, never on the company: somebody else in
  -- the same company connecting the same application is a different
  -- connection, and approving again -- for another company, from another
  -- machine, or for different scopes -- revokes this person's previous one.
  v_app := public.silo_api_app_key(p_client_id);

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null;

  insert into public.silo_api_grants
    (client_id, app_key, user_id, company_entity_id, auth_session_id, generation,
     scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_app, v_user, v_company, null, v_gen + 1,
     v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Creates the one live authorization for a third-party application, deriving the person, company, assurance and dates from request state rather than from arguments. Offers reports:read and data:read. Refuses a session that is not aal2, because a grant consented below aal2 can never be used. Approving again revokes this person''s previous connection to the same application -- keyed on silo_api_app_key(), never on the company -- and bumps generation. 20261020030000; data:read 20261030110000; per-application 20261102180000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Which company the consent screen should start on
-- ---------------------------------------------------------------------------
-- v2/api-consent.html defaults the company selector to the one this
-- application already had, so a reconnect is one click and a CHANGE of company
-- is something the person has to actually choose. It looked that up by
-- client_id, which on a reconnect is always new -- so the default has in
-- practice always fallen back to whichever company the person's tab happened
-- to be on. Same root cause, same key, so it is fixed here.
--
-- Returns the company of the caller's most recent grant for this application,
-- live or not: a connection that expired or that an owner disconnected is
-- exactly the case where the previous company is worth offering.
--
-- NULL when there is no history, and scoped to the CALLER'S OWN grants, so it
-- says nothing about anyone else's connections.
create or replace function public.silo_api_prior_company(p_client_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_app  text;
  v_co   uuid;
begin
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot read a connection history'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := nullif(public.silo_api_claims() ->> 'sub', '')::uuid;
  if v_user is null then
    raise exception 'not_authenticated: sign in to continue'
      using errcode = 'insufficient_privilege';
  end if;

  v_app := public.silo_api_app_key(p_client_id);
  if v_app is null then
    return null;
  end if;

  select g.company_entity_id into v_co
  from public.silo_api_grants g
  where g.app_key = v_app
    and g.user_id = v_user
  order by g.consented_at desc
  limit 1;

  return v_co;
end;
$$;

comment on function public.silo_api_prior_company(text) is
  'The company the CALLER''S most recent connection to this application read, so the consent screen can default to it on a reconnect that arrives under a brand-new client_id. Own grants only; NULL when there is no history. 20261102180000.';

revoke all on function public.silo_api_prior_company(text)
  from public, anon, silo_integration, silo_revoked;
grant execute on function public.silo_api_prior_company(text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The migration's own guards
-- ---------------------------------------------------------------------------
-- A silent no-op here leaves duplicates accumulating and nothing says so
-- until somebody counts the rows again.
do $$
declare
  v_dupes integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'silo_api_grants'
      and column_name = 'app_key' and is_nullable = 'NO') then
    raise exception 'silo_api_grants.app_key: missing or nullable';
  end if;

  if not exists (
    select 1 from pg_index x join pg_class i on i.oid = x.indexrelid
    where i.relname = 'silo_api_grants_one_live_app' and x.indisunique) then
    raise exception 'silo_api_grants_one_live_app: missing, so one person could hold two live connections to one application';
  end if;

  select count(*) into v_dupes from (
    select 1 from public.silo_api_grants
    where revoked_at is null
    group by app_key, user_id having count(*) > 1) s;
  if v_dupes > 0 then
    raise exception 'silo_api_grants: % duplicate live connections survived the collapse', v_dupes;
  end if;

  -- The key function is the server's alone.
  if has_function_privilege('authenticated', 'public.silo_api_app_key(text)', 'execute')
     or has_function_privilege('anon', 'public.silo_api_app_key(text)', 'execute')
     or has_function_privilege('silo_integration', 'public.silo_api_app_key(text)', 'execute')
     or has_function_privilege('silo_revoked', 'public.silo_api_app_key(text)', 'execute') then
    raise exception 'silo_api_app_key: a role that must not reach it can';
  end if;

  if not has_function_privilege('authenticated', 'public.silo_api_consent(text, text[])', 'execute') then
    raise exception 'silo_api_consent: authenticated cannot execute it';
  end if;
  if not has_function_privilege('authenticated', 'public.silo_api_prior_company(text)', 'execute') then
    raise exception 'silo_api_prior_company: authenticated cannot execute it';
  end if;
  if has_function_privilege('silo_integration', 'public.silo_api_prior_company(text)', 'execute')
     or has_function_privilege('anon', 'public.silo_api_prior_company(text)', 'execute') then
    raise exception 'silo_api_prior_company: a role that must not reach it can';
  end if;

  -- Consent must be counting the application, not the registration.
  if pg_get_functiondef(to_regprocedure('public.silo_api_consent(text, text[])'))
       not like '%app_key = v_app%' then
    raise exception 'silo_api_consent: no longer dedupes on the application';
  end if;
  if pg_get_functiondef(to_regprocedure('public.silo_api_grants_frozen()'))
       not like '%new.app_key%' then
    raise exception 'silo_api_grants_frozen: app_key is not frozen';
  end if;
end $$;
