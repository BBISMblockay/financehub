-- 20261127213000: SILO's balances against QuickBooks' balances, account by account.
--
-- WHY. Blake, 2026-11-27: "if office supply = office supply, we are good, i'm
-- not worried about who posted what in the recon, just that the coa and
-- numbers match", "not journal driven, coa and balance driven", "2 feeds, one
-- board". Until now a month's verdict on the sync page came from entries SILO
-- sent, or from the fact that SILO's statements are built from QuickBooks'
-- ledger lines. Neither is a comparison of balances.
--
-- WHAT THIS ADDS. A second, independent reading of QuickBooks for every month
-- the nightly reader reads: QuickBooks' OWN summary reports (ProfitAndLoss for
-- the month, TrialBalance at the month's end and at the day before it starts),
-- reduced by the reader to one row per account -- what moved on that account in
-- the month, and where it stood at the end. That is compared with what SILO's
-- books (silo_books_ledger_v) show moved on the same account in the same days.
--
--   quickbooks_ledger_mirror_balances        one row per month and account, as
--                                            QuickBooks' reports state it
--   quickbooks_ledger_mirror_balances_store  the only writer; service role only
--   quickbooks_balance_check_v               per account: SILO, QuickBooks,
--                                            and whether they match
--   quickbooks_balance_check_months_v        per month: accounts compared,
--                                            matched, and the ones that differ
--
-- The ledger lines and the summary reports are two different QuickBooks
-- reports, so a month reads "match" only when two independent readings agree
-- to the cent on every account.
--
-- MONTH MOVEMENT, NOT LIFETIME BALANCE. The comparison is what moved in the
-- month, because that is what both sides state without depending on anything
-- older than the month. QuickBooks' ending balance is stored too (ending), for
-- the screen and for a later lifetime comparison.
--
-- NOT COMPARED, AND SAID SO. QuickBooks computes its retained-earnings account
-- (prior years' result rolls into it without a ledger line), so its row carries
-- no movement (activity is null) and is reported as not compared, never as a
-- match and never as a difference.
--
-- FAIL CLOSED. Balances belong to one accepted read of a month: they carry the
-- hash of the lines they were fetched beside, and the views ignore them as soon
-- as the lines change without them. A read whose reports could not be fetched
-- or understood clears the month's balances and records why, so the month reads
-- "not checked", never "match".
--
-- READ ONLY toward QuickBooks: three more GETs per month. Nothing here writes
-- to QuickBooks, a posting or a journal entry, and no screen action built on
-- this writes to QuickBooks either: QuickBooks is the source, SILO follows it.
--
-- Generic: no company, account or date is named. No BEGIN/COMMIT of its own.
-- Idempotent. Rollback: drop view public.quickbooks_balance_check_months_v;
-- drop view public.quickbooks_balance_check_v; drop function
-- public.quickbooks_ledger_mirror_balances_store(uuid,uuid,date,date,jsonb,text);
-- drop table public.quickbooks_ledger_mirror_balances; alter table
-- public.quickbooks_ledger_mirror_periods drop column balances_read_at, drop
-- column balances_hash, drop column balances_error; and re-run
-- 20261125150000's quickbooks_ledger_mirror_due.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Storage
-- ──────────────────────────────────────────────────────────────────────────
alter table public.quickbooks_ledger_mirror_periods
  add column if not exists balances_read_at timestamptz,
  -- content_hash of the lines these balances were fetched beside.
  add column if not exists balances_hash    text,
  -- Why the last attempt to read balances stored none. NULL when it stored them.
  add column if not exists balances_error   text;

create table if not exists public.quickbooks_ledger_mirror_balances (
  id                 bigint generated always as identity primary key,
  company_entity_id  uuid not null references public.entities(id),
  period_id          uuid not null references public.quickbooks_ledger_mirror_periods(id) on delete cascade,
  qbo_account_id     text not null,
  account_name       text not null,
  account_type       text not null,
  -- What moved on the account from the period's first day through its
  -- read_through, +debit / -credit. NULL = QuickBooks computes this account and
  -- no movement can be stated for it (retained earnings).
  activity           numeric,
  -- Where the account stood at read_through, +debit / -credit. NULL for a
  -- profit-and-loss account, which has no standing balance of its own.
  ending             numeric,
  unique (period_id, qbo_account_id)
);

alter table public.quickbooks_ledger_mirror_balances enable row level security;
revoke all on public.quickbooks_ledger_mirror_balances from public, anon, authenticated;
grant select on public.quickbooks_ledger_mirror_balances to authenticated;
drop policy if exists ledger_mirror_finance_read on public.quickbooks_ledger_mirror_balances;
create policy ledger_mirror_finance_read on public.quickbooks_ledger_mirror_balances for select to authenticated
  using (company_entity_id = (select public.active_company_id())
         and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())));

