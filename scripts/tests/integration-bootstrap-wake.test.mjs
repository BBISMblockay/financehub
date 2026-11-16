import assert from 'node:assert/strict';
import { createHandler, githubDispatcher } from '../../supabase/functions/integration-bootstrap-wake/handler.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const job = { id, integration: 'meta_ads', status: 'pending' };
const request = (body = {job_id:id}) => new Request('https://local/wake', {method:'POST', headers:{Authorization:'Bearer test'}, body:JSON.stringify(body)});
function setup({visible=job, admin=true, reserved=true, reserveError=null, dispatchError=false, configured=true, auth=true}={}) {
  const calls=[];
  const service={auth:{getUser:async()=>({data:{user:auth?{}:null}})},rpc:async(name)=>{calls.push(name);return {data:reserved,error:reserveError};}};
  const userClientFor=()=>({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:visible})})})}),rpc:async()=>({data:admin})});
  const dispatch=configured?async(jobId)=>{calls.push(jobId);if(dispatchError)throw Error('bad');}:null;
  return {handle:createHandler({service,userClientFor,dispatch}),calls};
}
for (const [options,status] of [[{auth:false},401],[{visible:null},404],[{admin:false},403],[{visible:{...job,integration:'shopify'}},400],[{configured:false},503],[{reserveError:{message:'missing'}},503],[{dispatchError:true},503]]) {
  const x=setup(options); assert.equal((await x.handle(request())).status,status);
  if(status===401||status===404||status===403||status===400)assert.equal(x.calls.length,0);
}
let x=setup(); let r=await x.handle(request());assert.equal(r.status,202);assert.deepEqual(x.calls,['reserve_bootstrap_dispatch',id]);
x=setup({reserved:false});r=await x.handle(request());assert.equal((await r.json()).requested,false);assert.equal(x.calls.length,1);
x=setup({visible:{...job,status:'running'}});assert.equal((await (await x.handle(request())).json()).status,'running');assert.equal(x.calls.length,0);
x=setup();assert.equal((await x.handle(request({job_id:'evil'}))).status,400);assert.equal(x.calls.length,0);
let sent;
await githubDispatcher({token:'test-secret',fetchImpl:async(url,opts)=>{sent={url,opts};return {status:204};}})(id);
assert.equal(sent.url,'https://api.github.com/repos/BBISMblockay/financehub/actions/workflows/integration-bootstrap.yml/dispatches');
assert.deepEqual(JSON.parse(sent.opts.body),{ref:'main',inputs:{job_id:id,max_jobs:'1'}});
assert.equal(githubDispatcher({token:''}),null);
await assert.rejects(()=>githubDispatcher({token:'t',fetchImpl:async()=>({status:403})})(id),/HTTP 403/);
console.log('integration-bootstrap-wake: auth, tenant visibility, throttling, configuration and fixed dispatch checks pass');
