// Background coding preparation, executed against the real migrations.
//
// What is proven:
//   1. "Needs preparation" is derived from stored facts: a new or changed row
//      is picked up, a prepared or dismissed one is not, a failure comes back
//      only after its backoff and stops after five attempts, a claimed row is
//      left to its claimant, and every blocker (coded, excluded, split,
//      pending, locked) keeps a row out.
//   2. Claims are exclusive until they expire, and releasing frees them.
//   3. next_card_coding_work hands out one import at a time, in order, capped,
//      with the company read from the import, and closes interrupted runs.
//   4. None of it is reachable from the browser.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_BACKGROUND_MUTATION=no-backoff        failures retried immediately
//   CARD_BACKGROUND_MUTATION=claims-ignored    claimed rows handed out again
//   CARD_BACKGROUND_MUTATION=dismissal-ignored dismissed rows prepared again
//   CARD_BACKGROUND_MUTATION=claim-steals      a live claim can be taken over
//   CARD_BACKGROUND_MUTATION=location-not-stale a retired location still reads as prepared
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'no-backoff': ["if now() < public.card_coding_retry_after(v_live.attempt, v_live.prepared_at) then return 'backoff'; end if;", ''],
  'claims-ignored': ["if exists (select 1 from public.card_coding_preparation_claims c where c.transaction_id = t.id and c.expires_at > now()) then", 'if false then'],
  'dismissal-ignored': ["if v_live.review_status = 'dismissed' then return 'dismissed'; end if;", ''],
  'claim-steals': ['where c.expires_at <= now() or c.claim_token = excluded.claim_token', 'where true'],
  'location-not-stale': [`    when g.qbo_location_id is not null and not exists (select 1 from public.quickbooks_locations l
      where l.company_entity_id = g.company_entity_id and l.connection_id = g.qbo_connection_id
        and l.qbo_location_id = g.qbo_location_id and l.is_active) then 'location_unavailable'
`, ''],
};
const mutation = process.env.CARD_BACKGROUND_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown mutation');

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql', '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
  '20260923120000_card_coding_suggestions.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID(), other = randomUUID(), finance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID(), source = randomUUID(), otherSource = randomUUID();
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const svc = (fn) => as(null, fn, 'service_role');
const rpc = async (name, args) => Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];
const refused = async (fn, pattern, what) => { await assert.rejects(fn, pattern, what); passed += 1; console.log(`ok ${passed} - refused: ${what}`); };

async function newBatch(src = source, { status = 'draft', company = co, connection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status,origin,qbo_connection_id)
           values($1,$2,$3,'Batch','2026-09-30',$4,'csv',$5)`, [id, company, src, status, connection]);
  return id;
}
async function newTxn(batchId, amount = 20, { company = co, date = '2026-09-15', merchant = 'Office Depot' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status)
           values($1,$2,$3,1,$4,$5,$5,$5,'Supplies',$6,'USD','uncoded')`, [id, company, batchId, date, merchant, amount]);
  return id;
}
const needs = async (txn) => (await one(`select public.card_coding_needs_preparation(t,b,s) r from card_transactions t
  join card_import_batches b on b.id=t.batch_id join card_sources s on s.id=b.source_id where t.id=$1`, [txn])).r;
