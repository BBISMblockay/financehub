-- Two silences found by the first live test of work:write (2026-11-04).
--
-- SILENCE 1 -- a permission the person ticked was dropped without a word.
-- Blake approved the connection with "also let it open tasks" ticked; the grant
-- stored reports:read and data:read only, and the bot's first write was refused
-- for insufficient scope. The deployed consent page was correct (checked: both
-- files went up at 23:00:28Z, ten minutes before the approval), so the scope
-- name reaching the database was most likely null -- a browser still running
-- the previous v2/api-connections.js, where the constant did not exist. The
-- allowlist filter then dropped it, and the screen said the connection was
-- approved. Whatever the cause, a scope SILO does not recognise must now be a
-- refusal: "reload and approve again" costs one reload, while a connection
-- quietly missing a permission the person granted costs their trust in the
-- screen. The page is hardened in the same change and reads the grant back.
--
-- SILENCE 2 -- the client lists a write tool a connection may not call.
-- Claude's connector showed "Write/delete tools 1" for a read-only grant,
-- because the MCP server advertises the same tool list to everyone and SILO
-- only checks the permission when the tool is CALLED. Reading a permission off
-- the client's screen is then wrong, and the only way to find out is to try it
-- and be refused. silo_api_scopes() lets the server list what this connection
-- may actually use.
begin;

create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000 (the query tool).
  -- work:write since 20261104230000: creating a task. Asked for separately on
  -- the consent screen and never implied by a read scope.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_app     text;
  v_gen     integer;
  v_limit   integer;
  v_slot    integer;
  v_evict   uuid;
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
  -- reports it. An OAuth token reads aal1 forever, so the only evidence
  -- two-factor approval happened is what was true HERE, at this moment.
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

  -- An unrecognised scope is REFUSED, not dropped. Measured on production
  -- 2026-11-04: an approval that ticked "also let it open tasks" stored the two
  -- read scopes and nothing else, because the page was running an older cached
  -- copy of v2/api-connections.js in which the constant for the write scope did
  -- not exist yet -- so it sent a null, this filter dropped it, and the person
  -- was told the connection was approved with a permission it did not have.
  -- Storing FEWER permissions than the person ticked, silently, is the worst
  -- outcome available here: failing in front of them costs one reload.
  if exists (
    select 1
    from unnest(coalesce(p_scopes, '{}'::text[])) sc
    where sc is null or sc <> all(c_offered)) then
    raise exception 'unknown_scope: SILO does not recognise one of the permissions this page asked for. Reload the approval page and approve again.'
      using errcode = 'check_violation';
  end if;

  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- Up to silo_api_app_connection_limit() live connections per person per
  -- APPLICATION (20261102180000, slots 20261104020000).
  v_app   := public.silo_api_app_key(p_client_id);
  v_limit := public.silo_api_app_connection_limit();

  perform pg_advisory_xact_lock(
    hashtextextended(v_app || ':' || v_user::text, 0));

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  -- Rule 1: an authorization that never received a token is nobody's
  -- connection.
  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null
     and auth_session_id is null
     and last_used_at is null;

  -- Rule 1b: this person's live grant for THIS SAME client registration.
  update public.silo_api_grants
     set revoked_at = now()
   where client_id = trim(p_client_id)
     and user_id = v_user
     and revoked_at is null;

  -- Rule 2: the lowest free slot, or the least recently used connection's.
  select s.n into v_slot
  from generate_series(0, v_limit - 1) as s(n)
  where not exists (
    select 1 from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot = s.n)
  order by s.n
  limit 1;

  if v_slot is null then
    select g.id, g.slot into v_evict, v_slot
    from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot < v_limit
    order by g.last_used_at desc nulls last, g.consented_at desc, g.id
    offset greatest(v_limit - 1, 0)
    limit 1;

    if v_evict is null then
      raise exception 'no_connection_slot: disconnect one of your existing connections to this application first'
        using errcode = 'check_violation';
    end if;

    update public.silo_api_grants
       set revoked_at = now()
     where id = v_evict
       and revoked_at is null;
  end if;

  insert into public.silo_api_grants
    (client_id, app_key, slot, user_id, company_entity_id, auth_session_id,
     generation, scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_app, v_slot, v_user, v_company, null,
     v_gen + 1, v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write) and a scope outside it is REFUSED rather than dropped, up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000; strict scopes 20261104234500.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- ── The scopes of the calling connection ──────────────────────────────────
-- For the MCP server's tools/list, so a connection is shown the tools it may
-- actually call. Returns an empty array for anything that is not a live
-- integration, which is how the server fails closed: no scopes, no write tool.
create or replace function public.silo_api_scopes()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select g.scopes from public.silo_api_grant() g limit 1), '{}'::text[])
$$;

comment on function public.silo_api_scopes() is
  'The scopes of the connection making this request, or an empty array when there is no live grant. Read by the MCP server so tools/list offers only what this connection may call -- the permission itself is still enforced per tool by silo_api_require_scope(). 20261104234500.';

revoke all on function public.silo_api_scopes() from public, anon;
grant execute on function public.silo_api_scopes() to authenticated, silo_integration;

-- The path gate admits only what it names, so the new read needs a line here.
-- Re-stated from 20261104230000 with one path added.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task',
    '/rpc/silo_api_scopes')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), and reading this connection''s own scopes (no scope needed -- it is what the server lists tools from). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500.';

notify pgrst, 'reload schema';

commit;
