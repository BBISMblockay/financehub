process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20261029190000_live_schedule_moderator_payout.sql against a real
// PostgreSQL: a TikTok Live slot can name the moderator working it, the pay
// route is one of the two AP request types and cannot exist without someone
// to pay, a share of the commission exists only where the host agreed to split
// it and never exceeds what the slot earned, the filed request is linked
// without owning the slot's life, and
// live_sessions_v gains the moderator columns WITHOUT moving the columns the
// board already reads.
//
// Run: node scripts/tests/live-schedule-moderator-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
//
// Mutations (each must fail a check):
//   MODERATOR_MUTATION=no-name-guard   a pay route needs no one to pay
//   MODERATOR_MUTATION=any-pay-type    the pay route is not restricted
//   MODERATOR_MUTATION=no-payout-guard a filed payout needs no one to pay
//   MODERATOR_MUTATION=cascade-delete  deleting the AP request deletes the slot
//   MODERATOR_MUTATION=no-view-columns the view does not expose the moderator
//   MODERATOR_MUTATION=no-split-guard   a share with no agreement to split
//   MODERATOR_MUTATION=overpay-allowed  a share larger than the slot's commission
//   MODERATOR_MUTATION=split-default-on the split is on unless turned off
//   MODERATOR_MUTATION=self-allowed     the host can be their own moderator
//   MODERATOR_MUTATION=unsettled-split  a finalized split with no share recorded
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20261029190000_live_schedule_moderator_payout.sql';
// The deployment check's own SQL, run here rather than described: a verifier
// that only looks for constraint NAMES reports 'ok' for a constraint replaced
// by a weaker one of the same name, which is the failure it exists to catch.
const VERIFIER_SQL = await (async () => {
  const all = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = all.indexOf('-- 21b. Live schedule moderator payout');
  assert.ok(start > 0, 'the verifier section is still there');
  const end = all.indexOf('as live_schedule_moderator_payout;', start);
  assert.ok(end > start, 'the verifier section still ends where it did');
  return all.slice(start, end + 'as live_schedule_moderator_payout;'.length);
})();
let migration = await readFile(new URL(MIGRATION, root), 'utf8');

const mutation = process.env.MODERATOR_MUTATION || '';
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation anchor not found: ${from.slice(0, 60)}`);
  migration = migration.replace(from, to);
};
if (mutation === 'no-name-guard') mutate('    or (moderator_name is not null\n        and moderator_pay_type in', '    or (true\n        and moderator_pay_type in');
if (mutation === 'any-pay-type') mutate("and moderator_pay_type in ('payroll_payment', 'invoice_vendor_payment'))", 'and moderator_pay_type is not null)');
if (mutation === 'no-payout-guard') mutate('    moderator_name is not null\n    or (moderator_payout_total is null', '    true\n    or (moderator_payout_total is null');
if (mutation === 'cascade-delete') mutate('references public.payment_requests(id) on delete set null;', 'references public.payment_requests(id) on delete cascade;');
if (mutation === 'no-split-guard') mutate('    or (moderator_commission_split\n        and moderator_commission_amount >= 0', '    or (true\n        and moderator_commission_amount >= 0');
if (mutation === 'overpay-allowed') mutate('        and moderator_commission_amount <= coalesce(commission_amount, 0))', '        and moderator_commission_amount <= 1e9)');
if (mutation === 'split-default-on') mutate('add column if not exists moderator_commission_split boolean not null default false;', 'add column if not exists moderator_commission_split boolean not null default true;');
if (mutation === 'self-allowed') mutate('  check (moderator_user_id is null or moderator_user_id <> claimed_by);', '  check (true);');
if (mutation === 'unsettled-split') mutate("    status <> 'finalized'\n    or not moderator_commission_split", "    true\n    or not moderator_commission_split");
if (mutation === 'no-view-columns') mutate('  moderator.name as moderator_user_name,\n  moderator.email as moderator_user_email', '  null::text as moderator_user_name,\n  null::text as moderator_user_email');

const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const refuses = async (sql, params, match) => {
  try { await db.query(sql, params); } catch (err) { assert.match(err.message, match); return err.message; }
  assert.fail(`expected a refusal matching ${match}`);
};

// The slice of production these columns land on: live_sessions as
// 20260807120000 + 20260807150000 leave it, plus the two tables it points at.
await db.exec(`
create schema if not exists public;
create table public.entities (id uuid primary key default gen_random_uuid(), name text);
create table public.profiles (id uuid primary key default gen_random_uuid(), name text, email text, avatar_url text);
create table public.payment_requests (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  vendor_name text, request_type text, amount_due numeric(14,2));
create table public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  slot_start timestamptz not null,
  live_location text, notes text,
  claimed_by uuid not null references public.profiles(id),
  status text not null default 'claimed' check (status in ('claimed','finalized')),
  gross_sales numeric(14,2),
  commission_rate numeric(6,4) not null default 0.03,
  commission_amount numeric(14,2),
  payee_name text,
  payment_request_id uuid references public.payment_requests(id) on delete set null,
  finalized_at timestamptz,
  hourly_rate numeric(8,2) not null default 25.00,
  payout_total numeric(14,2),
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create unique index live_sessions_company_slot_key on public.live_sessions (company_entity_id, slot_start);
create view public.live_sessions_v with (security_invoker = true) as
select ls.*, claimer.name as claimed_by_name, claimer.email as claimed_by_email,
       claimer.avatar_url as claimed_by_avatar_url
  from public.live_sessions ls left join public.profiles claimer on claimer.id = ls.claimed_by;

