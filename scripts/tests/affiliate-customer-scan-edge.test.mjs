// "Find their social accounts" (affiliate-research action customer_scan),
// executed in Node: the pure lib directly, then the real handler with a fake
// Supabase, a fake search provider and a fake model.
//
// Properties:
//   * a customer who UNSUBSCRIBED is never queued, searched or researched,
//     while one whose consent was never checked (NULL) IS scanned -- consent
//     is a filter, never a gate, and a plain NOT IN would drop every NULL;
//   * a follower count is kept only when a result's own text states it, and
//     the model never supplies one: its choice must be a profile that row was
//     shown, and the count is re-read from that profile's text;
//   * only a profile carrying the customer's first AND last name counts;
//   * one search per customer, never a second for a customer this program
//     already scanned; rows are queued before any search, so a run that runs
//     out of time leaves a queue the next press finishes;
//   * a press while a scan runs joins it; a dead worker's scan is taken over;
//   * the model is asked only about ambiguous searches, AI_BATCH at a time,
//     under the 'affiliate_research' credit hold;
//   * the company comes from the caller-token gate, and every write is scoped
//     to it;
//   * spend is recorded on the scan row (cost_usd) and nowhere the page reads;
//   * the function's lib/ copy is byte-identical to scripts/lib/, and the
//     slice orderings equal the Your Customers list's.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_SCAN_MUTATION=nullconsent  the opt-out filter is a plain NOT IN, dropping unmeasured customers
//   AFFILIATE_SCAN_MUTATION=optoutscan   unsubscribed customers are scanned
//   AFFILIATE_SCAN_MUTATION=aicount      the model's chosen profile keeps a count its text does not state
//   AFFILIATE_SCAN_MUTATION=aianyurl     the model may choose a profile the row was never shown
//   AFFILIATE_SCAN_MUTATION=firstonly    a profile with only the first name counts as theirs
//   AFFILIATE_SCAN_MUTATION=rescan       a customer already scanned for this program is searched again
//   AFFILIATE_SCAN_MUTATION=nojoin       a second press starts a second scan while one runs
//   AFFILIATE_SCAN_MUTATION=noresume     rows a stopped scan left pending are not finished by the next press
//   AFFILIATE_SCAN_MUTATION=resumeoptout a queued customer who unsubscribed since is still searched on resume
//   AFFILIATE_SCAN_MUTATION=aiall        the model is asked about every customer, not only ambiguous ones
//   AFFILIATE_SCAN_MUTATION=nobar        the program's follower bar is ignored for the default
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_SCAN_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);
const FN = new URL('supabase/functions/affiliate-research/', ROOT);
const LIB = 'lib/affiliate-customer-scan-core.mjs';
const MUTS = {
  nullconsent: ['handler.mjs', ".or(`email_consent_state.is.null,email_consent_state.not.in.(${NEVER_SCAN_CONSENT.join(',')})`);", ".not('email_consent_state', 'in', `(${NEVER_SCAN_CONSENT.join(',')})`);"],
  optoutscan: ['handler.mjs', ".or(`email_consent_state.is.null,email_consent_state.not.in.(${NEVER_SCAN_CONSENT.join(',')})`);", ';'],
  aicount: [LIB, "    const f = parseFollowers(`${c.title} ${c.snippet}`);\n    const pick", "    const f = parseFollowers(`${c.title} ${c.snippet}`) || { count: 5000, approx: false, quote: 'model said' };\n    const pick"],
  aianyurl: [LIB, "    if (!c) return { key: r.key, status: 'ambiguous', pick: null };\n", "    if (!c) return { key: r.key, status: 'found', pick: { profile_url: url, followers: 5000, followers_quote: 'x' } };\n"],
  firstonly: [LIB, '  return has(person.first) && has(person.last);', '  return has(person.first);'],
  rescan: ['handler.mjs', "      pick = pick.filter((r) => !seen.has(r.customer_key)).slice(0, need);", '      pick = pick.slice(0, need);'],
  nojoin: ['handler.mjs', "      if (now().getTime() - beat < STALE_SCAN_MS) return reply({ scan_id: prev.id, joined: true });\n", ''],
  noresume: ['handler.mjs', "    const resumed = (left || []).filter(eligible).map((r) => r.id);", '    const resumed = [];'],
  resumeoptout: ['handler.mjs', "    const eligible = (r) => {\n      const c = now_.get(r.customer_key);", "    const eligible = () => true;\n    const _was = (r) => {\n      const c = now_.get(r.customer_key);"],
  aiall: ['handler.mjs', "            if (j.status === 'ambiguous') ambiguous.push(", '            if (true) ambiguous.push('],
  nobar: [LIB, '  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_MIN_FOLLOWERS;', '  return DEFAULT_MIN_FOLLOWERS;'],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
// Every pattern must match the UNMUTATED source, every run: a mutation whose
// pattern drifted would otherwise "fail" for the wrong reason forever.
for (const [name, [file, from]] of Object.entries(MUTS)) {
  const src = await readFile(new URL(file, FN), 'utf8');
  if (!src.includes(from)) { console.error(`mutation ${name} no longer matches ${file}: fix its pattern`); process.exit(3); }
}
async function load() {
  if (!MUT) return { H: await import(new URL('handler.mjs', FN)), L: await import(new URL(LIB, FN)) };
  const tmp = await mkdtemp(join(tmpdir(), 'affscan-'));
  await cp(FN, tmp, { recursive: true });
  const [file, from, to] = MUTS[MUT];
  const path = join(tmp, file);
  await writeFile(path, (await readFile(path, 'utf8')).split(from).join(to));
  return {
    H: await import(pathToFileURL(join(tmp, 'handler.mjs')).href),
    L: await import(pathToFileURL(join(tmp, LIB)).href),
  };
}
const { H, L } = await load();
const { createResearchHandler } = H;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

// ── The pure lib ──────────────────────────────────────────────────────────
await test('the function ships the lib byte for byte, and the slice orderings are the list\'s own', async () => {
  const a = await readFile(new URL('scripts/lib/affiliate-customer-scan-core.mjs', ROOT), 'utf8');
  const b = await readFile(new URL('supabase/functions/affiliate-research/lib/affiliate-customer-scan-core.mjs', ROOT), 'utf8');
  if (!MUT) assert.equal(b, a, 'lib/affiliate-customer-scan-core.mjs must be a verbatim copy of scripts/lib/');
  const core = await import(new URL('v2/affiliates/studio-core.js', ROOT));
  assert.deepEqual(L.SCAN_SORTS, core.CUSTOMER_SORTS, '"scan 500" must scan the top 500 the person is looking at');
});

await test('a person\'s name is searched; a business, initials or one word is not', () => {
  assert.deepEqual(L.personName('emily durrance'), { first: 'emily', last: 'durrance', display: 'Emily Durrance' });
  assert.equal(L.personName('josé  peña').display, 'Jose Pena');
  assert.equal(L.personName('mary-kate o\'neil').display, 'Mary-Kate O\'Neil');
  for (const n of ['cher', 'j r', 'team store', 'acme baseball llc', 'john smith 2', '', null]) assert.equal(L.personName(n), null, String(n));
  assert.equal(L.scanQuery(L.personName('emily durrance'), 'Phoenix'), '"Emily Durrance" Phoenix');
  assert.equal(L.scanQuery(L.personName('emily durrance'), null), '"Emily Durrance"');
});

await test('a follower count is read only from what the text states, and a floor is marked approximate', () => {
  assert.deepEqual(L.parseFollowers('1,204 Followers, 300 Following, 12 Posts'), { count: 1204, approx: false, quote: '1,204 Followers' });
  assert.deepEqual(L.parseFollowers('10K+ followers · 360 following'), { count: 10000, approx: true, quote: '10K+ followers' });
  assert.equal(L.parseFollowers('Jo (@jo) on TikTok | 4.1M Likes. 12.3K Followers.').count, 12300);
  assert.equal(L.parseFollowers('2.5M subscribers').count, 2500000);
  assert.equal(L.parseFollowers('840 followers').count, 840);
  assert.equal(L.parseFollowers('360 following · 38 posts'), null, '"following" is not followers');
  assert.equal(L.parseFollowers('Loves baseball'), null, 'no count stated is null, never zero');
});

const PROGRAM = { id: 'p', company_entity_id: 'c', niche: 'baseball', platforms: ['instagram', 'tiktok'] };
const ig = (handle, title, snippet, rank = 1) => ({ type: 'organic', url: `https://www.instagram.com/${handle}/`, title, description: snippet, rank_absolute: rank });
const person = L.personName('emily durrance');

await test('one profile carrying their name answers it: found, below the bar, or no count stated', () => {
  const found = L.judgeResults({ items: [ig('emdurrance', 'Emily Durrance (@emdurrance)', '1,204 Followers, 300 Following')], person, program: PROGRAM, minFollowers: 750, collectedAt: 'now' });
  assert.equal(found.status, 'found');
  assert.equal(found.pick.profile_url, 'https://www.instagram.com/emdurrance');
  assert.equal(found.pick.followers, 1204);
  assert.equal(found.pick.followers_quote, '1,204 Followers');
  assert.equal(L.judgeResults({ items: [ig('emdurrance', 'Emily Durrance (@emdurrance)', '204 Followers')], person, program: PROGRAM, minFollowers: 750, collectedAt: 'now' }).status, 'below');
  const nc = L.judgeResults({ items: [ig('emdurrance', 'Emily Durrance (@emdurrance)', 'Mom of three. Phoenix.')], person, program: PROGRAM, minFollowers: 750, collectedAt: 'now' });
  assert.equal(nc.status, 'no_count');
  assert.equal(nc.pick.followers, null, 'unstated is null, never zero');
});

await test('only a profile carrying first AND last name counts; two of them is a question for the model', () => {
  const firstOnly = L.judgeResults({ items: [ig('emily.k', 'Emily Kim (@emily.k)', '9,000 Followers')], person, program: PROGRAM, collectedAt: 'now' });
  assert.equal(firstOnly.status, 'none', 'another Emily is not this customer');
  const two = L.judgeResults({ items: [ig('emdurrance', 'Emily Durrance (@emdurrance)', '1,204 Followers'), ig('emily_durrance_az', 'Emily Durrance (@emily_durrance_az)', 'Phoenix AZ · 3,100 Followers', 2)], person, program: PROGRAM, collectedAt: 'now' });
  assert.equal(two.status, 'ambiguous');
  assert.equal(two.candidates.length, 2);
  const watch = L.judgeResults({ items: [{ type: 'organic', url: 'https://www.youtube.com/watch?v=x', title: 'Emily Durrance hits a homer' }], person, program: PROGRAM, collectedAt: 'now' });
  assert.equal(watch.status, 'none', 'a video is not a profile');
});

await test('the model may only choose a profile it was shown, and never supplies the count', () => {
  const rows = [
    { key: 'a', candidates: [{ profile_url: 'https://www.instagram.com/one', title: 'Emily Durrance', snippet: '3,100 Followers', platform: 'instagram', handle: '@one' }, { profile_url: 'https://www.instagram.com/two', title: 'Emily Durrance', snippet: 'Phoenix', platform: 'instagram', handle: '@two' }] },
    { key: 'b', candidates: [{ profile_url: 'https://www.instagram.com/three', title: 'Bo Lee', snippet: 'no count here', platform: 'instagram', handle: '@three' }] },
    { key: 'c', candidates: [{ profile_url: 'https://www.instagram.com/four', title: 'Cy Ray', snippet: '1,000 Followers', platform: 'instagram', handle: '@four' }] },
    { key: 'd', candidates: [{ profile_url: 'https://www.instagram.com/five', title: 'Di Ho', snippet: '900 Followers', platform: 'instagram', handle: '@five' }] },
  ];
  const answer = { content: [{ type: 'tool_use', name: 'record_matches', input: { matches: [
    { key: 'a', profile_url: 'https://www.instagram.com/one' },
    { key: 'b', profile_url: 'https://www.instagram.com/three', followers: 50000 },
    { key: 'c', profile_url: 'https://www.instagram.com/not-shown' },
    { key: 'd', profile_url: null },
  ] } }] };
  const out = Object.fromEntries(L.applyAiAnswer({ rows, answer, minFollowers: 750 }).map((o) => [o.key, o]));
  assert.equal(out.a.status, 'found'); assert.equal(out.a.pick.followers, 3100);
  assert.equal(out.b.status, 'no_count', 'a number the model offers is ignored'); assert.equal(out.b.pick.followers, null);
  assert.equal(out.c.status, 'ambiguous', 'a profile the row was never shown is refused');
  assert.equal(out.d.status, 'none');
});

await test('the bar is the program\'s own; the slice is clamped and never includes unsubscribed', () => {
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 2000 }), 2000);
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 0 }), 0);
  assert.equal(L.minFollowersFor({}), 750);
  assert.equal(L.clampScanCount(5000), 1000); assert.equal(L.clampScanCount(0), 500); assert.equal(L.clampScanCount('x'), 500);
  const f = L.scanFilters({ consent: 'unsubscribed', minOrders: 99, to: '2026-12-31', sort: 'drop table' });
  assert.equal(f.consent, 'any', 'unsubscribed cannot be chosen as a slice');
  assert.equal(f.minOrders, 50); assert.equal(f.toExclusive, '2027-01-01'); assert.equal(f.sort, 'orders');
});

