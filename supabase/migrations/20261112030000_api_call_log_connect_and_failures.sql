-- The AI-connection call log, made to answer the two questions it could not.
--
-- Measured on production 2026-11-12, over silo_api_call_log's first 8 days
-- (1,047 rows, Baseballism only, demo workspaces excluded):
--
--  1. "list_reports" was the second-busiest tool (295 rows) and it was mostly
--     not a bot listing reports. The MCP server's connect handshake
--     (onInitialize) called silo_api_list_reports as its token probe, so every
--     time an AI app opened a new chat it logged a "listed reports". 205 of the
--     295 rows came straight after another list_reports on the same
--     connection, 116 of them within 5 seconds. Connections and real tool use
--     were one number.
--  2. Only successes were recorded. A tool that fails after the scope check
--     (a bad query, a timeout, a missing report) raises, the raise rolls back
--     the transaction, and the log row written by silo_api_require_scope()
--     goes with it. 20261103240000 named that limit and said the fix was the
--     MCP server recording failures after the fact. This is that fix.
--
-- WHAT CHANGES
--   * silo_api_connect(): the handshake's own probe. Same refusals as any tool
--     (the pre-request hook still verifies the token and the grant before it
--     runs, and it re-checks the grant itself), and it records the call, so a
--     connection is logged as "silo_api_connect" and the tool counts mean
--     tools. It needs NO scope: connecting is not reading. Every grant in
--     production holds reports:read today, so nothing that connects now is
--     refused or newly admitted by this.
--   * silo_api_record_failure(p_tool, p_error_code): the MCP server calls it
--     after a tool call came back refused or failed, in a NEW request, so the
--     row survives the failed call's rollback. It writes outcome = 'error'.
--   * Two columns: outcome ('ok' | 'error', default 'ok' -- every existing row
--     is a recorded success, which is exactly what it was) and error_code.
--
-- WHAT A CALLER CAN DO WITH THE NEW FUNCTION, since it is on the API path:
-- label calls as failed in ITS OWN connection's log, nothing more. The grant,
-- company, client and user come from the token (silo_api_grant()), never from
-- arguments; the tool name must look like one of SILO's own (silo_api_*) or is
-- stored as 'unknown'; the code is reduced to [A-Za-z0-9_.:-], 80 characters.
-- And it is bounded: at most 300 failure rows per connection per hour, so a
-- looping client cannot grow the table. It does not touch the grant: a
-- failure is not evidence the connection is in use for the idle policy.
--
-- FAIL-SOFT BOTH WAYS. The MCP server falls back to the old probe when
-- silo_api_connect does not exist or is not on the path yet, and ignores any
-- error from silo_api_record_failure, so deploying mcp before this is applied
-- changes nothing, and applying this before mcp is deployed changes nothing.
--
-- Idempotent.

begin;

-- ── 1. Outcome columns ─────────────────────────────────────────────────────
alter table public.silo_api_call_log
  add column if not exists outcome text not null default 'ok';
alter table public.silo_api_call_log
  add column if not exists error_code text;
alter table public.silo_api_call_log
  drop constraint if exists silo_api_call_log_outcome_check;
alter table public.silo_api_call_log
  add constraint silo_api_call_log_outcome_check check (outcome in ('ok', 'error'));

comment on column public.silo_api_call_log.outcome is
  'ok = the call passed the gates and its log row survived (every row before 20261112030000). error = the MCP server reported the call refused or failed, via silo_api_record_failure(), in a separate request.';
comment on column public.silo_api_call_log.error_code is
  'For outcome = error: the refusal or Postgres error code the MCP server received (e.g. insufficient_scope, 57014 for a statement timeout). Null for ok.';

