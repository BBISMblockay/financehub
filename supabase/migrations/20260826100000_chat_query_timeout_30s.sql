-- Ask SILO run_sql: raise the statement timeout from 10s to 30s.
--
-- Symptom: Product Concepts phase 2 kept recording its most valuable
-- fields as unknown rather than filling them. The concepts themselves
-- said why, in their own unknowns arrays:
--
--   economics                -- "po_lines/po_headers cost query timed out
--                                during phase 2 grounding attempt"
--   suggested_size_breakdown -- "shopify_order_lines size-curve query
--                                timed out during phase 2 grounding
--                                attempt"
--   Factory                  -- "the production-history lookup timed out
--                                and wasn't re-run before drafting"
--
-- So economics/forecast/provenance sat at 0 of 18 concepts. The model was
-- behaving correctly -- the tool schema tells it a missing key means
-- "unavailable" and that a guessed unit cost is not acceptable -- but the
-- queries that would have grounded those fields could not finish.
--
-- Measured before choosing the number: a representative size-curve query
-- (shopify_order_lines joined to shopify_orders over 180 days, filtered
-- by product title) runs 7.4s on a cold cache -- 34,243 blocks read
-- against 68 cached. That is already 74% of the old budget, so anything
-- marginally heavier, or the same query on a colder cache, exceeds it.
-- 30s gives roughly 4x headroom on that measurement while still bounding
-- a runaway; it is not open-ended.
--
-- This is the SECOND time phase 2 has been starved by tooling rather than
-- by thin data -- 20260825150000 fixed a whitespace bug with the same
-- signature (six fields recorded as unknown citing "repeated query
-- tooling error"). Worth remembering when a brief comes back sparse: read
-- the unknowns array before concluding the data is not there.
--
-- Nothing else changes. Same normalisation, same single-statement guard,
-- same semicolon rejection, same 500-row cap, still SECURITY INVOKER so
-- RLS scopes every read to the calling user.

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

  -- 10s -> 30s. See the header for the measurement behind this number.
  set local statement_timeout = '30s';

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) user_query limit 500) t',
    trimmed
  ) into result;

  return result;
end;
$function$;
