// Product Studio "Ready for PO" gate against real PostgreSQL (PGlite).
//
// Applies the committed migrations from disk, in order: the Studio preview,
// the SKU spread, the Generate PO guard, then 20260930120000 (twice, to prove
// it is re-runnable). Every refusal asserts that nothing was written.
//
// Also runs the same readiness cases through v3/product-workflow-model.js's
// readinessIssues() and requires the SAME messages, so the on-page checklist
// cannot drift from the database rule.
//
// Stated limits: PGlite is one connection, so lock ordering and concurrent
// generation are proven by outcome here (repeat / cross-entry-point calls
// return one PO). scripts/tests/product-studio-ready-for-po-concurrency.sh
// runs two genuinely concurrent sessions against a real PostgreSQL when one
// is available. RLS policies are not modelled beyond grants: every writer is
// SECURITY DEFINER with its own checks, which is what is under test.
//
// MUTATE=<name> removes one guard; each must fail the suite (see sync-tests.yml).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { schemaSql } from './product-studio-ready-for-po-fixture.mjs';

const read = (p) => readFile(new URL('../../' + p, import.meta.url), 'utf8');
const sandbox = { window: {} }; vm.createContext(sandbox);
vm.runInContext(await read('v3/product-workflow-model.js'), sandbox);
const M = sandbox.window.SiloProductWorkflow;
const preview = await read('supabase/migrations/20260926082115_product_workflow_preview.sql');
const spread = await read('supabase/migrations/20260927074820_product_studio_variant_spread.sql');
const uniq = await read('supabase/migrations/20260930000000_generate_po_from_concept_uniq.sql');
let gate = await read('supabase/migrations/20260930120000_product_studio_ready_for_po.sql');

const MUTATIONS = {
  // mark-ready no longer runs the readiness rules
  'save-readiness': ["if cardinality(issues) > 0 then\n      raise exception 'Not ready for PO: %', array_to_string(issues, '; ') using errcode='22023';\n    end if;\n  end if;\n  -- The review boundary",
                     "if false then\n      raise exception 'x';\n    end if;\n  end if;\n  -- The review boundary"],
  // handoff no longer requires the brief to have been marked ready
  'handoff-ready': ["if b.po_ready_at is null then", "if false then"],
  // a concept change after readiness no longer blocks the PO
  'fingerprint': ["if public.product_concept_purchasing_fingerprint(concept) is distinct from b.po_ready_concept_fingerprint then", "if false then"],
  // the confirmation no longer has to match the lines
  'confirmation': ["or confirmed is distinct from actual then", "then"],
  // total vs size sum no longer compared
  'totals': ["if not bad_qty and stated is not null and total <> stated then", "if false then"],
  // direct client writes of concept lines/links no longer refused
  'guard': ["if current_user not in ('authenticated', 'anon') then return new; end if;", "return new;"],
  // one-size flag no longer limits the line count
  'one-size': ["if mode = 'one_size' and n <> 1 then", "if false then"],
  // a concept with a PO can be marked ready again
  'existing-po': ["    if existing_po is not null then\n      raise exception 'This concept already has PO %. Open", "    if false then\n      raise exception 'This concept already has PO %. Open"],
  // cycle-1 review: the generated claim may be cleared from the browser
  'claim-mutable': ["if tg_op = 'UPDATE' and old.generated_from_concept_id is not null", "if false and old.generated_from_concept_id is not null"],
  // cycle-1 review: the generated link may be deleted from the browser
  'link-deletable': ["where h.id = old.po_header_id and h.generated_from_concept_id = old.concept_id) then", "where false) then"],
  // cycle-1 review: the PO lookup trusts the link table alone
  'lookup-links-only': ["      where h.generated_from_concept_id = p_concept_id and h.company_entity_id = p_company\n      limit 1),", "      where false\n      limit 1),"],
  // cycle-1 review: launch-first strands a ready concept brief
  'launch-first': ["if b.launch_id is not null and b.source_kind <> 'concept' then", "if b.launch_id is not null then"],
};
if (process.env.MUTATE) {
  const [from, to] = MUTATIONS[process.env.MUTATE] || [];
  assert.ok(from && gate.includes(from), 'unknown or stale mutation ' + process.env.MUTATE);
  gate = gate.replace(from, to);
}

