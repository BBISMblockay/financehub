-- Mirror every journal adjustment SILO posts to QuickBooks into the SILO ledger.
--
-- The daily ledger (20261005120000) records bank and card activity the moment it
-- is categorized, but journal adjustments -- manual entries, prepaid
-- amortization, depreciation, Shopify sales journals, transaction reclasses --
-- reached the books only through QuickBooks, and Books -> Ledger read them back
-- from the posting log. So SILO's own ledger was missing everything SILO itself
-- posted as an adjustment, and a company could not run from it without QBO.
--
-- Now an adjustment is a ledger entry the moment QuickBooks has it:
--   * posted            -> one balanced entry, the adjustment's own lines;
--   * unposted (voided) -> a reversal of that entry;
--   * posted again      -> a new entry.
-- Same engine as card transactions: append-only, fingerprinted (an unchanged
-- sync writes nothing), company lock shared then a per-adjustment lock.
--
-- Two deliberate differences from card transactions:
--   * The entry is dated on the adjustment's QuickBooks date, even inside a
--     SILO-locked period. This is a mirror of what QuickBooks holds, so it must
--     match QuickBooks; the period lock governs what SILO originates.
--   * Only POSTED adjustments are recorded (a draft or approved adjustment is
--     not in the books anywhere yet).
-- Like card transactions, nothing is recorded before the books start
-- (accounting_start_date with accepted opening balances): earlier activity is
-- inside the accepted opening balances.
--
-- A reclass (accounting_source = 'card_reclass') is recorded the same way and
-- tied to its transaction in silo_ledger_lines_v.transaction_id, so a SILO-only
-- reader sees it as that transaction's category change.
--
-- Books -> Ledger keeps counting each entry once: it already counts the posting
-- for anything in QuickBooks, and now skips the mirrored lines of a counted
-- posting by silo_ledger_lines_v.posting_id (as it skips a posted card batch's
-- lines by batch_id). Its figures do not move.

-- ── The ledger accepts a second source ──────────────────────────────────────
alter table public.ledger_entries drop constraint if exists ledger_entries_source_check;
alter table public.ledger_entries add constraint ledger_entries_source_check
  check (source in ('card_transaction', 'journal_adjustment'));

-- ── When the books start for a company ──────────────────────────────────────
-- NULL = no accepted opening balances: nothing is recorded.
create or replace function public.silo_ledger_company_start(p_company uuid)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select st.accounting_start_date
  from public.accounting_settings st
  join public.accounting_opening_balances ob on ob.company_entity_id = st.company_entity_id and ob.status = 'accepted'
  where st.company_entity_id = p_company
  limit 1;
$$;

