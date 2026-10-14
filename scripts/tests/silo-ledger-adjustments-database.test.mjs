// Journal adjustments mirrored into the SILO ledger (20261014040000), executed
// against the real finance, ledger and reclass migrations.
//
// What is proven:
//   1. A POSTED adjustment is one balanced ledger entry with exactly its lines,
//      on its QuickBooks date and connection; draft and approved record nothing.
//   2. Unposting (void) writes a reversal on the same date; posting again writes
//      a new entry; an unchanged re-sync writes nothing.
//   3. The mirror follows QuickBooks even inside a SILO-locked period.
//   4. Nothing before the books start, and nothing without accepted opening
//      balances; accepting them later records what was already posted.
//   5. A reclass is tied to its transaction in silo_ledger_lines_v.
//   6. The backfill is idempotent; the ledger stays append-only and balanced.
//
// Mutation hooks -- each must make this suite FAIL:
//   LEDGER_ADJ_MUTATION=lock-shifted|no-start-check|no-void-reversal|record-unposted|no-books-start
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  // Date the mirror by the SILO period lock instead of QuickBooks' date.
  'lock-shifted': ["    values (v_company, a.entry_date, 'journal_adjustment', p_adjustment, 'original', v_fp, v_conn,",
    "    values (v_company, greatest(a.entry_date, coalesce(public.silo_ledger_locked_through(v_company) + 1, a.entry_date)), 'journal_adjustment', p_adjustment, 'original', v_fp, v_conn,"],
  'no-start-check': ["and v_start is not null and a.entry_date >= v_start then", "then"],
  'no-void-reversal': ["  if v_active.id is not null and v_fp is not distinct from v_active.fingerprint then return; end if;",
    "  if v_active.id is not null then return; end if;"],
  'record-unposted': ["if a.id is not null and a.status = 'posted' and", "if a.id is not null and"],
  'no-books-start': ["  for each row when (new.status = 'accepted') execute function", "  for each row when (false) execute function"],
};
const mutation = process.env.LEDGER_ADJ_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown mutation');

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
  '20261005120000_silo_daily_ledger.sql', '20261007180000_card_import_entity_kind_on_approve.sql',
  '20261013180000_card_transaction_reclass.sql', '20261014020000_card_reclass_all_bank_treatments.sql',
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

const co = randomUUID(), late = randomUUID(), finance = randomUUID(), lateFinance = randomUUID();
const conn = randomUUID(), lateConn = randomUUID(), card = randomUUID();

