-- SILO's own ledger, recorded daily, one transaction at a time.
--
-- Until now SILO had no ledger of its own: a card or bank transaction reached
-- "the books" only when its whole MONTHLY import batch was approved and posted
-- to QuickBooks (Books -> Ledger counted posted QuickBooks payloads only). A
-- transaction categorized on the 3rd was invisible to SILO's books until month
-- end. Decided with Blake 2026-10-04:
--
--   * The SILO ledger records a transaction the moment it is categorized
--     (coded, with an account) and settled. No batch approval, no "journal".
--   * The QuickBooks push stays monthly and optional; it is the existing batch
--     approval + quickbooks-post-journal path, unchanged here.
--   * Saved-rule matches record automatically; AI suggestions record only once
--     a person accepts them (accepting is what codes the row). Server-side rule
--     application at bank sync is the next PR.
--
-- Design, each rule enforced here rather than by callers:
--   * ONE source of truth for what a transaction posts: card_coding_effective_lines
--     (split lines or the single line) plus the balancing line on the source's
--     account, built exactly as approve_card_import_batch builds a batch, per
--     transaction instead of per batch. No second definition of a posted line.
--   * Settled only: a Plaid row records once provider_status = 'posted'; a
--     pending or removed row records nothing (a removal reverses what exists).
--   * Never before the books start: a transaction dated on or before the
--     accepted opening balances, or before a bank feed's authoritative_from, is
--     already inside the opening balances and is never recorded again.
--   * Append-only: ledger rows are never updated or deleted. A changed
--     transaction writes a REVERSAL of its active entry plus a new entry, so the
--     history shows what changed and when.
--   * Period lock: nothing is dated on or before accounting_period_locks.locked_through.
--     A correction to a locked month is dated the first open day instead.
--   * Recorded by deferred constraint triggers, so a transaction whose splits are
--     replaced in several statements is recorded once, from its final state.
--   * Every entry balances to the cent (checked in the writer and again by a
--     deferred trigger that a service-role write cannot dodge).
--   * Only VALID coding is recorded: silo_ledger_blocker() runs the checks the
--     QuickBooks approval runs (active accounts, locations and entities, the
--     AR/AP entity rule, the balancing account and its vendor/customer, split
--     totals, and for a bank feed USD data, a known treatment, direction and
--     clearing-account type). A coded row that fails stays OUT of the ledger
--     and On Deck shows it as needs input (silo_ledger_batch_status()).
--   * History is frozen while an approval snapshot is live (batch 'approved' or
--     'posted'): QuickBooks receives exactly that frozen snapshot, so a source
--     remap must not rewrite SILO's entry for it. Reopening the batch (which
--     discards the approval) resyncs it; marking a post unposted keeps the
--     snapshot and stays frozen.
--   * The connection is resolved once (silo_ledger_connection) and stored on
--     the entry, so Books -> Ledger (which filters by connection) can read it.
--   * One per-company advisory lock orders recording against the period lock:
--     recording takes it SHARED, set_accounting_period_lock takes it EXCLUSIVE.
--   * Accepting opening balances (or moving the start date) records every
--     already-coded transaction for that company, under the company lock taken
--     EXCLUSIVE so a coding save in flight cannot slip between the two.
--
-- Clients cannot write any of this. Read: finance population, active company.

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  entry_date date not null,
  source text not null check (source in ('card_transaction')),
  source_id uuid not null,
  kind text not null check (kind in ('original', 'reversal')),
  reverses_entry_id uuid references public.ledger_entries(id),
  fingerprint text not null,
  qbo_connection_id uuid,
  memo text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid,
  check ((kind = 'reversal') = (reverses_entry_id is not null))
);
create unique index if not exists ledger_entries_one_reversal on public.ledger_entries(reverses_entry_id) where reverses_entry_id is not null;
create index if not exists ledger_entries_source on public.ledger_entries(company_entity_id, source, source_id, recorded_at);
create index if not exists ledger_entries_date on public.ledger_entries(company_entity_id, entry_date);

