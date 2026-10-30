-- Read-only query runners: refuse functions that change who the database
-- thinks the caller is, or that run SQL handed to them as text.
--
-- THE HOLE (found 2026-10-30, confirmed on production in a rolled-back test):
-- chat_run_readonly_query is SECURITY INVOKER and RLS is the tenant boundary,
-- and RLS decides with auth.uid(), which reads the request.jwt.claims setting.
-- A SELECT may call set_config, and read-only transactions allow it:
--
--   select set_config('request.jwt.claims', '{"sub":"<another user>","role":"authenticated"}', true),
--          auth.uid()                                   -- now the other user
--
-- From there active_company_id() reads the other user's profile, so any
-- signed-in user of any company could read another company's data through
-- this RPC (PostgREST exposes it to `authenticated`). Reads only: the
-- transaction is still read-only, so nothing could be changed.
--
-- THE FIX: refuse, by name, set_config and every function reachable from
-- `authenticated` that executes SQL passed to it as text (which could build
-- 'set_' || 'config' at run time). The list was read live from pg_proc on
-- 2026-10-30 (has_function_privilege('authenticated', ...) and arguments
-- named query/sql, or names matching *_to_xml*, ts_stat, ts_rewrite).
-- Checked on production the same day: no saved or built-in report, and no
-- tie-out, mentions any of them, so nothing that runs today is refused.
--
-- How the check reads the text: lower-cased, matched on word boundaries (so
-- "set_config", pg_catalog.set_config and set_config/**/( all match, while
-- a column like offset_config does not), U& escaped identifiers refused
-- outright (the one way to spell a name without its letters). A
-- string literal that merely contains a refused name is refused too; that
-- false positive is accepted.
--
-- create or replace keeps chat_run_readonly_query's grants; anything else
-- about it is unchanged and re-stated from 20260916120000.

create or replace function public.silo_sql_refused_function(p_sql text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_sql is null then null
    when lower(p_sql) ~ 'u&' then 'a U& escaped identifier'
    else substring(lower(p_sql) from
      '(\mset_config\M|\m[a-z_]*_to_xml[a-z_]*\M|\mts_stat\M|\mts_rewrite\M|\mindex_advisor\M|\mhypopg_[a-z_]+\M|\mgraphql\M|\mdblink[a-z_]*\M|\mrealtime\s*\.)')
  end
$$;

comment on function public.silo_sql_refused_function(text) is
  'Read-only query guard: returns the name of a refused function the SQL calls (set_config, which switches auth.uid() and so RLS identity; or a function that executes SQL text), or null. Used by chat_run_readonly_query and the developer API runners. See 20261030100000.';

revoke all on function public.silo_sql_refused_function(text) from public, anon;
grant execute on function public.silo_sql_refused_function(text) to authenticated, service_role;

create or replace function public.chat_run_readonly_query(query text, p_offset integer default 0)
returns json
language plpgsql
-- Must stay VOLATILE. See the STABLE note above: it is neither sufficient nor
-- compatible with the statement timeout below.
volatile
set search_path to 'public'
as $function$
declare
  result      json;
  trimmed     text;
  safe_offset integer;
  refused_fn  text;
begin
  trimmed := btrim(
    regexp_replace(query, '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''),
    E' \t\r\n'
  );

  if right(trimmed, 1) = ';' then
    trimmed := btrim(left(trimmed, length(trimmed) - 1), E' \t\r\n');
  end if;

  if trimmed !~* '^(select|with)\s' then
    raise exception
      'Only a single SELECT or WITH (read-only) statement is allowed (parsed statement began: %)',
      left(coalesce(nullif(trimmed, ''), '<empty>'), 40);
  end if;

  if trimmed ~ ';' then
    raise exception 'Statement must not contain a semicolon (single statement only)';
  end if;

  -- Identity switch (20261030100000). Read-only does not stop set_config, and
  -- set_config('request.jwt.claims', ...) changes auth.uid() for the rest of
  -- the statement, so RLS then judges the query as somebody else.
  refused_fn := public.silo_sql_refused_function(trimmed);
  if refused_fn is not null then
    raise exception 'This query calls %, which a read-only report query may not use', refused_fn
      using errcode = '42501';
  end if;

  -- Never negative: a caller-supplied negative offset would otherwise reach
  -- Postgres as "OFFSET -5", a syntax error with no useful message attached.
  safe_offset := greatest(coalesce(p_offset, 0), 0);

  set local statement_timeout = '30s';

  -- The whole point of this migration, and it has to be the LAST thing set:
  -- `set local statement_timeout` above is itself refused once the transaction
  -- is read-only in some Postgres configurations, and there is no reason to
  -- find out the hard way. EXECUTE rather than a bare statement -- see the
  -- GUC_DISALLOW_IN_FUNC note above.
  execute 'set transaction read only';

  -- 1000-row page cap. json_agg, not jsonb_agg -- see 20260904200000.
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) user_query limit 1000 offset %s) t',
    trimmed, safe_offset
  ) into result;

  return result;
end;
$function$;

comment on function public.chat_run_readonly_query(text, integer) is
  'The shared read-only reporting engine: single SELECT/WITH, no semicolon, refuses set_config and SQL-executing functions (silo_sql_refused_function, 20261030100000), 1000-row cap per page (p_offset pages through more), 30s statement timeout, and transaction_read_only=on so a write reached THROUGH a volatile function is refused by the executor. Returns json (NOT jsonb) -- see 20260904200000. SECURITY INVOKER, so RLS is still the tenant boundary.';

-- Belt and braces: create or replace keeps grants, but say them anyway.
revoke all on function public.chat_run_readonly_query(text, integer) from public, anon;
grant execute on function public.chat_run_readonly_query(text, integer) to authenticated;
