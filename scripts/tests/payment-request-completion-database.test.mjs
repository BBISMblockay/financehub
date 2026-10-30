/* Payment requests: completion, workflow status and completion date stay in sync.
 *
 * Why this exists. Before 20261030120000 the Request Manager wrote `completed`
 * and `workflow_status` independently, so production held 65 rows that were
 * completed while still reading 'new'. The page now keeps the two together, but
 * the browser writes `payment_requests` directly, so the invariant has to hold
 * in the database as well -- and the backfill has an ordering trap of its own:
 * the trigger is installed before the backfill runs, so a statement that sets
 * the status without also setting a missing date_completed gets today's date
 * stamped by its own trigger, silently moving a September completion to
 * migration day. That is mutation `date-after-status` below.
 *
 * Runs on PGlite against a stand-in `payment_requests` carrying only the
 * columns the migration touches: this proves the trigger and the backfill,
 * not the rest of the table.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const MIGRATION = '20261030120000_payment_request_completion_status_sync.sql';
const mutation = process.env.PAYMENT_COMPLETION_MUTATION || '';
assert.ok(['', 'date-after-status', 'no-trigger', 'overwrite-terminal'].includes(mutation),
  `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

// ── The columns the migration reads and writes, nothing else ────────────────
await db.exec(`
  create table public.payment_requests (
    id uuid primary key default gen_random_uuid(),
    vendor_name text,
    workflow_status text not null default 'new',
    completed boolean not null default false,
    date_completed date,
    submitted_at timestamptz default now(),
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
`);

// Rows as production held them: completed, non-terminal, some with no date.
const rows = [
  ['legacy-new-dated', 'new', true, '2026-09-04', '2026-09-18T00:00:00Z'],
  ['legacy-new-undated', 'new', true, null, '2026-09-18T00:00:00Z'],
  ['legacy-approved-undated', 'approved', true, null, '2026-08-12T00:00:00Z'],
  ['rejected-undated', 'rejected', true, null, '2026-09-17T00:00:00Z'],
  ['cancelled-undated', 'cancelled', true, null, '2026-09-22T00:00:00Z'],
  ['paid-dated', 'paid', true, '2026-10-01', '2026-10-01T00:00:00Z'],
  ['open-new', 'new', false, null, '2026-10-29T00:00:00Z'],
  ['open-with-stray-date', 'needs_info', false, '2026-08-11', '2026-08-11T00:00:00Z']
];
for (const [vendor, status, completed, date, updated] of rows) {
  await q(`insert into public.payment_requests
             (vendor_name, workflow_status, completed, date_completed, updated_at, created_at, submitted_at)
           values ($1, $2, $3, $4, $5, $5, $5)`,
    [vendor, status, completed, date, updated]);
}

// ── Apply the migration, optionally mutated ────────────────────────────────
let sql = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
if (mutation === 'date-after-status') {
  // The bug the reviewer found on PR #1081: set the status first and leave the
  // date to a later statement, which the trigger has already filled.
  sql = sql.replace(/ set workflow_status = 'paid',\n\s+date_completed = coalesce\([^)]*\)\n/,
    " set workflow_status = 'paid'\n");
}
if (mutation === 'no-trigger') {
  sql = sql.replace(/create trigger trg_payment_request_sync_completion[\s\S]*?execute function public\.payment_request_sync_completion\(\);/,
    'select 1;');
}
if (mutation === 'overwrite-terminal') {
  sql = sql.replace("coalesce(new.workflow_status, '') <> all (terminal)", 'true');
}
assert.ok(!mutation || sql !== await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8'),
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}

const row = (vendor) => first('select * from public.payment_requests where vendor_name = $1', [vendor]);
const today = (await first('select current_date as d')).d;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ── 1. The backfill ────────────────────────────────────────────────────────
check('completed+new becomes paid', () => {});
assert.equal((await row('legacy-new-dated')).workflow_status, 'paid');
assert.equal((await row('legacy-approved-undated')).workflow_status, 'paid');

check('a completion date already on the row is preserved', () => {});
assert.equal(iso((await row('legacy-new-dated')).date_completed), '2026-09-04');

check('a missing completion date is the historical one, not migration day', () => {});
for (const vendor of ['legacy-new-undated', 'legacy-approved-undated', 'rejected-undated', 'cancelled-undated']) {
  const r = await row(vendor);
  assert.equal(iso(r.date_completed), iso(r.updated_at),
    `${vendor}: date_completed must come from updated_at, not current_date (${iso(today)})`);
  assert.notEqual(iso(r.date_completed), iso(today), `${vendor}: stamped with migration day`);
}

check('rejected and cancelled are not rewritten to paid', () => {});
assert.equal((await row('rejected-undated')).workflow_status, 'rejected');
assert.equal((await row('cancelled-undated')).workflow_status, 'cancelled');

check('an open row keeps its status and loses a stray completion date', () => {});
assert.equal((await row('open-new')).workflow_status, 'new');
assert.equal((await row('open-with-stray-date')).workflow_status, 'needs_info');
assert.equal((await row('open-with-stray-date')).date_completed, null);

check('no completed row is left in a non-terminal status', () => {});
assert.equal(Number((await first(`select count(*) n from public.payment_requests
   where completed and workflow_status <> all (array['paid','rejected','cancelled'])`)).n), 0);
assert.equal(Number((await first('select count(*) n from public.payment_requests where completed and date_completed is null')).n), 0);

// ── 2. The trigger, which is what stops the mismatch coming back ───────────
const write = async (sets, vendor) => {
  await q(`update public.payment_requests set ${sets} where vendor_name = $1`, [vendor]);
  return row(vendor);
};

check('completing a request through a direct write lands it in paid', () => {});
await q(`insert into public.payment_requests (vendor_name, workflow_status) values ('fresh', 'new')`);
let r = await write('completed = true', 'fresh');
assert.equal(r.workflow_status, 'paid');
assert.equal(iso(r.date_completed), iso(today));

check('setting a terminal status marks the request completed', () => {});
await q(`insert into public.payment_requests (vendor_name, workflow_status) values ('to-reject', 'in_review')`);
r = await write("workflow_status = 'rejected'", 'to-reject');
assert.equal(r.completed, true);
assert.equal(iso(r.date_completed), iso(today));

check('reopening a paid request clears completion and demotes the status', () => {});
r = await write('completed = false', 'fresh');
assert.equal(r.workflow_status, 'approved');
assert.equal(r.completed, false);
assert.equal(r.date_completed, null);

check('moving a paid request back to in_review reopens it', () => {});
await q(`insert into public.payment_requests (vendor_name, workflow_status, completed, date_completed)
         values ('paid-then-reopened', 'paid', true, current_date)`);
r = await write("workflow_status = 'in_review'", 'paid-then-reopened');
assert.equal(r.completed, false);
assert.equal(r.date_completed, null);

check('an insert that is already completed is stored paid and dated', () => {});
await q(`insert into public.payment_requests (vendor_name, workflow_status, completed) values ('born-done', 'new', true)`);
r = await row('born-done');
assert.equal(r.workflow_status, 'paid');
assert.equal(iso(r.date_completed), iso(today));

check('an ordinary insert is untouched', () => {});
await q(`insert into public.payment_requests (vendor_name) values ('ordinary')`);
r = await row('ordinary');
assert.equal(r.workflow_status, 'new');
assert.equal(r.completed, false);
assert.equal(r.date_completed, null);

check('a write to an unrelated column does not run the rule', () => {});
await db.exec(`alter table public.payment_requests add column internal_notes text`);
await q(`insert into public.payment_requests (vendor_name, workflow_status, completed, date_completed)
         values ('untouched', 'paid', true, '2026-09-04')`);
await q(`update public.payment_requests set internal_notes = 'note' where vendor_name = 'untouched'`);
r = await row('untouched');
assert.equal(iso(r.date_completed), '2026-09-04', 'an unrelated write must not restamp the date');
assert.equal(r.workflow_status, 'paid');

check('re-running the migration changes nothing', () => {});
const before = await q('select vendor_name, workflow_status, completed, date_completed from public.payment_requests order by vendor_name');
for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}
const after = await q('select vendor_name, workflow_status, completed, date_completed from public.payment_requests order by vendor_name');
assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));

console.log(`${checks} payment request completion checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
