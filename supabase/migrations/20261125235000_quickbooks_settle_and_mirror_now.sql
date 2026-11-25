-- QuickBooks read-back: make it run, let a finance user start it, and settle
-- what it finds (2026-11-25).
--
-- Blake, 2026-11-25: "we need to get tied out ... qbo is current master", and
-- "with action to get settled and mirrored, not just flag".
--
-- 1. THE READ-BACK NEVER STORED A MONTH. quickbooks_ledger_mirror_store
--    (20261125150000) fills two working columns with an UPDATE that has no
--    WHERE. Production loads safeupdate for the API roles, which refuses that
--    statement ("UPDATE requires a WHERE clause"), so every month of the first
--    run was refused and recorded as failed. The statement is patched in place
--    to say `where true`; nothing else in the function changes. PGlite has no
--    safeupdate, which is why the tests did not see it -- the test for this
--    migration now reads every function body in it for a bare UPDATE/DELETE.
--
-- 2. MIRROR NOW. quickbooks_ledger_mirror_my_due(since) hands a signed-in
--    finance user the next month of THEIR OWN active company that has not
--    been attempted since they pressed the button. The Edge Function calls it
--    with the caller's own token, so the database decides who may ask and for
--    which company; the caller still names no company, connection or month.
--
-- 3. SETTLE. quickbooks_sent_entries_check_v says, for every entry SILO
--    posted, whether QuickBooks still holds it as sent. QuickBooks is the
--    master copy: when an entry was changed, moved or deleted there, a finance
--    user accepts QuickBooks' version (quickbooks_accept_quickbooks_version),
--    which records the exact state accepted. If QuickBooks changes the entry
--    again, the acceptance no longer matches and the entry is flagged again.
--    Nothing here writes to QuickBooks.
--
-- No BEGIN/COMMIT: auto-apply-migrations runs this file as one transaction.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. The store function's bare UPDATE
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  v_proc regprocedure := to_regprocedure('public.quickbooks_ledger_mirror_store(uuid,uuid,date,date,jsonb,jsonb)');
  v_def  text;
  v_bare constant text := 'amt = coalesce(nullif(cells #>> ''{6,value}'', '''')::numeric, 0);';
  v_safe constant text := 'amt = coalesce(nullif(cells #>> ''{6,value}'', '''')::numeric, 0) where true;';
begin
  if v_proc is null then
    raise exception 'quickbooks_ledger_mirror_store is missing: run 20261125150000 first';
  end if;
  v_def := pg_get_functiondef(v_proc);
  if position(v_safe in v_def) > 0 then
    return;                                   -- already patched
  end if;
  if position(v_bare in v_def) = 0 then
    raise exception 'quickbooks_ledger_mirror_store no longer contains the statement this migration patches';
  end if;
  execute replace(v_def, v_bare, v_safe);
end $$;

-- A month refused only by that statement is due again at once, not in six
-- hours: with the error cleared and nothing read, quickbooks_ledger_mirror_due
-- hands it out on the next run.
update public.quickbooks_ledger_mirror_periods
   set last_error = null
 where read_at is null and last_error = 'UPDATE requires a WHERE clause';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Mirror now
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.quickbooks_ledger_mirror_my_due(
  p_since timestamptz, p_months_back integer default 12)
