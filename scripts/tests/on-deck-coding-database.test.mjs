// On Deck coding review, executed against the real finance migrations plus
// 20261004120000_on_deck_coding_review.sql, as authenticated users.
//
// What is proven:
//   1. Only the finance population sees the coding queue or a preview, even
//      though card_import_batches is readable by every company member; another
//      company's batch is invisible; anon cannot execute any of it.
//   2. The preview IS approval: its hash equals the hash approve_card_import_batch
//      freezes, and it leaves no trace (status, snapshot, audit, source binding).
//   3. Approval is bound to the reviewed version: a change after the preview,
//      including an edit after a reopen, refuses and rolls the approval back.
//   4. A repeated approval (double click, retry) is a no-op returning the same
//      hash, never a second approval.
//   5. Missing inputs surface as a specific blocker, never a fabricated entry.
//
// on_deck_proposals is a minimal stub here (owner/admin RLS as in production);
// its real policies are covered by on-deck-database.test.mjs.
//
// Mutation hooks -- each must make this suite FAIL:
//   ON_DECK_CODING_MUTATION=no-hash-check
//   ON_DECK_CODING_MUTATION=preview-commits
//   ON_DECK_CODING_MUTATION=items-ungated
//   ON_DECK_CODING_MUTATION=preview-ungated
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = {
  'no-hash-check': ["if v_result->>'approval_hash' is distinct from p_expected_hash then", 'if false then'],
  'preview-commits': ["raise exception using errcode = 'P0D01', message = 'on_deck_preview_rollback';", 'null;'],
  'items-ungated': ['where gate.ok and b.company_entity_id = gate.co', 'where b.company_entity_id = gate.co'],
  'preview-ungated': ["     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then\n    raise exception 'Finance access required' using errcode = '42501';", " then\n    raise exception 'Finance access required' using errcode = '42501';"],
};
const mutation = process.env.ON_DECK_CODING_MUTATION || '';
assert.ok(!mutation || MUTATIONS[mutation], 'Unknown On Deck coding mutation');

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
const rpc = async (name, args = []) => Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];
const refused = async (fn, pattern, what) => { await assert.rejects(fn, pattern, what); passed += 1; console.log(`ok ${passed} - refused: ${what}`); };

const co = randomUUID(), other = randomUUID();
const finance = randomUUID(), member = randomUUID(), exec = randomUUID(), otherFinance = randomUUID(), admin = randomUUID();
const conn = randomUUID(), otherConn = randomUUID(), source = randomUUID(), offSource = randomUUID(), otherSource = randomUUID();

