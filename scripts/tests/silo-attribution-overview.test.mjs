import test from 'node:test';
import assert from 'node:assert/strict';
import {allocate} from '../../v2/silo-attribution-model.js';
import {analyzeJourneys,observedJourney,splitCents,touchWeights,loadJourneyRecords} from '../../v2/silo-attribution-overview.js';
import {channelTeamwork,findings,pathRevenue} from '../../v2/silo-attribution-together.js';
const company='00000000-0000-0000-0000-000000000001',store='00000000-0000-0000-0000-000000000002';
export function fixture(){
  const sources=[['facebook','paid'],['facebook','paid'],['redo','sms'],['google','cpc'],['direct','']];
  const visits=sources.map(([source,medium],i)=>({id:'v'+i,occurredAt:`2026-09-${String(10+i).padStart(2,'0')}T10:00:00Z`,utmParameters:{source,medium}}));
  const order={id:'gid://shopify/Order/1',name:'#SYNTHETIC-1',sourceName:'web',createdAt:'2026-09-15T10:00:00Z',customerJourneySummary:{ready:true,firstVisit:visits[0],lastVisit:visits.at(-1),moments:{nodes:visits,pageInfo:{hasNextPage:false}}}};
  const allocation=allocate(order,null,null,{windowDays:30});
  const row={company_entity_id:company,connection_id:store,order_id:'1',order_name:order.name,window_days:30,allocation,channel:allocation.channel,net_cents:10001,total_cents:11003,evidence_fetched_at:'2026-09-16T00:00:00Z'};
  const record={...row,evidence:{order,own_hosts:['store.test']},fetched_at:row.evidence_fetched_at};
  const report={orders:[row],net:row.net_cents,total:row.total_cents,currency:'USD'};
  return {row,record,report};
}
test('synthetic repeated touches, medians, overlapping roles and signed cent conservation',()=>{
  const {row,record,report}=fixture(),a=analyzeJourneys(report,[record]);
  assert.deepEqual(a.paths[0].path,['Meta Ads','Redo SMS','Google Ads']);assert.equal(a.paths[0].medianMs,5*86400000);assert.equal(a.paths[0].steps[0].medianMs,2*86400000);
  assert.deepEqual(a.roles.find(r=>r.channel==='Meta Ads'),{channel:'Meta Ads',introductions:1,assists:1,closes:0});
  for(const m of Object.values(a.models)){assert.equal([...m.values()].reduce((s,c)=>s+c.net_cents,0),10001);assert.equal([...m.values()].reduce((s,c)=>s+c.total_cents,0),11003);}
  const reversed=analyzeJourneys({...report,net:-10001,total:-11003,orders:[{...row,net_cents:-10001,total_cents:-11003}]},[record]);
  for(const name of Object.keys(a.models))for(const [c,x] of a.models[name])assert.equal(reversed.models[name].get(c).net_cents,-x.net_cents);
  const rows=channelTeamwork(report,a,null);
  assert.equal(rows.reduce((t,r)=>t+r.net_cents,0),10001);assert.equal(rows.reduce((t,r)=>t+r.shared_cents,0),10001);
  assert.equal(rows.find(r=>r.channel==='Meta Ads').shared_cents,3334);assert.equal(pathRevenue(report,a.paths)[0].net_cents,10001);
  assert.ok(findings(report,rows,a,n=>String(n)).some(f=>f.key==='path'&&f.text.includes('1 order,')));assert.throws(()=>analyzeJourneys({...report,orders:[row,row]},[record]),/unique orders/);
});
test('stale, tenant, pending, unknown, incomplete and future evidence fail honestly',()=>{
  const {row,record,report}=fixture();
  assert.throws(()=>observedJourney(row,{...record,company_entity_id:'other'}),/identity/);
  assert.throws(()=>observedJourney(row,{...record,fetched_at:'new'}),/refreshed/);
  for(const kind of ['pending','incomplete','future','unknown']){
    const r=structuredClone(record),j=r.evidence.order.customerJourneySummary;
    if(kind==='pending')j.ready=false;
    if(kind==='incomplete')j.moments.pageInfo.hasNextPage=true;
    if(kind==='future')j.moments.nodes.push({id:'future',occurredAt:'2027-01-01'});
    if(kind==='unknown')j.moments.nodes.push({id:'unknown',occurredAt:'2026-09-12T12:00:00Z'});
    const a=analyzeJourneys(report,[r]);assert.equal(a.eligible,0);assert.equal(a.paths.length,0);assert.equal(a.models.equal.get(row.channel).net_cents,row.net_cents);
  }
  assert.equal(analyzeJourneys(report,[]).exclusions[0].reason,'Missing evidence');
});
test('rounding, zero and custom role settings',()=>{
  const weights=new Map([['A',1],['B',1],['C',1]]);
  assert.deepEqual([...splitCents(2,weights)],[['A',1],['B',1],['C',0]]);
  for(let n=-100;n<=100;n++)assert.equal([...splitCents(n,weights).values()].reduce((a,b)=>a+b,0),n);
  const j={created:20,touches:[{channel:'A',time:10},{channel:'B',time:15}]};
  assert.deepEqual([...touchWeights(j,'roles',{roles:[0,1,0]})],[['A',1],['B',1]]);
  assert.throws(()=>touchWeights(j,'roles',{roles:[0,0,0]}),/positive/);
  assert.throws(()=>touchWeights(j,'decay',{halfLifeDays:0}),/Half-life/);
  assert.equal(touchWeights({...j,touches:[j.touches[0]]},'roles').get('A'),1);
});
test('historical catalog labels must reconcile before changing credit rules',()=>{
  const {row,record,report}=fixture();
  row.allocation.assisting_channels=['Meta Ads','Historically mapped provider'];
  assert.equal(analyzeJourneys(report,[record]).exclusions[0].reason,'Historical channel mapping unavailable');
});
// The server now returns the two evidence keys the rollup reads, not the whole blob, so the
// loader rebuilds the `evidence` shape the rest of the module expects.
const served=record=>({company_entity_id:record.company_entity_id,connection_id:record.connection_id,order_id:record.order_id,order_evidence:record.evidence.order,own_hosts:record.evidence.own_hosts,fetched_at:record.fetched_at});
function journeyDb(records,calls,track={inFlight:0,peak:0}){
  const byId=new Map(records.map(r=>[r.order_id,r]));
  return {track,from(){const filters={};const chain={select(columns){filters.columns=columns;return chain;},eq(k,v){filters[k]=v;return chain;},in(k,v){
    calls.push({...filters,[k]:v});
    track.inFlight++;track.peak=Math.max(track.peak,track.inFlight);
    // Resolve on a later tick so overlapping requests are observable.
    return new Promise(resolve=>setTimeout(()=>{track.inFlight--;resolve({data:v.map(id=>byId.get(id)).filter(Boolean).map(served)});},0));
  }};return chain;}};
}
test('loader enforces tenant/store scope and asks only for the keys the rollup reads',async()=>{
  const {row,record}=fixture(),calls=[];
  const db=journeyDb([record],calls);
  const loaded=await loadJourneyRecords(db,company,store,[row]);
  assert.equal(loaded.length,1);
  assert.equal(calls[0].company_entity_id,company);assert.equal(calls[0].connection_id,store);
  // The whole blob is 5.3KB an order and 3.1KB of it duplicates the ledger's allocation.
  assert.match(calls[0].columns,/order_evidence:evidence->order/);
  assert.match(calls[0].columns,/own_hosts:evidence->own_hosts/);
  assert.ok(!/(^|,)evidence(,|$)/.test(calls[0].columns),'the whole evidence blob must not be requested');
  // Rebuilt into the shape analyzeJourneys reads, so the rollup is unchanged.
  assert.deepEqual(loaded[0].evidence.order,record.evidence.order);
  assert.deepEqual(loaded[0].evidence.own_hosts,record.evidence.own_hosts);
  assert.equal(loaded[0].fetched_at,record.fetched_at);
  assert.deepEqual(analyzeJourneys({orders:[row],net:row.net_cents,total:row.total_cents,currency:'USD'},loaded).paths,analyzeJourneys({orders:[row],net:row.net_cents,total:row.total_cents,currency:'USD'},[record]).paths);
  await assert.rejects(loadJourneyRecords(db,'other',store,[row]),/scope/);
});
test('batches run several at a time and return every order exactly once',async()=>{
  const {row,record}=fixture(),calls=[];
  // Eight batches, so the six-request ceiling is actually crossed: five would overlap fully
  // and prove nothing about the bound.
  const orders=Array.from({length:1600},(_,i)=>({...row,order_id:'o'+i}));
  const records=orders.map(o=>({...record,order_id:o.order_id}));
  const db=journeyDb(records,calls);
  const loaded=await loadJourneyRecords(db,company,store,orders);
  assert.equal(loaded.length,1600);
  assert.equal(new Set(loaded.map(r=>r.order_id)).size,1600);
  assert.equal(calls.length,8,'1600 orders in batches of 200');
  assert.ok(calls.every(c=>c.order_id.length<=200));
  // Sequential batches were the whole cost for a 30-day store: ~95 round trips end to end.
  assert.ok(db.track.peak>1,'batches must overlap');
  assert.ok(db.track.peak<=6,'and must not all be fired at once');
});
