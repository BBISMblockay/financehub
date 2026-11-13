// Journal -> source drill-down (20261113200000), executed in a real
// PostgreSQL (PGlite): the deployed SQL from the migration, over fixtures
// whose answers are known.
//
// What it pins, in the order the migration's header claims it:
//   * every journal line of BOTH kinds appears once -- an adjustment from its
//     stored lines, a batch from its frozen approval snapshot, and a batch
//     posted before snapshots existed from the posting's own payload;
//   * a draft batch, which is not a journal yet, contributes nothing;
//   * signed_amount balances an entry to zero;
//   * the period is read from accounting_source_ref, then source_context,
//     then the entry's month -- and a UUID-shaped ref does NOT parse as one
//     (the loose regex that raised "date/time field value out of range");
//   * each source branch returns its own records and nothing else, and an
//     entry with no stored breakdown returns none;
//   * accounting_source is recovered from the two unambiguous context
//     prefixes, and NOT from the ambiguous 'accounting-export:' one;
//   * both tie-outs pass, and each FAILS when the thing it guards breaks;
//   * the migration is idempotent.
//
// Which rows a person may see is NOT tested here: both views are
// security_invoker over RLS tables, and that boundary is production's own.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/journal-drilldown-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const num = (v) => (v === null || v === undefined ? null : Number(v));
// pglite hands dates back as JS Date objects in the local zone; toISOString
// would shift them a day, so format them where they are.
const ymd = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const CO = '00000000-0000-4000-a000-000000000001';
const CONN = '00000000-0000-4000-c000-000000000001';
const REPORT = 'c7000000-0000-4000-a000-000000000004';
const GL_REPORT = 'c7000000-0000-4000-a000-000000000005';

// Entry ids, so every assertion names the entry it is about.
const JE_SHOPIFY   = '30000000-0000-4000-a000-000000000001';
const JE_PREPAID   = '30000000-0000-4000-a000-000000000002';
const JE_DEPREC    = '30000000-0000-4000-a000-000000000003'; // accounting_source NULL, context prefix
const JE_MANUAL    = '30000000-0000-4000-a000-000000000004'; // UUID-shaped ref, no breakdown
const JE_RECLASS   = '30000000-0000-4000-a000-000000000005';
const JE_AMBIG     = '30000000-0000-4000-a000-000000000006'; // NULL source, 'accounting-export:' context
const B_SNAP       = '40000000-0000-4000-a000-000000000001'; // approved, snapshot
const B_OLD        = '40000000-0000-4000-a000-000000000002'; // posted, no snapshot
const B_DRAFT      = '40000000-0000-4000-a000-000000000003'; // draft, neither

