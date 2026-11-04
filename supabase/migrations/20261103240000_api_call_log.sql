-- What has this connection actually done? Today: unanswerable.
--
-- THE GAP. A SILO AI connection (MCP, or the developer API directly) reads a
-- company's data as the person who approved it. The only record of that is one
-- column: silo_api_grants.last_used_at, bumped at most once an hour by
-- silo_api_touch_grant(). Nothing records which tool ran, when, or how often.
-- So "what did that bot read" cannot be answered -- not by the person who
-- approved it, not by an owner, not by Blake, not after an incident. Writes
-- (work:write) are the next thing on the roadmap and must not ship before the
-- reading is visible, because a write nobody can audit is worse than no write.
--
-- WHERE THE HOOK GOES, AND WHY IT IS ONE PLACE. Every tool -- silo_api_query,
-- silo_api_run_report, both silo_api_list_reports, silo_api_describe_tables,
-- silo_api_windsor_connections -- begins with silo_api_require_scope(). Nothing
-- else calls it: verified against production, it appears in no policy, no view,
-- no index, only inside those six bodies, each via `perform`. So logging there
-- covers every tool that exists AND every tool added later, without copying six
-- function bodies into this migration (which would also mean re-pasting
-- 20261103230000's brand-new windsor function and drifting from it).
--
-- The tool name comes from PostgREST's own request path, not from an argument,
-- so a tool cannot under-report itself and a new tool needs no change here.
--
-- TWO HONEST LIMITS, both stated on the screen as well:
--   * It records calls that PASSED the gates. A refused call raises, and a
--     raise rolls back the transaction, so any row written before it is lost.
--     Postgres has no autonomous transaction to escape that. Recording refusals
--     means the MCP edge function logging them after the fact -- a separate
--     change, with a deploy.
--   * A GET is not recorded. PostgREST serves a GET for a STABLE function, in a
--     READ ONLY transaction, and silo_api_describe_tables and both
--     silo_api_list_reports are STABLE. A call that arrives that way is skipped
--     rather than refused: logging must not break a read.
--   * It records the REQUEST, not the answer. silo_api_query and
--     silo_api_run_report `set transaction read only` after the scope check, so
--     nothing can be written once the rows are known: no row count, no
--     duration. Same edge-function change covers it.
-- What this does record, for every authorized call: which connection, which
-- person approved it, which company, which tool, which scope, and when.
--
-- IT ALSO CLOSES AN IDLE-DISCONNECT HOLE. silo_api_touch_grant() was called
-- only by silo_api_query and silo_api_run_report (20261103230000 added it to
-- the windsor tool). A connection whose bot lives on describe_tables and
-- list_reports -- which is most of a coding agent's traffic -- recorded no
-- activity at all, so the 30-day idle policy would disconnect a connection that
-- was in use every day. Recording a call touches the grant too, under the same
-- hourly throttle, so every tool now counts as activity.

begin;

-- ── 1. The log ─────────────────────────────────────────────────────────────
create table if not exists public.silo_api_call_log (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  grant_id          uuid references public.silo_api_grants(id) on delete set null,
  client_id         text,
  user_id           uuid,
  tool              text not null,
  scope             text,
  created_at        timestamptz not null default now()
);

create index if not exists silo_api_call_log_company_time_idx
  on public.silo_api_call_log (company_entity_id, created_at desc);
create index if not exists silo_api_call_log_grant_time_idx
  on public.silo_api_call_log (grant_id, created_at desc);

alter table public.silo_api_call_log enable row level security;

-- Who may read it. The person who approved a connection can see what it did,
-- and an owner or executive can see every connection in the company -- the two
-- people who would ever have to answer for it. is_admin_user() is deliberately
-- NOT used here: it passes for nearly every profile, and this is a record of
-- who looked at the company's data.
drop policy if exists silo_api_call_log_select on public.silo_api_call_log;
create policy silo_api_call_log_select on public.silo_api_call_log
  for select using (
    company_entity_id = public.active_company_id()
    and (user_id = auth.uid() or public.is_exec_or_owner())
  );

-- Written by the definer function below and by nothing else: no insert, update
-- or delete policy exists, and no client role is granted those.
revoke all on public.silo_api_call_log from anon, authenticated;
grant select on public.silo_api_call_log to authenticated;

comment on table public.silo_api_call_log is
  'One row per AUTHORIZED call a SILO AI connection made (MCP or developer API), written by silo_api_record_call() from inside silo_api_require_scope(). Records the request -- connection, approver, company, tool, scope, time -- NOT the answer: a refused call raises and rolls back, and the query tools go read-only before the rows are known. Kept 90 days.';

-- ── 2. Recording a call ────────────────────────────────────────────────────
create or replace function public.silo_api_record_call(p_scope text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant public.silo_api_grants;
  v_tool  text;
begin
  -- A person in the browser is not a connection and is not logged here.
  if not public.silo_api_is_integration() then
    return;
  end if;
  select * into v_grant from public.silo_api_grant() limit 1;
  if v_grant.id is null or v_grant.company_entity_id is null then
    return;
  end if;

  -- A READ ONLY transaction is PostgREST's own shape for a GET, and PostgREST
  -- serves a GET for any STABLE function -- which silo_api_describe_tables and
  -- both silo_api_list_reports are. Nothing can be written there (proved:
  -- `cannot execute INSERT in a read-only transaction`), so such a call is NOT
  -- RECORDED rather than refused. Breaking a customer's read in order to log it
  -- would be the wrong way round, and this is the first write anything had ever
  -- attempted on that path.
  if current_setting('transaction_read_only', true) = 'on' then
    return;
  end if;

  -- Activity for the idle policy, under its own hourly throttle. This is the
  -- only place every tool passes through, which is the point.
  perform public.silo_api_touch_grant();

  -- PostgREST's own path names the function that was called. A caller that is
  -- not PostgREST (psql, a migration) has no path; it is still a call.
  v_tool := nullif(regexp_replace(
    coalesce(current_setting('request.path', true), ''), '^.*/', ''), '');

  -- Logging must never be the reason a company cannot read its own data. If
  -- the write fails for any reason the call proceeds, and the failure is left
  -- in the Postgres log rather than swallowed in silence.
  begin
    insert into public.silo_api_call_log
      (company_entity_id, grant_id, client_id, user_id, tool, scope)
    values (v_grant.company_entity_id, v_grant.id, v_grant.client_id,
            v_grant.user_id, coalesce(v_tool, 'unknown'), nullif(p_scope, ''));

    -- Retention, paid for in bounded work by the call that benefits from it
    -- rather than by a job that can stop running without anyone noticing.
    delete from public.silo_api_call_log
     where ctid in (select l.ctid from public.silo_api_call_log l
                     where l.company_entity_id = v_grant.company_entity_id
                       and l.created_at < now() - interval '90 days'
                     limit 50);
  exception when others then
    raise warning 'silo_api_record_call could not record % : %', coalesce(v_tool, 'unknown'), sqlerrm;
  end;
end;
$$;

revoke all on function public.silo_api_record_call(text) from public, anon, authenticated;
comment on function public.silo_api_record_call(text) is
  'Records one authorized connection call and counts it as activity for the idle policy. Called only from silo_api_require_scope(); never from a client.';

-- ── 3. The hook ────────────────────────────────────────────────────────────
-- Byte-for-byte the shipped gate (20261028070000), with two changes: it is
-- VOLATILE, because a STABLE function cannot insert, and it records the call
-- after both checks pass. Order matters: recording before them would log a
-- revoked connection's attempt -- and lose it anyway when the raise rolls the
-- transaction back.
create or replace function public.silo_api_require_scope(p_scope text)
returns void
language plpgsql
volatile
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

  -- Authorized. Record it, and count it as activity for every tool.
  perform public.silo_api_record_call(p_scope);
end;
$$;

-- Its grants are deliberately NOT restated. `create or replace` keeps the
-- existing ACL, and production grants EXECUTE to authenticated as well as to
-- silo_integration and silo_api_exec; revoking that here would be an unrelated
-- change to who can reach the gate, in a migration about logging.

select public.attach_stamp_company_entity_id_triggers();

commit;
