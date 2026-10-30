/* Product samples: a pipeline stage and its paired date are one event.
 *
 * Why this exists. Before 20261030130000 the Products page sample drawer wrote
 * the pipeline pill and the date inputs independently, so production held 169
 * of 171 'warehouse_ready' samples with no warehouse_ready_at and all 6
 * 'picked_up' samples with no picked_up_at -- sample lead time could not be
 * measured at all. The browser writes product_samples directly, so the rule
 * has to hold in the database.
 *
 * The traps this guards, each with a mutation below:
 *   * stamping on every write rather than on entering a stage, which overrules
 *     someone who deliberately clears a date (`always-stamp`);
 *   * overwriting a date that is already there (`overwrite-date`);
 *   * backfilling with migration day instead of the logged date -- the mistake
 *     PR #1081's review caught (`backfill-today`);
 *   * taking the FIRST entry into a stage rather than the most recent, which
 *     is wrong for the 5 samples that re-entered one (`backfill-min`);
 *   * backfilling rows that have since moved on (`backfill-any-status`);
 *   * re-running the backfill on a later apply, which resurrects a date
 *     someone deliberately cleared (`backfill-every-apply`).
 *
 * Runs on PGlite against stand-in tables carrying only the columns the
 * migration touches.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const MIGRATION = '20261030130000_product_sample_stage_dates.sql';
const MUTATIONS = ['', 'no-trigger', 'always-stamp', 'overwrite-date',
  'backfill-today', 'backfill-min', 'backfill-any-status', 'backfill-every-apply'];
const mutation = process.env.SAMPLE_STAGE_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];

let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

const PACIFIC = '11111111-1111-4111-8111-111111111111';
const FAR_EAST = '22222222-2222-4222-8222-222222222222';   // UTC+14
const FAR_WEST = '33333333-3333-4333-8333-333333333333';   // UTC-11

// ── The columns the migration reads and writes, nothing else ────────────────
await db.exec(`
  create table public.company_settings (
    company_entity_id uuid primary key,
    business_timezone text
  );

  create table public.product_samples (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid,
    product_title text,
    sample_status text,
    received_at date,
    warehouse_ready_at date,
    picked_up_at date,
    sent_at date,
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );

  create table public.product_sample_activity (
    id uuid primary key default gen_random_uuid(),
    sample_id uuid,
    action text,
    from_value text,
    to_value text,
    created_at timestamptz default now()
  );

  -- The real one is SECURITY DEFINER and reads company_settings; the fallback
  -- to Pacific lives in it and nowhere else (see 20260924130000). This
  -- stand-in has the same signature and the same answer.
  create or replace function public.silo_company_timezone(p_company_entity_id uuid)
  returns text language sql stable as $$
    select coalesce(
      (select cs.business_timezone from public.company_settings cs
        where cs.company_entity_id = p_company_entity_id),
      'America/Los_Angeles');
  $$;
`);

await q(`insert into public.company_settings values
  ($1, 'America/Los_Angeles'), ($2, 'Pacific/Kiritimati'), ($3, 'Pacific/Midway')`,
  [PACIFIC, FAR_EAST, FAR_WEST]);

// Rows as production held them, plus the cases the backfill must NOT touch.
const samples = [
  // title,                 status,              received, whs,          picked
  ['whs-no-date', 'warehouse_ready', '2026-09-01', null, null],
  ['whs-dated', 'warehouse_ready', '2026-09-02', '2026-09-20', null],
  ['whs-no-evidence', 'warehouse_ready', '2026-09-03', null, null],
  ['whs-reentered', 'warehouse_ready', '2026-09-04', null, null],
  ['picked-no-date', 'picked_up', null, null, null],
  ['received-legacy', 'received', null, null, null],
  ['pps-dated', 'pps_received', '2026-08-15', null, null],
  ['moved-on', 'picked_up', '2026-09-05', null, '2026-09-28'],
  ['size-req-sent', 'size_request_sent', '2026-09-06', null, null]
];
for (const [title, status, received, whs, picked] of samples) {
  await q(`insert into public.product_samples
             (company_entity_id, product_title, sample_status, received_at, warehouse_ready_at, picked_up_at)
           values ($1, $2, $3, $4, $5, $6)`,
    [PACIFIC, title, status, received, whs, picked]);
}

const idOf = async (title) =>
  (await first('select id from public.product_samples where product_title = $1', [title])).id;

// The activity log, as the page writes it on every status change.
const logs = [
  ['whs-no-date', 'warehouse_ready', '2026-09-11T18:00:00Z'],
  ['whs-dated', 'warehouse_ready', '2026-09-12T18:00:00Z'],
  // whs-reentered went in, out, and back in: MAX must win, not MIN.
  ['whs-reentered', 'warehouse_ready', '2026-09-13T18:00:00Z'],
  ['whs-reentered', 'size_request_sent', '2026-09-14T18:00:00Z'],
  ['whs-reentered', 'warehouse_ready', '2026-09-25T18:00:00Z'],
  ['picked-no-date', 'picked_up', '2026-09-15T18:00:00Z'],
  ['received-legacy', 'received', '2026-09-16T18:00:00Z'],
  // 'moved-on' was warehouse_ready once and has since been picked up. Its
  // warehouse_ready_at must stay null: the backfill is scoped to the status
  // the row is in NOW.
  ['moved-on', 'warehouse_ready', '2026-09-17T18:00:00Z'],
  // So was size-req-sent.
  ['size-req-sent', 'warehouse_ready', '2026-09-18T18:00:00Z']
];
for (const [title, to, at] of logs) {
  await q(`insert into public.product_sample_activity (sample_id, action, to_value, created_at)
           values ($1, 'status_changed', $2, $3)`, [await idOf(title), to, at]);
}

// ── Apply the migration, optionally mutated ────────────────────────────────
const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
let sql = original;
if (mutation === 'no-trigger') {
  sql = sql.replace(/create trigger trg_product_sample_stage_date[\s\S]*?execute function public\.product_sample_stamp_stage_date\(\);/,
    'select 1;');
}
if (mutation === 'always-stamp') {
  // Drop the "only on entering a stage" guard: every save restamps, so a
  // deliberately cleared date comes back.
  sql = sql.replace(
    /  if tg_op = 'UPDATE'\n     and coalesce\(new\.sample_status, ''\) is not distinct from coalesce\(old\.sample_status, ''\) then\n    return new;\n  end if;\n/,
    '');
}
if (mutation === 'overwrite-date') {
  sql = sql.replace('new.warehouse_ready_at := coalesce(new.warehouse_ready_at, today);',
    'new.warehouse_ready_at := today;');
}
if (mutation === 'backfill-today') {
  // The #1081 trap: stamp migration day instead of the logged date.
  sql = sql.replace(/\(max\(act\.created_at\) at time zone public\.silo_company_timezone\(smp\.company_entity_id\)\)::date as stage_date/g,
    'current_date as stage_date');
}
if (mutation === 'backfill-min') {
  sql = sql.replace(/max\(act\.created_at\)/g, 'min(act.created_at)');
}
if (mutation === 'backfill-every-apply') {
  // Remove the first-apply gate, so re-applying resurrects a date someone
  // deliberately cleared.
  sql = sql.replace(/  if exists \(select 1 from pg_trigger\n[\s\S]*?    return;\n  end if;\n/,
    '');
}
if (mutation === 'backfill-any-status') {
  sql = sql.replace(/     and s\.sample_status = 'warehouse_ready'\n/, '');
}
assert.ok(!mutation || sql !== original,
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}

const row = (title) => first('select * from public.product_samples where product_title = $1', [title]);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// The expected date is the COMPANY's business day, computed the way the
// trigger computes it -- never SQL current_date, which is the session's UTC
// day. Between 00:00 and 07:00 UTC the Pacific company is still on the
// previous date, so a `current_date` comparison fails on correct behaviour
// and takes the finance-database job red for those hours every night.
const businessDay = async (company) =>
  (await first('select (now() at time zone public.silo_company_timezone($1))::date as d', [company])).d;
const today = await businessDay(PACIFIC);
// Proof that the distinction is not theoretical: a UTC+14 and a UTC-11
// company are 25 hours apart, so at every instant at least one of them is on
// a different calendar date from UTC.
const utcToday = (await first('select current_date as d')).d;
assert.ok(
  [await businessDay(FAR_EAST), await businessDay(FAR_WEST)]
    .some((d) => iso(d) !== iso(utcToday)),
  'at least one fixture company must differ from the UTC date at any instant');

// ── 1. The backfill ───────────────────────────────────────────────────────
check('a stranded warehouse_ready row gets the logged date, not migration day');
let r = await row('whs-no-date');
assert.equal(iso(r.warehouse_ready_at), '2026-09-11');
assert.notEqual(iso(r.warehouse_ready_at), iso(today), 'stamped with migration day');

check('a date already on the row is preserved');
assert.equal(iso((await row('whs-dated')).warehouse_ready_at), '2026-09-20');

check('a row with no activity evidence is left null rather than invented');
assert.equal((await row('whs-no-evidence')).warehouse_ready_at, null);

check('a re-entered stage takes the most recent entry, not the first');
assert.equal(iso((await row('whs-reentered')).warehouse_ready_at), '2026-09-25');

check('picked_up and the legacy received value are backfilled too');
assert.equal(iso((await row('picked-no-date')).picked_up_at), '2026-09-15');
assert.equal(iso((await row('received-legacy')).received_at), '2026-09-16');

check('a row that has moved past a stage is not given that stage date');
assert.equal((await row('moved-on')).warehouse_ready_at, null,
  'the backfill must be scoped to the status the row is in now');
assert.equal((await row('size-req-sent')).warehouse_ready_at, null);

check('a date the backfill has no business touching is untouched');
assert.equal(iso((await row('pps-dated')).received_at), '2026-08-15');
assert.equal(iso((await row('moved-on')).picked_up_at), '2026-09-28');

// ── 2. The trigger ────────────────────────────────────────────────────────
const newSample = async (title, status, company = PACIFIC) => {
  await q(`insert into public.product_samples (company_entity_id, product_title, sample_status)
           values ($1, $2, $3)`, [company, title, status]);
  return row(title);
};

check('entering warehouse_ready stamps the date');
await newSample('fresh', 'pps_received');
await q(`update public.product_samples set sample_status = 'warehouse_ready' where product_title = 'fresh'`);
r = await row('fresh');
assert.equal(iso(r.warehouse_ready_at), iso(today));

check('entering a stage does not disturb an earlier stage date');
assert.equal(iso(r.received_at), iso(today), 'received_at was stamped when the row was born at pps_received');

check('entering picked_up stamps only picked_up_at');
await q(`update public.product_samples set sample_status = 'picked_up' where product_title = 'fresh'`);
r = await row('fresh');
assert.equal(iso(r.picked_up_at), iso(today));
assert.equal(iso(r.warehouse_ready_at), iso(today), 'the warehouse date must not move');

check('a date already typed in is never overwritten');
await newSample('hand-dated', 'pps_received');
await q(`update public.product_samples set warehouse_ready_at = '2026-07-04' where product_title = 'hand-dated'`);
await q(`update public.product_samples set sample_status = 'warehouse_ready' where product_title = 'hand-dated'`);
assert.equal(iso((await row('hand-dated')).warehouse_ready_at), '2026-07-04');

check('moving back to an earlier stage does not clear a date');
await q(`update public.product_samples set sample_status = 'size_request_sent' where product_title = 'fresh'`);
r = await row('fresh');
assert.equal(iso(r.warehouse_ready_at), iso(today), 'a sample arriving does not un-happen');
assert.equal(iso(r.picked_up_at), iso(today));

check('a deliberately cleared date stays cleared');
await q(`update public.product_samples set warehouse_ready_at = null, notes = 'wrong date'
          where product_title = 'hand-dated'`);
assert.equal((await row('hand-dated')).warehouse_ready_at, null,
  'an ordinary save must not restamp a date the user emptied');

check('a save that carries the same status does not restamp');
await q(`update public.product_samples set sample_status = 'warehouse_ready', warehouse_ready_at = null
          where product_title = 'hand-dated'`);
assert.equal((await row('hand-dated')).warehouse_ready_at, null,
  'the status did not change, so the rule must not run');

check('a row born at a stage is stamped on insert');
r = await newSample('born-ready', 'warehouse_ready');
assert.equal(iso(r.warehouse_ready_at), iso(today));

check('a stage with no paired date is left alone');
r = await newSample('no-pair', 'size_request_sent');
assert.equal(r.received_at, null);
assert.equal(r.warehouse_ready_at, null);
assert.equal(r.picked_up_at, null);

check('a write to an unrelated column does not run the rule');
await q(`update public.product_samples set notes = 'note' where product_title = 'no-pair'`);
r = await row('no-pair');
assert.equal(r.warehouse_ready_at, null);

check('the date is the company business day, not the UTC day');
// 25 hours apart, so these two can never land on the same calendar date.
const east = await newSample('east', 'warehouse_ready', FAR_EAST);
const west = await newSample('west', 'warehouse_ready', FAR_WEST);
assert.notEqual(iso(east.warehouse_ready_at), iso(west.warehouse_ready_at),
  'UTC+14 and UTC-11 must not share a business date');
for (const [sample, tz] of [[east, 'Pacific/Kiritimati'], [west, 'Pacific/Midway']]) {
  const expected = (await first(`select (now() at time zone $1)::date as d`, [tz])).d;
  assert.equal(iso(sample.warehouse_ready_at), iso(expected));
}

check('the stamp follows the company, not the SESSION timezone');
// The reviewer's scenario on PR #1084, made deterministic: with the session
// ahead of Pacific, current_date and the Pacific business day are different
// calendar dates (verified: session Pacific/Kiritimati gives current_date
// 2026-10-31 while Pacific is still 2026-10-30). The trigger must follow the
// company, and an assertion must never be written against current_date.
await db.exec("set timezone = 'Pacific/Kiritimati'");
try {
  const sessionDate = (await first('select current_date as d')).d;
  const pacificDay = await businessDay(PACIFIC);
  r = await newSample('session-shifted', 'warehouse_ready');
  assert.equal(iso(r.warehouse_ready_at), iso(pacificDay),
    'the stamp must be the company business day whatever the session timezone is');
  if (iso(sessionDate) !== iso(pacificDay)) {
    assert.notEqual(iso(r.warehouse_ready_at), iso(sessionDate),
      'the session date and the company date differ right now, and the stamp followed the session');
  }
} finally {
  await db.exec("set timezone = 'UTC'");
}

check('a company with no settings row still gets a date');
r = await newSample('no-settings', 'warehouse_ready', '44444444-4444-4444-8444-444444444444');
assert.notEqual(r.warehouse_ready_at, null);

check('a null company does not break the write');
await q(`insert into public.product_samples (product_title, sample_status)
         values ('no-company', 'warehouse_ready')`);
assert.notEqual((await row('no-company')).warehouse_ready_at, null);

check('no row is left in a dated stage without its date');
assert.equal(Number((await first(`select count(*) n from public.product_samples
   where sample_status = 'warehouse_ready' and warehouse_ready_at is null
     and exists (select 1 from public.product_sample_activity a
                  where a.sample_id = product_samples.id and a.to_value = 'warehouse_ready')`)).n), 0);

// ── 3. The committed verification check, against this same fixture ────────
// Finding 2 on PR #1084: the first version of this check reported DRIFT for
// any current warehouse_ready sample with a NULL date and a logged transition
// -- which is a legitimate row (enter the stage, then clear the date and save
// without changing status). Run the committed check here so that condition
// cannot come back.
check('the committed schema check tolerates transition -> clear -> same-status save');
const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
const stageCheck = splitSqlStatements(verifySql)
  .find((st) => st.text.includes("'Product sample stage dates' as check_name"));
assert.ok(stageCheck, 'the Product sample stage dates check must stay committed');

// Build exactly that row: enter the stage (logging the transition, as the
// page does), then clear the date without touching the status.
await newSample('cleared-on-purpose', 'pps_received');
const clearedId = await idOf('cleared-on-purpose');
await q(`update public.product_samples set sample_status = 'warehouse_ready' where id = $1`, [clearedId]);
await q(`insert into public.product_sample_activity (sample_id, action, to_value)
         values ($1, 'status_changed', 'warehouse_ready')`, [clearedId]);
await q(`update public.product_samples set warehouse_ready_at = null, notes = 'wrong date' where id = $1`, [clearedId]);
assert.equal((await row('cleared-on-purpose')).warehouse_ready_at, null,
  'the trigger must have preserved the cleared date for this case to mean anything');

const verdict = (await q(stageCheck.text))[0];
assert.equal(verdict.status, 'ok',
  `a deliberately cleared stage date must not read as drift (got: ${verdict.status})`);

// ── 4. Idempotence ────────────────────────────────────────────────────────
check('re-running the migration changes nothing');
const cols = 'product_title, sample_status, received_at, warehouse_ready_at, picked_up_at';
const before = await q(`select ${cols} from public.product_samples order by product_title`);
for (const statement of splitSqlStatements(sql)) {
  if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
  await db.exec(statement.text);
}
const after = await q(`select ${cols} from public.product_samples order by product_title`);
assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));

console.log(`${checks} product sample stage-date checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