await db.exec(`
create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select '${CO}'::uuid $$;
create function active_company_id() returns uuid language sql as $$ select '${CO}'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
set test.today = '2026-11-13';

create table silo_chat_saved_reports(id uuid primary key, company_entity_id uuid, created_by uuid, source text,
  visibility text, title text, description text, question text, answer text, queries_run text[],
  parameters jsonb default '[]', columns_metadata jsonb, archived_at timestamptz, updated_at timestamptz);
create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text,
  check_sql text, tolerance numeric, enabled boolean default true, note text, created_at timestamptz default now(),
  unique(report_id, name));
create table silo_chat_schema_catalog(relname text primary key, relkind text, columns jsonb, description text,
  keywords text[], is_hidden boolean default false, auto_refreshed_at timestamptz, updated_at timestamptz,
  reportable boolean default false, report_priority smallint);
-- Production's refresh walks pg_class; here it only has to make every public
-- relation present, which is what the migration's guard then checks.
create function refresh_chat_schema_catalog() returns void language plpgsql as $$
begin
  insert into silo_chat_schema_catalog(relname, relkind)
  select c.relname, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m')
  on conflict (relname) do nothing;
end $$;

create table quickbooks_journal_postings(id uuid primary key, company_entity_id uuid, connection_id uuid,
  source text, source_ref text, period_start date, period_end date, memo text, payload jsonb,
  qbo_journal_entry_id text, qbo_doc_number text, status text);
create table quickbooks_accounts(id uuid primary key default gen_random_uuid(), connection_id uuid,
  company_entity_id uuid, qbo_account_id text, name text);
create table quickbooks_locations(id uuid primary key default gen_random_uuid(), connection_id uuid,
  company_entity_id uuid, qbo_location_id text, name text);
insert into quickbooks_accounts(connection_id, company_entity_id, qbo_account_id, name) values
  ('${CONN}', '${CO}', '10', 'Software Expense'),
  ('${CONN}', '${CO}', '20', 'Credit Card'),
  ('${CONN}', '${CO}', '30', 'Office Supply Expense');
insert into quickbooks_locations(connection_id, company_entity_id, qbo_location_id, name) values
  ('${CONN}', '${CO}', '8', 'HQ');

create table journal_adjustments(id uuid primary key, company_entity_id uuid, entry_date date, memo text,
  source_context text, status text, posting_id uuid, accounting_source text, accounting_source_ref text,
  approval_snapshot jsonb, qbo_connection_id uuid);
create table journal_adjustment_lines(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  adjustment_id uuid, line_no integer, qbo_account_id text, qbo_account_name text, posting_type text,
  amount numeric, description text, qbo_location_id text, qbo_location_name text, entity_qbo_id text,
  entity_name text, entity_type text);

create table card_sources(id uuid primary key, company_entity_id uuid, display_name text,
  credit_qbo_account_id text);
create table card_import_batches(id uuid primary key, company_entity_id uuid, source_id uuid, entry_date date,
  period_start date, period_end date, status text, posting_id uuid, approval_snapshot jsonb,
  qbo_connection_id uuid, total_amount numeric);
create table card_transactions(id uuid primary key, company_entity_id uuid, batch_id uuid, txn_date date,
  description text, merchant text, clean_merchant text, amount numeric, qbo_account_id text,
  qbo_location_id text, status text);
-- Production's card_coding_effective_lines is a view over the transaction and
-- its splits; here the unsplit shape is enough, plus one split row.
create table card_transaction_splits(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  transaction_id uuid, line_no integer, amount numeric, qbo_account_id text, qbo_location_id text, memo text);
create view card_coding_effective_lines as
  select t.id as transaction_id, t.batch_id, t.company_entity_id, 1 as row_no, t.txn_date, t.description,
         s.line_no, s.amount, s.qbo_account_id, s.qbo_location_id,
         null::text as entity_qbo_id, null::text as entity_type, s.memo, true as is_split
    from card_transactions t join card_transaction_splits s on s.transaction_id = t.id
  union all
  select t.id, t.batch_id, t.company_entity_id, 1, t.txn_date, t.description,
         1, t.amount, t.qbo_account_id, t.qbo_location_id, null, null, null, false
    from card_transactions t
   where not exists (select 1 from card_transaction_splits s where s.transaction_id = t.id);

create table card_transaction_reclasses(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  transaction_id uuid, batch_id uuid, adjustment_id uuid, amount numeric,
  from_qbo_account_id text, from_qbo_account_name text,
  to_qbo_account_id text, to_qbo_account_name text, to_qbo_location_id text, to_qbo_location_name text);

create table sales_by_day_verification_v(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  location_tag text, location_name text, day_date date, total_gross_sales numeric, total_discounts numeric,
  total_refunds numeric, shipping numeric, sum_shipping numeric, taxes numeric, sum_taxes numeric,
  total_sales numeric, sum_total_sales numeric);
create table shopify_payouts(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  shop_domain text, payout_id text, payout_date date, amount_net numeric, charges_fee numeric,
  refunds_fee numeric, adjustments_fee numeric);
create table schedule_item_amortization_v(schedule_item_id uuid, company_entity_id uuid, schedule_type text,
  label text, qbo_account_id text, qbo_account_name text, qbo_expense_account_id text, status text,
  period_start date, period_end date, period_no integer, months integer, total_amount numeric,
  period_amount numeric);
create table fixed_asset_depreciation_v(fixed_asset_id uuid, company_entity_id uuid, label text,
  qbo_asset_account_id text, qbo_asset_account_name text, qbo_depreciation_expense_account_id text,
  qbo_accum_depreciation_account_id text, status text, cost numeric, period_start date, period_end date,
  period_no integer, months integer, depreciable_base numeric, period_amount numeric);

create table accounting_settings(company_entity_id uuid primary key, accounting_start_date date,
  silo_takeover_on date, bookkeeping_mode text, books_authority text);
create table qbo_history_lines(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  import_id uuid, row_no integer, row_kind text, qbo_account_id text, account_name text,
  account_type text, transaction_date date, qbo_transaction_id text, transaction_type text,
  document_number text, counterparty text, memo text, split_account_id text, split_account_name text,
  natural_amount numeric, natural_balance numeric, raw_row jsonb);
`);