-- ── 2. The connect probe ───────────────────────────────────────────────────
create or replace function public.silo_api_connect()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- A browser session is not a connection. The MCP server refuses one before
  -- it gets here (checkShape); this is the database's own answer.
  if not public.silo_api_is_integration() then
    return jsonb_build_object('ok', true);
  end if;
  -- The pre-request hook answers this first; restated so a caller that
  -- reaches the function by another route gets the same answer.
  if not exists (select 1 from public.silo_api_grant()) then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'integration_revoked',
        'message', 'This connection is no longer authorized.',
        'hint', 'Reconnect the application in SILO to continue.')::text,
      detail = json_build_object('status', 403, 'headers', json_build_object())::text;
  end if;
  -- Records the call (tool name from the request path) and counts it as
  -- activity for the idle policy, exactly like every tool.
  perform public.silo_api_record_call('');
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.silo_api_connect() is
  'The MCP server''s connect-time probe (20261112030000). Refused like any tool when the token or grant is not live; otherwise records one silo_api_connect row so connections are counted apart from tool use. Needs no scope.';

revoke all on function public.silo_api_connect() from public, anon;
grant execute on function public.silo_api_connect() to authenticated, silo_integration;

-- ── 3. Recording a failure ─────────────────────────────────────────────────
create or replace function public.silo_api_record_failure(p_tool text, p_error_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant public.silo_api_grants;
  v_tool  text;
  v_code  text;
begin
  if not public.silo_api_is_integration() then
    return;
  end if;
  select * into v_grant from public.silo_api_grant() limit 1;
  if v_grant.id is null or v_grant.company_entity_id is null then
    return;
  end if;

  v_tool := case when coalesce(p_tool, '') ~ '^silo_api_[a-z_]{1,60}$' then p_tool else 'unknown' end;
  v_code := left(regexp_replace(coalesce(p_error_code, ''), '[^A-Za-z0-9_.:-]', '', 'g'), 80);
  v_code := coalesce(nullif(v_code, ''), 'error');

  -- Bounded per connection, on the existing (grant_id, created_at) index.
  if (select count(*) from public.silo_api_call_log l
       where l.grant_id = v_grant.id
         and l.outcome = 'error'
         and l.created_at > now() - interval '1 hour') >= 300 then
    return;
  end if;

  -- Same stance as silo_api_record_call(): recording must never be the reason
  -- a call fails. The caller ignores this function's errors as well.
  begin
    insert into public.silo_api_call_log
      (company_entity_id, grant_id, client_id, user_id, tool, scope, outcome, error_code)
    values (v_grant.company_entity_id, v_grant.id, v_grant.client_id,
            v_grant.user_id, v_tool, null, 'error', v_code);
  exception when others then
    raise warning 'silo_api_record_failure could not record % : %', v_tool, sqlerrm;
  end;
end;
$$;

comment on function public.silo_api_record_failure(text, text) is
  'Called by the MCP server after a tool call was refused or failed (20261112030000), in its own request so the row survives the failed call''s rollback. Writes outcome = error for the token''s own grant only; tool must be silo_api_* or is stored as unknown; at most 300 failure rows per connection per hour. Does not count as activity.';

revoke all on function public.silo_api_record_failure(text, text) from public, anon;
grant execute on function public.silo_api_record_failure(text, text) to authenticated, silo_integration;

-- ── 4. The API path ────────────────────────────────────────────────────────
-- Re-stated from 20261110160000 with two paths added.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task',
    '/rpc/silo_api_scopes',
    '/rpc/silo_api_claim_outreach',
    '/rpc/silo_api_mark_outreach_sent',
    '/rpc/silo_api_codes_to_create',
    '/rpc/silo_api_mark_code_created',
    '/rpc/silo_api_connect',
    '/rpc/silo_api_record_failure')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), reading this connection''s own scopes (no scope needed -- it is what the server lists tools from), claiming approved affiliate outreach and marking it sent (outreach:send), reading affiliate codes waiting for Shopify and recording one as created (codes:create), and the MCP server''s connect probe and failure record (no scope; they touch only the connection''s own log). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000; codes 20261110160000; connect/failure 20261112030000.';

commit;
