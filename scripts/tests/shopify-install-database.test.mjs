// 20261007120000 (Shopify-initiated install) against a REAL PostgreSQL
// (PGlite), with Supabase's default privileges in force.
//
// What it proves:
//   1. Both install tables are closed to clients: a parked token is never
//      readable, writable or countable by a member or by anon.
//   2. The claim and purge functions are not client-callable.
//   3. Claiming: a new store is connected with sync OFF; a second claim of the
//      same token finds nothing (single use); a reinstall through the same
//      public app refreshes the token and KEEPS sync; a workspace that
//      connects the store another way is refused, nothing changes, and the
//      claim stays usable for another workspace; a closed connection of
//      another kind is reopened as the public app with its old secret removed;
//      an expired claim is refused.
//   4. The purge removes only expired rows.
//   5. The migration applies twice and its verify_v2_schema.sql block reads ok.
//
// Run:  node scripts/tests/shopify-install-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db
// Mutations (each must fail an assertion):
//   SHOPIFY_INSTALL_DB_MUTATION=grant-back     (the table revoke is dropped)
//   SHOPIFY_INSTALL_DB_MUTATION=exec-granted   (the function revoke is dropped)
//   SHOPIFY_INSTALL_DB_MUTATION=overwrite      (the other-way refusal is dropped)
//   SHOPIFY_INSTALL_DB_MUTATION=multi-park     (two parked tokens per store allowed)
//   SHOPIFY_INSTALL_DB_MUTATION=no-actor       (the claiming admin is not recorded)
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.SHOPIFY_INSTALL_DB_MUTATION || '';
assert.ok(['', 'grant-back', 'exec-granted', 'overwrite', 'multi-park', 'no-actor'].includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const coA = randomUUID(), coB = randomUUID(), member = randomUUID();
const hash = (t) => createHash('sha256').update(t).digest('hex');
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
await db.exec(`
  create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
  create table public.shopify_connections (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid not null references public.entities(id),
    shop_domain text not null, access_token text, is_active boolean default true,
    sync_enabled boolean not null default false, shop_name text, shop_currency text,
    scopes_granted jsonb not null default '[]', scopes_missing jsonb not null default '[]',
    scopes_checked_at timestamptz,
    created_by uuid, updated_by uuid, created_at timestamptz default now(),
    unique (company_entity_id, shop_domain));
  alter table public.shopify_connections enable row level security;
  -- Production's own update trigger (pg_get_functiondef, 2026-10-07): it
  -- stamps updated_by from auth.uid() on every update.
  create function public.set_shopify_connections_updated_at() returns trigger language plpgsql as $$
  begin new.updated_by = auth.uid(); return new; end; $$;
  create trigger trg_shopify_connections_updated_at before update on public.shopify_connections
    for each row execute function public.set_shopify_connections_updated_at();
  create policy shopify_connections_select on public.shopify_connections for select to authenticated
    using (company_entity_id = public.active_company_id());
  create table public.shopify_oauth_states (nonce text primary key, company_entity_id uuid, shop_domain text);
  alter table public.shopify_oauth_states enable row level security;
`);
await q('insert into public.entities (id, title) values ($1, $2), ($3, $4)', [coA, 'Bat Nutz', coB, 'Other Co']);
await q('insert into auth.users (id) values ($1)', [member]);
await q("insert into public.profiles (id, is_active, active_company_id) values ($1, true, $2)", [member, coA]);
await db.exec(await read('supabase/migrations/20260928120000_shopify_client_credentials.sql'));

let migration = await read('supabase/migrations/20261007120000_shopify_app_install.sql');
const cut = (from, to = '') => { assert.ok(migration.includes(from), `mutation anchor missing: ${from}`); migration = migration.replace(from, to); };
if (mutation === 'grant-back') cut('revoke all on public.shopify_pending_installs from anon, authenticated;');
if (mutation === 'exec-granted') cut('revoke all on function public.shopify_claim_pending_install(text, uuid, uuid) from public, anon, authenticated;');
if (mutation === 'overwrite') cut('if found and v_c.is_active is true\n     and not', 'if false and not');
if (mutation === 'multi-park') cut('  shop_domain    text not null unique,', '  shop_domain    text not null,');
if (mutation === 'no-actor') cut("  perform set_config('request.jwt.claim.sub', p_user::text, true);\n", '');
await db.exec(migration);
await db.exec(migration);

const park = async (token, shop, { expired = false } = {}) => q(
  `insert into public.shopify_pending_installs (claim_hash, shop_domain, access_token, scopes_granted, shop_name, expires_at)
   values ($1, $2, $3, '["read_orders"]', 'Bat Nutz', now() + ($4 || ' minutes')::interval)
   on conflict (shop_domain) do update set claim_hash = excluded.claim_hash, access_token = excluded.access_token,
     created_at = now(), expires_at = excluded.expires_at`,
  [hash(token), shop, `tok-${token}`, expired ? '-1' : '60']);
const claim = async (token, company) => (await q('select * from public.shopify_claim_pending_install($1, $2, $3)',
  [hash(token), company, member]))[0];
const conn = async (company, shop) => (await q(
  'select * from public.shopify_connections where company_entity_id = $1 and shop_domain = $2', [company, shop]))[0];

await test('the migration applies twice', async () => {
  assert.equal((await q(`select count(*)::int n from pg_class where relname in ('shopify_install_states','shopify_pending_installs')`))[0].n, 2);
});

await park('t1', 'bat-nutz.myshopify.com');
await q("insert into public.shopify_install_states (nonce, shop_domain) values ('n1', 'bat-nutz.myshopify.com')");

await test('members and anon can never read, write or count a parked token', async () => {
  for (const [role, user] of [['authenticated', member], ['anon', null]]) {
    await as(role, user, async () => {
      await refused(() => q('select access_token from public.shopify_pending_installs'), /permission denied/, `${role} select pending`);
      await refused(() => q('select count(*) from public.shopify_pending_installs'), /permission denied/, `${role} count pending`);
      await refused(() => q(`insert into public.shopify_pending_installs (claim_hash, shop_domain, access_token)
        values ($1, 'x.myshopify.com', 'y')`, ['a'.repeat(64)]), /permission denied/, `${role} insert pending`);
      await refused(() => q('select * from public.shopify_install_states'), /permission denied/, `${role} select states`);
    });
  }
});

await test('the claim and purge functions are not client-callable', async () => {
  await as('authenticated', member, async () => {
    await refused(() => q('select * from public.shopify_claim_pending_install($1, $2, $3)', [hash('t1'), coA, member]),
      /permission denied/, 'authenticated claim');
    await refused(() => q('select public.shopify_purge_expired_installs()'), /permission denied/, 'authenticated purge');
  });
  await as('anon', null, async () => {
    await refused(() => q('select * from public.shopify_claim_pending_install($1, $2, $3)', [hash('t1'), coA, member]),
      /permission denied/, 'anon claim');
  });
});

await test('a new store is connected with sync off, and the claim is single use', async () => {
  const r = await claim('t1', coA);
  assert.equal(r.outcome, 'connected');
  const c = await conn(coA, 'bat-nutz.myshopify.com');
  assert.equal(c.access_token, 'tok-t1');
  assert.equal(c.auth_method, 'oauth');
  assert.equal(c.oauth_app, 'public');
  assert.equal(c.sync_enabled, false);
  assert.equal(c.created_by, member);
  assert.deepEqual(c.scopes_granted, ['read_orders']);
  assert.equal((await claim('t1', coB)).outcome, 'expired', 'a used claim finds nothing');
  assert.equal(await conn(coB, 'bat-nutz.myshopify.com'), undefined);
});

await test('a reinstall through the same public app refreshes the token and keeps sync', async () => {
  await q("update public.shopify_connections set sync_enabled = true where company_entity_id = $1", [coA]);
  await park('t2', 'bat-nutz.myshopify.com');
  // Out of order: install A, reinstall B (newest wins), claim B, then the old
  // A tab tries to claim. A must find nothing, or it would write a revoked
  // token over B's.
  await park('t2a', 'bat-nutz.myshopify.com');
  await park('t2', 'bat-nutz.myshopify.com');
  assert.equal((await q("select count(*)::int n from public.shopify_pending_installs where shop_domain = 'bat-nutz.myshopify.com'"))[0].n, 1);
  assert.equal((await claim('t2', coA)).outcome, 'refreshed');
  assert.equal((await claim('t2a', coA)).outcome, 'expired', 'the superseded claim link is dead');
  const c = await conn(coA, 'bat-nutz.myshopify.com');
  assert.equal(c.access_token, 'tok-t2');
  assert.equal(c.sync_enabled, true, 'a reinstall must not switch sync off');
  assert.equal(c.updated_by, member, 'the admin who claimed the reinstall is recorded, not erased');
  assert.equal((await q('select count(*)::int n from public.shopify_connections'))[0].n, 1);
});

await test('a store connected another way is never overwritten, and the claim stays usable', async () => {
  await q(`insert into public.shopify_connections (company_entity_id, shop_domain, access_token, auth_method, sync_enabled)
    values ($1, 'legacy.myshopify.com', 'legacy-token', 'client_credentials', true)`, [coA]);
  await park('t3', 'legacy.myshopify.com');
  const r = await claim('t3', coA);
  assert.equal(r.outcome, 'connected_other_way');
  const c = await conn(coA, 'legacy.myshopify.com');
  assert.equal(c.access_token, 'legacy-token');
  assert.equal(c.auth_method, 'client_credentials');
  assert.equal((await claim('t3', coB)).outcome, 'connected', 'the same claim may still go to a workspace that can take it');
});

await test('a closed connection of another kind is reopened as the public app, its old secret removed, sync off', async () => {
  const [{ id }] = await q(`insert into public.shopify_connections (company_entity_id, shop_domain, access_token, auth_method, is_active, sync_enabled)
    values ($1, 'closed.myshopify.com', null, 'client_credentials', false, true) returning id`, [coA]);
  await q(`insert into public.shopify_client_credentials (connection_id, company_entity_id, client_id, client_secret)
    values ($1, $2, 'cid', 'SECRET')`, [id, coA]);
  await park('t4', 'closed.myshopify.com');
  assert.equal((await claim('t4', coA)).outcome, 'connected');
  const c = await conn(coA, 'closed.myshopify.com');
  assert.equal(c.id, id, 'the same row is reused');
  assert.equal(c.oauth_app, 'public');
  assert.equal(c.is_active, true);
  assert.equal(c.sync_enabled, false);
  assert.equal((await q('select count(*)::int n from public.shopify_client_credentials where connection_id = $1', [id]))[0].n, 0);
});

await test('an expired claim is refused and the purge removes only expired rows', async () => {
  await park('t5', 'late.myshopify.com', { expired: true });
  await park('t6', 'live.myshopify.com');
  assert.equal((await claim('t5', coA)).outcome, 'expired');
  await q("insert into public.shopify_install_states (nonce, shop_domain, expires_at) values ('old', 'x.myshopify.com', now() - interval '1 minute')");
  const removed = (await q('select public.shopify_purge_expired_installs() n'))[0].n;
  assert.equal(removed, 2, 'one expired state + one expired pending install');
  assert.equal((await q("select count(*)::int n from public.shopify_pending_installs where shop_domain = 'live.myshopify.com'"))[0].n, 1);
});

await test("the migration's verify_v2_schema.sql check reads ok", async () => {
  const verify = await read('supabase/verify_v2_schema.sql');
  const start = verify.indexOf('-- ── Shopify-initiated install of the public app (20261007120000)');
  const end = verify.indexOf('as shopify_app_install;', start);
  assert.ok(start > 0 && end > start, 'verify block not found');
  const [row] = await q(verify.slice(start, end + 'as shopify_app_install'.length));
  assert.equal(row.shopify_app_install, 'ok');
});

console.log(`\n${passed} passed`);
