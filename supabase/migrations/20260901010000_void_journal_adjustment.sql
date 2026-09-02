-- Unposting an adjustment, for the same reason card batches needed it.
--
-- void_card_posting exists because the first real card post went into
-- QuickBooks before the month was complete, was deleted there, and SILO went
-- on claiming it was posted to an entry that no longer existed. The partial
-- unique index on (company, source, source_ref) WHERE status = 'posted' then
-- refuses to ever post that source_ref again.
--
-- That function is hardcoded to source = 'card_import'. Adding a second
-- posting source without a matching void would rebuild the same trap one
-- surface over -- and deleting a journal entry is, if anything, MORE ordinary
-- for a hand-written adjustment than for a card batch: an adjustment is
-- typically the thing you write while still deciding whether it is right.
--
-- SECURITY DEFINER for the same reason as its sibling: the postings table has
-- no client write policy and must not get one. This function can do exactly
-- one thing -- move a posting from 'posted' to 'voided' and hand the
-- adjustment back for review -- and re-checks the journal-entry gate itself,
-- since it is not running under the caller's RLS.
create or replace function public.void_journal_adjustment(p_adjustment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public.active_company_id();
  v_posting record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required to void a posting';
  end if;
  if v_company is null then
    raise exception 'No active company';
  end if;
  if v_reason is null then
    raise exception 'A reason is required to void a posting';
  end if;

  select p.* into v_posting
    from public.quickbooks_journal_postings p
   where p.company_entity_id = v_company
     and p.source = 'journal_adjustment'
     and p.source_ref = p_adjustment_id::text
     and p.status = 'posted'
   limit 1;

  if not found then
    raise exception 'No posted entry found for this adjustment';
  end if;

  update public.quickbooks_journal_postings
     set status = 'voided',
         error_message = left('Voided in SILO: ' || v_reason, 500)
   where id = v_posting.id;

  -- Back to approved, not draft: the lines were reviewed when they were
  -- written and nothing about them changed. Editing them is still possible --
  -- the RLS guard on journal_adjustment_lines only blocks a 'posted' parent.
  update public.journal_adjustments
     set status = 'approved', posting_id = null, updated_at = now()
   where id = p_adjustment_id and company_entity_id = v_company;

  return jsonb_build_object(
    'ok', true,
    'qbo_journal_entry_id', v_posting.qbo_journal_entry_id,
    'doc_number', v_posting.qbo_doc_number
  );
end;
$$;

revoke all on function public.void_journal_adjustment(uuid, text) from public;
grant execute on function public.void_journal_adjustment(uuid, text) to authenticated;
