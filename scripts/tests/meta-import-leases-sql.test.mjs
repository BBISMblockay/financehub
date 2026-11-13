// Static security contracts plus actual PostgreSQL execution in PGlite.
// Single-session semantics; not a distributed live concurrency/load test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const sql = readFileSync(new URL('../../supabase/migrations/20261113220322_immediate_meta_import_leases.sql', import.meta.url), 'utf8');
assert.match(sql, /alter table public.ad_sync_leases enable row level security/);
assert.match(sql, /revoke all on public.ad_sync_leases from public, anon, authenticated/);
assert.doesNotMatch(sql, /security definer/i);
for (const [name, signature] of Object.entries({claim_ad_sync_lease:'uuid,uuid,uuid,integer', renew_ad_sync_lease:'uuid,uuid,uuid,integer', release_ad_sync_lease:'uuid,uuid,uuid', claim_integration_bootstrap_job:'uuid,integer,integer,integer', reserve_bootstrap_dispatch:'uuid'})) {
  assert.ok(sql.includes(`revoke all on function public.${name}(${signature}) from public, anon, authenticated;`));
  assert.ok(sql.includes(`grant execute on function public.${name}(${signature}) to service_role;`));
}
assert.match(sql, /on conflict \(connection_id\) do update[\s\S]*where l.lease_until < now\(\)/);
assert.match(sql, /l.owner = p_owner and l.lease_until > now\(\)/);
assert.match(sql, /company_entity_id = p_company_id and owner = p_owner/);
assert.match(sql, /p_job_id is null or c.id = p_job_id/);
assert.match(sql, /for update skip locked/);
assert.match(sql, /attempts = j.attempts \+ 1/);
assert.match(sql, /interval '2 minutes'/);
assert.match(sql, /c.id = j.connection_id and c.company_entity_id = j.company_entity_id/);
console.log('Meta import lease SQL security contracts passed');

// Execute the actual migration with Supabase-like default grants.
const { PGlite } = await import('./finance-db/node_modules/@electric-sql/pglite/dist/index.js');
const db = new PGlite();
try {
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table public.entities(id uuid primary key);
create function public.active_company_id() returns uuid language sql as $$ select null::uuid $$;
create function public.is_admin_user() returns boolean language sql as $$ select false $$;
create function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function public.refresh_chat_schema_catalog() returns void language sql as $$ select $$;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create table public.ad_platform_connections(id uuid primary key, company_entity_id uuid not null references public.entities(id), platform text, is_active boolean, sync_enabled boolean);
grant select on public.ad_platform_connections to service_role;
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261013060000_integration_bootstrap_jobs.sql', import.meta.url),'utf8'));
await db.exec(sql); await db.exec(sql);
const co = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const conn = '33333333-3333-4333-8333-333333333333', owner = '44444444-4444-4444-8444-444444444444', successor = '55555555-5555-4555-8555-555555555555';
const job = '66666666-6666-4666-8666-666666666666';
await db.exec(`insert into public.entities values ('${co}'),('${other}'); insert into public.ad_platform_connections values ('${conn}','${co}','meta_ads',true,true); insert into public.integration_bootstrap_jobs(id,company_entity_id,integration,connection_id) values ('${job}','${co}','meta_ads','${conn}');`);
const value = async (query) => (await db.query(query)).rows[0].v;
for(const role of ['anon','authenticated']) {
  assert.equal(await value(`select has_table_privilege('${role}','public.ad_sync_leases','SELECT') as v`),false);
  for(const fn of ['claim_ad_sync_lease(uuid,uuid,uuid,integer)','renew_ad_sync_lease(uuid,uuid,uuid,integer)','release_ad_sync_lease(uuid,uuid,uuid)','claim_integration_bootstrap_job(uuid,integer,integer,integer)','reserve_bootstrap_dispatch(uuid)']) {
    assert.equal(await value(`select has_function_privilege('${role}','public.${fn}','EXECUTE') as v`),false,`${role} cannot call ${fn}`);
    assert.equal(await value(`select has_function_privilege('service_role','public.${fn}','EXECUTE') as v`),true);
  }
}
const asService = async (query) => { await db.exec('set role service_role'); try { return await value(query); } finally { await db.exec('reset role'); } };
const claim = (company=co,who=owner) => asService(`select public.claim_ad_sync_lease('${conn}','${company}','${who}',900) as v`);
const renew = (who=owner) => asService(`select public.renew_ad_sync_lease('${conn}','${co}','${who}',900) as v`);
const release = (who=owner) => asService(`select public.release_ad_sync_lease('${conn}','${co}','${who}') as v`);
assert.equal(await claim(other),false,'wrong tenant refused');
assert.equal(await claim(),true); assert.equal(await claim(co,successor),false,'busy refused');
assert.equal(await renew(successor),false); assert.equal(await release(successor),false);
assert.equal(await renew(),true);
await db.exec(`update public.ad_sync_leases set lease_until = now() - interval '1 second'`);
assert.equal(await renew(),false,'expired owner cannot renew');
assert.equal(await claim(co,successor),true,'expired lease claimable');
assert.equal(await release(),false,'old owner cannot release successor');
assert.equal(await release(successor),true);
await db.exec(`update public.ad_platform_connections set is_active=false`);
assert.equal(await claim(),false,'inactive connection refused');
await db.exec(`update public.ad_platform_connections set is_active=true,platform='google_ads'`);
assert.equal(await claim(),false,'non-Meta connection refused');
await db.exec(`update public.ad_platform_connections set platform='meta_ads'`);
// sync_enabled=false intentionally does not prevent manual Sync now's lease;
// bootstrap dispatch DOES require it (background owner intent).
await db.exec(`update public.ad_platform_connections set sync_enabled=false`);
assert.equal(await claim(),true); assert.equal(await release(),true);
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),false);
await db.exec(`update public.ad_platform_connections set sync_enabled=true`);
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),true);
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),false,'dispatch cooldown');
await db.exec(`update public.integration_bootstrap_jobs set dispatch_requested_at=now()-interval '3 minutes'`);
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),true);
const claimJob = () => asService(`select count(*)::int as v from public.claim_integration_bootstrap_job('${job}',1,900,5)`);
assert.equal(await asService(`select count(*)::int as v from public.claim_integration_bootstrap_job('${successor}',1,900,5)`),0,'target id respected');
assert.equal(await claimJob(),1); assert.equal(await claimJob(),0,'targeted job cannot bypass live lease');
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),false,'running job cannot dispatch');
await db.exec(`update public.integration_bootstrap_jobs set lease_until=now()-interval '1 second'`);
assert.equal(await claimJob(),1);
assert.equal(await value(`select attempts as v from public.integration_bootstrap_jobs where id='${job}'`),2);
await db.exec(`update public.integration_bootstrap_jobs set lease_until=now()-interval '1 second',attempts=5`);
assert.equal(await claimJob(),0,'attempt cap');
await db.exec(`update public.integration_bootstrap_jobs set status='pending', dispatch_requested_at=null, company_entity_id='${other}'`);
assert.equal(await asService(`select public.reserve_bootstrap_dispatch('${job}') as v`),false,'job cannot dispatch another tenant connection');
console.log('Meta import migration PGlite checks passed: real SQL, tenant ownership, expiry, grants, targeted lease, dispatch cooldown');
} finally { await db.close(); }
