// Two REAL PostgreSQL connections, interleaved on purpose.
//
// The company-onboarding migration makes two claims that a single-connection
// harness cannot test at all. PGlite -- which scripts/tests/company-onboarding-
// database.test.mjs runs on -- is an in-process PostgreSQL with ONE connection,
// so it can prove a guard refuses a bad state but never that two sessions
// racing cannot ASSEMBLE that state between them. Both claims were argued from
// the source through four review cycles and never once measured:
//
//   1. pg_advisory_xact_lock serialises the two currency guards. Without it
//      each is a plain read-then-write: the declaration side reads "no books"
//      while the books side reads the still-committed declaration, both pass,
//      and the company commits with its books in USD and its reporting set to
//      CAD -- the exact state the pair of triggers exists to make unreachable.
//   2. `select is_active ... for update` in redeem_platform_invite makes the
//      disabled-account refusal authoritative rather than a time-of-check /
//      time-of-use read. Without the row lock, an administrator disabling an
//      account while a redeem is in flight has that disable silently UNDONE by
//      the redeem's own profile upsert, which writes is_active = true.
//   3. `select ... for update` on the invite row makes the token a real
//      idempotency key under simultaneity, not only under retry-after-failure.
//      Without it two clicks that arrive together both read the invite as
//      pending and found TWO companies -- and the second is not a duplicate the
//      user can see and delete, it is a company they now own and did not ask
//      for. "Safe retries" was the scoped ask; this is the half of it that a
//      sequential test cannot reach.
//
// Each test drives two genuine psql sessions and a third control session that
// watches pg_stat_activity, so "the second session blocked" is observed in the
// server's own wait state rather than inferred from timing.
//
// Mutations (each must make a specific assertion fail, for the right reason):
//   ONBOARDING_RACE_MUTATION=currency-unlocked  (both advisory locks removed)
//   ONBOARDING_RACE_MUTATION=redeem-unlocked    (the profiles FOR UPDATE removed)
//   ONBOARDING_RACE_MUTATION=invite-unlocked    (the invite-row FOR UPDATE removed)
//
// Requires a reachable PostgreSQL server. It SKIPS -- exit 0, loudly -- when
// there is none, the same stance v3's browser suites take toward Playwright: a
// suite that cannot run must not be mistaken for a suite that passed, and must
// not fail a checkout that never asked for a database.
//
//   SILO_PG_CONN=postgresql://postgres@/postgres?host=/var/run/postgresql \
//     node scripts/tests/onboarding-concurrency.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mutation = process.env.ONBOARDING_RACE_MUTATION || '';
assert.ok(['', 'currency-unlocked', 'redeem-unlocked', 'invite-unlocked'].includes(mutation),
  `Unknown race mutation: ${mutation}`);

const root = new URL('../../', import.meta.url);
const BASE = process.env.SILO_PG_CONN || process.env.DATABASE_URL || '';

function skip(why) {
  // SILO_PG_REQUIRED is what CI sets. A suite that silently skips is green
  // without looking -- exactly the failure this repo keeps finding -- so where
  // a database is supposed to exist, its absence is a failure, not a skip.
  if (process.env.SILO_PG_REQUIRED === '1') {
    console.error(`\nFAILED: a PostgreSQL server was required and ${why}`);
    process.exit(1);
  }
  console.log(`SKIP - onboarding concurrency suite: ${why}`);
  console.log('SKIP - set SILO_PG_CONN to a reachable PostgreSQL to run it.');
  process.exit(0);
}

