// Isolated PostgreSQL permissions and transaction tests. PGlite is one connection;
// overlapping queued calls are NOT evidence of real multiconnection interleaving.
// Run: node scripts/tests/onboarding-interest-database.test.mjs
// Optional mutation: ONBOARDING_DB_MUTATION=wide-policy|wide-grants|overwrite|no-rate-limit
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const files = await readdir(new URL('../../supabase/migrations/', import.meta.url));
const migration = process.env.ONBOARDING_INTEREST_SQL || new URL('../../supabase/migrations/' + files.find(f => f.endsWith('_onboarding_interest_queue.sql')), import.meta.url);
let sql = await readFile(migration, 'utf8');
const mutation = process.env.ONBOARDING_DB_MUTATION || '';
const swaps = {
  'wide-policy': ["(select public.is_platform_admin())", 'true'],
  'wide-grants': ['grant update (status) on public.onboarding_interest_queue to authenticated;', 'grant update on public.onboarding_interest_queue to authenticated;'],
  overwrite: ['on conflict (email) do nothing;', 'on conflict (email) do update set name = excluded.name;'],
  'no-rate-limit': ['if v_retry > 0 then', 'if false then'],
};
if (mutation) { assert.ok(swaps[mutation]); const [a,b] = swaps[mutation]; assert.ok(sql.includes(a)); sql = sql.replaceAll(a,b); }
await db.exec(`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.platform_admins(user_id uuid primary key);
create table public.profiles(id uuid primary key, role text);
create function public.is_platform_admin() returns boolean language sql stable security definer set search_path=public as $$
select exists(select 1 from public.platform_admins where user_id=auth.uid()) $$;
revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;
insert into platform_admins values ('00000000-0000-0000-0000-000000000001');
insert into profiles values ('00000000-0000-0000-0000-000000000002','owner');
`);
await db.exec(sql); await db.exec(sql);
let passed = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++passed} - ${name}`); }
async function as(role, uid, fn) {
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const service = fn => as('service_role', '', fn);
const admin = fn => as('authenticated', '00000000-0000-0000-0000-000000000001', fn);
const ordinary = fn => as('authenticated', '00000000-0000-0000-0000-000000000002', fn);
const digest = text => createHash('sha256').update(text).digest('hex');
const submit = (email='lead@example.com', name='First person', company='First company', key=digest(email)) =>
  one('select public.submit_onboarding_interest($1,$2,$3,$4) as result', [name,company,email,key]).then(r=>r.result);
const clean = () => db.exec('truncate public.onboarding_interest_rate_buckets, public.onboarding_interest_queue');
async function denied(fn) { await assert.rejects(fn, /permission denied|row-level security|check constraint|Invalid interest request/); }
await test('poisoned default grants removed: anon cannot access either table or RPC', async()=>{
  for (const table of ['onboarding_interest_queue','onboarding_interest_rate_buckets']) {
    await as('anon','', ()=>denied(()=>q(`select * from ${table}`)));
  }
  await as('anon','',()=>denied(()=>submit()));
  await ordinary(()=>denied(()=>submit()));
  await admin(()=>denied(()=>submit()));
});
await test('service inserts durably; duplicate preserves ALL original lead fields',async()=>{
  assert.deepEqual(await service(()=>submit()), {accepted:true,retry_after_seconds:0});
  await admin(()=>q("update onboarding_interest_queue set status='contacted'"));
  const before = await one('select * from onboarding_interest_queue');
  assert.deepEqual(await service(()=>submit('lead@example.com','Replacement','Replacement')), {accepted:true,retry_after_seconds:0});
  assert.deepEqual(await one('select * from onboarding_interest_queue'),before);
});
await test('ordinary company owner sees no leads and updates zero rows',async()=>{
  assert.equal((await ordinary(()=>q('select * from onboarding_interest_queue'))).length,0);
  assert.equal((await ordinary(()=>q("update onboarding_interest_queue set status='closed' returning id"))).length,0);
});
await test('platform admin can select and change status only',async()=>{
  assert.equal((await admin(()=>q('select * from onboarding_interest_queue'))).length,1);
  assert.equal((await admin(()=>q("update onboarding_interest_queue set status='closed' returning id"))).length,1);
  for (const assignment of ["name='changed'","company_name='changed'","email='x@example.com'","source='other'","created_at=now()","id=gen_random_uuid()"])
    await admin(()=>denied(()=>q(`update onboarding_interest_queue set ${assignment}`)));
  await admin(()=>denied(()=>q("update onboarding_interest_queue set status='approved'")));
  await admin(()=>denied(()=>q("insert into onboarding_interest_queue(name,company_name,email) values('X','Y','x@example.com')")));
  await admin(()=>denied(()=>q('delete from onboarding_interest_queue')));
  await admin(()=>denied(()=>q('select * from onboarding_interest_rate_buckets')));
});
await test('RPC input validation rejects missing, malformed, non-normalized, and oversized values',async()=>{
  const bad = [
    ['x@example.com',null,'Company'], ['x@example.com','','Company'], ['x@example.com','x'.repeat(121),'Company'],
    ['x@example.com','Name','x'.repeat(201)], ['x@example.com','Name','bad\ncompany'], ['UPPER@example.com'],
    [' a@example.com'], ['bad'], ['a..b@example.com'], ['a@-example.com'], ['a@one'], ['a@'+'x'.repeat(64)+'.com'],
    ['x@example.com','Name','Company',null], ['x@example.com','Name','Company','ip-address'],
  ];
  for (const args of bad) await service(()=>denied(()=>submit(...args)));
});
await test('table constraints backstop direct service inserts',async()=>{
  for (const [column,value] of [['source','manual'],['status','approved'],['email','UPPER@example.com'],['name',''],['company_name','x'.repeat(201)]]) {
    await service(()=>denied(()=>q(`insert into onboarding_interest_queue(name,company_name,email,${column === 'name'||column === 'company_name'||column === 'email' ? 'status' : column}) values($1,$2,$3,$4)`,
      [column==='name'?value:'Name',column==='company_name'?value:'Company',column==='email'?value:'fresh@example.com', ['name','company_name','email'].includes(column)?'pending':value])));
  }
});
await test('per-email quota checks before dedup and survives separate handler invocations',async()=>{
  await clean();
  for(let i=0;i<3;i++) assert.equal((await service(()=>submit())).accepted,true);
  const result=await service(()=>submit()); assert.equal(result.accepted,false); assert.ok(result.retry_after_seconds > 0);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_queue')).n,1);
});
await test('global minute cap denies new addresses without creating rate buckets or leads',async()=>{
  await clean();
  for(let i=0;i<30;i++) assert.equal((await service(()=>submit(`lead${i}@example.com`))).accepted,true);
  const before = await one('select count(*)::int as n from onboarding_interest_rate_buckets');
  assert.equal((await service(()=>submit('blocked@example.com'))).accepted,false);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,before.n);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_queue')).n,30);
});
await test('global day cap applies even with a fresh minute; expired windows reset',async()=>{
  await clean();
  await q("insert into onboarding_interest_rate_buckets values ('global:day',300,now()+interval '1 day')");
  assert.equal((await service(()=>submit())).accepted,false);
  await q("update onboarding_interest_rate_buckets set expires_at=now()-interval '1 second'");
  assert.equal((await service(()=>submit())).accepted,true);
});
await test('cleanup removes at most 100 expired rows, never lead data',async()=>{
  await clean();
  for(let i=0;i<150;i++) await q("insert into onboarding_interest_rate_buckets values ($1,1,now()-interval '1 second')",['email:'+digest('stale'+i)]);
  assert.equal((await service(()=>submit())).accepted,true);
  assert.equal((await one("select count(*)::int as n from onboarding_interest_rate_buckets where expires_at < now()")).n,50);
});
await test('a persistence exception rolls back quota admission',async()=>{
  await clean();
  await db.exec(`create function public.reject_fixture() returns trigger language plpgsql as $$ begin raise exception 'fixture persistence failed'; end $$;
    create trigger reject_fixture before insert on public.onboarding_interest_queue for each row execute function public.reject_fixture();`);
  await assert.rejects(()=>service(()=>submit()),/fixture persistence failed/);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,0);
  await db.exec('drop trigger reject_fixture on public.onboarding_interest_queue; drop function public.reject_fixture()');
});
await test('RPC remains invoker/service-only and queue ACLs retain no broad UPDATE',async()=>{
  const f=await one("select prosecdef,prosrc from pg_proc where oid='public.submit_onboarding_interest(text,text,text,text)'::regprocedure");
  assert.equal(f.prosecdef,false); assert.match(f.prosrc,/pg_advisory_xact_lock/);
  assert.equal((await one("select has_table_privilege('authenticated','public.onboarding_interest_queue','UPDATE') as allowed")).allowed,false);
});
await test('read-only deployment verifier reports both queue checks ok',async()=>{
  const full=await readFile(new URL('../../supabase/verify_v2_schema.sql',import.meta.url),'utf8');
  const fragment=full.split('-- Begin onboarding interest checks.')[1].split('-- End onboarding interest checks.')[0];
  const result=await db.exec(fragment);
  assert.equal(result.length,2);
  for(const statement of result) for(const row of statement.rows) assert.equal(row.status,'ok',row.check_name+': '+row.status);
});
console.log(`${passed} database checks passed (single-connection PostgreSQL; real cross-connection race untested)`);
await db.close();