const db = new PGlite();
const A = randomUUID(), B = randomUUID();
const ADMIN = randomUUID(), VIEWER = randomUUID();
const FACTORY = randomUUID(), FOREIGN_FACTORY = randomUUID();
let checks = 0;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
const fail = (fn, pattern) => assert.rejects(fn, pattern);
async function as(id = ADMIN, co = A) {
  await db.exec('reset role');
  await q("select set_config('request.jwt.claim.sub',$1,false), set_config('test.company',$2,false)", [id || '', co || '']);
  await db.exec('set role authenticated');
}
async function superuser(fn) { await db.exec('reset role'); try { return await fn(); } finally { await db.exec('set role authenticated'); } }

await db.exec(schemaSql({ A, B, ADMIN, VIEWER, FACTORY, FOREIGN_FACTORY }));
await db.exec(preview);
await db.exec(spread);
await db.exec(uniq);

await test('the migration applies, and again (re-runnable)', async () => { await db.exec(gate); await db.exec(gate); });

// ---- helpers ---------------------------------------------------------------
async function concept(o = {}) {
  return (await superuser(() => one(`insert into public.product_concepts(company_entity_id,title,status,suggested_factory_id,parent_concept_id,
      suggested_qty,suggested_product_type,suggested_size_breakdown,concept_summary)
    values($1,$2,$3,$4,$5,$6,$7,$8,'Wear it') returning id`, [o.company ?? A, o.title ?? 'Tee', o.status ?? 'draft',
    'factory' in o ? o.factory : FACTORY, o.parent ?? null, o.qty ?? null, o.type ?? null,
    o.breakdown === undefined ? null : JSON.stringify(o.breakdown)]))).id;
}
const base = (o = {}) => ({ source_updated_at: '2026-09-30T00:00:00Z', title: 'Tee', design_intent: 'Everyday tee', product_type: 'T-Shirts', factory_id: FACTORY, decision_note: '', ...o });
function ready(lines, mode, total, extra = {}) {
  return base({ lines, po_readiness: { size_mode: mode, total_qty: total ?? lines.reduce((s, l) => s + Number(l.qty || 0), 0), range_confirmed: true, confirmed_lines: JSON.parse(JSON.stringify(M.confirmedLines(lines))) }, ...extra });
}
const save = async (id, version, status, content, source, co = A) =>
  (await one('select public.save_product_workflow_brief($1,$2,$3,$4,$5,$6,$7) b', [co, id, version, 'concept', source, content, status])).b;
const handoff = async (id, version, target = 'po', date = null) =>
  (await one('select public.handoff_product_workflow_brief($1,$2,$3,$4,$5) b', [A, id, version, target, date])).b;
const generate = async (cid) => (await one('select public.generate_po_from_concept($1) r', [cid])).r;
const counts = (cid) => superuser(() => one(`select
  (select count(*)::int from public.po_headers where generated_from_concept_id=$1) headers,
  (select count(*)::int from public.po_lines where source_concept_id=$1) lines,
  (select count(*)::int from public.po_concept_links where concept_id=$1) links,
  (select count(*)::int from public.product_workflow_briefs where source_id=$1 and po_ready_at is not null) ready`, [cid]));
const stage = async (cid) => (await one('select stage, ready_stale, po_header_id from public.product_studio_concepts_v where id=$1', [cid]));
const serverIssues = (cid, content) => superuser(async () => (await one('select public.product_concept_po_readiness_issues($1,$2,$3) i', [A, cid, content])).i);
async function parity(cid, content, ctx = {}) {
  const server = await serverIssues(cid, content);
  // JSON round-trip: the model runs in a vm realm, whose arrays are not this realm's.
  const client = JSON.parse(JSON.stringify(M.readinessIssues(content, { factoryIds: [FACTORY], ...ctx })));
  assert.deepEqual(client, server, 'client checklist must equal the database rule for ' + JSON.stringify(content.po_readiness));
  return server;
}

await as();

await test('grants: helpers are private, writers and the stage view are authenticated-only, nobody anonymous', async () => {
  const fn = async (sig) => one(`select has_function_privilege('anon',$1,'execute') anon, has_function_privilege('authenticated',$1,'execute') auth`, [sig]);
  for (const sig of ['public.product_concept_po_readiness_issues(uuid,uuid,jsonb)', 'public.product_concept_po_header(uuid,uuid)', 'public.guard_concept_po_writes()'])
    assert.deepEqual(await fn(sig), { anon: false, auth: false }, sig);
  for (const sig of ['public.save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text)', 'public.handoff_product_workflow_brief(uuid,uuid,integer,text,date)',
    'public.generate_po_from_concept(uuid)', 'public.product_concept_purchasing_fingerprint(public.product_concepts)'])
    assert.deepEqual(await fn(sig), { anon: false, auth: true }, sig);
  const v = await one(`select has_table_privilege('anon','public.product_studio_concepts_v','select') anon, has_table_privilege('authenticated','public.product_studio_concepts_v','select') auth`);
  assert.deepEqual(v, { anon: false, auth: true });
});

