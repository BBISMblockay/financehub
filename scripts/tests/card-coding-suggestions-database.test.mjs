// Prepared coding suggestions, executed against the real migrations as the
// service role (the preparer) and as authenticated users (the reviewer).
//
// What is proven, in order of how much it would cost to get wrong:
//   1. Accepting re-checks everything at the moment of acceptance: changed
//      facts, a human coding the row meanwhile, a split, a locked batch, a
//      deactivated account, another company, a non-finance user.
//   2. Preparing never writes card_transactions, and a suggestion is never
//      recorded against facts the preparer did not read.
//   3. A dismissal persists across runs until the facts change or someone asks
//      again; duplicate delivery leaves one live suggestion; a failure never
//      replaces a prepared answer.
//   4. Clients cannot write suggestions or runs, and cannot call the writer.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_SUGGESTION_MUTATION=accept-ignores-hash
//   CARD_SUGGESTION_MUTATION=dismissal-ignored
//   CARD_SUGGESTION_MUTATION=accept-ignores-company
//   CARD_SUGGESTION_MUTATION=record-ignores-read-revision
//   CARD_SUGGESTION_MUTATION=failure-replaces-prepared
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'accept-ignores-hash': ["if public.card_coding_input_hash(v_t) <> v_g.input_hash then raise exception using message = 'facts_changed'; end if;", ''],
  'dismissal-ignored': ["if v_live.review_status = 'dismissed' and not p_retry then", "if false then"],
  // Both lookups: the transaction read is company-scoped too, so dropping only
  // the suggestion's filter is still caught (defence in depth, not a gap).
  'accept-ignores-company': [["select * into v_g from public.card_coding_suggestions where id = v_id and company_entity_id = v_company;",
    'select * into v_g from public.card_coding_suggestions where id = v_id;'],
    ["select * into v_t from public.card_transactions where id = v_g.transaction_id and company_entity_id = v_company for update;",
    'select * into v_t from public.card_transactions where id = v_g.transaction_id for update;']],
  'record-ignores-read-revision': ["if public.card_coding_input_hash(v_t) is distinct from nullif(v_row->>'expected_input_hash','') then", 'if false then'],
  'failure-replaces-prepared': ["if v_outcome = 'failed' and v_live.outcome <> 'failed' then", 'if false then'],
};
const mutation = process.env.CARD_SUGGESTION_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown card suggestion mutation');

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql', '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID(), other = randomUUID(), finance = randomUUID(), outsider = randomUUID(), otherUser = randomUUID();
const conn = randomUUID(), otherConn = randomUUID(), cardSource = randomUUID(), bankSource = randomUUID(), otherSource = randomUUID();
const plaidConn = randomUUID(), plaidAcct = randomUUID();
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, args) => Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];
const refused = async (fn, pattern, what) => { await assert.rejects(fn, pattern, what); passed += 1; console.log(`ok ${passed} - refused: ${what}`); };

