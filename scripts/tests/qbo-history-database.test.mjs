import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { generateLedgerPair } from './fixtures/qbo-ledger-generator.mjs';
// QBO_DB_MUTATION=no-resume-state   (a section resumed mid-way forgets its running balance)
// QBO_DB_MUTATION=unbounded         (the per-call budget removed: one call does everything)
// QBO_DB_MUTATION=no-size-guard     (the report-size ceiling on the unbounded phases removed)
// QBO_DB_MUTATION=no-byte-guard     (only the byte ceiling removed; the row ceiling does not cover a dense ledger)
// QBO_DB_MUTATION=absorbs-unattributed-money (an account-less section with real money filed under the placeholder)
// QBO_DB_MUTATION=admits-unattributed-balance (the placeholder's running-balance admission test removed)
// QBO_DB_MUTATION=admits-unattributed-ending-balance (the placeholder's section ENDING BALANCE admission test removed)
// QBO_DB_MUTATION=exempts-unattributed-problems (every problem on the placeholder exempt from exception_count, not just the notice)
// QBO_DB_MUTATION=guard-after-hash  (the ceiling kept but moved back below the snapshot hash)
// QBO_DB_MUTATION=finalize-unguarded (finalization outside its own exception block)
const mutation=process.env.QBO_DB_MUTATION||'';
assert.ok(['','no-resume-state','unbounded','no-size-guard','no-byte-guard','guard-after-hash','finalize-unguarded','absorbs-unattributed-money','admits-unattributed-balance','admits-unattributed-ending-balance','exempts-unattributed-problems'].includes(mutation),'Unknown QBO history mutation');
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
async function store(raw,company=co,connection=conn,params={},start='2026-08-01',end='2026-08-31'){const id=randomUUID();await q("insert into quickbooks_report_runs(id,company_entity_id,connection_id,report_name,start_date,end_date,raw_response,status,params) values($1,$2,$3,$4,$5,$6,$7,'ok',$8)",[id,company,connection,raw.Header.ReportName,start,end,raw,params]);return id;}
// The archive is a job the caller drives: every call is bounded and returns
// in_progress until the last one. `batchRows` forces small batches so the
// suite exercises resume paths deterministically; production defaults to
// 5,000 rows / 3s per call.
let batchRows=null;
const step=(g,t,actor=finance)=>as(actor,async()=>{if(batchRows!==null)await q("select set_config('silo.qbo_archive_batch_rows',$1,false)",[String(batchRows)]);return rpc('archive_qbo_ledger',[g,t]);});
async function archive(g,t,actor=finance){const progress=[];for(;;){const r=await step(g,t,actor);progress.push(r);if(r.status==='failed')throw Object.assign(new Error(r.error),{job_id:r.job_id,progress});if(r.status!=='in_progress')return Object.assign(r,{progress});if(progress.length>10000)throw new Error('archive never completed');}}
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
 const bounded=await readFile(new URL('supabase/migrations/20260915000000_qbo_history_bounded_archive.sql',root),'utf8');await db.exec(bounded);await db.exec(bounded);
 const unattributed=await readFile(new URL('supabase/migrations/20260915200000_qbo_history_unattributed_section.sql',root),'utf8');await db.exec(unattributed);await db.exec(unattributed);
 if(mutation){const def=(await one("select pg_get_functiondef('public.archive_qbo_ledger(uuid,uuid)'::regprocedure) d")).d;
  let mutated=def;
  if(mutation==='no-resume-state')mutated=def.replace("state=jsonb_build_object('balance',balance,","state=jsonb_build_object('balance',0,");
  else if(mutation==='unbounded')mutated=def.replace("current_setting('silo.qbo_archive_batch_rows',true),'')::integer,5000)","current_setting('silo.qbo_archive_batch_rows',true),'')::integer,2147483647)").replace("current_setting('silo.qbo_archive_batch_ms',true),'')::integer,3000)","current_setting('silo.qbo_archive_batch_ms',true),'')::integer,2147483647)");
  else if(mutation==='no-size-guard')mutated=def.replace('if n > max_rows then','if false then').replace('if pg_column_size(gl.raw_response) > max_bytes then','if false then');
  // The byte ceiling on its own: a dense ledger reaches 8 MB while still short,
  // so the row ceiling does not cover it.
  else if(mutation==='no-byte-guard')mutated=def.replace('if pg_column_size(gl.raw_response) > max_bytes then','if false then');
  // An account-less section carrying real money filed under the placeholder
  // instead of refusing -- the silent mis-attribution the guard exists to stop.
  else if(mutation==='absorbs-unattributed-money')mutated=def.replace('    if n>0 then','    if false then');
  // The placeholder skips the trial-balance comparison, so a balance it admits
  // is never checked against anything again. Removing only the running-balance
  // half of the admission test leaves an amounts-only check -- the exact shape
  // the cycle-1 review found.
  else if(mutation==='admits-unattributed-balance'){
   const anchor="'{ColData,7,value}',where_),0)<>0;\n    if n>0 then";
   if(!def.includes(anchor))throw new Error('admits-unattributed-balance: the running-balance admission test was not found');
   mutated=def.replace(anchor,"'{ColData,7,value}',where_),0)<>0;\n    if false then");
  }
  // Column 7 of the section Summary is the ENDING BALANCE, a separate claim
  // from the period total in column 6. Removing its test leaves a section that
  // reports no movement and a balance carried out, which nothing downstream
  // looks at because the placeholder skips the trial-balance comparison.
  else if(mutation==='admits-unattributed-ending-balance'){
   const anchor="'{Summary,ColData,7,value}',where_),0)<>0 then";
   if(!def.includes(anchor))throw new Error('admits-unattributed-ending-balance: the ending-balance admission test was not found');
   mutated=def.replace(anchor,"'{Summary,ColData,7,value}',where_),0)<>0 and false then");
  }
  // The blanket exemption this cycle replaced: every problem on the
  // unattributed section excused, not just the intentional notice.
  else if(mutation==='exempts-unattributed-problems'){
   const anchor="exists(select 1 from unnest(problems) p where p<>'unattributed_ledger_section')";
   if(!def.includes(anchor))throw new Error('exempts-unattributed-problems: the scoped exemption was not found');
   mutated=def.replace(anchor,"cardinality(problems)>0 and qid<>'silo:unattributed'");
  }
  // Guard present but AFTER the hash: the shape cycle-2 review found. Moving
  // the ceiling below the snapshot build reproduces it exactly.
  else if(mutation==='guard-after-hash'){
   const guard=def.match(/ {2}if pg_column_size\(gl\.raw_response\)[\s\S]*?n, max_rows; end if;\n/);
   if(!guard)throw new Error('guard-after-hash: the size guard block was not found');
   mutated=def.replace(guard[0],'').replace('  select id into imp from public.qbo_history_imports where company_entity_id=co and qbo_connection_id=gl.connection_id and source_hash=digest;',guard[0]+'  select id into imp from public.qbo_history_imports where company_entity_id=co and qbo_connection_id=gl.connection_id and source_hash=digest;');
  }
  else if(mutation==='finalize-unguarded'){
   // Let a finalization error propagate instead of terminating the job, which
   // is what the code did before this cycle's fix: the call rolls back and the
   // job is left 'running' at 100% with nothing recording why.
   const handler=' exception when others then\n  err:=sqlerrm;\n end;';
   const last=def.lastIndexOf(handler);
   assert.ok(last>def.indexOf(handler),'the finalization block must have its own handler to remove');
   mutated=def.slice(0,last)+' exception when others then\n  raise;\n end;'+def.slice(last+handler.length);
  }
  assert.notEqual(mutated,def,'mutation must change the live function');await db.exec(mutated);}
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
 await bad(r=>delete r.Rows.Row[0].Header.ColData[0].id,/has no QuickBooks account and carries \d+ rows with an amount/);
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
 // ── Bounded, resumable archive (20260915000000) ──────────────────────────
 // Two synthetic report pairs in the production shape at scale; the
 // generator ties its own trial balance, so a matched reconciliation is the
 // expected outcome and any drift is the archive's.
 const scaleRows=Number(process.env.QBO_HISTORY_SCALE_ROWS||40000);
 const scale=generateLedgerPair({rows:scaleRows,seed:scaleRows});
 await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(scale.accounts)]);
 const scaleWindow=[scale.gl.Header.StartPeriod,scale.gl.Header.EndPeriod];
 const scaleG=await store(scale.gl,co,conn,{},...scaleWindow),scaleT=await store(scale.tb,co,conn,{},...scaleWindow);
 const jobsFor=(g)=>q('select * from qbo_history_jobs where gl_run_id=$1 order by created_at',[g]);
 const staged=async(jobId)=>({sections:Number((await one('select count(*) n from qbo_history_staging_sections where job_id=$1',[jobId])).n),lines:Number((await one('select count(*) n from qbo_history_staging_lines where job_id=$1',[jobId])).n)});
 // Progress and completeness while a job is in flight: the evidence tables
 // hold nothing for this source, finance can read the job's progress, the
 // staging tables are closed to every client, another company sees no job.
 batchRows=7000;
 {const before=await counts();const first=await step(scaleG,scaleT);
  assert.equal(first.status,'in_progress',JSON.stringify(first));assert.equal(first.rows_total,scale.expected.lineRows);assert.ok(first.rows_done>0&&first.rows_done<first.rows_total);assert.equal(first.sections_total,scale.expected.leafAccounts);
  assert.deepEqual(await counts(),before,'An in-progress archive is not evidence: nothing in imports, lines or the audit trail');
  const job=(await jobsFor(scaleG))[0];assert.equal(job.status,'running');assert.equal(job.rows_done,first.rows_done);assert.ok(job.source_snapshot,'The frozen source stays with the job until it completes');
  const visible=await as(finance,()=>q('select id,status,rows_done,rows_total from qbo_history_jobs where id=$1',[job.id]));assert.equal(visible.length,1,'Finance can read progress');
  assert.equal((await as(otherUser,()=>q('select id from qbo_history_jobs where id=$1',[job.id]))).length,0,'Another company cannot see the job');
  for(const table of ['qbo_history_staging_sections','qbo_history_staging_lines'])for(const actor of [finance,otherUser])await assert.rejects(as(actor,()=>q(`select * from ${table} where job_id=$1`,[job.id])),/permission denied/,`${table} is closed to clients`);
  for(const action of ["update qbo_history_jobs set status='complete'","delete from qbo_history_jobs"])await assert.rejects(as(finance,()=>q(action)),/permission denied/);
  // Only one running job per source, ever: the partial unique index refuses
  // a second even from a service-role write.
  await assert.rejects(q("insert into qbo_history_jobs(company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,source_hash,created_by) select company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,source_hash,created_by from qbo_history_jobs where id=$1",[job.id]),/qbo_history_jobs_one_running/);
  // The same reports resume the same job; progress only moves forward.
  const second=await step(scaleG,scaleT);assert.equal(second.job_id,job.id,'Retrying with the same reports resumes the job');assert.ok(second.rows_done>first.rows_done);
  if(mutation==='unbounded')assert.fail('The per-call budget was removed, yet the first call did not finish the archive');}
 const scaleStart=Date.now();const scaled=await archive(scaleG,scaleT);const scaleMs=Date.now()-scaleStart;
 assert.equal(scaled.status,'complete');assert.ok(scaled.calls>=Math.ceil(scale.expected.lineRows/7000),`Bounded calls: ${scaled.calls}`);
 assert.ok(scaled.progress.slice(0,-1).every((p,i,a)=>p.status==='in_progress'&&(i===0||p.rows_done>a[i-1].rows_done)),'Every call before the last reports monotonic progress');
 assert.equal(scaled.transaction_count,scale.expected.dataRows,'Every data row is retained');assert.equal(scaled.zero_amount_rows,scale.expected.zeroRows);assert.equal(scaled.blank_amount_rows,scale.expected.blankRows);assert.equal(scaled.exception_count,0,'A self-consistent ledger reconciles with no exceptions');
 {const imp=await one('select * from qbo_history_imports where id=$1',[scaled.id]);assert.equal(imp.reconciliation_status,'matched');assert.equal(imp.transaction_count,scale.expected.dataRows);assert.equal(imp.reconciliation.length,scale.expected.leafAccounts);assert.equal(imp.source_hash.length,64);assert.deepEqual(imp.source_snapshot.general_ledger,scale.gl,'The frozen source is the report, byte for byte');
  const shape=await one('select count(*)::int n,min(row_no) lo,max(row_no) hi,count(distinct row_no)::int d from qbo_history_lines where import_id=$1',[scaled.id]);assert.deepEqual([shape.n,shape.lo,shape.hi,shape.d],[scale.expected.lineRows,1,scale.expected.lineRows,scale.expected.lineRows],'Lines are contiguous and complete');
  assert.equal(Number((await one("select count(*) n from qbo_history_lines where import_id=$1 and row_kind='transaction' and natural_amount=0",[scaled.id])).n),0);
  // Per account, the last retained balance normalised by type equals the TB.
  const closings=await q(`select l.qbo_account_id,l.natural_balance::text b from qbo_history_lines l join (select import_id,qbo_account_id,max(row_no) m from qbo_history_lines where import_id=$1 group by 1,2) x on x.import_id=l.import_id and x.qbo_account_id=l.qbo_account_id and x.m=l.row_no`,[scaled.id]);
  for(const c of closings){const check=imp.reconciliation.find(r=>r.qbo_account_id===c.qbo_account_id);assert.equal(check.difference,0,c.qbo_account_id);}
  const job=(await jobsFor(scaleG)).at(-1);assert.equal(job.status,'complete');assert.equal(job.import_id,scaled.id);assert.equal(job.source_snapshot,null,'The job drops its copy once the import holds it');assert.deepEqual(await staged(job.id),{sections:0,lines:0},'Staging is emptied on completion');
  const audit=await one("select new_values from finance_audit_events where object_type='qbo_history_imports' and object_id=$1",[scaled.id]);assert.equal(audit.new_values.source_hash,imp.source_hash);assert.equal('source_snapshot' in audit.new_values,false,'The audit event records the import without the multi-megabyte snapshot body');
  assert.equal((await archive(scaleG,scaleT)).already_imported,true,'A completed source is not archived twice');
  console.log(`  scale: ${scale.expected.lineRows} lines archived in ${scaled.calls} bounded calls, ${(scaleMs/1000).toFixed(1)}s on PGlite (a real server is several times faster; see scripts/tests/qbo-history-benchmark.mjs)`);}
 // Malformed data discovered after earlier calls already staged rows: the
 // failing call rolls back its own work, the job records the message, its
 // staging is removed, and the evidence tables never saw the source. A retry
 // with the same reports starts a fresh job and fails identically; a corrected
 // report (a new source) archives.
 batchRows=2000;
 {const broken=generateLedgerPair({rows:12000,seed:12000});const own=broken.gl.Rows.Row[0].Rows.Row[0];own.Rows.Row[3000].ColData[6].value='1,000.00';
  const bG=await store(broken.gl,co,conn,{},...scaleWindow),bT=await store(broken.tb,co,conn,{},...scaleWindow);const before=await counts();
  const first=await step(bG,bT);assert.equal(first.status,'in_progress');const jobId=first.job_id;assert.ok((await staged(jobId)).lines>0,'Earlier calls staged rows');
  const failure=await assert.rejects(archive(bG,bT),/Unsupported number format in ledger amount at row 3001 of account acct-bank/);
  assert.deepEqual(await counts(),before,'A failed job writes no evidence and no audit event');
  const job=await one('select * from qbo_history_jobs where id=$1',[jobId]);assert.equal(job.status,'failed');assert.match(job.error,/row 3001 of account acct-bank/);assert.equal(job.source_snapshot,null);assert.deepEqual(await staged(jobId),{sections:0,lines:0},'A failed job leaves no staging behind');
  await assert.rejects(archive(bG,bT),/row 3001 of account acct-bank/);const jobs=await jobsFor(bG);assert.equal(jobs.length,2,'A retry after failure is a fresh job');assert.ok(jobs.every(j=>j.status==='failed'));
  own.Rows.Row[3000].ColData[6].value='1000.00';own.Rows.Row[3000].ColData[7].value=own.Rows.Row[2999].ColData[7].value;
  // (the corrected row no longer ties its running balance: the archive keeps it as an exception, never a refusal)
  const fixed=await archive(await store(broken.gl,co,conn,{},...scaleWindow),bT);assert.equal(fixed.status,'complete');assert.ok(fixed.calls>1);
  const fixedImp=await one('select reconciliation_status from qbo_history_imports where id=$1',[fixed.id]);assert.equal(fixedImp.reconciliation_status,'exceptions','A hand-edited row surfaces as a reconciliation exception, not as lost history');}
 // A newer source for the same connection supersedes an unfinished job.
 {const a=generateLedgerPair({rows:6000,seed:61}),b=generateLedgerPair({rows:6000,seed:62});
  const aG=await store(a.gl,co,conn,{},...scaleWindow),aT=await store(a.tb,co,conn,{},...scaleWindow),bG=await store(b.gl,co,conn,{},...scaleWindow),bT=await store(b.tb,co,conn,{},...scaleWindow);
  const started=await step(aG,aT);assert.equal(started.status,'in_progress');
  const other=await archive(bG,bT);assert.equal(other.status,'complete');
  const abandoned=await one('select status,error from qbo_history_jobs where id=$1',[started.job_id]);assert.equal(abandoned.status,'abandoned');assert.deepEqual(await staged(started.job_id),{sections:0,lines:0});
  const again=await archive(aG,aT);assert.equal(again.status,'complete');assert.notEqual(again.job_id,started.job_id,'An abandoned job is not resumed; the source is archived from the start');
  assert.equal(Number((await one("select count(*) n from qbo_history_jobs where status='running'")).n),0,'No job is left running');}
  // QBO's own housekeeping bucket: a leaf section with NO account id, holding
  // rows nobody can assign an account to. On Baseballism's real ledger it is
  // called 'Not Specified' and carries 24 rows in the full-year window, every
  // one a zero Journal Entry or a blank-amount Payment reading 'Created by QB
  // Online to link credits to ...'. Refusing the import over it left that
  // window permanently unarchivable.
  {const pair=generateLedgerPair({rows:200,seed:770});
   // Built by hand rather than in the generator: this is a PROVIDER shape SILO
   // never produces, and the whole point is that it carries no id at all.
   const blank=(v)=>({type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900001',value:'Payment'},{value:''},
     {value:'Created by QB Online to link credits to the invoice'},{value:''},{value:''},{value:v},{value:'0.00'}]});
   const nsRows=[blank(''),blank('.00'),blank('0.00')];
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:nsRows},
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'0.00'},{value:'0.00'}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const uG=await store(pair.gl,co,conn,{},...scaleWindow),uT=await store(pair.tb,co,conn,{},...scaleWindow);
   const out=await archive(uG,uT);
   assert.equal(out.status,'complete','an account-less ZERO section no longer refuses the whole import');
   const kept=await q("select row_kind,natural_amount,account_name,account_type from qbo_history_lines where import_id=$1 and qbo_account_id='silo:unattributed' order by row_no",[out.id]);
   assert.equal(kept.length,nsRows.length,'every row of it is archived, not skipped');
   assert.ok(kept.every(r=>Number(r.natural_amount)===0),'and every one is zero, which is why it can be archived at all');
   assert.ok(kept.every(r=>r.account_name==='Not Specified' && r.account_type==='Unattributed'),
     'filed under a name and type that cannot be read as a QuickBooks account');
   const recon=await one('select reconciliation r,reconciliation_status s from qbo_history_imports where id=$1',[out.id]);
   const line=recon.r.find(x=>x.qbo_account_id==='silo:unattributed');
   assert.ok(line,'the section is named in the reconciliation rather than vanishing from it');
   assert.deepEqual(line.issues,['unattributed_ledger_section'],'under its own issue, not a trial-balance miss');
   assert.equal(line.difference,null,'it has no trial balance counterpart to differ from');
   assert.equal(recon.s,'matched','a provably zero section does not make an otherwise clean archive read as exceptions');
  }
  // The half that matters: an account-less section carrying ACTUAL MONEY is a
  // bookkeeping problem for a person, not something to file under a
  // placeholder. It refuses the whole import and says how many rows.
  {const before=await counts();
   const pair=generateLedgerPair({rows:200,seed:771});
   const row=(v,bal)=>({type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900002',value:'Journal Entry'},{value:'JE-9'},
     {value:''},{value:''},{value:''},{value:v},{value:bal}]});
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:[row('0.00','0.00'),row('250.00','250.00')]},
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'250.00'},{value:'250.00'}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const mG=await store(pair.gl,co,conn,{},...scaleWindow),mT=await store(pair.tb,co,conn,{},...scaleWindow);
   if(mutation==='absorbs-unattributed-money'){await archive(mG,mT);assert.fail('The non-zero guard was removed, yet money with no account was still archived under the placeholder');}
   await assert.rejects(archive(mG,mT),/has no QuickBooks account and carries 1 rows with an amount/,
     'money with no account refuses the whole import and names the count');
   assert.deepEqual(await counts(),before,'and writes no evidence');
  }
  // Admission is the ONLY test this section ever faces: the placeholder has no
  // trial-balance counterpart, so whatever it admits is never checked against
  // anything again. Amount cells alone are not enough -- these four cases are
  // the ways a section with no amounts still carries a real fact.
  //
  // (1) A Beginning Balance row: blank amount, real balance. It passes an
  // amounts-only test, keeps a $250 closing balance under the placeholder and
  // reports 'matched'.
  {const before=await counts();
   const pair=generateLedgerPair({rows:200,seed:772});
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:[{type:'Data',ColData:[{value:'Beginning Balance'},{value:''},{value:''},{value:''},{value:''},{value:''},{value:''},{value:'250.00'}]},
       {type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900003',value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:'.00'},{value:'250.00'}]}]},
     // The section summary's ending balance is left BLANK, which is what QBO
     // actually emits here (all 14 stored sections carry ''), so the only guard
     // that can catch this fixture is the row-level running balance one. If the
     // summary also said 250 the ending-balance guard would catch it too and
     // the mutation below would prove nothing about the row-level test.
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'.00'},{value:''}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const bG=await store(pair.gl,co,conn,{},...scaleWindow),bT=await store(pair.tb,co,conn,{},...scaleWindow);
   if(mutation==='admits-unattributed-balance'){
    const out=await archive(bG,bT);
    const recon=await one('select reconciliation r,reconciliation_status s from qbo_history_imports where id=$1',[out.id]);
    const line=recon.r.find(x=>x.qbo_account_id==='silo:unattributed');
    assert.fail(`The running-balance admission test was removed, yet a $250 unattributed balance was archived reading '${recon.s}' with ledger_debit_net ${line&&line.ledger_debit_net}`);
   }
   await assert.rejects(archive(bG,bT),/has no QuickBooks account and carries a running balance on 2 rows/,
     'a balance with no account refuses the whole import, the same as an amount does');
   assert.deepEqual(await counts(),before,'and writes no evidence');
  }
  // (2) A zero-amount row whose running balance MOVES. Under an amounts-only
  // test this archived and recorded running_balance_gap; the gap was then
  // excused from exception_count, so it reported 'matched'. Refusing at
  // admission is the stronger outcome: the gap is now unreachable rather than
  // uncounted.
  {const before=await counts();
   const pair=generateLedgerPair({rows:200,seed:773});
   const row=(id,v,bal)=>({type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id,value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:v},{value:bal}]});
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:[row('900004','.00','0.00'),row('900005','.00','40.00')]},
     // Blank summary ending balance again, for the same isolation reason.
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'.00'},{value:''}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const gG=await store(pair.gl,co,conn,{},...scaleWindow),gT=await store(pair.tb,co,conn,{},...scaleWindow);
   if(mutation==='admits-unattributed-balance'){
    const out=await archive(gG,gT);
    const recon=await one('select reconciliation r,reconciliation_status s from qbo_history_imports where id=$1',[out.id]);
    const line=recon.r.find(x=>x.qbo_account_id==='silo:unattributed');
    assert.fail(`The running-balance admission test was removed, yet zero movements against a moving balance archived reading '${recon.s}' with issues ${JSON.stringify(line&&line.issues)}`);
   }
   await assert.rejects(archive(gG,gT),/has no QuickBooks account and carries a running balance on 1 rows/,
     'a moving running balance beside zero movements refuses rather than being archived and excused');
   assert.deepEqual(await counts(),before,'and writes no evidence');
  }
  // (3) A period total that disagrees with the rows, and (4) a period total
  // cell that is absent entirely. Every other account refuses a missing total
  // when it is staged; the placeholder read it as zero, so QBO telling us money
  // moved was silently discarded.
  {const before=await counts();
   const mk=(summaryCell)=>{const pair=generateLedgerPair({rows:200,seed:774});
    pair.gl.Rows.Row.push({type:'Section',
      Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
      Rows:{Row:[{type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900006',value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:'.00'},{value:'.00'}]}]},
      Summary:{ColData:[...Array(6).fill({value:''}),summaryCell,{value:'.00'}]}});
    return pair;};
   const disagrees=mk({value:'500.00'});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(disagrees.accounts)]);
   const dG=await store(disagrees.gl,co,conn,{},...scaleWindow),dT=await store(disagrees.tb,co,conn,{},...scaleWindow);
   await assert.rejects(archive(dG,dT),/has no QuickBooks account and reports a non-zero period total/,
     'a period total saying money moved refuses, rather than being overruled by the rows');
   const absent=mk({});
   const aG=await store(absent.gl,co,conn,{},...scaleWindow),aT=await store(absent.tb,co,conn,{},...scaleWindow);
   await assert.rejects(archive(aG,aT),/Period total cell is missing for the unattributed ledger section/,
     'an absent period total refuses here exactly as it does for a real account, instead of reading as zero');
   assert.deepEqual(await counts(),before,'and neither writes evidence');
  }
  // Summary column 7 is `rbal_nat_amount`, the section's ENDING BALANCE, and it
  // is a separate claim from the period total in column 6: zero movement and a
  // balance carried out is a coherent thing for a report to say. On a real
  // account it would surface as a trial_balance_mismatch, because the closing
  // balance is compared to the trial balance; the placeholder skips that
  // comparison, so nothing downstream would ever look at it.
  {const before=await counts();
   const mk=(balCell)=>{const pair=generateLedgerPair({rows:200,seed:777});
    pair.gl.Rows.Row.push({type:'Section',
      Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
      Rows:{Row:[{type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900009',value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:'.00'},{value:'.00'}]}]},
      Summary:{ColData:[...Array(6).fill({value:''}),{value:'.00'},balCell]}});
    return pair;};
   const carried=mk({value:'250.00'});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(carried.accounts)]);
   const cG=await store(carried.gl,co,conn,{},...scaleWindow),cT=await store(carried.tb,co,conn,{},...scaleWindow);
   if(mutation==='admits-unattributed-ending-balance'){
    const out=await archive(cG,cT);
    const recon=await one('select reconciliation r,reconciliation_status s from qbo_history_imports where id=$1',[out.id]);
    const line=recon.r.find(x=>x.qbo_account_id==='silo:unattributed');
    assert.fail(`The ending-balance admission test was removed, yet a section reporting a $250 balance carried out was archived reading '${recon.s}' with issues ${JSON.stringify(line&&line.issues)}`);
   }
   await assert.rejects(archive(cG,cT),/has no QuickBooks account and reports a non-zero ending balance/,
     'zero movement and a balance carried out refuses; the period total being zero does not vouch for the balance');
   const gone=mk({});
   const gG=await store(gone.gl,co,conn,{},...scaleWindow),gT=await store(gone.tb,co,conn,{},...scaleWindow);
   await assert.rejects(archive(gG,gT),/Period ending balance cell is missing for the unattributed ledger section/,
     'an absent ending balance is unknown, never zero');
   assert.deepEqual(await counts(),before,'and neither writes evidence');
  }
  // A row with BOTH cells blank. QBO really does emit these: four of the seven
  // stored windows of Baseballism's ledger carry exactly one, and before this
  // they failed on 'Missing running balance' -- so archiving the account-less
  // section fixed the one window that was reported and left the rest refusing
  // with a different message. A blank balance is read as zero HERE and only
  // here, because admission has already established the section is all zero.
  {const pair=generateLedgerPair({rows:200,seed:775});
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:[{type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900007',value:'Payment'},{value:''},
       {value:'Created by QB Online to link credits to the invoice'},{value:''},{value:''},{value:''},{value:''}]},
       {type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{id:'900008',value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:'.00'},{value:'.00'}]}]},
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'.00'},{value:''}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const kG=await store(pair.gl,co,conn,{},...scaleWindow),kT=await store(pair.tb,co,conn,{},...scaleWindow);
   const out=await archive(kG,kT);
   assert.equal(out.status,'complete','a blank running balance on the all-zero placeholder no longer refuses the window');
   const kept=await q("select natural_amount,natural_balance from qbo_history_lines where import_id=$1 and qbo_account_id='silo:unattributed' order by row_no",[out.id]);
   assert.equal(kept.length,2,'both rows are archived, not skipped');
   assert.ok(kept.every(r=>Number(r.natural_amount)===0 && Number(r.natural_balance)===0),
     'the blank reads as the zero it is, and is stored as zero rather than as null');
   const recon=await one('select reconciliation_status s from qbo_history_imports where id=$1',[out.id]);
   assert.equal(recon.s,'matched','and the window reconciles');
  }
  // The exemption from exception_count is the NOTICE, not the section. A real
  // problem on the placeholder -- here a row QBO gave no transaction id, which
  // admission does not and should not refuse -- is counted like it would be on
  // any other account, so 'matched' keeps meaning matched.
  {const pair=generateLedgerPair({rows:200,seed:776});
   pair.gl.Rows.Row.push({type:'Section',
     Header:{ColData:[{value:'Not Specified'},...Array(7).fill({value:''})]},
     Rows:{Row:[{type:'Data',ColData:[{value:pair.gl.Header.StartPeriod},{value:'Journal Entry'},{value:''},{value:''},{value:''},{value:''},{value:'.00'},{value:'.00'}]}]},
     Summary:{ColData:[...Array(6).fill({value:''}),{value:'.00'},{value:'.00'}]}});
   await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(pair.accounts)]);
   const rG=await store(pair.gl,co,conn,{},...scaleWindow),rT=await store(pair.tb,co,conn,{},...scaleWindow);
   const out=await archive(rG,rT);
   const recon=await one('select reconciliation r,reconciliation_status s,exception_count e from qbo_history_imports where id=$1',[out.id]);
   const line=recon.r.find(x=>x.qbo_account_id==='silo:unattributed');
   assert.ok(line.issues.includes('unattributed_ledger_section'),'the notice is still recorded');
   assert.ok(line.issues.includes('missing_transaction_reference'),'and so is the real problem beside it');
   // No mutation branch here on purpose: restoring the blanket exemption makes
   // the two plain assertions below fail on their own, which is the point.
   assert.equal(Number(recon.e),1,'a real problem on the placeholder counts as an exception');
   assert.equal(recon.s,'exceptions','so the archive does not report matched over it');
  }
 // The two phases the per-call budget does not cover -- freezing and hashing
 // the source, and the atomic final copy -- grow with the report, so a size
 // guard refuses an oversized one BEFORE any work rather than letting it time
 // out half way. Measured longest call on a real server: 3.6s at 100k rows,
 // 6.9s at 150k, against the authenticated 8s ceiling; the shipped ceiling is
 // 100k rows / 8MB. The setting is lowered here so the refusal is exercised
 // without building a 100k-row fixture.
 {const before=await counts();const small=generateLedgerPair({rows:300,seed:300});
  await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(small.accounts)]);
  const sG=await store(small.gl,co,conn,{},...scaleWindow),sT=await store(small.tb,co,conn,{},...scaleWindow);
  // The setting is session-scoped here (one PGlite connection), so it is put
  // back afterwards or every later call would inherit the lowered ceiling.
  const capped=()=>as(finance,async()=>{await q("select set_config('silo.qbo_archive_max_rows','100',false)");
   try{return await rpc('archive_qbo_ledger',[sG,sT]);}finally{await q("select set_config('silo.qbo_archive_max_rows','',false)");}});
  if(mutation==='no-size-guard'){await capped();assert.fail('The size guard was removed, yet an oversized report was still refused');}
  // The guard counts every Data row, beginning balances included: each one
  // becomes a stored line, so each one is work the final copy has to do.
  await assert.rejects(capped(),new RegExp(`has ${small.expected.lineRows} ledger rows, more than the 100 this archive processes in one window`),'An oversized report is refused, naming the count');
  assert.deepEqual(await counts(),before,'A refused report writes no evidence');
  assert.equal(Number((await one('select count(*) n from qbo_history_jobs where gl_run_id=$1',[sG])).n),0,'...and creates no job: the refusal comes before any work, so there is nothing to resume');
  // BEFORE the snapshot is assembled and hashed, not merely before the rows
  // are staged. Hashing runs sha256 over the whole document and is the largest
  // part of the unbounded setup the ceiling exists to bound, so a guard
  // standing after it would let an oversized report be copied and hashed in
  // full and only then refused -- and the refusal would look identical from
  // outside. The hash helper is therefore replaced with one that always
  // raises: reaching it becomes a different error, which no rollback can
  // hide. (A counter table cannot be used here: the refusal rolls the call
  // back and takes the count with it.)
  const SENTINEL="create or replace function public.finance_approval_snapshot_hash(p_snapshot jsonb) returns text language plpgsql volatile as $$ begin raise exception 'SENTINEL the snapshot hash was invoked'; end $$";
  const REAL="create or replace function public.finance_approval_snapshot_hash(p_snapshot jsonb) returns text language sql immutable security invoker set search_path to 'extensions','pg_temp' as $$ select encode(extensions.digest(convert_to(p_snapshot::text,'UTF8'),'sha256'),'hex') $$";
  try{
   await db.exec(SENTINEL);
   await assert.rejects(capped(),/ledger rows, more than the 100/,'An oversized report is refused before its snapshot is hashed');
   // The control: a report the ceiling ADMITS does reach the hash, so the
   // sentinel is genuinely wired in and the assertion above means something.
   await assert.rejects(archive(sG,sT),/SENTINEL the snapshot hash was invoked/,'A report under the ceiling is hashed, so the sentinel measures what it claims');
  } finally { await db.exec(REAL); }
  // The BYTE ceiling, which the row ceiling does not cover: a ledger with long
  // memos reaches 8 MB while still short, and hashing is worse than linear in
  // the document's size (measured on PostgreSQL 16: 7.7 MB 1.21s, 15.5 MB
  // 7.10s, 23 MB 9.27s, 31 MB 21.1s), so the byte limit is what keeps the
  // hash inside the 8s statement timeout. It is lowered here rather than
  // building an 8 MB fixture; what is being proved is that the check runs,
  // refuses, and refuses BEFORE the hash.
  const byteCapped=()=>as(finance,async()=>{await q("select set_config('silo.qbo_archive_max_bytes','1024',false)");
   try{return await rpc('archive_qbo_ledger',[sG,sT]);}finally{await q("select set_config('silo.qbo_archive_max_bytes','',false)");}});
  {const before=await counts();
   if(mutation==='no-byte-guard'){await byteCapped();assert.fail('The byte ceiling was removed, yet an oversized document was still refused');}
   await assert.rejects(byteCapped(),/larger than the 0 MB this archive processes in one window/,'An oversized document is refused on bytes, naming its size');
   assert.deepEqual(await counts(),before,'A byte-refused report writes no evidence');
   assert.equal(Number((await one('select count(*) n from qbo_history_jobs where gl_run_id=$1',[sG])).n),0,'...and creates no job');
   try{ await db.exec(SENTINEL); await assert.rejects(byteCapped(),/larger than the 0 MB/,'The byte check runs before the snapshot is hashed'); }
   finally { await db.exec(REAL); }}
  // The same ordering, stated the way verify_v2_schema.sql states it. The
  // committed check compares these two positions in pg_get_functiondef, and it
  // has to match the CALL SITE: the helper's bare name also appears in the
  // comment above the guard, and a check matching that reports CRITICAL on
  // correct code.
  {const body=(await one("select pg_get_functiondef('public.archive_qbo_ledger(uuid,uuid)'::regprocedure) d")).d;
   assert.ok(body.indexOf('digest:=public.finance_approval_snapshot_hash')>0,'the hash call site verify_v2_schema.sql matches must exist verbatim');
   assert.ok(body.indexOf('pg_column_size(gl.raw_response)')<body.indexOf('digest:=public.finance_approval_snapshot_hash'),
    'the size guard must precede the hash call in the stored body, which is what the committed verify check asserts');}
  const ok=await archive(sG,sT);assert.equal(ok.status,'complete');assert.equal(ok.transaction_count,small.expected.dataRows,'Under the shipped ceiling the same report archives whole');
  // Re-archiving the same two stored report runs is answered from their ids,
  // so it neither re-hashes the document nor trips the lowered ceiling: a
  // period that is completely archived must not be refused as too large.
  try{
   await db.exec(SENTINEL);
   const repeat=await capped();
   assert.equal(repeat.already_imported,true,'The same stored reports are recognised as already archived');
   assert.equal(repeat.id,ok.id,'...and answer with the existing import');
  } finally { await db.exec(REAL); }}
 // A failure during FINALIZATION (a constraint, trigger or storage error after
 // every section is checked) must terminate the job with its reason. Without
 // its own exception block the job stays 'running' at 100% and every resume
 // repeats the same terminal failure with nothing recording why.
 // A small batch on purpose: the job must be committed by an earlier call for
 // the stranding this guards against to be possible at all. (When an archive
 // fits in ONE call there is nothing to strand -- that call's rollback takes
 // the job row with it, which the unguarded mutation also demonstrates.)
 batchRows=300;
 {const broken=generateLedgerPair({rows:900,seed:900});
  await q("insert into accounting_accounts(company_entity_id,qbo_connection_id,qbo_account_id,name,account_type,is_active,source_snapshot) select $1,$2,x.qbo_account_id,x.name,x.account_type,true,'{}' from jsonb_to_recordset($3::jsonb) as x(qbo_account_id text,name text,account_type text) on conflict do nothing",[co,conn,JSON.stringify(broken.accounts)]);
  const fG=await store(broken.gl,co,conn,{},...scaleWindow),fT=await store(broken.tb,co,conn,{},...scaleWindow);
  await db.exec("create or replace function public.test_block_line_copy() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure during the final copy'; end $$");
  await db.exec('create trigger test_block_line_copy before insert on public.qbo_history_lines for each row execute function public.test_block_line_copy()');
  const before=await counts();let outcome;
  try{ outcome=await archive(fG,fT).then((r)=>({ok:r}),(e)=>({err:e})); }
  finally{ await db.exec('drop trigger test_block_line_copy on public.qbo_history_lines'); }
  const job=await one('select * from qbo_history_jobs where gl_run_id=$1 order by created_at desc limit 1',[fG]);
  if(mutation==='finalize-unguarded'){
   assert.equal(job.status,'running','the mutation should strand the job');
   assert.fail('Finalization ran outside its own exception block: the job was left running with no recorded error');
  }
  assert.ok(outcome.err,'The call reports the failure rather than a saved archive');
  assert.match(outcome.err.message,/synthetic storage failure during the final copy/);
  assert.equal(job.status,'failed','A finalization error terminates the job rather than leaving it running');
  assert.match(job.error,/synthetic storage failure/,'...and records why, so a resume is never offered blind');
  assert.equal(job.source_snapshot,null);
  assert.deepEqual(await staged(job.id),{sections:0,lines:0},'A failed finalization leaves no staging behind');
  assert.deepEqual(await counts(),before,'...and no evidence row and no audit event');
  assert.equal(Number((await one("select count(*) n from qbo_history_jobs where status='running'")).n),0,'No job is left for the page to offer as resumable');
  const retried=await archive(fG,fT);assert.equal(retried.status,'complete');assert.notEqual(retried.job_id,job.id,'A retry once the cause is gone is a fresh job');
  assert.equal(retried.transaction_count,broken.expected.dataRows,'Every row is still archived on the retry');}
 batchRows=null;
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
 console.log('PASS QBO history: bounded resumable archive at scale, size guard on the unbounded phases, terminal finalization failure, progress and completeness, mid-job failure rollback, retries and duplicate prevention, leading-decimal amounts, evidence-settled blank amounts, cell-level format errors, atomic rejection, nested rows, exact reconciliation, exceptions, identity, immutable retention, company/permission isolation, no posting');
}finally{await db.close();}
