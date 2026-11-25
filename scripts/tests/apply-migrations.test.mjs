/* The decisions behind .github/workflows/auto-apply-migrations.yml.
 *
 * This is the one piece of SILO that writes to production with nobody
 * watching, so every refusal and every stop is pinned here: that a failure
 * takes nothing after it with it, that an already-recorded version is left
 * alone, that a file needing CONCURRENTLY is refused rather than run without
 * a transaction, and -- the assumption the whole design rests on -- that a
 * query endpoint which turns out NOT to be transactional stops the run before
 * a single migration is sent.
 *
 * No network, no database, no install. Run:
 *   node scripts/tests/apply-migrations.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseMigrationFile, refusalReason, migrationRequestSql,
  probeAtomicity, applyMigrations, chooseBase, PROBE_SCHEMA,
} from '../lib/apply-migrations-core.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); });
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

/** A fake query endpoint. `atomic` decides what a multi-statement request
 * does when one of its statements fails. */
function fakeEndpoint({ atomic = true, recorded = [], failOn = null, applied = [], schemas = new Set() } = {}) {
  const calls = [];
  const runSql = async (query) => {
    calls.push(query);
    if (query.startsWith(`drop schema if exists ${PROBE_SCHEMA}`)) { schemas.delete(PROBE_SCHEMA); return { rows: [] }; }
    if (query.includes(`create schema ${PROBE_SCHEMA}`)) {
      // The probe: create, then divide by zero. A non-atomic endpoint keeps
      // the schema the first statement made.
      if (!atomic) schemas.add(PROBE_SCHEMA);
      return { error: 'ERROR: division by zero' };
    }
    if (query.includes('from information_schema.schemata')) {
      return { rows: schemas.has(PROBE_SCHEMA) ? [{ present: 1 }] : [] };
    }
    if (query.includes('from supabase_migrations.schema_migrations')) {
      const v = /version = '(\d+)'/.exec(query)?.[1];
      return { rows: recorded.includes(v) ? [{ applied: 1 }] : [] };
    }
    if (failOn && query.includes(failOn)) return { error: 'ERROR: relation "nope" does not exist' };
    applied.push(query);
    return { rows: [] };
  };
  return { runSql, calls, applied, schemas };
}

const FILES = {
  'supabase/migrations/20261201010000_first.sql': 'create table a();',
  'supabase/migrations/20261201020000_second.sql': 'create table nope_marker();',
  'supabase/migrations/20261201030000_third.sql': 'create table c();',
  'supabase/migrations/20261201040000_index.sql': 'create index concurrently i on t(x);',
  'supabase/migrations/20261201050000_comment.sql': "-- we could do this concurrently later\ncreate table d();",
  'supabase/migrations/20261201060000_owntxn.sql': 'begin;\ncreate table e();\ncommit;',
};
const readFile = async (p) => {
  if (!(p in FILES)) throw new Error(`no such file: ${p}`);
  return FILES[p];
};

