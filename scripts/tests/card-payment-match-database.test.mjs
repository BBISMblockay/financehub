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
//   CARD_MATCH_MUTATION=relink-resnapshots  linking the same pair twice snapshots the match's own coding
//   CARD_MATCH_MUTATION=restore-unstamped   the undo trusts the values alone, not that it wrote them
//   CARD_MATCH_MUTATION=settle-frozen-import the bank side is offered a paydown its confirm could not change
//   CARD_MATCH_MUTATION=names-ignored    a row naming a different account is offered anyway
//   CARD_MATCH_MUTATION=names-shared     a word shared by two accounts counts as naming one of them
//   CARD_MATCH_MUTATION=contest-ignored  one payment is the one-click answer for two rows at once
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

// Every mutation targets the CURRENT definition of what it breaks: the record's
// trigger and the treatment rule in the both-sides migration, the link and the
// undo in the relink one that redefines them. Mutating a definition something
// later overwrites would prove nothing, so each mutation names its file.
const RELINK = new Set(['no-exclude', 'ignore-rowcount', 'relink-resnapshots', 'restore-unstamped', 'restore-changed']);
const NAMES = new Set(['names-ignored', 'names-shared', 'contest-ignored', 'settle-frozen-import']);
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
  'relink-resnapshots': ["  select * into v_match from public.card_payment_matches where card_transaction_id = v_card.id;\n  if v_match.card_transaction_id is not null then", '  if false then'],
  'restore-unstamped': ['         and t.updated_at is not distinct from v_match.payer_coded_at\n', ''],
  // From the bank side the row that must change is the OTHER one, so an
  // import that cannot be edited is not a candidate at all.
  'settle-frozen-import': ["    join public.card_import_batches b on b.id = t.batch_id and b.status in ('draft', 'categorized')",
    '    join public.card_import_batches b on b.id = t.batch_id'],
  // The name rule, and the rule that one payment answers one row.
  'names-ignored': ["    where c.name_signal <> 'other_source'", '    where true'],
  'names-shared': ['  where (select count(distinct k2.source_id) from kept k2 where k2.token = k.token) = 1',
    '  where (select count(distinct k2.source_id) from kept k2 where k2.token = k.token) >= 1'],
  'contest-ignored': ['  select f.id, f.side, f.n::integer, f.rivals > 1, f.name_signal,',
    '  select f.id, f.side, f.n::integer, false, f.name_signal,'],
  'restore-changed': ["       where t.id = v_bank.id\n         and t.status = 'coded'\n         and t.updated_at is not distinct from v_match.payer_coded_at\n         and t.qbo_account_id is not distinct from v_card_src.credit_qbo_account_id\n         and t.accounting_treatment is not distinct from v_treatment;",
    '       where t.id = v_bank.id;'],
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
  as(user, () => q('select * from card_payment_match_options($1,$2)', [txn, days]));
const link = (card, bank, user = finance) =>
  as(user, () => one('select link_card_payment_match($1,$2) as r', [card, bank]));
const unlink = (card, user = finance) => as(user, () => one('select unlink_card_payment_match($1) as r', [card]));
const row = (id) => one('select status, exclude_reason from card_transactions where id=$1', [id]);
const coding = (id) => one(`select status, qbo_account_id, qbo_account_name, accounting_treatment, coding_source
                            from card_transactions where id=$1`, [id]);
const proposals = (ids, days = 7, user = finance) =>
  as(user, () => q('select * from card_payment_offers($1,$2)', [ids, days]));
