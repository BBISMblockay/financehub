// Affiliate Studio -- the page logic that has no DOM in it, so Node can test
// it (scripts/tests/affiliate-studio-ui.test.mjs). Imported by studio.js and
// by the three affiliate-facing pages. Nothing in here is company-specific:
// every name, rate and date comes from the program row.

// Mirrors public.affiliate_currency_minor_units(). A currency not listed is
// two-decimal, the same default the database uses.
export const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
export const minorUnits = (currency) => (ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100);

// NULL is "not measured" and renders as a dash, never as $0.
export function formatMoney(minor, currency = 'USD') {
  if (minor === null || minor === undefined || minor === '' || !Number.isFinite(Number(minor))) return '—';
  const cur = String(currency || 'USD').toUpperCase();
  const units = minorUnits(cur);
  const digits = units === 1 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(minor) / units);
  } catch {
    return `${(Number(minor) / units).toFixed(digits)} ${cur}`;
  }
}

// "12.50" -> 1250 (USD), "500" -> 500 (JPY). Refuses more decimals than the
// currency has instead of rounding someone's money.
export function parseMajorToMinor(text, currency = 'USD') {
  const s = String(text ?? '').trim().replace(/[,\s]/g, '');
  if (!s) return null;
  const units = minorUnits(currency);
  const re = units === 1 ? /^-?\d+$/ : /^-?\d+(\.\d{1,2})?$/;
  if (!re.test(s)) return NaN;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const v = Number(whole) * units + (units === 1 ? 0 : Number(frac.padEnd(2, '0')));
  return neg ? -v : v;
}

export function describeCommission({ kind, percent, fixed_cents: fixed, currency }) {
  if (kind === 'percent_of_net' && percent !== null && percent !== undefined) {
    return `${Number(percent)}% of each order's merchandise subtotal, after discounts and refunds, excluding tax and shipping`;
  }
  if (kind === 'fixed_per_order' && fixed !== null && fixed !== undefined) {
    return `${formatMoney(fixed, currency)} per attributed order`;
  }
  return 'Commission not configured';
}

export const BASIS_LABELS = {
  single_affiliate_code: { label: 'Earns: only code on order', earns: true },
  first_affiliate_code: { label: 'Earns: the one affiliate code among several', earns: true },
  ambiguous_multiple_affiliate_codes: { label: 'Not credited: two affiliates’ codes', earns: false },
  multiple_codes_refused: { label: 'Not credited: program allows one code per order', earns: false },
  code_outside_window: { label: 'Not credited: outside the code’s dates', earns: false },
  currency_mismatch: { label: 'Not credited: order in another currency', earns: false },
  refunds_not_measured: { label: 'Held: refunds not measured yet', earns: false },
};
export const basisLabel = (b) => BASIS_LABELS[b]?.label || b;

// Where a discovery search looks, by name. The numbers are the search
// provider's location codes (Google geo target ids); nobody should have to
// know them.
export const SEARCH_COUNTRIES = [
  ['US', 2840, 'United States'], ['CA', 2124, 'Canada'], ['GB', 2826, 'United Kingdom'], ['AU', 2036, 'Australia'],
  ['NZ', 2554, 'New Zealand'], ['IE', 2372, 'Ireland'], ['DE', 2276, 'Germany'], ['FR', 2250, 'France'],
  ['ES', 2724, 'Spain'], ['IT', 2380, 'Italy'], ['NL', 2528, 'Netherlands'], ['MX', 2484, 'Mexico'],
  ['BR', 2076, 'Brazil'], ['JP', 2392, 'Japan'],
];
export const SEARCH_LANGUAGES = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese']];
export const countryName = (code) => SEARCH_COUNTRIES.find((c) => c[1] === Number(code))?.[2] || (code ? `location ${code}` : 'any country');
export const languageName = (code) => SEARCH_LANGUAGES.find((l) => l[0] === code)?.[1] || code || 'any language';

