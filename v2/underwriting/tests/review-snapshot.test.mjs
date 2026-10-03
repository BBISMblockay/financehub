import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReviewSnapshot, validateReviewSnapshot, compareReviewSnapshots } from '../review-snapshot.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const EARLIER = '2026-01-15T12:00:00.000Z';
const LATER = '2026-01-20T12:00:00.000Z';
const fact = (id, value, extra = {}) => ({ id, value, ...extra });
const source = (extra = {}) => ({ id: 'qbo-profit-and-loss', status: 'available', reportId: 'synthetic-report-1',
  periodStart: '2025-12-01', periodEnd: '2025-12-31', currency: 'USD', basis: 'Accrual',
  fetchedAt: '2026-01-14T12:00:00Z', metrics: [fact('revenue',1000,{unit:'currency',label:'Revenue'})], ...extra });
function snapshot(extra = {}) {
  return buildReviewSnapshot({ companyId: COMPANY, createdAt: LATER,
    assumptions: [fact('proposal-rate',5,{unit:'percent'}), fact('debt-complete',true), fact('frequency','monthly')],
    sources: [source()], outcomes: [fact('minimum-cash',500,{unit:'currency',currency:'USD',periodStart:'2026-02',periodEnd:'2027-01'})], ...extra });
}
function prior(extra = {}) { return snapshot({createdAt:EARLIER,...extra}); }