-- ── Bring the ledger in line with one adjustment ────────────────────────────
create or replace function public.silo_ledger_sync_adjustment(p_adjustment uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.journal_adjustments%rowtype; v_company uuid; v_start date; v_lines jsonb; v_fp text;
  v_conn uuid; v_active public.ledger_entries%rowtype; v_entry uuid; v_line jsonb; v_n integer;
begin
  select company_entity_id into v_company from public.journal_adjustments where id = p_adjustment;
  if v_company is null then
    select company_entity_id into v_company from public.ledger_entries
     where source = 'journal_adjustment' and source_id = p_adjustment limit 1;
    if v_company is null then return; end if;
  end if;
  -- Same lock order as card transactions: company (shared), then the source row.
  perform pg_advisory_xact_lock_shared(hashtextextended('silo_ledger:company:' || v_company::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('silo_ledger:journal_adjustment:' || p_adjustment::text, 0));
  select * into a from public.journal_adjustments where id = p_adjustment;

  v_start := public.silo_ledger_company_start(v_company);
  v_conn := coalesce(nullif(a.approval_snapshot->>'qbo_connection_id', '')::uuid, a.qbo_connection_id);
  if a.id is not null and a.status = 'posted' and v_start is not null and a.entry_date >= v_start then
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'posting_type', l.posting_type, 'amount', round(l.amount, 2), 'qbo_account_id', l.qbo_account_id,
             'qbo_location_id', l.qbo_location_id, 'entity_type', l.entity_type, 'entity_qbo_id', l.entity_qbo_id,
             'description', left(coalesce(l.description, a.memo, ''), 4000))) order by l.line_no, l.id)
      into v_lines
      from public.journal_adjustment_lines l where l.adjustment_id = a.id and round(l.amount, 2) <> 0;
  end if;
  -- Accounting facts only; labels (descriptions) never re-record.
  v_fp := case when v_lines is null then null
               else md5(a.entry_date::text || '|' || coalesce(v_conn::text, '') || '|' ||
                 (select jsonb_agg(x.value - 'description' order by x.ordinality)
                    from jsonb_array_elements(v_lines) with ordinality x)::text) end;

  select e.* into v_active from public.ledger_entries e
   where e.company_entity_id = v_company and e.source = 'journal_adjustment' and e.source_id = p_adjustment
     and e.kind = 'original'
     and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id)
   order by e.recorded_at desc limit 1;

  if v_active.id is not null and v_fp is not distinct from v_active.fingerprint then return; end if;
  if v_active.id is null and v_lines is null then return; end if;

  -- The reversal carries the date of what it reverses: QuickBooks no longer has
  -- that entry at all, so the mirror nets to zero on the same day.
  if v_active.id is not null then
    insert into public.ledger_entries(company_entity_id, entry_date, source, source_id, kind, reverses_entry_id,
      fingerprint, qbo_connection_id, memo, recorded_by)
    values (v_company, v_active.entry_date, 'journal_adjustment', p_adjustment, 'reversal', v_active.id,
      'reversal:' || v_active.fingerprint, v_active.qbo_connection_id,
      left('Reverses ' || coalesce(v_active.memo, ''), 4000), auth.uid())
    returning id into v_entry;
    insert into public.ledger_lines(entry_id, company_entity_id, line_no, qbo_account_id, posting_type, amount,
      qbo_location_id, entity_type, entity_qbo_id, description)
    select v_entry, l.company_entity_id, l.line_no, l.qbo_account_id,
           case when l.posting_type = 'Debit' then 'Credit' else 'Debit' end, l.amount,
           l.qbo_location_id, l.entity_type, l.entity_qbo_id, l.description
      from public.ledger_lines l where l.entry_id = v_active.id;
  end if;

  if v_lines is not null then
    insert into public.ledger_entries(company_entity_id, entry_date, source, source_id, kind, fingerprint,
      qbo_connection_id, memo, recorded_by)
    values (v_company, a.entry_date, 'journal_adjustment', p_adjustment, 'original', v_fp, v_conn,
      left(coalesce(a.memo, 'Journal adjustment'), 4000), auth.uid())
    returning id into v_entry;
    v_n := 0;
    for v_line in select value from jsonb_array_elements(v_lines) loop
      v_n := v_n + 1;
      insert into public.ledger_lines(entry_id, company_entity_id, line_no, qbo_account_id, posting_type, amount,
        qbo_location_id, entity_type, entity_qbo_id, description)
      values (v_entry, v_company, v_n, v_line->>'qbo_account_id', v_line->>'posting_type', (v_line->>'amount')::numeric,
        v_line->>'qbo_location_id', v_line->>'entity_type', v_line->>'entity_qbo_id', v_line->>'description');
    end loop;
  end if;
end $$;

-- ── Trigger: record from the final state of the adjustment ──────────────────
-- Deferred, so a status change and its posting_id land together (void sets both
-- in one statement; the posting function sets both as well).
create or replace function public.silo_ledger_on_adjustment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.silo_ledger_sync_adjustment(new.id);
  return null;
