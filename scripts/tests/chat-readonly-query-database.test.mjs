// chat_run_readonly_query's read-only boundary, executed against the real
// migration in a real Postgres (PGlite).
//
// The hole this closes, found by the 2026-09-16 Ask SILO audit: the function's
// guard is a check on the SHAPE of the statement text -- one SELECT or WITH,
// no semicolon -- and a SELECT is not a read. A SELECT may call a VOLATILE
// function, which runs with the caller's own privileges, and
// set_active_company(uuid) is granted to `authenticated`:
//
//     select public.set_active_company('<an entity the caller belongs to>');
//
// is one semicolon-free SELECT that passes every existing check and UPDATEs
// profiles.active_company_id -- the column every RLS policy in SILO reads to
// decide which company's rows the caller sees.
//
// This file exists because the fix could NOT be reasoned out from the docs.
// Three plausible mechanisms were tried and two of them fail in ways that read
// as correct in review:
//
//   1. A function-level `set transaction_read_only to 'on'` clause, and a
//      `set local` in the body. Both REJECTED by Postgres at create/run time:
//      "parameter transaction_read_only cannot be set locally in functions".
//   2. Declaring the function STABLE (PostgREST runs a STABLE function in a
//      read-only transaction). WORSE THAN USELESS: measured below, a nested
//      VOLATILE function still writes, because SPI's non-volatile guard is per
//      function -- and a non-volatile function may not run `set local
//      statement_timeout` at all, so the 30s budget silently goes away too.
//   3. `SET TRANSACTION READ ONLY` through EXECUTE. Works, and the refusal
//      comes from the EXECUTOR, so it holds however the write is reached.
//
// Assertion 2 is the one worth keeping forever: it is the version of this fix
// somebody will reach for next time, and it looks safer than the one shipped.
//
// Run: node scripts/tests/chat-readonly-query-database.test.mjs
//   (needs: npm ci --prefix scripts/tests/finance-db --ignore-scripts)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const db = new PGlite();

let run = 0;
let failures = 0;
async function test(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`); }
}
async function refused(sql, params) {
  try { await db.query(sql, params); return null; }
  catch (err) { return String(err.message).split('\n')[0]; }
}

// PGlite has no Supabase roles; the migration grants to them by name.
await db.exec(`create role authenticated; create role anon;`);

// A stand-in for set_active_company: caller-executable, VOLATILE, writes.
await db.exec(`
  create table tenant_state (id int primary key, active_company text);
  insert into tenant_state values (1, 'company-a');
  create function switch_company(p text) returns text
    language plpgsql volatile as $$
    begin update tenant_state set active_company = p where id = 1; return p; end $$;
`);

await db.exec(await readFile(
  new URL('supabase/migrations/20260916120000_chat_readonly_query_read_only_txn.sql', root), 'utf8',
));

const active = async () =>
  (await db.query('select active_company from tenant_state where id = 1')).rows[0].active_company;

console.log('\n-- the boundary --');

await test('a write reached through a volatile function is refused', async () => {
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [`select switch_company('company-b')`]);
  assert.ok(msg, 'the call was allowed; the read-only boundary is not in place');
  assert.match(msg, /read-only transaction/i);
});

await test('...and the row it targeted is untouched', async () => {
  assert.equal(await active(), 'company-a');
});

await test('the refusal comes from the executor, not from matching on text', async () => {
  // Nothing about this statement looks like a write: the writing call is
  // buried in a CTE behind a name the guard has never heard of.
  const msg = await refused(
    `select public.chat_run_readonly_query($1)`,
    [`with hidden as (select switch_company('company-c') as x) select x from hidden`],
  );
  assert.ok(msg, 'a write hidden inside a CTE was allowed');
  assert.match(msg, /read-only transaction/i);
  assert.equal(await active(), 'company-a');
});

console.log('\n-- ordinary reads are unaffected --');

await test('a plain select still returns its rows, in select-list order', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select 1 as first_col, 'x' as second_col`]);
  assert.deepEqual(r.rows[0].out, [{ first_col: 1, second_col: 'x' }]);
});

