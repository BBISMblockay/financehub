-- QBO-seeded onboarding. An accepted baseline is LOCAL opening history, never
-- an outbound journal. Existing approval and QBO write paths are unchanged.
create table if not exists public.accounting_settings (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null unique references public.entities(id),
  qbo_connection_id uuid not null references public.quickbooks_connections(id),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  fiscal_year_start_month integer not null check (fiscal_year_start_month between 1 and 12),
  accounting_start_date date not null,
  accounting_basis text not null check (accounting_basis in ('Accrual','Cash')),
  books_authority text not null default 'qbo' check (books_authority='qbo'),
  created_at timestamptz not null default now()
);
create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  qbo_connection_id uuid not null references public.quickbooks_connections(id),
  qbo_account_id text not null,
  name text not null,
  account_type text not null,
  is_active boolean not null,
  source_snapshot jsonb not null,
  seeded_at timestamptz not null default now(),
  unique(company_entity_id,qbo_connection_id,qbo_account_id)
);
create table if not exists public.accounting_opening_balances (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null unique references public.entities(id),
  report_run_id uuid not null references public.quickbooks_report_runs(id),
  snapshot jsonb not null,
  snapshot_hash text not null,
  status text not null default 'draft' check(status in ('draft','accepted')),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
-- RPC-only mutation: no client can forge acceptance, inject balances or remap
-- another company's accounts. Explicit revokes cover Supabase default grants.
do $$ declare t text; begin
  foreach t in array array['accounting_settings','accounting_accounts','accounting_opening_balances'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('drop policy if exists accounting_finance_read on public.%I',t);
    execute format('create policy accounting_finance_read on public.%I for select to authenticated using (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()))',t);
    execute format('drop trigger if exists finance_audit_event on public.%I',t);
    execute format('create trigger finance_audit_event after insert or update or delete on public.%I for each row execute function public.finance_append_audit_event()',t);
  end loop;
end $$;

create or replace function public.seed_accounting_from_qbo(p_report_id uuid,p_fiscal_month integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  co uuid:=public.active_company_id(); r public.quickbooks_report_runs%rowtype;
  s public.accounting_settings%rowtype; b public.accounting_opening_balances%rowtype;
  item jsonb; n_totals integer; totals jsonb; cols jsonb; lines jsonb:='[]'; snap jsonb; account public.accounting_accounts%rowtype;
  currency text; basis text; cutoff date; debit numeric; credit numeric;
  debits numeric:=0; credits numeric:=0; seen text[]:='{}'; qid text;
begin
  if auth.uid() is null or co is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required'; end if;
  -- Serialize initial creation and re-seeding, including an empty company.
  perform 1 from public.entities where id=co for update;
  select * into b from public.accounting_opening_balances where company_entity_id=co for update;
  if b.status='accepted' then raise exception 'Opening balances already accepted; historical baseline is immutable'; end if;
  select * into r from public.quickbooks_report_runs where id=p_report_id and company_entity_id=co and report_name='TrialBalance' and status='ok' for share;
  if not found then raise exception 'Select a successful trial balance for this company'; end if;
  if not exists(select 1 from public.quickbooks_connections where id=r.connection_id and company_entity_id=co and is_active) then
    raise exception 'The report must belong to an active QBO connection in this company'; end if;
  cutoff:=r.end_date; currency:=r.raw_response#>>'{Header,Currency}'; basis:=r.raw_response#>>'{Header,ReportBasis}';
  if cutoff is null or r.raw_response#>>'{Header,EndPeriod}' is distinct from cutoff::text
    or r.raw_response#>>'{Header,ReportName}' is distinct from 'TrialBalance'
    or currency is null or currency !~ '^[A-Z]{3}$' or basis is null or basis not in ('Accrual','Cash') then
    raise exception 'Report header must confirm trial balance, cutover date, currency and accounting basis'; end if;
  if p_fiscal_month is null or p_fiscal_month not between 1 and 12 then raise exception 'Confirm fiscal year start month'; end if;
  if exists(select 1 from jsonb_each(r.params) p where p.key not in ('start_date','end_date','accounting_method') and p.value not in ('null'::jsonb,'""'::jsonb)) then
    raise exception 'Filtered trial balances cannot seed company books; fetch an unfiltered report'; end if;
  cols:=r.raw_response#>'{Columns,Column}';
  if jsonb_array_length(cols) is distinct from 3 or cols#>>'{0,ColType}' is distinct from 'Account'
    or lower(cols#>>'{1,ColTitle}') is distinct from 'debit'
    or lower(cols#>>'{2,ColTitle}') is distinct from 'credit' then
    raise exception 'Unsupported trial balance columns; fetch an unsummarized Debit/Credit trial balance'; end if;
  -- Seed ONCE per account identity. Subsequent QBO refreshes cannot overwrite
  -- Silo-owned account labels or historical source snapshots.
  insert into public.accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot)
    select co,r.connection_id,q.qbo_account_id,q.name,q.account_type,q.is_active,to_jsonb(q)
    from public.quickbooks_accounts q where q.company_entity_id=co and q.connection_id=r.connection_id
    on conflict(company_entity_id,qbo_connection_id,qbo_account_id) do nothing;
  for item in
    with recursive rows(j) as (
      select value from jsonb_array_elements(r.raw_response#>'{Rows,Row}')
      union all select child.value from rows cross join lateral jsonb_array_elements(rows.j#>'{Rows,Row}') child
    ) select j from rows where j->>'type'='Data' or j ? 'ColData'
  loop
    qid:=item#>>'{ColData,0,id}';
    if qid is null or qid='' or qid=any(seen) or jsonb_array_length(item->'ColData') is distinct from 3 then
      raise exception 'Trial balance contains an unidentified or duplicate account; refresh QBO reference data'; end if;
    select * into account from public.accounting_accounts where company_entity_id=co and qbo_connection_id=r.connection_id and qbo_account_id=qid;
    if not found then raise exception 'Trial balance account % is missing from the synced QBO chart; sync accounts first',qid; end if;
    if coalesce(item#>>'{ColData,1,value}','') !~ '^([0-9]+([.][0-9]{1,2})?)?$'
      or coalesce(item#>>'{ColData,2,value}','') !~ '^([0-9]+([.][0-9]{1,2})?)?$' then
      raise exception 'Unsupported debit or credit value; no balances were imported'; end if;
    debit:=coalesce(nullif(item#>>'{ColData,1,value}','')::numeric,0);
    credit:=coalesce(nullif(item#>>'{ColData,2,value}','')::numeric,0);
    if debit>0 and credit>0 then raise exception 'Account has both a debit and credit balance'; end if;
    seen:=array_append(seen,qid); debits:=debits+debit; credits:=credits+credit;
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',account.id,'qbo_account_id',qid,'name',account.name,'account_type',account.account_type,'debit',debit,'credit',credit));
  end loop;
  if cardinality(seen)=0 or debits<>credits then raise exception 'Trial balance must contain accounts and balance exactly; no plug entries are created'; end if;
  -- A balanced subset is not a company trial balance. Tie every parsed row
  -- back to the provider's top-level TOTAL, in addition to rejecting filters.
  -- QBO's flat format has untyped ColData rows followed by a GrandTotal
  -- section. Find that marker; do not confuse its array position with identity.
  -- Retain support for a single ungrouped summary in a nested section.
  select count(*), jsonb_agg(e.value#>'{Summary,ColData}')->0
    into n_totals, totals
    from jsonb_array_elements(r.raw_response#>'{Rows,Row}') e
    where e.value ? 'Summary' and coalesce(e.value->>'group','GrandTotal')='GrandTotal';
  if n_totals<>1 then raise exception 'Expected exactly one provider grand total'; end if;
  if jsonb_array_length(totals) is distinct from 3
    or totals#>>'{0,value}' is distinct from 'TOTAL'
    or coalesce(totals#>>'{1,value}','') !~ '^[0-9]+([.][0-9]{1,2})?$'
    or coalesce(totals#>>'{2,value}','') !~ '^[0-9]+([.][0-9]{1,2})?$' then
    raise exception 'Provider trial balance total is missing or unsupported'; end if;
  if (totals#>>'{1,value}')::numeric<>debits or (totals#>>'{2,value}')::numeric<>credits then
    raise exception 'Imported rows do not match the provider trial balance total'; end if;
  select * into s from public.accounting_settings where company_entity_id=co;
  if found and s.qbo_connection_id<>r.connection_id then raise exception 'This company was seeded from a different QBO connection'; end if;
  insert into public.accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
    values(co,r.connection_id,currency,p_fiscal_month,cutoff+1,basis)
    on conflict(company_entity_id) do update set base_currency=excluded.base_currency,fiscal_year_start_month=excluded.fiscal_year_start_month,
      accounting_start_date=excluded.accounting_start_date,accounting_basis=excluded.accounting_basis;
  snap:=jsonb_build_object('schema_version',1,'report_run_id',r.id,'qbo_connection_id',r.connection_id,'as_of',cutoff,
    'accounting_start_date',cutoff+1,'currency',currency,'basis',basis,'fiscal_year_start_month',p_fiscal_month,
    'fetched_at',r.fetched_at,'debits',debits,'credits',credits,'lines',lines,'destination','silo_opening_history');
  insert into public.accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash)
    values(co,r.id,snap,public.finance_approval_snapshot_hash(snap))
    on conflict(company_entity_id) do update set report_run_id=excluded.report_run_id,snapshot=excluded.snapshot,snapshot_hash=excluded.snapshot_hash
    returning * into b;
  return jsonb_build_object('id',b.id,'snapshot_hash',b.snapshot_hash);
end $$;

create or replace function public.accept_accounting_opening_balances(p_id uuid,p_expected_hash text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare co uuid:=public.active_company_id(); b public.accounting_opening_balances%rowtype;
begin
  if auth.uid() is null or co is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  perform 1 from public.entities where id=co for update;
  select * into b from public.accounting_opening_balances where id=p_id and company_entity_id=co for update;
  if not found then raise exception 'Opening balances not found'; end if;
  if p_expected_hash is distinct from b.snapshot_hash or b.snapshot_hash is distinct from public.finance_approval_snapshot_hash(b.snapshot) then
    raise exception 'Opening balances changed; reload and review again'; end if;
  if b.status='accepted' then return jsonb_build_object('already_accepted',true); end if;
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'Explain your opening balance review (at least 10 characters)'; end if;
  update public.accounting_opening_balances set status='accepted',accepted_by=auth.uid(),accepted_at=now(),review_note=trim(p_reason) where id=b.id;
  return jsonb_build_object('accepted',true,'destination','silo_opening_history');
end $$;
revoke all on function public.seed_accounting_from_qbo(uuid,integer) from public,anon,authenticated;
revoke all on function public.accept_accounting_opening_balances(uuid,text,text) from public,anon,authenticated;
grant execute on function public.seed_accounting_from_qbo(uuid,integer),public.accept_accounting_opening_balances(uuid,text,text) to authenticated;

-- A source register, not a claim that a complete independent GL already exists.
create or replace view public.accounting_journal_register with (security_invoker=true) as
 select a.id,a.company_entity_id,'journal_adjustment'::text as kind,a.entry_date,a.memo,a.status,a.posting_id,
   a.accounting_source as source,p.status as posting_status,p.qbo_journal_entry_id
 from public.journal_adjustments a left join public.quickbooks_journal_postings p on p.id=a.posting_id
 union all
 select b.id,b.company_entity_id,'card_batch',b.entry_date,s.display_name,b.status,b.posting_id,
   'transactions',p.status,p.qbo_journal_entry_id
 from public.card_import_batches b join public.card_sources s on s.id=b.source_id
 left join public.quickbooks_journal_postings p on p.id=b.posting_id;
revoke all on public.accounting_journal_register from public,anon,authenticated;
grant select on public.accounting_journal_register to authenticated;

-- Finance-safe connection picker: never grants access to OAuth token columns.
create or replace function public.accounting_qbo_connections()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'company_name',company_name,'realm_id',realm_id,'environment',environment,'accounts_synced_at',accounts_synced_at))
    from public.quickbooks_connections where company_entity_id=public.active_company_id() and is_active),'[]'::jsonb);
end $$;
revoke all on function public.accounting_qbo_connections() from public,anon,authenticated;
grant execute on function public.accounting_qbo_connections() to authenticated;
