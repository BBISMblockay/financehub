import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

// This suite accepts no database URL or credentials. Every operation, including
// the deliberately rejected writes, runs in a fresh in-memory PostgreSQL.
const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
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
  '20260912000000_finance_v1_posting_controls.sql',
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const scalar = async (sql, params = []) => Object.values(await first(sql, params))[0];
const rpc = (name, params) => scalar(`select public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')})`, params);
const load = (kind, id) => first(`select * from public.${kind} where id=$1`, [id]);
const co = randomUUID(), otherCo = randomUUID();
const finance = randomUUID(), outsider = randomUUID(), otherFinance = randomUUID();
const conn = randomUUID(), otherConn = randomUUID();
const mutation = process.env.PLAID_DB_MUTATION || '';
assert.ok(['', 'csv-authority'].includes(mutation), 'Unknown Plaid database mutation');
let passed = 0;

async function asRole(role, user, fn) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}
const asFinance = (fn) => asRole('authenticated', finance, fn);
const asService = (fn) => asRole('service_role', null, fn);
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) {
    console.error(`not ok - ${name}`);
    // PGlite attaches the entire migration to a SQL error; preserve the useful
    // PostgreSQL message/position without printing 1,000 lines of source in CI.
    if (error.query) delete error.query;
    throw error;
  }
}

function providerAccount(id, type = 'depository') {
  return { account_id: id, name: 'Synthetic account', official_name: 'Synthetic bank account',
    mask: '1234', type, subtype: type === 'credit' ? 'credit card' : 'checking',
    balances: { current: 1000, available: 900, iso_currency_code: 'USD' } };
}
function providerTransaction(account, overrides = {}) {
  return { account_id: account.providerId, transaction_id: `txn-${randomUUID()}`,
    date: '2026-09-11', authorized_date: '2026-09-10', name: 'Synthetic merchant',
    merchant_name: 'Synthetic merchant', amount: 35, iso_currency_code: 'USD',
    pending: false, pending_transaction_id: null, ...overrides };
}
async function bankAccount({ company = co, actor = finance, type = 'depository', mapped = true } = {}) {
  const providerId = `account-${randomUUID()}`, itemId = `item-${randomUUID()}`;
  const result = await asService(() => rpc('plaid_register_connection', [company, itemId,
    'sandbox', 'Synthetic bank', { v: 1, iv: 'synthetic-iv', ciphertext: 'synthetic-ciphertext' },
    [providerAccount(providerId, type)], actor]));
  const account = await first('select * from plaid_accounts where connection_id=$1 and provider_account_id=$2',
    [result.connection_id, providerId]);
  assert.ok(account?.id, 'Registration persists its authoritative account response');
  const fixture = { id: account.id, connectionId: result.connection_id, providerId, itemId, company,
    actor, type, cursor: null, qboId: `bank-${randomUUID()}` };
  if (mapped) await mapAccount(fixture);
  return fixture;
}
async function mapAccount(account, { cutover = '2026-09-01', source = null, qboId = account.qboId } = {}) {
  const qboConnection = account.company === co ? conn : otherConn;
  await q(`insert into quickbooks_accounts(connection_id,company_entity_id,qbo_account_id,name,account_type)
    values ($1,$2,$3,'Synthetic mapped account',$4) on conflict do nothing`,
  [qboConnection, account.company, qboId, account.type === 'credit' ? 'Credit Card' : 'Bank']);
  const result = await asRole('authenticated', account.actor, () => rpc('configure_plaid_account',
    [account.id, qboConnection, qboId, cutover, source]));
  account.source = result.source_id;
  account.qboId = qboId;
  await asRole('authenticated', account.actor, () => q('update card_sources set posting_enabled=true where id=$1', [account.source]));
  return result;
}
async function claim(account, lease = randomUUID()) {
  return { ...await asService(() => rpc('plaid_claim_sync', [account.id, lease])), lease };
}
async function apply(account, changes = {}, lease = null) {
  const claimed = lease || await claim(account);
  const next = `cursor-${randomUUID()}`;
  const result = await asService(() => rpc('plaid_apply_sync', [account.id, claimed.lease,
    claimed.cursor ?? null, next, changes.added || [], changes.modified || [], changes.removed || [],
    [providerAccount(account.providerId, account.type)]]));
  account.cursor = next;
  return result;
}
const transaction = (account, providerId) => first('select * from card_transactions where plaid_account_id=$1 and external_transaction_id=$2', [account.id, providerId]);
async function code(row, overrides = {}) {
  return asFinance(() => rpc('apply_card_coding', [[{ id: row.id, qbo_account_id: 'expense',
    qbo_account_name: 'Synthetic expense', coding_source: 'manual', status: 'coded',
    accounting_treatment: 'purchase', expected_provider_updated_at: row.provider_updated_at, ...overrides }]]));
}
const approve = (batchId) => asFinance(() => rpc('approve_card_import_batch', [batchId]));
async function csv(sourceId, { company = co, date = '2026-09-10' } = {}) {
  const batch = randomUUID(), txn = randomUUID();
  await q(`insert into card_import_batches(id,company_entity_id,source_id,entry_date)
    values ($1,$2,$3,$4)`, [batch, company, sourceId, date]);
  await asRole('authenticated', company === co ? finance : otherFinance, () => q(`insert into card_transactions
    (id,company_entity_id,batch_id,txn_date,amount,description) values ($1,$2,$3,$4,12,'Synthetic CSV row')`,
  [txn, company, batch, date]));
  return { batch, txn };
}
async function csvSource(qboId = `csv-bank-${randomUUID()}`) {
  const id = randomUUID();
  await q(`insert into quickbooks_accounts(connection_id,company_entity_id,qbo_account_id,name,account_type)
    values ($1,$2,$3,'Synthetic CSV bank','Bank') on conflict do nothing`, [conn, co, qboId]);
  await asFinance(() => q(`insert into card_sources(id,company_entity_id,source_key,display_name,
    credit_qbo_account_id,qbo_connection_id,posting_enabled) values ($1,$2,$5,'Synthetic CSV source',$3,$4,true)`,
  [id, co, qboId, conn, id]));
  return { id, qboId };
}
async function markPosted(table, id) {
  const parent = await load(table, id);
  const postingId = randomUUID();
  await asService(() => q(`insert into quickbooks_journal_postings(id,company_entity_id,connection_id,
    source,source_ref,payload,payload_hash,status,qbo_journal_entry_id)
    values ($1,$2,$3,$4,$5,$6,$7,'posted',$8)`, [postingId, co, parent.qbo_connection_id,
    parent.approval_snapshot.source, parent.approval_snapshot.source_ref,
    parent.approval_snapshot.payload, parent.approval_hash, `synthetic-qbo-${postingId}`]));
  await asService(() => q(`update ${table} set status='posted',posting_id=$1 where id=$2`, [postingId, id]));
  return postingId;
}
async function correction(account, { posted = false, company = co, qboConnection = conn } = {}) {
  const id = randomUUID();
  await q(`insert into journal_adjustments(id,company_entity_id,entry_date,memo,qbo_connection_id)
    values ($1,$2,'2026-09-12','Correct provider amount difference',$3)`, [id, company, qboConnection]);
  await q(`insert into journal_adjustment_lines(company_entity_id,adjustment_id,line_no,qbo_account_id,posting_type,amount)
    values ($1,$2,1,'expense','Debit',5),($1,$2,2,$3,'Credit',5)`, [company, id, account.qboId]);
  if (posted) {
    await asFinance(() => rpc('approve_journal_adjustment', [id]));
    await markPosted('journal_adjustments', id);
  }
  return id;
}

