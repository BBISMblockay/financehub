-- 20261125140000: the continuous ledger counts each day of imported history ONCE.
--
-- WHAT WAS WRONG. `accounting_ledger_v` (20261113200000) read every row of
-- `qbo_history_lines`. Imports are immutable and append-only, so importing a
-- period again -- to pick up a later QuickBooks edit, or a wider range that
-- overlaps an earlier one -- leaves both copies in the table, and the ledger
-- added them together. A company with four overlapping imports of one period
-- saw that period at four times its size in the general ledger by month and in
-- everything a connected AI reads from this view. The QuickBooks report reader
-- is a different path and was never affected.
--
-- THE RULE. For each imported line: among the imports of the SAME company and
-- the SAME QuickBooks connection whose period covers that line's date, only
-- the newest import's lines are shown. So re-importing a period replaces it in
-- the ledger, and an older, wider import still supplies the days no newer one
-- reaches. Two connections are two QuickBooks company files
-- (uq_quickbooks_connections_company_realm), so they never replace each other.
--
-- Nothing is deleted or rewritten: qbo_history_imports / qbo_history_lines
-- stay exactly as they are, and this is a `create or replace` of the view with
-- the same columns, so its grants (20261113230000) carry over. Both tables
-- carry the same RLS policy (history_finance_read), so whoever can read a line
-- can read the imports that decide whether it is shown.
--
-- The "No imported history is hidden by the cut-over" tie-out compared the raw
-- line count with the ledger's, so it is regenerated here with the same rule
-- on its left side: it keeps guarding the cut-over, and does not turn red
-- because a re-import was correctly collapsed. The report itself is unchanged,
-- so the other three checks and the fingerprint guard stay as they are.
--
-- No BEGIN/COMMIT of its own, on purpose: the applier sends this file and its
-- schema_migrations row as ONE request, which is one transaction. A file that
-- commits itself would be applied before its version is recorded.
--
-- Idempotent. No data change. Rollback: re-run section 3 (the view) and the
-- last tie-out of 20261113200000.

