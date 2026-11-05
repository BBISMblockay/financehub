// The speed probe reads a live shop to answer three questions the faster collector
// depends on. It must stay read-only, must refuse to run alongside a snapshot range, and
// must never put an order, a visit, a URL or a token in its output -- these tests hold it
// to all three, and check that the batched query it measures is the SAME selection the
// collector will use.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runPlanProbe,planProbeMain,batchJourneyQuery,probeSalesPaging,probeJourneyBatch,probeLandingBatch} from '../shopify-attribution-plan-probe.mjs';
import {journeyVisitFields} from '../lib/shopify-attribution-evidence.mjs';

const day='2025-11-28';
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-key',
 ATTRIBUTION_CONNECTION_ID:'00000000-0000-4000-8000-000000000001',
 ATTRIBUTION_MODE:'manual',ATTRIBUTION_COMMIT:'false',ATTRIBUTION_PROBE_PLAN_DAY:day};
const connection={id:env.ATTRIBUTION_CONNECTION_ID,shop_domain:'TEST.myshopify.com',
 access_token:'private-token',auth_method:'client_credentials',token_expires_at:'2026-10-07T08:00:00Z',
 is_active:true,sync_enabled:true};
const now=Date.parse('2026-10-07T05:00:00Z');

// The probe must read ONE column list from ONE table and never reach a write.
function client(row=connection,error=null) {
 return (url,key,options)=>{
  assert.equal(url,env.SUPABASE_URL);assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(options,{auth:{persistSession:false,autoRefreshToken:false}});
  return {from(table){assert.equal(table,'shopify_connections');return {
   select(fields){assert.equal(fields,'id,shop_domain,access_token,auth_method,token_expires_at,is_active,sync_enabled');return {
    eq(column,id){assert.equal(column,'id');assert.equal(id,env.ATTRIBUTION_CONNECTION_ID);return {
     async single(){return {data:row,error};},
    };},
   };},
  };}};
 };
}

