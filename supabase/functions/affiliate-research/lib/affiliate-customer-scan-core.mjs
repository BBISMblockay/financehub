// scripts/lib/affiliate-customer-scan-core.mjs -- "Find their social
// accounts" on Affiliate Studio's Your Customers tab.
//
// The question it answers (Blake, 2026-11-24): which of a brand's own repeat
// buyers have a public social account big enough to be a micro-influencer for
// it? Not existing creators -- "more looking to make a bunch of micro
// influencers pushing the brand if they are down" -- so the bar is a
// per-program follower count (750 by default), and the people come from the
// company's own customer list, not from a keyword search.
//
// HOW, per customer, cheapest first:
//   1. ONE search through the provider Discovery already pays for, pinned to
//      the program's social platforms: "First Last" City. That is a fraction
//      of a cent, against 8-10c a lead for an AI research run.
//   2. The result titles are read for a PROFILE whose name is the customer's
//      own name, and the snippet for a follower count ("1,204 Followers",
//      "12.3K followers"). One such profile answers the question.
//   3. Only where the search shows TWO OR MORE profiles carrying the name is
//      a model asked, twenty customers per request, with nothing but the text
//      already fetched and no web tools -- it chooses one of those profiles,
//      or none. It never supplies a follower count: a count is kept only when
//      it can be read out of a result's own text, which the code re-checks.
//
// WHAT IT NEVER DOES: fetch a profile page, guess a handle, estimate a count,
// research somebody who unsubscribed from marketing, or contact anyone. A
// person found here is only a row on the Your Customers list until somebody
// ticks them.
//
// Pure, apart from the imports. Verbatim copy shipped in
// supabase/functions/affiliate-research/lib/, pinned by
// scripts/tests/affiliate-customer-scan-edge.test.mjs.
import { buildSerpTask, candidatesFromResults, nicheTerms } from './affiliate-discovery-core.mjs';

export const SCAN_PROVIDER = 'dataforseo';
export const SCAN_DEFAULT = 500;
export const SCAN_MAX = 1000;
export const DEFAULT_MIN_FOLLOWERS = 750;
// Searches in flight at once. The provider allows far more; ten keeps a
// 500-customer scan inside one background run without hammering anyone.
export const SCAN_CONCURRENCY = 10;
// Customers per model request when a search was ambiguous.
export const AI_BATCH = 20;
export const AI_MAX_CANDIDATES = 4;
export const AI_MAX_OUTPUT_TOKENS = 2000;
// The statuses a customer's row can be in, in the order a person reads them.
export const SCAN_STATUSES = ['found', 'below', 'no_count', 'ambiguous', 'none', 'pending', 'error', 'rejected'];
// Why a profile is believed to be THIS customer (Blake, 2026-11-24: "how to
// trust finds"). A first-and-last-name match alone is what a namesake also
// has, so it is shown as a name match to check, never as a likely find.
//   email_handle  the handle is the customer's own email name (jsmith@ -> @jsmith)
//   city          the customer's city appears in the result's own text
//   niche         the profile's own text uses one of the company's niche words
//   name_only     nothing but the name ties the profile to them
export const MATCH_BASES = ['email_handle', 'city', 'niche', 'name_only'];
// Free mail hosts. A member's address on any OTHER domain marks that domain as
// the company's own, so its staff are never scanned as customers.
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net']);
// Never researched at all: somebody who said no to marketing, and a privacy
// erasure (a redacted row has no name left to look for anyway). Every other
// consent state, including "never asked" and "not checked yet", is scanned --
// consent is a filter, never a gate (Blake, 2026-11-24), and an explicit
// opt-out is out of the pool entirely ("if they physically opted out, we
// don't want them in pool").
export const NEVER_SCAN_CONSENT = ['unsubscribed', 'redacted'];

const BUSINESS_WORDS = new Set(['llc', 'inc', 'co', 'corp', 'company', 'store', 'shop', 'team', 'club', 'league',
  'school', 'academy', 'association', 'church', 'llp', 'ltd', 'group', 'sports', 'athletics', 'baseball', 'softball',
  'boutique', 'services', 'enterprises', 'foundation', 'university', 'college', 'org', 'department']);

