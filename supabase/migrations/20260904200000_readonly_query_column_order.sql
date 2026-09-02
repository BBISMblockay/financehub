-- chat_run_readonly_query scrambled every result's COLUMN ORDER.
--
-- It aggregated with jsonb_agg, and jsonb does not preserve object key
-- order -- it stores keys sorted by (length, then bytewise). So a report
-- selecting product_title, product_type, units_sold, net_sales,
-- days_with_sales came back as net_sales, units_sold, product_type,
-- product_title, days_with_sales, and EVERY table tile in /v3/ rendered its
-- columns in that order. Measured side by side on one row:
--
--   jsonb_agg -> {"net_sales":..,"units_sold":..,"product_type":..,
--                 "product_title":..,"days_with_sales":..}
--   json_agg  -> {"product_title":..,"product_type":..,"units_sold":..,
--                 "net_sales":..,"days_with_sales":..}
--
-- json preserves the select list exactly; jsonb cannot at any cost, because
-- key order is not part of the jsonb data model. So the return type changes
-- to json, which is why this is a drop-and-create rather than a replace.
--
-- Nothing downstream cares: every caller (the silo-chat edge function, Ask
-- SILO's refresh button, the v3 dashboard renderer, the report builder)
-- consumes the result as a JSON array over the wire, where json and jsonb
-- are indistinguishable.
--
-- This is why v3's README claimed column order comes from the query while
-- the rendered board disagreed: the renderer was faithful, the transport
-- was not.
drop function if exists public.chat_run_readonly_query(text);

create function public.chat_run_readonly_query(query text)
returns json
language plpgsql
set search_path to 'public'
as $function$
declare
  result  json;
  trimmed text;
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

  -- 10s -> 30s: a representative size-curve query measured 7.4s cold,
  -- 74% of the old budget, so phase-2 grounding queries were timing out
  -- and being recorded as unknowns.
  set local statement_timeout = '30s';

  -- json_agg, NOT jsonb_agg. See the header: jsonb sorts object keys and
  -- destroys the select-list order every table visual depends on.
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) user_query limit 500) t',
    trimmed
  ) into result;

  return result;
end;
$function$;

revoke all on function public.chat_run_readonly_query(text) from public;
grant execute on function public.chat_run_readonly_query(text) to authenticated;

comment on function public.chat_run_readonly_query(text) is
  'The shared read-only reporting engine: single SELECT/WITH, no semicolon, 500-row cap, 30s statement timeout, SECURITY INVOKER so every read is scoped by the caller''s own RLS. Returns json (NOT jsonb) deliberately -- jsonb stores object keys sorted by length then bytewise, which silently reordered every result''s columns and broke column order in every v3 table visual until 20260904200000.';