// The batched query must carry the collector's own visit selection, not a second
// spelling of it: a drift between the measured query and the shipped query would make
// the measurement meaningless.
assert.ok(batchJourneyQuery(10).includes(journeyVisitFields),'the probe measures the collector selection');
assert.match(batchJourneyQuery(10),/nodes\(ids: \$ids\)/);
assert.match(batchJourneyQuery(7),/moments\(first:7,after:\$after\)/);
assert.match(batchJourneyQuery(10),/\.\.\. on Order \{ id name createdAt sourceName discountCodes/);

// --- sales paging ---------------------------------------------------------------
{
 // A day larger than the collector's own 10,000-row bound: the probe exists to say
 // whether Shopify keeps serving rows past it.
 const rows=Array.from({length:10500},(_,i)=>({order_id:String(i+1),day,net_sales:'1.00',total_sales:'1.00'}));
 const queries=[];
 const ql=async(c,q)=>{
  queries.push(q);
  if(!q.includes('GROUP BY'))return [{net_sales:'10500.00',total_sales:'10500.00'}];
  const offset=Number(q.match(/OFFSET (\d+)/)?.[1]||0);
  return rows.slice(offset,offset+500);
 };
 const result=await probeSalesPaging(connection,day,{ql,maxRows:20000});
 assert.equal(result.distinct_orders,10500,'the probe walks past the collector bound');
 assert.equal(result.duplicate_rows,0);
 assert.equal(result.stopped_at_offset,10500,'it reports where Shopify ran out');
 assert.equal(result.hit_probe_bound,false);
 assert.equal(result.control_rows,1);
 assert.ok(queries.every(q=>q.includes(day)),'every query is scoped to the probe day');
 assert.ok(queries.some(q=>q.includes('OFFSET 10000')),'the offset past the bound is actually asked for');

 // A shop that silently repeats a window must be reported as repeating it, because that
 // is exactly the failure that would otherwise look like a bigger day.
 const stuck=await probeSalesPaging(connection,day,{maxRows:2000,
  ql:async(c,q)=>q.includes('GROUP BY')?rows.slice(0,500):[{net_sales:'1',total_sales:'1'}]});
 assert.equal(stuck.distinct_orders,500);
 assert.ok(stuck.duplicate_rows>0,'repeated rows are counted, not quietly de-duplicated');

 // A null table is a refusal, not an empty day.
 const nulled=await probeSalesPaging(connection,day,{maxRows:2000,
  ql:async()=>Object.assign([],{raw:{table_data_was_null:true}})});
 assert.equal(nulled.pages,1);
 assert.equal(nulled.page_shape[0].table_data_was_null,true);

 // Reaching the probe's own bound must be distinguishable from the shop running out.
 const bounded=await probeSalesPaging(connection,day,{maxRows:1000,
  ql:async(c,q)=>q.includes('GROUP BY')?rows.slice(Number(q.match(/OFFSET (\d+)/)?.[1]||0),Number(q.match(/OFFSET (\d+)/)?.[1]||0)+500):[{net_sales:'1',total_sales:'1'}]});
 assert.equal(bounded.hit_probe_bound,true);
}

// --- journey batch cost --------------------------------------------------------
{
 const order=n=>({__typename:'Order',id:'gid://shopify/Order/'+n,name:'#'+n,createdAt:'2025-11-28T01:00:00Z',
  sourceName:'web',discountCodes:['TEAM50'],
  customerJourneySummary:{ready:true,
   firstVisit:{id:'v'+n,__typename:'CustomerVisit',occurredAt:'2025-11-28T00:00:00Z',source:'https://facebook.com/?email=secret',utmParameters:{}},
   lastVisit:{id:'v'+n,__typename:'CustomerVisit',occurredAt:'2025-11-28T00:00:00Z',source:'https://facebook.com/?email=secret',utmParameters:{}},
   moments:{nodes:[{id:'v'+n,__typename:'CustomerVisit',occurredAt:'2025-11-28T00:00:00Z',source:'https://facebook.com/?email=secret',utmParameters:{}}],pageInfo:{hasNextPage:false}}}});
 const ids=Array.from({length:50},(_,i)=>String(i+1));
 const sizes=[];
 const originalFetch=globalThis.fetch;
 try {
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,'https://test.myshopify.com/admin/api/2026-07/graphql.json');
   assert.equal(options.headers['X-Shopify-Access-Token'],'private-token');
   const {query,variables}=JSON.parse(options.body);
   assert.match(query,/^query AttributionJourneyBatch/);
   sizes.push(variables.ids.length);
   return {status:200,json:async()=>({
    data:{nodes:variables.ids.map(gid=>order(gid.split('/').pop()))},
    extensions:{cost:{requestedQueryCost:variables.ids.length*12,actualQueryCost:variables.ids.length*11,
     throttleStatus:{maximumAvailable:2000,currentlyAvailable:1800,restoreRate:100}}},
   })};
  };
  const {attempts,fidelity}=await probeJourneyBatch({...connection,shop_domain:'test.myshopify.com'},ids,
   {sizes:[5,10],moments:3,gql:async()=>({order:order('1')})});
  assert.deepEqual(attempts.map(a=>a.size),[5,10]);
  assert.deepEqual(attempts.map(a=>a.returned),[5,10]);
  assert.equal(attempts[1].cost.requested,120,'the cost Shopify reported is what gets reported');
  assert.equal(attempts[1].cost.maximum,2000);
  assert.equal(attempts[0].ready,5);
  assert.equal(attempts[0].needs_more_pages,0);
  assert.equal(fidelity.checked,true);
  assert.equal(fidelity.identical,true,'the batched shape equals the serial shape for the same order');
  assert.deepEqual(sizes,[5,10,1],'the fidelity check costs one more single-id request');

  // A query Shopify rejects must stop the sweep rather than keep asking for bigger batches.
  globalThis.fetch=async()=>({status:200,json:async()=>({data:null,errors:[{message:'Query cost exceeds limit'}]})});
  const refused=await probeJourneyBatch({...connection,shop_domain:'test.myshopify.com'},ids,
   {sizes:[5,10,25],gql:async()=>({order:order('1')})});
  assert.equal(refused.attempts.length,1,'one refusal ends the sweep');
  assert.match(refused.attempts[0].errors[0],/cost/);
 } finally { globalThis.fetch=originalFetch; }
}

