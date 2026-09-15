// Splitting one transaction across several accounts, executed against the real
// migrations as authenticated users. The loan payment that motivated it:
// $25,187.68 leaving the bank, part principal against the loan liability and
// part interest expense, with the interest changing every month.
//
// What is proven here, in order of how much it would cost to get wrong:
//   1. A split's lines must total the transaction to the cent -- in the RPC,
//      and as a stored invariant a service-role write cannot dodge.
//   2. The posted journal entry carries one line per split line and stays
//      balanced: the settlement side is computed from the batch total, so a
//      split that did not tie would move money the statement never moved.
//   3. A split line passes the same QBO account/location/entity checks an
//      ordinary coded line does, because both read one view.
//   4. A learned rule remembers the ACCOUNTS and never the amounts.
//   5. Company isolation, a closed batch, and who may write.
//
//   CARD_SPLIT_MUTATION=sum-unchecked   (the RPC's total check removed)
//   CARD_SPLIT_MUTATION=single-line     (the posting aggregate ignores splits)
//   CARD_SPLIT_MUTATION=guard-skips-splits    (the feed guard back on the parent account join)
//
// The other bank-feed interaction -- a provider amount correction clearing the
// split instead of wedging the account's sync -- needs plaid_apply_sync, so it
// lives in plaid-bank-feed-database.test.mjs where that harness is.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const mutation = process.env.CARD_SPLIT_MUTATION || '';
assert.ok(['', 'sum-unchecked', 'single-line', 'guard-skips-splits'].includes(mutation), 'Unknown card split mutation');
const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID(), other = randomUUID(), finance = randomUUID(), outsider = randomUUID(), otherUser = randomUUID();
const conn = randomUUID(), source = randomUUID();
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, args) => Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];
const setSplits = (txn, lines, actor = finance, learn = false, match = 'merchant') =>
  as(actor, () => rpc('set_card_transaction_splits', [txn, JSON.stringify(lines), learn, match]));
const refused = async (fn, pattern, what) => { await assert.rejects(fn, pattern, what); passed += 1; console.log(`ok ${passed} - refused: ${what}`); };

