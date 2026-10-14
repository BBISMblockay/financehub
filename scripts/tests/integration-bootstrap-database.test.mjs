// scripts/tests/integration-bootstrap-database.test.mjs
//
// The parts of first-connect auto sync that are enforced by the database, on
// real PostgreSQL (PGlite): the tenant boundary on the queue, the admin gate
// on enqueueing, the partial unique index that stops one connection being
// imported twice, and the lease that stops two drainers doing the same job.
//
// The lease is the one worth being careful about: without it, two overlapping
// runs (the schedule is every 15 minutes and GitHub delivers schedules late
// and in bursts) would both claim the same row and both pay for the same API
// calls, and a row left `running` by a killed runner would never be picked up
// again. Both directions are asserted here.
//
// Mutations this suite is meant to catch, each confirmed to fail it:
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=rls        RLS left off the table
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=admin      insert policy drops is_admin_user()
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=lease      claim ignores a live lease
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=attempts   claim ignores the attempt cap
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=uniq       the open-job index is dropped
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=grant      claim stays client-callable
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=anongrant  anon keeps Supabase's default table grant
//   INTEGRATION_BOOTSTRAP_DB_MUTATION=skiplocked  the claim selects rows without locking them

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.INTEGRATION_BOOTSTRAP_DB_MUTATION || '';
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table entities(id uuid primary key);
-- The two gates the policies read, as switches a test can flip.
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_admin_user() returns boolean language sql as
  $$ select coalesce(nullif(current_setting('test.admin', true), '')::boolean, false) $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
-- Supabase's own default privileges, which are the reason the migration has
-- to revoke rather than simply not grant: every new public table and function
-- is handed to anon and authenticated as it is created. Without this line the
-- harness is more locked down than production and the revokes look
-- unnecessary -- two mutations against them passed until this was added.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

let migration = await readFile(
  new URL('../../supabase/migrations/20261013060000_integration_bootstrap_jobs.sql', import.meta.url),
  'utf8',
);
if (MUT === 'rls') migration = migration.replace('enable row level security', 'disable row level security');
if (MUT === 'admin') migration = migration.replace('and public.is_admin_user()', '');
if (MUT === 'anongrant') migration = migration.replace('revoke all on public.integration_bootstrap_jobs from anon;', '');
if (MUT === 'lease') migration = migration.replace(
  'and (c.lease_until is null or c.lease_until < now())', '',
);
if (MUT === 'attempts') migration = migration.replace(
  'and c.attempts < greatest(p_max_attempts, 1)', '',
);
if (MUT === 'uniq') migration = migration.replace(
  /create unique index if not exists integration_bootstrap_jobs_open_uniq[\s\S]*?;\n/,
  '',
);
if (MUT === 'skiplocked') migration = migration.replace('      for update skip locked\n', '');
if (MUT === 'grant') migration = migration.replace(
  /revoke all on function public\.claim_integration_bootstrap_jobs\(integer, integer, integer\) from authenticated;/,
  '',
);

// Twice: a migration that is not idempotent breaks apply_all_post_merge.sql.
await db.exec(migration);
await db.exec(migration);

// ── The verifier's own block, first ───────────────────────────────────────
// The daily drift check runs verify_v2_schema.sql against production, so a
// block that cannot see a degradation is a degradation nobody is told about.
// The real text is executed, not a copy, so the two cannot drift -- and it
// runs before the behavioural assertions below so that every mutation reaches
// it rather than failing earlier.
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const verifyStart = verifySql.indexOf("select 'Integration bootstrap queue' as check_name,");
assert.ok(verifyStart >= 0, 'Integration bootstrap verify block missing');
let verifyBlock = verifySql.slice(verifyStart);
// Later verify rows (e.g. report_email_schedules) must not ride along — one
// statement per db.query, and each suite owns its own block.
const verifyEnd = verifyBlock.indexOf("select 'report_email_schedules table' as check_name,");
if (verifyEnd > 0) verifyBlock = verifyBlock.slice(0, verifyEnd);
verifyBlock = verifyBlock.trim();
assert.ok(verifyBlock.length > 100 && verifyBlock.endsWith(';'), 'could not extract the verify block');
const verifyStatus = async () => (await db.query(verifyBlock)).rows[0].status;
if (MUT) {
  assert.notEqual(await verifyStatus(), 'ok', `verify_v2_schema.sql reports ok under the ${MUT} mutation`);
} else {
  assert.equal(await verifyStatus(), 'ok', 'a correctly applied migration must verify ok');
}

const co = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const connA = '00000000-0000-0000-0000-00000000000a';
const connB = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [co, other]);

assert.equal(
  (await db.query("select relrowsecurity from pg_class where oid='integration_bootstrap_jobs'::regclass")).rows[0].relrowsecurity,
  true,
  'RLS must be on: this table names every connection a tenant has',
);

// ── Enqueueing is an admin act on the admin's own company ─────────────────
const asUser = async (company, admin) => {
  await db.exec('reset role');
  await db.query("select set_config('test.company', $1, false)", [company || '']);
  await db.query("select set_config('test.admin', $1, false)", [admin ? 'true' : 'false']);
  await db.exec('set role authenticated');
};
const enqueue = (company, integration, connection) => db.query(
  'insert into integration_bootstrap_jobs(company_entity_id, integration, connection_id) values($1,$2,$3) returning id',
  [company, integration, connection],
);

await asUser(co, false);
await assert.rejects(enqueue(co, 'shopify', connA), /row-level security/, 'a non-admin must not queue a sync');

