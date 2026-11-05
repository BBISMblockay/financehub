import assert from 'node:assert/strict';
import {collectDay,fetchJourney,fetchJourneys,fetchLandingSites,fetchSalesDay,validateDay,landingEvidence,dayRange,sanitizeDiscountCodes,planReuse,reusableEvidence} from '../lib/shopify-attribution-evidence.mjs';
import {shopifyql,shopifyGraphql} from '../lib/shopify-sync-core.mjs';
const day='2026-09-01',conn={id:'c',shop_domain:'test.myshopify.com'};
const visit={id:'v1',__typename:'CustomerVisit',occurredAt:'2026-09-01T01:00:00Z',source:'https://facebook.com/?email=secret',utmParameters:{source:'facebook',medium:'paid'},landingPage:'https://shop.test/p?utm_contact=secret'};
const order={id:'gid://shopify/Order/1',name:'#1',createdAt:'2026-09-01T02:00:00Z',sourceName:'web',discountCodes:['TEAM50',' team50 ','',null,'PRESTON30'],customerJourneySummary:{ready:true,firstVisit:visit,lastVisit:visit,moments:{nodes:[visit],pageInfo:{hasNextPage:false}}}};
const sales=[{day,order_id:'1',net_sales:'-10.01',total_sales:'-11.02'}],control=[{net_sales:'-10.01',total_sales:'-11.02'}];
assert.equal(validateDay(day,sales,control).net,-1001);
assert.throws(()=>validateDay(day,[...sales,...sales],control),/identity/);
assert.throws(()=>validateDay(day,sales,[{net_sales:'0',total_sales:'0'}]),/mismatch/);
assert.throws(()=>validateDay(day,Object.assign([],{raw:{table_data_was_null:true}}),control),/Incomplete/);
assert.throws(()=>validateDay(day,Array(10000).fill(sales[0]),control),/Incomplete/);
assert.throws(()=>dayRange('2026-02-30','2026-03-01'));
assert.throws(()=>dayRange('2026-01-01','2026-03-01'),/31/);
assert.equal(dayRange(day,'2026-09-30').length,30);
assert.deepEqual(landingEvidence('/p?utm_source=redo&utm_contact=secret&email=secret&gclid=private').tracking,{utm_source:'redo',gclid:'present'});
assert.deepEqual(sanitizeDiscountCodes(['TEAM50',' TEAM50 ','',null,'PRESTON30']),['TEAM50','PRESTON30'],'codes are trimmed and de-duplicated');
assert.deepEqual(sanitizeDiscountCodes(Array(25).fill().map((_,i)=>'C'+i)).length,20,'a code list is capped');
assert.deepEqual(sanitizeDiscountCodes(sanitizeDiscountCodes(['X'])),['X'],'sanitizing twice is stable');
for(const absent of [undefined,null,'TEAM50',{code:'TEAM50'}])assert.deepEqual(sanitizeDiscountCodes(absent),[],'a non-array carries no codes');
assert.equal(sanitizeDiscountCodes(['x'.repeat(200)])[0].length,128,'a code is capped in length');
let calls=0;
const paged=await fetchJourney(conn,'1',{gql:async()=>{calls++;return {order:{...order,customerJourneySummary:{...order.customerJourneySummary,moments:{nodes:[],pageInfo:{hasNextPage:calls===1,endCursor:'next'}}}}};}});
assert.equal(calls,2);assert.equal(paged.customerJourneySummary.moments.nodes.length,1);
assert.deepEqual(paged.discountCodes,['TEAM50','PRESTON30'],'a completed journey carries the sanitized codes');
const notReady=await fetchJourney(conn,'1',{gql:async()=>({order:{...order,customerJourneySummary:{ready:false}}})});
assert.deepEqual(notReady.discountCodes,['TEAM50','PRESTON30'],'an order whose journey is not ready still carries its codes');
const noSummary=await fetchJourney(conn,'1',{gql:async()=>({order:{...order,customerJourneySummary:null}})});
assert.deepEqual(noSummary.discountCodes,['TEAM50','PRESTON30'],'an order with no journey summary still carries its codes');
// An order Shopify will not return has no evidence at all: codes must be ABSENT, not an empty
// array, so the ledger reads it as not measured rather than as a sale that used no code.
const gone=await fetchJourney(conn,'1',{gql:async()=>({order:null})});
assert.ok(!('discountCodes' in gone),'an unavailable order claims nothing about codes');
assert.ok(!JSON.stringify(paged).includes('secret'));
await assert.rejects(fetchJourney(conn,'1',{gql:async()=>({order:{...order,customerJourneySummary:{...order.customerJourneySummary,moments:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}})}),/advance/);
let published=0;
const deps={ql:async(c,q)=>q.includes('GROUP BY')?sales:control,gql:async(c,q)=>q.includes('AttributionShop')?{shop:{currencyCode:'USD',ianaTimezone:'America/Los_Angeles',primaryDomain:{host:'shop.test'}}}:{order},rest:async()=>({landing_site:'/p?utm_source=redo&utm_contact=secret'}),publish:async p=>{published++;assert.equal(p.p_net,-1001);assert.ok(!JSON.stringify(p).includes('secret'));assert.deepEqual(p.p_orders[0].evidence.order.discountCodes,['TEAM50','PRESTON30'],'the published evidence carries the codes');},commit:true};
await collectDay(conn,day,deps);assert.equal(published,1);
await collectDay(conn,day,{...deps,commit:false});assert.equal(published,1);
await assert.rejects(collectDay(conn,day,{...deps,rest:async()=>{throw Error('interrupted');}}),/interrupted/);assert.equal(published,1);

// A day too large to send in one request stages its evidence in slices and then finalizes the
// day row on its own. 2025-11-27 (8,231 orders) died twice on the single call, so above the
// threshold the whole-day publish must not be attempted at all.
{
 const many=[1,2,3,4,5].map(n=>({day,order_id:String(n),net_sales:'-10.01',total_sales:'-11.02'}));
 const bigControl=[{net_sales:'-50.05',total_sales:'-55.10'}];
 const bigDeps={...deps,ql:async(c,q)=>q.includes('GROUP BY')?many:bigControl,
  gql:async(c,q)=>q.includes('AttributionShop')?{shop:{currencyCode:'USD',ianaTimezone:'America/Los_Angeles',primaryDomain:{host:'shop.test'}}}:{order}};
 let whole=0;const chunks=[];let finalized=null;
 const result=await collectDay(conn,day,{...bigDeps,threshold:2,chunk:2,
  publish:async()=>{whole++;},
  stage:async p=>{chunks.push(p);},
  finalize:async p=>{finalized=p;}});
 assert.equal(whole,0,'a day past the threshold must never attempt the whole-day publish');
 assert.equal(result.staged,true);
 assert.deepEqual(chunks.map(c=>c.p_orders.length),[2,2,1],'evidence goes up in slices of the chunk size');
 assert.deepEqual(chunks.flatMap(c=>c.p_orders.map(o=>o.order_id)),['1','2','3','4','5'],'every order is staged exactly once');
 assert.ok(chunks.every(c=>c.p_extracted===finalized.p_extracted),'one extraction stamp covers the staged day');
 assert.ok(chunks.every(c=>c.p_connection===conn.id&&c.p_day===day),'each chunk names the day it belongs to');
 assert.ok(!('p_orders' in finalized),'the finalize call carries the ledger only, not the evidence');
 assert.equal(finalized.p_ledger.length,5);
 assert.equal(finalized.p_net,-5005);
 assert.ok(!JSON.stringify(chunks).includes('secret'),'staged evidence is sanitized like published evidence');
 // Exactly at the threshold is still a single call: the switch is for days that have been
 // proven undeliverable, and the whole-day path is the one with the track record.
 let atEdge=0,stagedAtEdge=0;
 const edge=await collectDay(conn,day,{...bigDeps,threshold:5,chunk:2,
  publish:async()=>{atEdge++;},stage:async()=>{stagedAtEdge++;},finalize:async()=>{}});
 assert.equal(atEdge,1);assert.equal(stagedAtEdge,0);assert.equal(edge.staged,false);
 // Without the callbacks wired there is no staged path to fall into.
 let legacy=0;
 await collectDay(conn,day,{...bigDeps,threshold:2,publish:async()=>{legacy++;}});
 assert.equal(legacy,1,'a caller that passes no stage/finalize keeps the single call');
}
// Exercise the real shared parser, including its truncation guard.
const originalFetch=globalThis.fetch;
try{
 // CustomerMoment exposes occurredAt, not id; CustomerVisit implements both
 // CustomerMoment and Node. Validate the actual wire query, not a canned gql
 // response which would accept the invalid interface selection from production.
 // https://shopify.dev/docs/api/admin-graphql/2026-07/interfaces/CustomerMoment
 // https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerVisit
 const journeyRequests=[];
 const lastVisit={...visit,id:'v3'};
 globalThis.fetch=async(url,options)=>{
  assert.match(url,/\/admin\/api\/2026-07\/graphql\.json$/);
  const request=JSON.parse(options.body);journeyRequests.push(request);
  assert.match(request.query,/query AttributionJourney\(\$id: ID!, \$after: String\)/);
  assert.match(request.query,/moments\(first:50,after:\$after\)/);
  // One field on the order the journey fetch already asks for: no extra request, no new scope.
  assert.match(request.query,/order\(id:\$id\)\s*\{[^{]*\bdiscountCodes\b/);
  // All three uses must keep __typename outside the concrete-type fragment,
  // with id INSIDE it. The full selection also protects the evidence fields.
  const selections=[...request.query.matchAll(/(?:firstVisit|lastVisit|nodes)\s*\{([^]*?)\}\s*\}/g)];
  assert.equal(selections.length,3);
  for(const [,selection] of selections){
   assert.match(selection,/^\s*__typename\s+\.\.\.\s+on\s+CustomerVisit\s*\{\s*id\s+occurredAt\s+source\s+sourceType\s+landingPage\s+referrerUrl\s+utmParameters\s*\{\s*source\s+medium\s+campaign\s+content\s+term\s*$/);
  }
  const second=request.variables.after!==null;
  assert.deepEqual(request.variables,{id:'gid://shopify/Order/1',after:second?'journey-page-2':null});
  return {status:200,json:async()=>({data:{order:{...order,customerJourneySummary:{
   ready:true,firstVisit:visit,lastVisit,
   moments:{nodes:second?[{...visit,id:'v2'},lastVisit]:[visit],
    pageInfo:{hasNextPage:!second,endCursor:second?null:'journey-page-2'}},
  }}}})};
 };
 const journey=await fetchJourney({...conn,api_version:'2026-07'},'1',{gql:shopifyGraphql});
 assert.equal(journeyRequests.length,2);
 assert.equal(journey.customerJourneySummary.firstVisit.id,'v1');
 assert.equal(journey.customerJourneySummary.lastVisit.id,'v3');
 assert.deepEqual(journey.customerJourneySummary.moments.nodes.map(v=>v.id).sort(),['v1','v2','v3']);
 assert.ok(!JSON.stringify(journey).includes('secret'));
 for(const size of [999,1000]){
  globalThis.fetch=async()=>({status:200,json:async()=>({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:Array.from({length:size},(_,i)=>({order_id:String(i+1),day,net_sales:'0',total_sales:'0'}))}}}})});
  if(size===999)assert.equal((await shopifyql(conn,'FROM sales SHOW net_sales')).length,999);
  else await assert.rejects(shopifyql(conn,'FROM sales SHOW net_sales'),/ceiling/);
 }
 // A 2,549-row launch day is read through the actual shared parser, not bypassed.
 const launch=Array.from({length:2549},(_,i)=>({order_id:String(i+1),day,net_sales:'1.00',total_sales:'1.10'}));
 const offsets=[];
 globalThis.fetch=async(url,options)=>{
  const query=JSON.parse(options.body).variables.q,offset=Number(query.match(/OFFSET (\d+)/)?.[1]||0);offsets.push(offset);
  assert.match(query,/ORDER BY order_id ASC LIMIT 500 OFFSET/);
  return {status:200,json:async()=>({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:launch.slice(offset,offset+500)}}}})};
 };
 const pagedSales=await fetchSalesDay(conn,day,shopifyql);
 assert.equal(pagedSales.length,2549);assert.deepEqual(offsets,[0,500,1000,1500,2000,2500]);
 assert.equal(validateDay(day,pagedSales,[{net_sales:'2549.00',total_sales:'2803.90'}]).net,254900);
}finally{globalThis.fetch=originalFetch;}
await assert.rejects(fetchSalesDay(conn,day,async()=>Object.assign([],{raw:{table_data_was_null:true}})),/Incomplete/);
await assert.rejects(fetchSalesDay(conn,day,async()=>Array(500).fill(sales[0])),/ceiling/);
assert.throws(()=>validateDay(day,[...sales,...sales],control),/identity/);
let unavailablePublished=0;
for(const d of [day,'2026-09-02']){
 await collectDay(conn,d,{...deps,ql:async(c,q)=>q.includes('GROUP BY')?sales.map(r=>({...r,day:d})):control,
  gql:async(c,q)=>q.includes('AttributionShop')?{shop:{currencyCode:'USD',ianaTimezone:'UTC'}}:{order:null},
  rest:async()=>{throw Error('Unavailable order must not fetch landing');},
  publish:async p=>{unavailablePublished++;assert.equal(p.p_net,-1001);assert.equal(p.p_orders[0].evidence.order.evidence_status,'unavailable');assert.ok(!('discountCodes' in p.p_orders[0].evidence.order));}});
}
assert.equal(unavailablePublished,2);
// ---------------------------------------------------------------------------
// Batched collection. A day used to cost two sequential HTTP calls per order
// (4,103 orders = 32 min at a dead-flat 2.13/sec). These tests hold the batched
// path to one standard: it must produce EXACTLY what the serial path produces.
// ---------------------------------------------------------------------------
{
 const visitFor=n=>({id:'v'+n,__typename:'CustomerVisit',occurredAt:'2026-09-01T01:00:00Z',
  source:'https://facebook.com/?email=secret',utmParameters:{source:'facebook',medium:'paid'},
  landingPage:'https://shop.test/p?utm_contact=secret'});
 const ready=n=>({__typename:'Order',id:'gid://shopify/Order/'+n,name:'#'+n,createdAt:'2026-09-01T02:00:00Z',sourceName:'web',
  discountCodes:['TEAM50'],customerJourneySummary:{ready:true,firstVisit:visitFor(n),lastVisit:visitFor(n),
   moments:{nodes:[visitFor(n)],pageInfo:{hasNextPage:false}}}});
 // Order 3 is deeper than the shallow batch page, so the batch must hand it back to the
 // single-order fetch rather than publish a truncated journey.
 const deepFirst=n=>({...ready(n),customerJourneySummary:{ready:true,firstVisit:visitFor(n),lastVisit:visitFor(n),
  moments:{nodes:[visitFor(n)],pageInfo:{hasNextPage:true,endCursor:'deep-page-2'}}}});
 const deepRest=n=>({...ready(n),customerJourneySummary:{ready:true,firstVisit:visitFor(n),lastVisit:visitFor(n+'b'),
  moments:{nodes:[visitFor(n+'b')],pageInfo:{hasNextPage:false}}}});
 const notReady=n=>({...ready(n),customerJourneySummary:{ready:false}});

 const shapes={'1':ready,'2':notReady,'3':deepFirst,'4':()=>null,'5':ready};
 let singleCalls=0,batchCalls=0,deepSingles=0;
 const gql=async(c,q,v)=>{
  if(q.includes('AttributionShop'))return {shop:{currencyCode:'USD',ianaTimezone:'America/Los_Angeles',primaryDomain:{host:'shop.test'}}};
  if(q.includes('AttributionJourneyBatch')){
   batchCalls++;
   return {nodes:v.ids.map(gid=>{const n=gid.split('/').pop();return shapes[n](n);})};
  }
  singleCalls++;
  const n=v.id.split('/').pop();
  if(n==='3'){deepSingles++;return {order:v.after?deepRest(n):deepFirst(n)};}
  return {order:shapes[n](n)};
 };

 // fetchJourneys: every shape handled, and only the deep order costs an extra round trip.
 const got=await fetchJourneys(conn,['1','2','3','4','5'],{gql,moments:1});
 assert.equal(batchCalls,1,'five orders are one request');
 assert.equal(deepSingles,2,'only the deep journey is paged on its own');
 assert.deepEqual([...got.keys()],['1','2','4','5','3'],'every id asked for comes back');
 assert.equal(got.get('2').customerJourneySummary.ready,false,'a journey that is not ready stays not ready');
 assert.equal(got.get('4').evidence_status,'unavailable','an id Shopify will not return is unavailable, never dropped');
 assert.equal(got.get('4').name,'4','an unavailable order is named by the id asked for');
 assert.deepEqual(got.get('3').customerJourneySummary.moments.nodes.map(v=>v.id).sort(),['v3','v3b'],
  'the deep journey is completed, not truncated');
 assert.ok(!JSON.stringify(got).includes('secret'),'batched evidence is sanitized like serial evidence');

 // Repeated visit ids must keep the LAST copy. The page rebuilds a journey with
 // Map.set(), so whichever copy is stored last is the one it shows; storing the first
 // instead would silently change which visit a sale is credited to. The copies here
 // differ in sourceType so keeping the wrong one is visible.
 const repeated={__typename:'Order',id:'gid://shopify/Order/9',name:'#9',createdAt:'2026-09-01T02:00:00Z',
  sourceName:'web',discountCodes:[],customerJourneySummary:{ready:true,
   firstVisit:{...visitFor(9),sourceType:'first-copy'},
   lastVisit:{...visitFor(9),sourceType:'last-copy'},
   moments:{nodes:[{...visitFor(9),sourceType:'middle-copy'}],pageInfo:{hasNextPage:false}}}};
 const deduped=await fetchJourneys(conn,['9'],{gql:async()=>({nodes:[repeated]})});
 const stored=deduped.get('9').customerJourneySummary.moments.nodes;
 assert.equal(stored.length,1,'one visit id is one visit');
 assert.equal(stored[0].sourceType,'last-copy','the last copy of a repeated visit id wins');
 assert.equal(deduped.get('9').customerJourneySummary.lastVisit.sourceType,'last-copy');

 // The batch is matched to ids BY POSITION, so a short or padded answer must be refused
 // rather than silently misattributing one order's journey to another order.
 // A short answer is refused -- and because a failed batch halves itself, the refusal has
 // to survive all the way down to a single id rather than being papered over by a retry
 // that happens to line up.
 const splits=[];
 await assert.rejects(fetchJourneys(conn,['1','2','3','4'],{onSplit:s=>splits.push(s.size),
  gql:async(c,q,v)=>({nodes:v.ids.slice(0,Math.max(0,v.ids.length-1)).map(gid=>shapes['1'](gid.split('/').pop()))})}),/every order/);
 assert.deepEqual(splits,[4,2],'the batch halves before it gives up');
 await assert.rejects(fetchJourneys(conn,['1'],{gql:async()=>({nodes:null})}),/every order/);
 // A node that is not an order at all is a wrong id, not an unmeasured order.
 await assert.rejects(fetchJourneys(conn,['1'],{gql:async()=>({nodes:[{__typename:'Customer',id:'gid://shopify/Customer/1'}]})}),/non-order/);

 // A cost refusal or a throttle must cost speed, not the day. The batch halves until the
 // calls fit, and every order still comes back exactly once.
 const seen=[],halved=[];
 const throttled=await fetchJourneys(conn,['1','2','3','4','5'],{moments:1,onSplit:s=>halved.push(s.size),
  gql:async(c,q,v)=>{
   if(q.includes('AttributionJourneyBatch')){
    seen.push(v.ids.length);
    if(v.ids.length>2)throw Error('Shopify GraphQL: Query cost exceeds limit');
    return {nodes:v.ids.map(gid=>{const n=gid.split('/').pop();return shapes[n](n);})};
   }
   const n=v.id.split('/').pop();
   return {order:n==='3'?(v.after?deepRest(n):deepFirst(n)):shapes[n](n)};
  }});
 assert.deepEqual(halved,[5,3],'only the batches that failed were halved');
 // A batch that throws PART WAY through parsing must leave nothing behind. Order 3 is a
 // deep journey staged before the bad node further down the same answer throws, so a
 // batch that kept its half-parsed work would queue that deep journey twice and pay for
 // it twice.
 {
  let deepPages=0;
  const mixed=await fetchJourneys(conn,['3','bad'],{moments:1,
   gql:async(c,q,v)=>{
    if(q.includes('AttributionJourneyBatch'))return {nodes:v.ids.map(gid=>{
     const n=gid.split('/').pop();
     if(n!=='bad')return deepFirst(n);
     return v.ids.length>1?{__typename:'Customer',id:'gid://shopify/Customer/1'}:ready('bad');
    })};
    const n=v.id.split('/').pop();
    if(n==='3')deepPages++;
    return {order:v.after?deepRest(n):deepFirst(n)};
   }});
  assert.equal(deepPages,2,'the deep journey is paged once, not once per abandoned attempt');
  assert.deepEqual([...mixed.keys()].sort(),['3','bad']);
 }
 assert.deepEqual(seen,[5,3,2,1,2],'it halves down to calls that fit, then stops halving');
 assert.deepEqual([...throttled.keys()].sort(),['1','2','3','4','5'],'every order survives the halving exactly once');
 assert.equal(throttled.get('4').evidence_status,'unavailable');
 assert.deepEqual(throttled.get('3').customerJourneySummary.moments.nodes.map(v=>v.id).sort(),['v3','v3b'],
  'a deep journey inside a halved batch is still completed');
 assert.equal((await fetchJourneys(conn,[],{gql:async()=>{throw Error('no request for an empty batch');}})).size,0);

 // fetchLandingSites: a batch that answers only some ids re-asks the rest one at a time.
 const asked=[];
 const landings=await fetchLandingSites(conn,['1','2','3'],{batch:3,
  restBatch:async(c,ids)=>[{id:1,landing_site:'/a'},{id:'3',landing_site:'/c'}],
  rest:async(c,id)=>{asked.push(id);return {id,landing_site:'/single'};}});
 assert.deepEqual(asked,['2'],'only the id the batch left out is asked for singly');
 assert.equal(landings.get('1').landing_site,'/a');
 assert.equal(landings.get('2').landing_site,'/single');
 assert.equal(landings.get('3').landing_site,'/c','a numeric id and a string id are the same order');
 // A batch that fails entirely degrades to the serial calls, which is today's behaviour.
 const degraded=[];
 await fetchLandingSites(conn,['7','8'],{batch:2,restBatch:async()=>[],rest:async(c,id)=>{degraded.push(id);return {id};}});
 assert.deepEqual(degraded,['7','8'],'a refused batch falls back to every order, losing speed and nothing else');
 // Without a batch callback there is no batched path to fall into.
 const serialOnly=[];
 await fetchLandingSites(conn,['9'],{rest:async(c,id)=>{serialOnly.push(id);return {id};}});
 assert.deepEqual(serialOnly,['9']);

 // THE EQUIVALENCE PROOF. The same fixture day, collected serially and in batches, must
 // publish byte-for-byte the same payload. This is what makes turning batching on a
 // configuration change rather than a rewrite of what a snapshot means.
 const many=['1','2','3','4','5'].map(n=>({day,order_id:n,net_sales:'10.00',total_sales:'11.00'}));
 const dayControl=[{net_sales:'50.00',total_sales:'55.00'}];
 const restCalls={serial:[],batched:[]};
 const base=mode=>({
  ql:async(c,q)=>q.includes('GROUP BY')?many:dayControl,
  gql,
  rest:async(c,id)=>{restCalls[mode].push(id);return {id,landing_site:'/p?utm_source=redo&utm_contact=secret'};},
  commit:true,
 });
 let serialPayload=null,batchedPayload=null;
 await collectDay(conn,day,{...base('serial'),publish:async p=>{serialPayload=p;}});
 await collectDay(conn,day,{...base('batched'),journeyBatch:5,landingBatch:5,journeyMoments:1,
  restBatch:async(c,ids)=>ids.map(id=>({id,landing_site:'/p?utm_source=redo&utm_contact=secret'})),
  publish:async p=>{batchedPayload=p;}});
 const comparable=p=>({...p,p_extracted:'stamp'});
 assert.deepEqual(comparable(batchedPayload),comparable(serialPayload),
  'batched collection publishes exactly what serial collection publishes');
 assert.equal(batchedPayload.p_orders.length,5);
 assert.deepEqual(batchedPayload.p_orders.map(o=>o.order_id),['1','2','3','4','5'],'ledger order survives batching');
 // Order 4 is unavailable, so its landing site must never be asked for -- in either mode.
 assert.ok(!restCalls.serial.includes('4')&&!restCalls.batched.includes('4'),
  'an unavailable order is never asked for a landing site');
 assert.equal(batchedPayload.p_orders[3].evidence.order.evidence_status,'unavailable');
 assert.ok(!JSON.stringify(batchedPayload).includes('secret'));
}