// ── The handler ───────────────────────────────────────────────────────────
const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// A PostgREST stand-in rich enough for this action: eq / in / gte / lt / is,
// the or() the opt-out filter uses, order, range, limit and the unique keys
// the migration declares.
function fakeService(seed) {
  const tables = structuredClone(seed);
  const log = []; const rpcs = [];
  let n = 1;
  const cmp = (op, v, x) => {
    if (op === 'eq') return v === x;
    if (op === 'is') return x === null ? v === null || v === undefined : v === x;
    if (op === 'in') return x.includes(v);
    if (op === 'gte') return v !== null && v !== undefined && v >= x;
    if (op === 'lt') return v !== null && v !== undefined && v < x;
    if (op === 'notin') return v !== null && v !== undefined && !x.includes(v);
    throw new Error(op);
  };
  const orClause = (expr) => expr.split(/,(?![^(]*\))/).map((c) => {
    const m = c.match(/^([a-z_]+)\.(is|eq|not\.in)\.(.*)$/);
    if (!m) throw new Error(`fake or(): ${c}`);
    const [, col, op, raw] = m;
    if (op === 'is') return (r) => cmp('is', r[col], raw === 'null' ? null : raw);
    if (op === 'eq') return (r) => cmp('eq', r[col], raw);
    return (r) => cmp('notin', r[col], raw.replace(/^\(|\)$/g, '').split(','));
  });
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let single = false; let maybe = false; let lim = null; const ords = []; let rng = null;
    const run = () => {
      log.push(`${op}:${table}`);
      const rows = (tables[table] ||= []);
      const match = (r) => filters.every((f) => f(r));
      if (op === 'select') {
        let out = rows.filter(match).map((r) => ({ ...r }));
        if (ords.length) out.sort((a, b) => { for (const o of ords) { if (a[o.k] === b[o.k]) continue; return (a[o.k] < b[o.k] ? -1 : 1) * (o.asc ? 1 : -1); } return 0; });
        if (rng) out = out.slice(rng[0], rng[1] + 1);
        if (lim != null) out = out.slice(0, lim);
        if (maybe) return { data: out[0] ?? null, error: null };
        if (single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not one row' } };
        return { data: out, error: null };
      }
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        let last = null;
        for (const r of list) {
          if (table === 'affiliate_customer_scans' && r.status === 'running'
            && rows.some((x) => x.status === 'running' && x.company_entity_id === r.company_entity_id && x.program_id === r.program_id)) {
            return { data: null, error: { code: '23505', message: 'one running scan per program' } };
          }
          if (table === 'affiliate_customer_social'
            && rows.some((x) => x.company_entity_id === r.company_entity_id && x.program_id === r.program_id && x.customer_key === r.customer_key)) {
            return { data: null, error: { code: '23505', message: 'customer already scanned for this program' } };
          }
          last = { id: `${table}-${n++}`, created_at: new Date(1_700_000_000_000 + n).toISOString(), ...r }; rows.push(last);
        }
        return { data: single ? { id: last.id } : null, error: null };
      }
      if (op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
      throw new Error(op);
    };
    const b = {
      select() { return b; }, delete() { op = 'delete'; return b; }, insert(p) { op = 'insert'; payload = p; return b; }, update(p) { op = 'update'; payload = p; return b; },
      eq(k, v) { filters.push((r) => cmp('eq', r[k], v)); return b; }, in(k, v) { filters.push((r) => cmp('in', r[k], v)); return b; },
      gte(k, v) { filters.push((r) => cmp('gte', r[k], v)); return b; }, lt(k, v) { filters.push((r) => cmp('lt', r[k], v)); return b; },
      is(k, v) { filters.push((r) => cmp('is', r[k], v)); return b; },
      not(k, o, v) { assert.equal(o, 'in'); const list = String(v).replace(/^\(|\)$/g, '').split(','); filters.push((r) => cmp('notin', r[k], list)); return b; },
      or(expr) { const cs = orClause(expr); filters.push((r) => cs.some((c) => c(r))); return b; },
      order(k, o) { ords.push({ k, asc: o?.ascending !== false }); return b; }, limit(x) { lim = x; return b; }, range(a, z) { rng = [a, z]; return b; },
      single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  const rpc = async (name, args) => {
    rpcs.push({ name, args });
    if (name === 'ai_credit_open') return { data: { ok: true, mode: 'enforce', held_micros: 1000 }, error: null };
    if (name === 'ai_credit_step') return { data: { ok: true, held_micros: 2000 }, error: null };
    if (name === 'ai_credit_settle') return { data: { ok: true, outcome: args.p_outcome, enforced: true, charged_micros: 0 }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  return { tables, from: builder, rpc, log, rpcs };
}

const cust = (key, name, o = {}) => ({ company_entity_id: CO, customer_key: key, email_lc: `${key}@buyer.invalid`, name_lc: name, first_name_lc: null, last_name_lc: null, order_count: 5, last_order_at: '2026-10-01T00:00:00Z', lifetime_spend: 500, email_consent_state: null, ...o });
const seed = (extra = {}) => ({
  affiliate_programs: [{ id: PA, company_entity_id: CO, name: 'A', status: 'active', niche: 'baseball', platforms: ['instagram', 'tiktok'], geographies: [], customer_scan_min_followers: 750 }],
  company_customer_profiles: [
    cust('emily', 'emily durrance', { order_count: 9 }),
    cust('nobody', 'quiet person', { order_count: 8 }),
    cust('optout', 'olive out', { order_count: 7, email_consent_state: 'unsubscribed' }),
    cust('twins', 'sam twin', { order_count: 6, email_consent_state: 'subscribed' }),
    cust('biz', 'team store', { order_count: 6 }),
    cust('otherco', 'emily durrance', { order_count: 99, company_entity_id: OTHER }),
  ],
  shopify_customers: [{ company_entity_id: CO, email_lc: 'emily@buyer.invalid', city: 'Phoenix' }],
  affiliate_suppressions: [],
  affiliate_customer_scans: [],
  affiliate_customer_social: [],
  ...extra,
});
// What the provider returns for each customer's search.
const RESULTS = {
  'Emily Durrance': [ig('emdurrance', 'Emily Durrance (@emdurrance)', '1,204 Followers, 300 Following')],
  'Quiet Person': [],
  'Sam Twin': [ig('samtwin', 'Sam Twin (@samtwin)', '5,000 Followers'), ig('samtwin_az', 'Sam Twin (@samtwin_az)', 'Phoenix', 2)],
  'Olive Out': [ig('oliveout', 'Olive Out (@oliveout)', '90K Followers')],
};
function setup({ data = seed(), apiKey = 'k', clock = null, budgetHit = false } = {}) {
  const service = fakeService(data);
  const searches = []; const modelCalls = []; const bg = [];
  let t = Date.parse('2026-11-24T04:00:00Z');
  const handler = createResearchHandler({
    service,
    userClientFor: () => ({
      rpc: async () => ({ data: CO, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: '99999999-9999-4999-8999-999999999999' } } }) },
    }),
    apiKey,
    now: () => new Date(clock ? clock() : t),
    fetchSerp: async (task) => {
      searches.push(task);
      // A run that hits its time limit: the clock jumps after the first search.
      if (budgetHit) t += 10 * 60_000;
      const name = (task.keyword.match(/"([^"]+)"/) || [])[1];
      return { items: RESULTS[name] || [], cost: 0.002 };
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      modelCalls.push(body);
      const lines = body.messages[0].content;
      const keys = [...lines.matchAll(/Customer (\S+):/g)].map((m) => m[1]);
      return { ok: true, json: async () => ({
        content: [{ type: 'tool_use', name: 'record_matches', input: { matches: keys.map((k) => ({ key: k, profile_url: 'https://www.instagram.com/samtwin' })) } }],
        usage: { input_tokens: 500, output_tokens: 50 },
      }) };
    },
    background: (p) => { bg.push(p); },
  });
  const call = async (body) => {
    const res = await handler(new Request('https://fn.test', { method: 'POST', headers: { Authorization: 'Bearer user', 'Content-Type': 'application/json' }, body: JSON.stringify({ program_id: PA, action: 'customer_scan', ...body }) }));
    return { status: res.status, body: await res.json() };
  };
  return { service, searches, modelCalls, bg, call, settle: () => Promise.all(bg), tick: (ms) => { t += ms; } };
}
const row = (s, key) => s.service.tables.affiliate_customer_social.find((r) => r.customer_key === key);

await test('a press scans the slice: one search each, opt-outs and businesses never, unmeasured consent always', async () => {
  const s = setup();
  const r = await s.call({ count: 500, filters: { minOrders: 2, consent: 'any', sort: 'orders' } });
  assert.equal(r.status, 202);
  await s.settle();
  const keys = s.service.tables.affiliate_customer_social.map((x) => x.customer_key).sort();
  assert.deepEqual(keys, ['emily', 'nobody', 'twins'], 'unsubscribed, a business and another company\'s customer are never queued');
  assert.ok(!s.searches.some((t) => /Olive Out/.test(t.keyword)), 'an opt-out is never searched');
  assert.ok(row(s, 'nobody'), 'a customer whose consent was never checked IS scanned');
  assert.equal(s.searches.length, 3, 'one search per customer');
  assert.match(s.searches.find((t) => /Emily/.test(t.keyword)).keyword, /^"Emily Durrance" Phoenix \(site:instagram\.com OR site:tiktok\.com\/@\)$/, 'name, city, pinned to the program\'s platforms');
  assert.equal(row(s, 'emily').status, 'found');
  assert.equal(row(s, 'emily').followers, 1204);
  assert.equal(row(s, 'emily').followers_quote, '1,204 Followers');
  assert.equal(row(s, 'emily').decided_by, 'search');
  assert.equal(row(s, 'nobody').status, 'none');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.company_entity_id, CO);
  assert.equal(scan.status, 'done');
  assert.deepEqual([scan.requested, scan.checked, scan.found], [3, 3, 2]);
  assert.equal(scan.cost_usd, 0.006, 'spend is recorded for SILO');
});