/** Lowercase, accents stripped, letters only -- for comparing names. */
export function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
// Name suffixes are not a surname: "Ricardo Solano Jr" is searched as
// "Ricardo Solano", never "Ricardo Jr".
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'md', 'phd', 'esq']);
const titleCase = (w) => w.replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase());

/**
 * A customer's stored name -> the person to look for, or null when it is not
 * a person's name a search could find: one word, initials, digits, or a
 * business. A null is skipped, not searched, so nothing is spent on "Team
 * Store" or "J".
 */
export function personName(nameLc, firstLc = null, lastLc = null) {
  const words = fold(nameLc).replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w, i, all) => !(i > 0 && i === all.length - 1 && SUFFIXES.has(w.replace(/[^a-z]/g, ''))));
  if (/\d/.test(String(nameLc || ''))) return null;
  if (words.length < 2 || words.length > 4) return null;
  if (words.some((w) => BUSINESS_WORDS.has(w))) return null;
  const first = fold(firstLc || words[0]).replace(/[^a-z'-]/g, '') || words[0];
  const last = fold(lastLc || words[words.length - 1]).replace(/[^a-z'-]/g, '') || words[words.length - 1];
  if (first.length < 2 || last.length < 2) return null;
  return { first, last, display: words.map(titleCase).join(' ') };
}

/** The words searched for one customer: their name in quotes, then the city. */
export function scanQuery(person, city = null) {
  const c = String(city || '').replace(/["\s]+/g, ' ').replace(/\s+,/g, ',').trim().slice(0, 60);
  return `"${titleCase(person.first)} ${titleCase(person.last)}"${c ? ` ${c}` : ''}`;
}

/** The provider task: the shallowest page the provider sells, pinned to the program's platforms. */
export function buildScanTask(person, city, program) {
  return buildSerpTask({ query: scanQuery(person, city), max_results: 10 }, program);
}

const MULT = { k: 1e3, m: 1e6, b: 1e9 };
/**
 * A follower count stated in a result's own text, or null. "10K+" is read as
 * 10,000 and marked approximate: it is a floor the platform printed, never a
 * number SILO rounded. Subscribers count the same way (YouTube's word).
 */
export function parseFollowers(text) {
  const s = String(text || '');
  const re = /(\d{1,3}(?:[,.\s]\d{3})+|\d+(?:[.,]\d+)?)\s*([kmb])?\s*(\+)?\s*(followers|follower|subscribers|subscriber)\b/i;
  const m = s.match(re);
  if (!m) return null;
  let raw = m[1];
  const unit = (m[2] || '').toLowerCase();
  let n;
  if (unit) n = Number(raw.replace(',', '.')) * MULT[unit];
  else n = Number(raw.replace(/[,.\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return { count: Math.round(n), approx: !!unit || !!m[3], quote: m[0].trim() };
}

/** Does this profile carry the customer's own name? First AND last, in the title or the handle. */
export function nameOnProfile(candidate, person) {
  const title = fold(`${candidate.display_name || ''} ${candidate.evidence?.title || ''}`);
  const handle = fold(candidate.handle || '').replace(/[^a-z]/g, '');
  const has = (w) => title.includes(w) || handle.includes(w.replace(/[^a-z]/g, ''));
  return has(person.first) && has(person.last);
}

const textOf = (c) => `${c.evidence?.title || ''} ${c.evidence?.snippet || ''}`;

// Instagram pages that read as a profile from the URL and are not one:
// /popular/<name>/ is Instagram's own SEO directory of everybody with that
// name, and an 11-character mixed-case path is a post's shortcode.
const NOT_A_PROFILE = new Set(['popular', 'explore', 'p', 'reel', 'reels', 'stories', 'tv', 'accounts', 'about']);
export function realProfile(c) {
  const h = String(c?.handle || '').replace(/^@/, '');
  if (!h) return false;
  if (c.platform === 'instagram') {
    if (NOT_A_PROFILE.has(h.toLowerCase())) return false;
    if (/^[A-Za-z0-9_-]{11}$/.test(h) && /[A-Z]/.test(h) && /[a-z]/.test(h)) return false;
  }
  return true;
}

/**
 * Every reason this profile is believed to be this customer: their email name
 * as the handle, their city in the result, one of the company's niche words in
 * the result, their name in the handle itself. An email name that is just
 * their first name, last name or both is not a signal -- a namesake has those
 * too. Pure.
 */
export function matchSignals({ pick, person, email = null, city = null, terms = [] }) {
  const core = (v) => fold(v).replace(/[^a-z]/g, '');
  const local = core(String(email || '').split('@')[0]);
  const handle = core(pick?.handle);
  const nameOnly = new Set([person.first, person.last, person.first + person.last, person.last + person.first].map(core));
  const text = ` ${fold(`${pick?.title || ''} ${pick?.snippet || ''}`).replace(/[^a-z0-9]+/g, ' ')} `;
  const out = new Set();
  if (local.length >= 4 && handle.length >= 4 && !nameOnly.has(local)
    && (handle === local || (local.length >= 6 && handle.includes(local)))) out.add('email_handle');
  const where = fold(String(city || '').split(',')[0]).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (where.length >= 3 && text.includes(` ${where} `)) out.add('city');
  // A whole word, so "ball" never matches "balloon".
  if ((terms || []).some((t) => t && text.includes(` ${t} `))) out.add('niche');
  if (handle.includes(core(person.first)) && handle.includes(core(person.last))) out.add('handle_name');
  return out;
}

/** The strongest reason, as stored in match_basis. */
export function matchBasis(args) {
  const sig = matchSignals(args);
  return MATCH_BASES.find((b) => sig.has(b)) || 'name_only';
}

// ── How sure: a 0-100 match score ────────────────────────────────────────
// Blake 2026-11-24: "need scores". Every point is a reason a person can read
// back. A name alone starts at 40; each independent signal adds; a big account
// tied to them by nothing but a name loses points, because the most-followed
// namesake is exactly what Google ranks first (the 2026-11-24 audit: every
// find over 750 was name-only, and the 324K, 223K and 107K ones were
// strangers). A choice the model made between namesakes is a little less sure
// than a search that showed one profile.
//
// LIKELY_SCORE and up is "Likely" and counts toward the finds asked for;
// below it is "Check" -- shown, never counted, until a person looks.
export const LIKELY_SCORE = 70;
export const SCORE_POINTS = { base: 40, email_handle: 50, city: 30, niche: 30, handle_name: 10, ai_choice: -5 };
// Followers -> points off, for a profile tied to them by the name alone.
export const NAME_ONLY_BIG = [[100_000, -30], [20_000, -20], [5_000, -10]];
const STRONG = ['email_handle', 'city', 'niche'];
export function matchScore({ signals, followers = null, decidedBy = 'search' }) {
  const sig = signals instanceof Set ? signals : new Set(signals || []);
  let s = SCORE_POINTS.base;
  for (const k of ['email_handle', 'city', 'niche', 'handle_name']) if (sig.has(k)) s += SCORE_POINTS[k];
  if (decidedBy === 'ai') s += SCORE_POINTS.ai_choice;
  const f = Number(followers);
  if (!STRONG.some((k) => sig.has(k)) && followers !== null && Number.isFinite(f)) {
    const off = NAME_ONLY_BIG.find(([at]) => f >= at);
    if (off) s += off[1];
  }
  return Math.max(5, Math.min(99, Math.round(s)));
}
/** Score and basis together, for one chosen profile. */
export function scorePick({ pick, person, email = null, city = null, terms = [], decidedBy = 'search', also = [] }) {
  const signals = matchSignals({ pick, person, email, city, terms });
  // A signal the caller already proved another way (the username search's
  // exact handle match is email_handle by construction).
  for (const x of also) signals.add(x);
  return {
    basis: MATCH_BASES.find((b) => signals.has(b)) || 'name_only',
    score: matchScore({ signals, followers: pick?.followers ?? null, decidedBy }),
  };
}
/**
 * The counter a judged row lands in. Over the bar but not sure enough is
 * 'check', never 'found': "Find 25" brings back 25 people the score trusts.
 */
export function tallyBucket(status, score) {
  return status === 'found' && !(Number(score) >= LIKELY_SCORE) ? 'check' : status;
}

/**
 * The company's niche words, for the niche signal. Company data first
 * (entities.meta.affiliate_customer_scan_terms: a list or comma-separated
 * text), else the words of its active programs' niche and audience notes.
 */
export function companyTerms(meta, programs = []) {
  const raw = meta && typeof meta === 'object' ? meta.affiliate_customer_scan_terms : null;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  const words = list
    ? list.map((w) => fold(w).replace(/[^a-z0-9 ]/g, ' ').trim()).filter((w) => w.length >= 3)
    : (programs || []).flatMap((p) => nicheTerms(p)).map((w) => fold(w).replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 40);
}

/**
 * One customer's search results -> what is known about their social account.
 * Returns { status, pick, candidates } where status is one of:
 *   found      one profile carries their name, and its stated count meets the bar
 *   below      one profile carries their name, and its stated count is under it
 *   no_count   one profile carries their name, and no result states a count
 *   ambiguous  two or more profiles carry their name; the model chooses
 *   none       no profile carries their name
 */
export function judgeResults({ items, person, program, minFollowers = DEFAULT_MIN_FOLLOWERS, collectedAt }) {
  const { candidates } = candidatesFromResults({ items, program, source: { query: scanQuery(person) }, collectedAt });
  // Only the platforms the program recruits on: a search pinned to them can
  // still return a Pinterest board or an X account, which is not a channel
  // this program pays for.
  const allowed = Array.isArray(program?.platforms) && program.platforms.length ? new Set(program.platforms) : null;
  const named = candidates
    .filter((c) => c.platform !== 'blog' && (!allowed || allowed.has(c.platform)) && realProfile(c) && nameOnProfile(c, person))
    .map((c) => ({ ...c, followers: parseFollowers(textOf(c)) }));
  if (!named.length) return { status: 'none', pick: null, candidates: [] };
  if (named.length === 1) return { ...outcome(named[0], minFollowers), candidates: named.map(brief) };
  return { status: 'ambiguous', pick: null, candidates: named.slice(0, AI_MAX_CANDIDATES).map(brief) };
}

function outcome(c, minFollowers) {
  const f = c.followers;
  const status = !f ? 'no_count' : f.count >= minFollowers ? 'found' : 'below';
  return { status, pick: brief(c) };
}

/** What is stored and shown for one profile: where it is, and the words it was read from. */
export function brief(c) {
  return {
    platform: c.platform, handle: c.handle, profile_url: c.profile_url,
    title: String(c.evidence?.title || '').slice(0, 200), snippet: String(c.evidence?.snippet || '').slice(0, 400),
    source_url: c.source_url || c.profile_url,
    followers: c.followers ? c.followers.count : null,
    followers_approx: c.followers ? c.followers.approx : null,
    followers_quote: c.followers ? c.followers.quote : null,
  };
}

// ── The model, for ambiguous searches only ───────────────────────────────
export const AI_TOOL = {
  name: 'record_matches',
  description: 'Record, for each customer, which listed profile is that same person, or null when none clearly is.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The customer number exactly as given, e.g. "3".' },
            profile_url: { type: ['string', 'null'], description: 'One of the listed profile URLs for that customer, exactly as given, or null.' },
          },
          required: ['key', 'profile_url'],
        },
      },
    },
    required: ['matches'],
  },
};

/** One request for up to AI_BATCH ambiguous customers. Only text SILO already fetched; no web tools. */
export function buildAiRequest({ rows, model }) {
  // Customers are labelled by POSITION, never by customer_key: the key is
  // usually their email address, and a model needs only the name and city
  // (plus the profiles) to choose.
  const lines = rows.slice(0, AI_BATCH).map((r, n) => {
    const cands = (r.candidates || []).slice(0, AI_MAX_CANDIDATES)
      .map((c, i) => `  ${i + 1}. ${c.profile_url}\n     title: ${c.title}\n     text: ${c.snippet}`).join('\n');
    return `Customer ${n + 1}: ${r.name}${r.city ? `, ${r.city}` : ''}\n${cands}`;
  }).join('\n\n');
  return {
    model,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    system: 'You match a shop\'s customers to their own public social profiles. For each customer you are shown the profiles a Google search returned that carry their name. Choose the one profile that is most plausibly that same person (the city, region or anything in the text can tell you), or null when you cannot tell. Never choose a brand, a fan page, a team or a celebrity who merely shares the name. Always answer by calling the record_matches tool exactly once, covering every customer.',
    tools: [AI_TOOL],
    // 'auto', never a forced tool: the production model refuses
    // tool_choice 'tool' and 'any' outright (400 on 2026-11-24, which left
    // every ambiguous search unjudged). No tool call in the answer leaves
    // the rows ambiguous, never 'none'.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: lines }],
  };
}

/**
 * The model's answer -> one outcome per row. Its choice is accepted only when
 * it is one of the profiles that row was shown, and the follower count is
 * re-read from THAT profile's own text: the model never supplies a number.
 */
export function applyAiAnswer({ rows, answer, minFollowers = DEFAULT_MIN_FOLLOWERS }) {
  const tool = (answer?.content || []).find((b) => b?.type === 'tool_use' && b.name === AI_TOOL.name);
  const byKey = new Map();
  for (const m of tool?.input?.matches || []) {
    const n = Number(m?.key);
    const r = Number.isInteger(n) && n >= 1 && n <= Math.min(rows.length, AI_BATCH) ? rows[n - 1] : null;
    if (r) byKey.set(r.key, m.profile_url ?? null);
  }
  return rows.map((r) => {
    if (!byKey.has(r.key)) return { key: r.key, status: 'ambiguous', pick: null };
    const url = byKey.get(r.key);
    if (url === null) return { key: r.key, status: 'none', pick: null };
    const c = (r.candidates || []).find((x) => x.profile_url === url);
    if (!c) return { key: r.key, status: 'ambiguous', pick: null };
    const f = parseFollowers(`${c.title} ${c.snippet}`);
    const pick = { ...c, followers: f ? f.count : null, followers_approx: f ? f.approx : null, followers_quote: f ? f.quote : null };
    return { key: r.key, status: !f ? 'no_count' : f.count >= minFollowers ? 'found' : 'below', pick };
  });
}

/** The count of each status, for the scan row and the progress line. */
export function scanTally(rows) {
  const t = Object.fromEntries(SCAN_STATUSES.map((s) => [s, 0]));
  for (const r of rows || []) if (t[r.status] !== undefined) t[r.status] += 1;
  return t;
}

/** How many to scan: what was asked for, clamped; default when nothing usable was asked. */
// "Find 25" (Blake, 2026-11-24): the number a person enters is how many
// people over the bar come back, not how many are checked.
export const FINDS_DEFAULT = 25;
export const FINDS_MAX = 500;
export function clampFinds(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return FINDS_DEFAULT;
  return Math.min(FINDS_MAX, v);
}
// The safety cap on customers one press may check, so a big ask on a thin
// slice cannot run on unbounded. Company DATA:
// entities.meta.affiliate_customer_scan_max_checks, 10,000 when unset (Blake
// chose 10,000 on 2026-11-24).
export const MAX_CHECKS_DEFAULT = 10_000;
export function companyMaxChecks(meta) {
  const v = Math.floor(Number(meta?.affiliate_customer_scan_max_checks));
  return Number.isFinite(v) && v >= 1 ? Math.min(100_000, v) : MAX_CHECKS_DEFAULT;
}

// DataForSEO's standard queue: up to 100 searches per request at about a
// third of the live price, answered in a minute or two (measured 2026-09-26,
// see scripts/lib/seo-serp-sync-core.mjs). post() maps answers to the tasks
// by position, as the provider returns them; get() on a task still in the
// queue says so and costs nothing.
export const QUEUE_POST_BATCH = 100;
export function createSerpQueue({ credentials, fetchImpl = fetch, base = 'https://api.dataforseo.com' }) {
  const auth = 'Basic ' + btoa(`${credentials.login}:${credentials.password}`);
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.status_code !== 20000) {
      throw Object.assign(new Error(`SERP queue ${method} HTTP ${res.status} ${json?.status_code ?? ''} ${json?.status_message ?? ''}`.trim()), { code: json?.status_code ?? res.status });
    }
    return json;
  };
  return {
    /** [{ task }] -> [{ id, cost, code }] in the same order; id is null when refused. */
    async post(list) {
      if (!list.length) return [];
      const json = await call('POST', '/v3/serp/google/organic/task_post', list.map(({ task }) => ({ ...task, priority: 1 })));
      const tasks = json.tasks || [];
      if (tasks.length !== list.length) throw new Error(`SERP queue answered ${tasks.length} tasks for ${list.length} posted`);
      return tasks.map((t) => ({ id: t.status_code === 20100 && t.id ? String(t.id) : null, cost: Number(t.cost) || 0, code: t.status_code ?? null }));
    },
    /** -> { state: 'pending' } | { state: 'ready', items } | { state: 'error', code } */
    async get(id) {
      const json = await call('GET', `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(id)}`);
      const t = json.tasks?.[0];
      const code = t?.status_code ?? null;
      if (code === 40601 || code === 40602) return { state: 'pending' };
      // "No Search Results": Google had nothing for the name. An answer --
      // no account -- never a failure (most of the 2026-11-24 pilot's
      // "failed" rows were this).
      if (code === 40102) return { state: 'ready', items: [] };
      if (!t || code !== 20000) return { state: 'error', code };
      return { state: 'ready', items: (t.result?.[0]?.items || []).filter((i) => i && i.type === 'organic' && i.url) };
    },
  };
}

