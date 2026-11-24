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
//   * the scan is the COMPANY's (Blake 2026-11-24, people come before
//     program): no program is needed or read, every platform is searched,
//     the follower bar is entities.meta data, one scan runs per company and a
//     customer scanned under any program is never searched again;
//   * one search per customer, never a second for a customer this company
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
//   AFFILIATE_SCAN_MUTATION=rescan       a customer already scanned for this company is searched again
//   AFFILIATE_SCAN_MUTATION=programscope the search is narrowed to one program's platforms
//   AFFILIATE_SCAN_MUTATION=programjoin  a press in another program starts a second scan instead of joining
//   AFFILIATE_SCAN_MUTATION=programbar   the follower bar is read from the program, not the company
//   AFFILIATE_SCAN_MUTATION=nojoin       a second press starts a second scan while one runs
//   AFFILIATE_SCAN_MUTATION=noresume     rows a stopped scan left pending are not finished by the next press
//   AFFILIATE_SCAN_MUTATION=resumeoptout a queued customer who unsubscribed since is still searched on resume
//   AFFILIATE_SCAN_MUTATION=teamskip     the company's own people are scanned as customers
//   AFFILIATE_SCAN_MUTATION=teamdomain   a colleague on the company domain who is not a SILO user is scanned
//   AFFILIATE_SCAN_MUTATION=suffix       "Ricardo Solano Jr" is searched as "Ricardo Jr"
//   AFFILIATE_SCAN_MUTATION=popular      Instagram's /popular/ directory page counts as a profile
//   AFFILIATE_SCAN_MUTATION=offplatform  a Pinterest board counts for a program that recruits on Instagram
//   AFFILIATE_SCAN_MUTATION=namebasis    an email that is just their name counts as a second signal
//   AFFILIATE_SCAN_MUTATION=aikeyleak    the model is shown customer keys (their email addresses)
//   AFFILIATE_SCAN_MUTATION=nohandle     the email username is never searched
//   AFFILIATE_SCAN_MUTATION=maskedmail   a marketplace's masked relay username is searched
//   AFFILIATE_SCAN_MUTATION=handleloose  a handle merely CONTAINING the username counts as theirs
//   AFFILIATE_SCAN_MUTATION=aiall        the model is asked about every customer, not only ambiguous ones
//   AFFILIATE_SCAN_MUTATION=forcedtool   the model request forces the tool, which the production model refuses
//   AFFILIATE_SCAN_MUTATION=nocarry      a search an earlier scan left ambiguous is never judged
//   AFFILIATE_SCAN_MUTATION=carryoptout  a carried ambiguous customer who has since unsubscribed is sent to the model
//   AFFILIATE_SCAN_MUTATION=nobar        the company's follower bar is ignored for the default
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
  teamskip: ['handler.mjs', "&& !suppressed(r.email_lc) && !isTeam(r.email_lc));", '&& !suppressed(r.email_lc));'],
  teamdomain: [LIB, "    if (d && !FREE_MAIL.has(d)) domains.add(d);", ''],
  suffix: [LIB, "    .filter((w, i, all) => !(i > 0 && i === all.length - 1 && SUFFIXES.has(w.replace(/[^a-z]/g, ''))));", ';'],
  popular: [LIB, "    if (NOT_A_PROFILE.has(h.toLowerCase())) return false;", ''],
  offplatform: [LIB, "(!allowed || allowed.has(c.platform))", 'true'],
  namebasis: [LIB, "&& !nameOnly.has(local)\n", '\n'],
  aikeyleak: [LIB, "    return `Customer ${n + 1}: ${r.name}", "    return `Customer ${r.key}: ${r.name}"],
  nohandle: ['handler.mjs', "            if (eh && left() > SCAN_TAIL_MS) {", '            if (false) {'],
  maskedmail: [LIB, "  if (MASKED_MAIL.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;\n", ''],
  handleloose: [LIB, "    && coreOf(c.handle) === handle.core);", '    && coreOf(c.handle).includes(handle.core.slice(0, 4)));'],
  aiall: ['handler.mjs', "            if (j.status === 'ambiguous') ambiguous.push(", '            if (true) ambiguous.push('],
  programscope: ['handler.mjs', '    const program = COMPANY_SCAN_SCOPE;', "    const program = { platforms: ['instagram', 'tiktok'] };"],
  programjoin: ['handler.mjs', ".eq('company_entity_id', company)\n      .eq('status', 'running')", ".eq('company_entity_id', company).eq('program_id', body?.program_id ?? null)\n      .eq('status', 'running')"],
  programbar: ['handler.mjs', '    const minFollowers = companyMinFollowers(ent?.meta);', "    const { data: pb } = await service.from('affiliate_programs').select('customer_scan_min_followers').eq('company_entity_id', company).limit(1).maybeSingle();\n    const minFollowers = minFollowersFor(pb);"],
  forcedtool: [LIB, "    tool_choice: { type: 'auto' },", "    tool_choice: { type: 'tool', name: 'record_matches' },"],
  nocarry: ['handler.mjs', '      if (apiKey && left() > SCAN_TAIL_MS / 2) {', '      if (false) {'],
  carryoptout: ['handler.mjs', '        const carried = fresh.filter(okNow).map(', '        const carried = fresh.map('],
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
    { key: '1', profile_url: 'https://www.instagram.com/one' },
    { key: '2', profile_url: 'https://www.instagram.com/three', followers: 50000 },
    { key: '3', profile_url: 'https://www.instagram.com/not-shown' },
    { key: '4', profile_url: null },
  ] } }] };
  const out = Object.fromEntries(L.applyAiAnswer({ rows, answer, minFollowers: 750 }).map((o) => [o.key, o]));
  assert.equal(out.a.status, 'found'); assert.equal(out.a.pick.followers, 3100);
  assert.equal(out.b.status, 'no_count', 'a number the model offers is ignored'); assert.equal(out.b.pick.followers, null);
  assert.equal(out.c.status, 'ambiguous', 'a profile the row was never shown is refused');
  assert.equal(out.d.status, 'none');
});

