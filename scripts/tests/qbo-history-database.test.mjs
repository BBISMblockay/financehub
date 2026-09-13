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
 await q("insert into entities(id,title) values($1,'Test A'),($2,'Test B')",[co,other]);
 await q('insert into auth.users(id) values($1),($2),($3)',[finance,outsider,otherUser]);
 await q("insert into profiles(id,name,role,department,active_company_id) values($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)",[finance,outsider,otherUser,co,other]);
 await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')",[co,finance,outsider,other,otherUser]);
 await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'a','secret'),($3,$4,'b','othersecret')",[conn,co,otherConn,other]);
 for(const [id,name,type] of [['bank','Checking','Bank'],['equity','Equity','Equity'],['expense','Expenses','Expense'],['child','Supplies','Expense'],['income','Sales','Income']])await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type) values($1,$2,$3,$4,$5)',[co,conn,id,name,type]);
 const t=await store(tbShape),g=await store(glShape);
 const openingReport=await store(tbShape);await as(finance,()=>rpc('seed_accounting_from_qbo',[openingReport,1]));
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
 assert.equal((await archive(g,t)).already_imported,true);assert.equal(Number((await one('select count(*) n from qbo_history_imports')).n),1);
 async function bad(edit,pattern){const raw=structuredClone(glShape);edit(raw);await assert.rejects(archive(await store(raw),t),pattern);}
 await bad(r=>r.Header.Currency='CAD',/currency/);await bad(r=>r.Header.ReportBasis='Cash',/basis/);await bad(r=>r.Header.EndPeriod='2026-09-01',/end date/);
 await bad(r=>r.Columns.Column.pop(),/Unsupported ledger columns/);
 await bad(r=>r.Rows.Row.push(r.Rows.Row[0]),/duplicate ledger account/);
 await bad(r=>delete r.Rows.Row[0].Header.ColData[0].id,/Unsupported or duplicate/);
 await bad(r=>r.Rows.Row[0].Rows.Row[1].ColData[6].value='nope',/Invalid ledger movement/);
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
 console.log('PASS QBO history: nested rows, exact reconciliation, exceptions, identity, immutable retention, company/permission isolation, no posting');
}finally{await db.close();}
