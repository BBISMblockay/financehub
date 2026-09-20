// The stamp helper is idempotent, and check 6 can actually fail.
//
// Both properties are here because PR #736 put this helper into CLAUDE.md's
// "Adding a new DB table" checklist. That turns a once-a-quarter repair into a
// step on every future migration, and two things that were tolerable as a
// one-off stop being tolerable as routine:
//
//   1. The helper ran DROP + CREATE TRIGGER on EVERY eligible table -- 164 on
//      production. Inside a migration transaction those ACCESS EXCLUSIVE locks
//      are held to COMMIT, so a migration adding one table would lock 164
//      operational tables and block behind the first long transaction it met.
//      Proven here by TRIGGER OID STABILITY: a correctly bound trigger must
//      come out of a re-run with the same oid, which it cannot do if it was
//      dropped and recreated. Counting DDL is not possible from SQL; oid
//      identity is the observable that means "untouched".
//
//   2. Check 6 compared a COUNT of triggers to a COUNT of required tables over
//      DIFFERENT sets, leaving permanent slack (measured 5 on production). One
//      through five required tables could lose their trigger and it still read
//      'ok'. The fixture here removes EXACTLY ONE and requires red -- which
//      the old check could not deliver.
//
// Mutations (each must make a specific assertion fail):
//   STAMP_MUTATION=helper-drops-everything  (helper back to unconditional DROP+CREATE)
//   STAMP_MUTATION=verify-counts            (check 6 back to the count comparison)
//   STAMP_MUTATION=predicate-loose          (both predicates back to `tgenabled <> 'D'`
//                                            and bitwise `& 4`, which accept a
//                                            replica-only trigger and a
//                                            BEFORE INSERT OR UPDATE one)
//
// Run: node scripts/tests/stamp-trigger-helper.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.STAMP_MUTATION || '';
assert.ok(['', 'helper-drops-everything', 'verify-counts', 'predicate-loose'].includes(mutation),
  `Unknown mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

// Minimal fixture: active_company_id(), the stamp function, and a handful of
// company-scoped tables including the five the verifier excludes but the
// helper still covers -- that asymmetry is what produced the slack.
await db.exec(`
  create schema if not exists auth;
  create function auth_uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function public.active_company_id() returns uuid language sql stable as $$ select null::uuid $$;
  create table public.entities (id uuid primary key default gen_random_uuid());
  create table public.alpha  (id int primary key, company_entity_id uuid);
  create table public.bravo  (id int primary key, company_entity_id uuid);
  create table public.charlie(id int primary key, company_entity_id uuid);
  create table public.inventory_on_hand (id int primary key, company_entity_id uuid);
  create table public.sales_by_day      (id int primary key, company_entity_id uuid);
  create table public.plaid_connections        (id int primary key, company_entity_id uuid);
  create table public.plaid_connection_secrets (id int primary key, company_entity_id uuid);
  create table public.plaid_accounts           (id int primary key, company_entity_id uuid);
  create table public.plaid_sync_exceptions    (id int primary key, company_entity_id uuid);
  create table public.finance_audit_events     (id int primary key, company_entity_id uuid);
`);

await db.exec(await readFile(new URL('supabase/migrations/20260616060000_stamp_company_entity_id_on_insert.sql', root), 'utf8'));

let sql = await readFile(new URL('supabase/migrations/20260920150000_stamp_trigger_idempotent_and_verified.sql', root), 'utf8');
if (mutation === 'predicate-loose') {
  sql = sql.replace("and tg.tgenabled in ('O', 'A')", "and tg.tgenabled <> 'D'")
           .replace('and tg.tgtype = 7', 'and (tg.tgtype & 1) = 1 and (tg.tgtype & 2) = 2 and (tg.tgtype & 4) = 4');
}
if (mutation === 'helper-drops-everything') {
  // Put the unconditional loop back: no "already correct" filter at all.
  sql = sql.replace(/-- The whole point[\s\S]*?\n       \)\n  loop/, '  loop');
}
await db.exec(sql);

const triggerOids = async () => Object.fromEntries((await q(`
  select cl.relname as tbl, tg.oid::text as oid
    from pg_trigger tg join pg_class cl on cl.oid = tg.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname='public' and tg.tgname='stamp_company_entity_id' and not tg.tgisinternal
`)).map((r) => [r.tbl, r.oid]));

// ── 1. A re-run with nothing to do must touch nothing ───────────────────────
await test('a no-op re-run leaves every existing trigger untouched (same oid)', async () => {
  const before = await triggerOids();
  assert.ok(Object.keys(before).length >= 8, 'the fixture should already be fully stamped');
  await q('select public.attach_stamp_company_entity_id_triggers()');
  const after = await triggerOids();
  assert.deepEqual(after, before,
    'a trigger oid changed, so it was dropped and recreated -- the helper is not a no-op, '
    + 'and as a per-migration checklist step it would take ACCESS EXCLUSIVE locks on every table');
});

// ── 2. It still does the job it exists for ──────────────────────────────────
await test('a newly added table gets the trigger, and only that one is touched', async () => {
  await db.exec('create table public.delta (id int primary key, company_entity_id uuid)');
  const before = await triggerOids();
  await q('select public.attach_stamp_company_entity_id_triggers()');
  const after = await triggerOids();
  assert.ok(after.delta, 'the new table must be stamped');
  delete after.delta;
  assert.deepEqual(after, before, 'nothing else should have been recreated');

  // And the trigger actually works.
  await q('insert into public.delta(id) values (1)');
  assert.equal((await one('select company_entity_id from public.delta where id=1')).company_entity_id, null,
    'active_company_id() is null in this fixture, so the stamp is a no-op by design');
});

// ── 3. A trigger with the right NAME and the wrong body is repaired ─────────
await test('a wrongly bound trigger is dropped and rebound, not skipped', async () => {
  await db.exec(`
    create function public.wrong_stamp() returns trigger language plpgsql as $$ begin return new; end $$;
    drop trigger stamp_company_entity_id on public.alpha;
    create trigger stamp_company_entity_id before insert on public.alpha
      for each row execute function public.wrong_stamp();
  `);
  await q('select public.attach_stamp_company_entity_id_triggers()');
  const bound = await one(`select tg.tgfoid::regprocedure::text as fn
     from pg_trigger tg join pg_class cl on cl.oid=tg.tgrelid
    where cl.relname='alpha' and tg.tgname='stamp_company_entity_id' and not tg.tgisinternal`);
  assert.match(bound.fn, /stamp_company_entity_id/,
    'a name-only check would have left this pointing at the wrong function');
});

// ── 4. Check 6 must go red for ONE missing table ────────────────────────────
const verifyCheck = async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf('-- An ANTI-JOIN, not a count comparison');
  const end = verify.indexOf('-- 7. Shopify integration tables');
  assert.ok(start > 0 && end > start, 'check 6 must be locatable by its own comment');
  let stmt = verify.slice(start, end).split(/;\s*\n/)[0] + ';';
  if (mutation === 'predicate-loose') {
    stmt = stmt.replace("and tg.tgenabled in ('O', 'A')", "and tg.tgenabled <> 'D'")
               .replace('and tg.tgtype = 7', 'and (tg.tgtype & 1) = 1 and (tg.tgtype & 2) = 2 and (tg.tgtype & 4) = 4');
  }
  if (mutation === 'verify-counts') {
    stmt = `select count(*)::int as required_tables,
      case when count(*) >= (
        select count(*) from information_schema.columns c
        join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name
        where c.table_schema='public' and c.column_name='company_entity_id' and t.table_type='BASE TABLE'
          and c.table_name not in ('inventory_on_hand','sales_by_day','plaid_connections',
              'plaid_connection_secrets','plaid_accounts','plaid_sync_exceptions','finance_audit_events')
      ) then 'ok' else 'MISSING' end as status
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and t.tgname='stamp_company_entity_id' and not t.tgisinternal;`;
  }
  return (await one(stmt)).status;
};

await test('check 6 reads ok when every required table is stamped', async () => {
  assert.equal(await verifyCheck(), 'ok');
});

await test('check 6 goes red for exactly ONE missing table, and names it', async () => {
  await db.exec('drop trigger stamp_company_entity_id on public.bravo');
  const status = await verifyCheck();
  assert.notEqual(status, 'ok',
    'one required table has no stamp trigger and the check still passed -- this is the '
    + 'count-vs-count slack that let five tables hide');
  assert.match(status, /bravo/, 'the failure must name the table, or the next person counts by hand');
  await q('select public.attach_stamp_company_entity_id_triggers()');
  assert.equal(await verifyCheck(), 'ok', 'and the helper repairs it');
});

// ── 5. A trigger that exists but does not FIRE ──────────────────────────────
// The nastiest shape, because both safeguards agree on the wrong answer: a
// replica-only trigger is present, enabled and correctly bound, and does not
// run in the origin session mode every application insert uses.
await test('a replica-only trigger is treated as missing, not as healthy', async () => {
  await db.exec('alter table public.charlie enable replica trigger stamp_company_entity_id');
  const status = await verifyCheck();
  assert.notEqual(status, 'ok',
    'a replica-only trigger does not fire for ordinary inserts, so the backstop is off '
    + 'while the check reports healthy');
  assert.match(status, /charlie/, 'and the failure must name it');

  await q('select public.attach_stamp_company_entity_id_triggers()');
  const fixed = await one(`select tg.tgenabled, tg.tgtype from pg_trigger tg
     join pg_class cl on cl.oid=tg.tgrelid
    where cl.relname='charlie' and tg.tgname='stamp_company_entity_id' and not tg.tgisinternal`);
  assert.equal(fixed.tgenabled, 'O', 'the helper must repair it to origin mode');
  assert.equal(fixed.tgtype, 7);
  assert.equal(await verifyCheck(), 'ok');
});

// ── 6. A trigger that fires TOO MUCH ────────────────────────────────────────
await test('a BEFORE INSERT OR UPDATE trigger is treated as missing, not as equivalent', async () => {
  await db.exec(`
    drop trigger stamp_company_entity_id on public.alpha;
    create trigger stamp_company_entity_id before insert or update on public.alpha
      for each row execute function public.stamp_company_entity_id();
  `);
  const status = await verifyCheck();
  assert.notEqual(status, 'ok',
    'INSERT OR UPDATE re-stamps a company_entity_id somebody deliberately cleared, '
    + 'which is a different trigger from the one this check exists to require');
  assert.match(status, /alpha/);

  await q('select public.attach_stamp_company_entity_id_triggers()');
  assert.equal((await one(`select tg.tgtype from pg_trigger tg join pg_class cl on cl.oid=tg.tgrelid
     where cl.relname='alpha' and tg.tgname='stamp_company_entity_id' and not tg.tgisinternal`)).tgtype,
    7, 'repaired back to ROW|BEFORE|INSERT exactly');
  assert.equal(await verifyCheck(), 'ok');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
