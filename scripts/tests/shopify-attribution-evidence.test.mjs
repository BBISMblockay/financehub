import assert from 'node:assert/strict';
import {collectDay,fetchJourney,fetchSalesDay,validateDay,landingEvidence,dayRange} from '../lib/shopify-attribution-evidence.mjs';
import {shopifyql} from '../lib/shopify-sync-core.mjs';
const day='2026-09-01',conn={id:'c',shop_domain:'test.myshopify.com'};
const visit={id:'v1',__typename:'CustomerVisit',occurredAt:'2026-09-01T01:00:00Z',source:'https://facebook.com/?email=secret',utmParameters:{source:'facebook',medium:'paid'},landingPage:'https://shop.test/p?utm_contact=secret'};
const order={id:'gid://shopify/Order/1',name:'#1',createdAt:'2026-09-01T02:00:00Z',sourceName:'web',customerJourneySummary:{ready:true,firstVisit:visit,lastVisit:visit,moments:{nodes:[visit],pageInfo:{hasNextPage:false}}}};
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
let calls=0;
const paged=await fetchJourney(conn,'1',{gql:async()=>{calls++;return {order:{...order,customerJourneySummary:{...order.customerJourneySummary,moments:{nodes:[],pageInfo:{hasNextPage:calls===1,endCursor:'next'}}}}};}});
assert.equal(calls,2);assert.equal(paged.customerJourneySummary.moments.nodes.length,1);
assert.ok(!JSON.stringify(paged).includes('secret'));
await assert.rejects(fetchJourney(conn,'1',{gql:async()=>({order:{...order,customerJourneySummary:{...order.customerJourneySummary,moments:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}})}),/advance/);
let published=0;
const deps={ql:async(c,q)=>q.includes('GROUP BY')?sales:control,gql:async(c,q)=>q.includes('AttributionShop')?{shop:{currencyCode:'USD',ianaTimezone:'America/Los_Angeles',primaryDomain:{host:'shop.test'}}}:{order},rest:async()=>({landing_site:'/p?utm_source=redo&utm_contact=secret'}),publish:async p=>{published++;assert.equal(p.p_net,-1001);assert.ok(!JSON.stringify(p).includes('secret'));},commit:true};
await collectDay(conn,day,deps);assert.equal(published,1);
await collectDay(conn,day,{...deps,commit:false});assert.equal(published,1);
await assert.rejects(collectDay(conn,day,{...deps,rest:async()=>{throw Error('interrupted');}}),/interrupted/);assert.equal(published,1);
// Exercise the real shared parser, including its truncation guard.
const originalFetch=globalThis.fetch;
try{
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
  publish:async p=>{unavailablePublished++;assert.equal(p.p_net,-1001);assert.equal(p.p_orders[0].evidence.order.evidence_status,'unavailable');}});
}
assert.equal(unavailablePublished,2);
console.log('Attribution evidence: integrated failure paths, unavailable reversals and actual shared 999/1000 boundary passed');
