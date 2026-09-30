// Generate PO from a concept, against real PostgreSQL (PGlite).
//
// Applies BOTH committed migrations, in order, exactly as production has
// them (read from disk, not retyped):
//   20260930000000  po_headers.generated_from_concept_id + its partial unique
//                   index, and generate_po_from_concept(): header, lines and
//                   link in ONE transaction, a repeat returns the same PO
//   20260930120000  product_concept_po_missing(), the one definition of
//                   "ready for a PO"; product_concepts_v.po_missing; and the
//                   function rewritten to refuse an incomplete concept and
//                   take lines only from the size breakdown
//
// The second exists because the first live Generate PO (2026-09-30) made one
// flat 1,400-unit line at $0 from a concept with no sizes, cost or retail.
//
// The stand-in schema uses production's REAL column types, measured
// 2026-09-30: po_lines.qty is INTEGER and money columns are numeric(12,2).
// The first version of this file assumed numeric qty, which is how a
// fractional size would have been silently rounded without any test noticing.
//
// Limits, stated: no RLS policies (the function is SECURITY DEFINER and does
// its own checks), and PGlite is one connection, so FOR UPDATE serialisation
// is proven by outcome, not by two concurrent sessions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const MIGRATIONS = [
  'supabase/migrations/20260930000000_generate_po_from_concept_uniq.sql',
  'supabase/migrations/20260930120000_concept_po_readiness.sql',
];

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const sql = await Promise.all(MIGRATIONS.map((m) => readFile(new URL(m, root), 'utf8')));

// Every concept column the view names, so the view really compiles. Columns
// the tests touch get their production types; the rest only need to exist.
const typed = {
  id: 'uuid primary key default gen_random_uuid()', company_entity_id: 'uuid not null',
  title: 'text', status: "text not null default 'draft'", parent_concept_id: 'uuid references public.product_concepts(id)',
  suggested_qty: 'integer', suggested_factory_id: 'uuid', suggested_product_type: 'text',
  suggested_size_breakdown: 'jsonb', economics: 'jsonb', created_by: 'uuid', approved_by: 'uuid',
  resulting_po_header_id: 'uuid', current_revision_number: 'integer',
};
const viewCols = [...new Set([...sql[1].matchAll(/\bc\.(\w+)/g)].map((m) => m[1]))];
const conceptCols = [...new Set([...Object.keys(typed), ...viewCols])]
  .map((c) => `${c} ${typed[c] || 'text'}`).join(', ');

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
  create function public.refresh_chat_schema_catalog() returns void language plpgsql as $$ begin end $$;

  create table public.profiles (id uuid primary key, name text);
  create table public.factories (id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, factory_name text);
  create table public.product_concepts (${conceptCols});
  create table public.product_concept_revisions (id uuid primary key default gen_random_uuid(), concept_id uuid);
  create table public.po_headers (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, po_name text,
    factory_id uuid references public.factories(id), order_date date, req_ship_date date,
    status text default 'Draft', is_new_product_po boolean, wholesale_triggered boolean,
    created_by uuid, created_at timestamptz default now());
  create table public.po_lines (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid,
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    source_concept_id uuid, title_snapshot text, product_type_snapshot text, variant_title_snapshot text,
    qty integer, unit_cost numeric(12,2), retail_price numeric(12,2), retail_value numeric(12,2), line_notes text);
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
    if new.variant_title_snapshot = 'EXPLODE' then raise exception 'line insert refused (test)'; end if;
    return new;
  end $$;
  create trigger po_lines_explode before insert on public.po_lines
    for each row execute function public.test_explode_line();