export function clampScanCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return SCAN_DEFAULT;
  return Math.min(SCAN_MAX, v);
}

/**
 * A program's follower bar. Data on the program, never a constant in code: a
 * brand that wants 2,000 sets 2,000.
 */
export function minFollowersFor(program) {
  const v = Number(program?.customer_scan_min_followers);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_MIN_FOLLOWERS;
}

/**
 * The scan is the COMPANY's, not a program's (Blake 2026-11-24: "people come
 * before program"). Its bar is company data -- entities.meta key
 * affiliate_customer_scan_min_followers -- and 750 when unset.
 */
export function companyMinFollowers(meta) {
  const raw = meta && typeof meta === 'object' ? meta.affiliate_customer_scan_min_followers : undefined;
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MIN_FOLLOWERS;
  return minFollowersFor({ customer_scan_min_followers: raw });
}

/**
 * What a company-level scan searches: the platforms whose profiles state a
 * follower count in a search result. Not Pinterest or X: on 2026-11-24 they
 * were 58 of 140 matched accounts, NEVER carried a count, and made 49 of the
 * 83 "several possible" rows (a namesake's board next to the real profile).
 * Not a program's ticks, so no program narrows an answer every program shares.
 */
export const COMPANY_SCAN_SCOPE = Object.freeze({ platforms: Object.freeze(['instagram', 'tiktok', 'youtube']) });


