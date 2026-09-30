// Generate PO from a concept: the duplicate-PO race guard, against real
// PostgreSQL (PGlite). PR #830 supplemental review reproduced the bug by
// running the committed page functions against a mocked store enforcing
// po_concept_links' actual constraint: two concurrent "Generate PO"
// attempts for one concept each created a FULL DUPLICATE po_headers row
// (and its own lines) before either inserted a po_concept_links row --
// whose own uniqueness is (po_header_id, concept_id), which does not fire
// across two DIFFERENT headers.
//
// 20260930000000_generate_po_from_concept_uniq.sql closes the race at the
// earliest possible point instead: po_headers.generated_from_concept_id
// plus a PARTIAL UNIQUE INDEX (only where non-null), so the INSERT ITSELF
// is what Postgres arbitrates. This test applies that migration's actual,
// committed SQL (read from disk, not re-typed here) against a minimal
// stand-in schema and proves the constraint:
//   - applies cleanly, twice (idempotent, matches every migration in this repo)
//   - a first insert for a concept succeeds
//   - a second insert for the SAME concept is REJECTED (23505) -- this is
//     the mechanism v2/po-builder.html's generateFromConceptDeepLink()
//     relies on to detect it lost a race, not a client-side check-then-act
//   - any number of rows with NO claim (null) insert freely -- every OTHER
//     PO creation path (manual, catalog, the concept-picker modal adding to
//     an already-open PO) never sets this column and must be unaffected
//
// What this does NOT prove, stated rather than implied: this is a minimal
// stand-in schema, not the full po_headers/product_concepts/RLS chain (no
// RLS is involved in this fix at all -- the migration adds a column and an
// index, nothing policy-related), and PGlite is one embedded connection, so
// this is a SEQUENTIAL proof of the constraint's outcome, not two genuinely
// concurrent PostgreSQL sessions -- the same stated boundary
// scripts/tests/finance-db/README.md already draws for this repo's other
// PGlite suites. The PAGE'S reaction to hitting this constraint (opening
// the winner's PO, or failing safely when it can't be found) is covered
// separately in v2/tests/browser/po-builder-from-concept.test.js.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20260930000000_generate_po_from_concept_uniq.sql';

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

await db.exec(`
  create table product_concepts (id uuid primary key default gen_random_uuid());
  create table po_headers (id uuid primary key default gen_random_uuid());
`);

const migrationSql = await readFile(new URL(MIGRATION, root), 'utf8');

await test('the migration applies cleanly against the minimal schema', async () => {
  await db.exec(migrationSql);
});

await test('the migration is idempotent -- applies a second time with no error', async () => {
  await db.exec(migrationSql);
});

await test('the column and its partial unique index both exist afterward', async () => {
  const col = await one(`select 1 as x from information_schema.columns
    where table_schema='public' and table_name='po_headers' and column_name='generated_from_concept_id'`);
  assert.ok(col, 'generated_from_concept_id column missing');
  const idx = await one(`select indexdef from pg_indexes
    where schemaname='public' and tablename='po_headers' and indexname='po_headers_generated_from_concept_uniq'`);
  assert.ok(idx, 'po_headers_generated_from_concept_uniq index missing');
  assert.match(idx.indexdef, /unique/i, 'index is not unique');
  assert.match(idx.indexdef, /where.*generated_from_concept_id is not null/i, 'index is not the intended partial index');
});

const concept = randomUUID();
await test('the referenced concept row exists (the FK the migration adds)', async () => {
  await db.query('insert into product_concepts (id) values ($1)', [concept]);
});

let firstHeaderId;
await test('a first "Generate PO" claim for this concept succeeds', async () => {
  const row = await one(
    'insert into po_headers (generated_from_concept_id) values ($1) returning id', [concept]);
  firstHeaderId = row.id;
  assert.ok(firstHeaderId);
});

await test('a SECOND claim for the SAME concept is rejected -- the exact race this migration closes', async () => {
  await assert.rejects(
    () => db.query('insert into po_headers (generated_from_concept_id) values ($1)', [concept]),
    (err) => /duplicate key value violates unique constraint "po_headers_generated_from_concept_uniq"/.test(err.message),
    'the second insert for one concept must fail with THIS unique constraint',
  );
});

await test('the loser can find the winner\'s PO by the same column the constraint guards', async () => {
  const row = await one('select id from po_headers where generated_from_concept_id = $1', [concept]);
  assert.equal(row.id, firstHeaderId, 'the recoverable row must be the one that actually won');
});

await test('a THIRD concurrent attempt is rejected too -- not just the second', async () => {
  await assert.rejects(
    () => db.query('insert into po_headers (generated_from_concept_id) values ($1)', [concept]),
  );
});

await test('rows with NO claim (null) -- every other PO creation path -- are completely unaffected', async () => {
  for (let i = 0; i < 5; i += 1) {
    await db.query('insert into po_headers (generated_from_concept_id) values (null)');
  }
  const nullCount = await one('select count(*)::int as n from po_headers where generated_from_concept_id is null');
  assert.equal(nullCount.n, 5, 'unrelated PO creations must never collide with each other');
});

await test('a DIFFERENT concept claims independently, unaffected by the first', async () => {
  const other = randomUUID();
  await db.query('insert into product_concepts (id) values ($1)', [other]);
  const row = await one(
    'insert into po_headers (generated_from_concept_id) values ($1) returning id', [other]);
  assert.ok(row.id);
});

console.log(`\ngenerate-po-from-concept-database: ${passed} database regression cases passed`);
