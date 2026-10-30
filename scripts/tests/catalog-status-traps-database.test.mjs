/* The four status traps that are documented rather than fixed.
 *
 * 20261030150000 is text in silo_chat_schema_catalog and changes no row, so
 * what can go wrong is narrow and worth pinning: an append that fires twice
 * (the description grows on every apply), an append that replaces an existing
 * description instead of adding to it, a relation named wrongly so the warning
 * lands nowhere, and a `reportable` flag that does not get set.
 *
 * Each guard has a mutation below. Runs on PGlite against a stand-in catalog.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const MIGRATION = '20261030150000_catalog_status_traps.sql';
const MUTATIONS = ['', 'no-append-guard', 'clobber-description', 'no-reportable'];
const mutation = process.env.CATALOG_TRAPS_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];

let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

await db.exec(`
  create table public.silo_chat_schema_catalog (
    relname text primary key,
    relkind text not null,
    columns jsonb not null default '[]'::jsonb,
    description text,
    keywords text[],
    is_hidden boolean not null default false,
    reportable boolean not null default false,
    report_priority smallint not null default 0,
    auto_refreshed_at timestamptz,
    updated_at timestamptz not null default now()
  );
`);

// The catalog as production holds it: two relations carry a real description
// the migration must APPEND to, and three carry none at all.
const EXISTING_LAUNCH = 'Marketing launch pipeline. The name column is title.';
const EXISTING_PO = 'Purchase order headers -- what has been ORDERED but may not have arrived yet.';
const EXISTING_ORDERS = 'One row per Shopify order (base table; prefer shopify_orders_v).';
const EXISTING_RETURNS = 'Returns/exchanges/store-credit data from Redo.';
const rows = [
  ['launch_calendar', EXISTING_LAUNCH, false],
  ['po_headers', EXISTING_PO, false],
  ['po_status_history', null, false],
  ['incoming_shipments', null, true],
  ['shopify_orders', EXISTING_ORDERS, true],
  ['redo_returns', EXISTING_RETURNS, true],
  ['redo_return_items', null, true],
  // is_hidden, and deliberately left undescribed by the migration.
  ['ad_platform_connections', null, false]
];
for (const [relname, description, reportable] of rows) {
  await q(`insert into public.silo_chat_schema_catalog (relname, relkind, description, reportable, is_hidden)
           values ($1, 'table', $2, $3, $4)`,
    [relname, description, reportable, relname === 'ad_platform_connections']);
}

// ── Apply the migration, optionally mutated ────────────────────────────────
const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
let sql = original;
if (mutation === 'no-append-guard') {
  // Drop every "only if the marker is absent" clause, so a second apply
  // appends the same paragraph again.
  sql = sql.replace(/\n  and coalesce\(description, ''\) not like '%[^']*%'/g, '');
}
if (mutation === 'clobber-description') {
  // Replace rather than append, losing what was already there.
  sql = sql.replace(/description = coalesce\(description, ''\) \|\|/g, 'description =');
}
if (mutation === 'no-reportable') {
  sql = sql.replace(/update public\.silo_chat_schema_catalog set\n  reportable = true\nwhere relname = 'po_status_history';/,
    'select 1;');
}
assert.ok(!mutation || sql !== original,
  `mutation ${mutation} changed nothing -- the migration no longer looks the way it did`);

const apply = async () => {
  for (const statement of splitSqlStatements(sql)) {
    if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
    await db.exec(statement.text);
  }
};
await apply();

const cat = (relname) =>
  first('select * from public.silo_chat_schema_catalog where relname = $1', [relname]);

// ── 1. Each trap is named, on the relation a bot would read ───────────────
const MARKERS = [
  ['launch_calendar', 'STATUS IS NOT MAINTAINED'],
  ['po_headers', 'NO ARRIVAL DATE ON THIS TABLE'],
  ['shopify_orders', 'CANCELLED ORDERS KEEP THEIR FINANCIAL STATUS'],
  ['redo_returns', 'STATUS EXISTS AT TWO GRAINS'],
  ['redo_return_items', 'STATUS EXISTS AT TWO GRAINS']
];
for (const [relname, marker] of MARKERS) {
  check(`${relname} carries its warning`);
  assert.ok((await cat(relname)).description.includes(marker),
    `${relname} is missing ${marker}`);
}

check('each warning says what to use INSTEAD, not only what is wrong');
assert.match((await cat('launch_calendar')).description, /Use the DATE/);
assert.match((await cat('po_headers')).description, /read po_status_history/);
assert.match((await cat('shopify_orders')).description, /cancelled_at is null/);
assert.match((await cat('redo_returns')).description, /name the grain/);

check('the relations that had no description at all now have one');
for (const relname of ['po_status_history', 'incoming_shipments', 'redo_return_items']) {
  const r = await cat(relname);
  assert.ok(r.description && r.description.length > 200, `${relname} has no usable description`);
  assert.ok(r.keywords && r.keywords.length > 0, `${relname} has no keywords, so it is not findable`);
}

check('po_status_history is pointed at as the arrival-date source');
assert.match((await cat('po_status_history')).description, /WHERE PO DATES THAT ACTUALLY HAPPENED LIVE/);
assert.match((await cat('po_status_history')).description, /2026-04-28/,
  'it must say when history starts, so an older PO reads as not measurable');

check('po_status_history joins the report builder allowlist');
assert.equal((await cat('po_status_history')).reportable, true,
  'a PO lead-time report cannot be built without it');

check('incoming_shipments says what it does NOT cover');
assert.match((await cat('incoming_shipments')).description, /NOT a complete record/);

check('the hidden connection table is left alone');
const hidden = await cat('ad_platform_connections');
assert.equal(hidden.description, null,
  'a description on a hidden relation would never be read; it must not be written');
assert.equal(hidden.reportable, false);

// ── 2. Appending, not replacing ───────────────────────────────────────────
check('an existing description is kept in front of the appended warning');
for (const [relname, existing] of [
  ['launch_calendar', EXISTING_LAUNCH],
  ['po_headers', EXISTING_PO],
  ['shopify_orders', EXISTING_ORDERS],
  ['redo_returns', EXISTING_RETURNS]
]) {
  const d = (await cat(relname)).description;
  assert.ok(d.startsWith(existing), `${relname}: the original description was clobbered`);
}

// ── 3. Idempotence, which is the whole risk in an append ──────────────────
check('re-applying appends nothing a second time');
const before = await q('select relname, description, keywords, reportable from public.silo_chat_schema_catalog order by relname');
await apply();
await apply();
const after = await q('select relname, description, keywords, reportable from public.silo_chat_schema_catalog order by relname');
assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)),
  'the migration is not idempotent -- a description grows on every apply');

check('no warning appears twice in one description');
for (const [relname, marker] of MARKERS) {
  const d = (await cat(relname)).description;
  assert.equal(d.split(marker).length - 1, 1, `${relname} carries ${marker} more than once`);
}

console.log(`${checks} catalog status-trap checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
