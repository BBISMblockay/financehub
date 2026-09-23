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
const reports=await inline('qbo-reports'),schedules=await inline('schedules');
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
test('a fetched empty schedule explains the result without asking for the fetch again',()=>{
 const h=harness(schedules,'renderTie,renderTxns,setLoaded(value){ledgerLoaded=value;}');h.api.setLoaded(true);h.api.renderTie([]);h.api.renderTxns();
 assert.match(h.el('tieNote').textContent,/returned no ledger balance/);assert.match(h.el('tblTxns').innerHTML,/No transactions returned/);
 h.api.setLoaded(false);h.api.renderTie([]);assert.match(h.el('tieNote').textContent,/Fetch transactions/);
});

test('each suite page pins its shared design assets to the shipped content',async()=>{
 const {createHash}=await import('node:crypto');
 for(const page of ['transactions','accounting-books','qbo-reports','cash-forecast','schedules','fixed-assets','accounting-export','customers']){
  const html=await readFile(new URL(page+'.html',root),'utf8');
  assert.match(html,/silo-main accounting-workspace/);
  const assets=['accounting-suite.css',...(page==='cash-forecast'?['cashflow-model.js','cashflow.js','cashflow.css','cashflow-charts.js']:[]),...(page==='transactions'?['plaid-bank-feed.js']:[]),...(page==='accounting-books'?['accounting-books.css','accounting-books.js','qbo-history.js','migration-status.js']:[]),...(page==='customers'?['customers.css']:[])];
  for(const asset of assets){
   const hash=createHash('sha256').update(await readFile(new URL(asset,root))).digest('hex').slice(0,12);
   assert.ok(html.includes(`${asset}?v=${hash}`),`${page} must load current ${asset}`);
  }
 }
});

test('schedules separate what is due by date from what was actually posted',()=>{
 const h=harness(schedules,'renderCatchup,setPosted(value){postedRecognized=value;}');
 const items=[{recognized_to_date:300,remaining_balance:900,schedule_type:'prepaid'}];
 // Unread posting state is unknown, never zero.
 h.api.setPosted(null);h.api.renderCatchup(items);
 assert.equal(h.el('cuRecognized').textContent,'$300.00');assert.equal(h.el('cuPosted').textContent,'—');
 assert.match(h.el('cuNote').textContent,/could not be read/);
 h.api.setPosted(100);h.api.renderCatchup(items);
 assert.equal(h.el('cuPosted').textContent,'$100.00');assert.equal(h.el('cuBehind').textContent,'$200.00');
 assert.match(h.el('cuNote').textContent,/\$200\.00 is due but not posted/);assert.match(h.el('catchup').className,/sc-tie--off/);
 h.api.setPosted(300);h.api.renderCatchup(items);
 assert.match(h.el('cuNote').textContent,/Everything prepaid that is due to date has been posted/);assert.match(h.el('catchup').className,/sc-tie--ok/);
 h.api.setPosted(400);h.api.renderCatchup(items);assert.match(h.el('cuNote').textContent,/more has been posted than is due/);
});

test('only prepaid items drive due / posted / not posted; other schedule types are named, never a false gap',()=>{
 const h=harness(schedules,'renderCatchup,setPosted(value){postedRecognized=value;}');
 // Review finding on #758: $1,200 prepaid with $300 due, $600 deferred revenue
 // with $150 due, prepaid amortization posted. There is no missing prepaid
 // month, and the $150 cannot be posted from this page.
 const mixed=[{recognized_to_date:300,remaining_balance:900,schedule_type:'prepaid'},{recognized_to_date:150,remaining_balance:450,schedule_type:'deferred_revenue'}];
 h.api.setPosted(300);h.api.renderCatchup(mixed);
 assert.equal(h.el('cuRecognized').textContent,'$300.00');assert.equal(h.el('cuBehind').textContent,'$0.00');
 assert.equal(h.el('cuRemaining').textContent,'$900.00','balance once posted is on the same prepaid scope');
 assert.match(h.el('catchup').className,/sc-tie--ok/);
 assert.match(h.el('cuNote').textContent,/Everything prepaid that is due to date has been posted/);
 assert.match(h.el('cuNote').textContent,/1 other item \(deferred_revenue\) has \$150\.00 due by date, which does not post from this page/);
 assert.ok(!/is due but not posted/.test(h.el('cuNote').textContent));
 // A deferred-only account is never described as prepaid QuickBooks still holds.
 h.api.setPosted(0);h.api.renderCatchup([mixed[1]]);
 assert.match(h.el('cuNote').textContent,/No prepaid items are stamped/);assert.ok(!/still holds it as prepaid/.test(h.el('cuNote').textContent));
 assert.match(h.el('catchup').className,/sc-tie--ok/);
});

test('reports choose a statement by tile, and the adjustment list lives in Journals',async()=>{
 const html=await readFile(new URL('qbo-reports.html',root),'utf8');
 for(const r of ['ProfitAndLoss','BalanceSheet','TrialBalance','GeneralLedger','CashFlow','ProfitAndLossDetail','TransactionList'])
  assert.match(html,new RegExp(`class="qr-tile" data-report="${r}"`),r);
 assert.ok(!/<select[^>]*id="report"/.test(html),'the report dropdown is gone');
 assert.ok(!/id="adjCard"|id="btnAdjust"|loadAdjustments/.test(html),'the staged/posted list moved to Books');
 assert.match(html,/href="accounting-books.html#register"/);
 assert.match(html,/id="drillPostAdjustment"/,'an adjustment can still start from the account being looked at');
});
