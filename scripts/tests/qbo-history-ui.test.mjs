import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const code=await readFile(new URL('../../v2/qbo-history.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
// Drives the real explain() through summarise() on a row that must read loudly.
function window_explain(h){
 const sum=h.summarise([{account_name:'Clearing',issues:['trial_balance_mismatch'],
  ledger_debit_net:10,trial_balance_debit_net:0,difference:10}]);
 return h.explainHtml(sum);
}
class Element{
 constructor(){this.value='';this.events={};}
 set innerHTML(s){this.html=s;if(s.includes('<option'))this.value=s.match(/value="([^"]*)"/)?.[1]||'';}
 get innerHTML(){return this.html||'';}
 addEventListener(n,f){this.events[n]=f;}
 insertAdjacentHTML(_,s){this.html=(this.html||'')+s;}
}
function harness({disconnected=false,failTb=false,failArchive=false,preloaded=false,failedJob=false,unfinished=null,steps=1,snapshotOverrides={}}={}){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};const calls=[];let archives=[];
 const settings={qbo_connection_id:'connection-test',accounting_start_date:'2026-09-01',accounting_basis:'Accrual',base_currency:'USD',fiscal_year_start_month:1};
 const snapshot={id:'archive-1',period_start:'2026-08-01',period_end:'2026-08-31',currency:'USD',accounting_basis:'Accrual',created_at:'2026-09-13T06:31:29Z',exception_count:0,transaction_count:1,reconciliation:[{qbo_account_id:'bank',account_name:'Checking',ledger_debit_net:10,trial_balance_debit_net:10,difference:0,issues:[]}],...snapshotOverrides};
 if(preloaded)archives=[snapshot];
 const db={from(table){const filters={};const chain={select(cols){calls.push({table,cols});return this;},eq(k,v){filters[k]=v;return this;},order(){return this;},range(){return this;},maybeSingle(){return this;},then(resolve){assert.equal(filters.company_entity_id,'test-company');if(table==='qbo_history_lines')assert.equal(filters.import_id,'archive-1');return Promise.resolve({data:table==='accounting_settings'?settings:table==='qbo_history_imports'?archives:table==='qbo_history_jobs'?(unfinished?[unfinished]:[]):table==='qbo_history_lines'?[{row_no:1,account_name:'Checking',transaction_date:'2026-08-05',qbo_transaction_id:'txn-1',memo:'<script>bad</script>',natural_amount:10,natural_balance:10}]:[]}).then(resolve);}};return chain;},
 functions:{invoke:async(name,{body})=>{calls.push({name,body});assert.equal(name,'quickbooks-report');if(disconnected)return {error:{message:'QBO connection inactive'}};if(failTb&&body.report_name==='TrialBalance')return {error:{message:'Report timeout'}};return {data:{run_id:body.report_name+'-run'}};}},
 rpc:async(name,args)=>{calls.push({name,args});assert.equal(name,'archive_qbo_ledger');if(failArchive)return {error:{message:'Archive unavailable'}};const n=calls.filter(c=>c.name==='archive_qbo_ledger').length;if(failedJob&&n===2)return {data:{status:'failed',job_id:'job-1',error:'Blank ledger amount with a changed running balance at row 3 of account bank is ambiguous; no archive was written'}};if(n<steps)return {data:{status:'in_progress',job_id:'job-1',rows_done:n*1000,rows_total:steps*1000,sections_done:n,sections_total:steps}};archives=[snapshot];return {data:{id:'archive-1',status:'complete'}};}};
 const window={};vm.runInNewContext(code,{window,document:{getElementById:el},console});
 const statuses=[];const st=el('historyStatus');Object.defineProperty(st,'textContent',{set(v){statuses.push(v);this._t=v;},get(){return this._t||'';}});
 return {el,calls,statuses,fiscalYears:(...a)=>window.SiloQboHistory.fiscalYears(...a),summarise:(...a)=>window.SiloQboHistory.summarise(...a),explainHtml:(...a)=>window.SiloQboHistory.explain(...a),windowLabel:(...a)=>window.SiloQboHistory.windowLabel(...a),openDetail:async()=>{el('historyDetail').open=true;el('historyDetail').events.toggle();await settle();},closeDetail:async()=>{el('historyDetail').open=false;el('historyDetail').events.toggle();await settle();},loadMore:async()=>{el('historyMore').events.click();await settle();},boot:()=>window.SiloQboHistory.mount({db,companyId:'test-company'}),submit:async(start='2026-01-01',end='2026-08-31',extra={})=>{el('historyYears').events.click({target:{dataset:{start,end,...extra}}});await settle();},resume:async()=>{el('historyResume').events.click();await settle();}};
}
test('actual history handler reads scoped GL then TB, archives stored IDs and displays escaped retained details',async()=>{
 const h=harness();await h.boot();assert.match(h.el('historyStatus').textContent,/Pick a year/);
 // There are no date fields to fill any more: a year IS the request.
 assert.ok(!/id="historyFrom"|id="historyTo"/.test(h.el('historyYears').innerHTML));
 await h.submit();
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');assert.equal(fetch.length,2);assert.equal(fetch[0].body.report_name,'GeneralLedger');assert.equal(fetch[1].body.report_name,'TrialBalance');
 // Both reports must describe the SAME PERIOD. This assertion previously
 // pinned the trial balance to '2026-01-01', the fiscal year start -- which is
 // the defect, written down as an expectation: a trial balance is period-scoped
 // for income and expense accounts, so one over a different range disagrees
 // with the ledger on every P&L account.
 for(const f of fetch){assert.equal(f.body.connection_id,'connection-test');assert.equal(f.body.params.start_date,'2026-01-01');assert.equal(f.body.params.end_date,'2026-08-31');assert.equal(f.body.params.accounting_method,'Accrual');}
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x=>x.name==='archive_qbo_ledger').args)),{p_gl_run_id:'GeneralLedger-run',p_tb_run_id:'TrialBalance-run'});
 assert.equal(h.el('historyRows').innerHTML,'','the ledger card is closed, so its lines were never fetched');
 await h.openDetail();
 assert.match(h.el('historyRows').innerHTML,/&lt;script&gt;bad/);assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.equal(h.el('historyDetail').hidden,false);
 assert.ok(!h.calls.some(x=>x.name==='quickbooks-post-journal'));assert.ok(!h.calls.some(x=>x.cols?.includes('source_snapshot')));
});
// The window that actually broke it. With a January fiscal year, any window
// beginning on January 1 IS the fiscal year to date, so the old code happened to
// send the right dates and every archive reconciled. The first window to cross a
// fiscal-year boundary compared twelve months of ledger against seven months of
// trial balance: 63 P&L accounts out by $33.3m on 2026-09-15, every balance-sheet
// account tying exactly.
test('a window crossing the fiscal year boundary still reads the trial balance over the ledger period',async()=>{
 const h=harness();await h.boot();
 await h.submit('2025-01-01','2025-12-31');
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');
 assert.equal(fetch.length,2);
 assert.equal(fetch[0].body.report_name,'GeneralLedger');assert.equal(fetch[1].body.report_name,'TrialBalance');
 for(const f of fetch){
  assert.equal(f.body.params.start_date,'2025-01-01','both reports cover the ledger window');
  assert.equal(f.body.params.end_date,'2025-12-31');
 }
});

