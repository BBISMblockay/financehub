import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const code=await readFile(new URL('../../v2/qbo-history.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
class Element{
 constructor(){this.value='';this.events={};}
 set innerHTML(s){this.html=s;if(s.includes('<option'))this.value=s.match(/value="([^"]*)"/)?.[1]||'';}
 get innerHTML(){return this.html||'';}
 addEventListener(n,f){this.events[n]=f;}
 insertAdjacentHTML(_,s){this.html=(this.html||'')+s;}
}
function harness({disconnected=false,failTb=false,failArchive=false,preloaded=false,failedJob=false,unfinished=null,steps=1}={}){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};const calls=[];let archives=[];
 const settings={qbo_connection_id:'connection-test',accounting_start_date:'2026-09-01',accounting_basis:'Accrual',base_currency:'USD',fiscal_year_start_month:1};
 const snapshot={id:'archive-1',period_start:'2026-08-01',period_end:'2026-08-31',currency:'USD',accounting_basis:'Accrual',created_at:'2026-09-13',exception_count:0,transaction_count:1,reconciliation:[{qbo_account_id:'bank',account_name:'Checking',ledger_debit_net:10,trial_balance_debit_net:10,difference:0,issues:[]}]};
 if(preloaded)archives=[snapshot];
 const db={from(table){const filters={};const chain={select(cols){calls.push({table,cols});return this;},eq(k,v){filters[k]=v;return this;},order(){return this;},range(){return this;},maybeSingle(){return this;},then(resolve){assert.equal(filters.company_entity_id,'test-company');if(table==='qbo_history_lines')assert.equal(filters.import_id,'archive-1');return Promise.resolve({data:table==='accounting_settings'?settings:table==='qbo_history_imports'?archives:table==='qbo_history_jobs'?(unfinished?[unfinished]:[]):table==='qbo_history_lines'?[{row_no:1,account_name:'Checking',transaction_date:'2026-08-05',qbo_transaction_id:'txn-1',memo:'<script>bad</script>',natural_amount:10,natural_balance:10}]:[]}).then(resolve);}};return chain;},
 functions:{invoke:async(name,{body})=>{calls.push({name,body});assert.equal(name,'quickbooks-report');if(disconnected)return {error:{message:'QBO connection inactive'}};if(failTb&&body.report_name==='TrialBalance')return {error:{message:'Report timeout'}};return {data:{run_id:body.report_name+'-run'}};}},
 rpc:async(name,args)=>{calls.push({name,args});assert.equal(name,'archive_qbo_ledger');if(failArchive)return {error:{message:'Archive unavailable'}};const n=calls.filter(c=>c.name==='archive_qbo_ledger').length;if(failedJob&&n===2)return {data:{status:'failed',job_id:'job-1',error:'Blank ledger amount with a changed running balance at row 3 of account bank is ambiguous; no archive was written'}};if(n<steps)return {data:{status:'in_progress',job_id:'job-1',rows_done:n*1000,rows_total:steps*1000,sections_done:n,sections_total:steps}};archives=[snapshot];return {data:{id:'archive-1',status:'complete'}};}};
 const window={};vm.runInNewContext(code,{window,document:{getElementById:el},console});
 const statuses=[];const st=el('historyStatus');Object.defineProperty(st,'textContent',{set(v){statuses.push(v);this._t=v;},get(){return this._t||'';}});
 return {el,calls,statuses,boot:()=>window.SiloQboHistory.mount({db,companyId:'test-company'}),submit:async()=>{el('historyForm').events.submit({preventDefault(){}});await settle();},resume:async()=>{el('historyResume').events.click();await settle();}};
}
test('actual history handler reads scoped GL then TB, archives stored IDs and displays escaped retained details',async()=>{
 const h=harness();await h.boot();assert.match(h.el('historyStatus').textContent,/Choose dates before/);assert.equal(h.el('historyFrom').value,'2026-08-01');assert.equal(h.el('historyTo').value,'2026-08-31');await h.submit();
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');assert.equal(fetch.length,2);assert.equal(fetch[0].body.report_name,'GeneralLedger');assert.equal(fetch[1].body.report_name,'TrialBalance');
 for(const f of fetch){assert.equal(f.body.connection_id,'connection-test');assert.equal(f.body.params.end_date,'2026-08-31');assert.equal(f.body.params.accounting_method,'Accrual');}assert.equal(fetch[1].body.params.start_date,'2026-01-01');
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x=>x.name==='archive_qbo_ledger').args)),{p_gl_run_id:'GeneralLedger-run',p_tb_run_id:'TrialBalance-run'});
 assert.match(h.el('historyRows').innerHTML,/&lt;script&gt;bad/);assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.equal(h.el('historyDetail').hidden,false);
 assert.ok(!h.calls.some(x=>x.name==='quickbooks-post-journal'));assert.ok(!h.calls.some(x=>x.cols?.includes('source_snapshot')));
});
test('invalid or overlapping cutover window makes no QBO calls',async()=>{
 const h=harness();await h.boot();for(const [start,end] of [['2026-08-01','2026-09-01'],['2025-01-01','2026-08-31'],['2026-02-30','2026-08-31'],['2026-08-31','2026-08-01']]){h.el('historyFrom').value=start;h.el('historyTo').value=end;await h.submit();assert.match(h.el('historyStatus').textContent,/366 days/);}assert.ok(!h.calls.some(x=>x.name));
});
test('saved history loads without any QBO connection request; disconnected fetch leaves it usable',async()=>{
 const h=harness({disconnected:true,preloaded:true});await h.boot();assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.ok(!h.calls.some(x=>x.name));await h.submit();assert.match(h.el('historyStatus').textContent,/inactive/);assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.ok(!h.calls.some(x=>x.name==='archive_qbo_ledger'));
});
test('partial report or local archive failure never claims success and leaves a retry action',async()=>{
 for(const options of [{failTb:true},{failArchive:true}]){const h=harness(options);await h.boot();await h.submit();assert.match(h.el('historyStatus').textContent,/retry/);assert.equal(h.el('historyInputs').disabled,false);assert.equal(h.el('historyDetail').hidden,true);if(options.failTb)assert.ok(!h.calls.some(x=>x.name==='archive_qbo_ledger'));}
});
test('the archive is driven to completion across bounded calls with progress, and a failed job names the row without claiming success',async()=>{
 const h=harness({steps:3});await h.boot();await h.submit();
 assert.equal(h.calls.filter(x=>x.name==='archive_qbo_ledger').length,3,'The same RPC is called until it reports complete');
 assert.ok(h.statuses.some(s=>/1,000 of 3,000/.test(s)&&/Nothing is saved until every row is checked/.test(s)),'Progress is shown between calls');
 assert.equal(h.el('historyDetail').hidden,false);assert.match(h.el('historyRows').innerHTML,/txn-1/);
 const f=harness({failedJob:true,steps:3});await f.boot();await f.submit();
 assert.equal(f.calls.filter(x=>x.name==='archive_qbo_ledger').length,2,'A failed status stops the loop');
 assert.match(f.el('historyStatus').textContent,/row 3 of account bank/);assert.match(f.el('historyStatus').textContent,/retry/);assert.equal(f.el('historyDetail').hidden,true);assert.equal(f.el('historyInputs').disabled,false);
});
test('an unfinished job is offered for resume and resumes with its stored reports, without a new QBO fetch',async()=>{
 const h=harness({unfinished:{id:'job-1',gl_run_id:'gl-stored',tb_run_id:'tb-stored',rows_done:12000,rows_total:36818,status:'running'},steps:2});await h.boot();
 assert.equal(h.el('historyResume').hidden,false);assert.match(h.el('historyResume').textContent,/12,000 of 36,818/);
 await h.resume();
 assert.ok(!h.calls.some(x=>x.name==='quickbooks-report'),'Resuming never re-fetches from QBO');
 const rpcs=h.calls.filter(x=>x.name==='archive_qbo_ledger');assert.equal(rpcs.length,2);assert.deepEqual(JSON.parse(JSON.stringify(rpcs[0].args)),{p_gl_run_id:'gl-stored',p_tb_run_id:'tb-stored'});
 const n=harness();await n.boot();assert.equal(n.el('historyResume').hidden,true,'No unfinished job, no resume control');
});