// --- landing batch -------------------------------------------------------------
{
 const originalFetch=globalThis.fetch;
 try {
  const urls=[];
  globalThis.fetch=async(url,options)=>{
   urls.push(url);
   assert.equal(options.headers['X-Shopify-Access-Token'],'private-token');
   // Answer one id short, which is the failure mode that would lose evidence.
   return {ok:true,status:200,json:async()=>({orders:[{id:1,landing_site:'/a?email=secret'},{id:2,landing_site:null}]})};
  };
  const {attempts}=await probeLandingBatch({...connection,shop_domain:'test.myshopify.com'},['1','2','3'],{sizes:[3]});
  assert.equal(attempts[0].returned,2);
  assert.equal(attempts[0].missing,1,'an id the batch left out is counted');
  assert.equal(attempts[0].non_null_landing_site,1);
  assert.match(urls[0],/orders\.json\?ids=1,2,3&fields=id,landing_site&limit=3&status=any/,
   'cancelled and archived orders are included, or their evidence would vanish');

  globalThis.fetch=async()=>({ok:false,status:400,json:async()=>({})});
  const refused=await probeLandingBatch({...connection,shop_domain:'test.myshopify.com'},['1','2'],{sizes:[2,250]});
  assert.equal(refused.attempts.length,1);
  assert.equal(refused.attempts[0].status,400);
 } finally { globalThis.fetch=originalFetch; }
}

// --- input guards ---------------------------------------------------------------
for (const [bad,reason] of [
 [{ATTRIBUTION_PROBE_PLAN_DAY:''},/probe day/],
 [{ATTRIBUTION_PROBE_PLAN_DAY:'2025-11-31'},/probe day/],
 [{ATTRIBUTION_PROBE_PLAN_DAY:'yesterday'},/probe day/],
 [{ATTRIBUTION_MODE:'scheduled'},/manual mode/],
 [{ATTRIBUTION_COMMIT:'true'},/manual mode/],
 [{ATTRIBUTION_START:'2025-11-01'},/manual mode/],
 [{ATTRIBUTION_END:'2025-11-30'},/manual mode/],
 [{SUPABASE_SERVICE_ROLE_KEY:''},/secrets/],
 [{ATTRIBUTION_CONNECTION_ID:'not-a-uuid'},/secrets/],
]) {
 await assert.rejects(runPlanProbe({...env,...bad},{createClient:client(),now}),reason,JSON.stringify(bad));
}
// A connection that is not collectable, or whose token is gone or near expiry, stops the
// probe BEFORE any Shopify call: the probe must never refresh a credential.
for (const [row,reason] of [
 [{...connection,is_active:false},/Active sync-enabled/],
 [{...connection,sync_enabled:false},/Active sync-enabled/],
 [{...connection,shop_domain:'not a domain'},/Shopify domain/],
 [{...connection,access_token:null},/token missing/],
 [{...connection,token_expires_at:'2026-10-07T05:00:00Z'},/token missing/],
 [{...connection,token_expires_at:'not-a-date'},/token missing/],
]) {
 await assert.rejects(runPlanProbe(env,{createClient:client(row),now}),reason,JSON.stringify(row.shop_domain));
}
await assert.rejects(runPlanProbe(env,{createClient:client(null,{message:'denied'}),now}),/Active sync-enabled/);

// --- redaction ------------------------------------------------------------------
{
 const output=[];
 const log=console.log,error=console.error;
 console.log=line=>output.push(String(line));console.error=line=>output.push(String(line));
 try {
  // A real upstream failure must not leak the token, the shop or the customer data in it.
  const code=await planProbeMain(env,{createClient:client(),
   ql:async()=>{throw Error('fetch failed for private-token at https://test.myshopify.com?email=secret');},
   now});
  assert.equal(code,1);
 } finally { console.log=log;console.error=error; }
 const text=output.join('');
 assert.ok(!text.includes('private-token'),'no token in the output');
 assert.ok(!text.includes('secret'),'no customer data in the output');
 assert.ok(JSON.parse(output[0]).committed===false,'the probe always reports that it wrote nothing');
 assert.match(JSON.parse(output[0]).reason,/no writes performed/);
}
// A guard failure names the guard, because that one the operator has to fix.
{
 const output=[];
 const error=console.error;
 console.error=line=>output.push(String(line));
 try { assert.equal(await planProbeMain({...env,ATTRIBUTION_COMMIT:'true'},{createClient:client(),now}),1); }
 finally { console.error=error; }
 assert.match(JSON.parse(output[0]).reason,/manual mode/);
}

// The probe is wired into the same read-only workflow gate as the one-order probe.
const workflow=readFileSync(new URL('../../.github/workflows/shopify-attribution.yml',import.meta.url),'utf8');
assert.match(workflow,/if: inputs.probe_plan_day != ''/);
assert.match(workflow,/if: inputs.probe_order_id == '' && inputs.probe_plan_day == ''\s+run: node scripts\/shopify-attribution-sync.mjs/);
console.log('Attribution speed probe: collector selection, deep paging, batch cost, landing gaps, input guards and redacted failures passed');
