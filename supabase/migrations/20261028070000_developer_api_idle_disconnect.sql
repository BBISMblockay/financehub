-- Developer platform, PR1: the idle half of the connection lifetime.
--
-- 20261020030000 built the 90-day maximum and said, in its own comment, that
-- the 30-day idle disconnect was NOT built there: it needs the grant row to
-- carry when it was last used, which means a WRITE on a path every integration
-- request runs, and that belongs with its own review rather than bolted onto a
-- reviewed head. This is that review. Blake's policy, confirmed 2026-10-20:
-- 90 days maximum, disconnect after 30 days unused.
--
-- Why an idle rule exists at all, separately from the expiry: an OAuth access
-- token reads aal1 and Supabase re-issues it hourly, forever, with nobody
-- asked. The 90-day cap bounds a connection somebody is still using. The idle
-- rule retires one nobody is -- the abandoned integration, the partner that
-- switched vendors, the test client registered once and forgotten. Those are
-- the connections whose compromise nobody would notice.
--
-- THREE THINGS, and the order matters:
--
--   1. silo_api_idle_window()  -- the number, in one place.
--   2. silo_api_grant()        -- the usability predicate gains the idle test.
--      Everything downstream (active_company_id(), mfa_session_satisfied(),
--      silo_check_request(), silo_api_require_scope()) resolves through this
--      one function, so an idle connection resolves to NO GRANT everywhere at
--      once, and resolves to NULL company rather than to the browser's.
--   3. silo_api_touch_grant()  -- the write, called by silo_api_run_report(),
--      which is the only data surface an integration has.
--
-- The touch happens AFTER the scope check, which resolves through
-- silo_api_grant(), which now carries the idle test. So a grant that has gone
-- idle cannot touch itself back to life: by the time the write would run, the
-- request has already been refused. That ordering is the whole safety
-- argument, and the mutation tests break it deliberately.
--
-- NOT a revocation. An idle grant is UNUSABLE, not revoked: revoked_at stays
-- null and nothing is deleted. A predicate is reversible (change the window,
-- re-apply, done) where an automatic revoke written from a path that runs on
-- every token refresh is not -- if the window were ever wrong, that would kill
-- live connections permanently. The grant row stays readable so a person can
-- see what happened to their connection and re-approve it, which creates a NEW
-- row, as every approval does.
--
-- FIRST-PARTY BEHAVIOUR IS UNCHANGED. Every function below keeps its existing
-- body verbatim outside the integration branch, and all of it is still
-- unreachable in production: the OAuth server is off, no client is registered
-- and the access-token hook is not pointed at silo_api_access_token_hook(), so
-- no token can carry client_id and silo_api_is_integration() is false for
-- every request SILO serves today.
--
-- Rollback: re-apply the silo_api_grant(), silo_api_access_token_hook() and
-- silo_api_run_report() bodies from 20261020030000, then
-- `drop function public.silo_api_touch_grant(), public.silo_api_idle_window();`

-- ---------------------------------------------------------------------------
-- 1. The window
-- ---------------------------------------------------------------------------
-- A function, not a literal repeated in four places: the policy is one number
-- and changing it has to be one edit. IMMUTABLE so it can be inlined into the
-- grant lookup's WHERE clause.
create or replace function public.silo_api_idle_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

comment on function public.silo_api_idle_window() is
  'How long a third-party connection may go unused before it stops working: 30 days (Blake, 2026-10-20). The 90-day maximum lifetime is a CHECK constraint on silo_api_grants; this is the sliding half. 20261028070000.';

revoke all on function public.silo_api_idle_window() from public, anon;
grant execute on function public.silo_api_idle_window()
  to authenticated, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 2. The usability predicate
-- ---------------------------------------------------------------------------
-- 20261020030000's body, with ONE condition added. Everything else -- the
-- SETOF return (a composite-returning version yields one all-NULL row when
-- nothing matches, which makes every `not exists` refusal built on it fail
-- OPEN), the five original conditions and the live membership check -- is
-- unchanged and must stay unchanged.
--
-- coalesce(last_used_at, consented_at), because last_used_at is NULL until the
-- connection is first used: a grant approved 31 days ago and never used is
-- idle, which is the correct answer, while `last_used_at > ...` on its own
-- would have made a never-used grant unusable from the moment it was created
-- and `last_used_at is null or ...` would have made it immortal. Those are the
-- two ways to get this wrong and they are opposite ways.
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
    and coalesce(g.last_used_at, g.consented_at) > now() - public.silo_api_idle_window()
    and exists (
      select 1 from public.entity_memberships em
      where em.user_id = g.user_id and em.entity_id = g.company_entity_id)
