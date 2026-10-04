// Runs the actual deployment index + handler under Node, mocking only fetch/env.
// No request reaches a live service and no credential is loaded.
// Mutation: ONBOARDING_HANDLER_MUTATION=false-success|no-body-limit|trust-origin|no-honeypot
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../../', import.meta.url);
let source = await readFile(new URL('supabase/functions/onboarding-interest/handler.ts',root),'utf8');
const mutation=process.env.ONBOARDING_HANDLER_MUTATION||'';
const swaps={
  'false-success': ['if (!result.ok) return reply({ error: UNAVAILABLE }, 503);','if (!result.ok) return reply({ ok: true }, 200);'],
  'no-body-limit':['if (bytes > MAX_BODY_BYTES) throw new InputError(413);','if (false) throw new InputError(413);'],
  'trust-origin':['const allowed = ALLOWED_ORIGINS.has(origin);','const allowed = true;'],
  'no-honeypot':["if (row.website !== undefined && (typeof row.website !== 'string' || row.website !== '')) throw new InputError(400);",''],
};
if(mutation){assert.ok(swaps[mutation]);const [a,b]=swaps[mutation];assert.ok(source.includes(a));source=source.replace(a,b);}
const {createHandler}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const index=await readFile(new URL('supabase/functions/onboarding-interest/index.ts',root),'utf8');
assert.match(index,/import \{ createHandler \} from '\.\/handler\.ts'/);
const ORIGIN='https://get-silo.com';
const input={name:'  Alex Example  ',company_name:'  Example Co  ',email:'  ALEX@Example.COM  ',website:''};
const accepted=()=>Response.json({accepted:true,retry_after_seconds:0});
function fixture(response=accepted, config={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-secret'}){
  const calls=[]; let handler;
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(...args)=>{calls.push(args);return response(...args);};
  try {
    // The index is executed exactly as deployed; Deno.serve is the only seam.
    new Function('Deno','createHandler', index.replace(/^import[^\n]*\n/,''))({
      env:{get:key=>config[key]},serve:fn=>{handler=fn;},
    },createHandler);
  } finally {globalThis.fetch=realFetch;}
  assert.equal(typeof handler,'function');
  return {handler,calls};
}
function request(body=input,{origin=ORIGIN,method='POST',headers={},raw=false}={}){
  return new Request('https://fixture.supabase.co/functions/v1/onboarding-interest',{
    method,headers:{...(origin?{origin}:{}),'content-type':'application/json',...headers},
    ...(method==='POST'?{body:raw?body:JSON.stringify(body)}:{}),
  });
}
let passed=0;
async function test(name,fn){await fn();console.log(`ok ${++passed} - ${name}`);}
await test('deployed index normalizes fields, posts one RPC, and returns only generic persisted success',async()=>{
  const {handler,calls}=fixture(); const response=await handler(request());
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(calls.length,1);
  const [url,opts]=calls[0];assert.equal(url,'https://fixture.supabase.co/rest/v1/rpc/submit_onboarding_interest');
  const body=JSON.parse(opts.body);assert.deepEqual(Object.keys(body).sort(),['p_company_name','p_email','p_email_key','p_name']);
  assert.equal(body.p_name,'Alex Example');assert.equal(body.p_company_name,'Example Co');assert.equal(body.p_email,'alex@example.com');
  assert.match(body.p_email_key,/^[a-f0-9]{64}$/);assert.ok(!body.p_email_key.includes('alex'));
  assert.equal(opts.headers.Authorization,'Bearer fixture-secret');assert.equal(opts.headers.apikey,'fixture-secret');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
});
await test('duplicates use same response and the same keyed digest; IP headers never reach the database',async()=>{
  const {handler,calls}=fixture();const first=await handler(request());
  const second=await handler(request({...input,name:'Changed'},{headers:{'x-forwarded-for':'1.2.3.4','cf-connecting-ip':'5.6.7.8'}}));
  assert.equal(await first.text(),await second.text());
  assert.deepEqual(Object.keys(JSON.parse(calls[1][1].body)).sort(),['p_company_name','p_email','p_email_key','p_name']);
  assert.equal(JSON.parse(calls[0][1].body).p_email_key,JSON.parse(calls[1][1].body).p_email_key);
  assert.doesNotMatch(calls[1][1].body,/1\.2\.3\.4|5\.6\.7\.8/);
});
await test('exact official origins preflight content-type and apikey; other/missing origins refused without persistence',async()=>{
  const {handler,calls}=fixture();
  for(const origin of [ORIGIN,'https://www.get-silo.com','https://silo-baseballism.com']){
    const res=await handler(request(null,{origin,method:'OPTIONS',headers:{'access-control-request-headers':'content-type,apikey'}}));
    assert.equal(res.status,204);assert.equal(res.headers.get('Access-Control-Allow-Origin'),origin);
    assert.match(res.headers.get('Access-Control-Allow-Headers'),/apikey/);
  }
  for(const origin of ['https://evil.test','https://get-silo.com.evil.test','http://get-silo.com','null','']){
    const res=await handler(request(input,{origin}));assert.equal(res.status,403);assert.equal(res.headers.get('Access-Control-Allow-Origin'),null);
  }
  assert.equal(calls.length,0);
});
await test('only JSON POST; GET/PUT and other media types are honest errors',async()=>{
  const {handler,calls}=fixture();
  for(const method of ['GET','PUT'])assert.equal((await handler(request(null,{method}))).status,405);
  assert.equal((await handler(request('x',{raw:true,headers:{'content-type':'text/plain'}}))).status,415);
  assert.equal(calls.length,0);
});
await test('honeypot rejects without claiming persistence',async()=>{
  const {handler,calls}=fixture();
  for(const website of ['https://bot.test',' ',null,false]){
    const res=await handler(request({...input,website}));assert.equal(res.status,400);assert.equal((await res.json()).ok,undefined);
  }
  assert.equal(calls.length,0);
});
await test('bounded schema validation handles hostile and malformed inputs',async()=>{
  const {handler,calls}=fixture();
  const bad=[null,[],{},true,{...input,email:42},{...input,name:''},{...input,name:'x'.repeat(121)},
    {...input,company_name:'x'.repeat(201)},{...input,email:'x'.repeat(255)},
    {...input,email:'invalid'},{...input,email:'a..b@example.com'},{...input,email:'x@-example.com'},
    {...input,email:'a@one'},{...input,email:'a@'+'x'.repeat(64)+'.com'},
    {...input,name:'Hello\nWorld'},{...input,name:'bad\u200bname'}, {...input,status:'approved'},{...input,source:'other'}];
  for(const body of bad)assert.equal((await handler(request(body))).status,400,JSON.stringify(body));
  assert.equal((await handler(request('{broken',{raw:true}))).status,400);
  assert.equal(calls.length,0);
});
await test('boundary name/company lengths and optional absent honeypot remain valid',async()=>{
  const {handler}=fixture();
  assert.equal((await handler(request({name:'x'.repeat(120),company_name:'x'.repeat(200),email:'x@example.com'}))).status,200);
});
await test('declared or actual streamed bodies above 4 KiB are refused, including false content-length',async()=>{
  const {handler,calls}=fixture();
  assert.equal((await handler(request(input,{headers:{'content-length':'999999'}}))).status,413);
  const large=JSON.stringify({...input,name:'x'.repeat(5000)});
  assert.equal((await handler(request(large,{raw:true,headers:{'content-length':'0'}}))).status,413);
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(' '.repeat(4096)));controller.enqueue(new TextEncoder().encode('{}'));controller.close();}});
  const streamed=new Request('https://fixture.supabase.co/functions/v1/onboarding-interest',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body,duplex:'half'});
  assert.equal((await handler(streamed)).status,413);assert.equal(calls.length,0);
});
await test('missing environment, DB rejection, invalid result and network failures never report success or leak details',async()=>{
  for(const response of [()=>new Response('secret database error lead@example.com',{status:500}),()=>{throw new Error('fixture-secret')},()=>new Response('{broken'),()=>Response.json(null),()=>Response.json({accepted:true}),()=>Response.json({accepted:false,retry_after_seconds:-1})]){
    const {handler}=fixture(response);const res=await handler(request());assert.equal(res.status,503);
    const text=await res.text();assert.doesNotMatch(text,/fixture-secret|lead@example|database error|"ok"/);
  }
  const missing=fixture(accepted,{});assert.equal((await missing.handler(request())).status,503);assert.equal(missing.calls.length,0);
});
await test('database quota response is 429 with Retry-After and no duplicate information',async()=>{
  const {handler}=fixture(()=>Response.json({accepted:false,retry_after_seconds:42}));
  const res=await handler(request());assert.equal(res.status,429);assert.equal(res.headers.get('Retry-After'),'42');
  assert.deepEqual(await res.json(),{error:'Please wait before trying again.'});
});
await test('untrusted slow body has a finite read deadline and no persistence',async()=>{
  const {handler,calls}=fixture();
  const body=new ReadableStream({start(){}});
  const req=new Request('https://fixture.supabase.co/functions/v1/onboarding-interest',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body,duplex:'half'});
  assert.equal((await handler(req)).status,408);assert.equal(calls.length,0);
});
console.log(`${passed} deployed-path handler checks passed`);
