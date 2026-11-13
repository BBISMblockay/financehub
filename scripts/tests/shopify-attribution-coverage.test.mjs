import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageConfig, eligible, missingScopes, canPublish, planDays, runCoverage, storeToday, historyFloorDay } from '../lib/shopify-attribution-coverage.mjs';
const company='00000000-0000-0000-0000-000000000001';
const config=coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company,ATTRIBUTION_GAP_DAYS:'3'});
const connection=id=>({id,company_entity_id:company,is_active:true,sync_enabled:true,scopes_granted:['read_orders','read_reports']});
test('explicit enrollment boundary, opt-out and minimum scopes',()=>{
  assert.throws(()=>coverageConfig({}));
  assert.throws(()=>coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:'*',ATTRIBUTION_INITIAL_DAYS:'32'}));
  assert.equal(eligible(connection('a'),config),true);
  assert.equal(eligible({...connection('a'),company_entity_id:'other'},config),false);
  assert.equal(eligible({...connection('a'),sync_enabled:false},config),false);
  assert.equal(eligible({...connection('a'),is_active:false},config),false);
  assert.equal(eligible(connection('a'),{...config,excluded:new Set(['a'])}),false);
  assert.equal(eligible({...connection('a'),company_entity_id:'new'},coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:'*'})),true);
  assert.deepEqual(missingScopes({...connection('a'),scopes_granted:[]}),['read_orders','read_reports']);
});
test('store calendars, frozen floor, rotating failures and permission boundary',()=>{
  assert.equal(storeToday('America/Los_Angeles',new Date('2026-10-07T03:00:00Z')),'2026-10-06');
  const state={start_day:'2026-09-01',next_day:'2026-09-04',shop_timezone:'America/Los_Angeles'};
  const plan=planDays({today:'2026-10-06',state,snapshots:[],fullHistory:true,gapDays:3});
  assert.deepEqual(plan.gaps,['2026-09-04','2026-09-05','2026-09-06']);
  assert.equal(plan.refresh.length,7);
  assert.equal(plan.refresh.at(-1),'2026-10-05');
  const limited=planDays({today:'2026-12-01',state,snapshots:[],fullHistory:false,gapDays:3});
  assert.equal(limited.floor,'2026-10-03');
  assert.equal(limited.permissionLimited,true);
  assert.ok(limited.gaps.every(day=>day>='2026-10-03'));
});
function fixture() {
  const connections=[connection('a'),connection('b')],states=new Map(),snapshots=new Map(),calls=[];
  const fixed=new Date('2026-10-07T03:00:00Z');
  const io={config,listConnections:async()=>connections,loadState:async id=>structuredClone(states.get(id)),
    saveState:async state=>states.set(state.connection_id,structuredClone(state)),
    loadSnapshots:async id=>snapshots.get(id)||[],prepare:async()=> 'America/Los_Angeles',
    currentConnection:async id=>connections.find(c=>c.id===id),now:()=>fixed,log:()=>{},
    runDay:async(c,day)=>{calls.push([c.id,day]);const rows=snapshots.get(c.id)||[];rows.push({day,extracted_at:fixed.toISOString()});snapshots.set(c.id,rows);}};
  return {io,connections,states,snapshots,calls};
}
test('real orchestration enrolls new stores, freezes checkpoint, isolates failures, and resumes',async()=>{
  const f=fixture(),publish=f.io.runDay;
  f.io.runDay=async(c,day)=>{if(c.id==='a'&&day==='2026-09-05')throw Error('private upstream payload');return publish(c,day);};
  assert.equal((await runCoverage(f.io)).failures,1);
  assert.equal(f.states.get('a').start_day,'2026-09-05');
  assert.equal(f.states.get('a').next_day,'2026-09-08');
  assert.equal(f.states.get('a').last_status,'partial_failure');
  assert.equal(f.states.get('a').last_failed_day,'2026-09-05');
  assert.equal(f.states.get('b').last_result.succeeded,10);
  f.connections.push(connection('c'));
  f.calls.length=0;
  await runCoverage(f.io);
  assert.equal(f.calls[0][0],'c'); // new store precedes stores already attempted
  assert.equal(f.states.get('a').start_day,'2026-09-05');
  assert.ok(f.calls.some(([id,day])=>id==='a'&&day==='2026-09-08'));
  assert.ok(!f.calls.some(([id,day])=>id==='a'&&day==='2026-10-05')); // today's successful checkpoint
  for(let i=0;i<9;i++)await runCoverage(f.io);
  assert.equal(f.states.get('a').last_failed_day,'2026-09-05');
  assert.equal(f.states.get('a').last_result.failed,1); // failed missing day eventually revisited
});
test('disconnect, publication failure, deadline and scope skips never become successful checkpoints',async()=>{
  const f=fixture();let checks=0;
  f.io.currentConnection=async id=>id==='a'&&++checks>1?{...connection(id),sync_enabled:false}:f.connections.find(c=>c.id===id);
  f.connections[1].scopes_granted=[];
  await runCoverage(f.io);
  assert.equal(f.calls.length,0);
  assert.equal(f.states.get('a').last_status,'paused');
  assert.equal(f.states.has('b'),false);
  const g=fixture();g.io.deadline=+g.io.now();await runCoverage(g.io);
  assert.equal(g.states.size,0);
});

