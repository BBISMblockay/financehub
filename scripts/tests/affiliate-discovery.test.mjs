// Affiliate Studio native discovery (scripts/lib/affiliate-discovery-core.mjs),
// driven through runDiscovery() with a fake SERP provider and a fake Supabase.
//
// The properties that matter:
//   * only URLs that NAME their owner become prospects -- a YouTube /watch or
//     an Instagram /p/ link is not a profile, and guessing the channel would
//     mean fetching pages this module does not fetch;
//   * nothing is invented: no follower counts, and an email only when the
//     snippet states one, with the result URL as its source;
//   * the score never reaches 1 and always carries its basis;
//   * a prospect a human reviewed is never re-opened, and its contact is never
//     overwritten;
//   * the suppression list is consulted for every candidate;
//   * the per-program cost cap stops querying, against the PROVIDER'S cost;
//   * a dry run calls no provider and writes nothing;
//   * one failing query does not lose the others, and is recorded.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_DISCOVERY_MUTATION=watch      a YouTube /watch URL is accepted as a profile
//   AFFILIATE_DISCOVERY_MUTATION=reviewed   an update resets status to 'new'
//   AFFILIATE_DISCOVERY_MUTATION=contact    an existing contact is overwritten
//   AFFILIATE_DISCOVERY_MUTATION=suppress   the suppression check is skipped
//   AFFILIATE_DISCOVERY_MUTATION=cap        the cost cap is never checked
//   AFFILIATE_DISCOVERY_MUTATION=dryrun     a dry run still calls the provider
//   AFFILIATE_DISCOVERY_MUTATION=ceiling    the score may reach 1.0
//   AFFILIATE_DISCOVERY_MUTATION=noretry    a transient provider error is not retried
//   AFFILIATE_DISCOVERY_MUTATION=unpinned   a search is not pinned to creator platforms
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_DISCOVERY_MUTATION || '';
async function loadCore() {
  const src = new URL('../lib/affiliate-discovery-core.mjs', import.meta.url);
  if (!MUT) return import(src);
  let code = await readFile(src, 'utf8');
  const swap = (from, to) => { assert.ok(code.includes(from), `mutation ${MUT}: pattern not found`); code = code.split(from).join(to); };
  if (MUT === 'watch') swap("    if (['c', 'user', 'channel'].includes(seg[0]) && seg[1]) {", "    if (seg[0] === 'watch') return { platform: 'youtube', handle: 'unknown', profile_url: rawUrl };\n    if (['c', 'user', 'channel'].includes(seg[0]) && seg[1]) {");
  else if (MUT === 'reviewed') swap('        confidence: c.confidence, confidence_basis: c.confidence_basis, updated_at: c.collected_at,\n      };', "        confidence: c.confidence, confidence_basis: c.confidence_basis, updated_at: c.collected_at, status: 'new',\n      };");
  else if (MUT === 'contact') swap('      if (!prior.contact_email && c.contact_email) {', '      if (c.contact_email) {');
  else if (MUT === 'suppress') swap("    if (prior?.status === 'suppressed' || !(await canContact(supabase, program, c))) {", "    if (prior?.status === 'suppressed') {");
  else if (MUT === 'cap') swap('      if (spent >= cap) {', '      if (false) {');
  else if (MUT === 'dryrun') swap("      if (dryRun) {\n        log(", "      if (dryRun && false) {\n        log(");
  else if (MUT === 'unpinned') swap('  if (!sites.length) return q.slice(0, 700);', '  return q.slice(0, 700);')
  else if (MUT === 'noretry') swap('      if (!err?.retryable || attempt >= SERP_ATTEMPTS) throw err;', '      throw err;');
  else if (MUT === 'goto') swap('    const resolved = resolveResultUrl(raw);', '    const resolved = raw.url;')
  else if (MUT === 'crumbcut') swap("    if (/(\\.\\.\\.|…)/.test(seg)) break;", '')
  else if (MUT === 'blank') swap('...Object.fromEntries(Object.entries(c.evidence || {}).filter(([, v]) => v !== null && v !== undefined))', '...c.evidence')
  else if (MUT === 'ceiling') swap('  score = Math.min(0.95, Math.round(score * 1000) / 1000);', '  score = Math.min(1, Math.round(score * 1000) / 1000 + 0.5);');
  else throw new Error(`unknown mutation ${MUT}`);
  const dir = await mkdtemp(join(tmpdir(), 'affdisc-'));
  const file = join(dir, 'affiliate-discovery-core.mjs');
  await writeFile(file, code);
  return import(pathToFileURL(file).href);
}
const core = await loadCore();
const { classifyProfileUrl, classifyWebsite, statedEmail, scoreProspect, nicheTerms, candidatesFromResults, runDiscovery, buildSerpTask, fetchSerpLive, searchKeyword, resolveResultUrl } = core;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

