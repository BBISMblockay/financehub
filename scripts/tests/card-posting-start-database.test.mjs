// When SILO starts posting an account (20261015020000_card_posting_start.sql),
// executed against the real finance, ledger and On Deck migrations.
//
// The case: Baseballism's card accounts came under SILO in August 2026, but the
// Plaid bank feed only in September, and its July and August periods were coded
// inside QuickBooks directly off a three-month backload. Nothing in SILO could
// say so, so On Deck listed both as work, Approve would have accepted them --
// leaving each one click from duplicating the manual entries -- and SILO's own
// ledger had already recorded August.
//
// What is proven:
//   1. NULL posting_start_on changes nothing: approval, the ledger and On Deck
//      behave exactly as before for every account without a date.
//   2. A period ending before the date cannot be approved, whoever approves it
//      and by whatever path, and the refusal names the account and the date.
//      Posting is therefore unreachable: the Edge Function posts only an
//      approved batch.
//   3. A period ending on or after the date still approves; an import with no
//      period and no entry date is left alone rather than guessed at.
//   4. The ledger records nothing dated before the date, and what it recorded
//      earlier is REVERSED, never deleted, in pages, with the remaining count
//      returned so a browser can finish inside its 8s statement timeout.
//   5. The resync is finance-only and company-isolated, and is idempotent.
//   6. On Deck drops those periods from the queue but leaves approved and
//      posted history alone.
//
// Mutation hooks -- each must make this suite FAIL:
//   CARD_POSTING_START_MUTATION=no-approve-guard|guard-refuses-undated|no-ledger-gate
//     |no-on-deck-filter|resync-deletes|resync-ungated|resync-crosses-companies|no-view-column
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  // Let approval through: the guard becomes decoration.
  'no-approve-guard': ["  raise exception 'This period ends before SILO started posting % (%). It was handled outside SILO; nothing is to be sent for it.',\n    coalesce(v_name, 'this account'), to_char(v_start, 'FMMonth FMDD, YYYY');", '  return new;'],
  // Judge a period with no dates at all as pre-cut-over rather than leaving it alone.
  'guard-refuses-undated': ['  if v_end is null or v_end >= v_start then return new; end if;', '  if v_end is not null and v_end >= v_start then return new; end if;'],
  // The ledger ignores the date: August stays recorded and new rows keep landing.
  'no-ledger-gate': ['  select greatest(st.accounting_start_date,\n                  coalesce(p_source.authoritative_from, st.accounting_start_date),\n                  coalesce(p_source.posting_start_on, st.accounting_start_date))',
    '  select greatest(st.accounting_start_date,\n                  coalesce(p_source.authoritative_from, st.accounting_start_date))'],
  // On Deck keeps asking for the months that were handled elsewhere.
  'no-on-deck-filter': ["      and (b.source_posting_start_on is null\n           or b.status in ('approved', 'posted')\n           or coalesce(b.period_end, b.entry_date, b.period_start) is null\n           or coalesce(b.period_end, b.entry_date, b.period_start) >= b.source_posting_start_on)", ''],
  // Delete the entries instead of reversing them: the ledger stops being append-only.
  'resync-deletes': ['    perform public.silo_ledger_sync_card_transaction(v_id);\n    v_done := v_done + 1;',
    "    delete from public.ledger_lines where entry_id in (select id from public.ledger_entries where source='card_transaction' and source_id=v_id);\n    delete from public.ledger_entries where source='card_transaction' and source_id=v_id;\n    v_done := v_done + 1;"],
  'resync-ungated': ["  if not (coalesce(public.can_manage_journal_entries(), false) or coalesce(public.is_exec_or_owner(), false)) then\n    raise exception 'Finance access required';\n  end if;", ''],
  // Resolve the account without the active company: another tenant's books become reachable.
  'resync-crosses-companies': ['   where id = p_source_id and company_entity_id = public.active_company_id();', '   where id = p_source_id;'],
  'no-view-column': ['  s.posting_start_on as source_posting_start_on\n', '  null::date as source_posting_start_on\n'],
};
const mutation = process.env.CARD_POSTING_START_MUTATION || '';
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
// The On Deck queue, the ledger and the approval gate, in the order production
// applied them. The queue's own migration needs the preview table, which lives
// in a feature this suite does not otherwise touch, so it gets the same minimal
// stand-in on-deck-coding-database.test.mjs uses.
const afterwards = [
  '20261004120000_on_deck_coding_review.sql',
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
async function refused(fn, re, why) {
  try { await fn(); } catch (e) { assert.match(e.message, re, why); return e; }
  assert.fail(`${why}: nothing was refused`);
}

const co = randomUUID(), other = randomUUID();
const finance = randomUUID(), member = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID();
const bank = randomUUID(), card = randomUUID(), otherBank = randomUUID();
let rowNo = 0;

async function newBatch(source, { company = co, connection = conn, start, end, entry = end, status = 'draft' } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
           values($1,$2,$3,'B',$4,$5,$6,$7,'csv',$8)`, [id, company, source, entry, start, end, status, connection]);
  return id;
}
async function newTxn(batch, amount, { date, company = co, account = 'supplies', status = 'coded' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,$5,'OFFICE DEPOT','OFFICE DEPOT','Office Depot','Ops',$6,'USD',$7,$8,$8,$9)`,
    [id, company, batch, ++rowNo, date, amount, status, status === 'coded' ? account : null, status === 'coded' ? 'manual' : null]);
  return id;
}
const live = (txn) => q(`select e.* from ledger_entries e where e.source='card_transaction' and e.source_id=$1 and e.kind='original'
                         and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id)`, [txn]);