returns table (company_entity_id uuid, qbo_connection_id uuid, period_start date, read_through date,
               accounting_basis text, remaining integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_company uuid := public.active_company_id();
begin
  if v_company is null or not public.can_manage_journal_entries() then
    raise exception 'Finance access is required' using errcode = '42501';
  end if;
  -- `since` is when the person pressed the button. It only decides which
  -- months still count as not yet attempted, so it must be a recent moment.
  if p_since is null or p_since > now() + interval '1 minute' or p_since < now() - interval '30 minutes' then
    raise exception 'Start the read again' using errcode = '22023';
  end if;
  return query
  with today as (select public.silo_business_today() as d),
  books as (
    select s.company_entity_id, s.qbo_connection_id,
           coalesce(nullif(s.accounting_basis, ''), 'Accrual') as accounting_basis
      from public.accounting_settings s
      join public.quickbooks_connections c
        on c.id = s.qbo_connection_id and c.company_entity_id = s.company_entity_id and c.is_active
     where s.company_entity_id = v_company
  ),
  months as (
    select b.company_entity_id, b.qbo_connection_id, b.accounting_basis, m::date as period_start,
           least((m + interval '1 month - 1 day')::date, (select d from today)) as read_through
      from books b
      cross join generate_series(
        date_trunc('month', (select d from today)) - make_interval(months => least(greatest(coalesce(p_months_back, 12), 0), 12)),
        date_trunc('month', (select d from today)), interval '1 month') m
  ),
  todo as (
    select m.*
      from months m
      left join public.quickbooks_ledger_mirror_periods p
        on p.company_entity_id = m.company_entity_id and p.qbo_connection_id = m.qbo_connection_id
       and p.period_start = m.period_start
     where p.id is null
        or greatest(coalesce(p.read_at, '-infinity'), coalesce(p.last_attempt_at, '-infinity')) < p_since
  )
  select t.company_entity_id, t.qbo_connection_id, t.period_start, t.read_through, t.accounting_basis,
         (select count(*)::integer from todo)
    from todo t
   order by t.period_start desc
   limit 1;
end $$;

revoke all on function public.quickbooks_ledger_mirror_my_due(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_my_due(timestamptz, integer) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Settle
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.quickbooks_entry_settlements (
  posting_id         uuid primary key references public.quickbooks_journal_postings(id) on delete cascade,
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  -- The state of the entry in QuickBooks that was accepted (held_state of
  -- quickbooks_sent_entries_check_v at that moment). An acceptance speaks only
  -- for that state.
  accepted_state     text not null,
  accepted_by        uuid,
  accepted_at        timestamptz not null default now()
);
create index if not exists quickbooks_entry_settlements_company
  on public.quickbooks_entry_settlements (company_entity_id);

alter table public.quickbooks_entry_settlements enable row level security;
revoke all on public.quickbooks_entry_settlements from public, anon, authenticated;
grant select on public.quickbooks_entry_settlements to authenticated;
drop policy if exists entry_settlements_finance_read on public.quickbooks_entry_settlements;
create policy entry_settlements_finance_read on public.quickbooks_entry_settlements for select to authenticated
  using (company_entity_id = (select public.active_company_id())
         and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())));
-- No insert/update/delete policy and no grant: only the function below writes.

