// Reclassifying a transaction in a posted period, executed against the real
// finance migrations, the SILO ledger and 20261013180000_card_transaction_reclass.sql.
//
// What is proven:
//   1. Staging writes a DRAFT two-line adjustment (target on the transaction's
//      side, source on the other) plus the reclass record; nothing is approved.
//   2. Only a posted period, a coded single-account settled row, a finance user
//      in the active company, an active target and an open date are accepted.
//   3. The real approve_journal_adjustment approves an untouched reclass and
//      refuses one whose lines, connection or date were edited, or whose period
//      is no longer posted.
//   4. A second reclass moves from the first's target; the first cannot be
//      unposted while the second is active; one open reclass per transaction.
//   5. A reclassified period cannot be reopened for recoding; discarding the
//      draft discards the reclass and frees it.
//   6. Clients cannot write the record; reads are company-scoped; the SILO
//      ledger records nothing for a reclass (Books counts the posted journal).
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_RECLASS_MUTATION=no-line-check|no-posted-check|no-open-check|no-reopen-guard|no-void-order|no-lock-check|source-mutable|from-row-location
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'no-line-check': ['    if not v_ok then\n      raise exception', '    if false then\n      raise exception'],
  'no-posted-check': ["  if b.status <> 'posted' then\n    raise exception 'Only a transaction", "  if false then\n    raise exception 'Only a transaction"],
  'no-open-check': ["              where r.transaction_id = t.id and a.status in ('draft', 'approved')) then", "              where false) then"],
  'no-reopen-guard': ["  if old.status in ('approved', 'posted') and new.status in ('draft', 'categorized') and exists (", '  if false and exists ('],
  'no-void-order': ["  if old.status = 'posted' and new.status <> 'posted' and r.id is not null and exists (", '  if false and exists ('],
  'no-lock-check': ["  if v_lock is not null and v_date <= v_lock then", '  if false then'],
  'from-row-location': ["  v_loc := t.qbo_location_id; v_loc_name := t.qbo_location_name;\n  if v_loc is null then", "  v_loc := t.qbo_location_id; v_loc_name := t.qbo_location_name;\n  if false then"],
  'source-mutable': ["    if old.accounting_source = 'card_reclass' or new.accounting_source = 'card_reclass' then\n      raise exception", "    if false then\n      raise exception"],
};
const mutation = process.env.CARD_RECLASS_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown reclass mutation');

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
async function refuses(fn, pattern) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error.message, pattern);
}

const co = randomUUID(), other = randomUUID(), finance = randomUUID(), member = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID(), card = randomUUID(), bank = randomUUID(), hqCard = randomUUID();
let rowNo = 0;
async function newBatch(source, { status = 'draft', company = co, connection = conn, entryDate = '2026-08-31' } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
           values($1,$2,$3,'B',$5,'2026-08-01','2026-08-31','draft','csv',$4)`, [id, company, source, connection, entryDate]);
  if (status !== 'draft') await q('update card_import_batches set status=$2 where id=$1', [id, status]);
  return id;
}
async function newTxn(batch, amount, { company = co, account = 'meals', date = '2026-08-12', status = 'coded' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,$5,'DELTA AIR','DELTA AIR','Delta','Travel',$6,'USD',$7,$8,$8,$9)`,
    [id, company, batch, ++rowNo, date, amount, status, status === 'coded' ? account : null, status === 'coded' ? 'manual' : null]);
  return id;
}
// A period posted to QuickBooks: coded while draft, then posted (as the edge function does).
// Through the REAL approval (snapshot + freeze note), as production does.
const approveBatch = (b) => as(finance, () => q('select approve_card_import_batch($1)', [b]));
async function postedTxn(amount, opts = {}) {
  const b = await newBatch(opts.source || card, opts);
  const t = await newTxn(b, amount, opts);
  await approveBatch(b);
  await q("update card_import_batches set status='posted' where id=$1", [b]);
  return { b, t };
}
const fromOf = (user, t) => as(user, () => one('select card_transaction_reclass_from($1) f', [t])).then((x) => x.f);
const stage = (user, t, { to = 'travel', loc = null, etype = null, eid = null, date = null, reason = 'Booked to meals by mistake' } = {}) =>
  as(user, () => one('select stage_card_transaction_reclass($1,$2,$3,$4,$5,$6,$7) r', [t, to, loc, etype, eid, date, reason])).then((x) => x.r);
