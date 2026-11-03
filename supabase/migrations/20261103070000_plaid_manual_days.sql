-- Hand-entered days for a Plaid-fed account.
--
-- A bank feed can stop delivering while every signal SILO stores says healthy
-- (see 2026-10-26, Columbia Bank: /transactions/sync returned empty pages for
-- eight days while balances kept refreshing and every scheduled run was green).
-- PR #1100 added a date-range import that asks the provider directly, which
-- answers the case where the provider HAS the days and our cursor does not. It
-- cannot answer the case where the provider itself has nothing: the days exist
-- at the bank, the books cannot close without them, and there is no supported
-- way to get them in. CSV import is deliberately refused for a Plaid-fed source
-- (v2/transactions.html filters ingest_mode='plaid' out of the picker) because
-- a csv row carries no provider identity, so the feed would later insert its
-- own copy of the same transaction and both would sit in the books.
--
-- This adds a third origin that closes that gap. A 'manual' row belongs to the
-- Plaid account but carries no provider id. It codes, approves and posts like
-- any other row, and when the feed finally delivers that day the provider's
-- copy CLAIMS the placeholder in place -- keeping its coding -- instead of
-- landing beside it. That claim lives in plaid_project_transaction's insert
-- branch, which is the only path a never-seen provider transaction takes.
--
-- Deliberately NOT done: no date is written into this file, and nothing here
-- distinguishes one company from another. Every tenant gets the same behaviour.

alter table public.card_transactions
  add column if not exists manual_entered_at timestamptz,
  add column if not exists manual_entered_by uuid references auth.users(id);

comment on column public.card_transactions.manual_entered_at is
  'When a human typed this row in because the bank feed had not delivered its day. Survives the provider claiming the row, so a transaction that entered the books by hand stays identifiable after the feed confirms it. Null for everything else.';

do $$
declare v_name text;
begin
  -- The origin check is an inline column constraint, so its name is generated.
  -- Find it by what it constrains rather than by a name this file guesses.
  for v_name in select conname from pg_constraint
    where conrelid='public.card_transactions'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%origin%' and pg_get_constraintdef(oid) not like '%plaid_account_id%'
  loop
    execute format('alter table public.card_transactions drop constraint %I', v_name);
  end loop;
  if not exists (select 1 from pg_constraint where conname='card_transactions_origin_check') then
    alter table public.card_transactions add constraint card_transactions_origin_check
      check (origin in ('csv','plaid','manual'));
  end if;
  -- 'manual' is a Plaid-fed row with no provider identity yet: it must name its
  -- account (so the claim can find it and RLS can scope it) and must NOT carry
  -- an external id or provider status, which are the provider's to assign.
  if exists (select 1 from pg_constraint where conname='card_transactions_plaid_identity_check') then
    alter table public.card_transactions drop constraint card_transactions_plaid_identity_check;
  end if;
  alter table public.card_transactions add constraint card_transactions_plaid_identity_check check (
    (origin='csv' and plaid_account_id is null and external_transaction_id is null and provider_status is null)
    or (origin='plaid' and plaid_account_id is not null and external_transaction_id is not null and provider_status is not null)
    or (origin='manual' and plaid_account_id is not null and external_transaction_id is null and provider_status is null));
end $$;