// ── Fixtures ───────────────────────────────────────────────────────────────
await db.exec(`
insert into card_sources values ('50000000-0000-4000-a000-000000000001', '${CO}', 'Acme CC', '20');

insert into quickbooks_journal_postings(id, company_entity_id, connection_id, source, source_ref, status,
  qbo_journal_entry_id, qbo_doc_number, payload) values
  ('60000000-0000-4000-a000-000000000001', '${CO}', '${CONN}', 'card_import', 'old', 'posted', '901', 'SILO-OLD',
   '{"Line":[
      {"Amount":40,"Description":"2026-09-02 · OLDSHOP","JournalEntryLineDetail":{"AccountRef":{"value":"30"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":40,"Description":"Acme CC settlement","JournalEntryLineDetail":{"AccountRef":{"value":"20"},"PostingType":"Credit"}}]}'::jsonb);

-- Approved batch: the frozen snapshot is what was sent.
insert into card_import_batches values
  ('${B_SNAP}', '${CO}', '50000000-0000-4000-a000-000000000001', '2026-10-31', '2026-10-01', '2026-10-31',
   'posted', null,
   '{"schema_version":1,"payload":{"TxnDate":"2026-10-31","Line":[
      {"Amount":100,"Description":"2026-10-05 · SOFTCO","JournalEntryLineDetail":{"AccountRef":{"value":"10"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":25,"Description":"2026-10-06 · SPLITCO a","JournalEntryLineDetail":{"AccountRef":{"value":"10"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":35,"Description":"2026-10-06 · SPLITCO b","JournalEntryLineDetail":{"AccountRef":{"value":"30"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":160,"Description":"Acme CC settlement","JournalEntryLineDetail":{"AccountRef":{"value":"20"},"PostingType":"Credit"}}]}}'::jsonb,
   '${CONN}', 160),
  ('${B_OLD}', '${CO}', '50000000-0000-4000-a000-000000000001', '2026-09-30', '2026-09-01', '2026-09-30',
   'posted', '60000000-0000-4000-a000-000000000001', null, '${CONN}', 40),
  ('${B_DRAFT}', '${CO}', '50000000-0000-4000-a000-000000000001', '2026-11-30', '2026-11-01', '2026-11-30',
   'draft', null, null, '${CONN}', 70);

insert into card_transactions values
  ('70000000-0000-4000-a000-000000000001', '${CO}', '${B_SNAP}', '2026-10-05', 'SOFTCO INC', 'SOFTCO', 'Softco', 100, '10', '8', 'coded'),
  ('70000000-0000-4000-a000-000000000002', '${CO}', '${B_SNAP}', '2026-10-06', 'SPLITCO', 'SPLITCO', null, 60, null, '8', 'coded'),
  ('70000000-0000-4000-a000-000000000003', '${CO}', '${B_OLD}',  '2026-09-02', 'OLDSHOP', null, null, 40, '30', '8', 'coded'),
  ('70000000-0000-4000-a000-000000000004', '${CO}', '${B_DRAFT}', '2026-11-04', 'DRAFTCO', null, null, 70, '10', '8', 'uncoded');
insert into card_transaction_splits(company_entity_id, transaction_id, line_no, amount, qbo_account_id, qbo_location_id, memo) values
  ('${CO}', '70000000-0000-4000-a000-000000000002', 1, 25, '10', '8', 'software half'),
  ('${CO}', '70000000-0000-4000-a000-000000000002', 2, 35, '30', '8', 'supplies half');

insert into journal_adjustments(id, company_entity_id, entry_date, memo, source_context, status, posting_id,
  accounting_source, accounting_source_ref) values
  ('${JE_SHOPIFY}', '${CO}', '2026-10-31', 'Shopify sales & payout fees', 'accounting-export:2026-10', 'posted', null, 'shopify_monthly', '2026-10'),
  ('${JE_PREPAID}', '${CO}', '2026-10-31', 'Prepaid amortization',        'schedules:prepaid:2026-10',  'posted', null, 'prepaid_amortization', '2026-10'),
  -- accounting_source NULL, recovered from the context prefix.
  ('${JE_DEPREC}',  '${CO}', '2026-10-31', 'Depreciation', 'fixed-assets:depreciation:2026-10', 'posted', null, null, null),
  -- A UUID-shaped ref: must NOT parse as a period, and has no breakdown.
  ('${JE_MANUAL}',  '${CO}', '2026-09-17', 'Hand-written', 'qbo-reports:GeneralLedger', 'posted', null,
   'manual_adjustment', 'b8fefafc-e399-41ef-8235-800be699b9f3'),
  ('${JE_RECLASS}', '${CO}', '2026-10-31', 'Reclass', 'transactions:reclass', 'approved', null, 'card_reclass', 'card-reclass:1'),
  -- NULL source with the AMBIGUOUS context: stays unattributed on purpose.
  ('${JE_AMBIG}',   '${CO}', '2026-08-31', 'Older export', 'accounting-export:2026-08', 'posted', null, null, null);

insert into journal_adjustment_lines(company_entity_id, adjustment_id, line_no, qbo_account_id, qbo_account_name,
  posting_type, amount, description, qbo_location_id, qbo_location_name) values
  ('${CO}', '${JE_SHOPIFY}', 1, '10', 'Revenue',   'Credit', 900, 'Shopify Sales Summary', '8', 'HQ'),
  ('${CO}', '${JE_SHOPIFY}', 2, '30', 'Receivable','Debit',  900, 'Shopify Sales Summary', '8', 'HQ'),
  ('${CO}', '${JE_PREPAID}', 1, '10', 'Expense',   'Debit',  500, 'Prepaid', '8', 'HQ'),
  ('${CO}', '${JE_PREPAID}', 2, '30', 'Prepaid',   'Credit', 500, 'Prepaid', '8', 'HQ'),
  ('${CO}', '${JE_DEPREC}',  1, '10', 'Deprec',    'Debit',  300, 'Depreciation', '8', 'HQ'),
  ('${CO}', '${JE_DEPREC}',  2, '30', 'Accum',     'Credit', 300, 'Depreciation', '8', 'HQ'),
  ('${CO}', '${JE_MANUAL}',  1, '10', 'A',         'Debit',    1, 'Hand', null, null),
  ('${CO}', '${JE_MANUAL}',  2, '30', 'B',         'Credit',   1, 'Hand', null, null),
  ('${CO}', '${JE_RECLASS}', 1, '30', 'To',        'Debit',   12, 'Reclass', '8', 'HQ'),
  ('${CO}', '${JE_RECLASS}', 2, '10', 'From',      'Credit',  12, 'Reclass', '8', 'HQ'),
  ('${CO}', '${JE_AMBIG}',   1, '10', 'A',         'Debit',    7, 'Older', null, null),
  ('${CO}', '${JE_AMBIG}',   2, '30', 'B',         'Credit',   7, 'Older', null, null);

insert into card_transaction_reclasses(company_entity_id, transaction_id, batch_id, adjustment_id, amount,
  from_qbo_account_id, from_qbo_account_name, to_qbo_account_id, to_qbo_account_name, to_qbo_location_id, to_qbo_location_name)
values ('${CO}', '70000000-0000-4000-a000-000000000001', '${B_SNAP}', '${JE_RECLASS}', 12, '10', 'Software Expense', '30', 'Office Supply Expense', '8', 'HQ');

-- Two locations over two October days, plus a September day that must stay out.
insert into sales_by_day_verification_v(company_entity_id, location_tag, location_name, day_date,
  total_gross_sales, total_discounts, total_refunds, shipping, taxes, total_sales) values
  ('${CO}', 'online', 'Online', '2026-10-05', 600, 40, 10, 15, 20, 585),
  ('${CO}', 'online', 'Online', '2026-10-06', 200, 10,  0,  5,  8, 203),
  ('${CO}', 'store',  'Store',  '2026-10-05', 100,  0,  0,  0,  5, 105),
  ('${CO}', 'online', 'Online', '2026-09-30', 999,  0,  0,  0,  0, 999);
insert into shopify_payouts(company_entity_id, shop_domain, payout_id, payout_date, amount_net,
  charges_fee, refunds_fee, adjustments_fee) values
  ('${CO}', 'shop.myshopify.com', 'p1', '2026-10-09', 500, 10, 2, 1),
  ('${CO}', 'shop.myshopify.com', 'p2', '2026-09-09', 400, 99, 0, 0);
insert into schedule_item_amortization_v values
  ('80000000-0000-4000-a000-000000000001', '${CO}', 'prepaid', 'Insurance', '30', 'Prepaid', '10', 'active',
   '2026-10-01', '2026-10-31', 3, 12, 6000, 500),
  ('80000000-0000-4000-a000-000000000001', '${CO}', 'prepaid', 'Insurance', '30', 'Prepaid', '10', 'active',
   '2026-09-01', '2026-09-30', 2, 12, 6000, 500);
insert into fixed_asset_depreciation_v values
  ('90000000-0000-4000-a000-000000000001', '${CO}', 'Van', '30', 'Vehicles', '10', '31', 'active', 36000,
   '2026-10-01', '2026-10-31', 4, 36, 36000, 300),
  ('90000000-0000-4000-a000-000000000001', '${CO}', 'Van', '30', 'Vehicles', '10', '31', 'active', 36000,
   '2026-09-01', '2026-09-30', 3, 36, 36000, 300);
`);

const MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20261113200000_accounting_journal_drilldown.sql', import.meta.url), 'utf8');
await db.exec(MIGRATION);

// ── The lines view ─────────────────────────────────────────────────────────
await test('every journal line appears once, from the right place', async () => {
  const rows = await q(`select kind, lines_basis, count(*)::int n, count(distinct journal_id)::int entries
                          from accounting_journal_lines_v group by 1,2 order by 1,2`);
  assert.deepEqual(rows, [
    { kind: 'card_batch', lines_basis: 'approval_snapshot', n: 4, entries: 1 },
    { kind: 'card_batch', lines_basis: 'posting_payload',   n: 2, entries: 1 },
    { kind: 'journal_adjustment', lines_basis: 'stored',    n: 12, entries: 6 },
  ]);
});

await test('a draft batch is not a journal and contributes no lines', async () => {
  const [{ n }] = await q(`select count(*)::int n from accounting_journal_lines_v where journal_id = '${B_DRAFT}'`);
  assert.equal(n, 0);
});

await test('account and location names resolve against the batch connection', async () => {
  const rows = await q(`select qbo_account_name, qbo_location_name, amount, description
                          from accounting_journal_lines_v
                         where journal_id = '${B_SNAP}' order by line_no`);
  assert.deepEqual(rows.map((r) => r.qbo_account_name),
    ['Software Expense', 'Software Expense', 'Office Supply Expense', 'Credit Card']);
  assert.deepEqual(rows.map((r) => r.qbo_location_name), ['HQ', 'HQ', 'HQ', null]);
  assert.equal(num(rows[3].amount), 160);
});

await test('signed_amount balances every entry to zero', async () => {
  const rows = await q(`select journal_id, round(sum(signed_amount), 2)::text bal
                          from accounting_journal_lines_v group by 1 having round(sum(signed_amount), 2) <> 0`);
  assert.deepEqual(rows, []);
});

await test('a credit is negative and a debit positive', async () => {
  const rows = await q(`select posting_type, amount::text, signed_amount::text
                          from accounting_journal_lines_v where journal_id = '${JE_SHOPIFY}' order by line_no`);
  assert.deepEqual(rows, [
    { posting_type: 'Credit', amount: '900', signed_amount: '-900' },
    { posting_type: 'Debit',  amount: '900', signed_amount: '900' },
  ]);
});

// ── Period derivation ──────────────────────────────────────────────────────
await test('the period comes from the ref, then the context, then the entry month', async () => {
  const rows = await q(`select journal_id, min(period_start)::text ps, max(period_end)::text pe
                          from accounting_journal_sources_v group by 1 order by 1`);
  const by = Object.fromEntries(rows.map((r) => [r.journal_id, [r.ps, r.pe]]));
  assert.deepEqual(by[JE_SHOPIFY], ['2026-10-01', '2026-10-31']);   // ref '2026-10'
  assert.deepEqual(by[JE_DEPREC],  ['2026-10-01', '2026-10-31']);   // context suffix
  assert.deepEqual(by[B_SNAP],     ['2026-10-01', '2026-10-31']);   // the batch's own period
});

await test('a UUID-shaped ref does not parse as a period, and the entry month is used', async () => {
  // The loose (\\d{4}-\\d{2}) matched "8235-80" inside this ref and raised.
  const [{ ps }] = await q(
    `select coalesce(
              to_date(substring('b8fefafc-e399-41ef-8235-800be699b9f3' from '^(\\d{4}-(?:0[1-9]|1[0-2]))$'), 'YYYY-MM'),
              date_trunc('month', date '2026-09-17')::date)::text ps`);
  assert.equal(ps, '2026-09-01');
});

// ── The sources view ───────────────────────────────────────────────────────
await test('each source branch returns its own records', async () => {
  const rows = await q(`select source_kind, source_basis, count(*)::int n, round(sum(amount), 2)::text total
                          from accounting_journal_sources_v group by 1,2 order by 1`);
  assert.deepEqual(rows, [
    { source_kind: 'card_reclass_transaction', source_basis: 'as_posted',  n: 1, total: '12.00' },
    { source_kind: 'card_split_line',          source_basis: 'as_posted',  n: 2, total: '60.00' },
    { source_kind: 'card_transaction',         source_basis: 'as_posted',  n: 2, total: '140.00' },
    { source_kind: 'fixed_asset',              source_basis: 'recomputed', n: 1, total: '300.00' },
    { source_kind: 'prepaid_schedule_item',    source_basis: 'recomputed', n: 1, total: '500.00' },
    { source_kind: 'shopify_payout',           source_basis: 'recomputed', n: 1, total: '13.00' },
    { source_kind: 'shopify_sales_day',        source_basis: 'recomputed', n: 3, total: '893.00' },
  ]);
});

