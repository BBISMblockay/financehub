// Work-queue SILO reports (20261030060000, + On Deck in Open work 20261030080000), executed in a real PostgreSQL
// (PGlite): the deployed SQL from the migration over fixtures whose answers
// are known. Covers what each row says (open vs done, overdue, blank when
// there is no due date), whose work is "mine", the deep links, and every
// tie-out the migration writes, including that each one fails when its
// report loses or duplicates rows.
//
// Which rows a person may see is NOT tested here: the reports read RLS
// tables and security_invoker views, and that boundary is production's own
// (measured through the API's runner in the migration header).
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/work-queue-reports-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const num = (v) => (v === null || v === undefined ? null : Number(v));

const CO = '00000000-0000-4000-a000-000000000001';
const OTHER = '00000000-0000-4000-a000-000000000002';
const ME = '00000000-0000-4000-b000-000000000001';
const YOU = '00000000-0000-4000-b000-000000000002';
const OPEN_WORK = 'c7000000-0000-4000-a000-000000000001';
const LAUNCHES = 'c7000000-0000-4000-a000-000000000002';
const CLOSE = 'c7000000-0000-4000-a000-000000000003';

// today = 2026-10-29. Every table carries a second company's rows behind a
// company-only RLS policy, and every query runs as a non-owner role so the
// policy applies.
await db.exec(`
create schema auth;
create function auth.uid() returns uuid language sql as $$ select current_setting('test.uid')::uuid $$;
create function active_company_id() returns uuid language sql as $$ select '${CO}'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
set test.today = '2026-10-29';
set test.uid = '${ME}';
create table silo_chat_saved_reports(id uuid primary key, company_entity_id uuid, created_by uuid, source text, visibility text,
  title text, description text, question text, answer text, queries_run text[], parameters jsonb default '[]',
  columns_metadata jsonb, archived_at timestamptz, updated_at timestamptz);
create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text, check_sql text,
  tolerance numeric, enabled boolean default true, note text, unique(report_id, name));
create table profiles(id uuid primary key, name text, email text);
insert into profiles values ('${ME}', 'Pat Lee', 'Pat@Example.com'), ('${YOU}', 'Sam Roe', 'sam@example.com');

create table launch_calendar(id uuid primary key default gen_random_uuid(), company_entity_id uuid, title text,
  launch_date date, launch_end_date date, launch_type text, status text, launch_readiness text, designer text,
  po_number text, expected_units integer);
create table launch_tasks(id uuid primary key default gen_random_uuid(), company_entity_id uuid, launch_id uuid,
  task_title text, status text, priority text, due_date date, assigned_to_user_id uuid, assigned_to_name text);
create table launch_channel_items(id uuid primary key default gen_random_uuid(), company_entity_id uuid, launch_id uuid,
  channel text, item_title text, status text, priority text, scheduled_date date, owner text);
create table payment_requests(id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  effective_vendor_name text, amount_due numeric, request_type text, workflow_status text, priority text,
  due_date date, requester_email text, assigned_to uuid, assigned_to_name text, created_by uuid, completed boolean);
-- The real view is security_invoker over the table; here it only has to
-- expose the same columns for this company.
create view payment_requests_v as select * from payment_requests where company_entity_id = active_company_id();
create table card_transactions(id uuid primary key default gen_random_uuid(), company_entity_id uuid, batch_id uuid,
  txn_date date, status text);
create view card_import_batches_v as
  select batch_id as id, company_entity_id, count(*) filter (where status = 'uncoded') as uncoded_count
    from card_transactions group by 1, 2;
create table journal_adjustments(id uuid primary key default gen_random_uuid(), company_entity_id uuid, entry_date date, status text);
create view journal_adjustments_v as select * from journal_adjustments where company_entity_id = active_company_id();
create table on_deck_proposals(id uuid primary key default gen_random_uuid(), company_entity_id uuid, kind text, title text, status text);
-- Production's only policy: active company AND on_deck_can_review().
set test.reviewer = 'true';
create function on_deck_can_review() returns boolean language sql stable as $$ select current_setting('test.reviewer')::boolean $$;
alter table on_deck_proposals enable row level security;
create policy on_deck_read on on_deck_proposals for select using (company_entity_id = active_company_id() and on_deck_can_review());
insert into on_deck_proposals(company_entity_id, kind, title, status) values
  ('${CO}', 'seo', 'Fix hat page title', 'ready'),
  ('${CO}', 'ads', 'Refresh winter ad', 'needs_info'),
  ('${CO}', 'launch', 'Turkey cap brief', 'failed'),
  ('${CO}', 'ads', 'Screened only', 'screened'),
  ('${CO}', 'seo', 'Still drafting', 'preparing'),
  ('${CO}', 'seo', 'Being revised', 'revision'),
  ('${CO}', 'restock', 'Done one', 'completed'),
  ('${CO}', 'ads', 'Dismissed one', 'dismissed'),
  ('${OTHER}', 'seo', 'Other company draft', 'ready');

insert into launch_calendar(id, company_entity_id, title, launch_date, launch_end_date, status, launch_readiness) values
  ('10000000-0000-4000-a000-000000000001', '${CO}', 'Today launch', '2026-10-29', null, 'planned', 'not_reviewed'),
  ('10000000-0000-4000-a000-000000000002', '${CO}', 'In 30 days', '2026-11-28', null, 'planned', 'ready'),
  ('10000000-0000-4000-a000-000000000003', '${CO}', 'In 31 days', '2026-11-29', null, 'planned', 'ready'),
  ('10000000-0000-4000-a000-000000000004', '${CO}', 'Yesterday', '2026-10-28', null, 'planned', 'ready'),
  ('10000000-0000-4000-a000-000000000005', '${CO}', 'Still running', '2026-10-20', '2026-11-02', 'planned', 'ready'),
  ('10000000-0000-4000-a000-000000000006', '${OTHER}', 'Other company', '2026-10-30', null, 'planned', 'ready');

insert into launch_tasks(company_entity_id, launch_id, task_title, status, due_date, assigned_to_user_id, assigned_to_name) values
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'Mine overdue', 'open', '2026-10-20', '${ME}', 'Pat Lee'),
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'Yours future', 'open', '2026-11-05', '${YOU}', 'Sam Roe'),
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'Finished', 'done', '2026-10-01', '${ME}', 'Pat Lee'),
  ('${CO}', null, 'Evergreen no date', 'open', null, null, null),
  ('${OTHER}', '10000000-0000-4000-a000-000000000006', 'Other company task', 'open', '2026-10-01', '${ME}', 'Pat Lee');

insert into launch_channel_items(company_entity_id, launch_id, channel, item_title, status, scheduled_date, owner) values
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'Email', 'Teaser', 'planned', '2026-10-27', ' pat lee '),
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'SMS', null, 'blocked', '2026-11-01', 'pat'),
  ('${CO}', '10000000-0000-4000-a000-000000000001', 'IG', 'Post', 'live', '2026-10-29', 'pat@example.com'),
  -- Schedule saves an initiative with no launch as launch_id NULL.
  ('${CO}', null, 'Email', 'Standalone send', 'scheduled', '2026-10-28', 'Sam Roe'),
  ('${OTHER}', '10000000-0000-4000-a000-000000000006', 'Email', 'X', 'planned', '2026-10-30', 'Pat Lee');

insert into payment_requests(company_entity_id, effective_vendor_name, amount_due, request_type, workflow_status,
  due_date, requester_email, assigned_to, assigned_to_name, created_by, completed) values
  ('${CO}', 'Acme', 1234.5, 'invoice', 'new', '2026-10-25', 'sam@example.com', '${ME}', 'Pat Lee', '${YOU}', false),
  ('${CO}', 'Globex', null, null, 'needs_info', null, 'pat@example.com', '${YOU}', 'Sam Roe', '${ME}', false),
  ('${CO}', 'Initech', 10, 'invoice', 'new', '2026-11-30', 'pat@example.com', null, null, '${ME}', false),
  ('${CO}', 'Paid Co', 10, 'invoice', 'paid', '2026-10-01', 'pat@example.com', '${ME}', 'Pat Lee', '${ME}', true),
  ('${OTHER}', 'Elsewhere', 10, 'invoice', 'new', '2026-10-01', 'x@example.com', '${ME}', 'Pat Lee', '${ME}', false);

insert into card_transactions(company_entity_id, batch_id, txn_date, status) values
  ('${CO}', '20000000-0000-4000-a000-000000000001', '2026-10-03', 'uncoded'),
  ('${CO}', '20000000-0000-4000-a000-000000000001', '2026-10-10', 'uncoded'),
  ('${CO}', '20000000-0000-4000-a000-000000000001', '2026-09-01', 'coded'),
  ('${OTHER}', '20000000-0000-4000-a000-000000000002', '2026-01-01', 'uncoded');
-- Production's SELECT policy on each of these is (at least) company_entity_id
-- = active_company_id(); reproduce that part so the reader sees one company.
do $do$ declare t text; begin
  foreach t in array array['card_transactions','launch_calendar','launch_tasks','launch_channel_items','payment_requests','journal_adjustments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (company_entity_id = active_company_id())', t || '_select', t);
  end loop;
end $do$;
create role reader;
grant usage on schema auth to reader;
grant select on all tables in schema public to reader;
grant execute on all functions in schema public to reader;
grant execute on all functions in schema auth to reader;

insert into journal_adjustments(company_entity_id, entry_date, status) values
  ('${CO}', '2026-10-15', 'draft'), ('${CO}', '2026-10-05', 'approved'), ('${CO}', '2026-09-30', 'posted'),
  ('${OTHER}', '2026-01-01', 'draft');
`);

