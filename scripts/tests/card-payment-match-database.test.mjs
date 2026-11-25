// Matching a card paydown to the bank payment that made it
// (20261125020000_card_payment_match.sql), on real PostgreSQL (PGlite).
//
// The case: a card feed and a bank feed both carry the same paydown. Approval
// refuses a card paying a card, so the BANK row is the one that posts -- which
// means a card row left CATEGORIZED records the paydown a second time (a
// balanced entry, and still a double: the card liability is reduced twice and
// the clearing account is left holding the other side). The only way out was a
// hand exclusion that recorded nothing about which payment it was.
//
// What is proven:
//   1. Candidates are the offsetting bank rows inside the window, and the one
//      that matters most is a bank row ALREADY APPROVED OR POSTED -- that is
//      the normal case, because the paying account runs ahead of the card
//      review. Nothing on the bank side is ever written.
//   2. A match excludes the card row, so it contributes no posted line: the
//      paydown is recorded once.
//   3. The record cannot lie: amounts must offset, the paying side must be a
//      bank account, it cannot be the same account, and the card row must
//      actually be excluded -- enforced for a direct INSERT too, not only
//      inside the RPC.
//   4. An approved or posted card import cannot be matched (its rows are
//      frozen), and a reader without finance access cannot match anything.
//   5. Undoing a match puts the row back; a pending provider row stays
//      excluded, because the feed guard allows nothing else.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_MATCH_MUTATION=no-exclude       the link records the pair without excluding the card row
//   CARD_MATCH_MUTATION=ignore-rowcount  an RLS-refused update is reported as a match
//   CARD_MATCH_MUTATION=insert-any-source   the record accepts any account as the payer
//   CARD_MATCH_MUTATION=insert-skip-amount  the record accepts two sides that do not offset
//   CARD_MATCH_MUTATION=payer-any-treatment the paying row is coded whatever the account type is
//   CARD_MATCH_MUTATION=restore-changed     undoing restores a paying row somebody has since recoded
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

// Every mutation targets the CURRENT definitions, which live in the
// both-sides migration: it redefines the link, the undo and the record's
// trigger, so mutating the first migration alone would be overwritten and
// prove nothing.
const MUTATIONS = {
  'no-exclude': ["     set status = 'excluded', exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()",
    '     set exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()'],
  'ignore-rowcount': ["  get diagnostics v_rows = row_count;\n  if v_rows = 0 then\n    raise exception 'This transaction cannot be changed — its import is approved or posted, or you do not have finance access';\n  end if;\n\n  -- The paying row posts this payment",
    '  -- The paying row posts this payment'],
  // The two rules the RPC and the record's own trigger both hold. Mutating the
  // trigger is what a mutation must be able to see, because the trigger is
  // what holds a write that never went through the RPC.
  'insert-any-source': ["  if coalesce(v_bank_src.credit_qbo_account_type, '') <> 'Bank' then\n    raise exception 'The paying side must be an account of type Bank';\n  end if;", ''],
  'insert-skip-amount': ["  if round(v_bank.amount, 2) <> round(-v_card.amount, 2) then\n    raise exception 'The two amounts do not offset';\n  end if;", ''],
  // Coding the paying row is the second half of the feature, and both halves
  // of it have to hold: the treatment comes from the account type approval
  // will judge, and an undo never overwrites coding somebody did themselves.
  'payer-any-treatment': ['    else null end;', "    else 'card_payment' end;"],
  'restore-changed': ["    if v_bank.id is not null and v_bank.status = 'coded'\n       and v_bank.qbo_account_id is not distinct from v_card_src.credit_qbo_account_id\n       and v_bank.accounting_treatment is not distinct from v_treatment then",
    '    if v_bank.id is not null then'],
};
const mutation = process.env.CARD_MATCH_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown mutation');

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const dependencies = [
  '20260826070000_quickbooks_integration.sql', '20260826090000_quickbooks_locations.sql', '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql', '20260831190000_card_name_and_holder.sql', '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql', '20260831220000_void_card_posting.sql', '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql', '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql', '20260912000000_finance_v1_posting_controls.sql',
  '20260912052930_plaid_bank_feed.sql', '20260912203725_bank_feed_workspace_history.sql',
  '20260915100000_card_transaction_splits.sql', '20260915220000_plaid_removed_from_status.sql',
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
async function refused(fn, re, why) {
  try { await fn(); } catch (e) { assert.match(e.message, re, why); return e; }
  assert.fail(`${why}: nothing was refused`);
}

const co = randomUUID();
const finance = randomUUID(), reader = randomUUID();
const conn = randomUUID();
const bankSource = randomUUID(), cardSource = randomUUID(), secondCard = randomUUID();
const payableSource = randomUUID(), oddSource = randomUUID();
let rowNo = 0;

async function newBatch(source, { status = 'draft', company = co } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
           values($1,$2,$3,'B','2026-10-31','2026-10-01','2026-10-31',$4,'csv',$5)`, [id, company, source, status, conn]);
  return id;
}
async function newTxn(batch, amount, { date = '2026-10-10', company = co, account = 'supplies', status = 'coded', description = 'ROW' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,$5,$6,$6,$6,'Ops',$7,'USD',$8,$9,$9,$10)`,
  [id, company, batch, ++rowNo, date, description, amount, status, status === 'coded' ? account : null, status === 'coded' ? 'manual' : null]);
  return id;
}
const candidates = (txn, days = 7, user = finance) =>
  as(user, () => q('select * from card_payment_match_candidates($1,$2)', [txn, days]));