// ── A minimal fake Supabase: enough of the query builder for the core ────
function fakeSupabase(seed, { suppressed = [] } = {}) {
  const tables = structuredClone(seed);
  const calls = [];
  const ensure = (t) => (tables[t] ||= []);
  let nextId = 1;
  function builder(table) {
    const filters = [];
    let op = 'select'; let payload = null; let single = false;
    const run = () => {
      const rows = ensure(table);
      const match = (r) => filters.every(([k, v, kind]) => kind === 'in' ? v.map(String).includes(String(r[k])) : r[k] === v);
      if (op === 'select') return { data: rows.filter(match).map((r) => ({ ...r })), error: null };
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const r of list) {
          if (table === 'affiliate_prospects' && rows.some((x) => x.program_id === r.program_id && String(x.profile_url).toLowerCase() === String(r.profile_url).toLowerCase())) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "affiliate_prospects_identity"' } };
          }
          const row = { id: `${table}-${nextId++}`, ...r };
          rows.push(row);
          calls.push({ table, op, row });
          if (single) return { data: { id: row.id }, error: null };
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        for (const r of rows.filter(match)) { Object.assign(r, payload); calls.push({ table, op, row: r, patch: payload }); }
        return { data: null, error: null };
      }
      throw new Error(op);
    };
    const b = {
      select() { return b; },
      insert(p) { op = 'insert'; payload = p; return b; },
      update(p) { op = 'update'; payload = p; return b; },
      eq(k, v) { filters.push([k, v, 'eq']); return b; },
      in(k, v) { filters.push([k, v, 'in']); return b; },
      single() { single = true; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return {
    tables, calls,
    from: builder,
    rpc: async (name, args) => {
      assert.equal(name, 'affiliate_outreach_can_contact');
      calls.push({ rpc: name, args });
      const hit = suppressed.some((s) => [args.p_email, args.p_handle, args.p_profile_url].filter(Boolean).map((x) => x.toLowerCase()).includes(s));
      return { data: !hit, error: null };
    },
  };
}

const CO = 'co-1';
const PROGRAM = { id: 'prog-1', company_entity_id: CO, name: 'Creators', status: 'active', niche: 'baseball training drills and youth coaching', audience_notes: 'parents of travel ball players', platforms: ['youtube', 'instagram'], discovery_max_cost_usd: 0.05 };
const SOURCE = (id, query, extra = {}) => ({ id, company_entity_id: CO, program_id: PROGRAM.id, kind: 'serp_query', enabled: true, query, max_results: 20, ...extra });

const ITEMS = [
  { type: 'organic', url: 'https://www.youtube.com/@CoachPat', title: 'Coach Pat - Baseball Training Drills', description: 'Youth coaching drills every week. Business: pat@coachpat.invalid', rank_absolute: 2, domain: 'www.youtube.com' },
  { type: 'organic', url: 'https://www.youtube.com/watch?v=abc123', title: 'Top 10 drills', description: 'A video', rank_absolute: 3 },
  { type: 'organic', url: 'https://www.instagram.com/p/Cxyz/', title: 'A post', description: '', rank_absolute: 4 },
  { type: 'organic', url: 'https://www.instagram.com/travelballmom/', title: 'Travel Ball Mom (@travelballmom)', description: 'Parents of travel ball players unite', rank_absolute: 12 },
  { type: 'organic', url: 'https://m.youtube.com/@coachpat/videos', title: 'Coach Pat videos', description: '', rank_absolute: 15 },
  { type: 'organic', url: 'https://www.amazon.com/baseball-drills', title: 'Buy drills', description: '', rank_absolute: 1 },
  { type: 'organic', url: 'https://www.tiktok.com/@swingfix/video/123', title: 'swing fix on TikTok', description: 'contact noreply@tiktok.com', rank_absolute: 40 },
];

await test('only URLs that name their owner are profiles', () => {
  assert.deepEqual(classifyProfileUrl('https://www.youtube.com/@CoachPat'), { platform: 'youtube', handle: '@CoachPat', profile_url: 'https://www.youtube.com/@CoachPat' });
  assert.equal(classifyProfileUrl('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(classifyProfileUrl('https://www.instagram.com/p/Cxyz/'), null);
  assert.equal(classifyProfileUrl('https://www.instagram.com/explore/tags/baseball/'), null);
  assert.equal(classifyProfileUrl('https://www.tiktok.com/@swingfix/video/123').profile_url, 'https://www.tiktok.com/@swingfix');
  assert.equal(classifyProfileUrl('https://twitter.com/coachpat/status/1').profile_url, 'https://x.com/coachpat');
  assert.equal(classifyProfileUrl('https://x.com/search?q=x'), null);
  assert.equal(classifyProfileUrl('javascript:alert(1)'), null);
  assert.equal(classifyProfileUrl('not a url'), null);
});

await test('the website lane refuses retailers, encyclopedias and platform hosts', () => {
  assert.equal(classifyWebsite('https://www.amazon.com/x'), null);
  assert.equal(classifyWebsite('https://en.wikipedia.org/wiki/Baseball'), null);
  assert.equal(classifyWebsite('https://www.youtube.com/watch?v=1'), null);
  assert.equal(classifyWebsite('https://coachpatblog.example/post/1').profile_url, 'https://coachpatblog.example');
});

await test('an email is stored only when the snippet states one, and never a role address', () => {
  assert.equal(statedEmail('Business: Pat@CoachPat.invalid.'), 'pat@coachpat.invalid');
  assert.equal(statedEmail('contact noreply@tiktok.com'), null);
  assert.equal(statedEmail('email me at me@example.com'), null);
  assert.equal(statedEmail('no address here'), null);
});

await test('the score is fit to the query, carries its basis, and never reaches 1', () => {
  const terms = nicheTerms(PROGRAM);
  assert.ok(terms.includes('baseball') && terms.includes('drills') && !terms.includes('and'));
  const best = scoreProspect({ item: { title: 'baseball training drills youth coaching travel', description: 'a@b.co', rank_absolute: 1 }, profile: { platform: 'youtube' }, program: PROGRAM, terms });
  assert.ok(best.confidence < 1, `got ${best.confidence}`);
  assert.ok(best.confidence <= 0.95);
  assert.match(best.confidence_basis, /not creator quality/);
  assert.match(best.confidence_basis, /search rank 1/);
  const weak = scoreProspect({ item: { title: 'Unrelated', description: '', rank_absolute: 80 }, profile: { platform: 'x' }, program: PROGRAM, terms });
  assert.ok(weak.confidence < best.confidence);
});

await test('one result set becomes de-duplicated candidates with full provenance and no invented metrics', () => {
  const { candidates, stats } = candidatesFromResults({ items: ITEMS, program: PROGRAM, source: SOURCE('s1', 'baseball drills youtube'), collectedAt: '2026-11-10T00:00:00Z' });
  assert.equal(stats.results_returned, 7);
  const urls = candidates.map((c) => c.profile_url);
  assert.ok(urls.includes('https://www.youtube.com/@CoachPat'));
  assert.ok(urls.includes('https://www.instagram.com/travelballmom'));
  assert.ok(urls.includes('https://www.tiktok.com/@swingfix'));
  assert.equal(urls.filter((u) => u.toLowerCase() === 'https://www.youtube.com/@coachpat').length, 1, 'the same channel twice is one candidate');
  assert.ok(!urls.some((u) => /watch|\/p\/|amazon/.test(u)), 'non-profiles are dropped (no web lane for this program)');
  assert.equal(stats.profiles_recognized, candidates.length);
  const pat = candidates.find((c) => c.handle === '@CoachPat');
  assert.equal(pat.contact_email, 'pat@coachpat.invalid');
  assert.equal(pat.contact_source_url, 'https://www.youtube.com/@CoachPat');
  assert.equal(pat.evidence.query, 'baseball drills youtube');
  assert.equal(pat.collected_at, '2026-11-10T00:00:00Z');
  const tiktok = candidates.find((c) => c.platform === 'tiktok');
  assert.equal(tiktok.contact_email, null, 'a role address in the snippet is not a contact');
  for (const c of candidates) {
    assert.ok(!/follower|subscriber_count|engagement/i.test(JSON.stringify(c.evidence).replace(/"snippet":"[^"]*"/, '')), 'no invented metric keys');
  }
});

await test('the SERP task is bounded', () => {
  const t = buildSerpTask(SOURCE('s', '  baseball  ', { max_results: 500 }));
  assert.equal(t.depth, 100);
  assert.equal(t.keyword, 'baseball (site:instagram.com OR site:tiktok.com/@ OR site:youtube.com/@ OR site:twitch.tv OR site:x.com OR site:twitter.com OR site:pinterest.com)', 'no program: every creator platform');
  assert.ok(buildSerpTask(SOURCE('s', 'y'.repeat(900)), PROGRAM).keyword.length <= 700);
});

await test('every search is pinned to creator platforms', () => {
  const q = (query, extra, program) => searchKeyword(SOURCE('s', query, extra), program);
  assert.equal(q('baseball drills', {}, PROGRAM), 'baseball drills (site:youtube.com/@ OR site:instagram.com)', 'the program\u2019s ticked platforms');
  assert.equal(q('baseball drills', { platform_hint: 'tiktok' }, PROGRAM), 'baseball drills site:tiktok.com/@', 'the search\u2019s own Platform wins');
  assert.equal(q('baseball drills', { platform_hint: 'x' }, PROGRAM), 'baseball drills (site:x.com OR site:twitter.com)');
  assert.equal(q('baseball drills', { platform_hint: 'blog' }, PROGRAM), 'baseball drills', 'Platform blog searches websites, unpinned');
  assert.equal(q('baseball drills', {}, { ...PROGRAM, platforms: ['blog', 'web'] }), 'baseball drills', 'a websites-only program is unpinned');
  assert.equal(q('baseball drills', {}, { ...PROGRAM, platforms: ['blog', 'youtube'] }), 'baseball drills site:youtube.com/@', 'social ticks pin even with blog ticked');
  assert.match(q('baseball drills', {}, { ...PROGRAM, platforms: [] }), /site:youtube\.com\/@ OR .*site:pinterest\.com\)$/, 'nothing ticked: every creator platform');
  assert.equal(q('drills site:youtube.com/@', {}, PROGRAM), 'drills site:youtube.com/@', 'an operator\u2019s own site: filter is left alone');
  assert.equal(buildSerpTask(SOURCE('s', 'x', { max_results: 1 })).depth, 10);
});

const clock = () => new Date('2026-11-10T12:00:00Z');
let uuidN = 0; const uuid = () => `run-${++uuidN}`;

await test('a run writes prospects, observations, a run row per query, the source summary, and sync_jobs', async () => {
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'baseball drills youtube')] });
  const serpCalls = [];
  const summary = await runDiscovery({ supabase: sb, now: clock, uuid, fetchSerp: async (task) => { serpCalls.push(task); return { items: ITEMS, cost: 0.002 }; } });
  assert.equal(serpCalls.length, 1);
  assert.equal(summary.ran, 1);
  assert.equal(summary.prospects_new, 3);
  assert.equal(sb.tables.affiliate_prospects.length, 3);
  assert.ok(sb.tables.affiliate_prospects.every((p) => p.status === 'new' && p.source === 'serp' && p.source_url && p.collected_at));
  assert.equal(sb.tables.affiliate_prospect_observations.length, 3);
  const run = sb.tables.affiliate_discovery_runs[0];
  assert.equal(run.status, 'ok');
  assert.equal(run.cost_usd, 0.002);
  assert.equal(run.results_returned, 7);
  assert.equal(run.profiles_recognized, 3);
  assert.equal(sb.tables.affiliate_prospect_sources[0].last_run_results, 3);
  assert.equal(sb.tables.sync_jobs[0].job_type, 'affiliate_discovery');
  assert.equal(sb.tables.sync_jobs[0].status, 'success');
  // The source summary is written after the prospects it describes.
  const order = sb.calls.filter((c) => c.table).map((c) => c.table);
  assert.ok(order.lastIndexOf('affiliate_prospects') < order.indexOf('affiliate_prospect_sources'));
});