/** One row of the result table, from a judgement. Columns match affiliate_customer_social. */
export function socialRowPatch({ status, pick, candidates = null, decidedBy, query, checkedAt, basis = null, score = null }) {
  return {
    status,
    match_basis: pick?.profile_url ? (MATCH_BASES.includes(basis) ? basis : 'name_only') : null,
    match_score: pick?.profile_url && Number.isFinite(Number(score)) && score !== null ? Math.max(0, Math.min(100, Math.round(Number(score)))) : null,
    decided_by: decidedBy,
    query,
    checked_at: checkedAt,
    platform: pick?.platform ?? null,
    handle: pick?.handle ?? null,
    profile_url: pick?.profile_url ?? null,
    followers: pick?.followers ?? null,
    followers_approx: pick?.followers_approx ?? null,
    followers_quote: pick?.followers_quote ?? null,
    source_url: pick?.source_url ?? null,
    // Ambiguous: the profiles the model chooses from. Otherwise the chosen
    // profile's own title and text are kept too, so a find can be checked
    // from its row (the 2026-11-24 audit could not re-check single finds).
    candidates: status === 'ambiguous' ? (candidates || [])
      : candidates && candidates.length > 1 ? candidates
        : pick?.profile_url ? [pick] : null,
  };
}

/**
 * The company's own people, who are never scanned as customers: every member's
 * address, and every member domain that is not a free mail host (so staff who
 * never signed in to SILO are skipped too).
 */