// ── Can we run at all? ──────────────────────────────────────────────────────
if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) skip('psql is not installed');
const probe = spawnSync('psql', [BASE || 'postgresql://postgres@/postgres', '-XtAc', 'select 1'],
  { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0) skip(`no server answered (${(probe.stderr || '').trim().split('\n')[0] || 'connection failed'})`);

const admin = BASE || 'postgresql://postgres@/postgres';
const dbName = `silo_race_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const dbConn = admin.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);

const run = (conn, args) => {
  const r = spawnSync('psql', [conn, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};

// ── A psql session we can leave a statement running in ──────────────────────
// stderr is merged into stdout by the shell, not by two pipes, so an ERROR and
// the sentinel that follows it cannot arrive out of order.
const MARK = '__SILO_MARK__';
function session(name) {
  const p = spawn('bash', ['-c', `exec psql "$SILO_CONN" -X -A -t -q 2>&1`],
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
    pending: null,
    // Fire a statement and get a promise for its output. Hold the promise
    // without awaiting it to leave the session mid-statement.
    send(sql) {
      if (done) throw new Error(`${name}: session already closed`);
      // psql BUFFERS an unterminated statement and glues the next one onto it,
      // which turns a missing semicolon into a syntax error attributed to the
      // following line. Refuse it here rather than debugging it there.
      if (!/;\s*$/.test(sql)) throw new Error(`${name}: statement must end in ';' -- ${sql.slice(0, 40)}`);
      // One waiter slot per session. A second send while one is still in flight
      // would orphan the first promise, and the suite would HANG rather than
      // fail -- a hang reads as a slow runner, not as a broken test.
      if (waiter) throw new Error(`${name}: a statement is already in flight`);
      const promise = new Promise((resolve) => { waiter = { resolve }; });
      p.stdin.write(`${sql}\n\\echo ${MARK}\n`);
      api.pending = promise.finally(() => { if (api.pending === promise) api.pending = null; });
      return api.pending;
    },
    async exec(sql) { return api.send(sql); },
    async end() { if (!done) { p.stdin.end(); await new Promise((r) => p.on('exit', r)); } },
  };
  return api;
}

let passed = 0;
const test = async (title, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${title}`); };

