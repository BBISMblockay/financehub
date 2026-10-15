'use strict';
const assert = require('assert/strict');
const { loadV2 } = require('../lib/load');
const { build, inputPlan, prepareHandoff, statusOf, draftBlockers, canReview } = loadV2(['on-deck-briefing.js']).SiloOnDeckBriefing;
const now = Date.parse('2026-10-08T12:00:00Z');
const ads = (over = {}) => ({ id: 'ad1', kind: 'ads', status: 'ready', title: 'Draft creative · Classic tee', source_current: true, valid_until: '2026-10-10',
  selection_reason: 'Strong evidence. Selected #1 of 2 eligible ads opportunities.',
  source: { objective: 'purchase', index: 1.3, evidence: 'strong', current_copy: 'Meet the classic tee.' },
  content: { recommend: true, subject:'Reviewed draft', summary:'Summary', reason:'Evidence', tasks:[], missing: [], body: 'A fresh creative variation.' }, ...over });
const seo = (over = {}) => ({ ...ads(), id: 'seo1', kind: 'seo', title: 'Improve search · Tees', source: { impressions: 29972, clicks: 175, days: 26, position: 7.3, inspection: { title: 'Tees', meta_description: 'Original copy' } }, content: { ...ads().content, proposed_title:'Tees', proposed_meta_description:'New copy', recommend: true, missing: [], body: 'Draft Title Tag:\nTees\n\nDraft Meta Description:\nNew copy' }, ...over });
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
  const launch = ads({ id: 'launch', kind: 'launch', source: { launch_date: '2026-10-08', audience: 'Fans' }, content: {...ads().content,tasks:[{title:'Email',detail:'Copy'}]} });
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
  assert.equal(run([ads({ kind: 'launch', source: { launch_date: '2026-10-08', audience: 'Fans' }, content: {...ads().content,tasks:[{title:'Email',detail:'Copy'}]} })]).featured, null);
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
test('only structured optional research may carry; legacy wording stays essential', () => {
  const label = 'Any prior SEO test history for this page';
  const p = seo({ content: { ...seo().content, missing: [label], optional_context: ['CTR benchmark'] } });
  assert.equal(inputPlan(p)[0].research, false); assert.equal(inputPlan(p)[1].research, true);
  const blocked = prepareHandoff(p, [{carry:true},{carry:true}]); assert.equal(blocked.content.missing.length,1);
  const supplied = prepareHandoff(p, [{value:'Verified historic test record'},{carry:true}]); assert.equal(supplied.content.missing.length,0);
  assert.equal(supplied.content.review_inputs[0].answer,'Verified historic test record'); assert.equal(supplied.content.review_inputs[1].mode,'carry');
  const saved = {...p,content:supplied.content}; assert.equal(inputPlan(saved)[0].answer,'Verified historic test record');
  const reopened = prepareHandoff(saved,[{value:inputPlan(saved)[0].answer,reopen:true},{carry:true}]); assert.equal(reopened.content.missing.length,1); assert.equal(reopened.content.body,p.content.body);
});
test('complete SEO fields and launch rows are required even with no missing facts', () => {
  const B=loadV2(['on-deck-briefing.js']).SiloOnDeckBriefing;
  const p=seo({content:{...seo().content,proposed_title:'',proposed_meta_description:''}});
  assert.equal(B.draftBlockers(p).length,2); assert.equal(run([p]).featured,null);
  assert.equal(B.draftBlockers(ads({kind:'launch'})).length,1);
  assert.equal(B.canReview({...ads(),source_current:undefined}),false);
  assert.equal(B.preparation({...p,status:'preparing'}, {enabled:false}).state,'paused');
  assert.equal(B.preparation({...p,status:'preparing'}, {enabled:true}).state,'unknown');
});
console.log(`${checks} briefing checks passed`);