$$;

comment on function public.silo_api_grant() is
  'The live grant for this request, or NO ROWS. Returns SETOF on purpose: a composite-returning version yields one all-NULL row when nothing matches, which makes every `not exists` refusal built on it fail open. Six conditions: client, person, Auth session, not revoked, not expired, and not idle past silo_api_idle_window() -- plus a live membership of the granted company. 20261020030000, idle condition 20261028070000.';

revoke all on function public.silo_api_grant() from public, anon;
grant execute on function public.silo_api_grant()
  to authenticated, silo_integration, silo_revoked, silo_api_exec;

-- ---------------------------------------------------------------------------
-- 3. The write
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER owned by postgres, because no caller holds UPDATE on
-- silo_api_grants -- and deliberately so: a row-level policy says which ROWS a
-- writer may touch, never which COLUMNS, so an UPDATE privilege on this table
-- would be a way to move expires_at or un-revoke a disconnected connection.
-- The silo_api_grants_frozen trigger is the backstop for that and allows
-- exactly three changes to an existing grant: revocation, the one-time session
-- binding, and last_used_at. This writes the third.
--
-- Keyed entirely by silo_api_grant(), so it can only ever touch the ONE row
-- this request already resolved to, and only while that row is still usable.
-- It cannot revive an idle or revoked grant, because an idle or revoked grant
-- is not what silo_api_grant() returns.
--
-- The hourly floor is not an optimisation detail, it is what keeps this from
-- being a contention point: without it every API request takes a row lock on
-- the same grant row, and a client making parallel requests serialises on it.
-- With it, concurrent requests inside the same hour find the predicate already
-- false and write nothing. Under READ COMMITTED the loser of a race re-reads
-- the updated row, re-checks the WHERE and no-ops rather than erroring. An
-- hour of resolution against a 30-day window is noise.
create or replace function public.silo_api_touch_grant()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.silo_api_grants g
     set last_used_at = now(),
         updated_at = now()
   where g.id = (select id from public.silo_api_grant())
     and (g.last_used_at is null or g.last_used_at < now() - interval '1 hour');
$$;

comment on function public.silo_api_touch_grant() is
  'Records that this request''s connection was used, which is what the idle window measures. Writes at most one row -- the grant silo_api_grant() already resolved to, so an unusable grant cannot touch itself back into use -- and at most once an hour per grant, so parallel API requests do not serialise on one row lock. Called by silo_api_run_report(). 20261028070000.';

-- NOT granted to silo_integration or silo_revoked. The integration role holds
-- EXECUTE on silo_api_run_report and nothing else; that is the invariant the
-- "developer API boundary" check in verify_v2_schema.sql asserts, and this
-- function is reached through the wrapper, whose owner is silo_api_exec.
revoke all on function public.silo_api_touch_grant() from public, anon, authenticated, silo_integration, silo_revoked;
grant execute on function public.silo_api_touch_grant() to silo_api_exec;

-- ---------------------------------------------------------------------------
-- 4. The token hook learns the same rule
-- ---------------------------------------------------------------------------
-- 20261020030000's body with the idle condition added to both lookups. Without
-- this, an idle connection would keep being handed a role=silo_integration
-- token that every later layer then refuses -- a token that looks valid and
-- works nowhere. Stamping silo_revoked instead is how a client is told, at the
-- refresh, that the connection is over: the dead-end role holds nothing, and
-- silo_check_request() answers integration_revoked.
--
-- The binding branch keeps `for update` and keeps binding only a grant whose
-- auth_session_id is NULL, so this can still never move a grant from one
-- session to another.
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
    and expires_at > now()
    and coalesce(last_used_at, consented_at) > now() - public.silo_api_idle_window();

  -- Otherwise the first issuance for a fresh consent, which binds it.
  if v_grant.id is null then
    select * into v_grant
    from public.silo_api_grants
    where client_id = v_client_id
      and user_id = v_user_id
      and auth_session_id is null
      and revoked_at is null
      and expires_at > now()
      and coalesce(last_used_at, consented_at) > now() - public.silo_api_idle_window()
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
  'Supabase Custom Access Token hook. Stamps role=silo_integration (plus company and scope claims, for display only) on a token carrying client_id when its grant is usable -- not revoked, not expired and not idle past silo_api_idle_window() -- role=silo_revoked when it is not, and leaves first-party tokens untouched. Also binds a fresh grant to its Auth session on first issuance. Runs on every refresh too. Inert until pointed at in Authentication settings. 20261020030000, idle condition 20261028070000.';