test('a failed checkpoint read does not prevent healthy stores from progressing',async()=>{
  const f=fixture(),load=f.io.loadState;
  f.io.loadState=async id=>{if(id==='a')throw Error('database failed');return load(id);};
  assert.equal((await runCoverage(f.io)).failures,1);
  assert.equal(f.states.has('a'),false);
  assert.equal(f.states.get('b').last_result.succeeded,10);
});

test('publication eligibility rejects changed tenant, domain, opt-out, scopes and aged history',()=>{
  const original={...connection('a'),shop_domain:'a.myshopify.com'};
  const allowed=fresh=>canPublish(fresh,original,config,'2026-10-01','2026-10-07');
  assert.equal(allowed(original),true);
  for(const patch of [{company_entity_id:'other'},{shop_domain:'b.myshopify.com'},{is_active:false},{sync_enabled:false},{scopes_granted:[]}]) assert.equal(allowed({...original,...patch}),false);
  assert.equal(canPublish(original,original,config,'2026-08-01','2026-10-07'),false);
  assert.equal(canPublish({...original,scopes_granted:[...original.scopes_granted,'read_all_orders']},original,config,'2026-08-01','2026-10-07'),true);
});

test('catch-up budget is configurable, bounded, and never silently absent',async()=>{
  assert.equal(coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company}).gapDays,10); // raised default
  assert.equal(coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company,ATTRIBUTION_GAP_DAYS:'31'}).gapDays,31);
  for(const bad of ['0','61','2.5','-3','abc']) assert.throws(()=>coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company,ATTRIBUTION_GAP_DAYS:bad}));
  // A missing budget must refuse, not plan zero historical days forever.
  const state={start_day:'2026-09-01',next_day:'2026-09-04',shop_timezone:'America/Los_Angeles'};
  for(const bad of [undefined,0,2.5,null]) assert.throws(()=>planDays({today:'2026-10-06',state,snapshots:[],fullHistory:true,gapDays:bad}));
  // The budget, and only the budget, decides how many historical days a run plans.
  const plan=n=>planDays({today:'2026-10-06',state,snapshots:[],fullHistory:true,gapDays:n});
  assert.equal(plan(3).gaps.length,3);
  assert.equal(plan(10).gaps.length,10);
  assert.deepEqual(plan(10).gaps.slice(0,4),['2026-09-04','2026-09-05','2026-09-06','2026-09-07']);
  assert.equal(plan(10).refresh.length,7); // refresh budget is untouched by the catch-up budget
  assert.ok(plan(60).gaps.every(day=>day>=plan(60).floor&&day<=plan(60).end));
});
test('a bigger budget enrolls a new store in proportionally fewer runs',async()=>{
  const fast=fixture();fast.io.config={...config,gapDays:10};
  await runCoverage(fast.io);
  // 31-day enrollment window: 10 historical + 7 refresh in one run, against 3 + 7 before.
  assert.equal(fast.states.get('a').last_result.succeeded,17);
  const slow=fixture();
  await runCoverage(slow.io);
  assert.equal(slow.states.get('a').last_result.succeeded,10);
  // Same destination either way: neither budget can reach past the frozen floor.
  for(let i=0;i<12;i++)await runCoverage(fast.io);
  const days=new Set(fast.snapshots.get('a').map(r=>r.day));
  assert.ok(days.has(fast.states.get('a').start_day));
  assert.ok([...days].every(day=>day>=fast.states.get('a').start_day));
});

