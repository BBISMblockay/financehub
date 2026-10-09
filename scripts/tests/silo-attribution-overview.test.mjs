import test from 'node:test';
import assert from 'node:assert/strict';
import {allocate} from '../../v2/silo-attribution-model.js';
import {analyzeJourneys,observedJourney,splitCents,touchWeights,loadJourneyRecords} from '../../v2/silo-attribution-overview.js';
import {draftId,saveReviewTask,suggestions} from '../../v2/silo-attribution-actions.js';
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
  assert.equal(suggestions(report,a).length,2);assert.throws(()=>analyzeJourneys({...report,orders:[row,row]},[record]),/unique orders/);
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
test('loader enforces tenant/store scope and batches',async()=>{
  const {row,record}=fixture(),calls=[];
  const db={from(){const filters={};const chain={select(){return chain;},eq(k,v){filters[k]=v;return chain;},in(k,v){calls.push({...filters,[k]:v});return Promise.resolve({data:[record]});}};return chain;}};
  assert.equal((await loadJourneyRecords(db,company,store,[row])).length,1);assert.equal(calls[0].company_entity_id,company);assert.equal(calls[0].connection_id,store);
  await assert.rejects(loadJourneyRecords(db,'other',store,[row]),/scope/);
});
test('draft repeated/concurrent clicks, uncertain insert, owner and tenant checks',async()=>{
  const {report,record}=fixture(),suggestion=suggestions(report,analyzeJourneys(report,[record]))[0];
  const context={companyId:company,connectionId:store,start:'2026-09-01',end:'2026-09-30',windowDays:30,userId:'user'};
  const saved=new Map();let insertions=0,checks=0;
  const db={from(table){const filters={};const q={select(){return q;},eq(k,v){filters[k]=v;return q;},maybeSingle:async()=>({data:table==='entity_memberships'?{user_id:'owner'}:saved.get(filters.id)||null}),insert:async payload=>{insertions++;assert.equal(payload.company_entity_id,company);assert.equal(payload.is_private,true);assert.equal(payload.launch_id,null);assert.match(payload.notes,/Hypothesis \(unproven\)/);if(saved.has(payload.id))return {error:{code:'23505'}};saved.set(payload.id,payload);return {error:{message:'simulated lost response'}};}};return q;}};
  const args={db,context,suggestion,owner:{id:'owner',name:'Synthetic owner'},reviewDate:'2026-10-20',now:new Date('2026-10-09'),checkCompany:async()=>{checks++;}};
  const [a,b]=await Promise.all([saveReviewTask(args),saveReviewTask(args)]);assert.equal(a.id,b.id);assert.equal(saved.size,1);assert.ok(checks>=4);
  const count=insertions;await saveReviewTask(args);assert.equal(insertions,count);
  assert.notEqual(await draftId(context,suggestion.key),await draftId({...context,companyId:'other'},suggestion.key));
  assert.notEqual(await draftId(context,suggestion.key),await draftId({...context,userId:'other'},suggestion.key));
  await assert.rejects(saveReviewTask({...args,owner:null}),/Select/);
  await assert.rejects(saveReviewTask({...args,checkCompany:async()=>{throw Error('Company changed');}}),/Company changed/);
  const before=insertions;
  await assert.rejects(saveReviewTask({...args,suggestion:{...suggestion,key:'new-stale'},assertCurrent:()=>{throw Error('Report changed');}}),/Report changed/);
  assert.equal(insertions,before);
});
