import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const db=new PGlite({extensions:{pgcrypto}});
const root=new URL('../../',import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql',
  '20260826090000_quickbooks_locations.sql',
  '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql',
  '20260831190000_card_name_and_holder.sql',
  '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql',
  '20260831220000_void_card_posting.sql',
  '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql',
  '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql',
  '20260912000000_finance_v1_posting_controls.sql',
];
const q=async(sql,params=[])=>(await db.query(sql,params)).rows;
const one=async(sql,params=[])=>(await q(sql,params))[0];
const co=randomUUID(),other=randomUUID(),finance=randomUUID(),outsider=randomUUID(),otherUser=randomUUID(),conn=randomUUID(),otherConn=randomUUID();
async function as(user,fn,role='authenticated'){await db.exec('set role '+role);await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);try{return await fn();}finally{await db.exec('reset role');}}
const rpc=async(name,args)=>(Object.values(await one(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)))[0];
const glShape=JSON.parse(await readFile(new URL('./fixtures/qbo-general-ledger-nested.json',import.meta.url),'utf8'));
const tbShape=JSON.parse(await readFile(new URL('./fixtures/qbo-trial-balance-flat.json',import.meta.url),'utf8'));
// Synthetic amounts and names, provider-observed nested/headerless structure.
tbShape.Rows.Row.splice(2,0,...[['expense','Expenses',4,0],['child','Supplies',6,0],['income','Sales',0,10]].map(([id,name,d,c])=>({ColData:[{id,value:name},{value:d?String(d):''},{value:c?String(c):''}]})));
tbShape.Rows.Row.at(-1).Summary.ColData[1].value='45.00';tbShape.Rows.Row.at(-1).Summary.ColData[2].value='45.00';
async function store(raw,company=co,connection=conn,params={}){const id=randomUUID();await q("insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params) values($1,$2,$3,$4,'2026-08-01','2026-08-31',$5,'ok',$6)",[id,company,connection,raw.Header.ReportName,raw,params]);return id;}
const archive=(g,t)=>as(finance,()=>rpc('archive_qbo_ledger',[g,t]));
try{
 await db.exec(await readFile(new URL('./finance-db/bootstrap.sql',import.meta.url),'utf8'));
 for(const name of [...dependencies,'20260912052930_plaid_bank_feed.sql','20260912203725_bank_feed_workspace_history.sql','20260912231606_accounting_foundation.sql'])await db.exec(await readFile(new URL('supabase/migrations/'+name,root),'utf8'));
 const sql=await readFile(new URL('supabase/migrations/20260913022606_qbo_historical_ledger.sql',root),'utf8');await db.exec(sql);await db.exec(sql);
 const formats=await readFile(new URL('supabase/migrations/20260914220000_qbo_history_number_formats.sql',root),'utf8');
 await q("insert into entities(id,title) values($1,'Test A'),($2,'Test B')",[co,other]);
 await q('insert into auth.users(id) values($1),($2),($3)',[finance,outsider,otherUser]);
 await q("insert into profiles(id,name,role,department,active_company_id) values($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)",[finance,outsider,otherUser,co,other]);
 await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')",[co,finance,outsider,other,otherUser]);
 await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'a','secret'),($3,$4,'b','othersecret')",[conn,co,otherConn,other]);
 for(const [id,name,type] of [['bank','Checking','Bank'],['equity','Equity','Equity'],['expense','Expenses','Expense'],['child','Supplies','Expense'],['income','Sales','Income']])await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type) values($1,$2,$3,$4,$5)',[co,conn,id,name,type]);

 const t=await store(tbShape),g=await store(glShape);
 const openingReport=await store(tbShape);await as(finance,()=>rpc('seed_accounting_from_qbo',[openingReport,1]));
 // QBO renders fractions without a leading digit (".44", "-.67") and leaves a
 // zero-value line's amount blank while its running balance holds. Synthetic
 // values; the structure is what production returns.
 const decimalGl=structuredClone(glShape),decimalTb=structuredClone(tbShape);
 {const bank=decimalGl.Rows.Row[0].Rows.Row;bank[0].ColData[7].value='20.44';bank[1].ColData[6].value='.56';bank[1].ColData[7].value='21.00';bank[2].ColData[6].value='-.67';bank[2].ColData[7].value='20.33';
  const blank=structuredClone(bank[2]);blank.ColData[1].value='Payment';blank.ColData[6].value='';blank.ColData[7].value='20.33';bank.push(blank);decimalGl.Rows.Row[0].Summary.ColData[6].value='-.11';
  decimalGl.Rows.Row[1].Rows.Row[0].ColData[7].value='14.39';
  const supplies=decimalGl.Rows.Row[2].Rows.Row[1];supplies.Rows.Row[0].ColData[6].value='.06';supplies.Rows.Row[0].ColData[7].value='.06';supplies.Summary.ColData[6].value='.06';decimalGl.Rows.Row[2].Summary.ColData[6].value='4.06';
  const tbRow=id=>decimalTb.Rows.Row.find(r=>r.ColData?.[0].id===id);tbRow('bank').ColData[1].value='20.33';tbRow('equity').ColData[2].value='14.39';tbRow('child').ColData[1].value='.06';
  decimalTb.Rows.Row.at(-1).Summary.ColData[1].value='24.39';decimalTb.Rows.Row.at(-1).Summary.ColData[2].value='24.39';}
 const decimalT=await store(decimalTb),decimalG=await store(decimalGl);
 // Reproduce the production failure against the original archive SQL first:
 // the GL movement rejection Blake saw, and the same assumption one step
 // earlier in the trial balance parser.
 await assert.rejects(archive(decimalG,await store(tbShape)),/Invalid ledger movement/);
 await assert.rejects(archive(decimalG,decimalT),/Invalid trial balance amount/);
 assert.equal(Number((await one('select count(*) n from qbo_history_imports')).n),0,'The rejected report left no snapshot');
 await db.exec(formats);await db.exec(formats);
 const counts=async()=>({imports:Number((await one('select count(*) n from qbo_history_imports')).n),lines:Number((await one('select count(*) n from qbo_history_lines')).n),audit:Number((await one("select count(*) n from finance_audit_events where object_type='qbo_history_imports'")).n)});
 const decimalSaved=await archive(decimalG,decimalT);assert.equal(decimalSaved.transaction_count,6);assert.equal(decimalSaved.exception_count,0);assert.equal(decimalSaved.blank_amount_rows,1);
 {const row=await one('select * from qbo_history_imports where id=$1',[decimalSaved.id]);assert.equal(row.reconciliation_status,'matched');
  const bank=row.reconciliation.find(x=>x.qbo_account_id==='bank');assert.equal(bank.ledger_debit_net,20.33);assert.equal(bank.trial_balance_debit_net,20.33);assert.equal(bank.difference,0);assert.equal(bank.blank_amount_rows,1);
  assert.equal(row.reconciliation.find(x=>x.qbo_account_id==='equity').ledger_debit_net,-14.39);assert.equal(row.reconciliation.find(x=>x.qbo_account_id==='child').ledger_debit_net,0.06);
  const lines=await q('select row_kind,natural_amount::text amount,natural_balance::text balance,transaction_type,raw_row from qbo_history_lines where import_id=$1 and qbo_account_id=$2 order by row_no',[decimalSaved.id,'bank']);
  assert.deepEqual(lines.map(l=>[l.row_kind,l.amount,l.balance]),[['opening','0','20.44'],['transaction','0.56','21.00'],['transaction','-0.67','20.33'],['zero_amount','0','20.33']],'Stored exactly as the provider wrote them; a zero line is its own kind');
  assert.equal(lines[3].transaction_type,'Payment');assert.equal(lines[3].raw_row.ColData[6].value,'','The blank amount is retained as evidence, not rewritten');
  assert.equal(decimalSaved.zero_amount_rows,1);assert.equal(bank.zero_amount_rows,1);
  // The categorizer's evidence read (card-categorize/index.ts) filters
  // row_kind = 'transaction'; the same shape of query must never see a zero line.
  assert.equal(Number((await one("select count(*) n from qbo_history_lines where import_id=$1 and row_kind='transaction' and natural_amount=0",[decimalSaved.id])).n),0);
  assert.equal((await one('select natural_amount::text a from qbo_history_lines where import_id=$1 and qbo_account_id=$2',[decimalSaved.id,'child'])).a,'0.06');}
 // The same fixture with the blank amount beside a moving balance, a missing
 // cell, or a format QBO does not use fails atomically: nothing is written.
 async function badDecimal(edit,pattern){const raw=structuredClone(decimalGl);edit(raw);const before=await counts();await assert.rejects(archive(await store(raw),decimalT),pattern);assert.deepEqual(await counts(),before,'A rejected import writes nothing');}
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[3].ColData[7].value='21.33';},/Blank ledger amount with a changed running balance at row 4 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[3].ColData[7].value='20.33';r.Rows.Row[0].Rows.Row[2].ColData[6].value='';},/Blank ledger amount with a changed running balance at row 3/);
 await badDecimal(r=>{delete r.Rows.Row[0].Rows.Row[3].ColData[6].value;},/amount or running balance cell is missing at row 4 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[1].ColData[6].value=null;},/cell is missing at row 2 of account bank/);
 for(const value of ['1,000.00','1.','.','- .5','1e3','$1.00',' 1.00','--1','1.2.3','nope'])await badDecimal(r=>{r.Rows.Row[0].Rows.Row[1].ColData[6].value=value;},/Unsupported number format in ledger amount at row 2 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[1].ColData[7].value='';},/Missing running balance at row 2 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[1].ColData[7].value='21,00';},/Unsupported number format in running balance at row 2 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Rows.Row[0].ColData[7].value='';},/Missing running balance at row 1 of account bank/);
 await badDecimal(r=>{r.Rows.Row[0].Summary.ColData[6].value='-.1.1';},/Unsupported number format in period total for account bank/);
 await badDecimal(r=>{r.Rows.Row[2].Summary.ColData[6].value='4.06 ';},/Unsupported number format in grouped ledger total for expense/);
 await badDecimal(r=>{r.Rows.Row[2].Rows.Row[1].Summary.ColData[6].value='x';},/Unsupported number format in grouped ledger total for expense/);
 for(const [edit,pattern] of [[t=>{t.Rows.Row[0].ColData[1].value='20,33';},/Unsupported number format in trial balance debit for account bank/],[t=>{t.Rows.Row[0].ColData[1].value='-20.33';},/Negative trial balance amount for account bank/],[t=>{delete t.Rows.Row[0].ColData[1].value;},/Trial balance amount cell is missing for account bank/],[t=>{t.Rows.Row.at(-1).Summary.ColData[1].value='24.39.';},/Unsupported number format in trial balance grand total debit/]]){
  const raw=structuredClone(decimalTb);edit(raw);const before=await counts();await assert.rejects(archive(decimalG,await store(raw)),pattern);assert.deepEqual(await counts(),before);}
 // A blank amount is corroborated by the balance carried in, including the
 // implicit zero of an account with no beginning balance.
 {const raw=structuredClone(decimalGl);const income=raw.Rows.Row[3].Rows.Row[0];const zero=structuredClone(income.Rows.Row[0]);zero.ColData[6].value='';zero.ColData[7].value='';income.Rows.Row.unshift(zero);
  await assert.rejects(archive(await store(raw),decimalT),/Missing running balance at row 1 of account income/);
  zero.ColData[7].value='.00';const out=await archive(await store(raw),decimalT);assert.equal(out.blank_amount_rows,2);assert.equal(out.exception_count,0);
  const first=await one('select natural_amount::text a,natural_balance::text b from qbo_history_lines where import_id=$1 and qbo_account_id=$2 order by row_no limit 1',[out.id,'income']);assert.deepEqual(first,{a:'0',b:'0.00'});
  zero.ColData[7].value='.01';await assert.rejects(archive(await store(raw),decimalT),/Blank ledger amount with a changed running balance at row 1 of account income/);}
 // An explicit .00 amount is the same zero line: retained, kept out of coding
 // evidence, and never able to reach the categorizer's row_kind filter.
 {const raw=structuredClone(decimalGl);const bank=raw.Rows.Row[0].Rows.Row;const explicit=structuredClone(bank[3]);explicit.ColData[6].value='.00';bank.push(explicit);
  const out=await archive(await store(raw),decimalT);assert.equal(out.transaction_count,7);assert.equal(out.blank_amount_rows,1);assert.equal(out.zero_amount_rows,2);assert.equal(out.exception_count,0);
  const kinds=await q('select row_kind,natural_amount::text a from qbo_history_lines where import_id=$1 and qbo_account_id=$2 order by row_no',[out.id,'bank']);
  assert.deepEqual(kinds.map(k=>k.row_kind),['opening','transaction','transaction','zero_amount','zero_amount']);assert.deepEqual(kinds.slice(3).map(k=>k.a),['0','0.00'],'A blank is 0; an explicit .00 keeps its scale');
  assert.equal(Number((await one("select count(*) n from qbo_history_lines where import_id=$1 and row_kind='transaction' and natural_amount=0",[out.id])).n),0);
  await assert.rejects(q("insert into qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,natural_amount,natural_balance,raw_row) values($1,$2,999,'blank','bank','x','Bank',0,0,'{}')",[co,out.id]),/row_kind_check/);
  // The invariant the categorizer relies on is stored, not just a property of
  // this RPC: even a service-role write cannot file a zero amount as a transaction.
  await assert.rejects(q("insert into qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,natural_amount,natural_balance,raw_row) values($1,$2,998,'transaction','bank','x','Bank',0,0,'{}')",[co,out.id]),/transaction_nonzero/);
  await assert.rejects(q("insert into qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,natural_amount,natural_balance,raw_row) values($1,$2,997,'transaction','bank','x','Bank',0.00,0,'{}')",[co,out.id]),/transaction_nonzero/);}
 // Applying the migration over an archive that already holds a zero-amount
 // transaction row must refuse, not silently leave coding precedent behind.
 {const legacy=new PGlite({extensions:{pgcrypto}});
  try{await legacy.exec(await readFile(new URL('./finance-db/bootstrap.sql',import.meta.url),'utf8'));
   for(const name of [...dependencies,'20260912052930_plaid_bank_feed.sql','20260912203725_bank_feed_workspace_history.sql','20260912231606_accounting_foundation.sql','20260913022606_qbo_historical_ledger.sql'])await legacy.exec(await readFile(new URL('supabase/migrations/'+name,root),'utf8'));
   await legacy.query("insert into entities(id,title) values($1,'Legacy')",[co]);await legacy.query('insert into auth.users(id) values($1)',[finance]);
   const imp=randomUUID();await legacy.query("insert into qbo_history_imports(id,company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,currency,accounting_basis,source_hash,source_snapshot,reconciliation,reconciliation_status,exception_count,transaction_count,created_by) values($1,$2,$3,$4,$5,'2026-08-01','2026-08-31','USD','Accrual','h','{}','[]','matched',0,1,$6)",[imp,co,conn,randomUUID(),randomUUID(),finance]);
   await legacy.query("insert into qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,natural_amount,natural_balance,raw_row) values($1,$2,1,'transaction','bank','x','Bank',0,0,'{}')",[co,imp]);
   await assert.rejects(legacy.exec(formats),/transaction_nonzero/);
   assert.equal((await legacy.query("select pg_get_functiondef('public.archive_qbo_ledger(uuid,uuid)'::regprocedure) d")).rows[0].d.includes('qbo_report_number'),false,'A refused compatibility step leaves the original RPC in place');
  }finally{await legacy.close();}}
 // Summary cells: only a PRESENT empty string means zero. A missing key or a
 // JSON null in a parent group, a child, or a leaf period total is a shape
 // failure, whatever the section's movement.
 for(const edit of [r=>{delete r.Rows.Row[0].Summary.ColData[6].value;},r=>{r.Rows.Row[0].Summary.ColData[6].value=null;}])await badDecimal(edit,/Period total cell is missing for account bank/);
 for(const edit of [r=>{delete r.Rows.Row[1].Summary.ColData[6].value;},r=>{r.Rows.Row[1].Summary.ColData[6].value=null;}])await badDecimal(edit,/Period total cell is missing for account equity/);
 for(const edit of [r=>{delete r.Rows.Row[2].Summary.ColData[6].value;},r=>{r.Rows.Row[2].Summary.ColData[6].value=null;}])await badDecimal(edit,/Ledger total cell is missing in grouped ledger total for expense/);
 for(const edit of [r=>{delete r.Rows.Row[2].Rows.Row[1].Summary.ColData[6].value;},r=>{r.Rows.Row[2].Rows.Row[1].Summary.ColData[6].value=null;}])await badDecimal(edit,/Ledger total cell is missing in grouped ledger total for expense/);
 for(const edit of [r=>{delete r.Rows.Row[3].Summary.ColData[6].value;},r=>{r.Rows.Row[3].Summary.ColData[6].value=null;}])await badDecimal(edit,/Ledger total cell is missing in grouped ledger total for an unidentified group/);
 // Blank rows still count toward the provider's period total and the
 // running-balance chain, so a blank that hides a real movement surfaces as
 // the same exceptions any other row would raise.
 {const raw=structuredClone(decimalGl);raw.Rows.Row[0].Summary.ColData[6].value='-.10';const out=await archive(await store(raw),decimalT);const row=await one('select reconciliation from qbo_history_imports where id=$1',[out.id]);assert.ok(row.reconciliation.find(x=>x.qbo_account_id==='bank').issues.includes('movement_total_mismatch'));}
 await assert.rejects(as(outsider,()=>rpc('archive_qbo_ledger',[g,t])),/Finance access/);
 await assert.rejects(as(otherUser,()=>rpc('archive_qbo_ledger',[g,t])),/Seed accounting settings/);
 await assert.rejects(archive(await store(glShape,other,otherConn),t),/successful GeneralLedger/);
 await assert.rejects(archive(await store(glShape,co,otherConn),t),/connections must match/);
 const saved=await archive(g,t);assert.equal(saved.transaction_count,5);assert.equal(saved.exception_count,0);
 const imported=await one('select * from qbo_history_imports where id=$1',[saved.id]);assert.equal(imported.reconciliation_status,'matched');assert.equal(imported.reconciliation.length,5);
 assert.equal(imported.reconciliation.find(x=>x.qbo_account_id==='equity').ledger_debit_net,-35);
 assert.equal(imported.reconciliation.find(x=>x.qbo_account_id==='expense').ledger_debit_net,4,'Parent own lines, not aggregated subaccount total');
 const lines=await q('select * from qbo_history_lines where import_id=$1 order by row_no',[saved.id]);assert.equal(lines.length,7);assert.equal(lines.filter(x=>x.qbo_transaction_id==='txn-1').length,5,'Repeated transaction IDs are distinct source lines');
 assert.equal(lines[1].memo,'Synthetic memo');assert.equal(lines[1].split_account_id,'split-1');assert.equal(lines[1].counterparty,'Example counterparty');
 {const before=await counts();assert.equal((await archive(g,t)).already_imported,true);assert.deepEqual(await counts(),before,'A repeat of the same source snapshot writes nothing');}
 async function bad(edit,pattern){const raw=structuredClone(glShape);edit(raw);await assert.rejects(archive(await store(raw),t),pattern);}
 await bad(r=>r.Header.Currency='CAD',/currency/);await bad(r=>r.Header.ReportBasis='Cash',/basis/);await bad(r=>r.Header.EndPeriod='2026-09-01',/end date/);
 await bad(r=>r.Columns.Column.pop(),/Unsupported ledger columns/);
 await bad(r=>r.Rows.Row.push(r.Rows.Row[0]),/duplicate ledger account/);
 await bad(r=>delete r.Rows.Row[0].Header.ColData[0].id,/Unsupported or duplicate/);
 await bad(r=>r.Rows.Row[0].Rows.Row[1].ColData[6].value='nope',/Unsupported number format in ledger amount at row 2 of account bank/);
 await bad(r=>r.Rows.Row[2].Summary.ColData[6].value='11',/Grouped ledger totals/);
 const filtered=await store(glShape,co,conn,{account:'bank'});const unfilter=await store(tbShape,co,conn,{account:''});await assert.rejects(archive(filtered,unfilter),/Filtered or custom/);
 const over=await store(glShape);await q("update quickbooks_report_runs set start_date='2025-01-01' where id=$1",[over]);await assert.rejects(archive(over,t),/366 historical days/);
 const after=await store(glShape);await q("update quickbooks_report_runs set end_date='2026-09-01' where id=$1",[after]);await assert.rejects(archive(after,t),/before the Silo start/);
 async function issues(edit,wanted){const raw=structuredClone(glShape);edit(raw);const out=await archive(await store(raw),t);const row=await one('select * from qbo_history_imports where id=$1',[out.id]);assert.equal(row.reconciliation_status,'exceptions');for(const issue of wanted)assert.ok(row.reconciliation.some(a=>a.issues.includes(issue)),issue);}
 await issues(r=>r.Rows.Row[0].Rows.Row[1].ColData[7].value='31',['running_balance_gap']);
 await issues(r=>r.Rows.Row[0].Summary.ColData[6].value='16',['movement_total_mismatch']);
 await issues(r=>r.Rows.Row[0].Rows.Row[2].ColData[7].value='36',['trial_balance_mismatch']);
 await issues(r=>delete r.Rows.Row[0].Rows.Row[1].ColData[1].id,['missing_transaction_reference']);
 await issues(r=>r.Rows.Row.splice(0,1),['missing_ledger_account']);
 for(const table of ['qbo_history_imports','qbo_history_lines']){
  assert.equal((await as(otherUser,()=>q(`select * from ${table}`))).length,0);assert.equal((await as(outsider,()=>q(`select * from ${table}`))).length,0);
  for(const action of [`delete from ${table}`,`update ${table} set id=id`,`insert into ${table}(id) values(gen_random_uuid())`])await assert.rejects(as(finance,()=>q(action)),/permission denied/);
  for(const action of [`delete from ${table}`,`update ${table} set id=id`,`truncate ${table} cascade`])await assert.rejects(q(action),/append.only|immutable/i);
 }
 assert.equal((await one("select has_function_privilege('anon','archive_qbo_ledger(uuid,uuid)','execute') allowed")).allowed,false);
 assert.ok(Number((await one("select count(*) n from finance_audit_events where object_type='qbo_history_imports'")).n)>0);
 await q('update quickbooks_connections set is_active=false where id=$1',[conn]);
 await q('delete from quickbooks_report_runs where id in ($1,$2)',[g,t]);
 assert.deepEqual((await as(finance,()=>one('select source_snapshot from qbo_history_imports where id=$1',[saved.id]))).source_snapshot.general_ledger,glShape);
 assert.equal((await as(finance,()=>q('select * from qbo_history_lines where import_id=$1',[saved.id]))).length,7);
 for(const table of ['journal_adjustments','quickbooks_journal_postings'])assert.equal(Number((await one(`select count(*) n from ${table}`)).n),0);
 assert.equal((await one("select has_function_privilege('authenticated','qbo_report_number(text,text)','execute') allowed")).allowed,false);
 console.log('PASS QBO history: leading-decimal amounts, evidence-settled blank amounts, cell-level format errors, atomic rejection, nested rows, exact reconciliation, exceptions, identity, immutable retention, company/permission isolation, no posting');
}finally{await db.close();}