// ---------------------------------------------------------------------------
// The day row ceiling. 2025-11-28 (9,916 orders) failed on OUR bound, not on a
// refusal from Shopify, so the bound is a parameter -- but the penny
// reconciliation stays the thing that decides whether a day may publish.
// ---------------------------------------------------------------------------
{
 const big=Array.from({length:10500},(_,i)=>({order_id:String(i+1),day,net_sales:'1.00',total_sales:'1.00'}));
 const ql=async(c,q)=>{const offset=Number(q.match(/OFFSET (\d+)/)?.[1]||0);return big.slice(offset,offset+500);};
 await assert.rejects(fetchSalesDay(conn,day,ql),/ceiling of 10000/,'the default ceiling is unchanged');
 const all=await fetchSalesDay(conn,day,ql,{maxRows:20000});
 assert.equal(all.length,10500,'a raised ceiling pages the whole day');
 assert.equal(validateDay(day,all,[{net_sales:'10500.00',total_sales:'10500.00'}],{maxRows:20000}).net,1050000);
 // What makes raising the ceiling safe: a day whose rows do not add up to its own control
 // total cannot publish, however many rows were read.
 assert.throws(()=>validateDay(day,all,[{net_sales:'10499.00',total_sales:'10500.00'}],{maxRows:20000}),/mismatch/);
 // And deep paging that silently repeats a window is caught as an identity failure.
 assert.throws(()=>validateDay(day,[...all,all[0]],[{net_sales:'10501.00',total_sales:'10501.00'}],{maxRows:20000}),/identity/);
}
// ---------------------------------------------------------------------------
// Incremental refresh. The nightly coverage run re-collects the trailing seven
// days IN FULL, so a 4,000-order-a-day store re-read ~28,000 orders a night to
// learn almost nothing. Reuse changes what is FETCHED and nothing else: the day
// still publishes evidence for every order, because both publish functions
// refuse a day that is missing any.
// ---------------------------------------------------------------------------
{
 const ago=h=>new Date(Date.parse('2026-09-02T00:00:00Z')-h*3600000).toISOString();
 const now='2026-09-02T00:00:00Z';
 const storedRow=(over={})=>({fetched_at:ago(24),evidence:{
  order:{id:'gid://shopify/Order/1',name:'#1',sourceName:'web',discountCodes:['TEAM50'],
   customerJourneySummary:{ready:true,firstVisit:{id:'v1'},lastVisit:{id:'v1'},moments:{nodes:[{id:'v1'}],pageInfo:{hasNextPage:false}}}},
  raw:{landing_path:'/p',tracking:{utm_source:'redo'},landing_truncated:false},
  own_hosts:['stale.example'],allocations:{stale:true}},...over});

 // reusableEvidence: each refusal is a case where the evidence could have moved.
 assert.equal(reusableEvidence(storedRow(),now,7),true);
 assert.equal(reusableEvidence(undefined,now,7),false,'nothing stored is nothing to reuse');
 assert.equal(reusableEvidence({fetched_at:ago(24),evidence:null},now,7),false);
 assert.equal(reusableEvidence({fetched_at:ago(24),evidence:[]},now,7),false,'an array is not an evidence object');
 for (const missing of ['order','raw']) {
  const row=storedRow(); delete row.evidence[missing];
  assert.equal(reusableEvidence(row,now,7),false,'a row missing '+missing+' is re-fetched, not trusted');
 }
 {
  const row=storedRow(); row.evidence.order.evidence_status='unavailable';
  assert.equal(reusableEvidence(row,now,7),false,'an unavailable order may since have become readable');
 }
 {
  const row=storedRow(); row.evidence.order.customerJourneySummary={ready:false};
  assert.equal(reusableEvidence(row,now,7),false,'a pending journey is what a refresh is FOR');
 }
 {
  const row=storedRow(); row.evidence.order.customerJourneySummary=null;
  assert.equal(reusableEvidence(row,now,7),false);
 }
 assert.equal(reusableEvidence(storedRow({fetched_at:'not-a-date'}),now,7),false);
 assert.equal(reusableEvidence(storedRow({fetched_at:undefined}),now,7),false);
 assert.equal(reusableEvidence(storedRow({fetched_at:ago(-1)}),now,7),false,'a stamp in the future bounds nothing');
 assert.equal(reusableEvidence(storedRow({fetched_at:ago(24*8)}),now,7),false,'past the age bound it is read again');
 assert.equal(reusableEvidence(storedRow({fetched_at:ago(24*8)}),now,9),true);
 // Zero days admits nothing, which is why it is the off switch: planReuse refuses to plan
 // at all at 0, and the predicate would refuse every row anyway.
 assert.equal(reusableEvidence(storedRow(),now,0),false);
 assert.equal(reusableEvidence(storedRow({fetched_at:now}),now,0),true,'only a read taken this instant is zero days old');

 // planReuse: the decision, and what it costs.
 const stored=new Map([['1',storedRow()],['2',storedRow()],['3',storedRow({fetched_at:ago(24*30)})]]);
 let changeCalls=0,askedAbout=null;
 const deps=changes=>({storedEvidence:async()=>stored,
  orderChanges:async ids=>{changeCalls++;askedAbout=ids;return new Map(ids.map(id=>[id,changes[id]??ago(48)]));},
  extracted:now,maxAgeDays:7});
 {
  changeCalls=0;
  const plan=await planReuse(['1','2','3','4'],deps({}));
  assert.deepEqual([...plan.keys()],['1','2'],'only orders unchanged since their stored read are reused');
  assert.deepEqual(askedAbout,['1','2'],'order 3 is past the age bound and 4 has nothing stored, so neither is asked about');
  assert.equal(changeCalls,1);
 }
 {
  // Touched in Shopify AFTER we stored it: fetch it.
  const plan=await planReuse(['1','2'],deps({'1':ago(2)}));
  assert.deepEqual([...plan.keys()],['2'],'an order touched since the stored read is fetched again');
 }
 {
  // Shopify did not answer for it. Not knowing whether it moved is not knowing it did not.
  const plan=await planReuse(['1','2'],{...deps({}),orderChanges:async()=>new Map([['2',ago(48)]])});
  assert.deepEqual([...plan.keys()],['2'],'an order Shopify did not answer for is never assumed unchanged');
 }
 {
  // Off by default, and off costs no request at all.
  let touched=0;
  const off=await planReuse(['1'],{storedEvidence:async()=>{touched++;return stored;},orderChanges:async()=>{touched++;return new Map();},extracted:now,maxAgeDays:0});
  assert.equal(off.size,0);assert.equal(touched,0,'reuse off reads nothing and asks nothing');
 }
 {
  // A day with nothing stored -- a first collection, or a manual backfill -- must not pay
  // for the change pass.
  let asked=0;
  const fresh=await planReuse(['9'],{storedEvidence:async()=>new Map(),orderChanges:async()=>{asked++;return new Map();},extracted:now,maxAgeDays:7});
  assert.equal(fresh.size,0);assert.equal(asked,0,'nothing stored means nothing to ask Shopify about');
 }
 for (const broken of [
  {storedEvidence:async()=>{throw Error('database refused');},orderChanges:async()=>new Map()},
  {storedEvidence:async()=>stored,orderChanges:async()=>{throw Error('Shopify refused');}},
 ]) {
  const notes=[];
  const plan=await planReuse(['1','2'],{...broken,extracted:now,maxAgeDays:7,onReuse:n=>notes.push(n)});
  assert.equal(plan.size,0,'reuse that cannot be planned costs speed, not the day');
  assert.match(notes[0].unavailable,/refused/,'and it says so rather than looking like nothing to reuse');
 }

 // THE INTEGRATED GUARANTEE. A refreshed day must publish exactly what a full collection
 // publishes -- same orders, same ledger, same money -- while fetching only what changed.
 const visit=n=>({id:'v'+n,__typename:'CustomerVisit',occurredAt:'2026-09-01T01:00:00Z',source:'https://x.test/',utmParameters:{}});
 const live=n=>({__typename:'Order',id:'gid://shopify/Order/'+n,name:'#'+n,createdAt:'2026-09-01T02:00:00Z',sourceName:'web',
  discountCodes:['TEAM50'],customerJourneySummary:{ready:true,firstVisit:visit(n),lastVisit:visit(n),
   moments:{nodes:[visit(n)],pageInfo:{hasNextPage:false}}}});
 const three=['1','2','3'].map(n=>({day,order_id:n,net_sales:'10.00',total_sales:'11.00'}));
 const threeControl=[{net_sales:'30.00',total_sales:'33.00'}];
 const fetched={full:[],partial:[]};
 const base=mode=>({
  ql:async(c,q)=>q.includes('GROUP BY')?three:threeControl,
  gql:async(c,q,v)=>{
   if(q.includes('AttributionShop'))return {shop:{currencyCode:'USD',ianaTimezone:'UTC',primaryDomain:{host:'shop.test'}}};
   const ids=q.includes('Batch')?v.ids:[v.id];
   for(const gid of ids)fetched[mode].push(gid.split('/').pop());
   return q.includes('Batch')?{nodes:ids.map(g=>live(g.split('/').pop()))}:{order:live(v.id.split('/').pop())};
  },
  rest:async(c,id)=>({id,landing_site:'/p?utm_source=redo'}),
  decorate:e=>({channel:e.order.customerJourneySummary?.firstVisit?.id ?? 'none'}),
  commit:true,journeyBatch:3,landingBatch:3,
  restBatch:async(c,ids)=>ids.map(id=>({id,landing_site:'/p?utm_source=redo'})),
  // The extraction stamp is what the age bound is measured against, so the fixture has to
  // own the clock or the stored rows read as months old.
  now:()=>now,
 });
 let fullPayload=null,partialPayload=null,note=null;
 await collectDay(conn,day,{...base('full'),publish:async p=>{fullPayload=p;}});
 // Orders 1 and 2 are stored, unchanged and young; 3 is not stored at all.
 const storedTwo=new Map([['1',{fetched_at:ago(24),evidence:{...fullPayload.p_orders[0].evidence,own_hosts:['stale.example'],allocations:{stale:true}}}],
                          ['2',{fetched_at:ago(24),evidence:{...fullPayload.p_orders[1].evidence,own_hosts:['stale.example'],allocations:{stale:true}}}]]);
 const result=await collectDay(conn,day,{...base('partial'),
  reuseMaxAgeDays:7,storedEvidence:async()=>storedTwo,
  orderChanges:async ids=>new Map(ids.map(id=>[id,ago(48)])),
  onReuse:n=>{note=n;},
  publish:async p=>{partialPayload=p;}});
 assert.deepEqual(fetched.full,['1','2','3'],'a full collection fetches every order');
 assert.deepEqual(fetched.partial,['3'],'a refresh fetches only the order it has nothing good for');
 assert.equal(result.reused,2,'and reports how many it stood on');
 assert.deepEqual(note,{orders:3,stored:2,candidates:2,reused:2});
 const comparable=p=>({...p,p_extracted:'stamp'});
 assert.deepEqual(comparable(partialPayload),comparable(fullPayload),
  'a refreshed day publishes exactly what a full collection publishes');
 // Specifically: the whole ledger is still there, which is what the publish functions
 // require ("Missing order evidence"), and the two things that must NOT be reused were
 // rebuilt rather than carried over from the stored row.
 assert.deepEqual(partialPayload.p_orders.map(o=>o.order_id),['1','2','3']);
 assert.equal(partialPayload.p_ledger.length,3);
 assert.equal(partialPayload.p_net,3000);
 for (const o of partialPayload.p_orders) {
  assert.ok(!o.evidence.own_hosts.includes('stale.example'),'own_hosts is rebuilt from the shop as it is now');
  assert.notDeepEqual(o.evidence.allocations,{stale:true},'allocations are re-derived against today\'s catalog');
  assert.equal(o.evidence.allocations.channel,'v'+o.order_id);
 }
}
console.log('Attribution evidence: integrated failure paths, unavailable reversals, actual shared 999/1000 boundary, batched/serial equivalence, the day row ceiling and incremental refresh passed');
