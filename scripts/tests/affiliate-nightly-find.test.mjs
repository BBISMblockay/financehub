// scripts/tests/affiliate-nightly-find.test.mjs
//
// The nightly Find starter (scripts/affiliate-nightly-find.mjs): one call per
// company that switched it on, nothing for anyone else, and red only for a
// refusal SILO can fix.
//
// Mutations (CI runs each and requires the suite to FAIL):
//   NIGHTLY_FIND_MUTATION=allcos     Find is started wherever only Discovery is on
//   NIGHTLY_FIND_MUTATION=capred     a company at its monthly cap turns the run red
//   NIGHTLY_FIND_MUTATION=quietfail  a refused start is not counted as a failure
//   NIGHTLY_FIND_MUTATION=discoall   Discovery is started wherever only Find is on
//   NIGHTLY_FIND_MUTATION=nofindfallback  before the Discovery update, Find stops too
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MUT = process.env.NIGHTLY_FIND_MUTATION || '';
const SRC = new URL('../affiliate-nightly-find.mjs', import.meta.url);
let src = await readFile(SRC, 'utf8');
const mutate = (a, b) => { assert.ok(src.includes(a), `mutation ${MUT}: pattern not found`); src = src.split(a).join(b); };
switch (MUT) {
  case '': break;
  case 'allcos': mutate("if (row.nightly_enabled === true) jobs", 'if (true) jobs'); break;
  case 'discoall': mutate("if (row.discovery_nightly_enabled === true) jobs", "if (true) jobs"); break;
  case 'nofindfallback': mutate("if (/discovery_nightly_enabled/.test(`${r.error.message}`))", 'if (false)'); break;
  case 'capred': mutate('const OK_REFUSALS = new Set([402]);', 'const OK_REFUSALS = new Set([]);'); break;
  case 'quietfail': mutate("return { started: 0, failed: 1 };", 'return { started: 0, failed: 0 };'); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
// The module imports @supabase/supabase-js at the top; run it from a copy
// next to the original so that import resolves the same way.
const dir = path.dirname(new URL(SRC).pathname);
const copy = path.join(dir, `.nightly-find-under-test-${process.pid}.mjs`);
await writeFile(copy, src);
let mod;
try { mod = await import(copy); } finally { await import('node:fs/promises').then((f) => f.rm(copy, { force: true })); }

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const SETTINGS = [
  { company_entity_id: 'a', nightly_enabled: true, discovery_nightly_enabled: false },
  { company_entity_id: 'b', nightly_enabled: false, discovery_nightly_enabled: false },
  { company_entity_id: 'c', nightly_enabled: true, discovery_nightly_enabled: false },
  { company_entity_id: 'd', nightly_enabled: true, discovery_nightly_enabled: false },
];
// tableError: every read fails. noDiscoveryColumn: only a read naming the
// Discovery column fails (the database before 20261125100000).
function fakeDb({ answers = {}, tableError = null, noDiscoveryColumn = false, settings = SETTINGS } = {}) {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, 'affiliate_studio_spend_settings');
      const f = []; let cols = '';
      const b = {
        select(c) { cols = c; return b; }, order() { return b; }, limit() { return b; },
        eq(k, v) { f.push((r) => r[k] === v); return b; },
        or(expr) { const keys = expr.split(',').map((x) => x.split('.')[0]); f.push((r) => keys.some((k) => r[k] === true)); return b; },
        then(res) {
          if (tableError) return res({ data: null, error: tableError });
          if (noDiscoveryColumn && /discovery_nightly_enabled/.test(cols)) {
            return res({ data: null, error: { code: '42703', message: 'column affiliate_studio_spend_settings.discovery_nightly_enabled does not exist' } });
          }
          res({ data: settings.filter((r) => f.every((x) => x(r))), error: null });
        },
      };
      return b;
    },
    functions: {
      async invoke(name, { body }) {
        calls.push({ name, body });
        const a = answers[`${body.company}:${body.action}`] || answers[body.company] || { data: { scan_id: `scan-${body.company}` } };
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
  assert.ok(out.some((x) => /a Find: at its monthly Affiliate Studio cap/.test(x)));
  assert.ok(out.some((x) => /d Find: refused \(500\)/.test(x)));
});

await test('before the database update, nothing runs and nothing is red', async () => {
  const { db, calls } = fakeDb({ tableError: { code: 'PGRST205', message: "Could not find the table 'public.affiliate_studio_spend_settings'" } });
  const r = await mod.run({ db, log: () => {} });
  assert.deepEqual([r.started, r.failed, calls.length], [0, 0, 0]);
});

await test('Discovery starts only where its own switch is on, and a running one is not a failure', async () => {
  const settings = [
    { company_entity_id: 'a', nightly_enabled: true, discovery_nightly_enabled: true },
    { company_entity_id: 'b', nightly_enabled: false, discovery_nightly_enabled: true },
    { company_entity_id: 'c', nightly_enabled: true, discovery_nightly_enabled: false },
    { company_entity_id: 'e', nightly_enabled: false, discovery_nightly_enabled: false },
  ];
  const { db, calls } = fakeDb({ settings, answers: { 'b:nightly_discovery': { status: 429 }, 'a:nightly_discovery': { data: { run_id: 'r' } } } });
  const r = await mod.run({ db, log: () => {} });
  assert.deepEqual(calls.map((c) => `${c.body.company}:${c.body.action}`), ['a:nightly_scan', 'a:nightly_discovery', 'b:nightly_discovery', 'c:nightly_scan']);
  assert.equal(r.failed, 0, 'a Discovery already running is that night\'s turn');
  assert.equal(r.started, 3);
});

await test('before the Discovery update is applied, Find still runs', async () => {
  const { db, calls } = fakeDb({ noDiscoveryColumn: true });
  const r = await mod.run({ db, log: () => {} });
  assert.deepEqual(calls.map((c) => `${c.body.company}:${c.body.action}`), ['a:nightly_scan', 'c:nightly_scan', 'd:nightly_scan']);
  assert.equal(r.failed, 0);
});

console.log(`\naffiliate-nightly-find: ${passed} passed`);
