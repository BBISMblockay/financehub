// SILO books (/v2/silo-books.html): the shipped module's SQL, executed in a
// real PostgreSQL (PGlite) the way the report engine wraps it, and the
// statements built from the rows, against books whose answers are known.
//
// What it pins:
//   * a Profit & Loss with QuickBooks' sections and subtotals, one column or
//     one per month;
//   * a Balance Sheet that starts from the opening position of the EARLIEST
//     imported period (newest import of it), adds all activity, splits profit
//     into earlier years and this fiscal year, and balances;
//   * a Trial Balance whose debits equal its credits;
//   * another company's lines never reach a statement;
//   * a date, a company id or an account id that is not one is refused before
//     any SQL is built.
//
// Row security is NOT tested here: the view is security_invoker and the engine
// runs as the signed-in person; that is production's own boundary.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/silo-books.test.mjs
// Mutations: SILO_BOOKS_MUTATION=<name> breaks one rule; the suite must fail.
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

let SOURCE = readFileSync(new URL('../../v2/silo-books.js', import.meta.url), 'utf8');
const MUTATIONS = {
  // every import's opening position is added, not only the earliest period's
  'opening-any-import': [`      + '    and (o.period_start < i.period_start'\n      + '     or (o.period_start = i.period_start and (o.created_at, o.id) > (i.created_at, i.id))))'`,
                         `      + '    and false)'`],
  // an older copy of the earliest period beats the newest
  'opening-oldest-copy': [`(o.created_at, o.id) > (i.created_at, i.id))))'`, `(o.created_at, o.id) < (i.created_at, i.id))))'`],
  // a position before the books start still carries the opening
  'opening-before-start': [`      + \`  and i.period_start <= \${asOf}\`\n`, ``],
  // the opening position is left out
  'opening-ignored': [`const total = cents(r.opening) + cents(r.activity);`, `const total = cents(r.activity);`],
  // another company's lines are read
  'activity-any-company': [`      + \` where company_entity_id = \${uuid(companyId)}\`\n      + \` and entry_date between \${date(from)} and \${date(to)}\`\n      + ' and signed_amount is not null'`,
                           `      + \` where entry_date between \${date(from)} and \${date(to)}\`\n      + ' and signed_amount is not null'`],
  'positions-any-company': [`      + \` where company_entity_id = \${co} and entry_date <= \${asOf} and signed_amount is not null\``,
                            `      + \` where entry_date <= \${asOf} and signed_amount is not null\``],
  // income reads as a cost
  'income-sign': [`const sign = DEBIT_NATURAL.includes(r.account_type) ? 1 : -1;`, `const sign = 1;`],
  // profit of earlier years vanishes from equity
  'prior-earnings-dropped': [`priorEarnings -= (total - fiscal);`, ``],
  // this year's profit is the profit of all time
  'fiscal-all-time': [`netIncome -= fiscal;`, `netIncome -= total;`],
  // activity after the date is counted
  'positions-ignore-date': [`and entry_date <= \${asOf} and signed_amount is not null`, `and signed_amount is not null`],
  // anything is accepted as a date
  'date-unchecked': [`if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('Pick a valid date');`, ``],
  // anything is accepted as an account id
  'account-unchecked': [`if (!s || s.length > 64 || /[^A-Za-z0-9_.:-]/.test(s)) throw new Error('Not an account id');`, ``],
  // a period statement counts unplaced lines from outside its period
  'unplaced-ignores-from': [`const since = from ? \` and entry_date >= \${date(from)}\` : '';`, `const since = '';`],
  // another company's unplaced lines are counted
  'unplaced-any-company': [`      + \` where company_entity_id = \${uuid(companyId)} and entry_date <= \${date(to)}\${since}\``, `      + \` where entry_date <= \${date(to)}\${since}\``],
  // gross profit forgets cost of goods
  'gross-ignores-cogs': [`const gross = add(income, cogs, -1);`, `const gross = income;`],
  // the fiscal year always starts in January
  'fiscal-january': [`const y = month >= m ? year : year - 1;`, `const y = year;`],
};
const MUTATION = process.env.SILO_BOOKS_MUTATION || '';
if (MUTATION) {
  const m = MUTATIONS[MUTATION];
  if (m) {
    if (SOURCE.split(m[0]).length !== 2) throw new Error(`mutation ${MUTATION} no longer matches the module`);
    SOURCE = SOURCE.replace(m[0], m[1]);
  } else if (!/^policy-/.test(MUTATION)) throw new Error(`unknown SILO_BOOKS_MUTATION ${MUTATION}`);
  console.log(`# mutation ${MUTATION} applied`);
}
const ctx = { self: {} };
vm.runInNewContext(SOURCE, ctx);
const Books = ctx.self.SiloBooks;

