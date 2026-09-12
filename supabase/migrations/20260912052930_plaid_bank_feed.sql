-- Plaid is an importer into the existing card ledger and approval flow.
-- Tokens and provider writes are service-only. Cursors are ACCOUNT scoped:
-- every /transactions/sync request must use options.account_id consistently.

create table if not exists public.plaid_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  item_id text not null,
  environment text not null check (environment in ('sandbox','production')),
  institution_name text,
  status text not null default 'active' check (status in ('active','login_required','disconnected','error')),
  last_error_code text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment,item_id),
  unique (id,company_entity_id)
);
create table if not exists public.plaid_connection_secrets (
  connection_id uuid primary key,
  company_entity_id uuid not null,
  token_ciphertext jsonb not null check (jsonb_typeof(token_ciphertext)='object' and token_ciphertext @> '{"v":1}'::jsonb
    and jsonb_typeof(token_ciphertext->'iv')='string' and jsonb_typeof(token_ciphertext->'ciphertext')='string'
    and token_ciphertext ? 'iv' and token_ciphertext ? 'ciphertext'),
  updated_at timestamptz not null default now(),
  foreign key (connection_id,company_entity_id) references public.plaid_connections(id,company_entity_id)
);
create table if not exists public.plaid_accounts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  connection_id uuid not null,
  provider_account_id text not null,
  name text not null,
  official_name text,
  mask text,
  type text not null,
  subtype text,
  iso_currency_code text,
  current_balance numeric(18,2),
  available_balance numeric(18,2),
  balance_updated_at timestamptz,
  source_id uuid,
  cursor text,
  sync_lease_id uuid,
  sync_lease_expires_at timestamptz,
  last_synced_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id,provider_account_id),
  unique (source_id),
  unique (id,company_entity_id),
  foreign key (connection_id,company_entity_id) references public.plaid_connections(id,company_entity_id),
  foreign key (source_id,company_entity_id) references public.card_sources(id,company_entity_id)
);
alter table public.card_sources
  add column if not exists source_type text not null default 'card' check (source_type in ('card','bank')),
  add column if not exists ingest_mode text not null default 'csv' check (ingest_mode in ('csv','plaid')),
  add column if not exists authoritative_from date;
alter table public.card_import_batches
  add column if not exists origin text not null default 'csv' check (origin in ('csv','plaid')),
  add column if not exists feed_sequence integer;
create unique index if not exists uq_plaid_monthly_batch
  on public.card_import_batches(source_id,period_start,feed_sequence) where origin='plaid';
alter table public.card_transactions
  add column if not exists origin text not null default 'csv' check (origin in ('csv','plaid')),
  add column if not exists plaid_account_id uuid,
  add column if not exists external_transaction_id text,
  add column if not exists pending_transaction_id text,
  add column if not exists provider_status text check (provider_status in ('pending','posted','removed')),
  add column if not exists provider_updated_at timestamptz,
  add column if not exists accounting_treatment text not null default 'unknown'
    check (accounting_treatment in ('purchase','refund','deposit','transfer','card_payment','payroll_settlement','shopify_settlement','unknown'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname='card_transactions_plaid_account_company_fkey') then
    alter table public.card_transactions add constraint card_transactions_plaid_account_company_fkey
      foreign key(plaid_account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='card_transactions_plaid_identity_check') then
    alter table public.card_transactions add constraint card_transactions_plaid_identity_check check (
      (origin='csv' and plaid_account_id is null and external_transaction_id is null and provider_status is null)
      or (origin='plaid' and plaid_account_id is not null and external_transaction_id is not null and provider_status is not null));
  end if;
end $$;

create unique index if not exists uq_plaid_transaction_identity
  on public.card_transactions(plaid_account_id,external_transaction_id) where origin='plaid';
alter table public.card_coding_rules
  add column if not exists direction text not null default 'any' check (direction in ('any','outflow','inflow')),
  add column if not exists accounting_treatment text not null default 'unknown'
    check (accounting_treatment in ('purchase','refund','deposit','transfer','card_payment','payroll_settlement','shopify_settlement','unknown'));

create table if not exists public.plaid_sync_exceptions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  account_id uuid not null,
  transaction_id uuid not null references public.card_transactions(id),
  external_transaction_id text not null,
  previous_payload jsonb,
  provider_payload jsonb not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution_reason text,
  correction_adjustment_id uuid references public.journal_adjustments(id),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(account_id,company_entity_id) references public.plaid_accounts(id,company_entity_id)
);
create unique index if not exists uq_plaid_open_exception on public.plaid_sync_exceptions(account_id,external_transaction_id) where status='open';
create unique index if not exists uq_plaid_exception_correction on public.plaid_sync_exceptions(correction_adjustment_id) where correction_adjustment_id is not null;
create index if not exists idx_plaid_exception_history on public.plaid_sync_exceptions(account_id,external_transaction_id,created_at desc);
create unique index if not exists uq_card_transactions_id_company on public.card_transactions(id,company_entity_id);
do $$ begin
  if not exists(select 1 from pg_constraint where conname='plaid_exception_transaction_company_fkey') then
    alter table public.plaid_sync_exceptions add constraint plaid_exception_transaction_company_fkey
      foreign key(transaction_id,company_entity_id) references public.card_transactions(id,company_entity_id);
  end if;
  if not exists(select 1 from pg_constraint where conname='plaid_exception_correction_company_fkey') then
    alter table public.plaid_sync_exceptions add constraint plaid_exception_correction_company_fkey
      foreign key(correction_adjustment_id,company_entity_id) references public.journal_adjustments(id,company_entity_id);
  end if;