`);

const CO = randomUUID();
const OTHER_CO = randomUUID();
const USER = randomUUID();
let FACTORY; let OTHER_FACTORY;

async function as({ user = USER, company = CO, canWrite = true } = {}) {
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  await q("select set_config('test.company', $1, false)", [company || '']);
  await q("select set_config('test.can_write', $1, false)", [String(canWrite)]);
}

// A COMPLETE concept by default; each test removes what it is about.
const COMPLETE = () => ({
  title: 'Sonic summer tee', status: 'approved', qty: 100, type: 'T-Shirts',
  breakdown: { S: 20, M: 40, L: 30, XL: 10 }, economics: { unit_cost: 6.4, msrp: 38 },
});
async function concept(overrides = {}) {
  const o = { ...COMPLETE(), factory: FACTORY, company: CO, parent: null, ...overrides };
  const row = await one(`insert into public.product_concepts
      (company_entity_id, title, status, parent_concept_id, suggested_qty, suggested_factory_id,
       suggested_product_type, suggested_size_breakdown, economics)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [
    o.company, o.title, o.status, o.parent, o.qty, o.factory, o.type,
    o.breakdown == null ? null : JSON.stringify(o.breakdown),
    o.economics == null ? null : JSON.stringify(o.economics)]);
  return row.id;
}
const missingFor = async (id) => (await one(
  'select public.product_concept_po_missing(c) as m from public.product_concepts c where id = $1', [id])).m;
const generate = async (id) => (await one('select public.generate_po_from_concept($1) as r', [id])).r;
const counts = async (id) => one(`select
    (select count(*)::int from public.po_headers where generated_from_concept_id = $1) as headers,
    (select count(*)::int from public.po_lines where source_concept_id = $1) as lines,
    (select count(*)::int from public.po_concept_links where concept_id = $1) as links`, [id]);
async function refuses(id, pattern, label) {
  await assert.rejects(() => generate(id), (e) => pattern.test(e.message), label);
  assert.deepEqual(await counts(id), { headers: 0, lines: 0, links: 0 }, `${label}: nothing may be written`);
}

await test('both migrations apply cleanly, in order', async () => { for (const s of sql) await db.exec(s); });
await test('and apply a second time (idempotent)', async () => { for (const s of sql) await db.exec(s); });

FACTORY = (await one("insert into public.factories (company_entity_id, factory_name) values ($1, 'Incotexco') returning id", [CO])).id;
OTHER_FACTORY = (await one('insert into public.factories (company_entity_id) values ($1) returning id', [OTHER_CO])).id;

// ── Readiness: the one definition ────────────────────────────────────────
await test('a complete concept is ready: po_missing is empty', async () => {
  assert.deepEqual(await missingFor(await concept()), []);
});

await test('the Bat Bros shape (approved, factory, type, qty; nothing else) names exactly what is missing', async () => {
  const id = await concept({ breakdown: null, economics: null, qty: 1400 });
  assert.deepEqual(await missingFor(id), ['Size breakdown', 'Unit cost (FOB)', 'Retail price']);
});

await test('each requirement is reported on its own', async () => {
  assert.deepEqual(await missingFor(await concept({ status: 'draft' })), ['Approval']);
  assert.deepEqual(await missingFor(await concept({ factory: null })), ['Factory']);
  assert.deepEqual(await missingFor(await concept({ type: '  ' })), ['Product type']);
  assert.deepEqual(await missingFor(await concept({ breakdown: {} })), ['Size breakdown']);
  assert.deepEqual(await missingFor(await concept({ breakdown: { S: 0, M: 0 } })), ['Size breakdown']);
  assert.deepEqual(await missingFor(await concept({ economics: { msrp: 38 } })), ['Unit cost (FOB)']);
  assert.deepEqual(await missingFor(await concept({ economics: { unit_cost: 6.4 } })), ['Retail price']);
});

await test('a fractional, negative, non-numeric or oversized size is refused, never rounded', async () => {
  for (const bad of [{ S: 20.5, M: 79.5 }, { S: -5, M: 105 }, { S: 'twenty', M: 80 }, { S: { n: 1 }, M: 99 }, { S: 2000000 }]) {
    const m = await missingFor(await concept({ breakdown: bad, qty: null }));
    assert.deepEqual(m, ['Whole-unit quantity for every size'], JSON.stringify(bad));
  }
});

