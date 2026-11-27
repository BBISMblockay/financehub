-- The sent-entries check answers in time (20261127200000).
--
-- quickbooks_sent_entries_check_v (20261125235000) named each differing
-- account with a subquery on accounting_accounts per account per entry. On
-- production that ran the chart's row policy about half a million times: 16 s
-- for 27 entries, against the 8 s statement limit of a signed-in user. The
-- sync page reads the view as optional, so the read failed quietly and no
-- month said "agree" or "Differs by".
--
-- Same columns, same rows, same rules. The chart is read once and joined, and
-- each step is computed once (MATERIALIZED) instead of once per entry.
-- No top-level BEGIN/COMMIT: the applier wraps the file.

create or replace view public.quickbooks_sent_entries_check_v
with (security_invoker = true) as
with covered as (
  select p.id, p.company_entity_id, p.qbo_connection_id, p.period_start, p.read_through
    from public.quickbooks_ledger_mirror_periods p
   where p.read_at is not null
), chart as materialized (
  -- The company's chart, read ONCE. As a per-account subquery it re-ran the
  -- chart's row policy for every account of every entry (16 s on production
  -- against an 8 s limit, so the page showed no verdict at all).
  select a.company_entity_id, a.qbo_connection_id, a.qbo_account_id, max(a.name) as name
    from public.accounting_accounts a
   where a.qbo_account_id is not null
   group by 1, 2, 3
), entry as materialized (
  select p.id as posting_id, p.company_entity_id, p.connection_id, p.qbo_journal_entry_id as txn,
         p.qbo_doc_number, p.source, p.source_ref, p.memo, p.payload,
         (p.payload ->> 'TxnDate')::date as entry_date,
         exists (select 1 from covered c
                  where c.company_entity_id = p.company_entity_id and c.qbo_connection_id = p.connection_id
                    and (p.payload ->> 'TxnDate')::date between c.period_start and c.read_through) as was_read
    from public.quickbooks_journal_postings p
   where p.status = 'posted' and p.qbo_journal_entry_id is not null and p.payload ? 'TxnDate'
), sent as materialized (
  select e.posting_id, l.value #>> '{JournalEntryLineDetail,AccountRef,value}' as acct,
         sum(case when l.value #>> '{JournalEntryLineDetail,PostingType}' = 'Debit' then 1 else -1 end
             * (l.value ->> 'Amount')::numeric) as amt,
         max(l.value #>> '{JournalEntryLineDetail,AccountRef,name}') as name
    from entry e
    cross join lateral jsonb_array_elements(coalesce(e.payload -> 'Line', '[]'::jsonb)) l
   where e.was_read
   group by 1, 2
), held as materialized (
  select e.posting_id, m.qbo_account_id as acct, sum(m.signed_amount) as amt,
         min(m.transaction_date) as first_day, max(m.transaction_date) as last_day,
         max(m.account_name) as name
    from entry e
    join covered c on c.company_entity_id = e.company_entity_id and c.qbo_connection_id = e.connection_id
    join public.quickbooks_ledger_mirror_lines m
      on m.period_id = c.id and m.company_entity_id = e.company_entity_id
     and m.qbo_transaction_id = e.txn and m.transaction_type = 'Journal Entry'
   where e.was_read
   group by 1, 2
), pair as materialized (
  select coalesce(s.posting_id, h.posting_id) as posting_id,
         abs(round(coalesce(s.amt, 0), 2) - round(coalesce(h.amt, 0), 2)) as off,
         coalesce(s.acct, h.acct) as acct,
         -- The company's own chart names the account; QuickBooks' report or the
         -- sent entry is the fallback, then the bare id.
         coalesce(ch.name, h.name, s.name, s.acct, h.acct) as name,
         round(coalesce(s.amt, 0), 2) as sent_amt, round(coalesce(h.amt, 0), 2) as held_amt
    from sent s full join held h on h.posting_id = s.posting_id and h.acct = s.acct
    join entry e on e.posting_id = coalesce(s.posting_id, h.posting_id)
    left join chart ch on ch.company_entity_id = e.company_entity_id and ch.qbo_connection_id = e.connection_id
                      and ch.qbo_account_id = coalesce(s.acct, h.acct)
), gap as materialized (
  -- accounts: only the accounts that differ, what SILO sent against what
  -- QuickBooks holds now (+debit / -credit), so a person sees what they accept.
  select posting_id, sum(off) / 2 as differs_by,
         coalesce(jsonb_agg(jsonb_build_object('account', name, 'sent', sent_amt, 'quickbooks', held_amt)
                            order by name, acct) filter (where off <> 0), '[]'::jsonb) as accounts
    from pair group by 1
), state as materialized (
  select h.posting_id, min(h.first_day) as first_day, max(h.last_day) as last_day,
         md5(string_agg(h.acct || ':' || round(h.amt, 2)::text || ':' || h.first_day::text || ':' || h.last_day::text,
                        '|' order by h.acct)) as held_state
    from held h group by 1
), judged as (
  select e.posting_id, e.company_entity_id, e.connection_id, e.txn, e.qbo_doc_number, e.source, e.source_ref,
         e.memo, e.entry_date, e.was_read,
         case when e.was_read then coalesce(g.differs_by, 0) end as differs_by,
         case when e.was_read then st.posting_id is null end as missing,
         case when e.was_read then st.posting_id is not null
                                   and (st.first_day <> e.entry_date or st.last_day <> e.entry_date) end as moved,
         case when e.was_read then coalesce(st.held_state, 'gone') end as held_state,
         case when e.was_read then st.first_day end as held_first_day,
         case when e.was_read then st.last_day end as held_last_day,
         case when e.was_read then coalesce(g.accounts, '[]'::jsonb) end as accounts
    from entry e
    left join gap g on g.posting_id = e.posting_id
    left join state st on st.posting_id = e.posting_id
)
select j.posting_id, j.company_entity_id, j.connection_id as qbo_connection_id,
       j.txn as qbo_transaction_id, j.qbo_doc_number, j.source, j.source_ref, j.memo, j.entry_date,
       j.differs_by, j.missing, j.moved, j.held_state,
       case
         when not j.was_read then 'unread'
         when j.differs_by = 0 and not j.missing and not j.moved then 'as_sent'
         when s.accepted_state is not null and s.accepted_state = j.held_state then 'settled'
         else 'changed'
       end as status,
       s.accepted_at,
       j.held_first_day, j.held_last_day, j.accounts
  from judged j
  left join public.quickbooks_entry_settlements s on s.posting_id = j.posting_id;

comment on view public.quickbooks_sent_entries_check_v is
  'One row per journal entry SILO posted to QuickBooks, checked against the nightly read-back of QuickBooks'' own ledger. status: ''unread'' (no read-back reaches the entry''s day yet), ''as_sent'' (QuickBooks holds it on the same day with the same net amount on every account), ''changed'' (edited, moved to another day, or deleted in QuickBooks; missing and moved say which, differs_by is the amount, held_first_day/held_last_day are the day QuickBooks holds it on, accounts lists each account that differs with what SILO sent and what QuickBooks has, +debit/-credit), ''settled'' (changed, and a finance user accepted that exact QuickBooks version). QuickBooks is the master copy: SILO''s statements already use QuickBooks'' lines for a month that was read back. Matched by QuickBooks transaction id and the type Journal Entry, never by document number. Finance users of the company only. security_invoker. 20261125235000, made fast in 20261127200000.';

revoke all on public.quickbooks_sent_entries_check_v from public, anon, authenticated;
grant select on public.quickbooks_sent_entries_check_v to authenticated;