const { currentStatus } = loadV2(['on-deck-briefing.js']).SiloOnDeckBriefing;
test('current readiness counts a refreshed sync as drift, and expiry as stale',()=>{
 const rows=[...Array.from({length:5},(_,i)=>ads({id:String(i),status:'needs_info',source_current:false})),ads({id:'failed',status:'failed',source_current:false})];
 const result=currentStatus(rows,now);assert.equal(result.ready,0);assert.equal(result.needs,5);assert.equal(result.failed,1);
 // Drift is not staleness: these six are inside their window, so nothing expired.
 assert.equal(result.stale,0);assert.equal(result.drifted,6);assert.match(result.text,/prepared before the latest data sync/);
 // A ready draft whose data has since synced is still actionable; an expired one is not.
 assert.equal(currentStatus([ads({source_current:false})],now).ready,1);
 assert.equal(currentStatus([ads({valid_until:'bad'}),ads({content:{recommend:true,body:'text',missing:['Need facts']}})],now).ready,0);
 assert.equal(currentStatus([ads({valid_until:'bad'})],now).stale,1);
 assert.equal(currentStatus([ads({source_current:true})],now).ready,1);assert.equal(currentStatus([],now).ready,0);
 assert.equal(currentStatus([ads({source_current:undefined})],now).ready,0);assert.equal(currentStatus([ads({source_current:undefined})],now).unknown,1);
 assert.match(currentStatus([ads({source_current:undefined})],now).text,/Freshness unavailable/);
 assert.equal(currentStatus([seo({source_current:true,content:{...seo().content,proposed_title:'',proposed_meta_description:''}})],now).ready,0);
 assert.equal(currentStatus([seo({source_current:true,content:{...seo().content,body:'Draft',proposed_title:'Title',proposed_meta_description:'Description'}})],now).ready,1);
});

// One status per proposal: the card, the detail and the button all read this.
const reviewOk = { review_contract: 2, drift_warns: true, proposals: [] };
const stat = (p, over = {}) => statusOf(p, { settings: { enabled: true, workflows: ['ads','seo','launch','restock'] }, review: reviewOk, now, ...over });
test('a failed readiness call never invents a status', () => {
  for (const review of [null, undefined, { review_contract: 1, proposals: [] }]) {
    const st = stat(ads({ source_current: true }), { review });
    assert.equal(st.key, 'unavailable'); assert.equal(st.action, 'retry');
    assert.doesNotMatch(st.label, /ready|needs/i);
    assert.doesNotMatch(st.detail, /install|migration|update/i);
  }
});
test('unknown freshness is unknown, not ready', () => {
  assert.equal(stat(ads({ source_current: undefined })).key, 'unavailable');
});
test('the card and the detail cannot disagree: ready means no blockers', () => {
  const ready = ads({ source_current: true });
  assert.equal(draftBlockers(ready).length, 0);
  assert.equal(stat(ready).key, 'ready'); assert.equal(stat(ready).action, 'review');
  // The exact row Blake hit: status 'ready' with an unanswered required fact.
  const blocked = ads({ status: 'ready', source_current: true, content: { ...ads().content, missing: ['Verify the margin claim'] } });
  assert.ok(draftBlockers(blocked).length);
  const st = stat(blocked);
  assert.equal(st.key, 'needs_input'); assert.equal(st.action, 'answer');
  assert.equal(st.label, 'Needs 1 answer'); assert.equal(st.asks, 1);
  assert.notEqual(st.label.toLowerCase(), 'ready for your review');
});
test('two unanswered facts pluralise, answered ones do not count', () => {
  const two = ads({ source_current: true, content: { ...ads().content, missing: ['One', 'Two'] } });
  assert.equal(stat(two).label, 'Needs 2 answers');
});
test('terminal rows keep their status even when readiness is unavailable', () => {
  assert.equal(stat(ads({ status: 'completed' }), { review: null }).key, 'done');
  assert.equal(stat(ads({ status: 'dismissed' }), { review: null }).key, 'dismissed');
  assert.equal(stat(ads({ status: 'screened' }), { review: null }).key, 'screened');
});
test('preparing, paused, failed and stale each say what they are', () => {
  assert.equal(stat(ads({ status: 'preparing', source_current: true })).key, 'working');
  assert.equal(stat(ads({ source_current: true }), { settings: { enabled: false } }).key, 'blocked');
  assert.equal(stat(ads({ status: 'failed', source_current: true })).key, 'blocked');
  assert.equal(stat(ads({ source_current: true, valid_until: '2026-10-01' })).key, 'stale');
  assert.equal(stat(ads({ source_current: true, valid_until: '2026-10-01' })).label, 'Evidence expired');
});
// A sync refreshing the source data is the single most common event in SILO; it
// must not take the draft away. Expiry and unknown freshness still do.
test('a refreshed sync is a notice on a usable status, not a blocked one', () => {
  const drifted = stat(ads({ source_current: false }));
  assert.equal(drifted.key, 'ready'); assert.equal(drifted.action, 'review');
  assert.match(drifted.notice, /refreshed since this draft/);
  assert.equal(canReview(ads({ source_current: false }), true, now, true), true);
  // Same draft, one unanswered fact: it needs the answer, and still says the data moved.
  const asked = stat(ads({ source_current: false, content: { ...ads().content, missing: ['Confirm the margin'] } }));
  assert.equal(asked.key, 'needs_input'); assert.match(asked.notice, /refreshed since this draft/);
  // Expired and unknown are unchanged.
  assert.equal(stat(ads({ source_current: false, valid_until: '2026-10-01' })).key, 'stale');
  assert.equal(canReview(ads({ source_current: false, valid_until: '2026-10-01' }), true, now, true), false);
  assert.equal(canReview(ads({ source_current: undefined }), true, now), false);
  assert.equal(stat(ads({ source_current: true })).notice, undefined);
  // An explicit Refresh empties source_version. That is no evidence basis at all,
  // and the SQL refuses it, so the page must not offer the draft either.
  const refreshed = ads({ source_current: false, source_version: '' });
  assert.equal(stat(refreshed).key, 'queued'); assert.equal(stat(refreshed).action, null);
  assert.match(stat(refreshed).detail, /fresh screening/i);
  assert.equal(canReview(refreshed, true, now), false);
});
// Between merge and apply the database still refuses a drifted draft, so the page
// must keep blocking it instead of offering an action that will error.
test('before the migration is applied, drift still blocks', () => {
  const old = { review_contract: 2, proposals: [] };
  const st = stat(ads({ source_current: false }), { review: old });
  assert.equal(st.key, 'stale'); assert.equal(st.action, 'refresh'); assert.equal(st.notice, undefined);
  assert.equal(canReview(ads({ source_current: false }), true, now, false), false);
  assert.equal(canReview(ads({ source_current: false }), true, now, true), true);
});