await test('a sales day carries its buckets, one row per location per day', async () => {
  const rows = await q(`select source_id, source_label, gross::text, discounts::text, refunds::text,
                               shipping::text, taxes::text, amount::text
                          from accounting_journal_sources_v
                         where source_kind = 'shopify_sales_day' order by source_id`);
  assert.deepEqual(rows, [
    { source_id: 'online:2026-10-05', source_label: 'Online', gross: '600.00', discounts: '40.00',
      refunds: '10.00', shipping: '15.00', taxes: '20.00', amount: '585.00' },
    { source_id: 'online:2026-10-06', source_label: 'Online', gross: '200.00', discounts: '10.00',
      refunds: '0.00', shipping: '5.00', taxes: '8.00', amount: '203.00' },
    { source_id: 'store:2026-10-05', source_label: 'Store', gross: '100.00', discounts: '0.00',
      refunds: '0.00', shipping: '0.00', taxes: '5.00', amount: '105.00' },
  ]);
});

await test('a payout outside the period is excluded, and the amount is its fee', async () => {
  const rows = await q(`select source_id, amount::text from accounting_journal_sources_v
                         where source_kind = 'shopify_payout'`);
  assert.deepEqual(rows, [{ source_id: 'p1', amount: '13.00' }]);  // 10 + 2 + 1, not September's 99
});

await test('a split transaction shows its lines, not one blended row', async () => {
  const rows = await q(`select source_kind, source_label, qbo_account_name, amount::text
                          from accounting_journal_sources_v
                         where journal_id = '${B_SNAP}' order by source_kind, amount`);
  assert.deepEqual(rows, [
    { source_kind: 'card_split_line', source_label: 'SPLITCO', qbo_account_name: 'Software Expense', amount: '25' },
    { source_kind: 'card_split_line', source_label: 'SPLITCO', qbo_account_name: 'Office Supply Expense', amount: '35' },
    { source_kind: 'card_transaction', source_label: 'Softco', qbo_account_name: 'Software Expense', amount: '100' },
  ]);
});

await test('a batch posted before snapshots existed still has its sources', async () => {
  const rows = await q(`select source_kind, amount::text from accounting_journal_sources_v where journal_id = '${B_OLD}'`);
  assert.deepEqual(rows, [{ source_kind: 'card_transaction', amount: '40' }]);
});

await test('a draft batch has no sources either', async () => {
  const [{ n }] = await q(`select count(*)::int n from accounting_journal_sources_v where journal_id = '${B_DRAFT}'`);
  assert.equal(n, 0);
});

await test('an entry with no stored breakdown has no source rows', async () => {
  const [{ n }] = await q(`select count(*)::int n from accounting_journal_sources_v where journal_id = '${JE_MANUAL}'`);
  assert.equal(n, 0);
});

// ── accounting_source recovery ─────────────────────────────────────────────
await test('an unambiguous context prefix recovers accounting_source in BOTH views', async () => {
  const [{ src }] = await q(`select distinct accounting_source src from accounting_journal_lines_v
                              where journal_id = '${JE_DEPREC}'`);
  assert.equal(src, 'fixed_asset_depreciation');
  const rows = await q(`select source_kind, amount::text from accounting_journal_sources_v
                         where journal_id = '${JE_DEPREC}'`);
  assert.deepEqual(rows, [{ source_kind: 'fixed_asset', amount: '300.00' }]);
});

await test("the ambiguous 'accounting-export:' prefix recovers nothing", async () => {
  // Both a Shopify summary and a prepaid amortization have carried it, so
  // attributing either set to this entry would be a guess.
  const [{ src }] = await q(`select distinct accounting_source src from accounting_journal_lines_v
                              where journal_id = '${JE_AMBIG}'`);
  assert.equal(src, null);
  const [{ n }] = await q(`select count(*)::int n from accounting_journal_sources_v where journal_id = '${JE_AMBIG}'`);
  assert.equal(n, 0);
});

// ── The catalog, the report and its tie-outs ───────────────────────────────
await test('both views are security_invoker, granted to authenticated and described in the catalog', async () => {
  const rows = await q(`select c.relname, c.reloptions @> array['security_invoker=true'] invoker,
                               has_table_privilege('authenticated', c.oid, 'SELECT') granted,
                               (select coalesce(btrim(k.description), '') <> '' and not k.is_hidden
                                  from silo_chat_schema_catalog k where k.relname = c.relname) described
                          from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public'
                           and c.relname in ('accounting_journal_lines_v', 'accounting_journal_sources_v')
                         order by 1`);
  assert.deepEqual(rows, [
    { relname: 'accounting_journal_lines_v', invoker: true, granted: true, described: true },
    { relname: 'accounting_journal_sources_v', invoker: true, granted: true, described: true },
  ]);
});

const runReport = async () => {
  const [{ queries_run: sql }] = await q(
    `select queries_run[1] as queries_run from silo_chat_saved_reports where id = '${REPORT}'`);
  return q(sql
    .replaceAll('{{date_from}}', "((select silo_business_today()) - 180)")
    .replaceAll('{{date_to}}', '(select silo_business_today())'));
};