export function teamFilter(memberEmails = []) {
  const emails = new Set(); const domains = new Set();
  for (const e of memberEmails) {
    const v = String(e || '').trim().toLowerCase();
    if (!v.includes('@')) continue;
    emails.add(v);
    const d = v.split('@')[1];
    if (d && !FREE_MAIL.has(d)) domains.add(d);
  }
  return (email) => {
    const v = String(email || '').trim().toLowerCase();
    if (!v) return false;
    if (emails.has(v)) return true;
    const host = v.split('@')[1] || '';
    for (const d of domains) if (host === d || host.endsWith(`.${d}`)) return true;
    return false;
  };
}

// ── The email username, as a second search ───────────────────────────────
// Blake, 2026-11-24: "Can't we use shopify email lookup too not just name
// based". No platform lets anybody look a person up by email, but the part
// before the @ is often their handle everywhere ("jsmith88@" -> @jsmith88).
// So a customer whose name search did not already tie a profile to their
// email gets ONE more search for that username alone -- never the full
// address -- and a profile whose handle IS that username is a likely find
// whether or not it carries their name.
//
// Not searched: a username that is only their name (a namesake shares it),
// a generic mailbox, one too short to be distinctive, and a marketplace's
// masked relay address (TikTok Shop, Apple, Amazon), whose username is random.
export const MASKED_MAIL = ['scs.tiktokw.us', 'privaterelay.appleid.com', 'marketplace.amazon.com', 'relay.firefox.com', 'duck.com'];
const GENERIC_LOCAL = new Set(['info', 'contact', 'hello', 'sales', 'admin', 'orders', 'order', 'support', 'office', 'mail', 'email', 'shop', 'store', 'team', 'billing', 'accounts', 'noreply']);
const coreOf = (v) => fold(v).replace(/[^a-z0-9]/g, '');
export function emailHandle(email, person) {
  const v = String(email || '').trim().toLowerCase();
  const at = v.lastIndexOf('@');
  if (at < 1) return null;
  const domain = v.slice(at + 1);
  if (MASKED_MAIL.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  const local = v.slice(0, at).split('+')[0];
  if (!/^[a-z0-9._-]+$/.test(local)) return null;
  const core = coreOf(local);
  const letters = core.replace(/[0-9]/g, '');
  if (core.length < 5 || letters.length < 3 || GENERIC_LOCAL.has(letters)) return null;
  if (person) {
    const names = [person.first, person.last, person.first + person.last, person.last + person.first].map(coreOf);
    if (names.includes(core)) return null;
  }
  return { local, core };
}
export function buildHandleTask(handle, program) {
  return buildSerpTask({ query: `"${handle.local}"`, max_results: 10 }, program);
}
/** The username search's results -> the profile whose handle IS that username, or none. */
export function judgeHandle({ items, handle, program, minFollowers = DEFAULT_MIN_FOLLOWERS, collectedAt }) {
  const { candidates } = candidatesFromResults({ items, program, source: { query: `"${handle.local}"` }, collectedAt });
  const allowed = Array.isArray(program?.platforms) && program.platforms.length ? new Set(program.platforms) : null;
  const hit = candidates.find((c) => c.platform !== 'blog' && (!allowed || allowed.has(c.platform)) && realProfile(c)
    && coreOf(c.handle) === handle.core);
  if (!hit) return { status: 'none', pick: null };
  return outcome({ ...hit, followers: parseFollowers(textOf(hit)) }, minFollowers);
}

// ── The follower count, when the match did not show one ──────────────────
// A profile found with no count in its result gets ONE more search for its
// own handle, pinned to its platform: the profile page's own result usually
// states "1,204 Followers". The count is read from that profile's result
// only, never from another account's text, and never estimated.
export const COUNT_PLATFORMS = ['instagram', 'tiktok', 'youtube'];
export function buildCountTask(pick) {
  // Only an @handle is searchable; a YouTube /channel/UC... id is not.
  const h = String(pick?.handle || '');
  if (!/^@[A-Za-z0-9._-]{2,64}$/.test(h) || !COUNT_PLATFORMS.includes(pick?.platform)) return null;
  return buildSerpTask({ query: `"${h}"`, platform_hint: pick.platform, max_results: 10 }, { platforms: [pick.platform] });
}
/** The count search's results -> the count stated on THAT profile's own result, or null. */
export function judgeCount({ items, pick, collectedAt }) {
  const { candidates } = candidatesFromResults({ items, program: { platforms: [pick.platform] }, source: { query: String(pick.handle || '') }, collectedAt });
  const want = String(pick.profile_url || '').toLowerCase();
  const hit = candidates.find((c) => c.platform === pick.platform && (c.profile_url.toLowerCase() === want || coreOf(c.handle) === coreOf(pick.handle)));
  const f = hit ? parseFollowers(textOf(hit)) : null;
  if (!f) return null;
  return { followers: f.count, followers_approx: f.approx, followers_quote: f.quote, source_url: hit.source_url || hit.profile_url,
    title: String(hit.evidence?.title || '').slice(0, 200), snippet: String(hit.evidence?.snippet || '').slice(0, 400) };
}

// ── Which customers a press scans ────────────────────────────────────────
// The same orderings the Your Customers list offers (v2/affiliates/
// studio-core.js CUSTOMER_SORTS), so "scan 500" scans the top 500 the person
// is looking at. A test pins the two tables equal.
export const SCAN_SORTS = {
  orders: [['order_count', false], ['lifetime_spend', false], ['last_order_at', false], ['customer_key', true]],
  spend: [['lifetime_spend', false], ['order_count', false], ['last_order_at', false], ['customer_key', true]],
  recent: [['last_order_at', false], ['order_count', false], ['lifetime_spend', false], ['customer_key', true]],
  oldest: [['first_order_at', true], ['order_count', false], ['customer_key', true]],
  name: [['name_lc', true], ['customer_key', true]],
};
const SCAN_CONSENTS = ['any', 'subscribed', 'not_subscribed', 'pending', 'unmeasured'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/**
 * The slice a press scans, from what the page sent, every field clamped. An
 * explicit opt-out is NOT a choice here: 'unsubscribed' is refused, because
 * those customers are never scanned whatever the filter says.
 */
export function scanFilters(f = {}) {
  const sort = Object.prototype.hasOwnProperty.call(SCAN_SORTS, f?.sort) ? f.sort : 'orders';
  const mo = Math.floor(Number(f?.minOrders));
  const minOrders = Number.isFinite(mo) ? Math.min(50, Math.max(1, mo)) : 2;
  const consent = SCAN_CONSENTS.includes(f?.consent) ? f.consent : 'any';
  const from = ISO.test(String(f?.from || '')) ? f.from : null;
  const to = ISO.test(String(f?.to || '')) ? f.to : null;
  return {
    sort, minOrders, consent, from, to,
    toExclusive: to ? nextDay(to) : null,
    consentIsNull: consent === 'unmeasured',
    consentState: consent === 'any' || consent === 'unmeasured' ? null : consent,
  };
}