const run = async () => {
console.log('\n-- filenames --');

await test('version and name come off the filename the way Supabase keys them', () => {
  const p = parseMigrationFile('supabase/migrations/20261201010000_rules_auto_apply.sql');
  eq(p.version, '20261201010000', 'version');
  eq(p.name, 'rules_auto_apply', 'name');
});

await test('a filename without a version timestamp is refused', () => {
  ok(parseMigrationFile('supabase/migrations/fix_the_thing.sql').error, 'should carry an error');
});

await test("a filename that could end a SQL string literal is refused", () => {
  ok(parseMigrationFile("supabase/migrations/20261201010000_o'brien.sql").error, 'should carry an error');
});

console.log('\n-- what will not be applied --');

await test('CONCURRENTLY is refused', () => {
  ok(refusalReason('create index concurrently i on t(x);'), 'should be refused');
});

await test('VACUUM is refused', () => {
  ok(refusalReason('vacuum analyze orders;'), 'should be refused');
});

await test('the same word in a comment is not a refusal', () => {
  eq(refusalReason('-- build this concurrently one day\ncreate table a();'), null, 'reason');
  eq(refusalReason('/* vacuum later */ create table a();'), null, 'reason');
});

await test('a word merely containing the keyword is not a refusal', () => {
  eq(refusalReason('create table concurrently_queued(x int);'), null, 'reason');
});

await test('a file with its own BEGIN/COMMIT is refused', () => {
  ok(refusalReason('begin;\ncreate table a();\ncommit;'), 'should be refused');
});

await test('BEGIN/END inside a plpgsql body is not transaction control', () => {
  const fn = `create function f() returns void language plpgsql as $$
begin
  update t set x = 1;
end;
$$;`;
  eq(refusalReason(fn), null, 'reason');
});

await test('the refusals match the real migrations directory and nothing more', () => {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const refused = files.filter((f) => refusalReason(readFileSync(`${dir}${f}`, 'utf8')));
  // Most of the directory must still be auto-appliable: a matcher that reads
  // every plpgsql body as a transaction would refuse hundreds and nobody
  // would notice until merges stopped applying.
  ok(refused.length < files.length * 0.2, `refused ${refused.length} of ${files.length}, which is too many to be right`);
  ok(refused.length > 0, 'the known CONCURRENTLY and BEGIN/COMMIT files are refused');
});

console.log('\n-- which commits a run is responsible for --');

await test("the base is the last successful run's commit, so a dropped run is caught up", () => {
  // Merge A applied (run succeeded at A). B queued, C arrived and cancelled
  // B's run. C's run must still see B's migration.
  const picked = chooseBase({ lookup: { ok: true, sha: 'A' }, pushBefore: 'B', isAncestor: () => true });
  eq(picked.base, 'A', 'base');
  eq(picked.source, 'last-success', 'source');
});

await test('with no successful run yet, the push is the base', () => {
  const picked = chooseBase({ lookup: { ok: true, sha: null }, pushBefore: 'B', isAncestor: () => true });
  eq(picked.base, 'B', 'base');
  ok(picked.note, 'says why');
});

await test('an unreadable run history stops the run instead of falling back', () => {
  // The loss this guards against: A succeeded, B's run was cancelled, and the
  // Actions API answers 403 for C. Using this push would apply only C and
  // SUCCEED, moving the base past B's migration for good.
  const picked = chooseBase({ lookup: { ok: false, reason: 'HTTP 403' }, pushBefore: 'B', isAncestor: () => true });
  eq(picked.source, 'unreadable', 'source');
  eq(picked.base, null, 'no base is guessed');
  ok(/403/.test(picked.note || ''), 'says what went wrong');
});

await test('a last-success commit that is not an ancestor is not used', () => {
  const picked = chooseBase({ lookup: { ok: true, sha: 'X' }, pushBefore: 'B', isAncestor: (sha) => sha === 'B' });
  eq(picked.base, 'B', 'base');
});

await test('an all-zero push base is never used', () => {
  const picked = chooseBase({ lookup: { ok: true, sha: null }, pushBefore: '0'.repeat(40), isAncestor: () => true });
  eq(picked.base, null, 'base');
  eq(picked.source, 'none', 'source');
});

console.log('\n-- the request --');

await test('the schema_migrations insert travels with the file, in one request', () => {
  const sql = migrationRequestSql('create table a()', '20261201010000', 'first');
  ok(sql.startsWith('create table a();'), 'file first, terminated');
  ok(sql.includes("values ('20261201010000', 'first')"), 'records the version');
  ok(sql.includes('on conflict (version) do nothing'), 'a second run records nothing twice');
});

console.log('\n-- the atomicity probe --');

await test('a transactional endpoint passes the probe and leaves nothing behind', async () => {
  const ep = fakeEndpoint({ atomic: true });
  const res = await probeAtomicity({ runSql: ep.runSql });
  eq(res.ok, true, 'probe result');
  ok(!ep.schemas.has(PROBE_SCHEMA), 'no probe schema left');
});

await test('a NON-transactional endpoint fails the probe and the schema is dropped', async () => {
  const ep = fakeEndpoint({ atomic: false });
  const res = await probeAtomicity({ runSql: ep.runSql });
  eq(res.ok, false, 'probe result');
  ok(/NOT transactional/.test(res.reason), `reason says so: ${res.reason}`);
  ok(!ep.schemas.has(PROBE_SCHEMA), 'probe schema cleaned up');
});

await test('a probe that does not even fail stops the run', async () => {
  const runSql = async (q) => (q.includes(`create schema ${PROBE_SCHEMA}`) ? { rows: [] } : { rows: [] });
  const res = await probeAtomicity({ runSql });
  eq(res.ok, false, 'probe result');
});

await test('an unreadable probe check stops the run', async () => {
  const runSql = async (q) => {
    if (q.includes(`create schema ${PROBE_SCHEMA}`)) return { error: 'ERROR: division by zero' };
    if (q.includes('information_schema.schemata')) return { error: 'HTTP 503' };
    return { rows: [] };
  };
  const res = await probeAtomicity({ runSql });
  eq(res.ok, false, 'probe result');
});

console.log('\n-- applying --');

await test('a new migration is applied and a recorded one is skipped', async () => {
  const ep = fakeEndpoint({ recorded: ['20261201030000'] });
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201010000_first.sql', 'supabase/migrations/20261201030000_third.sql'],
    readFile, runSql: ep.runSql,
  });
  eq(out.failed, false, 'run outcome');
  eq(out.results[0].status, 'applied', 'first');
  eq(out.results[1].status, 'skipped', 'third');
  eq(ep.applied.length, 1, 'exactly one migration request sent');
});

