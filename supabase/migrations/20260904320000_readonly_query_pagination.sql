-- chat_run_readonly_query: raise the row cap 500 -> 1000, and add pagination.
--
-- The 500-row cap was hit routinely on ungrouped exports (a month of card
-- transactions, a season of order lines) and the only recovery was "add a
-- filter and lose the rest of the data" -- there was no way to see row 501.
--
-- Two independent changes:
--   1. The hard cap per call goes from 500 to 1000. Still bounded -- this is
--      a safety limit, not an invitation to select * off a 3M-row table --
--      just wide enough that a typical guided report or CSV export finishes
--      in one page.
--   2. A new `p_offset` parameter (default 0) pages through anything larger.
--      `p_offset` is spliced into the wrapping SQL via format(), same as the
--      caller's query text already is, so it goes through %s -- but unlike
--      the caller's query it is never caller-supplied text: it is coerced to
--      integer by the function signature itself (Postgres rejects a
--      non-integer argument before the function body ever runs), then
--      clamped non-negative. There is no string path from an RPC argument to
--      this format() call, so there is nothing here to inject.
--
-- Return type is unchanged (json, an array) -- see 20260904200000 for why
-- jsonb was already ruled out. A caller omitting p_offset behaves exactly as
-- before: page 1, up to 1000 rows. Existing callers (the silo-chat edge
-- function's tool loop, Ask SILO's refresh button) need no changes to keep
-- working; only the ones that want a second page pass p_offset explicitly.
--
-- Callers cannot tell "exactly 1000 rows total" from "1000 of many more"
-- without an extra COUNT(*) -- which would double the cost of every call to
-- answer a question most callers don't ask. So, as before, `length(result) =
-- the cap` is the signal a caller uses to offer a next page; this migration
-- does not change that contract, only the number.
drop function if exists public.chat_run_readonly_query(text);

create function public.chat_run_readonly_query(query text, p_offset integer default 0)
returns json
language plpgsql
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

  -- 500 -> 1000. json_agg, not jsonb_agg -- see 20260904200000.
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) user_query limit 1000 offset %s) t',
    trimmed, safe_offset
  ) into result;

  return result;
end;
$function$;

revoke all on function public.chat_run_readonly_query(text, integer) from public;
grant execute on function public.chat_run_readonly_query(text, integer) to authenticated;

comment on function public.chat_run_readonly_query(text, integer) is
  'The shared read-only reporting engine: single SELECT/WITH, no semicolon, 1000-row cap per page (p_offset pages through more), 30s statement timeout, SECURITY INVOKER so every read is scoped by the caller''s own RLS. Returns json (NOT jsonb) -- see 20260904200000. Raised from a 500-row single page in 20260904320000.';