await test('trust: suffixes, junk pages, off-platform profiles and the second signal', () => {
  assert.equal(L.personName('ricardo solano jr').display, 'Ricardo Solano', 'a suffix is not a surname');
  assert.equal(L.scanQuery(L.personName('ricardo solano jr')), '"Ricardo Solano"');
  assert.equal(L.personName('bob iii'), null, 'a first name and a suffix is one word, not a person to search');
  const p = L.personName('melissa king');
  const pop = L.judgeResults({ items: [ig('popular', 'Melissa King | Instagram', 'See photos of Melissa King')], person: p, program: PROGRAM, collectedAt: 'now' });
  assert.equal(pop.status, 'none', 'instagram.com/popular is a directory of everybody with the name');
  const code = L.judgeResults({ items: [ig('DXelvKUAJYh', 'Melissa King on Instagram', '1,000 Followers')], person: p, program: PROGRAM, collectedAt: 'now' });
  assert.equal(code.status, 'none', 'a post shortcode is not a handle');
  const pin = L.judgeResults({ items: [{ type: 'organic', url: 'https://www.pinterest.com/melissaking/', title: 'Melissa King (melissaking) - Profile | Pinterest', description: '2,000 followers' }], person: p, program: PROGRAM, collectedAt: 'now' });
  assert.equal(pin.status, 'none', 'Pinterest is not a channel this program recruits on');

  const pick = { handle: '@jsmith88', title: 'J Smith (@jsmith88)', snippet: 'Phoenix, AZ' };
  const js = L.personName('john smith');
  assert.equal(L.matchBasis({ pick, person: js, email: 'jsmith88@gmail.com' }), 'email_handle', 'their own email name is the handle');
  assert.equal(L.matchBasis({ pick: { ...pick, handle: '@johnsmith' }, person: js, email: 'johnsmith@gmail.com' }), 'name_only', 'an email that is only their name is not a second signal');
  assert.equal(L.matchBasis({ pick, person: js, email: 'other@gmail.com', city: 'Phoenix' }), 'city', 'their city in the result');
  assert.equal(L.matchBasis({ pick, person: js, email: 'other@gmail.com', city: 'Tulsa' }), 'name_only');
  assert.equal(L.socialRowPatch({ status: 'found', pick: { profile_url: 'https://x.test/a' }, basis: 'bogus' }).match_basis, 'name_only', 'an unknown basis is never promoted');
  assert.equal(L.socialRowPatch({ status: 'none', pick: null }).match_basis, null);

  const team = L.teamFilter(['Jen@Brand.invalid', 'owner@gmail.com', 'nope']);
  assert.ok(team('jen@brand.invalid') && team('cole@brand.invalid') && team('a@shop.brand.invalid'), 'members and their company domain');
  assert.ok(team('owner@gmail.com') && !team('someone@gmail.com'), 'a free mail member is matched by address only');
});

