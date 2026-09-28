// 20260928120000 against a REAL PostgreSQL (PGlite), with Supabase's default
// privileges in force (every new public table granted to anon/authenticated).
//
// What it proves:
//   1. A store's client secret (shopify_client_credentials) cannot be read,
//      written or even counted by a signed-in member -- the connection row it
//      belongs to stays readable, the secret does not.
//   2. The compliance log is equally closed to clients.
//   3. The service role reads both.
//   4. The CHECKs refuse an unknown auth_method / oauth_app.
//   5. Deleting a connection deletes its credentials.
//   6. The migration applies twice.
//
// Run:  node scripts/tests/shopify-credentials-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db
// Mutation (must fail an assertion):
//   SHOPIFY_CRED_DB_MUTATION=grant-back   (the migration forgets its revoke)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.SHOPIFY_CRED_DB_MUTATION || '';
assert.ok(['', 'grant-back'].includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const co = randomUUID(), member = randomUUID();
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
async function as(role, user, fn) {
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  try { return await fn(); }
  finally { await db.exec('reset role'); await q("select set_config('request.jwt.claim.sub', '', false)"); }
}
async function refused(fn, pattern, what) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  assert.ok(msg !== null, `${what}: expected a refusal`);
  assert.match(msg, pattern, `${what}: ${msg}`);
}

await db.exec(await read('scripts/tests/seo-db-bootstrap.sql'));
// The two existing tables the migration alters, shaped as in production, with
// production's "any company member reads" policy on the connection.
await db.exec(`
  create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
  create table public.shopify_connections (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid not null references public.entities(id),
    shop_domain text not null, access_token text, is_active boolean default true,
    unique (company_entity_id, shop_domain));
  alter table public.shopify_connections enable row level security;
  create policy shopify_connections_select on public.shopify_connections for select to authenticated
    using (company_entity_id = public.active_company_id());
  create table public.shopify_oauth_states (nonce text primary key, company_entity_id uuid, shop_domain text);
  alter table public.shopify_oauth_states enable row level security;
`);
await q('insert into public.entities (id, title) values ($1, $2)', [co, 'Bat Nutz']);
await q('insert into auth.users (id) values ($1)', [member]);
await q("insert into public.profiles (id, is_active, active_company_id) values ($1, true, $2)", [member, co]);

let migration = await read('supabase/migrations/20260928120000_shopify_client_credentials.sql');
if (mutation === 'grant-back') migration = migration.replace('revoke all on public.shopify_client_credentials from anon, authenticated;', '');
await db.exec(migration);
await db.exec(migration);

await test('the migration applies twice', async () => {
  const cols = (await q(`select column_name from information_schema.columns
    where table_name = 'shopify_connections' and column_name in ('auth_method','token_expires_at','oauth_app')`)).length;
  assert.equal(cols, 3);
});

const [{ id: connId }] = await q(`insert into public.shopify_connections (company_entity_id, shop_domain, access_token, auth_method)
  values ($1, 'bat-nutz.myshopify.com', 'tok', 'client_credentials') returning id`, [co]);
await q(`insert into public.shopify_client_credentials (connection_id, company_entity_id, client_id, client_secret)
  values ($1, $2, 'cid', 'SECRET')`, [connId, co]);
await q(`insert into public.shopify_compliance_requests (topic, action, payload) values ('shop/redact', 'redact_shop', '{}')`);

await test('a member sees the connection but can never touch its secret', async () => {
  await as('authenticated', member, async () => {
    assert.equal((await q('select id from public.shopify_connections')).length, 1, 'the connection itself stays visible');
    await refused(() => q('select client_secret from public.shopify_client_credentials'), /permission denied/, 'select secret');
    await refused(() => q('select count(*) from public.shopify_client_credentials'), /permission denied/, 'count');
    await refused(() => q(`insert into public.shopify_client_credentials (connection_id, company_entity_id, client_id, client_secret)
      values ($1, $2, 'x', 'y')`, [connId, co]), /permission denied/, 'insert');
    await refused(() => q("update public.shopify_client_credentials set client_secret = 'z'"), /permission denied/, 'update');
  });
  await as('anon', null, async () => {
    await refused(() => q('select 1 from public.shopify_client_credentials'), /permission denied/, 'anon select');
  });
});

await test('the compliance log is closed to clients', async () => {
  await as('authenticated', member, async () => {
    await refused(() => q('select * from public.shopify_compliance_requests'), /permission denied/, 'select log');
  });
});

await test('the service role reads both', async () => {
  await as('service_role', null, async () => {
    assert.equal((await q('select client_secret from public.shopify_client_credentials'))[0].client_secret, 'SECRET');
    assert.equal((await q('select count(*)::int n from public.shopify_compliance_requests'))[0].n, 1);
  });
});

await test('unknown auth_method / oauth_app are refused', async () => {
  await refused(() => q("update public.shopify_connections set auth_method = 'password'"), /auth_method_check/, 'auth_method');
  await refused(() => q("update public.shopify_connections set oauth_app = 'mine'"), /oauth_app_check/, 'oauth_app');
});

await test('deleting a connection deletes its credentials', async () => {
  await q('delete from public.shopify_connections where id = $1', [connId]);
  assert.equal((await q('select count(*)::int n from public.shopify_client_credentials'))[0].n, 0);
});

console.log(`\n${passed} passed`);
