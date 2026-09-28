// Ask SILO deferred replies (20260928140000) against a REAL PostgreSQL
// (PGlite), as authenticated users -- not a mock, not the service role.
//
// What it proves: a finished reply is readable by the person who asked and by
// nobody else (not a colleague, not an executive, not anon); nobody can write a
// reply under someone else's name; a delivered reply cannot be edited or
// deleted from a client; and one request id holds one reply.
//
// Run:  node scripts/tests/silo-chat-responses-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db
// Mutations (each must fail at least one assertion):
//   SILO_RESPONSES_DB_MUTATION=exec-reads      (select policy also admits is_exec_or_owner())
//   SILO_RESPONSES_DB_MUTATION=insert-anyone   (insert policy drops the created_by check)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const mutation = process.env.SILO_RESPONSES_DB_MUTATION || '';
assert.ok(['', 'exec-reads', 'insert-anyone'].includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const co = randomUUID();
const asker = randomUUID(), colleague = randomUUID(), exec = randomUUID();
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
async function as(role, user, fn) {
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  try { return await fn(); }
  finally { await db.exec('reset role'); await q("select set_config('request.jwt.claim.sub', '', false)"); }
}
async function refused(fn, what) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  assert.ok(msg !== null, `${what}: expected a refusal`);
}

// Foundation: the SEO bootstrap (auth, profiles, companies, the catalog with its
// real columns). The company stamp is a separate, separately-tested mechanism,
// so it is a no-op here: nothing below depends on it.
await db.exec(await readFile(new URL('./seo-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(`
  create or replace function public.stamp_created_by() returns trigger language plpgsql as $$
  begin new.created_by := coalesce(new.created_by, auth.uid()); return new; end; $$;
  create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select; $$;
`);
let migration = await readFile(new URL('supabase/migrations/20260928140000_silo_chat_responses.sql', root), 'utf8');
if (mutation === 'exec-reads') {
  migration = migration.replace('for select using (created_by = auth.uid());',
    'for select using (created_by = auth.uid() or public.is_exec_or_owner());');
}
if (mutation === 'insert-anyone') {
  migration = migration.replace('for insert with check (created_by = auth.uid());', 'for insert with check (true);');
}
await db.exec(migration);
// Applied twice: every migration here must be re-runnable (apply_all_post_merge.sql).
await db.exec(migration);

await db.exec(`insert into public.entities (id, title) values ('${co}', 'Co')`);
for (const [id, role] of [[asker, 'admin'], [colleague, 'admin'], [exec, 'owner']]) {
  await db.exec(`insert into auth.users (id) values ('${id}')`);
  await db.exec(`insert into public.profiles (id, role, is_active, active_company_id) values ('${id}', '${role}', true, '${co}')`);
}

const rid = randomUUID();
await test('the asker writes and reads their own finished reply', async () => {
  await as('authenticated', asker, () => q(
    `insert into public.silo_chat_responses (request_id, http_status, response) values ($1, 200, '{"answer":"hi"}')`, [rid]));
  const rows = await as('authenticated', asker, () => q('select request_id, http_status, response, created_by from public.silo_chat_responses'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response.answer, 'hi');
  assert.equal(rows[0].created_by, asker, 'created_by was not stamped as the asker');
});

await test('a colleague cannot read it', async () => {
  const rows = await as('authenticated', colleague, () => q('select * from public.silo_chat_responses'));
  assert.equal(rows.length, 0);
});

await test('an owner/executive cannot read it either (the audit log is the oversight surface)', async () => {
  const rows = await as('authenticated', exec, () => q('select * from public.silo_chat_responses'));
  assert.equal(rows.length, 0);
});

await test('anon cannot read it', async () => {
  await refused(() => as('anon', null, () => q('select * from public.silo_chat_responses')), 'anon select');
});

await test('nobody can write a reply under someone else\'s name', async () => {
  await refused(() => as('authenticated', colleague, () => q(
    `insert into public.silo_chat_responses (request_id, http_status, response, created_by) values ($1, 200, '{"answer":"fake"}', $2)`,
    [randomUUID(), asker])), 'spoofed created_by');
});

await test('a delivered reply cannot be edited or deleted from a client', async () => {
  await refused(() => as('authenticated', asker, () => q(
    `update public.silo_chat_responses set response = '{"answer":"changed"}' where request_id = $1`, [rid])), 'update');
  await refused(() => as('authenticated', asker, () => q(
    'delete from public.silo_chat_responses where request_id = $1', [rid])), 'delete');
});

await test('one request id holds one reply', async () => {
  await refused(() => as('authenticated', asker, () => q(
    `insert into public.silo_chat_responses (request_id, http_status, response) values ($1, 200, '{"answer":"again"}')`, [rid])),
  'duplicate request id');
});

await test('the table is hidden from Ask SILO\'s own index', async () => {
  const rows = await q(`select is_hidden from public.silo_chat_schema_catalog where relname = 'silo_chat_responses'`);
  assert.equal(rows[0]?.is_hidden, true);
});

console.log(`${passed} silo_chat_responses checks passed (local PostgreSQL only).`);