// ── Build the database ──────────────────────────────────────────────────────
run(admin, ['-c', `create database ${dbName}`]);
let work;
try {
  work = await mkdtemp(join(tmpdir(), 'silo-race-'));

  const bootstrap = await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8');
  let sql = await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8');

  if (mutation === 'currency-unlocked') {
    // Exactly the cycle-2 state: both guards present, neither serialised.
    const before = sql;
    let removed = 0;
    sql = sql.replace(/perform pg_advisory_xact_lock\(\s*hashtextextended\('silo-company-currency\|' \|\| new\.company_entity_id::text, 0\)\);/g,
      () => { removed += 1; return '-- lock removed by the currency-unlocked mutation'; });
    // BOTH sides, or the mutation tests the wrong thing: one lock left standing
    // still serialises the pair, so a half-applied mutation would pass and be
    // credited as proof that the lock is load-bearing.
    assert.equal(removed, 2, `currency-unlocked must remove both locks, removed ${removed}`);
  }
  if (mutation === 'invite-unlocked') {
    const before = sql;
    sql = sql.replace(/where token_hash = encode\(extensions\.digest\(coalesce\(p_token, ''\), 'sha256'\), 'hex'\)\s*\n\s*for update;/,
      () => "where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');");
    assert.notEqual(sql, before, 'invite-unlocked must actually remove the invite FOR UPDATE');
  }
  if (mutation === 'redeem-unlocked') {
    // The is_active read becomes a plain snapshot read again.
    const before = sql;
    sql = sql.replace(/select is_active into v_is_active\s*\n\s*from public\.profiles where id = auth\.uid\(\)\s*\n\s*for update;/,
      () => 'select is_active into v_is_active\n    from public.profiles where id = auth.uid();');
    assert.notEqual(sql, before, 'redeem-unlocked must actually remove the FOR UPDATE');
  }

  const blake = randomUUID();
  const bbism = randomUUID();
  const seed = `
    insert into auth.users(id,email) values ('${blake}','blake@baseballism.com');
    insert into public.entities(id,module,entity_type,entity_key,source,title)
      values ('${bbism}','finance_hub','company','baseballism','seed','Baseballism');
    update public.profiles set role='owner', department='exec', active_company_id='${bbism}'
      where id='${blake}';
    insert into public.entity_memberships(entity_id,user_id,role)
      values ('${bbism}','${blake}','owner_admin');
  `;

  const file = async (n, body) => { const f = join(work, n); await writeFile(f, body); return f; };
  // auth.users first: the migration's platform_admins seed looks Blake up by email.
  run(dbConn, ['-f', await file('00-bootstrap.sql', bootstrap)]);
  run(dbConn, ['-f', await file('01-seed.sql', seed)]);
  run(dbConn, ['-f', await file('02-migration.sql', sql)]);

  const ctl = session('silo-ctl');
  const scalar = async (s, sqlText) => (await s.send(sqlText)).split('\n').pop().trim();

  // Wait until the server itself says the session is waiting on a lock.
  async function waitUntilBlocked(appName) {
    for (let i = 0; i < 200; i += 1) {
      const ev = await scalar(ctl, `select coalesce(string_agg(wait_event,','),'') from pg_stat_activity
                                    where application_name='${appName}' and wait_event_type='Lock';`);
      if (ev) return ev;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  const asUser = (s, uid) => s.send(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`);

  // ── Race 1: the currency pair ─────────────────────────────────────────────
  await test('a declaration change and a books seed cannot interleave into two currencies', async () => {
    // A founded company: declared USD, no books yet.
    const token = await scalar(ctl, `reset role; select set_config('request.jwt.claim.sub','${blake}',false);
      set role authenticated;
      select public.create_platform_invite('race1@prospect.com','Race One')->>'token';`);
    assert.match(token, /^[0-9a-f]{16,}$/i, 'minting an invite should yield a token');

    const founder = randomUUID();
    await ctl.send(`reset role; insert into auth.users(id,email) values ('${founder}','race1@prospect.com');`);
    const company = await scalar(ctl, `select set_config('request.jwt.claim.sub','${founder}',false);
      set role authenticated;
      select public.redeem_platform_invite('${token}','Race One','America/Los_Angeles','USD')->>'entity_id';`);
    assert.match(company, /^[0-9a-f-]{36}$/, 'the founder should end up with a company');
    await ctl.send('reset role;');

    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let waited = null;
    let refused = false;
    try {
      await asUser(s1, founder);
      await s1.send('begin;');
      const moved = await s1.send(
        `update public.company_settings set default_currency='CAD' where company_entity_id='${company}' returning default_currency;`);
      assert.match(moved, /CAD/, 'with no books, moving the declaration must be allowed');

      // S2 seeds the books in the ORIGINAL currency, which is still what any
      // uncommitted-unaware read of company_settings returns.
      await s2.send('begin;');
      const inflight = s2.send(`insert into public.accounting_settings
        (company_entity_id, qbo_connection_id, base_currency)
        values ('${company}','${randomUUID()}','USD');`);

      // Observe, do NOT assert yet. Asserting the mechanism here would abort the
      // test before it reaches the committed state, so an unlocked build would
      // report "it did not block" -- true, but not the finding. The finding is
      // what the two sessions leave behind.
      waited = await waitUntilBlocked('silo-s2');

      await s1.send('commit;');
      const outcome = await inflight;
      refused = /books in USD/.test(outcome);
      // Let the books seed COMMIT if the guards let it through. Rolling it back
      // unconditionally would hide the divergence behind the test's own cleanup.
      await s2.send(refused ? 'rollback;' : 'commit;');
    } finally {
      await s1.end(); await s2.end();
    }

    const books = await scalar(ctl, `select coalesce((select base_currency from public.accounting_settings
                                     where company_entity_id='${company}'),'none');`);
    const declared = await scalar(ctl, `select default_currency from public.company_settings
                                        where company_entity_id='${company}';`);
    // The invariant first: whatever the mechanism, the company must not be
    // carrying one currency in its books and another in its declaration.
    assert.ok(books === 'none' || books === declared,
      `the company ended up reporting in ${declared} with its books seeded in ${books} -- `
      + 'the state the two currency guards exist to make unreachable');
    assert.equal(declared, 'CAD', 'the declaration that won should be the committed one');
    assert.equal(refused, true, 'the books seed should have been refused, not merely delayed');
    assert.equal(waited, 'advisory',
      'and it should have been refused because it waited on the per-company advisory lock');
  });

  // ── Race 2: redemption against a concurrent deactivation ──────────────────
  await test('a disable landing mid-redemption is not undone by the redemption', async () => {
    const token = await scalar(ctl, `select set_config('request.jwt.claim.sub','${blake}',false);
      set role authenticated;
      select public.create_platform_invite('race2@prospect.com','Race Two')->>'token';`);
    const founder = randomUUID();
    await ctl.send(`reset role; insert into auth.users(id,email) values ('${founder}','race2@prospect.com');`);

    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let waited = null;
    let refused = false;
    try {
      // An administrator disables the account, and has not committed yet.
      await s2.send('begin;');
      await s2.send(`update public.profiles set is_active=false where id='${founder}';`);

      await asUser(s1, founder);
      const inflight = s1.send(
        `select public.redeem_platform_invite('${token}','Race Two','America/Los_Angeles','USD')->>'entity_id';`);

      // Same order as race 1: observe the wait, assert the outcome.
      waited = await waitUntilBlocked('silo-s1');

      await s2.send('commit;');
      refused = /account is disabled/.test(await inflight);
    } finally {
      await s1.end(); await s2.end();
    }

    const active = await scalar(ctl, `reset role; select is_active from public.profiles where id='${founder}';`);
    assert.equal(active, 'f', "the administrator's deactivation must survive the redemption attempt");
    const made = await scalar(ctl, `select count(*) from public.entities
                                    where created_by='${founder}';`);
    assert.equal(made, '0', 'a disabled account must not have founded a company');
    const invite = await scalar(ctl, `select status from public.platform_invites where email='race2@prospect.com';`);
    assert.equal(invite, 'pending', 'and its invite must remain usable once the account is restored');
    assert.equal(refused, true,
      'the refusal must be decided on the committed row, not on the snapshot taken before it');
    assert.ok(waited && /transactionid|tuple/.test(waited),
      `and it must have waited for the profile row rather than read around it (waited on: ${waited || 'nothing'})`);
  });

  // ── Race 3: one token, two clicks that arrive together ───────────────────
  await test('two simultaneous redeems of one token found one company, not two', async () => {
    const token = await scalar(ctl, `select set_config('request.jwt.claim.sub','${blake}',false);
      set role authenticated;
      select public.create_platform_invite('race3@prospect.com','Race Three')->>'token';`);
    const founder = randomUUID();
    await ctl.send(`reset role; insert into auth.users(id,email) values ('${founder}','race3@prospect.com');`);

    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let waited = null;
    let first = '';
    let second = '';
    try {
      await asUser(s1, founder);
      await asUser(s2, founder);
      // S1 opens a transaction and redeems, but does NOT commit: the window a
      // double-click actually lands in.
      await s1.send('begin;');
      first = await s1.send(
        `select public.redeem_platform_invite('${token}','Race Three','America/Los_Angeles','USD')->>'entity_id';`);

      const inflight = s2.send(
        `select public.redeem_platform_invite('${token}','Race Three','America/Los_Angeles','USD')->>'entity_id';`);
      waited = await waitUntilBlocked('silo-s2');

      await s1.send('commit;');
      second = await inflight;
    } finally {
      await s1.end(); await s2.end();
    }

    const founded = await scalar(ctl, `reset role; select count(*) from public.entities
                                       where created_by='${founder}';`);
    assert.equal(founded, '1',
      `the second click founded a company of its own -- ${founded} exist for one invite`);
    assert.equal(second.trim(), first.trim(),
      'the second redeem must return the company the first one made');
    assert.ok(waited && /transactionid|tuple/.test(waited),
      `and it must have waited on the invite row (waited on: ${waited || 'nothing'})`);
  });

  await ctl.end();
  console.log(`\n${passed} concurrency assertions passed against real PostgreSQL${mutation ? ` [mutation: ${mutation}]` : ''}.`);
} finally {
  if (work) await rm(work, { recursive: true, force: true });
  spawnSync('psql', [admin, '-XtAc',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname='${dbName}'`], { encoding: 'utf8' });
  spawnSync('psql', [admin, '-XtAc', `drop database if exists ${dbName}`], { encoding: 'utf8' });
}
