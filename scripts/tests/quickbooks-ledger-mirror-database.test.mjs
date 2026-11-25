// QuickBooks ledger mirror (20261125150000), executed in a real PostgreSQL
// (PGlite): the deployed SQL from the migration over reports whose answers are
// known.
//
// What it pins:
//   * a good month is stored with debits positive and credits negative, with
//     sub-accounts, a parent's own rows, opening balances and zero rows handled;
//   * reading the same month again changes nothing; a changed month REPLACES
//     its lines (never appends);
//   * every refusal leaves the last accepted read untouched and records why;
//   * account types passed by the reader win over a stale stored chart;
//   * which months are due, and in what order;
//   * the books view takes a read month from the mirror and every other day
//     from the ledger, and labels each line by where it came from;
//   * only the service role can write or ask what is due.
//
// Which rows a person may see is NOT tested here: the tables' RLS policy and
// the security_invoker view are production's own boundary.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/quickbooks-ledger-mirror-database.test.mjs
// Mutations: LEDGER_MIRROR_MUTATION=<name> breaks one rule; the suite must fail.
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const CO = '00000000-0000-4000-a000-000000000001';
const CO2 = '00000000-0000-4000-a000-000000000002';
const CONN = '00000000-0000-4000-c000-000000000001';
const CONN2 = '00000000-0000-4000-c000-000000000002';
const CONN_STRAY = '00000000-0000-4000-c000-000000000009';

await db.exec(`
create role authenticated; create role anon; create role service_role;
create function active_company_id() returns uuid language sql stable as $$ select '${CO}'::uuid $$;
create function can_manage_journal_entries() returns boolean language sql stable as $$ select true $$;
create function is_exec_or_owner() returns boolean language sql stable as $$ select true $$;
create function silo_business_today() returns date language sql stable as $$ select current_setting('test.today')::date $$;
set test.today = '2026-11-25';
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create table silo_chat_schema_catalog(relname text primary key, relkind text, description text, keywords text[],
  is_hidden boolean default false, updated_at timestamptz);
create function refresh_chat_schema_catalog() returns void language plpgsql as $$
begin
  insert into silo_chat_schema_catalog(relname, relkind)
  select c.relname, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v') on conflict (relname) do nothing;
end $$;

create table entities(id uuid primary key);
insert into entities values ('${CO}'), ('${CO2}');
create table quickbooks_connections(id uuid primary key, company_entity_id uuid, is_active boolean default true);
insert into quickbooks_connections values ('${CONN}', '${CO}', true), ('${CONN2}', '${CO2}', true),
  ('${CONN_STRAY}', '${CO}', true);
create table accounting_settings(company_entity_id uuid primary key, qbo_connection_id uuid, accounting_basis text);
insert into accounting_settings values ('${CO}', '${CONN}', 'Accrual'), ('${CO2}', '${CONN2}', 'Accrual');
create table accounting_accounts(company_entity_id uuid, qbo_connection_id uuid, qbo_account_id text, name text,
  account_type text);
create table quickbooks_accounts(company_entity_id uuid, connection_id uuid, qbo_account_id text, name text,
  account_type text);
insert into accounting_accounts values
  ('${CO}', '${CONN}', '10', 'Checking', 'Bank'),
  ('${CO}', '${CONN}', '20', 'Sales', 'Income'),
  ('${CO}', '${CONN}', '30', 'Rent', 'Expense'),
  ('${CO}', '${CONN}', '31', 'Rent:Warehouse', 'Expense'),
  ('${CO}', '${CONN}', '40', 'Visa', 'Credit Card');
insert into quickbooks_accounts values ('${CO}', '${CONN}', '50', 'Old Loan', 'Long Term Liability');
create table quickbooks_journal_postings(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  connection_id uuid, payload jsonb, qbo_journal_entry_id text, qbo_doc_number text, status text);
-- The ledger view this migration reads for every day it has not read back.
create table ledger_fixture(company_entity_id uuid, origin text, entry_date date, qbo_account_id text,
  qbo_account_name text, account_type text, posting_type text, amount numeric, signed_amount numeric,
  counterparty text, document_number text, transaction_type text, memo text, description text,
  transaction_ref text);
create view accounting_ledger_v as select * from ledger_fixture;
`);

let MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20261125150000_quickbooks_ledger_mirror.sql', import.meta.url), 'utf8');
const MUTATIONS = {
  // a section whose rows do not add up is accepted
  'accept-untied-section': [`               is distinct from coalesce(r.total, 0))`, `               is distinct from coalesce(r.total, 0) and false)`],
  // a month that does not balance is accepted
  'accept-unbalanced': [`if abs(v_net) > 0.005 then`, `if false then`],
  // an account with no known side is stored anyway
  'accept-unknown-type': [`if v_bad is not null then raise exception 'account % has no known debit or credit side', v_bad; end if;`, ``],
  // a changed month is appended to instead of replaced
  'append-not-replace': [`    delete from public.quickbooks_ledger_mirror_lines where period_id = v_period.id;`, ``],
  // credits are stored as debits
  'no-sign-flip': [`'Other Income') then -1`, `'Other Income') then 1`],
  // the stored chart beats what QuickBooks says now
  'stale-chart-first': [`          nullif(p_account_types ->> r.qid, ''),\n`, ``],
  // a report for another period is accepted
  'accept-wrong-start': [`    if p_report #>> '{Header,StartPeriod}' is distinct from p_period_start::text`, `    if false and p_report #>> '{Header,StartPeriod}' is distinct from p_period_start::text`],
  // a report that stops short is accepted as the whole period
  'accept-wrong-end': [`       or p_report #>> '{Header,EndPeriod}' is distinct from p_read_through::text then`, `       then`],
  // a refusal wipes the last good read
  'refusal-forgets-error': [`     set last_attempt_at = now(), last_error = v_err`, `     set last_attempt_at = now()`],
  // any connection of the company can be written
  'any-connection': [`   where s.company_entity_id = p_company and s.qbo_connection_id = p_connection;`, `   where s.company_entity_id = p_company;`],
  // the books view shows a read month from both places
  'view-double-count': [`     and g.entry_date between c.period_start and c.read_through\n);`, `     and g.entry_date between c.period_start and c.read_through and false\n);`],
  // a lookalike document number is taken for SILO's entry
  'view-match-by-number': [` and e.txn_id = m.qbo_transaction_id and m.transaction_type = 'Journal Entry'\n\nunion all`,
                           ` and (e.txn_id = m.qbo_transaction_id or m.document_number like 'SILO-%') and m.transaction_type = 'Journal Entry'\n\nunion all`],
  // an edit in QuickBooks goes unnoticed
  'view-ignore-edits': [`            where round(coalesce(sent.amt, 0), 2) <> round(coalesce(held.amt, 0), 2)\n               or held.same_day is false`, `            where false`],
  // a refused month is retried at once
  'due-no-backoff': [`when p.last_error is not null then p.last_attempt_at < now() - interval '6 hours'`, `when p.last_error is not null then true`],
  // a failed read wipes the record of the last good one
  'failure-clears-read': [`  do update set last_attempt_at = now(), last_error = excluded.last_error;`,
                          `  do update set last_attempt_at = now(), last_error = excluded.last_error, read_at = null, content_hash = null;`],
  // a browser can mark any month as failed
  'browser-can-fail': [`revoke all on function public.quickbooks_ledger_mirror_failed(uuid, uuid, date, text)\n  from public, anon, authenticated;`, ``],
  // a browser can write the mirror
  'browser-can-store': [`revoke all on function public.quickbooks_ledger_mirror_store(uuid, uuid, date, date, jsonb, jsonb)\n  from public, anon, authenticated;`, ``],
};
const MUTATION = process.env.LEDGER_MIRROR_MUTATION || '';
if (MUTATION) {
  const m = MUTATIONS[MUTATION];
  if (!m) throw new Error(`unknown LEDGER_MIRROR_MUTATION ${MUTATION}`);
  if (MIGRATION.split(m[0]).length !== 2) throw new Error(`mutation ${MUTATION} no longer matches the migration`);
  MIGRATION = MIGRATION.replace(m[0], m[1]);
  console.log(`# mutation ${MUTATION} applied`);
}
// Supabase hands EXECUTE on every new public function to anon and authenticated.
await db.exec(`alter default privileges in schema public grant execute on functions to anon, authenticated`);
await db.exec(MIGRATION);

// ── A QuickBooks GeneralLedger report, built the way QuickBooks sends it ────
const COLS = ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'split_acc', 'subt_nat_amount', 'rbal_nat_amount'];
const money = (n) => (n === '' ? '' : Number(n).toFixed(2));
const dataRow = ([date, type, id, doc, name, memo, split, amount]) => ({
  type: 'Data',
  ColData: [{ value: date }, { value: type, id }, { value: doc }, { value: name }, { value: memo },
            { value: split }, { value: money(amount) }, { value: '0.00' }],
});
const opening = () => ({ type: 'Data', ColData: [{ value: 'Beginning Balance' }, { value: '' }, { value: '' },
  { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '100.00' }] });
const summary = (total) => ({ ColData: [{ value: 'Total' }, { value: '' }, { value: '' }, { value: '' },
  { value: '' }, { value: '' }, { value: money(total) }, { value: '' }] });
