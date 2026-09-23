// Coding evidence retrieval and saved-rule matching, executed against the real
// migrations (20260923140000).
//
// What is proven:
//   1. card_coding_history_evidence returns only THIS company's history, only
//      for THIS QuickBooks connection (the batch's own binding, else its
//      source's), only confirmed codings, never later than each merchant's own
//      "before" date, with bank direction respected, the settlement leg and
//      zero lines excluded, overlapping snapshots deduplicated, payee / memo /
//      similar matches told apart, and a per-merchant cap applied AFTER
//      matching with exact matches kept ahead of similar ones -- and it says
//      how many matched, so a cap is visible.
//   2. The JavaScript stand-in the categorizer suites use returns exactly
//      what this SQL returns over the same fixtures.
//   3. card_coding_rule_match makes the page's decision: bank rules must name
//      this source and direction, a merchant rule outranks a card rule unless
//      they disagree (a conflict answers nothing), a rule with no account
//      answers nothing, and ties break the way the page's sort does.
//      card_coding_needs_preparation says 'rule_applies' for those rows and
//      card_coding_rule_answered lists them, company-scoped.
//   4. None of it is reachable from the browser.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_EVIDENCE_MUTATION=ai-unconfirmed     an AI coding counts before its batch is approved
//   CARD_EVIDENCE_MUTATION=any-connection     history from another QuickBooks realm counts
//   CARD_EVIDENCE_MUTATION=later-history      history dated after the merchant's line counts
//   CARD_EVIDENCE_MUTATION=cap-before-rank    the cap keeps the newest lines, similar ones included
//   CARD_EVIDENCE_MUTATION=ledger-any-import  another connection's ledger import counts
//   CARD_EVIDENCE_MUTATION=bank-any-direction a bank feed takes a rule scoped to the other direction
//   CARD_EVIDENCE_MUTATION=conflict-ignored   a merchant rule wins over a card rule that disagrees
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { historyEvidence } from './lib/history-evidence-fake.mjs';

const MUTATIONS = {
  'ai-unconfirmed': ["(t.coding_source = 'ai' and b.status in ('approved', 'posted'))", "t.coding_source = 'ai'"],
  'any-connection': ['      and coalesce(b.qbo_connection_id, s.qbo_connection_id) = p_connection\n', ''],
  'later-history': ['a.txn_date between p.lo and p.d', 'a.txn_date >= p.lo'],
  'cap-before-rank': ['order by u.rank, u.dt desc, u.tie', 'order by u.dt desc, u.tie'],
  'ledger-any-import': ['where h.company_entity_id = p_company and im.qbo_connection_id = p_connection', 'where h.company_entity_id = p_company'],
  'bank-any-direction': ["      and case when v_bank then r.source_id = s.id and r.direction = v_dir\n", "      and case when v_bank then r.source_id = s.id\n"],
  'conflict-ignored': ["  if m.id is not null and c.id is not null and (m.qbo_account_id is distinct from c.qbo_account_id", "  if false and (m.qbo_account_id is distinct from c.qbo_account_id"],
};
const mutation = process.env.CARD_EVIDENCE_MUTATION || '';
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

const co = randomUUID(), other = randomUUID(), user = randomUUID();
const conn = randomUUID(), oldConn = randomUUID(), otherConn = randomUUID();
const card = randomUUID(), bank = randomUUID(), oldCard = randomUUID(), otherCard = randomUUID();
const importHere = randomUUID(), importHere2 = randomUUID(), importOld = randomUUID(), importOther = randomUUID();
// A plain-row mirror of what is inserted, for the JavaScript stand-in.
const mirror = { card_transactions: [], card_import_batches: [], card_sources: [], qbo_history_imports: [], qbo_history_lines: [], quickbooks_connections: [] };