const db = new PGlite();
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
// The engine's own wrapper (chat_run_readonly_query): one 1000-row page.
const engine = async (sql, offset = 0) => {
  assert.match(sql, /^(select|with)\s/i, 'the engine only runs SELECT or WITH');
  assert.ok(!sql.includes(';'), 'the engine refuses a semicolon');
  return (await db.query(`select * from (${sql}) user_query limit 1000 offset ${offset}`)).rows;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

const CO = '00000000-0000-4000-a000-000000000001';
const CO2 = '00000000-0000-4000-a000-000000000002';
const CONN = '00000000-0000-4000-c000-000000000001';
const CONN2 = '00000000-0000-4000-c000-000000000002';

await db.exec(`
create table qbo_history_imports(id uuid primary key, company_entity_id uuid, qbo_connection_id uuid,
  period_start date, period_end date, created_at timestamptz);
create table qbo_history_lines(company_entity_id uuid, import_id uuid, row_kind text, qbo_account_id text,
  account_name text, account_type text, natural_balance numeric);
create table quickbooks_ledger_mirror_periods(company_entity_id uuid, period_start date, read_through date,
  read_at timestamptz, last_error text);
create table silo_books_ledger_v(company_entity_id uuid, source text, entry_date date, qbo_account_id text,
  qbo_account_name text, account_type text, signed_amount numeric, counterparty text, document_number text,
  transaction_type text, memo text, description text, transaction_ref text);

-- The earliest period was imported twice; the newer copy is the one that counts.
insert into qbo_history_imports values
  ('00000000-0000-4000-b000-000000000001', '${CO}', '${CONN}', '2025-01-01', '2025-12-31', '2026-09-01'),
  ('00000000-0000-4000-b000-000000000002', '${CO}', '${CONN}', '2025-01-01', '2025-12-31', '2026-09-15'),
  ('00000000-0000-4000-b000-000000000003', '${CO}', '${CONN}', '2026-01-01', '2026-07-31', '2026-09-20'),
  ('00000000-0000-4000-b000-000000000009', '${CO2}', '${CONN2}', '2024-01-01', '2024-12-31', '2026-09-01');
insert into qbo_history_lines values
  ('${CO}', '00000000-0000-4000-b000-000000000001', 'opening', '10', 'Checking', 'Bank', 900),
  ('${CO}', '00000000-0000-4000-b000-000000000001', 'opening', '60', 'Owner', 'Equity', 900),
  ('${CO}', '00000000-0000-4000-b000-000000000002', 'opening', '10', 'Checking', 'Bank', 1000),
  ('${CO}', '00000000-0000-4000-b000-000000000002', 'opening', '60', 'Owner', 'Equity', 1000),
  ('${CO}', '00000000-0000-4000-b000-000000000002', 'transaction', '10', 'Checking', 'Bank', 7777),
  ('${CO}', '00000000-0000-4000-b000-000000000003', 'opening', '10', 'Checking', 'Bank', 5555),
  ('${CO2}', '00000000-0000-4000-b000-000000000009', 'opening', '10', 'Checking', 'Bank', 4444);

insert into silo_books_ledger_v(company_entity_id, source, entry_date, qbo_account_id, qbo_account_name,
  account_type, signed_amount, transaction_type, document_number, transaction_ref) values
  -- 2025: sales 500, rent 200
  ('${CO}', 'history', '2025-03-10', '10', 'Checking', 'Bank', 500, 'Deposit', 'D1', 't1'),
  ('${CO}', 'history', '2025-03-10', '20', 'Sales', 'Income', -500, 'Deposit', 'D1', 't1'),
  ('${CO}', 'history', '2025-12-05', '30', 'Rent', 'Expense', 200, 'Check', 'C1', 't2'),
  ('${CO}', 'history', '2025-12-05', '10', 'Checking', 'Bank', -200, 'Check', 'C1', 't2'),
  -- January 2026
  ('${CO}', 'silo', '2026-01-08', '10', 'Checking', 'Bank', 300, 'Journal Entry', 'SILO-1', 't3'),
  ('${CO}', 'silo', '2026-01-08', '20', 'Sales', 'Income', -300, 'Journal Entry', 'SILO-1', 't3'),
  ('${CO}', 'quickbooks', '2026-01-09', '25', 'Cost of goods', 'Cost of Goods Sold', 100, 'Journal Entry', 'J7', 't4'),
  ('${CO}', 'quickbooks', '2026-01-09', '10', 'Checking', 'Bank', -100, 'Journal Entry', 'J7', 't4'),
  ('${CO}', 'quickbooks_edited', '2026-01-15', '30', 'Rent', 'Expense', 50, 'Journal Entry', 'SILO-2', 't5'),
  ('${CO}', 'quickbooks_edited', '2026-01-15', '10', 'Checking', 'Bank', -50, 'Journal Entry', 'SILO-2', 't5'),
  ('${CO}', 'silo', '2026-01-20', '10', 'Checking', 'Bank', 10, 'Deposit', 'D2', 't6'),
  ('${CO}', 'silo', '2026-01-20', '70', 'Interest', 'Other Income', -10, 'Deposit', 'D2', 't6'),
  ('${CO}', 'silo', '2026-01-21', '80', 'Penalties', 'Other Expense', 5, 'Check', 'C2', 't7'),
  ('${CO}', 'silo', '2026-01-21', '10', 'Checking', 'Bank', -5, 'Check', 'C2', 't7'),
  ('${CO}', 'silo', '2026-01-22', '30', 'Rent', 'Expense', 20, 'Expense', 'E1', 't8'),
  ('${CO}', 'silo', '2026-01-22', '40', 'Visa', 'Credit Card', -20, 'Expense', 'E1', 't8'),
  -- February: after every date asked for below
  ('${CO}', 'silo', '2026-02-02', '10', 'Checking', 'Bank', 9000, 'Deposit', 'D3', 't9'),
  ('${CO}', 'silo', '2026-02-02', '20', 'Sales', 'Income', -9000, 'Deposit', 'D3', 't9'),
  -- an account type with no known side
  ('${CO}', 'history', '2026-01-10', '99', 'Mystery', 'Unattributed', null, 'Journal Entry', 'J9', 't10'),
  ('${CO}', 'history', '2025-06-10', '99', 'Mystery', 'Unattributed', null, 'Journal Entry', 'J8', 't11'),
  ('${CO2}', 'history', '2026-01-10', '99', 'Mystery', 'Unattributed', null, 'Journal Entry', 'X9', 'x2'),
  -- another company
  ('${CO2}', 'silo', '2026-01-08', '10', 'Checking', 'Bank', 8888, 'Deposit', 'X1', 'x1'),
  ('${CO2}', 'silo', '2026-01-08', '20', 'Sales', 'Income', -8888, 'Deposit', 'X1', 'x1');
insert into quickbooks_ledger_mirror_periods values
  ('${CO}', '2026-01-01', '2026-01-31', now(), null),
  ('${CO}', '2026-02-01', null, null, 'refused'),
  ('${CO2}', '2026-03-01', '2026-03-31', now(), null);
`);

const line = (st, label) => st.lines.find((l) => l.label === label);
const value = (st, label, i = 0) => line(st, label)?.values?.[i];

await test('Profit & Loss: sections, subtotals and net income for one period', async () => {
  const rows = await engine(Books.activitySql({ companyId: CO, from: '2026-01-01', to: '2026-01-31', byMonth: false, types: Books.PL_TYPES }));
  const st = Books.profitAndLoss(rows, null);
  assert.deepEqual(plain(st.columns), ['total']);
  assert.equal(value(st, 'Sales'), 300);
  assert.equal(value(st, 'Total Income'), 300);
  assert.equal(value(st, 'Total Cost of Goods Sold'), 100);
  assert.equal(value(st, 'Gross Profit'), 200);
  assert.equal(value(st, 'Rent'), 70);
  assert.equal(value(st, 'Net Operating Income'), 130);
  assert.equal(value(st, 'Interest'), 10);
  assert.equal(value(st, 'Penalties'), 5);
  assert.equal(value(st, 'Net Income'), 135);
  assert.equal(line(st, 'Checking'), undefined, 'a bank account is not on a P&L');
  assert.equal(line(st, 'Rent').accountId, '30');
});

await test('Profit & Loss by month: one column per month and a total', async () => {
  const months = Books.monthsBetween('2025-12-01', '2026-01-31');
  assert.deepEqual(plain(months), ['2025-12', '2026-01']);
  const rows = await engine(Books.activitySql({ companyId: CO, from: '2025-12-01', to: '2026-01-31', byMonth: true, types: Books.PL_TYPES }));
  const st = Books.profitAndLoss(rows, months);
  assert.deepEqual(plain(st.columns), ['2025-12', '2026-01', 'Total']);
  assert.deepEqual(plain(line(st, 'Rent').values), [200, 70, 270]);
  assert.deepEqual(plain(line(st, 'Net Income').values), [-200, 135, -65]);
});

const positionsAt = (to, startMonth = 1) => engine(Books.positionsSql({
  companyId: CO, to, fiscalStart: Books.fiscalYearStart(to, startMonth) }));

await test('Balance Sheet: opening position + activity, profit split by fiscal year, and it balances', async () => {
  const st = Books.balanceSheet(await positionsAt('2026-01-31'));
  assert.equal(value(st, 'Checking'), 1455);
  assert.equal(value(st, 'Total Assets'), 1455);
  assert.equal(value(st, 'Visa'), 20);
  assert.equal(value(st, 'Total Liabilities'), 20);
  assert.equal(value(st, 'Owner'), 1000);
  assert.equal(value(st, 'Earnings from earlier years'), 300);
  assert.equal(value(st, 'Net income this year'), 135);
  assert.equal(value(st, 'Total Equity'), 1435);
  assert.equal(value(st, 'Total Liabilities and Equity'), 1455);
  assert.equal(st.outOfBalance, 0);
});

await test('a fiscal year that starts mid-year moves profit between the two equity lines only', async () => {
  assert.equal(Books.fiscalYearStart('2026-01-31', 7), '2025-07-01');
  assert.equal(Books.fiscalYearStart('2026-07-01', 7), '2026-07-01');
  assert.equal(Books.fiscalYearStart('2026-01-31', 1), '2026-01-01');
  const st = Books.balanceSheet(await positionsAt('2026-01-31', 7));
  assert.equal(value(st, 'Earnings from earlier years'), 500);
  assert.equal(value(st, 'Net income this year'), -65);
  assert.equal(value(st, 'Total Equity'), 1435);
  assert.equal(st.outOfBalance, 0);
});

await test('a position before the books start is empty, not the opening balance', async () => {
  const rows = await positionsAt('2024-06-30');
  const st = Books.balanceSheet(rows);
  assert.equal(value(st, 'Total Assets'), 0);
  assert.equal(value(st, 'Total Liabilities and Equity'), 0);
});

await test('Trial Balance: every account on its side, debits equal credits', async () => {
  const st = Books.trialBalance(await positionsAt('2026-01-31'));
  assert.deepEqual(plain(line(st, 'Checking').values), [1455, 0]);
  assert.deepEqual(plain(line(st, 'Sales').values), [0, 300]);
  assert.deepEqual(plain(line(st, 'Rent').values), [70, 0]);
  assert.deepEqual(plain(line(st, 'Owner').values), [0, 1000]);
  assert.deepEqual(plain(line(st, 'Earnings from earlier years').values), [0, 300]);
  assert.deepEqual(plain(line(st, 'Total').values), [1630, 1630]);
  assert.equal(st.outOfBalance, 0);
});

await test('General Ledger: activity by account for the period, and the lines behind one', async () => {
  const st = Books.accountActivity(await engine(Books.activitySql({ companyId: CO, from: '2026-01-01', to: '2026-01-31', byMonth: false, types: null })));
  assert.deepEqual(plain(line(st, 'Checking').values), [155, 0]);
  assert.deepEqual(plain(line(st, 'Visa').values), [0, 20]);
  assert.deepEqual(plain(line(st, 'Total').values), [330, 330]);
  const lines = await engine(Books.accountLinesSql({ companyId: CO, account: '30', from: '2026-01-01', to: '2026-01-31' }));
  assert.deepEqual(lines.map((l) => [l.document_number, Number(l.signed_amount), l.source]),
    [['SILO-2', 50, 'quickbooks_edited'], ['E1', 20, 'silo']]);
  assert.equal(Books.SOURCE_LABEL.quickbooks_edited, 'Edited in QuickBooks');
  assert.equal(Books.SOURCE_LABEL.quickbooks, 'QuickBooks');
  assert.equal(Books.SOURCE_LABEL.silo, undefined, "SILO's own lines carry no label");
  assert.equal(Books.SOURCE_LABEL.history, undefined);
});

await test('lines with no known side are counted so a statement can say it left them out', async () => {
  // A position counts every such line through the date...
  const rows = await engine(Books.unplacedSql({ companyId: CO, to: '2026-01-31' }));
  assert.equal(Number(rows[0].line_count), 2);
  // ...a period statement only the ones inside the period.
  const count = async (from, to) => Number((await engine(Books.unplacedSql({ companyId: CO, from, to })))[0].line_count);
  assert.equal(await count('2026-01-01', '2026-01-31'), 1);
  assert.equal(await count('2025-01-01', '2025-12-31'), 1);
  assert.equal(await count('2026-02-01', '2026-02-28'), 0);
  assert.throws(() => Books.unplacedSql({ companyId: CO, from: 'x', to: '2026-01-31' }), /valid date/);
});

await test('how far QuickBooks has been read back, for this company only', async () => {
  const rows = await engine(Books.freshnessSql({ companyId: CO }));
  assert.equal(String(rows[0].read_through instanceof Date ? rows[0].read_through.toISOString().slice(0, 10) : rows[0].read_through), '2026-01-31');
  assert.equal(Number(rows[0].months_with_a_problem), 0);
});

await test('a value that is not a date, a company or an account is refused before any SQL exists', async () => {
  const good = { companyId: CO, from: '2026-01-01', to: '2026-01-31', byMonth: false, types: null };
  assert.throws(() => Books.activitySql({ ...good, to: "2026-01-31' or true --" }), /valid date/);
  assert.throws(() => Books.activitySql({ ...good, from: '2026-02-30' }), /valid date/);
  assert.throws(() => Books.activitySql({ ...good, companyId: `${CO}' or true --` }), /company id/);
  assert.throws(() => Books.positionsSql({ companyId: CO, to: '2026-01-31', fiscalStart: 'x' }), /valid date/);
  assert.throws(() => Books.accountLinesSql({ ...good, account: "30' or '1'='1" }), /account id/);
  assert.throws(() => Books.accountLinesSql({ ...good, account: '' }), /account id/);
});

// ── The read policy the statements run under (20261125160000) ─────────────
// The page reads the whole imported ledger, so the policy must ask who the
// reader is once per query. The rewrite must not change who reads what.
{
  let POLICY = readFileSync(
    new URL('../../supabase/migrations/20261125160000_history_read_policy_once_per_query.sql', import.meta.url), 'utf8');
  const POLICY_MUTATIONS = {
    // anyone in the company reads the imported ledger
    'policy-drops-finance-gate': [`        || 'and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())))', t);`, `        || ')', t);`],
    // a finance user reads every company's imported ledger
    'policy-drops-company': [`        || 'company_entity_id = (select public.active_company_id()) '\n        || 'and (`, `        || '(`],
    // the calls stay bare, so they run for every row
    'policy-not-hoisted': [`(select public.active_company_id())`, `public.active_company_id()`],
  };
  if (MUTATION && POLICY_MUTATIONS[MUTATION]) {
    const m = POLICY_MUTATIONS[MUTATION];
    if (POLICY.split(m[0]).length !== 2) throw new Error(`mutation ${MUTATION} no longer matches the migration`);
    POLICY = POLICY.replace(m[0], m[1]);
  }
  const pdb = new PGlite();
  await pdb.exec(`
    create role authenticated;
    create table who(company uuid, finance boolean, exec boolean, calls integer default 0);
    insert into who values ('${CO}', true, false, 0);
    grant select, update on who to authenticated;
    create function active_company_id() returns uuid language plpgsql stable as $$
      declare v uuid; begin select company into v from who; return v; end $$;
    create function can_manage_journal_entries() returns boolean language sql stable as $$ select finance from who $$;
    create function is_exec_or_owner() returns boolean language sql stable as $$ select exec from who $$;
    create table qbo_history_imports(id int, company_entity_id uuid);
    create table qbo_history_lines(id int, company_entity_id uuid);
    insert into qbo_history_imports values (1, '${CO}'), (2, '${CO2}');
    insert into qbo_history_lines select g, case when g % 2 = 0 then '${CO}'::uuid else '${CO2}'::uuid end from generate_series(1, 200) g;
  `);
  // The policy exactly as 20260913022606 created it.
  for (const t of ['qbo_history_imports', 'qbo_history_lines']) {
    await pdb.exec(`alter table ${t} enable row level security; grant select on ${t} to authenticated;
      create policy history_finance_read on ${t} for select to authenticated using
        (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()))`);
  }
  await pdb.exec(POLICY);
  await pdb.exec(POLICY);   // applied twice, as apply_all_post_merge.sql does
  const as = async (finance, exec, sql) => {
    await pdb.exec(`reset role; update who set finance = ${finance}, exec = ${exec}; set role authenticated`);
    const rows = (await pdb.query(sql)).rows;
    await pdb.exec('reset role');
    return rows;
  };
  await test('the imported-history policy still lets only a finance user of the company read', async () => {
    assert.equal(Number((await as(true, false, 'select count(*) n from qbo_history_lines'))[0].n), 100);
    assert.equal(Number((await as(false, true, 'select count(*) n from qbo_history_lines'))[0].n), 100);
    assert.equal(Number((await as(false, false, 'select count(*) n from qbo_history_lines'))[0].n), 0);
    assert.deepEqual((await as(true, false, 'select id from qbo_history_imports')).map((r) => r.id), [1]);
    assert.equal(Number((await as(false, false, 'select count(*) n from qbo_history_imports'))[0].n), 0);
    const pol = (await pdb.query(`select c.relname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) as q,
        (select string_agg(rolname, ',') from pg_roles r where r.oid = any(p.polroles)) as roles
      from pg_policy p join pg_class c on c.oid = p.polrelid where p.polname = 'history_finance_read'`)).rows;
    assert.equal(pol.length, 2);
    for (const p of pol) { assert.equal(p.polcmd, 'r'); assert.equal(p.roles, 'authenticated'); }
  });
  await test('the policy asks who the reader is once per query, not once per row', async () => {
    const plan = (await as(true, false, 'explain select count(*) from qbo_history_lines')).map((r) => r['QUERY PLAN']).join('\n');
    assert.equal((plan.match(/InitPlan/g) || []).length >= 2, true, plan);
    assert.doesNotMatch(plan, /Filter: \(\(company_entity_id = active_company_id\(\)\)/, plan);
  });
  await test("the production verify block reads ok after the migration and BROKEN on the old policy", async () => {
    const verifySql = readFileSync(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
    const start = verifySql.indexOf("select 'History read policy runs once per query' as check_name,");
    assert.ok(start >= 0, 'the verify block is missing');
    const block = verifySql.slice(start, verifySql.indexOf(';', start) + 1);
    assert.equal((await pdb.query(block)).rows[0].status, 'ok');
    await pdb.exec(`alter policy history_finance_read on qbo_history_lines using
      (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()))`);
    assert.match((await pdb.query(block)).rows[0].status, /^BROKEN/);
  });
  await test('the migration leaves its transaction to the applier', async () => {
    assert.doesNotMatch(POLICY.replace(/--[^\n]*/g, ''), /^\s*(begin|commit)\s*;/im);
  });
}

console.log(`\n${passed} passed`);