const sum = (rows) => rows.reduce((n, r) => n + (r[7] === '' ? 0 : Number(r[7])), 0);
const leaf = (id, name, rows, { total, withOpening = false } = {}) => ({
  type: 'Section',
  Header: { ColData: [id === null ? { value: name } : { value: name, id }] },
  Rows: { Row: [...(withOpening ? [opening()] : []), ...rows.map(dataRow)] },
  Summary: summary(total ?? sum(rows)),
});
// A parent with its own rows: QuickBooks wraps them in a headerless child.
const group = (id, name, ownRows, children) => ({
  type: 'Section',
  Header: { ColData: [{ value: name, id }] },
  Rows: { Row: [
    { type: 'Section', Rows: { Row: ownRows.map(dataRow) }, Summary: summary(sum(ownRows)) },
    ...children,
  ] },
  Summary: summary(sum(ownRows) + children.reduce((n, c) => n + Number(c.Summary.ColData[6].value || 0), 0)),
});
const report = (start, end, sections, over = {}) => ({
  Header: { ReportName: 'GeneralLedger', StartPeriod: start, EndPeriod: end, ReportBasis: 'Accrual', ...over.Header },
  Columns: { Column: (over.cols || COLS).map((k) => ({ ColTitle: k, MetaData: [{ Name: 'ColKey', Value: k }] })) },
  Rows: { Row: sections },
});
const store = async (rep, { co = CO, conn = CONN, start = '2026-09-01', through = '2026-09-30', types = {} } = {}) => {
  const [{ r }] = await q(`select public.quickbooks_ledger_mirror_store($1::uuid, $2::uuid, $3::date, $4::date, $5::jsonb, $6::jsonb) r`,
    [co, conn, start, through, JSON.stringify(rep), JSON.stringify(types)]);
  return r;
};
const lines = async (start = '2026-09-01') => (await q(
  `select l.transaction_date::text d, l.qbo_account_id a, l.account_type t, l.signed_amount::text amt,
          coalesce(l.qbo_transaction_id, '') ref
     from quickbooks_ledger_mirror_lines l join quickbooks_ledger_mirror_periods p on p.id = l.period_id
    where p.period_start = '${start}' order by l.line_no`)).map((r) => `${r.d} ${r.a} ${r.t} ${r.amt} ${r.ref}`);
const period = async (start = '2026-09-01') => (await q(
  `select read_at, read_through::text, line_count, last_error, content_hash, last_attempt_at
     from quickbooks_ledger_mirror_periods where company_entity_id = '${CO}' and period_start = '${start}'`))[0];

// September as QuickBooks holds it: a sale, rent paid on the card (the rent
// split between the parent account and a sub-account), and one zero row.
const SEPT_ROWS = {
  checking: [['2026-09-05', 'Deposit', 'T1', '', 'Customer', 'Sale', 'Sales', 300]],
  sales:    [['2026-09-05', 'Deposit', 'T1', '', 'Customer', 'Sale', 'Checking', 300]],
  rent:     [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 400]],
  rentWh:   [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 100],
             ['2026-09-11', 'Journal Entry', 'J8', '', '', 'Zero line', 'Visa', '']],
  visa:     [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 500]],
};
const september = (rows = SEPT_ROWS) => report('2026-09-01', '2026-09-30', [
  leaf('10', 'Checking', rows.checking, { withOpening: true }),
  leaf('20', 'Sales', rows.sales),
  group('30', 'Rent', rows.rent, [leaf('31', 'Warehouse', rows.rentWh)]),
  leaf('40', 'Visa', rows.visa),
  leaf(null, 'Not Specified', [['2026-09-12', 'Payment', 'T9', '', '', 'Created by QB Online', '', '']]),
]);
const SEPT_LINES = [
  '2026-09-05 10 Bank 300.00 T1',
  '2026-09-05 20 Income -300.00 T1',
  '2026-09-10 30 Expense 400.00 J7',      // the parent's own row, from its headerless child
  '2026-09-10 31 Expense 100.00 J7',
  '2026-09-10 40 Credit Card -500.00 J7',
];

await test('a good month is stored: debits positive, credits negative, no opening or zero rows', async () => {
  const r = await store(september());
  assert.deepEqual(r, { ok: true, changed: true, lines: 5 });
  assert.deepEqual(await lines(), SEPT_LINES);
  const p = await period();
  assert.ok(p.read_at);
  assert.equal(p.read_through, '2026-09-30');
  assert.equal(p.line_count, 5);
  assert.equal(p.last_error, null);
  const [{ net }] = await q(`select sum(signed_amount)::text net from quickbooks_ledger_mirror_lines`);
  assert.equal(Number(net), 0);
});

await test('reading the same month again changes nothing', async () => {
  const before = await q(`select id from quickbooks_ledger_mirror_lines order by id`);
  const p0 = await period();
  const r = await store(september());
  assert.deepEqual(r, { ok: true, changed: false, lines: 5 });
  assert.deepEqual(await q(`select id from quickbooks_ledger_mirror_lines order by id`), before);
  assert.equal((await period()).content_hash, p0.content_hash);
});

await test('a changed month replaces its lines in place', async () => {
  // Someone moved the warehouse rent to the parent account in QuickBooks.
  const edited = { ...SEPT_ROWS,
    rent: [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 500]],
    rentWh: [] };
  const r = await store(september(edited));
  assert.deepEqual(r, { ok: true, changed: true, lines: 4 });
  assert.deepEqual(await lines(), [
    '2026-09-05 10 Bank 300.00 T1', '2026-09-05 20 Income -300.00 T1',
    '2026-09-10 30 Expense 500.00 J7', '2026-09-10 40 Credit Card -500.00 J7',
  ]);
  const [{ n }] = await q(`select count(*)::int n from quickbooks_ledger_mirror_periods`);
  assert.equal(n, 1, 'one period row per month, however often it is read');
  assert.deepEqual(await store(september()), { ok: true, changed: true, lines: 5 });
});

