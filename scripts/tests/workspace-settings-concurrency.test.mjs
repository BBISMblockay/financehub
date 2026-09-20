// Two REAL PostgreSQL connections, interleaved on purpose.
//
// `set_workspace_member_role` and `remove_workspace_member` both promise the
// same invariant: a workspace is never left without an owner_admin. Nothing in
// the product can put one back -- `company_settings`' UPDATE policy,
// `set_workspace_company_name` and `stripe-billing` all gate on
// `is_owner_admin_of_active_company()` -- so an ownerless workspace is a
// permanent state that needs a service-role write to escape.
//
// Each function locks the TARGET membership row with `for update` and then
// counts owners across the OTHER rows, unlocked. That is check-then-act across
// two different rows, which a single-connection harness cannot reach:
// scripts/tests/workspace-settings-database.test.mjs runs on PGlite, one
// connection, so it proves each guard refuses a bad state and never that two
// sessions can ASSEMBLE that state between them.
//
// The race is not exotic. Self-demotion is allowed on purpose (an owner
// stepping back is a real thing to do, and the last-owner check is what makes
// it safe), so two owners can each demote THEMSELVES with no overlapping row
// lock at all. Both count two owners, both pass, both commit, and the
// workspace has none. The same window spans the pair: one owner demoting
// themselves while another is removed by an admin reaches it too.
//
// Reported by the independent review on PR #734, cycle 1, and reproduced here
// against the unlocked migration before the lock was added.
//
// Mutations (each must make a specific assertion fail, for the right reason):
//   WS_RACE_MUTATION=owner-count-unlocked  (both advisory locks removed)
//
// Requires a reachable PostgreSQL server. It SKIPS -- exit 0, loudly -- when
// there is none, the same stance the onboarding concurrency suite takes.
//
//   SILO_PG_CONN=postgresql://postgres@/postgres?host=/var/run/postgresql \
//     node scripts/tests/workspace-settings-concurrency.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mutation = process.env.WS_RACE_MUTATION || '';
assert.ok(['', 'owner-count-unlocked'].includes(mutation), `Unknown race mutation: ${mutation}`);

const root = new URL('../../', import.meta.url);
const BASE = process.env.SILO_PG_CONN || process.env.DATABASE_URL || '';

function skip(why) {
  if (process.env.SILO_PG_REQUIRED === '1') {
    console.error(`\nFAILED: a PostgreSQL server was required and ${why}`);
    process.exit(1);
  }
  console.log(`SKIP - workspace settings concurrency suite: ${why}`);
  console.log('SKIP - set SILO_PG_CONN to a reachable PostgreSQL to run it.');
  process.exit(0);
}

if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) skip('psql is not installed');
const probe = spawnSync('psql', [BASE || 'postgresql://postgres@/postgres', '-XtAc', 'select 1'],
  { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0) skip(`no server answered (${(probe.stderr || '').trim().split('\n')[0] || 'connection failed'})`);

const admin = BASE || 'postgresql://postgres@/postgres';
const dbName = `silo_wsrace_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const dbConn = admin.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);

const run = (conn, args) => {
  const r = spawnSync('psql', [conn, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};

const MARK = '__SILO_MARK__';
function session(name) {
  const p = spawn('bash', ['-c', 'exec psql "$SILO_CONN" -X -A -t -q 2>&1'],
    { env: { ...process.env, SILO_CONN: dbConn, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let waiter = null;
  let done = false;
  p.stdout.on('data', (d) => {
    buf += d.toString();
    if (waiter && buf.includes(MARK)) {
      const i = buf.indexOf(MARK);
      const out = buf.slice(0, i);
      buf = buf.slice(i + MARK.length);
      const w = waiter; waiter = null; w.resolve(out.trim());
    }
  });
  p.on('exit', () => { done = true; if (waiter) waiter.resolve(buf.trim()); });

  const api = {
    name,
    send(sql) {
      if (done) throw new Error(`${name}: session already closed`);
      if (!/;\s*$/.test(sql)) throw new Error(`${name}: statement must end in ';' -- ${sql.slice(0, 40)}`);
      if (waiter) throw new Error(`${name}: a statement is already in flight`);
      const promise = new Promise((resolve) => { waiter = { resolve }; });
      p.stdin.write(`${sql}\n\\echo ${MARK}\n`);
      return promise;
    },
    async end() { if (!done) { p.stdin.end(); await new Promise((r) => p.on('exit', r)); } },
  };
  return api;
}

let passed = 0;
const test = async (title, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${title}`); };

