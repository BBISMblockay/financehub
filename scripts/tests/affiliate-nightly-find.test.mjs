// scripts/tests/affiliate-nightly-find.test.mjs
//
// The nightly Find starter (scripts/affiliate-nightly-find.mjs): one call per
// company that switched it on, nothing for anyone else, and red only for a
// refusal SILO can fix.
//
// Mutations (CI runs each and requires the suite to FAIL):
//   NIGHTLY_FIND_MUTATION=allcos     every company is started, switched on or not
//   NIGHTLY_FIND_MUTATION=capred     a company at its monthly cap turns the run red
//   NIGHTLY_FIND_MUTATION=quietfail  a refused start is not counted as a failure
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.NIGHTLY_FIND_MUTATION || '';
const SRC = new URL('../affiliate-nightly-find.mjs', import.meta.url);
let src = await readFile(SRC, 'utf8');
const mutate = (a, b) => { assert.ok(src.includes(a), `mutation ${MUT}: pattern not found`); src = src.split(a).join(b); };
switch (MUT) {
  case '': break;
  case 'allcos': mutate(".eq('nightly_enabled', true)", ''); break;
  case 'capred': mutate('const OK_REFUSALS = new Set([402]);', 'const OK_REFUSALS = new Set([]);'); break;
  case 'quietfail': mutate('      failed += 1;\n', ''); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
// The module imports @supabase/supabase-js at the top, and the Unit job runs
// without node_modules -- so running a copy next to the original died on
// ERR_MODULE_NOT_FOUND there while passing anywhere npm install had been run.
// Point that import at a stub instead, which is the pattern the creative
// backfill driver tests already use. Nothing here needs the real client:
// every test injects its own `db`, and createClient is only reached by the
// command-line path.
const dir = await mkdtemp(path.join(tmpdir(), 'nightly-find-'));
const stub = path.join(dir, 'supabase-stub.mjs');
await writeFile(stub, 'export const createClient = () => { throw new Error("not used under test"); };\n');
const copy = path.join(dir, 'nightly-find-under-test.mjs');
await writeFile(copy, src.replace("from '@supabase/supabase-js'", `from '${pathToFileURL(stub).href}'`));
const mod = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const SETTINGS = [
  { company_entity_id: 'a', nightly_enabled: true },
  { company_entity_id: 'b', nightly_enabled: false },
  { company_entity_id: 'c', nightly_enabled: true },
  { company_entity_id: 'd', nightly_enabled: true },
];
function fakeDb({ answers = {}, tableError = null } = {}) {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, 'affiliate_studio_spend_settings');
      const f = [];
      const b = {
        select() { return b; }, order() { return b; }, limit() { return b; },
        eq(k, v) { f.push((r) => r[k] === v); return b; },
        then(res) { res(tableError ? { data: null, error: tableError } : { data: SETTINGS.filter((r) => f.every((x) => x(r))), error: null }); },
      };
      return b;
    },
    functions: {
      async invoke(name, { body }) {
        calls.push({ name, body });
        const a = answers[body.company] || { data: { scan_id: `scan-${body.company}` } };
        return a.status ? { data: null, error: { context: { status: a.status } } } : { data: a.data, error: null };
      },
    },
  };
  return { db, calls };
}

await test('one call per company that switched it on, with only the company named', async () => {
  const { db, calls } = fakeDb({ answers: { c: { data: { scan_id: 's', joined: true } } } });
  const r = await mod.run({ db, log: () => {} });
  assert.deepEqual(calls.map((c) => c.body.company), ['a', 'c', 'd'], 'never a company that left it off');
  assert.ok(calls.every((c) => c.name === 'affiliate-research' && c.body.action === 'nightly_scan' && Object.keys(c.body).length === 2));
  assert.equal(r.started, 2, 'joining a running Find is not a new start');
  assert.equal(r.failed, 0);
});

await test('a company at its monthly cap is not a failure; any other refusal is', async () => {
  const { db } = fakeDb({ answers: { a: { status: 402 }, d: { status: 500 } } });
  const out = [];
  const r = await mod.run({ db, log: (x) => out.push(x) });
  assert.equal(r.failed, 1, 'only the 500');
  assert.ok(out.some((x) => /a: at its monthly Affiliate Studio cap/.test(x)));
  assert.ok(out.some((x) => /d: refused \(500\)/.test(x)));
});

await test('before the database update, nothing runs and nothing is red', async () => {
  const { db, calls } = fakeDb({ tableError: { code: 'PGRST205', message: "Could not find the table 'public.affiliate_studio_spend_settings'" } });
  const r = await mod.run({ db, log: () => {} });
  assert.deepEqual([r.started, r.failed, calls.length], [0, 0, 0]);
});

console.log(`\naffiliate-nightly-find: ${passed} passed`);
