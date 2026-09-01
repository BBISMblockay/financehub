-- 'posted' means "QuickBooks holds this entry". Only the posting function may
-- say so, and it holds the service-role key, so it is unaffected by RLS.
--
-- Both tables already refused to EDIT a posted row (the USING clause), which
-- reads like the whole guard but is only half of it: WITH CHECK governs the
-- row being WRITTEN, and neither table constrained the incoming status. A
-- finance user could therefore move a draft straight to 'posted' from the
-- browser -- USING saw the old status and passed, WITH CHECK never looked --
-- and SILO would then show, and refuse to correct, an entry that was never
-- sent to Intuit. That is the precise failure the posting design exists to
-- prevent, reachable without going near the posting path.
--
-- Verified by impersonation, not by reading: as blake@baseballism.com, an
-- UPDATE to 'posted' and an INSERT as 'posted' are both refused on both
-- tables, while draft -> categorized -> approved and deleting one's own draft
-- still work.
--
-- void_journal_adjustment / void_card_posting are SECURITY DEFINER and also
-- unaffected; they are how a posted row legitimately returns to 'approved'.
drop policy if exists journal_adjustments_write on public.journal_adjustments;
create policy journal_adjustments_write on public.journal_adjustments
  for all to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_journal_entries() or public.is_exec_or_owner())
         and status <> 'posted')
  with check (company_entity_id = public.active_company_id()
              and (public.can_manage_journal_entries() or public.is_exec_or_owner())
              and status <> 'posted');

drop policy if exists card_import_batches_write on public.card_import_batches;
create policy card_import_batches_write on public.card_import_batches
  for all to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_journal_entries() or public.is_exec_or_owner())
         and status <> 'posted')
  with check (company_entity_id = public.active_company_id()
              and (public.can_manage_journal_entries() or public.is_exec_or_owner())
              and status <> 'posted');