// A draft adjustment with balanced lines, approved through the real RPC.
async function adjustment({ company = co, user = finance, connection = conn, date = '2026-08-31', amount = 100, source = null, ref = null } = {}) {
  const id = randomUUID();
  await q(`insert into journal_adjustments(id,company_entity_id,entry_date,memo,status,qbo_connection_id,accounting_source,accounting_source_ref)
           values($1,$2,$3,'Prepaid amortization','draft',$4,$5,$6)`, [id, company, date, connection, source, ref]);
  await q(`insert into journal_adjustment_lines(company_entity_id,adjustment_id,line_no,qbo_account_id,posting_type,amount,description)
           values($1,$2,1,'rent','Debit',$3,'Rent'),($1,$2,2,'prepaid','Credit',$3,'Prepaid rent')`, [company, id, amount]);
  await as(user, () => q('select approve_journal_adjustment($1)', [id]));
  return id;
}
// What quickbooks-post-journal does after QuickBooks accepts the entry.
async function post(id) {
  const a = await one('select company_entity_id, qbo_connection_id, accounting_source, accounting_source_ref, approval_hash from journal_adjustments where id=$1', [id]);
  const p = (await one(`insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,payload,payload_hash,status,qbo_journal_entry_id)
    values($1,$2,$3,$4,'{}'::jsonb,$5,'posted','QB-' || floor(random()*100000)::text) returning id`,
    [a.company_entity_id, a.qbo_connection_id, a.accounting_source, a.accounting_source_ref, a.approval_hash])).id;
  await q("update journal_adjustments set status='posted', posting_id=$2 where id=$1", [id, p]);
  return p;
}
// void_journal_adjustment's effect on the adjustment row.
const unpost = async (id) => {
  await q("update quickbooks_journal_postings set status='voided' where id=(select posting_id from journal_adjustments where id=$1)", [id]);
  await q("update journal_adjustments set status='approved', posting_id=null where id=$1", [id]);
};
const entries = (id) => q("select * from ledger_entries where source='journal_adjustment' and source_id=$1 order by recorded_at, kind desc", [id]);
const lines = (entry) => q('select qbo_account_id, posting_type, amount::text from ledger_lines where entry_id=$1 order by line_no', [entry]);
const day = (d) => d.toISOString().slice(0, 10);

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) {
    if (name.startsWith('20261005120000')) {
      await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                     create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-04' $$;`);
    }
    await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  }
  let sql = await readFile(new URL('supabase/migrations/20261014040000_silo_ledger_mirror_journal_adjustments.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale`);
    sql = sql.replace(from, to);
  }

  await q("insert into entities(id,title) values($1,'A'),($2,'Late')", [co, late]);
  await q('insert into auth.users(id) values($1),($2)', [finance, lateFinance]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values ($1,'F','user','finance',$3),($2,'L','user','finance',$4)`, [finance, lateFinance, co, late]);
  await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($3,$4,'member')", [co, finance, late, lateFinance]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','x'),($3,$4,'r2','x')", [conn, co, lateConn, late]);
  for (const [c, cn] of [[co, conn], [late, lateConn]]) {
    for (const [id, type] of [['rent', 'Expense'], ['prepaid', 'Other Current Asset'], ['meals', 'Expense'], ['travel', 'Expense'], ['cc', 'Credit Card']]) {
      await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,true)', [c, cn, id, type]);
    }
    await q(`insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
             values($1,$2,'USD',1,'2026-08-01','Accrual')`, [c, cn]);
  }
  // Company A's books have started; the late company's have not (opening balances still draft).
  for (const [c, cn, status] of [[co, conn, 'accepted'], [late, lateConn, 'draft']]) {
    const run = (await one(`insert into quickbooks_report_runs(company_entity_id,connection_id,report_name,status) values($1,$2,'TrialBalance','ok') returning id`, [c, cn])).id;
    await q(`insert into accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash,status) values($1,$2,'{}'::jsonb,'h',$3)`, [c, run, status]);
  }
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,posting_enabled)
           values($1,$2,$3,'card','Company card','card','cc','cc',true,true)`, [card, co, conn]);

  // Already posted before the migration: the backfill records it.
  const prior = await adjustment();
  await post(prior);
  assert.equal((await one("select count(*)::int n from pg_proc where proname='silo_ledger_sync_adjustment'")).n, 0);
  await db.exec(sql);
  await db.exec(sql); // idempotent

  await test('the backfill recorded an already-posted adjustment once, with exactly its lines, and re-running changes nothing', async () => {
    const es = await entries(prior);
    assert.equal(es.length, 1);
    assert.equal(es[0].kind, 'original');
    assert.equal(day(es[0].entry_date), '2026-08-31');
    assert.equal(es[0].qbo_connection_id, conn);
    assert.deepEqual(await lines(es[0].id), [{ qbo_account_id: 'rent', posting_type: 'Debit', amount: '100.00' }, { qbo_account_id: 'prepaid', posting_type: 'Credit', amount: '100.00' }]);
  });

  await test('draft and approved adjustments are not in the books anywhere, so the ledger records nothing', async () => {
    const id = await adjustment();
    assert.equal((await entries(id)).length, 0, 'approved, not posted');
  });

  await test('posting records it; unposting reverses it on the same date; posting again records it anew', async () => {
    const id = await adjustment({ date: '2026-09-15', amount: 42.5 });
    await post(id);
    let es = await entries(id);
    assert.deepEqual(es.map((e) => e.kind), ['original']);
    assert.equal(day(es[0].entry_date), '2026-09-15');
    await unpost(id);
    es = await entries(id);
    assert.deepEqual(es.map((e) => e.kind), ['original', 'reversal']);
    assert.equal(es[1].reverses_entry_id, es[0].id);
    assert.equal(day(es[1].entry_date), '2026-09-15', 'QuickBooks no longer has it on that day, so the mirror nets to zero on that day');
    assert.deepEqual(await lines(es[1].id), [{ qbo_account_id: 'rent', posting_type: 'Credit', amount: '42.50' }, { qbo_account_id: 'prepaid', posting_type: 'Debit', amount: '42.50' }]);
    await post(id);
    assert.deepEqual((await entries(id)).map((e) => e.kind), ['original', 'reversal', 'original']);
  });

  await test('an unchanged save writes nothing; a memo edit is a label, not an accounting fact', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    await q("update journal_adjustments set status=status where id=$1", [prior]);
    await q("update journal_adjustments set memo='Renamed' where id=$1", [prior]);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('the mirror follows the QuickBooks date even inside a SILO-locked period', async () => {
    await q(`insert into accounting_period_locks(company_entity_id,locked_through,reason) values($1,'2026-09-30','September closed')`, [co]);
    try {
      const id = await adjustment({ date: '2026-09-20' });
      await post(id);
      assert.equal(day((await entries(id))[0].entry_date), '2026-09-20');
    } finally { await q('delete from accounting_period_locks where company_entity_id=$1', [co]); }
  });

  await test('nothing dated before the books start is recorded: it is inside the opening balances', async () => {
    const id = await adjustment({ date: '2026-07-31' });
    await post(id);
    assert.equal((await entries(id)).length, 0);
  });

  await test('a company without accepted opening balances records nothing, then catches up when it accepts them', async () => {
    const id = await adjustment({ company: late, user: lateFinance, connection: lateConn, date: '2026-08-20', amount: 7 });
    await post(id);
    assert.equal((await entries(id)).length, 0, 'no books yet');
    await q("update accounting_opening_balances set status='accepted' where company_entity_id=$1", [late]);
    assert.equal((await entries(id)).length, 1, 'recorded on acceptance');
  });

  await test('a reclass is mirrored and tied to its transaction', async () => {
    const b = randomUUID(), t = randomUUID();
    await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
             values($1,$2,$3,'Aug','2026-08-31','2026-08-01','2026-08-31','draft','csv',$4)`, [b, co, card, conn]);
    await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
             values($1,$2,$3,1,'2026-08-12','DELTA','DELTA','Delta','Travel',84.5,'USD','coded','meals','meals','manual')`, [t, co, b]);
    await as(finance, () => q('select approve_card_import_batch($1)', [b]));
    await q("update card_import_batches set status='posted' where id=$1", [b]);
    const r = (await as(finance, () => one("select stage_card_transaction_reclass($1,'travel',null,null,null,null,'Flight, not a meal') r", [t]))).r;
    await as(finance, () => q('select approve_journal_adjustment($1)', [r.adjustment_id]));
    const postingId = await post(r.adjustment_id);
    const rows = await as(finance, () => q(`select qbo_account_id, posting_type, transaction_id, adjustment_id, posting_id, in_quickbooks, source
      from silo_ledger_lines_v where adjustment_id=$1 order by line_no`, [r.adjustment_id]));
    assert.deepEqual(rows.map((x) => [x.qbo_account_id, x.posting_type, x.transaction_id, x.posting_id, x.in_quickbooks, x.source]),
      [['travel', 'Debit', t, postingId, true, 'journal_adjustment'], ['meals', 'Credit', t, postingId, true, 'journal_adjustment']]);
    // In a SILO-only reading, the transaction's lines now net to Travel, not Meals.
    const net = await as(finance, () => q(`select qbo_account_id, sum(signed_amount)::text s from silo_ledger_lines_v
      where transaction_id=$1 and qbo_account_id in ('meals','travel') group by 1 order by 1`, [t]));
    assert.deepEqual(net, [{ qbo_account_id: 'meals', s: '0.00' }, { qbo_account_id: 'travel', s: '84.50' }]);
  });

  await test('the ledger stays append-only and every entry balances', async () => {
    await assert.rejects(q('update ledger_entries set memo=memo'), /append-only/);
    const bad = await one(`select count(*)::int n from (select entry_id from ledger_lines group by entry_id
      having sum(case when posting_type='Debit' then amount else -amount end) <> 0) x`);
    assert.equal(bad.n, 0);
  });

  await test('re-running the migration over a populated ledger writes nothing', async () => {
    const n = (await one('select count(*)::int n from ledger_entries')).n;
    await db.exec(sql);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, n);
  });

  await test('the schema verifier check for the mirror passes', async () => {
    const full = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const block = full.slice(full.indexOf('-- SILO ledger mirrors journal adjustments (20261014040000)'), full.indexOf('-- End SILO ledger adjustment mirror checks.'));
    const parts = block.split(/;\s*\n/).filter((x) => x.replace(/--.*$/gm, '').trim());
    assert.equal(parts.length, 1);
    for (const row of await q(parts[0])) assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  });

  console.log(`PASS ledger adjustment mirror: ${passed} checks -- posted only, QuickBooks' date, reversal on unpost, books-start rule, reclass tied to its transaction, idempotent backfill`);
} catch (error) {
  console.error(`FAIL after ${passed} checks${mutation ? ` (mutation ${mutation})` : ''}:`, error.message);
  process.exitCode = 1;
}
