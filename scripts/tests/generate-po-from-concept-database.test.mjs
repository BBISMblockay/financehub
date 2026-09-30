// Generate PO from a concept, against real PostgreSQL (PGlite).
//
// 20260930000000_generate_po_from_concept_uniq.sql does two things, both
// tested here from the committed SQL (read from disk, not retyped):
//   1. po_headers.generated_from_concept_id with a PARTIAL unique index, so
//      Postgres refuses a second PO claiming one concept (PR #830 review:
//      two concurrent clicks made two full POs).
//   2. generate_po_from_concept(), which makes the header, its lines and the
//      po_concept_links row in ONE transaction (PR #830 Opus review, finding
//      2: the page wrote the header first, so a failed line insert left an
//      empty PO holding the claim, and every later click opened it).
//
// The function is SECURITY DEFINER, so its own checks are the boundary.
// Each refusal case asserts that nothing was written.
//
// Stated limits: a minimal stand-in schema (no RLS policies, which a DEFINER
// function bypasses anyway), and PGlite is one connection, so the FOR UPDATE
// serialisation is proven by outcome (a repeat returns the same PO), not by
// two genuinely concurrent sessions. The page's handling of the function's
// answers is in v2/tests/browser/po-builder-from-concept.test.js.
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
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role authenticated; create role anon;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;

  create function public.active_company_id() returns uuid language sql stable as $$
    select nullif(current_setting('test.company', true), '')::uuid $$;
  create function public.po_builder_can_write() returns boolean language sql stable as $$
    select coalesce(nullif(current_setting('test.can_write', true), ''), 'false')::boolean $$;
  create function public.silo_business_today() returns date language sql stable as $$ select date '2026-09-30' $$;

  create table public.factories (id uuid primary key default gen_random_uuid(), company_entity_id uuid not null);
  create table public.product_concepts (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
    title text, status text not null default 'draft', parent_concept_id uuid references public.product_concepts(id),
    suggested_qty integer, suggested_factory_id uuid, suggested_product_type text,
    suggested_size_breakdown jsonb, economics jsonb);
  create table public.po_headers (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, po_name text,
    factory_id uuid references public.factories(id), order_date date, req_ship_date date,
    status text default 'Draft', is_new_product_po boolean, wholesale_triggered boolean,
    created_by uuid, created_at timestamptz default now());
  create table public.po_lines (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid,
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    source_concept_id uuid, title_snapshot text, product_type_snapshot text, variant_title_snapshot text,
    qty numeric(12,2), unit_cost numeric(12,4), retail_price numeric(12,2), retail_value numeric(14,2), line_notes text);
  create table public.po_concept_links (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid,
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    concept_id uuid not null references public.product_concepts(id), created_by uuid,
    unique (po_header_id, concept_id));

  create function public.generate_next_po_name(p_factory_id uuid) returns text language sql as $$
    select 'PO-' || (count(*) + 1)::text from public.po_headers where factory_id = p_factory_id $$;

  -- Stands in for any failure after the header is written: a refused line.
  create function public.test_explode_line() returns trigger language plpgsql as $$
  begin
    if new.title_snapshot = 'EXPLODE' then raise exception 'line insert refused (test)'; end if;
    return new;
  end $$;
  create trigger po_lines_explode before insert on public.po_lines
    for each row execute function public.test_explode_line();
`);

const migrationSql = await readFile(new URL(MIGRATION, root), 'utf8');

const CO = randomUUID();
const OTHER_CO = randomUUID();
const USER = randomUUID();
let FACTORY; let OTHER_FACTORY;

async function as({ user = USER, company = CO, canWrite = true } = {}) {
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  await q("select set_config('test.company', $1, false)", [company || '']);
  await q("select set_config('test.can_write', $1, false)", [String(canWrite)]);
}
async function concept(o = {}) {
  const row = await one(`insert into public.product_concepts
      (company_entity_id, title, status, parent_concept_id, suggested_qty, suggested_factory_id,
       suggested_product_type, suggested_size_breakdown, economics)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [
    o.company ?? CO, o.title ?? 'Sonic summer drop', o.status ?? 'approved', o.parent ?? null,
    o.qty ?? 500, 'factory' in o ? o.factory : FACTORY, o.type ?? 'T-Shirts',
    o.breakdown === undefined ? null : JSON.stringify(o.breakdown),
    o.economics === undefined ? null : JSON.stringify(o.economics)]);
  return row.id;
}
const generate = async (id) => (await one('select public.generate_po_from_concept($1) as r', [id])).r;
const counts = async (id) => one(`select
    (select count(*)::int from public.po_headers where generated_from_concept_id = $1) as headers,
    (select count(*)::int from public.po_lines where source_concept_id = $1) as lines,
    (select count(*)::int from public.po_concept_links where concept_id = $1) as links`, [id]);