end $$;
drop trigger if exists silo_ledger_adjustment on public.journal_adjustments;
create constraint trigger silo_ledger_adjustment after update of status, posting_id, entry_date on public.journal_adjustments
  deferrable initially deferred for each row execute function public.silo_ledger_on_adjustment();

-- ── Opening balances accepted later, or the start date moved ────────────────
-- Card transactions already resync here (silo_ledger_on_books_start); posted
-- adjustments must too, or a company that accepts its opening balances after
-- posting adjustments would be missing them.
create or replace function public.silo_ledger_on_books_start_adjustments()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  for v_id in select id from public.journal_adjustments
              where company_entity_id = new.company_entity_id and status = 'posted' order by entry_date, id loop
    perform public.silo_ledger_sync_adjustment(v_id);
  end loop;
  return null;
end $$;
drop trigger if exists silo_ledger_opening_accepted_adjustments on public.accounting_opening_balances;
create trigger silo_ledger_opening_accepted_adjustments after insert or update of status on public.accounting_opening_balances
  for each row when (new.status = 'accepted') execute function public.silo_ledger_on_books_start_adjustments();
drop trigger if exists silo_ledger_start_moved_adjustments on public.accounting_settings;
create trigger silo_ledger_start_moved_adjustments after insert or update of accounting_start_date on public.accounting_settings
  for each row execute function public.silo_ledger_on_books_start_adjustments();

-- ── Reading it ──────────────────────────────────────────────────────────────
-- Same columns, in the same order, plus three at the end:
--   transaction_id  the card/bank transaction a line belongs to: its own entry,
--                   or a reclass of it;
--   adjustment_id   the journal adjustment a mirrored line came from;
--   posting_id      that adjustment's QuickBooks posting (Books -> Ledger skips
--                   lines whose posting it already counts).
create or replace view public.silo_ledger_lines_v with (security_invoker = true) as
select l.id, l.company_entity_id, e.qbo_connection_id, e.id as entry_id, e.entry_date, e.kind, e.source, e.source_id,
       e.memo, l.line_no, l.qbo_account_id, l.posting_type, l.amount,
       case when l.posting_type = 'Debit' then l.amount else -l.amount end as signed_amount,
       l.qbo_location_id, l.entity_type, l.entity_qbo_id, l.description, e.recorded_at,
       case when e.source = 'journal_adjustment' then coalesce(ja.status = 'posted', false)
            else coalesce(b.status = 'posted', false) end as in_quickbooks,
       case when e.source = 'journal_adjustment' then case when ja.status = 'posted' then ja.entry_date end
            when b.status = 'posted' then b.entry_date end as quickbooks_date,
       t.batch_id,
       coalesce(t.id, rc.transaction_id) as transaction_id,
       ja.id as adjustment_id,
       ja.posting_id
  from public.ledger_lines l
  join public.ledger_entries e on e.id = l.entry_id
  left join public.card_transactions t on e.source = 'card_transaction' and t.id = e.source_id
  left join public.card_import_batches b on b.id = t.batch_id
  left join public.journal_adjustments ja on e.source = 'journal_adjustment' and ja.id = e.source_id
  left join public.card_transaction_reclasses rc on rc.adjustment_id = ja.id;
revoke all on public.silo_ledger_lines_v from public, anon, authenticated;
grant select on public.silo_ledger_lines_v to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.silo_ledger_company_start(uuid)', 'public.silo_ledger_sync_adjustment(uuid)',
    'public.silo_ledger_on_adjustment()', 'public.silo_ledger_on_books_start_adjustments()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── Backfill: every adjustment already posted ───────────────────────────────
-- Idempotent: an unchanged adjustment's fingerprint matches and writes nothing.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.journal_adjustments where status = 'posted' order by company_entity_id, entry_date, id loop
    perform public.silo_ledger_sync_adjustment(v_id);
  end loop;
end $$;

select public.refresh_chat_schema_catalog();
