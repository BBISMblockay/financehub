-- The AI-connection call log is kept, not pruned at 90 days.
--
-- 20261103240000 had silo_api_record_call() delete up to 50 of the company's
-- rows older than 90 days on every recorded call. That was written for an
-- access log. The log is now also the record of what each company used
-- (Billing's "Connected AI apps" row, and anything SILO bills for connected
-- apps later), and a usage record that deletes itself cannot be billed from.
-- Blake 2026-11-12: keep it.
--
-- Nothing has been deleted yet: the oldest production row is 2026-11-04, so
-- no row has reached 90 days. Volume is about 1,000 rows a week across every
-- company, and both indexes, (company_entity_id, created_at desc) and
-- (grant_id, created_at desc), keep a period's count cheap as it grows.
--
-- WHAT CHANGES: silo_api_record_call() is re-stated from 20261103240000 with
-- the delete removed and nothing else changed (production's body was checked
-- against that migration before this was written). The table comment no
-- longer says "Kept 90 days". The refusal and failure paths, the idle-policy
-- touch, the read-only guard and the fail-soft insert are unchanged.
--
-- Idempotent.

begin;

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
  exception when others then
    raise warning 'silo_api_record_call could not record % : %', coalesce(v_tool, 'unknown'), sqlerrm;
  end;
end;
$$;

revoke all on function public.silo_api_record_call(text) from public, anon, authenticated;
revoke all on function public.silo_api_record_call(text) from public, anon, authenticated;
comment on function public.silo_api_record_call(text) is
  'Records one authorized connection call and counts it as activity for the idle policy. Called only from silo_api_require_scope(); never from a client. Rows are kept (20261112050000): no retention delete.';

comment on table public.silo_api_call_log is
  'One row per AI-connection call (MCP or developer API). Written by silo_api_record_call() from inside silo_api_require_scope() for an authorized call (outcome ok), and by silo_api_record_failure() for a refused or failed one (outcome error, 20261112030000). Records the request -- connection, approver, company, tool, scope, time -- NOT the answer. Kept indefinitely (20261112050000): it is the usage record for connected AI apps.';

commit;