async function refuses(id, pattern, label) {
  await assert.rejects(() => generate(id), (e) => pattern.test(e.message), label);
  assert.deepEqual(await counts(id), { headers: 0, lines: 0, links: 0 }, `${label}: nothing may be written`);
}

await test('the migration applies cleanly', async () => { await db.exec(migrationSql); });
await test('the migration is idempotent', async () => { await db.exec(migrationSql); });

await test('the column and its partial unique index exist', async () => {
  const idx = await one(`select indexdef from pg_indexes
    where schemaname='public' and tablename='po_headers' and indexname='po_headers_generated_from_concept_uniq'`);
  assert.ok(idx);
  assert.match(idx.indexdef, /unique/i);
  assert.match(idx.indexdef, /where.*generated_from_concept_id is not null/i);
});

FACTORY = (await one('insert into public.factories (company_entity_id) values ($1) returning id', [CO])).id;
OTHER_FACTORY = (await one('insert into public.factories (company_entity_id) values ($1) returning id', [OTHER_CO])).id;

await test('anon cannot execute the function; authenticated can; PUBLIC has no grant', async () => {
  const r = await one(`select
    has_function_privilege('anon', 'public.generate_po_from_concept(uuid)', 'execute') as anon,
    has_function_privilege('authenticated', 'public.generate_po_from_concept(uuid)', 'execute') as auth,
    exists (select 1 from pg_proc p, aclexplode(p.proacl) a
            where p.proname = 'generate_po_from_concept' and a.grantee = 0) as public_grant,
    (select prosecdef from pg_proc where proname = 'generate_po_from_concept') as definer`);
  assert.deepEqual(r, { anon: false, auth: true, public_grant: false, definer: true });
});

let sized; let sizedPo;
await test('a fresh generation makes the header, one line per positive size, and the link', async () => {
  sized = await concept({ breakdown: { S: 10, M: 0, L: '5', XL: 'abc', XXL: -3 }, economics: { unit_cost: '4.25', msrp: 32 } });
  await as();
  await db.exec('set role authenticated');
  const r = await generate(sized);
  await db.exec('reset role');
  assert.equal(r.repeated, false);
  assert.equal(r.line_count, 2);
  sizedPo = r.po_header_id;
  const h = await one('select * from public.po_headers where id = $1', [sizedPo]);
  assert.equal(h.company_entity_id, CO);
  assert.equal(h.factory_id, FACTORY);
  assert.equal(h.generated_from_concept_id, sized);
  assert.equal(h.status, 'Draft');
  assert.equal(h.is_new_product_po, true);
  assert.equal(h.created_by, USER);
  assert.equal(h.po_name, 'PO-1');
  const lines = await q(`select variant_title_snapshot as size, qty::text, unit_cost::text, retail_price::text,
      retail_value::text, title_snapshot, product_type_snapshot, company_entity_id, line_notes
    from public.po_lines where po_header_id = $1 order by variant_title_snapshot`, [sizedPo]);
  assert.deepEqual(lines.map((l) => [l.size, l.qty, l.unit_cost, l.retail_price, l.retail_value]), [
    ['L', '5.00', '4.2500', '32.00', '160.00'],
    ['S', '10.00', '4.2500', '32.00', '320.00'],
  ]);
  assert.ok(lines.every((l) => l.company_entity_id === CO && l.title_snapshot === 'Sonic summer drop'
    && l.product_type_snapshot === 'T-Shirts' && l.line_notes === 'From concept: Sonic summer drop'));
  assert.deepEqual(await counts(sized), { headers: 1, lines: 2, links: 1 });
});

await test('a repeat returns the SAME PO and writes nothing', async () => {
  await as();
  const r = await generate(sized);
  assert.deepEqual([r.po_header_id, r.repeated], [sizedPo, true]);
  assert.deepEqual(await counts(sized), { headers: 1, lines: 2, links: 1 });
});