await asUser(co, true);
await assert.rejects(enqueue(other, 'shopify', connA), /row-level security/, "an admin must not queue work in another tenant's company");
await assert.rejects(enqueue(co, 'quickbooks', connA), /integration_check|violates check/, 'an integration no drainer can plan must be refused at the door');
const jobA = (await enqueue(co, 'shopify', connA)).rows[0].id;

// One OPEN job per connection: a double-click, a reconnect or a retried
// insert must not queue a second 60-day import.
await assert.rejects(enqueue(co, 'shopify', connA), /duplicate key|unique/, 'a second open job for one connection must be refused');
// A different connection of the same integration is different work.
await enqueue(co, 'shopify', connB);
// Redo has one row per company and no connection id; that is still one job.
await enqueue(co, 'redo', null);
await assert.rejects(enqueue(co, 'redo', null), /duplicate key|unique/, 'the null connection_id must collide with itself');

// Another company's admin sees none of it.
await asUser(other, true);
assert.equal((await db.query('select * from integration_bootstrap_jobs')).rows.length, 0, 'the queue must be tenant-scoped');

// anon holds no grant at all on this table: Supabase's default privileges
// would have given it one, and a later permissive policy would then make
// every tenant's connection list public.
await db.exec('reset role; set role anon');
await assert.rejects(db.query('select * from integration_bootstrap_jobs'), /permission denied/, 'anon must hold no grant on the queue');

// An admin may cancel their own queued job, and may not pass it off as done.
await asUser(co, true);
assert.equal(
  (await db.query("update integration_bootstrap_jobs set status='cancelled' where id=$1 returning id", [jobA])).rows.length,
  1,
);
// Calling a job done is the drainer's to say. The WITH CHECK half of the
// policy RAISES here rather than filtering the row away -- only the USING
// half turns a refusal into "zero rows updated" -- so this is an error, and
// the page must not treat it as a no-op.
await assert.rejects(
  db.query("update integration_bootstrap_jobs set status='done' where connection_id=$1 returning id", [connB]),
  /row-level security/,
  'only the drainer may call a job done',
);
// A job belonging to another tenant is filtered by USING instead, so that
// one really does come back as zero rows.
await asUser(other, true);
assert.equal(
  (await db.query("update integration_bootstrap_jobs set status='cancelled' where connection_id=$1 returning id", [connB])).rows.length,
  0,
  "another tenant's job is invisible, not refused",
);
await asUser(co, true);

// Two drainers overlap (the schedule is every 15 minutes, GitHub delivers
// late and in bursts), and the lease is only half of what keeps them apart:
// without `for update skip locked` two claims running at the same instant can
// select the same id, and the second one's safety then rests on Postgres
// re-checking the outer qual after the lock clears. Structural, because the
// race it closes cannot be staged in a single-connection test.
assert.match(
  (await db.query("select pg_get_functiondef(oid) as def from pg_proc where proname = 'claim_integration_bootstrap_jobs'")).rows[0].def,
  /for update\s+skip locked/i,
  'the claim must lock the rows it selects',
);

// The claim function is the drainer's, not the browser's.
for (const role of ['anon', 'authenticated']) {
  assert.equal(
    (await db.query('select has_function_privilege($1, $2, $3) as ok', [role, 'public.claim_integration_bootstrap_jobs(integer,integer,integer)', 'execute'])).rows[0].ok,
    false,
    `${role} must not be able to claim jobs`,
  );
}

// ── The lease ─────────────────────────────────────────────────────────────
await db.exec('reset role; set role service_role');
// Only the two open rows remain claimable (jobA was cancelled).
const claim = async (lease = 900, maxAttempts = 5, limit = 10) => (await db.query(
  'select id, status, attempts, lease_until from claim_integration_bootstrap_jobs($1,$2,$3)',
  [limit, lease, maxAttempts],
)).rows;

const first = await claim();
assert.deepEqual(
  first.map((r) => r.status),
  first.map(() => 'running'),
  'a claimed job is running',
);
assert.equal(first.length, 2, 'the cancelled job must not be claimable');
assert.ok(first.every((r) => r.attempts === 1 && r.lease_until), 'the claim counts the attempt and takes a lease');

// A second drainer, while the lease is live, gets nothing.
assert.deepEqual(await claim(), [], 'a live lease must keep another drainer off the row');

// A runner that died leaves the row running with an expired lease, and that
// row is work again -- which is the whole reason the lease exists rather than
// a status flag.
await db.query("update integration_bootstrap_jobs set lease_until = now() - interval '1 minute' where status='running'");
const second = await claim();
assert.equal(second.length, 2, 'an expired lease must make the row claimable');
assert.ok(second.every((r) => r.attempts === 2), 'the retry is counted');

// The attempt cap is what stops a credential that will never work from being
// retried every few minutes for ever, each attempt a paid API call.
await db.query("update integration_bootstrap_jobs set lease_until = null, attempts = 5 where status='running'");
assert.deepEqual(await claim(900, 5), [], 'a row at the attempt cap must be left alone');
assert.equal((await claim(900, 6)).length, 2, 'raising the cap makes it claimable again');

// A finished job does not collide, so a connection can be re-imported
// deliberately later.
await db.exec('reset role');
await db.query("update integration_bootstrap_jobs set status='done', finished_at=now() where connection_id=$1", [connB]);
await asUser(co, true);
await enqueue(co, 'shopify', connB);

await db.exec('reset role; set role service_role');
assert.equal((await claim()).length, 1, 'the re-queued job is claimable on its own');

await db.close();
console.log(`Integration bootstrap DB: tenant scope, admin gate, one-open-job index, lease, attempt cap and the verify block passed${MUT ? ` (mutation: ${MUT})` : ''}`);