-- ──────────────────────────────────────────────────────────────────────────
-- 2. The only writer
-- ──────────────────────────────────────────────────────────────────────────
-- p_rows   [{"id","name","type","activity","ending"}], one per account, already
--          reduced by the reader from QuickBooks' reports. activity and ending
--          are numbers or null.
-- p_error  set instead of rows when the reports could not be fetched or
--          understood: the month's balances are cleared and the reason kept.
-- The month must already hold an accepted read through p_read_through; the
-- balances are tied to that read's lines by its hash.
-- Returns {ok, accounts} or {ok:false, error}.
create or replace function public.quickbooks_ledger_mirror_balances_store(
  p_company uuid, p_connection uuid, p_period_start date, p_read_through date,
  p_rows jsonb, p_error text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_period public.quickbooks_ledger_mirror_periods%rowtype;
  v_err    text := nullif(left(coalesce(p_error, ''), 200), '');
  v_count  integer;
begin
  if p_company is null or p_connection is null or p_period_start is null or p_read_through is null then
    raise exception 'quickbooks_ledger_mirror_balances_store: a company, its connection, a month and a day are required';
  end if;
  perform 1
    from public.accounting_settings s
    join public.quickbooks_connections c
      on c.id = s.qbo_connection_id and c.company_entity_id = s.company_entity_id
   where s.company_entity_id = p_company and s.qbo_connection_id = p_connection;
  if not found then
    raise exception 'quickbooks_ledger_mirror_balances_store: that connection is not this company''s books';
  end if;

  -- The same lock as the line store: balances never interleave with a replace.
  perform pg_advisory_xact_lock(hashtextextended(
    'quickbooks_ledger_mirror:' || p_company::text || ':' || p_connection::text || ':' || p_period_start::text, 0));

  select * into v_period from public.quickbooks_ledger_mirror_periods
   where company_entity_id = p_company and qbo_connection_id = p_connection and period_start = p_period_start;
  if not found or v_period.read_at is null then
    raise exception 'quickbooks_ledger_mirror_balances_store: that month has no accepted read';
  end if;

  if v_err is null then
    begin
      if v_period.read_through is distinct from p_read_through then
        raise exception 'the month was read through %, not %', v_period.read_through, p_read_through;
      end if;
      if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
        raise exception 'no account rows';
      end if;
      if exists (
        select 1 from jsonb_array_elements(p_rows) r
         where jsonb_typeof(r) <> 'object'
            or coalesce(r ->> 'id', '') = '' or coalesce(r ->> 'name', '') = '' or coalesce(r ->> 'type', '') = ''
            or jsonb_typeof(coalesce(r -> 'activity', 'null'::jsonb)) not in ('number', 'null')
            or jsonb_typeof(coalesce(r -> 'ending', 'null'::jsonb)) not in ('number', 'null')) then
        raise exception 'an account row is not understood';
      end if;
      if (select count(*) from jsonb_array_elements(p_rows) r)
         <> (select count(distinct r ->> 'id') from jsonb_array_elements(p_rows) r) then
        raise exception 'an account appears twice';
      end if;

      delete from public.quickbooks_ledger_mirror_balances where period_id = v_period.id;
      insert into public.quickbooks_ledger_mirror_balances
        (company_entity_id, period_id, qbo_account_id, account_name, account_type, activity, ending)
      select p_company, v_period.id, r ->> 'id', left(r ->> 'name', 300), left(r ->> 'type', 100),
             round((r ->> 'activity')::numeric, 2), round((r ->> 'ending')::numeric, 2)
        from jsonb_array_elements(p_rows) r;
      get diagnostics v_count = row_count;
      update public.quickbooks_ledger_mirror_periods
         set balances_read_at = now(), balances_hash = v_period.content_hash, balances_error = null
       where id = v_period.id;
      return jsonb_build_object('ok', true, 'accounts', v_count);
    exception when others then
      v_err := left(sqlerrm, 200);
    end;
  end if;

  -- Not stored: whatever was there no longer describes this read.
  delete from public.quickbooks_ledger_mirror_balances where period_id = v_period.id;
  update public.quickbooks_ledger_mirror_periods
     set balances_read_at = null, balances_hash = null, balances_error = v_err
   where id = v_period.id;
  return jsonb_build_object('ok', false, 'error', v_err);
end $$;

revoke all on function public.quickbooks_ledger_mirror_balances_store(uuid, uuid, date, date, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_balances_store(uuid, uuid, date, date, jsonb, text)
  to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. What to read next: a month read before balances existed is due once
-- ──────────────────────────────────────────────────────────────────────────
-- 20261125150000's function with one more reason: an accepted read that has
-- neither balances nor a recorded reason for having none. A month whose
-- balances failed waits its ordinary turn, so one bad report cannot spend a run.
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
           when p.balances_read_at is null and p.balances_error is null then true
           when m.recent then p.read_at < now() - interval '20 hours'
           else p.read_at < now() - interval '7 days'
         end
   order by (p.read_at is null) desc, m.recent desc, p.read_at nulls first, m.period_start desc
   limit greatest(coalesce(p_limit, 20), 0)
$$;

revoke all on function public.quickbooks_ledger_mirror_due(integer, integer) from public, anon, authenticated;
grant execute on function public.quickbooks_ledger_mirror_due(integer, integer) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. The comparison
-- ──────────────────────────────────────────────────────────────────────────
-- One row per month and account that either side has. status:
--   'match'         both moved the same amount, to the cent
--   'differs'       they did not
--   'not_compared'  QuickBooks states no movement for the account (computed)
-- Only for months whose balances belong to the lines now stored, on the
-- connection the company keeps its books on. Read as the signed-in finance
-- user (security_invoker): each step below is that user's own rows.
create or replace view public.quickbooks_balance_check_v
with (security_invoker = true) as
with per as materialized (
  select p.id, p.company_entity_id, p.period_start, p.read_through, p.balances_read_at
    from public.quickbooks_ledger_mirror_periods p
    join public.accounting_settings s
      on s.company_entity_id = p.company_entity_id and s.qbo_connection_id = p.qbo_connection_id
   where p.read_at is not null and p.balances_read_at is not null
     and p.balances_hash is not distinct from p.content_hash
), qb as materialized (
  select per.id as period_id, b.qbo_account_id, b.account_name, b.account_type, b.activity, b.ending
    from per join public.quickbooks_ledger_mirror_balances b on b.period_id = per.id
), books as materialized (
  select l.company_entity_id, date_trunc('month', l.entry_date)::date as period_start, l.entry_date,
         l.qbo_account_id, l.qbo_account_name as account_name, l.account_type, l.signed_amount
    from public.silo_books_ledger_v l
   where l.entry_date >= (select min(period_start) from per)
     and l.entry_date <= (select max(read_through) from per)
), silo as materialized (
  select per.id as period_id, coalesce(k.qbo_account_id, '') as qbo_account_id,
         max(k.account_name) as account_name, max(k.account_type) as account_type,
         round(sum(k.signed_amount), 2) as activity
    from per join books k
      on k.company_entity_id = per.company_entity_id and k.period_start = per.period_start
     and k.entry_date <= per.read_through
   group by 1, 2
)
select per.company_entity_id, per.period_start, per.read_through, per.balances_read_at as checked_at,
       coalesce(q.qbo_account_id, s.qbo_account_id) as qbo_account_id,
       coalesce(q.account_name, s.account_name, '') as account_name,
       coalesce(q.account_type, s.account_type, '') as account_type,
       coalesce(s.activity, 0) as silo_amount,
       case when q.period_id is null then 0 else q.activity end as quickbooks_amount,
       q.ending as quickbooks_ending,
       case when q.period_id is not null and q.activity is null then null
            else abs(coalesce(s.activity, 0) - coalesce(q.activity, 0)) end as differs_by,
       case when q.period_id is not null and q.activity is null then 'not_compared'
            when coalesce(s.activity, 0) = coalesce(q.activity, 0) then 'match'
            else 'differs' end as status
  from qb q
  full join silo s on s.period_id = q.period_id and s.qbo_account_id = q.qbo_account_id
  join per on per.id = coalesce(q.period_id, s.period_id);

comment on view public.quickbooks_balance_check_v is
  'SILO against QuickBooks, account by account and month by month. silo_amount is what SILO''s books (silo_books_ledger_v) show moved on the account from the month''s first day through read_through; quickbooks_amount is the same movement taken from QuickBooks'' own ProfitAndLoss and TrialBalance reports, read by the nightly reader beside the ledger lines (+debit / -credit). status is match, differs, or not_compared (QuickBooks computes the account, e.g. retained earnings, and states no movement). quickbooks_ending is where QuickBooks says the account stood at read_through. Only months whose balances belong to the lines now stored. Who posted an entry plays no part. Finance users of the company only. security_invoker. 20261127213000.';

revoke all on public.quickbooks_balance_check_v from public, anon, authenticated;
grant select on public.quickbooks_balance_check_v to authenticated;

-- One row per read month, for the screen. A month with no usable balances is
-- here too, as checked = false with the reason, so "not checked" is a stored
-- state and not an absence.
create or replace view public.quickbooks_balance_check_months_v
with (security_invoker = true) as
with rows as materialized (
  select * from public.quickbooks_balance_check_v
), agg as (
  select company_entity_id, period_start,
         count(*) filter (where status <> 'not_compared') as compared,
         count(*) filter (where status = 'match') as matched,
         count(*) filter (where status = 'differs') as differing,
         count(*) filter (where status = 'not_compared') as not_compared,
         coalesce(sum(differs_by) filter (where status = 'differs'), 0) as differs_by,
         coalesce(jsonb_agg(jsonb_build_object('account', account_name, 'type', account_type,
                                               'silo', silo_amount, 'quickbooks', quickbooks_amount)
                            order by differs_by desc, account_name)
                  filter (where status = 'differs'), '[]'::jsonb) as accounts
    from rows group by 1, 2
)
select p.company_entity_id, p.period_start, p.read_through,
       (a.period_start is not null) as checked,
       case when a.period_start is null then p.balances_read_at end is not null as stale,
       p.balances_read_at as checked_at, p.balances_error,
       coalesce(a.compared, 0) as compared, coalesce(a.matched, 0) as matched,
       coalesce(a.differing, 0) as differing, coalesce(a.not_compared, 0) as not_compared,
       coalesce(a.differs_by, 0) as differs_by, coalesce(a.accounts, '[]'::jsonb) as accounts
  from public.quickbooks_ledger_mirror_periods p
  join public.accounting_settings s
    on s.company_entity_id = p.company_entity_id and s.qbo_connection_id = p.qbo_connection_id
  left join agg a on a.company_entity_id = p.company_entity_id and a.period_start = p.period_start
 where p.read_at is not null;

comment on view public.quickbooks_balance_check_months_v is
  'One row per month read back from QuickBooks: checked (balances were read for the lines now stored), compared / matched / differing / not_compared account counts, differs_by (the sum of the differences), and accounts (each account that differs, with SILO''s and QuickBooks'' movement, +debit / -credit). checked = false means the month has no usable balances yet (balances_error says why when a read failed). From quickbooks_balance_check_v. Finance users of the company only. security_invoker. 20261127213000.';

revoke all on public.quickbooks_balance_check_months_v from public, anon, authenticated;
grant select on public.quickbooks_balance_check_months_v to authenticated;

select public.attach_stamp_company_entity_id_triggers();

-- Ask SILO's map.
select public.refresh_chat_schema_catalog();
update public.silo_chat_schema_catalog set
  description = $d$SILO's books against QuickBooks, one row per month and account: silo_amount is what SILO's books show moved on the account in the month, quickbooks_amount is the same movement from QuickBooks' own Profit and Loss and Trial Balance reports (+debit / -credit), status is match, differs or not_compared (QuickBooks computes the account, e.g. retained earnings), quickbooks_ending is QuickBooks' balance at the end of the read. USE THIS to answer "do SILO's books match QuickBooks" or "which accounts differ from QuickBooks". Who posted an entry plays no part. Finance users only.$d$,
  keywords = array['match quickbooks','tie out','reconcile to quickbooks','accounts differ','balance check','trial balance'],
  updated_at = now()
where relname = 'quickbooks_balance_check_v';
update public.silo_chat_schema_catalog set
  description = $d$One row per month read back from QuickBooks: checked (QuickBooks' balances were read for the month), how many accounts were compared, matched and differ, and the accounts that differ with both amounts. For the account rows use quickbooks_balance_check_v. Finance users only.$d$,
  keywords = array['match quickbooks by month','tie out','months that differ from quickbooks'],
  updated_at = now()
where relname = 'quickbooks_balance_check_months_v';
update public.silo_chat_schema_catalog set
  description = $d$QuickBooks' own balances per month and account, as its Profit and Loss and Trial Balance reports state them (activity = what moved in the month, ending = where the account stood; +debit / -credit). Replaced on every read. Prefer quickbooks_balance_check_v, which compares them with SILO's books.$d$,
  keywords = array['quickbooks balances','trial balance from quickbooks'],
  updated_at = now()
where relname = 'quickbooks_ledger_mirror_balances';