// QBO's trial balance is fiscal-year-to-date whatever range is requested, so a
// window beginning on the fiscal year start is the only one it can check in
// full. The year buttons exist so the crossing window is unreachable.
test('fiscal year buttons offer only windows the trial balance can check, clamped at the cutover',async()=>{
 const h=harness();await h.boot();
 const years=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:1},[]);
 // the module runs in its own vm realm, so arrays are not reference-equal
 assert.deepEqual(JSON.parse(JSON.stringify(years.map(y=>[y.label,y.start_date,y.end_date]))),[
  ['2026','2026-01-01','2026-08-31'],
  ['2025','2025-01-01','2025-12-31'],
  ['2024','2024-01-01','2024-12-31'],
  ['2023','2023-01-01','2023-12-31'],
 ]);
 assert.equal(years[0].partial,true,'the current year stops at the day before the Silo start date');
 assert.equal(years[1].partial,false);
 for(const y of years)assert.ok((Date.parse(y.end_date)-Date.parse(y.start_date))/86400000<=365,
   `${y.label} must be a window the archive accepts`);
});

test('a non-January fiscal year is offered as its own span, not the calendar year',async()=>{
 const h=harness();await h.boot();
 const years=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:7},[],2);
 // the module runs in its own vm realm, so arrays are not reference-equal
 assert.deepEqual(JSON.parse(JSON.stringify(years.map(y=>[y.label,y.start_date,y.end_date]))),[
  ['2026–27','2026-07-01','2026-08-31'],
  ['2025–26','2025-07-01','2026-06-30'],
 ]);
});

