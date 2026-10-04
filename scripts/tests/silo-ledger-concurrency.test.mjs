// Two REAL PostgreSQL connections, interleaved on purpose, against the SILO
// daily ledger's period lock.
//
// PGlite (silo-ledger-database.test.mjs) has ONE connection, so it can prove
// which lock each path takes but never that two sessions cannot interleave
// around it. These are the two races the cycle-1 review named:
//
//   1. Recording vs. moving the lock. A transaction that read "no lock" must
//      not commit a September entry after finance has locked September. The
//      recorder takes the per-company advisory lock SHARED and
//      set_accounting_period_lock takes it EXCLUSIVE, so a recording that
//      starts while the lock is moving waits, then reads the new lock and is
//      dated the first open day.
//   2. Two first locks at once. Without serialisation both see "no row", and
//      the earlier date can land last and reopen a closed month. The advisory
//      lock serialises them and the upsert only ever advances the date.
//
// Mutations (each must make the suite fail, for the right reason):
//   LEDGER_RACE_MUTATION=lock-unshared    (the recorder's shared lock removed)
//   LEDGER_RACE_MUTATION=period-unlocked  (the period lock's advisory lock AND
//                                          its forward-only upsert removed;
//                                          run with LEDGER_RACE_ONLY=2 too)
//
// Requires a reachable PostgreSQL server; SKIPS (exit 0, loudly) without one,
// and FAILS when SILO_PG_REQUIRED=1, as the other concurrency suites do.
//
//   SILO_PG_CONN=postgresql://postgres@/postgres?host=/var/run/postgresql \
//     node scripts/tests/silo-ledger-concurrency.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mutation = process.env.LEDGER_RACE_MUTATION || '';
assert.ok(['', 'lock-unshared', 'period-unlocked'].includes(mutation), `Unknown race mutation: ${mutation}`);

const root = new URL('../../', import.meta.url);
const BASE = process.env.SILO_PG_CONN || process.env.DATABASE_URL || '';

function skip(why) {
  if (process.env.SILO_PG_REQUIRED === '1') {
    console.error(`\nFAILED: a PostgreSQL server was required and ${why}`);
    process.exit(1);
  }
  console.log(`SKIP - SILO ledger concurrency suite: ${why}`);
  console.log('SKIP - set SILO_PG_CONN to a reachable PostgreSQL to run it.');
  process.exit(0);
}