create table if not exists public.ledger_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.ledger_entries(id),
  company_entity_id uuid not null references public.entities(id),
  line_no integer not null,
  qbo_account_id text not null,
  posting_type text not null check (posting_type in ('Debit', 'Credit')),
  amount numeric(14,2) not null check (amount > 0),
  qbo_location_id text,
  entity_type text,
  entity_qbo_id text,
  description text,
  unique (entry_id, line_no)
);
create index if not exists ledger_lines_account on public.ledger_lines(company_entity_id, qbo_account_id);

create table if not exists public.accounting_period_locks (
  company_entity_id uuid primary key references public.entities(id),
  locked_through date not null,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  locked_by uuid,
  locked_at timestamptz not null default now()
);

-- ── Append-only ─────────────────────────────────────────────────────────────
create or replace function public.ledger_deny_mutation()
returns trigger language plpgsql as $$
begin raise exception 'The SILO ledger is append-only: record a reversal instead'; end $$;
drop trigger if exists ledger_entries_immutable on public.ledger_entries;
create trigger ledger_entries_immutable before update or delete or truncate on public.ledger_entries
  for each statement execute function public.ledger_deny_mutation();
drop trigger if exists ledger_lines_immutable on public.ledger_lines;
create trigger ledger_lines_immutable before update or delete or truncate on public.ledger_lines
  for each statement execute function public.ledger_deny_mutation();

-- Every entry balances. Deferred: the writer inserts lines one at a time.
create or replace function public.ledger_entry_must_balance()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_dr numeric; v_cr numeric; v_n integer;
begin
  select coalesce(sum(amount) filter (where posting_type = 'Debit'), 0),
         coalesce(sum(amount) filter (where posting_type = 'Credit'), 0), count(*)
    into v_dr, v_cr, v_n
  from public.ledger_lines where entry_id = new.entry_id;
  if v_n < 2 or v_dr <> v_cr then
    raise exception 'Ledger entry % does not balance (debits %, credits %)', new.entry_id, v_dr, v_cr;
  end if;
  return null;
end $$;
drop trigger if exists ledger_lines_balance on public.ledger_lines;
create constraint trigger ledger_lines_balance after insert on public.ledger_lines
  deferrable initially deferred for each row execute function public.ledger_entry_must_balance();

-- ── When the books start for a source ───────────────────────────────────────
-- The day after the accepted opening balances, or a bank feed's
-- authoritative_from if later. NULL = no accepted opening balances: nothing is
-- recorded, because a ledger with no opening has no balance to add to.
create or replace function public.silo_ledger_start(p_source public.card_sources)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(st.accounting_start_date, coalesce(p_source.authoritative_from, st.accounting_start_date))
  from public.accounting_settings st
  join public.accounting_opening_balances ob on ob.company_entity_id = st.company_entity_id and ob.status = 'accepted'
  where st.company_entity_id = p_source.company_entity_id;
$$;

create or replace function public.silo_ledger_locked_through(p_company uuid)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select locked_through from public.accounting_period_locks where company_entity_id = p_company;
$$;

-- ── Which QuickBooks connection a batch's chart comes from ──────────────────
-- Same resolution as approve_card_import_batch: the source's, else the batch's,
-- else the company's single active connection.
create or replace function public.silo_ledger_connection(p_batch uuid)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b public.card_import_batches%rowtype; s public.card_sources%rowtype; v_conn uuid; v_n integer;
begin
  select * into b from public.card_import_batches where id = p_batch;
  select * into s from public.card_sources where id = b.source_id;
  v_conn := coalesce(s.qbo_connection_id, b.qbo_connection_id);
  if v_conn is null then
    select count(*), (array_agg(id order by id))[1] into v_n, v_conn
      from public.quickbooks_connections where company_entity_id = b.company_entity_id and is_active;
    if v_n <> 1 then return null; end if;
  end if;
  if not exists (select 1 from public.quickbooks_connections
                 where id = v_conn and company_entity_id = b.company_entity_id and is_active) then
    return null;
  end if;
  return v_conn;
end $$;

