import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

// Deliberately no URL/credentials option: this runner can only create a new
// in-memory PostgreSQL database, never write to an existing Supabase project.
const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const migrationName = '20260912000000_finance_v1_posting_controls.sql';
const mutation = process.env.FINANCE_DB_MUTATION || '';
assert.ok(['', 'roundtrip-hash', 'legacy-void'].includes(mutation), 'Unknown database mutation');
const dependencies = [
  '20260826070000_quickbooks_integration.sql',
  '20260826090000_quickbooks_locations.sql',
  '20260827210000_quickbooks_reports.sql',
  '20260831180000_card_coding.sql',
  '20260831190000_card_name_and_holder.sql',
  '20260831200000_qbo_entities_and_line_entity.sql',
  '20260831210000_apply_card_coding_rpc.sql',
  '20260831220000_void_card_posting.sql',
  '20260831230000_rule_hits_and_conflicts.sql',
  '20260901000000_journal_adjustments.sql',
  '20260901010000_void_journal_adjustment.sql',
  '20260901020000_posted_status_not_client_writable.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const scalar = async (sql, params = []) => Object.values(await first(sql, params))[0];
const co = randomUUID(), otherCo = randomUUID();
const finance = randomUUID(), outsider = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID();

async function asRole(role, user, callback) {
  assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  try { return await callback(); }
  finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}
const asFinance = (fn) => asRole('authenticated', finance, fn);
const rpc = (name, params) => scalar(`select public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')})`, params);
const approve = (kind, id) => asFinance(() => rpc(kind === 'card_import_batches'
  ? 'approve_card_import_batch' : 'approve_journal_adjustment', [id]));
const verify = (kind, id, hash, version) => asRole('service_role', null, async () => {
  if (mutation === 'roundtrip-hash') {
    // The original Edge Function path: pg JSON -> JS -> pg hash RPC. This
    // deliberately restores the defect; the unchanged real-approval test fails.
    const parent = await load(kind, id);
    return (await rpc('finance_approval_snapshot_hash', [parent.approval_snapshot])) === hash;
  }
  return rpc('finance_approval_hash_matches', [kind, id, hash, version]);
});
const load = (kind, id) => first(`select * from public.${kind} where id=$1`, [id]);

async function card() {
  const source = randomUUID(), id = randomUUID(), txn = randomUUID();
  await q(`insert into card_sources (id, company_entity_id, source_key, display_name,
    credit_qbo_account_id, posting_enabled) values ($1,$2,$3,'Synthetic card','bank',true)`, [source, co, source]);
  await q(`insert into card_import_batches (id,company_entity_id,source_id,entry_date)
    values ($1,$2,$3,'2026-08-31')`, [id, co, source]);
  await q(`insert into card_transactions (id,company_entity_id,batch_id,amount,status,qbo_account_id,description)
    values ($1,$2,$3,35.00,'coded','expense','Synthetic expense')`, [txn, co, id]);
  return { id, source, txn, kind: 'card_import_batches' };
}

async function adjustment(source = null, ref = null) {
  const id = randomUUID();
  await q(`insert into journal_adjustments (id,company_entity_id,entry_date,memo,accounting_source,accounting_source_ref)
    values ($1,$2,'2026-08-31','Synthetic adjustment',$3,$4)`, [id, co, source, ref]);
  await q(`insert into journal_adjustment_lines
    (company_entity_id,adjustment_id,line_no,qbo_account_id,posting_type,amount)
    values ($1,$2,1,'expense','Debit',35.00),($1,$2,2,'bank','Credit',35.00)`, [co, id]);
  return { id, kind: 'journal_adjustments' };
}

async function posted(fixture, { linked = true, parentStatus = 'posted', postingCompany = co,
  postingConnection = conn, source = null, sourceRef = null, hash = null } = {}) {
  const parent = await load(fixture.kind, fixture.id);
  const id = randomUUID();
  await q(`insert into quickbooks_journal_postings (id,company_entity_id,connection_id,source,source_ref,
    payload,payload_hash,status,qbo_journal_entry_id,qbo_doc_number)
    values ($1,$2,$3,$4,$5,$6,$7,'posted',$8,'SILO-TEST')`,
  [id, postingCompany, postingConnection, source || parent.approval_snapshot.source,
    sourceRef || parent.approval_snapshot.source_ref, parent.approval_snapshot.payload,
    hash || parent.approval_hash, `synthetic-${id}`]);
  await q(`update ${fixture.kind} set status=$1, posting_id=$2 where id=$3`,
    [parentStatus, linked ? id : null, fixture.id]);
  return id;
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) {
    try { await db.exec(await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')); }
    catch (error) { throw new Error(`Dependency migration failed: ${name}: ${error.message}`, { cause: error }); }
  }
  await q('insert into entities(id,title) values ($1,\'Synthetic A\'),($2,\'Synthetic B\')', [co, otherCo]);
  await q('insert into auth.users(id) values ($1),($2),($3)', [finance, outsider, otherFinance]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'Finance A','user','finance',$4),($2,'Marketing A','user','marketing',$4),
    ($3,'Finance B','user','finance',$5)`, [finance, outsider, otherFinance, co, otherCo]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values
    ($1,$2,'member'),($1,$3,'member'),($4,$5,'member')`, [co, finance, outsider, otherCo, otherFinance]);
  await q(`insert into quickbooks_connections(id,company_entity_id,realm_id)
    values ($1,$2,'synthetic-a'),($3,$4,'synthetic-b')`, [conn, co, otherConn, otherCo]);
  await q(`insert into quickbooks_accounts(connection_id,company_entity_id,qbo_account_id,name,account_type)
    values ($1,$2,'expense','Synthetic expense','Expense'),($1,$2,'bank','Synthetic bank','Bank'),
    ($3,$4,'expense','Other expense','Expense'),($3,$4,'bank','Other bank','Bank')`, [conn, co, otherConn, otherCo]);

  const migration = await readFile(new URL(`supabase/migrations/${migrationName}`, root), 'utf8');
  await test('draft controls migration applies twice with real PostgreSQL DDL', async () => {
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await scalar("select count(*)::integer from pg_constraint where conname='journal_lines_adjustment_company_fkey'"), 1);
  });
  if (mutation === 'legacy-void') {
    // Replace the actual SQL function with its pre-fix repository definition.
    await db.exec(await readFile(new URL('supabase/migrations/20260901010000_void_journal_adjustment.sql', root), 'utf8'));
  }

  await test('old JSON round-trip hash bug is reproduced (35.00 becomes 35)', async () => {
    const result = await first(`select '{"Amount":35.00}'::jsonb::text as stored,
      finance_approval_snapshot_hash('{"Amount":35.00}') as old_hash`);
    const roundTrip = JSON.parse(result.stored);
    assert.equal(roundTrip.Amount, 35);
    assert.notEqual(await rpc('finance_approval_snapshot_hash', [roundTrip]), result.old_hash);
  });

  for (const make of [card, adjustment]) {
    const fixture = await make();
    const { kind, id } = fixture;
    await test(`${kind}: finance RPC approves real lines and stores exact numeric snapshot`, async () => {
      const approval = await approve(kind, id);
      const parent = await load(kind, id);
      assert.equal(parent.status, 'approved');
      assert.equal(parent.approved_by, finance);
      assert.equal(parent.qbo_connection_id, conn);
      assert.equal(parent.approval_hash, approval.approval_hash);
      assert.match(await scalar(`select approval_snapshot::text from ${kind} where id=$1`, [id]), /35\.00/);
      assert.equal(await verify(kind, id, parent.approval_hash, parent.approval_version), true);
      assert.equal((await approve(kind, id)).already_approved, true);
    });
    await test(`${kind}: normal JS deserialization no longer breaks stored-column hash verification`, async () => {
      const parent = await load(kind, id);
      const roundTripped = JSON.parse(JSON.stringify(parent.approval_snapshot));
      assert.notEqual(await rpc('finance_approval_snapshot_hash', [roundTripped]), parent.approval_hash);
      assert.equal(await verify(kind, id, parent.approval_hash, parent.approval_version), true);
      assert.equal(await verify(kind, id, '0'.repeat(64), parent.approval_version), false);
      assert.equal(await verify(kind, id, parent.approval_hash, Number(parent.approval_version) + 1), false);
    });
    await test(`${kind}: RLS blocks edits to approved children and forged approval`, async () => {
      const child = kind === 'card_import_batches' ? 'card_transactions' : 'journal_adjustment_lines';
      const parentKey = kind === 'card_import_batches' ? 'batch_id' : 'adjustment_id';
      assert.equal((await asFinance(() => q(`update ${child} set amount=99 where ${parentKey}=$1 returning id`, [id]))).length, 0);
      const fresh = await make();
      await assert.rejects(asFinance(() => q(`update ${kind} set status='approved',approved_by=$1 where id=$2`,
        [outsider, fresh.id])), /row-level security/i);
      await assert.rejects(asRole('authenticated', outsider, () => rpc(kind === 'card_import_batches'
        ? 'approve_card_import_batch' : 'approve_journal_adjustment', [fresh.id])), /Finance access required/);
      await assert.rejects(asRole('authenticated', otherFinance, () => rpc(kind === 'card_import_batches'
        ? 'approve_card_import_batch' : 'approve_journal_adjustment', [fresh.id])), /not found/i);
    });
    await test(`${kind}: reopen clears approval and rejects stale version after reapproval`, async () => {
      const before = await load(kind, id);
      const name = kind === 'card_import_batches' ? 'reopen_card_import_batch' : 'reopen_journal_adjustment';
      await assert.rejects(asFinance(() => rpc(name, [id, ' '])), /reason/i);
      await asFinance(() => rpc(name, [id, 'Correct synthetic coding']));
      const reopened = await load(kind, id);
      assert.equal(reopened.approval_hash, null);
      assert.equal(reopened.approved_by, null);
      assert.equal(reopened.approval_reopened_by, finance);
      assert.equal(reopened.approval_reopen_reason, 'Correct synthetic coding');
      assert.equal(await verify(kind, id, before.approval_hash, before.approval_version), false);
      await approve(kind, id);
      assert.equal(await verify(kind, id, before.approval_hash, before.approval_version), false);
      const after = await load(kind, id);
      assert.equal(Number(after.approval_version), Number(before.approval_version) + 1);
      assert.equal(await verify(kind, id, after.approval_hash, after.approval_version), true);
    });
  }

  await test('stored-column verification rejects altered snapshot, null arguments, and unavailable sources', async () => {
    const fixture = await adjustment();
    await approve(fixture.kind, fixture.id);
    const parent = await load(fixture.kind, fixture.id);
    await q("update journal_adjustments set approval_snapshot=jsonb_set(approval_snapshot,'{payload,TxnDate}','\"2026-09-01\"') where id=$1", [fixture.id]);
    assert.equal(await verify(fixture.kind, fixture.id, parent.approval_hash, parent.approval_version), false);
    assert.equal(await verify(fixture.kind, randomUUID(), parent.approval_hash, 1), false);
    assert.equal(await verify('unsupported', fixture.id, parent.approval_hash, 1), false);
    assert.equal(await verify(fixture.kind, fixture.id, null, 1), false);
  });

  await test('hash RPC is service-only even under Supabase-style default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await scalar("select has_function_privilege($1,'public.finance_approval_hash_matches(text,uuid,text,bigint)','execute')", [role]), false);
      await assert.rejects(asRole(role, finance, () => rpc('finance_approval_hash_matches',
        ['journal_adjustments', randomUUID(), '0'.repeat(64), 1])), /permission denied/i);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','public.finance_approval_hash_matches(text,uuid,text,bigint)','execute')"), true);
  });

  for (const source of ['manual_adjustment', 'shopify_monthly', 'prepaid_amortization', 'fixed_asset_depreciation']) {
    await test(`void locates ${source}, retains approved snapshot and records operator reason`, async () => {
      const fixture = await adjustment(source, source === 'manual_adjustment' ? randomUUID() : `2026-08-${source}`);
      await approve(fixture.kind, fixture.id);
      const before = await load(fixture.kind, fixture.id);
      const postingId = await posted(fixture);
      await assert.rejects(asFinance(() => rpc('void_journal_adjustment', [fixture.id, '  '])), /reason/i);
      await assert.rejects(asRole('authenticated', outsider, () => rpc('void_journal_adjustment', [fixture.id, 'Deleted in synthetic QBO'])), /Finance access/i);
      await assert.rejects(asRole('authenticated', otherFinance, () => rpc('void_journal_adjustment', [fixture.id, 'Wrong tenant'])), /not found|No posted/i);
      const result = await asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Deleted in synthetic QBO']));
      assert.equal(result.ok, true);
      const posting = await load('quickbooks_journal_postings', postingId);
      assert.equal(posting.status, 'voided');
      assert.match(posting.error_message, /Deleted in synthetic QBO/);
      assert.ok(posting.recovery_note.includes(finance));
      assert.match(posting.recovery_note, /at .*Deleted in synthetic QBO/);
      const after = await load(fixture.kind, fixture.id);
      assert.equal(after.status, 'approved');
      assert.equal(after.posting_id, null);
      assert.equal(after.approval_hash, before.approval_hash);
      assert.deepEqual(after.approval_snapshot, before.approval_snapshot);
    });
  }

  await test('legacy journal_adjustment/UUID void lookup remains available', async () => {
    const fixture = await adjustment();
    const postingId = randomUUID();
    await q(`insert into quickbooks_journal_postings(id,company_entity_id,connection_id,source,source_ref,payload,status)
      values ($1,$2,$3,'journal_adjustment',$4,'{}','posted')`, [postingId, co, conn, fixture.id]);
    await q("update journal_adjustments set status='posted',qbo_connection_id=$1,posting_id=$2 where id=$3", [conn, postingId, fixture.id]);
    assert.equal((await asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Legacy QBO deletion']))).ok, true);
    assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'voided');
  });

  await test('void recovers confirmed posting when parent persistence failed using exact approved hash', async () => {
    const fixture = await adjustment('shopify_monthly', '2026-09');
    await approve(fixture.kind, fixture.id);
    const postingId = await posted(fixture, { linked: false, parentStatus: 'approved' });
    assert.equal((await asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Recovered QBO deletion']))).ok, true);
    assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'voided');
  });

  await test('void cannot take an unrelated posting sharing the generated period', async () => {
    const fixture = await adjustment('shopify_monthly', '2026-10');
    await approve(fixture.kind, fixture.id);
    const postingId = await posted(fixture, { linked: false, parentStatus: 'approved', hash: 'f'.repeat(64) });
    await assert.rejects(asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Wrong approval'])), /not found|No posted|match/i);
    assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'posted');
  });

  await test('a set posting link never falls back to another entry for the same generated period', async () => {
    const fixture = await adjustment('prepaid_amortization', '2026-11');
    await approve(fixture.kind, fixture.id);
    const postingId = await posted(fixture, { linked: false, parentStatus: 'approved' });
    const unrelated = await adjustment();
    await approve(unrelated.kind, unrelated.id);
    const unrelatedId = await posted(unrelated);
    await q('update journal_adjustments set posting_id=$1 where id=$2', [unrelatedId, fixture.id]);
    await assert.rejects(asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Wrong link'])), /No posted/i);
    assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'posted');
    assert.equal((await load('quickbooks_journal_postings', unrelatedId)).status, 'posted');
  });

  await test('void rejects company/connection-crossed posting links', async () => {
    for (const wrong of [{ postingCompany: otherCo, postingConnection: otherConn }, { postingConnection: otherConn }]) {
      const fixture = await adjustment();
      await approve(fixture.kind, fixture.id);
      const postingId = await posted(fixture, wrong);
      await assert.rejects(asFinance(() => rpc('void_journal_adjustment', [fixture.id, 'Bad link'])), /not found|No posted|match/i);
      assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'posted');
    }
  });

  await test('active source uniqueness holds across submitting, unknown, posted and connections', async () => {
    for (const status of ['submitting', 'unknown', 'posted']) {
      const sourceRef = randomUUID();
      await q(`insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,payload,status)
        values ($1,$2,'card_import',$3,'{}',$4)`, [co, conn, sourceRef, status]);
      await assert.rejects(q(`insert into quickbooks_journal_postings(company_entity_id,connection_id,source,source_ref,payload,status)
        values ($1,$2,'card_import',$3,'{}','submitting')`, [co, otherConn, sourceRef]), /duplicate key/i);
    }
  });

  await test('composite company constraints reject cross-tenant parents and QBO connection', async () => {
    const fixture = await card();
    await assert.rejects(q('update card_transactions set company_entity_id=$1 where id=$2', [otherCo, fixture.txn]), /foreign key/i);
    await assert.rejects(q('update card_sources set qbo_connection_id=$1 where id=$2', [otherConn, fixture.source]), /foreign key/i);
    const adj = await adjustment();
    await assert.rejects(q('update journal_adjustment_lines set company_entity_id=$1 where adjustment_id=$2', [otherCo, adj.id]), /foreign key/i);
  });

  await test('approved snapshot survives source-config changes and remains verifiable', async () => {
    const fixture = await card();
    await approve(fixture.kind, fixture.id);
    const before = await load(fixture.kind, fixture.id);
    await asFinance(() => q("update card_sources set credit_qbo_account_id='expense',display_name='Changed card' where id=$1", [fixture.source]));
    const after = await load(fixture.kind, fixture.id);
    assert.deepEqual(after.approval_snapshot, before.approval_snapshot);
    assert.equal(await verify(fixture.kind, fixture.id, before.approval_hash, before.approval_version), true);
  });

  await test('unresolved QBO claims block reopening approved card and adjustment inputs', async () => {
    for (const make of [card, adjustment]) {
      const fixture = await make();
      await approve(fixture.kind, fixture.id);
      const postingId = await posted(fixture, { linked: false, parentStatus: 'approved' });
      await q("update quickbooks_journal_postings set status='unknown' where id=$1", [postingId]);
      await assert.rejects(asFinance(() => rpc(fixture.kind === 'card_import_batches'
        ? 'reopen_card_import_batch' : 'reopen_journal_adjustment', [fixture.id, 'Try edit'])), /Resolve the active QuickBooks posting/i);
    }
  });

  await test('the committed Finance V1 schema verification queries execute and return ok', async () => {
    const sql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const checks = splitSqlStatements(sql).filter(({ text }) => /as finance_(v1_posting_controls|approval_stored_hash|adjustment_void_contract)\s*$/i.test(text));
    assert.equal(checks.length, 3);
    for (const { text } of checks) assert.equal(await scalar(text), 'ok');
  });

  console.log(`finance-v1-database: ${passed} database regression cases passed (${await scalar('select version()')})`);
} catch (error) {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally {
  await db.close();
}
