import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageConfig, eligible, missingScopes, canPublish, planDays, runCoverage, storeToday } from '../lib/shopify-attribution-coverage.mjs';
const company='00000000-0000-0000-0000-000000000001';
const config=coverageConfig({ATTRIBUTION_COVERAGE_COMPANIES:company});
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
  const plan=planDays({today:'2026-10-06',state,snapshots:[],fullHistory:true});
  assert.deepEqual(plan.gaps,['2026-09-04','2026-09-05','2026-09-06']);
  assert.equal(plan.refresh.length,7);
  assert.equal(plan.refresh.at(-1),'2026-10-05');
  const limited=planDays({today:'2026-12-01',state,snapshots:[],fullHistory:false});
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