await test('an old APPROVED concept is not ready: Generate PO refuses and writes nothing', async () => {
  const c = await concept({ title: 'Bat Bros Youth Hoodie', status: 'approved', qty: 1400, type: 'Youth Sweatshirt' });
  await fail(() => generate(c), /not ready for PO.*Product Studio/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 0 });
  assert.equal((await stage(c)).stage, 'draft');
});

await test('missing details are listed together, and the client checklist says exactly the same', async () => {
  const c = await concept({ title: 'Youth Cap', breakdown: { 'One Size': 1800 }, qty: 1800 });
  const bare = base({ product_type: '', factory_id: '', lines: [{ size: 'One Size', qty: 1800 }] });
  const issues = await parity(c, bare);
  assert.deepEqual(issues, ['Choose a product type', 'Choose a factory in the active company', 'Enter a positive whole-unit total quantity',
    'Choose whether the product is sized or one size', 'Confirm the size/variant range and quantities']);
  await fail(() => save(randomUUID(), 0, 'reviewed', bare, c), /Not ready for PO: Choose a product type; Choose a factory/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 0 });
  assert.equal((await one('select count(*)::int n from public.product_workflow_briefs where source_id=$1', [c])).n, 0, 'a refused first save leaves no brief');
});

await test('parity across every rule the checklist mirrors', async () => {
  const c = await concept();
  const L = [{ size: 'S', qty: 10 }, { size: 'M', qty: 20 }];
  const cases = [
    ready(L, 'sized'),
    ready(L, 'sized', 25),
    ready([{ size: 'S', qty: 10 }, { size: '', qty: 20 }], 'sized'),
    ready([{ size: 'S', qty: 10 }, { size: 's ', qty: 20 }], 'sized'),
    ready([{ size: 'S', qty: 0 }, { size: 'M', qty: 20 }], 'sized', 20),
    ready([{ size: 'S', qty: null }, { size: 'M', qty: 20 }], 'sized', 20),
    ready([{ size: 'S', qty: '1.5' }], 'sized', 2),
    ready(L, 'one_size'),
    ready([{ size: 'S', qty: 10, unit_cost: -1 }], 'sized'),
    ready([{ size: 'S', qty: 10, retail_price: '12.50' }], 'one_size'),
    ready(L, 'medium'),
    ready([], 'sized', 10),
    { ...ready(L, 'sized'), po_readiness: { ...ready(L, 'sized').po_readiness, range_confirmed: 'true' } },
    { ...ready(L, 'sized'), po_readiness: { ...ready(L, 'sized').po_readiness, confirmed_lines: [['S', 10], ['M', 21]] } },
    { ...ready(L, 'sized'), po_readiness: { ...ready(L, 'sized').po_readiness, total_qty: 0 } },
    { ...ready(L, 'sized'), po_readiness: { ...ready(L, 'sized').po_readiness, total_qty: '30' } },
    { ...ready(L, 'sized'), factory_id: FOREIGN_FACTORY },
    { ...ready(L, 'sized'), title: '  ' },
  ];
  for (const content of cases) await parity(c, content);
  assert.deepEqual(await parity(c, ready(L, 'sized')), []);
});