// The real payment shape: one draft leaving the bank, principal + interest.
const LOAN = 25187.68, PRINCIPAL = 21000.00, INTEREST = 4187.68;
let batch, loanTxn;
async function newBatch(status = 'draft') {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status)
           values($1,$2,$3,'Bank drafts','2026-09-30',$4)`, [id, co, source, status]);
  return id;
}
async function newTxn(batchId, amount, opts = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,status)
           values($1,$2,$3,$4,'2026-09-15',$5,$6,$7,$8,$9,'uncoded')`,
    [id, co, batchId, opts.row_no ?? 1, opts.description ?? 'BIZ2CREDIT LOAN PMT', opts.merchant ?? 'BIZ2CREDIT',
     opts.clean_merchant ?? 'Biz2Credit', opts.card_name ?? 'Operating', amount]);
  return id;
}

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  const splitSql = await readFile(new URL('supabase/migrations/20260915100000_card_transaction_splits.sql', root), 'utf8');
  await db.exec(splitSql); await db.exec(splitSql);

  await q("insert into entities(id,title) values($1,'Test A'),($2,'Test B')", [co, other]);
  await q('insert into auth.users(id) values($1),($2),($3)', [finance, outsider, otherUser]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)`,
    [finance, outsider, otherUser, co, other]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')`,
    [co, finance, outsider, other, otherUser]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','secret')", [conn, co]);
  for (const [id, name, type] of [['loan', 'Biz2Credit loan', 'Long Term Liability'], ['interest', 'Interest expense', 'Expense'],
    ['bank', 'Operating bank', 'Bank'], ['ap', 'Accounts payable', 'Accounts Payable'], ['fees', 'Bank fees', 'Expense']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$4,$5,true)', [co, conn, id, name, type]);
  }
  await q("insert into quickbooks_locations(company_entity_id,connection_id,qbo_location_id,name,is_active) values($1,$2,'hq','HQ',true)", [co, conn]);
  await q("insert into quickbooks_vendors(company_entity_id,connection_id,qbo_vendor_id,display_name,is_active) values($1,$2,'v1','Biz2Credit',true)", [co, conn]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,credit_qbo_account_id,credit_qbo_account_name,posting_enabled,is_active)
           values($1,$2,$3,'operating-bank','Operating bank','bank','Operating bank',true,true)`, [source, co, conn]);
  if (mutation) {
    const def = (await one("select pg_get_functiondef('public.set_card_transaction_splits(uuid,jsonb,boolean,text)'::regprocedure) d")).d;
    const approve = (await one("select pg_get_functiondef('public.approve_card_import_batch(uuid)'::regprocedure) d")).d;
    if (mutation === 'sum-unchecked') await db.exec(def.replace('if total <> round(txn.amount, 2) then', 'if false then'));
    if (mutation === 'guard-skips-splits') {
      // The shape the cycle-1 review found: both checks back on one join
      // through the parent's own account column, which a split row leaves null.
      const guard = (await one("select pg_get_functiondef('public.plaid_guard_batch()'::regprocedure) d")).d;
      const from = guard.indexOf('    -- Direction: the transaction');
      const to = guard.indexOf('  end if;\n  return new;');
      assert.ok(from > 0 && to > from, 'guard-skips-splits: the two split checks were not found');
      await db.exec(guard.slice(0, from) + `    if exists(select 1 from public.card_transactions t join public.quickbooks_accounts a
      on a.connection_id=new.qbo_connection_id and a.qbo_account_id=t.qbo_account_id and a.company_entity_id=new.company_entity_id
      where t.batch_id=new.id and t.origin='plaid' and t.status='coded' and
        ((t.accounting_treatment='purchase' and t.amount<=0)
        or (t.accounting_treatment in ('refund','deposit') and t.amount>=0)
        or (t.accounting_treatment in ('transfer','payroll_settlement','shopify_settlement') and a.account_type not in ('Other Current Asset','Other Current Liability'))
        or (t.accounting_treatment='card_payment' and (v_source.source_type='card' or a.account_type not in ('Credit Card','Accounts Payable'))))) then
      raise exception 'Review feed direction and clearing-account treatment; the bank feed owns card payments';
    end if;
