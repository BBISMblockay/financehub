-- QBO history: accept the provider's own decimal formats and settle blank
-- amounts from ledger evidence.
--
-- Production read-only inspection (2026-09-14, aggregates only) of a stored
-- 366-day GeneralLedger: QBO renders fractional amounts WITHOUT a leading
-- digit (".00", ".44", "-.67") in movements, running balances and account
-- period totals. archive_qbo_ledger's regexes required a digit before the
-- point, so every real report failed with "Invalid ledger movement" and no
-- snapshot was saved. The trial balance parser and the grouped-total parser
-- carried the same assumption. Blank movement cells also exist (41 of 36,778
-- data rows), every one on a Payment or Journal Entry line whose running
-- balance is unchanged from the prior line: the provider's own statement that
-- the line moved nothing. No blank cell ever moved the balance, and none was
-- a missing key: the cell is present as {"value": ""}.
--
-- This migration is additive. It leaves 20260913022606 untouched, adds one
-- parser shared by every numeric cell, and re-creates the RPC with:
--   * one number format for the whole report: an optional sign, digits with
--     an optional fraction, or a fraction alone. Thousands separators,
--     exponents, whitespace and a trailing point are still rejected. Values
--     are cast to numeric as written, so nothing is rounded.
--   * blank movement accepted as zero ONLY when the row's running balance
--     equals the balance carried from the prior line (or the beginning
--     balance / zero for the first line). A blank amount beside a moving
--     balance is ambiguous and fails the whole import. Blank rows are kept as
--     lines (natural_amount 0, raw row preserved) and counted per account as
--     blank_amount_rows in the reconciliation so nothing is silently dropped.
--   * a cell whose "value" key is missing is a shape failure, never a blank.
--   * errors name the cell, the ledger row ordinal and the QBO account id,
--     never the value, so a formatting failure is distinguishable from a
--     connection, date or coverage failure without copying report data.
-- Tables, RLS, immutability triggers, the atomic insert and the GL/TB
-- reconciliation are unchanged.

create or replace function public.qbo_report_number(p_value text,p_context text)
returns numeric language plpgsql immutable as $$
begin
 if p_value is null or p_value='' then return null; end if;
 if p_value !~ '^-?([0-9]+|[0-9]*[.][0-9]+)$' then
  raise exception 'Unsupported number format in %; QBO returned a value that is not a plain decimal (expected forms: 12, 12.34, .44 or -.67). No archive was written',p_context using errcode='22P02';
 end if;
 return p_value::numeric;