await test('a failure stops the run and later files are not attempted', async () => {
  const ep = fakeEndpoint({ failOn: 'nope_marker' });
  const out = await applyMigrations({
    files: [
      'supabase/migrations/20261201010000_first.sql',
      'supabase/migrations/20261201020000_second.sql',
      'supabase/migrations/20261201030000_third.sql',
    ],
    readFile, runSql: ep.runSql,
  });
  eq(out.failed, true, 'run outcome');
  eq(out.results[0].status, 'applied', 'first');
  eq(out.results[1].status, 'failed', 'second');
  eq(out.results[2].status, 'not-attempted', 'third');
  ok(!ep.applied.some((q) => q.includes('create table c()')), 'the third file was never sent');
});

await test('a refused file stops the run before it is sent', async () => {
  const ep = fakeEndpoint();
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201040000_index.sql', 'supabase/migrations/20261201010000_first.sql'],
    readFile, runSql: ep.runSql,
  });
  eq(out.failed, true, 'run outcome');
  eq(out.results[0].status, 'refused', 'index file');
  eq(out.results[1].status, 'not-attempted', 'the file after it');
  eq(ep.applied.length, 0, 'nothing was sent');
});

await test('a comment mentioning the keyword still applies', async () => {
  const ep = fakeEndpoint();
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201050000_comment.sql'], readFile, runSql: ep.runSql,
  });
  eq(out.results[0].status, 'applied', 'comment file');
});

await test('a file carrying its own BEGIN/COMMIT is refused, never half-recorded', async () => {
  const ep = fakeEndpoint();
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201060000_owntxn.sql'], readFile, runSql: ep.runSql,
  });
  eq(out.results[0].status, 'refused', 'own-transaction file');
  eq(ep.applied.length, 0, 'nothing was sent');
});

await test('a non-transactional endpoint means NOTHING is applied', async () => {
  const ep = fakeEndpoint({ atomic: false });
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201010000_first.sql', 'supabase/migrations/20261201030000_third.sql'],
    readFile, runSql: ep.runSql,
  });
  eq(out.failed, true, 'run outcome');
  ok(out.abort, 'carries the reason');
  eq(ep.applied.length, 0, 'not one migration was sent');
  ok(out.results.every((r) => r.status === 'not-attempted'), 'every file untouched');
});

await test('an unreadable schema_migrations stops the run rather than re-applying', async () => {
  const runSql = async (q) => {
    if (q.includes(`create schema ${PROBE_SCHEMA}`)) return { error: 'ERROR: division by zero' };
    if (q.includes('information_schema.schemata')) return { rows: [] };
    if (q.includes('supabase_migrations.schema_migrations where version')) return { error: 'HTTP 503' };
    throw new Error('a migration was sent after schema_migrations could not be read');
  };
  const out = await applyMigrations({
    files: ['supabase/migrations/20261201010000_first.sql'], readFile, runSql,
  });
  eq(out.failed, true, 'run outcome');
  eq(out.results[0].status, 'failed', 'first');
});

await test('no files means no probe and no calls', async () => {
  const ep = fakeEndpoint();
  const out = await applyMigrations({ files: [], readFile, runSql: ep.runSql });
  eq(out.failed, false, 'run outcome');
  eq(ep.calls.length, 0, 'nothing was sent');
});

console.log(`\n${count - failures}/${count} checks passed`);
process.exit(failures ? 1 : 0);
};
run();