run(admin, ['-c', `create database ${dbName}`]);
let work;
try {
  work = await mkdtemp(join(tmpdir(), 'silo-wsrace-'));

  const bootstrap = await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8');
  const onboarding = await readFile(
    new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8');
  let sql = await readFile(
    new URL('supabase/migrations/20260920120000_workspace_settings_admin.sql', root), 'utf8');

  if (mutation === 'owner-count-unlocked') {
    let removed = 0;
    sql = sql.replace(/perform pg_advisory_xact_lock\(\s*hashtextextended\('silo-workspace-membership\|' \|\| v_company::text, 0\)\);/g,
      () => { removed += 1; return '-- lock removed by the owner-count-unlocked mutation'; });
    // BOTH functions, or the mutation tests the wrong thing: one lock left
    // standing still serialises every path that takes the other, and a
    // half-applied mutation would pass and be credited as proof.
    assert.equal(removed, 2, `owner-count-unlocked must remove both locks, removed ${removed}`);
  }

  // Two owners of one workspace, plus an ordinary admin.
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const plainAdmin = randomUUID();
  const company = randomUUID();
  const seed = `
    insert into auth.users(id,email) values
      ('${ownerA}','a@blockay.com'),('${ownerB}','b@blockay.com'),('${plainAdmin}','c@blockay.com');
    insert into public.entities(id,module,entity_type,entity_key,source,title)
      values ('${company}','finance_hub','company','blockay-ops','seed','Blockay Ops');
    update public.profiles set role='owner', department='exec', active_company_id='${company}'
      where id in ('${ownerA}','${ownerB}');
    update public.profiles set role='admin', department='ops', active_company_id='${company}'
      where id='${plainAdmin}';
    insert into public.entity_memberships(entity_id,user_id,role) values
      ('${company}','${ownerA}','owner_admin'),
      ('${company}','${ownerB}','owner_admin'),
      ('${company}','${plainAdmin}','admin');
  `;

  const file = async (n, body) => { const f = join(work, n); await writeFile(f, body); return f; };
  run(dbConn, ['-f', await file('00-bootstrap.sql', bootstrap)]);
  run(dbConn, ['-f', await file('01-onboarding.sql', onboarding)]);
  run(dbConn, ['-f', await file('02-seed.sql', seed)]);
  run(dbConn, ['-f', await file('03-migration.sql', sql)]);

  const ctl = session('silo-ctl');
  const scalar = async (s, sqlText) => (await s.send(sqlText)).split('\n').pop().trim();

  async function waitUntilBlocked(appName) {
    for (let i = 0; i < 200; i += 1) {
      const ev = await scalar(ctl, `select coalesce(string_agg(wait_event,','),'') from pg_stat_activity
                                    where application_name='${appName}' and wait_event_type='Lock';`);
      if (ev) return ev;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  const asUser = (s, uid) => s.send(
    `reset role; select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`);
  const owners = () => scalar(ctl, `reset role; select count(*) from public.entity_memberships
                                    where entity_id='${company}' and role='owner_admin';`);

  // ── Race 1: two owners demoting THEMSELVES ────────────────────────────────
  await test('two owners stepping back at once cannot both succeed', async () => {
    assert.equal(await owners(), '2', 'the workspace starts with two owners');

    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let waited = null;
    let second = '';
    try {
      await asUser(s1, ownerA);
      await asUser(s2, ownerB);

      // S1 demotes itself and holds the transaction open -- the window two
      // clicks actually land in. Its `for update` is on ownerA's row only.
      await s1.send('begin;');
      const first = await s1.send(
        `select public.set_workspace_member_role('${ownerA}','admin')->>'role';`);
      assert.match(first, /admin/, 'with two owners, one stepping back must be allowed');

      // S2 demotes ITSELF: a different row, so no row lock is shared. Every
      // unlocked read it makes still sees ownerA as an owner.
      await s2.send('begin;');
      const inflight = s2.send(
        `select public.set_workspace_member_role('${ownerB}','admin')->>'role';`);

      // Observed, not asserted here: asserting the mechanism now would abort
      // before the committed state exists, and the finding IS the committed
      // state, not the wait.
      waited = await waitUntilBlocked('silo-s2');

      await s1.send('commit;');
      second = await inflight;
      // Let it COMMIT if the guard let it through. Rolling back unconditionally
      // would hide the ownerless workspace behind the test's own cleanup.
      await s2.send(/must keep at least one owner/.test(second) ? 'rollback;' : 'commit;');
    } finally {
      await s1.end(); await s2.end();
    }

    // The invariant first, whatever the mechanism.
    assert.equal(await owners(), '1',
      'the workspace was left without an owner -- the state the last-owner check exists to prevent');
    assert.match(second, /must keep at least one owner/,
      'the second demotion should have been refused, not merely delayed');
    assert.equal(waited, 'advisory',
      'and refused because it waited on the per-company advisory lock');
  });

  // ── Race 2: the invariant spans BOTH functions ────────────────────────────
  // One lock per function would serialise each against itself and leave this
  // pair wide open, so the two must share one key.
  await test('a demotion and a removal cannot between them empty the workspace', async () => {
    // Race 1 committed ownerA's step-back and rolled ownerB's back, so ownerA
    // is the one to restore. (Promoting ownerB here instead is a no-op that
    // reads as a passing setup and leaves the race untested -- it is how the
    // first version of this test quietly proved nothing.)
    await ctl.send(`reset role; update public.entity_memberships set role='owner_admin'
                    where entity_id='${company}' and user_id='${ownerA}';`);
    assert.equal(await owners(), '2', 'both owners are back');

    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let outcome = '';
    try {
      await asUser(s1, ownerA);
      await asUser(s2, ownerB);
      await s1.send('begin;');
      await s1.send(`select public.set_workspace_member_role('${ownerA}','viewer')->>'role';`);

      await s2.send('begin;');
      const inflight = s2.send(`select public.remove_workspace_member('${ownerA}')->>'ok';`);
      await waitUntilBlocked('silo-s2');
      await s1.send('commit;');
      outcome = await inflight;
      await s2.send(/error|not a member|at least one owner/i.test(outcome) ? 'rollback;' : 'commit;');
    } finally {
      await s1.end(); await s2.end();
    }

    assert.notEqual(await owners(), '0',
      'a demotion and a removal interleaved the workspace into having no owner');
  });

  await ctl.end();
  console.log(`\n${passed} concurrency assertions passed against real PostgreSQL${mutation ? ` [mutation: ${mutation}]` : ''}.`);
} finally {
  if (work) await rm(work, { recursive: true, force: true });
  spawnSync('psql', [admin, '-XtAc',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname='${dbName}'`], { encoding: 'utf8' });
  spawnSync('psql', [admin, '-XtAc', `drop database if exists ${dbName}`], { encoding: 'utf8' });
}
