import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
let source=await readFile(new URL('../../supabase/functions/quickbooks-report/index.ts',import.meta.url),'utf8');
source=stripTypeScriptTypes(source.replace(/import \{ createClient \} from 'https:[^']+';/,''),{mode:'strip'});
async function call(connection_id){let handler;const requests=[],writes=[];
 const records={profiles:[{id:'user',active_company_id:'company',is_active:true}],entity_memberships:[{user_id:'user',entity_id:'company',role:'member'}],quickbooks_connections:[
  {id:'first',company_entity_id:'company',realm_id:'first-realm',is_active:true},
  {id:'selected',company_entity_id:'company',realm_id:'selected-realm',is_active:true},
  {id:'foreign',company_entity_id:'other-company',realm_id:'foreign-realm',is_active:true},
  {id:'inactive',company_entity_id:'company',realm_id:'inactive-realm',is_active:false},
 ].map(r=>({...r,environment:'sandbox',access_token:'synthetic',token_expires_at:'2099-01-01'}))};
 const db={auth:{getUser:async()=>({data:{user:{id:'user'}}})},from(table){let filters=[];let insert;return {select(){return this},eq(k,v){filters.push([k,v]);return this},limit(){return this},insert(v){writes.push(v);insert=v;return this},single(){return this},maybeSingle(){return this},then(resolve){const row=insert?{id:'run',fetched_at:'2026-09-12'}:(records[table]||[]).find(r=>filters.every(([k,v])=>r[k]===v));return Promise.resolve({data:row||null,error:null}).then(resolve);}};}};
 vm.runInNewContext(source,{createClient:()=>db,Deno:{env:{get:()=>''},serve:fn=>handler=fn},Response,Request,URLSearchParams,Date,console,fetch:async(url,opts)=>{requests.push({url,method:opts?.method||'GET'});return new Response(JSON.stringify({Header:{ReportName:'TrialBalance'},Rows:{Row:[]}}),{status:200});}});
 const response=await handler(new Request('https://synthetic.test',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({connection_id,report_name:'TrialBalance',params:{end_date:'2026-08-31'}})}));
 return {status:response.status,body:await response.json(),requests,writes};
}
test('selected QBO connection reaches the actual read-only report fetch and stored provenance',async()=>{const r=await call('selected');assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.requests[0].url.includes('/company/selected-realm/reports/TrialBalance'));assert.equal(r.requests[0].method,'GET');assert.equal(r.writes[0].connection_id,'selected');});
test('foreign and inactive connections never reach QBO',async()=>{for(const id of ['foreign','inactive']){const r=await call(id);assert.equal(r.status,404);assert.equal(r.requests.length,0);}});
