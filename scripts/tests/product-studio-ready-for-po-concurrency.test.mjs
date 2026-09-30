// Product Studio Ready for PO: GENUINELY concurrent sessions on a real
// PostgreSQL server. PGlite (the main suite) is one connection, so it can
// only prove lock ordering by outcome; this runs overlapping transactions.
//
// Needs psql and a server: PG_CONCURRENCY_URL=postgresql://postgres@/postgres?host=/var/tmp&port=5499
// Without it the script says so and exits 0 (skipped, not passed).
// It creates and drops its own throwaway database; it never touches any other.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { schemaSql } from './product-studio-ready-for-po-fixture.mjs';

const URL_ = process.env.PG_CONCURRENCY_URL;
if (!URL_ && process.env.PG_CONCURRENCY_REQUIRED === '1') { console.error('PG_CONCURRENCY_URL is required here; refusing a silent skip'); process.exit(1); }
if (!URL_) { console.log('product-studio-ready-for-po-concurrency: SKIPPED (set PG_CONCURRENCY_URL to a PostgreSQL server)'); process.exit(0); }

const read = (p) => readFile(new URL('../../' + p, import.meta.url), 'utf8');
const dbName = 'studio_ready_' + randomUUID().replace(/-/g, '').slice(0, 12);
const withDb = (url, name) => { const u = new URL(url); u.pathname = '/' + name; return u.toString(); };
const TARGET = withDb(URL_, dbName);

function psql(url, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', url], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || 'psql exited ' + code))));
    p.stdin.end(sql);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CONC_MUTATION removes one lock; each must turn this suite red (sync-tests.yml).
const LOCK_MUTATIONS = {
  'generate-unlocked': ["where id = p_concept_id and company_entity_id = co for update;", "where id = p_concept_id and company_entity_id = co;"],
  'mark-unlocked': ["where id = p_source_id and company_entity_id = p_company for update;", "where id = p_source_id and company_entity_id = p_company;"],
};
async function migration(name) {
  let sql = await read(`supabase/migrations/${name}.sql`);
  const m = process.env.CONC_MUTATION;
  if (m && name.endsWith('ready_for_po')) {
    const [from, to] = LOCK_MUTATIONS[m] || [];
    assert.ok(from && sql.includes(from), 'unknown or stale mutation ' + m);
    sql = sql.replace(from, to);
  }
  return sql;
}

const ids = { A: randomUUID(), B: randomUUID(), ADMIN: randomUUID(), VIEWER: randomUUID(), FACTORY: randomUUID(), FOREIGN_FACTORY: randomUUID() };
const as = `select set_config('request.jwt.claim.sub','${ids.ADMIN}',false), set_config('test.company','${ids.A}',false) \\g /dev/null
set role authenticated;
`;
let checks = 0;
const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };

await psql(URL_, `create database ${dbName};`);
try {
  // Role creation is cluster-wide; tolerate roles left by an earlier run.
  // A function replacement: a string one would read "$$" as an escaped "$".
  const schema = schemaSql(ids).replace('create role anon; create role authenticated;', () =>
    `do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;`);
  await psql(TARGET, schema);
  for (const m of ['20260926082115_product_workflow_preview', '20260927074820_product_studio_variant_spread',
    '20260930000000_generate_po_from_concept_uniq', '20260930120000_product_studio_ready_for_po'])
    await psql(TARGET, await migration(m));

  async function readyConcept(title) {
    const c = randomUUID(), brief = randomUUID();
    const content = JSON.stringify({ source_updated_at: '2026-09-30T00:00:00Z', title, design_intent: 'x', product_type: 'Tee', factory_id: ids.FACTORY,
      lines: [{ size: 'S', qty: 10 }, { size: 'M', qty: 20 }],
      po_readiness: { size_mode: 'sized', total_qty: 30, range_confirmed: true, confirmed_lines: [['S', '10'], ['M', '20']] } });
    await psql(TARGET, `insert into public.product_concepts(id,company_entity_id,title,suggested_factory_id) values('${c}','${ids.A}','${title}','${ids.FACTORY}');
${as}select public.save_product_workflow_brief('${ids.A}','${brief}',0,'concept','${c}','${content}'::jsonb,'reviewed');`);
    return { c, brief };
  }
  const poCount = async (c) => Number(await psql(TARGET, `select count(*) from public.po_headers where generated_from_concept_id='${c}';`));

  await test('two concurrent Generate PO calls for one concept: one PO; the waiter gets it as a repeat', async () => {
    const { c } = await readyConcept('Race one');
    const first = psql(TARGET, `${as}begin;
select public.generate_po_from_concept('${c}')::text;
select pg_sleep(1.5) \\g /dev/null
commit;`);
    await sleep(300);
    const second = psql(TARGET, `${as}select public.generate_po_from_concept('${c}')::text;`);
    const [a, b] = (await Promise.all([first, second])).map((t) => JSON.parse(t.split('\n').pop()));
    assert.equal(a.repeated, false); assert.equal(b.repeated, true); assert.equal(a.po_header_id, b.po_header_id);
    assert.equal(await poCount(c), 1);
  });

  await test('Generate PO racing the Studio handoff of the same brief: one PO, both get it', async () => {
    const { c, brief } = await readyConcept('Race two');
    const version = await psql(TARGET, `select version from public.product_workflow_briefs where id='${brief}';`);
    const first = psql(TARGET, `${as}begin;
select public.generate_po_from_concept('${c}')::text;
select pg_sleep(1.5) \\g /dev/null
commit;`);
    await sleep(300);
    const second = psql(TARGET, `${as}select (public.handoff_product_workflow_brief('${ids.A}','${brief}',${version},'po',null))->>'po_header_id';`);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(JSON.parse(a.split('\n').pop()).po_header_id, b.split('\n').pop());
    assert.equal(await poCount(c), 1);
  });

  await test('Studio handoff first, legacy link second (reverse lock order at the call site): no deadlock, one PO', async () => {
    const { c, brief } = await readyConcept('Race three');
    const version = await psql(TARGET, `select version from public.product_workflow_briefs where id='${brief}';`);
    const first = psql(TARGET, `${as}begin;
select (public.handoff_product_workflow_brief('${ids.A}','${brief}',${version},'po',null))->>'po_header_id';
select pg_sleep(1.5) \\g /dev/null
commit;`);
    await sleep(300);
    const second = psql(TARGET, `${as}select public.generate_po_from_concept('${c}')::text;`);
    const [a, b] = await Promise.all([first, second]);
    const g = JSON.parse(b.split('\n').pop());
    assert.equal(g.repeated, true); assert.equal(g.po_header_id, a.split('\n').pop());
    assert.equal(await poCount(c), 1);
  });

  await test('two briefs for one concept marked ready at once: exactly one wins', async () => {
    const c = randomUUID();
    await psql(TARGET, `insert into public.product_concepts(id,company_entity_id,title,suggested_factory_id) values('${c}','${ids.A}','Race four','${ids.FACTORY}');`);
    const content = JSON.stringify({ source_updated_at: '2026-09-30T00:00:00Z', title: 'Race four', design_intent: 'x', product_type: 'Tee', factory_id: ids.FACTORY,
      lines: [{ size: 'S', qty: 5 }], po_readiness: { size_mode: 'sized', total_qty: 5, range_confirmed: true, confirmed_lines: [['S', '5']] } });
    const mark = (hold) => psql(TARGET, `${as}begin;
select public.save_product_workflow_brief('${ids.A}','${randomUUID()}',0,'concept','${c}','${content}'::jsonb,'reviewed') is not null;
${hold ? "select pg_sleep(1.5) \\g /dev/null\n" : ''}commit;`).then(() => 'ok', (e) => e.message);
    const first = mark(true);
    await sleep(300);
    const results = await Promise.all([first, mark(false)]);
    assert.equal(results[0], 'ok');
    assert.match(results[1], /Another brief for this concept is already ready/);
    assert.equal(Number(await psql(TARGET, `select count(*) from public.product_workflow_briefs where source_id='${c}' and po_ready_at is not null;`)), 1);
  });
} finally {
  await psql(URL_, `drop database if exists ${dbName} with (force);`).catch((e) => console.error('cleanup:', e.message));
}
console.log(`\nproduct-studio-ready-for-po-concurrency: ${checks} concurrent cases passed on a real PostgreSQL server`);