// What a person sees for a failed search: no provider name, no codes. The
// provider's own message stays in affiliate_discovery_runs.error for support.
export function friendlySearchError(message) {
  const m = String(message || '');
  if (!m) return '';
  if (/HTTP 401|HTTP 403|40100|40200|40201/.test(m)) return 'Search is not connected. Contact support.';
  if (/cost cap/i.test(m)) return 'Skipped: this run reached its search limit.';
  if (/^skipped: /.test(m)) return `Left out: ${m.slice(9)}.`;
  if (/AI credit exhausted/i.test(m)) return 'Out of AI credit. A workspace owner can add credit in Workspace Settings.';
  if (/ran out of time|timeout|aborted/i.test(m)) return 'This took too long. Try a narrower focus.';
  return 'The search service had a temporary problem. Try again in a few minutes.';
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web', 'other'];
const intOr = (v, d) => (v === '' || v === null || v === undefined ? d : Number(v));

// The program form -> a row the table's CHECKs will accept, or the reasons
// it would not. The database re-checks every one of these.
export function validateProgram(f) {
  const errors = [];
  const currency = String(f.currency || 'USD').trim().toUpperCase();
  const row = {
    name: String(f.name || '').trim(),
    slug: String(f.slug || slugify(f.name)).trim(),
    status: f.status || 'draft',
    niche: String(f.niche || '').trim() || null,
    audience_notes: String(f.audience_notes || '').trim() || null,
    geographies: String(f.geographies || '').split(',').map((s) => s.trim()).filter(Boolean),
    platforms: (Array.isArray(f.platforms) ? f.platforms : String(f.platforms || '').split(',')).map((s) => String(s).trim()).filter(Boolean),
    intake_mode: f.intake_mode === 'open' ? 'open' : 'invite_only',
    commission_kind: f.commission_kind === 'fixed_per_order' ? 'fixed_per_order' : 'percent_of_net',
    commission_percent: null,
    commission_fixed_cents: null,
    currency,
    attribution_window_days: intOr(f.attribution_window_days, 0),
    code_precedence: f.code_precedence === 'single_code_only' ? 'single_code_only' : 'first_affiliate_code',
    refund_hold_days: intOr(f.refund_hold_days, 30),
    payout_minimum_cents: 0,
    payout_method: 'manual',
    discovery_max_cost_usd: f.discovery_max_cost_usd === '' || f.discovery_max_cost_usd === undefined ? 0.5 : Number(f.discovery_max_cost_usd),
    default_code_starts_on: f.default_code_starts_on || null,
    default_code_ends_on: f.default_code_ends_on || null,
    owner_user_id: f.owner_user_id || null,
    terms_markdown: String(f.terms_markdown || '').trim() || null,
  };
  // Percent off on the code queued when someone joins (blank = off). Only
  // sent when the form carries it, so a database without the column
  // (before 20261110180000) still saves.
  if (f.default_discount_percent !== undefined) {
    const d = String(f.default_discount_percent ?? '').trim();
    row.default_discount_percent = d === '' ? null : Number(d);
    if (row.default_discount_percent !== null && (!Number.isInteger(row.default_discount_percent) || row.default_discount_percent < 1 || row.default_discount_percent > 100)) {
      errors.push('Code % off must be a whole number from 1 to 100, or blank for no automatic code.');
    }
  }
  // The message every new outreach draft starts from (20261111020000). Only
  // sent when the form carries it, so a database without the columns still
  // saves. SILO's own wording is stored as blank, so it is never pinned to a
  // copy of itself.
  if (f.outreach_subject !== undefined || f.outreach_body !== undefined) {
    const subj = String(f.outreach_subject ?? '').trim();
    const body = String(f.outreach_body ?? '').replace(/\r\n/g, '\n').trim();
    row.outreach_subject = subj === '' || subj === DEFAULT_OUTREACH.subject ? null : subj;
    row.outreach_body = body === '' || body === DEFAULT_OUTREACH.body ? null : body;
    if (row.outreach_subject && row.outreach_subject.length > 200) errors.push('Keep the outreach subject under 200 characters.');
    if (row.outreach_body && row.outreach_body.length > 5000) errors.push('Keep the outreach message under 5,000 characters.');
    if (row.outreach_body && !row.outreach_body.includes('{signup_link}')) errors.push('Keep {signup_link} in the outreach message: it is how the creator joins.');
  }
  if (!row.name) errors.push('Give the program a name.');
  if (!SLUG_RE.test(row.slug)) errors.push('The short name (slug) must be 3–40 lowercase letters, digits or dashes.');
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('Currency must be a three-letter code such as USD.');
  if (row.commission_kind === 'percent_of_net') {
    const p = Number(f.commission_percent);
    if (f.commission_percent === '' || f.commission_percent === undefined || !Number.isFinite(p) || p < 0 || p > 100) errors.push('Commission percent must be between 0 and 100.');
    else row.commission_percent = p;
  } else {
    const c = parseMajorToMinor(f.commission_fixed, currency);
    if (c === null || Number.isNaN(c) || c < 0) errors.push('Enter the fixed commission per order.');
    else row.commission_fixed_cents = c;
  }
  const min = parseMajorToMinor(f.payout_minimum, currency);
  if (Number.isNaN(min) || (min !== null && min < 0)) errors.push('Payout minimum must be a positive amount.');
  else row.payout_minimum_cents = min ?? 0;
  for (const [k, lo, hi, what] of [['attribution_window_days', 0, 365, 'Grace days'], ['refund_hold_days', 0, 365, 'Refund hold']]) {
    if (!Number.isInteger(row[k]) || row[k] < lo || row[k] > hi) errors.push(`${what} must be a whole number from ${lo} to ${hi}.`);
  }
  if (!Number.isFinite(row.discovery_max_cost_usd) || row.discovery_max_cost_usd < 0 || row.discovery_max_cost_usd > 25) errors.push('Discovery cost cap must be between $0 and $25 per run.');
  if (row.default_code_starts_on && row.default_code_ends_on && row.default_code_ends_on < row.default_code_starts_on) errors.push('Default code end date is before its start date.');
  const bad = row.platforms.filter((p) => !PLATFORMS.includes(p));
  if (bad.length) errors.push(`Unknown platform: ${bad.join(', ')}.`);
  if (row.status === 'active' && !row.terms_markdown) errors.push('Write the program terms before making it active; affiliates accept them to join.');
  return { row, errors };
}

// ── Outreach export ──────────────────────────────────────────────────────
// Spreadsheet software executes a cell that starts with = + - @ (or a tab /
// carriage return). A creator's display name is untrusted text, so every
// such cell is neutralised with a leading apostrophe.
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function fillTemplate(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

export const DEFAULT_OUTREACH = {
  subject: 'Partnering with {brand}',
  body: 'Hi {name},\n\nWe found your {platform} through {source} and think your audience would like {brand}. We run an affiliate program: {commission}.\n\nIf you are interested, this link has the terms and lets you join: {signup_link}\n\nIf you would rather not hear from us again, just reply and say so.\n\n{sender}',
};

export const OUTREACH_HEADER = ['recipient_email', 'recipient_handle', 'channel', 'subject', 'message', 'signup_link', 'signup_link_expires', 'note'];
export function outreachRows(drafts, links) {
  return drafts.map((d) => {
    const l = links[d.id] || {};
    const msg = fillTemplate(d.body, { signup_link: l.url || '(no signup link: see note)' });
    return [d.recipient_email || '', d.recipient_handle || '', d.channel, d.subject || '', msg, l.url || '', l.expires_at || '', l.error || ''];
  });
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Payout handoff ───────────────────────────────────────────────────────
export const PAYOUT_HEADER = ['payout_id', 'payee', 'payee_email', 'amount', 'currency', 'amount_minor_units', 'entries', 'approved_at', 'note'];
export function payoutRows(payouts, affiliatesById) {
  return payouts.map((p) => {
    const a = affiliatesById[p.affiliate_id] || {};
    return [p.id, a.display_name || '', a.contact_email || '', (Number(p.amount_cents) / minorUnits(p.currency)).toFixed(minorUnits(p.currency) === 1 ? 0 : 2), p.currency, p.amount_cents, p.item_count ?? '', p.approved_at || '', 'SILO did not pay this. Pay it in your own system, then record the reference in SILO.'];
  });
}

// An href from stored data: http(s) only. The database refuses anything else
// on the prospect and affiliate URL columns; this is the second lock.
export function safeHref(u) {
  try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null; } catch { return null; }
}

// ── Trackable link ───────────────────────────────────────────────────────
export function linkUrl(l) {
  try {
    const u = new URL(l.destination_url);
    if (u.protocol !== 'https:') return null;
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (l[k]) u.searchParams.set(k, l[k]);
    return u.toString();
  } catch { return null; }
}

// An affiliate link: the brand's store through Shopify's /discount/CODE
// address, so the code is applied at checkout, then on to the page with the
// UTMs. The same builder as supabase/functions/affiliate-portal/affiliate-mail.mjs
// (pinned identical by the browser test), so Studio shows exactly the link the
// affiliate gets.
const STORE_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PATH_RE = /^\/[A-Za-z0-9/_.~%-]*$/;
export function affiliateLink(store, code, path = '/', query = '', hash = '') {
  if (!STORE_RE.test(String(store || '')) || !code) return null;
  const p = PATH_RE.test(String(path || '')) && !String(path).startsWith('//') ? path : '/';
  // The page's own query (a variant, a search) is kept; the UTMs are merged in.
  const q = new URLSearchParams(String(query || ''));
  for (const [k, v] of [['utm_source', 'affiliate'], ['utm_medium', 'affiliate'], ['utm_campaign', String(code)]]) q.set(k, v);
  const h = /^#[A-Za-z0-9_.~%=&-]*$/.test(String(hash || '')) ? hash : '';
  return `${store}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(`${p}?${q}${h}`)}`;
}
export function storeLinkFor(store, code, url) {
  if (!STORE_RE.test(String(store || '')) || !code) return null;
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  const bare = (h) => String(h).toLowerCase().replace(/^www\./, '');
  if (u.protocol !== 'https:' || bare(u.hostname) !== bare(new URL(store).hostname)) return null;
  return affiliateLink(store, code, u.pathname || '/', u.search, u.hash);
}

export function applyUrl(origin, companyId, slug) {
  return `${String(origin).replace(/\/$/, '')}/v2/affiliates/apply.html?c=${encodeURIComponent(companyId)}&p=${encodeURIComponent(slug)}`;
}

// ── How each part works, stated from what the data shows ─────────────────
// verified: SILO has observed it working for this company.
// manual: a person does it outside SILO and records it.
// simulated: only dry runs so far.
// unconfigured: not set up for this company yet.
// waiting: set up, but not yet seen working here (a code never used on an order).
// Codes that are live in the store: active only. A pending code is not in
// Shopify yet, and a retired one (including a request cancelled before it was
// ever created) is not set up.
export const liveCodeCount = (codes) => (codes || []).filter((c) => c?.status === 'active').length;

export function stageLabels(f = {}) {
  const runs = f.discoveryRuns || [];
  // Runs are recorded 'ok' (older ones 'success').
  const liveOk = runs.some((r) => !r.dry_run && (r.status === 'ok' || r.status === 'success'));
  const dryOnly = runs.length > 0 && runs.every((r) => r.dry_run);
  const notes = f.notifications || [];
  const mailSent = notes.some((n) => n.status === 'sent');
  const mailSkipped = notes.some((n) => n.status === 'skipped' && /RESEND/i.test(n.reason || ''));
  return [
    { stage: 'Discovery', label: liveOk ? 'verified' : dryOnly ? 'simulated' : 'unconfigured',
      detail: liveOk ? 'Find creators is finding creators for this program.' : dryOnly ? 'Only test runs so far.' : 'Run Find creators to start.' },
    { stage: 'Outreach to prospects', label: 'manual', detail: 'You send approved messages from your own inbox.' },
    { stage: 'Affiliate emails', label: mailSent ? 'verified' : mailSkipped ? 'unconfigured' : 'unconfigured',
      detail: mailSent ? 'Signup confirmations and portal links are being delivered.' : mailSkipped ? 'Email is not set up yet.' : 'No affiliate email has been sent yet.' },
    { stage: 'Code tracking', label: f.codesSeen > 0 ? 'verified' : f.codesTotal > 0 ? 'waiting' : 'unconfigured',
      detail: f.codesSeen > 0 ? `${f.codesSeen} code(s) have been seen on real orders.` : f.codesTotal > 0 ? 'Codes are set up. Waiting for the first order that uses one.' : 'Add a code for an affiliate to start.' },
    { stage: 'Trackable links', label: 'manual', detail: 'Tagged links to your site for your analytics.' },
    { stage: 'Commissions', label: f.ledgerEntries > 0 ? 'verified' : 'unconfigured', detail: 'Calculated after discounts and refunds, before tax and shipping.' },
    { stage: 'Payouts', label: 'manual', detail: 'You pay from your own bank or payment tool and record it here.' },
  ];
}

// ── List import ──────────────────────────────────────────────────────────
// RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, a leading BOM) to
// an array of objects keyed by the header row. Header names are lower-cased
// and trimmed; the edge function matches its own column aliases. Blank lines
// are dropped. Throws on an unterminated quote, so a broken file is refused
// instead of half-read.
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (q) throw new Error('The file has an unclosed quote, so it cannot be read.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonBlank = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonBlank.length) return [];
  const header = nonBlank[0].map((h) => h.trim().toLowerCase());
  return nonBlank.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h)));
}
export const chunk = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

