import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotForReview } from '../review-view.js';
import { compareReviewSnapshots } from '../review-snapshot.js';
import { parseInputNumber } from '../scenario-file.js';

const COMPANY='11111111-1111-4111-8111-111111111111';
const earlier='2026-01-15T12:00:00Z',later='2026-01-20T12:00:00Z';
const metric=(label,value,extra={})=>({label,value,unit:'currency',...extra});
function state(metrics,extra={}) {
  return {context:{company:{id:COMPANY}},values:{currency:'USD'},overrides:{},facilities:[],commitments:[],
    sources:{sources:{profitAndLoss:{status:'available',reportId:'synthetic-report',fetchedAt:'2026-01-14T12:00:00Z',
      periodStart:'2025-12-01',periodEnd:'2025-12-31',basis:'Accrual',currency:'USD',metrics,...extra}}}};
}
const capture=(state,createdAt=later,definitions=[])=>snapshotForReview({state,definitions,number:parseInputNumber,createdAt});
test('review adapter uses semantic metric IDs despite insertion and reordering',()=>{
  const baseline=capture(state([metric('Income',1000),metric('Gross profit',400)]),earlier);
  const current=capture(state([metric('Net income',250),metric('Gross profit',450),metric('Income',1000)]));
  const result=compareReviewSnapshots(current,baseline);
  assert.deepEqual(result.sourceValueChanges.map(r=>[r.id,r.kind,r.delta]),[['gross-profit','changed',50],['net-income','added',null]]);
  assert.equal(result.sourceValueChanges.find(r=>r.id==='income'),undefined);
});
test('explicit stable adapter IDs retain identity when labels are renamed',()=>{
  const baseline=capture(state([metric('Prior title',1000,{id:'income'})]),earlier);
  const current=capture(state([metric('New title',1000,{id:'income'})]));
  assert.equal(compareReviewSnapshots(current,baseline).counts.total,0);
});
test('adapter preserves source refresh lineage and omits unknown metrics and raw source content',()=>{
  const baseline=capture(state([metric('Income',1000)]),earlier);
  const current=capture(state([metric('Income',1000),metric('Unclassified label',200)],{
    fetchedAt:'2026-01-19T09:00:00Z',rows:[{syntheticPrivateName:'Do not retain'}],notes:'Do not retain',raw_response:{sensitive:'Do not retain'},
  }));
  assert.equal(current.sources[0].metrics.length,1);assert.equal(current.sources[0].fetchedAt,'2026-01-19T09:00:00.000Z');
  assert.equal(JSON.stringify(current).includes('Do not retain'),false);
  const result=compareReviewSnapshots(current,baseline);assert.equal(result.sourceValueChanges.length,0);assert.equal(result.sourceChanges[0].kind,'lineage-changed');
});
test('metric ID collisions fail capture rather than overwrite selected numeric facts',()=>{
  assert.throws(()=>capture(state([metric('Income',1000),metric('Different fact',500,{id:'income'})])),/duplicate stable ID/);
});
test('unavailable source values are not carried from stale metrics into captured facts',()=>{
  const current=capture(state([metric('Income',1000)],{status:'error'}));
  assert.equal(current.sources[0].metrics.length,0);assert.equal(current.sources[0].status,'error');
});

