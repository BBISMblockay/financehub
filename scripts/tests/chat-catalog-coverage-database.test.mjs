/* The catalog-coverage seed: 20261103190000_chat_catalog_coverage.sql.
 *
 * The migration writes no business row, so the whole risk is in how it writes
 * text. Four things can go wrong and each has a mutation below:
 *
 *   1. it clobbers a curated description (sync_jobs carries a skip and
 *      partial-failure warning that cost real debugging to write);
 *   2. a seeded relname is a typo, so the update reports success and lands
 *      nowhere -- the silent failure this file's guard exists to stop;
 *   3. the plumbing tables are not hidden, leaving a credentials table and
 *      nine scaffolding tables in the model's index AND in the query tool's
 *      allowlist;
 *   4. it reaches a relation it was not asked to touch.
 *
 * Each statement is applied SEPARATELY, with begin/commit dropped, because that
 * is how the SQL editor applies a file -- and the first version of this
 * migration held its seed in a temp table declared `on commit drop`, which works
 * under psql and fails with `relation "_catalog_seed" does not exist` under
 * anything that commits per statement. Blake hit it on the real apply. The whole
 * file in one transaction is strictly easier, so this covers both.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const MIGRATION = '20261103190000_chat_catalog_coverage.sql';
const MUTATIONS = ['', 'clobber-curated', 'no-missing-guard', 'no-hide', 'bloat-lead', 'touch-everything'];
const mutation = process.env.CATALOG_COVERAGE_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
let sql = original;
if (mutation === 'clobber-curated') {
  sql = sql.replace(
    /description = case[\s\S]*?end,/,
    'description = nullif(btrim(s.description), \'\'),');
}
if (mutation === 'no-missing-guard') {
  sql = sql.replace(/do \$\$[\s\S]*?end \$\$;/, 'select 1;');
}
if (mutation === 'no-hide') {
  sql = sql.replace(/update public\.silo_chat_schema_catalog set is_hidden = true[\s\S]*?and not is_hidden;/,
    'select 1;');
}
if (mutation === 'bloat-lead') {
  // Fold the column enumeration back into the opening sentence, which is what
  // gets truncated at 140 characters on every index line.
  sql = sql.replace(/\. Columns: /g, ', columns: ');
}
if (mutation === 'touch-everything') {
  sql = sql.replace(' where k.relname = s.relname;', ' where true;');
}
assert.ok(!mutation || sql !== original,
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

/* The names the migration seeds, read out of the file itself so this test
   cannot drift from it, and the eleven it hides. */
