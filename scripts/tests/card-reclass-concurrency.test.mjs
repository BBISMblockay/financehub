// Two REAL PostgreSQL connections, interleaved on purpose, against the
// posted-period reclass (20261013180000_card_transaction_reclass.sql).
//
// PGlite (card-reclass-database.test.mjs) has ONE connection, so it proves each
// guard's logic but never that two sessions cannot slip past it together:
//
//   1. Staging B (which moves FROM posted reclass A's target) while A is being
//      unposted, stage first: the unpost must wait for B and then be refused.
//   2. The same, unpost first: the stage must wait, then read A as unposted and
//      be refused, rather than commit a move from an account A no longer fed.
//   3. Two stages of one transaction at once: the second must wait and be
//      refused, never leave two open reclasses moving the same amount.
//
// Mutations (each must make the suite fail):
//   CARD_RECLASS_RACE_MUTATION=void-unlocked   (the unpost guard's lock removed)
//   CARD_RECLASS_RACE_MUTATION=stage-unlocked  (the staging lock removed)
//
// Requires a reachable PostgreSQL server; SKIPS (exit 0, loudly) without one,
// and FAILS when SILO_PG_REQUIRED=1, as the other concurrency suites do.
//
//   SILO_PG_CONN=postgresql://postgres@/postgres?host=/var/run/postgresql \
//     node scripts/tests/card-reclass-concurrency.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mutation = process.env.CARD_RECLASS_RACE_MUTATION || '';
assert.ok(['', 'void-unlocked', 'stage-unlocked'].includes(mutation), `Unknown race mutation: ${mutation}`);

const root = new URL('../../', import.meta.url);
const BASE = process.env.SILO_PG_CONN || process.env.DATABASE_URL || '';

function skip(why) {
  if (process.env.SILO_PG_REQUIRED === '1') {
    console.error(`\nFAILED: a PostgreSQL server was required and ${why}`);
    process.exit(1);
  }
  console.log(`SKIP - card reclass concurrency suite: ${why}`);
  console.log('SKIP - set SILO_PG_CONN to a reachable PostgreSQL to run it.');
  process.exit(0);
}

if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) skip('psql is not installed');
const probe = spawnSync('psql', [BASE || 'postgresql://postgres@/postgres', '-XtAc', 'select 1'],
  { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0) skip(`no server answered (${(probe.stderr || '').trim().split('\n')[0] || 'connection failed'})`);

const admin = BASE || 'postgresql://postgres@/postgres';
const dbName = `silo_reclass_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const dbConn = admin.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);

const run = (conn, args) => {
  const r = spawnSync('psql', [conn, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
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
  return {
    send(sql) {
      if (done) throw new Error(`${name}: session already closed`);
      if (!/;\s*$/.test(sql)) throw new Error(`${name}: statement must end in ';'`);
      if (waiter) throw new Error(`${name}: a statement is already in flight`);
      const promise = new Promise((resolve) => { waiter = { resolve }; });
      p.stdin.write(`${sql}\n\\echo ${MARK}\n`);
      return promise;
    },
    async end() { if (!done) { p.stdin.end(); await new Promise((r) => p.on('exit', r)); } },
  };
}

let passed = 0;
const test = async (title, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${title}`); };