async function source(id, company, connection, type, key) {
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active)
           values($1,$2,$3,$4,$4,$5,'cc','Card',true)`, [id, company, connection, key, type]);
  mirror.card_sources.push({ id, company_entity_id: company, qbo_connection_id: connection });
}
// Rows can only be added to an open import, so every import starts as a
// draft and settle() moves it to the status the fixture wants -- with the
// guard triggers bypassed, since this is fixture setup, not a posting.
async function batch(src, { status = 'posted', company = co, connection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,status,origin,qbo_connection_id)
           values($1,$2,$3,'B','2026-09-30','draft','csv',$4)`, [id, company, src, connection]);
  mirror.card_import_batches.push({ id, company_entity_id: company, source_id: src, status, qbo_connection_id: connection });
  return id;
}
async function settle() {
  await db.exec('set session_replication_role = replica');
  try {
    for (const b of mirror.card_import_batches) await q('update card_import_batches set status=$2 where id=$1 and status is distinct from $2', [b.id, b.status]);
  } finally { await db.exec('set session_replication_role = origin'); }
}
let rowNo = 0;
async function txn(batchId, { company = co, date = '2026-06-01', merchant = 'Office Depot', clean = null, amount = 20, account = 'supplies',
  status = 'coded', codingSource = 'manual', card: cardName = null } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,'USD',$10,$11,$11,$12)`,
    [id, company, batchId, ++rowNo, date, merchant, clean, cardName, amount, status, status === 'coded' ? account : null, status === 'coded' ? codingSource : null]);
  mirror.card_transactions.push({ id, company_entity_id: company, batch_id: batchId, txn_date: date, description: merchant, clean_merchant: clean,
    amount, status, qbo_account_id: status === 'coded' ? account : null, qbo_account_name: status === 'coded' ? account : null, coding_source: status === 'coded' ? codingSource : null });
  return id;
}
async function historyImport(id, company, connection) {
  await q(`insert into qbo_history_imports(id,company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,currency,accounting_basis,
             source_hash,source_snapshot,reconciliation,reconciliation_status,exception_count,transaction_count,created_by)
           values($1,$2,$3,gen_random_uuid(),gen_random_uuid(),'2024-01-01','2026-08-31','USD','Accrual',$5,'{}','{}','matched',0,0,$4)`,
    [id, company, connection, user, `hash-${id}`]);
  mirror.qbo_history_imports.push({ id, company_entity_id: company, qbo_connection_id: connection });
}
let lineNo = 0;
async function line(importId, { company = co, account = 'supplies', type = 'Expense', date = '2026-05-01', payee = 'Office Depot', memo = null,
  txnId = randomUUID(), amount = 20, kind = 'transaction' } = {}) {
  const id = randomUUID();
  await q(`insert into qbo_history_lines(id,company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,transaction_date,qbo_transaction_id,counterparty,memo,natural_amount,natural_balance,raw_row)
           values($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,0,'{}')`,
    [id, company, importId, ++lineNo, kind, account, type, date, txnId, payee, memo, amount]);
  mirror.qbo_history_lines.push({ id, company_entity_id: company, import_id: importId, row_kind: kind, qbo_account_id: account, account_name: account,
    account_type: type, transaction_date: date, qbo_transaction_id: txnId, counterparty: payee, memo, natural_amount: amount });
  return id;
}
async function evidence(pairs, { company = co, connection = conn, perKey = 100, exclude = [] } = {}) {
  const sql = await svc(() => one('select card_coding_history_evidence($1,$2,$3,$4,$5) r', [company, connection, JSON.stringify(pairs), perKey, exclude]));
  const js = historyEvidence(mirror, { p_company: company, p_connection: connection, p_pairs: pairs, p_per_key: perKey, p_exclude: exclude });
  const norm = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)));
  // The stand-in must agree with the SQL, row for row, or the categorizer
  // suites that rely on it are testing something that is not deployed.
  // (CARD_EVIDENCE_NO_PARITY=1 turns it off, so a mutation run can show that
  // the behavioural assertions below catch the mutation on their own.)
  if (!process.env.CARD_EVIDENCE_NO_PARITY) assert.deepEqual(norm(js.data), norm(sql.r), 'the JavaScript stand-in matches the SQL');
  return sql.r;
}
const accountsOf = (r, src) => r.rows.filter((x) => x.src === src).map((x) => x.account_id).sort();

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  let sql = await readFile(new URL('supabase/migrations/20260923140000_card_coding_evidence_and_rules.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale`);
    sql = sql.replace(from, to);
  }
  await db.exec(sql); await db.exec(sql);

  await q("insert into entities(id,title) values($1,'A'),($2,'B')", [co, other]);
  await q('insert into auth.users(id) values($1)', [user]);
  await q("insert into profiles(id,name,role,department,active_company_id) values($1,'F','user','finance',$2)", [user, co]);
  await q("insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member')", [co, user]);
  await q(`insert into quickbooks_connections(id,company_entity_id,realm_id,access_token) values($1,$2,'r','s'),($3,$2,'r-old','s'),($4,$5,'r2','s')`,
    [conn, co, oldConn, otherConn, other]);
  mirror.quickbooks_connections.push({ id: conn, company_entity_id: co }, { id: oldConn, company_entity_id: co }, { id: otherConn, company_entity_id: other });
  await source(card, co, conn, 'card', 'card');
  await source(bank, co, conn, 'bank', 'bank');
  await source(oldCard, co, oldConn, 'card', 'old');
  await source(otherCard, other, otherConn, 'card', 'other');
  await historyImport(importHere, co, conn); await historyImport(importHere2, co, conn);
  await historyImport(importOld, co, oldConn); await historyImport(importOther, other, otherConn);

  // SILO history for "office depot": what counts and what must not.
  const posted = await batch(card), draft = await batch(card, { status: 'draft' }), approved = await batch(card, { status: 'approved' });
  const voided = await batch(card, { status: 'voided' }), unbound = await batch(card, { connection: null });
  const oldRealm = await batch(card, { connection: oldConn }), oldSource = await batch(oldCard, { connection: null });
  const foreign = await batch(otherCard, { company: other, connection: otherConn });
  await txn(posted, { account: 'supplies' });                                        // counts
  await txn(unbound, { account: 'supplies', date: '2026-05-01' });                   // counts: follows its source
  await txn(approved, { account: 'supplies', codingSource: 'ai', date: '2026-04-01' }); // counts: reviewed
  await txn(draft, { account: 'meals', codingSource: 'ai' });                         // unreviewed AI
  await txn(draft, { account: 'supplies', codingSource: 'manual', date: '2026-03-01' }); // counts: a person
  await txn(voided, { account: 'meals' });                                           // voided
  await txn(oldRealm, { account: 'meals' });                                         // another realm
  await txn(oldSource, { account: 'meals' });                                        // source bound elsewhere
  await txn(foreign, { account: 'meals', company: other });                          // another company
  await txn(posted, { account: 'meals', status: 'uncoded' });                        // not coded
  await txn(posted, { account: 'meals', date: '2026-09-10' });                       // after the anchor
  await txn(posted, { account: 'meals', date: '2024-05-01' });                       // before the window
  await settle();

  await test('SILO history: this company, this realm, confirmed, inside the merchant\'s own window only', async () => {
    const r = await evidence([{ key: 'office depot', before: '2026-09-01' }]);
    assert.deepEqual(accountsOf(r, 'silo'), ['supplies', 'supplies', 'supplies', 'supplies']);
    assert.deepEqual(r.totals, [{ i: 0, src: 'silo', total: 4 }]);
  });

  await test('the window ends at each merchant\'s own date and nothing later is returned', async () => {
    const r = await evidence([{ key: 'office depot', before: '2026-04-15' }, { key: 'office depot', before: '2026-09-30' }]);
    assert.deepEqual(r.rows.filter((x) => x.i === 0).map((x) => x.date).sort(), ['2024-05-01', '2026-03-01', '2026-04-01'], 'its own 24 months, which reach a row the later merchant cannot');
    assert.ok(r.rows.filter((x) => x.i === 1).some((x) => x.date === '2026-09-10'), 'the later merchant does see it');
  });

  await test('an evaluation can exclude the row it is asking about', async () => {
    const target = mirror.card_transactions.find((t) => t.batch_id === posted && t.txn_date === '2026-06-01' && t.status === 'coded');
    const r = await evidence([{ key: 'office depot', before: '2026-06-01' }], { exclude: [target.id] });
    assert.equal(r.rows.some((x) => x.date === '2026-06-01'), false);
  });

  // Bank direction: a Shopify payout and a Shopify subscription share a name.
  const bankBatch = await batch(bank);
  await txn(bankBatch, { merchant: 'SHOPIFY', amount: -500, account: 'clearing', date: '2026-07-01' });
  await txn(bankBatch, { merchant: 'SHOPIFY', amount: 29, account: 'software', date: '2026-07-02' });
  await settle();
  await test('in a bank feed the direction is part of the question', async () => {
    const r = await evidence([{ key: 'shopify', before: '2026-09-01', direction: 'inflow' }, { key: 'shopify', before: '2026-09-01', direction: 'outflow' }]);
    assert.deepEqual(r.rows.filter((x) => x.i === 0).map((x) => x.account_id), ['clearing']);
    assert.deepEqual(r.rows.filter((x) => x.i === 1).map((x) => x.account_id), ['software']);
  });

  // Ledger: payee, memo, similar, the settlement leg, zero lines, snapshots.
  const shared = randomUUID();
  await line(importHere, { payee: 'STATE FARM', account: 'insurance', txnId: shared, date: '2026-02-01' });
  await line(importHere2, { payee: 'STATE FARM', account: 'insurance', txnId: shared, date: '2026-02-01' }); // same line, second snapshot
  await line(importHere, { payee: null, memo: 'STATE FARM #4421', account: 'insurance', date: '2026-03-01' });
  await line(importHere, { payee: 'State Farm Insurance Co', account: 'insurance-gl', date: '2026-04-01' });
  await line(importHere, { payee: 'STATE FARM', account: 'ap', type: 'Accounts Payable', date: '2026-04-02' });
  await line(importHere, { payee: 'STATE FARM', account: 'insurance', kind: 'opening', date: '2026-04-03' });
  await line(importOld, { payee: 'STATE FARM', account: 'old-realm', date: '2026-04-04' });
  await line(importOther, { payee: 'STATE FARM', account: 'foreign', company: other, date: '2026-04-05' });
  await line(importHere, { payee: 'STATE FARM', account: 'sales', type: 'Income', date: '2026-04-06' });
  await line(importHere, { payee: 'STATE FARM', account: 'insurance', date: '2026-10-01' }); // after
  await test('ledger lines: payee, memo and similar told apart; settlement leg, opening rows, other realms and later lines excluded; snapshots deduplicated', async () => {
    const r = await evidence([{ key: 'state farm', before: '2026-09-01' }]);
    const ledger = r.rows.filter((x) => x.src === 'ledger').map((x) => `${x.match}:${x.account_id}:${x.date}`);
    assert.deepEqual(ledger, ['exact:sales:2026-04-06', 'exact:insurance:2026-02-01', 'memo:insurance:2026-03-01', 'similar:insurance-gl:2026-04-01']);
    // An outflow never takes an income line as precedent.
    const out = await evidence([{ key: 'state farm', before: '2026-09-01', direction: 'outflow' }]);
    assert.equal(out.rows.some((x) => x.account_id === 'sales'), false);
  });

  await test('the cap applies per merchant AFTER matching, exact lines first, and says how many matched', async () => {
    for (let i = 0; i < 4; i++) await line(importHere, { payee: 'Acme Supply Company', account: 'similar-acct', date: `2026-08-0${i + 1}` });
    await line(importHere, { payee: 'ACME SUPPLY', account: 'exact-acct', date: '2025-01-01' });
    const r = await evidence([{ key: 'acme supply', before: '2026-09-01' }, { key: 'state farm', before: '2026-09-01' }], { perKey: 2 });
    const acme = r.rows.filter((x) => x.i === 0);
    assert.deepEqual(acme.map((x) => x.account_id), ['exact-acct', 'similar-acct'], 'the older exact line outranks newer similar ones');
    assert.deepEqual(r.totals.find((t) => t.i === 0 && t.src === 'ledger'), { i: 0, src: 'ledger', total: 5 });
    assert.equal(r.rows.filter((x) => x.i === 1).length, 2, 'one busy merchant cannot use up another merchant\'s share');
  });

  await test('bad input and a foreign connection are refused', async () => {
    await assert.rejects(svc(() => q('select card_coding_history_evidence($1,$2,$3)', [co, otherConn, JSON.stringify([{ key: 'x', before: '2026-01-01' }])])), /does not belong/);
    await assert.rejects(svc(() => q('select card_coding_history_evidence($1,$2,$3)', [co, conn, JSON.stringify([{ key: 'x', before: 'soon' }])])), /before date/);
    await assert.rejects(svc(() => q('select card_coding_history_evidence($1,$2,$3)', [co, conn, JSON.stringify(Array.from({ length: 201 }, () => ({ key: 'x', before: '2026-01-01' })))])), /at most 200/);
  });

  // ── Saved rules ───────────────────────────────────────────────────────────
  async function rule({ src = null, field = 'merchant', type = 'normalized', pattern, direction = 'any', account = 'supplies', entity = null, priority = 100, hits = 0, active = true, company = co }) {
    const id = randomUUID();
    await q(`insert into card_coding_rules(id,company_entity_id,source_id,match_field,match_type,pattern,direction,qbo_account_id,qbo_account_name,entity_qbo_id,priority,hit_count,is_active)
             values($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12)`, [id, company, src, field, type, pattern, direction, account, entity, priority, hits, active]);
    return id;
  }
  const match = async (t) => (await one(`select public.card_coding_rule_match(t, s) m from card_transactions t
    join card_import_batches b on b.id=t.batch_id join card_sources s on s.id=b.source_id where t.id=$1`, [t])).m;
  const needs = async (t) => (await one(`select public.card_coding_needs_preparation(t,b,s) r from card_transactions t
    join card_import_batches b on b.id=t.batch_id join card_sources s on s.id=b.source_id where t.id=$1`, [t])).r;
  const cardDraft = await batch(card, { status: 'draft' }), bankDraft = await batch(bank, { status: 'draft' });

  await test('a card takes unscoped rules and its own; a bank feed only its own, in the right direction', async () => {
    const r1 = await rule({ pattern: 'staples' });
    const t1 = await txn(cardDraft, { merchant: 'STAPLES #0421', status: 'uncoded' });
    assert.equal((await match(t1)).rule_id, r1);
    assert.equal(await needs(t1), 'rule_applies');
    const t2 = await txn(bankDraft, { merchant: 'STAPLES #0421', status: 'uncoded' });
    assert.equal(await match(t2), null, 'an unscoped rule does not reach a bank feed');
    await rule({ src: bank, pattern: 'staples', direction: 'inflow', account: 'refunds' });
    assert.equal(await match(t2), null, 'a rule for the other direction does not either');
    const r3 = await rule({ src: bank, pattern: 'staples', direction: 'outflow', account: 'supplies' });
    assert.equal((await match(t2)).rule_id, r3);
  });

  await test('match types: exact on the raw text, contains on either, normalized on the key; inactive rules are ignored', async () => {
    const t = await txn(cardDraft, { merchant: 'AMZN Mktp US*2A4XY9', status: 'uncoded' });
    assert.equal(await match(t), null);
    await rule({ pattern: 'amzn mktp us', active: false });
    assert.equal(await match(t), null, 'inactive');
    const r = await rule({ pattern: 'mktp', type: 'contains', account: 'supplies' });
    assert.equal((await match(t)).rule_id, r);
    const exact = await rule({ pattern: 'amzn mktp us*2a4xy9', type: 'exact', priority: 200, account: 'meals' });
    assert.equal((await match(t)).rule_id, exact, 'higher priority wins');
  });

  await test('ties break like the page: priority, then source-specific, then hit count, then id', async () => {
    const t = await txn(cardDraft, { merchant: 'UBER TRIP', status: 'uncoded' });
    await rule({ pattern: 'uber trip', hits: 50, account: 'meals' });
    const specific = await rule({ src: card, pattern: 'uber trip', hits: 1, account: 'travel' });
    assert.equal((await match(t)).rule_id, specific);
    const busy = await rule({ src: card, pattern: 'uber trip', type: 'contains', hits: 9, account: 'travel' });
    assert.equal((await match(t)).rule_id, busy);
  });

  await test('a merchant rule and a card rule that disagree answer nothing; a rule with no account answers nothing', async () => {
    const t = await txn(cardDraft, { merchant: 'COMCAST', card: 'Jackie', status: 'uncoded' });
    await rule({ pattern: 'comcast', account: 'utilities' });
    await rule({ field: 'card_name', type: 'exact', pattern: 'jackie', account: 'jackie-receivable' });
    assert.equal((await match(t)).conflict, true);
    assert.equal(await needs(t), null, 'a conflict still needs a person, and evidence helps');
    const agree = await txn(cardDraft, { merchant: 'COMCAST', card: 'Office', status: 'uncoded' });
    await rule({ field: 'card_name', type: 'exact', pattern: 'office', account: 'utilities' });
    assert.equal((await match(agree)).conflict, false);
    const blank = await txn(cardDraft, { merchant: 'MYSTERY VENDOR', status: 'uncoded' });
    await rule({ pattern: 'mystery vendor', account: null });
    assert.equal(await needs(blank), null);
    const answered = await svc(() => q('select * from card_coding_rule_answered($1,$2)', [co, [t, agree, blank]]));
    assert.deepEqual(answered.map((r) => r.transaction_id), [agree]);
    const foreign = await svc(() => q('select * from card_coding_rule_answered($1,$2)', [other, [agree]]));
    assert.equal(foreign.length, 0, 'company-scoped');
  });

  await test('none of it is reachable from the browser', async () => {
    for (const [fn, args] of [['card_coding_history_evidence(uuid,uuid,jsonb,integer,uuid[])', 'history'], ['card_coding_rule_answered(uuid,uuid[])', 'rules']]) {
      const r = await one(`select has_function_privilege('authenticated', 'public.${fn}', 'execute') a, has_function_privilege('anon', 'public.${fn}', 'execute') b`);
      assert.equal(r.a, false, `${args}: authenticated`); assert.equal(r.b, false, `${args}: anon`);
    }
  });

  console.log(`${passed} coding evidence database checks passed`);
} finally {
  await db.close();
}