// What kind of run a discovery-runs row is, in words.
export function runKindLabel(r = {}) {
  if (r.provider === 'anthropic') return 'AI research';
  if (r.provider === 'import') return 'list import';
  return r.dry_run ? 'dry run' : 'search';
}
// Followers as a page stated them (AI research), or as the imported file said.
export function followersFrom(evidence) {
  const e = evidence || {};
  if (!Number.isFinite(Number(e.followers)) || e.followers === null || e.followers === '') return null;
  return { count: Number(e.followers), source_url: e.followers_source_url || null, as_of: e.followers_as_of || null, kind: e.followers_source_kind || null };
}

// A creator's profile photo, as AI research read it on their own profile page:
// https only, and nothing that could break out of an attribute. null = none.
export function prospectPhotoUrl(evidence) {
  const u = typeof evidence?.profile_image_url === 'string' ? evidence.profile_image_url.trim() : '';
  return u.length <= 2000 && /^https:\/\/[^\s"'<>()\\]+$/.test(u) ? u : null;
}

// An affiliate's photo (20261111020000): none if the rep removed it, else the
// one they set in the portal, else the one found for them as a prospect.
export function affiliatePhotoUrl(affiliate, prospectEvidence) {
  if (affiliate?.photo_hidden === true) return null;
  return prospectPhotoUrl({ profile_image_url: affiliate?.photo_url }) || prospectPhotoUrl(prospectEvidence);
}

// The subject and message a new outreach draft starts from: the program's
// own, else SILO's.
export function outreachTemplate(program) {
  const subject = typeof program?.outreach_subject === 'string' && program.outreach_subject.trim() ? program.outreach_subject : DEFAULT_OUTREACH.subject;
  const body = typeof program?.outreach_body === 'string' && program.outreach_body.includes('{signup_link}') ? program.outreach_body : DEFAULT_OUTREACH.body;
  return { subject, body };
}

// Where a prospect came from, in words.
export const SOURCE_LABELS = { serp: 'search', manual: 'added by hand', csv_import: 'your list', applied: 'applied', ai_research: 'AI research' };
export const sourceLabel = (s) => SOURCE_LABELS[s] || s || '';

// ── Overview maths (Affiliate Studio's Overview tab) ─────────────────────
// Every function here is pure: the page passes in the rows it has already
// read, and gets back numbers. Three rules hold throughout, because they are
// the rules the commission resolver itself follows:
//   * only the two EARNING bases are sales; every other basis is an order the
//     resolver refused to pay on, and is reported as such, never as revenue;
//   * the program settles in ONE currency, so an order in another currency is
//     counted separately and never added in;
//   * a missing number is unknown, not zero -- which is why a window with no
//     rows returns zero orders rather than a made-up total.
export const OV_EARNING_BASES = ['single_affiliate_code', 'first_affiliate_code'];
const EARNING = new Set(OV_EARNING_BASES);
const CUR = (c) => String(c || 'USD').toUpperCase();

// Calendar maths on plain YYYY-MM-DD days, in UTC, so no local clock can
// shift a day boundary between two calls.
export function dayShift(isoDay, back) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Number(back || 0));
  return d.toISOString().slice(0, 10);
}
export const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// The rows of one window, in the program's own currency.
export function ovWindowRows(rows, { from, to, currency }) {
  const cur = CUR(currency);
  return (rows || []).filter((r) => r?.order_day && r.order_day >= from && r.order_day <= to
    && CUR(r.order_currency || cur) === cur);
}
// What that window sold: sales are the merchandise subtotal of EARNING
// attributions only, and an order is counted once however many rows it has.
export function ovWindow(rows, opts) {
  const earning = ovWindowRows(rows, opts).filter((r) => EARNING.has(r.basis));
  return {
    sales: earning.reduce((n, r) => n + Number(r.gross_subtotal_cents || 0), 0),
    orders: new Set(earning.map((r) => r.order_id)).size,
    sellers: [...new Set(earning.map((r) => r.affiliate_id).filter(Boolean))],
    rows: earning,
  };
}
export function ovOtherCurrencyOrders(rows, { from, to, currency }) {
  const cur = CUR(currency);
  return new Set((rows || []).filter((r) => r?.order_day && r.order_day >= from && r.order_day <= to
    && CUR(r.order_currency || cur) !== cur).map((r) => r.order_id)).size;
}
// Commission is the ledger's own number, never a rate applied to sales: the
// ledger already carries refund adjustments, and it is what Pay settles.
// A ledger line with no order day (a manual adjustment) belongs to no window.
export function ovLedgerTotal(ledger, { from, to, currency }) {
  const cur = CUR(currency);
  return (ledger || []).filter((r) => r?.order_day && r.order_day >= from && r.order_day <= to
    && CUR(r.currency) === cur)
    .reduce((n, r) => n + Number(r.amount_cents || 0), 0);
}
// Weekly buckets ending on `today`, oldest first, for the trend lines.
export function ovWeekly(rows, { today, weeks, currency, pick }) {
  const cur = CUR(currency);
  const out = new Array(weeks).fill(0);
  for (const r of (rows || [])) {
    if (!r?.order_day || CUR(r.order_currency || r.currency || cur) !== cur) continue;
    const age = dayDiff(today, r.order_day);
    if (age < 0 || age >= weeks * 7) continue;
    out[weeks - 1 - Math.floor(age / 7)] += Number(pick(r) || 0);
  }
  return out;
}
export function ovWeeklySellers(rows, { today, weeks, currency }) {
  const cur = CUR(currency);
  const sets = Array.from({ length: weeks }, () => new Set());
  for (const r of (rows || [])) {
    if (!r?.order_day || !r.affiliate_id || !EARNING.has(r.basis)) continue;
    if (CUR(r.order_currency || cur) !== cur) continue;
    const age = dayDiff(today, r.order_day);
    if (age < 0 || age >= weeks * 7) continue;
    sets[weeks - 1 - Math.floor(age / 7)].add(r.affiliate_id);
  }
  return sets.map((s) => s.size);
}
// Per affiliate: this window, the window before it, and the commission the
// ledger recorded for the days in this window.
export function ovPerAffiliate({ rows, ledger, performance, affiliates, currency, from, to, prevFrom, prevTo }) {
  const cur = CUR(currency);
  const perf = Object.fromEntries((performance || []).map((x) => [x.affiliate_id, x]));
  const affById = Object.fromEntries((affiliates || []).map((a) => [a.id, a]));
  const by = new Map();
  const seat = (id) => {
    if (!by.has(id)) by.set(id, { id, sales: 0, prevSales: 0, comm: 0, orderIds: new Set() });
    return by.get(id);
  };
  for (const r of ovWindow(rows, { from, to, currency: cur }).rows) {
    if (!r.affiliate_id) continue;
    const b = seat(r.affiliate_id);
    b.sales += Number(r.gross_subtotal_cents || 0);
    b.orderIds.add(r.order_id);
  }
  for (const r of ovWindow(rows, { from: prevFrom, to: prevTo, currency: cur }).rows) {
    if (r.affiliate_id) seat(r.affiliate_id).prevSales += Number(r.gross_subtotal_cents || 0);
  }
  for (const r of (ledger || [])) {
    if (!r?.affiliate_id || !r.order_day || r.order_day < from || r.order_day > to) continue;
    if (CUR(r.currency) !== cur) continue;
    seat(r.affiliate_id).comm += Number(r.amount_cents || 0);
  }
  return [...by.values()].filter((b) => affById[b.id]).map((b) => ({
    id: b.id,
    sales: b.sales,
    prevSales: b.prevSales,
    comm: b.comm,
    orders: b.orderIds.size,
    aff: affById[b.id],
    perf: perf[b.id] || null,
    growth: b.prevSales ? (b.sales - b.prevSales) / b.prevSales : (b.sales ? 1 : 0),
  }));
}
// Who to contact, and the fact that says why. One reason per affiliate, the
// most urgent one, so the list stays a list of people rather than of events.
export const OV_REASONS = { quiet: 'Quiet', drop: 'Dropping', never: 'No sales', rise: 'Rising', stuck: 'Stuck' };
const OV_REASON_ORDER = { stuck: 0, drop: 1, quiet: 2, never: 3, rise: 4 };
export const OV_STUCK_DAYS = 7;      // an invite nobody finished
export const OV_SILENT_CODE_DAYS = 14; // a live code that has never sold
export function ovReachOut({ affiliates, codes, performance, perWindow, today, days }) {
  const perf = Object.fromEntries((performance || []).map((x) => [x.affiliate_id, x]));
  const win = Object.fromEntries((perWindow || []).map((b) => [b.id, b]));
  const out = [];
  for (const a of (affiliates || [])) {
    const p = perf[a.id];
    const w = win[a.id];
    if (a.status === 'invited' || a.status === 'pending_terms') {
      const age = a.created_at ? dayDiff(today, String(a.created_at).slice(0, 10)) : 0;
      if (age >= OV_STUCK_DAYS) out.push({ id: a.id, aff: a, kind: 'stuck', rank: age, days: age });
      continue;
    }
    if (a.status !== 'active') continue;
    if (!p?.last_order_day) {
      const code = (codes || []).filter((c) => c.affiliate_id === a.id && c.status === 'active')
        .sort((x, y) => String(x.starts_on).localeCompare(String(y.starts_on)))[0];
      const age = code?.starts_on ? dayDiff(today, code.starts_on) : -1;
      if (age >= OV_SILENT_CODE_DAYS) out.push({ id: a.id, aff: a, kind: 'never', rank: age, days: age, code: code.code });
      continue;
    }
    const silent = dayDiff(today, p.last_order_day);
    if (silent > days) { out.push({ id: a.id, aff: a, kind: 'quiet', rank: silent, days: silent }); continue; }
    if (w && w.prevSales > 0 && w.sales < w.prevSales * 0.6) {
      out.push({ id: a.id, aff: a, kind: 'drop', rank: Math.round((1 - w.sales / w.prevSales) * 100), sales: w.sales, prevSales: w.prevSales });
      continue;
    }
    if (w && w.prevSales > 0 && w.sales >= w.prevSales * 1.5) {
      out.push({ id: a.id, aff: a, kind: 'rise', rank: Math.round(w.growth * 100), sales: w.sales, growth: w.growth });
      continue;
    }
    if (p.first_order_day && dayDiff(today, p.first_order_day) <= 7) {
      out.push({ id: a.id, aff: a, kind: 'rise', rank: 0, firstSale: true });
    }
  }
  return out.sort((x, y) => (OV_REASON_ORDER[x.kind] - OV_REASON_ORDER[y.kind]) || (y.rank - x.rank));
}
// The nudge, as text. SILO sends nothing: this goes on the clipboard and the
// person sends it from their own mailbox, which is the same rule outreach to
// prospects follows.
export function ovMessage(item, { brand, code }) {
  const name = item?.aff?.contact_name || item?.aff?.display_name || 'there';
  const codeLine = code ? ` Your code ${code} is live.` : '';
  const body = {
    quiet: `it has been a while since your last order.${codeLine} Anything you need from us -- new product, fresh photos, a different offer?`,
    drop: `your sales slowed down this month.${codeLine} Tell me what is working and what is not, and I will get you what you need.`,
    never: `your code is live but has not had an order yet.${codeLine} Want help with a first post, or different product to feature?`,
    rise: `your numbers are up and we noticed.${codeLine} Tell me what you would like to feature next and I will send it over.`,
    stuck: 'you have not finished signing up yet. Open the link in your invite, accept the terms, and your code goes live.',
  }[item?.kind] || '';
  return `Hi ${name}, ${body}\n\n-- ${brand}`;
}