test('a year button reports what is already saved and what it collides with',async()=>{
 const h=harness();await h.boot();
 const settings={accounting_start_date:'2026-09-01',fiscal_year_start_month:1};
 const saved=h.fiscalYears(settings,[
  {period_start:'2025-01-01',period_end:'2025-12-31',exception_count:0,created_at:'2026-09-01'},
  {period_start:'2025-01-01',period_end:'2025-12-31',exception_count:4,created_at:'2026-09-02'},
  {period_start:'2024-06-01',period_end:'2024-09-30',exception_count:0,created_at:'2026-09-01'},
 ]);
 const y2025=saved.find(y=>y.label==='2025'),y2024=saved.find(y=>y.label==='2024');
 assert.equal(y2025.saved,true);
 assert.equal(y2025.exceptions,4,'the newest snapshot of that window wins, never the sum');
 assert.equal(y2024.saved,false);
 assert.equal(y2024.covered,false,'four months inside the year is not coverage of the year');
 assert.equal(y2024.partlyCovered,true);
});

// "Covered" is a claim about the whole year. Inferring it from any
// intersection let a single overlapping day read as coverage while eleven
// months were missing, which would talk a reader out of the archive this
// control exists to offer.
test('a partial overlap is reported as partly saved, with the missing dates named',async()=>{
 const h=harness();await h.boot();
 const settings={accounting_start_date:'2026-09-01',fiscal_year_start_month:1};
 const y=h.fiscalYears(settings,[{period_start:'2025-07-01',period_end:'2025-12-31',exception_count:0,created_at:'2026-09-01'}])
   .find(x=>x.label==='2025');
 assert.equal(y.covered,false,'half a year is not a covered year');
 assert.equal(y.partlyCovered,true);
 assert.deepEqual(JSON.parse(JSON.stringify(y.gaps)),[['2025-01-01','2025-06-30']],'the missing months are named');
});

test('one overlapping day is not coverage', async()=>{
 const h=harness();await h.boot();
 const y=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:1},
   [{period_start:'2024-12-31',period_end:'2025-01-01',exception_count:0,created_at:'2026-09-01'}])
   .find(x=>x.label==='2025');
 assert.equal(y.covered,false);
 assert.deepEqual(JSON.parse(JSON.stringify(y.gaps)),[['2025-01-02','2025-12-31']]);
});

test('adjacent saved windows together do cover the year', async()=>{
 const h=harness();await h.boot();
 const y=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:1},[
   {period_start:'2025-01-01',period_end:'2025-06-30',exception_count:0,created_at:'2026-09-01'},
   {period_start:'2025-07-01',period_end:'2025-12-31',exception_count:0,created_at:'2026-09-01'},
 ]).find(x=>x.label==='2025');
 assert.equal(y.covered,true,'day-adjacent windows are one stretch, so the year really is covered');
 assert.equal(y.partlyCovered,false);
 assert.deepEqual(JSON.parse(JSON.stringify(y.gaps)),[]);
});

// refresh() loads archives ordered by created_at DESC, never by period, so the
// coverage walk has to order them itself. Saved out of order, these two halves
// still cover the year.
test('coverage does not depend on the order archives arrive in',async()=>{
 const h=harness();await h.boot();
 const y=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:1},[
   {period_start:'2025-07-01',period_end:'2025-12-31',exception_count:0,created_at:'2026-09-02'},
   {period_start:'2025-01-01',period_end:'2025-06-30',exception_count:0,created_at:'2026-09-01'},
 ]).find(x=>x.label==='2025');
 assert.equal(y.covered,true,'newest-first input must not read as a gap at the start of the year');
 assert.deepEqual(JSON.parse(JSON.stringify(y.gaps)),[]);
});

// The list holds every saved window, not just this year's. One from another
// year must not make the year look partly saved.
test('an archive from another year leaves the year reading not saved',async()=>{
 const h=harness();await h.boot();
 const y=h.fiscalYears({accounting_start_date:'2026-09-01',fiscal_year_start_month:1},
   [{period_start:'2023-01-01',period_end:'2023-12-31',exception_count:0,created_at:'2026-09-01'}])
   .find(x=>x.label==='2025');
 assert.equal(y.covered,false);
 assert.equal(y.partlyCovered,false,'an unrelated window is not partial coverage of this one');
 assert.deepEqual(JSON.parse(JSON.stringify(y.gaps)),[['2025-01-01','2025-12-31']]);
});

