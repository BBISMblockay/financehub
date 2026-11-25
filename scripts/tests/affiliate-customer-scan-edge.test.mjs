// "Find their social accounts" (affiliate-research action customer_scan),
// executed in Node: the pure lib directly, then the real handler with a fake
// Supabase, a fake search provider and a fake model.
//
// Properties:
//   * an ERASED (redacted) customer is never queued, searched or researched,
//     while one who unsubscribed, or whose consent was never checked (NULL),
//     IS scanned -- consent decides how somebody is reached, never whether
//     they are found, and a plain NOT IN would drop every NULL;
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
//   AFFILIATE_SCAN_MUTATION=optoutscan   erased (redacted) customers are scanned
//   AFFILIATE_SCAN_MUTATION=aicount      the model's chosen profile keeps a count its text does not state
//   AFFILIATE_SCAN_MUTATION=aianyurl     the model may choose a profile the row was never shown
//   AFFILIATE_SCAN_MUTATION=nickquery    the search asks for their own spelling only, so a nickname is never returned
//   AFFILIATE_SCAN_MUTATION=nonick       a nickname on the profile (Michael for Mike) does not count
//   AFFILIATE_SCAN_MUTATION=nickword     a nickname inside another word (tom in tomato) counts
//   AFFILIATE_SCAN_MUTATION=firstonly    a profile with only the first name counts as theirs
//   AFFILIATE_SCAN_MUTATION=rescan       a customer already scanned for this company is searched again
//   AFFILIATE_SCAN_MUTATION=programscope the search is narrowed to one program's platforms
//   AFFILIATE_SCAN_MUTATION=programjoin  a press in another program starts a second scan instead of joining
//   AFFILIATE_SCAN_MUTATION=programbar   the follower bar is read from the program, not the company
//   AFFILIATE_SCAN_MUTATION=nojoin       a second press starts a second scan while one runs
//   AFFILIATE_SCAN_MUTATION=noresume     rows a stopped scan left pending are not finished by the next press
//   AFFILIATE_SCAN_MUTATION=resumeoptout a queued customer erased since is still searched on resume
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
//   AFFILIATE_SCAN_MUTATION=forcedtool   the model request forces the tool, which the production model refuses
//   AFFILIATE_SCAN_MUTATION=nocarry      a search an earlier scan left ambiguous is never judged
//   AFFILIATE_SCAN_MUTATION=carryoptout  a carried ambiguous customer since erased is sent to the model
//   AFFILIATE_SCAN_MUTATION=nochain      a run out of time ends the scan instead of continuing it
//   AFFILIATE_SCAN_MUTATION=nohandoff    any continue call runs a second worker over the queue
//   AFFILIATE_SCAN_MUTATION=nolegcap     a scan can continue for ever
//   AFFILIATE_SCAN_MUTATION=noresults    Google having nothing for a name counts as a failed search
//   AFFILIATE_SCAN_MUTATION=handlealways the email username is searched even when the name search settled it
//   AFFILIATE_SCAN_MUTATION=noaileg      ambiguous searches a run had no time to judge are left unjudged
//   AFFILIATE_SCAN_MUTATION=nogoal       a hunt keeps checking after it has the finds asked for
//   AFFILIATE_SCAN_MUTATION=nocap        a hunt ignores the company's cap on customers checked
//   AFFILIATE_SCAN_MUTATION=nobar        the company's follower bar is ignored for the default
//   AFFILIATE_SCAN_MUTATION=namefind     a find over the bar counts as found whatever its score
//   AFFILIATE_SCAN_MUTATION=bigname      a huge account tied by a name alone loses no points
//   AFFILIATE_SCAN_MUTATION=termsunsaved the Niche words box is used once but never saved
//   AFFILIATE_SCAN_MUTATION=noretry      a provider fault is a failure at once, never searched again
//   AFFILIATE_SCAN_MUTATION=termsreplace company words replace the programs' words instead of joining them
//   AFFILIATE_SCAN_MUTATION=nicheloose   a niche word matches inside another word ("baseballs")
//   AFFILIATE_SCAN_MUTATION=countother   the count lookup reads another account's count from the results
//   AFFILIATE_SCAN_MUTATION=nocountask   a profile matched with no count never gets its count looked up
//   AFFILIATE_SCAN_MUTATION=pinx         the company scan searches Pinterest and X again
//   AFFILIATE_SCAN_MUTATION=unsubpool    unsubscribed customers are left out of the pool again
//   AFFILIATE_SCAN_MUTATION=legcpu       a leg reads every result due, however many (killed for CPU in production)
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
  nickquery: [LIB, '  const names = firstNames(person.first).slice(0, NICK_QUERY)', '  const names = firstNames(person.first).slice(0, 1)'],
  nonick: [LIB, '  return (has(person.first) || firstNames(person.first).slice(1).some(nick)) && has(person.last);', '  return has(person.first) && has(person.last);'],
  nickword: [LIB, "  const nick = (w) => words.includes(` ${w} `) || (w.length >= 4 && handle.includes(w));", '  const nick = (w) => title.includes(w) || handle.includes(w);'],
  firstonly: [LIB, '  return (has(person.first) || firstNames(person.first).slice(1).some(nick)) && has(person.last);', '  return has(person.first);'],
  rescan: ['handler.mjs', "      const fresh = pick.filter((r) => !seen.has(r.customer_key));", '      const fresh = pick;'],
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
  nohandle: ['handler.mjs', "        if (eh) handles.push(", '        if (false) handles.push('],
  maskedmail: [LIB, "  if (MASKED_MAIL.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;\n", ''],
  handleloose: [LIB, "    && coreOf(c.handle) === handle.core);", '    && coreOf(c.handle).includes(handle.core.slice(0, 4)));'],
  programscope: ['handler.mjs', '    const program = COMPANY_SCAN_SCOPE;', "    const program = { platforms: ['instagram', 'tiktok'] };"],
  programjoin: ['handler.mjs', ".eq('company_entity_id', company)\n      .eq('status', 'running')", ".eq('company_entity_id', company).eq('program_id', body?.program_id ?? null)\n      .eq('status', 'running')"],
  programbar: ['handler.mjs', '    const minFollowers = companyMinFollowers(ent?.meta);', "    const { data: pb } = await service.from('affiliate_programs').select('customer_scan_min_followers').eq('company_entity_id', company).limit(1).maybeSingle();\n    const minFollowers = minFollowersFor(pb);"],
  forcedtool: [LIB, "    tool_choice: { type: 'auto' },", "    tool_choice: { type: 'tool', name: 'record_matches' },"],
  nocarry: ['handler.mjs', "        if (apiKey && left() > SCAN_TAIL_MS / 2) {", '        if (false) {'],
  carryoptout: ['handler.mjs', '        const carried = fresh.filter(okNow).map(', '        const carried = fresh.map('],
  nochain: ['handler.mjs', "      if ((status === 'stopped' || (status === 'done' && aiOwed)) && !error && selfInvoke && authHeader && leg + 1 < SCAN_MAX_LEGS) {", '      if (false) {'],
  nohandoff: ['handler.mjs', " || row.filters?.handoff !== handoff) return reply(", ") return reply("],
  nolegcap: ['handler.mjs', '&& authHeader && leg + 1 < SCAN_MAX_LEGS) {', '&& authHeader) {'],
  noresults: [LIB, "      if (code === 40102) return { state: 'ready', items: [] };\n", ''],
  handlealways: ['handler.mjs', "const eh = (j.status === 'none' || j.status === 'ambiguous') ? emailHandle(r.email_lc, person) : null;", "const eh = basis === 'email_handle' ? null : emailHandle(r.email_lc, person);"],
  noaileg: ['handler.mjs', "|| (status === 'done' && aiOwed)) && !error", ') && !error'],
  nogoal: ['handler.mjs', '      const goalMet = () => t.found >= want;', '      const goalMet = () => false;'],
  nocap: ['handler.mjs', '      const capLeft = () => Math.max(0, maxChecks - requested);', '      const capLeft = () => 1e9;'],
  namefind: [LIB, "  return status === 'found' && !(Number(score) >= LIKELY_SCORE) ? 'check' : status;", '  return status;'],
  bigname: [LIB, '    if (off) s += off[1];', '    if (off) s += 0;'],
  termsunsaved: ['handler.mjs', "        const { error: tErr } = await service.from('entities').update({ meta: next }).eq('id', company);", "        const tErr = null;"],
  noretry: ['handler.mjs', "        if (res.state === 'error' && RETRYABLE_SERP_CODES.has(res.code) && person && r.status === 'pending' && !r.checked_at) {", "        if (false) {"],
  termsreplace: [LIB, '  return [...new Set([...own, ...prog])].slice(0, 40);', '  return [...new Set(list ? own : prog)].slice(0, 40);'],
  nicheloose: [LIB, "  if ((terms || []).some((t) => t && text.includes(` ${t} `))) out.add('niche');", "  if ((terms || []).some((t) => t && text.includes(t))) out.add('niche');"],
  unsubpool: [LIB, "export const NEVER_SCAN_CONSENT = ['redacted'];", "export const NEVER_SCAN_CONSENT = ['unsubscribed', 'redacted'];"],
  countother: [LIB, '  const hit = candidates.find((c) => c.platform === pick.platform && (c.profile_url.toLowerCase() === want || coreOf(c.handle) === coreOf(pick.handle)));', '  const hit = candidates.find((c) => c.platform === pick.platform);'],
  nocountask: ['handler.mjs', "        const ct = j.status === 'no_count' ? buildCountTask(j.pick) : null;", '        const ct = null;'],
  pinx: [LIB, "export const COMPANY_SCAN_SCOPE = Object.freeze({ platforms: Object.freeze(['instagram', 'tiktok', 'youtube']) });", 'export const COMPANY_SCAN_SCOPE = Object.freeze({ platforms: Object.freeze([]) });'],
  legcpu: ['handler.mjs', '        if (left() < SCAN_TAIL_MS / 2 || gets >= SCAN_LEG_GETS) return;', '        if (left() < SCAN_TAIL_MS / 2) return;'],
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