const MIGRATIONS = ['20261030060000_work_queue_reports.sql', '20261030080000_open_work_on_deck.sql'];
const migrate = async () => { for (const m of MIGRATIONS) await db.exec(readFileSync(`supabase/migrations/${m}`, 'utf8')); };
await migrate();
const sqlOf = async (id) => (await q(`select queries_run[1] as s from silo_chat_saved_reports where id = '${id}'`))[0].s;
const asReader = async (sql) => {
  await db.exec('set role reader');
  try { return await q(sql); } finally { await db.exec('reset role'); }
};

await test('three system reports, no parameters, no SQL a read-only runner would refuse', async () => {
  const rows = await q(`select id, source, company_entity_id, parameters, queries_run from silo_chat_saved_reports order by id`);
  assert.deepEqual(rows.map((r) => r.id), [OPEN_WORK, LAUNCHES, CLOSE]);
  for (const r of rows) {
    assert.equal(r.source, 'system');
    assert.equal(r.company_entity_id, null);
    assert.deepEqual(r.parameters, []);
    assert.equal(r.queries_run.length, 1);
    // chat_run_readonly_query refuses any semicolon and anything not SELECT/WITH.
    assert.ok(!r.queries_run[0].includes(';'));
    assert.match(r.queries_run[0].trim(), /^(select|with)\s/i);
  }
});

