// AI credit under real concurrency: two PostgreSQL connections, interleaved.
//
// PGlite (scripts/tests/ai-credit-database.test.mjs) is one connection, so it
// proves a hold is refused when the balance is short, but never that two
// requests racing cannot BOTH read the same balance. These do:
//
//   1. Two opens on one company, one balance: the second WAITS on the first's
//      account row lock and is then refused -- never two holds on one balance.
//   2. A settle and a sweep of the same request: one wins, the other finds it
//      settled -- never charged twice, never a hold released twice.
//   3. One top-up delivered twice at once: credited once.
//
// Mutations (each must make the suite fail):
//   AI_CREDIT_RACE_MUTATION=open-unlocked   (the account FOR UPDATE removed from open)
//   AI_CREDIT_RACE_MUTATION=settle-unlocked (the reservation FOR UPDATE removed from settle)
//
// Requires PostgreSQL (SILO_PG_CONN); SKIPS loudly without one unless
// SILO_PG_REQUIRED=1, like onboarding-concurrency.test.mjs.
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mutation = process.env.AI_CREDIT_RACE_MUTATION || '';
assert.ok(['', 'open-unlocked', 'settle-unlocked'].includes(mutation), `Unknown race mutation: ${mutation}`);
const root = new URL('../../', import.meta.url);
const BASE = process.env.SILO_PG_CONN || process.env.DATABASE_URL || '';
function skip(why) {
  if (process.env.SILO_PG_REQUIRED === '1') { console.error(`\nFAILED: a PostgreSQL server was required and ${why}`); process.exit(1); }
  console.log(`SKIP - AI credit concurrency suite: ${why}`);
  process.exit(0);
}
if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) skip('psql is not installed');
const probe = spawnSync('psql', [BASE || 'postgresql://postgres@/postgres', '-XtAc', 'select 1'], { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0) skip(`no server answered (${(probe.stderr || '').trim().split('\n')[0] || 'connection failed'})`);
const admin = BASE || 'postgresql://postgres@/postgres';
const dbName = `silo_credit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

run(admin, ['-c', `create database ${dbName}`]);
let work;
try {
  work = await mkdtemp(join(tmpdir(), 'silo-credit-'));
  const file = async (n, b) => { const f = join(work, n); await writeFile(f, b); return f; };
  let sql = await readFile(new URL('supabase/migrations/20261001120000_ai_credit_billing.sql', root), 'utf8');
  if (mutation === 'open-unlocked') {
    const before = sql;
    sql = sql.replace(`  select * into acct from public.ai_credit_accounts
   where company_entity_id = p_company for update;`, () => `  select * into acct from public.ai_credit_accounts
   where company_entity_id = p_company;`);
    // The account upsert above it ALSO waits on a concurrent update of the same
    // row (ON CONFLICT must see the outcome), so it is removed too -- the row
    // already exists here. With neither, only the CHECK constraint is left,
    // which turns the race into an error instead of a clean refusal.
    const mid = sql;
    sql = sql.replace(`  -- enforce
  insert into public.ai_credit_accounts (company_entity_id) values (p_company)
    on conflict (company_entity_id) do nothing;`, () => '  -- enforce');
    assert.notEqual(sql, mid, 'open-unlocked (upsert) matched nothing');
    assert.notEqual(sql, before, 'open-unlocked matched nothing');
  }
  if (mutation === 'settle-unlocked') {
    const before = sql;
    sql = sql.replace(`  if r.enforced then
    select * into acct from public.ai_credit_accounts
      where company_entity_id = r.company_entity_id for update;
  end if;
  select * into r from public.ai_credit_reservations where id = p_request for update;`, () => '');
    assert.notEqual(sql, before, 'settle-unlocked matched nothing');
  }
  const A = randomUUID();
  run(dbConn, ['-f', await file('00-bootstrap.sql', await readFile(new URL('./stripe-db-bootstrap.sql', import.meta.url), 'utf8'))]);
  run(dbConn, ['-f', await file('01-stripe.sql', await readFile(new URL('supabase/migrations/20260919120000_stripe_billing_and_connect.sql', root), 'utf8'))]);
  run(dbConn, ['-f', await file('02-credit.sql', sql)]);
  run(dbConn, ['-f', await file('03-seed.sql', `
    insert into public.entities(id,module,entity_type,entity_key,title) values ('${A}','finance_hub','company','a','A');
    insert into public.billing_subscriptions(company_entity_id,stripe_customer_id,status) values ('${A}','cus_A','active');
    insert into public.ai_billing_settings(id,mode,customer_multiplier_bps) values (true,'enforce',15000);
    insert into public.ai_provider_rates(model,effective_from,input_micros_per_token,output_micros_per_token,
      cache_read_micros_per_token,cache_write_5m_micros_per_token,cache_write_1h_micros_per_token)
      values ('m', now()-interval '1 day', 2, 10, 0.2, 2.5, 4);
    insert into public.ai_credit_packs(pack_key,title,stripe_price_id,credit_micros) values ('p','p','price_p',30000);
  `)]);

  const ctl = session('credit-ctl');
  const scalar = async (s, q) => (await s.send(q)).split('\n').pop().trim();
  async function waitUntilBlocked(app) {
    for (let i = 0; i < 100; i += 1) {
      const ev = await scalar(ctl, `select coalesce(string_agg(wait_event,','),'') from pg_stat_activity where application_name='${app}' and wait_event_type='Lock';`);
      if (ev) return ev;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
  const svc = (s) => s.send('set role service_role;');
  const open = (req, input = 1000) => `select public.ai_credit_open('${req}','${A}',null,'ask_silo','m',${input},1000,0,1,null)::text;`;
  const reconciled = async () => assert.equal(await scalar(ctl, `select bool_and(ok) from public.ai_credit_reconcile('${A}');`), 't', 'ledger does not reconcile');

  // One worst-case call = (1000*4 + 1000*10) * 1.5 = 21000 micros. 30000 covers one.
  await ctl.send(`select public.ai_credit_grant_purchase('${A}', '{"id":"cs_seed","mode":"payment","payment_status":"paid","customer":"cus_A","payment_intent":"pi_seed","metadata":{"silo_purpose":"ai_credit_topup","silo_company_entity_id":"${A}","silo_credit_pack":"p"}}'::jsonb);`);

  await test('two concurrent opens cannot both hold one balance', async () => {
    const s1 = session('credit-s1'), s2 = session('credit-s2');
    let second, waited;
    try {
      await svc(s1); await svc(s2);
      await s1.send('begin;');
      const first = await s1.send(open(randomUUID()));
      assert.match(first, /"ok": true/);
      await s2.send('begin;');
      const inflight = s2.send(open(randomUUID()));
      waited = await waitUntilBlocked('credit-s2');
      await s1.send('commit;');
      second = await inflight;
      await s2.send(/ERROR/.test(second) ? 'rollback;' : 'commit;');
    } finally { await s1.end(); await s2.end(); }
    assert.match(second, /insufficient_credit/, `the second open should be refused cleanly, got: ${second}`);
    assert.ok(waited, 'the second open must have waited for the first');
    assert.equal(await scalar(ctl, `select held_micros from public.ai_credit_accounts where company_entity_id='${A}';`), '21000');
    await reconciled();
  });

  await test('a settle racing a sweep charges once and releases the hold once', async () => {
    const req = await scalar(ctl, `select id from public.ai_credit_reservations where status='held' limit 1;`);
    await ctl.send(`update public.ai_credit_reservations set last_activity_at = now() - interval '1 hour' where id='${req}';`);
    const s1 = session('credit-s1'), s2 = session('credit-s2');
    let swept;
    try {
      await svc(s1); await svc(s2);
      await s1.send('begin;');
      await s1.send(`select public.ai_credit_settle('${req}','{"input":1000,"output":500}'::jsonb,'succeeded',null);`);
      const inflight = s2.send(`select public.ai_credit_sweep('${A}', interval '15 minutes');`);
      await waitUntilBlocked('credit-s2');
      await s1.send('commit;');
      swept = await inflight;
    } finally { await s1.end(); await s2.end(); }
    const row = await scalar(ctl, `select outcome||':'||charged_micros from public.ai_credit_reservations where id='${req}';`);
    assert.equal(row, 'succeeded:10500', `settled once as the answer that was delivered (sweep said ${swept})`);
    assert.equal(await scalar(ctl, `select held_micros from public.ai_credit_accounts where company_entity_id='${A}';`), '0');
    assert.equal(await scalar(ctl, `select count(*) from public.ai_credit_ledger where reservation_id='${req}';`), '1');
    await reconciled();
  });

  await test('one top-up delivered twice at the same moment credits once', async () => {
    const session1 = `'{"id":"cs_dup","mode":"payment","payment_status":"paid","customer":"cus_A","payment_intent":"pi_dup","metadata":{"silo_purpose":"ai_credit_topup","silo_company_entity_id":"${A}","silo_credit_pack":"p"}}'::jsonb`;
    const s1 = session('credit-s1'), s2 = session('credit-s2');
    let a, b;
    try {
      await svc(s1); await svc(s2);
      await s1.send('begin;');
      a = await s1.send(`select public.ai_credit_grant_purchase('${A}', ${session1})::text;`);
      await s2.send('begin;');
      const inflight = s2.send(`select public.ai_credit_grant_purchase('${A}', ${session1})::text;`);
      await waitUntilBlocked('credit-s2');
      await s1.send('commit;');
      b = await inflight;
      await s2.send('commit;');
    } finally { await s1.end(); await s2.end(); }
    assert.match(a, /"granted": true/);
    assert.match(b, /already_granted/);
    assert.equal(await scalar(ctl, `select count(*) from public.ai_credit_ledger where stripe_payment_intent_id='pi_dup';`), '1');
    await reconciled();
  });
  await ctl.end();
} finally {
  if (work) await rm(work, { recursive: true, force: true });
  spawnSync('psql', [admin, '-X', '-c', `drop database if exists ${dbName} with (force)`], { encoding: 'utf8' });
}
console.log(`\n${passed} AI credit concurrency assertions passed against real PostgreSQL.`);