await test('a failure after the header rolls back the header too, so the claim is not sticky', async () => {
  const c = await concept({ title: 'EXPLODE' });
  await as();
  await assert.rejects(() => generate(c), /line insert refused/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0 }, 'no empty PO may be left holding the claim');
  await q("update public.product_concepts set title = 'Fixed' where id = $1", [c]);
  const r = await generate(c);
  assert.equal(r.repeated, false, 'the next attempt generates a real PO rather than finding an empty one');
  assert.deepEqual(await counts(c), { headers: 1, lines: 1, links: 1 });
});

await test('no breakdown: one line at suggested_qty; unparseable economics are NULL, never guessed', async () => {
  const c = await concept({ qty: 240, economics: { unit_cost: 'about 4', msrp: 0 } });
  await as();
  const r = await generate(c);
  const l = await one('select qty::text, unit_cost, retail_price, retail_value::text, variant_title_snapshot from public.po_lines where po_header_id = $1', [r.po_header_id]);
  assert.deepEqual(l, { qty: '240.00', unit_cost: null, retail_price: null, retail_value: '0.00', variant_title_snapshot: null });
});

await test('a breakdown with no positive size falls back to the single suggested_qty line', async () => {
  const c = await concept({ qty: 12, breakdown: { S: 0, M: '0' } });
  await as();
  const r = await generate(c);
  assert.equal(r.line_count, 1);
  const l = await one('select qty::text from public.po_lines where po_header_id = $1', [r.po_header_id]);
  assert.equal(l.qty, '12.00');
});

await test('refuses without purchasing permission', async () => {
  const c = await concept();
  await as({ canWrite: false });
  await refuses(c, /Purchasing permission/, 'no permission');
});

await test('refuses without a signed-in user or an active company', async () => {
  const c = await concept();
  await as({ user: null });
  await refuses(c, /Purchasing permission/, 'no user');
  await as({ company: null });
  await refuses(c, /Purchasing permission/, 'no company');
});

await test('a concept in another company reads as not found', async () => {
  const c = await concept({ company: OTHER_CO, factory: OTHER_FACTORY });
  await as();
  await refuses(c, /Concept not found/, 'other company');
});

await test('refuses an archived concept', async () => {
  const c = await concept({ status: 'archived' });
  await as();
  await refuses(c, /archived/, 'archived');
});

await test('refuses a collection parent with a live child, allows one whose children are all archived', async () => {
  const parent = await concept({ title: 'Collection' });
  const child = await concept({ title: 'Child', parent });
  await as();
  await refuses(parent, /collection/, 'collection parent');
  await q("update public.product_concepts set status = 'archived' where id = $1", [child]);
  const r = await generate(parent);
  assert.equal(r.repeated, false);
});

await test('refuses a concept with no factory, or a factory in another company', async () => {
  await as();
  await refuses(await concept({ factory: null }), /no suggested factory/, 'no factory');
  await refuses(await concept({ factory: OTHER_FACTORY }), /not in the active company/, 'foreign factory');
});

await test('an existing PO stays reachable after its concept is archived', async () => {
  await q("update public.product_concepts set status = 'archived' where id = $1", [sized]);
  await as();
  const r = await generate(sized);
  assert.deepEqual([r.po_header_id, r.repeated], [sizedPo, true]);
});

await test('deleting the generated PO frees the concept to generate again', async () => {
  const c = await concept();
  await as();
  const first = await generate(c);
  await q('delete from public.po_headers where id = $1', [first.po_header_id]);
  const second = await generate(c);
  assert.equal(second.repeated, false);
  assert.notEqual(second.po_header_id, first.po_header_id);
});

await test('the unique index still refuses a second claim from any other writer', async () => {
  await assert.rejects(
    () => q('insert into public.po_headers (generated_from_concept_id) values ($1)', [sized]),
    /po_headers_generated_from_concept_uniq/);
});

await test('rows with no claim (every other PO path) are unaffected', async () => {
  for (let i = 0; i < 3; i += 1) await q('insert into public.po_headers (generated_from_concept_id) values (null)');
});

await test('anon calling it is refused by the grant, not by luck', async () => {
  const c = await concept();
  await as();
  await db.exec('set role anon');
  try {
    await assert.rejects(() => generate(c), /permission denied/);
  } finally { await db.exec('reset role'); }
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0 });
});

console.log(`\ngenerate-po-from-concept-database: ${passed} database regression cases passed`);