create or replace function public.plaid_project_transaction(p_account_id uuid, p_payload jsonb, p_removed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare v_account public.plaid_accounts%rowtype; v_source public.card_sources%rowtype;
  v_old public.card_transactions%rowtype; v_exception public.plaid_sync_exceptions%rowtype;
  v_batch public.card_import_batches%rowtype; v_payload jsonb; v_latest_payload jsonb; v_date date; v_amount numeric(14,2); v_currency text;
  v_provider_status text; v_removed_from text; v_status text; v_reason text; v_treatment text; v_id uuid; v_batch_id uuid; v_previous jsonb; v_row_no integer;
  v_no_accounting_impact boolean; v_manual public.card_transactions%rowtype;
begin
  select * into v_account from public.plaid_accounts where id=p_account_id;
  select * into v_source from public.card_sources where id=v_account.source_id;
  if nullif(p_payload->>'transaction_id','') is null or p_payload->>'account_id' is distinct from v_account.provider_account_id then
    raise exception 'Plaid transaction account or identity mismatch';
  end if;
  select * into v_old from public.card_transactions where plaid_account_id=p_account_id and external_transaction_id=p_payload->>'transaction_id';
  if v_old.id is null and p_removed then
    insert into public.finance_audit_events(company_entity_id,object_type,object_id,event_type,new_values)
      values(v_account.company_entity_id,'plaid_accounts',p_account_id,'provider_removed_unseen',p_payload);
    return jsonb_build_object('ignored',true);
  end if;
  if p_removed then
    select provider_payload into v_latest_payload from public.plaid_sync_exceptions where account_id=p_account_id
      and external_transaction_id=v_old.external_transaction_id order by created_at desc,id desc limit 1;
  end if;
  v_payload:=case when p_removed then coalesce(v_latest_payload,v_old.raw,'{}'::jsonb)||jsonb_build_object('_silo_removed',true)
    else p_payload-'_silo_removed' end;
  if jsonb_typeof(v_payload->'date') is distinct from 'string' or v_payload->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
    or jsonb_typeof(v_payload->'amount') is distinct from 'number'
    or jsonb_typeof(v_payload->'pending') is distinct from 'boolean'
    or (v_payload->>'amount')::numeric<>round((v_payload->>'amount')::numeric,2) then
    raise exception 'Plaid amount must be a numeric exact-cent value and pending must be boolean';
  end if;
  v_date:=(v_payload->>'date')::date;
  v_amount:=(v_payload->>'amount')::numeric;
  if v_date is null or v_amount is null or v_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid Plaid transaction date or amount'; end if;
  if v_old.id is null and v_date<v_source.authoritative_from then return jsonb_build_object('ignored_before_cutover',true); end if;
  v_currency:=v_payload->>'iso_currency_code';
  if v_payload->>'unofficial_currency_code' is not null then v_currency:=v_payload->>'unofficial_currency_code'; end if;
  v_provider_status:=case when p_removed then 'removed' when (v_payload->>'pending')::boolean then 'pending' else 'posted' end;
  -- What the row WAS when the feed retired it. A pending row was never codeable
  -- and never reached the books, so retiring its id is bookkeeping; a posted row
  -- being retracted is an event. Recorded here rather than inferred later from
  -- the payload, and kept from the FIRST removal so a repeat cannot overwrite it
  -- with 'removed'. Cleared when a row comes back, so it only ever describes a
  -- row that is removed now.
  --
  -- The coalesce/nullif pair is NOT exercised by the test suite and is kept
  -- deliberately: a repeat removal rebuilds an identical payload, so the
  -- projection returns 'unchanged' before reaching this update, and the only
  -- route past that guard (a stored exception payload differing from the row,
  -- on a batch reopened to draft) could not be constructed. Without the pair a
  -- second removal down that route would write 'removed' into a column
  -- constrained to pending/posted and abort the sync mid-cycle. Fail-closed
  -- beats a tested-but-fragile simplification here.
  v_removed_from:=case when p_removed
    then coalesce(v_old.removed_from_status,nullif(v_old.provider_status,'removed')) end;
  v_status:=case when v_provider_status<>'posted' or v_currency is distinct from 'USD' or v_date<v_source.authoritative_from then 'excluded' else 'uncoded' end;
  v_reason:=case when v_provider_status='removed' then 'Removed by bank feed' when v_provider_status='pending' then 'Pending bank transaction'
    when v_currency is distinct from 'USD' then 'Unsupported bank feed currency' when v_date<v_source.authoritative_from then 'Before authoritative feed cutover' end;
  v_treatment:=case when v_account.type='credit' and v_amount>0 and nullif(v_payload->>'merchant_name','') is not null
    and v_payload#>>'{personal_finance_category,primary}' in ('ENTERTAINMENT','FOOD_AND_DRINK','GENERAL_MERCHANDISE','GENERAL_SERVICES',
      'HOME_IMPROVEMENT','MEDICAL','PERSONAL_CARE','RENT_AND_UTILITIES','TRANSPORTATION','TRAVEL') then 'purchase' else 'unknown' end;
  if v_old.id is not null then
    select * into v_batch from public.card_import_batches where id=v_old.batch_id for update;
    -- Re-read after the parent lock in case a browser changed coding first.
    select * into v_old from public.card_transactions where id=v_old.id;
    select * into v_exception from public.plaid_sync_exceptions where account_id=p_account_id
      and external_transaction_id=v_old.external_transaction_id order by created_at desc,id desc limit 1;
    v_previous:=case when v_exception.status='open' then v_exception.previous_payload else coalesce(v_exception.provider_payload,v_old.raw) end;
    v_no_accounting_impact:=(v_old.status='excluded' and v_status='excluded'
      and not exists(select 1 from public.plaid_sync_exceptions where account_id=p_account_id
        and external_transaction_id=v_old.external_transaction_id and correction_adjustment_id is not null))
      or public.plaid_accounting_facts(v_previous)=public.plaid_accounting_facts(v_payload);
    if v_exception.status='open' then
      if v_no_accounting_impact then
        update public.plaid_sync_exceptions set provider_payload=v_payload,status='resolved',
          resolution_reason='Provider change has no accounting impact: reviewed facts unchanged or excluded row remains unpostable',
          resolved_by=null,resolved_at=now(),updated_at=now() where id=v_exception.id;
      elsif v_exception.provider_payload is distinct from v_payload then
        update public.plaid_sync_exceptions set provider_payload=v_payload,updated_at=now() where id=v_exception.id;
      end if;
      return jsonb_build_object('exception',not v_no_accounting_impact,'batch_id',v_old.batch_id);
    end if;
    if v_batch.status not in ('draft','categorized') and v_exception.id is not null and v_exception.provider_payload=v_payload then
      return jsonb_build_object('unchanged',true,'batch_id',v_old.batch_id,'exception',v_exception.status='open');
    end if;
    if v_old.raw=v_payload and v_old.provider_status=v_provider_status and v_exception.status is distinct from 'open' then
      return jsonb_build_object('unchanged',true,'batch_id',v_old.batch_id);
    end if;
    if v_batch.status not in ('draft','categorized') then
      if v_exception.status='open' then
        update public.plaid_sync_exceptions set provider_payload=v_payload,updated_at=now() where id=v_exception.id;
      else
        insert into public.plaid_sync_exceptions(company_entity_id,account_id,transaction_id,external_transaction_id,previous_payload,provider_payload,
          status,resolution_reason,resolved_at)
          values(v_account.company_entity_id,p_account_id,v_old.id,v_old.external_transaction_id,v_previous,v_payload,
            case when v_no_accounting_impact then 'resolved' else 'open' end,
            case when v_no_accounting_impact then 'Provider change has no accounting impact: reviewed facts unchanged or excluded row remains unpostable' end,
            case when v_no_accounting_impact then now() end);
      end if;
      return jsonb_build_object('exception',not v_no_accounting_impact,'batch_id',v_old.batch_id);
    end if;
    -- Enrichment must not erase draft coding or invalidate an open editor.
    -- provider_updated_at is the accounting-facts revision used by the save
    -- RPC; updated_at/audit record metadata arrivals without changing it.
    if public.plaid_accounting_facts(v_old.raw)=public.plaid_accounting_facts(v_payload)
      and v_old.provider_status=v_provider_status then
      update public.card_transactions set raw=v_payload,updated_at=now() where id=v_old.id;
      return jsonb_build_object('metadata_updated',true,'batch_id',v_old.batch_id);
    end if;
    -- Explicit human exclusions survive normal provider edits; system exclusions
    -- for pending/removed/currency/cutover are recalculated from the provider.
    if v_old.status='excluded' and v_old.provider_status='posted' and v_old.currency='USD'
      and v_old.exclude_reason not in ('Before authoritative feed cutover') and v_status='uncoded' then
      v_status:='excluded'; v_reason:=v_old.exclude_reason;
    end if;
    v_batch_id:=v_old.batch_id; v_row_no:=v_old.row_no;
    if date_trunc('month',v_date)::date is distinct from v_batch.period_start then
      v_batch_id:=public.plaid_open_monthly_batch(p_account_id,v_date);
      select coalesce(max(row_no),0)+1 into v_row_no from public.card_transactions where batch_id=v_batch_id;
    end if;
    update public.card_transactions set batch_id=v_batch_id,row_no=v_row_no,txn_date=v_date,amount=v_amount,currency=v_currency,description=v_payload->>'name',
      merchant=coalesce(v_payload->>'merchant_name',v_payload->>'name'),clean_merchant=v_payload->>'merchant_name',raw=v_payload,
      pending_transaction_id=v_payload->>'pending_transaction_id',provider_status=v_provider_status,removed_from_status=v_removed_from,provider_updated_at=now(),
      status=v_status,exclude_reason=v_reason,accounting_treatment=v_treatment,qbo_account_id=null,qbo_account_name=null,
      qbo_location_id=null,qbo_location_name=null,entity_qbo_id=null,entity_name=null,entity_type=null,vendor_name=null,memo=null,
      coding_source=null,confidence=null,ai_reasoning=null,rule_id=null,coding_conflict=null,updated_at=now(),updated_by=null
      where id=v_old.id;
    v_id:=v_old.id;
  else
    -- A hand-entered row is a placeholder for a transaction the feed had not
    -- delivered yet, so the feed's own copy must take it over rather than land
    -- beside it. Matching is one-to-one on (account, exact amount) within three
    -- days, nearest date first: the bank's posted date and the portal export's
    -- date routinely differ by a day or two, and amount is the only field both
    -- sides spell identically.
    --
    -- One-to-one comes from the claim itself, not from the lock: claiming flips
    -- the row to origin='plaid', so the next provider row of the same amount no
    -- longer matches it and finds the next placeholder or inserts. The lock
    -- blocks rather than skips on purpose -- after waiting, READ COMMITTED
    -- re-checks this predicate, so a placeholder another transaction has just
    -- claimed is correctly not returned, whereas skipping it would insert a
    -- second copy of a transaction that already has a home.
    select * into v_manual from public.card_transactions
      where plaid_account_id=p_account_id and origin='manual' and amount=v_amount
        and txn_date between v_date-3 and v_date+3
      order by abs(txn_date-v_date),row_no limit 1 for update;
    if v_manual.id is not null then
      select * into v_batch from public.card_import_batches where id=v_manual.batch_id for update;
      -- A placeholder already in the books cannot be rewritten from under an
      -- approved entry. Raise the same exception a provider change on a posted
      -- row raises, so it reaches the review queue instead of the ledger.
      if v_batch.status not in ('draft','categorized') then
        insert into public.plaid_sync_exceptions(company_entity_id,account_id,transaction_id,external_transaction_id,
          previous_payload,provider_payload,status)
          values(v_account.company_entity_id,p_account_id,v_manual.id,v_payload->>'transaction_id',
            jsonb_build_object('_silo_manual_entry',true,'date',v_manual.txn_date,'amount',v_manual.amount,
              'name',v_manual.description),v_payload,'open');
        return jsonb_build_object('exception',true,'batch_id',v_manual.batch_id);
      end if;
      v_batch_id:=v_manual.batch_id; v_row_no:=v_manual.row_no;
      if date_trunc('month',v_date)::date is distinct from v_batch.period_start then
        v_batch_id:=public.plaid_open_monthly_batch(p_account_id,v_date);
        select coalesce(max(row_no),0)+1 into v_row_no from public.card_transactions where batch_id=v_batch_id;
      end if;
      -- The facts become the feed's. The coding does not: the amount matched,
      -- which is what the account choice was made on, and re-deriving it would
      -- throw away the work the placeholder existed to let someone do. Coding
      -- columns are deliberately absent from this SET list.
      update public.card_transactions set batch_id=v_batch_id,row_no=v_row_no,txn_date=v_date,amount=v_amount,
        currency=v_currency,description=v_payload->>'name',merchant=coalesce(v_payload->>'merchant_name',v_payload->>'name'),
        clean_merchant=v_payload->>'merchant_name',raw=v_payload,origin='plaid',
        external_transaction_id=v_payload->>'transaction_id',pending_transaction_id=v_payload->>'pending_transaction_id',
        provider_status=v_provider_status,removed_from_status=v_removed_from,provider_updated_at=now(),
        accounting_treatment=v_treatment,last4=v_account.mask,
        status=case when v_status='uncoded' and v_manual.status in ('coded','excluded') then v_manual.status else v_status end,
        exclude_reason=case when v_status='uncoded' and v_manual.status='excluded' then v_manual.exclude_reason else v_reason end,
        updated_at=now()
        where id=v_manual.id;
      v_id:=v_manual.id;
      update public.card_import_batches b set row_count=(select count(*) from public.card_transactions where batch_id=b.id),
        total_amount=(select coalesce(sum(amount),0) from public.card_transactions where batch_id=b.id),
        status='draft',updated_at=now() where id in (v_batch_id,v_manual.batch_id) and status in ('draft','categorized');
      return jsonb_build_object('transaction_id',v_id,'batch_id',v_batch_id,'claimed_manual_entry',true,'changed',true);
    end if;
    v_batch_id:=public.plaid_open_monthly_batch(p_account_id,v_date);
    insert into public.card_transactions(company_entity_id,batch_id,row_no,txn_date,amount,currency,description,merchant,clean_merchant,raw,
      origin,plaid_account_id,external_transaction_id,pending_transaction_id,provider_status,provider_updated_at,status,exclude_reason,accounting_treatment,last4)
      values(v_account.company_entity_id,v_batch_id,(select coalesce(max(row_no),0)+1 from public.card_transactions where batch_id=v_batch_id),
        v_date,v_amount,v_currency,v_payload->>'name',coalesce(v_payload->>'merchant_name',v_payload->>'name'),v_payload->>'merchant_name',v_payload,
        'plaid',p_account_id,v_payload->>'transaction_id',v_payload->>'pending_transaction_id',v_provider_status,now(),v_status,v_reason,v_treatment,v_account.mask)
      returning id into v_id;
  end if;
  update public.card_import_batches b set row_count=(select count(*) from public.card_transactions where batch_id=b.id),
    total_amount=(select coalesce(sum(amount),0) from public.card_transactions where batch_id=b.id),
    status='draft',updated_at=now() where id in (v_batch_id,v_old.batch_id) and status in ('draft','categorized');
  return jsonb_build_object('transaction_id',v_id,'batch_id',v_batch_id,'previous_batch_id',v_old.batch_id,'changed',true);
