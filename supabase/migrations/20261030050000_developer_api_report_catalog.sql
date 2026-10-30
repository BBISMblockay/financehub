-- Let a connected application find out which reports it can run.
--
-- WHY THIS EXISTS
--
-- 20261020030000 gave the developer platform exactly one data surface,
-- silo_api_run_report(report_id, ...), and silo_api_path_allowed() narrows the
-- whole Data API to that single path. That is the right shape for running a
-- report. It is not a usable API, because nothing tells the caller WHICH
-- reports exist, what they are called, or what parameters they take -- the
-- client has to already know a UUID.
--
-- A human developer can be handed the list once. An MCP client cannot: the
-- model picks the tool and fills its arguments from a description, so the
-- catalog IS the interface. Without this, SILO's MCP server would have to
-- either hardcode 21 report ids or read the catalog with the service role,
-- and a service-role read on a path the gate does not cover is exactly the
-- shape PR1 spent nineteen functions closing.
--
-- So discovery goes where running already is: one more SELECT-only RPC behind
-- the same scope, and the path allowlist widens from one path to two.
--
-- WHAT IT DOES NOT ADD
--
-- No new data. Every field it returns is metadata the caller is already
-- entitled to act on -- it can run any of these reports today if it knows the
-- id. Nothing here is company-specific: `source = 'system'` reports are
-- SILO's own, identical for every tenant, which is why the list needs no
-- company filter. The SQL behind them is deliberately NOT returned.
--
-- Idempotent. No table, no policy, no new role.

-- ---------------------------------------------------------------------------
-- 1. silo_api_list_reports() -> json
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, like the engine it sits beside: silo_chat_saved_reports_v
-- is readable by `authenticated`, and silo_integration reaches it through the
-- definer wrapper below for the same reason silo_api_run_report exists --
-- the restricted role holds no table privileges of its own.
create or replace function public.silo_api_list_reports()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_rows    json;
begin
  perform public.silo_api_require_scope('reports:read');

  v_company := public.active_company_id();
  if v_company is null then
    -- The same belt-and-braces as the report runner: a request that arrives
    -- with no resolvable company is a request whose grant is not usable, and
    -- it should be told so rather than handed a catalog it cannot run.
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  select coalesce(json_agg(r order by r.title), '[]'::json)
    into v_rows
  from (
    select
      s.id,
      s.title,
      s.description,
      -- The parameter spec drives an MCP tool's input schema, so it is
      -- returned whole: key, type, label, default and an enum's options.
      coalesce(s.parameters, '[]'::jsonb)                  as parameters,
      coalesce(array_length(s.queries_run, 1), 0)          as query_count,
      s.columns_metadata                                   as columns,
      s.updated_at
    from public.silo_chat_saved_reports_v s
    where s.source = 'system'
      and s.archived_at is null
  ) r;

  return json_build_object(
    'reports', v_rows,
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now());
end;
$$;

comment on function public.silo_api_list_reports() is
  'The developer API''s catalog: every GLOBAL (source = ''system'') report a connection may run, with its title, description, typed parameter spec, column metadata and query count -- never its SQL. Requires the reports:read scope, the same one silo_api_run_report requires, and returns no company-specific data. 20261030050000.';

-- Same ownership as the runner, and for the same reason: silo_api_exec owns no
-- tables, so SECURITY DEFINER buys the restricted role a read of the catalog
-- view and nothing else.
grant create on schema public to silo_api_exec;
alter function public.silo_api_list_reports() owner to silo_api_exec;
revoke create on schema public from silo_api_exec;

revoke all on function public.silo_api_list_reports() from public, anon, silo_revoked;
grant execute on function public.silo_api_list_reports() to silo_integration, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The path allowlist widens from one path to two
-- ---------------------------------------------------------------------------
-- This is the tenant boundary for every Data API request an integration makes,
-- so the list stays explicit and closed. Both entries are SELECT-only RPCs
-- behind the same scope check.
create or replace function public.silo_api_path_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report',
    '/rpc/silo_api_list_reports')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the two paths the developer platform exposes: running a global report, and listing them. Every other path is refused by silo_check_request() before the request reaches a table. 20261030050000 (was one path, 20261020030000).';

-- ---------------------------------------------------------------------------
-- 3. Assert what cannot be assumed
-- ---------------------------------------------------------------------------
-- On Supabase a GRANT by a role that is neither owner nor superuser is
-- accepted and does nothing, so every privilege this migration believes it
-- changed is read back.
do $$
declare
  v_oid  oid := 'public.silo_api_list_reports()'::regprocedure;
  v_path text;
begin
  if not has_function_privilege('silo_integration', v_oid, 'execute') then
    raise exception 'silo_integration cannot execute silo_api_list_reports: the catalog is unreachable';
  end if;
  if not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'authenticated cannot execute silo_api_list_reports';
  end if;
  if has_function_privilege('anon', v_oid, 'execute')
     or has_function_privilege('silo_revoked', v_oid, 'execute') then
    raise exception 'the catalog is readable by a role that must not reach it';
  end if;
  if not (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'silo_api_list_reports is not SECURITY DEFINER; silo_integration holds no table privileges';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid = v_oid) <> 'silo_api_exec' then
    raise exception 'silo_api_list_reports must be owned by silo_api_exec, which owns no tables';
  end if;
  -- The allowlist reads request.path, so it is asserted by setting it. The
  -- setting is local to this transaction and is cleared again below, so a
  -- migration run inside a session leaves nothing behind.
  perform set_config('request.path', '/rpc/silo_api_list_reports', true);
  if not public.silo_api_path_allowed() then
    raise exception 'the catalog path is not on the allowlist, so every call would be refused';
  end if;
  perform set_config('request.path', '/rpc/silo_api_run_report', true);
  if not public.silo_api_path_allowed() then
    raise exception 'widening the allowlist dropped the report runner''s own path';
  end if;
  foreach v_path in array array['/rpc/chat_run_readonly_query', '/silo_api_grants', '/profiles', ''] loop
    perform set_config('request.path', v_path, true);
    if public.silo_api_path_allowed() then
      raise exception 'the path allowlist admits %, which is not a developer platform path', v_path;
    end if;
  end loop;
  perform set_config('request.path', '', true);
end;
$$;