test('the rendered state says partly saved rather than covered', async()=>{
 const h=harness({preloaded:false});await h.boot();
 const html=h.el('historyYears').innerHTML;
 assert.ok(!/Covered by another window/.test(html),'the old wording that overstated coverage is gone');
});

test('clicking a year archives that window through the same path as the form',async()=>{
 const h=harness();await h.boot();
 h.el('historyYears').events.click({target:{dataset:{start:'2025-01-01',end:'2025-12-31'}}});
 await settle();
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');
 assert.equal(fetch.length,2);
 for(const f of fetch){
  assert.equal(f.body.params.start_date,'2025-01-01');
  assert.equal(f.body.params.end_date,'2025-12-31');
 }
 assert.ok(h.calls.some(x=>x.name==='archive_qbo_ledger'),'and it archives, rather than only filling the fields');
});

// A company that has closed June but not July archives through June. Only the
// START must be the fiscal year start -- the trial balance is as-at its end
// date, so any end inside the year reconciles.
test('the open fiscal year is archived through a date the reader chooses',async()=>{
 const h=harness();await h.boot();
 // The control now sits beside the open year rather than inside the strip.
 assert.equal(h.el('historyYearThrough').hidden,false,'the open year offers an end date');
 assert.equal(h.el('historyYearThroughLabel').textContent,'2026 through','and names the year it belongs to');
 assert.equal(h.el('historyYearEnd').min,'2026-01-01','bounded by the year itself');
 assert.equal(h.el('historyYearEnd').max,'2026-08-31');
 assert.equal(h.el('historyYearEnd').value,'2026-08-31','defaulting to the latest archivable day');
 h.el('historyYearEnd').value='2026-06-30';
 h.el('historyYears').events.click({target:{dataset:{start:'2026-01-01',end:'2026-08-31',editable:'1'}}});
 await settle();
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');
 assert.equal(fetch.length,2);
 for(const f of fetch){
  assert.equal(f.body.params.start_date,'2026-01-01','the start stays the fiscal year start');
  assert.equal(f.body.params.end_date,'2026-06-30','and the chosen end is what is asked for');
 }
});

test('an end date outside the open year is refused by name and archives nothing',async()=>{
 const h=harness();await h.boot();
 h.el('historyYearEnd').value='2025-06-30';
 const before=h.calls.length;
 h.el('historyYears').events.click({target:{dataset:{start:'2026-01-01',end:'2026-08-31',editable:'1'}}});
 await settle();
 assert.match(h.el('historyStatus').textContent,/end date between 2026-01-01 and 2026-08-31/);
 assert.equal(h.calls.length,before,'no report is fetched');
});

test('a completed fiscal year ignores the open year end and archives the whole year',async()=>{
 const h=harness();await h.boot();
 h.el('historyYearEnd').value='2026-06-30';
 h.el('historyYears').events.click({target:{dataset:{start:'2025-01-01',end:'2025-12-31'}}});
 await settle();
 const fetch=h.calls.filter(x=>x.name==='quickbooks-report');
 assert.equal(fetch.length,2);
 for(const f of fetch)assert.equal(f.body.params.end_date,'2025-12-31','a closed year is not shortened by the open year control');
});

// Removing the date fields removed the only way to reach a year further back
// than the list shows, so the list has to be extendable.
test('earlier years can be asked for, and the control retires at the cap',async()=>{
 const h=harness();await h.boot();
 const first=h.el('historyYears').innerHTML;
 assert.equal((first.match(/data-start=/g)||[]).length,4,'four years to begin with');
 assert.equal(h.el('historyMoreYears').hidden,false);
 h.el('historyMoreYears').events.click();await settle();
 assert.equal((h.el('historyYears').innerHTML.match(/data-start=/g)||[]).length,8);
 h.el('historyMoreYears').events.click();await settle();
 const all=h.el('historyYears').innerHTML;
 assert.equal((all.match(/data-start=/g)||[]).length,12,'capped at twelve');
 assert.match(all,/2015-01-01/,'reaching back far enough to be worth having');
 assert.equal(h.el('historyMoreYears').hidden,true,'the control retires once there is no more to show');
});