insert into public.entities (id, name) values ('11111111-1111-1111-1111-111111111111', 'Baseballism');
insert into public.profiles (id, name, email) values
  ('22222222-2222-2222-2222-222222222222', 'Blake Host', 'blake@baseballism.com'),
  ('33333333-3333-3333-3333-333333333333', 'Dana Reyes', 'dana@baseballism.com');
`);

const CO = '11111111-1111-1111-1111-111111111111';
const HOST = '22222222-2222-2222-2222-222222222222';
const DANA = '33333333-3333-3333-3333-333333333333';

// A slot claimed and finalized BEFORE this migration: every moderator column
// must read as "nobody moderated it", which is the truth, since there was no
// way to name one.
await db.query(
  `insert into public.live_sessions (id, company_entity_id, slot_start, claimed_by, status,
     gross_sales, commission_amount, payout_total, payee_name, finalized_at)
   values ('44444444-4444-4444-4444-444444444444', $1, '2026-10-01T18:00:00Z', $2, 'finalized',
     1000, 30, 55, 'Blake Host', now())`, [CO, HOST]);

await test('the migration applies, and applying it twice changes nothing', async () => {
  await db.exec(migration);
  await db.exec(migration);
  const [old] = await q(`select moderator_name, moderator_pay_type, moderator_payout_total,
    moderator_payment_request_id, moderator_hourly_rate, moderator_user_id,
    moderator_commission_amount
    from public.live_sessions where id = '44444444-4444-4444-4444-444444444444'`);
  assert.deepEqual(Object.values(old), [null, null, null, null, null, null, null],
    'a slot that ran before the moderator existed reports no moderator, not a zero payout');
  const [shared] = await q(`select moderator_commission_split from public.live_sessions
    where id = '44444444-4444-4444-4444-444444444444'`);
  assert.equal(shared.moderator_commission_split, false,
    'and its commission was NOT shared — the default is the arrangement that was in force');
});

await test('a slot can name a moderator who is a teammate, or one who is not', async () => {
  await db.query(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_user_id, moderator_pay_type)
    values ($1, '2026-11-01T18:00:00Z', $2, 'Dana Reyes', $3, 'payroll_payment')`, [CO, HOST, DANA]);
  await db.query(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_pay_type)
    values ($1, '2026-11-01T19:00:00Z', $2, 'Outside Moderator', 'invoice_vendor_payment')`, [CO, HOST]);
  const rows = await q(`select moderator_name, moderator_user_id from public.live_sessions
    where moderator_name is not null order by slot_start`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].moderator_user_id, DANA);
  assert.equal(rows[1].moderator_user_id, null,
    'a contractor with no SILO login is a name only, and is still payable');
});

await test('a pay route cannot exist without someone to pay', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by, moderator_pay_type)
    values ($1, '2026-11-02T18:00:00Z', $2, 'payroll_payment')`, [CO, HOST],
    /live_sessions_moderator_pay_type_check/);
});

