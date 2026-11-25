-- 20261125150000: SILO's books read QuickBooks back, on their own.
--
-- WHY. SILO posts entries to QuickBooks, and people keep working in QuickBooks
-- afterwards: they edit an entry SILO sent, add a journal entry by hand, or let
-- QuickBooks' own bank feed book a payment. None of that came back, so SILO's
-- books and QuickBooks drifted apart from the first month (reconciled
-- 2026-11-25: January to March matched to the cent, August and September did
-- not). Blake: SILO's books should match, with nothing new for anyone to press.
--
-- WHAT THIS ADDS. A MIRROR of QuickBooks' general ledger, one calendar month at
-- a time, that a scheduled reader (the quickbooks-ledger-mirror-scheduled edge
-- function, no person present) replaces in place:
--
--   quickbooks_ledger_mirror_periods   one row per company, connection and month:
--                                      when it was last read, and why the last
--                                      read was refused if it was
--   quickbooks_ledger_mirror_lines     that month's ledger lines as QuickBooks
--                                      has them now
--   quickbooks_ledger_mirror_store()   the only writer; service role only
--   quickbooks_ledger_mirror_failed()  records a read that never got as far as
--                                      the store (QuickBooks down, reconnect)
--   quickbooks_ledger_mirror_due()     which months the reader should read next
--   silo_books_ledger_v                SILO's books: the mirror where a month
--                                      has been read, SILO's own ledger
--                                      (accounting_ledger_v) everywhere else,
--                                      and every line says where it came from
--
-- This is deliberately NOT the history archive (qbo_history_*). That archive is
-- an immutable audit copy of the books a company kept BEFORE it moved, made
-- once by a person. A mirror is read every night, and an immutable copy per
-- night would grow without end -- so a month here is REPLACED, never appended.
--
-- READ ONLY. Nothing in this migration sends anything to QuickBooks, changes a
-- posting, or changes a journal entry. quickbooks-post-journal stays the only
-- write path to QuickBooks.
--
-- FAIL CLOSED, KEEP THE LAST GOOD COPY. A month is replaced only when the new
-- report is the shape SILO knows, every account section's rows add up to the
-- section's own total, every account with money has a known type, and the
-- month's debits equal its credits. Anything else leaves the lines exactly as
-- they were and records the reason on the period row (last_error), so success,
-- "nothing changed" and "refused" are three different stored states.
--
-- WHERE A LINE CAME FROM (silo_books_ledger_v.source):
--   'silo'              SILO posted this entry and QuickBooks still has it as sent
--   'quickbooks_edited' SILO posted it and it was changed in QuickBooks afterwards
--   'quickbooks'        entered in QuickBooks (by hand, or from its bank feed)
--   'history'           the books kept before the company moved to SILO
-- An entry is SILO's by its QuickBooks transaction id, never by its document
-- number alone: a person can type a SILO-looking number on their own entry.
--
-- Generic: no company, account or date is named here. Which companies are read
-- is data (an accounting_settings row with an active QuickBooks connection).
--
-- No BEGIN/COMMIT of its own, on purpose: the applier sends this file and its
-- schema_migrations row as ONE request, which is one transaction.
--
-- Idempotent. Rollback: drop view public.silo_books_ledger_v; drop function
-- public.quickbooks_ledger_mirror_due(integer,integer); drop function
-- public.quickbooks_ledger_mirror_failed(uuid,uuid,date,text); drop function
-- public.quickbooks_ledger_mirror_store(uuid,uuid,date,date,jsonb,jsonb); drop
-- table public.quickbooks_ledger_mirror_lines; drop table
-- public.quickbooks_ledger_mirror_periods;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.quickbooks_ledger_mirror_periods (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id),
  qbo_connection_id  uuid not null,
  period_start       date not null,
  period_end         date not null,
  accounting_basis   text not null,
  -- NULL until a read has been accepted. A month with no accepted read is not
  -- covered, and the books view falls back to SILO's own ledger for it.
  read_at            timestamptz,
  -- The last day the accepted read reached (the month's end, or the day of
  -- the read for the month still in progress).
  read_through       date,
  content_hash       text,
  line_count         integer not null default 0,
  last_attempt_at    timestamptz,
  -- NULL when the last attempt was accepted. Otherwise why it was refused; the
  -- lines are then still the last accepted read.
  last_error         text,
  created_at         timestamptz not null default now(),
  unique (company_entity_id, qbo_connection_id, period_start),
  check (period_start = date_trunc('month', period_start)::date),
  check (period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date)
);

