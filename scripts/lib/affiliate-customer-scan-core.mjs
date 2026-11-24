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
import { buildSerpTask, candidatesFromResults } from './affiliate-discovery-core.mjs';

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
export const SCAN_STATUSES = ['found', 'below', 'no_count', 'ambiguous', 'none', 'pending', 'error'];
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
const titleCase = (w) => w.replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase());

/**
 * A customer's stored name -> the person to look for, or null when it is not
 * a person's name a search could find: one word, initials, digits, or a
 * business. A null is skipped, not searched, so nothing is spent on "Team
 * Store" or "J".
 */
export function personName(nameLc, firstLc = null, lastLc = null) {
  const words = fold(nameLc).replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
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
  const c = String(city || '').replace(/["\s]+/g, ' ').trim().slice(0, 60);
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
  const named = candidates.filter((c) => c.platform !== 'blog' && nameOnProfile(c, person)).map((c) => ({ ...c, followers: parseFollowers(textOf(c)) }));
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
            key: { type: 'string', description: 'The customer key exactly as given.' },
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
  const lines = rows.slice(0, AI_BATCH).map((r) => {
    const cands = (r.candidates || []).slice(0, AI_MAX_CANDIDATES)
      .map((c, i) => `  ${i + 1}. ${c.profile_url}\n     title: ${c.title}\n     text: ${c.snippet}`).join('\n');
    return `Customer ${r.key}: ${r.name}${r.city ? `, ${r.city}` : ''}\n${cands}`;
  }).join('\n\n');
  return {
    model,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    system: 'You match a shop\'s customers to their own public social profiles. For each customer you are shown the profiles a Google search returned that carry their name. Choose the one profile that is most plausibly that same person (the city, region or anything in the text can tell you), or null when you cannot tell. Never choose a brand, a fan page, a team or a celebrity who merely shares the name. Answer only with the record_matches tool.',
    tools: [AI_TOOL],
    tool_choice: { type: 'tool', name: 'record_matches' },
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
  for (const m of tool?.input?.matches || []) if (m && typeof m.key === 'string') byKey.set(m.key, m.profile_url ?? null);
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

/** One row of the result table, from a judgement. Columns match affiliate_customer_social. */
export function socialRowPatch({ status, pick, candidates = null, decidedBy, query, checkedAt }) {
  return {
    status,
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
    candidates: status === 'ambiguous' ? (candidates || []) : (candidates && candidates.length > 1 ? candidates : null),
  };
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
