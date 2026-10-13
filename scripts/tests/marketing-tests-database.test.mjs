// The marketing test record (20261013120000) against a REAL PostgreSQL
// (PGlite), as authenticated users -- not a mock, not the service role.
//
// What it proves:
//   1. Company scope: a member reads, adds and moves their own company's
//      tests and nothing else; created_by cannot be spoofed; delete is
//      creator-or-admin.
//   2. The design freezes when a test starts: once it has left `planned`,
//      hypothesis / element / control / variant / metric are refused, while
//      the window, the status and the result stay editable.
//   3. A concluded test must carry an outcome AND a non-empty result_summary,
//      and an outcome cannot be filed in any other status.
//   4. concluded_by / concluded_at are stamped by the database, never taken
//      from the client, and are cleared when a test is reopened.
//   5. The schedule link is company-scoped BY CONSTRUCTION: a channel item
//      cannot name another company's test, and deleting a test unlinks its
//      items instead of deleting them.
//   6. A started test needs a start date, and a window cannot end before it
//      begins.
//
// Run:  node scripts/tests/marketing-tests-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db
// Mutations (each must fail at least one assertion):
//   MARKETING_TESTS_MUTATION=design-thaws        (a started test's metric can be rewritten)
//   MARKETING_TESTS_MUTATION=freeze-reads-status (the freeze reads status, so planned thaws it)
//   MARKETING_TESTS_MUTATION=conclude-unanswered (concluded needs no outcome or learning)
//   MARKETING_TESTS_MUTATION=conclusion-from-client (concluded_by is taken from the client)
//   MARKETING_TESTS_MUTATION=link-any-company    (the schedule link drops its company scope)
//   MARKETING_TESTS_MUTATION=link-cascades       (deleting a test deletes its scheduled items)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = ['', 'design-thaws', 'freeze-reads-status', 'conclude-unanswered',
  'conclusion-from-client', 'link-any-company', 'link-cascades'];
const mutation = process.env.MARKETING_TESTS_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID(), otherCo = randomUUID();
const member = randomUUID(), admin = randomUUID(), outsider = randomUUID();
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
async function asUser(user, fn) {
  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  try { return await fn(); }
  finally { await db.exec('reset role'); await q("select set_config('request.jwt.claim.sub', '', false)"); }
}
async function refused(fn, pattern, what) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  assert.ok(msg !== null, `${what}: expected a refusal`);
  assert.match(msg, pattern, `${what}: ${msg}`);
}