await test('the report lists every entry, balanced, with its sources', async () => {
  const rows = await runReport();
  assert.equal(rows.length, 8);                                   // 6 adjustments + 2 batches
  assert.ok(rows.every((r) => num(r.out_of_balance) === 0), 'an entry did not balance');
  const shopify = rows.find((r) => r.journal_id === JE_SHOPIFY);
  assert.equal(shopify.source_rows, 4);                           // 3 sales days + 1 payout
  assert.equal(shopify.source_kinds, 'shopify_payout, shopify_sales_day');
  assert.equal(shopify.source_basis, 'recomputed');
  assert.equal(num(shopify.source_total), 906);                   // 893 + 13, mixed kinds on purpose
  const manual = rows.find((r) => r.journal_id === JE_MANUAL);
  assert.equal(manual.source_rows, null);
  assert.equal(manual.source_total, null);
  assert.equal(manual.source_basis, null);
});

await test("an entry with both frozen and recomputed sources reads as 'mixed'", async () => {
  // No accounting_source today puts two bases on one entry -- each branch of
  // the sources view carries one -- so this guard is defensive and is tested
  // as the expression it is, rather than by faking an entry that cannot
  // exist. It matters the moment a branch is added that mixes them.
  const [{ one, two }] = await q(`
    with s(source_basis) as (values ('as_posted'), ('as_posted')),
         m(source_basis) as (values ('as_posted'), ('recomputed'))
    select (select case when count(distinct source_basis) > 1 then 'mixed' else min(source_basis) end from s) one,
           (select case when count(distinct source_basis) > 1 then 'mixed' else min(source_basis) end from m) two`);
  assert.equal(one, 'as_posted');
  assert.equal(two, 'mixed');
});

const tieouts = async (reportId = REPORT) => {
  const checks = await q(`select name, check_sql, tolerance from silo_report_tieouts
                           where report_id = '${reportId}' and enabled order by name`);
  const out = [];
  for (const c of checks) {
    const [row] = await q(c.check_sql);
    out.push({
      name: c.name,
      left: num(row?.left_value), right: num(row?.right_value),
      pass: row?.left_value !== null && row?.left_value !== undefined
        && Math.abs(num(row.left_value) - num(row.right_value)) <= Number(c.tolerance),
    });
  }
  return out;
};

await test('the migration writes two tie-outs and both pass', async () => {
  const rows = await tieouts();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows));
});

await test('an entry that stops balancing fails its tie-out', async () => {
  await db.exec(`update journal_adjustment_lines set amount = 901
                  where adjustment_id = '${JE_SHOPIFY}' and line_no = 1`);
  const bal = (await tieouts()).find((r) => r.name === 'Every journal entry balances');
  assert.equal(bal.pass, false);
  assert.equal(bal.left, 1);
  await db.exec(`update journal_adjustment_lines set amount = 900
                  where adjustment_id = '${JE_SHOPIFY}' and line_no = 1`);
  assert.ok((await tieouts()).every((r) => r.pass));
});

await test('a posted batch the report drops fails the count tie-out', async () => {
  // A snapshot the view can no longer expand: posted in QuickBooks, missing
  // from the report. The count check is what catches it.
  await db.exec(`update card_import_batches set approval_snapshot = '{"payload":{}}'::jsonb where id = '${B_SNAP}'`);
  const cnt = (await tieouts()).find((r) => r.name === 'Entry count ties to the base tables');
  assert.equal(cnt.pass, false);
  assert.equal(cnt.left, 7);
  assert.equal(cnt.right, 7 + 1);
});

await test('a changed report definition turns its tie-outs to NO DATA', async () => {
  await db.exec(`update silo_chat_saved_reports set queries_run = array['select 1 as entry_date']
                  where id = '${REPORT}'`);
  const rows = await tieouts();
  assert.ok(rows.every((r) => r.left === null), JSON.stringify(rows));
});

await test('the migration is idempotent', async () => {
  // Restore what the failure tests broke, then apply the file again.
  await db.exec(`update card_import_batches set approval_snapshot =
    '{"schema_version":1,"payload":{"TxnDate":"2026-10-31","Line":[
      {"Amount":100,"Description":"2026-10-05 · SOFTCO","JournalEntryLineDetail":{"AccountRef":{"value":"10"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":25,"Description":"2026-10-06 · SPLITCO a","JournalEntryLineDetail":{"AccountRef":{"value":"10"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":35,"Description":"2026-10-06 · SPLITCO b","JournalEntryLineDetail":{"AccountRef":{"value":"30"},"PostingType":"Debit","DepartmentRef":{"value":"8"}}},
      {"Amount":160,"Description":"Acme CC settlement","JournalEntryLineDetail":{"AccountRef":{"value":"20"},"PostingType":"Credit"}}]}}'::jsonb
    where id = '${B_SNAP}'`);
  await db.exec(MIGRATION);
  const rows = await tieouts();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows));
  const report = await runReport();
  assert.equal(report.length, 8);
});