const monetaryIds=['amount','upfrontFees','useOfProceeds','startingCash','cashFloor','normalizedCash','existingPayment','baselineWorkingCapital','revenue'];
const unitIds={rate:'percent',term:'months',amortizationMonths:'months',coverageTarget:'ratio',forecastMonths:'months',growthPct:'percent',growthSpread:'months',revenueDecline:'percent',grossMargin:'percent',marginCompression:'percentage-points',creditScore:'score'};
const assumptionDefinitions=[...monetaryIds,...Object.keys(unitIds)].map(id=>[id,id,'number']);
const facilityAmounts=['manualBalance','limit','borrowingBase','reserves','lenderAvailable','monthlyPayment'];
function monetaryState({scenarioCurrency='USD',facilityCurrency='EUR',commitmentCurrency='GBP',amount=100}={}) {
  const result=state([]);
  result.values={currency:scenarioCurrency,...Object.fromEntries(monetaryIds.map(id=>[id,String(amount)])),...Object.fromEntries(Object.keys(unitIds).map(id=>[id,'10']))};
  result.overrides={'2026-02':{payment:String(amount),preDebtCash:String(amount),workingCapitalUse:String(amount),otherCashUse:String(amount)}};
  result.facilities=[{id:'facility-a',name:'Synthetic facility',currency:facilityCurrency,...Object.fromEntries(facilityAmounts.map(id=>[id,amount])),monthlyPayments:{'2026-02':amount},terms:{annualRatePct:10,amortizationMonths:12}}];
  result.commitments=[{id:'commitment-a',amount,currency:commitmentCurrency,sourceReference:'Synthetic reference'}];
  const timing={enabled:true,amount,baselineReceipts:amount*2,fromMonth:'2026-02',toMonth:'2026-03',sourceReference:'Synthetic reference',reviewed:true};
  result.cashTiming={collections:{...timing},inventory:{...timing},distinctReceiptPoolsReviewed:true};
  return result;
}
test('every monetary assumption carries its own currency; rates and month counts have explicit units',()=>{
  const current=capture(monetaryState(),later,assumptionDefinitions);
  const facts=new Map(current.assumptions.map(f=>[f.id,f]));
  const scenarioMoney=[...monetaryIds,...['payment','preDebtCash','workingCapitalUse','otherCashUse'].map(id=>`override:2026-02:${id}`),...['collections','inventory'].flatMap(id=>[`timing:${id}:amount`,`timing:${id}:baselineReceipts`])];
  for(const id of scenarioMoney)assert.deepEqual([facts.get(id).unit,facts.get(id).currency],['currency','USD'],id);
  for(const id of [...facilityAmounts.map(id=>`facility:facility-a:${id}`),'payment:facility-a:2026-02'])assert.deepEqual([facts.get(id).unit,facts.get(id).currency],['currency','EUR'],id);
  assert.deepEqual([facts.get('commitment:commitment-a:amount').unit,facts.get('commitment:commitment-a:amount').currency],['currency','GBP']);
  for(const [id,unit]of Object.entries(unitIds))assert.deepEqual([facts.get(id).unit,facts.get(id).currency],[unit,null],id);
  assert.equal(facts.get('terms:facility-a:annualRatePct').unit,'percent');
  assert.equal(facts.get('terms:facility-a:amortizationMonths').unit,'months');
});
test('changed currency suppresses every monetary assumption delta rather than implying conversion',()=>{
  const baseline=capture(monetaryState(),earlier,assumptionDefinitions);
  const current=capture(monetaryState({scenarioCurrency:'CAD',facilityCurrency:'GBP',commitmentCurrency:'EUR',amount:150}),later,assumptionDefinitions);
  const comparison=compareReviewSnapshots(current,baseline);
  const moneyChanges=comparison.assumptionChanges.filter(f=>f.beforeContext?.unit==='currency');
  assert.equal(moneyChanges.length,monetaryIds.length+4+facilityAmounts.length+1+1+4);
  for(const change of moneyChanges){assert.equal(change.delta,null,change.id);assert.equal(change.kind,'context-changed',change.id);assert.notEqual(change.beforeContext.currency,change.afterContext.currency,change.id);}
});
test('same-currency monetary assumptions retain numeric deltas and a scenario change does not relabel facility currency',()=>{
  const baseline=capture(monetaryState(),earlier,assumptionDefinitions);
  const current=capture(monetaryState({scenarioCurrency:'CAD',amount:150}),later,assumptionDefinitions);
  const changes=compareReviewSnapshots(current,baseline).assumptionChanges;
  for(const id of ['facility:facility-a:manualBalance','payment:facility-a:2026-02','commitment:commitment-a:amount'])assert.equal(changes.find(f=>f.id===id).delta,50,id);
  assert.equal(changes.find(f=>f.id==='amount').delta,null);
  const unchangedCurrency=capture(monetaryState({amount:150}),later,assumptionDefinitions);
  assert.equal(compareReviewSnapshots(unchangedCurrency,baseline).assumptionChanges.find(f=>f.id==='amount').delta,50);
});
test('unknown monetary currency and amount stay explicit null without borrowing scenario currency',()=>{
  const input=monetaryState({facilityCurrency:'',commitmentCurrency:''});
  input.values.amount='';input.facilities[0].manualBalance=null;input.commitments[0].amount=null;
  const facts=new Map(capture(input,later,assumptionDefinitions).assumptions.map(f=>[f.id,f]));
  assert.equal(facts.get('amount').value,null);assert.equal(facts.get('amount').currency,'USD');
  for(const id of ['facility:facility-a:manualBalance','commitment:commitment-a:amount']){
    assert.equal(facts.get(id).currency,null,id);assert.equal(facts.get(id).value,null,id);assert.equal(facts.get(id).unit,'currency',id);
  }
});
