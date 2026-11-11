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
//   AFFILIATE_RESEARCH_MUTATION=imageseen    a photo URL no returned page showed is kept
//   AFFILIATE_RESEARCH_MUTATION=imagehttps   a plain-http or quote-breaking photo URL is kept
//   AFFILIATE_RESEARCH_MUTATION=imagehost    a photo read on another page (a list article) is kept
//   AFFILIATE_RESEARCH_MUTATION=doublerun    a second research starts while one runs
//   AFFILIATE_RESEARCH_MUTATION=oneround     a short run stops after one round
//   AFFILIATE_RESEARCH_MUTATION=partial      a failed later round throws away what was found
//   AFFILIATE_RESEARCH_MUTATION=onesource    one list article supplies the whole list
//   AFFILIATE_RESEARCH_MUTATION=onesearch    the typed words are searched once for all platforms together
//   AFFILIATE_RESEARCH_MUTATION=noshare      leads from the platform searches are not merged by profile
//   AFFILIATE_RESEARCH_MUTATION=notopup      a short run is not topped up from creators the per-source limit held back
//   AFFILIATE_RESEARCH_MUTATION=topupfirst   the top-up counts while searching, so the AI stops looking for variety
//   AFFILIATE_RESEARCH_MUTATION=leadevidence a Google lead does not count as found
//   AFFILIATE_RESEARCH_MUTATION=nobrief      the Google leads never reach the AI
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
  imageseen: [CORE, ' && seenText(evidence, image.toLowerCase())', ''],
  imagehttps: [CORE, "/^https:\\/\\/[^\\s\"'<>()\\\\]+$/.test(s)", '/^https?:/.test(s)'],
  imagehost: [CORE, ' && sameHost(c.profile_image_source_url, profile.profile_url)', ''],
  doublerun: ['handler.mjs', "    if (prev?.status === 'running' &&", '    if (false &&'],
  oneround: [CORE, '      if (!wanted || kept >= wanted ||', '      if (true ||'],
  partial: [CORE, '    catch (err) { if (rounds) return done(call - 1, String(err?.message || err)); throw err; }', '    catch (err) { throw err; }'],
  onesource: [CORE, '{ stats.over_source += 1; heldBack.push({ c, profile, key }); continue; }', '{ stats.over_source += 0; }'],
  onesearch: [CORE, '  return per.length > 1 ? per.map', '  return false ? per.map'],
  noshare: ['handler.mjs', 'leads: interleaveLeads(lists, MAX_LEADS)', 'leads: lists.flat().slice(0, MAX_LEADS)'],
  notopup: ['handler.mjs', 'collectedAt: now().toISOString(), fillTo: wanted });', 'collectedAt: now().toISOString() });'],
  topupfirst: ['handler.mjs', 'evidence: ev, program, focus, collectedAt }).stats.kept;', 'evidence: ev, program, focus, collectedAt, fillTo: wanted }).stats.kept;'],
  leadevidence: [CORE, '  const evidence = leadsEvidence(leads);', '  const evidence = { urls: new Set(), text: [] };'],
  nobrief: [CORE, "    leads.length ? leadsBrief(leads) : '',", "    '',"],
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
const { interleaveLeads, leadSearches } = await import(new URL(`lib/affiliate-research-core.mjs`, FN));

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
  affiliate_prospect_sources: [
    { id: 'src-a', company_entity_id: CO_A, program_id: PA, kind: 'serp_query', enabled: true, query: 'baseball mom', platform_hint: 'tiktok', max_results: 30, created_at: '2026-11-01' },
    { id: 'src-off', company_entity_id: CO_A, program_id: PA, kind: 'serp_query', enabled: false, query: 'paused search', max_results: 30, created_at: '2026-11-02' },
    { id: 'src-b', company_entity_id: CO_B, program_id: PB, kind: 'serp_query', enabled: true, query: 'golf', max_results: 30, created_at: '2026-11-01' },
  ],
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
// Two fetched pages: Jenna's own profile (which shows her photo URL) and a
// ranking page that shows a photo next to Diamond Mama's name.
const JENNA_PHOTO = 'https://p16-sign.tiktokcdn-us.example/tos/Jenna-Avatar.jpeg?x-expires=1';
const LIST_PHOTO = 'https://img.tokranks.example/diamondmama.jpg';
const FETCHED = [
  { type: 'web_fetch_tool_result', tool_use_id: 'srv2', content: { type: 'web_fetch_result', url: 'https://www.tiktok.com/@jenna.and.her.gents', content: { type: 'document', source: { type: 'text', data: `Jenna and Her Gents 993.2K Followers avatar ${JENNA_PHOTO} banner http://plain.example/a.jpg x https://evil.example/x.jpg');background:red` } } } },
  { type: 'web_fetch_tool_result', tool_use_id: 'srv3', content: { type: 'web_fetch_result', url: 'https://tokranks.example/baseballmom', content: { type: 'document', source: { type: 'text', data: `@diamondmama ${LIST_PHOTO}` } } } },
];
const creator = (o) => ({
  name: 'x', platform: 'tiktok', handle: '@x', profile_url: 'https://www.tiktok.com/@x', followers: null, followers_source_url: null,
  followers_as_of: null, profile_image_url: null, profile_image_source_url: null, fit_reason: 'baseball mom', found_on_url: null, contact_email: null, contact_source_url: null, likely_minor: false, ...o,
});
const LIST = [
  creator({ name: 'Jenna', handle: '@jenna.and.her.gents', profile_url: 'https://www.tiktok.com/@jenna.and.her.gents', followers: 993200, followers_source_url: 'https://www.tiktok.com/@jenna.and.her.gents', followers_as_of: '2026-11-10', found_on_url: 'https://www.tiktok.com/@jenna.and.her.gents', profile_image_url: JENNA_PHOTO, profile_image_source_url: 'https://www.tiktok.com/@jenna.and.her.gents' }),
  creator({ name: 'Diamond Mama', handle: '@diamondmama', profile_url: 'https://www.instagram.com/diamondmama', platform: 'instagram', followers: 41200, followers_source_url: 'https://made-up.example/stats', contact_email: 'dm@example.com', contact_source_url: 'https://made-up.example/contact', profile_image_url: LIST_PHOTO, profile_image_source_url: 'https://tokranks.example/baseballmom' }),
  creator({ name: 'Invented', handle: '@notreal', profile_url: 'https://www.tiktok.com/@notreal', followers: 500000, followers_source_url: 'https://www.tiktok.com/@notreal', profile_image_url: 'https://cdn.example/made-up.jpg', profile_image_source_url: 'https://www.tiktok.com/@notreal' }),
  creator({ name: 'Lathan', handle: '@lathanthekidumpire', profile_url: 'https://www.instagram.com/lathanthekidumpire/', platform: 'instagram', likely_minor: true }),
];
const msg = (content, stop) => ({ content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } } });
const SCRIPT = () => [
  msg([{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'baseball mom tiktok' } }, WEB_RESULTS, ...FETCHED], 'pause_turn'),
  msg([{ type: 'tool_use', id: 't1', name: 'record_creators', input: { creators: LIST } }], 'tool_use'),
];

