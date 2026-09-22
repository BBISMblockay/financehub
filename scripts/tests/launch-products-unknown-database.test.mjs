process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20260922150000_launch_products_unknown.sql against a real PostgreSQL:
// additive, applies twice, stamps `products_unknown_by` from auth.uid() and
// never from the client, keeps the original author on later edits, and a
// cleared flag carries no stale author or note -- by trigger for app writes and
// by CHECK for any writer that goes round the trigger.
// Run: node scripts/tests/launch-products-unknown-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20260922150000_launch_products_unknown.sql', root), 'utf8');
const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const FORGED = '33333333-3333-4333-8333-333333333333';
const asUser = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);

await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;
  create table public.launch_calendar(id uuid primary key default gen_random_uuid(), title text not null,
    launch_date date not null, linked_po_id uuid);
  create function public.refresh_chat_schema_catalog() returns void language sql as $$ select $$;
`);
await db.exec(migration);
await db.exec(migration);

await test('applies twice; three columns, one trigger, one CHECK', async () => {
  const c = await one(`select count(*)::int n from information_schema.columns where table_schema='public'
    and table_name='launch_calendar' and column_name like 'products_unknown%'`);
  assert.equal(c.n, 3);
  const t = await one(`select count(*)::int n from pg_trigger where tgname='trg_launch_products_unknown' and not tgisinternal`);
  assert.equal(t.n, 1);
  const k = await one(`select count(*)::int n from pg_constraint where conname='launch_calendar_products_unknown_consistent'`);
  assert.equal(k.n, 1);
});

await test('an existing launch is untouched: not deferred', async () => {
  const r = await one(`insert into public.launch_calendar(title, launch_date) values ('Old', '2026-01-01') returning *`);
  assert.equal(r.products_unknown_at, null);
  assert.equal(r.products_unknown_by, null);
});

let id;
await test('marking "not known yet" stamps the caller, ignoring a forged author', async () => {
  await asUser(ALICE);
  const r = await one(`insert into public.launch_calendar(title, launch_date, products_unknown_at, products_unknown_by, products_unknown_note)
    values ('Mystery', '2026-10-01', now(), $1, 'waiting on factory') returning *`, [FORGED]);
  id = r.id;
  assert.equal(r.products_unknown_by, ALICE);
  assert.equal(r.products_unknown_note, 'waiting on factory');
});

await test('a later edit by someone else keeps the original author', async () => {
  await asUser(BOB);
  const r = await one(`update public.launch_calendar set products_unknown_note='factory confirms Friday', products_unknown_by=$2
    where id=$1 returning *`, [id, FORGED]);
  assert.equal(r.products_unknown_by, ALICE);
  assert.equal(r.products_unknown_note, 'factory confirms Friday');
});

await test('clearing the flag clears author and note with it', async () => {
  const r = await one(`update public.launch_calendar set products_unknown_at=null where id=$1 returning *`, [id]);
  assert.equal(r.products_unknown_by, null);
  assert.equal(r.products_unknown_note, null);
});

await test('re-marking later stamps the new caller', async () => {
  await asUser(BOB);
  const r = await one(`update public.launch_calendar set products_unknown_at=now() where id=$1 returning *`, [id]);
  assert.equal(r.products_unknown_by, BOB);
});

await test('the CHECK refuses a note with no flag when the trigger is bypassed', async () => {
  await db.exec(`alter table public.launch_calendar disable trigger trg_launch_products_unknown`);
  await assert.rejects(
    db.query(`insert into public.launch_calendar(title, launch_date, products_unknown_note) values ('Bad', '2026-10-02', 'orphan note')`),
    /launch_calendar_products_unknown_consistent/);
  await db.exec(`alter table public.launch_calendar enable trigger trg_launch_products_unknown`);
});

await test('the trigger function is not callable by anon or authenticated', async () => {
  const r = await one(`select has_function_privilege('anon','public.stamp_launch_products_unknown()','EXECUTE') a,
                              has_function_privilege('authenticated','public.stamp_launch_products_unknown()','EXECUTE') b`);
  assert.equal(r.a, false);
  assert.equal(r.b, false);
});

console.log(`\n${checks} checks passed`);