// ── The seam: one continuous ledger across the cut-over ────────────────────
// The company moved to SILO on 2026-08-01, so everything before that date
// lives in the imported QuickBooks history and everything after is SILO's.
await db.exec(`
insert into accounting_settings(company_entity_id, accounting_start_date, silo_takeover_on,
                                bookkeeping_mode, books_authority)
values ('${CO}', '2026-08-01', null, 'silo', 'qbo');

insert into qbo_history_lines(company_entity_id, row_no, row_kind, qbo_account_id, account_name,
  account_type, transaction_date, qbo_transaction_id, transaction_type, document_number,
  counterparty, memo, split_account_name, natural_amount) values
  -- a debit-natural expense against a credit-natural card: both stored POSITIVE
  ('${CO}', 1, 'transaction', '900', 'Rent Expense',  'Expense',     '2026-07-15', 'H-A', 'Expense', 'E-1', 'Landlord', 'July rent', 'Visa', 500),
  ('${CO}', 2, 'transaction', '901', 'Visa',          'Credit Card', '2026-07-15', 'H-A', 'Expense', 'E-1', 'Landlord', 'July rent', 'Rent Expense', 500),
  -- income and bank, the pair that only balances once the credit side is flipped
  ('${CO}', 3, 'transaction', '902', 'Sales',         'Income',      '2026-07-20', 'H-B', 'Sales Receipt', 'S-9', 'Customer', 'Sale', 'Checking', 300),
  ('${CO}', 4, 'transaction', '903', 'Checking',      'Bank',        '2026-07-20', 'H-B', 'Sales Receipt', 'S-9', 'Customer', 'Sale', 'Sales', 300),
  -- the export's running-balance artifact and an undated opening balance
  ('${CO}', 5, 'zero_amount', '900', 'Rent Expense',  'Expense',     '2026-07-15', 'H-A', 'Expense', null, null, null, null, 0),
  ('${CO}', 6, 'opening',     '903', 'Checking',      'Bank',        null,          null, null, null, null, 'Opening balance', null, 12000);
`);

await test('the ledger runs across the cut-over, imported before and SILO after', async () => {
  const rows = await q(`select origin, min(entry_date)::text first_day, max(entry_date)::text last_day,
                               count(*)::int n, count(distinct cutover_on)::int cutovers,
                               max(cutover_on)::text cutover, bool_and(has_source_detail) detail
                          from accounting_ledger_v group by 1 order by 1`);
  assert.deepEqual(rows, [
    { origin: 'qbo_history', first_day: '2026-07-15', last_day: '2026-07-20', n: 4,
      cutovers: 1, cutover: '2026-08-01', detail: false },
    { origin: 'silo', first_day: '2026-08-31', last_day: '2026-10-31', n: 18,
      cutovers: 1, cutover: '2026-08-01', detail: true },
  ]);
});

await test('the natural sign is converted, not copied: every imported transaction balances', async () => {
  const rows = await q(`select transaction_ref, qbo_account_name, posting_type, signed_amount::text amt
                          from accounting_ledger_v where origin = 'qbo_history'
                         order by transaction_ref, qbo_account_name`);
  assert.deepEqual(rows.map((r) => [r.qbo_account_name, r.posting_type, r.amt]), [
    ['Rent Expense', 'Debit',  '500.00'],
    ['Visa',         'Credit', '-500.00'],   // stored +500 in its natural sign
    ['Checking',     'Debit',  '300.00'],
    ['Sales',        'Credit', '-300.00'],   // stored +300 in its natural sign
  ]);
  const [{ bad }] = await q(`select count(*)::int bad from (
      select transaction_ref from accounting_ledger_v where origin = 'qbo_history'
       group by transaction_ref having abs(sum(signed_amount)) > 0.005) t`);
  assert.equal(bad, 0);
});

await test('running-balance artifacts and undated opening balances stay out', async () => {
  const [{ n }] = await q(`select count(*)::int n from accounting_ledger_v
                            where qbo_account_name in ('Rent Expense', 'Checking')
                              and origin = 'qbo_history' and coalesce(memo, '') = 'Opening balance'`);
  assert.equal(n, 0);
  const [{ total }] = await q(`select count(*)::int total from accounting_ledger_v where origin = 'qbo_history'`);
  assert.equal(total, 4);   // 6 imported rows, 2 of them not activity
});

await test('with no accounting_settings the cut-over falls back to the first SILO entry', async () => {
  await db.exec(`delete from accounting_settings where company_entity_id = '${CO}'`);
  const rows = await q(`select distinct cutover_on::text c from accounting_ledger_v`);
  assert.deepEqual(rows, [{ c: '2026-08-31' }]);   // earliest entry SILO posted
  const [{ n }] = await q(`select count(*)::int n from accounting_ledger_v where origin = 'qbo_history'`);
  assert.equal(n, 4);                               // still before it, so still shown
  await db.exec(`insert into accounting_settings(company_entity_id, accounting_start_date)
                 values ('${CO}', '2026-08-01')`);
});

await test('a duplicate settings row does not take the whole ledger down', async () => {
  // A scalar subquery would raise 21000 here and the ledger would return
  // nothing at all, which is the worst possible answer for a recon.
  await db.exec(`alter table accounting_settings drop constraint accounting_settings_pkey;
                 insert into accounting_settings(company_entity_id, accounting_start_date)
                 values ('${CO}', '2026-07-01')`);
  const rows = await q(`select distinct cutover_on::text c from accounting_ledger_v`);
  assert.deepEqual(rows, [{ c: '2026-08-01' }]);   // the later of the two, not an error
  await db.exec(`delete from accounting_settings where accounting_start_date = '2026-07-01';
                 alter table accounting_settings add primary key (company_entity_id)`);
});

await test('an account type the map does not know gets no side, rather than a guessed one', async () => {
  await db.exec(`insert into qbo_history_lines(company_entity_id, row_no, row_kind, qbo_account_id,
    account_name, account_type, transaction_date, qbo_transaction_id, natural_amount)
    values ('${CO}', 7, 'transaction', '904', 'Mystery', 'Nonexistent Type', '2026-06-10', 'H-C', 50)`);
  const [row] = await q(`select posting_type, amount, signed_amount, account_type
                           from accounting_ledger_v where qbo_account_name = 'Mystery'`);
  assert.deepEqual(row, { posting_type: null, amount: null, signed_amount: null,
                          account_type: 'Nonexistent Type' });
  const side = (await tieouts(GL_REPORT)).find((r) => r.name === 'Every imported account type has a side');
  assert.equal(side.pass, false, 'an unmapped account type must turn its check red');
  assert.equal(side.left, 1);
  await db.exec(`delete from qbo_history_lines where qbo_transaction_id = 'H-C'`);
});