const work = await asReader(await sqlOf(OPEN_WORK));

await test('Open work lists open items only, for this company only', async () => {
  const items = work.map((r) => `${r.work_type}:${r.item}`).sort();
  assert.deepEqual(items, [
    'Initiative:SMS (SMS)',
    'Initiative:Standalone send (Email)',
    'Initiative:Teaser (Email)',
    'On Deck:Ads: Refresh winter ad',
    'On Deck:Launch: Turkey cap brief',
    'On Deck:SEO: Fix hat page title',
    'Payment request:Acme · $1,234.50 · invoice',
    'Payment request:Globex',
    'Payment request:Initech · $10.00 · invoice',
    'Task:Evergreen no date',
    'Task:Mine overdue',
    'Task:Yours future',
  ]);
});

await test('is_mine: assigned to me, my own request that needs my info, my full name or email on an initiative', async () => {
  const mine = work.filter((r) => r.is_mine).map((r) => r.item).sort();
  assert.deepEqual(mine, ['Acme · $1,234.50 · invoice', 'Globex', 'Mine overdue', 'Teaser (Email)']);
  // "pat" alone is a first name, not a match.
  assert.equal(work.find((r) => r.item === 'SMS (SMS)').is_mine, false);
});

await test('a request that needs info is waiting on its requester, not its assignee', async () => {
  assert.equal(work.find((r) => r.item === 'Globex').assigned_to, 'Requester: pat@example.com');
  assert.equal(work.find((r) => r.item === 'Initech · $10.00 · invoice').assigned_to, 'Unassigned');
});

await test('days overdue: counted past due, 0 when not yet due, blank when there is no due date', async () => {
  const by = Object.fromEntries(work.map((r) => [r.item, num(r.days_overdue)]));
  assert.equal(by['Mine overdue'], 9);
  assert.equal(by['Yours future'], 0);
  assert.equal(by['Evergreen no date'], null);
  assert.equal(by['Globex'], null);
});

