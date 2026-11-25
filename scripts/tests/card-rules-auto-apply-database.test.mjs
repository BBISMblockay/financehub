// Saved rules applied without a page, and "already in QuickBooks", executed
// against the real migration (20261125130000) on PGlite.
//
// What is proven:
//   1. card_coding_infer_treatment gives exactly what the page's
//      inferTreatment() gives (v2/transaction-dates.js, loaded and run here),
//      over every origin, account type, source type and direction.
//   2. apply_saved_card_coding_rules writes what the page's applyRules()
//      would save -- account, location, entity, type, rule id, hit count --
//      through apply_card_coding, and nothing for: a row a person has saved,
//      an account that is switched off, a locked month, a rule conflict, an
//      account missing from the chart, a type that cannot be read, another
//      company's rule. A skipped row never hides the rows after it.
//   3. It is not reachable from the browser.
//   4. An entry marked as entered by hand cannot be claimed for sending, a
//      send on record refuses the mark, the mark comes off again, and only a
//      finance user of the entry's own company can do either.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_RULES_AUTO_MUTATION=touched-rows     a row a person saved is categorized again
//   CARD_RULES_AUTO_MUTATION=auto-off         an account that is switched off is categorized
//   CARD_RULES_AUTO_MUTATION=unknown-type     a bank row is categorized with no readable type
//   CARD_RULES_AUTO_MUTATION=any-chart        an account missing from the chart is used
//   CARD_RULES_AUTO_MUTATION=limit-on-seen    skipped rows use up the limit
//   CARD_RULES_AUTO_MUTATION=browser-callable a signed-in browser can run it
//   CARD_RULES_AUTO_MUTATION=guard-off        a marked entry can still be claimed
//   CARD_RULES_AUTO_MUTATION=stale-mark-blocks      a mark holds back content it was never made on
//   CARD_RULES_AUTO_MUTATION=unknown-content-sends  a claim that cannot be compared is let through
//   CARD_RULES_AUTO_MUTATION=mark-keeps-old         marking again keeps the old content's mark
//   CARD_RULES_AUTO_MUTATION=fingerprint-no-coding  a recoded month still matches its mark
//   CARD_RULES_AUTO_MUTATION=fingerprint-no-text    a changed description or memo still matches its mark
//   CARD_RULES_AUTO_MUTATION=fingerprint-no-uncoded a late uncategorized row still matches its mark
//   CARD_RULES_AUTO_MUTATION=list-any-role          a non-finance user can read the marks list
//   CARD_RULES_AUTO_MUTATION=mark-after-send  an entry SILO sent can be marked by hand
//   CARD_RULES_AUTO_MUTATION=mark-any-role    a non-finance user can mark an entry
//   CARD_RULES_AUTO_MUTATION=infer-drift      the SQL type reading drifts from the page's
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'touched-rows': [["       and x.status = 'uncoded' and x.qbo_account_id is null and x.updated_by is null\n", "       and x.status = 'uncoded' and x.qbo_account_id is null\n"],
    ['if t.id is null or b.id is null or s.id is null or t.updated_by is not null\n', 'if t.id is null or b.id is null or s.id is null\n']],
  'auto-off': [["     where xb.status in ('draft', 'categorized') and xs.is_active and xs.auto_prepare_coding\n", "     where xb.status in ('draft', 'categorized') and xs.is_active\n"],
    ['         or not s.is_active or not s.auto_prepare_coding\n', '         or not s.is_active\n']],
  'unknown-type': ["      if v_treatment = 'unknown' then raise exception using message = 'needs_type'; end if;\n", ''],
  'any-chart': ["      if v_type is null then raise exception using message = 'account_unavailable'; end if;\n", ''],
  'limit-on-seen': ['if v_applied >= v_limit or v_seen >= 20000 then', 'if v_seen >= v_limit then'],
  'browser-callable': ['revoke all on function public.apply_saved_card_coding_rules(integer) from public, anon, authenticated;', 'grant execute on function public.apply_saved_card_coding_rules(integer) to authenticated;'],
  'guard-off': ['  if v_now is null or v_now = v_snapshot then\n    raise', '  if false then\n    raise'],
  'stale-mark-blocks': ['  if v_now is null or v_now = v_snapshot then\n    raise', '  if true then\n    raise'],
  'unknown-content-sends': ['  if v_now is null or v_now = v_snapshot then\n    raise', '  if v_now = v_snapshot then\n    raise'],
  'mark-keeps-old': ["    on conflict (company_entity_id, source, source_ref) do update\n      set snapshot = excluded.snapshot, created_by = excluded.created_by, created_at = now()\n      where quickbooks_entered_by_hand.snapshot is distinct from excluded.snapshot;", '    on conflict (company_entity_id, source, source_ref) do nothing;'],
  'fingerprint-no-coding': ["e.txn_date::text, coalesce(e.qbo_account_id, ''),", "e.txn_date::text, '',"],
  'fingerprint-no-text': ["md5(coalesce(e.description, '')), md5(coalesce(e.memo, '')), e.is_split::text)", "e.is_split::text)"],
  'fingerprint-no-uncoded': ["and t.status = 'uncoded')::text)", "and t.status = 'none')::text)"],
  'list-any-role': ["     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then\n    raise exception 'Finance access required' using errcode = '42501';\n  end if;\n  return query", '  then raise exception \'x\'; end if;\n  return query'],
  'mark-after-send': ["        and p.status in ('submitting', 'unknown', 'posted')) then\n    raise exception 'SILO has a send on record", "        and p.status in ('none')) then\n    raise exception 'SILO has a send on record"],
  'mark-any-role': ["  if not public.can_manage_journal_entries() then raise exception 'Finance access required'; end if;\n  if p_id is null", '  if p_id is null'],
  'infer-drift': ["      case when p_source_type = 'bank' then 'card_payment' else 'unknown' end", "      'card_payment'"],
};
const mutation = process.env.CARD_RULES_AUTO_MUTATION || '';
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
  '20260923120000_card_coding_suggestions.sql', '20260923130000_card_coding_background_preparation.sql',
  '20260923140000_card_coding_evidence_and_rules.sql',
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
const svc = (fn) => as(null, fn, 'service_role');
const apply = async (limit = 500) => (await svc(() => one('select public.apply_saved_card_coding_rules($1) r', [limit]))).r;

