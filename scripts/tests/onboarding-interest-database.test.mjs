// Isolated PostgreSQL permissions and transaction tests. PGlite is one connection;
// queued calls are NOT evidence of real multiconnection interleaving.
// Run: node scripts/tests/onboarding-interest-database.test.mjs
// Optional mutation: ONBOARDING_DB_MUTATION=wide-policy|wide-grants|overwrite|no-rate-limit|no-email-limit|extra-bucket|removal
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
  'no-email-limit': ["('email:' || p_email_key, 3)", "('email:' || p_email_key, 300)"],
  'extra-bucket': ["bucket_key in ('global:minute', 'global:day') or", "bucket_key in ('global:minute', 'global:day', 'extra') or"],
  removal: ['  v_now := clock_timestamp();', '  v_now := clock_timestamp();\n  delete from public.onboarding_interest_rate_buckets;'],
};
if (mutation) { assert.ok(swaps[mutation]); const [a,b] = swaps[mutation]; assert.ok(sql.includes(a)); sql = sql.replaceAll(a,b); }
// Whole migration, including nested PL/pgSQL bodies: no destructive operations
// or removal authority. This deliberately also rejects those words in comments.
assert.doesNotMatch(sql, /\b(?:drop|delete|truncate)\b/i, 'migration must be additive and contain no removal statements or grants');
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
await db.exec(sql);
const policyOids = await q("select oid,polname from pg_policy where polrelid='public.onboarding_interest_queue'::regclass order by polname");
await db.exec(sql);
assert.deepEqual(await q("select oid,polname from pg_policy where polrelid='public.onboarding_interest_queue'::regclass order by polname"), policyOids,
  'idempotent policy creation must preserve existing policy identities');
