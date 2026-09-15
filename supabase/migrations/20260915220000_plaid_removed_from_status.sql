-- A bank removal is two different events wearing one status.
--
-- Plaid maps every transactions/sync removal to provider_status='removed',
-- whether the institution retired a PENDING id (because it posted, or because
-- the authorisation was dropped) or retracted a POSTED transaction that was
-- real, codeable and possibly already coded. The row could not tell those
-- apart, so the UI could not either: it either showed both -- making a person
-- follow the feed retiring ids, which is not their job -- or hid both, taking
-- a retracted posted transaction off the screen with them.
--
-- Observed 2026-09-15 on the live feed: 26 pending rows retired in one sync
-- cycle, their posted twins delivered in a LATER cycle, none carrying
-- pending_transaction_id. This connection never populates that field, so the
-- pairing cannot be recovered from the row and the pre-removal status is the
-- only thing that distinguishes bookkeeping from an event.
--
-- So record it at removal time instead of inferring it afterwards.

alter table public.card_transactions
  add column if not exists removed_from_status text;

do $$
begin
  if not exists(select 1 from pg_constraint where conname='card_transactions_removed_from_status_check') then
    alter table public.card_transactions
      add constraint card_transactions_removed_from_status_check
      check (removed_from_status is null or removed_from_status in ('pending','posted'));
  end if;
end $$;

comment on column public.card_transactions.removed_from_status is
  'What provider_status held when the bank feed removed this row: pending (the id was retired before it ever posted -- never codeable, never in the books) or posted (a real transaction was retracted). Null unless provider_status = ''removed''. Set by plaid_project_transaction, never by a client.';

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
  v_no_accounting_impact boolean;
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

-- Existing removals predate the column. The pre-removal payload survives on the
-- row (the projection keeps the last known payload and stamps _silo_removed on
-- it), so raw->>'pending' still says what the feed last called each one. This is
-- the one place that inference is legitimate: the rows already exist and the
-- alternative is leaving them unclassified forever.
update public.card_transactions
set removed_from_status = case when raw->>'pending' = 'true' then 'pending' else 'posted' end
where origin = 'plaid' and provider_status = 'removed' and removed_from_status is null;
