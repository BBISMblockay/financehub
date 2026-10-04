// SILO daily ledger, executed against the real finance migrations plus
// 20261005120000_silo_daily_ledger.sql.
//
// What is proven:
//   1. A coded, settled transaction is in the ledger at once -- no batch
//      approval -- as a balanced entry built from the same lines approval uses
//      (splits included).
//   2. Pending, uncoded, excluded, pre-opening and pre-feed-start transactions
//      record nothing.
//   3. Changes are reversal + new entry, never edits; unchanged saves write
//      nothing; a removal or exclusion reverses; a deleted row reverses.
//   4. A locked period is never written into: corrections land on the first
//      open day.
//   5. The ledger is append-only and every entry balances; clients cannot
//      write it, read it across companies, or read it without finance access.
//   6. The backfill is idempotent.
//
// Mutation hooks -- each must make this suite FAIL:
//   SILO_LEDGER_MUTATION=no-start-check
//   SILO_LEDGER_MUTATION=edit-in-place
//   SILO_LEDGER_MUTATION=ignore-lock
//   SILO_LEDGER_MUTATION=read-ungated
//   SILO_LEDGER_MUTATION=cosmetic-rerecord
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'no-start-check': ['  if v_start is null or t.txn_date is null or t.txn_date < v_start then return null; end if;', '  if t.txn_date is null then return null; end if;'],
  // Skip the reversal: a change would then leave the old entry standing beside the new one.
  'edit-in-place': ['  if v_active.id is not null then\n    v_date := greatest(v_active.entry_date', '  if false then\n    v_date := greatest(v_active.entry_date'],
  'ignore-lock': ['    v_date := greatest(t.txn_date, coalesce(v_lock + 1, t.txn_date));', '    v_date := t.txn_date;'],
  // Fingerprint the labels too: a card rename then re-records every transaction.
  'cosmetic-rerecord': ["(select jsonb_agg(x.value - 'description' order by x.ordinality)", "(select jsonb_agg(x.value order by x.ordinality)"],
  'read-ungated': ["create policy ledger_lines_read on public.ledger_lines for select to authenticated\n  using (company_entity_id = public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()));",
    "create policy ledger_lines_read on public.ledger_lines for select to authenticated\n  using (true);"],
};
const mutation = process.env.SILO_LEDGER_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown ledger mutation');

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql', '20260912203725_bank_feed_workspace_history.sql', '20260912231606_accounting_foundation.sql',
  '20260913022606_qbo_historical_ledger.sql', '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

