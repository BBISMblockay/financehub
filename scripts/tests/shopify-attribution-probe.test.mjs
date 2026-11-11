import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runAttributionProbe,probeMain} from '../shopify-attribution-probe.mjs';

const now=Date.parse('2026-10-07T05:00:00Z');
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-key',
 ATTRIBUTION_CONNECTION_ID:'00000000-0000-4000-8000-000000000001',
 ATTRIBUTION_MODE:'manual',ATTRIBUTION_COMMIT:'false',ATTRIBUTION_PROBE_ORDER_ID:'123'};
const connection={id:env.ATTRIBUTION_CONNECTION_ID,shop_domain:'TEST.myshopify.com',
 access_token:'private-token',auth_method:'client_credentials',token_expires_at:'2026-10-07T08:00:00Z',
 is_active:true,sync_enabled:true};
let reads=0,requests=0;
function client(row=connection,error=null) {
 return (url,key,options)=>{
  assert.equal(url,env.SUPABASE_URL);assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(options,{auth:{persistSession:false,autoRefreshToken:false}});
  // No update, insert, rpc or credential-table access exists on this client.
  return {from(table){assert.equal(table,'shopify_connections');return {
   select(fields){assert.equal(fields,'id,shop_domain,access_token,auth_method,token_expires_at,is_active,sync_enabled');return {
    eq(column,id){assert.equal(column,'id');assert.equal(id,env.ATTRIBUTION_CONNECTION_ID);return {
     async single(){reads++;return {data:row,error};},
    };},
   };},
  };}};
 };
}
const originalFetch=globalThis.fetch;
try {
 globalThis.fetch=async(url,options)=>{
  requests++;
  assert.equal(url,'https://test.myshopify.com/admin/api/2026-07/graphql.json');
  assert.equal(options.method,'POST');
  assert.equal(options.headers['X-Shopify-Access-Token'],'private-token');
  const {query,variables}=JSON.parse(options.body);
  assert.match(query,/^query AttributionJourney/);
  assert.match(query,/nodes\s*\{\s*__typename\s+\.\.\. on CustomerVisit \{ id/);
  assert.equal(variables.id,'gid://shopify/Order/123');
  assert.equal(variables.after,requests===1?null:'next');
  return {status:200,json:async()=>({data:{order:{id:variables.id,name:'private-name',
   customerJourneySummary:{ready:true,firstVisit:null,lastVisit:null,
    moments:{nodes:[{id:'visit-'+requests,__typename:'CustomerVisit',source:'private-source'}],
     pageInfo:{hasNextPage:requests===1,endCursor:'next'}}}}}})};
 };
 const result=await runAttributionProbe(env,{createClient:client(),now});
 assert.deepEqual(result,{status:'success',mode:'one_order_probe',orders:1,api_version:'2026-07',ready:true,visits:2,committed:false});
 assert.equal(reads,1);assert.equal(requests,2);
} finally {globalThis.fetch=originalFetch;}

for(const changes of [{ATTRIBUTION_PROBE_ORDER_ID:''},{ATTRIBUTION_PROBE_ORDER_ID:'123,456'},
 {ATTRIBUTION_PROBE_ORDER_ID:'gid://shopify/Order/123'},{ATTRIBUTION_COMMIT:'true'},
 {ATTRIBUTION_COMMIT:'TRUE'},{ATTRIBUTION_MODE:'scheduled'},{ATTRIBUTION_START:'2026-09-01'},
 {ATTRIBUTION_END:'2026-09-01'},{ATTRIBUTION_CONNECTION_ID:'not-a-uuid'},{SUPABASE_SERVICE_ROLE_KEY:''}]) {
 let accessed=false;
 await assert.rejects(runAttributionProbe({...env,...changes},{createClient:()=>{accessed=true;throw Error('must not access');},now}));
 assert.equal(accessed,false);
}
for(const changes of [{access_token:''},{token_expires_at:null},{token_expires_at:'bad'},
 {token_expires_at:'2026-10-07T04:59:00Z'},{token_expires_at:'2026-10-07T05:00:01Z'},
 {auth_method:'oauth',token_expires_at:'2026-10-07T04:59:00Z'},
 {is_active:false},{sync_enabled:false},{shop_domain:'evil.example'}]) {
 let queried=false;
 await assert.rejects(runAttributionProbe(env,{createClient:client({...connection,...changes}),now,gql:async()=>{queried=true;throw Error('must not query');}}));
 assert.equal(queried,false);
}
await assert.rejects(runAttributionProbe(env,{createClient:client(null,{message:'private'}),now}),/Active/);
for(const order of [null,{id:'gid://shopify/Order/123',customerJourneySummary:null},
 {id:'gid://shopify/Order/123',customerJourneySummary:{ready:false}}]) {
 await assert.rejects(runAttributionProbe(env,{createClient:client(),now,gql:async()=>({order})}),/unavailable|not ready/i);
}
let pages=0;
await assert.rejects(runAttributionProbe(env,{createClient:client(),now,gql:async()=>({order:{
 id:'gid://shopify/Order/123',customerJourneySummary:{ready:true,moments:{nodes:[],pageInfo:{hasNextPage:true,endCursor:String(++pages)}}},
}})}),/pagination limit/);
assert.equal(pages,10);
const log=console.log,error=console.error,output=[];
try {
 console.log=console.error=line=>output.push(line);
 assert.equal(await probeMain(env,{createClient:client(),now,gql:async()=>{throw Error('private-token private-name');}}),1);
 assert.equal(await probeMain({...env,ATTRIBUTION_COMMIT:'true'},{createClient:client(),now}),1);
 assert.ok(!output.join('').includes('private'));
 assert.ok(output.every(line=>JSON.parse(line).committed===false));
} finally {console.log=log;console.error=error;}

const workflow=readFileSync(new URL('../../.github/workflows/shopify-attribution.yml',import.meta.url),'utf8');
const preflight=workflow.match(/node --input-type=module <<'NODE'\n([^]*?)\n\s+NODE/)[1];
assert.ok(workflow.indexOf(preflight)<workflow.indexOf('- run: npm ci'));
for(const [inputs,valid] of [
 [{ATTRIBUTION_PROBE_ORDER_ID:''},false],
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_START:'2026-09-01'},false],
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_START:'2026-09-30',ATTRIBUTION_END:'2026-09-01'},false],
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_START:'2026-09-01',ATTRIBUTION_END:'2026-09-30'},true],
 [{ATTRIBUTION_PROBE_ORDER_ID:'123'},true],
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_MODE:'scheduled'},true],
 // The speed probe takes a day of its own and no snapshot range, so the preflight must
 // let it through with blank dates exactly as the one-order probe is let through.
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_PROBE_PLAN_DAY:'2025-11-28'},true],
 [{ATTRIBUTION_PROBE_ORDER_ID:'',ATTRIBUTION_PROBE_PLAN_DAY:''},false],
]) {
 const result=spawnSync(process.execPath,['--input-type=module'],{input:preflight,encoding:'utf8',
  cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...env,...inputs}});
 assert.equal(result.status===0,valid,result.stderr);
}
assert.match(workflow,/ATTRIBUTION_PROBE_ORDER_ID: \$\{\{ inputs.probe_order_id \}\}/);
assert.match(workflow,/if: inputs.probe_order_id != ''\s+timeout-minutes: 10\s+run: node scripts\/shopify-attribution-probe.mjs/);
assert.match(workflow,/ATTRIBUTION_PROBE_PLAN_DAY: \$\{\{ inputs.probe_plan_day \}\}/);
assert.match(workflow,/if: inputs.probe_plan_day != ''\s+timeout-minutes: 20\s+run: node scripts\/shopify-attribution-plan-probe.mjs/);
// Collecting must be gated on BOTH probes being blank, or a probe dispatch would also
// collect and write the very day it was meant to measure read-only.
assert.match(workflow,/if: inputs.probe_order_id == '' && inputs.probe_plan_day == ''\s+run: node scripts\/shopify-attribution-sync.mjs/);
const coverage=readFileSync(new URL('../../.github/workflows/shopify-attribution-coverage.yml',import.meta.url),'utf8');
// The batch sizes must reach the job, or the speedup is dead code in production.
for(const name of ['ATTRIBUTION_JOURNEY_BATCH','ATTRIBUTION_JOURNEY_MOMENTS','ATTRIBUTION_LANDING_BATCH','ATTRIBUTION_MAX_DAY_ROWS','ATTRIBUTION_REUSE_MAX_AGE_DAYS']){
 // A dispatch input overrides the repo variable, so a size can be timed on ONE day,
 // read-only, before it is turned on for every run. Without the override the only way to
 // try a batch size would be to change it for production first.
 const input=name.replace('ATTRIBUTION_','').toLowerCase();
 assert.ok(workflow.includes(name+': ${{ inputs.'+input+' || vars.'+name+' }}'),
  name+' must be overridable per dispatch and otherwise read from the variable');
 assert.match(workflow,new RegExp('\\n      '+input+':\\n'),input+' must be a dispatch input');
 // The nightly coverage run is where a large store's cost actually lives, so the same
 // sizes have to reach that job too or only manual backfills get faster.
 assert.ok(coverage.includes(name+': ${{ vars.'+name+' }}'),name+' must be passed to the coverage job');
}
// The incremental refresh exists for the nightly run above all, so its sizing must reach
// the coverage job even though it has no dispatch inputs of its own.
assert.ok(coverage.includes('ATTRIBUTION_CHANGE_BATCH: ${{ vars.ATTRIBUTION_CHANGE_BATCH }}'));
assert.ok(workflow.includes('ATTRIBUTION_CHANGE_BATCH: ${{ vars.ATTRIBUTION_CHANGE_BATCH }}'));
// The catch-up budget is what decides how many nights a newly enrolled store needs before its
// history is whole, so it has to reach the nightly job. It is coverage-only on purpose: the manual
// dispatch path takes an explicit date range and never consults a per-run historical budget.
assert.ok(coverage.includes('ATTRIBUTION_GAP_DAYS: ${{ vars.ATTRIBUTION_GAP_DAYS }}'),
 'the catch-up budget must be passed to the coverage job');
assert.ok(!workflow.includes('ATTRIBUTION_GAP_DAYS'),'the manual dispatch has no historical budget');
const ci=readFileSync(new URL('../../.github/workflows/attribution-tests.yml',import.meta.url),'utf8');
assert.ok(ci.includes('node scripts/tests/shopify-attribution-probe.test.mjs'));
assert.ok(ci.includes('node scripts/tests/shopify-attribution-plan-probe.test.mjs'),'the speed probe is covered in CI');
console.log('Attribution probe: one order, read-only client, no refresh, bounded pages, input guards and redacted failures passed');