end $fn$;
-- Type in the days a stalled feed never delivered.
--
-- Insert-only and forward-only by construction: every submitted date must be
-- strictly AFTER the newest row this account already holds, so the call cannot
-- reach a transaction the feed delivered, and cannot reach one it delivered and
-- somebody coded. It also cannot reach before the account's own
-- card_sources.authoritative_from, which is the permanent boundary of what this
-- feed is allowed to own.
create or replace function public.plaid_import_manual_days(p_account_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare v_company uuid:=public.active_company_id(); v_account public.plaid_accounts%rowtype;
  v_source public.card_sources%rowtype; v_row jsonb; v_date date; v_amount numeric(14,2); v_name text;
  v_newest date; v_start date; v_end date; v_batch_id uuid; v_batches uuid[]:='{}'; v_count integer:=0;
begin
  if auth.uid() is null or v_company is null
    or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  select * into v_account from public.plaid_accounts where id=p_account_id and company_entity_id=v_company for update;
  if not found then raise exception 'Plaid account not found'; end if;
  -- Racing a sync would let the feed insert a transaction between the window
  -- check and the insert, which is exactly the duplicate this guards against.
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then
    raise exception 'Wait for account sync to finish';
  end if;
  select * into v_source from public.card_sources where id=v_account.source_id and is_active and ingest_mode='plaid';
  if not found then raise exception 'Map this account to an active bank feed first'; end if;
  if not exists(select 1 from public.plaid_connections where id=v_account.connection_id and status<>'disconnected') then
    raise exception 'Resume syncing this connection first';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)=0 then
    raise exception 'No rows to import';
  end if;
  if jsonb_array_length(p_rows)>2000 then raise exception 'Import at most 2000 rows at a time'; end if;

  select max(txn_date) into v_newest from public.card_transactions where plaid_account_id=p_account_id;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row->'date') is distinct from 'string' or v_row->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(v_row->'amount') is distinct from 'number'
      or (v_row->>'amount')::numeric<>round((v_row->>'amount')::numeric,2)
      or (v_row->>'amount')::numeric=0
      or (v_row->>'amount')::text in ('NaN','Infinity','-Infinity')
      or coalesce(length(btrim(v_row->>'name')),0)=0 or length(v_row->>'name')>500 then
      raise exception 'Every row needs a YYYY-MM-DD date, a non-zero exact-cent amount and a description';
    end if;
    v_date:=(v_row->>'date')::date;
    if v_newest is not null and v_date<=v_newest then
      raise exception 'Row dated % is on or before the newest day this account already holds (%). Import only the days the feed is missing.', v_date, v_newest;
    end if;
    if v_date<v_source.authoritative_from then
      raise exception 'Row dated % is before this account''s feed start date (%)', v_date, v_source.authoritative_from;
    end if;
    if v_date>current_date then raise exception 'Row dated % is in the future', v_date; end if;
    v_start:=least(coalesce(v_start,v_date),v_date);
    v_end:=greatest(coalesce(v_end,v_date),v_date);
  end loop;

  -- Pressing import twice cannot double a day: v_newest counts hand-entered
  -- rows too, so the forward-only check above already refuses every date the
  -- first import wrote. A separate duplicate guard here would be unreachable.

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_date:=(v_row->>'date')::date;
    v_amount:=(v_row->>'amount')::numeric;
    v_name:=btrim(v_row->>'name');
    v_batch_id:=public.plaid_open_monthly_batch(p_account_id,v_date);
    insert into public.card_transactions(company_entity_id,batch_id,row_no,txn_date,amount,currency,
      description,merchant,raw,origin,plaid_account_id,status,accounting_treatment,last4,
      manual_entered_at,manual_entered_by)
      values(v_account.company_entity_id,v_batch_id,
        (select coalesce(max(row_no),0)+1 from public.card_transactions where batch_id=v_batch_id),
        v_date,v_amount,'USD',v_name,v_name,
        jsonb_build_object('_silo_manual_entry',true,'date',v_date,'amount',v_amount,'name',v_name),
        'manual',p_account_id,'uncoded','unknown',v_account.mask,now(),auth.uid());
    if not v_batch_id=any(v_batches) then v_batches:=array_append(v_batches,v_batch_id); end if;
    v_count:=v_count+1;
  end loop;

  update public.card_import_batches b set row_count=(select count(*) from public.card_transactions where batch_id=b.id),
    total_amount=(select coalesce(sum(amount),0) from public.card_transactions where batch_id=b.id),
    status='draft',updated_at=now() where id=any(v_batches) and status in ('draft','categorized');
  insert into public.finance_audit_events(company_entity_id,object_type,object_id,event_type,new_values)
    values(v_account.company_entity_id,'plaid_accounts',p_account_id,'manual_days_imported',
      jsonb_build_object('rows',v_count,'start_date',v_start,'end_date',v_end));
  return jsonb_build_object('account_id',p_account_id,'imported',v_count,
    'start_date',v_start,'end_date',v_end,'batch_ids',to_jsonb(v_batches));