function setup({ company = CO_A, gateError = null, apiKey = 'k', script = SCRIPT(), runs = [], modelStatus = 200, serp = null } = {}) {
  const log = []; const rpcs = []; const calls = []; const bg = []; const searches = [];
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
      if (next === 'fail') return { ok: false, status: 529, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => next };
    },
    background: (p) => { bg.push(p); },
    fetchSerp: serp ? async (task) => { searches.push(task); if (serp === 'fail') throw new Error('SERP provider HTTP 500'); return { items: serp, cost: 0.002 }; } : null,
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  const call = async (body, auth = 'Bearer t') => {
    const r = await handler(new Request('https://x/fn', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    await Promise.all(bg.splice(0));
    return r;
  };
  return { log, rpcs, calls, service, call, searches };
}

await test('a photo URL is kept only if the profile page text showed it, exactly as https', async () => {
  const jenna = (img) => creator({ name: 'Jenna', handle: '@jenna.and.her.gents', profile_url: 'https://www.tiktok.com/@jenna.and.her.gents', found_on_url: 'https://www.tiktok.com/@jenna.and.her.gents', profile_image_url: img, profile_image_source_url: 'https://www.tiktok.com/@jenna.and.her.gents' });
  for (const img of ['https://p16-sign.tiktokcdn-us.example/tos/made-up.jpeg', 'http://plain.example/a.jpg', "https://evil.example/x.jpg');background:red"]) {
    const s = setup({ script: [
      msg([{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q' } }, WEB_RESULTS, ...FETCHED], 'pause_turn'),
      msg([{ type: 'tool_use', id: 't1', name: 'record_creators', input: { creators: [jenna(img)] } }], 'tool_use'),
    ] });
    await s.call({ action: 'research', program_id: PA, count: 5 });
    const p = s.service.tables.affiliate_prospects.find((x) => x.handle === '@jenna.and.her.gents');
    assert.ok(p, 'the creator is still kept');
    assert.equal(p.evidence.profile_image_url ?? null, null, `not stored: ${img}`);
  }
});

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
  const r = await s.call({ action: 'research', program_id: PA, focus: 'baseball moms', count: 5 });
  assert.equal(r.status, 202);
  const { run_id } = await r.json();
  const ps = s.service.tables.affiliate_prospects;
  assert.deepEqual(ps.map((p) => p.handle).sort(), ['@diamondmama', '@jenna.and.her.gents'], 'invented and minor creators are not stored');
  assert.ok(ps.every((p) => p.source === 'ai_research' && p.company_entity_id === CO_A));
  const jenna = ps.find((p) => p.handle === '@jenna.and.her.gents');
  assert.equal(jenna.evidence.followers, 993200);
  assert.equal(jenna.evidence.followers_source_url, 'https://www.tiktok.com/@jenna.and.her.gents');
  assert.equal(jenna.evidence.followers_source_kind, 'profile', 'a count read on the creator\'s own profile says so');
  const dm = ps.find((p) => p.handle === '@diamondmama');
  assert.equal(dm.evidence.followers, null, 'a count whose source no web result returned is not stored');
  assert.equal(dm.contact_email, null, 'nor is an email');
  assert.equal(jenna.evidence.profile_image_url, JENNA_PHOTO, 'a photo URL shown on the creator\'s own fetched profile is kept exactly');
  assert.equal(jenna.evidence.profile_image_source_url, 'https://www.tiktok.com/@jenna.and.her.gents');
  assert.equal(jenna.evidence.profile_image_as_of, '2026-11-10');
  assert.equal(dm.evidence.profile_image_url ?? null, null, 'a photo seen on another page (a list article) is never put on a creator');
  const run = s.service.tables.affiliate_discovery_runs.find((x) => x.id === run_id);
  assert.equal(run.status, 'ok');
  assert.equal(run.provider, 'anthropic');
  assert.equal(run.profiles_recognized, 2);
  assert.match(run.error, /^skipped: 1 likely minors, 1 not found/);
  assert.match(run.error, /found 2 of 5$/, 'a short run says how many of the number asked for it found');
  const open = s.rpcs.find((x) => x.name === 'ai_credit_open');
  assert.equal(open.args.p_feature, 'affiliate_research');
  assert.equal(open.args.p_company, CO_A);
  assert.ok(s.rpcs.some((x) => x.name === 'ai_credit_step'), 'the hold is grown before the second model call');
  assert.equal(s.rpcs.find((x) => x.name === 'ai_credit_settle').args.p_outcome, 'succeeded');
  assert.equal(s.calls.length, 3, 'pause_turn is continued, then one more round is asked for');
  assert.equal(s.calls[0].model, 'claude-sonnet-5-5');
});

await test('a run keeps searching until it has the number asked for, never repeating', async () => {
  const more = {
    type: 'web_search_tool_result', tool_use_id: 'srv2',
    content: [
      { type: 'web_search_result', url: 'https://www.youtube.com/@CoachPat', title: 'Coach Pat (@CoachPat) - YouTube' },
      { type: 'web_search_result', url: 'https://www.youtube.com/@DugoutDad', title: 'Dugout Dad - YouTube' },
      { type: 'web_search_result', url: 'https://www.youtube.com/@CageWork', title: 'Cage Work - YouTube' },
    ],
  };
  const s = setup({ script: [
    ...SCRIPT(),
    msg([{ type: 'server_tool_use', id: 'srv2', name: 'web_search', input: { query: 'more' } }, more,
      { type: 'tool_use', id: 't2', name: 'record_creators', input: { creators: ['CoachPat', 'DugoutDad', 'CageWork'].map((h) => creator({ name: h, platform: 'youtube', handle: `@${h}`, profile_url: `https://www.youtube.com/@${h}` })) } }], 'tool_use'),
  ] });
  await s.call({ action: 'research', program_id: PA, count: 5 });
  assert.equal(s.calls.length, 3, 'two rounds, then it stops at the number asked for');
  const ask = s.calls[2].messages.at(-1);
  assert.equal(ask.role, 'user');
  assert.equal(ask.content[0].type, 'tool_result');
  assert.equal(ask.content[0].tool_use_id, 't1');
  assert.match(ask.content[0].content, /2 of 5 confirmed/);
  assert.match(ask.content[0].content, /@jenna\.and\.her\.gents/, 'the creators already found are listed so they are not repeated');
  assert.equal(s.service.tables.affiliate_prospects.length, 5);
  assert.equal(s.service.tables.affiliate_discovery_runs[0].error, 'skipped: 1 likely minors, 1 not found on a page read, 0 not a profile link');
});

await test('a later round that fails keeps the creators already found', async () => {
  const s = setup({ script: [...SCRIPT(), 'fail'] });
  await s.call({ action: 'research', program_id: PA, count: 10 });
  assert.equal(s.calls.length, 3, 'the extra round was tried');
  const run = s.service.tables.affiliate_discovery_runs[0];
  assert.equal(run.status, 'ok', 'the first round is saved, not thrown away');
  assert.match(run.error, /found 2 of 10$/);
  assert.equal(s.service.tables.affiliate_prospects.length, 2);
  assert.equal(s.rpcs.find((x) => x.name === 'ai_credit_settle').args.p_outcome, 'succeeded');
});

await test('no single outside page supplies more than five creators', async () => {
  const handles = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const list = {
    type: 'web_fetch_tool_result', tool_use_id: 'srv3',
    content: { type: 'web_fetch_result', url: 'https://www.listicle.example/best-creators', content: { type: 'document', source: { type: 'text', data: handles.map((h) => `@${h} 10K followers`).join('\n') } } },
  };
  const s = setup({ script: [msg([{ type: 'server_tool_use', id: 'srv3', name: 'web_fetch', input: { url: 'https://www.listicle.example/best-creators' } }, list,
    { type: 'tool_use', id: 't3', name: 'record_creators', input: { creators: handles.map((h) => creator({ name: h, handle: `@${h}`, profile_url: `https://www.tiktok.com/@${h}`, followers: 10000, followers_source_url: 'https://www.listicle.example/best-creators', found_on_url: 'https://www.listicle.example/best-creators' })) } }], 'tool_use')] });
  await s.call({ action: 'research', program_id: PA, count: 5 });
  const ps = s.service.tables.affiliate_prospects;
  assert.equal(ps.length, 5);
  assert.ok(ps.every((p) => p.evidence.followers_source_kind === 'other_page'), 'a count from a list article is labelled as such');
  assert.match(s.service.tables.affiliate_discovery_runs[0].error, /2 over the per-source limit/);
});

await test('a run short of its number is topped up from creators the per-source limit held back, after searching on', async () => {
  const handles = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const list = {
    type: 'web_fetch_tool_result', tool_use_id: 'srv3',
    content: { type: 'web_fetch_result', url: 'https://www.listicle.example/best-creators', content: { type: 'document', source: { type: 'text', data: handles.map((h) => `@${h} 10K followers`).join('\n') } } },
  };
  const rec = (id) => ({ type: 'tool_use', id, name: 'record_creators', input: { creators: handles.map((h) => creator({ name: h, handle: `@${h}`, profile_url: `https://www.tiktok.com/@${h}`, found_on_url: 'https://www.listicle.example/best-creators' })) } });
  const s = setup({ script: [
    msg([{ type: 'server_tool_use', id: 'srv3', name: 'web_fetch', input: { url: 'https://www.listicle.example/best-creators' } }, list, rec('t3')], 'tool_use'),
    msg([{ type: 'tool_use', id: 't4', name: 'record_creators', input: { creators: [] } }], 'tool_use'),
  ] });
  await s.call({ action: 'research', program_id: PA, count: 7 });
  assert.equal(s.calls.length, 2, 'it first asks for more creators from other sources');
  assert.deepEqual(s.service.tables.affiliate_prospects.map((p) => p.handle).sort(), handles.map((h) => `@${h}`), 'then the held-back creators fill the run');
  const err = s.service.tables.affiliate_discovery_runs[0].error;
  assert.match(err, /2 added from a list page to fill the run/);
  assert.doesNotMatch(err, /over the per-source limit|found \d+ of/);
});

await test('Google leads go to the AI first; only the ones it checks and records are kept', async () => {
  const serp = [
    { type: 'organic', url: 'https://google.com/goto?url=CAES1', breadcrumb: 'https://www.tiktok.com › @leadcreator', title: 'Lead Creator (@leadcreator) | TikTok', description: 'baseball mom life' },
    { type: 'organic', url: 'https://www.tiktok.com/@junkstore', title: 'Junk Store (@junkstore)', description: 'shop now' },
  ];
  const s = setup({ serp, script: [msg([{ type: 'tool_use', id: 't', name: 'record_creators', input: { creators: [
    creator({ name: 'Lead Creator', handle: '@leadcreator', profile_url: 'https://www.tiktok.com/@leadcreator' }),
  ] } }], 'tool_use')] });
  await s.call({ action: 'research', program_id: PA, focus: 'travel ball parents', count: 5 });
  assert.deepEqual(s.searches.map((t) => t.keyword), ['travel ball parents site:tiktok.com/@', 'travel ball parents site:instagram.com', 'travel ball parents site:youtube.com/@'],
    'the typed words, once per ticked platform; an old saved search does not steer it');
  const brief = s.calls[0].messages[0].content;
  assert.match(brief, /Leads from a Google search/);
  assert.match(brief, /https:\/\/www\.tiktok\.com\/@leadcreator/);
  assert.match(brief, /@junkstore/);
  const ps = s.service.tables.affiliate_prospects;
  assert.deepEqual(ps.map((p) => p.handle), ['@leadcreator'], 'a lead the AI recorded is kept on the strength of the real search result; one it dropped is never stored');
  assert.equal(ps[0].source, 'ai_research');
  assert.match(s.service.tables.affiliate_discovery_runs[0].error, /2 Google leads checked$/, 'the same profile from two searches is one lead');
});

await test('each platform search gets a share of the leads; no words means no searches', async () => {
  const lead = (pl, i) => ({ profile_url: `https://www.${pl}.com/@${pl}${i}` });
  const yt = Array.from({ length: 50 }, (_, i) => lead('youtube', i));
  const tt = Array.from({ length: 3 }, (_, i) => lead('tiktok', i));
  const out = interleaveLeads([yt, tt], 10);
  assert.equal(out.length, 10);
  assert.equal(out.filter((c) => c.profile_url.includes('tiktok')).length, 3, 'a quieter platform is not crowded out by a busy one');
  assert.deepEqual(leadSearches({ platforms: ['youtube'] }, 'q').map((x) => x.platform_hint), [null], 'one platform: one search, pinned the usual way');
  assert.equal(leadSearches({ platforms: ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest'] }, 'q').length, 4, 'at most four searches a run');
  assert.deepEqual(leadSearches({ platforms: ['tiktok', 'youtube'] }, '  '), []);
});

await test('a failed Google search does not stop the research', async () => {
  const s = setup({ serp: 'fail' });
  await s.call({ action: 'research', program_id: PA, count: 5 });
  assert.equal(s.service.tables.affiliate_discovery_runs[0].status, 'ok');
  assert.equal(s.service.tables.affiliate_prospects.length, 2);
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