test('captured snapshot is deterministic, canonical and detached from caller objects', () => {
  const input = { companyId: COMPANY.toUpperCase(), createdAt: '2026-01-20T13:00:00+01:00', assumptions: [fact('z',-0),fact('a',null)],
    sources:[source({metrics:[fact('z',2),fact('a',1)]})], outcomes:[] };
  const untouched = structuredClone(input);
  const output = buildReviewSnapshot(input);
  const reordered = buildReviewSnapshot({...input, assumptions:[...input.assumptions].reverse(),sources:[source({metrics:[fact('a',1),fact('z',2)]})]});
  assert.deepEqual(output,reordered); assert.deepEqual(input,untouched);
  assert.equal(output.companyId,COMPANY); assert.equal(output.createdAt,LATER); assert.equal(Object.is(output.assumptions[1].value,-0),false);
  input.sources[0].metrics[0].value=900;
  assert.equal(output.sources[0].metrics[1].value,2);
  assert.deepEqual(validateReviewSnapshot(JSON.parse(JSON.stringify(output)),COMPANY),output);
});
test('no prior review produces unavailable, never a fabricated baseline or zero changes claim', () => {
  const result = compareReviewSnapshots(snapshot(),null);
  assert.equal(result.status,'unavailable'); assert.match(result.reason,/No prior review/);
  assert.equal(result.baselineCreatedAt,null); assert.equal(result.sourceValueChanges.length,0);
});
test('wrong company, unsupported versions, invalid current and future prior review cannot compare', () => {
  const wrong = prior({companyId:OTHER_COMPANY});
  assert.throws(()=>validateReviewSnapshot(wrong,COMPANY),/different company/);
  assert.equal(compareReviewSnapshots(snapshot(),wrong).status,'incompatible');
  assert.equal(compareReviewSnapshots(snapshot(),{...prior(),version:99}).status,'incompatible');
  assert.equal(compareReviewSnapshots(null,prior()).status,'unavailable');
  assert.equal(compareReviewSnapshots(prior(),snapshot()).status,'incompatible');
  assert.equal(compareReviewSnapshots(snapshot(),snapshot()).status,'comparable');
});
test('same facts at a newer review time are unchanged, including renamed labels and reordered arrays', () => {
  const baseline = prior({assumptions:[fact('a',2,{label:'Old assumption'})],sources:[source({label:'Old source',metrics:[fact('x',10,{label:'Old metric'})]})],outcomes:[fact('x',8,{label:'Old outcome'})]});
  const current = snapshot({assumptions:[fact('a',2,{label:'Renamed assumption'})],sources:[source({label:'Renamed source',metrics:[fact('x',10,{label:'Renamed metric'})]})],outcomes:[fact('x',8,{label:'Renamed outcome'})]});
  const result=compareReviewSnapshots(current,baseline);
  assert.equal(result.status,'comparable'); assert.equal(result.counts.total,0);
});
test('numeric and configuration assumption changes use stable IDs and accurate signed deltas', () => {
  const baseline=prior({assumptions:[fact('amount',100,{unit:'currency',currency:'USD'}),fact('frequency','monthly'),fact('reviewed',false)]});
  const current=snapshot({assumptions:[fact('reviewed',true),fact('frequency','quarterly'),fact('amount',85,{unit:'currency',currency:'USD'})]});
  const changes=compareReviewSnapshots(current,baseline).assumptionChanges;
  assert.equal(changes.length,3); assert.equal(changes.find(r=>r.id==='amount').delta,-15);
  assert.equal(changes.find(r=>r.id==='frequency').delta,null); assert.equal(changes.find(r=>r.id==='reviewed').after,true);
});
test('same-period source restatement and modeled result change remain distinct categories', () => {
  const baseline=prior();
  const current=snapshot({sources:[source({metrics:[fact('revenue',1200,{unit:'currency'})]})],outcomes:[fact('minimum-cash',400,{unit:'currency',currency:'USD',periodStart:'2026-02',periodEnd:'2027-01'})]});
  const result=compareReviewSnapshots(current,baseline);
  assert.equal(result.sourceValueChanges[0].delta,200); assert.equal(result.outcomeChanges[0].delta,-100);
  assert.equal(result.sourceValueChanges[0].sourceId,'qbo-profit-and-loss'); assert.equal(result.counts.sourceLineage,0);
});
test('report refresh alone is lineage, not financial movement', () => {
  const result=compareReviewSnapshots(snapshot({sources:[source({reportId:'synthetic-report-2',fetchedAt:'2026-01-19T09:00:00Z'})]}),prior());
  assert.equal(result.sourceValueChanges.length,0); assert.equal(result.sourceChanges.length,1);
  assert.equal(result.sourceChanges[0].kind,'lineage-changed');
  assert.equal(result.sourceChanges[0].after.metrics,undefined);
});
test('period, currency, basis, unit and source identity changes do not become numeric deltas', () => {
  for (const extra of [{periodEnd:'2026-01-31'},{currency:'CAD'},{basis:'Cash'}]) {
    const result=compareReviewSnapshots(snapshot({sources:[source({...extra,metrics:[fact('revenue',1200,{unit:'currency'})]})]}),prior());
    assert.equal(result.sourceValueChanges[0].kind,'context-changed'); assert.equal(result.sourceValueChanges[0].delta,null);
  }
  for (const extra of [{unit:'units'},{sourceId:'another-scope'}]) {
    const result=compareReviewSnapshots(snapshot({outcomes:[fact('amount',20,extra)]}),prior({outcomes:[fact('amount',10,{unit:'currency'})]}));
    assert.equal(result.outcomeChanges[0].kind,'context-changed'); assert.equal(result.outcomeChanges[0].delta,null);
  }
});
test('unknown to zero, zero to unknown and absent facts preserve separate meanings', () => {
  const baseline=prior({assumptions:[fact('a',null),fact('b',0),fact('c',10)],outcomes:[]});
  const current=snapshot({assumptions:[fact('a',0),fact('b',null),fact('d',9)],outcomes:[]});
  const changes=compareReviewSnapshots(current,baseline).assumptionChanges;
  assert.equal(changes.find(r=>r.id==='a').kind,'became-known'); assert.equal(changes.find(r=>r.id==='a').delta,null);
  assert.equal(changes.find(r=>r.id==='b').kind,'became-unknown');
  assert.equal(changes.find(r=>r.id==='c').kind,'removed'); assert.equal(changes.find(r=>r.id==='d').kind,'added');
});
test('source error or removed metric is unavailability, never a financial zero', () => {
  const failed=compareReviewSnapshots(snapshot({sources:[source({status:'error',metrics:[]})]}),prior());
  assert.equal(failed.sourceChanges[0].kind,'coverage-changed'); assert.equal(failed.sourceValueChanges[0].kind,'unavailable');
  assert.equal(failed.sourceValueChanges[0].after,null); assert.equal(failed.sourceValueChanges[0].delta,null);
  const absent=compareReviewSnapshots(snapshot({sources:[]}),prior());
  assert.equal(absent.sourceChanges[0].kind,'unavailable'); assert.equal(absent.sourceValueChanges[0].kind,'unavailable');
  assert.throws(()=>snapshot({sources:[source({status:'error'})]}),/cannot retain numeric/);
});
test('truncated or changed source coverage suppresses numeric deltas', () => {
  for (const extra of [{truncated:true},{status:'partial'}]) {
    const result=compareReviewSnapshots(snapshot({sources:[source({...extra,metrics:[fact('revenue',1200,{unit:'currency'})]})]}),prior());
    assert.equal(result.sourceValueChanges[0].delta,null); assert.match(result.sourceValueChanges[0].reason,/coverage/);
  }
});
test('numeric subtraction avoids binary dust and refuses overflowing deltas', () => {
  let result=compareReviewSnapshots(snapshot({outcomes:[fact('x',.3)]}),prior({outcomes:[fact('x',.1)]}));
  assert.equal(result.outcomeChanges[0].delta,.2);
  result=compareReviewSnapshots(snapshot({outcomes:[fact('x',Number.MAX_SAFE_INTEGER)]}),prior({outcomes:[fact('x',-Number.MAX_SAFE_INTEGER)]}));
  assert.equal(result.outcomeChanges[0].delta,null); assert.match(result.outcomeChanges[0].reason,/range/);
});
test('strict snapshot rejects raw source records, narratives, credentials fields and cached conclusions', () => {
  for (const extra of [{rawRows:[]},{notes:'Sensitive narrative'},{comparison:{delta:1}},{accessToken:'synthetic-secret'}]) {
    assert.throws(()=>validateReviewSnapshot({...snapshot(),...extra},COMPANY),/unsupported fields/);
  }
  assert.throws(()=>snapshot({sources:[{...source(),rows:[{privateName:'Synthetic private name'}]}]}),/unsupported fields/);
  assert.throws(()=>snapshot({assumptions:[fact('narrative','a free-form narrative with private facts')]}),/configuration token/);
  assert.throws(()=>snapshot({assumptions:[{...fact('x',2),raw:{}}]}),/unsupported fields/);
  assert.throws(()=>snapshot({outcomes:[fact('approval','approved')]}),/finite number/);
});
test('invalid scalar values, duplicate stable IDs and implicit unknowns are rejected', () => {
  for (const value of [undefined,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,{},[]]) assert.throws(()=>snapshot({outcomes:[fact('x',value)]}),/finite number/);
  assert.throws(()=>snapshot({outcomes:[{id:'x'}]}),/state value explicitly/);
  assert.throws(()=>snapshot({outcomes:[fact('x',1),fact('x',2)]}),/duplicate stable ID/);
  assert.throws(()=>snapshot({sources:[source(),source()]}),/duplicate stable ID/);
  assert.throws(()=>snapshot({sources:[source({metrics:[fact('x',1),fact('x',2)]})]}),/duplicate stable ID/);
  assert.throws(()=>snapshot({outcomes:[fact('__proto__',1)]}),/stable identifier/);
  assert.throws(()=>snapshot({assumptions:[fact('x','')]}),/configuration token/);
});
test('dates, units, currencies and bounds are validated on local imports', () => {
  for (const createdAt of [null,'yesterday','2026-02-31T12:00:00Z','2026-01-01T25:00:00Z']) assert.throws(()=>snapshot({createdAt}),/timestamp/);
  assert.throws(()=>snapshot({outcomes:[fact('x',1,{periodStart:'2026-13'})]}),/calendar/);
  assert.throws(()=>snapshot({outcomes:[fact('x',1,{periodStart:'2026-02',periodEnd:'2026-01'})]}),/reversed/);
  assert.throws(()=>snapshot({outcomes:[fact('x',1,{currency:'usd'})]}),/currency/);
  assert.throws(()=>snapshot({outcomes:[fact('x',1,{label:'x'.repeat(161)})]}),/short plain text/);
  assert.throws(()=>snapshot({sources:Array.from({length:33},(_,n)=>source({id:`source-${n}`}))}),/too many/);
  assert.throws(()=>snapshot({assumptions:Array.from({length:2000},(_,n)=>fact(`a-${n}`,n))}),/too many facts/);
});
test('snapshot and comparator contain no network, storage, timers or generated capture time', async () => {
  const code=await readFile(new URL('../review-snapshot.js',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|setTimeout|setInterval)\b/);
  assert.doesNotMatch(code,/new Date\(\s*\)|Date\.now\(/);
  assert.doesNotMatch(code,/\.\s*(?:insert|upsert|update|delete|invoke|rpc)\s*\(/);
});
test('two partial sources never imply comparable coverage merely because their status strings match', () => {
  const baseline=prior({sources:[source({status:'partial'})]});
  const current=snapshot({sources:[source({status:'partial',metrics:[fact('revenue',1200,{unit:'currency'})]})]});
  const result=compareReviewSnapshots(current,baseline);
  assert.equal(result.sourceValueChanges[0].before,1000); assert.equal(result.sourceValueChanges[0].after,1200);
  assert.equal(result.sourceValueChanges[0].delta,null); assert.match(result.sourceValueChanges[0].reason,/partial/);
});
test('two unknown source currencies, periods, units or required report bases are not evidence of comparability', () => {
  for (const missing of [{currency:null},{periodStart:null,periodEnd:null},{basis:null}]) {
    const baseline=prior({sources:[source(missing)]});
    const current=snapshot({sources:[source({...missing,metrics:[fact('revenue',1200,{unit:'currency'})]})]});
    const change=compareReviewSnapshots(current,baseline).sourceValueChanges[0];
    assert.equal(change.delta,null); assert.match(change.reason,/not established/);
  }
  const baseline=prior({sources:[source({metrics:[fact('revenue',1000)]})]});
  const current=snapshot({sources:[source({metrics:[fact('revenue',1200)]})]});
  assert.equal(compareReviewSnapshots(current,baseline).sourceValueChanges[0].delta,null);
});
test('non-financial count snapshots can compare with explicit units and measured as-of dates', () => {
  const counts=(value,asOf)=>({id:'inventory',status:'available',asOf,metrics:[fact('on-hand',value,{unit:'units'})]});
  const result=compareReviewSnapshots(snapshot({sources:[counts(8,'2026-01-19')]}),prior({sources:[counts(10,'2026-01-14')]}));
  assert.equal(result.sourceValueChanges[0].delta,-2); assert.equal(result.sourceChanges[0].kind,'lineage-changed');
});