let capBrief; let cap; let capPo;
await test('a valid one-size product is marked ready, then Generate PO makes one Draft PO from the reviewed snapshot', async () => {
  cap = await concept({ title: 'Youth Cap – Black Friday', status: 'approved', qty: 1800, breakdown: { 'One Size (adjustable snapback)': 1800 } });
  capBrief = randomUUID();
  const content = ready([{ size: 'One Size (adjustable snapback)', qty: 1800, unit_cost: 4, retail_price: 28 }], 'one_size', 1800, { title: 'Youth Cap', product_type: 'Hats' });
  let b = await save(capBrief, 0, 'draft', content, cap);
  assert.equal(b.po_ready_at, null, 'a draft save never marks ready');
  b = await save(capBrief, b.version, 'reviewed', content, cap);
  assert.ok(b.po_ready_at); assert.equal(b.po_ready_by, ADMIN); assert.ok(b.po_ready_concept_fingerprint);
  assert.equal((await save(capBrief, b.version - 1, 'reviewed', content, cap)).version, b.version, 'lost-response replay returns the same row');
  assert.equal((await stage(cap)).stage, 'ready_for_po');
  const r = await generate(cap);
  assert.equal(r.repeated, false); assert.equal(r.brief_id, capBrief); assert.equal(r.line_count, 1);
  capPo = r.po_header_id;
  const h = await superuser(() => one('select * from public.po_headers where id=$1', [capPo]));
  assert.equal(h.status, 'Draft'); assert.equal(h.generated_from_concept_id, cap); assert.equal(h.factory_id, FACTORY); assert.equal(h.is_new_product_po, true);
  const l = await superuser(() => one('select * from public.po_lines where po_header_id=$1', [capPo]));
  assert.deepEqual([l.variant_title_snapshot, l.qty, l.product_type_snapshot, l.title_snapshot, l.source_concept_id],
    ['One Size (adjustable snapback)', 1800, 'Hats', 'Youth Cap', cap]);
  assert.deepEqual(await counts(cap), { headers: 1, lines: 1, links: 1, ready: 1 });
  assert.equal((await stage(cap)).stage, 'po_created');
});

await test('repeat and cross-entry-point requests return the same complete PO', async () => {
  const again = await generate(cap);
  assert.deepEqual([again.po_header_id, again.repeated], [capPo, true]);
  const brief = await one('select version from public.product_workflow_briefs where id=$1', [capBrief]);
  assert.equal((await handoff(capBrief, brief.version)).po_header_id, capPo, 'Studio retry after Generate PO returns that PO');
  assert.equal((await handoff(capBrief, 0)).po_header_id, capPo, 'even from a stale tab');
  assert.deepEqual(await counts(cap), { headers: 1, lines: 1, links: 1, ready: 1 });
});

await test('Studio first, then the legacy Generate PO link, returns the Studio PO', async () => {
  const c = await concept({ title: 'Steal of a Deal Tee', breakdown: { S: 284, M: 442, L: 570, XL: 528, '2XL': 264, '3XL': 112 }, qty: 2200 });
  const lines = [['S', 284], ['M', 442], ['L', 570], ['XL', 528], ['2XL', 264], ['3XL', 112]].map(([size, qty]) => ({ size, qty }));
  const id = randomUUID();
  let b = await save(id, 0, 'reviewed', ready(lines, 'sized', 2200), c);
  b = await handoff(id, b.version);
  assert.equal((await superuser(() => one('select sum(qty)::int n, count(*)::int k from public.po_lines where po_header_id=$1', [b.po_header_id]))).n, 2200);
  const r = await generate(c);
  assert.deepEqual([r.po_header_id, r.repeated], [b.po_header_id, true]);
  assert.deepEqual(await counts(c), { headers: 1, lines: 6, links: 1, ready: 1 });
});

await test('incomplete sized products are refused: one populated size is not assumed complete', async () => {
  const c = await concept({ title: 'Back to School Youth Tee', qty: 4300 });
  const unconfirmed = { ...ready([{ size: 'YM', qty: 4300 }], 'sized'), po_readiness: { size_mode: 'sized', total_qty: 4300 } };
  await fail(() => save(randomUUID(), 0, 'reviewed', unconfirmed, c), /Confirm the size\/variant range/);
  await fail(() => save(randomUUID(), 0, 'reviewed', { ...unconfirmed, po_readiness: { total_qty: 4300, range_confirmed: true, confirmed_lines: [['YM', 4300]] } }, c), /sized or one size/);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: '', qty: 4300 }], 'sized'), c), /Name every size/);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'YS', qty: 0 }, { size: 'YM', qty: 4300 }], 'sized', 4300), c), /at least 1/);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'YS', qty: 2000 }, { size: 'ys', qty: 2300 }], 'sized'), c), /each size\/variant once/);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'YS', qty: 2000 }, { size: 'YM', qty: 2300 }], 'one_size'), c), /one-size product has exactly one line/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 0 });
});