create table if not exists public.quickbooks_ledger_mirror_lines (
  id                  bigint generated always as identity primary key,
  company_entity_id   uuid not null references public.entities(id),
  period_id           uuid not null references public.quickbooks_ledger_mirror_periods(id) on delete cascade,
  line_no             integer not null,
  qbo_account_id      text not null,
  account_name        text not null,
  account_type        text not null,
  transaction_date    date not null,
  qbo_transaction_id  text,
  transaction_type    text,
  document_number     text,
  counterparty        text,
  memo                text,
  split_account_name  text,
  -- As QuickBooks reports it, in the account's natural sign.
  natural_amount      numeric not null,
  -- +debit / -credit, the same convention as accounting_ledger_v.
  signed_amount       numeric not null,
  unique (period_id, line_no)
);
create index if not exists quickbooks_ledger_mirror_lines_day
  on public.quickbooks_ledger_mirror_lines (company_entity_id, transaction_date);
create index if not exists quickbooks_ledger_mirror_lines_txn
  on public.quickbooks_ledger_mirror_lines (company_entity_id, qbo_transaction_id);

-- Read: the same finance gate as the imported history. Write: nobody but the
-- store function below (no insert/update/delete policy, and no grant).
do $$ declare t text; begin
  foreach t in array array['quickbooks_ledger_mirror_periods','quickbooks_ledger_mirror_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ledger_mirror_finance_read on public.%I', t);
    execute format('create policy ledger_mirror_finance_read on public.%I for select to authenticated '
      || 'using (company_entity_id = (select public.active_company_id()) '
      || 'and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())))', t);
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. The only writer
-- ──────────────────────────────────────────────────────────────────────────
-- p_report        QuickBooks' GeneralLedger report for exactly one calendar
--                 month, default columns, unfiltered.
-- p_account_types {"<QuickBooks account id>": "<AccountType>"} as QuickBooks
--                 lists them now. Used first, because the stored chart can be
--                 older than an account created last week; the stored chart is
--                 the fallback.
-- Returns {ok, changed, lines} or {ok:false, error}. It never raises for a
-- report it does not like: the refusal is the stored record.
create or replace function public.quickbooks_ledger_mirror_store(
  p_company uuid, p_connection uuid, p_period_start date, p_read_through date,
  p_report jsonb, p_account_types jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_period    public.quickbooks_ledger_mirror_periods%rowtype;
  v_month_end date;
  v_basis     text;
  v_keys      text[];
  v_expected  text[] := array['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount','rbal_nat_amount'];
  v_hash      text;
  v_lines     integer;
  v_bad       text;
  v_net       numeric;
  v_err       text;
begin
  if p_company is null or p_connection is null or p_period_start is null or p_read_through is null
     or p_report is null then
    raise exception 'quickbooks_ledger_mirror_store: every argument but the account types is required';
  end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'quickbooks_ledger_mirror_store: a period starts on the first of a month';
  end if;
  v_month_end := (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date;
  if p_read_through < p_period_start or p_read_through > v_month_end then
    raise exception 'quickbooks_ledger_mirror_store: read_through is outside the month';
  end if;
  -- The connection must be this company's, and the one its books are kept on.
  select s.accounting_basis into v_basis
    from public.accounting_settings s
    join public.quickbooks_connections c
      on c.id = s.qbo_connection_id and c.company_entity_id = s.company_entity_id
   where s.company_entity_id = p_company and s.qbo_connection_id = p_connection;
  if not found then
    raise exception 'quickbooks_ledger_mirror_store: that connection is not this company''s books';
  end if;
  v_basis := coalesce(nullif(v_basis, ''), 'Accrual');

  -- One reader at a time per month: two overlapping runs must not interleave a
  -- delete and an insert.
  perform pg_advisory_xact_lock(hashtextextended(
    'quickbooks_ledger_mirror:' || p_company::text || ':' || p_connection::text || ':' || p_period_start::text, 0));

  insert into public.quickbooks_ledger_mirror_periods
    (company_entity_id, qbo_connection_id, period_start, period_end, accounting_basis, last_attempt_at)
  values (p_company, p_connection, p_period_start, v_month_end, v_basis, now())
  on conflict (company_entity_id, qbo_connection_id, period_start)
  do update set last_attempt_at = now()
  returning * into v_period;

  -- Everything from here to the replace happens inside one block, so a refusal
  -- undoes any partial work and the lines stay as the last accepted read.
  begin
    if p_report #>> '{Header,ReportName}' is distinct from 'GeneralLedger' then
      raise exception 'not a GeneralLedger report';
    end if;
    if p_report #>> '{Header,StartPeriod}' is distinct from p_period_start::text
       or p_report #>> '{Header,EndPeriod}' is distinct from p_read_through::text then
      raise exception 'the report covers % to %, not % to %',
        p_report #>> '{Header,StartPeriod}', p_report #>> '{Header,EndPeriod}', p_period_start, p_read_through;
    end if;
    if coalesce(p_report #>> '{Header,ReportBasis}', v_basis) is distinct from v_basis then
      raise exception 'the report is % basis and the books are %', p_report #>> '{Header,ReportBasis}', v_basis;
    end if;
    select array_agg(m.value ->> 'Value' order by c.ordinality) into v_keys
      from jsonb_array_elements(p_report #> '{Columns,Column}') with ordinality c
      cross join lateral jsonb_array_elements(coalesce(c.value -> 'MetaData', '[]'::jsonb)) m
     where m.value ->> 'Name' = 'ColKey';
    if v_keys is distinct from v_expected then
      raise exception 'unsupported ledger columns';
    end if;

    create temp table _mirror_sections on commit drop as
    with recursive sections(j, qid, path) as (
      select r.value, r.value #>> '{Header,ColData,0,id}', array[r.ordinality]
        from jsonb_array_elements(coalesce(p_report #> '{Rows,Row}', '[]'::jsonb)) with ordinality r
      union all
      select c.value,
             case when c.value ? 'Header' then c.value #>> '{Header,ColData,0,id}' else s.qid end,
             s.path || c.ordinality
        from sections s
        cross join lateral jsonb_array_elements(coalesce(s.j #> '{Rows,Row}', '[]'::jsonb)) with ordinality c
       where c.value ->> 'type' = 'Section'
    )
    select row_number() over (order by path) as seq, j, nullif(qid, '') as qid,
           coalesce(nullif(j #>> '{Header,ColData,0,value}', ''), '(unnamed)') as title,
           exists (select 1 from jsonb_array_elements(coalesce(j #> '{Rows,Row}', '[]'::jsonb)) c
                    where c.value ->> 'type' = 'Section') as has_children,
           exists (select 1 from jsonb_array_elements(coalesce(j #> '{Rows,Row}', '[]'::jsonb)) c
                    where c.value ->> 'type' = 'Data') as has_rows
      from sections;

    select title into v_bad from _mirror_sections
     where j ->> 'type' is distinct from 'Section'
        or exists (select 1 from jsonb_array_elements(coalesce(j #> '{Rows,Row}', '[]'::jsonb)) c
                    where c.value ->> 'type' is null or c.value ->> 'type' not in ('Section', 'Data'))
     limit 1;
    if v_bad is not null then raise exception 'unsupported ledger row in section %', v_bad; end if;
    select title into v_bad from _mirror_sections where has_children and has_rows limit 1;
    if v_bad is not null then raise exception 'section % mixes sub-accounts and its own rows', v_bad; end if;

    create temp table _mirror_rows on commit drop as
    select s.seq, s.qid, s.title, r.ordinality as row_in_section, r.value -> 'ColData' as cells
      from _mirror_sections s
      cross join lateral jsonb_array_elements(coalesce(s.j #> '{Rows,Row}', '[]'::jsonb)) with ordinality r
     where not s.has_children
       and r.value ->> 'type' = 'Data'
       and r.value #>> '{ColData,0,value}' is distinct from 'Beginning Balance';

    select title into v_bad from _mirror_rows
     where jsonb_array_length(cells) is distinct from 8
        or cells #>> '{0,value}' is null
        or cells #>> '{0,value}' !~ '^\d{4}-\d{2}-\d{2}$'
        or jsonb_typeof(cells #> '{6,value}') is distinct from 'string'
        or (cells #>> '{6,value}' <> '' and cells #>> '{6,value}' !~ '^-?([0-9]+|[0-9]*[.][0-9]+)$')
     limit 1;
    if v_bad is not null then raise exception 'a row in section % has no date or an unreadable amount', v_bad; end if;

    alter table _mirror_rows add column d date, add column amt numeric;
    update _mirror_rows set d = (cells #>> '{0,value}')::date,
                            amt = coalesce(nullif(cells #>> '{6,value}', '')::numeric, 0);

    select title into v_bad from _mirror_rows where d < p_period_start or d > p_read_through limit 1;
    if v_bad is not null then raise exception 'a row in section % is dated outside the period', v_bad; end if;

    -- Each account's rows must add up to the total QuickBooks prints for it.
    select s.title into v_bad
      from _mirror_sections s
      left join (select seq, sum(amt) as total from _mirror_rows group by seq) r on r.seq = s.seq
     where not s.has_children
       and (jsonb_typeof(s.j #> '{Summary,ColData,6,value}') is distinct from 'string'
            or (s.j #>> '{Summary,ColData,6,value}' <> ''
                and s.j #>> '{Summary,ColData,6,value}' !~ '^-?([0-9]+|[0-9]*[.][0-9]+)$')
            or coalesce(nullif(s.j #>> '{Summary,ColData,6,value}', ''), '0')::numeric
               is distinct from coalesce(r.total, 0))
     limit 1;
    if v_bad is not null then raise exception 'the rows of % do not add up to its total', v_bad; end if;

    -- QuickBooks' own account-less bucket may only hold zero rows.
    select title into v_bad from _mirror_rows where qid is null and amt <> 0 limit 1;
    if v_bad is not null then raise exception 'section % has money and no QuickBooks account', v_bad; end if;

    create temp table _mirror_lines on commit drop as
    select row_number() over (order by r.seq, r.row_in_section)::integer as line_no,
           r.qid, r.title, t.account_type, r.d, r.amt, r.cells,
           case
             when t.account_type in ('Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset',
                                     'Other Asset', 'Expense', 'Other Expense', 'Cost of Goods Sold') then 1
             when t.account_type in ('Accounts Payable', 'Credit Card', 'Other Current Liability',
                                     'Long Term Liability', 'Other Liability', 'Equity', 'Income',
                                     'Other Income') then -1
           end as direction
      from _mirror_rows r
      left join lateral (
        select coalesce(
          nullif(p_account_types ->> r.qid, ''),
          (select a.account_type from public.accounting_accounts a
            where a.company_entity_id = p_company and a.qbo_connection_id = p_connection
              and a.qbo_account_id = r.qid limit 1),
          (select a.account_type from public.quickbooks_accounts a
            where a.company_entity_id = p_company and a.connection_id = p_connection
              and a.qbo_account_id = r.qid limit 1)) as account_type
      ) t on true
     where r.qid is not null and r.amt <> 0;

    select title || ' (' || coalesce(account_type, 'no type') || ')' into v_bad
      from _mirror_lines where direction is null limit 1;
    if v_bad is not null then raise exception 'account % has no known debit or credit side', v_bad; end if;

    select coalesce(sum(amt * direction), 0), count(*) into v_net, v_lines from _mirror_lines;
    if abs(v_net) > 0.005 then
      raise exception 'the month does not balance: debits less credits is %', v_net;
    end if;

    select md5(coalesce(string_agg(md5(qid || '|' || account_type || '|' || d::text || '|' || amt::text || '|' || cells::text),
                                   '' order by line_no), ''))
      into v_hash from _mirror_lines;

    if v_period.read_at is not null and v_period.content_hash = v_hash then
      update public.quickbooks_ledger_mirror_periods
         set read_at = now(), read_through = p_read_through, last_error = null, accounting_basis = v_basis
       where id = v_period.id;
      drop table _mirror_lines; drop table _mirror_rows; drop table _mirror_sections;
      return jsonb_build_object('ok', true, 'changed', false, 'lines', v_lines);
    end if;

    delete from public.quickbooks_ledger_mirror_lines where period_id = v_period.id;
    insert into public.quickbooks_ledger_mirror_lines
      (company_entity_id, period_id, line_no, qbo_account_id, account_name, account_type, transaction_date,
       qbo_transaction_id, transaction_type, document_number, counterparty, memo, split_account_name,
       natural_amount, signed_amount)
    select p_company, v_period.id, line_no, qid, title, account_type, d,
           nullif(cells #>> '{1,id}', ''), nullif(cells #>> '{1,value}', ''), nullif(cells #>> '{2,value}', ''),
           nullif(cells #>> '{3,value}', ''), nullif(cells #>> '{4,value}', ''), nullif(cells #>> '{5,value}', ''),
           amt, round(amt * direction, 2)
      from _mirror_lines;
    update public.quickbooks_ledger_mirror_periods
       set read_at = now(), read_through = p_read_through, content_hash = v_hash, line_count = v_lines,
           last_error = null, accounting_basis = v_basis
     where id = v_period.id;
    drop table _mirror_lines; drop table _mirror_rows; drop table _mirror_sections;
    return jsonb_build_object('ok', true, 'changed', true, 'lines', v_lines);
  exception when others then
    v_err := left(sqlerrm, 500);
  end;

  -- Refused: the block above was rolled back, so the lines are untouched.
  update public.quickbooks_ledger_mirror_periods
     set last_attempt_at = now(), last_error = v_err
   where id = v_period.id;
  return jsonb_build_object('ok', false, 'error', v_err);
end $$;

revoke all on function public.quickbooks_ledger_mirror_store(uuid, uuid, date, date, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_store(uuid, uuid, date, date, jsonb, jsonb)
  to service_role;

-- A read that never reached the store (QuickBooks unreachable, the connection
-- needs reconnecting): recorded on the month, lines untouched, so the reader is
-- not handed the same month again on its very next call.
create or replace function public.quickbooks_ledger_mirror_failed(
  p_company uuid, p_connection uuid, p_period_start date, p_error text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_basis text;
begin
  if p_company is null or p_connection is null or p_period_start is null
     or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'quickbooks_ledger_mirror_failed: a company, its connection and a month are required';
  end if;
  select s.accounting_basis into v_basis
    from public.accounting_settings s
    join public.quickbooks_connections c
      on c.id = s.qbo_connection_id and c.company_entity_id = s.company_entity_id
   where s.company_entity_id = p_company and s.qbo_connection_id = p_connection;
  if not found then
    raise exception 'quickbooks_ledger_mirror_failed: that connection is not this company''s books';
  end if;
  insert into public.quickbooks_ledger_mirror_periods
    (company_entity_id, qbo_connection_id, period_start, period_end, accounting_basis, last_attempt_at, last_error)
  values (p_company, p_connection, p_period_start,
          (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date,
          coalesce(nullif(v_basis, ''), 'Accrual'), now(), left(coalesce(nullif(p_error, ''), 'read_failed'), 500))
  on conflict (company_entity_id, qbo_connection_id, period_start)
  do update set last_attempt_at = now(), last_error = excluded.last_error;
end $$;

revoke all on function public.quickbooks_ledger_mirror_failed(uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_failed(uuid, uuid, date, text) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. What to read next
-- ──────────────────────────────────────────────────────────────────────────
-- One row per month that is due, most urgent first: a month never read, then
-- the two newest months once a night, then older months once a week (an old
-- month still changes when someone edits it in QuickBooks). A month whose last
-- attempt was refused waits six hours, so one bad report cannot spend the run.
create or replace function public.quickbooks_ledger_mirror_due(
  p_months_back integer default 12, p_limit integer default 20)
returns table (company_entity_id uuid, qbo_connection_id uuid, period_start date, read_through date,
               accounting_basis text)
language sql stable security definer set search_path = public, pg_temp as $$
  with today as (select public.silo_business_today() as d),
  books as (
    select s.company_entity_id, s.qbo_connection_id,
           coalesce(nullif(s.accounting_basis, ''), 'Accrual') as accounting_basis
      from public.accounting_settings s
      join public.quickbooks_connections c
        on c.id = s.qbo_connection_id and c.company_entity_id = s.company_entity_id and c.is_active
  ),
  months as (
    select b.*, m::date as period_start,
           least((m + interval '1 month - 1 day')::date, (select d from today)) as read_through,
           m::date >= (date_trunc('month', (select d from today)) - interval '1 month')::date as recent
      from books b
      cross join generate_series(
        date_trunc('month', (select d from today)) - make_interval(months => greatest(coalesce(p_months_back, 12), 0)),
        date_trunc('month', (select d from today)), interval '1 month') m
  )
  select m.company_entity_id, m.qbo_connection_id, m.period_start, m.read_through, m.accounting_basis
    from months m
    left join public.quickbooks_ledger_mirror_periods p
      on p.company_entity_id = m.company_entity_id and p.qbo_connection_id = m.qbo_connection_id
     and p.period_start = m.period_start
   where case
           when p.id is null then true
           when p.last_error is not null then p.last_attempt_at < now() - interval '6 hours'
           when p.read_at is null then true
           when m.recent then p.read_at < now() - interval '20 hours'
           else p.read_at < now() - interval '7 days'
         end
   order by (p.read_at is null) desc, m.recent desc, p.read_at nulls first, m.period_start desc
   limit greatest(coalesce(p_limit, 20), 0)
$$;

revoke all on function public.quickbooks_ledger_mirror_due(integer, integer) from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_due(integer, integer) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. SILO's books
-- ──────────────────────────────────────────────────────────────────────────
-- A day inside a month that has been read comes from the mirror. Every other
-- day comes from accounting_ledger_v (imported history before the move, SILO's
-- posted entries after), so nothing is counted twice and nothing is dropped.
create or replace view public.silo_books_ledger_v
with (security_invoker = true) as
with covered as (
  select p.id, p.company_entity_id, p.qbo_connection_id, p.period_start, p.read_through, p.read_at
    from public.quickbooks_ledger_mirror_periods p
   where p.read_at is not null
), silo_entries as (
  -- One row per entry SILO posted, and whether QuickBooks still holds it as
  -- sent: the same day, and the same net amount on every account.
  select p.company_entity_id, p.connection_id, p.qbo_journal_entry_id as txn_id,
         not exists (
           select 1
             from (select l.value #>> '{JournalEntryLineDetail,AccountRef,value}' as acct,
                          sum(case when l.value #>> '{JournalEntryLineDetail,PostingType}' = 'Debit' then 1 else -1 end
                              * (l.value ->> 'Amount')::numeric) as amt
                     from jsonb_array_elements(coalesce(p.payload -> 'Line', '[]'::jsonb)) l
                    group by 1) sent
             full join (select m.qbo_account_id as acct, sum(m.signed_amount) as amt,
                               bool_and(m.transaction_date::text = p.payload ->> 'TxnDate') as same_day
                          from public.quickbooks_ledger_mirror_lines m
                          join covered c on c.id = m.period_id and c.qbo_connection_id = p.connection_id
                         where m.company_entity_id = p.company_entity_id
                           and m.qbo_transaction_id = p.qbo_journal_entry_id
                           and m.transaction_type = 'Journal Entry'
                         group by 1) held using (acct)
            where round(coalesce(sent.amt, 0), 2) <> round(coalesce(held.amt, 0), 2)
               or held.same_day is false
         ) as as_sent
    from public.quickbooks_journal_postings p
   where p.status = 'posted' and p.qbo_journal_entry_id is not null
)
select
  m.company_entity_id,
  case when e.txn_id is null then 'quickbooks'
       when e.as_sent then 'silo'
       else 'quickbooks_edited' end          as source,
  m.transaction_date                         as entry_date,
  m.qbo_account_id,
  m.account_name                             as qbo_account_name,
  m.account_type,
  case when m.signed_amount >= 0 then 'Debit' else 'Credit' end as posting_type,
  abs(m.signed_amount)                       as amount,
  m.signed_amount,
  m.counterparty,
  m.document_number,
  m.transaction_type,
  m.memo,
  m.split_account_name                       as description,
  m.qbo_transaction_id                       as transaction_ref,
  c.read_at                                  as quickbooks_read_at
from public.quickbooks_ledger_mirror_lines m
join covered c on c.id = m.period_id
left join silo_entries e
  on e.company_entity_id = m.company_entity_id and e.connection_id = c.qbo_connection_id
 and e.txn_id = m.qbo_transaction_id and m.transaction_type = 'Journal Entry'

union all

select
  g.company_entity_id,
  case when g.origin = 'qbo_history' then 'history' else 'silo' end,
  g.entry_date,
  g.qbo_account_id,
  g.qbo_account_name,
  coalesce(g.account_type,
    (select a.account_type from public.accounting_accounts a
      where a.company_entity_id = g.company_entity_id and a.qbo_account_id = g.qbo_account_id limit 1),
    (select a.account_type from public.quickbooks_accounts a
      where a.company_entity_id = g.company_entity_id and a.qbo_account_id = g.qbo_account_id limit 1)),
  g.posting_type,
  g.amount,
  g.signed_amount,
  g.counterparty,
  g.document_number,
  g.transaction_type,
  g.memo,
  g.description,
  g.transaction_ref,
  null::timestamptz
from public.accounting_ledger_v g
where not exists (
  select 1 from covered c
   where c.company_entity_id = g.company_entity_id
     and g.entry_date between c.period_start and c.read_through
);

comment on view public.silo_books_ledger_v is
  'SILO''s books, line by line, kept in step with QuickBooks. For a month SILO has read back from QuickBooks (quickbooks_ledger_mirror_periods.read_at is set) the lines are QuickBooks'' own general ledger as of quickbooks_read_at, so totals equal QuickBooks for those days; every other day comes from accounting_ledger_v (imported history before the company moved, SILO''s posted entries after). source says where a line came from: ''silo'' (SILO posted the entry and QuickBooks still has it as sent), ''quickbooks_edited'' (SILO posted it and it was changed in QuickBooks afterwards), ''quickbooks'' (entered in QuickBooks by hand or from its bank feed) or ''history'' (the books kept before SILO). signed_amount is +debit/-credit. An entry is matched to SILO by its QuickBooks transaction id, never by document number alone. Visible to finance users only, like the imported history. security_invoker. 20261125150000.';

revoke all on public.silo_books_ledger_v from public, anon, authenticated;
grant select on public.silo_books_ledger_v to authenticated;

-- Company stamp backstop on the two new tables.
select public.attach_stamp_company_entity_id_triggers();

-- Ask SILO's map.
select public.refresh_chat_schema_catalog();
update public.silo_chat_schema_catalog set
  description = $d$SILO's books line by line, kept in step with QuickBooks: for each month SILO has read back from QuickBooks the lines are QuickBooks' own general ledger as of quickbooks_read_at (so totals equal QuickBooks), and every other day comes from accounting_ledger_v. source is 'silo' (SILO posted it and QuickBooks still has it as sent), 'quickbooks_edited' (SILO posted it, changed in QuickBooks afterwards), 'quickbooks' (entered in QuickBooks by hand or from its bank feed) or 'history' (the books kept before SILO). signed_amount is +debit/-credit; account_type is QuickBooks' (Income, Cost of Goods Sold, Expense, Bank, ...). USE THIS for a profit and loss, balance sheet movement or account total that should agree with QuickBooks. Finance users only.$d$,
  keywords = array['books','profit and loss','p&l','balance sheet','general ledger','matches quickbooks','entered in quickbooks','edited in quickbooks','trial balance'],
  updated_at = now()
where relname = 'silo_books_ledger_v';
update public.silo_chat_schema_catalog set
  description = $d$One row per company, QuickBooks connection and calendar month that SILO reads back from QuickBooks: read_at (when the month was last accepted; NULL means never), read_through (the last day that read reached), line_count, and last_error (why the most recent attempt was refused or failed; NULL when it was accepted -- the stored lines are then still the last accepted read). Use it to answer "how fresh are SILO's books against QuickBooks". For the books themselves use silo_books_ledger_v.$d$,
  keywords = array['quickbooks read back','books freshness','ledger mirror','last read from quickbooks'],
  updated_at = now()
where relname = 'quickbooks_ledger_mirror_periods';
update public.silo_chat_schema_catalog set
  description = $d$QuickBooks' general ledger lines for each month SILO has read back, replaced in place on every read (never appended). signed_amount is +debit/-credit. Prefer silo_books_ledger_v, which adds where each line came from and covers the days not read back.$d$,
  keywords = array['quickbooks ledger lines','ledger mirror'],
  updated_at = now()
where relname = 'quickbooks_ledger_mirror_lines';
