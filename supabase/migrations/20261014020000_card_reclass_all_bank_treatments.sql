-- Reclassify ANY posted bank transaction, not only purchases and refunds.
--
-- 20261013180000 refused every bank treatment except purchase/refund, telling
-- the user such rows "need a journal entry" -- but a reclass IS a journal entry,
-- and the refusal covered most posted bank activity: 320 deposits (to Accounts
-- Receivable), 70 transfers and 30 card payments in production on 2026-10-14,
-- against 140 purchases and refunds.
--
-- A row keeps its treatment; what a reclass changes is the account, so the
-- target is held to the account rule that treatment already has everywhere a
-- bank line is validated (silo_ledger_blocker, batch approval):
--   * transfer, payroll settlement, Shopify settlement -> Other Current Asset or
--     Other Current Liability (a clearing account);
--   * card payment -> Credit Card or Accounts Payable, never on a card source;
--   * purchase, refund, deposit -> any account (receivable/payable still need
--     their customer/vendor, as before).
-- A bank row with no treatment cannot have been posted and is refused.
--
-- The remaining refusals (split rows, a pre-snapshot row with no location) now
-- name the manual journal entry in Books rather than "a journal entry".
--
-- Replaces two functions in place; grants are restated. No table, policy,
-- trigger or data change. Must come AFTER 20261013180000.

create or replace function public.card_transaction_reclass_from(p_transaction_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_company uuid := public.active_company_id();
  t public.card_transactions%rowtype; b public.card_import_batches%rowtype;
  r public.card_transaction_reclasses%rowtype;
  v_settle jsonb; v_loc text; v_loc_name text; v_noted boolean;
begin
  if auth.uid() is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  select * into t from public.card_transactions where id = p_transaction_id and company_entity_id = v_company;
  if not found then raise exception 'Transaction not found'; end if;
  select * into b from public.card_import_batches where id = t.batch_id and company_entity_id = v_company;

  select r2.* into r from public.card_transaction_reclasses r2
    join public.journal_adjustments a on a.id = r2.adjustment_id
   where r2.transaction_id = t.id and a.status = 'posted'
   order by r2.created_at desc limit 1;
  if r.id is not null then
    return jsonb_build_object('account_id', r.to_qbo_account_id, 'account_name', r.to_qbo_account_name,
      'location_id', r.to_qbo_location_id, 'location_name', r.to_qbo_location_name,
      'entity_type', r.to_entity_type, 'entity_id', r.to_entity_qbo_id, 'entity_name', r.to_entity_name,
      'basis', 'reclass');
  end if;

  v_loc := t.qbo_location_id; v_loc_name := t.qbo_location_name;
  if v_loc is null then
    if b.approval_snapshot is null then
      raise exception 'This period was posted before approvals recorded their default location, so the location it posted with is unknown. Reclassify it with a manual journal entry in Books instead.';
    end if;
    v_settle := public.silo_ledger_snapshot_settlement(b.id);
    if v_settle is not null then
      v_loc := v_settle->'DepartmentRef'->>'value';
    else
      select f.qbo_location_id, true into v_loc, v_noted from public.silo_ledger_freeze f where f.batch_id = b.id;
      if v_noted is null then
        raise exception 'This period netted to zero and its approval did not record a default location, so the location it posted with is unknown. Reclassify it with a manual journal entry in Books instead.';
      end if;
    end if;
    if v_loc is not null then
      select coalesce(l.fully_qualified_name, l.name) into v_loc_name from public.quickbooks_locations l
       where l.company_entity_id = v_company and l.qbo_location_id = v_loc
         and l.connection_id = coalesce(nullif(b.approval_snapshot->>'qbo_connection_id', '')::uuid, b.qbo_connection_id);
    end if;
  end if;
  return jsonb_build_object('account_id', t.qbo_account_id, 'account_name', t.qbo_account_name,
    'location_id', v_loc, 'location_name', v_loc_name,
    'entity_type', case when t.entity_qbo_id is not null then t.entity_type end,
    'entity_id', t.entity_qbo_id, 'entity_name', t.entity_name, 'basis', 'posting');
end $$;
revoke all on function public.card_transaction_reclass_from(uuid) from public, anon, authenticated;
grant execute on function public.card_transaction_reclass_from(uuid) to authenticated;

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
  v_from_ent_type text; v_from_ent text; v_from_ent_name text; v_from jsonb;
  v_to_acct_name text; v_to_type text; v_to_loc_name text; v_to_ent_name text;
  v_to_loc text := nullif(btrim(coalesce(p_to_location_id, '')), '');
  v_to_ent_type text := nullif(btrim(coalesce(p_to_entity_type, '')), '');
  v_to_ent text := nullif(btrim(coalesce(p_to_entity_id, '')), '');
  v_side text; v_other text; v_amount numeric(14,2); v_source_type text;
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
    raise exception 'A split transaction is reclassified with a manual journal entry in Books, line by line.';
  end if;
  v_amount := abs(round(t.amount, 2));
  if v_amount = 0 then raise exception 'A zero-amount transaction has nothing to reclassify'; end if;
  if t.origin = 'plaid' then
    if t.provider_status is distinct from 'posted' then raise exception 'Only a settled bank transaction can be reclassified'; end if;
    if coalesce(t.accounting_treatment, 'unknown') = 'unknown' then
      raise exception 'This bank transaction has no accounting treatment, so it cannot have been posted with one';
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

  -- Where the amount sits now, including the location the original posting
  -- actually used (card_transaction_reclass_from).
  v_from := public.card_transaction_reclass_from(t.id);
  v_from_acct := v_from->>'account_id'; v_from_acct_name := v_from->>'account_name';
  v_from_loc := v_from->>'location_id'; v_from_loc_name := v_from->>'location_name';
  v_from_ent_type := v_from->>'entity_type'; v_from_ent := v_from->>'entity_id'; v_from_ent_name := v_from->>'entity_name';
  if v_from_acct is null then raise exception 'This transaction has no category to move from'; end if;

  select a.name, a.account_type into v_to_acct_name, v_to_type from public.quickbooks_accounts a
   where a.connection_id = v_conn and a.company_entity_id = v_company
     and a.qbo_account_id = p_to_account_id and a.is_active;
  if not found then raise exception 'Choose an active account from this period''s QuickBooks chart'; end if;
  -- A bank row keeps its treatment, so the target must be an account that
  -- treatment may post to: the same rule silo_ledger_blocker() and approval
  -- hold every bank line to. Purchase, refund and deposit take any account.
  if t.origin = 'plaid' then
    select s.source_type into v_source_type from public.card_sources s where s.id = b.source_id;
    if t.accounting_treatment in ('transfer', 'payroll_settlement', 'shopify_settlement')
       and v_to_type not in ('Other Current Asset', 'Other Current Liability') then
      raise exception 'A % moves through a clearing account: choose an Other Current Asset or Other Current Liability account',
        replace(t.accounting_treatment, '_', ' ');
    end if;
    if t.accounting_treatment = 'card_payment'
       and (v_source_type = 'card' or v_to_type not in ('Credit Card', 'Accounts Payable')) then
      raise exception 'A card payment settles a card or a payable: choose a Credit Card or Accounts Payable account';
    end if;
  end if;
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

select public.refresh_chat_schema_catalog();
