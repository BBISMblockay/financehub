-- Reclassify a transaction whose period is already posted to QuickBooks.
--
-- A posted card/bank import is frozen: RLS refuses coding edits once its batch
-- leaves draft/categorized, and its QuickBooks entry is the approved snapshot.
-- Until now the only way to change one row's category was to delete the whole
-- month's entry in QuickBooks, mark it unposted, reopen, recode, re-approve and
-- re-post -- or hand-write an adjustment SILO never tied back to the row.
--
-- A reclass leaves the posted entry and the transaction row untouched. It
-- stages a two-line journal adjustment (to account on the transaction's side,
-- from account on the other, same amount) that goes through the existing
-- composer review and quickbooks-post-journal, and records which transaction it
-- moves, from what, to what, and why.
--
-- Deliberately NOT a SILO ledger entry: Books -> Ledger already counts every
-- posted QuickBooks journal (adjustments included) next to the ledger's lines,
-- so recording the reclass in ledger_entries too would count it twice. Journal
-- adjustments are not ledger entries yet; a reclass is a journal adjustment.
--
-- Guards (every one is a refusal, never a silent skip):
--   * staging: finance only, active company, the batch is POSTED, the row is
--     coded, single-account, non-zero, settled, purchase/refund on a bank feed,
--     no open bank change, no other reclass awaiting approval or posting, the
--     target account/location/entity is active in the batch's connection, and
--     the date is on/after the original entry and after the period lock;
--   * approval: the adjustment's lines, connection and date must still be
--     exactly what the reclass describes (drafts are editable through RLS and
--     the composer), and the batch must still be posted;
--   * void: a reclass cannot be unposted while a later reclass of the same
--     transaction is active (the later one moves money from this one's target);
--   * reopen: a batch with an active reclass cannot go back to draft, since
--     recoding it there would move the same amount a second time.

create table if not exists public.card_transaction_reclasses (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  transaction_id uuid not null,
  batch_id uuid not null references public.card_import_batches(id),
  adjustment_id uuid not null unique,
  qbo_connection_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  -- The side the transaction's own line sits on in the posted entry: Debit for a
  -- charge, Credit for a refund. The target takes this side; the source the other.
  original_posting_type text not null check (original_posting_type in ('Debit', 'Credit')),
  from_qbo_account_id text not null,
  from_qbo_account_name text,
  from_qbo_location_id text,
  from_qbo_location_name text,
  from_entity_type text check (from_entity_type in ('Customer', 'Vendor')),
  from_entity_qbo_id text,
  from_entity_name text,
  to_qbo_account_id text not null,
  to_qbo_account_name text,
  to_qbo_location_id text,
  to_qbo_location_name text,
  to_entity_type text check (to_entity_type in ('Customer', 'Vendor')),
  to_entity_qbo_id text,
  to_entity_name text,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default clock_timestamp(),
  check ((from_entity_type is null) = (from_entity_qbo_id is null)),
  check ((to_entity_type is null) = (to_entity_qbo_id is null)),
  constraint card_transaction_reclasses_txn_company_fkey foreign key (transaction_id, company_entity_id)
    references public.card_transactions(id, company_entity_id),
  -- Discarding the draft adjustment discards the reclass with it.
  constraint card_transaction_reclasses_adjustment_company_fkey foreign key (adjustment_id, company_entity_id)
    references public.journal_adjustments(id, company_entity_id) on delete cascade
);
create index if not exists card_transaction_reclasses_txn
  on public.card_transaction_reclasses(company_entity_id, transaction_id, created_at);
create index if not exists card_transaction_reclasses_batch on public.card_transaction_reclasses(batch_id);

alter table public.card_transaction_reclasses enable row level security;
drop policy if exists card_transaction_reclasses_select on public.card_transaction_reclasses;
create policy card_transaction_reclasses_select on public.card_transaction_reclasses for select to authenticated
  using (company_entity_id = public.active_company_id());
revoke all on public.card_transaction_reclasses from public, anon, authenticated;
grant select on public.card_transaction_reclasses to authenticated;

-- What the Transactions page reads: each reclass with its adjustment's state.
-- adjustment_status 'posted' = in QuickBooks; 'draft'/'approved' = awaiting
-- review or posting (an unposted void returns an adjustment to 'approved').
create or replace view public.card_transaction_reclasses_v with (security_invoker = true) as
select r.id, r.company_entity_id, r.transaction_id, r.batch_id, r.adjustment_id, r.amount,
       r.from_qbo_account_id, r.from_qbo_account_name, r.from_qbo_location_id, r.from_qbo_location_name,
       r.from_entity_type, r.from_entity_qbo_id, r.from_entity_name,
       r.to_qbo_account_id, r.to_qbo_account_name, r.to_qbo_location_id, r.to_qbo_location_name,
       r.to_entity_type, r.to_entity_qbo_id, r.to_entity_name,
       r.reason, r.created_by, r.created_at,
       a.status as adjustment_status, a.entry_date, p.qbo_doc_number, p.qbo_journal_entry_id
  from public.card_transaction_reclasses r
  join public.journal_adjustments a on a.id = r.adjustment_id and a.company_entity_id = r.company_entity_id
  left join public.quickbooks_journal_postings p on p.id = a.posting_id;
revoke all on public.card_transaction_reclasses_v from public, anon, authenticated;
grant select on public.card_transaction_reclasses_v to authenticated;

-- ── Stage a reclass ─────────────────────────────────────────────────────────
-- Writes a DRAFT journal adjustment and the reclass record in one transaction.
-- Nothing reaches QuickBooks here: the page then opens the composer's review of
-- the stored draft, and only Approve & post sends it.
create or replace function public.stage_card_transaction_reclass(
  p_transaction_id uuid, p_to_account_id text, p_to_location_id text,
  p_to_entity_type text, p_to_entity_id text, p_entry_date date, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  t public.card_transactions%rowtype;
  b public.card_import_batches%rowtype;
  v_conn uuid; v_lock date; v_min date; v_date date;
  v_from_acct text; v_from_acct_name text; v_from_loc text; v_from_loc_name text;
  v_from_ent_type text; v_from_ent text; v_from_ent_name text;
  v_to_acct_name text; v_to_type text; v_to_loc_name text; v_to_ent_name text;
  v_to_loc text := nullif(btrim(coalesce(p_to_location_id, '')), '');
  v_to_ent_type text := nullif(btrim(coalesce(p_to_entity_type, '')), '');
  v_to_ent text := nullif(btrim(coalesce(p_to_entity_id, '')), '');
  v_side text; v_other text; v_amount numeric(14,2);
  v_id uuid := gen_random_uuid(); v_adj uuid; v_who text;
begin
  if v_user is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'Give a reason for the reclassification (3 to 500 characters)';
  end if;

  select * into t from public.card_transactions where id = p_transaction_id and company_entity_id = v_company;
  if not found then raise exception 'Transaction not found'; end if;
  -- One staging per transaction at a time: the open-reclass check below must
  -- see any reclass a concurrent call is about to commit.
  perform pg_advisory_xact_lock(hashtextextended('card_reclass:' || t.id::text, 0));
  -- FOR SHARE: a concurrent reopen or void (an UPDATE of this row) waits for us,
  -- and then meets the reopen guard below with our reclass committed.
  select * into b from public.card_import_batches where id = t.batch_id and company_entity_id = v_company for share;
  if not found then raise exception 'Import not found'; end if;
  if b.status <> 'posted' then
    raise exception 'Only a transaction in a period posted to QuickBooks is reclassified with an adjustment. %',
      case when b.status = 'approved' then 'Reopen this approval to change its coding directly.'
           else 'Change its coding directly; it is not posted.' end;
  end if;

  if t.status <> 'coded' then raise exception 'Only a categorized transaction can be reclassified'; end if;
  if exists (select 1 from public.card_transaction_splits s where s.transaction_id = t.id) then
    raise exception 'A split transaction cannot be reclassified here yet. Post a journal entry for it instead.';
  end if;
  v_amount := abs(round(t.amount, 2));
  if v_amount = 0 then raise exception 'A zero-amount transaction has nothing to reclassify'; end if;
  if t.origin = 'plaid' then
    if t.provider_status is distinct from 'posted' then raise exception 'Only a settled bank transaction can be reclassified'; end if;
    if coalesce(t.accounting_treatment, '') not in ('purchase', 'refund') then
      raise exception 'Only a purchase or refund can be reclassified here. Transfers, payments and settlements need a journal entry.';
    end if;
    if exists (select 1 from public.plaid_sync_exceptions e where e.transaction_id = t.id and e.status = 'open') then
      raise exception 'Resolve the open bank change on this transaction first';
    end if;
  end if;

  if exists (select 1 from public.card_transaction_reclasses r
               join public.journal_adjustments a on a.id = r.adjustment_id
              where r.transaction_id = t.id and a.status in ('draft', 'approved')) then
    raise exception 'This transaction already has a reclassification awaiting review or posting. Post or discard it first.';
  end if;

  v_conn := coalesce(nullif(b.approval_snapshot->>'qbo_connection_id', '')::uuid, b.qbo_connection_id);
  if v_conn is null or not exists (select 1 from public.quickbooks_connections c
                                    where c.id = v_conn and c.company_entity_id = v_company and c.is_active) then
    raise exception 'The QuickBooks connection this period was posted to is not active';
  end if;

  -- Where the amount sits now: the latest POSTED reclass's target, else the
  -- coding the period was posted with.
  select r.to_qbo_account_id, r.to_qbo_account_name, r.to_qbo_location_id, r.to_qbo_location_name,
         r.to_entity_type, r.to_entity_qbo_id, r.to_entity_name
    into v_from_acct, v_from_acct_name, v_from_loc, v_from_loc_name, v_from_ent_type, v_from_ent, v_from_ent_name
    from public.card_transaction_reclasses r
    join public.journal_adjustments a on a.id = r.adjustment_id
   where r.transaction_id = t.id and a.status = 'posted'
   order by r.created_at desc limit 1;
  if v_from_acct is null then
    v_from_acct := t.qbo_account_id; v_from_acct_name := t.qbo_account_name;
    v_from_loc := t.qbo_location_id; v_from_loc_name := t.qbo_location_name;
    v_from_ent_type := t.entity_type; v_from_ent := t.entity_qbo_id; v_from_ent_name := t.entity_name;
    if v_from_ent is null then v_from_ent_type := null; end if;
  end if;
  if v_from_acct is null then raise exception 'This transaction has no category to move from'; end if;

  select a.name, a.account_type into v_to_acct_name, v_to_type from public.quickbooks_accounts a
   where a.connection_id = v_conn and a.company_entity_id = v_company
     and a.qbo_account_id = p_to_account_id and a.is_active;
  if not found then raise exception 'Choose an active account from this period''s QuickBooks chart'; end if;
  if v_to_loc is not null then
    select l.fully_qualified_name into v_to_loc_name from public.quickbooks_locations l
     where l.connection_id = v_conn and l.company_entity_id = v_company and l.qbo_location_id = v_to_loc and l.is_active;
    if not found then raise exception 'Choose an active location'; end if;
    v_to_loc_name := coalesce(v_to_loc_name, (select l.name from public.quickbooks_locations l
      where l.connection_id = v_conn and l.company_entity_id = v_company and l.qbo_location_id = v_to_loc));
  end if;
  if (v_to_ent is null) <> (v_to_ent_type is null) then raise exception 'A customer or vendor needs both its type and id'; end if;
  if v_to_ent is not null then
    if v_to_ent_type = 'Customer' then
      select c.display_name into v_to_ent_name from public.quickbooks_customers c
       where c.connection_id = v_conn and c.company_entity_id = v_company and c.qbo_customer_id = v_to_ent and c.is_active;
    elsif v_to_ent_type = 'Vendor' then
      select v.display_name into v_to_ent_name from public.quickbooks_vendors v
       where v.connection_id = v_conn and v.company_entity_id = v_company and v.qbo_vendor_id = v_to_ent and v.is_active;
    else raise exception 'Entity type must be Customer or Vendor';
    end if;
    if not found then raise exception 'Choose an active customer or vendor'; end if;
  end if;
  if v_to_type = 'Accounts Receivable' and v_to_ent_type is distinct from 'Customer' then
    raise exception 'A receivable account needs a customer';
  end if;
  if v_to_type = 'Accounts Payable' and v_to_ent_type is distinct from 'Vendor' then
    raise exception 'A payable account needs a vendor';
  end if;
  if p_to_account_id = v_from_acct and v_to_loc is not distinct from v_from_loc
     and v_to_ent is not distinct from v_from_ent and v_to_ent_type is not distinct from v_from_ent_type then
    raise exception 'Nothing to reclassify: the account, location and entity are unchanged';
  end if;

  -- The original entry carries the whole period on the batch's entry date; a
  -- reclass dated earlier would put a balance on the old account QuickBooks
  -- never had. Nothing is dated into a locked period.
  v_lock := public.silo_ledger_locked_through(v_company);
  v_min := greatest(coalesce(b.entry_date, t.txn_date), coalesce(v_lock + 1, coalesce(b.entry_date, t.txn_date)));
  v_date := coalesce(p_entry_date, v_min);
  if v_date < coalesce(b.entry_date, t.txn_date) then
    raise exception 'Date the reclass on or after the original entry (%)', coalesce(b.entry_date, t.txn_date);
  end if;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'The books are locked through %; date the reclass after that', v_lock;
  end if;

  v_side := case when t.amount > 0 then 'Debit' else 'Credit' end;
  v_other := case when v_side = 'Debit' then 'Credit' else 'Debit' end;
  v_who := left(coalesce(t.clean_merchant, t.description, 'transaction'), 120);

  insert into public.journal_adjustments(company_entity_id, entry_date, memo, source_context, status,
    qbo_connection_id, accounting_source, accounting_source_ref)
  values (v_company, v_date,
    left(format('Reclass %s %s %s: %s to %s. %s', v_who, t.txn_date, v_amount,
      coalesce(v_from_acct_name, v_from_acct), coalesce(v_to_acct_name, p_to_account_id), v_reason), 1000),
    'transactions:reclass:' || t.id, 'draft', v_conn, 'card_reclass', 'card-reclass:' || v_id)
  returning id into v_adj;

  insert into public.journal_adjustment_lines(company_entity_id, adjustment_id, line_no, qbo_account_id, qbo_account_name,
    posting_type, amount, description, qbo_location_id, qbo_location_name, entity_qbo_id, entity_name, entity_type)
  values
    (v_company, v_adj, 1, p_to_account_id, v_to_acct_name, v_side, v_amount,
     left('Reclass to · ' || t.txn_date || ' · ' || v_who, 4000), v_to_loc, v_to_loc_name, v_to_ent, v_to_ent_name, v_to_ent_type),
    (v_company, v_adj, 2, v_from_acct, v_from_acct_name, v_other, v_amount,
     left('Reclass from · ' || t.txn_date || ' · ' || v_who, 4000), v_from_loc, v_from_loc_name, v_from_ent, v_from_ent_name, v_from_ent_type);

  insert into public.card_transaction_reclasses(id, company_entity_id, transaction_id, batch_id, adjustment_id, qbo_connection_id,
    amount, original_posting_type,
    from_qbo_account_id, from_qbo_account_name, from_qbo_location_id, from_qbo_location_name,
    from_entity_type, from_entity_qbo_id, from_entity_name,
    to_qbo_account_id, to_qbo_account_name, to_qbo_location_id, to_qbo_location_name,
    to_entity_type, to_entity_qbo_id, to_entity_name, reason, created_by)
  values (v_id, v_company, t.id, b.id, v_adj, v_conn, v_amount, v_side,
    v_from_acct, v_from_acct_name, v_from_loc, v_from_loc_name, v_from_ent_type, v_from_ent, v_from_ent_name,
    p_to_account_id, v_to_acct_name, v_to_loc, v_to_loc_name, v_to_ent_type, v_to_ent, v_to_ent_name, v_reason, v_user);

  return jsonb_build_object('reclass_id', v_id, 'adjustment_id', v_adj, 'entry_date', v_date);
end $$;
revoke all on function public.stage_card_transaction_reclass(uuid, text, text, text, text, date, text) from public, anon, authenticated;
grant execute on function public.stage_card_transaction_reclass(uuid, text, text, text, text, date, text) to authenticated;

-- ── The adjustment must stay the reclass it was staged as ──────────────────
create or replace function public.card_reclass_guard_adjustment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.card_transaction_reclasses%rowtype; v_lock date; v_ok boolean;
begin
  if old.accounting_source is distinct from new.accounting_source
     or (old.accounting_source = 'card_reclass' and old.accounting_source_ref is distinct from new.accounting_source_ref) then
    if old.accounting_source = 'card_reclass' or new.accounting_source = 'card_reclass' then
      raise exception 'A reclassification adjustment keeps its source';
    end if;
  end if;
  if new.accounting_source is distinct from 'card_reclass' then return new; end if;

  select * into r from public.card_transaction_reclasses where adjustment_id = new.id;

  if old.status = 'draft' and new.status = 'approved' then
    if r.id is null then raise exception 'This adjustment has no reclassification record; stage it from Transactions'; end if;
    if new.accounting_source_ref is distinct from 'card-reclass:' || r.id then
      raise exception 'Reclassification adjustment source does not match its record';
    end if;
    if new.qbo_connection_id is distinct from r.qbo_connection_id then
      raise exception 'A reclassification posts to the QuickBooks connection its period was posted to';
    end if;
    if not exists (select 1 from public.card_import_batches b where b.id = r.batch_id and b.status = 'posted') then
      raise exception 'The original period is no longer posted to QuickBooks; discard this reclassification';
    end if;
    v_lock := public.silo_ledger_locked_through(new.company_entity_id);
    if v_lock is not null and new.entry_date <= v_lock then
      raise exception 'The books are locked through %; date the reclass after that', v_lock;
    end if;
    if new.entry_date < (select coalesce(b.entry_date, t.txn_date) from public.card_import_batches b
                           join public.card_transactions t on t.id = r.transaction_id where b.id = r.batch_id) then
      raise exception 'Date the reclass on or after the original entry';
    end if;
    -- Exactly the two staged lines: target on the transaction's side, source on the other.
    select count(*) = 2
       and count(*) filter (where l.line_no = 1 and l.qbo_account_id = r.to_qbo_account_id
             and l.posting_type = r.original_posting_type and l.amount = r.amount
             and l.qbo_location_id is not distinct from r.to_qbo_location_id
             and l.entity_qbo_id is not distinct from r.to_entity_qbo_id
             and l.entity_type is not distinct from r.to_entity_type) = 1
       and count(*) filter (where l.line_no = 2 and l.qbo_account_id = r.from_qbo_account_id
             and l.posting_type <> r.original_posting_type and l.amount = r.amount
             and l.qbo_location_id is not distinct from r.from_qbo_location_id
             and l.entity_qbo_id is not distinct from r.from_entity_qbo_id
             and l.entity_type is not distinct from r.from_entity_type) = 1
      into v_ok
      from public.journal_adjustment_lines l where l.adjustment_id = new.id;
    if not v_ok then
      raise exception 'The reclassification lines were edited. Discard it and reclassify from Transactions again.';
    end if;
  end if;

  -- The staging lock: a concurrent stage reading this reclass as posted (and so
  -- moving FROM its target) either commits first and is seen here, or waits and
  -- then reads it as unposted.
  if old.status = 'posted' and new.status <> 'posted' and r.id is not null then
    perform pg_advisory_xact_lock(hashtextextended('card_reclass:' || r.transaction_id::text, 0));
  end if;
  if old.status = 'posted' and new.status <> 'posted' and r.id is not null and exists (
       select 1 from public.card_transaction_reclasses later
         join public.journal_adjustments a on a.id = later.adjustment_id
        where later.transaction_id = r.transaction_id and later.created_at > r.created_at
          and a.status in ('draft', 'approved', 'posted')) then
    raise exception 'A later reclassification of this transaction moves money from this one. Unpost and discard that one first.';
  end if;
  return new;
end $$;
revoke all on function public.card_reclass_guard_adjustment() from public, anon, authenticated;
drop trigger if exists card_reclass_guard_adjustment on public.journal_adjustments;
create trigger card_reclass_guard_adjustment before update on public.journal_adjustments
  for each row execute function public.card_reclass_guard_adjustment();

-- ── A reclassified period cannot be recoded underneath its reclass ─────────
create or replace function public.card_reclass_guard_batch_reopen()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status in ('approved', 'posted') and new.status in ('draft', 'categorized') and exists (
       select 1 from public.card_transaction_reclasses r
         join public.journal_adjustments a on a.id = r.adjustment_id
        where r.batch_id = new.id and a.status in ('draft', 'approved', 'posted')) then
    raise exception 'This period has transaction reclassifications. Unpost and discard them before reopening it, or recoding would move the same amounts twice.';
  end if;
  return new;
end $$;
revoke all on function public.card_reclass_guard_batch_reopen() from public, anon, authenticated;
drop trigger if exists card_reclass_guard_batch_reopen on public.card_import_batches;
create trigger card_reclass_guard_batch_reopen before update of status on public.card_import_batches
  for each row execute function public.card_reclass_guard_batch_reopen();

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