async function newBatch(src, { company = co, connection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,label,entry_date,period_start,period_end,status,origin,qbo_connection_id)
           values($1,$2,$3,'September','2026-09-30','2026-09-01','2026-09-30','draft','csv',$4)`, [id, company, src, connection]);
  return id;
}
let rowNo = 0;
async function newTxn(batchId, amount, { company = co, coded = false, account = 'supplies', merchant = 'Office Depot' } = {}) {
  const id = randomUUID();
  await q(`insert into card_transactions(id,company_entity_id,batch_id,row_no,txn_date,description,merchant,clean_merchant,card_name,amount,currency,status,
             qbo_account_id,qbo_account_name,coding_source)
           values($1,$2,$3,$4,('2026-09-1' || ($4::int % 9)::text)::date,$5,$5,$5,'Supplies',$6,'USD',$7,$8,$9,$10)`,
    [id, company, batchId, ++rowNo, merchant, amount, coded ? 'coded' : 'uncoded', coded ? account : null,
     coded ? (account === 'supplies' ? 'Office supplies' : 'Meals') : null, coded ? 'manual' : null]);
  return id;
}
const items = (user) => as(user, () => q('select * from on_deck_coding_items()'));
const preview = (user, batch) => as(user, () => rpc('card_import_batch_preview', [batch]));
const approveReviewed = (user, batch, hash) => as(user, () => rpc('approve_reviewed_card_import_batch', [batch, hash]));

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'));
  // Minimal stand-in for the On Deck preview table (owner/admin read, as in prod).
  await db.exec(`
    create table public.on_deck_proposals(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, status text not null);
    alter table public.on_deck_proposals enable row level security;
    create function public.on_deck_can_review() returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id
        where p.id=auth.uid() and p.is_active and m.entity_id=public.active_company_id() and m.role in ('owner_admin','admin')) $$;
    create policy on_deck_read on public.on_deck_proposals for select to authenticated
      using (company_entity_id = public.active_company_id() and public.on_deck_can_review());
    grant select on public.on_deck_proposals to authenticated;`);
  let sql = await readFile(new URL('supabase/migrations/20261004120000_on_deck_coding_review.sql', root), 'utf8');
  if (mutation) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(sql.includes(from), `Mutation ${mutation} is stale: its target text is gone`);
    sql = sql.replace(from, to);
  }
  await db.exec(sql); await db.exec(sql); // idempotent: apply-all may run it twice

  await q("insert into entities(id,title) values($1,'Test A'),($2,'Test B')", [co, other]);
  await q('insert into auth.users(id) values($1),($2),($3),($4),($5)', [finance, member, exec, otherFinance, admin]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'Fin','user','finance',$6),($2,'Mem','user','marketing',$6),($3,'Exec','executive','marketing',$6),
    ($4,'OtherFin','user','finance',$7),($5,'Admin','admin','marketing',$6)`, [finance, member, exec, otherFinance, admin, co, other]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($1,$4,'member'),($5,$6,'member'),($1,$7,'admin')`,
    [co, finance, member, exec, other, otherFinance, admin]);
  await q("insert into quickbooks_connections(id,company_entity_id,realm_id,company_name,environment,access_token) values($1,$2,'r','Test A Books','sandbox','secret'),($3,$4,'r2','Test B Books','sandbox','secret')",
    [conn, co, otherConn, other]);
  for (const [company, connection, id, name, type] of [
    [co, conn, 'supplies', 'Office supplies', 'Expense'], [co, conn, 'meals', 'Meals', 'Expense'],
    [co, conn, 'cc', 'Company card', 'Credit Card'], [other, otherConn, 'supplies', 'Other supplies', 'Expense'],
    [other, otherConn, 'cc', 'Other card', 'Credit Card']]) {
    await q('insert into quickbooks_accounts(company_entity_id,connection_id,qbo_account_id,name,account_type,is_active) values($1,$2,$3,$4,$5,true)',
      [company, connection, id, name, type]);
  }
  await q(`insert into card_sources(id,company_entity_id,qbo_connection_id,source_key,display_name,source_type,credit_qbo_account_id,credit_qbo_account_name,is_active,posting_enabled)
           values($1,$2,$3,'card','Company card','card','cc','Company card',true,true),
                 ($4,$2,$3,'off','Posting-off card','card','cc','Company card',true,false),
                 ($5,$6,$7,'card','Other card','card','cc','Other card',true,true)`,
    [source, co, conn, offSource, otherSource, other, otherConn]);

  // Fixtures: a batch waiting on suggestions, one fully coded, one with an
  // unsuggested uncoded row, one on a posting-disabled card, another company's.
  const codeBatch = await newBatch(source);
  const suggestedTxn = await newTxn(codeBatch, 42.10);
  const readHash = async (id) => (await as(null, () => one('select input_hash from card_coding_input_hashes($1,$2)', [co, [id]]), 'service_role')).input_hash;
  const run = (await one(`insert into card_coding_preparation_runs(company_entity_id,source_id,qbo_connection_id,trigger,model)
                          values($1,$2,$3,'manual','synthetic') returning id`, [co, source, conn])).id;
  await as(null, async () => rpc('record_card_coding_suggestions', [run, JSON.stringify([{ transaction_id: suggestedTxn, expected_input_hash: await readHash(suggestedTxn),
    outcome: 'suggested', qbo_account_id: 'supplies', accounting_treatment: 'purchase', confidence: 0.82, reasoning: 'Office supplies retailer.',
    evidence: 'CONSISTENT', history_status: 'consistent', vendor_name: 'Office Depot' }]), false]), 'service_role');

  const codedBatch = await newBatch(source);
  await newTxn(codedBatch, 25.00, { coded: true });
  await newTxn(codedBatch, 10.50, { coded: true, account: 'meals', merchant: 'Cafe' });
  const stuckBatch = await newBatch(source);
  await newTxn(stuckBatch, 9.99);
  const offBatch = await newBatch(offSource);
  await newTxn(offBatch, 5, { coded: true });
  const otherBatch = await newBatch(otherSource, { company: other, connection: otherConn });
  await newTxn(otherBatch, 77, { company: other, coded: true });

  await test('finance sees its company queue with derived stages and the real account mix', async () => {
    const rows = await items(finance);
    const byId = Object.fromEntries(rows.map((r) => [r.batch_id, r]));
    assert.equal(byId[codeBatch].stage, 'code');
    assert.equal(byId[codeBatch].open_suggestions, 1);
    assert.equal(Number(byId[codeBatch].suggested_amount), 42.10);
    assert.deepEqual(byId[codeBatch].account_mix.map((m) => [m.account, m.count]), [['Office supplies', 1]]);
    assert.equal(byId[codedBatch].stage, 'approve');
    assert.equal(byId[stuckBatch].stage, 'needs_input');
    assert.equal(byId[stuckBatch].stage_reason, 'uncoded_without_suggestion');
    assert.equal(byId[offBatch].stage, 'needs_input');
    assert.equal(byId[offBatch].stage_reason, 'posting_disabled');
    assert.equal(byId[otherBatch], undefined, 'another company is never listed');
  });

  await test('a non-finance member who can read batches sees no coding queue and no count', async () => {
    assert.ok((await as(member, () => q('select id from card_import_batches'))).length > 0, 'fixture: batches are company-readable');
    assert.equal((await items(member)).length, 0);
    const access = await as(member, () => rpc('on_deck_coding_access'));
    assert.deepEqual(access, { review: false, post: false });
    assert.equal((await as(member, () => rpc('on_deck_ready_count'))).coding, 0);
  });
  await refused(() => preview(member, codedBatch), /Finance access required/, 'non-finance preview');
  await refused(() => approveReviewed(member, codedBatch, 'a'.repeat(64)), /Finance access required/, 'non-finance approval');
  await refused(() => preview(otherFinance, codedBatch), /Batch not found/, 'another company finance user cannot preview');
  await refused(() => as(null, () => rpc('card_import_batch_preview', [codedBatch]), 'anon'), /permission denied/, 'anon preview');

  await test('an executive outside finance may review and approve but not post', async () => {
    assert.deepEqual(await as(exec, () => rpc('on_deck_coding_access')), { review: true, post: false });
    assert.deepEqual(await as(finance, () => rpc('on_deck_coding_access')), { review: true, post: true });
  });

  let reviewed;
  await test('the preview is the entry approval would freeze, and leaves no trace', async () => {
    const audit = (await one('select count(*)::int n from finance_audit_events')).n;
    reviewed = await preview(finance, codedBatch);
    assert.equal(reviewed.ready, true, JSON.stringify(reviewed));
    assert.match(reviewed.hash, /^[0-9a-f]{64}$/);
    assert.equal(reviewed.lines.length, 3, 'two coded lines plus the balancing card line');
    assert.deepEqual(reviewed.lines.map((l) => [l.posting_type, l.account_name, Number(l.amount)]),
      [['Debit', 'Office supplies', 25], ['Debit', 'Meals', 10.5], ['Credit', 'Company card', 35.5]]);
    assert.equal(Number(reviewed.debits), Number(reviewed.credits));
    assert.equal(reviewed.destination.company_name, 'Test A Books');
    assert.equal(reviewed.facts.coded, 2);
    const after = await one('select status, approval_hash, approval_snapshot from card_import_batches where id=$1', [codedBatch]);
    assert.equal(after.status, 'draft', 'preview must not approve');
    assert.equal(after.approval_hash, null);
    assert.equal(after.approval_snapshot, null);
    assert.equal((await one('select count(*)::int n from finance_audit_events')).n, audit, 'preview writes no audit event');
  });

  await test('missing inputs return the specific blocker, never an entry', async () => {
    const stuck = await preview(finance, stuckBatch);
    assert.equal(stuck.ready, false); assert.equal(stuck.hash, null); assert.deepEqual(stuck.lines, []);
    assert.match(stuck.blocker, /Every transaction must be coded or excluded/);
    const off = await preview(finance, offBatch);
    assert.equal(off.ready, false); assert.match(off.blocker, /Posting is disabled/);
  });

  await refused(() => approveReviewed(finance, codedBatch, null), /Review the journal entry preview/, 'approval without a reviewed hash');
  await refused(() => approveReviewed(finance, codedBatch, 'not-a-hash'), /Review the journal entry preview/, 'approval with a malformed hash');

  await test('a change after the preview refuses approval and rolls it back', async () => {
    await q("update card_transactions set amount = 26.00 where batch_id=$1 and qbo_account_id='supplies'", [codedBatch]);
    await assert.rejects(() => approveReviewed(finance, codedBatch, reviewed.hash), /changed after you reviewed it/);
    const after = await one('select status, approval_hash from card_import_batches where id=$1', [codedBatch]);
    assert.equal(after.status, 'draft', 'the approval was rolled back');
    assert.equal(after.approval_hash, null);
  });

  await test('approving the freshly reviewed version freezes exactly that hash', async () => {
    reviewed = await preview(finance, codedBatch);
    const audit = (await one('select count(*)::int n from finance_audit_events')).n;
    const out = await approveReviewed(finance, codedBatch, reviewed.hash);
    assert.ok((await one('select count(*)::int n from finance_audit_events')).n > audit, 'a real approval is audited (so the preview check above is meaningful)');
    assert.equal(out.approval_hash, reviewed.hash);
    const after = await one('select status, approval_hash, approval_version from card_import_batches where id=$1', [codedBatch]);
    assert.equal(after.status, 'approved'); assert.equal(after.approval_hash, reviewed.hash);
    reviewed.version = after.approval_version;
  });

  await test('a repeated approval (double click or retry) is a no-op returning the same hash', async () => {
    const out = await approveReviewed(finance, codedBatch, reviewed.hash);
    assert.equal(out.already_approved, true); assert.equal(out.approval_hash, reviewed.hash);
    const after = await one('select approval_version from card_import_batches where id=$1', [codedBatch]);
    assert.equal(after.approval_version, reviewed.version, 'no second approval');
  });

  await test('an approved batch previews its stored approval and is ready to post', async () => {
    const stored = await preview(finance, codedBatch);
    assert.equal(stored.hash, reviewed.hash); assert.equal(stored.status, 'approved'); assert.equal(stored.can_post, true);
    const row = (await items(finance)).find((r) => r.batch_id === codedBatch);
    assert.equal(row.stage, 'post'); assert.equal(row.approval_hash, reviewed.hash);
    assert.equal((await preview(exec, codedBatch)).can_post, false, 'an exec outside finance cannot post');
  });

  await test('an edit after reopening invalidates the old approval hash', async () => {
    await as(finance, () => rpc('reopen_card_import_batch', [codedBatch, 'Fix the meal amount']));
    await q("update card_transactions set amount = 11.00 where batch_id=$1 and qbo_account_id='meals'", [codedBatch]);
    await assert.rejects(() => approveReviewed(finance, codedBatch, reviewed.hash), /changed after you reviewed it/);
    assert.equal((await one('select status from card_import_batches where id=$1', [codedBatch])).status, 'categorized');
  });

  await test('Home count reflects only real reviewable coding work and ready proposals', async () => {
    await q("insert into on_deck_proposals(company_entity_id,status) values($1,'ready'),($1,'completed'),($2,'ready')", [co, other]);
    const fin = await as(finance, () => rpc('on_deck_ready_count'));
    assert.equal(fin.coding, 2, JSON.stringify(fin)); // code + approve (reopened); stuck/off are needs_input
    assert.equal(fin.needs_input, 2);
    assert.equal(fin.proposals, 0, 'a finance member who is not an admin sees no proposals');
    const adm = await as(admin, () => rpc('on_deck_ready_count'));
    assert.deepEqual([adm.coding, adm.proposals], [0, 1]);
  });

  await test('no function in this migration is executable by anon', async () => {
    const rows = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
      ('on_deck_coding_access','on_deck_coding_items','card_import_batch_preview','approve_reviewed_card_import_batch','on_deck_ready_count')`);
    assert.equal(rows.length, 5); assert.ok(rows.every((r) => !r.anon), JSON.stringify(rows));
  });

  await test('the schema verifier checks for this migration pass against it', async () => {
    const full = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const block = full.slice(full.indexOf('-- On Deck coding review (20261004120000)'), full.indexOf('-- End On Deck coding review checks.'));
    const parts = block.split(/;\s*\n/).filter((x) => x.replace(/--.*$/gm, '').trim());
    assert.equal(parts.length, 2, 'two checks');
    for (const part of parts) for (const row of await q(part)) assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  });

  console.log(`PASS on-deck coding: ${passed} checks -- finance-only queue, preview equals approval with no trace, approval bound to the reviewed hash, idempotent retries, specific blockers, company isolation`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