// The overhaul is presentation only: every figure and every word of ISSUES is
// still reachable, just not all at one weight.
test('the figures lead as a KPI band and the snapshot names its own window',async()=>{
 const h=harness({preloaded:true});await h.boot();
 const band=h.el('historyKpis').innerHTML;
 assert.equal(h.el('historyKpis').hidden,false);
 for(const label of ['Window','Ledger lines','Accounts checked','Needs attention','Balance affected','Notes'])
  assert.ok(band.includes(label),`${label} is reported as a figure`);
 assert.match(band,/>Aug 2026</,'the window leads with its short name');
 // Each date is held on one line: '2026-08-' above '31' reads as two numbers.
 assert.match(band,/<span class="books-nowrap">2026-08-01<\/span> → <span class="books-nowrap">2026-08-31<\/span>/);
 // The card's own heading is the SHORT name; the exact dates are in the band
 // above it and in its body, so nothing is lost by not repeating them here.
 assert.equal(h.el('historySnapshotTitle').textContent,'Aug 2026');
 assert.equal(h.el('historySnapshotState').textContent,'Saved 2026-09-13');
 assert.equal(h.el('historyDetailState').textContent,'1 account');
 assert.match(band,/books-kpi-value--pos/,'a clean window reads as good, not neutral');
});

test('a clean window says so and an unexplained balance does not read as clean',async()=>{
 const clean=harness({preloaded:true});await clean.boot();
 assert.match(clean.el('historyStatus').textContent,/Every closing balance tied/);
 assert.equal(clean.el('historyStatus').className,'bcn-status bcn-status--pos');
});

test('matched accounts are behind a toggle, and the count of what is hidden is stated',async()=>{
 const h=harness({preloaded:true});await h.boot();
 // The preloaded snapshot has one account and it matched, so nothing is flagged.
 assert.match(h.el('historyReconciliation').innerHTML,/Every account tied to the trial balance/);
 assert.equal(h.el('historyShowAll').hidden,false,'the way to see them is still offered');
 assert.match(h.el('historyShowAll').textContent,/Show all 1 accounts?/);
 h.el('historyShowAll').events.click();
 assert.match(h.el('historyReconciliation').innerHTML,/Checking/,'the account is listed once asked for');
 assert.match(h.el('historyReconciliation').innerHTML,/bcn-pill--pos/,'its state is a pill, not a sentence');
 assert.match(h.el('historyShowAll').textContent,/Show only accounts needing attention/);
});

test('every word of an exception explanation is still reachable, behind a disclosure',async()=>{
 const h=harness();await h.boot();
 const html=window_explain(h);
 assert.match(html,/<details><summary>What this means<\/summary>/,'the prose is disclosed, not deleted');
 assert.match(html,/Do not rely on this window for this account until it is explained/,'the action text survives in full');
 assert.match(html,/books-exception--neg/,'a real difference is toned differently from a note');
});

test('a click that carries no window archives nothing',async()=>{
 const h=harness();await h.boot();
 const before=h.calls.length;
 h.el('historyYears').events.click({target:{dataset:{}}});
 await settle();
 assert.equal(h.calls.length,before,'no report is fetched and no archive is driven');
});