// ---------------------------------------------------------------------------
// Automatic backward history walk.
// ---------------------------------------------------------------------------
const deepConnection=id=>({...connection(id),scopes_granted:['read_orders','read_reports','read_all_orders']});

test('history depth and budget are configurable, bounded, and default to the house 730 days',()=>{
  const cfg=env=>coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company,...env});
  assert.equal(cfg({}).historyDays,730);
  assert.equal(cfg({ATTRIBUTION_HISTORY_DAYS:''}).historyDays,730); // unset repo variable arrives as ''
  assert.equal(cfg({ATTRIBUTION_HISTORY_DAYS:'0'}).historyDays,0);  // explicit off
  assert.equal(cfg({}).historyBudget,20);
  assert.equal(cfg({ATTRIBUTION_HISTORY_BUDGET:'25'}).historyBudget,25);
  for(const bad of ['-1','1096','2.5','abc']) assert.throws(()=>cfg({ATTRIBUTION_HISTORY_DAYS:bad}));
  for(const bad of ['0','61','2.5','abc']) assert.throws(()=>cfg({ATTRIBUTION_HISTORY_BUDGET:bad}));
});

test('the walk floor is bounded by depth, by read_all_orders and by the day the shop was created',()=>{
  const today='2026-10-06';
  assert.equal(historyFloorDay({today,connection:deepConnection('a'),historyDays:730}),'2024-10-06');
  // Without read_all_orders Shopify serves ~60 days, which refresh and catch-up already cover.
  assert.equal(historyFloorDay({today,connection:connection('a'),historyDays:730}),null);
  assert.equal(historyFloorDay({today,connection:deepConnection('a'),historyDays:0}),null);
  // A day before the store existed cannot reconcile, so the shop's own birthday wins.
  assert.equal(historyFloorDay({today,connection:deepConnection('a'),historyDays:730,shopCreatedDay:'2025-03-04'}),'2025-03-04');
  // ...but it never SHORTENS the reach when the store is older than the target depth.
  assert.equal(historyFloorDay({today,connection:deepConnection('a'),historyDays:730,shopCreatedDay:'2019-01-01'}),'2024-10-06');
});

test('history is planned backwards from enrollment, bounded, resumable and never re-published',()=>{
  const state={start_day:'2026-09-01',next_day:'2026-09-04',shop_timezone:'America/Los_Angeles',history_day:null};
  const plan=extra=>planDays({today:'2026-10-06',state,snapshots:[],fullHistory:true,gapDays:3,historyBudget:4,...extra});
  // Off by default: no floor, no history, and the rest of the plan is exactly as before.
  assert.deepEqual(plan({}).history,[]);
  assert.equal(plan({}).historyComplete,false);
  const walked=plan({historyFloor:'2024-10-06'});
  assert.deepEqual(walked.history,['2026-08-31','2026-08-30','2026-08-29','2026-08-28']); // newest first, contiguous
  assert.equal(walked.gaps.length,3); // the catch-up budget is untouched by the history budget
  assert.equal(walked.refresh.length,7);
  // Resumes from its own cursor rather than restarting at enrollment.
  assert.deepEqual(planDays({today:'2026-10-06',state:{...state,history_day:'2026-05-10'},snapshots:[],fullHistory:true,gapDays:3,historyBudget:2,historyFloor:'2024-10-06'}).history,
    ['2026-05-10','2026-05-09']);
  // A cursor at or above enrollment is ignored: the walk only ever goes below start_day.
  assert.deepEqual(plan({historyFloor:'2024-10-06',...{}}).history[0],'2026-08-31');
  assert.equal(planDays({today:'2026-10-06',state:{...state,history_day:'2026-09-20'},snapshots:[],fullHistory:true,gapDays:3,historyBudget:1,historyFloor:'2024-10-06'}).history[0],'2026-08-31');
  // Days already published -- an earlier manual backfill -- are stepped over, not re-spent.
  const stepped=planDays({today:'2026-10-06',state,fullHistory:true,gapDays:3,historyBudget:2,historyFloor:'2024-10-06',
    snapshots:[{day:'2026-08-31',extracted_at:'2026-09-01T00:00:00Z'},{day:'2026-08-30',extracted_at:'2026-09-01T00:00:00Z'}]});
  assert.deepEqual(stepped.history,['2026-08-29','2026-08-28']);
  // The floor is hard, and reaching it reports completion rather than planning past it.
  const done=planDays({today:'2026-10-06',state:{...state,history_day:'2026-08-30'},snapshots:[],fullHistory:true,gapDays:3,historyBudget:10,historyFloor:'2026-08-29'});
  assert.deepEqual(done.history,['2026-08-30','2026-08-29']);
  assert.equal(done.historyComplete,false);
  assert.equal(planDays({today:'2026-10-06',state:{...state,history_day:'2026-08-28'},snapshots:[],fullHistory:true,gapDays:3,historyBudget:10,historyFloor:'2026-08-29'}).historyComplete,true);
});

