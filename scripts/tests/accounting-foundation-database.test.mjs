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
// Reduced, synthetic values; structure verified against two stored QBO reports:
// flat untyped account rows and a final Section/group=GrandTotal summary.
const realShape=JSON.parse(await readFile(new URL('./fixtures/qbo-trial-balance-flat.json',import.meta.url),'utf8'));
const report=()=>structuredClone(realShape);
async function storeReport(raw=report(),company=co,connection=conn){const id=randomUUID();await q("insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,end_date,raw_response,status) values($1,$2,$3,'TrialBalance','2026-08-31',$4,'ok')",[id,company,connection,raw]);return id;}
const seed=id=>as(finance,()=>rpc('seed_accounting_from_qbo',[id,1]));
try{
 await db.exec(await readFile(new URL('./finance-db/bootstrap.sql',import.meta.url),'utf8'));
 for(const name of [...dependencies,'20260912052930_plaid_bank_feed.sql','20260912203725_bank_feed_workspace_history.sql'])await db.exec(await readFile(new URL('supabase/migrations/'+name,root),'utf8'));
 const sql=await readFile(new URL('supabase/migrations/20260912231606_accounting_foundation.sql',root),'utf8');await db.exec(sql);await db.exec(sql);
 await q('insert into entities(id,title) values($1,\'A\'),($2,\'B\')',[co,other]);
 await q('insert into auth.users(id) values($1),($2),($3)',[finance,outsider,otherUser]);
 await q("insert into profiles(id,name,role,department,active_company_id) values($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)",[finance,outsider,otherUser,co,other]);
 await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')",[co,finance,outsider,other,otherUser]);
 await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'a','secret'),($3,$4,'b','othersecret')",[conn,co,otherConn,other]);
 await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type) values($1,$2,'bank','Checking','Bank'),($1,$2,'equity','Equity','Equity')",[co,conn]);
 const id=await storeReport();
 await assert.rejects(as(outsider,()=>rpc('seed_accounting_from_qbo',[id,1])),/Finance access/);
 await assert.rejects(as(otherUser,()=>rpc('seed_accounting_from_qbo',[id,1])),/successful trial balance/);
 await assert.rejects(seed(await storeReport(report(),co,otherConn)),/active QBO connection/);
 const malformed=report();malformed.Rows.Row[1].ColData[2].value='34.99';await assert.rejects(seed(await storeReport(malformed)),/balance exactly/);
 assert.equal(Number((await one('select count(*) as n from accounting_accounts')).n),0,'Failed seed is fully atomic');
 const duplicate=report();duplicate.Rows.Row.push(duplicate.Rows.Row[0]);await assert.rejects(seed(await storeReport(duplicate)),/duplicate account/);
 const foreign=report();foreign.Rows.Row[0].ColData[0].id='missing';await assert.rejects(seed(await storeReport(foreign)),/missing from/);
 const wrongdate=report();wrongdate.Header.EndPeriod='2026-09-01';await assert.rejects(seed(await storeReport(wrongdate)),/Report header/);
 const partial=report();partial.Rows.Row[2].Summary.ColData[1].value='70.00';await assert.rejects(seed(await storeReport(partial)),/provider trial balance total/);
 const filtered=await storeReport();await q(`update quickbooks_report_runs set params='{"department":"1"}' where id=$1`,[filtered]);await assert.rejects(seed(filtered),/Filtered trial balances/);
 const missingTotal=report();missingTotal.Rows.Row.pop();await assert.rejects(seed(await storeReport(missingTotal)),/exactly one provider grand total/);
 const duplicateTotal=report();duplicateTotal.Rows.Row.push(duplicateTotal.Rows.Row[2]);await assert.rejects(seed(await storeReport(duplicateTotal)),/exactly one provider grand total/);
 const subtotalOnly=report();subtotalOnly.Rows.Row[2].group='Subtotal';await assert.rejects(seed(await storeReport(subtotalOnly)),/exactly one provider grand total/);
 const misplaced=report();misplaced.Rows.Row.unshift(misplaced.Rows.Row.pop());await seed(await storeReport(misplaced));
 const withSubtotal=report();withSubtotal.Rows.Row.unshift({group:'Subtotal',Summary:{ColData:[{value:'TOTAL'},{value:'999.00'},{value:'999.00'}]}});await seed(await storeReport(withSubtotal));
 const nested=report();const total=nested.Rows.Row.pop();delete total.group;total.Rows={Row:nested.Rows.Row};nested.Rows.Row=[total];await seed(await storeReport(nested));
 const s=await seed(id);const first=await one('select * from accounting_opening_balances');assert.equal(first.snapshot.lines.length,2);assert.equal(first.snapshot.debits,35);assert.equal(first.snapshot.destination,'silo_opening_history');
 assert.equal((await one('select accounting_start_date::text as d from accounting_settings')).d,'2026-09-01');
 const accountIds=(await q('select id from accounting_accounts order by id')).map(r=>r.id);await seed(id);assert.deepEqual((await q('select id from accounting_accounts order by id')).map(r=>r.id),accountIds);
 const picker=await as(finance,()=>rpc('accounting_qbo_connections',[]));assert.equal(picker.length,1);assert.equal(picker[0].id,conn);assert.ok(!JSON.stringify(picker).includes('secret'));
 for(const table of ['accounting_settings','accounting_accounts','accounting_opening_balances']){
  assert.equal((await as(otherUser,()=>q(`select * from ${table}`))).length,0);
  assert.equal((await as(outsider,()=>q(`select * from ${table}`))).length,0);
  await assert.rejects(as(finance,()=>q(`delete from ${table}`)),/permission denied/);
 }
 await assert.rejects(as(finance,()=>rpc('accept_accounting_opening_balances',[s.id,'stale','Reviewed against QBO'])),/changed/);
 const newer=report();newer.Header.Currency='CAD';const updated=await seed(await storeReport(newer));
 await assert.rejects(as(finance,()=>rpc('accept_accounting_opening_balances',[s.id,s.snapshot_hash,'Reviewed against QBO'])),/changed/);
 await assert.rejects(as(finance,()=>rpc('accept_accounting_opening_balances',[s.id,updated.snapshot_hash,''])),/Explain/);
 await as(finance,()=>rpc('accept_accounting_opening_balances',[s.id,updated.snapshot_hash,'Reviewed against QBO trial balance']));
 assert.equal((await one('select accepted_by from accounting_opening_balances')).accepted_by,finance);
 assert.equal((await as(finance,()=>rpc('accept_accounting_opening_balances',[s.id,updated.snapshot_hash,'Retry accepted review']))).already_accepted,true);
 await assert.rejects(seed(id),/already accepted/);
 for(const table of ['journal_adjustments','quickbooks_journal_postings'])assert.equal(Number((await one(`select count(*) n from ${table}`)).n),0,'No outbound journals are produced');
 assert.ok(Number((await one("select count(*) n from finance_audit_events where object_type='accounting_opening_balances'")).n)>=2);
 for(const signature of ['seed_accounting_from_qbo(uuid,integer)','accept_accounting_opening_balances(uuid,text,text)','accounting_qbo_connections()'])assert.equal((await one("select has_function_privilege('anon',$1,'execute') as allowed",[signature])).allowed,false);
 console.log('PASS accounting foundation: atomic seed, company/role boundaries, exact balance, stable IDs, stale approval, immutable acceptance, audit, no outbound journal');
}finally{await db.close();}
