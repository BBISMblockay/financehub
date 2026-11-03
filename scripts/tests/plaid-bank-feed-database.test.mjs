import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { btree_gist } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/btree_gist.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

// This suite accepts no database URL or credentials. Every operation, including
// the deliberately rejected writes, runs in a fresh in-memory PostgreSQL.
// btree_gist backs the cashflow override exclusion constraint that the
// verifier tail now checks; without it that migration cannot apply here.
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
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
  '20260904310000_cash_flow_forecast.sql',
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
    const historyMigration = await readFile(new URL('supabase/migrations/20260912203725_bank_feed_workspace_history.sql', root), 'utf8');
    await db.exec(historyMigration); await db.exec(historyMigration);
    await db.exec(await readFile(new URL('supabase/migrations/20260912231606_accounting_foundation.sql', root), 'utf8'));
    await db.exec(await readFile(new URL('supabase/migrations/20260913022606_qbo_historical_ledger.sql', root), 'utf8'));
    // The verifier slice below runs every check from the Plaid marker to the
    // "End of Plaid fixture checks" marker, so each migration whose check lands after that marker must
    // be applied here first. #684 and #686 appended checks without doing so and
    // the finance-database job went red on every push to main from then on.
    for (const later of ['20260913054723_profiles_active_company_scope.sql', '20260913062551_cashflow_overrides_liquidity.sql', '20260914220000_qbo_history_number_formats.sql', '20260915000000_qbo_history_bounded_archive.sql', '20260915100000_card_transaction_splits.sql', '20260915200000_qbo_history_unattributed_section.sql', '20260915210000_qbo_history_trial_balance_period.sql', '20260915220000_plaid_removed_from_status.sql', '20260923120000_card_coding_suggestions.sql', '20260923130000_card_coding_background_preparation.sql', '20260923140000_card_coding_evidence_and_rules.sql', '20261103070000_plaid_manual_days.sql']) {
      const sql = await readFile(new URL(`supabase/migrations/${later}`, root), 'utf8');
      await db.exec(sql); await db.exec(sql);
    }
    assert.equal(await scalar("select count(*)::integer from pg_class where relname='plaid_accounts' and relrowsecurity"), 1);
  });
  await test('committed Plaid health checks execute against the migrated database', async () => {
    const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const start = verifySql.indexOf('-- Plaid ingestion: metadata');
    assert.ok(start >= 0, 'Plaid health checks must be committed');
    // Stop at the explicit end marker: checks after it test schema this fixture
    // does not build (the AI credit ledger, 20261001120000, was the first) and
    // are executed by their own suites instead.
    const end = verifySql.indexOf('-- ── End of Plaid fixture checks', start);
    assert.ok(end > start, 'The end-of-Plaid-fixture marker must follow the Plaid marker');
    const checks = splitSqlStatements(verifySql.slice(start, end));
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

  await test('mutable metadata enrichment preserves saved coding and an open editor revision', async () => {
    for (const status of ['draft', 'categorized']) {
      const account = await bankAccount();
      const raw = providerTransaction(account);
      await apply(account, { added: [raw] });
      const row = await transaction(account, raw.transaction_id);
      await code(row, { memo: 'Reviewed purchase', vendor_name: 'Reviewed vendor', confidence: 0.9 });
      await asFinance(() => q('update card_import_batches set status=$1 where id=$2', [status, row.batch_id]));
      const before = await load('card_transactions', row.id);
      const enriched = { ...raw, logo_url: 'https://example.test/logo.png', location: { city: 'Portland' },
        counterparties: [{ name: 'Synthetic merchant', confidence_level: 'VERY_HIGH' }] };
      await apply(account, { modified: [enriched] });
      const after = await load('card_transactions', row.id);
      assert.deepEqual(after.raw, enriched);
      assert.deepEqual({ ...after, raw: before.raw, updated_at: before.updated_at }, before,
        'Every coding field, attribution and accounting revision survives metadata-only sync');
      assert.equal((await load('card_import_batches', row.batch_id)).status, status);
      assert.ok(await scalar("select count(*)::integer from finance_audit_events where object_id=$1 and new_values->'raw'=$2::jsonb", [row.id, JSON.stringify(enriched)]));
      await code(before, { memo: 'Unsaved edit from before enrichment' });
      assert.equal((await load('card_transactions', row.id)).memo, 'Unsaved edit from before enrichment');
      await apply(account, { modified: [{ ...enriched, amount: 40 }] });
      const changed = await load('card_transactions', row.id);
      assert.equal(changed.status, 'uncoded');
      assert.equal(changed.qbo_account_id, null);
      await assert.rejects(code(before), /provider_transaction_changed/);
    }
  });

  /* BATCH_FIELDS is read from the shipped page, so it names the batch view as
     the NEWEST migration defines it, while the fixture above stops at a slice
     of the migration history on purpose. Rather than drag the whole later
     accounting stack in (and its verifier checks with it), bring just this
     view to head: every committed re-definition of it, and every column a
     later migration adds to card_sources, which is all it reads from. Without
     this the suite went red the first time the view gained a column
     (source_posting_start_on, 20261015020000). */
  await test('the batch view is brought to its committed head definition', async () => {
    const names = (await readdir(new URL('supabase/migrations/', root))).filter((name) => name.slice(0, 14) > '20260923140000').sort();
    for (const name of names) {
      const sql = await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8');
      if (!/card_import_batches_v|card_sources/i.test(sql)) continue;
      for (const statement of splitSqlStatements(sql)) {
        if (!/^\s*(drop\s+view\s+if\s+exists\s+public\.card_import_batches_v|create\s+(or\s+replace\s+)?view\s+public\.card_import_batches_v|grant\s+select\s+on\s+public\.card_import_batches_v|alter\s+table\s+(public\.)?card_sources\s+add\s+column\s+if\s+not\s+exists)/i.test(statement.text)) continue;
        await db.exec(statement.text);
      }
    }
    assert.equal(await scalar("select count(*)::integer from pg_class where relname='card_import_batches_v'"), 1);
  });

  await test('batch page projection excludes journal payloads and uses real view columns', async () => {
    const html = await readFile(new URL('v2/transactions.html', root), 'utf8');
    const fields = html.match(/(?:const|let) BATCH_FIELDS = '([^']+)'/)[1];
    assert.ok(!fields.includes('*') && !fields.includes('approval_snapshot'));
    assert.ok(fields.includes('source_id') && fields.includes('posting_status'));
    await q(`select ${fields} from public.card_import_batches_v limit 1`);
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
    await assert.rejects(newClaim(), (error) => error.code === 'PBF01' && /bank feed change/i.test(error.message));
    await asService(() => q("update quickbooks_journal_postings set status='failed' where id=$1", [postingId]));
    assert.equal(await verifyHash(), false, 'Released claims no longer authorize recovery');
    await assert.rejects(newClaim(), (error) => error.code === 'PBF01' && /bank feed change/i.test(error.message));
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

  /* A removal has to say which kind it was, at the moment it happens. A pending
     row was never codeable and never reached the books, so retiring its id is
     the feed's own bookkeeping; a posted row being retracted is a real event.
     provider_status collapses both to 'removed', and on this connection the
     pairing cannot be recovered afterwards -- no payload carries
     pending_transaction_id -- so the pre-removal status is the only thing that
     distinguishes them. */
  await test('a removal records what the row was when the bank retired it', async () => {
    const account = await bankAccount();
    const pending = providerTransaction(account, { pending: true, amount: 12 });
    const posted = providerTransaction(account, { amount: 34 });
    await apply(account, { added: [pending, posted] });
    const pendingRow = await transaction(account, pending.transaction_id);
    const postedRow = await transaction(account, posted.transaction_id);
    assert.equal((await load('card_transactions', pendingRow.id)).removed_from_status, null,
      'nothing is stamped while a row is live');

    await apply(account, { removed: [
      { account_id: account.providerId, transaction_id: pending.transaction_id },
      { account_id: account.providerId, transaction_id: posted.transaction_id },
    ] });
    const wasPending = await load('card_transactions', pendingRow.id);
    const wasPosted = await load('card_transactions', postedRow.id);
    assert.equal(wasPending.provider_status, 'removed');
    assert.equal(wasPosted.provider_status, 'removed', 'one status covers both');
    assert.equal(wasPending.removed_from_status, 'pending', 'and the column tells them apart');
    assert.equal(wasPosted.removed_from_status, 'posted');

    /* A repeat removal is a no-op: it rebuilds the identical payload and the
       status is already 'removed', so the projection returns 'unchanged' before
       reaching the update. This asserts that no-op, NOT the coalesce that would
       protect the value if the update ever did run -- see the migration. */
    await apply(account, { removed: [{ account_id: account.providerId, transaction_id: pending.transaction_id }] });
    assert.equal((await load('card_transactions', pendingRow.id)).removed_from_status, 'pending',
      'a second removal leaves the first answer alone');

    // Coming back clears it: the column only ever describes a row removed NOW.
    await apply(account, { added: [{ ...pending, pending: false }] });
    const back = await load('card_transactions', pendingRow.id);
    assert.equal(back.provider_status, 'posted');
    assert.equal(back.removed_from_status, null, 'a live row is not described as removed from anything');
  });

  /* The one place removed_from_status cannot be recorded, pinned so it is not
     rediscovered as a surprise.

     A pending row can sit inside a batch that is later approved and posted: it
     is excluded, so it never reaches the journal, but it is still a row in that
     month. When the bank afterwards retires that pending id, the projection
     records the change as a resolved no-impact exception and returns without
     touching card_transactions -- and it could not touch it anyway. The
     immutability trigger on card_transactions raises for ANY update to a row
     whose batch has left draft/categorized, service_role included ("Approved or
     posted transactions are immutable").

     So the row keeps provider_status='pending' and removed_from_status=null,
     and the page goes on showing it as pending. That predates this work -- the
     row read 'pending' forever before removed_from_status existed -- and fixing
     it means either weakening a finance immutability guard for the sake of a
     label, which is the wrong trade, or holding live feed state outside the
     frozen snapshot, which is a design decision rather than a patch. The
     removal is not lost: the exception row below is the record. */
  await test('a pending row retired after its batch is posted stays frozen, and the removal is recorded as an exception', async () => {
    const account = await bankAccount();
    const pending = providerTransaction(account, { pending: true, amount: 21 });
    const posted = providerTransaction(account, { amount: 77 });
    await apply(account, { added: [pending, posted] });
    const pendingRow = await transaction(account, pending.transaction_id);
    const postedRow = await transaction(account, posted.transaction_id);
    assert.equal(pendingRow.status, 'excluded', 'a pending row is excluded, so the batch can still be posted');
    await code(postedRow);
    await approve(postedRow.batch_id);
    await markPosted('card_import_batches', postedRow.batch_id);

    await apply(account, { removed: [{ account_id: account.providerId, transaction_id: pending.transaction_id }] });
    const after = await load('card_transactions', pendingRow.id);
    assert.equal(after.provider_status, 'pending', 'the frozen snapshot wins over the feed');
    assert.equal(after.removed_from_status, null, 'so the classification cannot be written here');

    // The write is refused by the database, not merely skipped by the function.
    await assert.rejects(
      q(`update public.card_transactions set removed_from_status='pending' where id=$1`, [pendingRow.id]),
      /Approved or posted transactions are immutable/,
      'and no caller can route around it');

    // What the removal DID leave behind, so it is recoverable.
    const change = await first(`select * from plaid_sync_exceptions where transaction_id=$1
      order by created_at desc limit 1`, [pendingRow.id]);
    assert.equal(change.status, 'resolved', 'recorded, and no false alarm for finance');
    assert.equal(change.provider_payload._silo_removed, true, 'the exception is the record that the id was retired');
  });

  await test('only pending, posted or null can be stored in the removed-from column', async () => {
    const account = await bankAccount();
    const raw = providerTransaction(account, { amount: 5 });
    await apply(account, { added: [raw] });
    const row = await transaction(account, raw.transaction_id);
    // A real row, so the constraint is actually evaluated -- an update matching
    // nothing would pass whatever the constraint said.
    await assert.rejects(
      q(`update public.card_transactions set removed_from_status='cleared' where id=$1`, [row.id]),
      /card_transactions_removed_from_status_check/,
      'a third value is refused by the database, not by a caller remembering');
    assert.equal((await load('card_transactions', row.id)).removed_from_status, null);
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

  // A split row is coding, and the feed discards coding when the provider
  // corrects a DRAFT row's accounting facts. If the split lines survived that
  // reset, the tie check on card_transactions would raise inside
  // plaid_apply_sync, rolling the whole call back -- cursor included -- so
  // every later sync of that account re-reads the same correction and fails
  // the same way. One split transaction would stop the account's feed for good.
  // Verified to have teeth by disabling card_splits_follow_provider_change's
  // condition in the migration and re-running: the correction then raises
  // "This transaction is split into lines totalling 100.00; changing its amount
  // to 105.00 would leave the split short" from inside plaid_apply_sync.
  await test('a provider amount correction to a split row clears the split and lets the cursor advance', async () => {
    const account = await bankAccount();
    const provider = providerTransaction(account, { amount: 100 });
    await apply(account, { added: [provider] });
    const row = await transaction(account, provider.transaction_id);
    await asFinance(() => rpc('set_card_transaction_splits',
      [row.id, JSON.stringify([{ amount: 60, qbo_account_id: 'expense' }, { amount: 40, qbo_account_id: account.qboId }]), false, 'merchant']));
    assert.equal(await scalar('select count(*)::integer from card_transaction_splits where transaction_id=$1', [row.id]), 2,
      'the row is split before the bank corrects it');
    assert.equal((await first('select status,qbo_account_id from card_transactions where id=$1', [row.id])).qbo_account_id, null,
      'a split row carries no single account');

    const cursorBefore = await scalar('select cursor from plaid_accounts where id=$1', [account.id]);
    await apply(account, { modified: [{ ...provider, amount: 105 }] });

    const after = await first('select amount,status,qbo_account_id from card_transactions where id=$1', [row.id]);
    assert.equal(Number(after.amount), 105, 'the correction is applied');
    assert.equal(after.status, 'uncoded', 'and the row needs coding again, as an unsplit row would');
    assert.equal(await scalar('select count(*)::integer from card_transaction_splits where transaction_id=$1', [row.id]), 0,
      'the split went with the coding: its lines allocated an amount the statement no longer says');
    assert.notEqual(await scalar('select cursor from plaid_accounts where id=$1', [account.id]), cursorBefore,
      'the cursor advanced, so the next sync does not re-read the same correction for ever');

    // And a second sync still works, which is what "wedged" would break.
    await apply(account, { modified: [{ ...provider, amount: 105, name: 'Synthetic merchant renamed' }] });
    assert.equal((await first('select description from card_transactions where id=$1', [row.id])).description,
      'Synthetic merchant renamed', 'the feed keeps flowing after the correction');
  });

  // Background coding preparation is opted into per account, and a mapped
  // feed's source is guarded against rebinding: the switch must be a plain
  // column update that the guard lets through, and it must not be a way to
  // rebind anything.
  await test('a mapped bank feed can be switched into background coding preparation, by finance, without rebinding it', async () => {
    const account = await bankAccount();
    await asFinance(() => q('update card_sources set auto_prepare_coding=true where id=$1', [account.source]));
    assert.equal(await scalar('select auto_prepare_coding from card_sources where id=$1', [account.source]), true);
    await assert.rejects(asFinance(() => q("update card_sources set auto_prepare_coding=false, authoritative_from='2030-01-01' where id=$1", [account.source])),
      /rebound|cutover|configure/i, 'the switch cannot smuggle a cutover change past the guard');
  });


  // ── Hand-entered days for a stalled feed (20261103070000_plaid_manual_days)
  //
  // The case these cover: the provider itself has nothing for days the bank
  // does have, so there is no sync, refresh or date-range import that can
  // produce them. Someone types them in, codes them, and the feed later
  // delivers the same transactions. Nothing may end up in the books twice,
  // and nobody's coding may be thrown away when it does.
  const manual = (account, rows) => asRole('authenticated', account.actor,
    () => rpc('plaid_import_manual_days', [account.id, rows]));
  const day = (offset) => {
    const d = new Date(Date.now() + offset * 86400_000);
    return d.toISOString().slice(0, 10);
  };
  const rowsFor = (account) => q(`select * from card_transactions where plaid_account_id=$1 order by txn_date,row_no`, [account.id]);

  await test('hand-entered days land as codeable rows that name themselves as typed in', async () => {
    const account = await bankAccount();
    const result = await manual(account, [{ date: day(-3), amount: 120.55, name: 'ACH DEBIT VENDOR' },
      { date: day(-2), amount: -80.10, name: 'ACH CREDIT SHOPIFY' }]);
    assert.equal(result.imported, 2);
    const rows = await rowsFor(account);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.origin, 'manual');
      assert.equal(row.plaid_account_id, account.id);
      assert.equal(row.external_transaction_id, null, 'a typed row carries no provider identity');
      assert.equal(row.provider_status, null);
      assert.ok(row.manual_entered_at, 'the row says it was typed in');
      assert.equal(row.manual_entered_by, account.actor);
      // Postable: the whole point is closing a month the feed stranded.
      assert.equal(row.status, 'uncoded');
    }
  });

  await test('a hand-entered day can never reach a day the feed already delivered', async () => {
    const account = await bankAccount();
    const provider = providerTransaction(account, { date: '2026-09-20' });
    await apply(account, { added: [provider] });
    // On the newest held day, and before it: both are the feed's to own.
    await assert.rejects(manual(account, [{ date: '2026-09-20', amount: 10, name: 'Same day' }]),
      /newest day this account already holds/i);
    await assert.rejects(manual(account, [{ date: '2026-09-19', amount: 10, name: 'Earlier day' }]),
      /newest day this account already holds/i);
    // One good row does not carry a bad one in: the whole call is refused.
    await assert.rejects(manual(account, [{ date: day(-1), amount: 10, name: 'Fine' },
      { date: '2026-09-19', amount: 10, name: 'Not fine' }]), /newest day/i);
    assert.equal((await rowsFor(account)).length, 1, 'nothing was written by a refused call');
  });

  await test('hand-entered days respect the feed cutover, today, and the shape of a row', async () => {
    const account = await bankAccount();
    await assert.rejects(manual(account, [{ date: '2026-08-31', amount: 10, name: 'Before cutover' }]),
      /before this account's feed start date/i);
    await assert.rejects(manual(account, [{ date: day(2), amount: 10, name: 'Future' }]), /in the future/i);
    for (const bad of [{ date: '20261020', amount: 10, name: 'Bad date' }, { date: day(-1), amount: 10.005, name: 'Sub-cent' },
      { date: day(-1), amount: 0, name: 'Zero' }, { date: day(-1), amount: '10', name: 'String amount' },
      { date: day(-1), amount: 10, name: '   ' }]) {
      await assert.rejects(manual(account, [bad]), /YYYY-MM-DD date, a non-zero exact-cent amount and a description/i);
    }
    await assert.rejects(manual(account, []), /No rows to import/i);
    assert.equal((await rowsFor(account)).length, 0);
  });

  // Pressing the button twice is the obvious way to double a day, and these
  // rows carry no provider id to dedupe on afterwards. The forward-only window
  // is what prevents it: a hand-entered row counts as a day the account holds.
  await test('importing the same days twice is refused rather than doubled', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: day(-3), amount: 42, name: 'Once' }]);
    await assert.rejects(manual(account, [{ date: day(-3), amount: 42, name: 'Once' }]),
      /newest day this account already holds/i);
    // And a later day still imports, so the guard blocks repeats, not progress.
    await manual(account, [{ date: day(-2), amount: 43, name: 'Next day' }]);
    assert.equal((await rowsFor(account)).length, 2);
  });

  await test('hand-entered days need finance access, this company, and a settled sync', async () => {
    const account = await bankAccount();
    const rows = [{ date: day(-3), amount: 42, name: 'Typed' }];
    await assert.rejects(asRole('authenticated', outsider, () => rpc('plaid_import_manual_days', [account.id, rows])),
      /Finance access required|Plaid account not found/i);
    await assert.rejects(asRole('authenticated', otherFinance, () => rpc('plaid_import_manual_days', [account.id, rows])),
      /Finance access required|Plaid account not found/i);
    await claim(account);
    await assert.rejects(manual(account, rows), /Wait for account sync to finish/i);
    assert.equal((await rowsFor(account)).length, 0);
  });

  await test('the feed claims the row someone typed for it, and keeps their coding', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 120.55, name: 'ACH DEBIT ACME 0921' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder, { qbo_account_id: 'expense', vendor_name: 'Acme', memo: 'Typed from the portal' });
    // The feed's own copy: same amount, a day later, the bank's own wording.
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-21', amount: 120.55,
      name: 'PREAUTHORIZED ACH DEBIT ACME CORP', merchant_name: 'Acme Corp' })] });
    const rows = await rowsFor(account);
    assert.equal(rows.length, 1, 'the feed claimed the placeholder instead of landing beside it');
    const [row] = rows;
    assert.equal(row.id, placeholder.id, 'it is the same row, so coding and history survive');
    assert.equal(row.origin, 'plaid');
    assert.ok(row.external_transaction_id, 'it now carries the provider identity');
    assert.equal(row.provider_status, 'posted');
    assert.equal(new Date(row.txn_date).toISOString().slice(0, 10), '2026-09-21', "the feed's facts win");
    assert.equal(row.description, 'PREAUTHORIZED ACH DEBIT ACME CORP');
    assert.equal(row.qbo_account_id, 'expense', 'the coding does not');
    assert.equal(row.vendor_name, 'Acme');
    assert.equal(row.memo, 'Typed from the portal');
    assert.equal(row.status, 'coded');
    assert.ok(row.manual_entered_at, 'it stays identifiable as a row that entered the books by hand');
  });

  await test('two identical amounts on one day claim one placeholder each, never the same one twice', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 12500, name: '8FIG' },
      { date: '2026-09-20', amount: 12500, name: '8FIG' }]);
    await apply(account, { added: [
      providerTransaction(account, { date: '2026-09-20', amount: 12500, name: '8FIG PAYMENT ONE' }),
      providerTransaction(account, { date: '2026-09-20', amount: 12500, name: '8FIG PAYMENT TWO' })] });
    const rows = await rowsFor(account);
    assert.equal(rows.length, 2, 'two placeholders, two provider rows, two rows in the books');
    assert.equal(rows.filter((row) => row.origin === 'plaid').length, 2);
    assert.equal(new Set(rows.map((row) => row.external_transaction_id)).size, 2, 'each claimed a different provider id');
  });

  await test('a third provider row with no placeholder lands normally beside the claimed ones', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 12500, name: '8FIG' }]);
    await apply(account, { added: [
      providerTransaction(account, { date: '2026-09-20', amount: 12500, name: '8FIG ONE' }),
      providerTransaction(account, { date: '2026-09-20', amount: 12500, name: '8FIG TWO' })] });
    const rows = await rowsFor(account);
    assert.equal(rows.length, 2, 'one claim, one ordinary insert');
    assert.equal(rows.filter((row) => row.origin === 'plaid').length, 2);
  });

  await test('a placeholder is claimed only on an exact amount within three days', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 100, name: 'Typed' }]);
    // A cent out, and four days out: both are different transactions.
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-20', amount: 100.01, name: 'A cent out' })] });
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-24', amount: 100, name: 'Four days out' })] });
    const rows = await rowsFor(account);
    assert.equal(rows.length, 3, 'neither claimed the placeholder');
    assert.equal(rows.filter((row) => row.origin === 'manual').length, 1);
    // Three days out does claim it.
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-23', amount: 100, name: 'Three days out' })] });
    const after = await rowsFor(account);
    assert.equal(after.length, 3, 'the placeholder became the provider row');
    assert.equal(after.filter((row) => row.origin === 'manual').length, 0);
  });

  await test('a hand-entered row already in the books is never rewritten: the feed raises an exception', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 250, name: 'Typed and posted' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder);
    await approve(placeholder.batch_id);
    await markPosted('card_import_batches', placeholder.batch_id);
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-21', amount: 250, name: 'THE REAL ONE' })] });
    const row = await first('select * from card_transactions where id=$1', [placeholder.id]);
    assert.equal(row.origin, 'manual', 'the posted row is untouched');
    assert.equal(row.description, 'Typed and posted');
    assert.equal(await scalar(`select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'`, [account.id]), 1,
      'it reaches the review queue instead of the ledger');
  });


  // A frozen placeholder keeps origin='manual' for ever, so the provider
  // transaction that matched it is never findable by external id afterwards.
  // Every later delivery of that same transaction comes back down the insert
  // branch, which is where this could go very wrong very quietly.
  await test('a provider transaction redelivered against a frozen placeholder never wedges the feed', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 250, name: 'Typed and posted' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder);
    await approve(placeholder.batch_id);
    await markPosted('card_import_batches', placeholder.batch_id);
    const provider = providerTransaction(account, { date: '2026-09-21', amount: 250, name: 'THE REAL ONE' });
    await apply(account, { added: [provider] });
    const openNow = () => scalar(`select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'`, [account.id]);
    assert.equal(await openNow(), 1);
    // The same id again, revised. uq_plaid_open_exception is unique on
    // (account, external id) where status='open', so a second insert would
    // abort the whole sync and strand the cursor permanently.
    await apply(account, { modified: [{ ...provider, name: 'THE REAL ONE, RENAMED' }] });
    assert.equal(await openNow(), 1, 'the existing exception is reused, not duplicated');
    assert.equal((await first(`select provider_payload->>'name' as name from plaid_sync_exceptions
      where account_id=$1 and status='open'`, [account.id])).name, 'THE REAL ONE, RENAMED',
    'and it carries what the provider now says');
    // The cursor advanced, which is the thing a failed sync would have lost.
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-22', amount: 11, name: 'Later' })] });
    assert.equal((await rowsFor(account)).length, 2, 'the feed keeps flowing');
  });

  await test('a second provider row of the same amount never contests a placeholder already spoken for', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 250, name: 'Typed and posted' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder);
    await approve(placeholder.batch_id);
    await markPosted('card_import_batches', placeholder.batch_id);
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-20', amount: 250, name: 'First' })] });
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-20', amount: 250, name: 'Second' })] });
    const rows = await rowsFor(account);
    // The frozen placeholder, plus one ordinary row for the second provider
    // transaction, which is a different transaction and needs its own home.
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.origin === 'manual').length, 1);
    assert.equal(rows.filter((row) => row.origin === 'plaid' && row.description === 'Second').length, 1);
    assert.equal(await scalar(`select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'`, [account.id]), 1,
      'only the first raised a review; the second simply landed');
  });

  // Resolving the exception does not dissolve the association. The placeholder
  // is still 'manual' with no external id, so the rest of its life depends on
  // claimed_external_transaction_id having been recorded when the exception was
  // first raised. Resolution here is done in SQL -- the real
  // resolve_plaid_exception on a POSTED batch demands a posted correction
  // journal, and what matters downstream is only that the exception is no
  // longer open.
  const frozenPlaceholder = async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 250, name: 'Typed and posted' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder);
    await approve(placeholder.batch_id);
    await markPosted('card_import_batches', placeholder.batch_id);
    return { account, placeholder };
  };
  const resolveAll = (account) => db.query(
    `update plaid_sync_exceptions set status='resolved',resolved_at=now() where account_id=$1 and status='open'`, [account.id]);
  const openCount = (account) => scalar(
    `select count(*)::integer from plaid_sync_exceptions where account_id=$1 and status='open'`, [account.id]);

  await test('once the change is reviewed, the same transaction redelivered is a no-op, not a second review', async () => {
    const { account, placeholder } = await frozenPlaceholder();
    const provider = providerTransaction(account, { date: '2026-09-21', amount: 250, name: 'THE REAL ONE' });
    await apply(account, { added: [provider] });
    assert.equal(await scalar('select claimed_external_transaction_id from card_transactions where id=$1', [placeholder.id]),
      provider.transaction_id, 'the row records which provider transaction it stands for');
    await resolveAll(account);
    assert.equal(await openCount(account), 0);

    // Plaid redelivers the same transaction, unchanged, on the next sync.
    await apply(account, { modified: [provider] });
    assert.equal(await openCount(account), 0, 'nothing is raised again');
    const row = await first('select * from card_transactions where id=$1', [placeholder.id]);
    assert.equal(row.origin, 'manual'); assert.equal(row.description, 'Typed and posted');
    assert.equal((await rowsFor(account)).length, 1, 'and no second copy of it lands');
    // And the feed keeps flowing, which is the thing an aborted sync loses.
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-22', amount: 11, name: 'Later' })] });
    assert.equal((await rowsFor(account)).length, 2);
  });

  await test('after review, a genuine change to the same transaction is reviewed against what was last reviewed', async () => {
    const { account, placeholder } = await frozenPlaceholder();
    const provider = providerTransaction(account, { date: '2026-09-21', amount: 250, name: 'THE REAL ONE' });
    await apply(account, { added: [provider] });
    await resolveAll(account);
    await apply(account, { modified: [{ ...provider, name: 'RENAMED AFTER REVIEW' }] });
    assert.equal(await openCount(account), 1, 'a real change still reaches the queue');
    const exception = await first(`select * from plaid_sync_exceptions where account_id=$1 and status='open'`, [account.id]);
    assert.equal(exception.transaction_id, placeholder.id);
    assert.equal(exception.provider_payload.name, 'RENAMED AFTER REVIEW');
    assert.equal(exception.previous_payload.name, 'THE REAL ONE',
      'and it is read against the facts the person last saw, not against the typed-in row');
  });

  await test('after review, a different provider transaction of the same amount never reuses the placeholder', async () => {
    const { account, placeholder } = await frozenPlaceholder();
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-20', amount: 250, name: 'First' })] });
    await resolveAll(account);
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-20', amount: 250, name: 'Second' })] });
    const rows = await rowsFor(account);
    assert.equal(rows.length, 2, 'the second transaction gets its own row');
    assert.equal(rows.filter((row) => row.id === placeholder.id && row.origin === 'manual').length, 1,
      'the posted row is still untouched');
    assert.equal(rows.filter((row) => row.origin === 'plaid' && row.description === 'Second').length, 1);
    assert.equal(await openCount(account), 0, 'and it raises nothing: it is simply a new transaction');
  });

  await test('if the batch is reopened, the association is spent by the claim it was holding', async () => {
    const { account, placeholder } = await frozenPlaceholder();
    const provider = providerTransaction(account, { date: '2026-09-21', amount: 250, name: 'THE REAL ONE' });
    await apply(account, { added: [provider] });
    await resolveAll(account);
    await db.query("update card_import_batches set status='draft' where id=$1", [placeholder.batch_id]);
    await apply(account, { modified: [provider] });
    const row = await first('select * from card_transactions where id=$1', [placeholder.id]);
    assert.equal(row.origin, 'plaid', 'the claim finally happens');
    assert.equal(row.external_transaction_id, provider.transaction_id);
    assert.equal(row.claimed_external_transaction_id, null, 'and the provisional record of it is spent');
    assert.equal(row.qbo_account_id, placeholder.qbo_account_id ?? row.qbo_account_id, 'the coding is still there');
    assert.equal((await rowsFor(account)).length, 1, 'with no second copy beside it');
  });

  // The treatment is part of the review, not of the provider's facts, and for
  // a depository account the provider never supplies one. Overwriting it on
  // claim leaves a row that reads 'coded' but that approval and the ledger
  // both refuse -- the worst possible state to hand someone.
  await test('claiming keeps the reviewed accounting treatment, and the batch still approves', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 120.55, name: 'ACH DEBIT ACME' }]);
    const placeholder = (await rowsFor(account))[0];
    await code(placeholder, { accounting_treatment: 'purchase' });
    await apply(account, { added: [providerTransaction(account, { date: '2026-09-21', amount: 120.55,
      name: 'PREAUTHORIZED ACH DEBIT ACME CORP' })] });
    const row = await first('select * from card_transactions where id=$1', [placeholder.id]);
    assert.equal(row.origin, 'plaid');
    assert.equal(row.accounting_treatment, 'purchase', 'the review survived the claim');
    assert.equal(row.status, 'coded');
    await approve(row.batch_id);
    assert.equal((await load('card_import_batches', row.batch_id)).status, 'approved',
      'a claimed row is approvable, which it would not be with the treatment wiped');
  });

  await test('a hand-entered row clears the same approval bar as a provider row', async () => {
    const account = await bankAccount();
    await manual(account, [{ date: '2026-09-20', amount: 120.55, name: 'ACH DEBIT ACME' }]);
    const placeholder = (await rowsFor(account))[0];
    // Coded, but with no treatment chosen: it posts to the same accounts as a
    // provider row, so the direction rules must not be skippable by origin.
    await code(placeholder, { accounting_treatment: 'unknown' });
    await assert.rejects(approve(placeholder.batch_id), /require posted USD data and an accounting treatment/i);
    // And a treatment pointing the wrong way is caught, exactly as it is for
    // a provider row: a purchase cannot be money arriving.
    await asFinance(() => q(`update card_transactions set accounting_treatment='refund' where id=$1`, [placeholder.id]));
    await assert.rejects(approve(placeholder.batch_id), /direction/i);
    await asFinance(() => q(`update card_transactions set accounting_treatment='purchase' where id=$1`, [placeholder.id]));
    await approve(placeholder.batch_id);
    assert.equal((await load('card_import_batches', placeholder.batch_id)).status, 'approved');
  });

  console.log(`${passed} Plaid database tests passed (local PostgreSQL only).`);
} finally {
  await db.close();
}
