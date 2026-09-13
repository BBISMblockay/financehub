import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const root=new URL('../../v2/',import.meta.url);
const inline=async page=>{
 const html=await readFile(new URL(page+'.html',root),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 return script.slice(0,script.indexOf('  (async function boot()'));
};
const reports=await inline('qbo-reports'),forecast=await inline('cash-forecast'),schedules=await inline('schedules');
function harness(code,expose,{data={},errors={}}={}){
 const elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,querySelectorAll:()=>[],addEventListener(){}});return elements.get(id);};
 const db={from(table){const q={};for(const method of ['select','eq','gte','lte','order','limit','range','in','maybeSingle'])q[method]=()=>q;
  q.then=(resolve,reject)=>Promise.resolve({data:data[table]||[],error:errors[table]||null}).then(resolve,reject);return q;}};
 const window={__SILO_CONFIG__:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'synthetic'},supabase:{createClient:()=>db}};
 vm.runInNewContext(code+'\nwindow.subject={'+expose+'};\n})();',{window,document:{getElementById:el,querySelectorAll:()=>[]},console,setTimeout(){}});
 return {api:window.subject,el,data,errors};
}
const reportHarness=()=>harness(reports,'render, renderDrillTransactions, numericColumns, reportNumber');
const forecastHarness=options=>harness(forecast,`buildForecast,renderCashLow,renderForecast,
 setCash(amount){liquidity={asOf:new Date(),bankAccounts:[{balance:amount}],facilities:[]};},
 setState(value){forecastState=value;},
 deferItems(promise){loadPlanningItems=()=>promise;}`,options);