await test('mismatched totals are refused with both numbers', async () => {
  const c = await concept();
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'S', qty: 1000 }, { size: 'M', qty: 1200 }], 'sized', 2000), c),
    /Sizes total 2200 units but the confirmed total is 2000/);
  const L = [{ size: 'S', qty: 10 }, { size: 'M', qty: 20 }];
  const forged = { ...ready(L, 'sized'), po_readiness: { ...ready(L, 'sized').po_readiness, confirmed_lines: [['S', 10], ['M', 15]] } };
  await fail(() => save(randomUUID(), 0, 'reviewed', forged, c), /Confirm the size\/variant range/);
});

await test('a collection parent is refused at mark-ready and at Generate PO; its product can proceed', async () => {
  const parent = await concept({ title: 'Collection' });
  const child = await concept({ title: 'Child tee', parent });
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'S', qty: 5 }], 'sized'), parent), /collection/);
  await fail(() => generate(parent), /collection/);
  assert.equal((await stage(parent)).stage, 'collection');
  const b = await save(randomUUID(), 0, 'reviewed', ready([{ size: 'S', qty: 5 }], 'sized'), child);
  assert.ok(b.po_ready_at);
});

await test('permission and tenant denial', async () => {
  const c = await concept();
  const content = ready([{ size: 'S', qty: 5 }], 'sized');
  await as(VIEWER);
  await fail(() => save(randomUUID(), 0, 'reviewed', content, c), /Purchasing permission/);
  await fail(() => generate(c), /Purchasing permission/);
  await as(ADMIN, B);
  await fail(() => save(randomUUID(), 0, 'reviewed', content, c, B), /Source not found|missing or archived/);
  await fail(() => generate(c), /Concept not found/);
  await as(ADMIN, A);
  await fail(() => save(randomUUID(), 0, 'reviewed', content, c, B), /active company/);
  await fail(() => save(randomUUID(), 0, 'reviewed', { ...content, factory_id: FOREIGN_FACTORY }, c), /Choose a factory in the active company/);
  const foreign = await concept({ company: B, factory: FOREIGN_FACTORY });
  await fail(() => save(randomUUID(), 0, 'reviewed', content, foreign), /Source not found|missing or archived/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 0 });
  await fail(() => q("update public.product_workflow_briefs set po_ready_at=now()"), /permission denied/);
});

await test('readiness is bound to the reviewed version: reopen clears it, a concept purchasing change blocks the PO', async () => {
  const c = await concept({ breakdown: { S: 10, M: 20 }, qty: 30 });
  const id = randomUUID();
  const content = ready([{ size: 'S', qty: 10 }, { size: 'M', qty: 20 }], 'sized');
  let b = await save(id, 0, 'reviewed', content, c);
  b = await save(id, b.version, 'draft', content, c);
  assert.equal(b.po_ready_at, null); assert.equal(b.po_ready_concept_fingerprint, null);
  await fail(() => handoff(id, b.version), /Review the brief before handoff/);
  await fail(() => generate(c), /not ready for PO/);
  b = await save(id, b.version, 'reviewed', content, c);
  await fail(() => save(id, b.version, 'reviewed', { ...content, title: 'Edited while ready' }, c), /Reopen the reviewed brief/);
  // Non-purchasing concept edits (copy, imagery) keep readiness.
  await superuser(() => q("update public.product_concepts set concept_summary='New copy', reference_image_urls='{https://x.test/a.png}' where id=$1", [c]));
  assert.equal((await stage(c)).stage, 'ready_for_po');
  // Ask SILO revises the size curve after readiness.
  await superuser(() => q(`update public.product_concepts set suggested_size_breakdown='{"S":15,"M":15}' where id=$1`, [c]));
  assert.deepEqual(await stage(c), { stage: 'draft', ready_stale: true, po_header_id: null });
  await fail(() => handoff(id, b.version), /changed after it was marked ready/);
  await fail(() => generate(c), /changed after it was marked ready/);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 1 });
  b = await save(id, b.version, 'draft', content, c);
  b = await save(id, b.version, 'reviewed', content, c);
  const r = await generate(c);
  const lines = await superuser(() => q('select variant_title_snapshot s, qty from public.po_lines where po_header_id=$1 order by 1', [r.po_header_id]));
  assert.deepEqual(lines, [{ s: 'M', qty: 20 }, { s: 'S', qty: 10 }], 'the PO follows the REVIEWED lines, not the concept suggestion');
});

await test('one ready brief per concept', async () => {
  const c = await concept();
  const content = ready([{ size: 'S', qty: 5 }], 'sized');
  await save(randomUUID(), 0, 'reviewed', content, c);
  await fail(() => save(randomUUID(), 0, 'reviewed', content, c), /Another brief for this concept is already ready/);
});