// ── Foundation: the shared bootstrap (auth, profiles, companies, the Ask SILO
// catalog, launch_calendar) and the company-stamp trigger migration, then
// stand-ins for the two tables this migration only REFERENCES. ad_ideas and
// launch_channel_items both predate the migrations directory, so there is no
// migration file to load for either; launch_channel_items' stand-in carries
// the columns and the nullable, trigger-stamped company_entity_id production
// has, because the composite foreign key's MATCH SIMPLE behaviour depends on
// that nullability.
await db.exec(await readFile(new URL('./seo-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(await read('supabase/migrations/20260616060000_stamp_company_entity_id_on_insert.sql'));
await db.exec(`
  create table public.ad_ideas (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid not null references public.entities(id),
    title text, status text, updated_at timestamptz not null default now());
  alter table public.ad_ideas enable row level security;
  create policy ad_ideas_select on public.ad_ideas for select to authenticated
    using (company_entity_id = public.active_company_id());
  create table public.launch_channel_items (
    id uuid primary key default gen_random_uuid(),
    launch_id uuid references public.launch_calendar(id) on delete cascade,
    company_entity_id uuid references public.entities(id),
    channel text not null, item_title text, item_type text,
    scheduled_date date, scheduled_time time, time_zone text,
    status text, priority text, owner text, link_url text, notes text,
    copy_needed boolean, creative_needed boolean,
    created_by uuid, assigned_to uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint launch_channel_items_link_parent_key unique (id, launch_id, company_entity_id));
  alter table public.launch_channel_items enable row level security;
  create policy launch_channel_items_active_select on public.launch_channel_items
    for select to authenticated using (company_entity_id = public.active_company_id());
  create policy launch_channel_items_active_write on public.launch_channel_items
    for all to authenticated
    using (company_entity_id = public.active_company_id())
    with check (company_entity_id = public.active_company_id());
  grant select, insert, update, delete on public.launch_channel_items to authenticated;
  grant select on public.ad_ideas to authenticated;
`);

let sql = await read('supabase/migrations/20261013120000_marketing_tests.sql');
const swap = (from, to) => {
  assert.ok(sql.includes(from), `mutation anchor missing: ${from.slice(0, 70)}`);
  sql = sql.replace(from, to);
};
if (mutation === 'design-thaws') {
  swap('    if old.started_at is not null then', '    if false then');
} else if (mutation === 'freeze-reads-status') {
  // The first version of this guard read the CURRENT status, which a round
  // trip through `planned` thaws.
  swap('    if old.started_at is not null then', "    if old.status <> 'planned' then");
} else if (mutation === 'conclude-unanswered') {
  swap(`  constraint marketing_tests_concluded_is_answered
    check (status <> 'concluded'
           or (outcome is not null and length(btrim(coalesce(result_summary, ''))) > 0)),`,
    'constraint marketing_tests_concluded_is_answered check (true),');
} else if (mutation === 'conclusion-from-client') {
  swap(`  if new.status = 'concluded' and (tg_op = 'INSERT' or old.status is distinct from 'concluded') then
    new.concluded_by := auth.uid();
    new.concluded_at := now();
  elsif new.status <> 'concluded' then
    new.concluded_by := null;
    new.concluded_at := null;
  else
    new.concluded_by := old.concluded_by;
    new.concluded_at := old.concluded_at;
  end if;`, '');
} else if (mutation === 'link-any-company') {
  swap(`      foreign key (marketing_test_id, company_entity_id)
      references public.marketing_tests (id, company_entity_id)
      on delete set null (marketing_test_id);`,
    `      foreign key (marketing_test_id)
      references public.marketing_tests (id)
      on delete set null;`);
} else if (mutation === 'link-cascades') {
  swap(`      foreign key (marketing_test_id, company_entity_id)
      references public.marketing_tests (id, company_entity_id)
      on delete set null (marketing_test_id);`,
    `      foreign key (marketing_test_id, company_entity_id)
      references public.marketing_tests (id, company_entity_id)
      on delete cascade;`);
}
// Applied TWICE: it runs against production by hand, and a migration nobody
// can safely re-run after a partial failure is one nobody will re-run.
await db.exec(sql); await db.exec(sql);

// ── Fixtures ────────────────────────────────────────────────────────────────
await q("insert into entities(id,title) values ($1,'Co'),($2,'Other')", [co, otherCo]);
await q('insert into auth.users(id) values ($1),($2),($3)', [member, admin, outsider]);
await q(`insert into profiles(id,name,role,active_company_id) values
  ($1,'Member','user',$4),($2,'Admin','admin',$4),($3,'Outsider','user',$5)`,
  [member, admin, outsider, co, otherCo]);
await q(`insert into entity_memberships(entity_id,user_id,role) values
  ($1,$2,'member'),($1,$3,'admin'),($4,$5,'member')`, [co, member, admin, otherCo, outsider]);

const newTest = (over = {}) => ({
  company_entity_id: co,
  title: 'Hook test',
  channel: 'meta',
  element: 'creative',
  hypothesis: 'A player in the first three seconds lowers cost per purchase.',
  control: 'current best',
  variant: 'founder story',
  metric: 'cpa',
  status: 'planned',
  ...over,
});
async function insertAs(user, row) {
  const cols = Object.keys(row);
  const vals = cols.map((_, i) => `$${i + 1}`).join(',');
  return asUser(user, () => one(
    `insert into marketing_tests (${cols.join(',')}) values (${vals}) returning *`,
    cols.map((c) => row[c])));
}

// ── 1. Company scope, authorship, delete ───────────────────────────────────
let planned;
await test('a member adds a test to their own company and reads it back', async () => {
  planned = await insertAs(member, newTest());
  assert.equal(planned.company_entity_id, co);
  assert.equal(planned.created_by, member, 'created_by defaults to the caller');
  assert.equal(planned.status, 'planned');
  const seen = await asUser(member, () => q('select id from marketing_tests'));
  assert.equal(seen.length, 1);
});

await test('another company sees nothing, and cannot insert into this one', async () => {
  const seen = await asUser(outsider, () => q('select id from marketing_tests'));
  assert.equal(seen.length, 0, 'the outsider reads none of this company\'s tests');
  await refused(() => insertAs(outsider, newTest()), /row-level security/i,
    'an outsider inserting into another company');
});

await test('created_by cannot be spoofed, and a test cannot move company', async () => {
  await refused(() => insertAs(member, newTest({ created_by: admin })), /row-level security/i,
    'inserting a test as somebody else');
  await refused(() => asUser(member, () => q(
    'update marketing_tests set company_entity_id = $1 where id = $2', [otherCo, planned.id])),
    /cannot move to another company|row-level security/i, 'moving a test to another company');
  await refused(() => asUser(member, () => q(
    'update marketing_tests set created_by = $1 where id = $2', [admin, planned.id])),
    /created_by \/ created_at are fixed/, 'rewriting created_by');
});

// ── 2. The design freezes when the test starts ─────────────────────────────
await test('a planned test is still fully editable', async () => {
  await asUser(member, () => q(
    `update marketing_tests set hypothesis = $1, metric = 'roas', control = 'v1' where id = $2`,
    ['A different expectation entirely.', planned.id]));
  const row = await one('select hypothesis, metric from marketing_tests where id = $1', [planned.id]);
  assert.equal(row.metric, 'roas');
  assert.match(row.hypothesis, /different expectation/);
});

let running;
await test('once a test starts, hypothesis / element / control / variant / metric are frozen', async () => {
  running = await insertAs(member, newTest({
    title: 'Send time test', channel: 'email', element: 'send_time',
    metric: 'open_rate', status: 'running', starts_on: '2026-10-01',
  }));
  for (const [col, val] of [['hypothesis', 'rewritten after the fact'], ['metric', 'click_rate'],
    ['element', 'copy'], ['control', 'other'], ['variant', 'another']]) {
    await refused(() => asUser(member, () => q(
      `update marketing_tests set ${col} = $1 where id = $2`, [val, running.id])),
      /the design \(hypothesis, element, control, variant, metric\) is frozen/,
      `editing ${col} on a running test`);
  }
});

await test('a running test keeps its window, status, notes and reads editable', async () => {
  await asUser(member, () => q(
    `update marketing_tests set ends_on = '2026-10-21', status = 'reading',
       control_value = 41.2, variant_value = null, notes = 'extended a week'
     where id = $1`, [running.id]));
  const row = await one('select * from marketing_tests where id = $1', [running.id]);
  assert.equal(row.status, 'reading');
  // PGlite hands back a Date for a date column; compare on the calendar day.
  assert.equal(new Date(row.ends_on).toISOString().slice(0, 10), '2026-10-21');
  assert.equal(Number(row.control_value), 41.2);
  assert.equal(row.variant_value, null, 'an unmeasured read stays NULL, never 0');
});

await test('a round trip through `planned` does not thaw a started test', async () => {
  // The two-click bypass the first version of the guard allowed: back to
  // planned, rewrite the measure, forward again. started_at is what closes it.
  const row = await one('select started_at from marketing_tests where id = $1', [running.id]);
  assert.ok(row.started_at, 'started_at was stamped when the test began');
  await asUser(member, () => q(`update marketing_tests set status = 'planned' where id = $1`, [running.id]));
  await refused(() => asUser(member, () => q(
    `update marketing_tests set metric = 'click_rate' where id = $1`, [running.id])),
    /the design \(hypothesis, element, control, variant, metric\) is frozen/,
    'rewriting the metric after a trip through planned');
  const back = await one('select started_at from marketing_tests where id = $1', [running.id]);
  assert.equal(String(back.started_at), String(row.started_at), 'started_at was not cleared');
  await asUser(member, () => q(`update marketing_tests set status = 'reading' where id = $1`, [running.id]));
});

await test('a plan abandoned without running keeps its design editable', async () => {
  // Nothing was measured, so there is no result its design could be fitted to.
  const plan = await insertAs(member, newTest({ title: 'Never ran' }));
  await asUser(member, () => q(`update marketing_tests set status = 'abandoned' where id = $1`, [plan.id]));
  const row = await one('select started_at from marketing_tests where id = $1', [plan.id]);
  assert.equal(row.started_at, null, 'an abandoned plan was never stamped as started');
  await asUser(member, () => q(
    `update marketing_tests set metric = 'ctr', hypothesis = 'Rethought entirely.' where id = $1`, [plan.id]));
  assert.equal((await one('select metric from marketing_tests where id = $1', [plan.id])).metric, 'ctr');
});

await test('started_at cannot be supplied by the client', async () => {
  const t = await insertAs(member, newTest({ title: 'Client stamp', started_at: '2001-01-01' }));
  assert.equal(t.started_at, null, 'a planned test is not started, whatever the client sent');
  await asUser(member, () => q(
    `update marketing_tests set status = 'running', starts_on = '2026-10-01',
       started_at = '2001-01-01' where id = $1`, [t.id]));
  const row = await one('select started_at from marketing_tests where id = $1', [t.id]);
  assert.ok(new Date(row.started_at).getUTCFullYear() >= 2026, 'the stamp is now(), not the supplied date');
});

// ── 3. Concluding requires an answer ───────────────────────────────────────
await test('a test cannot conclude without an outcome and a learning', async () => {
  await refused(() => asUser(member, () => q(
    `update marketing_tests set status = 'concluded' where id = $1`, [running.id])),
    /marketing_tests_concluded_is_answered/, 'concluding with nothing recorded');
  await refused(() => asUser(member, () => q(
    `update marketing_tests set status = 'concluded', outcome = 'win' where id = $1`, [running.id])),
    /marketing_tests_concluded_is_answered/, 'concluding with an outcome but no learning');
  await refused(() => asUser(member, () => q(
    `update marketing_tests set status = 'concluded', outcome = 'win', result_summary = '   '
     where id = $1`, [running.id])),
    /marketing_tests_concluded_is_answered/, 'concluding with whitespace as the learning');
});

await test('an outcome cannot be filed on a test that has not concluded', async () => {
  await refused(() => asUser(member, () => q(
    `update marketing_tests set outcome = 'win' where id = $1`, [running.id])),
    /marketing_tests_outcome_only_when_concluded/, 'an outcome on a reading test');
});

// ── 4. The conclusion is stamped by the database ───────────────────────────
await test('concluded_by / concluded_at are stamped, not supplied', async () => {
  await asUser(member, () => q(
    `update marketing_tests set status = 'concluded', outcome = 'win',
       result_summary = 'The 9am send won on open rate; keeping it.',
       concluded_by = $1, concluded_at = '2001-01-01'
     where id = $2`, [outsider, running.id]));
  const row = await one('select * from marketing_tests where id = $1', [running.id]);
  assert.equal(row.concluded_by, member, 'the caller is recorded, not the supplied id');
  assert.ok(new Date(row.concluded_at).getUTCFullYear() >= 2026, 'the stamp is now(), not the supplied date');
});

await test('reopening a concluded test clears its conclusion', async () => {
  await asUser(member, () => q(
    `update marketing_tests set status = 'reading', outcome = null where id = $1`, [running.id]));
  const row = await one('select * from marketing_tests where id = $1', [running.id]);
  assert.equal(row.concluded_by, null);
  assert.equal(row.concluded_at, null);
});

// ── 5. The schedule link ───────────────────────────────────────────────────
let item;
await test('a scheduled item can name a test in its own company', async () => {
  item = await asUser(member, () => one(
    `insert into launch_channel_items (company_entity_id, channel, item_title, marketing_test_id)
     values ($1,'email','9am send',$2) returning *`, [co, running.id]));
  assert.equal(item.marketing_test_id, running.id);
});

await test('a scheduled item cannot name another company\'s test', async () => {
  const far = await insertAs(outsider, newTest({ company_entity_id: otherCo, title: 'Theirs' }));
  await refused(() => asUser(member, () => q(
    `insert into launch_channel_items (company_entity_id, channel, item_title, marketing_test_id)
     values ($1,'email','borrowed',$2)`, [co, far.id])),
    /launch_channel_items_marketing_test_fkey|violates foreign key/i,
    'linking across companies');
  // And it cannot be reached by an update either.
  await refused(() => asUser(member, () => q(
    'update launch_channel_items set marketing_test_id = $1 where id = $2', [far.id, item.id])),
    /launch_channel_items_marketing_test_fkey|violates foreign key/i,
    'moving a link across companies');
});

await test('deleting a test unlinks its scheduled items and keeps them', async () => {
  await asUser(admin, () => q('delete from marketing_tests where id = $1', [running.id]));
  const row = await one('select * from launch_channel_items where id = $1', [item.id]);
  assert.ok(row, 'the scheduled item survived its test');
  assert.equal(row.marketing_test_id, null, 'and was unlinked');
  assert.equal(row.item_title, '9am send');
});

await test('delete is creator-or-admin', async () => {
  const mine = await insertAs(member, newTest({ title: 'Mine to delete' }));
  // The admin may delete someone else's.
  const byAdmin = await insertAs(member, newTest({ title: 'Admin deletes this' }));
  await asUser(admin, () => q('delete from marketing_tests where id = $1', [byAdmin.id]));
  assert.equal((await q('select 1 from marketing_tests where id = $1', [byAdmin.id])).length, 0);
  // The outsider cannot, and an RLS-refused delete removes nothing rather
  // than raising.
  await asUser(outsider, () => q('delete from marketing_tests where id = $1', [mine.id]));
  assert.equal((await q('select 1 from marketing_tests where id = $1', [mine.id])).length, 1,
    'an outsider\'s delete removed nothing');
  await asUser(member, () => q('delete from marketing_tests where id = $1', [mine.id]));
  assert.equal((await q('select 1 from marketing_tests where id = $1', [mine.id])).length, 0);
});

// ── 6. The window, and a started test's start date ─────────────────────────
await test('a window cannot end before it starts, and a started test has a start date', async () => {
  await refused(() => insertAs(member, newTest({ starts_on: '2026-10-10', ends_on: '2026-10-01' })),
    /marketing_tests_window_ordered/, 'an inverted window');
  await refused(() => insertAs(member, newTest({ status: 'running' })),
    /marketing_tests_started_has_start_date/, 'a running test with no start date');
  // A plan, and an abandoned plan, may have no dates at all.
  const plan = await insertAs(member, newTest({ title: 'Someday', status: 'planned' }));
  await asUser(member, () => q(`update marketing_tests set status = 'abandoned' where id = $1`, [plan.id]));
  assert.equal((await one('select status from marketing_tests where id = $1', [plan.id])).status, 'abandoned');
});

await test('anon reaches nothing', async () => {
  await db.exec('set role anon');
  try {
    await refused(() => q('select 1 from marketing_tests'), /permission denied/i, 'anon selecting tests');
  } finally { await db.exec('reset role'); }
});

console.log(`\n${passed} passed`);
