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
//   SILO_LEDGER_MUTATION=no-validation|posted-not-frozen|no-books-start-sync|lock-unshared|connection-not-stored|approved-not-frozen
//   SILO_LEDGER_MUTATION=held-reverses|no-chart-resync|no-source-resync|snapshot-ignored
//   SILO_LEDGER_MUTATION=no-active-correction-resync|no-connection-resync|zero-net-uses-today
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
  // Record whatever was coded, valid or not.
  'no-validation': [
    ['  if public.silo_ledger_blocker(p_txn) is not null then return null; end if;\n', ''],
    ['  if t.id is not null and public.silo_ledger_blocker(p_txn) is not null then return; end if;\n', '']],
  // Treat a blocked row as "posts nothing": a temporary problem reverses a good entry.
  'held-reverses': ['  if t.id is not null and public.silo_ledger_blocker(p_txn) is not null then return; end if;\n', ''],
  // Nothing re-records a held row when an account becomes active again.
  'no-chart-resync': ["  -- Any update to a row that is active afterwards, not only inactive -> active:\n  -- correcting an active account's type (AP -> Expense) clears a blocker too.\n  for v_co in select distinct n.company_entity_id from new_rows n where n.is_active loop", "  for v_co in select distinct n.company_entity_id from new_rows n where false loop"],
  // Wake held rows only on inactive -> active, as before cycle 1: an active account corrected from AP to Expense stays held.
  'no-active-correction-resync': ["  -- Any update to a row that is active afterwards, not only inactive -> active:\n  -- correcting an active account's type (AP -> Expense) clears a blocker too.\n  for v_co in select distinct n.company_entity_id from new_rows n where n.is_active loop", "  for v_co in select distinct n.company_entity_id from new_rows n join old_rows o on o.id = n.id\n              where n.is_active and not coalesce(o.is_active, false) loop"],
  // A reactivated QuickBooks connection does not wake the rows it held.
  'no-connection-resync': ["'quickbooks_vendors', 'quickbooks_connections']", "'quickbooks_vendors']"],
  // Rebuild a zero-net frozen batch from today's source instead of holding it.
  'zero-net-uses-today': [
    ["    if v_settle is null then return null; end if;\n", ""],
    ["    then return 'This approved import netted to zero, so its approval did not record the balancing account'; end if;", "    then return null; end if;"]],
  // Switching a source back on does not re-record what it held.
  'no-source-resync': [
    ['      new.is_active, new.qbo_connection_id)', '      new.qbo_connection_id)'],
    ['      old.is_active, old.qbo_connection_id)', '      old.qbo_connection_id)']],
  // Record an approved batch from today's source instead of its frozen snapshot.
  'snapshot-ignored': ["  if b.status in ('approved', 'posted') and b.approval_snapshot is not null then\n    v_conn", '  if false then\n    v_conn'],
  // Let a source remap rewrite QuickBooks-posted history.
  // Both guards: the writer's freeze and the remap's posted-batch filter overlap.
  'posted-not-frozen': [
    ["    select 1 from public.card_import_batches pb where pb.id = t.batch_id and pb.status in ('approved', 'posted')) then", "    select 1 where false) then"],
    ["              where b.source_id = new.id and b.status not in ('approved', 'posted') loop", "              where b.source_id = new.id loop"]],
  // Forget to record what was coded before the books started.
  'no-books-start-sync': ["  if tg_table_name = 'accounting_opening_balances' then", "  if true then return null; end if;\n  if tg_table_name = 'accounting_opening_balances' then"],
  // Store the source/batch binding instead of the resolved connection.
  'connection-not-stored': ['                   public.silo_ledger_connection(t.batch_id),', '                   null,'],
  // Freeze only posted batches, as before cycle 2.
  'approved-not-frozen': [
    ["pb.status in ('approved', 'posted')) then", "pb.status = 'posted') then"],
    ["b.status not in ('approved', 'posted') loop", "b.status <> 'posted' loop"]],
  // Record without the company lock.
  'lock-unshared': ["  perform pg_advisory_xact_lock_shared(hashtextextended('silo_ledger:company:' || v_company::text, 0));", ''],
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
    const spec = MUTATIONS[mutation];
    for (const [from, to] of Array.isArray(spec[0]) ? spec : [spec]) {
      assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
      sql = sql.replace(from, to);
    }
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
      provider_status=$2, provider_updated_at=now(), accounting_treatment='purchase' where id=$1`, [id, status, plaidAcct]);
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

  await test('invalid coding is never recorded: a card payment coded to an expense, or an inactive account, waits in On Deck', async () => {
    const plaidAcct = (await one('select id from plaid_accounts where source_id=$1', [bank])).id;
    const b = await newBatch(bank);
    const pay = await newTxn(b, -200, { date: '2026-09-10' });
    await q(`update card_transactions set origin='plaid', plaid_account_id=$2, external_transaction_id=$1::text,
      provider_status='posted', provider_updated_at=now(), accounting_treatment='card_payment' where id=$1`, [pay, plaidAcct]);
    await code(pay, 'supplies');
    assert.equal((await entries(pay)).length, 0, 'a card payment coded to an expense is not recorded');
    let status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]));
    assert.equal(status.length, 1); assert.equal(status[0].unrecorded, 1); assert.match(status[0].reason, /direction and treatment/);
    await code(pay, 'cc');
    assert.equal((await entries(pay)).length, 1, 'recorded once coded to the card account it pays');
    assert.equal((await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]))).length, 0);
    assert.equal((await as(member, () => q('select * from silo_ledger_batch_status()'))).length, 0, 'finance only');

    await q("update quickbooks_accounts set is_active=false where company_entity_id=$1 and qbo_account_id='meals'", [co]);
    const cb = await newBatch(card);
    const stale = await newTxn(cb, 30, { date: '2026-09-12' });
    await code(stale, 'meals');
    assert.equal((await entries(stale)).length, 0, 'an inactive account is not recorded');
    status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [cb]));
    assert.match(status[0].reason, /not an active account/);
    await q("update quickbooks_accounts set is_active=true where company_entity_id=$1 and qbo_account_id='meals'", [co]);
    const es = await entries(stale);
    assert.equal(es.length, 1, 'reactivating the account recorded the held row with no edit');
    assert.deepEqual((await lines(es[0].id)).map((l) => l.qbo_account_id), ['meals', 'cc']);
    assert.equal((await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [cb]))).length, 0);
  });

  await test('a temporary problem holds a recorded transaction instead of reversing it, and clearing it catches up', async () => {
    const b = await newBatch(card);
    const t = await newTxn(b, 33, { status: 'coded', account: 'supplies', date: '2026-09-14' });
    assert.equal((await entries(t)).length, 1);
    await q('update card_sources set is_active=false where id=$1', [card]);
    await q("update card_transactions set description='TOUCHED BY SYNC' where id=$1", [t]);
    assert.deepEqual((await entries(t)).map((e) => e.kind), ['original'], 'switching the source off reverses nothing');
    await code(t, 'meals');
    assert.deepEqual((await entries(t)).map((e) => e.kind), ['original'], 'a change while held waits');
    let status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]));
    assert.match(status[0]?.reason || '', /switched off/, 'and On Deck says why');
    await q('update card_sources set is_active=true where id=$1', [card]);
    const es = await entries(t);
    assert.deepEqual(es.map((e) => e.kind), ['original', 'reversal', 'original'], 'switching it back on records the change');
    assert.deepEqual((await lines(es[2].id)).map((l) => l.qbo_account_id), ['meals', 'cc']);
  });

  await test('a source remap never rewrites QuickBooks-posted history; unposting brings it up to date', async () => {
    await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,'cc2','cc2','Credit Card',true)", [co, conn]);
    const postedTxns = (await q("select id from card_transactions where batch_id=$1 and status='coded'", [batch])).map((r) => r.id);
    assert.ok(postedTxns.length > 0);
    const countFor = async (ids) => (await one('select count(*)::int n from ledger_entries where source_id = any($1::uuid[])', [ids])).n;
    const before = await countFor(postedTxns);
    const open = await newBatch(card);
    const live = await newTxn(open, 12, { status: 'coded', account: 'supplies', date: '2026-09-15' });
    await q("update card_sources set credit_qbo_account_id='cc2', credit_qbo_account_name='cc2' where id=$1", [card]);
    assert.equal(await countFor(postedTxns), before, 'posted history is frozen');
    const latest = async (id) => (await q(`select l.qbo_account_id from ledger_lines l join ledger_entries e on e.id=l.entry_id
      where e.source_id=$1 and e.kind='original' order by e.recorded_at desc, l.line_no`, [id])).map((r) => r.qbo_account_id);
    assert.ok((await latest(live)).includes('cc2'), 'unposted history follows the remap');
    const v = await as(finance, () => q(`select bool_and(in_quickbooks) ok from silo_ledger_lines_v v join card_transactions t on t.id=v.source_id where t.batch_id=$1`, [batch]));
    assert.equal(v[0].ok, true, 'what QuickBooks holds is still what SILO says it holds');
    // Marking the post unposted keeps the approval snapshot: still frozen.
    await q("update card_import_batches set status='approved' where id=$1", [batch]);
    assert.equal(await countFor(postedTxns), before, 'posted -> approved keeps the snapshot, so stays frozen');
    // Reopening discards the approval: the freeze lifts and the remap applies.
    await q("update card_import_batches set status='categorized' where id=$1", [batch]);
    assert.ok(await countFor(postedTxns) > before, 'reopening resynced the batch');
    assert.ok((await latest(postedTxns[0])).includes('cc2'));
    await q("update card_sources set credit_qbo_account_id='cc', credit_qbo_account_name='cc' where id=$1", [card]);
  });

  await test('an approved snapshot freezes SILO too: approve, remap the source, post -- SILO says what QuickBooks got', async () => {
    const b = await newBatch(card);
    const t = await newTxn(b, 18, { status: 'coded', account: 'supplies', date: '2026-09-18' });
    const linesOf = async () => (await q(`select l.qbo_account_id from ledger_lines l join ledger_entries e on e.id=l.entry_id
      where e.source_id=$1 and e.kind='original' order by e.recorded_at desc, l.line_no`, [t])).map((r) => r.qbo_account_id);
    assert.deepEqual(await linesOf(), ['supplies', 'cc']);
    await db.exec('alter table card_import_batches disable trigger user');
    await q("update card_import_batches set status='approved' where id=$1", [b]);
    await db.exec('alter table card_import_batches enable trigger user');
    await q("update card_sources set credit_qbo_account_id='cc2', credit_qbo_account_name='cc2' where id=$1", [card]);
    assert.deepEqual(await linesOf(), ['supplies', 'cc'], 'an approved batch is not rewritten by a remap');
    await db.exec('alter table card_import_batches disable trigger user');
    await q("update card_import_batches set status='posted' where id=$1", [b]);
    await db.exec('alter table card_import_batches enable trigger user');
    const v = await as(finance, () => q('select qbo_account_id, in_quickbooks from silo_ledger_lines_v where source_id=$1', [t]));
    assert.ok(v.every((r) => r.in_quickbooks) && v.some((r) => r.qbo_account_id === 'cc') && !v.some((r) => r.qbo_account_id === 'cc2'),
      'what SILO marks as in QuickBooks is the snapshot QuickBooks received');
    await q("update card_sources set credit_qbo_account_id='cc', credit_qbo_account_name='cc' where id=$1", [card]);
  });

  await test('an approved batch is recorded from its frozen snapshot, not from a source remapped since', async () => {
    await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,'cc3','cc3','Credit Card',true) on conflict do nothing", [co, conn]);
    const b = await newBatch(card);
    const t = await newTxn(b, 21, { date: '2026-09-20' });
    const snapshot = { schema_version: 1, kind: 'card_batch', qbo_connection_id: conn, payload: { TxnDate: '2026-09-30', Line: [
      { DetailType: 'JournalEntryLineDetail', Amount: 21, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'supplies' } } },
      { DetailType: 'JournalEntryLineDetail', Amount: 21, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'cc' } } }] } };
    await db.exec('alter table card_import_batches disable trigger user');
    await q("update card_import_batches set status='approved', approval_snapshot=$2, approval_hash='h' where id=$1", [b, JSON.stringify(snapshot)]);
    await db.exec('alter table card_import_batches enable trigger user');
    await q("update card_sources set credit_qbo_account_id='cc3', credit_qbo_account_name='cc3' where id=$1", [card]);
    // As the backfill meets it: a frozen batch whose rows were never recorded.
    await db.exec('alter table card_transactions disable trigger plaid_transaction_integrity');
    await code(t, 'supplies');
    await db.exec('alter table card_transactions enable trigger plaid_transaction_integrity');
    const es = await entries(t);
    assert.equal(es.length, 1);
    assert.deepEqual((await lines(es[0].id)).map((l) => l.qbo_account_id), ['supplies', 'cc'], 'the account QuickBooks received, not today\'s cc3');
    await q("update card_sources set credit_qbo_account_id='cc', credit_qbo_account_name='cc' where id=$1", [card]);
  });

  await test('a zero-net approved batch is held, never rebuilt against a source remapped since', async () => {
    // +100 / -100: the snapshot has no settlement line, so it does not record the balancing account.
    const b = await newBatch(card);
    const up = await newTxn(b, 100, { date: '2026-09-21' });
    const down = await newTxn(b, -100, { date: '2026-09-21' });
    const snapshot = { schema_version: 1, kind: 'card_batch', qbo_connection_id: conn, payload: { TxnDate: '2026-09-30', Line: [
      { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'supplies' } } },
      { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'supplies' } } }] } };
    await db.exec('alter table card_import_batches disable trigger user');
    await q("update card_import_batches set status='approved', approval_snapshot=$2, approval_hash='h' where id=$1", [b, JSON.stringify(snapshot)]);
    await db.exec('alter table card_import_batches enable trigger user');
    await q("update card_sources set credit_qbo_account_id='cc3', credit_qbo_account_name='cc3' where id=$1", [card]);
    await db.exec('alter table card_transactions disable trigger plaid_transaction_integrity');
    // One statement: a frozen batch's coding is complete, so its effective lines match the snapshot's.
    await q("update card_transactions set status='coded', qbo_account_id='supplies', qbo_account_name='supplies', coding_source='manual' where id = any($1::uuid[])", [[up, down]]);
    await db.exec('alter table card_transactions enable trigger plaid_transaction_integrity');
    assert.equal((await entries(up)).length + (await entries(down)).length, 0, 'nothing is recorded against today\'s cc3');
    const status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]));
    assert.equal(status.length, 1); assert.equal(status[0].unrecorded, 2); assert.match(status[0].reason, /netted to zero/);
    await q("update card_sources set credit_qbo_account_id='cc', credit_qbo_account_name='cc' where id=$1", [card]);
  });

  await test('reactivating a QuickBooks connection records the rows it held', async () => {
    const b = await newBatch(card);
    await q('update quickbooks_connections set is_active=false where id=$1', [conn]);
    const t = await newTxn(b, 14, { status: 'coded', account: 'supplies', date: '2026-09-22' });
    assert.equal((await entries(t)).length, 0, 'no active connection: held');
    const status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]));
    assert.match(status[0]?.reason || '', /active QuickBooks connection/);
    await q('update quickbooks_connections set is_active=true where id=$1', [conn]);
    assert.equal((await entries(t)).length, 1, 'reactivating the connection recorded it with no edit');
  });

  await test('correcting an ACTIVE account from payable to expense records the row it held', async () => {
    await q("insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,'apx','apx','Accounts Payable',true)", [co, conn]);
    const b = await newBatch(card);
    const t = await newTxn(b, 16, { status: 'coded', account: 'apx', date: '2026-09-23' });
    assert.equal((await entries(t)).length, 0, 'a payable line with no vendor is held');
    const status = await as(finance, () => q('select * from silo_ledger_batch_status() where batch_id=$1', [b]));
    assert.match(status[0]?.reason || '', /customer or vendor/);
    await q("update quickbooks_accounts set account_type='Expense' where company_entity_id=$1 and qbo_account_id='apx'", [co]);
    assert.equal((await entries(t)).length, 1, 'still active, but no longer a payable: recorded');
  });

  await test('with no connection on the source or batch, the company\'s one connection is stored on the entry, so Books can read it', async () => {
    const loose = randomUUID();
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
             values($1,$2,null,'loose','Loose card','card','cc','cc',true)`, [loose, co]);
    const b = await newBatch(loose, co, null);
    const t = await newTxn(b, 9, { status: 'coded', account: 'supplies', date: '2026-09-19' });
    const e = await entries(t);
    assert.equal(e.length, 1); assert.equal(e[0].qbo_connection_id, conn);
    const v = await as(finance, () => q('select count(*)::int n from silo_ledger_lines_v where source_id=$1 and qbo_connection_id=$2', [t, conn]));
    assert.equal(v[0].n, 2);
  });

  await test('accepting opening balances later records everything already categorized', async () => {
    const c3 = randomUUID(), c3conn = randomUUID(), c3card = randomUUID();
    await q("insert into entities(id,title) values($1,'C')", [c3]);
    await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r3','x')", [c3conn, c3]);
    for (const [id, type] of [['supplies', 'Expense'], ['cc', 'Credit Card']]) {
      await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,true)', [c3, c3conn, id, type]);
    }
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
             values($1,$2,$3,'card','C card','card','cc','cc',true)`, [c3card, c3, c3conn]);
    const run = (await one(`insert into quickbooks_report_runs(company_entity_id,connection_id,report_name,status) values($1,$2,'TrialBalance','ok') returning id`, [c3, c3conn])).id;
    await q(`insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
             values($1,$2,'USD',1,'2026-08-01','Accrual')`, [c3, c3conn]);
    const ob = (await one(`insert into accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash,status) values($1,$2,'{}'::jsonb,'h','draft') returning id`, [c3, run])).id;
    const b = await newBatch(c3card, c3, c3conn);
    const t = await newTxn(b, 40, { status: 'coded', account: 'supplies', date: '2026-09-03', company: c3 });
    assert.equal((await entries(t)).length, 0, 'no books yet, nothing recorded');
    assert.match((await one('select silo_ledger_blocker($1) r', [t])).r, /opening balances are accepted/, 'and it says why');
    await q("update accounting_opening_balances set status='accepted', accepted_at=now() where id=$1", [ob]);
    assert.equal((await entries(t)).length, 1, 'acceptance recorded it');
  });

  await test('recording holds the company ledger lock shared; moving the period lock takes it exclusive', async () => {
    const t = await newTxn(await newBatch(card), 5, { status: 'coded', account: 'supplies', date: '2026-09-20' });
    const advisory = "select mode, classid, objid from pg_locks where locktype='advisory' and pid=pg_backend_pid()";
    await db.exec('begin');
    await q('select silo_ledger_sync_card_transaction($1)', [t]);
    const shared = (await q(advisory)).filter((r) => r.mode === 'ShareLock');
    await db.exec('rollback');
    assert.equal(shared.length, 1, 'one shared company lock while recording');
    await db.exec('begin');
    await as(finance, () => q("select set_accounting_period_lock('2026-09-02','early September closed')"));
    const exclusive = (await q(advisory)).filter((r) => r.mode === 'ExclusiveLock');
    await db.exec('rollback');
    assert.ok(exclusive.some((r) => r.classid === shared[0].classid && r.objid === shared[0].objid), 'the period lock takes the same key exclusively');
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