const refused = async (name, rep, pattern, opts) => {
  const before = await q(`select id, signed_amount from quickbooks_ledger_mirror_lines order by id`);
  const p0 = await period();
  const r = await store(rep, opts);
  assert.equal(r.ok, false, `${name}: must be refused`);
  assert.match(r.error, pattern, name);
  assert.deepEqual(await q(`select id, signed_amount from quickbooks_ledger_mirror_lines order by id`), before,
    `${name}: the last accepted read must be untouched`);
  const p = await period();
  assert.match(p.last_error, pattern);
  assert.deepEqual([String(p.read_at), p.content_hash, p.line_count], [String(p0.read_at), p0.content_hash, p0.line_count]);
  // ... and the next good read clears the error.
  assert.equal((await store(september())).ok, true);
  assert.equal((await period()).last_error, null);
};

await test('a report for another period is refused and the last read kept', async () => {
  await refused('other period', report('2026-08-01', '2026-08-31', []), /covers 2026-08-01 to 2026-08-31/);
  // Each end is checked on its own: a report that only STARTS early would
  // otherwise file two months of activity under one.
  await refused('starts early', report('2026-08-01', '2026-09-30', []), /covers 2026-08-01 to 2026-09-30/);
  await refused('ends early', report('2026-09-01', '2026-09-15', []), /covers 2026-09-01 to 2026-09-15/);
});

await test('a section whose rows do not add up to its total is refused', async () => {
  const rep = september();
  rep.Rows.Row[1] = leaf('20', 'Sales', SEPT_ROWS.sales, { total: 299 });
  await refused('untied section', rep, /rows of Sales do not add up/);
});

await test('a month whose debits and credits differ is refused', async () => {
  await refused('unbalanced', september({ ...SEPT_ROWS,
    sales: [['2026-09-05', 'Deposit', 'T1', '', 'Customer', 'Sale', 'Checking', 250]] }), /does not balance/);
});

await test('an account with no known type is refused, by name', async () => {
  const rep = september();
  rep.Rows.Row.push(leaf('77', 'Brand New Account', [['2026-09-20', 'Journal Entry', 'J9', '', '', '', '', 5]]));
  await refused('unknown account', rep, /Brand New Account \(no type\)/);
});

await test('unsupported columns, a row outside the period and loose money are each refused', async () => {
  await refused('columns', report('2026-09-01', '2026-09-30', [], { cols: ['tx_date', 'debt_amt'] }), /unsupported ledger columns/);
  await refused('outside', september({ ...SEPT_ROWS,
    checking: [['2026-10-05', 'Deposit', 'T1', '', 'Customer', 'Sale', 'Sales', 300]] }), /dated outside the period/);
  const loose = september();
  loose.Rows.Row[4] = leaf(null, 'Not Specified', [['2026-09-12', 'Payment', 'T9', '', '', '', '', 12]]);
  await refused('loose money', loose, /money and no QuickBooks account/);
  const mixed = september();
  mixed.Rows.Row[2].Rows.Row.push(dataRow(['2026-09-13', 'Check', 'T5', '', '', '', '', 1]));
  await refused('mixed', mixed, /mixes sub-accounts and its own rows/);
  await refused('other report', { ...september(), Header: { ReportName: 'TrialBalance' } }, /not a GeneralLedger/);
});

await test('account types from QuickBooks now win over the stored chart, which is the fallback', async () => {
  // Account 50 is only in the older chart table; account 77 is in neither and
  // arrives with the read; account 30 is stored as Expense but is now COGS.
  const rep = report('2026-10-01', '2026-10-31', [
    leaf('30', 'Rent', [['2026-10-02', 'Check', 'T20', '', '', '', '', 60]]),
    leaf('50', 'Old Loan', [['2026-10-02', 'Check', 'T20', '', '', '', '', 100]]),
    leaf('77', 'Brand New Account', [['2026-10-02', 'Check', 'T20', '', '', '', '', 40]]),
  ]);
  const r = await store(rep, { start: '2026-10-01', through: '2026-10-31',
    types: { 77: 'Other Current Asset', 30: 'Cost of Goods Sold' } });
  assert.deepEqual(r, { ok: true, changed: true, lines: 3 });
  assert.deepEqual(await lines('2026-10-01'), [
    '2026-10-02 30 Cost of Goods Sold 60.00 T20',
    '2026-10-02 50 Long Term Liability -100.00 T20',
    '2026-10-02 77 Other Current Asset 40.00 T20',
  ]);
});