await test('a reviewed prospect is refreshed, never re-opened, and keeps its contact', async () => {
  const existing = { id: 'p-1', company_entity_id: CO, program_id: PROGRAM.id, profile_url: 'https://www.youtube.com/@CoachPat', status: 'rejected', contact_email: 'manager@coachpat.invalid', evidence: { note: 'kept', followers: 41200, domain: 'kept.example' } };
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'q')], affiliate_prospects: [existing] });
  // This run's result names no domain, so its evidence carries domain: null.
  await runDiscovery({ supabase: sb, now: clock, uuid, fetchSerp: async () => ({ items: [{ ...ITEMS[0], domain: undefined }], cost: 0.002 }) });
  const p = sb.tables.affiliate_prospects.find((x) => x.id === 'p-1');
  assert.equal(p.status, 'rejected');
  assert.equal(p.contact_email, 'manager@coachpat.invalid');
  assert.equal(p.evidence.note, 'kept', 'earlier evidence is merged, not replaced');
  assert.equal(p.evidence.last_seen_query, 'q');
  assert.equal(p.evidence.followers, 41200, 'a value this run did not find never blanks a recorded one');
  assert.equal(p.evidence.domain, 'kept.example', 'a null from this run does not overwrite');
  assert.equal(sb.tables.affiliate_prospects.length, 1);
});