const co = randomUUID(), other = randomUUID(), finance = randomUUID(), outsider = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID();
const bank = randomUUID(), card = randomUUID(), offBank = randomUUID(), otherBank = randomUUID();
const plaidConn = randomUUID(), plaidBank = randomUUID(), plaidCard = randomUUID();

async function newBatch(source, { status = 'draft', origin = 'csv', company = co, connection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status,origin,qbo_connection_id)
           values($1,$2,$3,'Batch','2026-10-31','draft',$4,$5)`, [id, company, source, origin, connection]);
  if (status !== 'draft') {
    await db.exec('set session_replication_role = replica');
    try { await q('update card_import_batches set status=$2 where id=$1', [id, status]); } finally { await db.exec('set session_replication_role = origin'); }
  }
  return id;
}
let rowNo = 0;
async function newTxn(batchId, amount, description, { company = co, cardName = null } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,card_name,amount,currency,status)
           values($1,$2,$3,$4,'2026-10-15',$5,$5,$6,$7,'USD','uncoded')`, [id, company, batchId, ++rowNo, description, cardName, amount]);
  return id;
}
async function plaidTxn(batchId, amount, description, account, treatment = 'unknown') {
  const id = await newTxn(batchId, amount, description);
  await q(`update card_transactions set origin='plaid', plaid_account_id=$2, external_transaction_id=$1,
           provider_status='posted', provider_updated_at=now() - interval '1 day', accounting_treatment=$3 where id=$1`, [id, account, treatment]);
  return id;
}
async function rule({ src, pattern, direction = 'outflow', account = 'supplies', field = 'merchant', type = 'normalized', treatment = 'unknown',
  location = null, entity = null, company = co }) {
  const id = randomUUID();
  await q(`insert into card_coding_rules(id,company_entity_id,source_id,match_field,match_type,pattern,direction,qbo_account_id,qbo_account_name,
             qbo_location_id,entity_qbo_id,entity_name,entity_type,vendor_name,accounting_treatment,priority,hit_count,is_active)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,100,0,true)`,
    [id, company, src, field, type, pattern, direction, account, account ? 'Rule ' + account : null, location, entity,
     entity ? 'Entity ' + entity : null, entity ? 'Vendor' : null, 'Vendor ' + pattern, treatment]);
  return id;
}
const row = (id) => one('select * from card_transactions where id=$1', [id]);
const hits = async (id) => (await one('select hit_count from card_coding_rules where id=$1', [id])).hit_count;

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  await db.exec(`do $$ begin if to_regprocedure('public.attach_stamp_company_entity_id_triggers()') is null then
    execute 'create function public.attach_stamp_company_entity_id_triggers() returns void language sql as ''select''';
  end if; end $$`);
  let sql = await readFile(new URL('supabase/migrations/20261125130000_rules_auto_apply_and_entered_by_hand.sql', root), 'utf8');
  if (mutation) {
    const pairs = Array.isArray(MUTATIONS[mutation][0]) ? MUTATIONS[mutation] : [MUTATIONS[mutation]];
    for (const [from, to] of pairs) {
      assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
      sql = sql.replace(from, to);
    }
  }
  // Idempotent: the apply-all file may run it twice.
  await db.exec(sql); await db.exec(sql);

  await q("insert into entities(id,title) values($1,'A'),($2,'B')", [co, other]);
  await q('insert into auth.users(id) values($1),($2),($3)', [finance, outsider, otherFinance]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'F','user','finance',$4),($2,'O','user','marketing',$4),($3,'B','user','finance',$5)`, [finance, outsider, otherFinance, co, other]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($4,$5,'member')`,
    [co, finance, outsider, other, otherFinance]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','s'),($3,$4,'r2','s')", [conn, co, otherConn, other]);
  for (const [company, connection, id, type, active] of [
    [co, conn, 'supplies', 'Expense', true], [co, conn, 'meals', 'Expense', true], [co, conn, 'sales', 'Income', true],
    [co, conn, 'clearing', 'Other Current Liability', true], [co, conn, 'visa', 'Credit Card', true],
    [co, conn, 'retired', 'Expense', false], [other, otherConn, 'supplies', 'Expense', true], [other, otherConn, 'other-only', 'Expense', true]]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,$5)',
      [company, connection, id, type, active]);
  }
  await q(`insert into quickbooks_locations(company_entity_id,connection_id,qbo_location_id,name,is_active) values($1,$2,'hq','HQ',true),($1,$2,'store','Store',true)`, [co, conn]);
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,
             default_qbo_location_id,default_qbo_location_name,is_active,auto_prepare_coding)
           values($1,$2,$3,'bank','Operating','bank','bk','Operating','hq','Stale name',true,true),
                 ($4,$2,$3,'card','Card','card','cc','Card',null,null,true,true),
                 ($5,$2,$3,'off','Off','bank','bk2','Off',null,null,true,false),
                 ($6,$7,$8,'bank','Other','bank','bk','Other',null,null,true,true)`,
    [bank, co, conn, card, offBank, otherBank, other, otherConn]);
  await q(`insert into plaid_connections(id,company_entity_id,item_id,environment,institution_name) values($1,$2,'item','sandbox','Bank')`, [plaidConn, co]);
  await q(`insert into plaid_accounts(id,company_entity_id,connection_id,provider_account_id,name,type,source_id)
           values($1,$2,$3,'a1','Checking','depository',$4),($5,$2,$3,'a2','Card','credit',$6)`, [plaidBank, co, plaidConn, bank, plaidCard, card]);

  await test('the SQL type reading is the page\'s inferTreatment, case for case', async () => {
    const window = {};
    vm.runInNewContext(fs.readFileSync(new URL('../../v2/transaction-dates.js', import.meta.url), 'utf8'),
      { window, Date, JSON, Number, Object, String, Array, Math, localStorage: undefined, sessionStorage: undefined });
    const infer = window.SiloTransactionDates.inferTreatment;
    const types = ['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset', 'Accounts Payable', 'Credit Card',
      'Other Current Liability', 'Long Term Liability', 'Equity', 'Income', 'Other Income', 'Cost of Goods Sold', 'Expense', 'Other Expense', null];
    let checked = 0;
    for (const origin of ['plaid', 'manual', 'csv']) for (const type of types) for (const sourceType of ['bank', 'card']) for (const amount of [25, -25, 0]) {
      const js = infer({ origin, qbo_account_id: 'x', amount, accounting_treatment: 'unknown' }, type, sourceType);
      const got = (await one('select public.card_coding_infer_treatment($1,$2,$3,$4) r', [origin, type, sourceType, amount])).r;
      // A CSV line keeps whatever type it has: the page returns the row's own
      // value, the SQL returns NULL ("leave it alone").
      assert.equal(got, origin === 'csv' ? null : js, `${origin} / ${type} / ${sourceType} / ${amount}`);
      checked += 1;
    }
    assert.equal(checked, 288);
  });

  const month = await newBatch(bank);
  const staples = await rule({ src: bank, pattern: 'staples', account: 'supplies', entity: 'v9' });
  const plain = await newTxn(month, 20, 'STAPLES');

  await test('a row a saved rule answers is categorized the way the page would save it', async () => {
    const typeBefore = (await row(plain)).accounting_treatment;
    const out = await apply();
    assert.equal(out.applied, 1, JSON.stringify(out));
    const t = await row(plain);
    assert.deepEqual([t.status, t.qbo_account_id, t.qbo_account_name, t.coding_source, Number(t.confidence), t.rule_id, t.coding_conflict],
      ['coded', 'supplies', 'Rule supplies', 'rule', 1, staples, null]);
    // No rule location: the account's default, named from the current list.
    assert.deepEqual([t.qbo_location_id, t.qbo_location_name], ['hq', 'HQ']);
    assert.deepEqual([t.entity_qbo_id, t.entity_name, t.entity_type, t.vendor_name], ['v9', 'Entity v9', 'Vendor', 'Vendor staples']);
    assert.equal(t.updated_by, null, 'no person is recorded as having saved it');
    assert.equal(t.accounting_treatment, typeBefore, 'a CSV line keeps the type it had');
    assert.equal(await hits(staples), 1, 'the rule\'s hit count moved, as on the page');
    assert.deepEqual(await apply(), { applied: 0, skipped: {}, more: false }, 'a second run finds nothing: it is idempotent');
  });

  await test('a bank-feed row takes its type from the rule, else from the category', async () => {
    const feed = await newBatch(bank, { origin: 'plaid' });
    await rule({ src: bank, pattern: 'gusto', account: 'clearing', treatment: 'payroll_settlement' });
    await rule({ src: bank, pattern: 'shell', account: 'meals', location: 'store' });
    await rule({ src: bank, pattern: 'customer pay', direction: 'inflow', account: 'sales' });
    await rule({ src: bank, pattern: 'visa payment', account: 'visa' });
    const payroll = await plaidTxn(feed, 900, 'GUSTO', plaidBank), fuel = await plaidTxn(feed, 40, 'SHELL', plaidBank);
    const income = await plaidTxn(feed, -300, 'CUSTOMER PAY', plaidBank), paydown = await plaidTxn(feed, 500, 'VISA PAYMENT', plaidBank);
    const out = await apply();
    assert.equal(out.applied, 4, JSON.stringify(out));
    assert.equal((await row(payroll)).accounting_treatment, 'payroll_settlement');
    assert.deepEqual([(await row(fuel)).accounting_treatment, (await row(fuel)).qbo_location_id, (await row(fuel)).qbo_location_name], ['purchase', 'store', 'Store']);
    assert.equal((await row(income)).accounting_treatment, 'deposit');
    assert.equal((await row(paydown)).accounting_treatment, 'card_payment');
  });

  await test('what it must not touch stays exactly as it was, and says why', async () => {
    const b = await newBatch(bank);
    // A person cleared this one by hand.
    const cleared = await newTxn(b, 21, 'STAPLES');
    await q('update card_transactions set updated_by=$2 where id=$1', [cleared, finance]);
    // An account that is switched off.
    const offMonth = await newBatch(offBank);
    await rule({ src: offBank, pattern: 'staples' });
    const off = await newTxn(offMonth, 22, 'STAPLES');
    // An approved month.
    const locked = await newBatch(bank);
    const lockedRow = await newTxn(locked, 23, 'STAPLES');
    await db.exec('set session_replication_role = replica');
    await q("update card_import_batches set status='approved' where id=$1", [locked]);
    await db.exec('set session_replication_role = origin');
    // The merchant and the card disagree.
    await rule({ src: bank, pattern: 'comcast', account: 'meals' });
    await rule({ src: bank, pattern: 'jackie', field: 'card_name', type: 'exact', account: 'sales' });
    const conflict = await newTxn(b, 24, 'COMCAST', { cardName: 'Jackie' });
    // The rule's account left the chart; another rule names one only another company has.
    await rule({ src: bank, pattern: 'old vendor', account: 'retired' });
    await rule({ src: bank, pattern: 'foreign', account: 'other-only' });
    const retired = await newTxn(b, 25, 'OLD VENDOR'), foreign = await newTxn(b, 26, 'FOREIGN');
    // Only another company's rule matches.
    await rule({ src: otherBank, pattern: 'nobody', company: other });
    const nobody = await newTxn(b, 27, 'NOBODY');
    const before = await Promise.all([cleared, off, lockedRow, conflict, retired, foreign, nobody].map(row));
    const out = await apply();
    assert.equal(out.applied, 0, JSON.stringify(out));
    assert.deepEqual(out.skipped, { account_unavailable: 2 }, 'the two chart misses are counted; the rest were never candidates');
    assert.deepEqual(await Promise.all([cleared, off, lockedRow, conflict, retired, foreign, nobody].map(row)), before);
    // Take these out of the way of the tests below.
    await q("update card_coding_rules set is_active=false where pattern in ('old vendor','foreign')");
  });

  await test('a bank-feed row whose type cannot be read is left for a person', async () => {
    const cardFeed = await newBatch(card, { origin: 'plaid' });
    await rule({ src: card, pattern: 'weird', account: 'visa' });
    const weird = await plaidTxn(cardFeed, 60, 'WEIRD', plaidCard, 'purchase');
    const out = await apply();
    assert.deepEqual([out.applied, out.skipped], [0, { needs_type: 1 }], JSON.stringify(out));
    assert.equal((await row(weird)).status, 'uncoded');
    await q("update card_coding_rules set is_active=false where pattern='weird'");
  });

  await test('the limit counts rows categorized, so a skipped row never hides the ones after it', async () => {
    const first = await newBatch(bank), second = await newBatch(bank);
    const [lo, hi] = [first, second].sort();
    await q("update card_coding_rules set is_active=true where pattern='old vendor'");
    await newTxn(lo, 30, 'OLD VENDOR'); await newTxn(lo, 31, 'OLD VENDOR');
    const a = await newTxn(hi, 32, 'STAPLES'), b = await newTxn(hi, 33, 'STAPLES');
    const one1 = await apply(1);
    assert.deepEqual([one1.applied, one1.more], [1, true], JSON.stringify(one1));
    const two = await apply(1);
    assert.equal(two.applied, 1, JSON.stringify(two));
    assert.deepEqual([(await row(a)).status, (await row(b)).status], ['coded', 'coded']);
    await q("update card_coding_rules set is_active=false where pattern='old vendor'");
  });

  await test('it is not reachable from the browser', async () => {
    for (const role of ['authenticated', 'anon']) {
      await assert.rejects(as(role === 'anon' ? null : finance, () => q('select public.apply_saved_card_coding_rules(10)'), role), /permission denied/);
    }
    await assert.rejects(as(finance, () => q(`insert into quickbooks_entered_by_hand(company_entity_id,source,source_ref) values($1,'card_import','x')`, [co])), /permission denied|row-level security/);
    await assert.rejects(as(finance, () => q('select public.quickbooks_entry_lock($1,$2,$3)', [co, 'a', 'b'])), /permission denied/);
  });

  // ── Already in QuickBooks ─────────────────────────────────────────────────
  const mark = (kind, id, on = true, actor = finance) => as(actor, () => one('select public.set_entry_entered_in_quickbooks($1,$2,$3) r', [kind, id, on]));
  const HASH = 'h'.repeat(64), HASH2 = 'i'.repeat(64);
  // A sending claim carries the approval hash of what it sends (payload_hash).
  const claim = (source, ref, hash = HASH, company = co) => svc(() => q(
    `insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,payload,payload_hash,status)
     values($1,$2,$3,$4,'{}',$5,'submitting') returning id`, [company, company === co ? conn : otherConn, source, ref, hash]));
  const quietly = async (sql, params) => {
    await db.exec('set session_replication_role = replica');
    try { await q(sql, params); } finally { await db.exec('set session_replication_role = origin'); }
  };
  async function adjustment({ source = 'prepaid_amortization', ref = '2026-10', status = 'approved', company = co, hash = HASH } = {}) {
    const id = randomUUID();
    await quietly(`insert into journal_adjustments(id,company_entity_id,entry_date,memo,status,accounting_source,accounting_source_ref,approval_hash,qbo_connection_id)
               values($1,$2,'2026-10-31','Prepaid',$3,$4,$5,$6,$7)`, [id, company, status, source, ref, hash, company === co ? conn : otherConn]);
    return id;
  }
  const marks = (actor = finance) => as(actor, () => q('select * from public.quickbooks_entered_by_hand_list()'));
  const markOf = async (source, ref) => (await marks()).find((m) => m.source === source && m.source_ref === ref);

  await test('a marked entry cannot be claimed for sending, and the mark comes off again', async () => {
    const adj = await adjustment();
    assert.deepEqual((await mark('adjustment', adj)).r, { marked: true });
    assert.deepEqual((await mark('adjustment', adj)).r, { marked: true }, 'marking twice is harmless');
    const seen = await as(finance, () => q('select source, source_ref, snapshot, created_by from quickbooks_entered_by_hand'));
    assert.deepEqual(seen, [{ source: 'prepaid_amortization', source_ref: '2026-10', snapshot: HASH, created_by: finance }]);
    await assert.rejects(claim('prepaid_amortization', '2026-10'), /already entered in QuickBooks by hand/);
    await assert.rejects(claim('prepaid_amortization', '2026-10', null), /already entered in QuickBooks by hand/, 'a claim that cannot be compared is refused');
    assert.equal((await q("select 1 from quickbooks_journal_postings where source='prepaid_amortization'")).length, 0, 'no claim was written');
    // Another entry, and another company's entry with the same key, are not held.
    assert.equal((await claim('prepaid_amortization', '2026-09')).length, 1);
    assert.deepEqual((await mark('adjustment', adj, false)).r, { marked: false });
    assert.equal((await claim('prepaid_amortization', '2026-10')).length, 1, 'with the mark off it can be sent');
  });

  await test('an entry SILO has a send on record for cannot be marked; nor one that is posted, voided or not yet approved', async () => {
    const sent = await adjustment({ ref: '2026-09' });   // claimed above
    await assert.rejects(mark('adjustment', sent), /send on record/);
    const posted = await adjustment({ ref: '2026-08', status: 'posted' });
    await assert.rejects(mark('adjustment', posted), /already sent this entry, or it was voided/);
    const draft = await adjustment({ ref: '2026-06', status: 'draft', hash: null });
    await assert.rejects(mark('adjustment', draft), /Approve this entry first/);
    const legacy = await adjustment({ source: null, ref: null });
    assert.deepEqual((await mark('adjustment', legacy)).r, { marked: true });
    await assert.rejects(claim('journal_adjustment', legacy), /already entered in QuickBooks by hand/, 'a legacy entry is keyed the way its claim is');
  });

  await test('a journal entry approved again after it was marked is not held back by the old mark', async () => {
    const adj = await adjustment({ ref: '2026-05' });
    await mark('adjustment', adj);
    assert.deepEqual(await markOf('prepaid_amortization', '2026-05'), { source: 'prepaid_amortization', source_ref: '2026-05', snapshot: HASH, current: null });
    // Changed and approved again under the same reference: new content, new hash.
    await quietly('update journal_adjustments set approval_hash=$2 where id=$1', [adj, HASH2]);
    await assert.rejects(claim('prepaid_amortization', '2026-05', HASH), /already entered in QuickBooks by hand/, 'the content that WAS marked stays held');
    // A person says the new content is in QuickBooks too: the mark moves to it.
    assert.deepEqual((await mark('adjustment', adj)).r, { marked: true });
    assert.equal((await markOf('prepaid_amortization', '2026-05')).snapshot, HASH2);
    await assert.rejects(claim('prepaid_amortization', '2026-05', HASH2), /already entered in QuickBooks by hand/);
    await quietly('update journal_adjustments set approval_hash=$2 where id=$1', [adj, HASH]);
    assert.equal((await claim('prepaid_amortization', '2026-05', HASH)).length, 1, 'content the mark was never made on goes out');
  });

  await test('a card or bank month is marked by its own id, for the content it held', async () => {
    // An account with no bank feed: the feed's own claim guard would refuse a
    // draft month before this one is ever asked.
    const b = await newBatch(offBank);
    const first = await newTxn(b, 40, 'PAPER CO');
    await quietly("update card_transactions set status='coded', qbo_account_id='supplies' where id=$1", [first]);
    assert.deepEqual((await mark('batch', b)).r, { marked: true });
    const made = await markOf('card_import', b);
    assert.ok(made.snapshot && made.snapshot === made.current, 'the list reports the mark as still speaking for the month');
    await assert.rejects(claim('card_import', b), /already entered in QuickBooks by hand/);
    // Approving the unchanged month does not disturb the mark.
    await quietly("update card_import_batches set status='categorized' where id=$1", [b]);
    assert.equal((await markOf('card_import', b)).current, made.snapshot);

    // A recoding changes what would be sent.
    await quietly("update card_transactions set qbo_account_id='meals' where id=$1", [first]);
    const recoded = await markOf('card_import', b);
    assert.notEqual(recoded.current, recoded.snapshot);
    await quietly("update card_transactions set qbo_account_id='supplies' where id=$1", [first]);
    assert.equal((await markOf('card_import', b)).current, made.snapshot, 'put back, it is the marked content again');

    // The words on the QuickBooks line are part of what was marked: a memo or
    // description corrected on its own is a change too.
    for (const column of ['memo', 'description']) {
      await quietly(`update card_transactions set ${column}='corrected wording' where id=$1`, [first]);
      assert.notEqual((await markOf('card_import', b)).current, made.snapshot, `${column} alone`);
      await quietly(`update card_transactions set ${column}=$2 where id=$1`, [first, column === 'memo' ? null : 'PAPER CO']);
      assert.equal((await markOf('card_import', b)).current, made.snapshot);
    }

    // A late bank row lands uncategorized: the month is no longer what was marked.
    const late = await newTxn(b, 12.5, 'LATE ROW');
    assert.notEqual((await markOf('card_import', b)).current, made.snapshot);
    await quietly("update card_transactions set status='coded', qbo_account_id='supplies' where id=$1", [late]);
    assert.notEqual((await markOf('card_import', b)).current, made.snapshot);
    // Marking again is a fresh decision about the month as it is now.
    assert.deepEqual((await mark('batch', b)).r, { marked: true });
    const again = await markOf('card_import', b);
    assert.ok(again.snapshot === again.current && again.snapshot !== made.snapshot);
    await assert.rejects(claim('card_import', b), /already entered in QuickBooks by hand/);
    // Changed once more and NOT marked again: SILO may send it.
    await quietly("update card_transactions set amount=13 where id=$1", [late]);
    assert.equal((await claim('card_import', b)).length, 1, 'changed content is not held back by an old mark');
    assert.deepEqual((await mark('batch', b, false)).r, { marked: false });
  });

  await test('only a finance user of the entry\'s own company can mark or read', async () => {
    const adj = await adjustment({ ref: '2026-07' });
    await assert.rejects(mark('adjustment', adj, true, outsider), /Finance access required/);
    await assert.rejects(mark('adjustment', adj, true, otherFinance), /not found in this company/);
    await assert.rejects(mark('nonsense', adj), /Name one entry/);
    await mark('adjustment', adj);
    assert.equal((await as(outsider, () => q('select 1 from quickbooks_entered_by_hand'))).length, 0);
    assert.equal((await as(otherFinance, () => q('select 1 from quickbooks_entered_by_hand'))).length, 0);
    assert.ok((await as(finance, () => q('select 1 from quickbooks_entered_by_hand'))).length >= 1);
    await assert.rejects(marks(outsider), /Finance access required/);
    assert.equal((await marks(otherFinance)).length, 0);
    assert.ok((await marks()).some((m) => m.source_ref === '2026-07'));
    await assert.rejects(as(finance, () => q('select public.card_import_content_fingerprint($1,$2)', [co, randomUUID()])), /permission denied/);
  });

  await test('the production check for this migration reads ok on a database that has it', async () => {
    const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const from = verify.indexOf("select 'Saved rules auto-apply and entered by hand' as check_name");
    assert.ok(from > 0);
    const sql = verify.slice(from, verify.indexOf('end as status;', from) + 'end as status;'.length);
    const expected = ['guard-off', 'stale-mark-blocks', 'unknown-content-sends', 'browser-callable'].includes(mutation) ? null : 'ok';
    const status = (await one(sql)).status;
    if (expected) assert.equal(status, expected); else assert.notEqual(status, 'ok');
  });

  console.log(`${passed} rules auto-apply database checks passed`);
} finally { await db.close(); }
