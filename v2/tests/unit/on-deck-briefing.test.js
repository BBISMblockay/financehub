'use strict';
const assert = require('assert/strict');
const { loadV2 } = require('../lib/load');
const { build, inputPlan, prepareHandoff } = loadV2(['on-deck-briefing.js']).SiloOnDeckBriefing;
const now = Date.parse('2026-10-08T12:00:00Z');
const ads = (over = {}) => ({ id: 'ad1', kind: 'ads', status: 'ready', title: 'Draft creative · Classic tee', valid_until: '2026-10-10',
  selection_reason: 'Strong evidence. Selected #1 of 2 eligible ads opportunities.',
  source: { objective: 'purchase', index: 1.3, evidence: 'strong', current_copy: 'Meet the classic tee.' },
  content: { recommend: true, missing: [], body: 'A fresh creative variation.' }, ...over });
const seo = (over = {}) => ({ ...ads(), id: 'seo1', kind: 'seo', title: 'Improve search · Tees', source: { impressions: 29972, clicks: 175, days: 26, position: 7.3, inspection: { title: 'Tees', meta_description: 'Original copy' } }, content: { recommend: true, missing: [], body: 'Draft Title Tag:\nTees\n\nDraft Meta Description:\nNew copy' }, ...over });
let checks = 0;
function test(name, fn) { fn(); console.log(`ok ${++checks} - ${name}`); }
const run = rows => build({ rows, now });
test('one feature and two secondary actions, no arbitrary cross-domain score comparison', () => {
  const result = run(Array.from({ length: 6 }, (_, i) => ads({ id: `ad${i}`, score: i * 1000 })));
  assert.equal(result.featured.id, 'ad0'); assert.equal(result.secondary.length, 2); assert.equal(result.eligible, 6);
});
for (const status of [ 'preparing', 'revision', 'failed', 'completed', 'dismissed', 'screened']) test(`${status} never becomes a recommendation`, () => assert.equal(run([ads({ status })]).featured, null));
test('missing, declined, blank and malformed drafts stay off briefing', () => {
  for (const content of [{ recommend: false, body: 'Draft', missing: [] }, { recommend: true, body: '', missing: [] }, { recommend: true, body: 'Draft', missing: ['Benchmark'] }, { recommend: true, body: 'Draft' }]) assert.equal(run([ads({ content })]).featured, null);
});
test('expired, invalid and absent windows stay off briefing', () => {
  for (const valid_until of ['2026-10-01', 'invalid', null, '2026-10-08T12:00:00Z']) assert.equal(run([ads({ valid_until })]).featured, null);
});
test('future refresh timestamps and versions never promote an item', () => {
  const rows = [ads({ id: 'a' }), ads({ id: 'b', updated_at: '2099-01-01', version: 900 })];
  assert.equal(run(rows).featured.id, 'a'); assert.equal(run(rows.reverse()).featured.id, 'a');
});
test('source rank remains meaningful within the qualified shortlist', () => {
  assert.equal(run([ads({ id: 'a', selection_reason: 'Selected #2 of 2 eligible ads opportunities.' }), ads({ id: 'b' })]).featured.id, 'b');
});
test('independent workflow ranks cannot override cross-workflow policy', () => {
  const ad = ads({ selection_reason: 'Selected #2 of 2 eligible ads opportunities.' });
  const search = seo({ selection_reason: 'Selected #1 of 2 eligible seo opportunities.' });
  for (const rows of [[search, ad], [ad, search]]) {
    const result = run(rows); assert.equal(result.featured.kind, 'ads'); assert.equal(result.secondary[0].kind, 'seo');
  }
});
test('automatically discovered evidence precedes employee-prepared launch', () => {
  const launch = ads({ id: 'launch', kind: 'launch', source: { launch_date: '2026-10-08', audience: 'Fans' } });
  const result = run([launch, seo(), ads()]); assert.equal(result.featured.kind, 'ads'); assert.equal(result.upkeep[0].kind, 'launch');
  assert.match(result.upkeep[0].caveat, /employee/);
});
test('stock timing changes urgency without predicting demand or purchase quantities', () => {
  const restock = ads({ id: 'stock', kind: 'restock', source: { vetting: { days_cover: 12, lead_days: 21, units30: 100 } } });
  const result = run([ads(), restock]); assert.equal(result.featured.id, 'stock'); assert.match(result.featured.finding, /including incoming/); assert.match(result.featured.caveat, /not unconstrained/);
});
test('SEO exact CTR is observed, never a lift forecast', () => {
  const result = run([seo()]).featured; assert.equal(result.metrics[1][1], '0.58%'); assert.match(result.caveat, /No traffic or revenue lift/);
});
test('unchanged metadata and ambiguous generated format are not promoted', () => {
  for (const body of ['Draft Title Tag:\nTees\nDraft Meta Description:\nOriginal copy', 'Title and description are already fine.']) assert.equal(run([seo({ content: { recommend: true, missing: [], body } })]).featured, null);
});
test('invalid metrics and unsupported kinds fail conservatively', () => {
  assert.equal(run([ads({ kind: 'other' })]).featured, null);
  for (const source of [{ index: null }, { index: 1.3, objective: 'purchase', evidence: 'weak', current_copy: 'Copy' }]) assert.equal(run([ads({ source })]).featured, null);
  for (const value of [null, '', -1, 40000]) assert.equal(run([seo({ source: { ...seo().source, clicks: value } })]).featured, null);
});
test('finance recommendation counts reviewed suggestions, not financial gain', () => {
  const result = build({ now, coding: [{ batch_id: 'b', stage: 'code', open_suggestions: 30, source_name: 'Bank', suggested_amount: 263147 }] }).upkeep[0];
  assert.match(result.headline, /30 suggested/); assert.match(result.caveat, /not a saving/); assert.ok(!JSON.stringify(result).includes('263147'));
});
test('ledger legacy and input-only coding remain in all work', () => {
  for (const coding of [[{ stage: 'code', ledger_unavailable: true, open_suggestions: 30 }], [{ stage: 'needs_input', open_suggestions: 30 }]]) assert.equal(build({ coding, now }).featured, null);
});
test('monitoring counts do not call preparations completed', () => {
  const result = run([ads({ status: 'preparing' }), ads({ id: 'b', status: 'needs_info', source: { ...ads().source, evidence: 'weak' } })]);
  assert.equal(result.preparing, 1); assert.equal(result.needsInput, 1); assert.equal(result.eligible, 0);
});
test('routine coding and employee launch never become the growth hero', () => {
  const coding = [{ batch_id: 'b', stage: 'code', open_suggestions: 30 }];
  const result = build({ now, coding }); assert.equal(result.featured, null); assert.equal(result.upkeep[0].type, 'coding');
  assert.equal(run([ads({ kind: 'launch', source: { launch_date: '2026-10-08', audience: 'Fans' } })]).featured, null);
});
test('screened ad evidence invites investigation while ready growth drafts take precedence', () => {
  const blocked = ads({ status: 'needs_info', content: { recommend: true, missing: ['Audience'], body: 'Draft' } });
  assert.equal(run([blocked]).featured.readiness, 'investigate');
  assert.equal(run([blocked, seo()]).featured.kind, 'seo');
  assert.equal(run([ads({ ...blocked, source: { ...blocked.source, evidence: 'weak' } })]).featured, null);
});
test('screened search evidence can invite investigation without promoting a blocked draft', () => {
  const blocked = seo({ status: 'needs_info', content: { recommend: true, missing: ['CTR benchmark'], body: 'Unapproved draft' } });
  const item = run([blocked]).featured; assert.equal(item.readiness, 'investigate'); assert.match(item.prepared, /needs context/);
  assert.equal(item.action, 'Investigate search opportunity'); assert.match(item.caveat, /No click-through benchmark/);
  for (const patch of [{ valid_until: '2020-01-01' }, { content: { recommend: false } }, { content: { recommend: true, body: '' } }, { source: { ...blocked.source, impressions: null } }, { status: 'failed' }]) assert.equal(run([{ ...blocked, ...patch }]).featured, null);
});
test('SEO research is explicitly carried into task copy, never claimed answered', () => {
  const p = seo({ content: { ...seo().content, missing: ['Current ranking keywords driving the 175 clicks', 'Click-through rate benchmark for position ~7.3 in this vertical', 'Any prior SEO test history for this page'] } });
  assert.ok(inputPlan(p).every(x => x.research));
  const patch = prepareHandoff(p, [{ carry: true }, { carry: true }, { carry: true }]);
  assert.deepEqual(Array.from(patch.content.missing), []); assert.match(patch.content.body, /Research to complete before publishing/); assert.match(patch.content.body, /175 clicks/); assert.match(patch.note, /not claimed resolved/);
  assert.equal(p.content.missing.length, 3);
});
test('unknown and essential inputs remain blockers until supplied; partial research choice preserves the rest', () => {
  const p = seo({ content: { ...seo().content, missing: ['Required destination URL', 'Any prior SEO test history for this page'] } });
  assert.equal(inputPlan(p)[0].research, false);
  const partial = prepareHandoff(p, [{}, { carry: true }]); assert.equal(partial.content.missing[0], 'Required destination URL');
  const supplied = prepareHandoff(p, [{ value: 'https://store.example/tees' }, { carry: true }]); assert.equal(supplied.content.missing.length, 0); assert.match(supplied.content.body, /Confirmed task context/);
  assert.throws(() => prepareHandoff(p, [{ carry: true }, {}]), /Add a required input/);
  assert.equal(inputPlan({ ...p, kind: 'ads' })[1].research, false);
});
test('handoff refuses absent draft and excessive context without truncation', () => {
  assert.throws(() => prepareHandoff(seo({ content: { body: '', missing: ['Anything'] } }), []), /prepared draft/);
  assert.throws(() => prepareHandoff(seo({ content: { body: 'x'.repeat(5000), missing: ['Input'] } }), [{ value: 'Confirmed fact' }]), /draft limit/);
});
console.log(`${checks} briefing checks passed`);