await test('the bar is the company\'s own; the slice is clamped and never includes unsubscribed', () => {
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 2000 }), 2000);
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 0 }), 0);
  assert.equal(L.minFollowersFor({}), 750);
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 2000 }), 2000);
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 0 }), 0, 'zero is a real bar');
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 'abc' }), 750);
  assert.equal(L.companyMinFollowers(null), 750, 'unset is the default');
  assert.deepEqual([...L.COMPANY_SCAN_SCOPE.platforms], [], 'every platform: no program narrows it');
  assert.equal(L.clampScanCount(5000), 1000); assert.equal(L.clampScanCount(0), 500); assert.equal(L.clampScanCount('x'), 500);
  const f = L.scanFilters({ consent: 'unsubscribed', minOrders: 99, to: '2026-12-31', sort: 'drop table' });
  assert.equal(f.consent, 'any', 'unsubscribed cannot be chosen as a slice');
  assert.equal(f.minOrders, 50); assert.equal(f.toExclusive, '2027-01-01'); assert.equal(f.sort, 'orders');
});

// ── The handler ───────────────────────────────────────────────────────────
const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
            && rows.some((x) => x.status === 'running' && x.company_entity_id === r.company_entity_id)) {
            return { data: null, error: { code: '23505', message: 'one running scan per company' } };
          }
          if (table === 'affiliate_customer_social'
            && rows.some((x) => x.company_entity_id === r.company_entity_id && x.customer_key === r.customer_key)) {
            return { data: null, error: { code: '23505', message: 'customer already scanned for this company' } };
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
  // A program that recruits on two platforms only: the company-level scan
  // must not inherit that narrowing. Its old per-program bar is not read.
  affiliate_programs: [{ id: PA, company_entity_id: CO, name: 'A', status: 'active', niche: 'baseball', platforms: ['instagram', 'tiktok'], geographies: [], customer_scan_min_followers: 750 }],
  entities: [{ id: CO, meta: {} }, { id: OTHER, meta: { affiliate_customer_scan_min_followers: 1 } }],
  company_customer_profiles: [
    cust('emily', 'emily durrance', { order_count: 9 }),
    cust('nobody', 'quiet person', { order_count: 8 }),
    cust('optout', 'olive out', { order_count: 7, email_consent_state: 'unsubscribed' }),
    cust('twins', 'sam twin', { order_count: 6, email_consent_state: 'subscribed' }),
    cust('biz', 'team store', { order_count: 6 }),
    cust('otherco', 'emily durrance', { order_count: 99, company_entity_id: OTHER }),
    cust('jen', 'jen staffer', { order_count: 9, email_lc: 'jen@brand.invalid' }),
    cust('colleague', 'cole league', { order_count: 9, email_lc: 'cole@brand.invalid' }),
    cust('owner', 'oscar owner', { order_count: 9, email_lc: 'owner@gmail.com' }),
  ],
  shopify_customers: [{ company_entity_id: CO, email_lc: 'emily@buyer.invalid', city: 'Phoenix' }],
  // The company's own people: one SILO member on the company domain, one on
  // free mail. A colleague on the company domain who never signed in to SILO
  // is skipped by domain.
  entity_memberships: [{ entity_id: CO, user_id: 'u-staff' }, { entity_id: CO, user_id: 'u-free' }, { entity_id: OTHER, user_id: 'u-other' }],
  profiles: [{ id: 'u-staff', email: 'jen@brand.invalid' }, { id: 'u-free', email: 'owner@gmail.com' }, { id: 'u-other', email: 'x@buyer.invalid' }],
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
  // A lookalike first: only the handle that IS the username counts.
  samtwin_az: [ig('samtwinfans', 'Sam Twin Fans (@samtwinfans)', '50K Followers'), ig('samtwin_az', 'Sam T (@samtwin_az) • Instagram', '1,900 Followers, 210 Following', 2)],
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
      // As production answered on 2026-11-24: a forced tool is refused.
      if (['tool', 'any'].includes(body.tool_choice?.type)) {
        return { ok: false, status: 400, text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}' };
      }
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
    const res = await handler(new Request('https://fn.test', { method: 'POST', headers: { Authorization: 'Bearer user', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'customer_scan', ...body }) }));
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
  // One name search each, plus one username search for each email whose
  // username is not just their name: emily@ is her first name, so 3 + 2.
  assert.equal(s.searches.filter((t) => /^"[^"]* [^"]*"/.test(t.keyword)).length, 3, 'one name search per customer');
  assert.deepEqual(s.searches.filter((t) => /^"[a-z0-9._-]+"/.test(t.keyword)).map((t) => t.keyword.split(' ')[0]).sort(), ['"nobody"', '"twins"'], 'and the email username, where it is not just their name');
  assert.ok(!s.searches.some((t) => /[a-z0-9]@[a-z]/i.test(t.keyword) || /buyer\.invalid/.test(t.keyword)), 'never a full email address');
  assert.equal(s.searches.find((t) => /Emily/.test(t.keyword)).keyword,
    '"Emily Durrance" Phoenix (site:instagram.com OR site:tiktok.com/@ OR site:youtube.com/@ OR site:twitch.tv OR site:x.com OR site:twitter.com OR site:pinterest.com)',
    'name and city, on every platform: no program narrows a company-level scan');
  assert.equal(row(s, 'emily').status, 'found');
  assert.equal(row(s, 'emily').followers, 1204);
  assert.equal(row(s, 'emily').followers_quote, '1,204 Followers');
  assert.equal(row(s, 'emily').decided_by, 'search');
  assert.equal(row(s, 'emily').match_basis, 'name_only', 'a name alone is recorded as a name match, to check');
  for (const k of ['jen', 'colleague', 'owner']) assert.equal(row(s, k), undefined, `${k} works for the company and is never scanned`);
  assert.equal(row(s, 'nobody').status, 'none');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.company_entity_id, CO);
  assert.equal(scan.program_id, null, 'no program: the scan is the company\'s');
  assert.ok(s.service.tables.affiliate_customer_social.every((x) => x.program_id === null), 'and so is every answer');
  assert.ok(!s.service.log.includes('select:affiliate_programs'), 'no program is loaded or needed');
  assert.equal(scan.status, 'done');
  assert.deepEqual([scan.requested, scan.checked, scan.found], [3, 3, 2]);
  assert.equal(scan.cost_usd, 0.01, 'spend is recorded for SILO: five searches');
});