const adjLines = (adj) => q(`select line_no, qbo_account_id, posting_type, amount::text, qbo_location_id, entity_type, entity_qbo_id
                             from journal_adjustment_lines where adjustment_id=$1 order by line_no`, [adj]);
const approve = (user, adj) => as(user, () => one('select approve_journal_adjustment($1) r', [adj]));
const markPosted = (adj) => q("update journal_adjustments set status='posted' where id=$1", [adj]);   // the edge function, service role

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) {
    if (name.startsWith('20261005120000')) {
      await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                     create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-04' $$;`);
    }
    await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  }
  let sql = await readFile(new URL('supabase/migrations/20261013180000_card_transaction_reclass.sql', root), 'utf8');
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
  for (const [c, cn, id, type, active] of [[co, conn, 'meals', 'Expense', true], [co, conn, 'travel', 'Expense', true], [co, conn, 'supplies', 'Expense', true],
    [co, conn, 'ar', 'Accounts Receivable', true], [co, conn, 'old', 'Expense', false], [co, conn, 'cc', 'Credit Card', true], [co, conn, 'bank', 'Bank', true],
    [other, otherConn, 'meals', 'Expense', true], [other, otherConn, 'travel', 'Expense', true], [other, otherConn, 'cc', 'Credit Card', true]]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,$5)', [c, cn, id, type, active]);
  }
  await q(`insert into quickbooks_locations(company_entity_id,connection_id,qbo_location_id,name,fully_qualified_name,is_active)
           values($1,$2,'hq','HQ','HQ',true),($1,$2,'west','West','West',true)`, [co, conn]);
  await q(`insert into quickbooks_customers(company_entity_id,connection_id,qbo_customer_id,display_name,is_active) values($1,$2,'c1','Acme',true)`, [co, conn]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,'card','Company card','card','cc','cc',true)`, [card, co, conn]);
  // A card whose source carries a DEFAULT location: rows without one post there.
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,default_qbo_location_id)
           values($1,$2,$3,'hqcard','HQ card','card','cc','cc',true,'hq')`, [hqCard, co, conn]);
  await q('update card_sources set posting_enabled=true where company_entity_id=$1', [co]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,'card','Other card','card','cc','cc',true)`, [randomUUID(), other, otherConn]);

  const verifyBlock = async () => {
    const full = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const block = full.slice(full.indexOf('-- Posted-period reclass (20261013180000)'), full.indexOf('-- End posted transaction reclass checks.'));
    const parts = block.split(/;\s*\n/).filter((x) => x.replace(/--.*$/gm, '').trim());
    assert.equal(parts.length, 1);
    return q(parts[0]);
  };
  // Before the migration the drift check must REPORT it missing, not error out.
  assert.match((await verifyBlock())[0].status, /^MISSING/);

  await db.exec(sql);
  await db.exec(sql); // idempotent

  await test('staging writes a draft two-line adjustment and the reclass record; nothing is approved', async () => {
    const { b, t } = await postedTxn(84.5);
    const r = await stage(finance, t);
    const adj = await one('select * from journal_adjustments where id=$1', [r.adjustment_id]);
    assert.equal(adj.status, 'draft');
    assert.equal(adj.accounting_source, 'card_reclass');
    assert.equal(adj.accounting_source_ref, 'card-reclass:' + r.reclass_id);
    assert.equal(adj.qbo_connection_id, conn);
    assert.equal(adj.entry_date.toISOString().slice(0, 10), '2026-08-31', 'defaults to the original entry date');
    assert.deepEqual(await adjLines(r.adjustment_id), [
      { line_no: 1, qbo_account_id: 'travel', posting_type: 'Debit', amount: '84.50', qbo_location_id: null, entity_type: null, entity_qbo_id: null },
      { line_no: 2, qbo_account_id: 'meals', posting_type: 'Credit', amount: '84.50', qbo_location_id: null, entity_type: null, entity_qbo_id: null }]);
    const rec = await one('select * from card_transaction_reclasses where id=$1', [r.reclass_id]);
    assert.equal(rec.batch_id, b); assert.equal(rec.from_qbo_account_id, 'meals'); assert.equal(rec.to_qbo_account_id, 'travel');
    assert.equal((await one('select qbo_account_id from card_transactions where id=$1', [t])).qbo_account_id, 'meals', 'the posted row is untouched');
  });

  await test('a refund is moved the opposite way round', async () => {
    const { t } = await postedTxn(-20);
    const r = await stage(finance, t);
    assert.deepEqual((await adjLines(r.adjustment_id)).map((l) => [l.qbo_account_id, l.posting_type]), [['travel', 'Credit'], ['meals', 'Debit']]);
  });

  await test('only a posted period is reclassified this way', async () => {
    for (const status of ['draft', 'categorized', 'approved']) {
      const b = await newBatch(card);
      const t = await newTxn(b, 10);
      if (status !== 'draft') await q('update card_import_batches set status=$2 where id=$1', [b, status]);
      await refuses(() => stage(finance, t), /Only a transaction in a period posted to QuickBooks/);
    }
  });

  await test('uncoded, excluded, split and zero rows are refused', async () => {
    const b = await newBatch(card);
    const unc = await newTxn(b, 10, { status: 'uncoded' });
    const zero = await newTxn(b, 0);
    const split = await newTxn(b, 100);
    const excluded = await newTxn(b, 10);
    await q("update card_transactions set status='excluded', exclude_reason='personal' where id=$1", [excluded]);
    await db.exec('begin');
    await q("update card_transactions set qbo_account_id=null, qbo_account_name=null where id=$1", [split]);
    await q(`insert into card_transaction_splits(company_entity_id,transaction_id,line_no,amount,qbo_account_id,qbo_account_name)
             values($1,$2,1,60,'meals','meals'),($1,$2,2,40,'travel','travel')`, [co, split]);
    await db.exec('commit');
    await q("update card_import_batches set status='posted' where id=$1", [b]);
    await refuses(() => stage(finance, unc), /Only a categorized transaction/);
    await refuses(() => stage(finance, excluded), /Only a categorized transaction/);
    await refuses(() => stage(finance, split), /split transaction/);
    await refuses(() => stage(finance, zero), /zero-amount/);
  });

  await test('a non-finance user, another company and a missing reason are refused', async () => {
    const { t } = await postedTxn(12);
    await refuses(() => stage(member, t), /Finance access required/);
    await refuses(() => stage(otherFinance, t), /Transaction not found/);
    await refuses(() => stage(finance, t, { reason: '  ' }), /Give a reason/);
    await refuses(() => as(null, () => q('select stage_card_transaction_reclass($1,$2,null,null,null,null,$3)', [t, 'travel', 'xyz']), 'anon'), /permission denied/);
  });

  await test('the target must be active in the period\'s chart, with a customer on a receivable, and must change something', async () => {
    const { t } = await postedTxn(30);
    await refuses(() => stage(finance, t, { to: 'old' }), /active account/);
    await refuses(() => stage(finance, t, { to: 'nope' }), /active account/);
    await refuses(() => stage(finance, t, { to: 'ar' }), /receivable account needs a customer/);
    await refuses(() => stage(finance, t, { to: 'travel', loc: 'nowhere' }), /active location/);
    await refuses(() => stage(finance, t, { to: 'meals' }), /Nothing to reclassify/);
    const r = await stage(finance, t, { to: 'ar', etype: 'Customer', eid: 'c1', loc: 'hq' });
    assert.deepEqual((await adjLines(r.adjustment_id))[0],
      { line_no: 1, qbo_account_id: 'ar', posting_type: 'Debit', amount: '30.00', qbo_location_id: 'hq', entity_type: 'Customer', entity_qbo_id: 'c1' });
  });

  await test('dates: never before the original entry, never into a locked period, default after the lock', async () => {
    const { t } = await postedTxn(15);
    await refuses(() => stage(finance, t, { date: '2026-08-12' }), /on or after the original entry/);
    await q(`insert into accounting_period_locks(company_entity_id,locked_through,reason) values($1,'2026-09-30','September closed')`, [co]);
    try {
      await refuses(() => stage(finance, t, { date: '2026-09-15' }), /locked through/);
      const r = await stage(finance, t);
      assert.equal(r.entry_date, '2026-10-01', 'the first open day');
      await q('update journal_adjustments set entry_date=$2 where id=$1', [r.adjustment_id, '2026-09-20']);
      await refuses(() => approve(finance, r.adjustment_id), /locked through/);
    } finally { await q('delete from accounting_period_locks where company_entity_id=$1', [co]); }
  });

  await test('the real approval accepts an untouched reclass', async () => {
    const { t } = await postedTxn(40);
    const r = await stage(finance, t);
    const out = await approve(finance, r.adjustment_id);
    assert.ok(out.r.approval_hash);
    const adj = await one('select status, approval_snapshot from journal_adjustments where id=$1', [r.adjustment_id]);
    assert.equal(adj.status, 'approved');
    assert.equal(adj.approval_snapshot.source, 'card_reclass');
    assert.deepEqual(adj.approval_snapshot.payload.Line.map((l) => [l.JournalEntryLineDetail.AccountRef.value, l.JournalEntryLineDetail.PostingType, String(l.Amount)]),
      [['travel', 'Debit', '40'], ['meals', 'Credit', '40']]);
  });

  await test('approval refuses a reclass whose lines, connection or period changed after staging', async () => {
    const edits = [
      ["update journal_adjustment_lines set qbo_account_id='supplies' where adjustment_id=$1 and line_no=1", /lines were edited/],
      ["update journal_adjustment_lines set amount=amount+1 where adjustment_id=$1", /lines were edited/],
      ["update journal_adjustment_lines set qbo_location_id='hq' where adjustment_id=$1 and line_no=2", /lines were edited/],
      ["delete from journal_adjustment_lines where adjustment_id=$1 and line_no=2", /needs at least two lines|lines were edited/],
    ];
    for (const [edit, pattern] of edits) {
      const { t } = await postedTxn(25);
      const r = await stage(finance, t);
      await as(finance, () => q(edit, [r.adjustment_id]));   // drafts are editable through RLS
      await refuses(() => approve(finance, r.adjustment_id), pattern);
    }
    const { b, t } = await postedTxn(25);
    const r = await stage(finance, t);
    await q("update card_import_batches set status='approved' where id=$1", [b]);   // marked unposted
    await refuses(() => approve(finance, r.adjustment_id), /no longer posted/);
  });

  await test('a reclass adjustment cannot be turned into an ordinary one, nor one into a reclass', async () => {
    const { t } = await postedTxn(18);
    const r = await stage(finance, t);
    await refuses(() => as(finance, () => q("update journal_adjustments set accounting_source='manual_adjustment' where id=$1", [r.adjustment_id])), /keeps its source/);
    await refuses(() => as(finance, () => q("update journal_adjustments set accounting_source_ref='card-reclass:x' where id=$1", [r.adjustment_id])), /keeps its source/);
    const plain = (await as(finance, () => one(`insert into journal_adjustments(company_entity_id,entry_date,memo,qbo_connection_id) values($1,'2026-09-01','x',$2) returning id`, [co, conn]))).id;
    await refuses(() => as(finance, () => q("update journal_adjustments set accounting_source='card_reclass' where id=$1", [plain])), /keeps its source/);
  });

  await test('one open reclass per transaction; a posted one is the next one\'s starting point', async () => {
    const { t } = await postedTxn(60);
    const first = await stage(finance, t);
    await refuses(() => stage(finance, t, { to: 'supplies' }), /already has a reclassification awaiting/);
    await approve(finance, first.adjustment_id);
    await refuses(() => stage(finance, t, { to: 'supplies' }), /already has a reclassification awaiting/);
    await markPosted(first.adjustment_id);
    const second = await stage(finance, t, { to: 'supplies' });
    assert.deepEqual((await adjLines(second.adjustment_id)).map((l) => [l.qbo_account_id, l.posting_type]), [['supplies', 'Debit'], ['travel', 'Credit']],
      'moves from the posted reclass target, not the original category');
    await refuses(() => stage(finance, t, { to: 'meals' }), /already has a reclassification awaiting/);

    // The first cannot be unposted while the second is active.
    await refuses(() => q("update journal_adjustments set status='approved' where id=$1", [first.adjustment_id]), /later reclassification/);
    // Discarding the second (a draft) discards its record and frees the first.
    await as(finance, () => q('delete from journal_adjustments where id=$1', [second.adjustment_id]));
    assert.equal((await one('select count(*)::int n from card_transaction_reclasses where adjustment_id=$1', [second.adjustment_id])).n, 0);
    await q("update journal_adjustments set status='approved' where id=$1", [first.adjustment_id]);
  });

  await test('a reclassified period cannot be reopened for recoding until its reclasses are gone', async () => {
    const { b, t } = await postedTxn(70);
    const r = await stage(finance, t);
    await q("update card_import_batches set status='approved' where id=$1", [b]);   // void_card_posting's transition is allowed
    await refuses(() => as(finance, () => q('select reopen_card_import_batch($1,$2)', [b, 'recode'])), /has transaction reclassifications/);
    await as(finance, () => q('delete from journal_adjustments where id=$1', [r.adjustment_id]));
    await as(finance, () => q('select reopen_card_import_batch($1,$2)', [b, 'recode']));
    assert.equal((await one('select status from card_import_batches where id=$1', [b])).status, 'categorized');
  });

  await test('bank rows: settled purchases and refunds only, never with an open bank change', async () => {
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
             values($1,$2,$3,'bank','Operating','bank','bank','bank',true)`, [bank, co, conn]);
    const plaidConn = randomUUID(), plaidAcct = randomUUID();
    await q(`insert into plaid_connections(id,company_entity_id,item_id,environment,institution_name) values($1,$2,'item','sandbox','Bank')`, [plaidConn, co]);
    await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id) values($1,$2,$3,'acct','Checking','depository',$4)`, [plaidAcct, co, plaidConn, bank]);
    const b = await newBatch(bank);
    const mk = async (treatment) => {
      const t = await newTxn(b, 33);
      await q(`update card_transactions set origin='plaid', plaid_account_id=$2, external_transaction_id=$1::text, provider_status='posted',
               provider_updated_at=now(), accounting_treatment=$3, qbo_location_id='hq', qbo_location_name='HQ' where id=$1`, [t, plaidAcct, treatment]);
      return t;
    };
    const purchase = await mk('purchase'), transfer = await mk('transfer'), changed = await mk('purchase');
    await q("update card_import_batches set status='posted' where id=$1", [b]);
    await q(`insert into plaid_sync_exceptions(company_entity_id,account_id,transaction_id,external_transaction_id,previous_payload,provider_payload)
             values($1,$2,$3,$4,'{}','{}')`, [co, plaidAcct, changed, String(changed)]);
    await refuses(() => stage(finance, transfer), /Only a purchase or refund/);
    await refuses(() => stage(finance, changed), /open bank change/);
    assert.ok((await stage(finance, purchase)).adjustment_id);
  });

  await test('a row with no location reverses the source DEFAULT it posted on, frozen at approval, not today\'s default', async () => {
    const { b, t } = await postedTxn(100, { source: hqCard });
    await q("update card_sources set default_qbo_location_id='west' where id=$1", [hqCard]);   // changed after posting
    const from = await fromOf(finance, t);
    assert.equal(from.location_id, 'hq', 'Meals/HQ is where the original posting put it');
    assert.equal(from.location_name, 'HQ');
    const r = await stage(finance, t, { loc: 'hq' });
    assert.deepEqual((await adjLines(r.adjustment_id)).map((l) => [l.qbo_account_id, l.posting_type, l.qbo_location_id]),
      [['travel', 'Debit', 'hq'], ['meals', 'Credit', 'hq']], 'the source leg credits Meals/HQ, not Meals/no location');
    await approve(finance, r.adjustment_id);
    await q("update card_sources set default_qbo_location_id='hq' where id=$1", [hqCard]);
    void b;
  });

  await test('a zero-net period has no settlement line: the default comes from the note taken at approval', async () => {
    const b = await newBatch(hqCard);
    const t = await newTxn(b, 50);
    await newTxn(b, -50);
    await approveBatch(b);
    await q("update card_import_batches set status='posted' where id=$1", [b]);
    await q("update card_sources set default_qbo_location_id='west' where id=$1", [hqCard]);
    try {
      assert.equal((await fromOf(finance, t)).location_id, 'hq');
    } finally { await q("update card_sources set default_qbo_location_id='hq' where id=$1", [hqCard]); }
  });

  await test('a period posted before snapshots: a row with no location is refused, one with its own location is not', async () => {
    const b = await newBatch(hqCard);
    const unknown = await newTxn(b, 12);
    const known = await newTxn(b, 13);
    await q("update card_transactions set qbo_location_id='west', qbo_location_name='West' where id=$1", [known]);
    await q("update card_import_batches set status='posted' where id=$1", [b]);   // legacy: no approval snapshot
    await refuses(() => stage(finance, unknown), /location it posted with is unknown/);
    await refuses(() => fromOf(finance, unknown), /location it posted with is unknown/);
    assert.equal((await fromOf(finance, known)).location_id, 'west');
    assert.ok((await stage(finance, known)).adjustment_id);
  });

  await test('the resolver is finance-only and not callable by anon', async () => {
    const { t } = await postedTxn(11);
    await refuses(() => fromOf(member, t), /Finance access required/);
    await refuses(() => fromOf(otherFinance, t), /Transaction not found/);
    await refuses(() => as(null, () => q('select card_transaction_reclass_from($1)', [t]), 'anon'), /permission denied/);
  });

  await test('recovery without posting: posted -> deleted in QBO and unposted -> reopened -> discarded, then free again', async () => {
    const { b, t } = await postedTxn(90);
    const r = await stage(finance, t);
    await approve(finance, r.adjustment_id);
    await markPosted(r.adjustment_id);
    await q("update journal_adjustments set status='approved', posting_id=null where id=$1", [r.adjustment_id]);   // void_journal_adjustment's transition
    await refuses(() => stage(finance, t, { to: 'supplies' }), /awaiting review or posting/);
    await as(finance, () => q('select reopen_journal_adjustment($1,$2)', [r.adjustment_id, 'Deleted in QuickBooks']));
    assert.equal((await one('select status from journal_adjustments where id=$1', [r.adjustment_id])).status, 'draft');
    await as(finance, () => q('delete from journal_adjustments where id=$1', [r.adjustment_id]));
    assert.equal((await one('select count(*)::int n from card_transaction_reclasses where adjustment_id=$1', [r.adjustment_id])).n, 0);
    assert.equal((await fromOf(finance, t)).account_id, 'meals', 'the amount is back on its posted category');
    assert.equal(await one("select count(*)::int n from quickbooks_journal_postings where source='card_reclass'").then((x) => x.n), 0,
      'no posting request was made during recovery');
    await q("update card_import_batches set status='approved' where id=$1", [b]);
    await as(finance, () => q('select reopen_card_import_batch($1,$2)', [b, 'recode']));
  });

  await test('clients cannot write the reclass record; reads are company-scoped through the view', async () => {
    const { t } = await postedTxn(9);
    const r = await stage(finance, t);
    await refuses(() => as(finance, () => q('update card_transaction_reclasses set to_qbo_account_id=$2 where id=$1', [r.reclass_id, 'meals'])), /permission denied/);
    await refuses(() => as(finance, () => q('delete from card_transaction_reclasses where id=$1', [r.reclass_id])), /permission denied/);
    await refuses(() => as(finance, () => q(`insert into card_transaction_reclasses(company_entity_id,transaction_id,batch_id,adjustment_id,qbo_connection_id,amount,original_posting_type,from_qbo_account_id,to_qbo_account_id,reason)
      select company_entity_id,transaction_id,batch_id,adjustment_id,qbo_connection_id,amount,original_posting_type,from_qbo_account_id,to_qbo_account_id,reason from card_transaction_reclasses where id=$1`, [r.reclass_id])), /permission denied/);
    const mine = await as(finance, () => q('select adjustment_status, to_qbo_account_name from card_transaction_reclasses_v where id=$1', [r.reclass_id]));
    assert.deepEqual(mine, [{ adjustment_status: 'draft', to_qbo_account_name: 'travel' }]);
    assert.equal((await as(otherFinance, () => q('select id from card_transaction_reclasses_v where id=$1', [r.reclass_id]))).length, 0);
    assert.equal((await as(otherFinance, () => q('select id from card_transaction_reclasses where id=$1', [r.reclass_id]))).length, 0);
  });

  await test('a reclass writes nothing to the SILO ledger (Books counts the posted journal instead)', async () => {
    const { t } = await postedTxn(44);
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    const r = await stage(finance, t);
    await approve(finance, r.adjustment_id);
    await markPosted(r.adjustment_id);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('re-running the migration over existing reclasses changes nothing', async () => {
    const n = (await one('select count(*)::int n from card_transaction_reclasses')).n;
    await db.exec(sql);
    assert.equal((await one('select count(*)::int n from card_transaction_reclasses')).n, n);
  });

  await test('the schema verifier check reports MISSING before the migration and passes after it', async () => {
    for (const row of await verifyBlock()) assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  });

  console.log(`PASS card reclass: ${passed} checks -- posted-period only, staged draft reviewed before posting, lines locked to the record, one open reclass, ordered voids, no reopen underneath, client-read-only, not double-counted in the ledger`);
} catch (error) {
  console.error(`FAIL after ${passed} checks${mutation ? ` (mutation ${mutation})` : ''}:`, error.message);
  process.exitCode = 1;
}