-- ── Why a coded transaction cannot be recorded (NULL = it can, or it is not
--    the ledger's to record) ─────────────────────────────────────────────────
-- The per-transaction form of approve_card_import_batch's checks and of the
-- bank-feed approval trigger's treatment/direction checks, so recording is held
-- to the same standard the QuickBooks approval is. Reasons are the sentence
-- On Deck shows. A posted batch is never blocked: QuickBooks accepted it.
create or replace function public.silo_ledger_blocker(p_txn uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t public.card_transactions%rowtype; b public.card_import_batches%rowtype; s public.card_sources%rowtype;
  v_start date; v_conn uuid; v_bal text;
begin
  select * into t from public.card_transactions where id = p_txn;
  if not found or t.status <> 'coded' then return null; end if;
  if t.origin = 'plaid' and t.provider_status is distinct from 'posted' then return null; end if;
  select * into b from public.card_import_batches where id = t.batch_id;
  if b.status = 'posted' then return null; end if;
  select * into s from public.card_sources where id = b.source_id;
  if s.id is null then return 'The card or bank account for this import is missing'; end if;
  v_start := public.silo_ledger_start(s);
  if v_start is null then return 'The SILO ledger starts once opening balances are accepted'; end if;
  if t.txn_date is null or t.txn_date < v_start then return null; end if;   -- inside the opening balances
  if not s.is_active then return 'This card or bank account is switched off'; end if;
  v_conn := public.silo_ledger_connection(b.id);
  if v_conn is null then return 'Choose one active QuickBooks connection for this account'; end if;

  if s.credit_qbo_account_id is null then return 'Choose the balancing account for this card or bank account'; end if;
  select account_type into v_bal from public.quickbooks_accounts
   where connection_id = v_conn and company_entity_id = s.company_entity_id
     and qbo_account_id = s.credit_qbo_account_id and is_active;
  if not found then return 'The balancing account is not active in the chart of accounts'; end if;
  if s.default_qbo_location_id is not null and not exists (
    select 1 from public.quickbooks_locations where connection_id = v_conn and company_entity_id = s.company_entity_id
      and qbo_location_id = s.default_qbo_location_id and is_active)
  then return 'The default location is not active'; end if;
  if v_bal = 'Accounts Payable' and (s.credit_vendor_qbo_id is null or not exists (
    select 1 from public.quickbooks_vendors where connection_id = v_conn and company_entity_id = s.company_entity_id
      and qbo_vendor_id = s.credit_vendor_qbo_id and is_active))
  then return 'The balancing payable account needs a valid vendor'; end if;
  if v_bal = 'Accounts Receivable' and (s.credit_vendor_qbo_id is null or not exists (
    select 1 from public.quickbooks_customers where connection_id = v_conn and company_entity_id = s.company_entity_id
      and qbo_customer_id = s.credit_vendor_qbo_id and is_active))
  then return 'The balancing receivable account needs a valid customer'; end if;

  -- Per posted line, through the ONE definition of a posted line.
  if exists (select 1 from public.card_coding_effective_lines e
             left join public.quickbooks_accounts a on a.connection_id = v_conn and a.company_entity_id = t.company_entity_id
              and a.qbo_account_id = e.qbo_account_id and a.is_active
             where e.transaction_id = t.id and round(e.amount, 2) <> 0 and (e.qbo_account_id is null or a.id is null))
  then return 'A category is not an active account in the chart of accounts'; end if;
  if exists (select 1 from public.card_coding_effective_lines e
             where e.transaction_id = t.id and e.qbo_location_id is not null and not exists (
               select 1 from public.quickbooks_locations l where l.connection_id = v_conn
                 and l.company_entity_id = t.company_entity_id and l.qbo_location_id = e.qbo_location_id and l.is_active))
  then return 'A location is not active'; end if;
  if exists (select 1 from public.card_coding_effective_lines e
             join public.quickbooks_accounts a on a.connection_id = v_conn and a.company_entity_id = t.company_entity_id
              and a.qbo_account_id = e.qbo_account_id
             where e.transaction_id = t.id and a.account_type in ('Accounts Receivable', 'Accounts Payable')
               and e.entity_qbo_id is null)
  then return 'Receivable and payable categories need a customer or vendor'; end if;
  if exists (select 1 from public.card_coding_effective_lines e
             where e.transaction_id = t.id and ((e.entity_qbo_id is null) <> (e.entity_type is null)))
  then return 'A customer or vendor is incomplete'; end if;
  if exists (select 1 from public.card_coding_effective_lines e
             where e.transaction_id = t.id and e.entity_qbo_id is not null and not (
               (e.entity_type = 'Customer' and exists (select 1 from public.quickbooks_customers c where c.connection_id = v_conn
                  and c.company_entity_id = t.company_entity_id and c.qbo_customer_id = e.entity_qbo_id and c.is_active)) or
               (e.entity_type = 'Vendor' and exists (select 1 from public.quickbooks_vendors ve where ve.connection_id = v_conn
                  and ve.company_entity_id = t.company_entity_id and ve.qbo_vendor_id = e.entity_qbo_id and ve.is_active))))
  then return 'A customer or vendor is not active'; end if;
  if exists (select 1 from (select sum(amount) total from public.card_transaction_splits where transaction_id = t.id) x
             where x.total is not null and round(x.total, 2) <> round(t.amount, 2))
  then return 'A split does not total its transaction'; end if;

  if t.origin = 'plaid' then
    if exists (select 1 from public.plaid_sync_exceptions e join public.plaid_accounts a on a.id = e.account_id
               where a.source_id = s.id and e.status = 'open')
    then return 'Resolve the bank feed change first'; end if;
    if t.currency is distinct from 'USD' or t.accounting_treatment = 'unknown'
    then return 'Bank transactions need USD data and an accounting treatment'; end if;
    if (t.accounting_treatment = 'purchase' and t.amount <= 0)
       or (t.accounting_treatment in ('refund', 'deposit') and t.amount >= 0)
       or exists (select 1 from public.card_coding_effective_lines e
                  join public.quickbooks_accounts a on a.connection_id = v_conn and a.company_entity_id = t.company_entity_id
                   and a.qbo_account_id = e.qbo_account_id
                  where e.transaction_id = t.id and (
                    (t.accounting_treatment in ('transfer', 'payroll_settlement', 'shopify_settlement')
                      and a.account_type not in ('Other Current Asset', 'Other Current Liability'))
                    or (t.accounting_treatment = 'card_payment'
                      and (s.source_type = 'card' or a.account_type not in ('Credit Card', 'Accounts Payable')))))
    then return 'Review the direction and treatment: card payments and transfers belong on clearing, card or payable accounts'; end if;
  end if;
  return null;
end $$;

-- ── What one transaction posts right now ────────────────────────────────────
-- jsonb array of {posting_type, amount, qbo_account_id, qbo_location_id,
-- entity_type, entity_qbo_id, description}, or NULL when it should post
-- nothing. Mirrors approve_card_import_batch line for line, for one row.
create or replace function public.silo_ledger_desired_lines(p_txn uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t public.card_transactions%rowtype; b public.card_import_batches%rowtype; s public.card_sources%rowtype;
  v_start date; v_conn uuid; v_lines jsonb; v_net numeric(14,2); v_bal_type text;
begin
  select * into t from public.card_transactions where id = p_txn;
  if not found or t.status <> 'coded' then return null; end if;
  if t.origin = 'plaid' and t.provider_status is distinct from 'posted' then return null; end if;
  select * into b from public.card_import_batches where id = t.batch_id;
  select * into s from public.card_sources where id = b.source_id;
  if s.id is null or s.credit_qbo_account_id is null then return null; end if;
  v_start := public.silo_ledger_start(s);
  if v_start is null or t.txn_date is null or t.txn_date < v_start then return null; end if;
  -- Invalid coding is not recorded; it waits in On Deck (silo_ledger_batch_status).
  if public.silo_ledger_blocker(p_txn) is not null then return null; end if;
  v_conn := coalesce(public.silo_ledger_connection(b.id), s.qbo_connection_id, b.qbo_connection_id);

  select coalesce(round(sum(round(e.amount, 2)), 2), 0),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'posting_type', case when e.amount >= 0 then 'Debit' else 'Credit' end,
           'amount', abs(round(e.amount, 2)),
           'qbo_account_id', e.qbo_account_id,
           'qbo_location_id', coalesce(e.qbo_location_id, s.default_qbo_location_id),
           'entity_type', e.entity_type, 'entity_qbo_id', e.entity_qbo_id,
           'description', left(concat_ws(' · ', e.txn_date::text, e.description,
             case when e.is_split then coalesce(nullif(e.memo, ''), 'split ' || e.line_no::text) end), 4000)))
           order by e.line_no)
    into v_net, v_lines
  from public.card_coding_effective_lines e
  where e.transaction_id = t.id and round(e.amount, 2) <> 0 and e.qbo_account_id is not null;
  if v_lines is null or v_net = 0 then return null; end if;

  select account_type into v_bal_type from public.quickbooks_accounts
   where company_entity_id = s.company_entity_id and connection_id = v_conn and qbo_account_id = s.credit_qbo_account_id;
  return v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'posting_type', case when v_net >= 0 then 'Credit' else 'Debit' end,
    'amount', abs(v_net),
    'qbo_account_id', s.credit_qbo_account_id,
    'qbo_location_id', s.default_qbo_location_id,
    'entity_type', case when s.credit_vendor_qbo_id is not null then
      case when v_bal_type = 'Accounts Receivable' then 'Customer' else 'Vendor' end end,
    'entity_qbo_id', s.credit_vendor_qbo_id,
    'description', left(trim(s.display_name || ' · ' || coalesce(t.description, '')), 4000))));