await test('a profile whose handle IS their email username is a likely find, and settles an ambiguous name search', async () => {
  const data = seed();
  data.company_customer_profiles.find((c) => c.customer_key === 'twins').email_lc = 'samtwin_az@buyer.invalid';
  data.company_customer_profiles.push(cust('masked', 'max masked', { order_count: 9, email_lc: 'v4bdlu7k2x@scs.tiktokw.us' }));
  const s = setup({ data });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const tw = row(s, 'twins');
  assert.equal(tw.match_basis, 'email_handle');
  assert.equal(tw.handle, '@samtwin_az', 'the profile whose handle is their username, not the bigger namesake');
  assert.equal(tw.decided_by, 'search');
  assert.equal(s.modelCalls.length, 0, 'the username settled it, so the model is not asked');
  assert.ok(!s.searches.some((t) => /v4bdlu7k2x/.test(t.keyword)), 'a masked marketplace address is never searched');
  assert.equal(L.emailHandle('info@shop.invalid', L.personName('ann lee')), null, 'a generic mailbox');
  assert.equal(L.emailHandle('annlee@gmail.com', L.personName('ann lee')), null, 'a username that is just their name');
  assert.equal(L.emailHandle('jo1@gmail.com', L.personName('jo ray')), null, 'too short to be distinctive');
  assert.deepEqual(L.emailHandle('Ann.Lee.88+shop@gmail.com', L.personName('ann lee')), { local: 'ann.lee.88', core: 'annlee88' }, 'a +tag is dropped');
});