function deepFixture(overrides={}) {
  const connections=[deepConnection('a')],states=new Map(),snapshots=new Map(),calls=[];
  const fixed=new Date('2026-10-07T03:00:00Z');
  // An already-enrolled store whose checkpoint row came back from the database, so it
  // carries the history_day column.
  states.set('a',{connection_id:'a',start_day:'2026-09-06',next_day:'2026-10-06',shop_timezone:'America/Los_Angeles',
    history_day:null,last_attempt_at:'2026-10-06T12:00:00Z',last_status:'success'});
  snapshots.set('a',[]);
  // Published yesterday, so the trailing seven days are due a refresh and the run has
  // real current-day work to do before it reaches any history.
  for(let d=Date.parse('2026-09-06');d<=Date.parse('2026-10-05');d+=86400000)
    snapshots.get('a').push({day:new Date(d).toISOString().slice(0,10),extracted_at:'2026-10-06T00:00:00Z'});
  const io={config:{...config,historyDays:730,historyBudget:3},listConnections:async()=>connections,
    loadState:async id=>structuredClone(states.get(id)),
    saveState:async state=>states.set(state.connection_id,structuredClone(state)),
    loadSnapshots:async(id,start)=>(snapshots.get(id)||[]).filter(r=>r.day>=start),
    prepare:async()=>({timeZone:'America/Los_Angeles',createdDay:'2020-01-01'}),
    currentConnection:async id=>connections.find(c=>c.id===id),now:()=>fixed,log:()=>{},
    runDay:async(c,day)=>{calls.push([c.id,day]);(snapshots.get(c.id)||[]).push({day,extracted_at:fixed.toISOString()});},
    ...overrides};
  return {io,connections,states,snapshots,calls};
}

test('an enrolled store deepens its own history every run, oldest work last and resumable',async()=>{
  const f=deepFixture();
  assert.equal((await runCoverage(f.io)).failures,0);
  const deep=f.calls.filter(([,day])=>day<'2026-09-06').map(([,day])=>day);
  assert.deepEqual(deep,['2026-09-05','2026-09-04','2026-09-03']);
  // History is attempted only after the trailing refresh: a night that runs out of time
  // drops the oldest work, never the days every report reads.
  assert.equal(f.calls.filter(([,day])=>day>='2026-09-29'&&day<='2026-10-05').length,7); // the trailing refresh still ran
  assert.ok(f.calls.findIndex(([,day])=>day==='2026-10-05')<f.calls.findIndex(([,day])=>day==='2026-09-05'));
  assert.equal(f.states.get('a').history_day,'2026-09-02');
  assert.equal(f.states.get('a').start_day,'2026-09-06'); // enrollment is still frozen
  assert.equal(f.states.get('a').last_result.history_succeeded,3);
  await runCoverage(f.io);
  assert.deepEqual(f.calls.filter(([,day])=>day<'2026-09-03').map(([,day])=>day),['2026-09-02','2026-09-01','2026-08-31']);
  // Nineteen more runs reach the shop's creation day and stop there for good.
  const old=deepFixture();old.io.prepare=async()=>({timeZone:'America/Los_Angeles',createdDay:'2026-08-28'});
  for(let i=0;i<5;i++)await runCoverage(old.io);
  const reached=old.calls.filter(([,day])=>day<'2026-09-06').map(([,day])=>day).sort();
  assert.equal(reached[0],'2026-08-28');
  assert.equal(old.states.get('a').last_result.history_complete,true);
  assert.equal(old.calls.filter(([,day])=>day<'2026-08-28').length,0);
});