create or replace view public.accounting_ledger_v
with (security_invoker = true) as
with posted as (
  -- A GENERAL LEDGER holds what was posted, and nothing else. The lines view
  -- above is deliberately all-state, because a reconciler starts from "which
  -- entries do not tie" and a draft that will not balance is exactly what they
  -- are looking for. Summing that same all-state set into monthly account
  -- totals is a different thing and it is wrong: a saved $100 draft, or an
  -- approved reclass not yet sent to QuickBooks, would move a month's totals
  -- although nothing has been booked, and a voided entry would keep counting.
  -- The month-by-month report groups status away, so the reader could not even
  -- see it. (Raised in review on PR #1278.)
  --
  -- `status = 'posted'` is SILO's own word for it, and the posting row is
  -- checked too: an entry SILO believes it posted but whose QuickBooks posting
  -- later failed or was voided is not in the books either. coalesce, because a
  -- posted entry need not have a posting row at all.
  select l.*
    from public.accounting_journal_lines_v l
   where l.status = 'posted'
     and coalesce(l.posting_status, 'posted') not in ('failed', 'voided')
), cutover as (
  select
    coalesce(
      -- max(), not a bare scalar: a second settings row for one company would
      -- make a scalar subquery RAISE, taking the whole ledger down. There is
      -- one row per company today; the ledger does not depend on that holding.
      (select max(s.silo_takeover_on) from public.accounting_settings s
        where s.company_entity_id = public.active_company_id()),
      (select max(s.accounting_start_date) from public.accounting_settings s
        where s.company_entity_id = public.active_company_id()),
      -- POSTED entries only, for the same reason and one more: this date is
      -- the floor on imported history, so a draft dated before the real
      -- cut-over would silently hide a month of QuickBooks history behind an
      -- entry nobody booked. (The 'no imported history is hidden' tie-out
      -- would go red, which is the alarm, not the fix.)
      (select min(l.entry_date) from posted l)
    ) as on_date
)
-- ── What SILO posted ──────────────────────────────────────────────────────
select
  l.company_entity_id,
  'silo'::text                           as origin,
  l.entry_date,
  (select on_date from cutover)          as cutover_on,
  l.qbo_account_id,
  l.qbo_account_name,
  null::text                             as account_type,
  l.posting_type,
  l.amount,
  l.signed_amount,
  l.qbo_location_id,
  l.qbo_location_name,
  l.entity_name                          as counterparty,
  l.qbo_doc_number                       as document_number,
  l.kind                                 as transaction_type,
  l.memo,
  l.description,
  l.journal_id::text                     as transaction_ref,
  l.journal_id,
  l.status,
  l.posting_status,
  true                                   as has_source_detail
from posted l

union all

-- ── What the company kept in QuickBooks before it moved ───────────────────
select
  h.company_entity_id,
  'qbo_history'::text,
  h.transaction_date,
  (select on_date from cutover),
  h.qbo_account_id,
  h.account_name,
  h.account_type,
  case when sgn.dr is null then null when sgn.dr >= 0 then 'Debit' else 'Credit' end,
  case when sgn.dr is null then null else round(abs(sgn.dr), 2) end,
  case when sgn.dr is null then null else round(sgn.dr, 2) end,
  null::text,
  null::text,
  nullif(h.counterparty, ''),
  nullif(h.document_number, ''),
  h.transaction_type,
  nullif(h.memo, ''),
  nullif(h.split_account_name, ''),
  h.qbo_transaction_id,
  null::uuid,
  'posted'::text,
  'posted'::text,
  -- SILO never held the records behind these; QuickBooks did. Saying so is
  -- the point of the column.
  false
from public.qbo_history_lines h
-- The import this line came in with. import_id is NOT NULL with a foreign key
-- on (import_id, company_entity_id), so the inner join drops nothing.
join public.qbo_history_imports i
  on i.id = h.import_id and i.company_entity_id = h.company_entity_id
cross join lateral (
  select case
    when h.account_type in ('Bank', 'Accounts Receivable', 'Other Current Asset',
                            'Fixed Asset', 'Other Asset', 'Expense',
                            'Other Expense', 'Cost of Goods Sold')
      then h.natural_amount
    when h.account_type in ('Accounts Payable', 'Credit Card', 'Other Current Liability',
                            'Long Term Liability', 'Other Liability', 'Equity',
                            'Income', 'Other Income')
      then -h.natural_amount
  end as dr
) sgn
where h.row_kind = 'transaction'
  and h.transaction_date is not null
  and h.transaction_date < coalesce((select on_date from cutover), 'infinity'::date)
  -- ONE IMPORT PER DAY. A day covered by more than one import of the same
  -- QuickBooks company is read from the newest of them only (created_at, then
  -- id so a tie cannot keep both). Nothing is deleted: an older import still
  -- supplies every day the newer ones do not reach.
  and not exists (
    select 1
      from public.qbo_history_imports o
     where o.company_entity_id = i.company_entity_id
       and o.qbo_connection_id = i.qbo_connection_id
       and h.transaction_date between o.period_start and o.period_end
       and (o.created_at, o.id) > (i.created_at, i.id)
  );

comment on view public.accounting_ledger_v is
  'One continuous general ledger across the move to SILO, so a reconciliation that spans the cut-over needs no stitching. origin is ''qbo_history'' for the ledger the company kept in QuickBooks before it migrated (line by line, with transaction_type, document_number, counterparty, memo and the split account) and ''silo'' for every line SILO has POSTED since -- a draft, an approved-but-unsent entry and a voided one are all absent, because a general ledger holds what was booked (the all-state register is accounting_journal_lines_v). cutover_on is on every row and is derived from the company''s silo_takeover_on, else accounting_start_date, else the earliest entry SILO posted -- imported rows are taken only before it, so the two halves add up rather than overlap. A day of history that was imported more than once is counted ONCE: among the imports of the same QuickBooks connection whose period covers the day, only the newest import''s lines are shown, so a re-import replaces a period instead of doubling it, and an older import still supplies the days no newer one reaches (20261125140000). signed_amount is +debit/-credit on BOTH sides: imported amounts are stored in the account''s natural sign and are converted here by QuickBooks'' account-type map, which is proved by a tie-out (every multi-line imported transaction balances once converted); an account type the map does not know leaves posting_type, amount and signed_amount NULL rather than guessing a side. has_source_detail is true where SILO holds the records behind the line -- join accounting_journal_sources_v on journal_id for them -- and false for imported history, where QuickBooks holds them. Opening balances and the export''s running-balance rows are excluded: a position is not activity. The imported half is visible only to a finance user: qbo_history_lines'' own RLS adds can_manage_journal_entries() / is_exec_or_owner() on top of the company scope, so for anyone else the ledger simply starts at the cut-over -- that is access, not an absence of records. security_invoker, so RLS decides what is visible. 20261113200000, 20261125140000.';

-- Ask SILO's map: say it once, and only once however often this file runs.
update public.silo_chat_schema_catalog set
  description = description || $d$ A period of QuickBooks history that was imported more than once is counted once: the newest import covering a day supplies that day, so do not divide or de-duplicate these rows yourself.$d$,
  updated_at = now()
where relname = 'accounting_ledger_v'
  and description is not null
  and description not like '%imported more than once is counted once%';

-- The tie-out that compares imported lines with what the ledger shows, with
-- the one-import-per-day rule on its left side. Guarded by the report's
-- fingerprint exactly as 20261113200000 writes it.
do $$
declare
  r     record;
  guard text;
begin
  for r in select * from public.silo_chat_saved_reports
            where id = 'c7000000-0000-4000-a000-000000000005'
              and source = 'system' and company_entity_id is null
  loop
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);
    delete from public.silo_report_tieouts
     where report_id = r.id and name = 'No imported history is hidden by the cut-over';

    insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
    (r.id, 'No imported history is hidden by the cut-over', 'reconciliation',
     format('select case when %s then (select count(*) from public.qbo_history_lines h '
       || 'join public.qbo_history_imports i on i.id = h.import_id and i.company_entity_id = h.company_entity_id '
       || 'where h.row_kind = ''transaction'' '
       || 'and h.transaction_date is not null '
       || 'and h.transaction_date >= (select public.silo_business_today()) - 365 '
       || 'and h.transaction_date <= (select public.silo_business_today()) '
       || 'and not exists (select 1 from public.qbo_history_imports o '
       || 'where o.company_entity_id = i.company_entity_id and o.qbo_connection_id = i.qbo_connection_id '
       || 'and h.transaction_date between o.period_start and o.period_end '
       || 'and (o.created_at, o.id) > (i.created_at, i.id)))::numeric end as left_value, '
       || '(select count(*) from public.accounting_ledger_v g where g.origin = ''qbo_history'' '
       || 'and g.entry_date >= (select public.silo_business_today()) - 365 '
       || 'and g.entry_date <= (select public.silo_business_today()))::numeric as right_value',
            guard),
     0,
     'Imported QuickBooks lines in the window, against the ones the ledger actually shows. A day imported more than once is counted from its newest import on BOTH sides, so a re-import does not turn this red. What it guards is the cut-over: the ledger takes imported rows only BEFORE it so the two eras cannot double-count, and if an import reaches past the cut-over date those lines would vanish from the ledger silently -- instead this goes red. The fix is the cut-over date or the import, never this check.');
  end loop;

  if exists (select 1 from public.silo_chat_saved_reports
              where id = 'c7000000-0000-4000-a000-000000000005' and source = 'system')
     and (select count(*) from public.silo_report_tieouts
           where report_id = 'c7000000-0000-4000-a000-000000000005') <> 4 then
    raise exception 'general ledger by month tie-outs: expected 4 checks';
  end if;

  if pg_get_viewdef('public.accounting_ledger_v'::regclass, true) not like '%qbo_history_imports%' then
    raise exception 'accounting_ledger_v does not read qbo_history_imports: history would be counted once per import';
  end if;
end $$;