end $$;

-- ── Bring the ledger in line with one transaction ───────────────────────────
-- Idempotent: an unchanged transaction writes nothing. A changed one reverses
-- its active entry (if any) and records the new state (if any).
create or replace function public.silo_ledger_sync_card_transaction(p_txn uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.card_transactions%rowtype; v_company uuid; v_lines jsonb; v_fp text;
  v_active public.ledger_entries%rowtype; v_lock date; v_date date; v_entry uuid; v_line jsonb; v_n integer;
  v_conn uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('silo_ledger:card_transaction:' || p_txn::text, 0));
  select * into t from public.card_transactions where id = p_txn;
  v_company := t.company_entity_id;
  if v_company is null then
    select company_entity_id into v_company from public.ledger_entries
     where source = 'card_transaction' and source_id = p_txn limit 1;
    if v_company is null then return; end if;
  end if;
  -- Shared per-company lock: recording never interleaves with a period-lock
  -- change (set_accounting_period_lock takes it EXCLUSIVE), so the lock read
  -- below is the lock this write commits under.
  perform pg_advisory_xact_lock_shared(hashtextextended('silo_ledger:company:' || v_company::text, 0));
  v_lines := case when t.id is null then null else public.silo_ledger_desired_lines(p_txn) end;
  -- Fingerprint the ACCOUNTING facts only (date, accounts, sides, amounts,
  -- locations, entities). Descriptions are labels: renaming a card or fixing a
  -- merchant name must not reverse and re-record every transaction.
  v_conn := case when t.id is null then null
                 else coalesce(public.silo_ledger_connection(t.batch_id),
                   (select coalesce(s2.qbo_connection_id, b2.qbo_connection_id)
                      from public.card_import_batches b2 join public.card_sources s2 on s2.id = b2.source_id
                     where b2.id = t.batch_id)) end;
  v_fp := case when v_lines is null then null
               else md5(t.txn_date::text || '|' || coalesce(v_conn::text, '') || '|' ||
                 (select jsonb_agg(x.value - 'description' order by x.ordinality)
                    from jsonb_array_elements(v_lines) with ordinality x)::text) end;

  select e.* into v_active from public.ledger_entries e
   where e.company_entity_id = v_company and e.source = 'card_transaction' and e.source_id = p_txn
     and e.kind = 'original'
     and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id)
   order by e.recorded_at desc limit 1;

  if v_active.id is not null and v_fp is not distinct from v_active.fingerprint then return; end if;
  -- Frozen while an approval snapshot is live: QuickBooks receives (or holds)
  -- exactly that snapshot, so a later source remap must not rewrite SILO's
  -- entry for it. Reopening the batch resyncs it (silo_ledger_on_batch).
  if v_active.id is not null and exists (
    select 1 from public.card_import_batches pb where pb.id = t.batch_id and pb.status in ('approved', 'posted')) then
    return;
  end if;
  if v_active.id is null and v_lines is null then return; end if;

  v_lock := public.silo_ledger_locked_through(v_company);

  if v_active.id is not null then
    v_date := greatest(v_active.entry_date, coalesce(v_lock + 1, v_active.entry_date));
    insert into public.ledger_entries(company_entity_id, entry_date, source, source_id, kind, reverses_entry_id,
      fingerprint, qbo_connection_id, memo, recorded_by)
    values (v_company, v_date, 'card_transaction', p_txn, 'reversal', v_active.id,
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
    v_date := greatest(t.txn_date, coalesce(v_lock + 1, t.txn_date));
    insert into public.ledger_entries(company_entity_id, entry_date, source, source_id, kind, fingerprint,
      qbo_connection_id, memo, recorded_by)
    values (v_company, v_date, 'card_transaction', p_txn, 'original', v_fp, v_conn,
      left(concat_ws(' · ', t.txn_date::text, coalesce(t.clean_merchant, t.description)), 4000), auth.uid())
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

-- ── Triggers: record from the final state of the transaction ────────────────
create or replace function public.silo_ledger_on_card_transaction()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.silo_ledger_sync_card_transaction(coalesce(new.id, old.id));
  return null;
end $$;
drop trigger if exists silo_ledger_card_transaction on public.card_transactions;
create constraint trigger silo_ledger_card_transaction after insert or update on public.card_transactions
  deferrable initially deferred for each row execute function public.silo_ledger_on_card_transaction();
-- A deleted transaction cannot be deferred against (the row is gone); reverse now.
drop trigger if exists silo_ledger_card_transaction_delete on public.card_transactions;
create trigger silo_ledger_card_transaction_delete after delete on public.card_transactions
  for each row execute function public.silo_ledger_on_card_transaction();

create or replace function public.silo_ledger_on_split()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.silo_ledger_sync_card_transaction(coalesce(new.transaction_id, old.transaction_id));
  return null;
end $$;
drop trigger if exists silo_ledger_split on public.card_transaction_splits;
create constraint trigger silo_ledger_split after insert or update or delete on public.card_transaction_splits
  deferrable initially deferred for each row execute function public.silo_ledger_on_split();

-- A source's balancing account, default location or feed start changes what
-- every one of its transactions posts.
create or replace function public.silo_ledger_on_source()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if (new.credit_qbo_account_id, new.default_qbo_location_id, new.credit_vendor_qbo_id, new.authoritative_from)
     is not distinct from (old.credit_qbo_account_id, old.default_qbo_location_id, old.credit_vendor_qbo_id, old.authoritative_from) then
    return null;
  end if;
  for v_id in select t.id from public.card_transactions t join public.card_import_batches b on b.id = t.batch_id
              where b.source_id = new.id and b.status not in ('approved', 'posted') loop
    perform public.silo_ledger_sync_card_transaction(v_id);
  end loop;
  return null;
end $$;
drop trigger if exists silo_ledger_source on public.card_sources;
create trigger silo_ledger_source after update on public.card_sources
  for each row execute function public.silo_ledger_on_source();

-- Reopening a batch (approved/posted -> draft/categorized) discards its approval
-- snapshot and lifts the freeze: record its current state. Marking a post
-- unposted (posted -> approved) keeps the snapshot, so it stays frozen.
create or replace function public.silo_ledger_on_batch()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if old.status in ('approved', 'posted') and new.status in ('draft', 'categorized') then
    for v_id in select id from public.card_transactions where batch_id = new.id order by txn_date, id loop
      perform public.silo_ledger_sync_card_transaction(v_id);
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists silo_ledger_batch on public.card_import_batches;
create trigger silo_ledger_batch after update of status on public.card_import_batches
  for each row execute function public.silo_ledger_on_batch();

-- The books start when opening balances are accepted (or the start date moves).
-- Nothing on a transaction changes then, so record every coded one now.
create or replace function public.silo_ledger_on_books_start()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if tg_table_name = 'accounting_opening_balances' then
    if new.status <> 'accepted' or (tg_op = 'UPDATE' and old.status = 'accepted') then return null; end if;
  elsif tg_op = 'UPDATE' and new.accounting_start_date is not distinct from old.accounting_start_date then
    return null;
  end if;
  -- EXCLUSIVE before enumerating: a coding save in flight either committed
  -- first (and is seen below) or waits here and then reads the books as started.
  perform pg_advisory_xact_lock(hashtextextended('silo_ledger:company:' || new.company_entity_id::text, 0));
  for v_id in select id from public.card_transactions
              where company_entity_id = new.company_entity_id and status = 'coded' order by txn_date, id loop
    perform public.silo_ledger_sync_card_transaction(v_id);
  end loop;
  return null;
end $$;
drop trigger if exists silo_ledger_opening_accepted on public.accounting_opening_balances;
create trigger silo_ledger_opening_accepted after insert or update of status on public.accounting_opening_balances
  for each row execute function public.silo_ledger_on_books_start();
drop trigger if exists silo_ledger_start_moved on public.accounting_settings;
create trigger silo_ledger_start_moved after insert or update of accounting_start_date on public.accounting_settings
  for each row execute function public.silo_ledger_on_books_start();

-- ── Period lock ─────────────────────────────────────────────────────────────
-- Forward only: moving the lock back is a separate, deliberate decision.
create or replace function public.set_accounting_period_lock(p_through date, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid := public.active_company_id(); v_current date;
begin
  if auth.uid() is null or v_company is null or not coalesce(public.can_manage_journal_entries(), false) then
    raise exception 'Finance access required' using errcode = '42501';
  end if;
  if p_through is null or p_through >= public.silo_business_today() then
    raise exception 'Lock a date before today';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 3 then raise exception 'Give a reason for the lock'; end if;
  -- EXCLUSIVE per-company lock (recording holds it shared): no transaction can
  -- be recording against the old lock while this one moves it, and two first
  -- locks for one company are serialised rather than both seeing "no lock".
  perform pg_advisory_xact_lock(hashtextextended('silo_ledger:company:' || v_company::text, 0));
  select locked_through into v_current from public.accounting_period_locks where company_entity_id = v_company for update;
  if v_current is not null and p_through <= v_current then
    raise exception 'The books are already locked through %', v_current;
  end if;
  insert into public.accounting_period_locks(company_entity_id, locked_through, reason, locked_by)
  values (v_company, p_through, left(btrim(p_reason), 500), auth.uid())
  on conflict (company_entity_id) do update set locked_through = excluded.locked_through,
    reason = excluded.reason, locked_by = excluded.locked_by, locked_at = now()
    where accounting_period_locks.locked_through < excluded.locked_through;   -- forward only, even under a race
  if not found then raise exception 'The books are already locked through a later date'; end if;
  return jsonb_build_object('locked_through', p_through);
end $$;

-- ── Reads ───────────────────────────────────────────────────────────────────
alter table public.ledger_entries enable row level security;
alter table public.ledger_lines enable row level security;
alter table public.accounting_period_locks enable row level security;
revoke all on public.ledger_entries, public.ledger_lines, public.accounting_period_locks from public, anon, authenticated;
grant select on public.ledger_entries, public.ledger_lines, public.accounting_period_locks to authenticated;
drop policy if exists ledger_entries_read on public.ledger_entries;
create policy ledger_entries_read on public.ledger_entries for select to authenticated
  using (company_entity_id = public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
drop policy if exists ledger_lines_read on public.ledger_lines;
create policy ledger_lines_read on public.ledger_lines for select to authenticated
  using (company_entity_id = public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
drop policy if exists accounting_period_locks_read on public.accounting_period_locks;
create policy accounting_period_locks_read on public.accounting_period_locks for select to authenticated
  using (company_entity_id = public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()));

-- One row per ledger line with its entry, and whether QuickBooks already has
-- it: the transaction's batch is posted. A posted batch's rows cannot change
-- (RLS refuses edits; a void moves the batch off 'posted'), so every entry for
-- it describes what QuickBooks holds -- and superseded pairs net to zero. The
-- recording time is deliberately NOT compared with the posting time: the
-- backfill records months that were posted long before this ledger existed.
create or replace view public.silo_ledger_lines_v with (security_invoker = true) as
select l.id, l.company_entity_id, e.qbo_connection_id, e.id as entry_id, e.entry_date, e.kind, e.source, e.source_id,
       e.memo, l.line_no, l.qbo_account_id, l.posting_type, l.amount,
       case when l.posting_type = 'Debit' then l.amount else -l.amount end as signed_amount,
       l.qbo_location_id, l.entity_type, l.entity_qbo_id, l.description, e.recorded_at,
       coalesce(b.status = 'posted', false) as in_quickbooks,
       -- The date QuickBooks carries it on: the batch's single entry date. A
       -- trial balance through an earlier day does not contain it yet.
       case when b.status = 'posted' then b.entry_date end as quickbooks_date
  from public.ledger_lines l
  join public.ledger_entries e on e.id = l.entry_id
  left join public.card_transactions t on e.source = 'card_transaction' and t.id = e.source_id
  left join public.card_import_batches b on b.id = t.batch_id;
revoke all on public.silo_ledger_lines_v from public, anon, authenticated;
grant select on public.silo_ledger_lines_v to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.set_accounting_period_lock(date, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.silo_ledger_start(public.card_sources)', 'public.silo_ledger_locked_through(uuid)',
    'public.silo_ledger_desired_lines(uuid)', 'public.silo_ledger_sync_card_transaction(uuid)',
    'public.silo_ledger_on_card_transaction()', 'public.silo_ledger_on_split()', 'public.silo_ledger_on_source()',
    'public.silo_ledger_on_batch()', 'public.silo_ledger_on_books_start()',
    'public.silo_ledger_connection(uuid)', 'public.silo_ledger_blocker(uuid)',
    'public.ledger_entry_must_balance()', 'public.ledger_deny_mutation()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── Coded but not recorded: what On Deck must show as needs input ───────────
-- One row per non-posted import that has coded transactions the ledger refused,
-- with how many and the first reason. Finance only, active company.
create or replace function public.silo_ledger_batch_status()
returns table(batch_id uuid, unrecorded integer, reason text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_co uuid := public.active_company_id();
begin
  if auth.uid() is null or v_co is null
     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then
    return;
  end if;
  return query
  select x.batch_id, count(*)::int, min(x.reason)
  from (
    select t.batch_id,
           coalesce(public.silo_ledger_blocker(t.id),
                    case when public.silo_ledger_desired_lines(t.id) is not null
                         then 'Categorized but not yet in the SILO ledger' end) as reason
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where t.company_entity_id = v_co and b.company_entity_id = v_co and t.status = 'coded' and b.status <> 'posted'
      and not exists (select 1 from public.ledger_entries e
                      where e.company_entity_id = v_co and e.source = 'card_transaction' and e.source_id = t.id
                        and e.kind = 'original'
                        and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id))
  ) x
  where x.reason is not null
  group by x.batch_id;
end $$;
revoke all on function public.silo_ledger_batch_status() from public, anon, authenticated;
grant execute on function public.silo_ledger_batch_status() to authenticated;

-- ── On Deck: a saved categorization is the finish line ──────────────────────
-- With the daily ledger, preparing the monthly QuickBooks entry is optional, so
-- Home counts only transactions waiting to be categorized; a batch whose card
-- does not send to QuickBooks is no longer "needs input".
create or replace function public.on_deck_ready_count()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  -- PL/pgSQL so this migration applies even where the On Deck objects it reads
  -- are not installed; they are resolved when the function runs.
  return jsonb_build_object(
    'coding', (select count(*) from public.on_deck_coding_items() i where i.stage = 'code'),
    -- Also any import with coded transactions the ledger refused (invalid coding).
    'needs_input', (select count(*) from public.on_deck_coding_items() i
                    where (i.stage = 'needs_input' and i.stage_reason is distinct from 'posting_disabled')
                       or (i.stage not in ('code', 'posted')
                           and exists (select 1 from public.silo_ledger_batch_status() x where x.batch_id = i.batch_id))),
    'proposals', (select count(*) from public.on_deck_proposals p
                  where p.company_entity_id = public.active_company_id() and p.status = 'ready'));
end;
$$;
revoke all on function public.on_deck_ready_count() from public, anon, authenticated;
grant execute on function public.on_deck_ready_count() to authenticated;

-- ── Backfill: record every transaction already categorized ──────────────────
-- Idempotent (an unchanged transaction writes nothing), so a re-run is a no-op.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.card_transactions where status = 'coded' order by txn_date, id loop
    perform public.silo_ledger_sync_card_transaction(v_id);
  end loop;
end $$;

select public.attach_stamp_company_entity_id_triggers();