const cols=[['Date','Date','date'],['Transaction Type','String','txn_type'],['Num','String','doc_num'],['Name','String','name'],['Amount','Money','amount'],['Balance','Money','balance']].map(([ColTitle,ColType,key])=>({ColTitle,ColType,MetaData:[{Name:'ColKey',Value:key}]}));
const report={Columns:{Column:cols},Rows:{Row:[{ColData:['2026-09-12','Journal Entry','001203','Vendor 123','-48624.99','1000.50'].map(value=>({value}))}]}};
test('GL and drilldown retain text and leading-zero document numbers while formatting monetary columns',()=>{
 const h=reportHarness();h.api.render(report);h.api.renderDrillTransactions(report);
 assert.match(h.el('drillBody').innerHTML,/Journal Entry/);assert.match(h.el('drillBody').innerHTML,/001203/);assert.match(h.el('drillBody').innerHTML,/\(48,624\.99\)/);
 for(const expected of ['Journal Entry','001203','Vendor 123','(48,624.99)','1,000.50'])assert.ok(h.el('tbl').innerHTML.includes(expected),expected);
 assert.ok(!h.el('tbl').innerHTML.includes('1,203.00'));
 // Drill view uses the same semantic column classifier and strict parser.
 const flags=Array.from(h.api.numericColumns([{cells:report.Rows.Row[0].ColData}],cols));
 assert.deepEqual(flags,[false,false,false,false,true,true]);
 for(const value of ['Check','Journal Entry','Vendor 123','2026-09-12','-','',null])assert.equal(h.api.reportNumber(value),null);
});
test('monthly financial statements retain numeric totals and empty cells',()=>{
 const h=reportHarness();h.api.render({Columns:{Column:[{ColTitle:'Account',ColType:'Account'},{ColTitle:'Jan 2026',ColType:'Money'},{ColTitle:'Feb 2026',ColType:'Money'}]},Rows:{Row:[{ColData:[{value:'Cash'},{value:'0'},{value:''}]}]}});
 assert.match(h.el('tbl').innerHTML,/0\.00/);assert.match(h.el('tbl').innerHTML,/<td class="qr-num"><\/td>/);
});
test('cash summary matches rebuilt negative and positive forecast rows',async()=>{
 const h=forecastHarness({data:{payment_requests:[{amount_due:5,due_date:'2020-01-01',completed:false}]}});
 h.api.setCash(-48619.99);await h.api.buildForecast();
 assert.equal(h.el('lowValue').textContent,'-$48,624.99');assert.match(h.el('cashLow').className,/warn/);
 assert.match(h.el('tblForecast').innerHTML,/-\$48,624\.99/);assert.match(h.el('lowNote').textContent,/below zero/);
 h.api.setCash(100);await h.api.buildForecast();assert.equal(h.el('lowValue').textContent,'$95.00');assert.match(h.el('cashLow').className,/ok/);
});
test('pending and failed forecasts never show zero as an all-clear',async()=>{
 const h=forecastHarness();h.api.setCash(100);await h.api.buildForecast();
 let finish;const gate=new Promise(resolve=>finish=resolve);h.api.deferItems(gate);
 const loading=h.api.buildForecast();assert.equal(h.el('lowValue').textContent,'—');assert.equal(h.el('cashLow').className,'cf-low');
 finish(Array(13).fill(-10));await loading;assert.equal(h.el('lowValue').textContent,'-$30.00');
 for(const table of ['payment_requests','revenue_projections','shopify_payouts','cash_forecast_items']){
  const failed=forecastHarness({errors:{[table]:{message:'Fixture unavailable'}}});failed.api.setCash(100);await failed.api.buildForecast();
  assert.equal(failed.el('lowValue').textContent,'—');assert.equal(failed.el('cashLow').className,'cf-low');assert.match(failed.el('lowNote').textContent,/unavailable/);
 }
});
test('older forecast completion cannot replace newer inputs',async()=>{
 const h=forecastHarness();h.api.setCash(100);let finish;
 h.api.deferItems(new Promise(resolve=>finish=resolve));const old=h.api.buildForecast();
 h.api.deferItems(Promise.resolve(Array(13).fill(0)));h.api.setCash(-50);await h.api.buildForecast();
 finish(Array(13).fill(100));await old;assert.equal(h.el('lowValue').textContent,'-$50.00');
});
test('starting cash is included in the low and zero is not described as positive',()=>{
 const h=forecastHarness();h.api.setCash(-20);
 h.api.setState({rows:[{startBal:-20,endBal:100,week:{startStr:'2026-09-12'}}]});h.api.renderCashLow();assert.equal(h.el('lowValue').textContent,'-$20.00');assert.equal(h.el('lowWeek').textContent,'Today');
 h.api.setState({rows:[{startBal:0,endBal:100,week:{startStr:'2026-09-12'}}]});h.api.renderCashLow();assert.match(h.el('lowNote').textContent,/reaches zero/);assert.equal(h.el('cashLow').className,'cf-low');
});
test('a fetched empty schedule explains the result without asking for the fetch again',()=>{
 const h=harness(schedules,'renderTie,renderTxns,setLoaded(value){ledgerLoaded=value;}');h.api.setLoaded(true);h.api.renderTie([]);h.api.renderTxns();
 assert.match(h.el('tieNote').textContent,/returned no ledger balance/);assert.match(h.el('tblTxns').innerHTML,/No transactions returned/);
 h.api.setLoaded(false);h.api.renderTie([]);assert.match(h.el('tieNote').textContent,/Fetch transactions/);
});

test('each suite page pins its shared design assets to the shipped content',async()=>{
 const {createHash}=await import('node:crypto');
 for(const page of ['transactions','accounting-books','qbo-reports','cash-forecast','schedules','fixed-assets','accounting-export']){
  const html=await readFile(new URL(page+'.html',root),'utf8');
  assert.match(html,/silo-main accounting-workspace/);
  const assets=['accounting-suite.css',...(page==='accounting-books'?['accounting-books.css','accounting-books.js','qbo-history.js']:[])];
  for(const asset of assets){
   const hash=createHash('sha256').update(await readFile(new URL(asset,root))).digest('hex').slice(0,12);
   assert.ok(html.includes(`${asset}?v=${hash}`),`${page} must load current ${asset}`);
  }
 }
});