await test('a nickname counts as the same first name (Mike = Michael), never a different person or a word inside another', () => {
  const mike = L.personName('mike sorensen');
  const formal = L.judgeResults({ items: [ig('msorensen_bb', 'Michael Sorensen (@msorensen_bb)', '2,400 Followers')], person: mike, program: PROGRAM, collectedAt: 'now' });
  assert.equal(formal.status, 'found', 'Michael on the profile is the customer stored as Mike');
  const michael = L.personName('michael sorensen');
  assert.equal(L.judgeResults({ items: [ig('mikesorensen', 'Mike Sorensen (@mikesorensen)', '2,400 Followers')], person: michael, program: PROGRAM, collectedAt: 'now' }).status, 'found', 'and the other way round');
  assert.equal(L.judgeResults({ items: [ig('mattsorensen', 'Matt Sorensen (@mattsorensen)', '2,400 Followers')], person: mike, program: PROGRAM, collectedAt: 'now' }).status, 'none', 'another first name is another person');
  const tom = L.personName('tom baker');
  assert.equal(L.judgeResults({ items: [ig('tomatobaker', 'Tomato Baker (@tomatobaker)', '2,400 Followers')], person: L.personName('thomas baker'), program: PROGRAM, collectedAt: 'now' }).status, 'none', 'a nickname inside a word is not a name');
  assert.ok(tom && L.firstNames('thomas').includes('tom'));
  // The search itself asks for the other spellings, in one request, or the
  // matcher would never be shown "Michael Sorensen" at all.
  assert.equal(L.scanQuery(mike, 'Phoenix'), '"Mike Sorensen" OR "Michael Sorensen" OR "Mikey Sorensen" Phoenix');
  assert.equal(L.buildScanTask(mike, 'Phoenix', PROGRAM).keyword.startsWith('"Mike Sorensen" OR "Michael Sorensen"'), true, 'one provider request carries every spelling');
  assert.equal(L.scanQuery(L.personName('emily durrance')), '"Emily Durrance"', 'a name with no nickname is searched as before');
  const s = L.scorePick({ pick: formal.pick, person: mike });
  assert.ok(s.score < L.LIKELY_SCORE, 'a nickname alone never makes a find Likely');
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

await test('the bar is the company\'s own; the slice is clamped, and unsubscribed is a slice (erased never is)', () => {
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 2000 }), 2000);
  assert.equal(L.minFollowersFor({ customer_scan_min_followers: 0 }), 0);
  assert.equal(L.minFollowersFor({}), 750);
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 2000 }), 2000);
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 0 }), 0, 'zero is a real bar');
  assert.equal(L.companyMinFollowers({ affiliate_customer_scan_min_followers: 'abc' }), 750);
  assert.equal(L.companyMinFollowers(null), 750, 'unset is the default');
  assert.deepEqual([...L.COMPANY_SCAN_SCOPE.platforms], ['instagram', 'tiktok', 'youtube'], 'the platforms whose results state a count; no program narrows it, and never Pinterest or X');
  assert.equal(L.clampScanCount(5000), 1000); assert.equal(L.clampScanCount(0), 500); assert.equal(L.clampScanCount('x'), 500);
  const f = L.scanFilters({ consent: 'redacted', minOrders: 99, to: '2026-12-31', sort: 'drop table' });
  assert.equal(f.consent, 'any', 'an erased customer cannot be chosen as a slice');
  assert.equal(L.scanFilters({ consent: 'unsubscribed' }).consentState, 'unsubscribed', 'unsubscribed customers are found too; they are reached by DM, never email');
  assert.deepEqual(L.NEVER_SCAN_CONSENT, ['redacted'], 'only an erasure is never searched');
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
  // Ids never repeat ones the seed already holds (a later press over the
  // same tables must not mint the earlier scan's id again).
  let n = 1 + Object.values(tables).reduce((a, r) => a + (Array.isArray(r) ? r.length : 0), 0);
  const cmp = (op, v, x) => {
    if (op === 'eq') return v === x;
    if (op === 'is') return x === null ? v === null || v === undefined : v === x;
    if (op === 'in') return x.includes(v);
    if (op === 'gte') return v !== null && v !== undefined && v >= x;
    if (op === 'lt') return v !== null && v !== undefined && v < x;
    if (op === 'notin') return v !== null && v !== undefined && !x.includes(v);
    if (op === 'neq') return v !== x;
    throw new Error(op);
  };
  const orClause = (expr) => expr.split(/,(?![^(]*\))/).map((c) => {
    const m = c.match(/^([a-z_]+)\.(is|eq|not\.in|not\.is)\.(.*)$/);
    if (!m) throw new Error(`fake or(): ${c}`);
    const [, col, op, raw] = m;
    if (op === 'is') return (r) => cmp('is', r[col], raw === 'null' ? null : raw);
    if (op === 'not.is') return (r) => !cmp('is', r[col], raw === 'null' ? null : raw);
    if (op === 'eq') return (r) => cmp('eq', r[col], raw);
    return (r) => cmp('notin', r[col], raw.replace(/^\(|\)$/g, '').split(','));
  });
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let single = false; let maybe = false; let lim = null; const ords = []; let rng = null; let head = false;
    const run = () => {
      log.push(`${op}:${table}`);
      const rows = (tables[table] ||= []);
      const match = (r) => filters.every((f) => f(r));
      if (op === 'select') {
        let out = rows.filter(match).map((r) => ({ ...r }));
        if (ords.length) out.sort((a, b) => { for (const o of ords) { if (a[o.k] === b[o.k]) continue; return (a[o.k] < b[o.k] ? -1 : 1) * (o.asc ? 1 : -1); } return 0; });
        if (rng) out = out.slice(rng[0], rng[1] + 1);
        if (lim != null) out = out.slice(0, lim);
        if (head) return { data: null, count: out.length, error: null };
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
          last = { id: table === "affiliate_customer_scans" ? `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}` : `${table}-${n++}`, created_at: new Date(1_700_000_000_000 + n).toISOString(), ...r }; rows.push(last);
        }
        return { data: single ? { id: last.id } : null, error: null };
      }
      if (op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
      throw new Error(op);
    };
    const b = {
      select(_cols, opts) { if (opts?.head) head = true; return b; }, delete() { op = 'delete'; return b; }, insert(p) { op = 'insert'; payload = p; return b; }, update(p) { op = 'update'; payload = p; return b; },
      eq(k, v) { filters.push((r) => cmp('eq', r[k], v)); return b; }, in(k, v) { filters.push((r) => cmp('in', r[k], v)); return b; },
      gte(k, v) { filters.push((r) => cmp('gte', r[k], v)); return b; }, lt(k, v) { filters.push((r) => cmp('lt', r[k], v)); return b; },
      is(k, v) { filters.push((r) => cmp('is', r[k], v)); return b; },
      not(k, o, v) {
        if (o === 'is') { filters.push((r) => !cmp('is', r[k], v)); return b; }
        assert.equal(o, 'in'); const list = String(v).replace(/^\(|\)$/g, '').split(','); filters.push((r) => cmp('notin', r[k], list)); return b;
      },
      neq(k, v) { filters.push((r) => cmp('neq', r[k], v)); return b; },
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
    cust('optout', 'olive out', { order_count: 7, email_consent_state: 'redacted' }),
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
function setup({ data = seed(), apiKey = 'k', clock = null, budgetHit = false, chain = false, searchMs = 0, refuse = {}, flaky = {} } = {}) {
  const service = fakeService(data);
  const searches = []; const gets = []; const modelCalls = []; const bg = []; const legs = [];
  let t = Date.parse('2026-11-24T04:00:00Z');
  let handler = null;
  handler = createResearchHandler({
    // The next leg is this same handler, called as the same person.
    selfInvoke: chain ? async (auth, body) => {
      legs.push({ auth, body, gets: gets.length });
      return handler(new Request('https://fn.test', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    } : null,
    service,
    userClientFor: () => ({
      rpc: async () => ({ data: CO, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: '99999999-9999-4999-8999-999999999999' } } }) },
    }),
    apiKey,
    now: () => new Date(clock ? clock() : t),
    // The provider's queue. A task id carries its keyword, so a later setup
    // over the same tables (the next press) can collect what an earlier one
    // posted, as the real queue would.
    serpQueue: {
      post: async (list) => {
        // A run that hits its time limit: the clock jumps after the first post.
        if (budgetHit) t += 10 * 60_000;
        return list.map(({ task }) => { searches.push(task); return { id: `task:${encodeURIComponent(task.keyword)}`, cost: 0.002, code: 20100 }; });
      },
      get: async (id) => {
        gets.push(id);
        if (budgetHit) t += 10 * 60_000;
        t += searchMs;
        const keyword = decodeURIComponent(id.slice(5));
        const name = (keyword.match(/"([^"]+)"/) || [])[1];
        if (refuse[name]) return { state: 'error', code: refuse[name] };
        // Fails the first time only, as a provider hiccup does.
        if (flaky[name]) { const code = flaky[name]; delete flaky[name]; return { state: 'error', code }; }
        return { state: 'ready', items: RESULTS[name] || [] };
      },
    },
    sleep: async (ms) => { t += ms; },
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
  // Legs add background work while earlier legs finish: wait for all of it.
  const settle = async () => { for (let i = 0; i < bg.length; i += 1) await bg[i]; };
  return { service, searches, gets, modelCalls, bg, legs, call, settle, tick: (ms) => { t += ms; } };
}
const row = (s, key) => s.service.tables.affiliate_customer_social.find((r) => r.customer_key === key);

await test('a press scans the slice: one search each, opt-outs and businesses never, unmeasured consent always', async () => {
  const s = setup();
  const r = await s.call({ count: 500, filters: { minOrders: 2, consent: 'any', sort: 'orders' } });
  assert.equal(r.status, 202);
  await s.settle();
  const keys = s.service.tables.affiliate_customer_social.map((x) => x.customer_key).sort();
  assert.deepEqual(keys, ['emily', 'nobody', 'twins'], 'an erased customer, a business and another company\'s customer are never queued');
  assert.ok(!s.searches.some((t) => /Olive Out/.test(t.keyword)), 'an erased customer is never searched');
  assert.ok(row(s, 'nobody'), 'a customer whose consent was never checked IS scanned');
  // One name search each, plus one username search for each email whose
  // username is not just their name: emily@ is her first name, so 3 + 2.
  assert.equal(s.searches.filter((t) => /^"[^"]* [^"]*"/.test(t.keyword)).length, 3, 'one name search per customer');
  assert.deepEqual(s.searches.filter((t) => /^"[a-z0-9._-]+"/.test(t.keyword)).map((t) => t.keyword.split(' ')[0]).sort(), ['"nobody"', '"twins"'], 'and the email username, where it is not just their name');
  assert.ok(!s.searches.some((t) => /[a-z0-9]@[a-z]/i.test(t.keyword) || /buyer\.invalid/.test(t.keyword)), 'never a full email address');
  assert.equal(s.searches.find((t) => /Emily/.test(t.keyword)).keyword,
    '"Emily Durrance" Phoenix (site:instagram.com OR site:tiktok.com/@ OR site:youtube.com/@)',
    'name and city, on the platforms that state a count: no program narrows a company-level scan, and never Pinterest or X');
  assert.equal(row(s, 'emily').status, 'found');
  assert.equal(row(s, 'emily').followers, 1204);
  assert.equal(row(s, 'emily').followers_quote, '1,204 Followers');
  assert.equal(row(s, 'emily').decided_by, 'search');
  assert.equal(row(s, 'emily').match_basis, 'name_only', 'a name alone is recorded as a name match, to check');
  assert.equal(row(s, 'emily').match_score, 40, 'a name alone scores 40: Check, never Likely');
  assert.equal(row(s, 'emily').candidates?.[0]?.snippet, '1,204 Followers, 300 Following', 'the words the match was read from are kept on the row');
  for (const k of ['jen', 'colleague', 'owner']) assert.equal(row(s, k), undefined, `${k} works for the company and is never scanned`);
  assert.equal(row(s, 'nobody').status, 'none');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.company_entity_id, CO);
  assert.equal(scan.program_id, null, 'no program: the scan is the company\'s');
  assert.ok(s.service.tables.affiliate_customer_social.every((x) => x.program_id === null), 'and so is every answer');
  assert.equal(scan.status, 'done');
  // Both over the bar matched on the name alone, so neither counts as found:
  // they wait under Check for a person.
  assert.deepEqual([scan.requested, scan.checked, scan.found, scan.filters.to_check], [3, 3, 0, 2]);
  assert.deepEqual(scan.filters.terms, ['baseball'], 'the niche words come from the company\'s active programs when the company sets none');
  // The Niche words box rides on a press: saved as the company's own words,
  // and used with the programs' words by that same press.
  const w = setup();
  await w.call({ filters: { minOrders: 2 }, terms: 'MLB, Softball' });
  await w.settle();
  assert.deepEqual(w.service.tables.entities.find((e) => e.id === CO).meta.affiliate_customer_scan_terms, ['mlb', 'softball']);
  assert.deepEqual(w.service.tables.affiliate_customer_scans[0].filters.terms, ['mlb', 'softball', 'baseball']);
  assert.equal(w.service.tables.entities.find((e) => e.id === OTHER).meta.affiliate_customer_scan_terms, undefined, 'another company is untouched');
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
  assert.ok(scan.ambiguous >= 0 && scan.found === 0 && scan.filters.to_check === 1, 'this scan counts only what it searched (Emily, name only: to check), never the carried row');
});

await test('an unsubscribed customer IS found: consent decides the contact path, not the pool', async () => {
  const data = seed();
  data.company_customer_profiles.find((c) => c.customer_key === 'optout').email_consent_state = 'unsubscribed';
  const s = setup({ data });
  await s.call({ count: 500, filters: { minOrders: 2, consent: 'any', sort: 'orders' } });
  await s.settle();
  assert.ok(row(s, 'optout'), 'queued and searched');
  assert.ok(s.searches.some((t) => /Olive Out/.test(t.keyword)), 'their name is searched');
});

await test('a carried ambiguous customer who has since opted out is never sent to the model, and is cleared', async () => {
  const cands = [
    { platform: 'instagram', handle: '@samtwin', profile_url: 'https://www.instagram.com/samtwin', title: 'Sam Twin (@samtwin)', snippet: '5,000 Followers' },
    { platform: 'instagram', handle: '@samtwin_az', profile_url: 'https://www.instagram.com/samtwin_az', title: 'Sam Twin (@samtwin_az)', snippet: 'Phoenix' },
  ];
  const data = seed({ affiliate_customer_social: [{ id: 'amb', company_entity_id: CO, program_id: null, scan_id: 'old', customer_key: 'twins', email_lc: 'twins@buyer.invalid', display_name: 'Sam Twin', status: 'ambiguous', decided_by: 'search', candidates: cands, created_at: '2026-11-24T03:00:00Z' }] });
  data.company_customer_profiles.find((c) => c.customer_key === 'twins').email_consent_state = 'redacted';
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
  // Later, as the next press is: what the first run posted has had time to come back.
  next.tick(60 * 60_000);
  await next.call({ count: pending.length, filters: { minOrders: 2 } });
  await next.settle();
  assert.equal(next.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending').length, 0, 'the queue is finished');
  assert.ok(before >= 1);
  assert.ok(next.gets.length >= pending.length, 'what the first run posted is collected');
  assert.ok(!next.searches.some((t) => before && s.searches.some((o) => o.keyword === t.keyword && /^"[^"]* [^"]*"/.test(t.keyword))), 'and never posted (or paid for) again');
});

await test('a press runs to the end on its own: a run out of time continues the SAME scan, as the same person', async () => {
  const s = setup({ budgetHit: true, chain: true });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const scans = s.service.tables.affiliate_customer_scans;
  assert.equal(scans.length, 1, 'one scan, never a new one per run');
  assert.equal(scans[0].status, 'done', 'it finished, not "stopped early"');
  assert.equal(scans[0].error_message, null);
  assert.equal(s.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending').length, 0, 'the whole queue was searched');
  assert.equal(scans[0].checked, scans[0].requested, 'counts carry across runs');
  assert.ok(s.legs.length >= 1, 'it was handed to another run');
  assert.ok(s.legs.every((l) => l.auth === 'Bearer user'), 'as the person who pressed, never a service key');
  assert.equal(scans[0].cost_usd, Math.round(s.searches.length * 0.002 * 10000) / 10000, 'spend adds up across runs');
  assert.ok(!('handoff' in (scans[0].filters || {})), 'the one-time handoff is used up');
  // A replayed or forged continue call is refused: no second worker.
  const replay = await s.call({ continue_scan: scans[0].id, handoff: s.legs[0].body.handoff, leg: 1 });
  assert.equal(replay.status, 409);
  const forged = setup({ data: seed({ affiliate_customer_scans: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', company_entity_id: CO, status: 'running', requested: 3, filters: {}, started_at: '2026-11-24T03:59:30Z', heartbeat_at: '2026-11-24T03:59:30Z' }] }) });
  const f = await forged.call({ continue_scan: 'aaaaaaaa-0000-4000-8000-000000000001', handoff: 'guess', leg: 1 });
  assert.equal(f.status, 409, 'a continue without the handoff the last run wrote is refused');
});

await test('a scan whose runs keep running out stops after the run cap, saying so', async () => {
  const data = seed();
  for (let i = 0; i < 400; i += 1) data.company_customer_profiles.push(cust(`c${i}`, `cara num${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, { order_count: 4 }));
  const s = setup({ data, budgetHit: true, chain: true });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(s.legs.length, H.SCAN_MAX_LEGS - 1, 'at most the cap of runs');
  assert.equal(scan.status, 'stopped');
  assert.equal(scan.error_message, 'Stopped early. More to check.');
});

await test('a queued customer who unsubscribes before the next press is dropped, never searched', async () => {
  const s = setup({ budgetHit: true });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  const pending = s.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending');
  assert.ok(pending.length >= 1, 'the stopped scan left a queue');
  const data = structuredClone(s.service.tables);
  for (const c of data.company_customer_profiles) if (pending.some((p) => p.customer_key === c.customer_key)) c.email_consent_state = 'redacted';
  const next = setup({ data });
  // Later, as the next press is: what the first run posted has had time to come back.
  next.tick(60 * 60_000);
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

await test('the queue: posts map to tasks by position, "no results" is an answer, a fault is a failure', async () => {
  const calls = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const q = L.createSerpQueue({ credentials: { login: 'l', password: 'p' }, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (/task_post/.test(url)) return reply({ status_code: 20000, tasks: [{ id: 'a1', status_code: 20100, cost: 0.0006 }, { id: null, status_code: 40501, cost: 0 }] });
    const id = url.split('/').pop();
    const code = { none: 40102, wait: 40602, bad: 40101, ok: 20000 }[id];
    return reply({ status_code: 20000, tasks: [{ status_code: code, result: code === 20000 ? [{ items: [{ type: 'organic', url: 'https://www.instagram.com/x' }, { type: 'people_also_ask' }] }] : null }] });
  } });
  const acks = await q.post([{ task: { keyword: 'a' } }, { task: { keyword: 'b' } }]);
  assert.deepEqual(acks.map((a) => a.id), ['a1', null], 'a refused task has no id');
  assert.equal(acks[0].cost, 0.0006);
  assert.equal(JSON.parse(calls[0].init.body)[0].priority, 1, 'the standard (cheaper) queue');
  assert.ok(/\/v3\/serp\/google\/organic\/task_post$/.test(calls[0].url));
  assert.deepEqual(await q.get('none'), { state: 'ready', items: [] }, 'Google had nothing for the name: no account, not a failure');
  assert.deepEqual(await q.get('wait'), { state: 'pending' });
  assert.equal((await q.get('bad')).state, 'error');
  assert.equal((await q.get('ok')).items.length, 1, 'organic results only');
  // A real provider fault on a name search is a failure, kept to retry.
  const f = setup({ refuse: { 'Quiet Person': 40101 } });
  await f.call({ filters: { minOrders: 2 } });
  await f.settle();
  assert.equal(row(f, 'nobody').status, 'error');
  assert.equal(f.service.tables.affiliate_customer_scans[0].failed, 1);
  assert.equal(f.searches.filter((x) => /Quiet Person/.test(x.keyword)).length, 2, 'searched once more, then left as failed');
  // A hiccup: the one retry answers it.
  const g = setup({ flaky: { 'Quiet Person': 40101 } });
  await g.call({ filters: { minOrders: 2 } });
  await g.settle();
  assert.notEqual(row(g, 'nobody').status, 'error', 'the retry answered it');
  assert.equal(g.service.tables.affiliate_customer_scans[0].failed, 0);
});

await test('the email username is searched only when the name search did not settle it', async () => {
  const data = seed();
  data.company_customer_profiles.find((c) => c.customer_key === 'emily').email_lc = 'emd.az.77@buyer.invalid';
  const s = setup({ data });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(row(s, 'emily').status, 'found', 'one profile carrying her name answered it');
  assert.ok(!s.searches.some((t) => /emd\.az\.77/.test(t.keyword)), 'so her username is not searched, or paid for');
  assert.ok(s.searches.some((t) => /^"nobody"/.test(t.keyword)) && s.searches.some((t) => /^"twins"/.test(t.keyword)),
    'it still is for nothing found and for several namesakes');
});

await test('ambiguous searches a run had no time to judge are judged by one more run, then the scan is done', async () => {
  // Each search takes 107s: the third ends with 9s of the run left, too
  // little for the model (the 2026-11-24 pilot: 100 checked, none judged).
  const s = setup({ chain: true, searchMs: 107_000 });
  await s.call({ filters: { minOrders: 2 } });
  await s.settle();
  assert.equal(s.legs.length, 1, 'handed to one more run');
  assert.equal(s.modelCalls.length, 1, 'which asks the model');
  assert.equal(row(s, 'twins').decided_by, 'ai');
  assert.equal(row(s, 'twins').status, 'found');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.status, 'done');
  assert.equal(scan.error_message, null);
  assert.equal(s.service.tables.affiliate_customer_scans.length, 1, 'the same scan');
  assert.equal(s.searches.length, 3, 'with no new search');
  // Nowhere to hand it (no caller token to continue as): done, not "stopped early".
  const solo = setup({ searchMs: 107_000 });
  await solo.call({ filters: { minOrders: 2 } });
  await solo.settle();
  assert.equal(solo.service.tables.affiliate_customer_scans[0].status, 'done');
  assert.equal(row(solo, 'twins').status, 'ambiguous', 'left for the next press to judge');
  // Nothing owed: no extra run.
  const quick = setup({ chain: true });
  await quick.call({ filters: { minOrders: 2 } });
  await quick.settle();
  assert.equal(quick.legs.length, 0, 'a run that judged everything ends there');
});
// A big slice: customers named Cara <letters>, every 100th one with a profile
// over the bar.
const letters = (i, p = 'q') => { let x = ''; let v = i; do { x = String.fromCharCode(97 + (v % 26)) + x; v = Math.floor(v / 26); } while (v > 0); return `${p}${x}`; };
// Hits are Likely by default: the profile says "baseball", the company's
// niche word (its program's), and carries the name in the handle.
function bigSlice(n, { hitEvery = 100, meta = {}, prefix = 'q', snippet = '2,000 Followers · baseball mom' } = {}) {
  const data = seed();
  data.entities[0].meta = meta;
  for (let i = 0; i < n; i += 1) {
    const last = letters(i, prefix);
    data.company_customer_profiles.push(cust(`k${i}`, `cara ${last}`, { order_count: 4, email_lc: `k${i}@buyer.invalid` }));
    const display = `Cara ${last.charAt(0).toUpperCase()}${last.slice(1)}`;
    if (hitEvery && i % hitEvery === 0) RESULTS[display] = [ig(`cara${last}`, `${display} (@cara${last})`, snippet)];
  }
  return data;
}

await test('"Find 2" keeps hunting until 2 people over the bar come back, then stops paying', async () => {
  const s = setup({ data: bigSlice(1500), chain: true });
  await s.call({ finds: 2, filters: { minOrders: 2 } });
  await s.settle();
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.status, 'done');
  assert.equal(scan.filters.end, 'goal', 'it ended because it found what was asked for');
  assert.ok(scan.found >= 2, `found ${scan.found}`);
  assert.ok(scan.checked < 1500, `it did not check the whole slice (${scan.checked})`);
  assert.equal(scan.requested, scan.checked, 'everything lined up was checked or handed back');
  assert.equal(s.service.tables.affiliate_customer_social.filter((x) => x.status === 'pending').length, 0, 'nothing left queued');
});

await test('a slice that runs out says so; the cap on customers checked per press is company data', async () => {
  const s = setup();
  await s.call({ finds: 25, filters: { minOrders: 2 } });
  await s.settle();
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.status, 'done');
  assert.equal(scan.filters.end, 'pool', 'everyone in the slice was checked');
  assert.equal(scan.found, 0, 'both over the bar are name-only: to check, not found');
  assert.equal(scan.filters.to_check, 2);
  // A slice with no hits at all stops at the company's cap, not at the end
  // of the list.
  const c = setup({ data: bigSlice(600, { hitEvery: 0, prefix: 'z', meta: { affiliate_customer_scan_max_checks: 150 } }), chain: true });
  await c.call({ finds: 5, filters: { minOrders: 2 } });
  await c.settle();
  const cs = c.service.tables.affiliate_customer_scans[0];
  assert.equal(cs.filters.end, 'cap');
  assert.ok(cs.checked <= 150 && cs.checked >= 100, `checked ${cs.checked}, the cap is 150`);
  assert.equal(L.companyMaxChecks({}), 10_000, '10,000 when the company has not set one');
  assert.equal(L.clampFinds(undefined), 25);
  assert.equal(L.clampFinds(9999), 500);
});

await test('a find over the bar tied by the name alone is "Check" and never counts toward "Find N"', async () => {
  const s = setup({ data: bigSlice(400, { hitEvery: 50, prefix: 'n', snippet: '90K Followers' }), chain: true });
  await s.call({ finds: 2, filters: { minOrders: 2 } });
  await s.settle();
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.found, 0, 'no name-only find is counted as found');
  assert.equal(scan.filters.end, 'pool', 'so the press keeps going until the slice runs out');
  assert.ok(scan.filters.to_check >= 8, `they wait under Check (${scan.filters.to_check})`);
  const big = s.service.tables.affiliate_customer_social.find((x) => x.status === 'found' && x.followers === 90000);
  assert.equal(big.match_score, 30, '40 + 10 for the name in the handle, 20 off for 90K followers on a name alone');
});

await test('the match score: each signal adds, a big name-only account loses, 70 is Likely', async () => {
  const p = L.personName('john smith');
  const base = { handle: '@jsmith88', title: 'J Smith (@jsmith88)', snippet: '', followers: 1200 };
  const sc = (pick, o = {}) => L.scorePick({ pick, person: p, ...o });
  assert.deepEqual(sc(base), { basis: 'name_only', score: 40 });
  assert.deepEqual(sc(base, { email: 'jsmith88@gmail.com' }), { basis: 'email_handle', score: 90 });
  assert.deepEqual(sc({ ...base, snippet: 'Phoenix, AZ' }, { city: 'Phoenix, AZ' }), { basis: 'city', score: 70 });
  assert.deepEqual(sc({ ...base, snippet: 'Baseball dad' }, { terms: ['baseball'] }), { basis: 'niche', score: 70 });
  assert.equal(sc({ ...base, snippet: 'Baseballs and balloons' }, { terms: ['baseball'] }).basis, 'name_only', 'a whole word only');
  assert.equal(sc({ ...base, handle: '@johnsmith' }).score, 50, 'the name in the handle adds 10, never enough alone');
  assert.equal(sc({ ...base, followers: 324000 }).score, 10, 'a 324K account tied by a name alone is near the floor');
  assert.equal(sc({ ...base, followers: 324000, snippet: 'baseball' }, { terms: ['baseball'] }).score, 70, 'a second signal keeps a big account Likely');
  assert.equal(sc(base, { decidedBy: 'ai', email: 'jsmith88@gmail.com' }).score, 85, 'the model choosing between namesakes is a little less sure');
  assert.equal(L.tallyBucket('found', 69), 'check'); assert.equal(L.tallyBucket('found', 70), 'found');
  assert.equal(L.tallyBucket('found', null), 'check', 'unscored is never counted as found');
  assert.equal(L.tallyBucket('below', 10), 'below');
  assert.equal(L.socialRowPatch({ status: 'found', pick: { profile_url: 'https://x.test/a' }, score: 140 }).match_score, 100);
  assert.equal(L.socialRowPatch({ status: 'none', pick: null, score: 50 }).match_score, null, 'no profile, no score');
  const core = await import(new URL('v2/affiliates/studio-core.js', ROOT));
  assert.equal(core.LIKELY_SCORE, L.LIKELY_SCORE, 'the page and the scan agree on what Likely means');
  assert.deepEqual(L.companyTerms({ affiliate_customer_scan_terms: 'Baseball, MLB , x' }), ['baseball', 'mlb'], 'company words, short ones dropped');
  assert.deepEqual(L.companyTerms({ affiliate_customer_scan_terms: ['MLB', 'baseball'] }, [{ niche: 'baseball dads' }]), ['mlb', 'baseball', 'dads'], 'company words combined with the programs\' words');
  assert.deepEqual(L.companyTerms({}, [{ niche: null, audience_notes: 'Baseball' }, { niche: 'softball moms' }]), ['baseball', 'softball', 'moms']);
  assert.deepEqual(L.termsInput(' MLB, Baseball ,, x, baseball'), ['mlb', 'baseball'], 'the box as typed: folded, short and repeated words dropped');
  assert.deepEqual(L.termsInput(''), []);
});

await test('a profile matched with no count gets one search for its own handle, which can make it a find', async () => {
  const data = seed();
  data.company_customer_profiles = [cust('kim', 'kim lowe', { order_count: 9, email_lc: 'kimbo@buyer.invalid' })];
  RESULTS['Kim Lowe'] = [ig('kimlowe', 'Kim Lowe (@kimlowe)', 'Baseball mom. Phoenix.')];
  RESULTS['@kimlowe'] = [ig('kimlowefan', 'Kim fan (@kimlowefan)', '99K Followers'), ig('kimlowe', 'Kim Lowe (@kimlowe) • Instagram photos and videos', '3,400 Followers, 120 Following, 88 Posts', 2)];
  const s = setup({ data });
  await s.call({ finds: 1, filters: { minOrders: 2 } });
  await s.settle();
  const r = row(s, 'kim');
  const ask = s.searches.find((t) => t.keyword.startsWith('"@kimlowe"'));
  assert.ok(ask, 'one search for the matched profile\'s own handle');
  assert.equal(ask.keyword, '"@kimlowe" site:instagram.com', 'pinned to that profile\'s platform');
  assert.equal(r.status, 'found');
  assert.equal(r.followers, 3400, 'read from that profile\'s own result, never the bigger account next to it');
  assert.equal(r.followers_quote, '3,400 Followers');
  assert.equal(r.match_basis, 'niche');
  assert.equal(r.match_score, 80);
  assert.equal(r.serp_task_id, null, 'collected');
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.deepEqual([scan.found, scan.no_count, scan.filters.end], [1, 0, 'goal'], 'it moved from no count to found, and met the goal');
  // Nothing stated: it stays as it was, never a guess.
  delete RESULTS['@kimlowe'];
  assert.equal(L.judgeCount({ items: [ig('kimlowe', 'Kim Lowe', 'Baseball mom')], pick: { platform: 'instagram', handle: '@kimlowe', profile_url: 'https://www.instagram.com/kimlowe' } }), null);
  assert.equal(L.buildCountTask({ platform: 'pinterest', handle: '@x' }), null, 'only platforms that state a count');
  assert.equal(L.buildCountTask({ platform: 'youtube', handle: 'UCabc123' }), null, 'a channel id is not searchable');
});

await test('a leg reads at most SCAN_LEG_GETS results, then the same scan carries on in a fresh run', async () => {
  // Production 2026-11-24: a leg that read ~370 results was killed for CPU
  // before it could hand off, leaving the scan "running" with nobody on it.
  const s = setup({ data: bigSlice(700, { hitEvery: 0, prefix: 'l' }), chain: true });
  await s.call({ finds: 5, filters: { minOrders: 2 } });
  await s.settle();
  const marks = [0, ...s.legs.map((l) => l.gets), s.gets.length];
  for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i] - marks[i - 1] <= H.SCAN_LEG_GETS, `leg ${i} read ${marks[i] - marks[i - 1]} results`);
  assert.ok(s.legs.length >= 4, `the work is spread over several runs (${s.legs.length})`);
  const scan = s.service.tables.affiliate_customer_scans[0];
  assert.equal(scan.status, 'done', 'and the scan still finishes');
  assert.equal(scan.filters.end, 'pool');
  assert.ok(H.SCAN_LEG_GETS <= 200, 'well under the ~370 that hit the CPU limit');
});

console.log(`\naffiliate-customer-scan-edge: ${passed} passed`);
