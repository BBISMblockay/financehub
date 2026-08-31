-- Marking a posted batch unposted, because an entry was deleted in QuickBooks.
--
-- This is not a corner case. The first real post of this tool went in before
-- the month was complete, was deleted in QuickBooks, and SILO went on claiming
-- the batch was posted to a journal entry that no longer existed. Two things
-- follow from that, and both are worse than they look:
--
--   * the partial unique index on (company, source, source_ref) WHERE
--     status = 'posted' would refuse to ever post that batch again, so the
--     period could not be closed properly once it was complete
--   * card_transactions RLS blocks edits on a posted batch, so the coding was
--     frozen against an entry that was not in the books
--
-- Reversing it needed raw SQL, which means it needed me. That is the actual
-- defect: deleting an entry in QuickBooks is an ordinary thing for an
-- accountant to do, and SILO offered no way to say so.
--
-- SECURITY DEFINER, deliberately: quickbooks_journal_postings has no client
-- write policy at all, and it should not get one -- a general UPDATE grant on
-- the table would let a browser rewrite what SILO believes it sent to Intuit.
-- This function can do exactly one thing instead: move a posting from 'posted'
-- to 'voided' and hand the batch back for review. It re-checks the
-- journal-entry gate itself, since it is not running under the caller's RLS.
create or replace function public.void_card_posting(p_batch_id uuid, p_reason text)
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
  -- A void with no stated reason is a hole in the audit trail exactly where
  -- one is least affordable.
  if v_reason is null then
    raise exception 'A reason is required to void a posting';
  end if;

  select p.* into v_posting
    from public.quickbooks_journal_postings p
   where p.company_entity_id = v_company
     and p.source = 'card_import'
     and p.source_ref = p_batch_id::text
     and p.status = 'posted'
   limit 1;

  if not found then
    raise exception 'No posted entry found for this batch';
  end if;

  update public.quickbooks_journal_postings
     set status = 'voided',
         error_message = left('Voided in SILO: ' || v_reason, 500)
   where id = v_posting.id;

  -- Back to approved rather than draft: the coding was reviewed and signed off
  -- once already, and nothing about it changed.
  update public.card_import_batches
     set status = 'approved', posting_id = null, updated_at = now()
   where id = p_batch_id and company_entity_id = v_company;

  return jsonb_build_object(
    'ok', true,
    'qbo_journal_entry_id', v_posting.qbo_journal_entry_id,
    'doc_number', v_posting.qbo_doc_number
  );
end;
$$;

revoke all on function public.void_card_posting(uuid, text) from public;
grant execute on function public.void_card_posting(uuid, text) to authenticated;