-- One row per entry SILO posted. `status`:
--   unread   no read-back reaches the entry's day on its own connection yet
--   as_sent  QuickBooks holds it on the same day with the same net amount on
--            every account
--   changed  it was edited, moved to another day, or deleted in QuickBooks
--   settled  changed, and that exact QuickBooks state has been accepted
-- An entry is matched by its QuickBooks transaction id and the type Journal
-- Entry, never by document number. differs_by is half the sum of the
-- per-account differences, so a deleted entry differs by its whole amount.
create or replace view public.quickbooks_sent_entries_check_v
with (security_invoker = true) as
with covered as (
  select p.id, p.company_entity_id, p.qbo_connection_id, p.period_start, p.read_through
    from public.quickbooks_ledger_mirror_periods p
   where p.read_at is not null
), entry as (
  select p.id as posting_id, p.company_entity_id, p.connection_id, p.qbo_journal_entry_id as txn,
         p.qbo_doc_number, p.source, p.source_ref, p.memo, p.payload,
         (p.payload ->> 'TxnDate')::date as entry_date,
         exists (select 1 from covered c
                  where c.company_entity_id = p.company_entity_id and c.qbo_connection_id = p.connection_id
                    and (p.payload ->> 'TxnDate')::date between c.period_start and c.read_through) as was_read
    from public.quickbooks_journal_postings p
   where p.status = 'posted' and p.qbo_journal_entry_id is not null and p.payload ? 'TxnDate'
), sent as (
  select e.posting_id, l.value #>> '{JournalEntryLineDetail,AccountRef,value}' as acct,
         sum(case when l.value #>> '{JournalEntryLineDetail,PostingType}' = 'Debit' then 1 else -1 end
             * (l.value ->> 'Amount')::numeric) as amt
    from entry e
    cross join lateral jsonb_array_elements(coalesce(e.payload -> 'Line', '[]'::jsonb)) l
   where e.was_read
   group by 1, 2
), held as (
  select e.posting_id, m.qbo_account_id as acct, sum(m.signed_amount) as amt,
         min(m.transaction_date) as first_day, max(m.transaction_date) as last_day
    from entry e
    join covered c on c.company_entity_id = e.company_entity_id and c.qbo_connection_id = e.connection_id
    join public.quickbooks_ledger_mirror_lines m
      on m.period_id = c.id and m.company_entity_id = e.company_entity_id
     and m.qbo_transaction_id = e.txn and m.transaction_type = 'Journal Entry'
   where e.was_read
   group by 1, 2
), pair as (
  select coalesce(s.posting_id, h.posting_id) as posting_id,
         abs(round(coalesce(s.amt, 0), 2) - round(coalesce(h.amt, 0), 2)) as off
    from sent s full join held h on h.posting_id = s.posting_id and h.acct = s.acct
), gap as (
  select posting_id, sum(off) / 2 as differs_by from pair group by 1
), state as (
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
         case when e.was_read then coalesce(st.held_state, 'gone') end as held_state
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
       s.accepted_at
  from judged j
  left join public.quickbooks_entry_settlements s on s.posting_id = j.posting_id;

comment on view public.quickbooks_sent_entries_check_v is
  'One row per journal entry SILO posted to QuickBooks, checked against the nightly read-back of QuickBooks'' own ledger. status: ''unread'' (no read-back reaches the entry''s day yet), ''as_sent'' (QuickBooks holds it on the same day with the same net amount on every account), ''changed'' (edited, moved to another day, or deleted in QuickBooks; missing and moved say which, differs_by is the amount), ''settled'' (changed, and a finance user accepted that exact QuickBooks version). QuickBooks is the master copy: SILO''s statements already use QuickBooks'' lines for a month that was read back. Matched by QuickBooks transaction id and the type Journal Entry, never by document number. Finance users of the company only. security_invoker. 20261125235000.';

revoke all on public.quickbooks_sent_entries_check_v from public, anon, authenticated;
grant select on public.quickbooks_sent_entries_check_v to authenticated;

-- Accept QuickBooks' version of one entry SILO posted. Records the state that
-- was accepted, nothing else: no entry, posting or QuickBooks record changes.
create or replace function public.quickbooks_accept_quickbooks_version(p_posting_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company uuid := public.active_company_id();
  v_row record;
begin
  if v_company is null or not public.can_manage_journal_entries() then
    raise exception 'Finance access is required' using errcode = '42501';
  end if;
  -- The posting row is locked so two people settling at once cannot record
  -- two different states.
  perform 1 from public.quickbooks_journal_postings p
    where p.id = p_posting_id and p.company_entity_id = v_company for update;
  if not found then
    raise exception 'That entry is not in this company' using errcode = '42501';
  end if;
  select c.status, c.held_state into v_row
    from public.quickbooks_sent_entries_check_v c
   where c.posting_id = p_posting_id and c.company_entity_id = v_company;
  if not found or v_row.status is distinct from 'changed' or v_row.held_state is null then
    return jsonb_build_object('ok', false, 'status', coalesce(v_row.status, 'unknown'));
  end if;
  insert into public.quickbooks_entry_settlements (posting_id, company_entity_id, accepted_state, accepted_by)
  values (p_posting_id, v_company, v_row.held_state, auth.uid())
  on conflict (posting_id) do update
    set accepted_state = excluded.accepted_state, accepted_by = excluded.accepted_by, accepted_at = now();
  return jsonb_build_object('ok', true, 'status', 'settled');
end $$;

revoke all on function public.quickbooks_accept_quickbooks_version(uuid) from public, anon, authenticated;
grant execute on function public.quickbooks_accept_quickbooks_version(uuid) to authenticated;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  description = $d$One row per journal entry SILO posted to QuickBooks, checked against the nightly read-back of QuickBooks' own ledger. status is 'unread' (not compared yet), 'as_sent' (QuickBooks still holds it as sent), 'changed' (edited, moved to another day or deleted in QuickBooks; missing and moved say which, differs_by is the amount) or 'settled' (changed, and a finance user accepted QuickBooks' version). Use it to answer whether QuickBooks and SILO agree for a month.$d$,
  keywords = array['quickbooks and silo agree','tie out','changed in quickbooks','settled','read back'],
  updated_at = now()
where relname = 'quickbooks_sent_entries_check_v';
update public.silo_chat_schema_catalog set
  description = $d$Which changed QuickBooks entries a finance user accepted as QuickBooks' version (one row per posting, with the exact state accepted). Prefer quickbooks_sent_entries_check_v, which already shows 'settled'.$d$,
  keywords = array['settled entries','accepted quickbooks version'],
  updated_at = now()
where relname = 'quickbooks_entry_settlements';