await test('legacy bypasses: direct concept lines, links and PO claims are refused; manual PO work is unchanged', async () => {
  const c = await concept();
  const po = (await one("insert into public.po_headers(company_entity_id,po_name,factory_id,status) values($1,'MANUAL-1',$2,'Draft') returning id", [A, FACTORY])).id;
  const line = (await one("insert into public.po_lines(company_entity_id,po_header_id,title_snapshot,qty) values($1,$2,'Manual tee',12) returning id", [A, po])).id;
  await q('update public.po_lines set qty=14, title_snapshot=$2 where id=$1', [line, 'Manual tee 2']);
  await fail(() => q("insert into public.po_lines(company_entity_id,po_header_id,source_concept_id,title_snapshot,qty) values($1,$2,$3,'Concept',5)", [A, po, c]), /Product Studio/);
  await fail(() => q('update public.po_lines set source_concept_id=$2 where id=$1', [line, c]), /Product Studio/);
  await fail(() => q('insert into public.po_concept_links(company_entity_id,po_header_id,concept_id) values($1,$2,$3)', [A, po, c]), /Product Studio/);
  await fail(() => q("insert into public.po_headers(company_entity_id,po_name,factory_id,generated_from_concept_id) values($1,'X',$2,$3)", [A, FACTORY, c]), /Product Studio/);
  await fail(() => q('update public.po_headers set generated_from_concept_id=$2 where id=$1', [po, c]), /Product Studio/);
  // A concept line already on a PO stays editable; only the concept id is guarded.
  await q('update public.po_lines set qty=1799 where po_header_id=$1', [capPo]);
  await q('update public.po_lines set qty=1800, source_concept_id=source_concept_id where po_header_id=$1', [capPo]);
  await q('delete from public.po_lines where id=$1', [line]);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 0 });
});

await test('a PO that already exists (created before this gate) stays reachable and blocks a second one', async () => {
  const c = await concept({ title: 'Bat Bros Youth Hoodie', status: 'approved', qty: 1400 });
  const old = await superuser(async () => {
    const h = (await one("insert into public.po_headers(company_entity_id,po_name,factory_id,generated_from_concept_id) values($1,'KCMTAR-7',$2,$3) returning id", [A, FACTORY, c])).id;
    await q("insert into public.po_lines(company_entity_id,po_header_id,source_concept_id,title_snapshot,qty) values($1,$2,$3,'Bat Bros',1400)", [A, h, c]);
    await q('insert into public.po_concept_links(company_entity_id,po_header_id,concept_id) values($1,$2,$3)', [A, h, c]);
    return h;
  });
  const r = await generate(c);
  assert.deepEqual([r.po_header_id, r.repeated], [old, true]);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'YS', qty: 700 }, { size: 'YM', qty: 700 }], 'sized'), c), /already has PO KCMTAR-7/);
  assert.equal((await stage(c)).stage, 'po_created');
  await superuser(() => q("update public.product_concepts set status='archived' where id=$1", [c]));
  assert.equal((await generate(c)).po_header_id, old, 'still reachable once archived');
});

await test('a failed line rolls back the header, the lines and the link; the retry makes one whole PO', async () => {
  const c = await concept();
  const id = randomUUID();
  const b = await save(id, 0, 'reviewed', ready([{ size: 'S', qty: 5 }, { size: 'EXPLODE', qty: 6 }], 'sized'), c);
  await superuser(() => db.exec(`create function public.test_explode() returns trigger language plpgsql as $$ begin if new.variant_title_snapshot='EXPLODE' then raise exception 'line insert refused (test)'; end if; return new; end $$;
    create trigger test_explode before insert on public.po_lines for each row execute function public.test_explode();`));
  const before = await superuser(() => one('select count(*)::int n from public.po_headers'));
  await fail(() => generate(c), /line insert refused/);
  await fail(() => handoff(id, b.version), /line insert refused/);
  assert.deepEqual(await superuser(() => one('select count(*)::int n from public.po_headers')), before);
  assert.deepEqual(await counts(c), { headers: 0, lines: 0, links: 0, ready: 1 });
  assert.equal((await one('select po_header_id from public.product_workflow_briefs where id=$1', [id])).po_header_id, null);
  await superuser(() => db.exec('drop trigger test_explode on public.po_lines'));
  const r = await generate(c);
  assert.equal(r.line_count, 2);
  assert.deepEqual(await counts(c), { headers: 1, lines: 2, links: 1, ready: 1 });
});