run(admin, ['-c', `create database ${dbName}`]);
let work;
try {
  work = await mkdtemp(join(tmpdir(), 'silo-reclass-race-'));
  const file = async (n, body) => { const f = join(work, n); await writeFile(f, body); return f; };

  let bootstrap = await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8');
  bootstrap = bootstrap.replace(/create role (\w+) ([^;]*);/g,
    (_, r, opts) => `do $r$ begin create role ${r} ${opts}; exception when duplicate_object then null; end $r$;`);
  const dependencies = [
    '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
    '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
    '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
    '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
    '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
    '20260912052930_plaid_bank_feed.sql', '20260912203725_bank_feed_workspace_history.sql', '20260912231606_accounting_foundation.sql',
    '20260913022606_qbo_historical_ledger.sql', '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
  ];
  let reclass = await readFile(new URL('supabase/migrations/20261013180000_card_transaction_reclass.sql', root), 'utf8');
  const cut = (from, to = '') => {
    assert.ok(reclass.includes(from), `mutation ${mutation} is stale: its target text is gone`);
    reclass = reclass.replace(from, to);
  };
  if (mutation === 'void-unlocked') {
    cut("    perform pg_advisory_xact_lock(hashtextextended('card_reclass:' || r.transaction_id::text, 0));\n");
  }
  if (mutation === 'stage-unlocked') {
    cut("  perform pg_advisory_xact_lock(hashtextextended('card_reclass:' || t.id::text, 0));\n");
  }

  const co = randomUUID(), finance = randomUUID(), conn = randomUUID(), card = randomUUID();
  const txns = [0, 1, 2].map(() => ({ batch: randomUUID(), txn: randomUUID() }));
  const seed = `
    insert into entities(id,title) values ('${co}','A');
    insert into auth.users(id) values ('${finance}');
    insert into profiles(id,name,role,department,active_company_id) values ('${finance}','F','user','finance','${co}');
    insert into entity_memberships(entity_id,user_id,role) values ('${co}','${finance}','member');
    insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values ('${conn}','${co}','r','x');
    insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values
      ('${co}','${conn}','meals','meals','Expense',true),('${co}','${conn}','travel','travel','Expense',true),
      ('${co}','${conn}','supplies','supplies','Expense',true),('${co}','${conn}','cc','cc','Credit Card',true);
    insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
      values ('${card}','${co}','${conn}','card','Company card','card','cc','cc',true);
    ${txns.map((x, i) => `
    insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
      values ('${x.batch}','${co}','${card}','B${i}','2026-09-30','2026-09-01','2026-09-30','draft','csv','${conn}');
    insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
      values ('${x.txn}','${co}','${x.batch}',1,'2026-09-15','DELTA','DELTA','Delta','Travel',84,'USD','coded','meals','meals','manual');
    update card_import_batches set status='posted' where id='${x.batch}';`).join('')}
  `;
  const stubs = `create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-04' $$;`;
  run(dbConn, ['-f', await file('00-bootstrap.sql', bootstrap)]);
  for (const [i, name] of dependencies.entries()) {
    run(dbConn, ['-f', await file(`1${String(i).padStart(2, '0')}.sql`, await readFile(new URL('supabase/migrations/' + name, root), 'utf8'))]);
  }
  run(dbConn, ['-f', await file('20-stubs.sql', stubs)]);
  run(dbConn, ['-f', await file('30-ledger.sql', await readFile(new URL('supabase/migrations/20261005120000_silo_daily_ledger.sql', root), 'utf8'))]);
  run(dbConn, ['-f', await file('40-reclass.sql', reclass)]);
  run(dbConn, ['-f', await file('50-seed.sql', seed)]);

  const ctl = session('silo-ctl');
  const scalar = async (s, sqlText) => (await s.send(sqlText)).split('\n').pop().trim();
  async function waitUntilBlocked(appName) {
    for (let i = 0; i < 100; i += 1) {
      const ev = await scalar(ctl, `select coalesce(string_agg(wait_event,','),'') from pg_stat_activity
                                    where application_name='${appName}' and wait_event_type='Lock';`);
      if (ev) return ev;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
  const asUser = (s) => s.send(`reset role; select set_config('request.jwt.claim.sub','${finance}',false); set role authenticated;`);
  const stageSql = (t, to) => `select stage_card_transaction_reclass('${t}','${to}',null,null,null,null,'race test')->>'adjustment_id';`;
  // A posted reclass A (meals -> travel), as the edge function leaves it.
  async function postedReclass(t) {
    await asUser(ctl);
    const adj = await scalar(ctl, stageSql(t, 'travel'));
    await scalar(ctl, `select approve_journal_adjustment('${adj}');`);
    await ctl.send('reset role;');
    await ctl.send(`update journal_adjustments set status='posted' where id='${adj}';`);
    return adj;
  }
  const unpostSql = (adj) => `update journal_adjustments set status='approved' where id='${adj}';`;   // void_journal_adjustment's transition
  const openCount = (t) => scalar(ctl, `reset role; select count(*) from card_transaction_reclasses r join journal_adjustments a on a.id=r.adjustment_id
                                         where r.transaction_id='${t}' and a.status in ('draft','approved');`);

  await test('staging B while A is unposted (stage first): the unpost waits and is refused', async () => {
    const { txn } = txns[0];
    const a = await postedReclass(txn);
    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let unposted = '';
    try {
      await asUser(s1);
      await s1.send('begin;');
      assert.match(await s1.send(stageSql(txn, 'supplies')), /[0-9a-f-]{36}/);
      await s2.send('begin;');
      const inflight = s2.send(unpostSql(a));
      await waitUntilBlocked('silo-s2');
      await s1.send('commit;');
      unposted = await inflight;
      await s2.send(/ERROR/.test(unposted) ? 'rollback;' : 'commit;');
    } finally { await s1.end(); await s2.end(); }
    assert.match(unposted, /later reclassification/, `A was unposted under B: ${unposted || 'no error'}`);
    assert.equal(await scalar(ctl, `select status from journal_adjustments where id='${a}';`), 'posted');
  });

  await test('unposting A while B is staged (unpost first): the stage waits, then is refused', async () => {
    const { txn } = txns[1];
    const a = await postedReclass(txn);
    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let staged = '';
    try {
      await s2.send('begin;');
      await s2.send(unpostSql(a));
      await asUser(s1);
      await s1.send('begin;');
      const inflight = s1.send(stageSql(txn, 'supplies'));
      await waitUntilBlocked('silo-s1');
      await s2.send('commit;');
      staged = await inflight;
      await s1.send(/ERROR/.test(staged) ? 'rollback;' : 'commit;');
    } finally { await s1.end(); await s2.end(); }
    assert.match(staged, /awaiting review or posting/, `B was staged from an unposted A: ${staged || 'no error'}`);
    assert.equal(await openCount(txn), '1', 'only A (now approved, unposted) is open');
  });

  await test('two stages of one transaction at once: the second waits and is refused', async () => {
    const { txn } = txns[2];
    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let second = '';
    try {
      await asUser(s1); await asUser(s2);
      await s1.send('begin;');
      assert.match(await s1.send(stageSql(txn, 'travel')), /[0-9a-f-]{36}/);
      await s2.send('begin;');
      const inflight = s2.send(stageSql(txn, 'supplies'));
      await waitUntilBlocked('silo-s2');
      await s1.send('commit;');
      second = await inflight;
      await s2.send(/ERROR/.test(second) ? 'rollback;' : 'commit;');
    } finally { await s1.end(); await s2.end(); }
    assert.match(second, /already has a reclassification awaiting/, `two open reclasses: ${second || 'no error'}`);
    assert.equal(await openCount(txn), '1');
  });

  await ctl.end();
  console.log(`\n${passed} card reclass concurrency assertions passed against real PostgreSQL.`);
} finally {
  run(admin, ['-c', `drop database if exists ${dbName} with (force)`]);
  if (work) await rm(work, { recursive: true, force: true });
}
