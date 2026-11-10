// affiliate-research ("Find creators with AI" and "Import a list"), executed
// in Node with a fake Supabase, a fake caller client and a fake model API.
//
// Properties:
//   * the caller-token gate runs before any service-role call, and the
//     company comes from it, never from the request;
//   * a creator is kept only if the web tools' RESULTS showed its profile URL,
//     its "@handle" or its address -- the model's own words never verify it;
//   * a follower count or email is kept only with a source URL that a web
//     result returned; otherwise it is stored as not found (null);
//   * a likely minor is never stored, from research or from an imported file;
//   * one research per program at a time; no key answers 503 and spends nothing;
//   * AI credit is held under 'affiliate_research' and charged only when a
//     creator was kept;
//   * lib/ copies are byte-identical to scripts/lib/.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_RESEARCH_MUTATION=gateorder    a service-role read happens before the gate
//   AFFILIATE_RESEARCH_MUTATION=bodycompany  the program is looked up in the request's company
//   AFFILIATE_RESEARCH_MUTATION=unverified   a creator the web results never showed is kept
//   AFFILIATE_RESEARCH_MUTATION=minors       a likely minor from research is kept
//   AFFILIATE_RESEARCH_MUTATION=importminor  a row marked minor in a file is kept
//   AFFILIATE_RESEARCH_MUTATION=followers    a follower count without a seen source is kept
//   AFFILIATE_RESEARCH_MUTATION=doublerun    a second research starts while one runs
//   AFFILIATE_RESEARCH_MUTATION=freecharge   a run that kept nobody is charged
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_RESEARCH_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);
const FN = new URL('supabase/functions/affiliate-research/', ROOT);
const CORE = 'lib/affiliate-research-core.mjs';
const MUTS = {
  gateorder: ['handler.mjs', '    const caller = userClientFor(authHeader);\n', "    await service.from('affiliate_programs').select('id');\n    const caller = userClientFor(authHeader);\n"],
  bodycompany: ['handler.mjs', ".eq('id', programId).eq('company_entity_id', company).maybeSingle();", ".eq('id', programId).eq('company_entity_id', body?.company_entity_id || company).maybeSingle();"],
  unverified: [CORE, '{ stats.unverified += 1; continue; }', '{ stats.unverified += 0; }'],
  minors: [CORE, '    if (c?.likely_minor === true) { stats.minors += 1; continue; }\n', ''],
  importminor: [CORE, "    if (truthy(pick(row, ['minor', 'likely_minor', 'is_minor']))) { stats.minors += 1; continue; }\n", ''],
  followers: [CORE, 'c.followers >= 0 && seenUrl(evidence, c.followers_source_url)', 'c.followers >= 0'],
  doublerun: ['handler.mjs', "    if (prev?.status === 'running' &&", '    if (false &&'],
  freecharge: ['handler.mjs', "outcome = stats.kept > 0 ? 'succeeded' : 'failed';", "outcome = 'succeeded';"],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
async function load() {
  if (!MUT) return import(new URL('handler.mjs', FN));
  const tmp = await mkdtemp(join(tmpdir(), 'affresearch-'));
  await cp(FN, tmp, { recursive: true });
  const [file, from, to] = MUTS[MUT];
  const path = join(tmp, file);
  const code = await readFile(path, 'utf8');
  assert.ok(code.includes(from), `mutation ${MUT}: pattern not found`);
  await writeFile(path, code.split(from).join(to));
  return import(pathToFileURL(join(tmp, 'handler.mjs')).href);
}
const { createResearchHandler } = await load();

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

function fakeService(seed, log, rpcs) {
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
  const rpc = async (name, args) => {
    log.push(`service:rpc:${name}`); rpcs.push({ name, args });
    if (name === 'affiliate_outreach_can_contact') return { data: args.p_handle !== '@donotcontact', error: null };
    if (name === 'ai_credit_open') return { data: { ok: true, mode: 'enforce', held_micros: 1000 }, error: null };
    if (name === 'ai_credit_step') return { data: { ok: true, held_micros: 2000 }, error: null };
    if (name === 'ai_credit_settle') return { data: { ok: true, outcome: args.p_outcome, enforced: true, charged_micros: 0 }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  return { tables, from: builder, rpc };
}

const seed = (extraRuns = []) => ({
  affiliate_programs: [
    { id: PA, company_entity_id: CO_A, name: 'A', status: 'active', niche: 'baseball', audience_notes: 'baseball parents', platforms: ['tiktok', 'instagram', 'youtube'], geographies: ['US'] },
    { id: PB, company_entity_id: CO_B, name: 'B', status: 'active', niche: 'golf', platforms: ['youtube'], geographies: [] },
    { id: PPAUSED, company_entity_id: CO_A, name: 'Paused', status: 'paused', niche: 'x', platforms: [], geographies: [] },
  ],
  affiliate_discovery_runs: extraRuns,
  affiliate_prospects: [],
  affiliate_prospect_observations: [],
});

// What the web tools returned: a search listing two profiles and a ranking page
// that states one creator's follower count and another's handle.
const WEB_RESULTS = {
  type: 'web_search_tool_result', tool_use_id: 'srv1',
  content: [
    { type: 'web_search_result', url: 'https://www.tiktok.com/@jenna.and.her.gents', title: 'Jenna and Her Gents (@jenna.and.her.gents) | TikTok' },
    { type: 'web_search_result', url: 'https://tokranks.example/baseballmom', title: 'Top #baseballmom creators: @diamondmama 41.2K followers' },
    { type: 'web_search_result', url: 'https://www.instagram.com/lathanthekidumpire/', title: 'Lathan (@lathanthekidumpire)' },
  ],
};
const creator = (o) => ({
  name: 'x', platform: 'tiktok', handle: '@x', profile_url: 'https://www.tiktok.com/@x', followers: null, followers_source_url: null,
  followers_as_of: null, fit_reason: 'baseball mom', found_on_url: null, contact_email: null, contact_source_url: null, likely_minor: false, ...o,
});
const LIST = [
  creator({ name: 'Jenna', handle: '@jenna.and.her.gents', profile_url: 'https://www.tiktok.com/@jenna.and.her.gents', followers: 993200, followers_source_url: 'https://www.tiktok.com/@jenna.and.her.gents', followers_as_of: '2026-11-10', found_on_url: 'https://www.tiktok.com/@jenna.and.her.gents' }),
  creator({ name: 'Diamond Mama', handle: '@diamondmama', profile_url: 'https://www.instagram.com/diamondmama', platform: 'instagram', followers: 41200, followers_source_url: 'https://made-up.example/stats', contact_email: 'dm@example.com', contact_source_url: 'https://made-up.example/contact' }),
  creator({ name: 'Invented', handle: '@notreal', profile_url: 'https://www.tiktok.com/@notreal', followers: 500000, followers_source_url: 'https://www.tiktok.com/@notreal' }),
  creator({ name: 'Lathan', handle: '@lathanthekidumpire', profile_url: 'https://www.instagram.com/lathanthekidumpire/', platform: 'instagram', likely_minor: true }),
];
const msg = (content, stop) => ({ content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } } });
const SCRIPT = () => [
  msg([{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'baseball mom tiktok' } }, WEB_RESULTS], 'pause_turn'),
  msg([{ type: 'tool_use', id: 't1', name: 'record_creators', input: { creators: LIST } }], 'tool_use'),
];

