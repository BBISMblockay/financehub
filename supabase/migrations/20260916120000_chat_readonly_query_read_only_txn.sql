-- chat_run_readonly_query: make "read-only" a DATABASE guarantee, not a
-- shape check on the statement text.
--
-- What was actually enforced before this: the statement has to parse as a
-- single SELECT/WITH with no semicolon. That is a check on the SHAPE of the
-- text, and a SELECT is not a read. A SELECT may call a VOLATILE function,
-- and that function runs with the caller's own privileges:
--
--   select public.set_active_company('<some entity the caller belongs to>');
--
-- is a single SELECT, carries no semicolon, passes every existing guard, and
-- UPDATES profiles.active_company_id -- which is the column every RLS policy
-- in SILO reads to decide which company's rows the caller may see.
-- `set_active_company` is granted to `authenticated`, so this is reachable by
-- any caller of this RPC, Ask SILO's tool loop included. It is not a
-- cross-tenant read (the function validates membership before it writes), but
-- it silently repoints the caller's whole session at another company they
-- belong to, mid-answer, which is exactly what a "read-only reporting engine"
-- must not be able to do. Any other volatile, writing, caller-executable
-- function is reachable the same way.
--
-- The fix is the boundary Postgres already has. `transaction_read_only = on`
-- is enforced by the EXECUTOR, not by inspecting text, so it holds however
-- the write is reached -- directly, through a function, through a function
-- called by a function. Attempting a write raises
-- `25006: cannot execute UPDATE in a read-only transaction`, which surfaces
-- to the model/dashboard as an ordinary query error.
--
-- HOW it is set matters, and the obvious two ways do not work. Postgres marks
-- `transaction_read_only` GUC_DISALLOW_IN_FUNC, so BOTH a function-level
-- `set transaction_read_only to 'on'` clause and a `set local` in the body are
-- rejected outright:
--
--   ERROR: parameter "transaction_read_only" cannot be set locally in functions
--
-- `SET TRANSACTION READ ONLY` issued through EXECUTE is accepted, and was
-- measured doing the job (see the probe results recorded in
-- scripts/tests/chat-readonly-query-database.test.mjs). Marking the function
-- STABLE -- the other candidate, since PostgREST runs a STABLE function in a
-- read-only transaction -- was measured and REJECTED on two counts: a
-- non-volatile function may not run `set local statement_timeout` at all
-- ("SET is not allowed in a non-volatile function"), and, more importantly,
-- SPI's non-volatile guard is PER FUNCTION, so a nested VOLATILE function
-- still wrote the row. STABLE looks like the safer declaration and is not one.
--
-- CONSEQUENCE, since this is a transaction property and not a function one:
-- the rest of the transaction stays read-only after this returns. Under
-- PostgREST that is the end of the request, and nothing in this repo calls
-- this function from SQL inside a larger transaction (checked: every caller is
-- an HTTP RPC from the browser or the silo-chat edge function). If one ever
-- does, its write fails loudly rather than quietly -- the right direction for
-- a mistake to fall.
--
-- Scope, stated plainly so nobody reads more into this than it earns:
--   * It stops WRITES. It does not stop a volatile read-only function from
--     being called, and it does not stop a function that writes outside
--     transactional visibility rules (dblink, an untrusted PL doing its own
--     connection, a sequence advanced by nextval). SILO has no such function
--     reachable from `authenticated` today; an allowlist of callable
--     functions would be the stronger boundary and is deliberately not
--     attempted here, because it would have to enumerate every function every
--     legitimate report already calls.
--   * It changes nothing for a genuine read. Every existing caller -- Ask
--     SILO's tool loop, Ask SILO's Refresh button, every /v3/ dashboard
--     widget, the report builder preview -- runs SELECTs only.
--
-- Everything else about the function is unchanged and deliberately re-stated
-- verbatim: signature (text, integer), return type json (NOT jsonb -- see
-- 20260904200000, jsonb sorts object keys and reorders every result's
-- columns), the 1000-row page cap, p_offset, the 30s statement timeout, and
-- SECURITY INVOKER so RLS remains the tenant boundary.
drop function if exists public.chat_run_readonly_query(text, integer);

create function public.chat_run_readonly_query(query text, p_offset integer default 0)
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

-- Supabase's default privileges on the `public` schema re-grant EXECUTE to
-- anon on every NEWLY CREATED function, so a drop+create silently reopens the
-- hole 20260904330000 closed. Revoke from `anon` BY NAME, not just `public`.
revoke all on function public.chat_run_readonly_query(text, integer) from public, anon;
grant execute on function public.chat_run_readonly_query(text, integer) to authenticated;

comment on function public.chat_run_readonly_query(text, integer) is
  'The shared read-only reporting engine: single SELECT/WITH, no semicolon, 1000-row cap per page (p_offset pages through more), 30s statement timeout, and transaction_read_only=on so a write reached THROUGH a volatile function is refused by the executor rather than allowed by a passing shape check. Returns json (NOT jsonb) -- see 20260904200000. SECURITY INVOKER, so RLS is still the tenant boundary.';