await test('mine first, then overdue, then by due date', async () => {
  assert.deepEqual(work.slice(0, 4).map((r) => r.item),
    ['Mine overdue', 'Acme · $1,234.50 · invoice', 'Teaser (Email)', 'Globex']);
});

await test('every row links to the exact place in SILO', async () => {
  const task = work.find((r) => r.item === 'Mine overdue');
  assert.match(task.open_in_silo, /^https:\/\/get-silo\.com\/v2\/tasks\.html\?task=[0-9a-f-]{36}$/);
  assert.match(work.find((r) => r.item === 'Globex').open_in_silo, /^https:\/\/get-silo\.com\/v2\/request_manager\.html\?request=[0-9a-f-]{36}$/);
  assert.equal(work.find((r) => r.item === 'Teaser (Email)').open_in_silo,
    'https://get-silo.com/v2/launch-calendar.html?launch=10000000-0000-4000-a000-000000000001');
  const standalone = work.find((r) => r.item === 'Standalone send (Email)');
  assert.equal(standalone.open_in_silo, 'https://get-silo.com/v2/marketing-ops.html');
  assert.equal(standalone.launch, null);
  assert.equal(num(standalone.days_overdue), 1);
});

await test('On Deck: ready, needs info and failed drafts only, waiting on reviewers, linked to the draft', async () => {
  const od = work.filter((r) => r.work_type === 'On Deck');
  assert.deepEqual(od.map((r) => r.status).sort(), ['failed', 'needs_info', 'ready']);
  for (const r of od) {
    assert.equal(r.assigned_to, 'On Deck reviewers');
    assert.equal(r.is_mine, false);
    assert.equal(r.due_date, null);
    assert.equal(r.days_overdue, null);
    assert.match(r.open_in_silo, /^https:\/\/get-silo\.com\/v2\/on-deck\.html\?proposal=[0-9a-f-]{36}$/);
  }
});

await test('someone who cannot review On Deck sees no On Deck rows, and the rest unchanged', async () => {
  await db.exec(`set test.reviewer = 'false'`);
  const rows = await asReader(await sqlOf(OPEN_WORK));
  await db.exec(`set test.reviewer = 'true'`);
  assert.equal(rows.filter((r) => r.work_type === 'On Deck').length, 0);
  assert.equal(rows.length, work.length - 3);
});

await test('Launches next 30 days: today through day 30, plus a launch still running', async () => {
  const rows = await asReader(await sqlOf(LAUNCHES));
  assert.deepEqual(rows.map((r) => r.launch), ['Still running', 'Today launch', 'In 30 days']);
  const today = rows.find((r) => r.launch === 'Today launch');
  assert.equal(num(today.days_until_launch), 0);
  assert.equal(num(today.open_tasks), 2);
  assert.equal(num(today.overdue_tasks), 1);
  assert.equal(num(today.open_initiatives), 2);
  assert.equal(num(today.blocked_initiatives), 1);
  assert.equal(num(rows.find((r) => r.launch === 'In 30 days').open_tasks), 0);
});

await test('Accounting close status: counts, oldest date and age; an empty queue has no oldest date', async () => {
  await db.exec(`update journal_adjustments set status = 'posted' where status = 'approved'`);
  const rows = await asReader(await sqlOf(CLOSE));
  await db.exec(`update journal_adjustments set status = 'approved' where entry_date = '2026-10-05'`);
  const by = Object.fromEntries(rows.map((r) => [r.item, r]));
  assert.deepEqual(rows.map((r) => r.item), ['Bank transactions to categorize',
    'Journal entries waiting for approval', 'Journal entries approved, not yet posted']);
  assert.equal(num(by['Bank transactions to categorize'].open_count), 2);
  assert.equal(by['Bank transactions to categorize'].oldest_date.toISOString().slice(0, 10), '2026-10-03');
  assert.equal(num(by['Bank transactions to categorize'].oldest_age_days), 26);
  assert.equal(num(by['Journal entries waiting for approval'].open_count), 1);
  assert.equal(num(by['Journal entries approved, not yet posted'].open_count), 0);
  assert.equal(by['Journal entries approved, not yet posted'].oldest_age_days, null);
});

const checks = await q(`select report_id, name, kind, check_sql, tolerance from silo_report_tieouts order by report_id, name`);
const runCheck = async (name) => (await asReader(checks.find((c) => c.name === name).check_sql))[0];