await test('suppressed creators are skipped and counted', async () => {
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'q')] }, { suppressed: ['@travelballmom'] });
  await runDiscovery({ supabase: sb, now: clock, uuid, fetchSerp: async () => ({ items: ITEMS, cost: 0.001 }) });
  assert.ok(!sb.tables.affiliate_prospects.some((p) => p.handle === '@travelballmom'));
  assert.equal(sb.tables.affiliate_discovery_runs[0].suppressed_skipped, 1);
  assert.ok(sb.calls.filter((c) => c.rpc).length >= 3, 'every candidate is checked');
});

await test('the cost cap stops querying, measured by the provider\'s own cost', async () => {
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'a'), SOURCE('s2', 'b'), SOURCE('s3', 'c')] });
  let calls = 0;
  const summary = await runDiscovery({ supabase: sb, now: clock, uuid, fetchSerp: async () => { calls += 1; return { items: [], cost: 0.03 }; } });
  assert.equal(calls, 2, '0.03 + 0.03 crosses the 0.05 cap, so the third query is not sent');
  assert.equal(summary.skipped, 1);
  assert.equal(sb.tables.affiliate_discovery_runs.find((r) => r.query === 'c').status, 'skipped');
});

await test('a dry run calls no provider and writes nothing', async () => {
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'q')] });
  let calls = 0;
  const summary = await runDiscovery({ supabase: sb, dryRun: true, now: clock, uuid, fetchSerp: async () => { calls += 1; return { items: ITEMS, cost: 1 }; } });
  assert.equal(calls, 0);
  assert.equal(summary.dry_run, true);
  assert.equal(sb.calls.filter((c) => c.op === 'insert' || c.op === 'update').length, 0);
});

