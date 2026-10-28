import assert from 'node:assert/strict';
import {runAppend,config,digest} from '../shopify-attribution-append.mjs';
const company='00000000-0000-0000-0000-000000000001',connection='00000000-0000-0000-0000-000000000003';
const env={SUPABASE_URL:'https://invalid.test',SUPABASE_SERVICE_ROLE_KEY:'test-only',ATTRIBUTION_COMPANY_ID:company,ATTRIBUTION_CONNECTION_ID:connection,ATTRIBUTION_SHOP_DOMAIN:'test.myshopify.com',ATTRIBUTION_START:'2026-01-01',ATTRIBUTION_END:'2026-01-01',ATTRIBUTION_STAGE_DIR:'/private-stage'};
function fixture({snapshot=true,unknown=false,invalid=false,rows=1}={}) {
 const files=new Map(),calls=[],writes=[];let rpcCalls=0;
 const ids=Array.from({length:rows},(_,i)=>String(i+1));
 const db={from(table){const filters={};const q={select(){return q;},eq(k,v){filters[k]=v;return q;},in(k,v){filters[k]=v;return q;},order(){return q;},range(){return q;},single(){return q;},maybeSingle(){return q;},then(resolve){
  if(table!=='shopify_connections')assert.equal(filters.company_entity_id,company,'every database read is tenant scoped');
  let data=[];
  if(table==='shopify_connections')data={id:connection,company_entity_id:company,shop_domain:'test.myshopify.com',access_token:'never-print',is_active:true,sync_enabled:true};
  if(table==='shopify_attribution_days')data=snapshot?{day:'2026-01-01',ledger:ids.map(order_id=>({order_id,net_cents:100,total_cents:100}))}:null;
  if(table==='shopify_attribution_orders')data=filters.order_id.map(order_id=>({order_id,evidence:{order:{}}}));
  return Promise.resolve(resolve({data,error:null}));}};return q;},rpc(name,args){rpcCalls++;assert.equal(name,'append_shopify_attribution');assert.equal(args.p_company,company);return Promise.resolve({data:{status:'applied'},error:null});}};
 const deps={createClient:()=>db,now:()=>Date.parse('2026-10-28T12:00:00Z'),log:()=>{},makeDir:async()=>{},
  read:async path=>{if(!files.has(path))throw Object.assign(Error('missing'),{code:'ENOENT'});return files.get(path);},
  write:async(path,bytes,opts)=>{if(opts.flag==='wx'&&files.has(path))throw Error('overwrite');files.set(path,bytes);writes.push(path);},
  gql:async(c,query,vars)=>{calls.push(query);assert.equal(c.access_token,'never-print');
   if(query.includes('AdditivePreflight'))return{shop:{myshopifyDomain:'test.myshopify.com',ianaTimezone:'UTC'},currentAppInstallation:{accessScopes:['read_orders','read_all_orders','read_reports'].map(handle=>({handle}))}};
   if(query.includes('AttributionShop'))return{shop:{currencyCode:'USD',ianaTimezone:'UTC',primaryDomain:{host:'test.com'}}};
   if(query.includes('AdditiveCodes'))return{order:unknown?null:{id:vars.id,discountCodes:invalid?null:['RE-TEST']}};
   return{order:{id:vars.id,name:'#1',createdAt:'2026-01-01T12:00:00Z',sourceName:'web',discountCodes:[],customerJourneySummary:null}};
  },ql:async(c,q)=>q.includes('GROUP BY')?[{day:'2026-01-01',order_id:'1',net_sales:'1.00',total_sales:'1.00'}]:[{net_sales:'1.00',total_sales:'1.00'}],
  fetcher:async()=>({ok:true,json:async()=>({order:{landing_site:'/'}})})};
 return{deps,files,calls,writes,get rpcCalls(){return rpcCalls;}};
}
assert.throws(()=>config({...env,ATTRIBUTION_COMMIT:'false'}),/Legacy/);
assert.throws(()=>config({...env,ATTRIBUTION_START:'2026-01-01',ATTRIBUTION_END:'2026-03-01'}),/31/);
let f=fixture();const staged=await runAppend(env,f.deps);
assert.equal(f.rpcCalls,0,'stage is database read-only');assert.equal(staged.length,1);
const artifact=JSON.parse(f.files.get(staged[0].file));assert.deepEqual(artifact.payload.orders[0].discount_codes,['RE-TEST']);
const calls=f.calls.length;await runAppend(env,f.deps);assert.equal(f.calls.length,calls+1,'resume only checks live scopes, does not refetch codes');
const apply={...env,ATTRIBUTION_APPEND_MODE:'apply',ATTRIBUTION_STAGE_FILE:staged[0].file,ATTRIBUTION_STAGE_SHA256:staged[0].sha256};
await runAppend(apply,f.deps);assert.equal(f.rpcCalls,1);
await assert.rejects(runAppend({...apply,ATTRIBUTION_STAGE_SHA256:'0'.repeat(64)},f.deps),/digest/);
await assert.rejects(runAppend({...apply,ATTRIBUTION_COMPANY_ID:'00000000-0000-0000-0000-000000000002'},f.deps),/scope/);
f=fixture({unknown:true});await runAppend(env,f.deps);assert.equal(JSON.parse([...f.files.values()][0]).payload.orders[0].discount_codes,null);
f=fixture({invalid:true});await assert.rejects(runAppend(env,f.deps),/Invalid Shopify/);assert.equal(f.files.size,0);
f=fixture();await assert.rejects(runAppend({...env,ATTRIBUTION_MAX_REQUESTS:'1'},f.deps),/workload/);assert.equal(f.files.size,0);
f=fixture({rows:101});await assert.rejects(runAppend({...env,ATTRIBUTION_MAX_REQUESTS:'101'},f.deps),/workload/);
assert.equal(f.files.size,1,'completed 100-order batch survives later budget exhaustion');
const firstFile=[...f.files.keys()][0],firstBytes=f.files.get(firstFile);
await runAppend({...env,ATTRIBUTION_MAX_REQUESTS:'3'},f.deps);
assert.equal(f.files.size,2);assert.equal(f.files.get(firstFile),firstBytes,'resume never rewrites a staged batch');
// Run the actual shared collector wiring, not a stubbed collector.
f=fixture({snapshot:false});await runAppend({...env,ATTRIBUTION_APPEND_KIND:'day'},f.deps);
const dayArtifact=JSON.parse([...f.files.values()][0]);assert.equal(dayArtifact.payload.net_cents,100);assert.ok(dayArtifact.payload.orders[0].evidence.allocations);assert.equal(f.rpcCalls,0);
assert.ok(f.calls.some(q=>q.includes('AttributionJourney')));
// Apply failure creates an explicit uncertain receipt; same artifact stays replayable.
const failed=fixture();failed.files.set('/file',JSON.stringify({...dayArtifact,payload:{...dayArtifact.payload,collected_at:'2026-10-28T12:00:00Z'}}));
const create=failed.deps.createClient;failed.deps.createClient=()=>({...create(),rpc:async()=>{throw Error('network secret response');}});
await assert.rejects(runAppend({...env,ATTRIBUTION_APPEND_MODE:'apply',ATTRIBUTION_STAGE_FILE:'/file',ATTRIBUTION_STAGE_SHA256:digest(failed.files.get('/file'))},failed.deps),/uncertain/);
assert.equal(JSON.parse(failed.files.get('/file.attempt.json')).status,'failed_or_uncertain');
assert.ok(!failed.files.get('/file.attempt.json').includes('secret'));
console.log('Additive attribution CLI: real collector, dry staging, resume, bounds, scope, digest and uncertain apply passed');