let passed = 0;
async function test(name, fn) {
  // Fixture state is discarded by rollback; no table cleanup statement is run.
  await db.exec('begin');
  try { await fn(); console.log(`ok ${++passed} - ${name}`); }
  finally { await db.exec('rollback'); }
}
async function as(role, uid, fn) {
  await db.exec(`set local role ${role}`);
  await q("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const service = fn => as('service_role', '', fn);
const admin = fn => as('authenticated', '00000000-0000-0000-0000-000000000001', fn);
const ordinary = fn => as('authenticated', '00000000-0000-0000-0000-000000000002', fn);
const digest = text => createHash('sha256').update(text).digest('hex');
const submit = (email='lead@example.com', name='First person', company='First company', key=digest(String(email))) =>
  one('select public.submit_onboarding_interest($1,$2,$3,$4) as result', [name,company,email,key]).then(r=>r.result);
async function denied(fn, pattern=/permission denied|row-level security|check constraint|Invalid interest request/) {
  await db.exec('savepoint expected_refusal');
  try { await assert.rejects(fn, pattern); }
  finally { await db.exec('rollback to savepoint expected_refusal'); }
}
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
  await service(()=>submit());
  assert.equal((await ordinary(()=>q('select * from onboarding_interest_queue'))).length,0);
  assert.equal((await ordinary(()=>q("update onboarding_interest_queue set status='closed' returning id"))).length,0);
});
await test('platform admin can select and change status only',async()=>{
  await service(()=>submit());
  assert.equal((await admin(()=>q('select * from onboarding_interest_queue'))).length,1);
  assert.equal((await admin(()=>q("update onboarding_interest_queue set status='closed' returning id"))).length,1);
  for (const assignment of ["name='changed'","company_name='changed'","email='x@example.com'","source='other'","created_at=now()","id=gen_random_uuid()"])
    await admin(()=>denied(()=>q(`update onboarding_interest_queue set ${assignment}`)));
  await admin(()=>denied(()=>q("update onboarding_interest_queue set status='approved'")));
  await admin(()=>denied(()=>q("insert into onboarding_interest_queue(name,company_name,email) values('X','Y','x@example.com')")));
  assert.equal((await one("select has_table_privilege('authenticated','onboarding_interest_queue','DELETE,TRUNCATE') as allowed")).allowed,false);
  await admin(()=>denied(()=>q('select * from onboarding_interest_rate_buckets')));
});
await test('RPC input validation rejects missing, malformed, non-normalized, and oversized values',async()=>{
  const bad = [
    ['x@example.com',null,'Company'], ['x@example.com','','Company'], ['x@example.com','x'.repeat(121),'Company'],
    ['x@example.com','Name','x'.repeat(201)], ['x@example.com','Name','bad\ncompany'], ['UPPER@example.com'],
    [' a@example.com'], ['bad'], ['a..b@example.com'], ['a@-example.com'], ['a@one'], ['a@'+'x'.repeat(64)+'.com'],
    [null], ['x@example.com','Name',null],
    ['x@example.com','Name','Company',null], ['x@example.com','Name','Company','ip-address'], ['x@example.com','Name','Company','G'.repeat(64)],
  ];
  for (const args of bad) await service(()=>denied(()=>submit(...args)));
});
await test('table constraints backstop direct service inserts',async()=>{
  for (const [column,value] of [['source','manual'],['status','approved'],['email','UPPER@example.com'],['name',''],['company_name','x'.repeat(201)]]) {
    await service(()=>denied(()=>q(`insert into onboarding_interest_queue(name,company_name,email,${column === 'name'||column === 'company_name'||column === 'email' ? 'status' : column}) values($1,$2,$3,$4)`,
      [column==='name'?value:'Name',column==='company_name'?value:'Company',column==='email'?value:'fresh@example.com', ['name','company_name','email'].includes(column)?'pending':value])));
  }
});
await test('repeat attempts for one address are throttled at 3 per hour before the global quota, with one lead',async()=>{
  for(let i=0;i<3;i++) assert.equal((await service(()=>submit())).accepted,true);
  const result=await service(()=>submit()); assert.equal(result.accepted,false); assert.ok(result.retry_after_seconds > 0 && result.retry_after_seconds <= 3600);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_queue')).n,1);
  assert.deepEqual((await q('select bucket_key,hits from onboarding_interest_rate_buckets order by bucket_key')),
    [{bucket_key:'email:'+digest('lead@example.com'),hits:3},{bucket_key:'global:day',hits:3},{bucket_key:'global:minute',hits:3}]);
  // A different address is still admitted: the throttle is per address, not global.
  assert.equal((await service(()=>submit('other@example.com'))).accepted,true);
});
await test('an expired per-address counter resets in place; the row is reused, never removed',async()=>{
  for(let i=0;i<3;i++) await service(()=>submit());
  assert.equal((await service(()=>submit())).accepted,false);
  await q("update onboarding_interest_rate_buckets set expires_at=clock_timestamp()-interval '1 second' where bucket_key like 'email:%'");
  assert.equal((await service(()=>submit())).accepted,true);
  assert.deepEqual(await q("select hits from onboarding_interest_rate_buckets where bucket_key like 'email:%'"),[{hits:1}]);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,3);
});
await test('global minute cap denies new addresses without changing rate state or leads',async()=>{
  for(let i=0;i<30;i++) assert.equal((await service(()=>submit(`lead${i}@example.com`))).accepted,true);
  const before = await q('select * from onboarding_interest_rate_buckets order by bucket_key');
  assert.equal((await service(()=>submit('blocked@example.com'))).accepted,false);
  assert.deepEqual(await q('select * from onboarding_interest_rate_buckets order by bucket_key'),before);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_queue')).n,30);
});
await test('300 unique emails add exactly one row each; refused attempts add none; the day cap and reset work',async()=>{
  for(let i=0;i<300;i++) {
    if(i && i%30===0) await q("update onboarding_interest_rate_buckets set expires_at=clock_timestamp()-interval '1 second' where bucket_key='global:minute'");
    assert.equal((await service(()=>submit(`lead${i}@example.com`))).accepted,true);
    assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,2+i+1);
  }
  await q("update onboarding_interest_rate_buckets set expires_at=clock_timestamp()-interval '1 second' where bucket_key='global:minute'");
  for(let i=300;i<400;i++) assert.equal((await service(()=>submit(`lead${i}@example.com`))).accepted,false);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_queue')).n,300);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,302,'a refused request adds no per-address row');
  await q("update onboarding_interest_rate_buckets set expires_at=clock_timestamp()-interval '1 second'");
  assert.equal((await service(()=>submit('next-day@example.com'))).accepted,true);
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,303);
  assert.ok((await q('select hits from onboarding_interest_rate_buckets')).every(r=>r.hits===1));
});
await test('bucket key constraint and service permissions prevent unbounded state or removal',async()=>{
  await service(()=>denied(()=>q("insert into onboarding_interest_rate_buckets values('extra',1,now()+interval '1 hour')")));
  await service(()=>denied(()=>q("insert into onboarding_interest_rate_buckets values('email:not-a-digest',1,now()+interval '1 hour')")));
  for(const table of ['onboarding_interest_queue','onboarding_interest_rate_buckets'])
    assert.equal((await one('select has_table_privilege($1,$2,$3) as allowed',['service_role',table,'DELETE,TRUNCATE'])).allowed,false);
});
await test('a persistence exception rolls back quota admission',async()=>{
  await db.exec(`create function public.reject_fixture() returns trigger language plpgsql as $$ begin raise exception 'fixture persistence failed'; end $$;
    create trigger reject_fixture before insert on public.onboarding_interest_queue for each row execute function public.reject_fixture();`);
  await service(()=>denied(()=>submit(),/fixture persistence failed/));
  assert.equal((await one('select count(*)::int as n from onboarding_interest_rate_buckets')).n,0);
});
await test('only the four-argument invoker RPC exists, with no removal statements in its stored body',async()=>{
  const functions=await q("select pronargs,prosecdef,prosrc from pg_proc where pronamespace='public'::regnamespace and proname='submit_onboarding_interest'");
  assert.equal(functions.length,1); const [f]=functions;
  assert.equal(f.pronargs,4); assert.equal(f.prosecdef,false); assert.match(f.prosrc,/pg_advisory_xact_lock/);
  assert.doesNotMatch(f.prosrc,/\b(?:drop|delete|truncate)\b/i);
  assert.equal((await one("select has_table_privilege('authenticated','public.onboarding_interest_queue','UPDATE') as allowed")).allowed,false);
  assert.equal(policyOids.length,2);
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
