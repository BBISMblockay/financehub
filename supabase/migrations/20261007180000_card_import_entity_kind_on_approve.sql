-- Block approval when AR/AP lines carry the wrong entity kind (customer on payable, etc.).

create or replace function public.approve_card_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_batch public.card_import_batches%rowtype;
  v_source public.card_sources%rowtype;
  v_connection uuid;
  v_connection_count integer;
  v_balancing_type text;
  v_lines jsonb;
  v_net numeric(14,2);
  v_snapshot jsonb;
  v_hash text;
begin
  if v_user is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;

  select * into v_batch from public.card_import_batches
  where id = p_batch_id and company_entity_id = v_company for update;
  if not found then raise exception 'Batch not found'; end if;
  if v_batch.status = 'approved' and v_batch.approval_snapshot is not null
     and v_batch.approval_hash is not null then
    return jsonb_build_object('id', p_batch_id, 'approval_hash', v_batch.approval_hash,
      'approval_version', v_batch.approval_version, 'already_approved', true);
  end if;
  if v_batch.status not in ('draft', 'categorized') then
    raise exception 'Batch cannot be approved from status %', v_batch.status;
  end if;
  if v_batch.entry_date is null then raise exception 'Batch has no entry date'; end if;

  select * into v_source from public.card_sources
  where id = v_batch.source_id and company_entity_id = v_company;
  if not found or not v_source.is_active then raise exception 'Card source is not active'; end if;
  if not v_source.posting_enabled then raise exception 'Posting is disabled for this card source'; end if;

  v_connection := coalesce(v_source.qbo_connection_id, v_batch.qbo_connection_id);
  if v_connection is null then
    select count(*), (array_agg(id order by id))[1] into v_connection_count, v_connection
    from public.quickbooks_connections
    where company_entity_id = v_company and is_active;
    if v_connection_count <> 1 then
      raise exception 'Select one active QuickBooks connection before approval';
    end if;
  end if;
  if not exists (
    select 1 from public.quickbooks_connections
    where id = v_connection and company_entity_id = v_company and is_active
  ) then raise exception 'QuickBooks connection is not active for this company'; end if;

  if v_source.credit_qbo_account_id is null then raise exception 'Balancing account is required'; end if;
  select account_type into v_balancing_type
  from public.quickbooks_accounts
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_account_id = v_source.credit_qbo_account_id and is_active;
  if not found then raise exception 'Balancing account is not active on the selected QuickBooks connection'; end if;

  if exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'uncoded') then
    raise exception 'Every transaction must be coded or excluded before approval';
  end if;
  if not exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'coded') then
    raise exception 'No coded transactions to approve';
  end if;
  -- Validated through card_coding_effective_lines so a split line passes the
  -- same account, location and entity checks an ordinary coded line does.
  -- Reading card_transactions here instead would skip every split line, which
  -- is exactly the gap a second copy of these checks would leave.
  if exists (
    select 1 from public.card_coding_effective_lines e
    left join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = e.qbo_account_id and a.is_active
    where e.batch_id = p_batch_id and (e.qbo_account_id is null or a.id is null)
  ) then raise exception 'A coded line has an invalid QuickBooks account'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and e.qbo_location_id is not null
      and not exists (
        select 1 from public.quickbooks_locations l
        where l.connection_id = v_connection and l.company_entity_id = v_company
          and l.qbo_location_id = e.qbo_location_id and l.is_active
      )
  ) then raise exception 'A coded line has an invalid QuickBooks location'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = e.qbo_account_id
    where e.batch_id = p_batch_id
      and a.account_type in ('Accounts Receivable', 'Accounts Payable')
      and e.entity_qbo_id is null
  ) then raise exception 'Receivable and payable lines require an entity'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = e.qbo_account_id
    where e.batch_id = p_batch_id
      and e.entity_qbo_id is not null
      and (
        (a.account_type = 'Accounts Payable' and e.entity_type is distinct from 'Vendor')
        or (a.account_type = 'Accounts Receivable' and e.entity_type is distinct from 'Customer')
      )
  ) then raise exception 'Payable lines need a vendor and receivable lines need a customer'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and ((e.entity_qbo_id is null) <> (e.entity_type is null))
  ) then raise exception 'Entity id and type must be supplied together'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and e.entity_qbo_id is not null
      and not (
        (e.entity_type = 'Customer' and exists (
          select 1 from public.quickbooks_customers c where c.connection_id = v_connection
            and c.company_entity_id = v_company and c.qbo_customer_id = e.entity_qbo_id and c.is_active
        )) or
        (e.entity_type = 'Vendor' and exists (
          select 1 from public.quickbooks_vendors ve where ve.connection_id = v_connection
            and ve.company_entity_id = v_company and ve.qbo_vendor_id = e.entity_qbo_id and ve.is_active
        ))
      )
  ) then raise exception 'A coded line has an invalid QuickBooks entity'; end if;
  -- A split whose lines no longer total its transaction cannot be posted: the
  -- settlement side is computed from the batch total, so the entry would be
  -- unbalanced or would move money the statement never moved. The deferred
  -- constraint makes this unreachable; it is re-checked because approval is
  -- the last point before the numbers are frozen and sent to Intuit.
  if exists (
    select 1 from public.card_transactions t
    join (select transaction_id, sum(amount) total from public.card_transaction_splits group by transaction_id) s
      on s.transaction_id = t.id
    where t.batch_id = p_batch_id and t.status = 'coded' and round(s.total, 2) <> round(t.amount, 2)
  ) then raise exception 'A split transaction does not total its own amount; no entry was approved'; end if;

  select coalesce(round(sum(round(e.amount, 2)), 2), 0),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'DetailType', 'JournalEntryLineDetail',
           'Amount', abs(round(e.amount, 2)),
           'Description', left(concat_ws(' · ', e.txn_date::text, e.description,
             case when e.is_split then coalesce(nullif(e.memo, ''), 'split ' || e.line_no::text) end), 4000),
           'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
             'PostingType', case when e.amount >= 0 then 'Debit' else 'Credit' end,
             'AccountRef', jsonb_build_object('value', e.qbo_account_id),
             'Entity', case when e.entity_qbo_id is not null then jsonb_build_object(
               'Type', e.entity_type, 'EntityRef', jsonb_build_object('value', e.entity_qbo_id)) end,
             'DepartmentRef', case when coalesce(e.qbo_location_id, v_source.default_qbo_location_id) is not null
               then jsonb_build_object('value', coalesce(e.qbo_location_id, v_source.default_qbo_location_id)) end
           ))
         )) order by e.row_no nulls last, e.transaction_id, e.line_no)
    into v_net, v_lines
  from public.card_coding_effective_lines e
  where e.batch_id = p_batch_id and round(e.amount, 2) <> 0;
  if v_lines is null then raise exception 'Every coded transaction rounds to zero'; end if;

  if v_source.default_qbo_location_id is not null and not exists (
    select 1 from public.quickbooks_locations
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_location_id = v_source.default_qbo_location_id and is_active
  ) then raise exception 'Default location is not active on the selected QuickBooks connection'; end if;

  if v_net <> 0 then
    if v_balancing_type = 'Accounts Payable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_vendors where connection_id = v_connection
          and company_entity_id = v_company and qbo_vendor_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing payable account requires a valid vendor'; end if;
    elsif v_balancing_type = 'Accounts Receivable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_customers where connection_id = v_connection
          and company_entity_id = v_company and qbo_customer_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing receivable account requires a valid customer'; end if;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'DetailType', 'JournalEntryLineDetail', 'Amount', abs(v_net),
      'Description', left(trim(v_source.display_name || ' ' || coalesce(v_batch.label, '')), 4000),
      'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
        'PostingType', case when v_net >= 0 then 'Credit' else 'Debit' end,
        'AccountRef', jsonb_build_object('value', v_source.credit_qbo_account_id),
        'Entity', case when v_source.credit_vendor_qbo_id is not null then jsonb_build_object(
          'Type', case when v_balancing_type = 'Accounts Receivable' then 'Customer' else 'Vendor' end,
          'EntityRef', jsonb_build_object('value', v_source.credit_vendor_qbo_id)) end,
        'DepartmentRef', case when v_source.default_qbo_location_id is not null
          then jsonb_build_object('value', v_source.default_qbo_location_id) end
      ))
    )));
  end if;

  v_snapshot := jsonb_build_object(
    'schema_version', 1, 'kind', 'card_batch', 'qbo_connection_id', v_connection,
    'source', 'card_import', 'source_ref', p_batch_id,
    'period_start', v_batch.period_start, 'period_end', v_batch.period_end,
    'payload', jsonb_build_object(
      'TxnDate', v_batch.entry_date,
      'PrivateNote', left(trim('SILO card coding · ' || v_source.display_name || ' · ' || coalesce(v_batch.label, '')), 4000),
      'Line', v_lines));
  v_hash := public.finance_approval_snapshot_hash(v_snapshot);

  update public.card_sources set qbo_connection_id = v_connection, updated_at = now()
  where id = v_source.id and qbo_connection_id is null;
  update public.card_import_batches set
    status = 'approved', approved_at = now(), approved_by = v_user,
    approval_version = approval_version + 1,
    approval_snapshot = v_snapshot, approval_hash = v_hash,
    qbo_connection_id = v_connection, updated_at = now(),
    approval_reopened_at = null, approval_reopened_by = null, approval_reopen_reason = null
  where id = p_batch_id;
  return jsonb_build_object('id', p_batch_id, 'approval_hash', v_hash,
    'approval_version', v_batch.approval_version + 1);
end;
$$;
