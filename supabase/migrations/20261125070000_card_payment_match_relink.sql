-- Undoing a match restores what the person had, not what the match wrote
-- (2026-11-25).
--
-- Two ways the undo could put back the wrong thing, both found in review of
-- 20261125060000 and both about the same fact: the record remembers how the
-- paying row was coded BEFORE the match coded it, and that memory has to be
-- the person's state, not this feature's own.
--
--   1. Linking a pair that is already linked used to code and snapshot again.
--      A lost response and a second press would therefore record the match's
--      own coding as "what the person had", and the undo would restore that --
--      leaving the row coded by a match that no longer exists. An identical
--      link is now ANSWERED and nothing is written; re-pointing a match at a
--      different payment is refused until the first one is undone, because
--      undoing it is the only thing that puts its paying row back.
--   2. The undo recognised its own work by account and treatment alone, so a
--      person who saved the row again with the same account and treatment --
--      resolving a conflict, fixing a memo -- had their save overwritten. The
--      match now stamps the paying row's updated_at into payer_coded_at, and
--      restores only while that stamp still holds. The conflict flag the match
--      clears is restored too.
--
-- Only these two functions change; everything else from 20261125060000 stands.

-- Linking is one transaction: the settled row is excluded, the paying row is
-- coded where it can be, and the pairing is recorded, or none of it happens.
-- The UPDATEs run under the caller's own RLS, so a row in an approved or
-- posted import is refused exactly as it is in Transactions -- and an
-- RLS-refused UPDATE changes zero rows rather than raising, which is why the
-- row count is read back by name. For the settled row that is an error; for
-- the paying row it is the ordinary case of a payment already in the books,
-- and the match simply records the pairing without touching it.
create or replace function public.link_card_payment_match(p_card_transaction_id uuid, p_bank_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $lcm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_card_src public.card_sources%rowtype; v_bank_src public.card_sources%rowtype;
  v_match public.card_payment_matches%rowtype;
  v_reason text; v_rows integer; v_treatment text; v_prior jsonb; v_coded boolean := false;
  v_now timestamptz := now();
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
  select * into v_bank from public.card_transactions where id = p_bank_transaction_id;
  if not found then raise exception 'That bank transaction is not available'; end if;
  if v_bank.status = 'excluded' then
    raise exception 'That payment has since been excluded from its own entry — search again and pick the payment that posts';
  end if;
  if exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = v_bank.id
             and m.card_transaction_id <> v_card.id) then
    raise exception 'That payment is already matched to another transaction';
  end if;
  /* A link that already exists is ANSWERED, not done again. A lost response
     and a second press would otherwise snapshot the paying row as this match
     left it, and the undo would then restore the match's own coding instead
     of what the person had. Re-pointing a match at a different payment is
     refused outright: undoing the first one is what puts the paying row back,
     and nothing here can do that for a row it is about to overwrite. */
  select * into v_match from public.card_payment_matches where card_transaction_id = v_card.id;
  if v_match.card_transaction_id is not null then
    if v_match.bank_transaction_id <> v_bank.id then
      raise exception 'This transaction is already matched to another payment — undo that match first';
    end if;
    return jsonb_build_object('status', v_card.status, 'exclude_reason', v_card.exclude_reason,
      'bank_transaction_id', v_match.bank_transaction_id, 'bank_coded', v_match.payer_coded_at is not null,
      'already_matched', true);
  end if;
  select s.* into v_card_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_card.batch_id;
  select s.* into v_bank_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_bank.batch_id;
  v_reason := 'Paid by ' || coalesce(nullif(v_bank_src.display_name, ''), 'the bank account')
    || ' on ' || to_char(v_bank.txn_date, 'YYYY-MM-DD') || ' — matched to the bank feed, which posts this payment';

  update public.card_transactions t
     set status = 'excluded', exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()
   where t.id = v_card.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This transaction cannot be changed — its import is approved or posted, or you do not have finance access';
  end if;

  -- The paying row posts this payment, and the account it must hit is the
  -- liability account of the source being paid. A split row is left alone:
  -- its lines are somebody's deliberate work, and nothing here can know what
  -- the rest of them are for.
  v_treatment := public.card_payment_posting_treatment(v_card_src.credit_qbo_account_type);
  if v_treatment is not null and v_card_src.credit_qbo_account_id is not null
     and not exists (select 1 from public.card_transaction_splits sp where sp.transaction_id = v_bank.id) then
    v_prior := jsonb_build_object('status', v_bank.status, 'qbo_account_id', v_bank.qbo_account_id,
      'qbo_account_name', v_bank.qbo_account_name, 'accounting_treatment', v_bank.accounting_treatment,
      'coding_source', v_bank.coding_source, 'coding_conflict', v_bank.coding_conflict);
    update public.card_transactions t
       set status = 'coded', qbo_account_id = v_card_src.credit_qbo_account_id,
           qbo_account_name = v_card_src.credit_qbo_account_name,
           accounting_treatment = v_treatment, coding_source = 'manual', coding_conflict = null,
           updated_at = v_now, updated_by = auth.uid()
     where t.id = v_bank.id;
    get diagnostics v_rows = row_count;
    v_coded := v_rows > 0;
  end if;

  /* payer_coded_at is the paying row's updated_at as this wrote it, so the
     undo can tell its own work from an edit made since. */
  insert into public.card_payment_matches (company_entity_id, card_transaction_id, bank_transaction_id, note,
      payer_coded_at, payer_prior)
  values (v_card.company_entity_id, v_card.id, v_bank.id, v_reason,
      case when v_coded then v_now end, case when v_coded then v_prior end);

  return jsonb_build_object('status', 'excluded', 'exclude_reason', v_reason,
    'bank_transaction_id', v_bank.id, 'bank_source_name', v_bank_src.display_name,
    'bank_txn_date', v_bank.txn_date, 'bank_coded', v_coded,
    'bank_qbo_account_name', case when v_coded then v_card_src.credit_qbo_account_name end,
    'bank_accounting_treatment', case when v_coded then v_treatment end);