await test('sizes must add up to the suggested quantity, and the message says both numbers', async () => {
  const m = await missingFor(await concept({ qty: 120 }));
  assert.equal(m.length, 1);
  assert.match(m[0], /adding up to the suggested quantity \(120, sizes total 100\)/);
  assert.deepEqual(await missingFor(await concept({ qty: null })), [], 'no suggested quantity: the sizes stand alone');
});

await test('cost and retail: numeric strings accepted; zero, junk and out-of-bounds values read as missing', async () => {
  assert.deepEqual(await missingFor(await concept({ economics: { unit_cost: '6.40', msrp: '38' } })), []);
  for (const [econ, want] of [
    [{ unit_cost: 0, msrp: 38 }, ['Unit cost (FOB)']],
    [{ unit_cost: 'about 6', msrp: 38 }, ['Unit cost (FOB)']],
    [{ unit_cost: 6.4, msrp: 10000 }, ['Retail price']],
    [{ unit_cost: 100000, msrp: 38 }, ['Unit cost (FOB)']],
    [[6.4, 38], ['Unit cost (FOB)', 'Retail price']],
  ]) assert.deepEqual(await missingFor(await concept({ economics: econ })), want, JSON.stringify(econ));
});

await test('product_concepts_v exposes the same answer as po_missing', async () => {
  const id = await concept({ economics: null });
  const r = await one('select po_missing from public.product_concepts_v where id = $1', [id]);
  assert.deepEqual(r.po_missing, ['Unit cost (FOB)', 'Retail price']);
});

await test('grants: anon may execute neither function; authenticated may execute both', async () => {
  const r = await one(`select
    has_function_privilege('anon', 'public.generate_po_from_concept(uuid)', 'execute') as anon_gen,
    has_function_privilege('anon', 'public.product_concept_po_missing(public.product_concepts)', 'execute') as anon_ready,
    has_function_privilege('authenticated', 'public.generate_po_from_concept(uuid)', 'execute') as auth_gen,
    has_function_privilege('authenticated', 'public.product_concept_po_missing(public.product_concepts)', 'execute') as auth_ready,
    (select prosecdef from pg_proc where proname = 'generate_po_from_concept') as definer`);
  assert.deepEqual(r, { anon_gen: false, anon_ready: false, auth_gen: true, auth_ready: true, definer: true });
});

// ── Generate PO ──────────────────────────────────────────────────────────
let ready; let readyPo;
await test('a complete concept generates one line per size, with cost, retail and value', async () => {
  ready = await concept({ breakdown: { S: 20, M: 40, L: 30, XL: 10, '3XL': 0 } });
  await as();
  await db.exec('set role authenticated');
  const r = await generate(ready);
  await db.exec('reset role');
  assert.deepEqual([r.repeated, r.line_count], [false, 4]);
  readyPo = r.po_header_id;
  const h = await one('select * from public.po_headers where id = $1', [readyPo]);
  assert.deepEqual([h.company_entity_id, h.factory_id, h.generated_from_concept_id, h.status, h.is_new_product_po, h.created_by],
    [CO, FACTORY, ready, 'Draft', true, USER]);
  const lines = await q(`select variant_title_snapshot as size, qty, unit_cost::text, retail_price::text, retail_value::text
    from public.po_lines where po_header_id = $1 order by variant_title_snapshot`, [readyPo]);
  assert.deepEqual(lines.map((l) => [l.size, l.qty, l.unit_cost, l.retail_price, l.retail_value]), [
    ['L', 30, '6.40', '38.00', '1140.00'],
    ['M', 40, '6.40', '38.00', '1520.00'],
    ['S', 20, '6.40', '38.00', '760.00'],
    ['XL', 10, '6.40', '38.00', '380.00'],
  ], 'a 0 size is skipped, never a 0-unit line');
  assert.deepEqual(await counts(ready), { headers: 1, lines: 4, links: 1 });
});