await test('one failing query is recorded and does not lose the others', async () => {
  const sb = fakeSupabase({ affiliate_programs: [PROGRAM], affiliate_prospect_sources: [SOURCE('s1', 'bad'), SOURCE('s2', 'good')] });
  const summary = await runDiscovery({ supabase: sb, now: clock, uuid, fetchSerp: async (t) => {
    if (t.keyword.startsWith('bad ')) throw new Error('SERP provider refused the task: 40501 Invalid Field');
    return { items: ITEMS.slice(0, 1), cost: 0.001 };
  } });
  assert.equal(summary.failed, 1);
  assert.equal(summary.ran, 1);
  assert.equal(sb.tables.affiliate_discovery_runs.find((r) => r.query === 'bad').status, 'error');
  assert.match(sb.tables.affiliate_prospect_sources.find((s) => s.id === 's1').last_error, /40501/);
  assert.equal(sb.tables.affiliate_prospects.length, 1);
  assert.equal(sb.tables.sync_jobs[0].status, 'error');
});

await test('a transient provider error is retried; a real refusal is not', async () => {
  const answer = (code, items = []) => ({ ok: true, status: 200, json: async () => ({ tasks: [{ status_code: code, status_message: 'x', cost: 0.002, result: [{ items }] }] }) });
  const creds = { login: 'l', password: 'p' };
  const sleeps = [];
  let n = 0;
  const flaky = async () => (++n === 1 ? answer(40101) : answer(20000, [{ type: 'organic', url: 'https://www.youtube.com/@a' }]));
  const ok = await fetchSerpLive({ credentials: creds, task: { keyword: 'q' }, fetchImpl: flaky, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(n, 2, 'one retry after the search engine error');
  assert.equal(ok.items.length, 1);
  assert.equal(sleeps.length, 1);
  let m = 0;
  await assert.rejects(fetchSerpLive({ credentials: creds, task: { keyword: 'q' }, fetchImpl: async () => { m += 1; return answer(40101); }, sleep: async () => {} }), /40101/);
  assert.equal(m, 3, 'three attempts, then it is recorded as an error');
  let k = 0;
  await assert.rejects(fetchSerpLive({ credentials: creds, task: { keyword: 'q' }, fetchImpl: async () => { k += 1; return answer(40501); }, sleep: async () => {} }), /40501/);
  assert.equal(k, 1, 'an invalid request is not retried');
});

await test('a Google redirect result is read from its breadcrumb, never guessed', async () => {
  // Production 2026-11-10: every one of 29 results came back as
  // https://google.com/goto?url=CAES... (domain google.com), so nothing was a profile.
  const goto = 'https://google.com/goto?url=CAESZwHEIkXXsgCwMjMc&gsessionid=ceamwnE7qgzatoIjo';
  const items = [
    { type: 'organic', url: goto, domain: 'google.com', breadcrumb: 'https://www.tiktok.com › @jenna.and.her.gents', title: 'Jenna and Her Gents (@jenna.and.her.gents) | TikTok' },
    { type: 'organic', url: goto, domain: 'google.com', breadcrumb: 'https://www.youtube.com › @BaseballBenji', title: 'Baseball Benji - YouTube' },
    { type: 'organic', url: goto, domain: 'google.com', breadcrumb: 'https://www.instagram.com › baseball_mo…', title: 'cut off' },
    { type: 'organic', url: goto, domain: 'google.com', breadcrumb: 'www.google.com › search', title: 'google' },
    { type: 'organic', url: goto, domain: 'google.com', title: 'no breadcrumb' },
  ];
  const { candidates, stats } = candidatesFromResults({ items, program: { ...PROGRAM, platforms: ['tiktok', 'youtube', 'instagram'] }, source: SOURCE('s1', 'baseball mom'), collectedAt: '2026-11-10T00:00:00Z' });
  assert.equal(stats.profiles_recognized, 2);
  assert.deepEqual(candidates.map((c) => c.profile_url).sort(), ['https://www.tiktok.com/@jenna.and.her.gents', 'https://www.youtube.com/@BaseballBenji'].sort());
  const t = candidates.find((c) => c.platform === 'tiktok');
  assert.equal(t.source_url, 'https://www.tiktok.com/@jenna.and.her.gents');
  assert.equal(t.evidence.google_redirect_url, goto, 'the original redirect is kept for audit');
  assert.equal(t.evidence.resolved_from, 'breadcrumb');
  assert.equal(resolveResultUrl({ url: goto, breadcrumb: 'https://www.instagram.com › reel › …' }), 'https://www.instagram.com/reel', 'a shortened segment is dropped, not guessed');
  assert.equal(resolveResultUrl({ url: goto }), null);
  assert.equal(resolveResultUrl({ url: 'https://www.tiktok.com/@x', breadcrumb: 'https://other.com › y' }), 'https://www.tiktok.com/@x', 'a normal result is untouched');
  assert.equal(resolveResultUrl({ url: 'http://192.168.3.1/upg.html?url=www.google.com/goto?url=CAES', breadcrumb: 'https://www.tiktok.com › @a' }), 'https://www.tiktok.com/@a');
});

console.log(`\naffiliate-discovery: ${passed} passed`);