end $$;
revoke all on function public.qbo_report_number(text,text) from public,anon,authenticated;

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
 section_row integer; blank_rows integer; blank_total integer:=0; where_ text;
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
  if jsonb_typeof(cells#>'{1,value}') is distinct from 'string' or jsonb_typeof(cells#>'{2,value}') is distinct from 'string' then
   raise exception 'Trial balance amount cell is missing for account %; no archive was written',qid; end if;
  debit:=coalesce(public.qbo_report_number(cells#>>'{1,value}',format('trial balance debit for account %s',qid)),0);
  credit:=coalesce(public.qbo_report_number(cells#>>'{2,value}',format('trial balance credit for account %s',qid)),0);
  if debit<0 or credit<0 then raise exception 'Negative trial balance amount for account %; a negative debit or credit is ambiguous and was not archived',qid; end if;
  if debit>0 and credit>0 then raise exception 'Trial balance account contains both debit and credit'; end if;
  debit_sum:=debit_sum+debit;credit_sum:=credit_sum+credit;seen:=array_append(seen,qid);
  tb_balances:=tb_balances||jsonb_build_object(qid,debit-credit);
 end loop;
 select count(*),jsonb_agg(e.value#>'{Summary,ColData}')->0 into n,totals from jsonb_array_elements(tb.raw_response#>'{Rows,Row}') e
  where e.value ? 'Summary' and coalesce(e.value->>'group','GrandTotal')='GrandTotal';
 if cardinality(seen)=0 or n<>1 or debit_sum<>credit_sum or totals#>>'{0,value}' is distinct from 'TOTAL'
  or jsonb_typeof(totals#>'{1,value}') is distinct from 'string' or jsonb_typeof(totals#>'{2,value}') is distinct from 'string' then raise exception 'Trial balance lacks a valid balanced grand total'; end if;
 debit:=public.qbo_report_number(totals#>>'{1,value}','trial balance grand total debit');
 credit:=public.qbo_report_number(totals#>>'{2,value}','trial balance grand total credit');
 if debit is null or credit is null or debit<0 or credit<0 then raise exception 'Trial balance lacks a valid balanced grand total'; end if;
 if debit<>debit_sum or credit<>credit_sum then raise exception 'Trial balance rows do not tie to provider totals'; end if;
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
   where_:=format('grouped ledger total for %s',coalesce(nullif(qid,''),'an unidentified group'));
   summary_amount:=coalesce(public.qbo_report_number(section#>>'{Summary,ColData,6,value}',where_),0);
   select coalesce(sum(coalesce(public.qbo_report_number(c.value#>>'{Summary,ColData,6,value}',where_),0)),0) into child_total from jsonb_array_elements(section#>'{Rows,Row}') c;
   if summary_amount<>child_total then raise exception 'Grouped ledger totals do not tie to child sections'; end if;
   continue;
  end if;
  if qid is null or qid='' or qid=any(gl_seen) then raise exception 'Unsupported or duplicate ledger account section; raw report remains available'; end if;
  gl_seen:=array_append(gl_seen,qid);
  select * into account from public.accounting_accounts where company_entity_id=co and qbo_connection_id=gl.connection_id and qbo_account_id=qid;
  if not found then raise exception 'Ledger account % is not in the Silo chart; reconcile the chart before importing',qid; end if;
  direction:=case when account.account_type in ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset','Expense','Other Expense','Cost of Goods Sold') then 1
   when account.account_type in ('Accounts Payable','Credit Card','Other Current Liability','Long Term Liability','Equity','Income','Other Income') then -1 else null end;
  if direction is null then raise exception 'Unsupported account type %',account.account_type; end if;
  balance:=0;movement:=0;has_beginning:=false;txn_started:=false;problems:='{}';section_row:=0;blank_rows:=0;
  if coalesce(jsonb_array_length(section#>'{Rows,Row}'),0)=0 then problems:=array_append(problems,'no_ledger_rows'); end if;
  for item in select value from jsonb_array_elements(section#>'{Rows,Row}') loop
   cells:=item->'ColData';section_row:=section_row+1;
   if item ? 'Rows' or jsonb_array_length(cells) is distinct from 8 then raise exception 'Unsupported nested or incomplete ledger row; no archive was written'; end if;
   -- A cell without a "value" key is a shape the archive has never seen; it
   -- is not a blank and is never read as zero.
   if jsonb_typeof(cells#>'{6,value}') is distinct from 'string' or jsonb_typeof(cells#>'{7,value}') is distinct from 'string' then
    raise exception 'Ledger amount or running balance cell is missing at row % of account %; no archive was written',section_row,qid; end if;
   row_balance:=public.qbo_report_number(cells#>>'{7,value}',format('running balance at row %s of account %s',section_row,qid));
   if row_balance is null then raise exception 'Missing running balance at row % of account %; no archive was written',section_row,qid; end if;
   if cells#>>'{0,value}'='Beginning Balance' then
    if has_beginning or txn_started then raise exception 'Unexpected beginning balance position'; end if;
    has_beginning:=true;balance:=row_balance;amount:=0;row_kind:='opening';d:=null;
   else
    if cells#>>'{0,value}' is null or cells#>>'{0,value}' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Missing ledger transaction date'; end if;
    d:=(cells#>>'{0,value}')::date;
    if d<gl.start_date or d>gl.end_date then raise exception 'Ledger row outside declared period'; end if;
    amount:=public.qbo_report_number(cells#>>'{6,value}',format('ledger amount at row %s of account %s',section_row,qid));
    if amount is null then
     -- QBO leaves the amount blank on a zero-value line (a $0 payment
     -- application, a zero journal line). The running balance decides: an
     -- unchanged balance corroborates zero; a moving balance beside a blank
     -- amount is ambiguous and nothing is inferred from it.
     if row_balance<>balance then raise exception 'Blank ledger amount with a changed running balance at row % of account % is ambiguous; no archive was written',section_row,qid; end if;
     amount:=0;blank_rows:=blank_rows+1;blank_total:=blank_total+1;
    end if;
    txn_started:=true;row_kind:='transaction';txn_count:=txn_count+1;
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
  -- A blank period total is zero (an account with only a beginning balance).
  summary_amount:=coalesce(public.qbo_report_number(section#>>'{Summary,ColData,6,value}',format('period total for account %s',qid)),0);
  if summary_amount<>movement then problems:=array_append(problems,'movement_total_mismatch'); end if;
  expected:=(tb_balances->>qid)::numeric;
  if expected is null then problems:=array_append(problems,'missing_trial_balance_account');difference:=null;
   else difference:=balance*direction-expected;if difference<>0 then problems:=array_append(problems,'trial_balance_mismatch'); end if; end if;
  if cardinality(problems)>0 then exceptions:=exceptions+1; end if;
  checks:=checks||jsonb_build_array(jsonb_build_object('qbo_account_id',qid,'account_name',account.name,'ledger_debit_net',balance*direction,'trial_balance_debit_net',expected,'difference',difference,'issues',to_jsonb(problems),'blank_amount_rows',blank_rows));
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
 return jsonb_build_object('id',imp,'transaction_count',txn_count,'exception_count',exceptions,'blank_amount_rows',blank_total);
end $$;
revoke all on function public.archive_qbo_ledger(uuid,uuid) from public,anon,authenticated;
grant execute on function public.archive_qbo_ledger(uuid,uuid) to authenticated;