await test('THE BUG: the Bat Bros shape is refused, naming what is missing, and writes nothing', async () => {
  const id = await concept({ title: 'Bat Bros Youth Hoodie', type: 'Youth Sweatshirt', qty: 1400, breakdown: null, economics: null });
  await as();
  await refuses(id, /not ready for a PO\. Missing: Size breakdown; Unit cost \(FOB\); Retail price/, 'bat bros');
});

await test('an unapproved draft is refused', async () => {
  await as();
  await refuses(await concept({ status: 'draft' }), /Missing: Approval/, 'draft');
});

await test('a fractional size is refused rather than rounded into the integer column', async () => {
  await as();
  await refuses(await concept({ breakdown: { S: 20.5, M: 79.5 } }), /Whole-unit quantity/, 'fractional');
});

await test('a repeat returns the SAME PO and writes nothing, even if the concept has since become incomplete', async () => {
  await q('update public.product_concepts set economics = null where id = $1', [ready]);
  await as();
  const r = await generate(ready);
  assert.deepEqual([r.po_header_id, r.repeated], [readyPo, true]);
  assert.deepEqual(await counts(ready), { headers: 1, lines: 4, links: 1 });
});

await test('a failure after the header rolls the header back too, so the claim is not sticky', async () => {
  const id = await concept({ breakdown: { S: 50, EXPLODE: 50 } });
  await as();
  await assert.rejects(() => generate(id), /line insert refused/);
  assert.deepEqual(await counts(id), { headers: 0, lines: 0, links: 0 }, 'no empty PO may be left holding the claim');
  await q(`update public.product_concepts set suggested_size_breakdown = '{"S":50,"M":50}' where id = $1`, [id]);
  const r = await generate(id);
  assert.equal(r.repeated, false, 'the next attempt makes a real PO rather than finding an empty one');
});

await test('refuses without purchasing permission, a user, or an active company', async () => {
  const id = await concept();
  await as({ canWrite: false }); await refuses(id, /Purchasing permission/, 'no permission');
  await as({ user: null }); await refuses(id, /Purchasing permission/, 'no user');
  await as({ company: null }); await refuses(id, /Purchasing permission/, 'no company');
});

await test('a concept in another company reads as not found', async () => {
  const id = await concept({ company: OTHER_CO, factory: OTHER_FACTORY });
  await as();
  await refuses(id, /Concept not found/, 'other company');
});

await test('archived and collection parents are refused before readiness is even asked', async () => {
  await as();
  await refuses(await concept({ status: 'archived' }), /archived/, 'archived');
  const parent = await concept({ title: 'Collection' });
  const child = await concept({ title: 'Child', parent });
  await refuses(parent, /collection/, 'collection parent');
  await q("update public.product_concepts set status = 'archived' where id = $1", [child]);
  assert.equal((await generate(parent)).repeated, false, 'a parent whose children are all archived is a single product again');
});

await test('a factory in another company is refused', async () => {
  await as();
  await refuses(await concept({ factory: OTHER_FACTORY }), /not in the active company/, 'foreign factory');
});

await test('deleting the generated PO frees the concept to generate again', async () => {
  const id = await concept();
  await as();
  const first = await generate(id);
  await q('delete from public.po_headers where id = $1', [first.po_header_id]);
  const second = await generate(id);
  assert.equal(second.repeated, false);
  assert.notEqual(second.po_header_id, first.po_header_id);
});

await test('the unique index still refuses a second claim from any other writer', async () => {
  await assert.rejects(
    () => q('insert into public.po_headers (generated_from_concept_id) values ($1)', [ready]),
    /po_headers_generated_from_concept_uniq/);
  for (let i = 0; i < 3; i += 1) await q('insert into public.po_headers (generated_from_concept_id) values (null)');
});

await test('anon calling it is refused by the grant', async () => {
  const id = await concept();
  await as();
  await db.exec('set role anon');
  try { await assert.rejects(() => generate(id), /permission denied/); } finally { await db.exec('reset role'); }
  assert.deepEqual(await counts(id), { headers: 0, lines: 0, links: 0 });
});

console.log(`\ngenerate-po-from-concept-database: ${passed} database regression cases passed`);