await test('only the connection the company keeps its books on can be written', async () => {
  await assert.rejects(store(september(), { conn: CONN_STRAY }), /not this company's books/);
  await assert.rejects(store(september(), { conn: CONN2 }), /not this company's books/);
  await assert.rejects(store(september(), { start: '2026-09-02' }), /first of a month/);
  await assert.rejects(store(september(), { through: '2026-10-01' }), /outside the month/);
});

await test('a read that never reached the store is recorded and the lines kept', async () => {
  const before = await lines();
  const p0 = await period();
  await q(`select public.quickbooks_ledger_mirror_failed($1::uuid, $2::uuid, '2026-09-01', 'quickbooks_unreachable')`, [CO, CONN]);
  const p = await period();
  assert.equal(p.last_error, 'quickbooks_unreachable');
  assert.deepEqual([String(p.read_at), p.content_hash], [String(p0.read_at), p0.content_hash]);
  assert.deepEqual(await lines(), before);
  // A month that has never been read gets its row from the failure itself.
  await q(`select public.quickbooks_ledger_mirror_failed($1::uuid, $2::uuid, '2026-06-01', 'reconnect_required')`, [CO, CONN]);
  const june = await period('2026-06-01');
  assert.deepEqual([june.read_at, june.last_error, june.line_count], [null, 'reconnect_required', 0]);
  await assert.rejects(q(`select public.quickbooks_ledger_mirror_failed($1::uuid, $2::uuid, '2026-06-01', 'x')`, [CO, CONN_STRAY]), /not this company's books/);
  await assert.rejects(q(`select public.quickbooks_ledger_mirror_failed($1::uuid, $2::uuid, '2026-06-02', 'x')`, [CO, CONN]), /a month/);
  await db.exec(`delete from quickbooks_ledger_mirror_periods where period_start = '2026-06-01'`);
  assert.equal((await store(september())).ok, true);
  assert.equal((await period()).last_error, null);
});

await test('only the service role can write the mirror or ask what is due', async () => {
  const rows = await q(`select p.proname, r.rolname,
      has_function_privilege(r.rolname, p.oid, 'execute') can
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
   where p.proname in ('quickbooks_ledger_mirror_store', 'quickbooks_ledger_mirror_due',
                       'quickbooks_ledger_mirror_failed') order by 1, 2`);
  assert.deepEqual(rows.map((r) => `${r.proname} ${r.rolname} ${r.can}`), [
    'quickbooks_ledger_mirror_due anon false', 'quickbooks_ledger_mirror_due authenticated false',
    'quickbooks_ledger_mirror_due service_role true',
    'quickbooks_ledger_mirror_failed anon false', 'quickbooks_ledger_mirror_failed authenticated false',
    'quickbooks_ledger_mirror_failed service_role true',
    'quickbooks_ledger_mirror_store anon false', 'quickbooks_ledger_mirror_store authenticated false',
    'quickbooks_ledger_mirror_store service_role true',
  ]);
  const tables = await q(`select c.relname,
      has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE') w,
      has_table_privilege('anon', c.oid, 'SELECT') a, c.relrowsecurity rls
    from pg_class c where c.relname like 'quickbooks_ledger_mirror_%' and c.relkind = 'r' order by 1`);
  assert.deepEqual(tables, [
    { relname: 'quickbooks_ledger_mirror_lines', w: false, a: false, rls: true },
    { relname: 'quickbooks_ledger_mirror_periods', w: false, a: false, rls: true },
  ]);
  const [v] = await q(`select has_table_privilege('anon', 'silo_books_ledger_v', 'SELECT') a,
      has_table_privilege('authenticated', 'silo_books_ledger_v', 'INSERT,UPDATE,DELETE') w,
      (select reloptions::text from pg_class where relname = 'silo_books_ledger_v') o`);
  assert.deepEqual(v, { a: false, w: false, o: '{security_invoker=true}' });
});

// ── What is due ────────────────────────────────────────────────────────────
const due = async (back = 3, limit = 20) => (await q(
  `select company_entity_id co, period_start::text s, read_through::text t
     from public.quickbooks_ledger_mirror_due(${back}, ${limit})`))
  .map((r) => `${r.co === CO ? 'A' : 'B'} ${r.s}..${r.t}`);

await test('months never read come first, and the current month is read to today', async () => {
  // Today is 2026-11-25. Company A has September and October; B has nothing.
  const rows = await due();
  assert.deepEqual(rows.slice().sort(), [
    'A 2026-08-01..2026-08-31', 'A 2026-11-01..2026-11-25',
    'B 2026-08-01..2026-08-31', 'B 2026-09-01..2026-09-30', 'B 2026-10-01..2026-10-31', 'B 2026-11-01..2026-11-25',
  ]);
  assert.deepEqual((await due(3, 2)).length, 2);
  await db.exec(`update quickbooks_connections set is_active = false where id = '${CONN2}'`);
  assert.deepEqual((await due()).filter((r) => r.startsWith('B')), [], 'a disconnected company is not read');
});

await test('recent months are due nightly, older ones weekly, and a refusal waits', async () => {
  // October is last month (recent); September is older.
  await db.exec(`update quickbooks_ledger_mirror_periods set read_at = now() - interval '21 hours'`);
  assert.deepEqual((await due()).filter((r) => /2026-(09|10)/.test(r)), ['A 2026-10-01..2026-10-31']);
  await db.exec(`update quickbooks_ledger_mirror_periods set read_at = now() - interval '8 days'`);
  assert.deepEqual((await due()).filter((r) => /2026-(09|10)/.test(r)).sort(),
    ['A 2026-09-01..2026-09-30', 'A 2026-10-01..2026-10-31']);
  // A refusal a minute ago: not retried yet, even though the read is old.
  await db.exec(`update quickbooks_ledger_mirror_periods set last_error = 'x', last_attempt_at = now() - interval '1 minute'
                  where period_start = '2026-09-01'`);
  assert.deepEqual((await due()).filter((r) => /2026-09/.test(r)), []);
  await db.exec(`update quickbooks_ledger_mirror_periods set last_attempt_at = now() - interval '7 hours'
                  where period_start = '2026-09-01'`);
  assert.deepEqual((await due()).filter((r) => /2026-09/.test(r)), ['A 2026-09-01..2026-09-30']);
  await db.exec(`update quickbooks_ledger_mirror_periods set last_error = null, read_at = now()`);
});

// ── SILO's books ───────────────────────────────────────────────────────────
await db.exec(`
insert into ledger_fixture values
  -- before the move: imported history, never mirrored
  ('${CO}', 'qbo_history', '2026-07-15', '30', 'Rent', 'Expense', 'Debit', 90, 90, null, null, 'Check', null, null, 'H1'),
  -- September as SILO posted it: superseded by the mirror for that month
  ('${CO}', 'silo', '2026-09-10', '30', 'Rent', null, 'Debit', 400, 400, null, 'SILO-AAA', 'journal_adjustment', null, null, 'JE-1'),
  ('${CO}', 'silo', '2026-09-10', '40', 'Visa', null, 'Credit', 400, -400, null, 'SILO-AAA', 'journal_adjustment', null, null, 'JE-1'),
  -- November 28: after the day the November read reached
  ('${CO}', 'silo', '2026-11-28', '30', 'Rent', null, 'Debit', 70, 70, null, 'SILO-NOV', 'journal_adjustment', null, null, 'JE-2'),
  -- November 3: inside what was read, so the mirror answers for that day
  ('${CO}', 'silo', '2026-11-03', '30', 'Rent', null, 'Debit', 11, 11, null, 'SILO-EARLY', 'journal_adjustment', null, null, 'JE-3');
`);
const posting = (txnId, doc, date, linesIn, status = 'posted') => db.query(
  `insert into quickbooks_journal_postings(company_entity_id, connection_id, payload, qbo_journal_entry_id, qbo_doc_number, status)
   values ($1, $2, $3::jsonb, $4, $5, $6)`,
  [CO, CONN, JSON.stringify({ DocNumber: doc, TxnDate: date, Line: linesIn.map(([acct, type, amt]) => ({
    Amount: amt, JournalEntryLineDetail: { AccountRef: { value: acct }, PostingType: type } })) }), txnId, doc, status]);
const books = async (where = 'true') => (await q(
  `select source, entry_date::text d, qbo_account_id a, account_type t, signed_amount::text amt, coalesce(transaction_ref, '') ref
     from silo_books_ledger_v where ${where} order by entry_date, transaction_ref, qbo_account_id`))
  .map((r) => `${r.source} ${r.d} ${r.a} ${r.t} ${r.amt} ${r.ref}`);

await test('a read month comes from the mirror, every other day from the ledger', async () => {
  // November, read through the 25th.
  await store(report('2026-11-01', '2026-11-25', [
    leaf('30', 'Rent', [['2026-11-03', 'Check', 'T30', '', '', '', '', 11]]),
    leaf('10', 'Checking', [['2026-11-03', 'Check', 'T30', '', '', '', '', -11]]),
  ]), { start: '2026-11-01', through: '2026-11-25' });
  assert.deepEqual(await books(`entry_date < '2026-09-01' or entry_date >= '2026-11-01'`), [
    'history 2026-07-15 30 Expense 90 H1',
    // the 3rd is inside the read: QuickBooks' lines, and SILO's own JE-3 row is not added on top
    'quickbooks 2026-11-03 10 Bank -11.00 T30',
    'quickbooks 2026-11-03 30 Expense 11.00 T30',
    // the 28th is after the read: SILO's own entry, with its account type looked up
    'silo 2026-11-28 30 Expense 70 JE-2',
  ]);
  const [{ n }] = await q(`select count(*)::int n from silo_books_ledger_v where transaction_ref = 'JE-1'`);
  assert.equal(n, 0, 'September is read, so SILO\'s own copy of it is not counted as well');
  const [{ net }] = await q(`select sum(signed_amount)::text net from silo_books_ledger_v
                              where entry_date between '2026-09-01' and '2026-09-30'`);
  assert.equal(Number(net), 0);
});

await test('each line says where it came from', async () => {
  // J7 is the entry SILO sent, exactly as QuickBooks holds it now.
  await posting('J7', 'SILO-AAA', '2026-09-10', [['30', 'Debit', 400], ['31', 'Debit', 100], ['40', 'Credit', 500]]);
  assert.deepEqual(await books(`entry_date between '2026-09-01' and '2026-09-30'`), [
    'silo 2026-09-10 30 Expense 400.00 J7',
    'silo 2026-09-10 31 Expense 100.00 J7',
    'silo 2026-09-10 40 Credit Card -500.00 J7',
    'quickbooks 2026-09-05 10 Bank 300.00 T1',
    'quickbooks 2026-09-05 20 Income -300.00 T1',
  ].sort((a, b) => a.slice(a.indexOf('2026')).localeCompare(b.slice(b.indexOf('2026')))));
});

await test('an entry SILO sent and someone changed is marked edited', async () => {
  const sources = async () => [...new Set((await q(
    `select source from silo_books_ledger_v where transaction_ref = 'J7'`)).map((r) => r.source))];
  // The account was changed in QuickBooks: the warehouse rent moved to the parent.
  await store(september({ ...SEPT_ROWS,
    rent: [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 500]], rentWh: [] }));
  assert.deepEqual(await sources(), ['quickbooks_edited']);
  // The date was changed.
  const moved = (rows) => rows.map((r) => (r[2] === 'J7' ? ['2026-09-12', ...r.slice(1)] : r));
  await store(september({ ...SEPT_ROWS, rent: moved(SEPT_ROWS.rent), rentWh: moved(SEPT_ROWS.rentWh), visa: moved(SEPT_ROWS.visa) }));
  assert.deepEqual(await sources(), ['quickbooks_edited']);
  // Put back as sent.
  await store(september());
  assert.deepEqual(await sources(), ['silo']);
});

// ── the sync page's "QuickBooks and SILO agree" (v2/quickbooks-sync.js) ─────
// The page's own SQL, run the way the report engine wraps it.
// QBSYNC_MUTATION=<name> breaks one rule of it; the suite must then fail.
const AGREE_MUTATIONS = {
  'agree-ignores-amount': [`abs(round(coalesce(s.amt, 0), 2) - round(coalesce(h.amt, 0), 2)) as off`, `0::numeric as off`],
  'agree-ignores-day': [`coalesce(bool_or(same_day is false), false) as moved`, `false as moved`],
  'agree-judges-unread': [`judged as (select s.* from sent s where exists (select 1 from covered c`, `judged as (select s.* from sent s where true or exists (select 1 from covered c`],
  'agree-counts-unposted': [` and p.status = 'posted' and p.qbo_journal_entry_id is not null`, ` and p.qbo_journal_entry_id is not null`],
  'agree-by-any-type': [` and m.qbo_transaction_id = e.txn and m.transaction_type = 'Journal Entry'`, ` and m.qbo_transaction_id = e.txn`],
  'agree-unchecked-company': [`if (!UUID.test(String(companyId || ''))) throw new Error('Select a company first');`, ``],
};
let syncSource = readFileSync(new URL('../../v2/quickbooks-sync.js', import.meta.url), 'utf8');
if (process.env.QBSYNC_MUTATION) {
  const m = AGREE_MUTATIONS[process.env.QBSYNC_MUTATION];
  if (!m) throw new Error(`unknown QBSYNC_MUTATION ${process.env.QBSYNC_MUTATION}`);
  if (syncSource.split(m[0]).length !== 2) throw new Error(`mutation ${process.env.QBSYNC_MUTATION} no longer matches the page`);
  syncSource = syncSource.replace(m[0], m[1]);
}
const syncWindow = {};
vm.runInNewContext(syncSource, { window: syncWindow, Date, Map, Set, Number, Array, Object, Promise, Error, String, Math, Boolean });
const Sync = syncWindow.SiloQuickBooksSync;
const agree = async (co = CO) => (await q(`select * from (${Sync.agreementSql(co)}) user_query limit 1000 offset 0`))
  .map((r) => `${r.month} entries=${r.entries} changed=${r.changed} off=${Number(r.amount).toFixed(2)}`);

await test('the sync page: an entry QuickBooks still holds as sent agrees; a change, a move or a delete differs', async () => {
  // A posted entry in a month nobody has read back, one that failed, and a
  // different kind of QuickBooks transaction that happens to share J7's id.
  await posting('J200', 'SILO-DEC', '2026-12-05', [['30', 'Debit', 9], ['40', 'Credit', 9]]);
  await posting('J201', 'SILO-BAD', '2026-09-20', [['30', 'Debit', 77], ['40', 'Credit', 77]], 'failed');
  await store(september());
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=0 off=0.00']);
  // 100 moved from the warehouse account to its parent.
  await store(september({ ...SEPT_ROWS,
    rent: [['2026-09-10', 'Journal Entry', 'J7', 'SILO-AAA', '', 'Rent', '-Split-', 500]], rentWh: [] }));
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=1 off=100.00']);
  // Same amounts, two days later.
  const moved = (rows) => rows.map((r) => (r[2] === 'J7' ? ['2026-09-12', ...r.slice(1)] : r));
  await store(september({ ...SEPT_ROWS, rent: moved(SEPT_ROWS.rent), rentWh: moved(SEPT_ROWS.rentWh), visa: moved(SEPT_ROWS.visa) }));
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=1 off=0.00']);
  // Deleted in QuickBooks: the whole entry is the difference.
  const without = (rows) => rows.filter((r) => r[2] !== 'J7');
  await store(september({ ...SEPT_ROWS, rent: without(SEPT_ROWS.rent), rentWh: without(SEPT_ROWS.rentWh), visa: without(SEPT_ROWS.visa) }));
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=1 off=500.00']);
  // A deposit that carries the same id is not SILO's journal entry.
  await store(september({ ...SEPT_ROWS,
    rent: [['2026-09-10', 'Deposit', 'J7', '', '', 'Rent', '-Split-', 400]],
    rentWh: [['2026-09-10', 'Deposit', 'J7', '', '', 'Rent', '-Split-', 100]],
    visa: [['2026-09-10', 'Deposit', 'J7', '', '', 'Rent', '-Split-', 500]] }));
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=1 off=500.00']);
  await store(september());
  assert.deepEqual(await agree(), ['2026-09 entries=1 changed=0 off=0.00']);
  // Another company is never judged from this one's entries, and a value that
  // is not a company id never reaches the SQL.
  assert.deepEqual(await agree('00000000-0000-4000-a000-0000000000ff'), []);
  assert.throws(() => Sync.agreementSql(`${CO}' or true --`), /Select a company/);
  assert.throws(() => Sync.agreementSql(null), /Select a company/);
});

await test('a SILO-looking number on someone else\'s entry is not SILO\'s', async () => {
  // A hand entry in QuickBooks carrying a SILO-style document number, and a
  // posting of SILO's that failed and so was never booked.
  await posting('J55', 'SILO-BBB', '2026-10-02', [['30', 'Debit', 60]], 'failed');
  const rep = report('2026-10-01', '2026-10-31', [
    leaf('30', 'Rent', [['2026-10-02', 'Journal Entry', 'J99', 'SILO-BBB', '', 'COGS by hand', '', 60],
                        ['2026-10-03', 'Journal Entry', 'J55', 'SILO-BBB', '', '', '', 5]]),
    leaf('40', 'Visa', [['2026-10-02', 'Journal Entry', 'J99', 'SILO-BBB', '', 'COGS by hand', '', 60],
                        ['2026-10-03', 'Journal Entry', 'J55', 'SILO-BBB', '', '', '', 5]]),
  ]);
  assert.equal((await store(rep, { start: '2026-10-01', through: '2026-10-31' })).ok, true);
  const rows = await q(`select distinct source from silo_books_ledger_v
                         where entry_date between '2026-10-01' and '2026-10-31'`);
  assert.deepEqual(rows, [{ source: 'quickbooks' }]);
});

await test('the migration is idempotent and keeps what was read', async () => {
  const before = await q(`select count(*)::int n from quickbooks_ledger_mirror_lines`);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  assert.deepEqual(await q(`select count(*)::int n from quickbooks_ledger_mirror_lines`), before);
  const [{ description, described }] = await q(`select
      (select description from silo_chat_schema_catalog where relname = 'silo_books_ledger_v') description,
      (select count(*)::int from silo_chat_schema_catalog where relname like 'quickbooks_ledger_mirror_%'
          and coalesce(btrim(description), '') <> '' and keywords is not null) described`);
  assert.match(description, /kept in step with QuickBooks/);
  assert.equal(described, 2);
});

await test('the production verify check reads ok here', async () => {
  const verify = readFileSync(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  const at = verify.indexOf(`select 'QuickBooks ledger mirror' as check_name`);
  assert.ok(at > 0, 'the verify check is gone');
  const check = verify.slice(at, verify.indexOf('as status;', at) + 'as status;'.length);
  const [{ status }] = await q(check);
  if (!MUTATION) assert.equal(status, 'ok');
  // The check must notice the things it exists for.
  await db.exec(`grant execute on function public.quickbooks_ledger_mirror_store(uuid,uuid,date,date,jsonb,jsonb) to authenticated`);
  assert.match((await q(check))[0].status, /^CRITICAL: a browser can write/);
  await db.exec(`revoke execute on function public.quickbooks_ledger_mirror_store(uuid,uuid,date,date,jsonb,jsonb) from authenticated;
                 alter table public.quickbooks_ledger_mirror_lines disable row level security`);
  assert.match((await q(check))[0].status, /^CRITICAL: the QuickBooks ledger mirror is open/);
  await db.exec(`alter table public.quickbooks_ledger_mirror_lines enable row level security`);
});

console.log(`\n${passed} passed`);