await test('the pay route is one of the two AP request types, not free text', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_pay_type)
    values ($1, '2026-11-02T19:00:00Z', $2, 'Dana Reyes', 'venmo')`, [CO, HOST],
    /live_sessions_moderator_pay_type_check/);
});

await test('a filed moderator payout cannot exist without someone to pay', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by, moderator_payout_total)
    values ($1, '2026-11-02T20:00:00Z', $2, 25.00)`, [CO, HOST],
    /live_sessions_moderator_payout_check/);
});

await test('a share of the commission needs the host to have agreed to split it', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_pay_type, commission_amount, moderator_commission_amount)
    values ($1, '2026-11-02T21:00:00Z', $2, 'Dana Reyes', 'payroll_payment', 30.00, 15.00)`, [CO, HOST],
    /live_sessions_moderator_commission_check/);
});

await test('a share cannot exceed what the slot earned', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_pay_type, moderator_commission_split,
      commission_amount, moderator_commission_amount)
    values ($1, '2026-11-02T22:00:00Z', $2, 'Dana Reyes', 'payroll_payment', true, 30.00, 30.01)`, [CO, HOST],
    /live_sessions_moderator_commission_check/);
  // Exactly the half the page files is fine, and the two shares add back up to
  // the slot's own commission -- the odd cent on the host, never on nobody.
  await db.query(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by, status,
      moderator_name, moderator_pay_type, moderator_commission_split,
      gross_sales, commission_amount, moderator_commission_amount,
      payout_total, moderator_payout_total, moderator_hourly_rate, finalized_at)
    values ($1, '2026-11-02T23:00:00Z', $2, 'finalized', 'Dana Reyes', 'payroll_payment', true,
      333.67, 10.01, 5.00, 30.01, 30.00, 25.00, now())`, [CO, HOST]);
  const [row] = await q(`select commission_amount, moderator_commission_amount, payout_total
      from public.live_sessions where slot_start = '2026-11-02T23:00:00Z'`);
  // In cents: floating point has no business deciding whether a payout
  // reconciles.
  const cents = (v) => Math.round(Number(v) * 100);
  assert.equal(
    cents(row.moderator_commission_amount) + (cents(row.payout_total) - 2500),
    cents(row.commission_amount),
    "the two shares are the slot's commission exactly, with the odd cent on the host");
});

await test('an agreed split is unsettled while claimed and settled once finalized', async () => {
  // Claimed: the share is not knowable yet, because net sales are not in.
  await db.query(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_pay_type, moderator_commission_split)
    values ($1, '2026-11-04T18:00:00Z', $2, 'Dana Reyes', 'payroll_payment', true)`, [CO, HOST]);
  // Finalized with the agreement and no share is a moderator promised half and
  // paid none -- and it reads on the board as though nothing was agreed.
  await refuses(`update public.live_sessions set status = 'finalized', gross_sales = 1000,
      commission_amount = 30.00, payout_total = 55.00, finalized_at = now()
    where slot_start = '2026-11-04T18:00:00Z'`, [],
    /live_sessions_moderator_split_settled_check/);
  await db.exec(`update public.live_sessions set status = 'finalized', gross_sales = 1000,
      commission_amount = 30.00, moderator_commission_amount = 15.00, payout_total = 40.00,
      moderator_payout_total = 40.00, moderator_hourly_rate = 25.00, finalized_at = now()
    where slot_start = '2026-11-04T18:00:00Z'`);
});

