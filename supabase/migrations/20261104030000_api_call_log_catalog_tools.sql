-- The catalog tools were still recording nothing. Measured, not reasoned.
--
-- 20261103240000 put the logging hook in silo_api_require_scope() so that every
-- tool would record its call. It declared one exception: a GET, which PostgREST
-- serves for a STABLE function inside a READ ONLY transaction, where the insert
-- cannot run. That was half of the truth. PostgREST picks the transaction's
-- access mode from the function's VOLATILITY, not from the HTTP verb -- a
-- STABLE function is run read-only on POST as well. silo_api_describe_tables
-- and both silo_api_list_reports are STABLE, and the MCP server calls every
-- tool by POST, so those three recorded nothing at all, by any route.
--
-- Measured on production 2026-11-04 02:48Z through the live connector, minutes
-- after 20261103240000 was applied: silo_api_query wrote a log row;
-- silo_api_list_reports, called seconds later on the same connection, wrote
-- none. So "every tool records" was false for three tools of six, and the
-- 30-day idle disconnect still could not see a bot that only reads the catalog
-- -- the specific hole that change was written to close.
--
-- THE FIX. Declare those three VOLATILE. Their bodies are untouched and write
-- nothing: they are plain SELECTs over pg_catalog, chat_schema_catalog and the
-- report registry, with no dynamic SQL (the `execute` and the
-- `set transaction read only` in this family belong to silo_api_query, which is
-- already VOLATILE and stays as it is). What changes is the transaction
-- PostgREST hands them, which is the only thing the log insert needed.
--
-- And STABLE was never the thing keeping them read-only, which matters because
-- two of the three are SECURITY DEFINER: verify_v2_schema.sql already makes the
-- same point about chat_run_readonly_query -- SPI's non-volatile guard is per
-- function, so a nested VOLATILE function writes anyway. What keeps these three
-- from writing is that their bodies do not write and build no SQL.
--
-- WHAT THIS CHANGES FOR CALLERS, stated plainly: PostgREST answers 405 to a GET
-- of a VOLATILE function. Every caller in this repository uses POST --
-- supabase/functions/mcp (callRpc), v2/settings-connect-ai.html (supabase-js
-- .rpc(), which is POST unless { get: true }), and the Power BI recipe -- so
-- nothing known breaks. A client that chose GET for these two RPCs would begin
-- getting 405 and would have to switch to POST.
--
-- The read-only guard inside silo_api_record_call() STAYS. It is still correct
-- for silo_api_query and silo_api_run_report, which set the transaction read
-- only themselves, and for any call made inside someone else's read-only
-- transaction. Logging must never break a read.
begin;

-- Fail loudly if the shape this migration assumes is not there: the three
-- functions must exist, and the hook must still be in place.
do $$
begin
  if to_regprocedure('public.silo_api_describe_tables(text[], text, boolean)') is null
     or to_regprocedure('public.silo_api_list_reports()') is null
     or to_regprocedure('public.silo_api_list_reports(text)') is null then
    raise exception 'silo_api catalog tools are not present: nothing to re-declare';
  end if;
  if (select provolatile from pg_proc where oid = to_regprocedure('public.silo_api_require_scope(text)')) <> 'v'
     or to_regprocedure('public.silo_api_record_call(text)') is null then
    raise exception 'the call log hook (20261103240000) is not applied: apply it first';
  end if;
end $$;

alter function public.silo_api_describe_tables(text[], text, boolean) volatile;
alter function public.silo_api_list_reports() volatile;
alter function public.silo_api_list_reports(text) volatile;

-- Volatility is the whole change, so it is the thing asserted.
do $$
declare
  v_stable int;
begin
  select count(*) into v_stable
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('silo_api_describe_tables', 'silo_api_list_reports')
    and p.provolatile <> 'v';
  if v_stable > 0 then
    raise exception 'a catalog tool is still not VOLATILE: PostgREST would keep running it read-only';
  end if;
end $$;

comment on function public.silo_api_describe_tables(text[], text, boolean) is
  'The table and column catalog a connected AI reads. VOLATILE on purpose: PostgREST runs a STABLE function in a read-only transaction even on POST, and silo_api_require_scope() has to be able to record the call and touch the grant. Reads only; a GET of it is answered 405 by PostgREST.';
comment on function public.silo_api_list_reports() is
  'SILO''s own reports, for a connected AI. VOLATILE on purpose: see silo_api_describe_tables.';
comment on function public.silo_api_list_reports(text) is
  'SILO''s own reports matching a search, for a connected AI. VOLATILE on purpose: see silo_api_describe_tables.';

commit;
