-- The developer API and MCP list and run a company's own saved reports, not
-- only SILO's system reports.
--
-- WHY
--
-- Blake, 2026-10-30: reports people build in the report builder or save from
-- Ask SILO are how a company asks its own questions, and an MCP client that
-- can only see SILO's 24 system reports cannot reach any of them. v1 kept to
-- system reports on purpose (20261020030000: "a company's own saved report is
-- not part of the API contract in v1"). This is the v2 decision.
--
-- WHO SEES WHAT -- unchanged, and decided by RLS, not by this function
--
-- Both functions read public.silo_chat_saved_reports_v, which is
-- security_invoker. Its table's only SELECT policy is, read live 2026-10-30:
--   (company_entity_id = active_company_id()
--      and (visibility = 'company' or created_by = auth.uid()))
--   or (company_entity_id is null and source = 'system')
-- With an integration token, active_company_id() is the GRANT's company and
-- auth.uid() is the person who granted it (20261020030000). So a connection
-- sees exactly the reports that person sees in SILO in that company: the
-- system reports, the company's shared reports and their OWN private ones --
-- never another person's private report, never another company's. These
-- functions also state that rule themselves (visibility = 'company' or
-- created_by = auth.uid()), so it does not rest on the policy alone. Blake,
-- 2026-10-30: "keep wide open, just safely".
--
-- Saved reports are NOT vetted: no tie-out checks their numbers, unlike the
-- system reports. Both catalog calls and the runner say so (verified: false)
-- so an AI app can prefer SILO's own report when both fit. The report's SQL then
-- runs as the caller under RLS, as it does in the app, so a shared report
-- returns each person only the rows they may see.
--
-- WHAT IS NEW, BECAUSE THE SQL IS NOW PEOPLE'S, NOT SILO'S
--
-- A system report's SQL is reviewed and tied out. A saved report's SQL was
-- written by Ask SILO or a person, so the runner now holds it to the same
-- rules chat_run_readonly_query holds it to in the app, without going through
-- that function (Blake: MCP has its own path):
--   1. one SELECT or WITH statement, no semicolon -- refused otherwise;
--   2. the transaction is READ ONLY before the report runs. That is what
--      makes "read-only" true by construction rather than by inspection: a
--      write anywhere (a data-modifying function, nextval, a queued
--      net.http_* request, which is an INSERT into net's queue) fails. It
--      applies to system reports too, which never write.
-- The touch (last_used_at) runs first, while the transaction can still
-- write; switching a transaction to read only after a write is allowed.
--
-- The SQL itself never leaves the database: the catalog returns titles,
-- descriptions, parameter specs and column metadata, as before.
--
-- The MCP server's list_reports gains optional search/offset to reach the
-- second catalog call, so the `mcp` function needs a deploy after this is
-- applied. Until then MCP clients see the system reports and the company
-- report count, nothing breaks.
--
-- Idempotent: create or replace; grants restated.

-- The catalog, in two calls, because a company's own reports do not fit in
-- one answer: Baseballism has 153 visible to Blake, whose parameter specs
-- alone are 489k characters (enum option lists of every product), and an AI
-- app refuses a tool result past roughly 60k. So:
--   silo_api_list_reports()            SILO's system reports in full, as
--                                      before, plus how many company reports
--                                      exist and how to list them;
--   silo_api_list_reports(search)      the company's reports matching a
--                                      required search term (2+ characters),
--                                      compact (no column metadata, short
--                                      description, parameter keys/types/
--                                      defaults and at most 10 options
--                                      each), the 10 most recently updated.
--                                      Search-only on purpose (Blake): a bot
--                                      on one task should not be handed the
--                                      whole list. It queries raw tables for
--                                      analysis; saved reports are found by
--                                      name when it wants one.
-- Same name on purpose: the integration path allowlist and every boundary
-- check are by name, so the overload adds no new door. PostgREST picks the
-- overload by the arguments sent.
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
  v_company_count integer;
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
      'silo'::text                                         as kind,
      true                                                 as verified,
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

  -- The company's shared saved reports and the caller's own (RLS adds the
  -- company).
  select count(*)::integer into v_company_count
    from public.silo_chat_saved_reports_v s
   where s.source <> 'system'
     and (s.visibility = 'company' or s.created_by = auth.uid())
     and s.archived_at is null
     and coalesce(array_length(s.queries_run, 1), 0) > 0;

  return json_build_object(
    'reports', v_rows,
    'company_reports', json_build_object(
      'count', v_company_count,
      'verified', false,
      'how_to_list', 'Reports people in this company saved and shared, plus your own private ones (report builder, Ask SILO). '
                  || 'They are not verified by SILO: prefer a SILO report when one answers the question. '
                  || 'Find one by searching its title or description (search required, 10 results at most); run it with the same report runner.'),
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now());
end;
$$;

comment on function public.silo_api_list_reports() is
  'The developer API and MCP catalog of SILO''s own reports (kind silo, source = ''system''): title, description, typed parameter spec, column metadata and query count -- never SQL -- plus a count of the company''s saved reports, which silo_api_list_reports(text) lists. Requires reports:read. 20261030050000; company count 20261030090000.';

create or replace function public.silo_api_list_reports(p_search text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_limit constant integer := 10;
  c_max_options constant integer := 10;
  v_company uuid;
  v_search  text;
  v_rows    json;
  v_total   integer;
begin
  perform public.silo_api_require_scope('reports:read');

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  -- Search-only: no term, no list.
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is null or length(v_search) < 2 then
    raise exception 'search_required: give a search term of 2 or more characters (words in the report title or description)'
      using errcode = 'check_violation';
  end if;

  -- A plain substring, never a pattern: % and _ in the search are literal.
  v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');

  -- Shared reports and the caller's own; RLS on the view adds the company.
  with visible as (
    select s.*
      from public.silo_chat_saved_reports_v s
     where s.source <> 'system'
       and (s.visibility = 'company' or s.created_by = auth.uid())
       and s.archived_at is null
       and coalesce(array_length(s.queries_run, 1), 0) > 0
       and (s.title ilike '%' || v_search || '%'
            or s.description ilike '%' || v_search || '%')
  ), page as (
    select v.*
      from visible v
     order by v.updated_at desc nulls last, v.id
     limit c_limit
  )
  select (select count(*)::integer from visible),
         coalesce(json_agg(json_build_object(
           'id', p.id,
           'title', p.title,
           'description', left(p.description, 200),
           'kind', 'company',
           'verified', false,
           'sharing', case when p.visibility = 'company' then 'shared' else 'private' end,
           'created_by', p.created_by_name,
           'parameters', (
             select coalesce(json_agg(
                      (e - 'options')
                      || case when coalesce(jsonb_typeof(e->'options'), '') <> 'array' then '{}'::jsonb
                              when jsonb_array_length(e->'options') <= c_max_options
                                then jsonb_build_object('options', e->'options')
                              else jsonb_build_object(
                                     'options', (select jsonb_agg(o) from (
                                        select o from jsonb_array_elements(e->'options') with ordinality x(o, n)
                                         where n <= c_max_options) y),
                                     'options_total', jsonb_array_length(e->'options'),
                                     'options_note', 'Only the first ' || c_max_options || ' options are listed.')
                         end
                      order by n), '[]'::json)
               from jsonb_array_elements(coalesce(p.parameters, '[]'::jsonb)) with ordinality t(e, n)),
           'query_count', coalesce(array_length(p.queries_run, 1), 0),
           'updated_at', p.updated_at)
           order by p.updated_at desc nulls last, p.id), '[]'::json)
    into v_total, v_rows
    from page p;

  return json_build_object(
    'reports', v_rows,
    'total', v_total,
    'shown', least(v_total, c_limit),
    'note', case when v_total > c_limit
                 then 'Only the ' || c_limit || ' most recently updated matches are shown. Search for something more specific.' end,
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now());
end;
$$;

comment on function public.silo_api_list_reports(text) is
  'The developer API and MCP catalog of the company''s saved reports the caller can see -- shared ones and their own private ones (kind company, verified false, sharing) -- RLS on silo_chat_saved_reports_v adding the company; found by a required search term (literal substring of title or description, 2+ characters), the 10 most recently updated, compact (short description, parameter spec with at most 10 options, no columns). Search-only: never a full list. Never SQL. Requires reports:read. SECURITY DEFINER owned by silo_api_exec. 20261030090000.';

create or replace function public.silo_api_run_report(
  p_report_id uuid,
  p_params jsonb default '{}'::jsonb,
  p_query_index integer default 0,
  p_offset integer default 0)
returns json
language plpgsql
security definer
-- public, then pg_temp LAST: see 20261020030000. Report SQL names its tables
-- unqualified; a temporary relation must not be able to shadow one.
set search_path = public, pg_temp
as $$
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

  -- AFTER the scope check, never before, and BEFORE the transaction goes
  -- read only below: this is the one write the request makes.
  perform public.silo_api_touch_grant();

  if p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset: offset must be between 0 and 1000000'
      using errcode = 'check_violation';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  -- A system report, a shared report in the grant's company, or the caller's
  -- own private one (RLS adds the company).
  select r.id, r.title, r.updated_at, r.queries_run, r.parameters, r.columns_metadata, r.source
    into v_r
  from public.silo_chat_saved_reports_v r
  where r.id = p_report_id
    and (r.source = 'system' or r.visibility = 'company' or r.created_by = auth.uid())
    and r.archived_at is null;

  if v_r.id is null then
    raise exception 'report_not_found: no report with that id that this connection can see'
      using errcode = 'no_data_found';
  end if;

  if p_query_index < 0
     or p_query_index >= coalesce(array_length(v_r.queries_run, 1), 0) then
    raise exception 'invalid_query_index: this report has % queries',
      coalesce(array_length(v_r.queries_run, 1), 0)
      using errcode = 'check_violation';
  end if;

  v_sql := v_r.queries_run[p_query_index + 1];

  -- A saved report's SQL is held to the app's rules: one SELECT or WITH,
  -- no semicolon. (A system report's is reviewed; it passes these anyway.)
  v_sql := btrim(regexp_replace(v_sql, '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''), E' \t\r\n');
  if right(v_sql, 1) = ';' then
    v_sql := btrim(left(v_sql, length(v_sql) - 1), E' \t\r\n');
  end if;
  if v_sql !~* '^(select|with)\s' then
    raise exception 'report_not_runnable: only a single SELECT or WITH statement can run'
      using errcode = 'check_violation';
  end if;
  if strpos(v_sql, ';') > 0 then
    raise exception 'report_not_runnable: a report query must be a single statement'
      using errcode = 'check_violation';
  end if;

  v_final := public.silo_api_substitute(v_sql, v_r.parameters, coalesce(p_params, '{}'::jsonb));

  -- set_config would switch auth.uid() and so the grant and RLS identity;
  -- functions that run SQL text could build that call at run time. Checked
  -- on the final text, so a substituted value is held to it too. The guard
  -- is 20261030100000's, shared with chat_run_readonly_query.
  if public.silo_sql_refused_function(v_final) is not null then
    raise exception 'report_not_runnable: this report calls %, which a read-only report may not use',
      public.silo_sql_refused_function(v_final)
      using errcode = 'check_violation';
  end if;

  -- Read only from here to the end of the request. EXECUTE, not a bare SET
  -- TRANSACTION, as in chat_run_readonly_query.
  execute 'set transaction read only';

  execute format(
    'select coalesce(json_agg(t), ''[]''::json), count(*)::integer
       from (select * from (%s) q limit %s offset %s) t',
    v_final, c_page_size, p_offset)
    into v_rows, v_count;

  return json_build_object(
    'report', json_build_object(
      'id', v_r.id,
      'title', v_r.title,
      'kind', case when v_r.source = 'system' then 'silo' else 'company' end,
      'verified', v_r.source = 'system',
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
    -- caller asks for the next page and gets an empty one.
    'has_more', v_count = c_page_size,
    'rows', v_rows);
end;
$$;

comment on function public.silo_api_run_report(uuid, jsonb, integer, integer) is
  'The developer API''s only data surface: runs one query of a SILO system report or a saved report of the grant''s company that the person can see (shared, or their own private; verified false) -- with typed parameters, in a READ ONLY transaction, and returns a page of rows plus company, timezone, paging and generated_at. Saved-report SQL must be one SELECT/WITH with no semicolon. Requires reports:read. SECURITY DEFINER owned by silo_api_exec, which owns no tables -- RLS decides the rows. 20261020030000; company reports 20261030090000.';

-- Ownership and grants exactly as they stand (read live 2026-10-30):
-- owner silo_api_exec, execute for silo_integration and authenticated.
grant create on schema public to silo_api_exec;
alter function public.silo_api_list_reports() owner to silo_api_exec;
alter function public.silo_api_list_reports(text) owner to silo_api_exec;
alter function public.silo_api_run_report(uuid, jsonb, integer, integer) owner to silo_api_exec;
revoke create on schema public from silo_api_exec;
revoke all on function public.silo_api_list_reports() from public, anon, silo_revoked;
revoke all on function public.silo_api_list_reports(text) from public, anon, silo_revoked;
revoke all on function public.silo_api_run_report(uuid, jsonb, integer, integer) from public, anon, silo_revoked;
grant execute on function public.silo_api_list_reports() to silo_integration, authenticated;
grant execute on function public.silo_api_list_reports(text) to silo_integration, authenticated;
grant execute on function public.silo_api_run_report(uuid, jsonb, integer, integer) to silo_integration, authenticated;

notify pgrst, 'reload schema';