end $fn$;

revoke all on function public.plaid_import_manual_days(uuid,jsonb) from public,anon;
grant execute on function public.plaid_import_manual_days(uuid,jsonb) to authenticated;

-- The row guard predates this origin: its else-branch treats anything that is
-- not 'plaid' as a CSV line and refuses it for overlapping the feed, and its
-- batch-move rule only recognises plaid->plaid. Both are widened here.
create or replace function public.plaid_guard_transaction()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $gt$
declare v_batch public.card_import_batches%rowtype; v_source public.card_sources%rowtype; v_row public.card_transactions%rowtype; v_cutover date; v_connection uuid; begin
  v_row:=case when tg_op='DELETE' then old else new end;
  -- Approval locks the same parent first. Provider and browser writes cannot
  -- race past the frozen snapshot even with service-role RLS bypass.
  select * into v_batch from public.card_import_batches where id=v_row.batch_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if tg_op='UPDATE' and new.batch_id<>old.batch_id then
    -- A hand-entered day becomes a provider row when the feed claims it, and
    -- that claim may have to move it into another month's batch.
    if current_user in ('anon','authenticated') or old.origin not in ('plaid','manual') or new.origin<>'plaid' then
      raise exception 'Transactions cannot move between batches';
    end if;
    perform 1 from public.card_import_batches b where b.id=old.batch_id and b.status in ('draft','categorized')
      and b.source_id=v_batch.source_id and b.company_entity_id=v_batch.company_entity_id for update;
    if not found then raise exception 'Provider date changes can move only between mutable batches of the same source'; end if;
  end if;
  if v_batch.status not in ('draft','categorized') then raise exception 'Approved or posted transactions are immutable; reopen or correct the entry'; end if;
  -- Serialize CSV imports with source rebinding before consulting authority.
  select * into v_source from public.card_sources where id=v_batch.source_id for share;
  if current_user in ('anon','authenticated') then
    if tg_op='DELETE' and old.origin='plaid' then raise exception 'Provider transactions cannot be deleted'; end if;
    if tg_op='INSERT' and new.origin='plaid' then raise exception 'Provider transactions are server-owned'; end if;
    -- Only plaid_import_manual_days may create a hand-entered day: it is the
    -- one place the forward-only window and the feed cutover are enforced.
    -- Coding one is ordinary work, so only its identity and money are frozen,
    -- and deleting one stays open -- that is how a bad import is undone.
    if tg_op='INSERT' and new.origin='manual' then raise exception 'Hand-entered feed days are server-owned'; end if;
    if tg_op='UPDATE' and (old.origin='manual' or new.origin='manual') and
      (new.origin,new.plaid_account_id,new.txn_date,new.amount,new.currency,new.description,new.company_entity_id,
       new.manual_entered_at,new.manual_entered_by)
      is distinct from (old.origin,old.plaid_account_id,old.txn_date,old.amount,old.currency,old.description,old.company_entity_id,
       old.manual_entered_at,old.manual_entered_by) then
      raise exception 'Hand-entered feed day data is server-owned';
    end if;
    if tg_op='UPDATE' and (old.origin='plaid' or new.origin='plaid') and
      (new.origin,new.plaid_account_id,new.external_transaction_id,new.pending_transaction_id,new.provider_status,new.provider_updated_at,
       new.txn_date,new.amount,new.currency,new.description,new.merchant,new.raw,new.company_entity_id)
      is distinct from (old.origin,old.plaid_account_id,old.external_transaction_id,old.pending_transaction_id,old.provider_status,old.provider_updated_at,
       old.txn_date,old.amount,old.currency,old.description,old.merchant,old.raw,old.company_entity_id) then
      raise exception 'Provider transaction data is server-owned';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.origin='plaid' then
    if not exists(select 1 from public.plaid_accounts a where a.id=new.plaid_account_id and a.source_id=v_source.id
      and a.company_entity_id=new.company_entity_id) then raise exception 'Plaid account/source mismatch'; end if;
    if new.status<>'excluded' and (new.provider_status<>'posted' or new.currency is distinct from 'USD') then
      raise exception 'Pending, removed, or non-USD feed transactions must remain excluded';
    end if;
    if new.coding_source='rule' and not exists(select 1 from public.card_coding_rules r
      where r.id=new.rule_id and r.company_entity_id=new.company_entity_id and r.source_id=v_source.id and r.is_active
        and r.direction=case when new.amount>0 then 'outflow' when new.amount<0 then 'inflow' else 'none' end) then
      raise exception 'Plaid coding rules require the exact source and explicit matching direction';
    end if;
  elsif new.origin='manual' then
    -- Same account/source identity rule as a provider row: a hand-entered day
    -- is that account's row, not a loose CSV line that happens to sit nearby.
    -- It is deliberately NOT subjected to the cutover-overlap rule below --
    -- overlapping the feed is the entire point, and its own RPC enforces a
    -- stricter window (after the newest row held, at or after the cutover).
    if not exists(select 1 from public.plaid_accounts a where a.id=new.plaid_account_id and a.source_id=v_source.id
      and a.company_entity_id=new.company_entity_id) then raise exception 'Plaid account/source mismatch'; end if;
    if new.currency is distinct from 'USD' then raise exception 'Hand-entered feed days must be USD'; end if;
  else
    v_connection:=public.plaid_effective_qbo_connection(v_source.company_entity_id,v_source.qbo_connection_id);
    perform public.plaid_lock_financial_account(v_source.company_entity_id,v_connection,v_source.credit_qbo_account_id);
    select min(authoritative_from) into v_cutover from public.card_sources
      where company_entity_id=v_source.company_entity_id and qbo_connection_id=v_connection
        and credit_qbo_account_id=v_source.credit_qbo_account_id and ingest_mode='plaid';
    if v_cutover is not null and (new.txn_date is null or new.txn_date>=v_cutover) then
      raise exception 'CSV transactions overlap the authoritative Plaid feed';
    end if;
  end if;
  return new;
end $gt$;