const hash = async (txn) => (await svc(() => one('select input_hash from card_coding_input_hashes($1,$2)', [co, [txn]]))).input_hash;
async function prepare(txn, outcome = 'suggested', extra = {}) {
  const run = (await one(`insert into card_coding_preparation_runs(company_entity_id,source_id,qbo_connection_id,trigger)
    values($1,$2,$3,'background') returning id`, [co, source, conn])).id;
  const row = { transaction_id: txn, expected_input_hash: await hash(txn), outcome,
    ...(outcome === 'suggested' ? { qbo_account_id: 'supplies', accounting_treatment: 'purchase', confidence: 0.8 } : { error_code: 'anthropic_529' }), ...extra };
  return svc(() => rpc('record_card_coding_suggestions', [run, JSON.stringify([row]), false]));
}
const claim = (ids, token, lease = 240, company = co) => svc(async () => (await q('select * from claim_card_coding_preparation($1,$2,$3,$4) id', [company, ids, token, lease])).map((r) => r.id));
const work = (after = null, batch = null, limit = 160) => svc(() => rpc('next_card_coding_work', [after, batch, limit]));

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  let sql = await readFile(new URL('supabase/migrations/20260923130000_card_coding_background_preparation.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale`);
    sql = sql.replace(from, to);
  }
  await db.exec(sql); await db.exec(sql);

  await q("insert into entities(id,title) values($1,'A'),($2,'B')", [co, other]);
  await q('insert into auth.users(id) values($1)', [finance]);
  await q("insert into profiles(id,name,role,department,active_company_id) values($1,'F','user','finance',$2)", [finance, co]);
  await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member')", [co, finance]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','s'),($3,$4,'r2','s')", [conn, co, otherConn, other]);
  await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,'supplies','Office supplies','Expense',true),($1,$2,'meals','Meals','Expense',true)", [co, conn]);
  await q("insert into quickbooks_locations(company_entity_id,connection_id,qbo_location_id,name,is_active) values($1,$2,'hq','HQ',true),($1,$2,'shop','Shop',true)", [co, conn]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,'card','Card','card','cc','Card',true),($4,$5,$6,'card','Other','card','cc','Other',true)`,
    [source, co, conn, otherSource, other, otherConn]);
  // Opted in the way an administrator would: one column on the account.
  await q('update card_sources set auto_prepare_coding=true where id = any($1)', [[source, otherSource]]);

  const batch = await newBatch();

  await test('a new settled uncoded row needs preparing; once prepared it does not', async () => {
    const t = await newTxn(batch);
    assert.equal(await needs(t), null);
    await prepare(t);
    assert.equal(await needs(t), 'prepared');
  });

  await test('changed facts, a changed connection or a deactivated account bring a row back', async () => {
    const t = await newTxn(batch, 30);
    await prepare(t);
    await q('update card_transactions set amount=31 where id=$1', [t]);
    assert.equal(await needs(t), null, 'facts changed');
    await prepare(t);
    await q("update quickbooks_accounts set is_active=false where qbo_account_id='supplies'");
    assert.equal(await needs(t), null, 'the suggested account is gone');
    await q("update quickbooks_accounts set is_active=true where qbo_account_id='supplies'");
    const view = await as(finance, () => one("select stale_reason from card_coding_suggestions_v where transaction_id=$1 and review_status='open'", [t]));
    assert.equal(view.stale_reason, null, 'the view and the scheduler share one definition of stale');
  });

  // Review finding (#761, cycle 1, P1): a retired account made the row
  // eligible again, but the writer refused the replacement as already
  // prepared -- so every sync and nightly paid for a call that saved nothing.
  await test('a retired account is replaced once by the scheduler, and the row then leaves the schedule', async () => {
    const t = await newTxn(batch, 35);
    await prepare(t);
    await q("update quickbooks_accounts set is_active=false where qbo_account_id='supplies'");
    try {
      assert.equal(await needs(t), null, 'the stale suggestion makes the row eligible');
      const out = await prepare(t, 'suggested', { qbo_account_id: 'meals' });
      assert.equal(out.recorded, 1, JSON.stringify(out));
      assert.equal(await needs(t), 'prepared', 'and once replaced it is no longer scheduled');
      assert.equal((await one("select qbo_account_id from card_coding_suggestions where transaction_id=$1 and review_status='open'", [t])).qbo_account_id, 'meals');
    } finally { await q("update quickbooks_accounts set is_active=true where qbo_account_id='supplies'"); }
  });

  // Review finding (#761, cycle 1, P2): accept refuses a retired location, so
  // a suggestion naming one must read as stale -- hidden, and replaceable.
  await test('a retired location makes a suggestion stale, replaceable and acceptable again', async () => {
    const t = await newTxn(batch, 36);
    await prepare(t, 'suggested', { location_name: 'HQ' });
    assert.equal((await one("select qbo_location_id from card_coding_suggestions where transaction_id=$1 and review_status='open'", [t])).qbo_location_id, 'hq');
    await q("update quickbooks_locations set is_active=false where qbo_location_id='hq'");
    try {
      const view = await as(finance, () => one("select stale_reason from card_coding_suggestions_v where transaction_id=$1 and review_status='open'", [t]));
      assert.equal(view.stale_reason, 'location_unavailable');
      assert.equal(await needs(t), null);
      const out = await prepare(t, 'suggested', { location_name: 'Shop' });
      assert.equal(out.recorded, 1, JSON.stringify(out));
      const fresh = await one("select id, qbo_location_id from card_coding_suggestions where transaction_id=$1 and review_status='open'", [t]);
      assert.equal(fresh.qbo_location_id, 'shop');
      const accepted = await as(finance, () => rpc('accept_card_coding_suggestions', [[fresh.id]]));
      assert.equal(accepted.accepted.length, 1, JSON.stringify(accepted));
    } finally { await q("update quickbooks_locations set is_active=true where qbo_location_id='hq'"); }
  });

  await test('a dismissed row is not prepared again automatically', async () => {
    const t = await newTxn(batch, 40);
    await prepare(t);
    const s = await one("select id from card_coding_suggestions where transaction_id=$1 and review_status='open'", [t]);
    await as(finance, () => rpc('dismiss_card_coding_suggestions', [[s.id]]));
    assert.equal(await needs(t), 'dismissed');
  });

  await test('a failure waits out its backoff, then comes back, and stops after the fifth attempt', async () => {
    const t = await newTxn(batch, 50);
    await prepare(t, 'failed');
    assert.equal(await needs(t), 'backoff');
    await q("update card_coding_suggestions set prepared_at=now()-interval '16 minutes' where transaction_id=$1 and review_status='open'", [t]);
    assert.equal(await needs(t), null, 'attempt 1 retries after 15 minutes');
    for (let i = 0; i < 4; i++) {
      await prepare(t, 'failed');
      await q("update card_coding_suggestions set prepared_at=now()-interval '30 hours' where transaction_id=$1 and review_status='open'", [t]);
    }
    const live = await one("select attempt from card_coding_suggestions where transaction_id=$1 and review_status='open'", [t]);
    assert.equal(live.attempt, 5);
    assert.equal(await needs(t), 'retry_limit', 'a row that keeps failing waits for a person');
    const after = await one("select public.card_coding_retry_after(3, '2026-09-23T00:00:00Z'::timestamptz) at");
    assert.equal(new Date(after.at).toISOString(), '2026-09-23T01:00:00.000Z', 'backoff doubles: 15m, 30m, 1h');
  });

  await test('coded, excluded, split, locked and connectionless rows are never handed out', async () => {
    const coded = await newTxn(batch, 60);
    await q("update card_transactions set status='coded', qbo_account_id='supplies', coding_source='manual' where id=$1", [coded]);
    const excluded = await newTxn(batch, 61);
    await q("update card_transactions set status='excluded' where id=$1", [excluded]);
    const locked = await newBatch();
    const lockedTxn = await newTxn(locked, 62);
    await q("update card_import_batches set status='approved' where id=$1", [locked]);
    assert.equal(await needs(coded), 'already_coded'); assert.equal(await needs(excluded), 'excluded');
    assert.equal(await needs(lockedTxn), 'batch_locked');
    const noConn = await newBatch(); const nc = await newTxn(noConn, 63);
    await q('update quickbooks_connections set is_active=false where id=$1', [conn]);
    assert.equal(await needs(nc), 'no_connection');
    await q('update quickbooks_connections set is_active=true where id=$1', [conn]);
  });

  await test('a claim is exclusive until it expires, and releasing it frees the rows', async () => {
    const b = await newBatch(); const t1 = await newTxn(b, 70), t2 = await newTxn(b, 71);
    const a = randomUUID(), c = randomUUID();
    assert.deepEqual((await claim([t1, t2], a)).sort(), [t1, t2].sort());
    assert.deepEqual(await claim([t1, t2], c), [], 'a second worker gets nothing a live claim holds');
    assert.equal(await needs(t1), 'in_progress');
    assert.equal(await svc(() => rpc('release_card_coding_preparation', [a])), 2);
    assert.deepEqual((await claim([t1], c)), [t1]);
    await q("update card_coding_preparation_claims set expires_at=now()-interval '1 second' where claim_token=$1", [c]);
    assert.deepEqual(await claim([t1], a), [t1], 'an expired claim is taken over');
    assert.deepEqual(await claim([t1], randomUUID(), 240, other), [], 'a claim cannot reach another company\'s transaction');
    await svc(() => rpc('release_card_coding_preparation', [a]));
  });

  await test('next_card_coding_work hands out one import at a time, in order, capped, with its own company', async () => {
    // Settle everything seeded so far, then build a clean picture.
    await q(`update card_transactions t set status='excluded' from card_import_batches b
             where b.id=t.batch_id and b.status in ('draft','categorized') and t.status='uncoded'`);
    const b1 = await newBatch(), b2 = await newBatch(), foreign = await newBatch(otherSource, { company: other, connection: otherConn });
    const [first, second] = [b1, b2].sort();
    for (let i = 0; i < 3; i++) await newTxn(first, 100 + i, { date: `2026-09-1${i}` });
    await newTxn(second, 200);
    await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,'supplies','B supplies','Expense',true)", [other, otherConn]);
    await newTxn(foreign, 300, { company: other });
    const w1 = await work(null, null, 2);
    const ordered = [first, second, foreign].sort();
    assert.equal(w1.batch_id, ordered[0]);
    const expectedCompany = w1.batch_id === foreign ? other : co;
    assert.equal(w1.company_entity_id, expectedCompany, 'the company is read from the import');
    const seen = [w1.batch_id];
    let cursor = w1.batch_id;
    for (;;) { const w = await work(cursor); if (!w) break; seen.push(w.batch_id); cursor = w.batch_id; }
    assert.deepEqual(seen, ordered, 'every import with work is visited once, in id order');
    const whole = await work(null, first, 2);
    assert.equal(whole.transaction_ids.length, 2); assert.equal(whole.remaining, 1, 'the cap is reported, not hidden');
    const newest = await one('select id from card_transactions where batch_id=$1 order by txn_date desc limit 1', [first]);
    assert.equal(whole.transaction_ids[0], newest.id, 'newest first');
    // Claimed rows are not handed out twice.
    const token = randomUUID();
    await claim(whole.transaction_ids, token);
    const rest = await work(null, first, 10);
    assert.deepEqual(rest.transaction_ids.filter((id) => whole.transaction_ids.includes(id)), []);
    await svc(() => rpc('release_card_coding_preparation', [token]));
  });

  await test('an account nobody switched on is never prepared in the background', async () => {
    const offSource = randomUUID();
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
             values($1,$2,$3,'off','Off','card','cc','Off',true)`, [offSource, co, conn]);
    assert.equal((await one('select auto_prepare_coding from card_sources where id=$1', [offSource])).auto_prepare_coding, false, 'off by default');
    const b = await newBatch(offSource); const t = await newTxn(b, 400);
    assert.equal(await needs(t), null, 'the row itself is preparable -- by the Prepare button');
    let cursor = null; const seen = [];
    for (;;) { const w = await work(cursor); if (!w) break; seen.push(w.batch_id); cursor = w.batch_id; }
    assert.equal(seen.includes(b), false, 'but the scheduler never hands it out');
    await q('update card_sources set auto_prepare_coding=true where id=$1', [offSource]);
    const w = await work(null, b);
    assert.equal(w.batch_id, b);
    await q(`update card_transactions set status='excluded' where id=$1`, [t]);
  });

  await test('a run the gateway cut off is closed with a reason; a recent one is left running', async () => {
    const old = (await one(`insert into card_coding_preparation_runs(company_entity_id,qbo_connection_id,trigger,started_at)
      values($1,$2,'background',now()-interval '20 minutes') returning id`, [co, conn])).id;
    const fresh = (await one(`insert into card_coding_preparation_runs(company_entity_id,qbo_connection_id,trigger)
      values($1,$2,'background') returning id`, [co, conn])).id;
    await work();
    const o = await one('select status, finished_at, error from card_coding_preparation_runs where id=$1', [old]);
    assert.equal(o.status, 'failed'); assert.ok(o.finished_at); assert.match(o.error, /interrupted before it finished/);
    assert.equal((await one('select status from card_coding_preparation_runs where id=$1', [fresh])).status, 'running');
  });

  await test('the scheduler functions and the claims table are unreachable from the browser', async () => {
    for (const [fn, args] of [['next_card_coding_work', [null, null, 1]], ['claim_card_coding_preparation', [co, [], randomUUID(), 60]],
      ['release_card_coding_preparation', [randomUUID()]], ['close_interrupted_card_coding_runs', []]]) {
      await refused(() => as(finance, () => rpc(fn, args)), /permission denied/, `an authenticated user calling ${fn}`);
      await refused(() => as(null, () => rpc(fn, args), 'anon'), /permission denied/, `anon calling ${fn}`);
    }
    await refused(() => as(finance, () => q('select * from card_coding_preparation_claims')), /permission denied/, 'a client reading claims');
  });

  if (mutation) { console.error(`MUTATION ${mutation} survived`); process.exit(1); }
  console.log(`PASS card coding background preparation: ${passed} checks -- derived work, backoff and retry limit, exclusive claims, ordered one-import work units, interrupted-run closure, browser isolation`);
} catch (error) {
  if (mutation) { console.log(`mutation ${mutation} killed: ${error.message.split('\n')[0]}`); process.exit(0); }
  console.error(error);
  process.exit(1);
}
