import assert from 'node:assert/strict';
import {collectDay,fetchJourney,fetchSalesDay,validateDay,landingEvidence,dayRange,sanitizeDiscountCodes} from '../lib/shopify-attribution-evidence.mjs';
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
await assert.rejects(fetchSalesDay(conn,day,async()=>Array(500).fill(sales[0])),/cap/);
assert.throws(()=>validateDay(day,[...sales,...sales],control),/identity/);
let unavailablePublished=0;
for(const d of [day,'2026-09-02']){
 await collectDay(conn,d,{...deps,ql:async(c,q)=>q.includes('GROUP BY')?sales.map(r=>({...r,day:d})):control,
  gql:async(c,q)=>q.includes('AttributionShop')?{shop:{currencyCode:'USD',ianaTimezone:'UTC'}}:{order:null},
  rest:async()=>{throw Error('Unavailable order must not fetch landing');},
  publish:async p=>{unavailablePublished++;assert.equal(p.p_net,-1001);assert.equal(p.p_orders[0].evidence.order.evidence_status,'unavailable');assert.ok(!('discountCodes' in p.p_orders[0].evidence.order));}});
}
assert.equal(unavailablePublished,2);
console.log('Attribution evidence: integrated failure paths, unavailable reversals and actual shared 999/1000 boundary passed');