await test('the GL report is month by account by origin, and shows the cut-over month as both', async () => {
  const [{ queries_run: sql }] = await q(
    `select queries_run[1] as queries_run from silo_chat_saved_reports where id = '${GL_REPORT}'`);
  const rows = await q(sql
    .replaceAll('{{date_from}}', '((select silo_business_today()) - 365)')
    .replaceAll('{{date_to}}', '(select silo_business_today())'));
  const july = rows.filter((r) => ymd(r.month) === '2026-07-01');
  assert.deepEqual(july.map((r) => r.origin), ['qbo_history', 'qbo_history', 'qbo_history', 'qbo_history']);
  const sales = july.find((r) => r.account_name === 'Sales');
  assert.equal(num(sales.credits), 300);
  assert.equal(num(sales.debits), 0);
  assert.equal(num(sales.net), -300);
  assert.equal(num(sales.unmapped_lines), 0);
  assert.equal(ymd(sales.cutover_on), '2026-08-01');
  // August is the month the books change hands: imported history stops on
  // 2026-07-31 and SILO's first entry lands on 2026-08-31.
  const august = rows.filter((r) => ymd(r.month) === '2026-08-01');
  assert.deepEqual([...new Set(august.map((r) => r.origin))], ['silo']);
  assert.ok(august.length > 0);
});

await test('the GL report writes four tie-outs and all pass', async () => {
  const rows = await tieouts(GL_REPORT);
  assert.deepEqual(rows.map((r) => r.name).sort(), [
    'Every imported account type has a side',
    'Imported history balances after conversion',
    'Monthly totals tie to the ledger',
    'No imported history is hidden by the cut-over',
  ]);
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows));
});

await test('a wrong sign on one account type fails the conversion tie-out', async () => {
  // What a bad map would do: read the credit-natural card as a debit.
  await db.exec(`update qbo_history_lines set account_type = 'Expense'
                  where qbo_account_id = '901'`);
  const conv = (await tieouts(GL_REPORT)).find((r) => r.name === 'Imported history balances after conversion');
  assert.equal(conv.pass, false);
  assert.equal(conv.left, 1);
  await db.exec(`update qbo_history_lines set account_type = 'Credit Card' where qbo_account_id = '901'`);
  assert.ok((await tieouts(GL_REPORT)).every((r) => r.pass));
});

await test('imported history reaching past the cut-over fails rather than vanishing', async () => {
  await db.exec(`insert into qbo_history_lines(company_entity_id, row_no, row_kind, qbo_account_id,
    account_name, account_type, transaction_date, qbo_transaction_id, natural_amount)
    values ('${CO}', 8, 'transaction', '900', 'Rent Expense', 'Expense', '2026-09-15', 'H-D', 500)`);
  const [{ n }] = await q(`select count(*)::int n from accounting_ledger_v where origin = 'qbo_history'`);
  assert.equal(n, 4, 'the ledger must not double-count an overlap');
  const hidden = (await tieouts(GL_REPORT)).find((r) => r.name === 'No imported history is hidden by the cut-over');
  assert.equal(hidden.pass, false);
  assert.equal(hidden.left, 5);
  assert.equal(hidden.right, 4);
  await db.exec(`delete from qbo_history_lines where qbo_transaction_id = 'H-D'`);
});

await test('every enabled tie-out carries its report\'s current fingerprint', async () => {
  // The invariant verify_v2_schema.sql asserts on production: a tie-out that
  // does not embed the md5 of the report it guards reads as one left behind
  // by an older definition, and report-tieouts-nightly would see NO DATA.
  const rows = await q(`select r.id, t.name from silo_chat_saved_reports r
                          join silo_report_tieouts t on t.report_id = r.id
                         where r.id in ('${REPORT}', '${GL_REPORT}') and t.enabled
                           and position(md5(r.queries_run::text || r.parameters::text) in t.check_sql) = 0`);
  assert.deepEqual(rows, [], 'a tie-out is not guarded by its report definition');
  const [{ n }] = await q(`select count(*)::int n from silo_report_tieouts
                            where report_id in ('${REPORT}', '${GL_REPORT}') and enabled`);
  assert.equal(n, 6);
});

await test('the cut-over stays derived: no date literal, no company id in the view', async () => {
  // The same three patterns verify_v2_schema.sql runs on production. Asserted
  // against the real definition so the guard is proved, not just written.
  const [{ d }] = await q(`select pg_get_viewdef(to_regclass('public.accounting_ledger_v'), true) as d`);
  assert.ok(d, 'the view must exist');
  assert.equal(/'[0-9]{4}-[0-9]{2}-[0-9]{2}'/.test(d), false, 'a hardcoded cut-over date');
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d), false,
    'a company id in shared code');
  assert.ok(d.includes('active_company_id()'), 'the settings read must be company-scoped');
});

await test('a changed GL report definition turns its tie-outs to NO DATA', async () => {
  await db.exec(`update silo_chat_saved_reports set queries_run = array['select 1 as month']
                  where id = '${GL_REPORT}'`);
  const totals = (await tieouts(GL_REPORT)).find((r) => r.name === 'Monthly totals tie to the ledger');
  assert.equal(totals.left, null);
  assert.equal(totals.pass, false);
  await db.exec(MIGRATION);
  assert.ok((await tieouts(GL_REPORT)).every((r) => r.pass));
});

console.log(`\n${passed} passed`);