try {
  await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) {
    try { await db.exec(await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')); }
    catch (error) { throw new Error(`Dependency migration failed: ${name}: ${error.message}`, { cause: error }); }
  }
  await q("insert into entities(id,title) values ($1,'Synthetic A'),($2,'Synthetic B')", [co, otherCo]);
  await q('insert into auth.users(id) values ($1),($2),($3)', [finance, outsider, otherFinance]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'Finance A','user','finance',$4),($2,'Marketing A','user','marketing',$4),
    ($3,'Finance B','user','finance',$5)`, [finance, outsider, otherFinance, co, otherCo]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values
    ($1,$2,'member'),($1,$3,'member'),($4,$5,'member')`, [co, finance, outsider, otherCo, otherFinance]);
  await q(`insert into quickbooks_connections(id,company_entity_id,realm_id)
    values ($1,$2,'synthetic-a'),($3,$4,'synthetic-b')`, [conn, co, otherConn, otherCo]);
  await q(`insert into quickbooks_accounts(connection_id,company_entity_id,qbo_account_id,name,account_type)
    values ($1,$2,'expense','Synthetic expense','Expense'),($1,$2,'clearing','Synthetic clearing','Other Current Asset'),
    ($1,$2,'card-liability','Synthetic card liability','Credit Card'),($1,$2,'bank','Synthetic bank','Bank'),
    ($3,$4,'expense','Other expense','Expense'),($3,$4,'bank','Other bank','Bank')`, [conn, co, otherConn, otherCo]);
  const names = (await readdir(new URL('supabase/migrations/', root))).filter(name => /^\d+_plaid_bank_feed\.sql$/.test(name));
  assert.equal(names.length, 1, 'Exactly one Plaid bank-feed migration must be committed');
  const migration = await readFile(new URL(`supabase/migrations/${names[0]}`, root), 'utf8');
  await test('Plaid migration applies twice under Supabase-style default grants', async () => {
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await scalar("select count(*)::integer from pg_class where relname='plaid_accounts' and relrowsecurity"), 1);
  });
  await test('committed Plaid health checks execute against the migrated database', async () => {
    const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const start = verifySql.indexOf('-- Plaid ingestion: metadata');
    assert.ok(start >= 0, 'Plaid health checks must be committed');
    const checks = splitSqlStatements(verifySql.slice(start));
    assert.ok(checks.length >= 4);
    for (const sql of checks) {
      const rows = await q(sql.text);
      assert.ok(rows.length > 0, 'A verification check must return evidence');
      for (const row of rows) assert.equal(row.status ?? row.plaid_identity_and_audit_contract, 'ok', JSON.stringify(row));
    }
    const storedHashCheck = splitSqlStatements(verifySql).find(sql => sql.text.includes('as finance_approval_stored_hash'));
    assert.ok(storedHashCheck);
    assert.equal(await scalar(storedHashCheck.text), 'ok', 'The existing approval verifier must remain compatible');
  });
  if (mutation === 'csv-authority') {
    // Deliberately restore the double-import defect in the actual PostgreSQL
    // trigger. The unchanged alternate-CSV-source assertion must reject it.
    const definition = await scalar("select pg_get_functiondef('public.plaid_guard_transaction()'::regprocedure)");
    const guard = 'if v_cutover is not null and (new.txn_date is null or new.txn_date>=v_cutover) then';
    assert.ok(definition.includes(guard), 'Mutation must replace the live authority guard');
    await db.exec(definition.replace(guard, 'if false then'));
  }

  // Behavioral cases are deliberately against RPCs, policies and constraints
  // loaded from the committed SQL, not copies of their implementation.

  await test('credentials and sync RPCs are service-only; finance reads only its active company', async () => {
    const own = await bankAccount(), other = await bankAccount({ company: otherCo, actor: otherFinance });
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(role, finance, () => q('select * from plaid_connection_secrets')), /permission denied/i);
      for (const [name, args] of [
        ['plaid_claim_sync', [own.id, randomUUID()]],
        ['plaid_release_sync', [own.id, randomUUID(), 'TEST']],
        ['plaid_apply_sync', [own.id, randomUUID(), null, 'forged', [], [], [], []]],
        ['plaid_register_connection', [co, 'forged', 'sandbox', 'Forged', { v: 1, iv: 'x', ciphertext: 'y' }, [], finance]],
      ]) await assert.rejects(asRole(role, finance, () => rpc(name, args)), /permission denied/i);
    }
    assert.equal(await asFinance(() => scalar('select count(*)::integer from plaid_accounts where id=$1', [own.id])), 1);
    assert.equal(await asFinance(() => scalar('select count(*)::integer from plaid_accounts where id=$1', [other.id])), 0);
    assert.equal(await asRole('authenticated', outsider, () => scalar('select count(*)::integer from plaid_accounts')), 0);
    assert.equal(await asService(() => scalar('select count(*)::integer from plaid_connection_secrets where connection_id=$1', [own.connectionId])), 1);
    await assert.rejects(asFinance(() => q("update plaid_accounts set cursor='forged' where id=$1", [own.id])), /permission denied/i);
    await assert.rejects(asFinance(() => q("update plaid_connections set status='active' where id=$1", [own.connectionId])), /permission denied/i);
    await assert.rejects(asFinance(() => rpc('configure_plaid_account', [other.id, otherConn, other.qboId, '2026-09-01', null])), /not found|company|access/i);
  });

  await test('finance context resolves company and permission together under the caller identity', async () => {
    assert.equal(await asFinance(() => rpc('plaid_finance_context', [])), co);
    assert.equal(await asRole('authenticated', otherFinance, () => rpc('plaid_finance_context', [])), otherCo);
    assert.equal(await asRole('authenticated', outsider, () => rpc('plaid_finance_context', [])), null);
    for (const role of ['anon', 'service_role']) {
      await assert.rejects(asRole(role, finance, () => rpc('plaid_finance_context', [])), /permission denied/i);
    }
  });

  await test('account mapping refuses foreign-company QBO references and non-finance callers', async () => {
    const account = await bankAccount({ mapped: false });
    await assert.rejects(asFinance(() => rpc('configure_plaid_account', [account.id, otherConn, 'bank', '2026-09-01', null])), /company|connection|account/i);
    await assert.rejects(asRole('authenticated', outsider, () => rpc('configure_plaid_account', [account.id, conn, 'bank', '2026-09-01', null])), /finance|access/i);
    await assert.rejects(asFinance(() => rpc('configure_plaid_account', [account.id, conn, 'bank', null, null])), /cutover|date/i);
    assert.equal((await load('plaid_accounts', account.id)).source_id, null);
  });

  await test('registration validates the initiating company and cannot reassign an existing Plaid item', async () => {
    const account = await bankAccount({ mapped: false });
    const register = (company, actor) => asService(() => rpc('plaid_register_connection', [company,
      account.itemId, 'sandbox', 'Synthetic bank', { v: 1, iv: 'new-iv', ciphertext: 'new-ciphertext' },
      [providerAccount(account.providerId)], actor]));
    await assert.rejects(register(otherCo, finance), /company|actor|access|finance|connecting user/i);
    await assert.rejects(register(otherCo, otherFinance), /company|another|belongs|linked|registered/i);
    assert.equal((await load('plaid_connections', account.connectionId)).company_entity_id, co);
    assert.equal(await scalar('select count(*)::integer from plaid_connections where item_id=$1', [account.itemId]), 1);
    const same = await register(co, finance);
    assert.equal(same.connection_id, account.connectionId);
    assert.equal(await scalar('select count(*)::integer from plaid_accounts where connection_id=$1', [account.connectionId]), 1);
  });

  await test('cutover checks all CSV sources mapped to the same financial account', async () => {
    const source = await csvSource();
    await csv(source.id);
    const account = await bankAccount({ mapped: false });
    await assert.rejects(mapAccount(account, { qboId: source.qboId }), /CSV|overlap/i);
    assert.equal((await load('plaid_accounts', account.id)).source_id, null);
    assert.equal(await scalar("select count(*)::integer from card_sources where ingest_mode='plaid' and credit_qbo_account_id=$1", [source.qboId]), 0);
    await mapAccount(account, { qboId: source.qboId, cutover: '2026-09-11' });
    await csv(source.id, { date: '2026-09-10' });
    await assert.rejects(csv(source.id, { date: '2026-09-11' }), /CSV|overlap/i);
    const alternate = await csvSource(source.qboId);
    await assert.rejects(csv(alternate.id, { date: '2026-09-12' }), /CSV|overlap/i);
    const duplicate = await bankAccount({ mapped: false });
    await assert.rejects(mapAccount(duplicate, { qboId: source.qboId, cutover: '2026-09-11' }), /authoritative|already|mapped/i);
    await assert.rejects(asFinance(() => q("update card_sources set authoritative_from='2026-10-01' where id=$1", [account.source])), /rebound|cutover|configure/i);
  });

  await test('non-admin finance cannot bypass authority with an unbound legacy CSV source', async () => {
    const account = await bankAccount();
    const legacy = await csvSource(account.qboId);
    await asFinance(() => q('update card_sources set qbo_connection_id=null where id=$1', [legacy.id]));
    assert.equal(await asFinance(() => scalar('select count(*)::integer from quickbooks_connections')), 0,
      'The fixture must exercise the admin-only OAuth table policy');
    assert.equal(await asFinance(() => rpc('plaid_effective_qbo_connection', [co, null])), conn);
    assert.equal(await asFinance(() => rpc('plaid_effective_qbo_connection', [otherCo, null])), null);
    await assert.rejects(csv(legacy.id), /CSV|overlap/i);
    assert.equal(await scalar(`select count(*)::integer from card_transactions t join card_import_batches b
      on b.id=t.batch_id where b.source_id=$1`, [legacy.id]), 0);
  });

  await test('existing CSV coding and approval still work without new provider fields', async () => {
    const source = await csvSource();
    const fixture = await csv(source.id);
    await asFinance(() => rpc('apply_card_coding', [[{ id: fixture.txn, qbo_account_id: 'expense',
      coding_source: 'manual', status: 'coded' }]]));
    const row = await load('card_transactions', fixture.txn);
    assert.equal(row.origin, 'csv');
    assert.equal(row.accounting_treatment, 'unknown');
    const approval = await approve(fixture.batch);
    assert.ok(approval.approval_hash);
    assert.equal((await load('card_import_batches', fixture.batch)).status, 'approved');
  });

  await test('populated CSV batches cannot be rebound to another balancing source', async () => {
    const source = await csvSource(), other = await csvSource();
    const fixture = await csv(source.id);
    await assert.rejects(asFinance(() => q('update card_import_batches set source_id=$1 where id=$2',
      [other.id, fixture.batch])), /source|identity|rebind|populated/i);
    assert.equal((await load('card_import_batches', fixture.batch)).source_id, source.id);
  });

  await test('pending rows stay excluded and posted replacements preserve provider linkage', async () => {
    const account = await bankAccount();
    const pending = providerTransaction(account, { pending: true });
    const posted = providerTransaction(account, { pending_transaction_id: pending.transaction_id });
    await apply(account, { added: [pending] });
    const firstPending = await transaction(account, pending.transaction_id);
    assert.equal(firstPending.provider_status, 'pending');
    assert.equal(firstPending.status, 'excluded');
    await assert.rejects(code(firstPending), /pending|excluded/i);
    await apply(account, { added: [posted], removed: [{ transaction_id: pending.transaction_id, account_id: account.providerId }] });
    const afterPending = await transaction(account, pending.transaction_id);
    const afterPosted = await transaction(account, posted.transaction_id);
    assert.equal(afterPending.provider_status, 'removed');
    assert.equal(afterPending.status, 'excluded');
    assert.equal(afterPosted.provider_status, 'posted');
    assert.equal(afterPosted.pending_transaction_id, pending.transaction_id);
    assert.equal(afterPosted.amount, '35.00');
    await code(afterPosted);
    await approve(afterPosted.batch_id);
    assert.equal((await load('card_import_batches', afterPosted.batch_id)).status, 'approved');
  });

  await test('stable provider identity prevents duplicate ingestion and each account has its own cursor', async () => {
    const a = await bankAccount(), b = await bankAccount();
    const raw = providerTransaction(a);
    await apply(a, { added: [raw] });
    await apply(a, { added: [raw] });
    assert.equal(await scalar('select count(*)::integer from card_transactions where plaid_account_id=$1 and external_transaction_id=$2', [a.id, raw.transaction_id]), 1);
    const original = await transaction(a, raw.transaction_id);
    await apply(a, { modified: [{ ...raw, amount: 39.25, name: 'Corrected merchant' }] });
    const updated = await transaction(a, raw.transaction_id);
    assert.equal(updated.id, original.id);
    assert.equal(updated.amount, '39.25');
    assert.equal(updated.description, 'Corrected merchant');
    assert.equal((await load('plaid_accounts', a.id)).cursor, a.cursor);
    assert.equal((await load('plaid_accounts', b.id)).cursor, null);
  });

  await test('coding cannot overwrite an unseen provider update from a stale browser row', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const stale = await transaction(account, raw.transaction_id);
    await apply(account, { modified: [{ ...raw, amount: 42 }] });
    await assert.rejects(code(stale), /provider_transaction_changed|reload|review/i);
    const current = await transaction(account, raw.transaction_id);
    assert.equal(current.amount, '42.00');
    assert.equal(current.status, 'uncoded');
    await assert.rejects(code(current, { expected_provider_updated_at: null }), /provider_transaction_changed|reload|review/i);
    await code(current);
    assert.equal((await load('card_transactions', current.id)).status, 'coded');
  });

  await test('a provider date correction rebatches a mutable transaction into the correct accounting month', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const original = await transaction(account, raw.transaction_id);
    await code(original);
    await apply(account, { modified: [{ ...raw, date: '2026-10-02' }] });
    const moved = await transaction(account, raw.transaction_id);
    assert.equal(moved.id, original.id);
    assert.notEqual(moved.batch_id, original.batch_id);
    assert.equal(moved.status, 'uncoded');
    assert.equal(moved.qbo_account_id, null);
    const priorBatch = await load('card_import_batches', original.batch_id);
    const nextBatch = await load('card_import_batches', moved.batch_id);
    assert.equal(priorBatch.row_count, 0);
    assert.equal(priorBatch.total_amount, '0.00');
    assert.equal(nextBatch.row_count, 1);
    assert.equal(nextBatch.period_start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(nextBatch.entry_date.toISOString(), '2026-10-31T00:00:00.000Z');
    await assert.rejects(asFinance(() => q('update card_transactions set batch_id=$1 where id=$2',
      [original.batch_id, moved.id])), /batch|move|server/i);
    const audit = await first(`select * from finance_audit_events where object_type='card_transactions'
      and object_id=$1 and old_values->>'batch_id'=$2 and new_values->>'batch_id'=$3`,
    [moved.id, original.batch_id, moved.batch_id]);
    assert.ok(audit?.id);
  });

  await test('failed sync rolls back every row, audit event and cursor before retry', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    const claimed = await claim(account);
    const auditBefore = await scalar('select count(*)::integer from finance_audit_events');
    await assert.rejects(apply(account, { added: [raw, providerTransaction(account, { account_id: 'foreign-provider-account' })] }, claimed), /account|mismatch/i);
    assert.equal(await transaction(account, raw.transaction_id), undefined);
    const failed = await load('plaid_accounts', account.id);
    assert.equal(failed.cursor, null);
    assert.equal(failed.sync_lease_id, claimed.lease);
    assert.equal(await scalar('select count(*)::integer from finance_audit_events'), auditBefore);
    await apply(account, { added: [raw] }, claimed);
    assert.ok(await transaction(account, raw.transaction_id));
    assert.equal((await load('plaid_accounts', account.id)).cursor, account.cursor);
  });

  await test('lease and expected cursor reject overlapping or stale workers', async () => {
    const account = await bankAccount();
    const claimed = await claim(account);
    await assert.rejects(claim(account), /sync|lease|progress|busy/i);
    const invoke = (lease, cursor) => asService(() => rpc('plaid_apply_sync', [account.id, lease, cursor, 'stale-write', [], [], [], []]));
    await assert.rejects(invoke(randomUUID(), null), /lease|sync/i);
    await assert.rejects(invoke(claimed.lease, 'stale-cursor'), /cursor|sync/i);
    assert.equal((await load('plaid_accounts', account.id)).cursor, null);
    await apply(account, {}, claimed);
    await assert.rejects(invoke(claimed.lease, null), /lease|sync|cursor/i);
    assert.equal((await load('plaid_accounts', account.id)).cursor, account.cursor);
  });

  await test('unknown bank treatment prevents approval until a person classifies it', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    assert.equal(row.accounting_treatment, 'unknown');
    await code(row, { accounting_treatment: 'unknown' });
    await assert.rejects(approve(row.batch_id), /treatment|review/i);
    await code(row);
    const approval = await approve(row.batch_id);
    assert.ok(approval.approval_hash);
    assert.equal(await asService(() => rpc('finance_approval_hash_matches', ['card_import_batches', row.batch_id, approval.approval_hash, approval.approval_version])), true);
  });

  await test('non-USD provider rows cannot be included or silently converted', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account, { iso_currency_code: 'EUR' });
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    assert.equal(row.currency, 'EUR');
    assert.equal(row.status, 'excluded');
    await assert.rejects(code(row), /USD|excluded|currency/i);
    await assert.rejects(asFinance(() => q("update card_transactions set currency='USD' where id=$1", [row.id])), /server.owned|provider/i);
  });

  await test('malformed amount, missing pending flag and absent currency cannot become an approved USD row', async () => {
    const account = await bankAccount();
    for (const raw of [providerTransaction(account, { amount: 1.001 }),
      { ...providerTransaction(account), pending: undefined }, providerTransaction(account, { date: '09/12/2026' })]) {
      const claimed = await claim(account);
      await assert.rejects(apply(account, { added: [raw] }, claimed), /amount|cent|pending|date|ISO/i);
      assert.equal(await transaction(account, raw.transaction_id), undefined);
      assert.equal((await load('plaid_accounts', account.id)).cursor, null);
      await asService(() => rpc('plaid_release_sync', [account.id, claimed.lease, 'VALIDATION_ERROR']));
    }
    const raw = providerTransaction(account, { iso_currency_code: null });
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    assert.equal(row.currency, null);
    assert.equal(row.status, 'excluded');
    await assert.rejects(code(row), /USD|excluded|currency/i);
  });

  await test('browser cannot forge provider rows, edit raw facts, or erase feed history', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await assert.rejects(asFinance(() => q('update card_transactions set amount=999 where id=$1', [row.id])), /provider|server.owned/i);
    await assert.rejects(asFinance(() => q('delete from card_transactions where id=$1', [row.id])), /provider|delete/i);
    await assert.rejects(asFinance(() => q('delete from card_import_batches where id=$1', [row.batch_id])), /feed|delete/i);
    await assert.rejects(asFinance(() => q(`insert into card_transactions
      (company_entity_id,batch_id,amount,origin,plaid_account_id,external_transaction_id,provider_status)
      values ($1,$2,1,'plaid',$3,'forged','posted')`, [co, row.batch_id, account.id])), /provider|server.owned/i);
  });

  await test('clearing and direction checks block duplicate expense accounting', async () => {
    for (const treatment of ['transfer', 'payroll_settlement', 'shopify_settlement']) {
      const account = await bankAccount();
      const raw = providerTransaction(account);
      await apply(account, { added: [raw] });
      const row = await transaction(account, raw.transaction_id);
      await code(row, { accounting_treatment: treatment });
      await assert.rejects(approve(row.batch_id), /clearing|treatment|direction/i);
      await code(row, { accounting_treatment: treatment, qbo_account_id: 'clearing' });
      await approve(row.batch_id);
    }
    const account = await bankAccount();
    const raw = providerTransaction(account, { amount: -35 });
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    await assert.rejects(approve(row.batch_id), /direction|treatment/i);
    await code(row, { accounting_treatment: 'deposit', qbo_account_id: 'clearing' });
    await approve(row.batch_id);
  });

  await test('bank payment clears card liability; card-feed payment leg cannot post again', async () => {
    const bank = await bankAccount();
    const bankRaw = providerTransaction(bank);
    await apply(bank, { added: [bankRaw] });
    const bankRow = await transaction(bank, bankRaw.transaction_id);
    await code(bankRow, { accounting_treatment: 'card_payment' });
    await assert.rejects(approve(bankRow.batch_id), /payment|clearing|treatment/i);
    await code(bankRow, { accounting_treatment: 'card_payment', qbo_account_id: 'card-liability' });
    await approve(bankRow.batch_id);
    const card = await bankAccount({ type: 'credit' });
    const cardRaw = providerTransaction(card, { amount: -35 });
    await apply(card, { added: [cardRaw] });
    const cardRow = await transaction(card, cardRaw.transaction_id);
    await code(cardRow, { accounting_treatment: 'card_payment', qbo_account_id: 'bank' });
    await assert.rejects(approve(cardRow.batch_id), /payment|clearing|treatment/i);
  });

  await test('Plaid rules require this source and the transaction direction', async () => {
    const a = await bankAccount(), b = await bankAccount();
    const raw = providerTransaction(a);
    await apply(a, { added: [raw] });
    const row = await transaction(a, raw.transaction_id);
    for (const [source, direction] of [[null, 'any'], [b.source, 'outflow'], [a.source, 'inflow'], [a.source, 'outflow']]) {
      const id = randomUUID();
      await asFinance(() => q(`insert into card_coding_rules(id,company_entity_id,source_id,pattern,qbo_account_id,direction,accounting_treatment)
        values ($1,$2,$3,'synthetic merchant','expense',$4,'purchase')`, [id, co, source, direction]));
      if (source === a.source && direction === 'outflow') {
        await code(row, { coding_source: 'rule', rule_id: id });
        assert.equal((await load('card_transactions', row.id)).rule_id, id);
      } else await assert.rejects(code(row, { coding_source: 'rule', rule_id: id }), /source|direction|rule/i);
    }
  });

  await test('approved provider changes quarantine the update and invalidate posting eligibility', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    const approval = await approve(row.batch_id);
    const approved = await load('card_import_batches', row.batch_id);
    await assert.rejects(asService(() => q('update card_transactions set amount=99 where id=$1', [row.id])), /immutable|approved|reopen/i);
    await apply(account, { modified: [{ ...raw, amount: 40 }] });
    const after = await load('card_transactions', row.id);
    assert.equal(after.amount, '35.00');
    assert.deepEqual((await load('card_import_batches', row.batch_id)).approval_snapshot, approved.approval_snapshot);
    const exception = await first("select * from plaid_sync_exceptions where transaction_id=$1 and status='open'", [row.id]);
    assert.ok(exception?.id);
    assert.equal(await asService(() => rpc('finance_approval_hash_matches', ['card_import_batches', row.batch_id,
      approval.approval_hash, approval.approval_version])), false);
    await assert.rejects(asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Accept corrected provider amount', null])), /reopen|approved/i);
    await asFinance(() => rpc('reopen_card_import_batch', [row.batch_id, 'Provider corrected the bank amount']));
    await asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Apply reviewed provider correction', null]));
    assert.equal((await load('card_transactions', row.id)).amount, '40.00');
    const resolved = await load('plaid_sync_exceptions', exception.id);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolved_by, finance);
    await code(await load('card_transactions', row.id));
    const secondApproval = await approve(row.batch_id);
    assert.notEqual(secondApproval.approval_hash, approval.approval_hash);
  });

  await test('provider changes preserve recovery of an existing QBO attempt while blocking every new claim', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    const approval = await approve(row.batch_id);
    const batch = await load('card_import_batches', row.batch_id);
    const newClaim = (hash = approval.approval_hash) => asService(() => scalar(`insert into quickbooks_journal_postings
      (company_entity_id,connection_id,source,source_ref,payload,payload_hash,status)
      values ($1,$2,'card_import',$3,$4,$5,'submitting') returning id`,
    [co, conn, row.batch_id, batch.approval_snapshot.payload, hash]));
    const verifyHash = () => asService(() => rpc('finance_approval_hash_matches', ['card_import_batches', row.batch_id,
      approval.approval_hash, approval.approval_version]));
    await assert.rejects(newClaim('0'.repeat(64)), /claim|approved|match/i);
    const postingId = await newClaim();
    await apply(account, { modified: [{ ...raw, amount: 40 }] });
    assert.equal(await verifyHash(), true, 'Recovery must still attach a JE already accepted by QBO');
    await asService(() => q("update quickbooks_journal_postings set status='unknown' where id=$1", [postingId]));
    assert.equal(await verifyHash(), true);
    await asService(() => q("update quickbooks_journal_postings set payload_hash=$1 where id=$2", ['0'.repeat(64), postingId]));
    assert.equal(await verifyHash(), false, 'An unrelated or corrupted attempt cannot authorize recovery');
    await asService(() => q('update quickbooks_journal_postings set payload_hash=$1 where id=$2', [approval.approval_hash, postingId]));
    await assert.rejects(newClaim(), /bank feed change|new posting|resolve/i);
    await asService(() => q("update quickbooks_journal_postings set status='failed' where id=$1", [postingId]));
    assert.equal(await verifyHash(), false, 'Released claims no longer authorize recovery');
    await assert.rejects(newClaim(), /bank feed change|new posting|resolve/i);
    assert.equal(await scalar('select count(*)::integer from quickbooks_journal_postings where source_ref=$1', [row.batch_id]), 1);
  });

  await test('late additions create a continuation batch and never change an approved month', async () => {
    const account = await bankAccount();
    const original = providerTransaction(account);
    await apply(account, { added: [original] });
    const row = await transaction(account, original.transaction_id);
    await code(row);
    await approve(row.batch_id);
    const late = providerTransaction(account);
    await apply(account, { added: [late] });
    const lateRow = await transaction(account, late.transaction_id);
    assert.notEqual(lateRow.batch_id, row.batch_id);
    const oldBatch = await load('card_import_batches', row.batch_id);
    const nextBatch = await load('card_import_batches', lateRow.batch_id);
    assert.equal(oldBatch.status, 'approved');
    assert.deepEqual(nextBatch.period_start, oldBatch.period_start);
    assert.ok(nextBatch.feed_sequence > oldBatch.feed_sequence);
    assert.ok(['draft', 'categorized'].includes(nextBatch.status));
  });

  await test('posted provider exceptions require a posted same-connection correction entry', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    await approve(row.batch_id);
    await markPosted('card_import_batches', row.batch_id);
    await apply(account, { modified: [{ ...raw, amount: 40 }] });
    const exception = await first("select * from plaid_sync_exceptions where transaction_id=$1 and status='open'", [row.id]);
    assert.equal((await load('card_transactions', row.id)).amount, '35.00');
    const draft = await correction(account);
    await assert.rejects(asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Reviewed provider correction', null])), /correction|posted/i);
    await assert.rejects(asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Reviewed provider correction', draft])), /correction|posted/i);
    await assert.rejects(asFinance(() => rpc('resolve_plaid_exception', [exception.id, ' ', draft])), /reason/i);
    const wrongConnection = randomUUID();
    await q('insert into quickbooks_connections(id,company_entity_id,realm_id) values ($1,$2,$3)',
      [wrongConnection, co, `other-realm-${wrongConnection}`]);
    await q(`insert into quickbooks_accounts(connection_id,company_entity_id,qbo_account_id,name,account_type)
      values ($1,$2,'expense','Other realm expense','Expense'),($1,$2,$3,'Other realm bank','Bank')`,
    [wrongConnection, co, account.qboId]);
    const wrongRealmCorrection = await correction(account, { posted: true, qboConnection: wrongConnection });
    await assert.rejects(asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Wrong realm correction', wrongRealmCorrection])), /connection|correction/i);
    const postedCorrection = await correction(account, { posted: true });
    await asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Posted the five-dollar provider correction', postedCorrection]));
    const resolved = await load('plaid_sync_exceptions', exception.id);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.correction_adjustment_id, postedCorrection);
    assert.equal((await load('card_transactions', row.id)).amount, '35.00');
    assert.equal((await load('card_import_batches', row.batch_id)).status, 'posted');
    // Replaying the same provider state after correction must not open a second
    // exception demanding the same accounting difference again.
    await apply(account, { modified: [{ ...raw, amount: 40 }] });
    assert.equal(await scalar("select count(*)::integer from plaid_sync_exceptions where transaction_id=$1 and status='open'", [row.id]), 0);
    // The next provider removal reverses the latest corrected accounting
    // state (40), not the original frozen entry (35).
    await apply(account, { removed: [{ account_id: account.providerId, transaction_id: raw.transaction_id }] });
    const removed = await first("select * from plaid_sync_exceptions where transaction_id=$1 and status='open'", [row.id]);
    assert.equal(removed.previous_payload.amount, 40);
    assert.equal(removed.provider_payload.amount, 40);
    assert.equal(removed.provider_payload._silo_removed, true);
    assert.equal((await load('card_transactions', row.id)).amount, '35.00');
  });

  await test('pending changes after posting remain outside accounting without requiring a fictitious correction JE', async () => {
    const account = await bankAccount();
    const pending = providerTransaction(account, { pending: true, amount: 8 });
    const included = providerTransaction(account);
    await apply(account, { added: [pending, included] });
    const pendingRow = await transaction(account, pending.transaction_id);
    const postedRow = await transaction(account, included.transaction_id);
    await code(postedRow);
    await approve(postedRow.batch_id);
    await markPosted('card_import_batches', postedRow.batch_id);
    await apply(account, { modified: [{ ...pending, amount: 9 }] });
    assert.equal((await load('card_transactions', pendingRow.id)).amount, '8.00', 'Posted batch history remains immutable');
    assert.equal(await scalar("select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'", [account.id]), 0);
    const change = await first("select * from plaid_sync_exceptions where transaction_id=$1 order by created_at desc limit 1", [pendingRow.id]);
    assert.equal(change.status, 'resolved');
    assert.equal(change.correction_adjustment_id, null);
    const finalized = providerTransaction(account, { amount: 9, pending_transaction_id: pending.transaction_id });
    await apply(account, { added: [finalized], removed: [{ account_id: account.providerId, transaction_id: pending.transaction_id }] });
    const finalizedRow = await transaction(account, finalized.transaction_id);
    assert.notEqual(finalizedRow.batch_id, postedRow.batch_id);
    assert.equal(finalizedRow.provider_status, 'posted');
    assert.equal(finalizedRow.amount, '9.00');
    assert.equal(await scalar("select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'", [account.id]), 0);
  });

  await test('posted metadata enrichment is audited without altering approved accounting or requiring another journal', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    await approve(row.batch_id);
    const before = await load('card_import_batches', row.batch_id);
    await markPosted('card_import_batches', row.batch_id);
    const enriched = { ...raw, location: { city: 'Portland', region: 'OR' },
      counterparties: [{ name: 'Synthetic merchant', confidence_level: 'VERY_HIGH' }] };
    await apply(account, { modified: [enriched] });
    assert.deepEqual((await load('card_transactions', row.id)).raw, raw);
    assert.deepEqual((await load('card_import_batches', row.batch_id)).approval_snapshot, before.approval_snapshot);
    assert.equal(await scalar("select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'", [account.id]), 0);
    const event = await first('select * from plaid_sync_exceptions where transaction_id=$1 order by created_at desc limit 1', [row.id]);
    assert.equal(event.status, 'resolved');
    assert.equal(event.correction_adjustment_id, null);
    assert.deepEqual(event.provider_payload, enriched);
  });

  await test('existing void and reopen can recover a deleted QBO journal even after a provider change', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    await approve(row.batch_id);
    const postingId = await markPosted('card_import_batches', row.batch_id);
    await apply(account, { modified: [{ ...raw, amount: 40 }] });
    const exception = await first("select * from plaid_sync_exceptions where transaction_id=$1 and status='open'", [row.id]);
    await asFinance(() => rpc('void_card_posting', [row.batch_id, 'Original synthetic JE deleted in QBO']));
    assert.equal((await load('quickbooks_journal_postings', postingId)).status, 'voided');
    assert.equal((await load('card_import_batches', row.batch_id)).status, 'approved');
    await asFinance(() => rpc('reopen_card_import_batch', [row.batch_id, 'Apply corrected bank data after QBO deletion']));
    await asFinance(() => rpc('resolve_plaid_exception', [exception.id, 'Reviewed corrected bank amount', null]));
    assert.equal((await load('card_transactions', row.id)).amount, '40.00');
    await code(await load('card_transactions', row.id));
    await approve(row.batch_id);
  });

  await test('finance audit records coding and approval with the actual actor and cannot be rewritten', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account);
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    await code(row);
    await approve(row.batch_id);
    const codingEvent = await first(`select * from finance_audit_events where object_type='card_transactions'
      and object_id=$1 and new_values->>'coding_source'='manual' order by created_at desc limit 1`, [row.id]);
    assert.equal(codingEvent.actor_user_id, finance);
    assert.equal(codingEvent.old_values.status, 'uncoded');
    assert.equal(codingEvent.new_values.status, 'coded');
    const approvalEvent = await first(`select * from finance_audit_events where object_type='card_import_batches'
      and object_id=$1 and new_values->>'status'='approved' order by created_at desc limit 1`, [row.batch_id]);
    assert.equal(approvalEvent.actor_user_id, finance);
    assert.ok(approvalEvent.new_values.approval_hash);
    for (const role of ['authenticated', 'service_role']) {
      await assert.rejects(asRole(role, finance, () => q('update finance_audit_events set reason=$1 where id=$2', ['forged', codingEvent.id])), /permission denied|append.only/i);
      await assert.rejects(asRole(role, finance, () => q('delete from finance_audit_events where id=$1', [codingEvent.id])), /permission denied|append.only/i);
      await assert.rejects(asRole(role, finance, () => q(`insert into finance_audit_events
        (company_entity_id,object_type,object_id,event_type,actor_user_id) values ($1,'card_transactions',$2,'forged',$3)`,
      [co, row.id, outsider])), /permission denied|row.level security/i);
    }
    assert.equal(await asRole('authenticated', otherFinance, () => scalar('select count(*)::integer from finance_audit_events where object_id=$1', [row.id])), 0);
  });

  console.log(`${passed} Plaid database tests passed (local PostgreSQL only).`);
} finally {
  await db.close();
}