end $$;
create table if not exists public.finance_audit_events (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  object_type text not null,
  object_id uuid not null,
  event_type text not null,
  actor_user_id uuid references auth.users(id),
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_finance_audit_company_time on public.finance_audit_events(company_entity_id,created_at desc);
create index if not exists idx_plaid_accounts_company on public.plaid_accounts(company_entity_id);
create index if not exists idx_plaid_connections_company on public.plaid_connections(company_entity_id);
create index if not exists idx_plaid_exceptions_company on public.plaid_sync_exceptions(company_entity_id,status);

-- Revoke Supabase default grants explicitly, including the ciphertext table.
do $$ declare v_table text; begin
  foreach v_table in array array['plaid_connections','plaid_connection_secrets','plaid_accounts','plaid_sync_exceptions','finance_audit_events'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated',v_table);
    execute format('grant all on public.%I to service_role',v_table);
    if v_table <> 'plaid_connection_secrets' then
      execute format('grant select on public.%I to authenticated',v_table);
      execute format('drop policy if exists %I on public.%I',v_table||'_finance_read',v_table);
      execute format('create policy %I on public.%I for select to authenticated using (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()))',v_table||'_finance_read',v_table);
    end if;
  end loop;
end $$;
revoke insert,update,delete,truncate on public.finance_audit_events from service_role;

create or replace function public.finance_append_audit_event()
returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_old jsonb; v_new jsonb; v_row jsonb; begin
  if tg_op <> 'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new:=to_jsonb(new); end if;
  if v_old is not distinct from v_new then return new; end if;
  v_row:=coalesce(v_new,v_old);
  insert into public.finance_audit_events(company_entity_id,object_type,object_id,event_type,actor_user_id,old_values,new_values)
    values((v_row->>'company_entity_id')::uuid,tg_table_name,(v_row->>'id')::uuid,lower(tg_op),auth.uid(),v_old,v_new);
  return coalesce(new,old);
end $$;
create or replace function public.finance_deny_audit_mutation()
returns trigger language plpgsql as $$ begin raise exception 'Finance audit events are append-only'; end $$;
drop trigger if exists finance_audit_immutable on public.finance_audit_events;
create trigger finance_audit_immutable before update or delete or truncate on public.finance_audit_events
  for each statement execute function public.finance_deny_audit_mutation();
do $$ declare v_table text; begin
  foreach v_table in array array['card_sources','card_import_batches','card_transactions','card_coding_rules','journal_adjustments','journal_adjustment_lines','quickbooks_journal_postings','plaid_connections','plaid_accounts','plaid_sync_exceptions'] loop
    execute format('drop trigger if exists finance_audit_event on public.%I',v_table);
    execute format('create trigger finance_audit_event after insert or update or delete on public.%I for each row execute function public.finance_append_audit_event()',v_table);
  end loop;
end $$;

create or replace function public.plaid_effective_qbo_connection(p_company_id uuid,p_connection_id uuid)
returns uuid language sql stable security definer set search_path='public','pg_temp' as $$
  -- Finance users may import without the admin-only OAuth-table SELECT grant.
  -- Resolve only the connection UUID, scoped to their active company; expose
  -- neither credentials nor metadata from another company.
  select case when auth.uid() is not null and p_company_id is distinct from public.active_company_id() then null
    else coalesce(p_connection_id,(select (array_agg(id))[1] from public.quickbooks_connections
      where company_entity_id=p_company_id and is_active having count(*)=1)) end;
$$;
create or replace function public.plaid_lock_financial_account(p_company_id uuid,p_connection_id uuid,p_qbo_account_id text)
returns void language sql volatile security invoker set search_path='public','pg_temp' as $$
  select pg_advisory_xact_lock(hashtextextended(p_company_id::text||'|'||coalesce(p_connection_id::text,'')||'|'||coalesce(p_qbo_account_id,''),0));
$$;

create or replace function public.plaid_guard_source_authority()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $$
declare v_connection uuid; v_cutover date; begin
  if tg_op='UPDATE' and exists(select 1 from public.plaid_accounts where source_id=old.id) and
    (new.company_entity_id,new.qbo_connection_id,new.credit_qbo_account_id,new.source_type,new.ingest_mode,new.authoritative_from)
      is distinct from (old.company_entity_id,old.qbo_connection_id,old.credit_qbo_account_id,old.source_type,old.ingest_mode,old.authoritative_from) then
    raise exception 'A mapped Plaid source cannot be rebound or change its cutover';
  end if;
  if current_user in ('anon','authenticated') and (new.ingest_mode='plaid' or new.authoritative_from is not null)
    and (tg_op='INSERT' or (new.ingest_mode,new.authoritative_from) is distinct from (old.ingest_mode,old.authoritative_from)) then
    raise exception 'Use configure_plaid_account to enable a bank feed';
  end if;
  v_connection:=public.plaid_effective_qbo_connection(new.company_entity_id,new.qbo_connection_id);
  perform public.plaid_lock_financial_account(new.company_entity_id,v_connection,new.credit_qbo_account_id);
  select min(s.authoritative_from) into v_cutover from public.card_sources s
    where s.company_entity_id=new.company_entity_id and s.ingest_mode='plaid'
      and s.qbo_connection_id=v_connection and s.credit_qbo_account_id=new.credit_qbo_account_id;
  if new.ingest_mode='plaid' then
    if new.authoritative_from is null or new.qbo_connection_id is null or new.credit_qbo_account_id is null then
      raise exception 'Plaid source requires an explicit QuickBooks account and cutover date';
    end if;
    if exists(select 1 from public.card_sources s where s.id<>new.id and s.company_entity_id=new.company_entity_id
      and s.ingest_mode='plaid' and s.qbo_connection_id=new.qbo_connection_id and s.credit_qbo_account_id=new.credit_qbo_account_id) then
      raise exception 'This QuickBooks account already has an authoritative Plaid feed';
    end if;
    v_cutover:=least(v_cutover,new.authoritative_from);
    if exists(select 1 from public.card_transactions t join public.card_import_batches b on b.id=t.batch_id
      join public.card_sources s on s.id=b.source_id where t.origin='csv'
        and s.company_entity_id=new.company_entity_id
        and (s.id=new.id or (public.plaid_effective_qbo_connection(s.company_entity_id,s.qbo_connection_id)=v_connection
        and s.credit_qbo_account_id=new.credit_qbo_account_id))
        and (t.txn_date is null or t.txn_date>=v_cutover)) then
      raise exception 'CSV transactions overlap the Plaid cutover for this QuickBooks account';
    end if;
  elsif v_cutover is not null and exists(select 1 from public.card_transactions t join public.card_import_batches b on b.id=t.batch_id
    where b.source_id=new.id and t.origin='csv' and (t.txn_date is null or t.txn_date>=v_cutover)) then
    raise exception 'CSV transactions overlap the authoritative Plaid feed';
  end if;
  return new;
end $$;
drop trigger if exists plaid_source_authority on public.card_sources;
create trigger plaid_source_authority before insert or update on public.card_sources for each row execute function public.plaid_guard_source_authority();

create or replace function public.plaid_guard_transaction()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $$
declare v_batch public.card_import_batches%rowtype; v_source public.card_sources%rowtype; v_row public.card_transactions%rowtype; v_cutover date; v_connection uuid; begin
  v_row:=case when tg_op='DELETE' then old else new end;
  -- Approval locks the same parent first. Provider and browser writes cannot
  -- race past the frozen snapshot even with service-role RLS bypass.
  select * into v_batch from public.card_import_batches where id=v_row.batch_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if tg_op='UPDATE' and new.batch_id<>old.batch_id then
    if current_user in ('anon','authenticated') or old.origin<>'plaid' or new.origin<>'plaid' then
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
end $$;
drop trigger if exists plaid_transaction_integrity on public.card_transactions;
create trigger plaid_transaction_integrity before insert or update or delete on public.card_transactions for each row execute function public.plaid_guard_transaction();

create or replace function public.plaid_guard_batch()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $$
declare v_source public.card_sources%rowtype; begin
  if tg_op='UPDATE' and (new.source_id,new.company_entity_id) is distinct from (old.source_id,old.company_entity_id)
    and exists(select 1 from public.card_transactions where batch_id=old.id) then
    raise exception 'A populated import batch cannot change its source or company';
  end if;
  if current_user in ('anon','authenticated') then
    if tg_op='DELETE' and old.origin='plaid' then raise exception 'Feed batches cannot be deleted'; end if;
    if tg_op='INSERT' and new.origin='plaid' then raise exception 'Feed batches are server-owned'; end if;
    if tg_op='UPDATE' and (old.origin='plaid' or new.origin='plaid') and
      (new.origin,new.source_id,new.period_start,new.period_end,new.feed_sequence,new.company_entity_id)
      is distinct from (old.origin,old.source_id,old.period_start,old.period_end,old.feed_sequence,old.company_entity_id) then
      raise exception 'Feed batch identity is server-owned';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.status='approved' and (tg_op='INSERT' or old.status<>'approved') then
    -- Existing Mark unposted preserves its reviewed snapshot while retiring
    -- the old posting claim. It must remain possible to reopen next, even
    -- when a provider exception is the reason the QBO entry was removed.
    if tg_op='UPDATE' and old.status='posted' and new.approval_snapshot is not distinct from old.approval_snapshot
      and new.approval_hash is not distinct from old.approval_hash and new.approval_version=old.approval_version then return new; end if;
    select * into v_source from public.card_sources where id=new.source_id;
    if exists(select 1 from public.plaid_sync_exceptions e join public.plaid_accounts a on a.id=e.account_id
      where a.source_id=new.source_id and e.status='open') then raise exception 'Resolve the bank feed change before approval'; end if;
    if exists(select 1 from public.card_transactions t where t.batch_id=new.id and t.origin='plaid' and t.status='coded'
      and (t.provider_status<>'posted' or t.currency is distinct from 'USD' or t.accounting_treatment='unknown')) then
      raise exception 'Included feed transactions require posted USD data and an accounting treatment';
    end if;
    if exists(select 1 from public.card_transactions t join public.quickbooks_accounts a
      on a.connection_id=new.qbo_connection_id and a.qbo_account_id=t.qbo_account_id and a.company_entity_id=new.company_entity_id
      where t.batch_id=new.id and t.origin='plaid' and t.status='coded' and
        ((t.accounting_treatment='purchase' and t.amount<=0)
        or (t.accounting_treatment in ('refund','deposit') and t.amount>=0)
        or (t.accounting_treatment in ('transfer','payroll_settlement','shopify_settlement') and a.account_type not in ('Other Current Asset','Other Current Liability'))
        or (t.accounting_treatment='card_payment' and (v_source.source_type='card' or a.account_type not in ('Credit Card','Accounts Payable'))))) then
      raise exception 'Review feed direction and clearing-account treatment; the bank feed owns card payments';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists plaid_batch_integrity on public.card_import_batches;
create trigger plaid_batch_integrity before insert or update or delete on public.card_import_batches for each row execute function public.plaid_guard_batch();

-- Resolve authorization and the active company from one database snapshot so
-- a tab changing companies cannot race a separate permission/profile lookup.
create or replace function public.plaid_finance_context()
returns uuid language sql stable security invoker set search_path='public','pg_temp' as $$
  select case when auth.uid() is not null and public.can_manage_journal_entries()
    and exists(select 1 from public.profiles where id=auth.uid() and is_active)
    then public.active_company_id() else null end;
$$;

create or replace function public.plaid_register_connection(
  p_company_id uuid,p_item_id text,p_environment text,p_institution_name text,
  p_token_ciphertext jsonb,p_accounts jsonb,p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_connection public.plaid_connections%rowtype; v_account jsonb; begin
  if nullif(p_item_id,'') is null or p_environment not in ('sandbox','production')
    or jsonb_typeof(p_accounts) is distinct from 'array' then raise exception 'Invalid Plaid connection data'; end if;
  if not exists(select 1 from public.profiles p left join public.entity_memberships em
    on em.user_id=p.id and em.entity_id=p.active_company_id
    where p.id=p_actor_user_id and p.is_active and p.active_company_id=p_company_id
      and (p.department in ('finance','exec') or p.role::text in ('owner','executive') or em.role='owner_admin')) then
    raise exception 'Active finance connecting user required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plaid-item|'||p_environment||'|'||p_item_id,0));
  select * into v_connection from public.plaid_connections where environment=p_environment and item_id=p_item_id for update;
  if found and v_connection.company_entity_id<>p_company_id then raise exception 'Plaid Item is already linked to another company'; end if;
  if v_connection.id is null then
    insert into public.plaid_connections(company_entity_id,item_id,environment,institution_name,created_by)
      values(p_company_id,p_item_id,p_environment,p_institution_name,p_actor_user_id) returning * into v_connection;
  else
    update public.plaid_connections set institution_name=coalesce(p_institution_name,institution_name),
      status=case when status='disconnected' then status else 'active' end,last_error_code=null,updated_at=now()
      where id=v_connection.id;
  end if;
  insert into public.plaid_connection_secrets(connection_id,company_entity_id,token_ciphertext)
    values(v_connection.id,p_company_id,p_token_ciphertext)
    on conflict(connection_id) do update set token_ciphertext=excluded.token_ciphertext,updated_at=now();
  for v_account in select value from jsonb_array_elements(p_accounts) loop
    if nullif(v_account->>'account_id','') is null or nullif(v_account->>'name','') is null or nullif(v_account->>'type','') is null then
      raise exception 'Invalid Plaid account metadata';
    end if;
    insert into public.plaid_accounts(company_entity_id,connection_id,provider_account_id,name,official_name,mask,type,subtype,
      iso_currency_code,current_balance,available_balance,balance_updated_at)
      values(p_company_id,v_connection.id,v_account->>'account_id',v_account->>'name',v_account->>'official_name',v_account->>'mask',
        v_account->>'type',v_account->>'subtype',v_account#>>'{balances,iso_currency_code}',
        (v_account#>>'{balances,current}')::numeric,(v_account#>>'{balances,available}')::numeric,now())
      on conflict(connection_id,provider_account_id) do update set name=excluded.name,official_name=excluded.official_name,mask=excluded.mask,
        type=excluded.type,subtype=excluded.subtype,iso_currency_code=excluded.iso_currency_code,current_balance=excluded.current_balance,
        available_balance=excluded.available_balance,balance_updated_at=now(),updated_at=now();
  end loop;
  return jsonb_build_object('connection_id',v_connection.id);
end $$;

create or replace function public.configure_plaid_account(
  p_account_id uuid,p_qbo_connection_id uuid,p_qbo_account_id text,p_authoritative_from date,p_source_id uuid default null
) returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_company uuid:=public.active_company_id(); v_account public.plaid_accounts%rowtype;
  v_source public.card_sources%rowtype; v_qbo public.quickbooks_accounts%rowtype; v_source_id uuid;
begin
  if auth.uid() is null or v_company is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  select * into v_account from public.plaid_accounts where id=p_account_id and company_entity_id=v_company for update;
  if not found then raise exception 'Plaid account not found'; end if;
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then raise exception 'Wait for account sync to finish'; end if;
  if v_account.type not in ('depository','credit') then raise exception 'Only bank and credit card accounts are supported'; end if;
  if v_account.iso_currency_code is distinct from 'USD' then raise exception 'Only USD bank and card accounts are supported'; end if;
  if p_authoritative_from is null then raise exception 'An explicit CSV cutover date is required'; end if;
  if not exists(select 1 from public.quickbooks_connections where id=p_qbo_connection_id and company_entity_id=v_company and is_active) then
    raise exception 'QuickBooks connection is not active for this company';
  end if;
  select * into v_qbo from public.quickbooks_accounts where connection_id=p_qbo_connection_id and company_entity_id=v_company
    and qbo_account_id=p_qbo_account_id and is_active;
  if not found or (v_account.type='depository' and v_qbo.account_type<>'Bank')
    or (v_account.type='credit' and v_qbo.account_type not in ('Credit Card','Accounts Payable')) then
    raise exception 'Select the matching bank or card liability account';
  end if;
  if v_qbo.currency is not null and v_qbo.currency<>'USD' then raise exception 'QuickBooks balancing account must use USD'; end if;
  if p_source_id is not null then
    select * into v_source from public.card_sources where id=p_source_id and company_entity_id=v_company for update;
    if not found then raise exception 'Source not found'; end if;
  end if;
  perform public.plaid_lock_financial_account(v_company,p_qbo_connection_id,p_qbo_account_id);
  if v_account.source_id is not null then
    select * into v_source from public.card_sources where id=v_account.source_id;
    if (v_source.qbo_connection_id,v_source.credit_qbo_account_id,v_source.authoritative_from)
      is not distinct from (p_qbo_connection_id,p_qbo_account_id,p_authoritative_from)
      and (p_source_id is null or p_source_id=v_account.source_id) then
      return jsonb_build_object('source_id',v_account.source_id,'already_configured',true);
    end if;
    raise exception 'A mapped feed cannot be rebound or change its cutover';
  end if;
  if p_source_id is not null then
    select * into v_source from public.card_sources where id=p_source_id and company_entity_id=v_company for update;
    if not found then raise exception 'Source not found'; end if;
    if exists(select 1 from public.plaid_accounts where source_id=p_source_id) then raise exception 'Source already has a Plaid account'; end if;
    if v_source.credit_qbo_account_id is not null and v_source.credit_qbo_account_id<>p_qbo_account_id then
      raise exception 'Existing source has a different balancing account';
    end if;
    if v_source.qbo_connection_id is not null and v_source.qbo_connection_id<>p_qbo_connection_id then
      raise exception 'Existing source has a different QuickBooks connection';
    end if;
    v_source_id:=p_source_id;
    update public.card_sources set qbo_connection_id=p_qbo_connection_id,credit_qbo_account_id=p_qbo_account_id,
      credit_qbo_account_name=v_qbo.name,credit_qbo_account_type=v_qbo.account_type,
      source_type=case when v_account.type='credit' then 'card' else 'bank' end,ingest_mode='plaid',authoritative_from=p_authoritative_from,
      updated_at=now() where id=v_source_id;
  else
    insert into public.card_sources(company_entity_id,source_key,display_name,qbo_connection_id,credit_qbo_account_id,
      credit_qbo_account_name,credit_qbo_account_type,source_type,ingest_mode,authoritative_from,created_by)
      values(v_company,'plaid_'||p_account_id::text,v_account.name,p_qbo_connection_id,p_qbo_account_id,v_qbo.name,v_qbo.account_type,
        case when v_account.type='credit' then 'card' else 'bank' end,'plaid',p_authoritative_from,auth.uid()) returning id into v_source_id;
  end if;
  update public.plaid_accounts set source_id=v_source_id,updated_at=now() where id=p_account_id;
  return jsonb_build_object('source_id',v_source_id);
end $$;

create or replace function public.plaid_claim_sync(p_account_id uuid,p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_account public.plaid_accounts%rowtype; begin
  if p_lease_id is null then raise exception 'Sync lease id required'; end if;
  select * into v_account from public.plaid_accounts where id=p_account_id for update;
  if not found or v_account.source_id is null then raise exception 'Configure the feed account before syncing'; end if;
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then raise exception 'Sync already running'; end if;
  if not exists(select 1 from public.card_sources where id=v_account.source_id and is_active and ingest_mode='plaid') then raise exception 'Feed source is inactive'; end if;
  if not exists(select 1 from public.plaid_connections where id=v_account.connection_id and status in ('active','error')) then raise exception 'Repair the Plaid connection before syncing'; end if;
  update public.plaid_accounts set sync_lease_id=p_lease_id,sync_lease_expires_at=now()+interval '5 minutes',updated_at=now() where id=p_account_id;
  return jsonb_build_object('cursor',v_account.cursor,'lease_id',p_lease_id,'provider_account_id',v_account.provider_account_id,
    'connection_id',v_account.connection_id,'company_entity_id',v_account.company_entity_id,'source_id',v_account.source_id);
end $$;
create or replace function public.plaid_release_sync(p_account_id uuid,p_lease_id uuid,p_error_code text)
returns void language plpgsql security definer set search_path='public','pg_temp' as $$
begin
  update public.plaid_accounts set sync_lease_id=null,sync_lease_expires_at=null,last_error_code=left(p_error_code,120),updated_at=now()
    where id=p_account_id and sync_lease_id=p_lease_id;
  if found and p_error_code in ('ITEM_LOGIN_REQUIRED','ITEM_LOCKED','ITEM_NOT_SUPPORTED','ACCESS_NOT_GRANTED') then
    update public.plaid_connections set status='login_required',last_error_code=p_error_code,updated_at=now()
      where id=(select connection_id from public.plaid_accounts where id=p_account_id) and status<>'disconnected';
  end if;
end $$;

create or replace function public.plaid_open_monthly_batch(p_account_id uuid,p_date date)
returns uuid language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_account public.plaid_accounts%rowtype; v_source public.card_sources%rowtype; v_month date:=date_trunc('month',p_date)::date;
  v_batch_id uuid; v_sequence integer;
begin
  select * into v_account from public.plaid_accounts where id=p_account_id;
  select * into v_source from public.card_sources where id=v_account.source_id;
  select id into v_batch_id from public.card_import_batches where source_id=v_account.source_id and origin='plaid'
    and period_start=v_month and status in ('draft','categorized') order by feed_sequence desc limit 1 for update;
  if v_batch_id is not null then return v_batch_id; end if;
  select coalesce(max(feed_sequence),0)+1 into v_sequence from public.card_import_batches where source_id=v_account.source_id and period_start=v_month and origin='plaid';
  insert into public.card_import_batches(company_entity_id,source_id,qbo_connection_id,label,period_start,period_end,entry_date,origin,feed_sequence)
    values(v_account.company_entity_id,v_account.source_id,v_source.qbo_connection_id,
      to_char(v_month,'YYYY-MM')||' bank feed'||case when v_sequence>1 then ' · continuation '||v_sequence else '' end,
      v_month,(v_month+interval '1 month - 1 day')::date,(v_month+interval '1 month - 1 day')::date,'plaid',v_sequence)
    returning id into v_batch_id;
  return v_batch_id;
end $$;

-- Fields affecting accounting, coding context, or the reviewed description.
-- Provider location/enrichment/confidence changes alone need audit, not a JE.
create or replace function public.plaid_accounting_facts(p_payload jsonb)
returns jsonb language sql immutable security invoker set search_path='public','pg_temp' as $$
  select jsonb_build_array(p_payload->'amount',p_payload->'date',p_payload->'authorized_date',p_payload->'pending',
    p_payload->'name',p_payload->'merchant_name',p_payload->'iso_currency_code',p_payload->'unofficial_currency_code',
    p_payload->'pending_transaction_id',p_payload#>'{personal_finance_category,primary}',
    coalesce(p_payload->'_silo_removed','false'::jsonb));
$$;

-- Internal projection. The account row lease serializes callers; child writes
-- also take the approval parent lock. raw remains the authoritative Plaid row.
create or replace function public.plaid_project_transaction(p_account_id uuid,p_payload jsonb,p_removed boolean default false)
returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_account public.plaid_accounts%rowtype; v_source public.card_sources%rowtype;
  v_old public.card_transactions%rowtype; v_exception public.plaid_sync_exceptions%rowtype;
  v_batch public.card_import_batches%rowtype; v_payload jsonb; v_latest_payload jsonb; v_date date; v_amount numeric(14,2); v_currency text;
  v_provider_status text; v_status text; v_reason text; v_treatment text; v_id uuid; v_batch_id uuid; v_previous jsonb; v_row_no integer;
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
      pending_transaction_id=v_payload->>'pending_transaction_id',provider_status=v_provider_status,provider_updated_at=now(),
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
end $$;

create or replace function public.plaid_apply_sync(
  p_account_id uuid,p_lease_id uuid,p_expected_cursor text,p_next_cursor text,
  p_added jsonb,p_modified jsonb,p_removed jsonb,p_accounts jsonb
) returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_account public.plaid_accounts%rowtype; v_connection uuid; v_payload jsonb; v_result jsonb; v_batches uuid[]:='{}'; v_batch uuid; v_open integer;
begin
  select connection_id into v_connection from public.plaid_accounts where id=p_account_id;
  -- Keep connection -> account lock order consistent with registration/repair.
  perform 1 from public.plaid_connections where id=v_connection and status in ('active','error') for update;
  if not found then raise exception 'Plaid connection is paused or requires repair'; end if;
  select * into v_account from public.plaid_accounts where id=p_account_id for update;
  if not found or p_lease_id is null or v_account.sync_lease_id is distinct from p_lease_id
    or v_account.sync_lease_expires_at is null or v_account.sync_lease_expires_at<=now() then raise exception 'Sync lease expired or no longer owned'; end if;
  if v_account.cursor is distinct from p_expected_cursor then raise exception 'Stale Plaid cursor'; end if;
  if not exists(select 1 from public.card_sources where id=v_account.source_id and is_active and ingest_mode='plaid') then
    raise exception 'Feed source is inactive';
  end if;
  -- Date corrections may move between months. Lock existing parents in the
  -- same stable order as coding saves before processing any row of the cycle.
  perform 1 from public.card_import_batches where source_id=v_account.source_id order by id for update;
  if nullif(p_next_cursor,'') is null or jsonb_typeof(p_added) is distinct from 'array'
    or jsonb_typeof(p_modified) is distinct from 'array' or jsonb_typeof(p_removed) is distinct from 'array'
    or jsonb_typeof(p_accounts) is distinct from 'array' then raise exception 'Complete Plaid sync arrays and next cursor required'; end if;
  if jsonb_array_length(p_added)+jsonb_array_length(p_modified)+jsonb_array_length(p_removed)>20000 then raise exception 'Plaid sync cycle is too large'; end if;
  for v_payload in select value from jsonb_array_elements(p_added||p_modified) loop
    v_result:=public.plaid_project_transaction(p_account_id,v_payload,false);
    v_batch:=(v_result->>'batch_id')::uuid;
    if v_batch is not null then v_batches:=array_append(v_batches,v_batch); end if;
    if nullif(v_payload->>'pending_transaction_id','') is not null and v_payload->>'pending_transaction_id'<>v_payload->>'transaction_id' then
      v_result:=public.plaid_project_transaction(p_account_id,jsonb_build_object('transaction_id',v_payload->>'pending_transaction_id','account_id',v_account.provider_account_id),true);
      v_batch:=(v_result->>'batch_id')::uuid;
      if v_batch is not null then v_batches:=array_append(v_batches,v_batch); end if;
    end if;
  end loop;
  for v_payload in select value from jsonb_array_elements(p_removed) loop
    if v_payload->>'account_id' is not null and v_payload->>'account_id'<>v_account.provider_account_id then raise exception 'Removed Plaid transaction belongs to another account'; end if;
    v_result:=public.plaid_project_transaction(p_account_id,v_payload||jsonb_build_object('account_id',v_account.provider_account_id),true);
    v_batch:=(v_result->>'batch_id')::uuid;
    if v_batch is not null then v_batches:=array_append(v_batches,v_batch); end if;
  end loop;
  for v_payload in select value from jsonb_array_elements(p_accounts) loop
    if v_payload->>'account_id'=v_account.provider_account_id then
      update public.plaid_accounts set name=coalesce(v_payload->>'name',name),official_name=v_payload->>'official_name',mask=v_payload->>'mask',
        iso_currency_code=v_payload#>>'{balances,iso_currency_code}',current_balance=(v_payload#>>'{balances,current}')::numeric,
        available_balance=(v_payload#>>'{balances,available}')::numeric,balance_updated_at=now() where id=p_account_id;
    end if;
  end loop;
  update public.plaid_accounts set cursor=p_next_cursor,sync_lease_id=null,sync_lease_expires_at=null,
    last_synced_at=now(),last_error_code=null,updated_at=now() where id=p_account_id;
  update public.plaid_connections set status='active',last_error_code=null,updated_at=now()
    where id=v_account.connection_id and status in ('active','error');
  select count(*) into v_open from public.plaid_sync_exceptions where account_id=p_account_id and status='open';
  return jsonb_build_object('added',jsonb_array_length(p_added),'modified',jsonb_array_length(p_modified),'removed',jsonb_array_length(p_removed),
    'exceptions',v_open,'batch_ids',(select coalesce(jsonb_agg(distinct x),'[]'::jsonb) from unnest(v_batches) x));
end $$;

create or replace function public.resolve_plaid_exception(p_exception_id uuid,p_reason text,p_correction_adjustment_id uuid default null)
returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_company uuid:=public.active_company_id(); v_account public.plaid_accounts%rowtype;
  v_exception public.plaid_sync_exceptions%rowtype; v_tx public.card_transactions%rowtype;
  v_batch public.card_import_batches%rowtype; v_correction public.journal_adjustments%rowtype; v_result jsonb;
begin
  if auth.uid() is null or v_company is null or not(public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'An accounting resolution reason is required'; end if;
  select a.* into v_account from public.plaid_accounts a join public.plaid_sync_exceptions e on e.account_id=a.id
    where e.id=p_exception_id and e.company_entity_id=v_company for update of a;
  if not found then raise exception 'Feed exception not found'; end if;
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then raise exception 'Wait for account sync to finish'; end if;
  perform 1 from public.card_import_batches where source_id=v_account.source_id order by id for update;
  select * into v_exception from public.plaid_sync_exceptions where id=p_exception_id and company_entity_id=v_company for update;
  if v_exception.status<>'open' then return jsonb_build_object('resolved',true,'transaction_id',v_exception.transaction_id,'already_resolved',true); end if;
  select * into v_tx from public.card_transactions where id=v_exception.transaction_id and company_entity_id=v_company;
  select * into v_batch from public.card_import_batches where id=v_tx.batch_id and company_entity_id=v_company for update;
  if v_batch.status='approved' then raise exception 'Reopen the approved batch before applying the bank change'; end if;
  if v_batch.status in ('draft','categorized') then
    if p_correction_adjustment_id is not null then raise exception 'An unposted batch must apply the provider update directly'; end if;
    -- Remove the open exception first in this same transaction so projection
    -- can update the reopened row; failure rolls both operations back together.
    update public.plaid_sync_exceptions set status='resolved',resolution_reason=trim(p_reason),resolved_by=auth.uid(),resolved_at=now(),updated_at=now()
      where id=p_exception_id;
    -- The projector's unchanged check only applies to frozen history here.
    v_result:=public.plaid_project_transaction(p_account_id=>v_account.id,p_payload=>v_exception.provider_payload,
      p_removed=>coalesce((v_exception.provider_payload->>'_silo_removed')::boolean,false));
  elsif v_batch.status='posted' then
    if p_correction_adjustment_id is null then raise exception 'Post a correction in the existing journal composer and link it to this exception'; end if;
    select * into v_correction from public.journal_adjustments where id=p_correction_adjustment_id and company_entity_id=v_company for update;
    if not found or v_correction.status<>'posted' or v_correction.qbo_connection_id is distinct from v_batch.qbo_connection_id
      or not exists(select 1 from public.quickbooks_journal_postings p where p.id=v_correction.posting_id and p.status='posted'
        and p.company_entity_id=v_company and p.connection_id=v_batch.qbo_connection_id and p.qbo_journal_entry_id is not null) then
      raise exception 'A confirmed posted correction on the same QuickBooks connection is required';
    end if;
    update public.plaid_sync_exceptions set status='resolved',resolution_reason=trim(p_reason),correction_adjustment_id=p_correction_adjustment_id,
      resolved_by=auth.uid(),resolved_at=now(),updated_at=now() where id=p_exception_id;
  else
    raise exception 'Resolve the original journal state before this bank feed exception';
  end if;
  return jsonb_build_object('resolved',true,'transaction_id',v_exception.transaction_id);
end $$;

-- A provider edit can arrive after approval but before QBO submission. Retain
-- the frozen hash check, blocking new posts but allowing exact claim recovery.
create or replace function public.finance_approval_hash_matches(
  p_source_type text,p_source_id uuid,p_expected_hash text,p_expected_version bigint
) returns boolean language sql stable security invoker set search_path='public','extensions','pg_temp' as $$
  select coalesce(case p_source_type
    when 'card_import_batches' then (
      select b.status='approved' and b.approval_snapshot is not null
        and b.approval_hash = p_expected_hash and b.approval_version = p_expected_version
        and public.finance_approval_snapshot_hash(b.approval_snapshot)=b.approval_hash
        and (not exists(select 1 from public.plaid_sync_exceptions e join public.plaid_accounts a on a.id=e.account_id
          where a.source_id=b.source_id and e.status='open')
          or exists(select 1 from public.quickbooks_journal_postings p where p.company_entity_id=b.company_entity_id
            and p.connection_id=b.qbo_connection_id and p.source='card_import' and p.source_ref=b.id::text
            and p.payload_hash=b.approval_hash and p.status in ('submitting','unknown','posted')))
      from public.card_import_batches b where b.id=p_source_id)
    when 'journal_adjustments' then (
      select a.status='approved' and a.approval_snapshot is not null
        and a.approval_hash = p_expected_hash and a.approval_version = p_expected_version
        and public.finance_approval_snapshot_hash(a.approval_snapshot)=a.approval_hash
      from public.journal_adjustments a where a.id=p_source_id)
    else false end,false);
$$;

-- Recovery must keep working after a provider edit to an already-attempted
-- journal. Hash verification above allows only its exact existing claim. Every
-- NEW attempt takes the sync locks and refuses unresolved provider changes.
create or replace function public.plaid_guard_new_posting_claim()
returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_batch public.card_import_batches%rowtype; begin
  if new.source<>'card_import' or new.status<>'submitting' then return new; end if;
  select * into v_batch from public.card_import_batches where id=new.source_ref::uuid;
  if not found then raise exception 'Card batch not found for posting claim'; end if;
  if not exists(select 1 from public.plaid_accounts where source_id=v_batch.source_id) then return new; end if;
  perform 1 from public.plaid_accounts where source_id=v_batch.source_id for update;
  select * into v_batch from public.card_import_batches where id=v_batch.id for update;
  if v_batch.status<>'approved' or new.company_entity_id is distinct from v_batch.company_entity_id
    or new.connection_id is distinct from v_batch.qbo_connection_id
    or new.payload_hash is null or new.payload_hash is distinct from v_batch.approval_hash then
    raise exception 'Posting claim must match the approved bank batch and connection';
  end if;
  if exists(select 1 from public.plaid_sync_exceptions e join public.plaid_accounts a on a.id=e.account_id
    where a.source_id=v_batch.source_id and e.status='open') then
    raise exception 'Resolve the bank feed change before a new posting attempt';
  end if;
  return new;
end $$;
drop trigger if exists plaid_new_posting_claim on public.quickbooks_journal_postings;
create trigger plaid_new_posting_claim before insert on public.quickbooks_journal_postings
  for each row execute function public.plaid_guard_new_posting_claim();

-- Retain the existing save RPC and RLS; treatment is the sole added coding
-- field. Missing treatment in legacy CSV callers preserves its current value.
create or replace function public.apply_card_coding(p_rows jsonb)
returns integer language plpgsql security invoker set search_path='public' as $$
declare v_count integer; begin
  if p_rows is null or jsonb_typeof(p_rows)<>'array' then raise exception 'apply_card_coding expects a json array of rows'; end if;
  -- Lock parents in a stable order before checking provider revisions. Sync
  -- takes the same locks, so validation and save see one provider version.
  perform 1 from public.card_import_batches b where b.id in (
    select t.batch_id from public.card_transactions t join jsonb_to_recordset(p_rows) as r(id uuid) on r.id=t.id)
    order by b.id for update;
  if exists(select 1 from public.card_transactions t join jsonb_to_recordset(p_rows)
    as r(id uuid,expected_provider_updated_at timestamptz) on r.id=t.id
    where t.origin='plaid' and t.provider_updated_at is distinct from r.expected_provider_updated_at) then
    raise exception 'provider_transaction_changed: reload and review the bank transaction before saving';
  end if;
  update public.card_transactions t set
    qbo_account_id=r.qbo_account_id,qbo_account_name=r.qbo_account_name,qbo_location_id=r.qbo_location_id,qbo_location_name=r.qbo_location_name,
    entity_qbo_id=r.entity_qbo_id,entity_name=r.entity_name,entity_type=r.entity_type,vendor_name=r.vendor_name,memo=r.memo,
    coding_source=r.coding_source,confidence=r.confidence,ai_reasoning=r.ai_reasoning,rule_id=r.rule_id,status=coalesce(r.status,t.status),
    exclude_reason=r.exclude_reason,coding_conflict=r.coding_conflict,accounting_treatment=coalesce(r.accounting_treatment,t.accounting_treatment),
    updated_at=now(),updated_by=auth.uid()
    from jsonb_to_recordset(p_rows) as r(id uuid,qbo_account_id text,qbo_account_name text,qbo_location_id text,qbo_location_name text,
      entity_qbo_id text,entity_name text,entity_type text,vendor_name text,memo text,coding_source text,confidence numeric,ai_reasoning text,
      rule_id uuid,status text,exclude_reason text,coding_conflict text,accounting_treatment text) where t.id=r.id;
  get diagnostics v_count=row_count;
  update public.card_coding_rules cr set hit_count=cr.hit_count+hits.n,last_used_at=now()
    from(select (value->>'rule_id')::uuid rid,count(*) n from jsonb_array_elements(p_rows)
      where value->>'rule_id' is not null and value->>'coding_source'='rule' group by 1) hits where cr.id=hits.rid;
  return v_count;
end $$;
do $$ declare v_constraint text; begin
  for v_constraint in select conname from pg_constraint where conrelid='public.card_coding_rules'::regclass and contype='u'
    and pg_get_constraintdef(oid)='UNIQUE (company_entity_id, source_id, match_type, pattern)' loop
    execute format('alter table public.card_coding_rules drop constraint %I',v_constraint);
  end loop;
  alter table public.card_coding_rules drop constraint if exists card_coding_rules_source_direction_key;
end $$;
drop index if exists public.uq_card_rules_pattern;
create unique index uq_card_rules_pattern on public.card_coding_rules
  (company_entity_id,coalesce(source_id,'00000000-0000-0000-0000-000000000000'::uuid),match_field,match_type,pattern,direction);

-- Service operations and internal helpers are never browser RPCs. Explicitly
-- undo broad Supabase default EXECUTE grants, including PUBLIC and anon.
do $$ declare v_function record; begin
  for v_function in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname in ('plaid_register_connection','plaid_claim_sync','plaid_release_sync','plaid_apply_sync','plaid_project_transaction','plaid_open_monthly_batch','plaid_accounting_facts',
      'finance_append_audit_event','finance_deny_audit_mutation','plaid_guard_source_authority','plaid_guard_transaction','plaid_guard_batch','plaid_guard_new_posting_claim') loop
    execute format('revoke all on function %s from public,anon,authenticated',v_function.signature);
    execute format('grant execute on function %s to service_role',v_function.signature);
  end loop;
end $$;
revoke all on function public.configure_plaid_account(uuid,uuid,text,date,uuid) from public,anon;
grant execute on function public.configure_plaid_account(uuid,uuid,text,date,uuid) to authenticated;
revoke all on function public.resolve_plaid_exception(uuid,text,uuid) from public,anon;
grant execute on function public.resolve_plaid_exception(uuid,text,uuid) to authenticated;
revoke all on function public.finance_approval_hash_matches(text,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.finance_approval_hash_matches(text,uuid,text,bigint) to service_role;
revoke all on function public.apply_card_coding(jsonb) from public,anon;
grant execute on function public.apply_card_coding(jsonb) to authenticated,service_role;
revoke all on function public.plaid_effective_qbo_connection(uuid,uuid) from public,anon;
grant execute on function public.plaid_effective_qbo_connection(uuid,uuid) to authenticated,service_role;
revoke all on function public.plaid_lock_financial_account(uuid,uuid,text) from public,anon;
grant execute on function public.plaid_lock_financial_account(uuid,uuid,text) to authenticated,service_role;
revoke all on function public.plaid_finance_context() from public,anon,service_role;
grant execute on function public.plaid_finance_context() to authenticated;

-- Existing SELECT * views must be replaced to expose the appended fields.
drop view if exists public.card_transactions_v;
create view public.card_transactions_v with (security_invoker=true) as
select t.*,b.status as batch_status,b.label as batch_label,b.entry_date as batch_entry_date,
  s.display_name as source_name,s.source_key as source_key,public.normalize_merchant(coalesce(t.clean_merchant,t.description)) as merchant_norm
from public.card_transactions t join public.card_import_batches b on b.id=t.batch_id join public.card_sources s on s.id=b.source_id;
grant select on public.card_transactions_v to authenticated;
drop view if exists public.card_import_batches_v;
create view public.card_import_batches_v with (security_invoker=true) as
select b.*,s.display_name as source_name,s.source_key,s.credit_qbo_account_name as credit_account_name,
  s.credit_qbo_account_type as credit_account_type,s.posting_enabled as source_posting_enabled,
  cp.name as created_by_name,ap.name as approved_by_name,p.status as posting_status,
  p.qbo_journal_entry_id,p.qbo_doc_number,
  (select count(*) from public.card_transactions t where t.batch_id=b.id) as txn_count,
  (select count(*) from public.card_transactions t where t.batch_id=b.id and t.status='uncoded') as uncoded_count,
  (select count(*) from public.card_transactions t where t.batch_id=b.id and t.status='excluded') as excluded_count,
  (select coalesce(sum(t.amount),0) from public.card_transactions t where t.batch_id=b.id and t.status='coded') as coded_amount
from public.card_import_batches b join public.card_sources s on s.id=b.source_id
left join public.profiles cp on cp.id=b.created_by left join public.profiles ap on ap.id=b.approved_by
left join public.quickbooks_journal_postings p on p.id=b.posting_id;
grant select on public.card_import_batches_v to authenticated;

-- Refresh known ledger columns without advertising connector credentials or
-- operational state tables as report-building sources.
do $$ begin
  if to_regclass('public.silo_chat_schema_catalog') is not null
    and to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
    update public.silo_chat_schema_catalog set is_hidden=true
      where relname in ('plaid_connection_secrets','plaid_connections','plaid_accounts','plaid_sync_exceptions','finance_audit_events');
  end if;
end $$;