` + guard.slice(to));
    }
    if (mutation === 'single-line') await db.exec(approve.replace('from public.card_coding_effective_lines e\n  where e.batch_id = p_batch_id',
      "from (select t.id transaction_id, t.batch_id, t.row_no, t.txn_date, t.description, 1 line_no, t.amount, coalesce(t.qbo_account_id,'loan') qbo_account_id, t.qbo_location_id, t.entity_qbo_id, t.entity_type, t.memo, false is_split from public.card_transactions t where t.status='coded') e\n  where e.batch_id = p_batch_id"));
  }

  batch = await newBatch();
  loanTxn = await newTxn(batch, LOAN);

  await test('a loan payment splits into principal and interest, and the lines total the payment', async () => {
    const out = await setSplits(loanTxn, [
      { amount: PRINCIPAL, qbo_account_id: 'loan', memo: 'Principal' },
      { amount: INTEREST, qbo_account_id: 'interest', memo: 'Interest' },
    ]);
    assert.equal(out.lines, 2);
    assert.equal(Number(out.total), LOAN);
    assert.equal(out.status, 'coded');
    const rows = await q('select line_no,amount::text a,qbo_account_id,qbo_account_name,memo from card_transaction_splits where transaction_id=$1 order by line_no', [loanTxn]);
    assert.deepEqual(rows.map((r) => [r.line_no, r.a, r.qbo_account_id]), [[1, '21000.00', 'loan'], [2, '4187.68', 'interest']]);
    assert.equal(rows[0].qbo_account_name, 'Biz2Credit loan', 'The account name is resolved from the chart, never typed');
    const parent = await one('select status,qbo_account_id,coding_source from card_transactions where id=$1', [loanTxn]);
    assert.equal(parent.status, 'coded');
    assert.equal(parent.qbo_account_id, null, 'A split row carries no single account: a reader cannot see one account standing for the whole payment');
    assert.equal(parent.coding_source, 'split');
  });

  await test('the split is what posts: one journal line per split line, and the entry balances', async () => {
    const approved = await as(finance, () => rpc('approve_card_import_batch', [batch]));
    const snap = (await one('select approval_snapshot s from card_import_batches where id=$1', [batch])).s;
    const lines = snap.payload ? snap.payload.Line : snap.lines;
    const detail = lines.map((l) => [l.JournalEntryLineDetail.AccountRef.value, l.JournalEntryLineDetail.PostingType, Number(l.Amount)]);
    assert.deepEqual(detail, [['loan', 'Debit', PRINCIPAL], ['interest', 'Debit', INTEREST], ['bank', 'Credit', LOAN]],
      'Principal and interest debit their own accounts; the bank is credited once for the whole payment');
    const debits = detail.filter((d) => d[1] === 'Debit').reduce((t, d) => t + d[2], 0);
    const credits = detail.filter((d) => d[1] === 'Credit').reduce((t, d) => t + d[2], 0);
    assert.equal(Math.round(debits * 100), Math.round(credits * 100), 'The entry balances');
    assert.ok(approved.approval_hash, 'and it is frozen under an approval hash like any other batch');
    assert.deepEqual(lines.slice(0, 2).map((l) => l.Description.split(' · ').pop()), ['Principal', 'Interest'],
      'Each posted line ends with the memo the person typed, which is what the preview showed them');
    assert.ok(!lines.some((l) => /split \d/.test(l.Description)),
      'and never the generic "split N" placeholder while a memo exists');
  });

  await test('a split cannot be changed once its batch is approved, and reopening restores it', async () => {
    await refused(() => setSplits(loanTxn, [{ amount: 1, qbo_account_id: 'loan' }, { amount: LOAN - 1, qbo_account_id: 'interest' }]),
      /This batch is approved; reopen it before changing how a transaction is split/, 'editing a split on an approved batch');
    const still = await q('select amount::text a from card_transaction_splits where transaction_id=$1 order by line_no', [loanTxn]);
    assert.deepEqual(still.map((r) => r.a), ['21000.00', '4187.68'], 'The approved split is unchanged');
  });

  await test('the lines must total the transaction, in the function and as a stored invariant', async () => {
    const b = await newBatch(); const t = await newTxn(b, LOAN);
    if (mutation === 'sum-unchecked') {
      await setSplits(t, [{ amount: 1.00, qbo_account_id: 'loan' }, { amount: 2.00, qbo_account_id: 'interest' }])
        .then(() => assert.fail('The total check was removed, yet a short split was still refused'), () => {});
    }
    await refused(() => setSplits(t, [{ amount: 21000, qbo_account_id: 'loan' }, { amount: 4000, qbo_account_id: 'interest' }]),
      /Split lines total 25000.00 but the transaction is 25187.68; the difference is 187.68/, 'lines that do not total the payment');
    await refused(() => setSplits(t, [{ amount: 21000, qbo_account_id: 'loan' }, { amount: 4187.69, qbo_account_id: 'interest' }]),
      /difference is -0.01/, 'lines that are a cent over');
    assert.equal(Number((await one('select count(*) n from card_transaction_splits where transaction_id=$1', [t])).n), 0, 'A refused split writes nothing');
    // The same rule below the RPC: a service-role write cannot leave an
    // unbalanced set, because the constraint is deferred to commit.
    await setSplits(t, [{ amount: PRINCIPAL, qbo_account_id: 'loan' }, { amount: INTEREST, qbo_account_id: 'interest' }]);
    await refused(() => q('delete from card_transaction_splits where transaction_id=$1 and line_no=2', [t]),
      /A split needs at least two lines|must account for the whole amount/, 'a service-role delete of one line');
    await refused(() => q('update card_transaction_splits set amount=amount+1 where transaction_id=$1 and line_no=1', [t]),
      /must account for the whole amount/, 'a service-role edit of one amount');
    await refused(() => q("update card_transactions set qbo_account_id='loan' where id=$1", [t]),
      /split across 2 accounts; clear its splits before coding it to one account/, 'giving a split row a single account');
    await refused(() => q('update card_transactions set amount=amount+100 where id=$1', [t]),
      /would leave the split short/, 'moving the parent amount away from its lines');
  });

  await test('a split line passes the same QuickBooks checks an ordinary coded line does', async () => {
    const b = await newBatch(); const t = await newTxn(b, 100);
    await refused(() => setSplits(t, [{ amount: 60, qbo_account_id: 'nope' }, { amount: 40, qbo_account_id: 'interest' }]),
      /names an account that is not active/, 'an unknown account');
    await refused(() => setSplits(t, [{ amount: 60, qbo_account_id: 'loan', qbo_location_id: 'nowhere' }, { amount: 40, qbo_account_id: 'interest' }]),
      /names a location that is not active/, 'an unknown location');
    await refused(() => setSplits(t, [{ amount: 60, qbo_account_id: 'ap' }, { amount: 40, qbo_account_id: 'interest' }]),
      /receivable or payable account needs a customer or vendor/, 'a payable line with no entity');
    await refused(() => setSplits(t, [{ amount: 60, qbo_account_id: 'ap', entity_qbo_id: 'ghost', entity_type: 'Vendor' }, { amount: 40, qbo_account_id: 'interest' }]),
      /names a customer or vendor that is not active/, 'an unknown vendor');
    await refused(() => setSplits(t, [{ amount: 100, qbo_account_id: 'loan' }]), /at least two lines/, 'a one-line split');
    await refused(() => setSplits(t, [{ amount: 100, qbo_account_id: 'loan' }, { amount: 0, qbo_account_id: 'interest' }]), /cannot be zero/, 'a zero line');
    await refused(() => setSplits(t, [{ amount: null, qbo_account_id: 'loan' }, { amount: 100, qbo_account_id: 'interest' }]), /needs an amount/, 'a blank amount');
    // A payable line WITH its vendor is fine, and posts with the entity.
    const ok = await setSplits(t, [{ amount: 60, qbo_account_id: 'ap', entity_qbo_id: 'v1', entity_type: 'Vendor' }, { amount: 40, qbo_account_id: 'interest', qbo_location_id: 'hq' }]);
    assert.equal(ok.lines, 2);
    await as(finance, () => rpc('approve_card_import_batch', [b]));
    const snap = (await one('select approval_snapshot s from card_import_batches where id=$1', [b])).s;
    const lines = (snap.payload ? snap.payload.Line : snap.lines);
    assert.equal(lines[0].JournalEntryLineDetail.Entity.EntityRef.value, 'v1', 'the payable split line carries its vendor');
    assert.equal(lines[1].JournalEntryLineDetail.DepartmentRef.value, 'hq', 'and a split line keeps its own location');
  });

  await test('clearing a split returns the row to uncoded rather than guessing an account', async () => {
    const b = await newBatch(); const t = await newTxn(b, 500);
    await setSplits(t, [{ amount: 300, qbo_account_id: 'loan' }, { amount: 200, qbo_account_id: 'interest' }]);
    const cleared = await setSplits(t, []);
    assert.equal(cleared.status, 'uncoded');
    assert.equal(Number((await one('select count(*) n from card_transaction_splits where transaction_id=$1', [t])).n), 0);
    const parent = await one('select status,qbo_account_id from card_transactions where id=$1', [t]);
    assert.deepEqual([parent.status, parent.qbo_account_id], ['uncoded', null], 'Neither account is assumed to have been the real one');
    await refused(() => as(finance, () => rpc('approve_card_import_batch', [b])), /must be coded or excluded/, 'approving with the row left uncoded');
  });

  await test('a learned rule remembers the accounts and never the amounts', async () => {
    const b = await newBatch(); const t = await newTxn(b, LOAN);
    await setSplits(t, [{ amount: PRINCIPAL, qbo_account_id: 'loan', memo: 'Principal' }, { amount: INTEREST, qbo_account_id: 'interest', memo: 'Interest' }], finance, true, 'merchant');
    const rule = await one('select * from card_split_rules where company_entity_id=$1', [co]);
    assert.equal(rule.match_field, 'merchant');
    const ruleLines = await q('select line_no,qbo_account_id,memo_template from card_split_rule_lines where rule_id=$1 order by line_no', [rule.id]);
    assert.deepEqual(ruleLines.map((r) => r.qbo_account_id), ['loan', 'interest']);
    const cols = await q("select column_name from information_schema.columns where table_name='card_split_rule_lines'");
    assert.equal(cols.some((c) => /amount|proportion|percent/.test(c.column_name)), false,
      'The rule has nowhere to store an amount: an amortizing split differs every month, and a remembered figure would look authoritative while being wrong');
    // Next month's payment: same accounts offered, every amount blank.
    const b2 = await newBatch(); const t2 = await newTxn(b2, 25187.68);
    const suggested = await as(finance, () => rpc('suggest_card_transaction_splits', [t2]));
    assert.equal(suggested.conflict, false);
    assert.deepEqual(suggested.lines.map((l) => l.qbo_account_id), ['loan', 'interest']);
    assert.deepEqual(suggested.lines.map((l) => l.amount), [null, null], 'Every suggested amount is blank and must be entered from the statement');
    // A different division of the same total is accepted, which is the point.
    const out = await setSplits(t2, [{ amount: 21150.11, qbo_account_id: 'loan' }, { amount: 4037.57, qbo_account_id: 'interest' }]);
    assert.equal(Number(out.total), LOAN);
  });

  await test('a merchant rule and a card rule that disagree suggest nothing', async () => {
    await q(`insert into card_split_rules(id,company_entity_id,source_id,match_field,pattern)
             values(gen_random_uuid(),$1,null,'card_name','Operating') returning id`, [co]);
    const cardRule = await one("select id from card_split_rules where match_field='card_name'");
    await q("insert into card_split_rule_lines(rule_id,line_no,qbo_account_id) values($1,1,'fees'),($1,2,'interest')", [cardRule.id]);
    const b = await newBatch(); const t = await newTxn(b, 900);
    const suggested = await as(finance, () => rpc('suggest_card_transaction_splits', [t]));
    assert.equal(suggested.conflict, true, 'Knowing the vendor and knowing the card are different claims');
    assert.match(suggested.reason, /neither is applied/);
  });

  await test('splits are finance-only, company-scoped, and no client can write them', async () => {
    assert.equal((await as(otherUser, () => q('select * from card_transaction_splits'))).length, 0, 'Another company sees none');
    assert.equal((await as(outsider, () => q('select * from card_transaction_splits'))).length, 0, 'A non-finance user sees none');
    assert.ok((await as(finance, () => q('select * from card_transaction_splits'))).length > 0, 'Finance sees its own');
    for (const table of ['card_transaction_splits', 'card_split_rules', 'card_split_rule_lines']) {
      for (const action of [`insert into ${table}(company_entity_id) values(gen_random_uuid())`, `update ${table} set line_no=line_no`, `delete from ${table}`]) {
        await assert.rejects(as(finance, () => q(action)), /permission denied|column .* does not exist/, `${table}: ${action.split(' ')[0]}`);
      }
    }
    passed += 1; console.log(`ok ${passed} - refused: every client write to the split tables`);
    const foreign = await newTxn(await newBatch(), 10);
    await refused(() => setSplits(foreign, [{ amount: 6, qbo_account_id: 'loan' }, { amount: 4, qbo_account_id: 'interest' }], otherUser),
      /Transaction not found/, "another company's user splitting this company's transaction");
    await refused(() => setSplits(foreign, [{ amount: 6, qbo_account_id: 'loan' }, { amount: 4, qbo_account_id: 'interest' }], outsider),
      /Finance access required/, 'a non-finance user splitting a transaction');
  });

  // The bank feed's approval guard judged direction and clearing-account
  // treatment through an INNER JOIN on card_transactions.qbo_account_id, which
  // a split row leaves null on purpose -- so every split row fell out of the
  // join and skipped all four checks. A card_payment that must land on a
  // Credit Card or Accounts Payable account could be split into two expense
  // accounts and approved, while the same row unsplit was refused.
  await test('a split row faces the same bank-feed direction and treatment checks as an unsplit one', async () => {
    const feedSource = randomUUID(), plaidConn = randomUUID(), plaidAcct = randomUUID();
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,
             credit_qbo_account_id,credit_qbo_account_name,posting_enabled,is_active)
             values($1,$2,$3,'feed-bank','Feed bank','bank','bank','Operating bank',true,true)`, [feedSource, co, conn]);
    await q(`insert into plaid_connections(id,company_entity_id,item_id,environment,institution_name)
             values($1,$2,'item-split','sandbox','Synthetic bank')`, [plaidConn, co]);
    await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id)
             values($1,$2,$3,'acct-split','Checking','depository',$4)`, [plaidAcct, co, plaidConn, feedSource]);

    const feedTxn = async (b, amount, treatment) => {
      const t = await newTxn(b, amount);
      await q(`update card_transactions set origin='plaid', plaid_account_id=$3, external_transaction_id=$1,
               provider_status='posted', currency='USD', accounting_treatment=$2 where id=$1`, [t, treatment, plaidAcct]);
      return t;
    };
    const approve = (b) => as(finance, () => rpc('approve_card_import_batch', [b]));
    const feedBatch = async () => {
      const id = randomUUID();
      await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status,origin,qbo_connection_id)
               values($1,$2,$3,'Feed','2026-09-30','draft','plaid',$4)`, [id, co, feedSource, conn]);
      return id;
    };

    // Account type, per line. Two expense accounts for a card payment is the
    // exact misclassification the guard exists to refuse.
    {
      const b = await feedBatch(), t = await feedTxn(b, 500, 'card_payment');
      await setSplits(t, [{ amount: 300, qbo_account_id: 'interest' }, { amount: 200, qbo_account_id: 'fees' }]);
      if (mutation === 'guard-skips-splits') { await approve(b); assert.fail('The guard was put back on the parent account join, yet a split card payment was still refused'); }
      await refused(() => approve(b), /bank feed owns card payments/, 'a card payment split entirely into expense accounts');
      // The same shape UNSPLIT is refused too, which is the parity being claimed.
      const b2 = await feedBatch(), t2 = await feedTxn(b2, 500, 'card_payment');
      await q("update card_transactions set qbo_account_id='interest', qbo_account_name='Interest expense', status='coded', coding_source='manual' where id=$1", [t2]);
      await refused(() => approve(b2), /bank feed owns card payments/, 'the same card payment unsplit on one expense account');
      // And a split onto accounts the treatment does allow goes through.
      const b3 = await feedBatch(), t3 = await feedTxn(b3, 500, 'card_payment');
      await setSplits(t3, [{ amount: 300, qbo_account_id: 'ap', entity_qbo_id: 'v1', entity_type: 'Vendor' },
                           { amount: 200, qbo_account_id: 'ap', entity_qbo_id: 'v1', entity_type: 'Vendor' }]);
      const ok = await approve(b3);
      assert.ok(ok.approval_hash, 'A card payment split across payable accounts is approved');
    }
    // Direction, on the transaction's own amount. This one needs no account at
    // all, and was being skipped only because it shared the account join.
    {
      const b = await feedBatch(), t = await feedTxn(b, -40, 'purchase');
      await setSplits(t, [{ amount: -25, qbo_account_id: 'interest' }, { amount: -15, qbo_account_id: 'fees' }]);
      await refused(() => approve(b), /Review feed direction/, 'a split purchase whose amount is money in');
    }
  });

  await test('an unsplit batch posts exactly as it did before', async () => {
    const b = await newBatch(); const t = await newTxn(b, 250.00, { row_no: 1 });
    await q("update card_transactions set qbo_account_id='fees', qbo_account_name='Bank fees', status='coded', coding_source='manual' where id=$1", [t]);
    await as(finance, () => rpc('approve_card_import_batch', [b]));
    const snap = (await one('select approval_snapshot s from card_import_batches where id=$1', [b])).s;
    const lines = (snap.payload ? snap.payload.Line : snap.lines);
    assert.deepEqual(lines.map((l) => [l.JournalEntryLineDetail.AccountRef.value, l.JournalEntryLineDetail.PostingType, Number(l.Amount)]),
      [['fees', 'Debit', 250], ['bank', 'Credit', 250]], 'One coded row, one line, one balancing line');
  });

  console.log(`PASS card splits: principal/interest split, lines total the payment (RPC, stored invariant and at approval), one journal line per split line, QBO reference checks shared with ordinary lines, learned shape without learned amounts, conflict refusal, company/permission isolation, unsplit batches unchanged`);
} finally { await db.close(); }
