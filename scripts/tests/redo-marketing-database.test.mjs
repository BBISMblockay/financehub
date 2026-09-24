/* Redo marketing tables, executed against the real migration.
 *
 * Companion to redo-marketing-sync.test.mjs (the sync side). This half proves
 * what only the database can promise:
 *   1. The migration applies, and applies AGAIN (apply_all_post_merge.sql is
 *      re-run as a whole), without duplicating the catalog text or the
 *      job_type.
 *   2. The newest run wins: an upsert carrying an OLDER synced_at than the
 *      stored row is dropped, on both tables; equal passes (a retry).
 *   3. The identity is (company, kind, redo_id, channel, day) -- an upsert
 *      replaces, never duplicates.
 *   4. Tenancy: an authenticated user reads only their active company, through
 *      the tables AND the security_invoker view; authenticated cannot write;
 *      anon cannot read.
 *   5. sync_jobs.job_type gains 'redo_marketing' while every value already
 *      live survives, including one that exists only in "production".
 *   6. The view carries no rate column (rates belong to a window).
 *
 * Mutations (each must make this file FAIL):
 *   REDO_MKT_DB_MUTATION=no-stale-guard   (the newest-run trigger dropped)
 *   REDO_MKT_DB_MUTATION=open-select      (select policy not tenant-scoped)
 *   REDO_MKT_DB_MUTATION=catalog-replaces (catalog description overwritten)
 *
 * Run:  node scripts/tests/redo-marketing-database.test.mjs
 * Needs:  npm ci --prefix scripts/tests/finance-db
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.REDO_MKT_DB_MUTATION || '';
assert.ok(['', 'no-stale-guard', 'open-select', 'catalog-replaces'].includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const coA = randomUUID();
const coB = randomUUID();
const userA = randomUUID();

await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
// Fixtures: the connection table the new tables reference, sync_jobs with its
// LIVE constraint shape (plus a value that exists only here, standing in for a
// production-only value), the stamp-trigger helper (tested where it lives),
// and the catalog columns production has and the bootstrap stub does not.
await db.exec(`
  create table public.redo_connections (id uuid primary key, company_entity_id uuid references public.entities(id));
  create table public.sync_jobs (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, job_type text not null,
    constraint sync_jobs_job_type_check check (job_type = any (array['test_connection'::text, 'meta_creative_backfill'::text, 'prod_only_value'::text])));
  create function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select; $$;
  alter table public.silo_chat_schema_catalog add column relkind text, add column columns jsonb, add column updated_at timestamptz;
  insert into public.entities values ('${coA}', 'A'), ('${coB}', 'B');
  insert into auth.users values ('${userA}');
  insert into public.profiles (id, active_company_id) values ('${userA}', '${coA}');
`);

let migration = await readFile(new URL('supabase/migrations/20260924120000_redo_marketing_reporting.sql', root), 'utf8');
if (mutation === 'no-stale-guard') migration = migration.replace(/if new\.synced_at < old\.synced_at then\s+return null;\s+end if;/, '');
if (mutation === 'open-select') migration = migration.replaceAll('using (company_entity_id = public.active_company_id());', 'using (true);');
if (mutation === 'catalog-replaces') migration = migration.replace(/set description = case[\s\S]*?end,/, 'set description = excluded.description,');

await test('the migration applies twice without duplicating catalog text or job_type', async () => {
  await db.exec(migration);
  // A later hand-written append, which a re-run must not erase.
  await q(`update public.silo_chat_schema_catalog set description = description || ' LATER NOTE.' where relname = 'redo_marketing_daily_v'`);
  await db.exec(migration);
  const desc = (await one(`select description from public.silo_chat_schema_catalog where relname = 'redo_marketing_daily_v'`)).description;
  assert.equal(desc.split('REDO EMAIL/SMS MARKETING').length - 1, 1, 'catalog text appended once');
  assert.match(desc, /LATER NOTE\./, 'a later append survives a re-run');
  const def = (await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'sync_jobs_job_type_check'`)).d;
  assert.equal(def.split("'redo_marketing'").length - 1, 1);
  for (const v of ['test_connection', 'meta_creative_backfill', 'prod_only_value']) assert.match(def, new RegExp(`'${v}'`), `${v} kept`);
  await q(`insert into public.sync_jobs (company_entity_id, job_type) values ($1, 'redo_marketing')`, [coA]);
});

const upsertDaily = (co, syncedAt, orders) => q(`
  insert into public.redo_marketing_daily (company_entity_id, kind, redo_id, channel, day_date, orders, revenue, synced_at)
  values ($1, 'campaign', 'c1', 'EMAIL', '2026-09-02', $2, 10.50, $3)
  on conflict (company_entity_id, kind, redo_id, channel, day_date)
  do update set orders = excluded.orders, revenue = excluded.revenue, synced_at = excluded.synced_at`,
[co, orders, syncedAt]);

await test('an upsert replaces on the identity, never duplicates', async () => {
  await upsertDaily(coA, '2026-09-10T00:00:00Z', 1);
  await upsertDaily(coA, '2026-09-11T00:00:00Z', 2);
  const rows = await q(`select orders from public.redo_marketing_daily where company_entity_id = $1`, [coA]);
  assert.deepEqual(rows.map((r) => r.orders), [2]);
});

await test('the newest run wins: an older synced_at is dropped, an equal one passes', async () => {
  await upsertDaily(coA, '2026-09-09T00:00:00Z', 99); // older run, arriving late
  assert.equal((await one(`select orders from public.redo_marketing_daily where company_entity_id = $1`, [coA])).orders, 2);
  await upsertDaily(coA, '2026-09-11T00:00:00Z', 3); // a retry inside the same run
  assert.equal((await one(`select orders from public.redo_marketing_daily where company_entity_id = $1`, [coA])).orders, 3);

  await q(`insert into public.redo_marketing_messages (company_entity_id, kind, redo_id, name, synced_at)
           values ($1, 'campaign', 'c1', 'new name', '2026-09-11T00:00:00Z')`, [coA]);
  await q(`insert into public.redo_marketing_messages (company_entity_id, kind, redo_id, name, synced_at)
           values ($1, 'campaign', 'c1', 'stale name', '2026-09-01T00:00:00Z')
           on conflict (company_entity_id, kind, redo_id) do update set name = excluded.name, synced_at = excluded.synced_at`, [coA]);
  assert.equal((await one(`select name from public.redo_marketing_messages where company_entity_id = $1`, [coA])).name, 'new name');
});

await test('channel and kind are constrained', async () => {
  await assert.rejects(q(`insert into public.redo_marketing_daily (company_entity_id, kind, redo_id, channel, day_date, synced_at)
    values ($1, 'campaign', 'x', 'PUSH', '2026-09-02', now())`, [coA]), /check/i);
  await assert.rejects(q(`insert into public.redo_marketing_daily (company_entity_id, kind, redo_id, channel, day_date, synced_at)
    values ($1, 'flow', 'x', 'SMS', '2026-09-02', now())`, [coA]), /check/i);
});

await test('tenancy: a user reads only their active company, and cannot write', async () => {
  await upsertDaily(coB, '2026-09-11T00:00:00Z', 7);
  await q(`insert into public.redo_marketing_messages (company_entity_id, kind, redo_id, name, synced_at)
           values ($1, 'campaign', 'c1', 'B campaign', now())`, [coB]);
  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub', $1, false)", [userA]);
  try {
    const daily = await q(`select company_entity_id, orders from public.redo_marketing_daily`);
    assert.deepEqual(daily.map((r) => r.company_entity_id), [coA]);
    const view = await q(`select company_entity_id, name, orders from public.redo_marketing_daily_v`);
    assert.deepEqual(view.map((r) => [r.company_entity_id, r.name]), [[coA, 'new name']]);
    const msgs = await q(`select company_entity_id from public.redo_marketing_messages`);
    assert.deepEqual(msgs.map((r) => r.company_entity_id), [coA]);
    await assert.rejects(q(`insert into public.redo_marketing_daily (company_entity_id, kind, redo_id, channel, day_date, synced_at)
      values ($1, 'campaign', 'forged', 'EMAIL', '2026-09-02', now())`, [coA]), /row-level security|permission/i);
    await q(`update public.redo_marketing_daily set orders = 0`);
    await q(`delete from public.redo_marketing_daily`);
  } finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
  const after = await q(`select company_entity_id, orders from public.redo_marketing_daily order by orders`);
  assert.deepEqual(after.map((r) => r.orders), [3, 7], 'an authenticated update/delete touched nothing');

  await db.exec('set role anon');
  try {
    await assert.rejects(q(`select 1 from public.redo_marketing_daily`), /permission denied/);
    await assert.rejects(q(`select 1 from public.redo_marketing_messages`), /permission denied/);
    await assert.rejects(q(`select 1 from public.redo_marketing_daily_v`), /permission denied/);
  } finally {
    await db.exec('reset role');
  }
});

await test('the view carries counts and no rate column', async () => {
  const cols = (await q(`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'redo_marketing_daily_v'`)).map((r) => r.column_name);
  for (const c of ['delivered', 'unique_opens', 'unique_clicks', 'orders', 'revenue', 'spend', 'name', 'channel']) {
    assert.ok(cols.includes(c), `${c} present`);
  }
  assert.deepEqual(cols.filter((c) => /rate/.test(c)), []);
  const opts = (await one(`select reloptions from pg_class where relname = 'redo_marketing_daily_v'`)).reloptions;
  assert.ok(String(opts).includes('security_invoker=true'));
});

console.log(`1..${passed}`);