await test('cycle-1: the generated claim and its link cannot be erased from the browser, so no second PO', async () => {
  const c = await concept({ title: 'Claim holder' });
  let b = await save(randomUUID(), 0, 'reviewed', ready([{ size: 'S', qty: 5 }], 'sized'), c);
  const first = (await generate(c)).po_header_id;
  await fail(() => q('update public.po_headers set generated_from_concept_id = null where id = $1', [first]), /cannot be changed or cleared/);
  await fail(() => q('update public.po_headers set generated_from_concept_id = $2 where id = $1', [first, randomUUID()]), /cannot be changed|Product Studio/);
  await fail(() => q('delete from public.po_concept_links where po_header_id = $1', [first]), /cannot be removed/);
  // Defense in depth: even with the link gone (a service-role write), the claim still names the PO.
  await superuser(() => q('delete from public.po_concept_links where po_header_id = $1', [first]));
  assert.deepEqual([(await generate(c)).po_header_id, (await generate(c)).repeated], [first, true]);
  await fail(() => save(randomUUID(), 0, 'reviewed', ready([{ size: 'S', qty: 5 }], 'sized'), c), /already has PO/);
  assert.equal((await counts(c)).headers, 1, 'still exactly one PO');
  // A manual (non-generated) link stays deletable, and deleting the whole PO still works.
  const manual = (await one("insert into public.po_headers(company_entity_id,po_name,factory_id) values($1,'M-2',$2) returning id", [A, FACTORY])).id;
  await superuser(() => q('insert into public.po_concept_links(company_entity_id,po_header_id,concept_id) values($1,$2,$3)', [A, manual, c]));
  await q('delete from public.po_concept_links where po_header_id = $1', [manual]);
  await q('delete from public.po_headers where id = $1', [first]);
  assert.equal((await counts(c)).headers, 0, 'deleting the whole PO (cascade) is still allowed');
});

await test('cycle-1: a ready concept can create its PO after its launch, and the launch is linked to it', async () => {
  const c = await concept({ title: 'Launch first' });
  const id = randomUUID();
  let b = await save(id, 0, 'reviewed', ready([{ size: 'S', qty: 7 }], 'sized'), c);
  b = await handoff(id, b.version, 'launch', '2026-11-20');
  assert.ok(b.launch_id);
  assert.equal((await stage(c)).stage, 'ready_for_po', 'still actionable after the launch');
  b = await handoff(id, b.version, 'po');
  assert.ok(b.po_header_id);
  assert.equal((await superuser(() => one('select linked_po_id from public.launch_calendar where id=$1', [b.launch_id]))).linked_po_id, b.po_header_id);
  assert.equal((await stage(c)).stage, 'po_created');
  assert.equal((await generate(c)).po_header_id, b.po_header_id);
});

await test('a legacy reviewed concept brief (reviewed before the gate) cannot create a PO', async () => {
  const c = await concept();
  const id = randomUUID();
  await superuser(() => q(`insert into public.product_workflow_briefs(id,company_entity_id,source_kind,source_id,content,status,created_by,reviewed_by,reviewed_at,version)
    values($1,$2,'concept',$3,$4,'reviewed',$5,$5,now(),2)`, [id, A, c, base({ lines: [{ size: '', qty: 1400 }] }), ADMIN]));
  await fail(() => handoff(id, 2), /Mark this concept ready for PO/);
  await fail(() => generate(c), /not ready for PO/);
  assert.equal((await stage(c)).stage, 'draft');
});

await test('the deployed verifier section passes against this schema', async () => {
  const verifier = await read('supabase/verify_v2_schema.sql');
  const start = verifier.indexOf('-- Product Studio Ready for PO checks.');
  const end = verifier.indexOf('-- End Product Studio Ready for PO checks.');
  assert.ok(start > 0 && end > start, 'verifier section present');
  await superuser(async () => {
    for (const statement of verifier.slice(start, end).split(';').filter((x) => x.replace(/--.*$/gm, '').trim()))
      for (const row of (await db.query(statement)).rows) assert.equal(row.status, 'ok', JSON.stringify(row));
  });
});

console.log(`\nproduct-studio-ready-for-po-database: ${checks} cases passed`);
await db.close();
