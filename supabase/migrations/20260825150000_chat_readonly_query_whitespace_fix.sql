-- Ask SILO run_sql: stop rejecting valid queries over leading whitespace.
--
-- Bug: the guard in chat_run_readonly_query used `trim(query)`, and
-- Postgres `trim()` strips SPACES ONLY -- not newlines or tabs. A query
-- beginning with a newline (exactly how a model formats a multi-line CTE,
-- which the system prompt explicitly instructs it to write) therefore
-- failed the `^(select|with)` check and was rejected with:
--
--     Only a single SELECT or WITH (read-only) statement is allowed
--
-- That message describes the wrong problem. The caller reads it as "your
-- statement isn't a SELECT", rewrites the query, formats it across lines
-- again, and fails identically -- a loop that burns tool rounds and ends
-- with the model correctly refusing to guess.
--
-- Observed live 2026-08-25: a Product Concepts phase-2 pass recorded six
-- fields (size breakdown, channel split, marketing spend, weekly revenue,
-- marketing copy, unit cost) as unknown, each citing "repeated query
-- tooling error" / "query not completed this session". Verified by
-- reproduction: 'select 1 as ok' succeeds, E'\nselect 1 as ok' does not.
--
-- Also handled here, same class of false rejection:
--   - leading SQL comments (`-- what this does` before the SELECT)
--   - a single trailing semicolon, which is natural to write and harmless
--     once stripped
--
-- Security posture is unchanged, and if anything tightened: the statement
-- is normalised BEFORE the ^(select|with) test, so the test now sees the
-- real first keyword instead of being defeated by whitespace. Anything
-- that does not genuinely begin with SELECT/WITH after normalisation is
-- still rejected, internal semicolons are still rejected, the 10s
-- statement timeout and 500-row cap are untouched, and the function
-- remains non-SECURITY-DEFINER so RLS continues to scope every read to
-- the calling user.

create or replace function public.chat_run_readonly_query(query text)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  result  jsonb;
  trimmed text;
begin
  -- Normalise: strip any leading run of whitespace and/or SQL comments,
  -- then trailing whitespace. btrim with an explicit character set --
  -- the bare trim()/btrim() default is a space, which was the bug.
  trimmed := btrim(
    regexp_replace(query, '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''),
    E' \t\r\n'
  );

  -- One trailing semicolon is fine; strip it rather than rejecting the
  -- whole statement over it. Anything beyond that still trips the
  -- multi-statement guard below.
  if right(trimmed, 1) = ';' then
    trimmed := btrim(left(trimmed, length(trimmed) - 1), E' \t\r\n');
  end if;

  if trimmed !~* '^(select|with)\s' then
    -- Echo what was actually parsed. The old message named the wrong
    -- problem and gave the caller nothing to correct against.
    raise exception
      'Only a single SELECT or WITH (read-only) statement is allowed (parsed statement began: %)',
      left(coalesce(nullif(trimmed, ''), '<empty>'), 40);
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
$function$;