const { currentStatus } = loadV2(['on-deck-briefing.js']).SiloOnDeckBriefing;
test('current readiness distinguishes six stale drafts from old ready summaries',()=>{
 const rows=[...Array.from({length:5},(_,i)=>ads({id:String(i),status:'needs_info',source_current:false})),ads({id:'failed',status:'failed',source_current:false})];
 const result=currentStatus(rows,now);assert.equal(result.ready,0);assert.equal(result.needs,5);assert.equal(result.failed,1);assert.equal(result.stale,6);
 assert.equal(currentStatus([ads({source_current:false}),ads({valid_until:'bad'}),ads({content:{recommend:true,body:'text',missing:['Need facts']}})],now).ready,0);
 assert.equal(currentStatus([ads({source_current:true})],now).ready,1);assert.equal(currentStatus([],now).ready,0);
 assert.equal(currentStatus([ads()],now).ready,0);assert.equal(currentStatus([ads()],now).unknown,1);
 assert.match(currentStatus([ads()],now).text,/Freshness unavailable/);
 assert.equal(currentStatus([seo({source_current:true})],now).ready,0);
 assert.equal(currentStatus([seo({source_current:true,content:{recommend:true,body:'Draft',missing:[],proposed_title:'Title',proposed_meta_description:'Description'}})],now).ready,1);
});