await test('every tie-out passes, and each report has a reconciliation', async () => {
  assert.equal(checks.length, 8);
  for (const id of [OPEN_WORK, LAUNCHES, CLOSE]) {
    assert.ok(checks.some((c) => c.report_id === id && c.kind === 'reconciliation'), id);
  }
  for (const c of checks) {
    const [r] = await asReader(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: NO DATA`);
    assert.ok(Math.abs(num(r.left_value) - num(r.right_value)) <= num(c.tolerance), `${c.name}: ${r.left_value} vs ${r.right_value}`);
    assert.ok(num(r.right_value) > 0, `${c.name}: the fixture must give it something to count`);
  }
});

await test('an initiative the report drops fails its reconciliation', async () => {
  // Break the report, not the check: the inner join the first version used
  // silently lost every initiative with no launch.
  const c = checks.find((x) => x.name === 'Open initiatives tie to launch_channel_items');
  const broken = c.check_sql
    .replace('left join public.launch_calendar l on l.id = i.launch_id', 'join public.launch_calendar l on l.id = i.launch_id')
    .replace(/\(select md5\(queries_run::text \|\| parameters::text\) = '[0-9a-f]+' from public\.silo_chat_saved_reports where id = '[^']+'\)/, 'true');
  assert.notEqual(broken, c.check_sql);
  const [r] = await asReader(broken);
  assert.equal(num(r.right_value) - num(r.left_value), 1);
});

await test('an On Deck draft the report drops fails its reconciliation', async () => {
  const c = checks.find((x) => x.name === 'On Deck drafts tie to on_deck_proposals');
  const broken = c.check_sql
    .replace("p.status in ('ready', 'needs_info', 'failed')\n", "p.status in ('ready', 'needs_info')\n")
    .replace(/\(select md5\(queries_run::text \|\| parameters::text\) = '[0-9a-f]+' from public\.silo_chat_saved_reports where id = '[^']+'\)/, 'true');
  assert.notEqual(broken, c.check_sql);
  const [r] = await asReader(broken);
  assert.equal(num(r.right_value) - num(r.left_value), 1);
});

await test('a transaction outside every batch fails the bank reconciliation', async () => {
  await db.exec(`insert into card_transactions(company_entity_id, batch_id, txn_date, status) values ('${CO}', null, '2026-10-01', 'uncoded')`);
  // The fixture's batch view groups a null batch as its own row; production's
  // view is one row per real batch, so drop that row for this case.
  await db.exec(`create or replace view card_import_batches_v as
    select batch_id as id, company_entity_id, count(*) filter (where status = 'uncoded') as uncoded_count
      from card_transactions where batch_id is not null group by 1, 2`);
  const r = await runCheck('Uncategorized transactions tie to the batch counters');
  await db.exec(`delete from card_transactions where batch_id is null`);
  assert.equal(num(r.left_value) - num(r.right_value), 1);
});

await test('a launch window that drifts from the check fails it', async () => {
  // Break the report, not the check: re-run the shipped check against SQL
  // whose window is a day short, under the same md5 guard bypassed.
  const c = checks.find((x) => x.name === 'Open launch tasks tie to launch_tasks');
  const broken = c.check_sql.replace(/\+ 30\n/, '+ 29\n').replace(/\(select md5\(queries_run::text \|\| parameters::text\) = '[0-9a-f]+' from public\.silo_chat_saved_reports where id = '[^']+'\)/, 'true');
  await db.exec(`insert into launch_tasks(company_entity_id, launch_id, task_title, status) values ('${CO}', '10000000-0000-4000-a000-000000000002', 'Day 30 task', 'open')`);
  const [r] = await asReader(broken);
  await db.exec(`delete from launch_tasks where task_title = 'Day 30 task'`);
  assert.equal(num(r.right_value) - num(r.left_value), 1);
});

await test('a changed definition turns its tie-outs to NO DATA', async () => {
  await db.exec(`update silo_chat_saved_reports set queries_run = queries_run || array['select 2'] where id = '${OPEN_WORK}'`);
  const r = await runCheck('Open tasks tie to launch_tasks');
  assert.equal(r.left_value, null);
});

await test('the migration is idempotent', async () => {
  await migrate();
  assert.equal(num((await q(`select count(*) as n from silo_report_tieouts`))[0].n), 8);
  assert.match(await sqlOf(OPEN_WORK), /on_deck_proposals/);
  assert.equal(num((await q(`select count(*) as n from silo_chat_saved_reports`))[0].n), 3);
});

console.log(`\n${passed} passed`);
