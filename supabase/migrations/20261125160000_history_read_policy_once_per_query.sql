-- 20261125160000: the imported-history read policy asks its questions once per
-- query, not once per row.
--
-- history_finance_read (20260913022606) on qbo_history_imports and
-- qbo_history_lines reads
--     company_entity_id = active_company_id()
--     and (can_manage_journal_entries() or is_exec_or_owner())
-- with the three calls bare, so PostgreSQL runs them for every row it visits.
-- A statement over the whole ledger visits every imported line of every
-- import: measured on production 2026-11-25 as the signed-in finance user, a
-- full read of the books took 11.9s against 1.9s without row security, which
-- is past the 8s a browser query is allowed. A balance sheet from SILO's books
-- needs exactly that read.
--
-- The same predicate with each call wrapped in a scalar sub-select is
-- evaluated once and reused (an InitPlan). All three functions are STABLE and
-- take no row input, so the answer for a row cannot differ: who may read which
-- row is unchanged. This is the form quickbooks_ledger_mirror_* already use
-- (20261125150000).
--
-- ALTER POLICY keeps the policy's command (SELECT) and role (authenticated).
-- No explicit transaction: the applier's request is one already.
do $$
declare t text;
begin
  foreach t in array array['qbo_history_imports', 'qbo_history_lines'] loop
    if exists (select 1 from pg_policy p
                where p.polrelid = to_regclass('public.' || t) and p.polname = 'history_finance_read') then
      execute format(
        'alter policy history_finance_read on public.%I using ('
        || 'company_entity_id = (select public.active_company_id()) '
        || 'and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())))', t);
    end if;
  end loop;
end $$;