const postedLines = (id) => q('select * from card_coding_effective_lines where transaction_id=$1', [id]);

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-31' $$;`);

  const pairSql = await readFile(new URL('supabase/migrations/20261125020000_card_payment_match.sql', root), 'utf8');
  await db.exec(pairSql);
  // The drift check's own text is part of the feature: it runs on production
  // daily, and a condition naming something a later migration DROPS turns it
  // red for a function nothing calls. So the block is run here as the
  // migrations land. It is run from 060000 onward only: the block CALLS
  // card_payment_posting_treatment(), and a call to a function that does not
  // exist yet fails to parse, which is the file's existing convention.
  const verifyBlock = async () => {
    const full = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const block = full.slice(full.indexOf("select 'Card paydown match' as check_name"),
      full.indexOf('-- End card paydown match checks.'));
    const parts = block.split(/;\s*\n/).filter((x) => x.replace(/--.*$/gm, '').trim());
    assert.equal(parts.length, 1);
    return (await q(parts[0]))[0].status;
  };
  const files = ['20261125060000_card_payment_match_both_sides.sql', '20261125070000_card_payment_match_relink.sql',
    '20261125080000_card_payment_match_either_side.sql', '20261125090000_card_payment_match_names.sql'];
  const sources = [];
  for (const name of files) {
    let text = await readFile(new URL('supabase/migrations/' + name, root), 'utf8');
    const mine = mutation && (NAMES.has(mutation)
      ? name.includes('match_names')
      : !name.includes('either_side') && !name.includes('match_names')
        && RELINK.has(mutation) === name.includes('relink'));
    if (mine) {
      const [from, to] = MUTATIONS[mutation];
      assert.ok(text.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
      text = text.replace(from, to);
    }
    sources.push(text);
    await db.exec(text);
    if (name.includes('relink') && !mutation) {
      assert.match(await verifyBlock(), /^MISSING — run 20261125080000/,
        'with only 060000 and 070000 the check must name the either-side file');
    }
    if (name.includes('either_side') && !mutation) {
      assert.match(await verifyBlock(), /^MISSING — run 20261125090000/,
        'without the name rule the check must name that file too');
    }
  }
  // Applied twice: apply_all_post_merge.sql re-runs every migration.
  await db.exec(pairSql);
  for (const text of sources) await db.exec(text);
  if (!mutation) {
    assert.equal(await verifyBlock(), 'ok',
      'with every migration applied the drift check must be green');
  }

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
  /* One word carried by TWO of the accounts, which is how an issuer usually
     shows up: it cannot tell them apart, so it must say nothing at all. */
  await q(`update card_sources set credit_vendor_name = 'Vaultline Holdings' where id = any($1)`,
  [[cardSource, secondCard]]);

  // The paydown as the two feeds see it: the card gains 5,412.01, the bank
  // loses it. SILO's sign convention is money out positive.
  const cardBatch = await newBatch(cardSource);
  const secondBatch = await newBatch(secondCard);
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


  await test('linking the same pair twice answers, and never re-snapshots the match’s own coding', async () => {
    const owed = await newTxn(cardBatch, -410, { date: '2026-10-21', account: 'clearing', description: 'AUTOPAY 410' });
    const pays = await newTxn(bankBatch, 410, { date: '2026-10-21', status: 'uncoded', description: 'PAYS 410' });
    await link(owed, pays);
    const again = await link(owed, pays);
    assert.equal(again.r.already_matched, true, 'a lost response and a second press is the same match, not a second one');
    assert.equal(Number((await one('select count(*) n from card_payment_matches where card_transaction_id=$1', [owed])).n), 1);
    const undone = await unlink(owed);
    assert.equal(undone.r.bank_restored, true);
    assert.equal((await coding(pays)).status, 'uncoded',
      'the undo puts back what the person had, not what the first link wrote');

    const other = await newTxn(bankBatch, 410, { date: '2026-10-22', status: 'uncoded', description: 'A SECOND 410' });
    await link(owed, pays);
    await refused(() => link(owed, other), /already matched/, 're-pointing a match hides the first undo');
    await unlink(owed);
  });

  await test('an edit back to the same account still counts as somebody else’s decision', async () => {
    const owed = await newTxn(cardBatch, -515, { date: '2026-10-23', account: 'clearing', description: 'AUTOPAY 515' });
    const pays = await newTxn(bankBatch, 515, { date: '2026-10-23', status: 'uncoded', description: 'PAYS 515' });
    await link(owed, pays);
    // Same account, same treatment, somebody's own save: the values alone
    // cannot tell this from the match's work, so the stamp has to.
    await q("update card_transactions set memo='checked by hand', updated_at=now()+interval '1 minute' where id=$1", [pays]);
    const undone = await unlink(owed);
    assert.equal(undone.r.bank_restored, false);
    assert.equal((await coding(pays)).status, 'coded', 'their save stands');
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
    assert.equal(bySingle.other_transaction_id, singlePays, 'one candidate is offered by name, ready to confirm');
    assert.equal(bySingle.other_source_name, 'Operating checking');
    assert.equal(bySingle.side, 'paydown');
    const byAmbiguous = got.find((r) => r.transaction_id === ambiguous);
    assert.equal(Number(byAmbiguous.candidate_count), 2);
    assert.equal(byAmbiguous.other_transaction_id, null, 'choosing between two payments of the same amount stays a person\'s call');
    const byPayer = got.find((r) => r.transaction_id === payer);
    assert.equal(byPayer, undefined, 'a bank row with nothing to settle is not proposed');

    await link(single, singlePays);
    assert.equal((await proposals([single])).length, 0, 'a settled row is no longer proposed');
    await unlink(single);
  });


  await test('the same pair is offered from the bank side, and only where the confirm could land', async () => {
    const owed = await newTxn(cardBatch, -777, { date: '2026-10-24', account: 'clearing', description: 'AUTOPAY 777' });
    const pays = await newTxn(bankBatch, 777, { date: '2026-10-24', status: 'uncoded', description: 'PAYS 777' });
    const fromBank = await as(finance, () => q('select * from card_payment_settlement_options($1,$2)', [pays, 7]));
    assert.deepEqual(fromBank.map((r) => r.transaction_id), [owed], 'the paydown this payment would settle');

    const got = await proposals([pays]);
    assert.equal(got.length, 1);
    assert.equal(got[0].side, 'payment', 'the answer says which side was asked about');
    assert.equal(got[0].other_transaction_id, owed);
    assert.equal(got[0].other_source_name, 'Company card');

    // Confirming from there is the same call with the sides the right way round.
    await link(owed, pays);
    assert.equal((await row(owed)).status, 'excluded');
    assert.equal((await coding(pays)).qbo_account_id, 'card');
    await unlink(owed);

    // A paydown whose import is frozen is not offered here: the confirm would
    // have to change THAT row, and an approved import refuses it.
    const frozenBatch = await newBatch(cardSource);
    const frozen = await newTxn(frozenBatch, -888, { date: '2026-10-25', account: 'clearing', description: 'FROZEN 888' });
    const paysFrozen = await newTxn(bankBatch, 888, { date: '2026-10-25', status: 'uncoded', description: 'PAYS 888' });
    assert.equal((await as(finance, () => q('select * from card_payment_settlement_options($1,$2)', [paysFrozen, 7]))).length, 1,
      'offered while its import is open');
    await q("update card_import_batches set status='approved' where id=$1", [frozenBatch]);
    assert.equal((await as(finance, () => q('select * from card_payment_settlement_options($1,$2)', [paysFrozen, 7]))).length, 0,
      'and not once it is frozen, because the confirm could not change it');
    assert.equal((await proposals([paysFrozen])).length, 0);
    assert.ok(frozen);
  });

  /* Blake's case, in miniature: the same 15,000 on the card was offered, with
     a one-click Confirm, against both the Capital One ACH and a FLEX NET60
     ACH. The words were there the whole time, in the company's own accounts. */
  await test('a payment naming a different account of the company is never offered', async () => {
    const owed = await newTxn(cardBatch, -15000, { date: '2026-10-26', account: 'clearing', description: 'CAPITAL ONE MOBILE PMT' });
    const right = await newTxn(bankBatch, 15000, { date: '2026-10-26', status: 'uncoded', description: 'PREAUTH ACH DEBIT CAPITAL ONE MOBILE' });
    const wrong = await newTxn(bankBatch, 15000, { date: '2026-10-21', status: 'uncoded', description: 'PREAUTH ACH DEBIT PROCESSOR NET60' });

    // 'Processor float' is a source of this company, so PROCESSOR names it --
    // and it is not the account being paid.
    const seen = await candidates(owed);
    assert.deepEqual(seen.map((r) => r.transaction_id), [right, wrong],
      'both are still listed, so a person can judge, with the contradicted one last');
    assert.equal(seen[1].name_signal, 'other_source');

    const got = await proposals([owed]);
    assert.equal(Number(got[0].candidate_count), 1, 'only the row that does not name somebody else is an offer');
    assert.equal(got[0].other_transaction_id, right);

    // And from the bank side the contradicted row offers nothing at all.
    assert.equal((await proposals([wrong])).length, 0);
    assert.equal((await as(finance, () => q('select * from card_payment_settlement_options($1,$2)', [wrong, 7])))
      .filter((r) => r.name_signal !== 'other_source').length, 0);

    await q('delete from card_transactions where id = any($1)', [[right, wrong, owed]]);
  });

  await test('a word two accounts share names neither, and the account paid is never a contradiction', async () => {
    // CARD is a stopword, COMPANY is a stopword, and 'card' appears in the
    // display name of both card sources -- so nothing here can tell them apart.
    const names = await as(finance, () => q('select * from card_payment_source_names($1)', [co]));
    const tokens = names.map((r) => r.token);
    assert.ok(tokens.includes('PROCESSOR'), 'a word belonging to one account only is a name');
    assert.ok(!tokens.includes('CARD') && !tokens.includes('CHECKING'),
      'a word that is generic in banking never names an account');
    assert.equal(tokens.filter((t) => t === 'MISCONFIGURED').length, 1);
    assert.ok(!tokens.includes('VAULTLINE'), 'a word two accounts carry cannot tell them apart');

    // And it must not read as a contradiction either: a paydown on a third
    // account is still offered a payment whose words are that shared one.
    const third = await newTxn(await newBatch(payableSource), -4321,
      { date: '2026-10-27', account: 'clearing', description: 'FLOAT PMT' });
    const paysThird = await newTxn(bankBatch, 4321, { date: '2026-10-27', status: 'uncoded', description: 'VAULTLINE PMT' });
    const offered = await proposals([third]);
    assert.equal(offered[0]?.other_transaction_id, paysThird, 'a word that names nothing cannot name somebody else');
    assert.equal(offered[0].name_signal, 'unknown');
    await q('delete from card_transactions where id = any($1)', [[third, paysThird]]);

    // The payer's own bank is named on nearly every one of its lines, and that
    // must not read as a contradiction.
    const owed = await newTxn(cardBatch, -1234, { date: '2026-10-27', account: 'clearing', description: 'PAYMENT' });
    const pays = await newTxn(bankBatch, 1234, { date: '2026-10-27', status: 'uncoded', description: 'OPERATING CHECKING XFER' });
    const got = await proposals([owed]);
    assert.equal(got[0].other_transaction_id, pays, 'the bank naming itself is not evidence against the pair');
    assert.equal(got[0].name_signal, 'unknown');
    await q('delete from card_transactions where id = any($1)', [[owed, pays]]);
  });

  await test('one payment is never the one-click answer for two rows at once', async () => {
    const first = await newTxn(cardBatch, -2500, { date: '2026-10-28', account: 'clearing', description: 'PMT A' });
    const second = await newTxn(secondBatch, -2500, { date: '2026-10-28', account: 'clearing', description: 'PMT B' });
    const only = await newTxn(bankBatch, 2500, { date: '2026-10-28', status: 'uncoded', description: 'ONE PAYMENT' });

    const got = await proposals([first, second]);
    assert.equal(got.length, 2);
    for (const r of got) {
      assert.equal(Number(r.candidate_count), 1, 'each row really does have one candidate');
      assert.equal(r.contested, true);
      assert.equal(r.other_transaction_id, null, 'but it is the same payment, so neither offers a press');
    }

    /* And asked ONE AT A TIME, which is what a second card's screen does:
       counting the claims inside the call would have found none and offered a
       press on both screens. */
    for (const id of [first, second]) {
      const alone = await proposals([id]);
      assert.equal(alone.length, 1);
      assert.equal(alone[0].contested, true, 'the counterpart is asked how many rows it could settle, not this call');
      assert.equal(alone[0].other_transaction_id, null);
    }
    // The same from the payment's own screen.
    const fromBank = await proposals([only]);
    assert.equal(Number(fromBank[0].candidate_count), 2);
    assert.equal(fromBank[0].other_transaction_id, null);
    // Settle one by hand and the other row is left with nothing to claim.
    await link(first, only);
    assert.equal((await proposals([second])).length, 0);
    await unlink(first);
    await q('delete from card_transactions where id = any($1)', [[first, second, only]]);
  });

  await test('the browser role reads the record but cannot reach it as anon', async () => {
    assert.equal(await one("select has_function_privilege('anon','public.link_card_payment_match(uuid,uuid)','execute') as x")
      .then((r) => r.x), false);
    assert.equal(await one("select has_function_privilege('anon','public.card_payment_match_options(uuid,integer)','execute') as x")
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