await test('the model is asked about ambiguous searches only, under the research credit hold', async () => {
  const s = setup();
  await s.call({ count: 500, filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(s.modelCalls.length, 1, 'one request for the one ambiguous customer');
  const prompt = s.modelCalls[0].messages[0].content;
  assert.ok(/Customer 1: Sam Twin/.test(prompt), 'customers are labelled by position');
  assert.ok(!/Emily/.test(prompt), 'a search that answered it is never sent to the model');
  assert.ok(!/@buyer\.invalid|twins@/.test(JSON.stringify(s.modelCalls[0])), 'no customer email or key ever reaches the model');
  assert.equal(s.modelCalls[0].tools.length, 1, 'no web tools');
  assert.deepEqual(s.modelCalls[0].tool_choice, { type: 'auto' }, 'never a forced tool: the production model refuses one with a 400');
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

await test('a customer the company already scanned, under any program, is never searched or paid for twice', async () => {
  const s = setup({ data: seed({ affiliate_customer_social: [{ id: 'old', company_entity_id: CO, program_id: PA, customer_key: 'emily', status: 'found', created_at: '2026-11-01' }] }) });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.ok(!s.searches.some((t) => /Emily/.test(t.keyword)), 'Emily was scanned last week');
  assert.equal(s.searches.length, 4, 'the other two customers: a name search and a username search each');
});

await test('a search an earlier scan left ambiguous is judged from its stored profiles, with no new search', async () => {
  const cands = [
    { platform: 'instagram', handle: '@samtwin', profile_url: 'https://www.instagram.com/samtwin', title: 'Sam Twin (@samtwin)', snippet: '5,000 Followers' },
    { platform: 'instagram', handle: '@samtwin_az', profile_url: 'https://www.instagram.com/samtwin_az', title: 'Sam Twin (@samtwin_az)', snippet: 'Phoenix' },
  ];
  const s = setup({ data: seed({ affiliate_customer_social: [{ id: 'amb', company_entity_id: CO, program_id: null, scan_id: 'old', customer_key: 'twins', email_lc: 'twins@buyer.invalid', display_name: 'Sam Twin', status: 'ambiguous', decided_by: 'search', candidates: cands, created_at: '2026-11-24T03:00:00Z' }] }) });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.ok(!s.searches.some((t) => /Sam Twin|"twins"/.test(t.keyword)), 'no new search for a customer already searched');
  const r = row(s, 'twins');
  assert.equal(r.status, 'found', 'the model judged the stored profiles');
  assert.equal(r.decided_by, 'ai');
  assert.equal(r.followers, 5000, 'the count re-read from the chosen profile\'s own text');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.ok(scan.ambiguous >= 0 && scan.found === 1, 'this scan counts only what it searched (Emily), never the carried row');
});

await test('a carried ambiguous customer who has since opted out is never sent to the model, and is cleared', async () => {
  const cands = [
    { platform: 'instagram', handle: '@samtwin', profile_url: 'https://www.instagram.com/samtwin', title: 'Sam Twin (@samtwin)', snippet: '5,000 Followers' },
    { platform: 'instagram', handle: '@samtwin_az', profile_url: 'https://www.instagram.com/samtwin_az', title: 'Sam Twin (@samtwin_az)', snippet: 'Phoenix' },
  ];
  const data = seed({ affiliate_customer_social: [{ id: 'amb', company_entity_id: CO, program_id: null, scan_id: 'old', customer_key: 'twins', email_lc: 'twins@buyer.invalid', display_name: 'Sam Twin', status: 'ambiguous', decided_by: 'search', candidates: cands, created_at: '2026-11-24T03:00:00Z' }] });
  data.company_customer_profiles.find((c) => c.customer_key === 'twins').email_consent_state = 'unsubscribed';
  const s = setup({ data });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.ok(!s.modelCalls.some((b) => /Sam Twin/.test(JSON.stringify(b))), 'their name and profiles never reach the model');
  assert.equal(row(s, 'twins'), undefined, 'and their stored search is cleared');
});

await test('a press while a scan runs joins it; a dead worker\'s scan is taken over', async () => {
  const s = setup({ data: seed({ affiliate_customer_scans: [{ id: 'live', company_entity_id: CO, program_id: PA, status: 'running', started_at: '2026-11-24T03:59:30Z', heartbeat_at: '2026-11-24T03:59:30Z' }] }) });
  const r = await s.call({ filters: { minOrders: 2 } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { scan_id: 'live', joined: true });
  assert.equal(s.searches.length, 0, 'joining spends nothing');
  // A scan started from one program is joined by a press from another: one
  // running scan per company.
  const other = setup({ data: seed({ affiliate_customer_scans: [{ id: 'live', company_entity_id: CO, program_id: PA, status: 'running', started_at: '2026-11-24T03:59:30Z', heartbeat_at: '2026-11-24T03:59:30Z' }] }) });
  const r3 = await other.call({ program_id: PB, filters: { minOrders: 2 } });
  assert.deepEqual(r3.body, { scan_id: 'live', joined: true }, 'a press in another program joins the running scan');
  assert.equal(other.service.tables.affiliate_customer_scans.length, 1);
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

await test('the company\'s own bar decides found and below; a program\'s old bar is not read', async () => {
  const data = seed();
  data.entities[0].meta = { affiliate_customer_scan_min_followers: 2000 };
  data.affiliate_programs[0].customer_scan_min_followers = 100;
  const s = setup({ data });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(row(s, 'emily').status, 'below', '1,204 is under this company\'s bar of 2,000');
  assert.equal(s.service.tables.affiliate_customer_scans[0].min_followers, 2000);
  // Unset is 750, whatever the program column says.
  const d2 = seed();
  d2.affiliate_programs[0].customer_scan_min_followers = 5000;
  const s2 = setup({ data: d2 });
  await s2.call({ filters: { minOrders: 2 } });
  await s2.settle();
  assert.equal(row(s2, 'emily').status, 'found', 'the default bar, not the program\'s 5,000');
  assert.equal(s2.service.tables.affiliate_customer_scans[0].min_followers, 750);
});

console.log(`\naffiliate-customer-scan-edge: ${passed} passed`);