end $lcm$;

-- Undoing it puts both rows back where they were. The paying row is restored
-- only while it still carries exactly what the match wrote: once somebody has
-- changed it themselves, their coding is the newer decision and stands.
create or replace function public.unlink_card_payment_match(p_card_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $ucm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_card_src public.card_sources%rowtype; v_match public.card_payment_matches%rowtype;
  v_status text; v_reason text; v_rows integer; v_treatment text; v_restored boolean := false;
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
  select * into v_match from public.card_payment_matches where card_transaction_id = v_card.id;

  if v_card.origin = 'plaid' and (v_card.provider_status is distinct from 'posted' or v_card.currency is distinct from 'USD') then
    v_status := 'excluded'; v_reason := 'Pending or non-USD bank transaction';
  elsif v_card.qbo_account_id is not null
     or exists (select 1 from public.card_transaction_splits sp where sp.transaction_id = v_card.id) then
    v_status := 'coded'; v_reason := null;
  else
    v_status := 'uncoded'; v_reason := null;
  end if;

  update public.card_transactions t
     set status = v_status, exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()
   where t.id = v_card.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This transaction cannot be changed — its import is approved or posted, or you do not have finance access';
  end if;

  if v_match.payer_coded_at is not null and v_match.payer_prior is not null then
    select * into v_bank from public.card_transactions where id = v_match.bank_transaction_id;
    select s.* into v_card_src from public.card_sources s
      join public.card_import_batches b on b.source_id = s.id where b.id = v_card.batch_id;
    v_treatment := public.card_payment_posting_treatment(v_card_src.credit_qbo_account_type);
    /* Untouched since the match wrote it: the stamp catches an edit that put
       back the same account and treatment, which the values alone cannot.
       The test is the UPDATE's own predicate, not a decision taken on a row
       read a moment ago: another person saving this row between the read and
       the write would otherwise have their save overwritten, since the UPDATE
       waits for their lock and then proceeds regardless. In the predicate,
       PostgreSQL re-checks it against the row as they left it, so their
       coding stands and nothing is restored. */
    if v_bank.id is not null then
      update public.card_transactions t
         set status = v_match.payer_prior->>'status',
             qbo_account_id = v_match.payer_prior->>'qbo_account_id',
             qbo_account_name = v_match.payer_prior->>'qbo_account_name',
             accounting_treatment = coalesce(v_match.payer_prior->>'accounting_treatment', 'unknown'),
             coding_source = v_match.payer_prior->>'coding_source',
             coding_conflict = v_match.payer_prior->>'coding_conflict',
             updated_at = now(), updated_by = auth.uid()
       where t.id = v_bank.id
         and t.status = 'coded'
         and t.updated_at is not distinct from v_match.payer_coded_at
         and t.qbo_account_id is not distinct from v_card_src.credit_qbo_account_id
         and t.accounting_treatment is not distinct from v_treatment;
      get diagnostics v_rows = row_count;
      v_restored := v_rows > 0;
    end if;
  end if;

  delete from public.card_payment_matches m where m.card_transaction_id = v_card.id;
  return jsonb_build_object('status', v_status, 'exclude_reason', v_reason,
    'bank_transaction_id', v_match.bank_transaction_id, 'bank_restored', v_restored);
end $ucm$;

revoke all on function public.link_card_payment_match(uuid, uuid) from public, anon;
revoke all on function public.unlink_card_payment_match(uuid) from public, anon;
grant execute on function public.link_card_payment_match(uuid, uuid) to authenticated;
grant execute on function public.unlink_card_payment_match(uuid) to authenticated;
