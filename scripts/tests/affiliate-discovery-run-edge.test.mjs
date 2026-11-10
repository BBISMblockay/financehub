// affiliate-discovery-run ("Search now"), executed in Node with a fake
// Supabase, a fake caller client and a fake search provider.
//
// Properties:
//   * the caller-token gate runs before any service-role call, and the
//     company comes from it, never from the request;
//   * a program in another company is not found, and an inactive one is
//     refused, before anything is searched;
//   * a second search within a minute is refused (no double spend);
//   * the reply carries counts, never cost;
//   * without search credentials it answers 503 and calls nothing;
//   * lib/affiliate-discovery-core.mjs is byte-identical to
//     scripts/lib/affiliate-discovery-core.mjs.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_SEARCH_MUTATION=gateorder    a service-role read happens before the gate
//   AFFILIATE_SEARCH_MUTATION=bodycompany  the company is taken from the request
//   AFFILIATE_SEARCH_MUTATION=cooldown     the once-a-minute guard is skipped
//   AFFILIATE_SEARCH_MUTATION=inactive     an inactive program is searched
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_SEARCH_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);
const FN = new URL('supabase/functions/affiliate-discovery-run/', ROOT);
const MUTS = {
  gateorder: ['    const caller = userClientFor(authHeader);\n', "    await service.from('affiliate_programs').select('id');\n    const caller = userClientFor(authHeader);\n"],
  bodycompany: ["      .select('id, status').eq('id', programId).eq('company_entity_id', company).maybeSingle();", "      .select('id, status').eq('id', programId).eq('company_entity_id', body.company_entity_id || company).maybeSingle();"],
  cooldown: ['    if (lastAt && now().getTime() - lastAt < COOLDOWN_MS) {', '    if (false) {'],
  inactive: ["    if (program.status !== 'active') return", "    if (false) return"],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
async function load() {
  if (!MUT) return import(new URL('handler.mjs', FN));
  const tmp = await mkdtemp(join(tmpdir(), 'affsearch-'));
  await cp(FN, tmp, { recursive: true });
  const path = join(tmp, 'handler.mjs');
  const code = await readFile(path, 'utf8');
  assert.ok(code.includes(MUTS[MUT][0]), `mutation ${MUT}: pattern not found`);
  await writeFile(path, code.split(MUTS[MUT][0]).join(MUTS[MUT][1]));
  return import(pathToFileURL(path).href);
}
const { createDiscoveryRunHandler, COOLDOWN_MS } = await load();

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PPAUSED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function fakeService(seed, log) {
  const tables = structuredClone(seed);
  let n = 1;
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let single = false; let maybe = false; let lim = null; let ord = null;
    const run = () => {
      log.push(`service:${op}:${table}`);
      const rows = (tables[table] ||= []);
      const match = (r) => filters.every(([k, v, kind]) => (kind === 'in' ? v.includes(r[k]) : r[k] === v));
      if (op === 'select') {
        let out = rows.filter(match).map((r) => ({ ...r }));
        if (ord) out.sort((a, b) => (a[ord.k] < b[ord.k] ? 1 : -1) * (ord.asc ? -1 : 1));
        if (lim != null) out = out.slice(0, lim);
        if (maybe) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      }
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        let last = null;
        for (const r of list) { last = { id: `${table}-${n++}`, ...r }; rows.push(last); }
        return { data: single ? { id: last.id } : null, error: null };
      }
      if (op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      throw new Error(op);
    };
    const b = {
      select() { return b; }, insert(p) { op = 'insert'; payload = p; return b; }, update(p) { op = 'update'; payload = p; return b; },
      eq(k, v) { filters.push([k, v, 'eq']); return b; }, in(k, v) { filters.push([k, v, 'in']); return b; },
      order(k, o) { ord = { k, asc: o?.ascending !== false }; return b; }, limit(x) { lim = x; return b; },
      single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return { tables, from: builder, rpc: async () => ({ data: true, error: null }) };
}

const seed = () => ({
  affiliate_programs: [
    { id: PA, company_entity_id: CO_A, name: 'A', status: 'active', niche: 'baseball drills', platforms: ['youtube'], discovery_max_cost_usd: 0.5 },
    { id: PB, company_entity_id: CO_B, name: 'B', status: 'active', niche: 'golf', platforms: ['youtube'], discovery_max_cost_usd: 0.5 },
    { id: PPAUSED, company_entity_id: CO_A, name: 'Paused', status: 'paused', niche: 'x', platforms: [], discovery_max_cost_usd: 0.5 },
  ],
  affiliate_prospect_sources: [
    { id: 's1', company_entity_id: CO_A, program_id: PA, kind: 'serp_query', enabled: true, query: 'baseball drills youtube', max_results: 20 },
    { id: 's2', company_entity_id: CO_B, program_id: PB, kind: 'serp_query', enabled: true, query: 'golf', max_results: 20 },
    { id: 's3', company_entity_id: CO_A, program_id: PPAUSED, kind: 'serp_query', enabled: true, query: 'x', max_results: 20 },
  ],
  affiliate_discovery_runs: [],
});
const ITEMS = [{ type: 'organic', url: 'https://www.youtube.com/@CoachPat', title: 'Coach Pat - Baseball Drills', description: 'drills', rank_absolute: 1 }];

function setup({ company = CO_A, gateError = null, withSearch = true, clock = () => new Date('2026-11-10T12:00:00Z') } = {}) {
  const log = []; const searches = [];
  const service = fakeService(seed(), log);
  const handler = createDiscoveryRunHandler({
    service,
    userClientFor: () => ({ rpc: async (name) => { log.push(`caller:rpc:${name}`); return gateError ? { data: null, error: gateError } : { data: company, error: null }; } }),
    credentials: { login: '', password: '' },
    fetchSerp: withSearch ? async (task) => { searches.push(task); return { items: ITEMS, cost: 0.002 }; } : undefined,
    now: clock,
  });
  const call = (body, auth = 'Bearer t') => handler(new Request('https://x/fn', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { log, searches, service, call };
}

await test('the caller-token gate runs first, and a refused session stops everything', async () => {
  const s = setup({ gateError: { message: 'mfa_required' } });
  const r = await s.call({ program_id: PA });
  assert.equal(r.status, 401);
  assert.deepEqual(s.log, ['caller:rpc:affiliate_managed_company']);
  const ok = setup();
  await ok.call({ program_id: PA });
  assert.equal(ok.log[0], 'caller:rpc:affiliate_managed_company', 'nothing touches the service role before the gate');
});

await test('no manager rights means 403 and no search', async () => {
  const s = setup({ company: null });
  assert.equal((await s.call({ program_id: PA })).status, 403);
  assert.equal(s.searches.length, 0);
});

await test('a program in another company is not found, whatever the request says', async () => {
  const s = setup();
  const r = await s.call({ program_id: PB, company_entity_id: CO_B });
  assert.equal(r.status, 404);
  assert.equal(s.searches.length, 0);
});

await test('an inactive program is refused before searching', async () => {
  const s = setup();
  assert.equal((await s.call({ program_id: PPAUSED })).status, 409);
  assert.equal(s.searches.length, 0);
});

await test('Search now runs the program and replies with counts, not cost', async () => {
  const s = setup();
  const r = await s.call({ program_id: PA });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ran, 1);
  assert.equal(j.prospects_new, 1);
  assert.ok(!('cost_usd' in j), 'no cost in the reply');
  assert.equal(s.searches.length, 1);
  assert.equal(s.searches[0].keyword, 'baseball drills youtube', 'only this program’s searches run');
});

await test('a second search within a minute is refused', async () => {
  let t = new Date('2026-11-10T12:00:00Z').getTime();
  const s = setup({ clock: () => new Date(t) });
  assert.equal((await s.call({ program_id: PA })).status, 200);
  t += 10_000;
  assert.equal((await s.call({ program_id: PA })).status, 429);
  assert.equal(s.searches.length, 1, 'a double click does not pay twice');
  t += COOLDOWN_MS;
  assert.equal((await s.call({ program_id: PA })).status, 200);
});

await test('without search credentials it answers 503 and searches nothing', async () => {
  const s = setup({ withSearch: false });
  const r = await s.call({ program_id: PA });
  assert.equal(r.status, 503);
  assert.equal(s.service.tables.affiliate_discovery_runs.length, 0);
});

await test('a missing token and a non-POST are refused', async () => {
  const s = setup();
  assert.equal((await s.call({ program_id: PA }, '')).status, 401);
  const { createDiscoveryRunHandler: make } = await import(new URL('handler.mjs', FN));
  const h = make({ service: s.service, userClientFor: () => ({}), credentials: {} });
  assert.equal((await h(new Request('https://x/fn', { method: 'GET' }))).status, 405);
});

await test('the discovery core ships byte-identical to scripts/lib', async () => {
  const a = await readFile(new URL('scripts/lib/affiliate-discovery-core.mjs', ROOT), 'utf8');
  const b = await readFile(new URL('lib/affiliate-discovery-core.mjs', FN), 'utf8');
  assert.equal(b, a, 'supabase/functions/affiliate-discovery-run/lib/affiliate-discovery-core.mjs is a VERBATIM copy -- re-copy it');
});

console.log(`\naffiliate-discovery-run-edge: ${passed} passed`);