// Cycle-1 P2 on #998: `status='preparing'` is also what a row looks like when its
// credit is exhausted, when it is queued behind the scheduler, or when the attempt
// already failed. Reading the lifecycle status first said "SILO is preparing this"
// while the next-step paragraph said "Paused", which is the disagreement this PR
// exists to remove.
const prep = (state, reason) => ({ review: { review_contract: 2, proposals: [{ id: 'ad1', preparation: { state, reason } }] } });
test('a preparing row that is paused, queued or failed says so, not "preparing"', () => {
  const paused = stat(ads({ status: 'preparing' }), prep('paused', 'credit_exhausted'));
  assert.equal(paused.key, 'blocked'); assert.equal(paused.label, 'Paused');
  assert.match(paused.detail, /credit is exhausted/);
  const queued = stat(ads({ status: 'preparing' }), prep('queued', 'drafting'));
  assert.equal(queued.key, 'queued'); assert.equal(queued.label, 'Queued to prepare');
  assert.match(queued.detail, /scheduler/);
  const failed = stat(ads({ status: 'preparing' }), prep('failed', 'preparation_failed'));
  assert.equal(failed.key, 'blocked'); assert.equal(failed.label, 'Preparation did not finish');
  assert.equal(failed.action, 'refresh');
  for (const st of [paused, queued, failed]) assert.doesNotMatch(st.label, /preparing this/i);
});
test('only a reserved attempt earns the working label', () => {
  assert.equal(stat(ads({ status: 'preparing' }), prep('running', 'reserved')).key, 'working');
  // No confirmed state from the readiness payload: the lifecycle status is the
  // only thing left to go on, and it still may not claim paused or queued.
  assert.equal(stat(ads({ status: 'revision' })).key, 'working');
});
