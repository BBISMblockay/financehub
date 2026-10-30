// chat_run_readonly_query must not let a query change who RLS thinks the
// caller is. Executed against the real migrations in a real Postgres (PGlite).
//
// The hole (found 2026-10-30, confirmed on production in a rolled-back test):
// read-only transactions allow set_config, and
// set_config('request.jwt.claims', '{"sub":"<someone else>"}', true) changes
// auth.uid() for the rest of the statement, so RLS judges the query as that
// other user -- any signed-in user could read another company's data.
// 20261030100000 refuses set_config, and every function reachable from
// `authenticated` that runs SQL handed to it as text, by name.
//
// Run: node scripts/tests/readonly-query-identity-database.test.mjs
//   (needs: npm ci --prefix scripts/tests/finance-db --ignore-scripts)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const migration = (name) => readFile(new URL(`supabase/migrations/${name}`, root), 'utf8');
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

// PGlite has no Supabase roles or auth schema. auth.uid() is Supabase's own
// definition: it reads the claims setting, which is the whole point.
await db.exec(`
  create role authenticated; create role anon; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
  create table secrets (owner uuid, secret text);
  insert into secrets values ('00000000-0000-0000-0000-00000000000a', 'mine'),
                             ('00000000-0000-0000-0000-00000000000b', 'someone else''s');
`);
const ME = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';
const asMe = () => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: ME, role: 'authenticated' })]);
const swap = `'{"sub":"${OTHER}","role":"authenticated"}'`;
// Stands in for an RLS policy: the rows auth.uid() owns.
const steal = (call) => `with s as materialized (select ${call} as x) select (select secret from secrets where owner = auth.uid()) as secret from s`;

await db.exec(await migration('20260916120000_chat_readonly_query_read_only_txn.sql'));

console.log('\n-- the hole, before the fix --');
await asMe();

await test('without the fix, set_config inside the runner reads as another user', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [steal(`set_config('request.jwt.claims', ${swap}, true)`)]);
  assert.deepEqual(r.rows[0].out, [{ secret: "someone else's" }],
    'the fixture no longer reproduces the hole, so the tests below prove nothing');
});

await db.exec(await migration('20261030100000_readonly_query_refuse_identity_switch.sql'));

console.log('\n-- refused after the fix --');
await asMe();

const attempts = {
  'set_config': `set_config('request.jwt.claims', ${swap}, true)`,
  'schema-qualified': `pg_catalog.set_config('request.jwt.claims', ${swap}, true)`,
  'quoted and upper case': `"pg_catalog"."SET_CONFIG"('request.jwt.claims', ${swap}, true)`.replace('"SET_CONFIG"', 'SET_CONFIG'),
  'quoted identifier': `"set_config"('request.jwt.claims', ${swap}, true)`,
  'U& escaped identifier': `U&"\\0073et_config"('request.jwt.claims', ${swap}, true)`,
  'built at run time inside query_to_xml': `query_to_xml('select set_' || 'config(''request.jwt.claims'', ''${swap.slice(1, -1)}'', true)', true, false, '')`,
  'built at run time inside ts_stat': `(select count(*) from ts_stat('select to_tsvector(set_' || 'config(''x.y'', ''1'', true))'))`,
  'ts_rewrite': `ts_rewrite('a'::tsquery, 'select ''a''::tsquery, ''b''::tsquery')`,
};
for (const [label, call] of Object.entries(attempts)) {
  await test(`refused: ${label}`, async () => {
    const msg = await refused(`select public.chat_run_readonly_query($1)`, [steal(call)]);
    assert.ok(msg, 'the query ran');
    assert.match(msg, /may not use/i);
  });
}

await test('...and the caller is still themselves afterwards', async () => {
  const r = await db.query(`select auth.uid()::text as uid`);
  assert.equal(r.rows[0].uid, ME);
});

await test('a comment between the name and its parenthesis does not hide it', async () => {
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [steal(`set_config/**/('request.jwt.claims', ${swap}, true)`)]);
  assert.match(String(msg), /may not use/i);
});

console.log('\n-- ordinary reads are unaffected --');

await test('a plain select runs and reads as the caller', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select secret from secrets where owner = auth.uid()`]);
  assert.deepEqual(r.rows[0].out, [{ secret: 'mine' }]);
});

await test('names that only contain a refused word still run', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`,
    [`select 1 as posts_stat, 2 as offset_config, 3 as reset_configured, 4 as xml_export, 5 as graphql_calls`]);
  assert.deepEqual(r.rows[0].out, [{ posts_stat: 1, offset_config: 2, reset_configured: 3, xml_export: 4, graphql_calls: 5 }]);
});

await test('current_setting (reading, not writing) still runs', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1) as out`, [`select current_setting('transaction_read_only') as ro`]);
  assert.deepEqual(r.rows[0].out, [{ ro: 'on' }]);
});

await test('the 1000-row page cap and p_offset still hold', async () => {
  const r = await db.query(`select public.chat_run_readonly_query($1, 1100) as out`, [`select g from generate_series(1,1200) g order by g`]);
  assert.equal(r.rows[0].out.length, 100);
  assert.equal(r.rows[0].out[0].g, 1101);
});

await test('a write through a function is still refused by the executor', async () => {
  await db.exec(`create table t (n int); create function w() returns int language sql volatile as $$ insert into t values (1) returning n $$;`);
  const msg = await refused(`select public.chat_run_readonly_query($1)`, [`select w()`]);
  assert.match(String(msg), /read-only transaction/i);
});

console.log('\n-- the guard itself --');

await test('the guard names what it refused, and passes clean SQL', async () => {
  const r = await db.query(`select public.silo_sql_refused_function($1) as a, public.silo_sql_refused_function($2) as b, public.silo_sql_refused_function(null) as c`,
    [`select table_to_xml('secrets', true, false, '')`, `select 1`]);
  assert.equal(r.rows[0].a, 'table_to_xml');
  assert.equal(r.rows[0].b, null);
  assert.equal(r.rows[0].c, null);
});

await test('anon cannot execute the runner or the guard; authenticated can', async () => {
  const r = await db.query(`select
      has_function_privilege('anon', 'public.chat_run_readonly_query(text,integer)', 'execute') as anon_runner,
      has_function_privilege('anon', 'public.silo_sql_refused_function(text)', 'execute') as anon_guard,
      has_function_privilege('authenticated', 'public.chat_run_readonly_query(text,integer)', 'execute') as auth_runner,
      has_function_privilege('authenticated', 'public.silo_sql_refused_function(text)', 'execute') as auth_guard`);
  assert.deepEqual(r.rows[0], { anon_runner: false, anon_guard: false, auth_runner: true, auth_guard: true });
});

await test('the runner is still SECURITY INVOKER and VOLATILE', async () => {
  const r = await db.query(`select prosecdef, provolatile from pg_proc where oid = 'public.chat_run_readonly_query(text,integer)'::regprocedure`);
  assert.deepEqual(r.rows[0], { prosecdef: false, provolatile: 'v' });
});

console.log(`\n${run - failures}/${run} passed`);
if (failures) process.exit(1);