await test('a WITH statement still runs', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`with a as (select 2 as n) select n from a`]);
  assert.deepEqual(r.rows[0].out, [{ n: 2 }]);
});

await test('p_offset still pages', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1, 3) as out`, [`select g from generate_series(1,5) g order by g`]);
  assert.deepEqual(r.rows[0].out, [{ g: 4 }, { g: 5 }]);
});

await test('the 1000-row page cap still holds', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select g from generate_series(1,1200) g order by g`]);
  assert.equal(r.rows[0].out.length, 1000);
});

await test('an empty result is [] and not null', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select 1 where false`]);
  assert.deepEqual(r.rows[0].out, []);
});

// The read-only SET had to go AFTER the statement-timeout SET, and both had to
// keep working. Asked from INSIDE the sandbox rather than by timing a slow
// query: PGlite does not enforce statement_timeout at all (measured -- a
// pg_sleep(0.4) under an 80ms budget completed in 402ms), so a timing test
// here would pass whether or not the function still set anything, which is
// worse than not testing it. Reading the setting back is real: it fails if the
// SET is dropped, and it fails if the read-only line is moved above it and
// Postgres then refuses the SET.
await test('the 30s statement budget is still in force inside the sandbox', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select current_setting('statement_timeout') as budget`]);
  assert.deepEqual(r.rows[0].out, [{ budget: '30s' }]);
});

await test('...and the transaction really is read-only inside it', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select current_setting('transaction_read_only') as ro`]);
  assert.deepEqual(r.rows[0].out, [{ ro: 'on' }]);
});

console.log('\n-- the pre-existing guards are still there --');

await test('a bare UPDATE is still refused by the shape check, before the executor', async () => {
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [`update tenant_state set active_company = 'z'`]);
  assert.ok(msg);
  assert.match(msg, /Only a single SELECT or WITH/i);
});

await test('a second statement is still refused', async () => {
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [`select 1; select 2`]);
  assert.match(String(msg), /must not contain a semicolon/i);
});

await test('a leading comment does not smuggle a non-select past the check', async () => {
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [`-- innocent\n update tenant_state set active_company = 'z'`]);
  assert.match(String(msg), /Only a single SELECT or WITH/i);
});

await test('a trailing semicolon is still tolerated', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select 7 as n;`]);
  assert.deepEqual(r.rows[0].out, [{ n: 7 }]);
});

console.log('\n-- the mechanisms that do NOT work, so nobody re-tries them --');

await test('a function-level transaction_read_only SET clause is rejected by Postgres', async () => {
  const msg = await refused(`
    create function ro_clause(q text) returns json language plpgsql
      set transaction_read_only to 'on'
      as $$ begin return '[]'::json; end $$`);
  assert.ok(msg, 'Postgres accepted a transaction_read_only function SET clause; the migration comment is now wrong');
  assert.match(msg, /cannot be set locally in functions/i);
});

await test('STABLE does NOT stop a nested volatile function from writing', async () => {
  await db.exec(`
    create function stable_runner(q text) returns json language plpgsql stable as $$
      declare r json;
      begin
        execute format('select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) uq) t', q) into r;
        return r;
      end $$;`);
  await db.query(`select stable_runner($1)`, [`select switch_company('written-by-stable')`]);
  assert.equal(
    await active(), 'written-by-stable',
    'STABLE blocked the write -- if Postgres changed this, the migration could be simplified',
  );
  // Put the fixture back for anything after this.
  await db.exec(`update tenant_state set active_company = 'company-a' where id = 1`);
});

await test('...and a STABLE function cannot set its own statement timeout', async () => {
  await db.exec(`
    create function stable_timeout() returns int language plpgsql stable as $$
      begin set local statement_timeout = '30s'; return 1; end $$;`);
  const msg = await refused(`select stable_timeout()`);
  assert.ok(msg, 'a STABLE function was allowed to set statement_timeout');
  assert.match(msg, /not allowed in a non-volatile function/i);
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
