// Real PostgreSQL authorization + real MCP handler + synthetic external source.
// Auth signature verification is a PostgREST fixture; all grant/company/scope,
// MFA, RLS, resolver and path checks execute the repository's actual SQL.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const mutation=process.env.WINDSOR_LIVE_MUTATION || '';
const mutations=['identity','tail','reauthorize','scope','rls','published','default','client-execute','idle-touch','idle-predicate','resolver-publication','verify-activity','rollup-cap','rollup-nonadditive','rollup-blank','range-limit'];
assert.ok(!mutation || mutations.includes(mutation),'known mutation');
function replaceOnce(text,from,to){assert.ok(text.includes(from),'mutation target exists');return text.replace(from,to);}
const temp=mkdtempSync(`${tmpdir()}/windsor-live-`);
process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
cpSync('supabase/functions/mcp',`${temp}/mcp`,{recursive:true});
cpSync('supabase/functions/windsor-broker',`${temp}/windsor-broker`,{recursive:true});
let provider=readFileSync(`${temp}/mcp/windsor-live.mjs`,'utf8');
if(mutation==='identity') provider=replaceOnce(provider,'if (foreign || unattributed)','if (false)');
if(mutation==='tail') provider=replaceOnce(provider,'filterRowsToAccount(rows,','filterRowsToAccount(rows.slice(0, 200),');
if(mutation==='rollup-cap') provider=replaceOnce(provider,'if (rolled && rows.length >= sourceCap)','if (false)');
if(mutation==='rollup-nonadditive') provider=replaceOnce(provider,'return !NON_ADDITIVE.test(` ${label} `);','return true;');
if(mutation==='rollup-blank') provider=replaceOnce(provider,'measures.map(m => [m, null])','measures.map(m => [m, 0])');
if(mutation==='range-limit') provider=replaceOnce(provider,'> LIVE_RANGE_MAX_DAYS)','> 100000)');
writeFileSync(`${temp}/mcp/windsor-live.mjs`,provider);
let handlerSource=readFileSync(`${temp}/mcp/handler.mjs`,'utf8');
if(mutation==='reauthorize') handlerSource=replaceOnce(handlerSource,"const again = await callRpc(authorization, 'silo_api_windsor_connections', {p_connection_id:args.connection_id,p_offset:0});","const again = scoped;");
writeFileSync(`${temp}/mcp/handler.mjs`,handlerSource);
const {createMcpHandler}=await import(pathToFileURL(`${temp}/mcp/handler.mjs`));
import { LIVE_BYTE_LIMIT } from '../../supabase/functions/mcp/windsor-live.mjs';
const db = new PGlite();
const A='00000000-0000-4000-a000-00000000000a', B='00000000-0000-4000-a000-00000000000b';
const USER='00000000-0000-4000-b000-000000000001', SESSION='00000000-0000-4000-b000-000000000002';
const CA='00000000-0000-4000-c000-000000000001', CB='00000000-0000-4000-c000-000000000002', OFF='00000000-0000-4000-c000-000000000003';
const KEY='synthetic-owner-key-never-disclose';
const BASE='https://test.supabase.co';
const claims={sub:USER,session_id:SESSION,client_id:'app',role:'silo_integration',silo_company_id:B,silo_scopes:['data:read']};
const token=`Bearer ${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;
const origin=readFileSync('supabase/migrations/20261020030000_developer_api_integration_access.sql','utf8');
function definition(name, source=origin) {
  const start=source.indexOf(`create or replace function public.${name}(`); assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('$$;',source.indexOf('as $$',start))+3);
}
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create role silo_api_exec; create role silo_integration noinherit; create role silo_revoked noinherit;
grant authenticated to silo_api_exec;
create schema auth; create table auth.users(id uuid primary key);
insert into auth.users values('${USER}');
create table auth.mfa_factors(user_id uuid,status text);
create function auth.uid() returns uuid language sql as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
`);
await db.exec(`
create function auth.jwt() returns jsonb language sql as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
create table entities(id uuid primary key); insert into entities values('${A}'),('${B}');
create table profiles(id uuid primary key,active_company_id uuid); insert into profiles values('${USER}','${B}');
create table entity_memberships(user_id uuid,entity_id uuid); insert into entity_memberships values('${USER}','${A}'),('${USER}','${B}');
create table silo_api_grants(id uuid primary key default gen_random_uuid(),client_id text,user_id uuid,company_entity_id uuid,auth_session_id uuid,scopes text[],revoked_at timestamptz,expires_at timestamptz,consented_aal text,consented_at timestamptz not null default now(),last_used_at timestamptz,updated_at timestamptz not null default now());
insert into silo_api_grants(client_id,user_id,company_entity_id,auth_session_id,scopes,expires_at,consented_aal)
 values('app','${USER}','${A}','${SESSION}',array['reports:read','data:read'],now()+interval '1 day','aal2');
create function is_admin_user() returns boolean language sql as $$ select coalesce(nullif(current_setting('test.is_admin',true),''),'false')::boolean $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create table silo_chat_schema_catalog(relname text primary key,is_hidden boolean default false,reportable boolean default false);
create function refresh_chat_schema_catalog() returns void language sql as $$
 insert into silo_chat_schema_catalog(relname) values('windsor_links'),('windsor_linked_accounts') on conflict do nothing $$;
`);
for (const name of ['silo_api_claims','silo_api_is_integration','silo_api_grant','active_company_id','mfa_session_satisfied','silo_api_require_scope','silo_api_path_allowed','silo_check_request']) await db.exec(definition(name));
// Use the CURRENT idle-aware resolver/touch implementation, not the original
// pre-idle grant definition. Keep the real touch ACL: only the API executor.
let idle=readFileSync('supabase/migrations/20261028070000_developer_api_idle_disconnect.sql','utf8');
if(mutation==='idle-predicate') idle=replaceOnce(idle,'and coalesce(g.last_used_at, g.consented_at) > now() - public.silo_api_idle_window()','');
for(const name of ['silo_api_idle_window','silo_api_grant','silo_api_touch_grant']) await db.exec(definition(name,idle));
await db.exec(`revoke all on function silo_api_touch_grant() from public,anon,authenticated,silo_integration,silo_revoked;
grant execute on function silo_api_touch_grant() to silo_api_exec;`);
await db.exec(readFileSync('supabase/migrations/20261102220000_windsor_connections.sql','utf8'));
let migration=readFileSync('supabase/migrations/20261103210000_windsor_live_mcp.sql','utf8')
 + readFileSync('supabase/migrations/20261103230000_windsor_live_mcp_activity.sql','utf8');