test('an unreadable old day costs one attempt and never fails the nightly run',async()=>{
  const f=deepFixture();const publish=f.io.runDay;
  f.io.runDay=async(c,day)=>{if(day==='2026-09-04')throw Error('private upstream payload');return publish(c,day);};
  const result=await runCoverage(f.io);
  assert.equal(result.failures,0); // deep history cannot turn the run that keeps stores current red
  const state=f.states.get('a');
  assert.equal(state.last_result.history_failed,1);
  assert.equal(state.last_result.failed,0);
  assert.equal(state.last_failed_day,undefined); // the current-days failure channel is untouched
  assert.equal(state.last_status,'partial_failure');
  assert.equal(state.history_day,'2026-09-02'); // cursor walked PAST it
  f.calls.length=0;
  await runCoverage(f.io);
  assert.equal(f.calls.filter(([,day])=>day==='2026-09-04').length,0); // never retried, never wedged
});

test('the walk stays off without the cursor column, without the scope, and at depth 0',async()=>{
  // A checkpoint row from a database that has not had the migration applied has no
  // history_day key at all, so nothing is planned and nothing writes the column.
  const bare=deepFixture();
  const {history_day,...withoutColumn}=bare.states.get('a');
  bare.states.set('a',withoutColumn);
  await runCoverage(bare.io);
  assert.equal(bare.calls.filter(([,day])=>day<'2026-09-06').length,0);
  assert.equal('history_day' in bare.states.get('a'),false);
  const noScope=deepFixture();noScope.connections[0]=connection('a');
  await runCoverage(noScope.io);
  assert.equal(noScope.calls.filter(([,day])=>day<'2026-09-06').length,0);
  assert.equal(noScope.states.get('a').last_result.history_scope_missing,true);
  const off=deepFixture();off.io.config={...config,historyDays:0,historyBudget:10};
  await runCoverage(off.io);
  assert.equal(off.calls.filter(([,day])=>day<'2026-09-06').length,0);
  assert.equal(off.states.get('a').last_result.history_scope_missing,undefined);
});

test('deep history takes an equal share of the time left, so one store cannot starve the rest',async()=>{
  // Two enrolled stores, a clock that only moves when a day is published, and a deadline
  // that cannot fit both stores' histories. The first store must not consume all of it.
  let clock=Date.parse('2026-10-07T03:00:00Z');
  const f=deepFixture();
  f.connections.push(deepConnection('b'));
  f.states.set('b',{...structuredClone(f.states.get('a')),connection_id:'b'});
  f.snapshots.set('b',structuredClone(f.snapshots.get('a')));
  f.io.config={...config,historyDays:730,historyBudget:20};
  f.io.now=()=>new Date(clock);
  const publish=f.io.runDay;
  f.io.runDay=async(c,day)=>{clock+=1000;return publish(c,day);};
  // Each published day costs a second. 14 of them (7 refresh each) are current-day work,
  // and what is left is far less than the 40 days of history the two stores want.
  f.io.deadline=clock+30000;
  await runCoverage(f.io);
  const deepOf=id=>f.calls.filter(([c,day])=>c===id&&day<'2026-09-06').length;
  assert.ok(deepOf('a')>0&&deepOf('b')>0,'both stores deepened');
  assert.ok(deepOf('a')<20,'the first store did not spend its whole budget: '+deepOf('a'));
  assert.ok(deepOf('b')>=4,'the second store still got a real share: '+deepOf('b'));
  // Without the share, the first store would have taken every history day there was time for.
  assert.ok(deepOf('a')<=deepOf('b')+8,'the split is not lopsided: '+deepOf('a')+' vs '+deepOf('b'));
  assert.equal(f.states.get('b').last_status,'paused'); // unfinished history is paused, not failed
});