const link = (card, bank, user = finance) =>
  as(user, () => one('select link_card_payment_match($1,$2) as r', [card, bank]));
const unlink = (card, user = finance) => as(user, () => one('select unlink_card_payment_match($1) as r', [card]));
const row = (id) => one('select status, exclude_reason from card_transactions where id=$1', [id]);
const coding = (id) => one(`select status, qbo_account_id, qbo_account_name, accounting_treatment, coding_source
                            from card_transactions where id=$1`, [id]);
const proposals = (ids, days = 7, user = finance) =>
  as(user, () => q('select * from card_payment_match_proposals($1,$2)', [ids, days]));
const postedLines = (id) => q('select * from card_coding_effective_lines where transaction_id=$1', [id]);

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-31' $$;`);

  const pairSql = await readFile(new URL('supabase/migrations/20261125020000_card_payment_match.sql', root), 'utf8');
  await db.exec(pairSql);
  let sql = await readFile(new URL('supabase/migrations/20261125060000_card_payment_match_both_sides.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
    sql = sql.replace(from, to);
  }
  await db.exec(sql);
  // Applied twice: apply_all_post_merge.sql re-runs every migration.
  await db.exec(pairSql);
  await db.exec(sql);

  await q("insert into entities(id,title) values($1,'A')", [co]);
  await q('insert into auth.users(id) values($1),($2)', [finance, reader]);
  await q(`insert into profiles(id,role,department,is_active,active_company_id)
           values($1,'admin','finance',true,$2),($3,'user',null,true,$2)`, [finance, co, reader]);
  await q(`insert into entity_memberships(user_id,entity_id,role) values($1,$2,'admin'),($3,$2,'member')`, [finance, co, reader]);
  await q(`insert into quickbooks_connections(id,company_entity_id,realm_id,is_active) values($1,$2,'realm',true)`, [conn, co]);
  await q(`insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values
           ($1,$2,'supplies','Supplies','Expense',true),($1,$2,'card','Company card','Credit Card',true),
           ($1,$2,'checking','Checking','Bank',true),($1,$2,'clearing','Clearing','Other Current Asset',true),
           ($1,$2,'payable','Processor payable','Other Current Liability',true)`, [co, conn]);
  /* The two sides are told apart by the ACCOUNT TYPE behind the source, not by
     the word 'card': a payable line of credit and a source whose credit
     account is an expense are both here to prove it. */
  await q(`insert into card_sources(id,company_entity_id,source_key,display_name,source_type,qbo_connection_id,credit_qbo_account_id,credit_qbo_account_name,credit_qbo_account_type,is_active) values
           ($1,$6,'bank','Operating checking','bank',$7,'checking','Checking','Bank',true),
           ($2,$6,'card','Company card','card',$7,'card','Company card','Credit Card',true),
           ($3,$6,'card2','Second card','card',$7,'card','Company card','Credit Card',true),
           ($4,$6,'payable','Processor float','card',$7,'payable','Processor payable','Other Current Liability',true),
           ($5,$6,'odd','Misconfigured source','card',$7,'supplies','Supplies','Expense',true)`,
  [bankSource, cardSource, secondCard, payableSource, oddSource, co, conn]);

  // The paydown as the two feeds see it: the card gains 5,412.01, the bank
  // loses it. SILO's sign convention is money out positive.
  const cardBatch = await newBatch(cardSource);
  const bankBatch = await newBatch(bankSource);
  const donePeriod = await newBatch(bankSource);
  const paydown = await newTxn(cardBatch, -5412.01, { date: '2026-10-10', account: 'clearing', description: 'AUTOPAY PYMT' });
  const payment = await newTxn(donePeriod, 5412.01, { date: '2026-10-10', account: 'card', description: 'CARD AUTOPAY' });
  // The bank side is already done -- the case this exists for.
  await q("update card_import_batches set status='posted' where id=$1", [donePeriod]);

  await test('the bank payment is offered even though its import is already posted', async () => {
    const found = await candidates(paydown);
    assert.equal(found.length, 1, 'the one offsetting bank row is the candidate');
    assert.equal(found[0].transaction_id, payment);
    assert.equal(found[0].batch_status, 'posted', 'the normal case: the paying account ran ahead of the card review');
    assert.equal(Number(found[0].day_gap), 0);
  });

  await test('a row on another card, a different amount, or outside the window is not a candidate', async () => {
    const otherCardBatch = await newBatch(secondCard);
    await newTxn(otherCardBatch, 5412.01, { date: '2026-10-10', description: 'NOT A BANK ROW' });
    await newTxn(bankBatch, 5412.00, { date: '2026-10-10', description: 'A CENT OUT' });
    await newTxn(bankBatch, 5412.01, { date: '2026-10-25', description: 'TOO FAR AWAY' });
    const found = await candidates(paydown);
    assert.deepEqual(found.map((r) => r.transaction_id), [payment]);
    const wider = await candidates(paydown, 30);
    assert.equal(wider.length, 2, 'a wider window reaches the far one, and only it');
  });

  await test('matching excludes the card row, names the payment, and leaves a posted payment untouched', async () => {
    const before = await row(payment);
    const result = await link(paydown, payment);
    const after = await row(paydown);
    assert.equal(after.status, 'excluded');
    assert.match(after.exclude_reason, /Operating checking/, 'the reason says which payment it was');
    assert.match(after.exclude_reason, /2026-10-10/);
    assert.deepEqual(await row(payment), before, 'a payment already in the books is read, never written');
    assert.equal((await one('select payer_coded_at from card_payment_matches where card_transaction_id=$1', [paydown])).payer_coded_at,
      null, 'and the record says so, so undoing it will not invent coding for it');
    assert.equal(result.r.status, 'excluded');
    assert.equal(result.r.bank_transaction_id, payment);
    assert.equal((await postedLines(paydown)).length, 0, 'an excluded row contributes no line: the paydown posts once');
    assert.ok((await postedLines(payment)).length > 0, 'the bank side still posts it');
    assert.equal(Number((await one('select count(*) n from card_payment_matches where card_transaction_id=$1', [paydown])).n), 1);
  });

  await test('one bank payment cannot settle two card rows', async () => {
    assert.deepEqual(await candidates(paydown, 30).then((r) => r.map((x) => x.transaction_id === payment)), [false],
      'a payment already matched is no longer offered');
  });

  await test('the record cannot say something the transactions do not', async () => {
    const other = await newTxn(cardBatch, -99.5, { date: '2026-10-11', account: 'clearing', description: 'SECOND PAYDOWN' });
    const mismatched = await newTxn(bankBatch, 12.34, { date: '2026-10-11', description: 'WRONG AMOUNT' });
    const onACard = await newTxn(await newBatch(secondCard), 99.5, { date: '2026-10-11', description: 'ANOTHER CARD' });
    await refused(() => link(other, mismatched), /do not offset/, 'two amounts that do not offset');
    await refused(() => link(other, onACard), /type Bank/, 'a card cannot pay a card');

    // The record's own trigger holds a DIRECT write to the same rules, so the
    // table is not a back door around the RPC.
    const direct = (card, bank) => as(finance, () => q(
      'insert into card_payment_matches(company_entity_id,card_transaction_id,bank_transaction_id) values($1,$2,$3)',
      [co, card, bank]));
    const pays = await newTxn(bankBatch, 99.5, { date: '2026-10-11', description: 'PAYS THE SECOND PAYDOWN' });
    await refused(() => direct(other, pays), /excluded/, 'a row still in the entry is not settled by a record saying it is');
    await q("update card_transactions set status='excluded' where id=$1", [other]);
    await refused(() => direct(other, mismatched), /offset/, 'a record of two amounts that do not offset');
    await refused(() => direct(other, onACard), /type Bank/, 'a record naming a card as the payer');
    await q("update card_transactions set status='coded' where id=$1", [other]);
  });

  await test('a frozen card import cannot be matched, and a reader without finance access cannot match at all', async () => {
    const approvedBatch = await newBatch(cardSource);
    const frozen = await newTxn(approvedBatch, -250, { date: '2026-10-12', account: 'clearing', description: 'FROZEN PAYDOWN' });
    await q("update card_import_batches set status='approved' where id=$1", [approvedBatch]);
    const bankFor = await newTxn(bankBatch, 250, { date: '2026-10-12', description: 'PAYS THE FROZEN ONE' });
    await refused(() => link(frozen, bankFor), /approved or posted|immutable|finance access/,
      'an approved import is frozen; reopen it rather than editing it underneath the approval');

    const open = await newTxn(cardBatch, -77, { date: '2026-10-13', account: 'clearing', description: 'READER TRIES' });
    const bankOpen = await newTxn(bankBatch, 77, { date: '2026-10-13', description: 'PAYS IT' });
    await refused(() => link(open, bankOpen, reader), /cannot be changed|finance access|permission|policy/,
      'matching is a coding change, so it takes the same authority as coding');
    assert.equal((await row(open)).status, 'coded', 'and nothing moved');
  });

  await test('undoing a match puts the row back, and a pending provider row stays excluded', async () => {
    const back = await unlink(paydown);
    assert.equal(back.r.status, 'coded', 'it had a category, so it returns to coded');
    assert.equal((await row(paydown)).exclude_reason, null);
    assert.equal(Number((await one('select count(*) n from card_payment_matches where card_transaction_id=$1', [paydown])).n), 0);

    // Re-match it, then make it a pending provider row: the feed guard refuses
    // anything but 'excluded' for one, so the undo must leave it there.
    await link(paydown, payment);
    const plaidAccount = randomUUID(), plaidConn = randomUUID();
    await q(`insert into plaid_connections(id,company_entity_id,item_id,environment) values($1,$2,'item','production')`, [plaidConn, co]);
    await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id)
             values($1,$2,$3,'acct','Company card','credit',$4)`, [plaidAccount, co, plaidConn, cardSource]);
    await q(`update card_transactions set origin='plaid', provider_status='pending', plaid_account_id=$2,
             external_transaction_id='feed-1' where id=$1`, [paydown, plaidAccount]);
    const held = await unlink(paydown);
    assert.equal(held.r.status, 'excluded');
    assert.match(held.r.exclude_reason, /Pending/);
  });


  /* The second half: the paying row is the one that posts, and the account it
     must hit is the liability account of the source being paid. Confirming the
     match is the decision; coding it afterwards by hand was never a separate
     one. */
  await test('confirming a match codes the paying row, so it leaves Needs categorizing', async () => {
    const owed = await newTxn(cardBatch, -1200, { date: '2026-10-14', account: 'clearing', description: 'AUTOPAY 1200' });
    const pays = await newTxn(bankBatch, 1200, { date: '2026-10-14', status: 'uncoded', description: 'CARD PAYMENT 1200' });
    const result = await link(owed, pays);
    const after = await coding(pays);
    assert.equal(after.status, 'coded', 'it is no longer waiting to be categorized');
    assert.equal(after.qbo_account_id, 'card', 'it hits the liability account of the source it paid');
    assert.equal(after.accounting_treatment, 'card_payment', 'the treatment approval requires for that account type');
    assert.equal(result.r.bank_coded, true);
    assert.equal(result.r.bank_qbo_account_name, 'Company card');
    assert.ok((await postedLines(pays)).length > 0, 'and it is the side that posts');
    await unlink(owed);
  });

  await test('the treatment follows the account type, and an account type approval would refuse is left alone', async () => {
    const floatBatch = await newBatch(payableSource);
    const owed = await newTxn(floatBatch, -300, { date: '2026-10-15', account: 'clearing', description: 'FLOAT REPAID' });
    const pays = await newTxn(bankBatch, 300, { date: '2026-10-15', status: 'uncoded', description: 'PAYS THE FLOAT' });
    await link(owed, pays);
    const floatPayer = await coding(pays);
    assert.equal(floatPayer.accounting_treatment, 'transfer', 'Other Current Liability posts as a transfer, not a card payment');
    assert.equal(floatPayer.qbo_account_id, 'payable');

    const oddBatch = await newBatch(oddSource);
    const oddOwed = await newTxn(oddBatch, -42, { date: '2026-10-16', account: 'clearing', description: 'ODD SOURCE' });
    const oddPays = await newTxn(bankBatch, 42, { date: '2026-10-16', status: 'uncoded', description: 'PAYS THE ODD ONE' });
    const oddResult = await link(oddOwed, oddPays);
    assert.equal((await coding(oddPays)).status, 'uncoded',
      'no treatment is right for an expense account, and approval would refuse a guess');
    assert.equal(oddResult.r.bank_coded, false);
    assert.equal((await row(oddOwed)).status, 'excluded', 'the settled side is still settled either way');
  });

  await test('undoing a match puts the paying row back, unless somebody recoded it since', async () => {
    const owed = await newTxn(cardBatch, -800, { date: '2026-10-17', account: 'clearing', description: 'AUTOPAY 800' });
    const pays = await newTxn(bankBatch, 800, { date: '2026-10-17', status: 'uncoded', description: 'PAYS 800' });
    await link(owed, pays);
    const undone = await unlink(owed);
    assert.equal(undone.r.bank_restored, true);
    const back = await coding(pays);
    assert.equal(back.status, 'uncoded', 'it is back where the match found it');
    assert.equal(back.qbo_account_id, null);

    await link(owed, pays);
    await q("update card_transactions set qbo_account_id='supplies', qbo_account_name='Supplies', coding_source='manual' where id=$1", [pays]);
    const second = await unlink(owed);
    assert.equal(second.r.bank_restored, false);
    assert.equal((await coding(pays)).qbo_account_id, 'supplies', 'their coding is the newer decision and stands');
  });

  await test('proposals answer a whole screen, and name no payment when there are two', async () => {
    const single = await newTxn(cardBatch, -611.11, { date: '2026-10-18', account: 'clearing', description: 'ONE MATCH' });
    const singlePays = await newTxn(bankBatch, 611.11, { date: '2026-10-18', status: 'uncoded', description: 'THE PAYMENT' });
    const ambiguous = await newTxn(cardBatch, -222.22, { date: '2026-10-19', account: 'clearing', description: 'TWO MATCHES' });
    await newTxn(bankBatch, 222.22, { date: '2026-10-19', status: 'uncoded', description: 'EITHER ONE' });
    await newTxn(bankBatch, 222.22, { date: '2026-10-20', status: 'uncoded', description: 'OR THIS ONE' });
    const payer = await newTxn(bankBatch, 999.99, { date: '2026-10-18', status: 'uncoded', description: 'A BANK ROW' });

    const got = await proposals([single, ambiguous, payer]);
    const bySingle = got.find((r) => r.transaction_id === single);
    assert.equal(Number(bySingle.candidate_count), 1);
    assert.equal(bySingle.bank_transaction_id, singlePays, 'one candidate is offered by name, ready to confirm');
    assert.equal(bySingle.bank_source_name, 'Operating checking');
    const byAmbiguous = got.find((r) => r.transaction_id === ambiguous);
    assert.equal(Number(byAmbiguous.candidate_count), 2);
    assert.equal(byAmbiguous.bank_transaction_id, null, 'choosing between two payments of the same amount stays a person\'s call');
    assert.equal(got.find((r) => r.transaction_id === payer), undefined, 'a bank row is not something to settle');

    await link(single, singlePays);
    assert.equal((await proposals([single])).length, 0, 'a settled row is no longer proposed');
    await unlink(single);
  });

  await test('the browser role reads the record but cannot reach it as anon', async () => {
    assert.equal(await one("select has_function_privilege('anon','public.link_card_payment_match(uuid,uuid)','execute') as x")
      .then((r) => r.x), false);
    assert.equal(await one("select has_function_privilege('anon','public.card_payment_match_candidates(uuid,integer)','execute') as x")
      .then((r) => r.x), false);
    assert.equal(await one("select has_table_privilege('anon','public.card_payment_matches','SELECT') as x").then((r) => r.x), false);
    assert.ok((await one('select relrowsecurity from pg_class where oid=\'public.card_payment_matches\'::regclass')).relrowsecurity,
      'RLS is the tenant boundary here as everywhere');
  });

  console.log(`\n1..${passed}`);
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await db.close();
}
