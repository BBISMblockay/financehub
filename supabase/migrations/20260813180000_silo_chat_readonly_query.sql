-- SILO chat, phase 1: a single read-only SQL tool for the silo-chat edge
-- function's Claude tool-use loop. "Wide open, ask anything about our data"
-- means the safe way to scope it is Postgres RLS itself, not a hand-picked
-- list of allowed questions -- so this function is SECURITY INVOKER (runs
-- as the calling authenticated user, not service role) and every table/view
-- it touches keeps enforcing company_entity_id = active_company_id() exactly
-- like every other page already gets. A user can never see through this
-- function anything they couldn't already see by hand-querying from the
-- browser.
--
-- Defense in depth beyond RLS:
--   1. Only a single SELECT/WITH statement is accepted (rejects anything
--      that doesn't start with select/with, and rejects any semicolon --
--      a legitimate single SELECT never needs one).
--   2. The caller's query is wrapped as a subquery expression
--      ("select ... from (%s) t"), which is a hard Postgres syntax error
--      if it contains a second statement (";DROP TABLE ...") -- a
--      parenthesized subquery must parse as exactly one SELECT.
--   3. Row count is capped and a statement timeout is enforced, so a
--      runaway or accidentally expensive query can't hang the connection
--      or flood the LLM context.
create or replace function public.chat_run_readonly_query(query text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
  trimmed text := trim(query);
begin
  if trimmed !~* '^(select|with)\s' then
    raise exception 'Only a single SELECT or WITH (read-only) statement is allowed';
  end if;
  if trimmed ~ ';' then
    raise exception 'Statement must not contain a semicolon (single statement only)';
  end if;

  set local statement_timeout = '10s';

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) user_query limit 500) t',
    trimmed
  ) into result;

  return result;
end;
$$;

revoke all on function public.chat_run_readonly_query(text) from public, anon;
grant execute on function public.chat_run_readonly_query(text) to authenticated;
