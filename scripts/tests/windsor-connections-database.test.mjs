// scripts/tests/windsor-connections-database.test.mjs
//
// The database half of the Windsor tenant broker (20261102220000), on real
// PostgreSQL (PGlite). SILO holds one Windsor owner key for every company, so
// the account -> company mapping is the tenant boundary. Asserted here:
// company A's admin never sees company B's accounts, no client can read a
// link token or write a mapping, one account belongs to one company, and an
// account cannot be filed under a company other than its link's.
//
// Mutations this suite must catch (CI runs each and requires a failure):
//   WINDSOR_DB_MUTATION=rls        RLS left off windsor_linked_accounts
//   WINDSOR_DB_MUTATION=company    the select policy drops the company filter
//   WINDSOR_DB_MUTATION=tokens     authenticated keeps SELECT on windsor_links
//   WINDSOR_DB_MUTATION=writes     authenticated keeps write grants on accounts
//   WINDSOR_DB_MUTATION=uniq       (ds_id, account_id) not unique
//   WINDSOR_DB_MUTATION=linkfk     the link FK no longer carries the company

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.WINDSOR_DB_MUTATION || '';
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table entities(id uuid primary key);
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_admin_user() returns boolean language sql as
  $$ select coalesce(nullif(current_setting('test.admin', true), '')::boolean, false) $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
-- Supabase's own default privileges: the reason the migration must revoke.
alter default privileges in schema public grant all on tables to anon, authenticated;
`);

let migration = await readFile(
  new URL('../../supabase/migrations/20261102220000_windsor_connections.sql', import.meta.url), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation ${MUT}: pattern not found`);
  migration = migration.replace(from, to);
};
if (MUT === 'rls') mutate('alter table public.windsor_linked_accounts enable row level security;', '');
if (MUT === 'company') mutate('using (company_entity_id = public.active_company_id() and public.is_admin_user())', 'using (public.is_admin_user())');
if (MUT === 'tokens') mutate('revoke all on public.windsor_links from anon, authenticated;', 'revoke all on public.windsor_links from anon;');
if (MUT === 'writes') mutate('revoke all on public.windsor_linked_accounts from anon, authenticated;', 'revoke all on public.windsor_linked_accounts from anon;');
if (MUT === 'uniq') mutate('  constraint windsor_linked_accounts_account_uniq unique (ds_id, account_id),\n', '');
if (MUT === 'linkfk') mutate(
  'foreign key (link_id, company_entity_id)\n    references public.windsor_links(id, company_entity_id)',
  'foreign key (link_id)\n    references public.windsor_links(id)');

// Twice: apply_all_post_merge.sql re-runs every migration.
await db.exec(migration);
await db.exec(migration);

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const start = verifySql.indexOf("select 'Windsor tenant broker' as check_name,");
assert.ok(start >= 0, 'Windsor verify block missing');
let block = verifySql.slice(start);
const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
if (next) block = block.slice(0, next.index + 1);
block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
assert.ok(block.endsWith(';'), 'could not extract the verify block');
const verifyStatus = (await db.query(block)).rows[0].status;
if (MUT) assert.notEqual(verifyStatus, 'ok', `verify reports ok under the ${MUT} mutation`);
else assert.equal(verifyStatus, 'ok', `a correctly applied migration must verify ok (got ${verifyStatus})`);

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [A, B]);

// The broker writes as the service role.
await db.exec('set role service_role');
const linkA = (await db.query("insert into windsor_links(company_entity_id, access_token, allowed_source) values($1,'tok-a-123456','klaviyo') returning id", [A])).rows[0].id;
const linkB = (await db.query("insert into windsor_links(company_entity_id, access_token, allowed_source) values($1,'tok-b-123456','klaviyo') returning id", [B])).rows[0].id;
await db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'klaviyo','acct-A')", [A, linkA]);
await db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'klaviyo','acct-B')", [B, linkB]);

// One account, one company.
await assert.rejects(
  db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'klaviyo','acct-A')", [B, linkB]),
  /duplicate key|unique/, 'an account already attributed to A must not also be filed under B');
// The same id under a different data source is a different account.
await db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'tiktok','acct-A')", [A, linkA]);
// An account's company is its link's company.
await assert.rejects(
  db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'klaviyo','acct-X')", [B, linkA]),
  /foreign key/, "an account must not be filed under a company other than its link's");
await db.exec('reset role');

const asUser = async (company, admin) => {
  await db.exec('reset role');
  await db.query("select set_config('test.company', $1, false)", [company || '']);
  await db.query("select set_config('test.admin', $1, false)", [admin ? 'true' : 'false']);
  await db.exec('set role authenticated');
};

// A's admin sees A's accounts and nothing of B's.
await asUser(A, true);
const seenA = (await db.query('select account_id from windsor_linked_accounts order by ds_id, account_id')).rows.map((r) => r.account_id);
assert.deepEqual(seenA, ['acct-A', 'acct-A'], "A's admin sees exactly A's accounts");
// B's admin sees B's.
await asUser(B, true);
assert.deepEqual((await db.query('select account_id from windsor_linked_accounts')).rows.map((r) => r.account_id), ['acct-B']);
// A non-admin sees nothing.
await asUser(A, false);
assert.equal((await db.query('select * from windsor_linked_accounts')).rows.length, 0, 'non-admins see no connections');

// No client reads a link token, ever.
await asUser(A, true);
await assert.rejects(db.query('select access_token from windsor_links'), /permission denied/, 'link tokens are not client-readable');
// No client writes a mapping: a forged row would file someone's account under you.
await assert.rejects(
  db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id) values($1,$2,'klaviyo','forged')", [A, linkA]),
  /permission denied/, 'clients cannot insert mappings');
await assert.rejects(db.query("update windsor_linked_accounts set company_entity_id = $1", [A]), /permission denied/, 'clients cannot move mappings');
await assert.rejects(db.query('delete from windsor_linked_accounts'), /permission denied/, 'clients cannot delete mappings');

// anon holds nothing.
await db.exec('reset role; set role anon');
await assert.rejects(db.query('select * from windsor_linked_accounts'), /permission denied/);
await assert.rejects(db.query('select * from windsor_links'), /permission denied/);
await db.exec('reset role');

console.log(MUT ? `ran under ${MUT}` : 'windsor connections database: all assertions passed');
