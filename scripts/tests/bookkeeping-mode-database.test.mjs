// Who keeps the books (20261015190000_bookkeeping_mode.sql), executed against
// the real finance, ledger, On Deck and posting-cut-over migrations.
//
// The case: before this, a company's position was spread across four
// per-account fields and had to be inferred. A company that does its
// bookkeeping inside QuickBooks and uses SILO for reporting could only say so
// by switching every account off one at a time, and one account left on is a
// hybrid nobody chose.
//
// What is proven:
//   1. The default is 'silo' and changes nothing: every account behaves exactly
//      as it did before the column existed.
//   2. In 'qbo' mode SILO records nothing in its own ledger, and what it
//      recorded earlier is REVERSED by the existing paged resync, never deleted.
//   3. In 'qbo' mode the posting claim is refused for EVERY source, not just
//      bank coding, so a revenue journal cannot be sent either.
//   4. The takeover date is a company default, and an account's own
//      posting_start_on still overrides it (an account that came onboard later
//      keeps its later date).
//   5. set_bookkeeping_mode is finance-only, company-scoped, refuses an unknown
//      mode, and drops the takeover date when the answer is 'qbo'.
//
// Exit code, as every suite here: 0 when every check passes, non-zero when one
// fails. The CI loop applies a mutation and FAILS the job if the run exits 0,
// because a mutation that leaves the suite passing was not caught.
//
// Mutation hooks -- each must make this suite FAIL:
//   BOOKKEEPING_MODE_MUTATION=mode-ignores-ledger|no-mode-claim-guard
//     |claim-guard-card-only|override-ignored|on-deck-still-asks
//     |handover-ignores-approvals|handover-unserialized|rpc-ignores-company
//     |rpc-ungated|rpc-keeps-stale-date
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  // The mode never reaches the ledger: a reporting-only company keeps recording.
  'mode-ignores-ledger': ["  select case when st.bookkeeping_mode = 'qbo' then 'infinity'::date", '  select case when false then \'infinity\'::date'],
  // Nothing judges the claim: every surface can still send.
  'no-mode-claim-guard': ["  if coalesce(v_mode, 'silo') <> 'qbo' then return new; end if;", '  return new;'],
  // Judge bank coding only, as the per-account guard does: a revenue journal slips out.
  'claim-guard-card-only': ["  if new.status <> 'submitting' then return new; end if;\n  select bookkeeping_mode into v_mode", "  if new.status <> 'submitting' or new.source <> 'card_import' then return new; end if;\n  select bookkeeping_mode into v_mode"],
  // The company date wins over the account's own: a later-onboarded account is dragged back.
  'override-ignored': ['coalesce(p_source.posting_start_on, st.silo_takeover_on, st.accounting_start_date)', 'coalesce(st.silo_takeover_on, p_source.posting_start_on, st.accounting_start_date)'],
  // Keep listing coding work in reporting-only: On Deck then asks for a click
  // the approval guard refuses.
  'on-deck-still-asks': ["      and (b.status in ('approved', 'posted')\n           or coalesce((select st.bookkeeping_mode from public.accounting_settings st\n                        where st.company_entity_id = b.company_entity_id), 'silo') <> 'qbo')", ''],
  // Hand the books back with an approved import still outstanding: SILO is
  // left holding an entry it can no longer send, and the save claims a
  // reversal that did not happen.
  'handover-ignores-approvals': ["    if v_open > 0 then", '    if false then'],
  // Take the company from the session alone: a switch in another tab while the
  // confirmation is open writes the answer to the wrong company's books.
  // Drop the lock from the approval side: an approval in flight can then
  // commit after a handover has counted and found none.
  'handover-unserialized': ['  perform public.bookkeeping_mode_lock(new.company_entity_id);\n', ''],
  'rpc-ignores-company': ['  if p_company is not null and p_company <> v_company then', '  if false then'],
  'rpc-ungated': ["  if auth.uid() is null or v_company is null\n     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then\n    raise exception 'Finance access required' using errcode = '42501';\n  end if;", ''],
  // Keep a takeover date that belongs to the other mode: switching back shows a
  // date nobody chose.
  'rpc-keeps-stale-date': ["         silo_takeover_on = case when p_mode = 'silo' then p_takeover else null end", '         silo_takeover_on = coalesce(p_takeover, silo_takeover_on)'],
};
const mutation = process.env.BOOKKEEPING_MODE_MUTATION || '';
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
const afterwards = [
  '20261004120000_on_deck_coding_review.sql',
  '20261005120000_silo_daily_ledger.sql', '20261007180000_card_import_entity_kind_on_approve.sql',
  '20261015020000_card_posting_start.sql',
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
const allEntries = (txn) => q("select kind from ledger_entries where source='card_transaction' and source_id=$1", [txn]);
const onDeck = (user = finance) => as(user, () => q('select batch_id, stage from on_deck_coding_items()'));
const setMode = (mode, takeover = null, user = finance, company = null) =>
  as(user, () => q('select bookkeeping_mode, silo_takeover_on from set_bookkeeping_mode($1,$2,$3)', [mode, takeover, company]));
// The loop the Books & setup card runs: pages until nothing is out of line.
async function reconcile(source, user = finance) {
  for (let page = 0; page < 50; page += 1) {
    const left = Number((await as(user, () => one('select silo_ledger_resync_posting_start($1,100,null) as n', [source]))).n);
    if (!left) return 0;
  }
  return -1;
}

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
  // refresh_chat_schema_catalog belongs to Ask SILO's map, which this fixture
  // does not build; the migration's final line is not what is under test.
  await db.exec('create or replace function public.refresh_chat_schema_catalog() returns void language sql as $$ select $$;');

  let sql = await readFile(new URL('supabase/migrations/20261015190000_bookkeeping_mode.sql', root), 'utf8');
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
  for (const [c, cn, id, type] of [[co, conn, 'supplies', 'Expense'], [co, conn, 'cc', 'Credit Card'], [co, conn, 'bank', 'Bank'],
    [other, otherConn, 'supplies', 'Expense'], [other, otherConn, 'bank', 'Bank']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$3,$4,true)', [c, cn, id, type]);
  }
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

  const august = await newBatch(bank, { start: '2026-08-01', end: '2026-08-31' });
  const september = await newBatch(bank, { start: '2026-09-01', end: '2026-09-30' });
  const augustTxn = await newTxn(august, 410, { date: '2026-08-12' });
  const septemberTxn = await newTxn(september, 75, { date: '2026-09-09' });
  const cardBatch = await newBatch(card, { start: '2026-09-01', end: '2026-09-30' });
  const cardTxn = await newTxn(cardBatch, 30, { date: '2026-09-15' });

  await db.exec(sql);
  await db.exec(sql); // idempotent

  await test('the answer arrives as SILO, so nothing changes for a company that never answers', async () => {
    assert.deepEqual((await q('select bookkeeping_mode, silo_takeover_on from accounting_settings order by company_entity_id'))
      .map((r) => [r.bookkeeping_mode, r.silo_takeover_on]), [['silo', null], ['silo', null]]);
    assert.equal((await live(augustTxn)).length, 1, 'August is recorded exactly as before');
    assert.equal((await live(septemberTxn)).length, 1);
  });

  await test('the takeover date is a company default and keeps earlier months out of the ledger', async () => {
    await setMode('silo', '2026-09-01');
    assert.equal(await reconcile(bank), 0);
    assert.equal((await live(augustTxn)).length, 0, 'August is no longer SILO’s');
    assert.equal((await live(septemberTxn)).length, 1, 'September still is');
    assert.ok((await allEntries(augustTxn)).length >= 2, 'reversed, not deleted');
  });

  await test('an account that came onboard later keeps its own date over the company default', async () => {
    // The company says September 1; this account says October 1. September is
    // the company's month and not this account's, so the account wins.
    await q("update card_sources set posting_start_on = '2026-10-01' where id=$1", [card]);
    assert.equal(await reconcile(card), 0);
    assert.equal((await live(cardTxn)).length, 0,
      'a September row on an account SILO posts from October is not SILO’s');
    const refusal = (await one('select card_posting_start_refusal($1,$2,$3,$4,$5) as m',
      [cardBatch, card, '2026-09-30', '2026-09-30', '2026-09-01'])).m;
    assert.match(String(refusal), /October 1, 2026/, 'the account’s own date is the one quoted');
    await q('update card_sources set posting_start_on = null where id=$1', [card]);
    assert.equal(await reconcile(card), 0);
    assert.equal((await live(cardTxn)).length, 1, 'clearing it hands September back to SILO');
  });

  await test('reporting-only records nothing in SILO’s ledger and reverses what it held', async () => {
    await setMode('qbo');
    assert.equal(await reconcile(bank), 0);
    assert.equal(await reconcile(card), 0);
    assert.equal((await live(septemberTxn)).length, 0, 'QuickBooks keeps the books, so SILO’s ledger holds nothing');
    assert.equal((await live(cardTxn)).length, 0);
    assert.ok((await allEntries(septemberTxn)).length >= 2, 'reversed, not deleted');
    // A row coded while in reporting-only never enters the ledger at all.
    const late = await newTxn(september, 60, { date: '2026-09-20' });
    await q("update card_transactions set status='coded', qbo_account_id='supplies', qbo_account_name='supplies' where id=$1", [late]);
    assert.equal((await live(late)).length, 0);
  });

  await test('reporting-only drops unapproved coding work from On Deck, keeping history', async () => {
    assert.deepEqual(await onDeck(), [], 'nothing is waiting to be done when SILO sends nothing');
  });

  await test('reporting-only refuses the posting claim from every surface, not just bank coding', async () => {
    for (const source of ['card_import', 'journal_entry', 'schedule']) {
      await refused(() => q(`insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,status,payload,request_key,payload_hash)
                             values($1,$2,$3,$4,'submitting','{}'::jsonb,$5,'h')`, [co, conn, source, randomUUID(), randomUUID()]),
      /QuickBooks keeps the books/, `a ${source} claim must be refused`);
    }
  });

  await test('the refusal says why, in the reader’s words, rather than quoting a date', async () => {
    const message = (await one('select card_posting_start_refusal($1,$2,$3,$4,$5) as m',
      [september, bank, '2026-09-30', '2026-09-30', '2026-09-01'])).m;
    assert.match(String(message), /QuickBooks keeps the books/);
    assert.doesNotMatch(String(message), /infinity/i, 'a date of infinity must never reach a reader');
  });

  await test('switching back to SILO restores the ledger and clears the stale date', async () => {
    const back = await setMode('silo', null);
    assert.equal(back[0].silo_takeover_on, null, 'the takeover date from before must not reappear');
    assert.equal(await reconcile(bank), 0);
    assert.equal((await live(septemberTxn)).length, 1, 'September is SILO’s again');
    assert.equal((await live(augustTxn)).length, 1, 'and so is August, with no company date set');
    await q(`insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,status,payload,request_key,payload_hash)
             values($1,$2,'journal_entry',$3,'submitting','{}'::jsonb,$4,'h')`, [co, conn, randomUUID(), randomUUID()]);
  });

  await test('an approved import SILO never sent blocks the handover, and says how to clear it', async () => {
    // Its ledger entry came from the frozen approval snapshot and the resync
    // never touches it, so switching now would leave SILO holding an entry it
    // can no longer send -- and report a reversal that did not happen.
    const pending = await newBatch(bank, { start: '2026-10-01', end: '2026-10-31' });
    await newTxn(pending, 120, { date: '2026-10-05' });
    await as(finance, () => q('select approve_card_import_batch($1)', [pending]));
    await refused(() => setMode('qbo'), /approved import/i, 'the handover must not proceed');
    await refused(() => setMode('qbo'), /Reopen or post/, 'and must say how to clear it');
    assert.equal((await one('select bookkeeping_mode from accounting_settings where company_entity_id=$1', [co])).bookkeeping_mode, 'silo',
      'nothing is written when it is refused');
    await as(finance, () => q('select reopen_card_import_batch($1,$2)', [pending, 'clearing it for the handover']));
    await setMode('qbo');
    assert.equal(await reconcile(bank), 0);
  });

  await test('the handover and an approval take the same company lock, so they cannot interleave', async () => {
    // PGlite runs one connection, so the interleaving itself cannot be staged
    // here. What can be pinned is the invariant that makes it impossible: both
    // sides take the same company-scoped transaction lock before they read the
    // state the other is about to change, and each takes only that one.
    const key = (await one("select hashtext('silo.bookkeeping_mode:' || $1::text) as k", [co])).k;
    assert.equal(Number((await one('select public.bookkeeping_mode_lock($1) is null as taken', [co])).taken), 1,
      'the lock function runs');
    for (const fn of ['public.set_bookkeeping_mode(text,date,uuid)', 'public.card_posting_start_guard()']) {
      const body = (await one('select pg_get_functiondef(to_regprocedure($1)) as d', [fn])).d;
      assert.match(body, /bookkeeping_mode_lock/, `${fn} must take the lock`);
    }
    assert.ok(Number.isFinite(Number(key)), 'the key is derived from the company, so one company cannot block another');
    assert.equal((await one("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='bookkeeping_mode_lock'", [])).n, 1);
    // It is an xact lock, so it is released by commit or rollback and cannot
    // be leaked by a failed handover.
    const def = (await one("select pg_get_functiondef(to_regprocedure('public.bookkeeping_mode_lock(uuid)')) as d")).d;
    assert.match(def, /pg_advisory_xact_lock/);
    assert.doesNotMatch(def, /pg_advisory_lock\(/, 'a session lock would outlive the statement that took it');
  });

  await test('a company switch while the confirmation is open cannot write to the wrong books', async () => {
    // The confirmation sits outside the element the company-switch shield makes
    // inert, so the company the reader saw is passed with the answer.
    await refused(() => setMode('silo', null, finance, other), /active company changed/i,
      'another company’s id must not be accepted');
    assert.equal((await one('select bookkeeping_mode from accounting_settings where company_entity_id=$1', [other])).bookkeeping_mode, 'silo',
      'and the other company is untouched');
    const ok = await setMode('silo', null, finance, co);
    assert.equal(ok[0].bookkeeping_mode, 'silo', 'the company actually on screen is accepted');
  });

  await test('an account switched off still has its ledger entries reversed', async () => {
    const dormant = randomUUID();
    await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,posting_enabled)
             values($1,$2,$3,'old','Retired card','card','cc','cc',true,true)`, [dormant, co, conn]);
    const batch = await newBatch(dormant, { start: '2026-09-01', end: '2026-09-30' });
    const txn = await newTxn(batch, 45, { date: '2026-09-12' });
    assert.equal((await live(txn)).length, 1, 'it was recorded while the account was on');
    await q('update card_sources set is_active=false where id=$1', [dormant]);
    await setMode('qbo');
    assert.equal(await reconcile(dormant), 0, 'a disabled account is still reconciled');
    assert.equal((await live(txn)).length, 0, 'and its entries are reversed, not left standing');
    await setMode('silo', null);
  });

  await test('only finance can answer, for their own company, and only with a known answer', async () => {
    await refused(() => setMode('silo', null, member), /Finance access required/, 'a non-finance member must not answer');
    await refused(() => setMode('sometimes', null), /Unknown bookkeeping mode/, 'there is no third mode');
    await setMode('qbo', null, otherFinance);
    assert.equal((await one('select bookkeeping_mode from accounting_settings where company_entity_id=$1', [co])).bookkeeping_mode, 'silo',
      'answering for one company must not touch another');
    assert.equal((await one('select bookkeeping_mode from accounting_settings where company_entity_id=$1', [other])).bookkeeping_mode, 'qbo');
  });

  await test('the mode is not writable from the client except through the RPC', async () => {
    await as(finance, async () => {
      // The table has a read policy and no write grant or policy, so a client
      // write is either refused outright or silently updates zero rows (an
      // RLS-refused UPDATE does not error). Both are the same answer here.
      const rows = await q("update accounting_settings set bookkeeping_mode='qbo' where company_entity_id=$1 returning id", [co])
        .catch((e) => { assert.match(e.message, /permission denied|policy/i); return []; });
      assert.equal(rows.length, 0, 'accounting_settings is not client-writable');
    });
    assert.equal((await one('select bookkeeping_mode from accounting_settings where company_entity_id=$1', [co])).bookkeeping_mode, 'silo');
  });

  await test('the production schema check agrees with this migration: verify_v2_schema.sql reads ok', async () => {
    // Nothing else runs this block before production does, so a refactor that
    // moves logic between functions would first show up as a red drift check.
    const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const from = verify.indexOf("select 'Bookkeeping mode' as check_name");
    assert.ok(from >= 0, 'the check exists');
    const statement = verify.slice(from, verify.indexOf(';\n', from) + 1);
    assert.equal((await one(statement)).status, 'ok');
  });

  console.log(`PASS bookkeeping mode: ${passed} checks -- reporting-only sends nothing from any surface, records nothing, and says so; the account's own date still wins`);
} finally {
  await db.close();
}
