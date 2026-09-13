-- Independent, immutable report archives. These are never outbound journals,
-- never added to opening balances, and remain readable after QBO disconnect.
create table if not exists public.qbo_history_imports (
 id uuid primary key default gen_random_uuid(),
 company_entity_id uuid not null references public.entities(id),
 qbo_connection_id uuid not null, -- provenance, not a cascading connection FK
 gl_run_id uuid not null,
 tb_run_id uuid not null,
 period_start date not null,
 period_end date not null,
 currency text not null,
 accounting_basis text not null,
 source_hash text not null,
 source_snapshot jsonb not null,
 reconciliation jsonb not null,
 reconciliation_status text not null check(reconciliation_status in ('matched','exceptions')),
 exception_count integer not null check(exception_count>=0),
 transaction_count integer not null check(transaction_count>=0),
 created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id),
 unique(company_entity_id,qbo_connection_id,source_hash),
 unique(id,company_entity_id),
 check(period_start<=period_end)
);
create table if not exists public.qbo_history_lines (
 id uuid primary key default gen_random_uuid(),
 company_entity_id uuid not null references public.entities(id),
 import_id uuid not null,
 row_no integer not null,
 row_kind text not null check(row_kind in ('opening','transaction')),
 qbo_account_id text not null,
 account_name text not null,
 account_type text not null,
 transaction_date date,
 qbo_transaction_id text,
 transaction_type text,
 document_number text,
 counterparty text,
 memo text,
 split_account_id text,
 split_account_name text,
 natural_amount numeric not null,
 natural_balance numeric not null,
 raw_row jsonb not null,
 foreign key(import_id,company_entity_id) references public.qbo_history_imports(id,company_entity_id),
 unique(import_id,row_no)
);
create index if not exists qbo_history_lines_browse on public.qbo_history_lines(company_entity_id,import_id,transaction_date,row_no);
create index if not exists qbo_history_imports_period on public.qbo_history_imports(company_entity_id,period_start,period_end);
do $$ declare t text; begin
 foreach t in array array['qbo_history_imports','qbo_history_lines'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('drop policy if exists history_finance_read on public.%I',t);
  execute format('create policy history_finance_read on public.%I for select to authenticated using (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()))',t);
 end loop;
end $$;
drop trigger if exists finance_audit_event on public.qbo_history_imports;
create trigger finance_audit_event after insert on public.qbo_history_imports for each row execute function public.finance_append_audit_event();
-- Deny changes even through service clients; a corrected QBO report is a new
-- snapshot, never a rewrite of the evidence already reviewed.
drop trigger if exists history_immutable on public.qbo_history_imports;
create trigger history_immutable before update or delete or truncate on public.qbo_history_imports for each statement execute function public.finance_deny_audit_mutation();
drop trigger if exists history_immutable on public.qbo_history_lines;
create trigger history_immutable before update or delete or truncate on public.qbo_history_lines for each statement execute function public.finance_deny_audit_mutation();

create or replace function public.archive_qbo_ledger(p_gl_run_id uuid,p_tb_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 co uuid:=public.active_company_id(); settings public.accounting_settings%rowtype;
 gl public.quickbooks_report_runs%rowtype; tb public.quickbooks_report_runs%rowtype;
 imp uuid; src jsonb; digest text; column_keys text[]; expected_keys text[]:=array['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount','rbal_nat_amount'];
 section jsonb; item jsonb; cells jsonb; totals jsonb; checks jsonb:='[]'; staged jsonb:='[]'; tb_balances jsonb:='{}'; account public.accounting_accounts%rowtype;
 qid text; seen text[]:='{}'; gl_seen text[]:='{}'; debit numeric; credit numeric; debit_sum numeric:=0; credit_sum numeric:=0;
 balance numeric; movement numeric; amount numeric; row_balance numeric; expected numeric; difference numeric; summary_amount numeric; direction integer;
 row_no integer:=0; txn_count integer:=0; exceptions integer:=0; n integer; d date; row_kind text; problems text[];
 has_beginning boolean; txn_started boolean; doc jsonb; k text; node record; child_total numeric;
begin
 if auth.uid() is null or co is null or not(public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
 perform 1 from public.entities where id=co for update;
 select * into settings from public.accounting_settings where company_entity_id=co;
 if not found then raise exception 'Seed accounting settings before importing history'; end if;
 select * into gl from public.quickbooks_report_runs where id=p_gl_run_id and company_entity_id=co and report_name='GeneralLedger' and status='ok' for share;
 if not found then raise exception 'Select a successful GeneralLedger report for this company'; end if;
 select * into tb from public.quickbooks_report_runs where id=p_tb_run_id and company_entity_id=co and report_name='TrialBalance' and status='ok' for share;
 if not found then raise exception 'Select a successful TrialBalance report for this company'; end if;
 if gl.connection_id is distinct from settings.qbo_connection_id or tb.connection_id is distinct from gl.connection_id then raise exception 'Report connections must match company accounting settings'; end if;
 if gl.start_date is null or gl.end_date is null or gl.start_date>gl.end_date or gl.end_date-gl.start_date>365
   or gl.end_date>=settings.accounting_start_date or tb.end_date is distinct from gl.end_date then
  raise exception 'Choose at most 366 historical days before the Silo start date and a trial balance at the same end date'; end if;
 foreach doc in array array[gl.raw_response,tb.raw_response] loop
  if doc#>>'{Header,Currency}' is distinct from settings.base_currency or doc#>>'{Header,ReportBasis}' is distinct from settings.accounting_basis
    or doc#>>'{Header,EndPeriod}' is distinct from gl.end_date::text then raise exception 'Report currency, basis or end date does not match'; end if;
 end loop;
 if gl.raw_response#>>'{Header,StartPeriod}' is distinct from gl.start_date::text or gl.raw_response#>>'{Header,ReportName}' is distinct from 'GeneralLedger'
   or tb.raw_response#>>'{Header,ReportName}' is distinct from 'TrialBalance' then raise exception 'Unexpected report header'; end if;
 if exists(select 1 from (select * from jsonb_each(gl.params) union all select * from jsonb_each(tb.params)) p where p.key not in ('start_date','end_date','accounting_method') and p.value not in ('null'::jsonb,'""'::jsonb)) then
  raise exception 'Filtered or custom-column reports cannot establish historical coverage'; end if;
 -- Immutable copies have no FK to cached reports or connection credentials.
 src:=jsonb_build_object('general_ledger',gl.raw_response,'trial_balance',tb.raw_response,'gl_params',gl.params,'tb_params',tb.params,
  'account_context',(select jsonb_agg(to_jsonb(a) order by a.qbo_account_id) from public.accounting_accounts a where a.company_entity_id=co and a.qbo_connection_id=gl.connection_id),
  'gl_fetched_at',gl.fetched_at,'tb_fetched_at',tb.fetched_at,'realm_id',(select realm_id from public.quickbooks_connections where id=gl.connection_id and company_entity_id=co));
 digest:=public.finance_approval_snapshot_hash(src);
 select id into imp from public.qbo_history_imports where company_entity_id=co and qbo_connection_id=gl.connection_id and source_hash=digest;
 if found then return jsonb_build_object('id',imp,'already_imported',true); end if;
 -- A known provider shape, verified against Test Company's stored GL. Do not
 -- infer accounting signs from translated display labels or arbitrary columns.
 select array_agg((select m->>'Value' from jsonb_array_elements(c.value->'MetaData') m where m->>'Name'='ColKey') order by c.ordinality)
  into column_keys from jsonb_array_elements(gl.raw_response#>'{Columns,Column}') with ordinality c;
 if column_keys is distinct from expected_keys then raise exception 'Unsupported ledger columns; fetch the default unfiltered GeneralLedger report'; end if;
 cells:=tb.raw_response#>'{Columns,Column}';
 if jsonb_array_length(cells) is distinct from 3 or cells#>>'{0,ColType}' is distinct from 'Account'
   or lower(cells#>>'{1,ColTitle}') is distinct from 'debit' or lower(cells#>>'{2,ColTitle}') is distinct from 'credit' then raise exception 'Unsupported trial balance columns'; end if;
 for item in with recursive rows(j) as (select value from jsonb_array_elements(tb.raw_response#>'{Rows,Row}')
   union all select c.value from rows cross join lateral jsonb_array_elements(rows.j#>'{Rows,Row}') c)
   select j from rows where j ? 'ColData' or j->>'type'='Data'
 loop
  cells:=item->'ColData';qid:=cells#>>'{0,id}';
  if qid is null or qid='' or qid=any(seen) or jsonb_array_length(cells) is distinct from 3 then raise exception 'Unidentified or duplicate trial balance account'; end if;
  if coalesce(cells#>>'{1,value}','') !~ '^([0-9]+([.][0-9]{1,2})?)?$' or coalesce(cells#>>'{2,value}','') !~ '^([0-9]+([.][0-9]{1,2})?)?$' then raise exception 'Invalid trial balance amount'; end if;
  debit:=coalesce(nullif(cells#>>'{1,value}','')::numeric,0);credit:=coalesce(nullif(cells#>>'{2,value}','')::numeric,0);
  if debit>0 and credit>0 then raise exception 'Trial balance account contains both debit and credit'; end if;
  debit_sum:=debit_sum+debit;credit_sum:=credit_sum+credit;seen:=array_append(seen,qid);
  tb_balances:=tb_balances||jsonb_build_object(qid,debit-credit);
 end loop;
 select count(*),jsonb_agg(e.value#>'{Summary,ColData}')->0 into n,totals from jsonb_array_elements(tb.raw_response#>'{Rows,Row}') e
  where e.value ? 'Summary' and coalesce(e.value->>'group','GrandTotal')='GrandTotal';
 if cardinality(seen)=0 or n<>1 or debit_sum<>credit_sum or totals#>>'{0,value}' is distinct from 'TOTAL'
  or coalesce(totals#>>'{1,value}','') !~ '^[0-9]+([.][0-9]{1,2})?$' or coalesce(totals#>>'{2,value}','') !~ '^[0-9]+([.][0-9]{1,2})?$' then raise exception 'Trial balance lacks a valid balanced grand total'; end if;
 if (totals#>>'{1,value}')::numeric<>debit_sum or (totals#>>'{2,value}')::numeric<>credit_sum then raise exception 'Trial balance rows do not tie to provider totals'; end if;
 -- Each account section is retained separately. Same QBO transaction may
 -- legitimately have multiple lines; identity is the source row, not txn ID.
 for node in
  with recursive sections(j,qid,path) as (
   select value,value#>>'{Header,ColData,0,id}',array[ordinality] from jsonb_array_elements(gl.raw_response#>'{Rows,Row}') with ordinality
   union all select c.value,case when c.value ? 'Header' then c.value#>>'{Header,ColData,0,id}' else sections.qid end,sections.path||c.ordinality
   from sections cross join lateral jsonb_array_elements(sections.j#>'{Rows,Row}') with ordinality c where c.value->>'type'='Section'
  ) select * from sections order by path
 loop
  section:=node.j;qid:=node.qid;
  if section->>'type' is distinct from 'Section' or jsonb_array_length(section#>'{Summary,ColData}') is distinct from 8 then raise exception 'Unsupported ledger section'; end if;
  if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type' not in ('Section','Data') or c.value->>'type' is null) then raise exception 'Unsupported ledger row type'; end if;
  -- QBO wraps a parent's own rows in a headerless child, alongside named
  -- subaccounts. A headerless child inherits its parent's ID; a named group
  -- without an ID never inherits one. No name-to-ID guessing.
  if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type'='Section') then
   if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type'='Data') then raise exception 'Mixed grouped and direct ledger rows are not supported'; end if;
   if coalesce(section#>>'{Summary,ColData,6,value}','') !~ '^(-?[0-9]+([.][0-9]{1,2})?)?$'
     or exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where coalesce(c.value#>>'{Summary,ColData,6,value}','') !~ '^(-?[0-9]+([.][0-9]{1,2})?)?$') then raise exception 'Invalid grouped ledger total'; end if;
   select coalesce(sum(coalesce(nullif(c.value#>>'{Summary,ColData,6,value}','')::numeric,0)),0) into child_total from jsonb_array_elements(section#>'{Rows,Row}') c;
   if coalesce(nullif(section#>>'{Summary,ColData,6,value}','')::numeric,0)<>child_total then raise exception 'Grouped ledger totals do not tie to child sections'; end if;
   continue;
  end if;
  if qid is null or qid='' or qid=any(gl_seen) then raise exception 'Unsupported or duplicate ledger account section; raw report remains available'; end if;
  gl_seen:=array_append(gl_seen,qid);
  select * into account from public.accounting_accounts where company_entity_id=co and qbo_connection_id=gl.connection_id and qbo_account_id=qid;
  if not found then raise exception 'Ledger account % is not in the Silo chart; reconcile the chart before importing',qid; end if;
  direction:=case when account.account_type in ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset','Expense','Other Expense','Cost of Goods Sold') then 1
   when account.account_type in ('Accounts Payable','Credit Card','Other Current Liability','Long Term Liability','Equity','Income','Other Income') then -1 else null end;
  if direction is null then raise exception 'Unsupported account type %',account.account_type; end if;
  balance:=0;movement:=0;has_beginning:=false;txn_started:=false;problems:='{}';
  if coalesce(jsonb_array_length(section#>'{Rows,Row}'),0)=0 then problems:=array_append(problems,'no_ledger_rows'); end if;
  for item in select value from jsonb_array_elements(section#>'{Rows,Row}') loop
   cells:=item->'ColData';
   if item ? 'Rows' or jsonb_array_length(cells) is distinct from 8 then raise exception 'Unsupported nested or incomplete ledger row; no archive was written'; end if;
   if coalesce(cells#>>'{7,value}','') !~ '^-?[0-9]+([.][0-9]{1,2})?$' then raise exception 'Missing or invalid running balance'; end if;
   row_balance:=(cells#>>'{7,value}')::numeric;
   if cells#>>'{0,value}'='Beginning Balance' then
    if has_beginning or txn_started then raise exception 'Unexpected beginning balance position'; end if;
    has_beginning:=true;balance:=row_balance;amount:=0;row_kind:='opening';d:=null;
   else
    if cells#>>'{0,value}' is null or cells#>>'{0,value}' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Missing ledger transaction date'; end if;
    d:=(cells#>>'{0,value}')::date;
    if d<gl.start_date or d>gl.end_date then raise exception 'Ledger row outside declared period'; end if;
    if coalesce(cells#>>'{6,value}','') !~ '^-?[0-9]+([.][0-9]{1,2})?$' then raise exception 'Invalid ledger movement'; end if;
    amount:=(cells#>>'{6,value}')::numeric;txn_started:=true;row_kind:='transaction';txn_count:=txn_count+1;
    if balance+amount<>row_balance and not('running_balance_gap'=any(problems)) then problems:=array_append(problems,'running_balance_gap'); end if;
    movement:=movement+amount;balance:=row_balance;
    if nullif(cells#>>'{1,id}','') is null and not('missing_transaction_reference'=any(problems)) then problems:=array_append(problems,'missing_transaction_reference'); end if;
   end if;
   row_no:=row_no+1;
   staged:=staged||jsonb_build_array(jsonb_build_object('row_no',row_no,'row_kind',row_kind,'qbo_account_id',qid,'account_name',account.name,'account_type',account.account_type,
    'transaction_date',d,'qbo_transaction_id',nullif(cells#>>'{1,id}',''),'transaction_type',cells#>>'{1,value}','document_number',cells#>>'{2,value}',
    'counterparty',cells#>>'{3,value}','memo',cells#>>'{4,value}','split_account_id',cells#>>'{5,id}','split_account_name',cells#>>'{5,value}',
    'natural_amount',amount,'natural_balance',row_balance,'raw_row',item));
  end loop;
  if coalesce(section#>>'{Summary,ColData,6,value}','') !~ '^(-?[0-9]+([.][0-9]{1,2})?)?$' then raise exception 'Ledger account movement total is missing'; end if;
  summary_amount:=coalesce(nullif(section#>>'{Summary,ColData,6,value}','')::numeric,0);
  if summary_amount<>movement then problems:=array_append(problems,'movement_total_mismatch'); end if;
  expected:=(tb_balances->>qid)::numeric;
  if expected is null then problems:=array_append(problems,'missing_trial_balance_account');difference:=null;
   else difference:=balance*direction-expected;if difference<>0 then problems:=array_append(problems,'trial_balance_mismatch'); end if; end if;
  if cardinality(problems)>0 then exceptions:=exceptions+1; end if;
  checks:=checks||jsonb_build_array(jsonb_build_object('qbo_account_id',qid,'account_name',account.name,'ledger_debit_net',balance*direction,'trial_balance_debit_net',expected,'difference',difference,'issues',to_jsonb(problems)));
 end loop;
 if row_no=0 or cardinality(gl_seen)=0 then raise exception 'Ledger contains no account sections; no historical coverage was established'; end if;
 -- A TB account not in GL is an explicit coverage exception even at zero;
 -- a zero closing balance does not prove the account has no historical rows.
 foreach k in array seen loop
  if not(k=any(gl_seen)) then
   exceptions:=exceptions+1;
   checks:=checks||jsonb_build_array(jsonb_build_object('qbo_account_id',k,'account_name',coalesce((select name from public.accounting_accounts where company_entity_id=co and qbo_connection_id=gl.connection_id and qbo_account_id=k),k),'trial_balance_debit_net',tb_balances->k,'issues',jsonb_build_array('missing_ledger_account')));
  end if;
 end loop;
 insert into public.qbo_history_imports(company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,currency,accounting_basis,source_hash,source_snapshot,reconciliation,reconciliation_status,exception_count,transaction_count,created_by)
 values(co,gl.connection_id,gl.id,tb.id,gl.start_date,gl.end_date,settings.base_currency,settings.accounting_basis,digest,src,checks,case when exceptions=0 then 'matched' else 'exceptions' end,exceptions,txn_count,auth.uid()) returning id into imp;
 insert into public.qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,transaction_date,qbo_transaction_id,transaction_type,document_number,counterparty,memo,split_account_id,split_account_name,natural_amount,natural_balance,raw_row)
 select co,imp,x.row_no,x.row_kind,x.qbo_account_id,x.account_name,x.account_type,x.transaction_date,x.qbo_transaction_id,x.transaction_type,x.document_number,x.counterparty,x.memo,x.split_account_id,x.split_account_name,x.natural_amount,x.natural_balance,x.raw_row
 from jsonb_to_recordset(staged) as x(row_no integer,row_kind text,qbo_account_id text,account_name text,account_type text,transaction_date date,qbo_transaction_id text,transaction_type text,document_number text,counterparty text,memo text,split_account_id text,split_account_name text,natural_amount numeric,natural_balance numeric,raw_row jsonb);
 return jsonb_build_object('id',imp,'transaction_count',txn_count,'exception_count',exceptions);
end $$;
revoke all on function public.archive_qbo_ledger(uuid,uuid) from public,anon,authenticated;
grant execute on function public.archive_qbo_ledger(uuid,uuid) to authenticated;
