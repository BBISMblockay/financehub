import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const code=await readFile(new URL('../../v2/accounting-books.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));};
class Element{
 constructor(){this.value='';this.events={};this.hidden=false;this.dataset={};}
 set innerHTML(s){this.html=s;if(s.includes('<option'))this.value=s.match(/value="([^"]*)"/)?.[1]||'';}
 get innerHTML(){return this.html;}
 addEventListener(name,fn){this.events[name]=fn;}
 insertAdjacentHTML(_,s){this.html=(this.html||'')+s;}
 setAttribute(){}
}
test('actual onboarding UI fetches an explicitly scoped report, reviews stored balances and never invokes QBO posting',async()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const calls=[];let baseline=null,answer=null;
 const snapshot={as_of:'2026-08-31',accounting_start_date:'2026-09-01',currency:'USD',basis:'Accrual',fetched_at:'2026-09-12',debits:35,credits:35,lines:[{name:'Bank',debit:35,credit:0},{name:'Equity',debit:0,credit:35}]};
 const db={auth:{getSession:async()=>({data:{session:{user:{email:'synthetic@example.test'}}}})},
  from(table){const chain={select(){return this},eq(){return this},order(){return this},range(){return this},limit(){return this},maybeSingle(){return this},then(resolve){return Promise.resolve({data:table==='accounting_opening_balances'?baseline:table==='accounting_settings'?null:table==='accounting_journal_register'?[{id:'savings-aug',kind:'card_batch',entry_date:'2026-08-31',memo:'Savings',status:'draft'},{id:'adj-draft',kind:'journal_adjustment',entry_date:'2026-08-31',memo:'Accrual',status:'draft'},{id:'adj-approved',kind:'journal_adjustment',entry_date:'2026-08-30',memo:'Approved accrual',status:'approved'},{id:'adj-posted',kind:'journal_adjustment',entry_date:'2026-08-30',memo:'Depreciation',status:'posted',posting_status:'posted'},{id:'card-posted',kind:'card_batch',entry_date:'2026-08-29',memo:'Amex',status:'posted',posting_status:'posted'}]:[]}).then(resolve);}};return chain;},
  rpc:async(name,args)=>{calls.push({name,args});if(name==='silo_business_today')return {data:'2026-09-12'};if(name==='can_manage_journal_entries')return {data:true};if(name==='is_exec_or_owner')return {data:false};if(name==='accounting_qbo_connections')return {data:[{id:'connection-a',company_name:'Synthetic QBO',environment:'sandbox'}]};if(name==='seed_accounting_from_qbo'){baseline={id:'opening-a',status:'draft',snapshot_hash:'reviewed-hash',snapshot};return {data:{id:baseline.id}};}if(name==='accept_accounting_opening_balances'){baseline={...baseline,status:'accepted'};return {data:{accepted:true}};}throw new Error(name);},
  functions:{invoke:async(name,args)=>{calls.push({name,args});assert.equal(name,'quickbooks-report');return {data:{run_id:'trusted-report'}};}}};
 const window={__SILO_CONFIG__:{SUPABASE_URL:'https://synthetic.test',SUPABASE_ANON_KEY:'test',ensureActiveCompany:async()=>({id:'company-a'})},supabase:{createClient:()=>db},SiloChrome:{mount(){}},SiloFinanceDialog:{ask:async()=>answer},SiloJE:{open(){}}};
 class AfterPacificEvening extends Date { constructor(...args){super(...(args.length?args:['2026-09-13T02:00:00Z']));} }
 vm.runInNewContext(code,{Date:AfterPacificEvening,window,document:{getElementById:el,querySelectorAll:()=>[]},location:{pathname:'/v2/accounting-books.html'},console});await settle();
 assert.equal(el('cutoff').value,'2026-09-11','Yesterday comes from the Pacific business date');
 assert.ok(el('seedForm').events.submit,'Auth and company loading reaches the real form wiring');
 el('cutoff').value='2026-08-31';el('basis').value='Accrual';el('fiscal').value='1';
 el('seedForm').events.submit({preventDefault(){}});await settle();
 const fetch=calls.find(c=>c.name==='quickbooks-report');assert.equal(fetch.args.body.connection_id,'connection-a');assert.equal(fetch.args.body.params.end_date,'2026-08-31');
 assert.equal(calls.find(c=>c.name==='seed_accounting_from_qbo').args.p_report_id,'trusted-report');assert.match(el('opening').innerHTML,/Checking|Bank/);
 el('accept').events.click();await settle();assert.ok(!calls.some(c=>c.name==='accept_accounting_opening_balances'),'Cancel never accepts');
 answer='Reviewed against QuickBooks';el('accept').events.click();await settle();
 const accepted=calls.find(c=>c.name==='accept_accounting_opening_balances');assert.equal(accepted.args.p_expected_hash,'reviewed-hash');assert.equal(el('accept').disabled,true);assert.equal(el('seedForm').inert,true);
 assert.equal(el('setupInputs').open,false);assert.equal(el('booksBadge').textContent,'Opening balances accepted');assert.equal(el('accept').hidden,true);
 assert.match(el('registerTable').innerHTML,/transactions.html\?batch=savings-aug&amp;company=company-a/);
 // Discard/Void moved here from Reports: Discard only on a draft adjustment,
 // Void only on a posted entry, each through its own source's RPC.
 const reg=el('registerTable').innerHTML;
 assert.match(reg,/data-discard="adj-draft"/);assert.ok(!/data-discard="(adj-approved|adj-posted|savings-aug|card-posted)"/.test(reg),'Only a draft adjustment is discardable');
 assert.match(reg,/data-void="adj-posted" data-void-kind="journal_adjustment"/);assert.match(reg,/data-void="card-posted" data-void-kind="card_batch"/);
 assert.ok(!/data-void="(adj-draft|adj-approved|savings-aug)"/.test(reg),'Only a posted entry is voidable');
 const click=(attr,dataset)=>el('registerTable').events.click({target:{closest:sel=>sel===attr?{dataset}:null}});
 answer='Deleted in QuickBooks on 9/12';click('[data-void]',{void:'card-posted',voidKind:'card_batch'});await settle();
 assert.deepEqual({...calls.find(c=>c.name==='void_card_posting')?.args},{p_batch_id:'card-posted',p_reason:'Deleted in QuickBooks on 9/12'});
 click('[data-void]',{void:'adj-posted',voidKind:'journal_adjustment'});await settle();
 assert.deepEqual({...calls.find(c=>c.name==='void_journal_adjustment')?.args},{p_adjustment_id:'adj-posted',p_reason:'Deleted in QuickBooks on 9/12'});
 answer=null;const before=calls.length;click('[data-void]',{void:'adj-posted',voidKind:'journal_adjustment'});await settle();
 assert.equal(calls.length,before,'Cancelling the void dialog calls nothing');
 assert.ok(!calls.some(c=>c.name==='quickbooks-post-journal'));
});