if(mutation==='idle-touch') migration=replaceOnce(migration,'perform public.silo_api_touch_grant();','');
if(mutation==='scope') migration=migration.replaceAll("perform public.silo_api_require_scope('data:read');",'');
if(mutation==='rls') migration=replaceOnce(migration,'using (company_entity_id = (select public.active_company_id()) and mcp_enabled)','using (true)');
if(mutation==='resolver-publication') migration=migration.replaceAll(' and a.mcp_enabled','').replaceAll('where company_entity_id=v_company and mcp_enabled','where company_entity_id=v_company');
if(mutation==='published') migration=migration.replaceAll(' and a.mcp_enabled','').replaceAll(' and mcp_enabled','');
if(mutation==='default') migration=replaceOnce(migration,'not null default false','not null default true');
if(mutation==='client-execute') migration=migration.replaceAll('to silo_integration;','to silo_integration,authenticated;');
await db.exec(migration); await db.exec(migration);
await db.exec(`
insert into windsor_links(id,company_entity_id,access_token) values('${CA}','${A}','token-a'),('${CB}','${B}','token-b');
insert into windsor_linked_accounts(id,company_entity_id,link_id,ds_id,account_id,account_name,mcp_enabled) values
 ('${CA}','${A}','${CA}','klaviyo','account-a','A connector',true),
 ('${CB}','${B}','${CB}','klaviyo','account-b','B connector',true),
 ('${OFF}','${A}','${CA}','youtube','unpublished','Not published',false);
`);
let calls=[], mode='valid', expectedAccount='account-a';
const fields=[{id:'account_id',type:'TEXT'},{id:'date',type:'DATE'},{id:'subject',name:'Subject',type:'TEXT'},{id:'value',type:'NUMERIC'},{id:'rate',type:'PERCENT'},{id:'unique_users',name:'Unique users',type:'NUMERIC'}];
async function rpcFetch(url,init) {
  assert.equal(init.headers.Authorization,token,'fixture signature/issuer verification');
  assert.equal(init.headers.apikey,'anon-key');
  const path=new URL(url).pathname;
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.path',$2,true)",[JSON.stringify(claims),path.replace('/rest/v1','')]);
    await db.exec('set local role silo_integration');
    await db.query('select silo_check_request()');
    const body=JSON.parse(init.body);
    assert.equal(path,'/rest/v1/rpc/silo_api_windsor_connections');
    const r=await db.query('select silo_api_windsor_connections($1::uuid,$2::integer) as j',[body.p_connection_id,body.p_offset]);
    await db.exec('commit'); return new Response(JSON.stringify(r.rows[0].j));
  } catch(e) { await db.exec('rollback'); return new Response(JSON.stringify({code:e.code,message:e.message}),{status:403}); }
}
async function fetchImpl(url,init) {
  const u=new URL(url);
  if(u.origin===BASE) return rpcFetch(url,init);
  calls.push({url:u,init});
  assert.equal(u.origin,'https://connectors.windsor.ai'); assert.equal(init.method,'GET'); assert.equal(init.redirect,'error');
  if(u.pathname.endsWith('/fields')) {
    assert.equal(u.searchParams.has('api_key'),false);
    return new Response(JSON.stringify(mode==='no-identity-field'?fields.slice(1):fields));
  }
  assert.equal(u.pathname,'/klaviyo'); assert.equal(u.searchParams.get('api_key'),KEY);
  assert.equal(u.searchParams.get('select_accounts'),expectedAccount);
  if(mode==='transport') throw new Error('transport leak '+url);
  if(mode==='vendor-error') return new Response(KEY+' '+url,{status:500});
  if(mode==='oversize') return new Response('x',{headers:{'content-length':String(LIVE_BYTE_LIMIT+1)}});
  if(mode==='revoke') await db.exec("update silo_api_grants set revoked_at=now()");
  if(mode==='unpublish') await db.exec(`update windsor_linked_accounts set mcp_enabled=false where id='${CA}'`);
  let rows=[{account_id:expectedAccount,date:'2026-11-01',subject:'First text',value:1},
    {account_id:expectedAccount,date:'2026-11-01',subject:'Second text',value:2}];
  if(mode==='mixed') rows.push({...rows[0],account_id:'account-b',subject:'B secret'});
  if(mode==='missing') rows=[{date:'2026-11-01',subject:'unattributed'}];
  if(mode==='foreign') rows=[{...rows[0],account_id:'account-b'}];
  if(mode==='limit') rows=Array.from({length:201},(_,i)=>({...rows[0],subject:'row '+i}));
  if(mode==='foreign-tail') rows=[...Array.from({length:200},()=>rows[0]),{...rows[0],account_id:'account-b'}];
  if(mode==='long-text') rows=[{...rows[0],subject:'x'.repeat(700)}];
  if(mode==='huge-row') rows=[{...rows[0],subject:'x'.repeat(25000)}];
  if(mode==='series'||mode==='series-cap'){
    lastRange={from:u.searchParams.get('date_from'),to:u.searchParams.get('date_to'),preset:u.searchParams.get('date_preset'),max:u.searchParams.get('_max_rows')};
    const r=(date,subject,value)=>({account_id:expectedAccount,date,subject,value,rate:0.5,unique_users:7});
    rows=[r('2025-10-01','A',1),r('2025-10-15','B',2),r('2025-11-03','A',4),r('2026-09-30','A',null),r('2026-10-02','A',null),r('2026-10-03','B','5')];
    if(mode==='series-cap') rows=Array.from({length:Number(lastRange.max)},()=>r('2025-10-01','A',1));
  }
  return new Response(JSON.stringify({data:rows}));
}
const handler=createMcpHandler({env:{SUPABASE_URL:BASE,SUPABASE_ANON_KEY:'anon-key',WINDSOR_API_KEY:KEY},fetchImpl});
async function tool(name,args={}) {
  const response=await handler(new Request(BASE+'/functions/v1/mcp',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
  const body=await response.json(); const raw=JSON.stringify(body);
  assert.ok(!raw.includes(KEY),'key never returned'); assert.ok(!raw.includes('token-a'),'link token never returned');
  return {status:response.status,body,raw,data:body.result?.isError?null:body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text):null};
}
const queryArgs={connection_id:CA,fields:['date','subject','value']};
let lastRange=null;
let passed=0;
async function check(name,fn){await fn();console.log(`ok ${++passed} - ${name}`);}
await check('one MCP lists only published connections for the grant company, ignoring forged company claims/browser company',async()=>{
 const r=await tool('list_connections');assert.deepEqual(r.data.connections.map(c=>c.id),[CA]);assert.equal(calls.length,0);
});
await check('foreign and unpublished IDs make no external calls',async()=>{
 for(const id of [CB,OFF]){calls=[];const r=await tool('query_connection',{...queryArgs,connection_id:id});assert.ok(r.body.result?.isError||r.body.error);assert.equal(calls.length,0);}
});
await check('arbitrary company/account/source/url and write tools cannot redirect reads',async()=>{
 for(const extra of [{company_entity_id:B},{account_id:'account-b'},{source:'all'},{url:'https://evil.test'},{method:'DELETE'}]){calls=[];const r=await tool('query_connection',{...queryArgs,...extra});assert.equal(r.body.result.isError,true);assert.equal(calls.length,0);}
 calls=[];const r=await tool('delete_connection',{connection_id:CA});assert.ok(r.body.error||r.body.result?.isError);assert.equal(calls.length,0);
});
await check('live rows preserve same-day multiplicity and text; no persistence or aggregation',async()=>{
 calls=[];const r=await tool('query_connection',queryArgs);assert.equal(r.data.rows.length,2);assert.deepEqual(r.data.rows.map(r=>r.subject),['First text','Second text']);assert.equal(r.data.persisted,false);
 assert.ok(calls.every(c=>c.init.method==='GET'));
 const names=(await db.query("select tablename from pg_tables where schemaname='public'")).rows.map(r=>r.tablename);assert.ok(!names.includes('windsor_metrics_daily'));
});
await check('metadata is discovered and unknown fields fail before the data call',async()=>{
 const d=await tool('describe_connection',{connection_id:CA,search:'subject'});assert.deepEqual(d.data.fields.map(f=>f.id),['subject']);
 calls=[];const r=await tool('query_connection',{...queryArgs,fields:['not_a_field']});assert.equal(r.body.result.isError,true);assert.equal(calls.length,1);
});
for(const scenario of ['mixed','missing','foreign','foreign-tail','no-identity-field','oversize','huge-row','transport','vendor-error']){
 await check(`${scenario}: no data/credentials returned`,async()=>{mode=scenario;const r=await tool('query_connection',queryArgs);assert.ok(r.body.result?.isError||r.body.error);assert.ok(!r.raw.includes('First text'));assert.ok(!r.raw.includes('B secret'));mode='valid';});
}
await check('output caps do not truncate text or claim complete totals',async()=>{
 mode='limit';let r=await tool('query_connection',queryArgs);assert.equal(r.data.rows.length,200);assert.equal(r.data.maybe_truncated,true);
 mode='long-text';r=await tool('query_connection',queryArgs);assert.equal(r.data.rows[0].subject.length,700);mode='valid';
});
const yoy={connection_id:CA,date_from:'2025-10-01',date_to:'2026-10-31'};
await check('a two-year range rolls up by month over every source row, and a blank month stays blank',async()=>{
 mode='series';calls=[];const r=await tool('query_connection',{...yoy,fields:['date','value'],rollup:'month'});
 assert.deepEqual(lastRange,{from:'2025-10-01',to:'2026-10-31',preset:null,max:'20000'});
 assert.deepEqual(r.data.rows.map(g=>[g.period,g.value,g.days_with_rows]),[['2025-10',3,2],['2025-11',4,1],['2026-09',null,1],['2026-10',5,2]]);
 assert.equal(r.data.source_rows,6);assert.equal(r.data.persisted,false);assert.equal(r.data.rollup,'month');
 assert.equal(r.data.completeness_status,'unverified');mode='valid';
});
await check('text fields split the totals; week periods start on Monday; total ignores dates',async()=>{
 mode='series';let r=await tool('query_connection',{...yoy,fields:['date','subject','value'],rollup:'total'});
 assert.deepEqual(r.data.rows.map(g=>[g.subject,g.value]),[['A',5],['B',7]]);
 r=await tool('query_connection',{...yoy,fields:['date','value'],rollup:'week'});
 assert.equal(r.data.rows[0].period,'2025-09-29');assert.equal(r.data.rows[0].value,1);mode='valid';
});
await check('rates and distinct counts cannot be summed, whatever their type: refused before any data request',async()=>{
 for (const field of ['rate','unique_users']) {
  mode='series';calls=[];const r=await tool('query_connection',{...yoy,fields:['date','value',field],rollup:'month'});
  assert.equal(r.body.result.isError,true);assert.match(r.raw,new RegExp(field));
  assert.match(r.raw,/cannot be added up/);assert.ok(calls.every(c=>c.url.pathname.endsWith('/fields')));
 }
 mode='valid';
});
await check('a capped source response is refused, never returned as a partial total',async()=>{
 mode='series-cap';const r=await tool('query_connection',{...yoy,fields:['date','value'],rollup:'total'});
 assert.equal(r.body.result.isError,true);assert.match(r.raw,/too many source rows/);mode='valid';
});
for(const [label,extra] of [['preset and range together',{date_preset:'last_7d'}],['date_from after date_to',{date_from:'2026-11-01',date_to:'2026-10-01'}],
  ['future end',{date_to:'2099-01-01'}],['over 800 days',{date_from:'2020-01-01'}],['malformed date',{date_from:'2025-13-40'}],
  ['only one end',{date_to:undefined}],['unknown rollup',{rollup:'year'}],['day rollup without date',{fields:['value'],rollup:'day'}]]){
 await check(`invalid window refused with no data request: ${label}`,async()=>{
  // Exercise date guards on the supported raw path. A refused rollup would
  // mask a missing range guard by failing for an unrelated reason.
  mode='series';calls=[];const args={...yoy,fields:['date','value'],rollup:'none',...extra};
  for(const k of Object.keys(args)) if(args[k]===undefined) delete args[k];
  const r=await tool('query_connection',args);assert.equal(r.body.result.isError,true);
  if (label === 'over 800 days') assert.match(r.raw,/at most 800 days/);
  assert.ok(calls.every(c=>c.url.pathname.endsWith('/fields')),'no data call');mode='valid';
 });
}
for(const scenario of ['revoke','unpublish']) await check(`${scenario} during fetch is rechecked before result release`,async()=>{
 mode=scenario;const r=await tool('query_connection',queryArgs);assert.ok(r.body.result?.isError||r.body.error);assert.ok(!r.raw.includes('First text'));
 await db.exec(`update silo_api_grants set revoked_at=null;update windsor_linked_accounts set mcp_enabled=true where id='${CA}'`);mode='valid';
});
await check('reports-only, expired, wrong-session, missing membership and unassured grants all fail before external calls',async()=>{
 for(const [change,restore] of [
  ["update silo_api_grants set scopes=array['reports:read']","update silo_api_grants set scopes=array['reports:read','data:read']"],
  ["update silo_api_grants set expires_at=now()-interval '1 day'","update silo_api_grants set expires_at=now()+interval '1 day'"],
  ["update silo_api_grants set auth_session_id=null",`update silo_api_grants set auth_session_id='${SESSION}'`],
  [`delete from entity_memberships where entity_id='${A}'`,`insert into entity_memberships values('${USER}','${A}')`],
  ["update silo_api_grants set consented_aal='aal1'","update silo_api_grants set consented_aal='aal2'"]]){
   await db.exec(change);calls=[];const r=await tool('query_connection',queryArgs);assert.ok(r.body.result?.isError||r.body.error);assert.equal(calls.length,0);await db.exec(restore);
 }
});
await check('RLS itself hides other-company and unpublished rows; no direct integration table or client publication writes',async()=>{
 await db.exec('begin');await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);await db.exec('set local role silo_api_exec');
 assert.deepEqual((await db.query('select id from windsor_linked_accounts order by id')).rows.map(r=>r.id),[CA]);await db.exec('rollback');
 for(const role of ['silo_integration','anon','authenticated']){
  await db.exec(`begin;set local role ${role}`);
  await assert.rejects(db.query('update windsor_linked_accounts set mcp_enabled=true'),/permission denied/);await db.exec('rollback');
 }
 await db.exec('begin;set local role silo_integration');
 await assert.rejects(db.query('select id from windsor_linked_accounts'),/permission denied/);await db.exec('rollback');
 const acl=(await db.query("select has_function_privilege('anon','silo_api_windsor_connections(uuid,integer)','execute') a,has_function_privilege('authenticated','silo_api_windsor_connections(uuid,integer)','execute') b")).rows[0];assert.deepEqual(acl,{a:false,b:false});
});
await check('legacy admin RLS can read own unpublished mapping, but live resolver still refuses it',async()=>{
 await db.query("select set_config('test.is_admin','true',false)");
 try {
  await db.exec('begin');await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);await db.exec('set local role silo_api_exec');
  assert.deepEqual((await db.query('select id from windsor_linked_accounts order by id')).rows.map(r=>r.id),[CA,OFF]);await db.exec('rollback');
  assert.deepEqual((await tool('list_connections')).data.connections.map(c=>c.id),[CA]);
  for(const id of [OFF,CB]){
   calls=[];const r=await tool('query_connection',{...queryArgs,connection_id:id});assert.ok(r.body.error||r.body.result?.isError);assert.equal(calls.length,0);
  }
 } finally { await db.query("select set_config('test.is_admin','false',false)"); }
});
await check('a second grant company reads only its own connector and account',async()=>{
 await db.exec(`update silo_api_grants set company_entity_id='${B}'`);expectedAccount='account-b';
 assert.deepEqual((await tool('list_connections')).data.connections.map(c=>c.id),[CB]);
 const r=await tool('query_connection',{...queryArgs,connection_id:CB});assert.equal(r.data.rows.length,2);assert.ok(r.data.rows.every(row=>row.account_id==='account-b'));
 calls=[];const denied=await tool('query_connection',queryArgs);assert.ok(denied.body.error||denied.body.result?.isError);assert.equal(calls.length,0);
 await db.exec(`update silo_api_grants set company_entity_id='${A}'`);expectedAccount='account-a';
});
await check('the shipped operational verification recognizes applied authorization',async()=>{
 const verify=readFileSync('supabase/verify_v2_schema.sql','utf8');
 const start=verify.indexOf("select 'Windsor live MCP authorization'");
 assert.ok(start>=0);const result=await db.query(verify.slice(start,verify.indexOf(';',start)+1));
 assert.equal(result.rows[0].status,'ok');
});
await check('the verifier fails until the activity correction is applied, and passes after',async()=>{
 let verify=readFileSync('supabase/verify_v2_schema.sql','utf8');
 if(mutation==='verify-activity') verify=replaceOnce(verify,"      and strpos(p.prosrc,'perform public.silo_api_require_scope(''data:read'');')\n          < strpos(p.prosrc,'perform public.silo_api_touch_grant();'))","      )").replace("      and strpos(p.prosrc,'perform public.silo_api_touch_grant();')>0\n",'');
 const start=verify.indexOf("select 'Windsor live MCP activity'");
 assert.ok(start>=0);const sql=verify.slice(start,verify.indexOf('end as status;',start)+'end as status;'.length);
 assert.equal((await db.query(sql)).rows[0].status,'ok','applied correction passes');
 const original=definition('silo_api_windsor_connections',readFileSync('supabase/migrations/20261103210000_windsor_live_mcp.sql','utf8'));
 assert.ok(!original.includes('silo_api_touch_grant'),'fixture: the original resolver records no activity');
 await db.exec('begin');
 try { await db.exec(original); assert.notEqual((await db.query(sql)).rows[0].status,'ok','original resolver alone is reported missing'); }
 finally { await db.exec('rollback'); }
 assert.equal((await db.query(sql)).rows[0].status,'ok');
});
await check('legacy verifier admits only the exact live RPC grant and intended Windsor policies',async()=>{
 const verify=readFileSync('supabase/verify_v2_schema.sql','utf8');
 const brokerStart=verify.indexOf("select 'Windsor tenant broker'");
 const broker=verify.slice(brokerStart,verify.indexOf('end as status;',brokerStart)+'end as status;'.length);
 const aclStart=verify.indexOf('  -- EXPLICIT grants only.');
 const predicateStart=verify.indexOf('when exists (',aclStart)+5;
 const predicateEnd=verify.indexOf("\n   then 'CRITICAL: an integration role",predicateStart);
 const acl=`select ${verify.slice(predicateStart,predicateEnd)} as unexpected`;
 assert.equal((await db.query(acl)).rows[0].unexpected,false);
 assert.equal((await db.query(broker)).rows[0].status,'ok');
 for(const sql of [
  'grant execute on function silo_api_windsor_connections(uuid,integer) to silo_revoked',
  'create function silo_api_windsor_connections(text) returns void language sql as $$ select $$; grant execute on function silo_api_windsor_connections(text) to silo_integration',
  'create function unrelated_rpc() returns void language sql as $$ select $$; grant execute on function unrelated_rpc() to silo_integration'
 ]){
  await db.exec('begin');await db.exec(sql);assert.equal((await db.query(acl)).rows[0].unexpected,true);await db.exec('rollback');
 }
 for(const sql of [
  'alter policy windsor_linked_accounts_mcp_select on windsor_linked_accounts to authenticated',
  'alter policy windsor_linked_accounts_mcp_select on windsor_linked_accounts using (true)',
  'drop policy windsor_linked_accounts_mcp_select on windsor_linked_accounts; create policy windsor_linked_accounts_mcp_select on windsor_linked_accounts for select to silo_api_exec',
  'create policy unexpected_read on windsor_linked_accounts for select using (true)',
  'drop policy windsor_linked_accounts_admin_select on windsor_linked_accounts'
 ]){
  await db.exec('begin');await db.exec(sql);assert.notEqual((await db.query(broker)).rows[0].status,'ok');await db.exec('rollback');
 }
});
await check('each live tool refreshes a near-idle grant, with hourly throttling and no expiry extension',async()=>{
 for(const [name,args] of [['list_connections',{}],['describe_connection',{connection_id:CA}],['query_connection',queryArgs]]){
  await db.exec("update silo_api_grants set consented_at=now()-interval '40 days',last_used_at=now()-interval '29 days'");
  const before=(await db.query('select expires_at from silo_api_grants')).rows[0].expires_at;
  const r=await tool(name,args);assert.ok(r.data,`${name} succeeds`);
  const touched=(await db.query("select last_used_at,expires_at,last_used_at > now()-interval '1 minute' as recent from silo_api_grants")).rows[0];
  assert.equal(touched.recent,true,`${name} records activity`);assert.deepEqual(touched.expires_at,before);
  await tool(name,args);
  assert.deepEqual((await db.query('select last_used_at from silo_api_grants')).rows[0].last_used_at,touched.last_used_at,'same-hour use does not rewrite activity');
 }
});
await check('idle grants cannot revive themselves, and failed scope checks do not touch activity',async()=>{
 for(const setting of ["last_used_at=now()-interval '31 days'",'last_used_at=null']){
  await db.exec(`update silo_api_grants set consented_at=now()-interval '31 days',${setting}`);
  const before=(await db.query('select last_used_at,updated_at from silo_api_grants')).rows[0];
  for(const [name,args] of [['list_connections',{}],['describe_connection',{connection_id:CA}],['query_connection',queryArgs]]){
   calls=[];const r=await tool(name,args);assert.ok(r.body.error||r.body.result?.isError);assert.equal(calls.length,0);
   assert.deepEqual((await db.query('select last_used_at,updated_at from silo_api_grants')).rows[0],before);
  }
 }
 await db.exec("update silo_api_grants set consented_at=now(),last_used_at=now()-interval '2 hours',scopes=array['reports:read']");
 const before=(await db.query('select last_used_at from silo_api_grants')).rows[0];
 await tool('list_connections');assert.deepEqual((await db.query('select last_used_at from silo_api_grants')).rows[0],before);
 await db.exec("update silo_api_grants set scopes=array['reports:read','data:read']");
});
await check('publication defaults false and migration replay never publishes accounts',async()=>{
 assert.equal((await db.query("select column_default from information_schema.columns where table_name='windsor_linked_accounts' and column_name='mcp_enabled'")).rows[0].column_default,'false');
 await db.exec(`update windsor_linked_accounts set mcp_enabled=false where id='${CA}'`);await db.exec(migration);
 assert.equal((await db.query(`select mcp_enabled from windsor_linked_accounts where id='${CA}'`)).rows[0].mcp_enabled,false);
});
await db.close();console.log(`${passed} live MCP database/handler checks passed`);
