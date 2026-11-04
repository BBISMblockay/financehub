// Local synthetic PostgreSQL execution, never a hosted database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create table entities(id uuid primary key);
create table profiles(id uuid primary key, active_company_id uuid, is_active boolean default true);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as $$select active_company_id from profiles where id=auth.uid()$$;
create function is_active_user() returns boolean language sql stable security definer as $$select exists(select 1 from profiles where id=auth.uid() and is_active=true)$$;
create function is_entity_member(c uuid) returns boolean language sql stable security definer as $$select exists(select 1 from entity_memberships where entity_id=c and user_id=auth.uid())$$;
create function is_entity_admin(c uuid) returns boolean language sql stable security definer as $$select exists(select 1 from entity_memberships where entity_id=c and user_id=auth.uid() and role in ('owner_admin','admin'))$$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$select$$;
create function refresh_chat_schema_catalog() returns void language sql as $$select$$;
grant usage on schema public,auth to authenticated,anon;
`);
let migration = await readFile(new URL('../../supabase/migrations/20261104014709_workspace_module_visibility.sql',import.meta.url),'utf8');
if (process.env.MODULE_MUTATION === 'admin') migration = migration.replaceAll('public.is_entity_admin(company_entity_id)', 'public.is_entity_member(company_entity_id)');
if (process.env.MODULE_MUTATION === 'company') migration = migration.replaceAll('company_entity_id = (select public.active_company_id())','true');
await db.exec(migration);
await db.exec(migration); // idempotent
const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
await db.query('insert into entities values ($1),($2)',[a,b]);
await db.query("insert into workspace_module_visibility values ($1,'finance',true)",[b]);
const roles=['owner_admin','admin','member','viewer','outsider','inactive'];
let checks=0;
for(let i=0;i<roles.length;i++) {
  const role=roles[i],uid=`10000000-0000-0000-0000-00000000000${i}`;
  await db.query('insert into profiles values ($1,$2,$3)',[uid,a,role!=='inactive']);
  if(role!=='outsider') await db.query('insert into entity_memberships values ($1,$2,$3),($4,$2,$3)',[a,uid,role==='inactive'?'admin':role,b]);
  await db.query("select set_config('test.uid',$1,false)",[uid]); await db.exec('set role authenticated');
  const write=()=>db.query("insert into workspace_module_visibility values ($1,'finance',false) on conflict(company_entity_id,module_id) do update set visible=excluded.visible returning *",[a]);
  if(i<2) { assert.equal((await write()).rows[0].visible,false); checks++; }
  else { await assert.rejects(write,/row-level security/); checks++; }
  await assert.rejects(()=>db.query("insert into workspace_module_visibility values ($1,'marketing',false)",[b]),/row-level security/); checks++;
  const rows=(await db.query('select * from workspace_module_visibility')).rows;
  assert.equal(rows.length,role==='inactive'||role==='outsider'?0:1); checks++;
  if(i<2) {
    await assert.rejects(()=>db.query('update workspace_module_visibility set company_entity_id=$1',[b]),/row-level security/); checks++;
    await assert.rejects(()=>db.query("insert into workspace_module_visibility values ($1,'unknown',false)",[a]),/check constraint/); checks++;
  } else {
    assert.equal((await db.query("update workspace_module_visibility set visible=true returning *")).rows.length,0); checks++;
  }
  await assert.rejects(()=>db.exec('delete from workspace_module_visibility'),/permission denied/); checks++;
  await db.exec('reset role');
}
// Same person is admin in A and only a member in B: switching never imports A's authority.
const admin='10000000-0000-0000-0000-000000000001';
await db.query('update entity_memberships set role=$1 where entity_id=$2 and user_id=$3',['member',b,admin]);
await db.query('update profiles set active_company_id=$1 where id=$2',[b,admin]);
await db.query("select set_config('test.uid',$1,false)",[admin]);
await db.exec('set role authenticated');
assert.equal((await db.query('select * from workspace_module_visibility')).rows[0].company_entity_id,b); checks++;
await assert.rejects(()=>db.query("insert into workspace_module_visibility values ($1,'marketing',false)",[b]),/row-level security/); checks++;
assert.equal((await db.query('update workspace_module_visibility set visible=false returning *')).rows.length,0); checks++;
await db.exec('reset role');
await db.exec('set role anon');
await assert.rejects(()=>db.exec('select * from workspace_module_visibility'),/permission denied/); checks++;
await db.exec('reset role');
console.log(`${checks} database assertions passed (real policies, synthetic helper/auth fixtures).`);
await db.close();