const SEEDED = [...original.matchAll(/^\('([a-z0-9_]+)',$/gm)].map((m) => m[1]);
assert.ok(SEEDED.length >= 50, `only ${SEEDED.length} seeded names found -- the parse is wrong`);
assert.equal(new Set(SEEDED).size, SEEDED.length, 'a relation is seeded twice');

const hideBlock = original.match(/set is_hidden = true[\s\S]*?\) and not is_hidden;/)[0];
const HIDDEN = [...hideBlock.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
assert.equal(HIDDEN.length, 11, `expected 11 plumbing tables, found ${HIDDEN.length}`);

await db.exec(`
  create table public.silo_chat_schema_catalog (
    relname text primary key,
    relkind text not null,
    columns jsonb not null default '[]'::jsonb,
    description text,
    keywords text[],
    is_hidden boolean not null default false,
    reportable boolean not null default false,
    auto_refreshed_at timestamptz,
    updated_at timestamptz not null default now()
  );
`);

/* Production's shape where it matters: sync_jobs is the one seeded relation
   that already carries a description, and two relations stand in for
   everything the migration must not touch. */
const CURATED_SYNC_JOBS = "Per-connection sync run log. One row per stage per run. status: success, error, "
  + "running, pending, cancelled, or SKIPPED -- never read a missing row as evidence a stage succeeded.";
const UNTOUCHED = 'Daily sales rollup by location/SKU.';
for (const relname of SEEDED) {
  await q(`insert into public.silo_chat_schema_catalog (relname, relkind, description)
           values ($1, 'table', $2)`,
    [relname, relname === 'sync_jobs' ? CURATED_SYNC_JOBS : null]);
}
for (const relname of HIDDEN) {
  await q(`insert into public.silo_chat_schema_catalog (relname, relkind) values ($1, 'table')`, [relname]);
}
await q(`insert into public.silo_chat_schema_catalog (relname, relkind, description, keywords)
         values ('sales_by_day', 'table', $1, array['sales'])`, [UNTOUCHED]);
await q(`insert into public.silo_chat_schema_catalog (relname, relkind) values ('cash_forecast_items', 'table')`);

/* One statement at a time, each committed on its own: no cross-statement
   temporary state can hide here. */
const apply = async () => {
  for (const statement of splitSqlStatements(sql)) {
    if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
    await db.exec(statement.text);
  }
};

check('the migration carries no state between statements');
// Comments are allowed to name the old shape; the SQL is not.
const executable = original.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
assert.ok(!/create\s+(temporary|temp)\s+table/i.test(executable),
  'a temp table does not survive a client that commits each statement');
assert.ok(!/_catalog_seed/.test(executable),
  'the seed must live inside the statement that uses it');
await apply();

const cat = (relname) => first('select * from public.silo_chat_schema_catalog where relname = $1', [relname]);

// ── 1. Every seeded relation is now findable and says something ───────────
check('every seeded relation has keywords');
for (const relname of SEEDED) {
  const row = await cat(relname);
  assert.ok(row.keywords && row.keywords.length >= 3,
    `${relname} has fewer than 3 keywords, so the keyword-ranked slice can never pick it`);
}

check('every seeded relation has a description worth reading');
for (const relname of SEEDED) {
  const row = await cat(relname);
  assert.ok(row.description && row.description.length > 80,
    `${relname} has no usable description (${row.description?.length ?? 0} chars)`);
}

/* The index line Ask SILO sees for a relation that does not win a full card is
   `description.split('. ')[0]`, truncated at MAX_INDEX_SUMMARY_CHARS (140,
   silo-chat/schema-map-lib.mjs). A description whose opening clause runs past
   that is cut mid-thought on every question, which is the renderer hole that
   cost 17 launch_calendar guesses before it was found. */
check('every seeded description opens with a sentence that survives the index line');
const MAX_INDEX_SUMMARY_CHARS = 140;
for (const relname of SEEDED) {
  const description = (await cat(relname)).description || '';
  const lead = (description.split('. ')[0] || '').trim();
  assert.ok(lead.length > 0 && lead.length <= MAX_INDEX_SUMMARY_CHARS,
    `${relname}: the opening sentence is ${lead.length} chars and will be truncated on the index line`);
}

// ── 2. A curated description is never clobbered ───────────────────────────
check('sync_jobs keeps the description somebody wrote by hand');
assert.equal((await cat('sync_jobs')).description, CURATED_SYNC_JOBS,
  'the curated skip/partial-failure warning was overwritten');
check('sync_jobs still gains keywords, which is why it is in the seed');
assert.ok((await cat('sync_jobs')).keywords.includes('freshness'));

// ── 3. The plumbing is hidden ─────────────────────────────────────────────
check('the eleven plumbing tables are hidden from the index and the query tool');
for (const relname of HIDDEN) {
  assert.equal((await cat(relname)).is_hidden, true, `${relname} is still visible`);
}
check('a credentials table is among them');
assert.ok(HIDDEN.includes('shopify_client_credentials'));
check('nothing seeded is also hidden');
assert.equal(SEEDED.filter((r) => HIDDEN.includes(r)).length, 0,
  'a relation cannot be both described for the model and hidden from it');

// ── 4. Nothing outside the seed and the hide list moves ───────────────────
check('an unrelated described relation is left exactly as it was');
const untouched = await cat('sales_by_day');
assert.equal(untouched.description, UNTOUCHED);
assert.deepEqual(untouched.keywords, ['sales']);
check('an unrelated undescribed relation stays undescribed');
const empty = await cat('cash_forecast_items');
assert.equal(empty.description, null);
assert.equal(empty.keywords, null);
assert.equal(empty.is_hidden, false);

// ── 5. A seeded name the catalog does not have must raise ─────────────────
check('a seeded relname absent from the catalog raises instead of no-opping');
await q(`delete from public.silo_chat_schema_catalog where relname = 'reorder_plan_v'`);
let raised = null;
try { await apply(); } catch (err) { raised = err; }
try { await db.exec('rollback'); } catch { /* nothing open */ }
assert.ok(raised, 'a typo in a seeded name would land nowhere and report success');
assert.match(String(raised.message), /absent from silo_chat_schema_catalog/);
assert.match(String(raised.message), /reorder_plan_v/);
await q(`insert into public.silo_chat_schema_catalog (relname, relkind) values ('reorder_plan_v', 'table')`);
await apply();

// ── 6. Idempotence ────────────────────────────────────────────────────────
check('re-applying changes nothing');
const before = await q('select relname, description, keywords, is_hidden from public.silo_chat_schema_catalog order by relname');
await apply();
await apply();
const after = await q('select relname, description, keywords, is_hidden from public.silo_chat_schema_catalog order by relname');
assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)),
  'the migration is not idempotent');

console.log(`${checks} catalog coverage checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