await test('the model is asked about ambiguous searches only, under the research credit hold', async () => {
  const s = setup();
  await s.call({ count: 500, filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(s.modelCalls.length, 1, 'one request for the one ambiguous customer');
  assert.ok(/Customer twins:/.test(s.modelCalls[0].messages[0].content));
  assert.ok(!/Customer emily:/.test(s.modelCalls[0].messages[0].content), 'a search that answered it is never sent to the model');
  assert.equal(s.modelCalls[0].tools.length, 1, 'no web tools');
  assert.equal(row(s, 'twins').status, 'found');
  assert.equal(row(s, 'twins').decided_by, 'ai');
  assert.equal(row(s, 'twins').followers, 5000, 'read from the chosen profile\'s own text');
  const open = s.service.rpcs.find((x) => x.name === 'ai_credit_open');
  assert.equal(open.args.p_feature, 'affiliate_research');
  assert.equal(open.args.p_company, CO);
});

await test('no model key leaves ambiguous customers ambiguous, with their candidates, never "none"', async () => {
  const s = setup({ apiKey: '' });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(row(s, 'twins').status, 'ambiguous');
  assert.equal(row(s, 'twins').candidates.length, 2);
});

await test('a customer this program already scanned is never searched or paid for twice', async () => {
  const s = setup({ data: seed({ affiliate_customer_social: [{ id: 'old', company_entity_id: CO, program_id: PA, customer_key: 'emily', status: 'found', created_at: '2026-11-01' }] }) });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.ok(!s.searches.some((t) => /Emily/.test(t.keyword)), 'Emily was scanned last week');
  assert.equal(s.searches.length, 2);
});

await test('a press while a scan runs joins it; a dead worker\'s scan is taken over', async () => {
  const s = setup({ data: seed({ affiliate_customer_scans: [{ id: 'live', company_entity_id: CO, program_id: PA, status: 'running', started_at: '2026-11-24T03:59:30Z', heartbeat_at: '2026-11-24T03:59:30Z' }] }) });
  const r = await s.call({ filters: { minOrders: 2 } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { scan_id: 'live', joined: true });
  assert.equal(s.searches.length, 0, 'joining spends nothing');
  const dead = setup({ data: seed({ affiliate_customer_scans: [{ id: 'dead', company_entity_id: CO, program_id: PA, status: 'running', started_at: '2026-11-24T03:00:00Z', heartbeat_at: '2026-11-24T03:00:00Z' }] }) });
  const r2 = await dead.call({ filters: { minOrders: 2 } });
  assert.equal(r2.status, 202);
  assert.equal(dead.service.tables.affiliate_customer_scans.find((x) => x.id === 'dead').status, 'stopped');
});

await test('a run out of time stops early with its queue kept, and the next press finishes it', async () => {
  const s = setup({ budgetHit: true });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.status, 'stopped');
  assert.equal(scan.error_message, 'Stopped early. More to check.');
  const pending = s.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending');
  assert.ok(pending.length >= 1, 'what was not reached stays queued');
  const before = s.searches.length;
  // The next press, on a fresh clock.
  const next = setup({ data: { ...s.service.tables } });
  await next.call({ count: pending.length, filters: { minOrders: 2 } });
  await next.settle();
  assert.equal(next.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending').length, 0, 'the queue is finished');
  assert.ok(next.searches.length >= pending.length && before >= 1);
});

await test('a queued customer who unsubscribes before the next press is dropped, never searched', async () => {
  const s = setup({ budgetHit: true });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const pending = s.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending');
  assert.ok(pending.length >= 1, 'the stopped scan left a queue');
  const data = structuredClone(s.service.tables);
  for (const c of data.company_customer_profiles) if (pending.some((p) => p.customer_key === c.customer_key)) c.email_consent_state = 'unsubscribed';
  const next = setup({ data });
  await next.call({ count: pending.length, filters: { minOrders: 2 } });
  await next.settle();
  for (const p of pending) {
    const name = p.display_name;
    assert.ok(!next.searches.some((t) => t.keyword.includes(`"${name}"`)), `${name} opted out after being queued and must not be searched`);
    assert.equal(row(next, p.customer_key), undefined, 'and leaves the queue');
  }
});

await test('the program\'s own bar decides found and below', async () => {
  const data = seed();
  data.affiliate_programs[0].customer_scan_min_followers = 2000;
  const s = setup({ data });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(row(s, 'emily').status, 'below', '1,204 is under this brand\'s bar of 2,000');
  assert.equal(s.service.tables.affiliate_customer_scans[0].min_followers, 2000);
});

console.log(`\naffiliate-customer-scan-edge: ${passed} passed`);