function setup({ company = CO_A, gateError = null, apiKey = 'k', script = SCRIPT(), runs = [], modelStatus = 200 } = {}) {
  const log = []; const rpcs = []; const calls = []; const bg = [];
  const service = fakeService(seed(runs), log, rpcs);
  const handler = createResearchHandler({
    service,
    userClientFor: () => ({
      rpc: async (name) => { log.push(`caller:rpc:${name}`); return gateError ? { data: null, error: gateError } : { data: company, error: null }; },
      auth: { getUser: async () => ({ data: { user: { id: '99999999-9999-4999-8999-999999999999' } } }) },
    }),
    apiKey,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (modelStatus !== 200) return { ok: false, status: modelStatus, json: async () => ({}) };
      const next = script.shift();
      return { ok: true, status: 200, json: async () => next };
    },
    background: (p) => { bg.push(p); },
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  const call = async (body, auth = 'Bearer t') => {
    const r = await handler(new Request('https://x/fn', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    await Promise.all(bg.splice(0));
    return r;
  };
  return { log, rpcs, calls, service, call };
}

await test('the caller-token gate runs first, and a refused session stops everything', async () => {
  const s = setup({ gateError: { message: 'mfa_required' } });
  assert.equal((await s.call({ action: 'research', program_id: PA })).status, 401);
  assert.deepEqual(s.log, ['caller:rpc:affiliate_managed_company']);
  const ok = setup();
  await ok.call({ action: 'research', program_id: PA });
  assert.equal(ok.log[0], 'caller:rpc:affiliate_managed_company', 'nothing touches the service role before the gate');
});

await test('no manager rights means 403; another company\'s program is not found', async () => {
  assert.equal((await setup({ company: null }).call({ action: 'research', program_id: PA })).status, 403);
  const s = setup();
  const r = await s.call({ action: 'research', program_id: PB, company_entity_id: CO_B });
  assert.equal(r.status, 404, 'the company comes from the caller, never the request');
  assert.equal(s.calls.length, 0);
});

await test('research keeps only creators the web results showed, and never a minor', async () => {
  const s = setup();
  const r = await s.call({ action: 'research', program_id: PA, focus: 'baseball moms', count: 25 });
  assert.equal(r.status, 202);
  const { run_id } = await r.json();
  const ps = s.service.tables.affiliate_prospects;
  assert.deepEqual(ps.map((p) => p.handle).sort(), ['@diamondmama', '@jenna.and.her.gents'], 'invented and minor creators are not stored');
  assert.ok(ps.every((p) => p.source === 'ai_research' && p.company_entity_id === CO_A));
  const jenna = ps.find((p) => p.handle === '@jenna.and.her.gents');
  assert.equal(jenna.evidence.followers, 993200);
  assert.equal(jenna.evidence.followers_source_url, 'https://www.tiktok.com/@jenna.and.her.gents');
  const dm = ps.find((p) => p.handle === '@diamondmama');
  assert.equal(dm.evidence.followers, null, 'a count whose source no web result returned is not stored');
  assert.equal(dm.contact_email, null, 'nor is an email');
  const run = s.service.tables.affiliate_discovery_runs.find((x) => x.id === run_id);
  assert.equal(run.status, 'ok');
  assert.equal(run.provider, 'anthropic');
  assert.equal(run.profiles_recognized, 2);
  assert.match(run.error, /^skipped: 1 likely minors, 1 not found/);
  const open = s.rpcs.find((x) => x.name === 'ai_credit_open');
  assert.equal(open.args.p_feature, 'affiliate_research');
  assert.equal(open.args.p_company, CO_A);
  assert.ok(s.rpcs.some((x) => x.name === 'ai_credit_step'), 'the hold is grown before the second model call');
  assert.equal(s.rpcs.find((x) => x.name === 'ai_credit_settle').args.p_outcome, 'succeeded');
  assert.equal(s.calls.length, 2, 'pause_turn is continued');
  assert.equal(s.calls[0].model, 'claude-sonnet-5-5');
});

await test('a run that keeps nobody is free, and a model failure is recorded', async () => {
  const none = setup({ script: [msg([{ type: 'tool_use', id: 't', name: 'record_creators', input: { creators: [LIST[2]] } }], 'tool_use')] });
  await none.call({ action: 'research', program_id: PA });
  assert.equal(none.service.tables.affiliate_prospects.length, 0);
  assert.equal(none.rpcs.find((x) => x.name === 'ai_credit_settle').args.p_outcome, 'failed');
  const bad = setup({ modelStatus: 529 });
  await bad.call({ action: 'research', program_id: PA });
  const run = bad.service.tables.affiliate_discovery_runs[0];
  assert.equal(run.status, 'error');
  assert.match(run.error, /model HTTP 529/);
  assert.equal(bad.rpcs.find((x) => x.name === 'ai_credit_settle').args.p_outcome, 'failed');
});

await test('one research per program at a time; a dead run does not block', async () => {
  const running = { id: 'r0', company_entity_id: CO_A, program_id: PA, provider: 'anthropic', status: 'running', started_at: '2026-11-10T11:58:00Z' };
  const s = setup({ runs: [running] });
  assert.equal((await s.call({ action: 'research', program_id: PA })).status, 429);
  assert.equal(s.calls.length, 0);
  assert.ok(!s.rpcs.some((x) => x.name === 'ai_credit_open'), 'nothing is held');
  const stale = setup({ runs: [{ ...running, started_at: '2026-11-10T11:30:00Z' }] });
  assert.equal((await stale.call({ action: 'research', program_id: PA })).status, 202);
});

await test('no key answers 503 and an inactive program 409, both before anything is spent', async () => {
  const s = setup({ apiKey: '' });
  assert.equal((await s.call({ action: 'research', program_id: PA })).status, 503);
  const p = setup();
  assert.equal((await p.call({ action: 'research', program_id: PPAUSED })).status, 409);
  for (const x of [s, p]) {
    assert.equal(x.calls.length, 0);
    assert.equal(x.service.tables.affiliate_discovery_runs.length, 0);
    assert.ok(!x.rpcs.length);
  }
});

await test('an imported list keeps profiles, skips minors, and reads follower counts', async () => {
  const s = setup();
  const rows = [
    { name: 'Jenna', handle: '@jenna.and.her.gents', primary: 'TikTok', url: 'https://www.tiktok.com/@jenna.and.her.gents', followers: '993.2K TikTok (TokRanks)', followerNum: '993200', fitWhy: 'sports mom', minor: 'FALSE' },
    { name: 'Kid', primary: 'Instagram', url: 'https://www.instagram.com/lathanthekidumpire/', minor: 'TRUE' },
    { name: 'No link', primary: 'TikTok', url: 'https://example.com/about' },
    { name: 'Blocked', handle: '@donotcontact', primary: 'TikTok', url: 'https://www.tiktok.com/@donotcontact' },
  ];
  const r = await s.call({ action: 'import', program_id: PA, rows });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.kept, 2);
  assert.equal(out.prospects_new, 1);
  assert.equal(out.skipped_minors, 1);
  assert.equal(out.skipped_not_profile, 1);
  assert.equal(out.suppressed_skipped, 1);
  const p = s.service.tables.affiliate_prospects[0];
  assert.equal(p.source, 'csv_import');
  assert.equal(p.evidence.followers, 993200);
  assert.equal(p.contact_email, null);
  assert.equal(s.service.tables.affiliate_discovery_runs[0].provider, 'import');
  assert.equal(s.calls.length, 0, 'an import never calls the model');
  const big = await setup().call({ action: 'import', program_id: PA, rows: Array.from({ length: 501 }, () => rows[0]) });
  assert.equal(big.status, 413);
});

await test('the shipped libs are byte-identical to scripts/lib', async () => {
  for (const f of ['affiliate-research-core.mjs', 'affiliate-discovery-core.mjs']) {
    const a = await readFile(new URL(`scripts/lib/${f}`, ROOT), 'utf8');
    const b = await readFile(new URL(`lib/${f}`, FN), 'utf8');
    assert.equal(b, a, `${f} copy drifted: re-copy it`);
  }
});

console.log(`\naffiliate-research-edge: ${passed} passed`);