const allEntries = (txn) => q("select kind from ledger_entries where source='card_transaction' and source_id=$1 order by recorded_at, kind", [txn]);
const approve = (batch, user = finance) => as(user, () => q('select approve_card_import_batch($1)', [batch]));
const onDeck = (user = finance) => as(user, () => q('select batch_id, stage from on_deck_coding_items()'));

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  await db.exec(`create or replace function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
                 create or replace function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-15' $$;`);
  await db.exec(`
    create table public.on_deck_proposals(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, status text not null);
    alter table public.on_deck_proposals enable row level security;
    create function public.on_deck_can_review() returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id
        where p.id=auth.uid() and p.is_active and m.entity_id=public.active_company_id() and m.role in ('owner_admin','admin')) $$;
    create policy on_deck_read on public.on_deck_proposals for select to authenticated
      using (company_entity_id = public.active_company_id() and public.on_deck_can_review());
    grant select on public.on_deck_proposals to authenticated;`);
  for (const name of afterwards) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));

  let sql = await readFile(new URL('supabase/migrations/20261015020000_card_posting_start.sql', root), 'utf8');
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
  for (const [c, cn, id, type] of [[co, conn, 'supplies', 'Expense'], [co, conn, 'cc', 'Credit Card'], [co, conn, 'bank', 'Bank'],
    [other, otherConn, 'supplies', 'Expense'], [other, otherConn, 'bank', 'Bank']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,true)', [c, cn, id, type]);
  }
  // Two accounts in one company: the bank feed came under SILO later than the card.
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,posting_enabled)
           values($1,$2,$3,'bank','Baseballism Operating','bank','bank','bank',true,true),
                  ($4,$2,$3,'card','Company card','card','cc','cc',true,true),
                  ($5,$6,$7,'bank','Their bank','bank','bank','bank',true,true)`,
    [bank, co, conn, card, otherBank, other, otherConn]);
  for (const [c, cn] of [[co, conn], [other, otherConn]]) {
    const run = (await one(`insert into quickbooks_report_runs(company_entity_id,connection_id,report_name,status) values($1,$2,'TrialBalance','ok') returning id`, [c, cn])).id;
    await q(`insert into accounting_settings(company_entity_id,qbo_connection_id,base_currency,fiscal_year_start_month,accounting_start_date,accounting_basis)
             values($1,$2,'USD',1,'2026-08-01','Accrual')`, [c, cn]);
    await q(`insert into accounting_opening_balances(company_entity_id,report_run_id,snapshot,snapshot_hash,status) values($1,$2,'{}'::jsonb,'h','accepted')`, [c, run]);
  }

  // The world as it stands before the cut-over exists: August is coded and, by
  // the company books starting 2026-08-01, already recorded in SILO's ledger.
  const july = await newBatch(bank, { start: '2026-07-01', end: '2026-07-31' });
  const august = await newBatch(bank, { start: '2026-08-01', end: '2026-08-31' });
  const september = await newBatch(bank, { start: '2026-09-01', end: '2026-09-30' });
  const julyTxn = await newTxn(july, 250, { date: '2026-07-21' });
  const augustTxn = await newTxn(august, 410, { date: '2026-08-12' });
  const augustTxn2 = await newTxn(august, 90, { date: '2026-08-20' });
  const septemberTxn = await newTxn(september, 75, { date: '2026-09-09' });
  const cardBatch = await newBatch(card, { start: '2026-08-01', end: '2026-08-31' });
  const cardTxn = await newTxn(cardBatch, 30, { date: '2026-08-15', account: 'supplies' });

  await db.exec(sql);
  await db.exec(sql); // idempotent

  await test('the column arrives empty, so no account changes behaviour until a date is set', async () => {
    assert.deepEqual((await q('select posting_start_on from card_sources order by display_name')).map((r) => r.posting_start_on), [null, null, null]);
    assert.equal((await live(augustTxn)).length, 1, 'August was recorded before the cut-over existed, and still is');
    assert.equal((await live(julyTxn)).length, 0, 'July is before the company books start: never recorded');
    const stages = await onDeck();
    assert.ok(stages.some((r) => r.batch_id === august), 'On Deck still lists August');
  });

  await test('with no date, an old period still approves exactly as before', async () => {
    await approve(july);
    assert.equal((await one('select status from card_import_batches where id=$1', [july])).status, 'approved');
    await as(finance, () => q('select reopen_card_import_batch($1,$2)', [july, 'back to editable for the cut-over tests']));
    assert.equal((await one('select status from card_import_batches where id=$1', [july])).status, 'categorized',
      'a reopened batch returns to categorized, not draft');
  });

  // ── The cut-over is set: SILO starts posting this account in September ─────
  await test('setting the date is one fast UPDATE: it resyncs nothing inside the statement', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    await as(finance, () => q("update card_sources set posting_start_on='2026-09-01' where id=$1", [bank]));
    assert.equal((await one('select posting_start_on from card_sources where id=$1', [bank])).posting_start_on.toISOString().slice(0, 10), '2026-09-01');
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before,
      'the UPDATE must not drag thousands of transactions through a resync: a browser statement has 8s');
  });

  await test('a period ending before the date cannot be approved, and the refusal names the account and the date', async () => {
    const e = await refused(() => approve(august), /before SILO started posting/i, 'approving a period handled outside SILO');
    assert.match(e.message, /Baseballism Operating/, 'the reader must be told which account');
    assert.match(e.message, /September 1, 2026/, 'and from when');
    assert.equal((await one('select status from card_import_batches where id=$1', [august])).status, 'draft');
    await refused(() => approve(july), /before SILO started posting/i, 'July too, reopened and all');
  });

  await test('no path approves it: the guard sits on the table, not inside the approve function', async () => {
    await refused(() => q("update card_import_batches set status='approved' where id=$1", [august]),
      /before SILO started posting/i, 'a direct, service-role status write');
    assert.equal((await one('select status from card_import_batches where id=$1', [august])).status, 'draft');
  });

  await test('the period on the date itself still approves, and so does a later one', async () => {
    await approve(september);
    assert.equal((await one('select status from card_import_batches where id=$1', [september])).status, 'approved');
  });

  await test('another account in the same company is untouched by this one\'s date', async () => {
    await approve(cardBatch);
    assert.equal((await one('select status from card_import_batches where id=$1', [cardBatch])).status, 'approved');
  });

  await test('an import with no period and no entry date is left alone rather than guessed at', async () => {
    const dateless = await newBatch(bank, { start: null, end: null, entry: null });
    await newTxn(dateless, 12, { date: '2026-06-02' });
    await q("update card_import_batches set status='approved' where id=$1", [dateless]);
    assert.equal((await one('select status from card_import_batches where id=$1', [dateless])).status, 'approved');
  });

  await test('the ledger stops recording anything before the date', async () => {
    const fresh = await newTxn(august, 55, { date: '2026-08-25', status: 'uncoded' });
    await q("update card_transactions set status='coded', qbo_account_id='supplies', qbo_account_name='supplies', coding_source='manual' where id=$1", [fresh]);
    assert.equal((await live(fresh)).length, 0, 'a row coded now, dated before the cut-over, is not SILO\'s to record');
  });

  await test('what the ledger already recorded is reversed, never deleted, and the caller is told how much is left', async () => {
    assert.equal((await live(augustTxn)).length, 1, 'still standing before the resync');
    const remaining = (await as(finance, () => q('select silo_ledger_resync_posting_start($1,1) r', [bank])))[0].r;
    assert.equal(remaining, 1, 'one reversed, one still to go, so a browser can page through it');
    const rest = (await as(finance, () => q('select silo_ledger_resync_posting_start($1,100) r', [bank])))[0].r;
    assert.equal(rest, 0);
    for (const t of [augustTxn, augustTxn2]) {
      assert.equal((await live(t)).length, 0, 'no live entry remains');
      assert.deepEqual((await allEntries(t)).map((r) => r.kind), ['original', 'reversal'],
        'the original is reversed, not removed: ledger_entries is append-only');
    }
    // What is left in SILO's books: the card account's August expense (30) and
    // the bank account's September one (75). August's 410 and 90 are out.
    const dr = (await one("select coalesce(sum(case when posting_type='Debit' then amount else -amount end),0)::text v from ledger_lines where company_entity_id=$1 and qbo_account_id='supplies'", [co])).v;
    assert.equal(dr, '105.00', 'the two pre-cut-over amounts are gone from the balance, and nothing else is');
  });

  await test('running the resync again changes nothing', async () => {
    const before = (await one('select count(*)::int n from ledger_entries')).n;
    assert.equal((await as(finance, () => q('select silo_ledger_resync_posting_start($1,100) r', [bank])))[0].r, 0);
    assert.equal((await one('select count(*)::int n from ledger_entries')).n, before);
  });

  await test('September is left recorded: the cut-over reaches back, never forward', async () => {
    assert.equal((await live(septemberTxn)).length, 1);
  });

  await test('the resync is finance-only, and cannot reach another company\'s account', async () => {
    await refused(() => as(member, () => q('select silo_ledger_resync_posting_start($1,10)', [bank])),
      /Finance access required/i, 'a marketing user');
    await refused(() => as(otherFinance, () => q('select silo_ledger_resync_posting_start($1,10)', [bank])),
      /Account not found/i, 'finance in another company');
    await refused(() => as(null, () => q('select silo_ledger_resync_posting_start($1,10)', [bank]), 'anon'),
      /denied|Finance access/i, 'anon');
  });

  await test('On Deck stops asking for those periods, and keeps the history it should', async () => {
    const rows = await onDeck();
    const ids = rows.map((r) => r.batch_id);
    assert.ok(!ids.includes(august), 'August was handled outside SILO: it is not work');
    assert.ok(!ids.includes(july), 'nor is July');
    assert.ok(ids.includes(september), 'September is SILO\'s, and it is approved');
    assert.equal(rows.find((r) => r.batch_id === september).stage, 'approved');
  });

  await test('an approved or posted period before the date is still shown: history is not rewritten', async () => {
    const old = await newBatch(bank, { start: '2026-06-01', end: '2026-06-30', status: 'draft' });
    await newTxn(old, 10, { date: '2026-06-10' });
    await q("update card_sources set posting_start_on=null where id=$1", [bank]);
    await approve(old);
    await q("update card_sources set posting_start_on='2026-09-01' where id=$1", [bank]);
    assert.ok((await onDeck()).some((r) => r.batch_id === old), 'an approved period stays readable as a receipt');
  });

  await test('the batch view carries the date, so the browser reads it per period', async () => {
    const row = await one('select source_posting_start_on from card_import_batches_v where id=$1', [august]);
    assert.equal(row.source_posting_start_on.toISOString().slice(0, 10), '2026-09-01');
  });

  console.log(`PASS card posting start: ${passed} checks -- approval refused before the cut-over by any path, the ledger reversed in pages rather than deleted, On Deck quiet, history intact`);
} finally {
  await db.close();
}