await test('the host cannot be their own moderator', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_name, moderator_user_id, moderator_pay_type)
    values ($1, '2026-11-02T23:45:00Z', $2, 'Blake Host', $2, 'payroll_payment')`, [CO, HOST],
    /live_sessions_moderator_not_self_check/);
});

await test('a split cannot be recorded with nobody to split with', async () => {
  await refuses(`insert into public.live_sessions (company_entity_id, slot_start, claimed_by,
      moderator_commission_split)
    values ($1, '2026-11-02T23:30:00Z', $2, true)`, [CO, HOST],
    /live_sessions_moderator_payout_check/);
});

await test('the linked AP request does not own the slot', async () => {
  await db.query(`insert into public.payment_requests (id, company_entity_id, vendor_name, request_type, amount_due)
    values ('55555555-5555-5555-5555-555555555555', $1, 'Dana Reyes', 'payroll_payment', 25.00)`, [CO]);
  await db.query(`insert into public.live_sessions (id, company_entity_id, slot_start, claimed_by, status,
      moderator_name, moderator_user_id, moderator_pay_type, moderator_hourly_rate, moderator_payout_total,
      moderator_payment_request_id, finalized_at)
    values ('66666666-6666-6666-6666-666666666666', $1, '2026-11-03T18:00:00Z', $2, 'finalized',
      'Dana Reyes', $3, 'payroll_payment', 25.00, 25.00, '55555555-5555-5555-5555-555555555555', now())`, [CO, HOST, DANA]);
  await db.exec(`delete from public.payment_requests where id = '55555555-5555-5555-5555-555555555555'`);
  const rows = await q(`select moderator_name, moderator_payout_total, moderator_payment_request_id
    from public.live_sessions where id = '66666666-6666-6666-6666-666666666666'`);
  assert.equal(rows.length, 1, 'deleting the AP request must not delete the live session with it');
  assert.equal(rows[0].moderator_payment_request_id, null);
  assert.equal(Number(rows[0].moderator_payout_total), 25,
    'what the hour cost survives the request being deleted — history, not a live link');
});

await test('live_sessions_v carries the moderator AND everything the board already read', async () => {
  const cols = (await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='live_sessions_v'`)).map((r) => r.column_name);
  for (const c of ['moderator_name', 'moderator_user_id', 'moderator_pay_type', 'moderator_hourly_rate',
    'moderator_payout_total', 'moderator_payment_request_id', 'moderator_user_name', 'moderator_user_email',
    'moderator_commission_split', 'moderator_commission_amount']) {
    assert.ok(cols.includes(c), `view is missing ${c}`);
  }
  for (const c of ['claimed_by_name', 'claimed_by_email', 'claimed_by_avatar_url', 'payout_total',
    'hourly_rate', 'commission_amount', 'gross_sales', 'payment_request_id', 'status', 'slot_start']) {
    assert.ok(cols.includes(c), `view lost ${c}, which the board reads`);
  }
  const [opt] = await q(`select reloptions from pg_class where relname = 'live_sessions_v'`);
  assert.ok((opt.reloptions || []).includes('security_invoker=true'),
    'the view is invoker-rights, so RLS still applies through it');
  const [row] = await q(`select moderator_user_name, moderator_user_email from public.live_sessions_v
    where id = '66666666-6666-6666-6666-666666666666'`);
  assert.equal(row.moderator_user_name, 'Dana Reyes',
    'a linked teammate resolves to their current profile');
  assert.equal(row.moderator_user_email, 'dana@baseballism.com');
});

await test("the deployment check reads this schema as applied, and notices a guard weakened in place", async () => {
  const verdict = async () => (await q(VERIFIER_SQL))[0].live_schedule_moderator_payout;
  assert.equal(await verdict(), 'ok', 'the applied schema passes its own check');

  // Each guard replaced, in turn, by one that forbids nothing -- the same
  // NAME, a weaker definition. Every one must be caught by name AND meaning.
  const weakened = [
    ['live_sessions_moderator_pay_type_check', 'both routes'],
    ['live_sessions_moderator_payout_check', 'no payout without a name'],
    ['live_sessions_moderator_commission_check', 'split agreed'],
    ['live_sessions_moderator_not_self_check', 'not_self'],
    ['live_sessions_moderator_split_settled_check', 'a finalized split has a share'],
  ];
  for (const [name, why] of weakened) {
    const [{ def }] = await q(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.live_sessions'::regclass and conname = $1`, [name]);
    await db.exec(`alter table public.live_sessions drop constraint ${name};
                   alter table public.live_sessions add constraint ${name} check (true);`);
    const said = await verdict();
    assert.notEqual(said, 'ok', `a check(true) named ${name} must NOT read ok (${why})`);
    assert.match(said, /^MISSING/);
    await db.exec(`alter table public.live_sessions drop constraint ${name};
                   alter table public.live_sessions add constraint ${name} ${def};`);
    assert.equal(await verdict(), 'ok', `restoring ${name} restores the verdict`);
  }
});

console.log(`\n${checks} checks passed${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