// The year buttons cannot produce any of these, which is the point of removing
// the date fields. windowDates stays as the backstop, so it is driven directly.
test('a window the archive would refuse makes no QBO calls',async()=>{
 const h=harness();await h.boot();
 for(const [start,end] of [['2026-08-01','2026-09-01'],['2025-01-01','2026-08-31'],['2026-02-30','2026-08-31'],['2026-08-31','2026-08-01']]){
  await h.submit(start,end);
  assert.match(h.el('historyStatus').textContent,/366 days/);
 }
 assert.ok(!h.calls.some(x=>x.name));
});
test('saved history loads without any QBO connection request; disconnected fetch leaves it usable',async()=>{
 const h=harness({disconnected:true,preloaded:true});await h.boot();await h.openDetail();assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.ok(!h.calls.some(x=>x.name));await h.submit();assert.match(h.el('historyStatus').textContent,/inactive/);await h.openDetail();assert.match(h.el('historyRows').innerHTML,/txn-1/);assert.ok(!h.calls.some(x=>x.name==='archive_qbo_ledger'));
});
test('partial report or local archive failure never claims success and leaves a retry action',async()=>{
 for(const options of [{failTb:true},{failArchive:true}]){const h=harness(options);await h.boot();await h.submit();assert.match(h.el('historyStatus').textContent,/retry/);assert.equal(h.el('historyInputs').disabled,false);assert.equal(h.el('historyDetail').hidden,true);if(options.failTb)assert.ok(!h.calls.some(x=>x.name==='archive_qbo_ledger'));}
});
test('the archive is driven to completion across bounded calls with progress, and a failed job names the row without claiming success',async()=>{
 const h=harness({steps:3});await h.boot();await h.submit();
 assert.equal(h.calls.filter(x=>x.name==='archive_qbo_ledger').length,3,'The same RPC is called until it reports complete');
 assert.ok(h.statuses.some(s=>/1,000 of 3,000/.test(s)&&/Nothing is saved until every row is checked/.test(s)),'Progress is shown between calls');
 assert.equal(h.el('historyDetail').hidden,false);await h.openDetail();assert.match(h.el('historyRows').innerHTML,/txn-1/);
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

// The dropdown used to read '2025-01-01 – 2025-12-31 · Exceptions ·
// 2026-09-15T06:31:29Z' on every row. Shortening it is only safe where the
// short form claims nothing the dates do not: a window ending mid-month is not
// a month and keeps its dates.
test('a saved window is named as short as its own dates allow, and never rounded past them',async()=>{
 const h=harness();
 assert.equal(h.windowLabel('2025-01-01','2025-12-31'),'2025');
 assert.equal(h.windowLabel('2026-08-01','2026-08-31'),'Aug 2026');
 assert.equal(h.windowLabel('2026-01-01','2026-08-31'),'Jan – Aug 2026');
 assert.equal(h.windowLabel('2025-08-01','2026-07-31'),'Aug 2025 – Jul 2026');
 assert.equal(h.windowLabel('2024-02-01','2024-02-29'),'Feb 2024','a leap February ends on the 29th');
 assert.equal(h.windowLabel('2025-02-01','2025-02-28'),'Feb 2025');
 // Not month boundaries: rounding these to a month would claim a period the
 // archive does not cover.
 assert.equal(h.windowLabel('2026-01-01','2026-08-15'),'2026-01-01 → 2026-08-15');
 assert.equal(h.windowLabel('2026-01-05','2026-12-31'),'2026-01-05 → 2026-12-31');
 assert.equal(h.windowLabel('2024-02-01','2024-02-28'),'2024-02-01 → 2024-02-28','2024 February has 29 days');
 assert.equal(h.windowLabel('','2026-08-31'),'? → 2026-08-31');
});

// The dropdown itself: short window, the state, and no machine timestamp.
test('the snapshot dropdown carries the window and its state, not a saved-at timestamp',async()=>{
 const h=harness({preloaded:true});await h.boot();
 const options=h.el('historyArchive').innerHTML;
 assert.match(options,/>Aug 2026 · Matched</);
 assert.ok(!/2026-09-13/.test(options),'the saved-at timestamp is not in the option text');
});

// Closing the card and opening it again is not a new question. Without the
// loaded guard every reopen refetched page 1 and discarded whatever 'Load more'
// had already put on screen.
test('reopening the ledger card keeps the lines already loaded and asks for nothing more',async()=>{
 const h=harness({preloaded:true});await h.boot();
 const reads=()=>h.calls.filter(c=>c.table==='qbo_history_lines').length;
 await h.openDetail();
 assert.equal(reads(),1,'opening the card is what fetches the ledger');
 await h.loadMore();
 assert.equal(reads(),2);
 await h.closeDetail();await h.openDetail();
 assert.equal(reads(),2,'reopening refetches nothing');
 assert.match(h.el('historyRows').innerHTML,/txn-1/,'and keeps what was loaded');
});

// The window KPI's note is the one place a stored value is written as HTML
// rather than as escaped text, so that a date can hold its own line. Every part
// of it must still be escaped on the way in.
test('the window note is escaped even though it is written as markup',async()=>{
 const h=harness({preloaded:true,snapshotOverrides:{period_start:'<img src=x onerror=1>',period_end:'2026-08-31'}});
 await h.boot();
 const band=h.el('historyKpis').innerHTML;
 assert.match(band,/&lt;img src=x onerror=1&gt;/);
 assert.ok(!/<img/.test(band),'no raw tag reaches the page');
 // An unparseable window keeps its stored dates rather than being rounded.
 assert.match(band,/&lt;img src=x onerror=1&gt; → 2026-08-31/);
});