revoke all on function public.silo_api_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.silo_api_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 5. The surface records the use
-- ---------------------------------------------------------------------------
-- 20261020030000's body with ONE statement added, and its position is the
-- point: silo_api_require_scope() resolves through silo_api_grant(), so by the
-- time the touch runs the grant has been proved usable. Moving the touch above
-- the scope check would let an idle connection extend itself on a request that
-- is about to be refused, which is the opposite of what the window is for.
--
-- Everything else is unchanged, including the search_path reasoning: this
-- EXECUTEs report SQL other people wrote and every shipped report names its
-- tables unqualified, so `public` is on the path and `pg_temp` is named LAST
-- (an unlisted pg_temp is searched first, which would let a caller shadow a
-- report's table). Everything this function references itself stays fully
-- qualified.
create or replace function public.silo_api_run_report(
  p_report_id uuid,
  p_params jsonb default '{}'::jsonb,
  p_query_index integer default 0,
  p_offset integer default 0)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- AFTER the scope check, never before: see the comment above. This is the
  -- only path an integration has to data, so it is the only place the idle
  -- window can be measured from.
  perform public.silo_api_touch_grant();

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
  'The developer API''s only data surface: runs one query of one GLOBAL (source = ''system'') report with typed parameters and returns a page of rows plus company, timezone, paging and generated_at. Requires the reports:read scope, and records the use (silo_api_touch_grant) once the scope check has proved the grant usable. SECURITY DEFINER owned by silo_api_exec, which owns no tables -- RLS decides the rows; the ownership only spares the integration role from needing privileges of its own. 20261020030000, idle touch 20261028070000.';

-- CREATE OR REPLACE preserves the owner, but this migration must leave the
-- same state whether it runs over 20261020030000's version or over nothing, so
-- the ownership is re-asserted. ALTER FUNCTION ... OWNER TO needs the new owner
-- to hold CREATE on the schema, so it is granted for exactly this statement and
-- taken back.
grant create on schema public to silo_api_exec;
alter function public.silo_api_run_report(uuid, jsonb, integer, integer) owner to silo_api_exec;
revoke create on schema public from silo_api_exec;

revoke all on function public.silo_api_run_report(uuid, jsonb, integer, integer) from public, anon;
grant execute on function public.silo_api_run_report(uuid, jsonb, integer, integer)
  to silo_integration, authenticated;

-- ---------------------------------------------------------------------------
-- 6. A grant that silently no-ops is the failure mode this whole area has
-- ---------------------------------------------------------------------------
-- A GRANT issued by a role that is neither the object's owner nor a superuser
-- is ACCEPTED and does nothing. 20261020030000 ends with the same check for
-- the same reason.
do $$
begin
  if not has_function_privilege('silo_api_exec', 'public.silo_api_touch_grant()', 'execute') then
    raise exception 'silo_api_exec cannot execute silo_api_touch_grant(): the grant no-opped';
  end if;
  if has_function_privilege('silo_integration', 'public.silo_api_touch_grant()', 'execute')
     or has_function_privilege('silo_revoked', 'public.silo_api_touch_grant()', 'execute')
     or has_function_privilege('authenticated', 'public.silo_api_touch_grant()', 'execute') then
    raise exception 'silo_api_touch_grant() is reachable outside the API wrapper';
  end if;
  if not has_function_privilege('silo_integration', 'public.silo_api_run_report(uuid, jsonb, integer, integer)', 'execute') then
    raise exception 'silo_integration cannot execute silo_api_run_report(): the grant no-opped';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'silo_api_run_report') <> 'silo_api_exec' then
    raise exception 'silo_api_run_report() is no longer owned by silo_api_exec';
  end if;
end;
$$;