async function newBatch(source, { status = 'draft', origin = 'csv', company = co, connection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status,origin,qbo_connection_id)
           values($1,$2,$3,'Batch','2026-09-30',$4,$5,$6)`, [id, company, source, status, origin, connection]);
  return id;
}
async function newTxn(batchId, amount, opts = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status)
           values($1,$2,$3,1,'2026-09-15',$4,$5,$6,$7,$8,'USD','uncoded')`,
    [id, opts.company ?? co, batchId, opts.description ?? 'OFFICE DEPOT #221', opts.merchant ?? 'OFFICE DEPOT',
     opts.clean_merchant ?? 'Office Depot', opts.card_name ?? 'Supplies', amount]);
  return id;
}
async function plaidTxn(batchId, amount, treatment = 'purchase') {
  const id = await newTxn(batchId, amount, { description: 'ACME PAYROLL', clean_merchant: null });
  await q(`update card_transactions set origin='plaid', plaid_account_id=$3, external_transaction_id=$1,
           provider_status='posted', provider_updated_at=now() - interval '1 day', accounting_treatment=$2 where id=$1`,
    [id, treatment, plaidAcct]);
  return id;
}
// What the preparer reads BEFORE it reads the facts, as the service role.
const readHash = async (id) => (await as(null, () => one('select input_hash from card_coding_input_hashes($1,$2)', [co, [id]]), 'service_role'))?.input_hash;
async function newRun({ company = co, connection = conn, trigger = 'manual', source = cardSource } = {}) {
  return (await one(`insert into card_coding_preparation_runs(company_entity_id,source_id,qbo_connection_id,trigger,model)
                     values($1,$2,$3,$4,'synthetic-model') returning id`, [company, source, connection, trigger])).id;
}
// The preparer's call, made the way card-categorize makes it: service role.
async function record(run, rows, retry = false) {
  return as(null, () => rpc('record_card_coding_suggestions', [run, JSON.stringify(rows), retry]), 'service_role');
}
async function suggestRow(txn, overrides = {}) {
  return { transaction_id: txn, expected_input_hash: await readHash(txn), outcome: 'suggested',
    qbo_account_id: 'supplies', accounting_treatment: 'purchase', confidence: 0.82, reasoning: 'Office supplies retailer.',
    evidence: 'CONSISTENT: Office supplies [3 confirmed SILO codings; last 2026-08-02].', history_status: 'consistent',
    vendor_name: 'Office Depot', location_name: 'HQ', ...overrides };
}
const live = (txn) => one(`select * from card_coding_suggestions where transaction_id=$1 and review_status in ('open','dismissed')`, [txn]);
const accept = (ids, actor = finance) => as(actor, () => rpc('accept_card_coding_suggestions', [ids]));
const dismiss = (ids, actor = finance) => as(actor, () => rpc('dismiss_card_coding_suggestions', [ids]));
const reasonFor = (out, id) => out.refused.find((r) => r.id === id)?.reason;

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  let sql = await readFile(new URL('supabase/migrations/20260923120000_card_coding_suggestions.sql', root), 'utf8');
  if (mutation) {
    const pairs = Array.isArray(MUTATIONS[mutation][0]) ? MUTATIONS[mutation] : [MUTATIONS[mutation]];
    for (const [from, to] of pairs) {
      assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
      sql = sql.replace(from, to);
    }
  }
  // Idempotent: the apply-all file may run it twice.
  await db.exec(sql); await db.exec(sql);

  await q("insert into entities(id,title) values($1,'Test A'),($2,'Test B')", [co, other]);
  await q('insert into auth.users(id) values($1),($2),($3)', [finance, outsider, otherUser]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)`,
    [finance, outsider, otherUser, co, other]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')`,
    [co, finance, outsider, other, otherUser]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','secret'),($3,$4,'r2','secret')",
    [conn, co, otherConn, other]);
  for (const [company, connection, id, name, type] of [
    [co, conn, 'supplies', 'Office supplies', 'Expense'], [co, conn, 'meals', 'Meals', 'Expense'],
    [co, conn, 'sales', 'Sales', 'Income'], [co, conn, 'clearing', 'Payroll clearing', 'Other Current Liability'],
    [other, otherConn, 'supplies', 'Other co supplies', 'Expense']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$4,$5,true)',
      [company, connection, id, name, type]);
  }
  await q("insert into quickbooks_locations(company_entity_id,connection_id,qbo_location_id,name,is_active) values($1,$2,'hq','HQ',true)", [co, conn]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,'card','Company card','card','cc','Company card',true),
                 ($4,$2,$3,'bank','Operating bank','bank','bank','Operating bank',true),
                 ($5,$6,$7,'card','Other card','card','cc','Other card',true)`,
    [cardSource, co, conn, bankSource, otherSource, other, otherConn]);
  await q(`insert into plaid_connections(id,company_entity_id,item_id,environment,institution_name) values($1,$2,'item','sandbox','Synthetic bank')`, [plaidConn, co]);
  await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id)
           values($1,$2,$3,'acct','Checking','depository',$4)`, [plaidAcct, co, plaidConn, bankSource]);

  const batch = await newBatch(cardSource);

  await test('a prepared suggestion is stored apart from the transaction, which stays uncoded', async () => {
    const txn = await newTxn(batch, 42.10);
    const before = await one('select * from card_transactions where id=$1', [txn]);
    const out = await record(await newRun(), [await suggestRow(txn)]);
    assert.equal(out.recorded, 1, JSON.stringify(out));
    const s = await live(txn);
    assert.equal(s.outcome, 'suggested'); assert.equal(s.review_status, 'open');
    assert.equal(s.qbo_account_name, 'Office supplies', 'the account name comes from the chart');
    assert.equal(s.qbo_location_id, 'hq', 'the location name is resolved to the chart id');
    const after = await one('select * from card_transactions where id=$1', [txn]);
    assert.deepEqual({ ...after }, { ...before }, 'preparing never writes card_transactions');
  });

  await test('a model account name is never stored: an account outside the active chart becomes needs_judgment', async () => {
    const txn = await newTxn(batch, 18);
    await record(await newRun(), [await suggestRow(txn, { qbo_account_id: 'invented' })]);
    const s = await live(txn);
    assert.equal(s.outcome, 'needs_judgment'); assert.equal(s.qbo_account_id, null); assert.equal(s.error_code, 'account_rejected');
    // An income account cannot carry a card purchase either.
    const txn2 = await newTxn(batch, 18);
    await record(await newRun(), [await suggestRow(txn2, { qbo_account_id: 'sales' })]);
    assert.equal((await live(txn2)).outcome, 'needs_judgment');
  });

  await test('a suggestion is never recorded against facts the preparer did not read', async () => {
    const txn = await newTxn(batch, 25);
    const row = await suggestRow(txn);
    await q("update card_transactions set description='OFFICE DEPOT #999' where id=$1", [txn]);
    const out = await record(await newRun(), [row]);
    assert.equal(out.recorded, 0);
    assert.equal(out.skipped[0].reason, 'changed_since_read');
    assert.equal(await live(txn), undefined);
  });

  await test('rows that may not be prepared are refused: coded, excluded, split, locked batch, other company', async () => {
    const coded = await newTxn(batch, 10);
    await q("update card_transactions set status='coded', qbo_account_id='meals', qbo_account_name='Meals', coding_source='manual' where id=$1", [coded]);
    const excluded = await newTxn(batch, 10);
    await q("update card_transactions set status='excluded', exclude_reason='Personal' where id=$1", [excluded]);
    const split = await newTxn(batch, 30);
    await as(finance, () => rpc('set_card_transaction_splits', [split, JSON.stringify([
      { amount: 20, qbo_account_id: 'supplies' }, { amount: 10, qbo_account_id: 'meals' }]), false, 'merchant']));
    const lockedBatch = await newBatch(cardSource);
    const locked = await newTxn(lockedBatch, 10);
    const lockedRow = await suggestRow(locked);
    await q("update card_import_batches set status='approved' where id=$1", [lockedBatch]);
    const foreign = await newTxn(await newBatch(otherSource, { company: other, connection: otherConn }), 10, { company: other });
    const out = await record(await newRun(), [await suggestRow(coded), await suggestRow(excluded), await suggestRow(split), lockedRow,
      { ...(await suggestRow(foreign)) }]);
    assert.equal(out.recorded, 0);
    const reasons = Object.fromEntries(out.skipped.map((s) => [s.transaction_id, s.reason]));
    assert.equal(reasons[coded], 'already_coded'); assert.equal(reasons[excluded], 'excluded');
    assert.equal(reasons[split], 'split'); assert.equal(reasons[locked], 'batch_locked');
    assert.equal(reasons[foreign], 'not_found', 'a run for one company cannot reach another company\'s transaction');
  });

  await test('duplicate delivery of the same work leaves one live suggestion, and the first answer stands', async () => {
    const txn = await newTxn(batch, 60);
    const row = await suggestRow(txn);
    await record(await newRun(), [row]);
    const again = await record(await newRun(), [{ ...row, qbo_account_id: 'meals' }]);
    assert.equal(again.skipped[0].reason, 'already_prepared');
    const rows = await q("select * from card_coding_suggestions where transaction_id=$1", [txn]);
    assert.equal(rows.length, 1); assert.equal(rows[0].qbo_account_id, 'supplies');
    // An explicit retry replaces it and keeps the old one as history.
    await record(await newRun({ trigger: 'retry' }), [{ ...row, qbo_account_id: 'meals' }], true);
    const all = await q("select review_status, qbo_account_id, attempt from card_coding_suggestions where transaction_id=$1 order by prepared_at, attempt", [txn]);
    assert.deepEqual(all.map((r) => [r.review_status, r.qbo_account_id, r.attempt]), [['superseded', 'supplies', 1], ['open', 'meals', 2]]);
  });

  await test('a failure never replaces a prepared answer, and repeated failures count attempts', async () => {
    const txn = await newTxn(batch, 70);
    await record(await newRun(), [await suggestRow(txn)]);
    const out = await record(await newRun(), [{ transaction_id: txn, expected_input_hash: await readHash(txn), outcome: 'failed', error_code: 'anthropic_529' }]);
    assert.equal(out.skipped[0]?.reason, 'kept_prepared');
    assert.equal((await live(txn)).outcome, 'suggested');
    const failing = await newTxn(batch, 71);
    const fail = async () => record(await newRun({ trigger: 'background' }),
      [{ transaction_id: failing, expected_input_hash: await readHash(failing), outcome: 'failed', error_code: 'timeout' }]);
    await fail(); await fail();
    const s = await live(failing);
    assert.equal(s.outcome, 'failed'); assert.equal(s.attempt, 2); assert.equal(s.error_code, 'timeout'); assert.equal(s.prepared_via, 'background');
  });

  await test('a dismissal persists across scheduled runs until the facts change or someone asks again', async () => {
    const txn = await newTxn(batch, 80);
    await record(await newRun(), [await suggestRow(txn)]);
    const s = await live(txn);
    assert.equal(await dismiss([s.id]), 1);
    const rerun = await record(await newRun({ trigger: 'background' }), [await suggestRow(txn)]);
    assert.equal(rerun.skipped[0]?.reason, 'dismissed', 'a scheduled run does not bring a dismissed suggestion back');
    assert.equal((await live(txn)).review_status, 'dismissed');
    await record(await newRun({ trigger: 'retry' }), [await suggestRow(txn)], true);
    assert.equal((await live(txn)).review_status, 'open', 'an explicit retry asks again');
    // Changed facts retire a dismissal too.
    const txn2 = await newTxn(batch, 81);
    await record(await newRun(), [await suggestRow(txn2)]);
    await dismiss([(await live(txn2)).id]);
    await q('update card_transactions set amount=82 where id=$1', [txn2]);
    await record(await newRun({ trigger: 'background' }), [await suggestRow(txn2)]);
    assert.equal((await live(txn2)).review_status, 'open');
  });

  await test('accepting codes the row through apply_card_coding as the person accepting, with the evidence attached', async () => {
    const txn = await newTxn(batch, 90);
    await record(await newRun(), [await suggestRow(txn)]);
    const s = await live(txn);
    const out = await accept([s.id]);
    assert.equal(out.accepted.length, 1, JSON.stringify(out)); assert.equal(out.refused.length, 0);
    const t = await one('select * from card_transactions where id=$1', [txn]);
    assert.equal(t.status, 'coded'); assert.equal(t.qbo_account_id, 'supplies'); assert.equal(t.qbo_account_name, 'Office supplies');
    assert.equal(t.qbo_location_id, 'hq'); assert.equal(t.coding_source, 'ai'); assert.equal(Number(t.confidence), 0.82);
    assert.equal(t.updated_by, finance); assert.equal(t.vendor_name, 'Office Depot'); assert.equal(t.accounting_treatment, 'purchase');
    assert.match(t.ai_reasoning, /Office supplies retailer\. History: CONSISTENT/);
    const decided = await one('select * from card_coding_suggestions where id=$1', [s.id]);
    assert.equal(decided.review_status, 'accepted'); assert.equal(decided.decided_by, finance);
    // A second accept of the same suggestion is refused, not re-applied.
    const again = await accept([s.id]);
    assert.equal(reasonFor(again, s.id), 'not_open');
  });

  await test('accepting re-checks the transaction at that moment, one refusal at a time', async () => {
    const make = async (amount = 95) => { const t = await newTxn(batch, amount); await record(await newRun(), [await suggestRow(t)]); return [t, (await live(t)).id]; };
    const [changed, changedId] = await make();
    await q('update card_transactions set amount=96 where id=$1', [changed]);
    const [human, humanId] = await make();
    await q("update card_transactions set status='coded', qbo_account_id='meals', qbo_account_name='Meals', coding_source='manual' where id=$1", [human]);
    const [split, splitId] = await make(100);
    await as(finance, () => rpc('set_card_transaction_splits', [split, JSON.stringify([
      { amount: 60, qbo_account_id: 'supplies' }, { amount: 40, qbo_account_id: 'meals' }]), false, 'merchant']));
    const [, goneId] = await make();
    await q("update quickbooks_accounts set is_active=false where qbo_account_id='supplies' and connection_id=$1", [conn]);
    const [, okId] = [null, null];
    const out = await accept([changedId, humanId, splitId, goneId]);
    await q("update quickbooks_accounts set is_active=true where qbo_account_id='supplies' and connection_id=$1", [conn]);
    assert.equal(out.accepted.length, 0, JSON.stringify(out));
    assert.equal(reasonFor(out, changedId), 'facts_changed', 'changed facts make the suggestion stale');
    assert.equal(reasonFor(out, humanId), 'already_coded', 'a human coding in the meantime wins');
    assert.equal(reasonFor(out, splitId), 'split', 'a split is never overwritten');
    assert.equal(reasonFor(out, goneId), 'account_unavailable', 'a deactivated account is not applied');
    assert.equal(okId, null);
    const humanRow = await one('select qbo_account_id, coding_source from card_transactions where id=$1', [human]);
    assert.deepEqual({ ...humanRow }, { qbo_account_id: 'meals', coding_source: 'manual' });
    // A partial set: the good one is accepted even though its neighbour is refused.
    const [, fineId] = await make();
    const mixed = await accept([changedId, fineId]);
    assert.deepEqual(mixed.accepted.map((a) => a.id), [fineId]);
  });

  await test('the read view says why a suggestion is stale', async () => {
    const t = await newTxn(batch, 110);
    await record(await newRun(), [await suggestRow(t)]);
    const view = () => as(finance, () => one('select stale_reason from card_coding_suggestions_v where transaction_id=$1 and review_status=\'open\'', [t]));
    assert.equal((await view()).stale_reason, null);
    await q("update card_transactions set description='DIFFERENT' where id=$1", [t]);
    assert.equal((await view()).stale_reason, 'facts_changed');
  });

  await test('a bank correction retires suggestions made against the old facts; metadata alone does not', async () => {
    const feed = await newBatch(bankSource, { origin: 'plaid' });
    const t = await plaidTxn(feed, 1250, 'payroll_settlement');
    await record(await newRun({ source: bankSource }), [await suggestRow(t, { qbo_account_id: 'clearing', accounting_treatment: 'payroll_settlement', location_name: null })]);
    const s = await live(t);
    assert.equal(s.outcome, 'suggested', JSON.stringify(s));
    // Enrichment: raw payload and updated_at move, provider_updated_at does not.
    await q("update card_transactions set raw='{\"note\":\"enriched\"}'::jsonb, updated_at=now() where id=$1", [t]);
    const view = await as(finance, () => one('select stale_reason from card_coding_suggestions_v where id=$1', [s.id]));
    assert.equal(view.stale_reason, null, 'metadata does not stale a suggestion');
    // An accounting correction: what plaid_project_transaction writes.
    await q("update card_transactions set amount=1300, provider_updated_at=now() where id=$1", [t]);
    const out = await accept([s.id]);
    assert.equal(reasonFor(out, s.id), 'facts_changed');
  });

  await test('another company, a non-finance member and anon cannot accept, dismiss, record or write', async () => {
    const t = await newTxn(batch, 120);
    await record(await newRun(), [await suggestRow(t)]);
    const s = await live(t);
    const fromOther = await accept([s.id], otherUser);
    assert.equal(reasonFor(fromOther, s.id), 'not_found', 'another company cannot see the suggestion to accept it');
    assert.equal(await dismiss([s.id], otherUser), 0);
    await refused(() => accept([s.id], outsider), /Finance access required/, 'a member without finance access accepting');
    await refused(() => dismiss([s.id], outsider), /Finance access required/, 'a member without finance access dismissing');
    const run = await newRun();
    await refused(() => as(finance, () => rpc('record_card_coding_suggestions', [run, '[]', false])), /permission denied/,
      'an authenticated user calling the service-role writer');
    await refused(() => as(finance, () => q(`insert into card_coding_suggestions(company_entity_id,transaction_id,qbo_connection_id,input_hash,outcome,prepared_via)
      values($1,$2,$3,'x','needs_judgment','manual')`, [co, t, conn])), /permission denied/, 'a client inserting a suggestion');
    await refused(() => as(finance, () => q("update card_coding_suggestions set review_status='accepted', decided_at=now() where id=$1", [s.id])),
      /permission denied/, 'a client marking a suggestion accepted without coding it');
    await refused(() => as(finance, () => q("insert into card_coding_preparation_runs(company_entity_id,qbo_connection_id,trigger) values($1,$2,'manual')", [co, conn])),
      /permission denied/, 'a client writing a run');
    await refused(() => as(null, () => rpc('accept_card_coding_suggestions', [[s.id]]), 'anon'), /permission denied/, 'anon accepting');
    // Reading is scoped too.
    const seen = await as(otherUser, () => q('select id from card_coding_suggestions where id=$1', [s.id]));
    assert.equal(seen.length, 0);
    const outsiderSees = await as(outsider, () => q('select id from card_coding_suggestions where id=$1', [s.id]));
    assert.equal(outsiderSees.length, 0, 'a member without finance access does not read suggestions');
    assert.equal((await live(t)).review_status, 'open');
  });

  await test('an accepted suggestion does not become confirmed history until its batch is approved', async () => {
    // History (card-categorize) counts an 'ai' row only once its batch is
    // approved or posted. Acceptance writes coding_source='ai' -- never
    // 'manual' -- so accepting cannot promote the model's answer to precedent.
    const accepted = await q("select t.coding_source from card_transactions t join card_coding_suggestions g on g.transaction_id=t.id where g.review_status='accepted'");
    assert.ok(accepted.length >= 1 && accepted.every((r) => r.coding_source === 'ai'));
  });

  if (mutation) { console.error(`MUTATION ${mutation} survived: the suite passed against the bug it guards`); process.exit(1); }
  console.log(`PASS card coding suggestions: ${passed} checks -- durable suggestions apart from coding, refusal of unread facts, dismissal and duplicate handling, re-checked acceptance through apply_card_coding, tenant and permission isolation`);
} catch (error) {
  if (mutation) { console.log(`mutation ${mutation} killed: ${error.message.split('\n')[0]}`); process.exit(0); }
  console.error(error);
  process.exit(1);
}