if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) skip('psql is not installed');
const probe = spawnSync('psql', [BASE || 'postgresql://postgres@/postgres', '-XtAc', 'select 1'],
  { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0) skip(`no server answered (${(probe.stderr || '').trim().split('\n')[0] || 'connection failed'})`);

const admin = BASE || 'postgresql://postgres@/postgres';
const dbName = `silo_ledger_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
// LEDGER_RACE_ONLY=1|2 runs one race, so a mutation that breaks both can be
// shown to fail EACH (the period-unlocked mutation trips race 1 first).
const only = process.env.LEDGER_RACE_ONLY || '';
let raceNo = 0;
const test = async (title, fn) => {
  raceNo += 1;
  if (only && String(raceNo) !== only) return;
  await fn(); passed += 1; console.log(`ok ${passed} - ${title}`);
};

run(admin, ['-c', `create database ${dbName}`]);
let work;
try {
  work = await mkdtemp(join(tmpdir(), 'silo-ledger-race-'));
  const file = async (n, body) => { const f = join(work, n); await writeFile(f, body); return f; };

  // The PGlite bootstrap, made safe for a shared server: roles are cluster-wide.
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
  let ledger = await readFile(new URL('supabase/migrations/20261005120000_silo_daily_ledger.sql', root), 'utf8');
  const cut = (from, to = '') => {
    assert.ok(ledger.includes(from), `mutation ${mutation} is stale: its target text is gone`);
    ledger = ledger.replace(from, to);
  };
  if (mutation === 'lock-unshared') {
    cut("  perform pg_advisory_xact_lock_shared(hashtextextended('silo_ledger:company:' || v_company::text, 0));");
  }
  if (mutation === 'period-unlocked') {
    cut("  perform pg_advisory_xact_lock(hashtextextended('silo_ledger:company:' || v_company::text, 0));\n");
    cut('\n    where accounting_period_locks.locked_through < excluded.locked_through;   -- forward only, even under a race', ';');
    cut("  if not found then raise exception 'The books are already locked through a later date'; end if;\n");
  }

  const co = randomUUID(), co2 = randomUUID(), finance = randomUUID(), finance2 = randomUUID();
  const conn = randomUUID(), card = randomUUID(), batch = randomUUID(), txn = randomUUID();
  const seed = `
    insert into entities(id,title) values ('${co}','A'),('${co2}','B');
    insert into auth.users(id) values ('${finance}'),('${finance2}');
    insert into profiles(id,name,role,department,active_company_id) values
      ('${finance}','F','user','finance','${co}'),('${finance2}','G','user','finance','${co2}');
    insert into entity_memberships(entity_id,user_id,role) values ('${co}','${finance}','member'),('${co2}','${finance2}','member');
    insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values ('${conn}','${co}','r','x');
    insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values
      ('${co}','${conn}','supplies','supplies','Expense',true),('${co}','${conn}','cc','cc','Credit Card',true);
    insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
      values ('${card}','${co}','${conn}','card','Company card','card','cc','cc',true);
    with r as (insert into quickbooks_report_runs(company_entity_id,connection_id,report_name,status)
               values ('${co}','${conn}','TrialBalance','ok') returning id)
    insert into accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash,status)
      select '${co}', id, '{}'::jsonb, 'h', 'draft' from r;
    insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
      values ('${co}','${conn}','USD',1,'2026-08-01','Accrual');
    update accounting_opening_balances set status='accepted', accepted_at=now() where company_entity_id='${co}';
    insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
      values ('${batch}','${co}','${card}','B','2026-09-30','2026-09-01','2026-09-30','draft','csv','${conn}');
    insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status)
      values ('${txn}','${co}','${batch}',1,'2026-09-15','OFFICE DEPOT','OFFICE DEPOT','Office Depot','Supplies',42,'USD','uncoded');
  `;
  const stubs = `create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-04' $$;`;
  run(dbConn, ['-f', await file('00-bootstrap.sql', bootstrap)]);
  for (const [i, name] of dependencies.entries()) {
    run(dbConn, ['-f', await file(`1${String(i).padStart(2, '0')}.sql`, await readFile(new URL('supabase/migrations/' + name, root), 'utf8'))]);
  }
  run(dbConn, ['-f', await file('20-stubs.sql', stubs)]);
  run(dbConn, ['-f', await file('30-ledger.sql', ledger)]);
  run(dbConn, ['-f', await file('40-seed.sql', seed)]);

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
  const asUser = (s, uid) => s.send(`reset role; select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`);

  await test('a transaction recorded while finance locks its month lands on the first open day, never inside the lock', async () => {
    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let waited = null;
    try {
      await asUser(s1, finance);
      await s1.send('begin;');
      const locked = await s1.send("select set_accounting_period_lock('2026-09-30','September closed')->>'locked_through';");
      assert.match(locked, /2026-09-30/);

      // The categorization commits while the lock is still uncommitted: the
      // deferred recorder runs inside this COMMIT.
      await s2.send('begin;');
      await s2.send(`update card_transactions set status='coded', qbo_account_id='supplies', qbo_account_name='supplies', coding_source='manual' where id='${txn}';`);
      const inflight = s2.send('commit;');
      waited = await waitUntilBlocked('silo-s2');
      await s1.send('commit;');
      await inflight;
    } finally {
      await s1.end(); await s2.end();
    }
    const date = await scalar(ctl, `select string_agg(entry_date::text, ',') from ledger_entries where source_id='${txn}';`);
    assert.equal(date, '2026-10-01', `the entry was dated ${date} -- inside a period that was being locked`);
    assert.equal(waited, 'advisory', 'and it waited on the company ledger lock');
  });

  await test('two first period locks at once cannot leave the earlier date standing', async () => {
    const s1 = session('silo-s1');
    const s2 = session('silo-s2');
    let second = '';
    try {
      await asUser(s1, finance2);
      await asUser(s2, finance2);
      await s1.send('begin;');
      await s1.send("select set_accounting_period_lock('2026-09-30','September closed');");
      await s2.send('begin;');
      const inflight = s2.send("select set_accounting_period_lock('2026-08-31','August closed');");
      await waitUntilBlocked('silo-s2');
      await s1.send('commit;');
      second = await inflight;
      await s2.send(/ERROR/.test(second) ? 'rollback;' : 'commit;');
    } finally {
      await s1.end(); await s2.end();
    }
    const through = await scalar(ctl, `reset role; select locked_through::text from accounting_period_locks where company_entity_id='${co2}';`);
    assert.equal(through, '2026-09-30', `the books were left locked through ${through}: September reopened`);
    assert.match(second, /already locked/, 'the earlier lock was refused, not applied');
  });

  await ctl.end();
  console.log(`\n${passed} SILO ledger concurrency assertions passed against real PostgreSQL${mutation ? ` [mutation: ${mutation}]` : ''}.`);
} finally {
  if (work) await rm(work, { recursive: true, force: true });
  spawnSync('psql', [admin, '-XtAc',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname='${dbName}'`], { encoding: 'utf8' });
  spawnSync('psql', [admin, '-XtAc', `drop database if exists ${dbName}`], { encoding: 'utf8' });
}