const co = randomUUID(), other = randomUUID(), finance = randomUUID(), member = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID(), card = randomUUID(), bank = randomUUID(), otherCard = randomUUID();
let rowNo = 0;
async function newBatch(source, company = co, connection = conn) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
           values($1,$2,$3,'B','2026-08-31','2026-08-01','2026-08-31','draft','csv',$4)`, [id, company, source, connection]);
  return id;
}
async function newTxn(batch, amount, { date = '2026-08-12', company = co, account = null, status = 'uncoded' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,$5,'OFFICE DEPOT','OFFICE DEPOT','Office Depot','Supplies',$6,'USD',$7,$8,$8,$9)`,
    [id, company, batch, ++rowNo, date, amount, status, account, status === 'coded' ? 'manual' : null]);
  return id;
}
const code = (id, account = 'supplies') => q("update card_transactions set status='coded', qbo_account_id=$2, qbo_account_name=$2, coding_source='manual' where id=$1", [id, account]);
const entries = (txn) => q('select * from ledger_entries where source_id=$1 order by recorded_at, kind desc', [txn]);
const lines = (entry) => q('select posting_type, amount::text, qbo_account_id from ledger_lines where entry_id=$1 order by line_no', [entry]);
const balance = async (account, company = co) => (await one(`select coalesce(sum(case when posting_type='Debit' then amount else -amount end),0)::text v
  from ledger_lines where company_entity_id=$1 and qbo_account_id=$2`, [company, account])).v;

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-04' $$;`);
  let sql = await readFile(new URL('supabase/migrations/20261005120000_silo_daily_ledger.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
    sql = sql.replace(from, to);
  }

  await q("insert into entities(id,title) values($1,'A'),($2,'B')", [co, other]);
  await q('insert into auth.users(id) values($1),($2),($3)', [finance, member, otherFinance]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values ($1,'F','user','finance',$4),($2,'M','user','marketing',$4),($3,'O','user','finance',$5)`,
    [finance, member, otherFinance, co, other]);
  await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')", [co, finance, member, other, otherFinance]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','x'),($3,$4,'r2','x')", [conn, co, otherConn, other]);
  for (const [c, cn, id, type] of [[co, conn, 'supplies', 'Expense'], [co, conn, 'meals', 'Expense'], [co, conn, 'cc', 'Credit Card'], [co, conn, 'bank', 'Bank'],
    [other, otherConn, 'supplies', 'Expense'], [other, otherConn, 'cc', 'Credit Card']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,true)', [c, cn, id, type]);
  }
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,'card','Company card','card','cc','cc',true),($4,$5,$6,'card','Other card','card','cc','cc',true)`, [card, co, conn, otherCard, other, otherConn]);
  // Books start 2026-08-01 for both companies.
  for (const [c, cn] of [[co, conn], [other, otherConn]]) {
    const run = (await one(`insert into quickbooks_report_runs(company_entity_id,connection_id,report_name,status) values($1,$2,'TrialBalance','ok') returning id`, [c, cn])).id;
    await q(`insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
             values($1,$2,'USD',1,'2026-08-01','Accrual')`, [c, cn]);
    await q(`insert into accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash,status) values($1,$2,'{}'::jsonb,'h','accepted')`, [c, run]);
  }

  // Transactions that exist BEFORE the migration: the backfill records them.
  const batch = await newBatch(card);
  const preCoded = await newTxn(batch, 25, { status: 'coded', account: 'supplies' });
  await db.exec(sql);
  await db.exec(sql); // idempotent

  await test('the backfill recorded an already-categorized transaction, once, and re-running changes nothing', async () => {
    const es = await entries(preCoded);
    assert.equal(es.length, 1); assert.equal(es[0].kind, 'original'); assert.equal(es[0].entry_date.toISOString().slice(0, 10), '2026-08-12');
    assert.deepEqual(await lines(es[0].id), [{ posting_type: 'Debit', amount: '25.00', qbo_account_id: 'supplies' }, { posting_type: 'Credit', amount: '25.00', qbo_account_id: 'cc' }]);
  });

  await test('categorizing a transaction records it immediately, with no batch approval', async () => {
    const t = await newTxn(batch, 42.10);
    assert.equal((await entries(t)).length, 0, 'uncoded records nothing');
    await code(t);
    assert.equal((await one('select status from card_import_batches where id=$1', [batch])).status, 'draft', 'the batch was never approved');
    assert.equal((await entries(t)).length, 1);
    assert.equal(await balance('cc'), '-67.10');
  });

  await test('saving an unchanged transaction writes nothing', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    await q("update card_transactions set memo = memo where id=$1", [preCoded]);
    await code(preCoded);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('renaming a merchant writes nothing: labels are not accounting facts', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    await q("update card_transactions set description = 'RENAMED MERCHANT', clean_merchant = 'Renamed' where id=$1", [preCoded]);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('recategorizing is a reversal plus a new entry, never an edit', async () => {
    await code(preCoded, 'meals');
    const es = await entries(preCoded);
    assert.deepEqual(es.map((e) => e.kind), ['original', 'reversal', 'original']);
    assert.equal(es[1].reverses_entry_id, es[0].id);
    assert.equal(await balance('supplies'), '42.10', 'only the other transaction remains on supplies');
    assert.equal(await balance('meals'), '25.00');
  });

  await test('excluding or uncoding a recorded transaction reverses it', async () => {
    await q("update card_transactions set status='excluded', exclude_reason='personal' where id=$1", [preCoded]);
    assert.equal(await balance('meals'), '0.00');
    assert.equal((await entries(preCoded)).at(-1).kind, 'reversal');
  });

  await test('a split records one line per split, balanced against the card', async () => {
    const t = await newTxn(batch, 100, { status: 'coded', account: 'supplies' });
    await db.exec('begin');
    await q("update card_transactions set qbo_account_id=null, qbo_account_name=null where id=$1", [t]);
    await q(`insert into card_transaction_splits(company_entity_id,transaction_id,line_no,amount,qbo_account_id,qbo_account_name)
             values($1,$2,1,60,'supplies','supplies'),($1,$2,2,40,'meals','meals')`, [co, t]);
    await db.exec('commit');
    const active = (await entries(t)).filter((e) => e.kind === 'original').at(-1);
    assert.deepEqual(await lines(active.id), [
      { posting_type: 'Debit', amount: '60.00', qbo_account_id: 'supplies' }, { posting_type: 'Debit', amount: '40.00', qbo_account_id: 'meals' },
      { posting_type: 'Credit', amount: '100.00', qbo_account_id: 'cc' }]);
  });

  await test('a refund records the opposite way round', async () => {
    const t = await newTxn(batch, -15, { status: 'coded', account: 'supplies' });
    const e = (await entries(t))[0];
    assert.deepEqual(await lines(e.id), [{ posting_type: 'Credit', amount: '15.00', qbo_account_id: 'supplies' }, { posting_type: 'Debit', amount: '15.00', qbo_account_id: 'cc' }]);
  });

  await test('nothing dated on or before the opening balances is recorded', async () => {
    const t = await newTxn(batch, 9, { status: 'coded', account: 'supplies', date: '2026-07-31' });
    assert.equal((await entries(t)).length, 0);
  });

  await test('a bank feed records only settled transactions, and only from its authoritative start', async () => {
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
             values($1,$2,$3,'bank','Operating','bank','bank','bank',true)`, [bank, co, conn]);
    await q("update card_sources set authoritative_from='2026-08-20' where id=$1", [bank]);
    const plaidConn = randomUUID(), plaidAcct = randomUUID();
    await q(`insert into plaid_connections(id,company_entity_id,item_id,environment,institution_name) values($1,$2,'item','sandbox','Bank')`, [plaidConn, co]);
    await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id) values($1,$2,$3,'acct','Checking','depository',$4)`, [plaidAcct, co, plaidConn, bank]);
    const asPlaid = (id, status) => q(`update card_transactions set origin='plaid', plaid_account_id=$3, external_transaction_id=$1::text,
      provider_status=$2, provider_updated_at=now() where id=$1`, [id, status, plaidAcct]);
    const b = await newBatch(bank);
    // The bank-feed guard keeps a pending row excluded; it is coded once it settles.
    const pending = await newTxn(b, 50, { date: '2026-08-25' });
    await q("update card_transactions set status='excluded', exclude_reason='pending' where id=$1", [pending]);
    await asPlaid(pending, 'pending');
    assert.equal((await entries(pending)).length, 0, 'pending records nothing');
    await q("update card_transactions set provider_status='posted', provider_updated_at=now(), status='uncoded', exclude_reason=null where id=$1", [pending]);
    assert.equal((await entries(pending)).length, 0, 'settled but not yet categorized records nothing');
    await code(pending);
    assert.equal((await entries(pending)).length, 1, 'recorded the moment it is categorized');
    const early = await newTxn(b, 5, { date: '2026-08-10' });
    await asPlaid(early, 'posted');
    await code(early);
    assert.equal((await entries(early)).length, 0, 'before the feed owns the account, nothing is recorded');
    await q("update card_transactions set provider_status='removed', status='excluded', exclude_reason='removed by bank', provider_updated_at=now() where id=$1", [pending]);
    assert.equal((await entries(pending)).at(-1).kind, 'reversal', 'a removal by the bank reverses');
  });

  await test('a locked period is never written into: corrections land on the first open day', async () => {
    const t = await newTxn(batch, 30, { status: 'coded', account: 'supplies', date: '2026-08-20' });
    await as(finance, () => q("select set_accounting_period_lock('2026-08-31','August closed')"));
    await code(t, 'meals');
    const es = await entries(t);
    assert.deepEqual(es.map((e) => [e.kind, e.entry_date.toISOString().slice(0, 10)]),
      [['original', '2026-08-20'], ['reversal', '2026-09-01'], ['original', '2026-09-01']]);
    const late = await newTxn(batch, 11, { status: 'coded', account: 'supplies', date: '2026-08-28' });
    assert.equal((await entries(late))[0].entry_date.toISOString().slice(0, 10), '2026-09-01', 'a late arrival for a closed month is dated the first open day');
    await assert.rejects(() => as(finance, () => q("select set_accounting_period_lock('2026-08-15','back')")), /already locked/);
    await assert.rejects(() => as(member, () => q("select set_accounting_period_lock('2026-09-30','x x')")), /Finance access required/);
    passed++; console.log(`ok ${passed} - refused: moving the lock back, and a non-finance lock`);
  });

  await test('deleting a recorded transaction reverses it', async () => {
    const b = await newBatch(card);
    const t = await newTxn(b, 7, { status: 'coded', account: 'supplies', date: '2026-09-10' });
    await q('delete from card_transactions where id=$1', [t]);
    assert.deepEqual((await entries(t)).map((e) => e.kind), ['original', 'reversal']);
  });

  await test('every entry balances and the ledger is append-only, even for the owner', async () => {
    const bad = await one(`select count(*)::int n from (select entry_id from ledger_lines group by entry_id
      having sum(case when posting_type='Debit' then amount else -amount end) <> 0) x`);
    assert.equal(bad.n, 0);
    await assert.rejects(() => q('update ledger_lines set amount = amount + 1'), /append-only/);
    await assert.rejects(() => q('delete from ledger_entries'), /append-only/);
    await assert.rejects(async () => {
      await db.exec('begin');
      try {
        const e = (await one(`insert into ledger_entries(company_entity_id,entry_date,source,source_id,kind,fingerprint) values($1,'2026-09-02','card_transaction',$2,'original','x') returning id`, [co, randomUUID()])).id;
        await q(`insert into ledger_lines(entry_id,company_entity_id,line_no,qbo_account_id,posting_type,amount) values($1,$2,1,'supplies','Debit',5),($1,$2,2,'cc','Credit',4)`, [e, co]);
        await db.exec('commit');
      } catch (err) { await db.exec('rollback'); throw err; }
    }, /does not balance/);
    passed++; console.log(`ok ${passed} - refused: an unbalanced entry, even written directly`);
  });

  await test('clients cannot write the ledger, other companies cannot read it, non-finance members cannot read it', async () => {
    await assert.rejects(() => as(finance, () => q(`insert into ledger_entries(company_entity_id,entry_date,source,source_id,kind,fingerprint) values($1,'2026-09-02','card_transaction',$2,'original','x')`, [co, randomUUID()])), /permission denied/);
    await assert.rejects(() => as(finance, () => q('select silo_ledger_sync_card_transaction($1)', [preCoded])), /permission denied/);
    assert.ok((await as(finance, () => q('select id from ledger_lines'))).length > 0, 'finance reads its own ledger');
    assert.equal((await as(member, () => q('select id from ledger_lines'))).length, 0, 'a non-finance member reads nothing');
    assert.equal((await as(otherFinance, () => q('select id from ledger_lines'))).length, 0, 'another company reads nothing of ours');
    assert.equal((await as(null, () => q("select has_function_privilege('anon','public.set_accounting_period_lock(date,text)','execute') a"), 'postgres'))[0]?.a ?? false, false);
  });

  await test('the view says which lines QuickBooks already has', async () => {
    const rows = await as(finance, () => q('select in_quickbooks from silo_ledger_lines_v'));
    assert.ok(rows.length > 0); assert.ok(rows.every((r) => r.in_quickbooks === false), 'nothing has been posted to QuickBooks yet');
    // A month posted before the ledger existed: its backfilled entries are in QuickBooks.
    await db.exec('alter table card_import_batches disable trigger user');
    await q("update card_import_batches set status='posted' where id=$1", [batch]);
    await db.exec('alter table card_import_batches enable trigger user');
    const posted = await as(finance, () => q(`select v.in_quickbooks from silo_ledger_lines_v v join card_transactions t on t.id=v.source_id where t.batch_id=$1`, [batch]));
    assert.ok(posted.length > 0 && posted.every((r) => r.in_quickbooks === true));
  });

  await test('re-running the migration over a populated ledger writes nothing', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    await db.exec(sql);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('the schema verifier checks for this migration pass against it', async () => {
    const full = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const block = full.slice(full.indexOf('-- SILO daily ledger (20261005120000)'), full.indexOf('-- End SILO ledger checks.'));
    const parts = block.split(/;\s*\n/).filter((x) => x.replace(/--.*$/gm, '').trim());
    assert.equal(parts.length, 3);
    for (const part of parts) for (const row of await q(part)) assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  });

  console.log(`PASS silo ledger: ${passed} checks -- daily per-transaction recording, settled-only, never before the books start, reversal not edit, period lock, append-only and balanced, finance-only and company-isolated, idempotent backfill`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
