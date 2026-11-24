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
  order_cancelled: { label: 'Not credited: order cancelled', earns: false },
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
// The outreach template, as stored: SILO's own wording is stored as blank, so
// it is never pinned to a copy of itself. Shared by Setup and Comms.
export function templateRow(subject, body) {
  const errors = [];
  const subj = String(subject ?? '').trim();
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  const row = {
    outreach_subject: subj === '' || subj === DEFAULT_OUTREACH.subject ? null : subj,
    outreach_body: text === '' || text === DEFAULT_OUTREACH.body ? null : text,
  };
  if (row.outreach_subject && row.outreach_subject.length > 200) errors.push('Keep the outreach subject under 200 characters.');
  if (row.outreach_body && row.outreach_body.length > 5000) errors.push('Keep the outreach message under 5,000 characters.');
  if (row.outreach_body && !row.outreach_body.includes('{signup_link}')) errors.push('Keep {signup_link} in the outreach message: it is how the creator joins.');
  return { row, errors };
}

// A web address as the database accepts it (affiliate_prospects' *_url CHECKs
// want http(s)://, no spaces). People type "instagram.com/name" or
// "www.site.com", so a bare domain gets https:// in front. Returns null for
// blank and undefined for text that is not an address ("Instagram", "a
// friend"), so the caller decides whether that is an error or a note.
export function asWebUrl(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  const bare = t.replace(/^\/\//, '');
  if (/^[^\s/]+\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(bare)) return `https://${bare}`;
  return undefined;
}

// A person's edit of a creator (Blake, 2026-11-17). An email typed here was
// given or found by a person, so its "where it was stated" link is cleared
// when the email changes. Throws a message a person can act on.
export function prospectEditRow(f, before = {}) {
  const name = String(f.name ?? '').trim();
  const handle = String(f.handle ?? '').trim();
  const url = asWebUrl(f.url);
  const email = String(f.email ?? '').trim().toLowerCase();
  if (!handle && !url && url !== undefined) throw new Error('A handle or a profile URL is needed to tell creators apart.');
  if (url === undefined) throw new Error('The profile URL should be a web address, like instagram.com/name.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address is not valid.');
  const row = { display_name: name || handle || url, platform: String(f.platform || before.platform || 'other'), handle: handle || null, profile_url: url || null, contact_email: email || null };
  if ((email || null) !== (String(before.contact_email || '').toLowerCase() || null)) row.contact_source_url = null;
  return row;
}

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
    discovery_max_cost_usd: f.discovery_max_cost_usd === '' || f.discovery_max_cost_usd === undefined ? 0.5 : Number(f.discovery_max_cost_usd),
    default_code_starts_on: f.default_code_starts_on || null,
    default_code_ends_on: f.default_code_ends_on || null,
    owner_user_id: f.owner_user_id || null,
    terms_markdown: String(f.terms_markdown || '').trim() || null,
  };
  // The payout rail (20261113040000). Sent ONLY when the form carries it: a
  // caller that does not know about the field must not silently reset a
  // program that pays through PayPal back to paying by hand. A new program
  // takes the column default, which is manual.
  if (f.payout_method !== undefined) {
    row.payout_method = f.payout_method === 'paypal_payouts' ? 'paypal_payouts' : 'manual';
  }
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
    const t = templateRow(f.outreach_subject, f.outreach_body);
    Object.assign(row, t.row); errors.push(...t.errors);
  }
  // What a piece of content the brand uses earns (20261117050000). Blank =
  // nothing extra. Only sent when the form carries it.
  if (f.content_bonus !== undefined) {
    const c = parseMajorToMinor(f.content_bonus, currency);
    if (Number.isNaN(c) || (c !== null && (c < 0 || c > 100000000))) errors.push('Content bonus must be a positive amount, or blank for none.');
    else row.content_bonus_cents = c ? c : null;
  }
  // Which stores count (20261117030000). Every store ticked is stored as
  // NULL ("all"), so a store connected later is covered without a visit here.
  if (Array.isArray(f.shop_domains)) {
    const on = f.shop_domains.filter((x) => x && x.on).map((x) => String(x.d || '').toLowerCase());
    if (!on.length) errors.push('Pick at least one store.');
    else if (on.some((x) => !/^[a-z0-9.-]+$/.test(x))) errors.push('Unknown store.');
    row.shop_domains = on.length === f.shop_domains.length ? null : on;
  }
  if (!row.name) errors.push('Give the program a name.');
  if (!SLUG_RE.test(row.slug)) errors.push('The link name must be 3–40 letters, digits or dashes.');
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
  // Written terms or an uploaded agreement PDF (20261119010000) either count.
  if (row.status === 'active' && !row.terms_markdown && !f.has_terms_file) errors.push('Write the program terms or upload an agreement before making it active; affiliates sign it to join.');
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
// The creator import's template: the columns affiliate-research reads, one example row.
export const IMPORT_TEMPLATE = [['name', 'profile_url', 'platform', 'email', 'followers', 'notes'],
  [['Pat Trails', 'https://www.instagram.com/pattrails', 'instagram', 'pat@pattrails.com', '12400', 'Baseball training videos']]];
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
  // YouTube's own subscriber count wins (lib/affiliate-youtube-core.mjs).
  const yf = e.creator_profile?.followers;
  if (yf?.source === 'youtube_api' && Number.isFinite(Number(yf.value))) return { count: Number(yf.value), source_url: yf.source_url || null, as_of: yf.as_of || null, kind: 'youtube' };
  if (!Number.isFinite(Number(e.followers)) || e.followers === null || e.followers === '') return null;
  return { count: Number(e.followers), source_url: e.followers_source_url || null, as_of: e.followers_as_of || null, kind: e.followers_source_kind || null };
}

// The measured numbers in a prospect's structured profile (evidence.creator_profile),
// or null when nothing was measured. Never a zero for "not measured".
export function creatorStats(evidence) {
  const p = evidence?.creator_profile;
  if (!p || typeof p !== 'object') return null;
  const e = p.engagement || null;
  const out = {
    rate: Number.isFinite(Number(e?.rate)) && e?.rate !== null ? Number(e.rate) : null,
    avgViews: Number.isFinite(Number(e?.avg_views)) && e?.avg_views !== null ? Number(e.avg_views) : null,
    sample: e?.sample ?? null,
    topics: Array.isArray(p.topics?.value) ? p.topics.value.slice(0, 4) : [],
    brands: Array.isArray(p.brand_mentions?.domains) ? p.brand_mentions.domains.slice(0, 4).map((d) => d.domain) : [],
    sponsored: p.brand_mentions?.sponsored_videos ?? null,
    others: Array.isArray(p.other_profiles) ? p.other_profiles.slice(0, 4) : [],
    country: p.country?.value || null,
  };
  return out.rate === null && out.avgViews === null && !out.topics.length && !out.brands.length && !out.others.length ? null : out;
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
// The past-customer badge (20261123210000). Blake 2026-11-23: "Without
// muddying up or showing a lot of info on this, we'd give a badge to the
// prospect, showing they have ordered in past". So: one short label, and the
// order count, last order and lifetime spend only on hover.
//
// `customer_lifetime_spend` is a currency AMOUNT (Shopify's order totals), not
// minor units, so it is not formatMoney's input.
export function pastCustomerBadge(p, currency = 'USD') {
  const st = p?.customer_match_status;
  if (!['possible', 'likely', 'confirmed'].includes(st)) return null;
  const n = Number(p.customer_order_count || 0);
  const spend = Number(p.customer_lifetime_spend);
  const bits = [];
  if (n > 0) bits.push(`${n} order${n === 1 ? '' : 's'}`);
  if (p.customer_last_order_at) bits.push(`last ${String(p.customer_last_order_at).slice(0, 10)}`);
  if (Number.isFinite(spend) && spend > 0) {
    const cur = String(currency || 'USD').toUpperCase();
    try {
      bits.push(spend.toLocaleString('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }));
    } catch {
      bits.push(`${Math.round(spend)} ${cur}`);
    }
  }
  if (p.customer_match_basis) bits.push(p.customer_match_basis);
  return {
    label: st === 'possible' ? 'Possible customer' : 'Past customer',
    tone: st === 'possible' ? '' : 'pos',
    title: bits.length ? `${bits.join(' · ')}. Check before you write to them.` : 'Check before you write to them.',
  };
}

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

// Reading a window one page at a time. `fetchPage(i)` returns that page's
// rows, or null if it could not be read. The loop stops at the first short
// page, which is the only proof there is no more; a read that hits the
// ceiling with a FULL last page cannot tell whether history was cut off, so
// it returns null -- "could not read" -- rather than a total that silently
// drops the oldest rows and invents growth out of the gap.
export const OV_PAGE_SIZE = 1000;
export const OV_MAX_PAGES = 60;
export async function pagedCollect(fetchPage, { pageSize = OV_PAGE_SIZE, maxPages = OV_MAX_PAGES } = {}) {
  const rows = [];
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchPage(i);
    if (!Array.isArray(page)) return null;
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  return null;
}

// What is still owed to affiliates: everything the ledger recorded, less what
// a payout has actually been marked PAID for. Deliberately NOT
// `unclaimed_cents`, which the balance view reduces as soon as a DRAFT payout
// claims a ledger line -- money sitting in an unapproved payout is still
// money owed, and reading unclaimed here would show nothing owed the moment
// someone pressed "build payout".
export function ovUnpaid(balances, currency) {
  const cur = CUR(currency);
  return (balances || []).filter((b) => CUR(b.currency) === cur)
    .reduce((n, b) => n + (Number(b.earned_cents || 0) - Number(b.paid_cents || 0)), 0);
}

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

// An image an affiliate will see on a card, not a thumbnail the brand's own
// page asked for. An image CDN that takes a width hint in the address serves
// whatever was asked for, so a 100px thumbnail scaled into a 300px card is
// soft -- ask that CDN for the size the card actually uses. Only a host whose
// width parameter is documented is touched, and only upwards; every other
// address is returned exactly as it came.
const WIDTH_PARAM_HOSTS = new Set(['cdn.shopify.com']);
export function displayImage(url, px = 800) {
  const s = String(url || '');
  if (!/^https:\/\//.test(s)) return url;
  let u;
  try { u = new URL(s); } catch { return url; }
  if (!WIDTH_PARAM_HOSTS.has(u.hostname)) return url;
  const w = Number(u.searchParams.get('width'));
  if (!Number.isFinite(w) || w <= 0 || w >= px) return url;
  u.searchParams.set('width', String(px));
  u.searchParams.delete('height');
  return u.toString();
}

// The code to offer an affiliate who has none, so giving one out is a press
// rather than a typing exercise. Letters and digits of their own name, so the
// person they send it to can see whose it is, then the discount. A name with
// nothing usable in it (an emoji handle, a non-Latin script) falls back to
// AFF, and a code already in use takes the next free suffix -- the database
// still has the last word, since (program_id, code) is unique there.
export function suggestCode(name, percent, taken = []) {
  // The creator's handle or whole name plus the percent (BLAKETESTINGS10), as
  // affiliate_suggest_code does (20261117200000); a taken text gets a letter.
  const used = new Set((taken || []).map((c) => String(c || '').toUpperCase()));
  const stem = String(name || '').replace(/^@/, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
  const pct = Number(percent);
  const base = `${stem.length >= 2 ? stem : 'PARTNER'}${Number.isFinite(pct) && pct > 0 ? Math.round(pct) : ''}`;
  if (!used.has(base)) return base;
  for (const l of 'BCDEFGHJKLMNPQRSTUVWXYZ') if (!used.has(base + l)) return base + l;
  return `${base}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

// Product seeding (20261113093000): one claim -> what both the rep and the
// brand see. pct is null until there is a goal (no purchase yet), never 0.
export const SEED_LABEL = {
  requested: 'Waiting for the brand', approved: 'Code on its way', code_ready: 'Code ready',
  purchased: 'Bought', earned: 'Paid back', expired: 'Time ran out', declined: 'Declined', cancelled: 'Cancelled',
};
export const SEED_TONE = { requested: 'accent', approved: 'accent', code_ready: 'pos', purchased: '', earned: 'pos', expired: '', declined: 'neg', cancelled: '' };
export function seedView(c = {}) {
  const goal = Number(c.goal_cents ?? c.goal);
  const prog = Number(c.progress_cents ?? 0) || 0;
  const hasGoal = Number.isFinite(goal) && goal > 0;
  return {
    label: SEED_LABEL[c.state] || String(c.state || ''),
    tone: SEED_TONE[c.state] ?? '',
    open: ['requested', 'approved', 'code_ready', 'purchased'].includes(c.state),
    pct: c.state === 'earned' ? 100 : (hasGoal ? Math.max(0, Math.min(100, Math.round(prog / goal * 100))) : null),
  };
}

// ── Your Customers ────────────────────────────────────────────────────────
// Blake, 2026-11-24: "if the data is there, literally what are we waiting
// for ha?" -- the repeat buyers to recruit from, as a sub-tab under People
// rather than a report of its own, built on `company_customer_profiles`
// (one row per customer PER COMPANY, so a person who bought in two stores is
// one person here).
//
// CONSENT IS A FILTER, NEVER A GATE. Blake's own framing: "that is a tough
// barrier, we should use as filtering segment tactic, not barrier." The
// default is `any` and NO consent predicate is applied at all, because this
// is one-to-one recruiting, not a marketing send. The one value that is a
// decision rather than a filter is `unmeasured`, which means "SILO has not
// looked yet" -- the store may lack the read_customers scope, or the customer
// walk may not have reached that person. It is NOT unsubscribed, and reading
// it that way would invent an opt-out for hundreds of thousands of people.
//
// RANKING (Blake asked, 2026-11-24, "what is our ranking? is it configurable
// by brand?"): most orders, then highest lifetime spend, then most recent
// order. No blended score -- a weighted number nobody can explain is worse
// than two columns you can read, and the follower counts that would justify
// one do not exist until the social scan runs. Every sort is a named ordering
// here, so the column headers can re-rank without inventing arithmetic.
export const CUSTOMER_PAGE_SIZE = 100;
export const CUSTOMER_CONSENTS = ['any', 'subscribed', 'not_subscribed', 'unsubscribed', 'pending', 'unmeasured'];
export const CUSTOMER_MIN_ORDERS_MAX = 50;
// Each entry is the full tie-break chain, so two customers with the same
// order count never come back in storage order (which changes under paging
// and makes a row appear on two pages).
export const CUSTOMER_SORTS = {
  orders: [['order_count', false], ['lifetime_spend', false], ['last_order_at', false], ['customer_key', true]],
  spend: [['lifetime_spend', false], ['order_count', false], ['last_order_at', false], ['customer_key', true]],
  recent: [['last_order_at', false], ['order_count', false], ['lifetime_spend', false], ['customer_key', true]],
  oldest: [['first_order_at', true], ['order_count', false], ['customer_key', true]],
  name: [['name_lc', true], ['customer_key', true]],
};
export const CUSTOMER_SORT_DEFAULT = 'orders';
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The one filter spec every read of this tab goes through: what the database
// is asked, derived from what the person picked, with every value clamped
// here rather than at the call site.
export function customerQuerySpec(f = {}) {
  const sort = Object.prototype.hasOwnProperty.call(CUSTOMER_SORTS, f.sort) ? f.sort : CUSTOMER_SORT_DEFAULT;
  const minRaw = Number(f.minOrders);
  const minOrders = Number.isFinite(minRaw)
    ? Math.max(1, Math.min(CUSTOMER_MIN_ORDERS_MAX, Math.trunc(minRaw)))
    : 1;
  const consent = CUSTOMER_CONSENTS.includes(f.consent) ? f.consent : 'any';
  const from = ISO_DAY_RE.test(f.from) ? f.from : null;
  const to = ISO_DAY_RE.test(f.to) ? f.to : null;
  const page = Number.isFinite(Number(f.page)) ? Math.max(0, Math.trunc(Number(f.page))) : 0;
  const size = CUSTOMER_PAGE_SIZE;
  return {
    sort,
    minOrders,
    consent,
    from,
    // The window is on the customer's LAST order, and the end is EXCLUSIVE of
    // the next day: `last_order_at` is a timestamp, so `lte` the chosen day
    // would drop everyone who ordered that day after midnight.
    toExclusive: to ? dayShift(to, -1) : null,
    // `any` applies no predicate at all; `unmeasured` is an IS NULL, not a
    // state comparison, and the two must never collapse into one branch.
    consentIsNull: consent === 'unmeasured',
    consentState: consent === 'any' || consent === 'unmeasured' ? null : consent,
    order: CUSTOMER_SORTS[sort].map(([column, ascending]) => ({ column, ascending })),
    range: [page * size, page * size + size - 1],
    page,
    size,
  };
}

// What the tab says a customer's consent is. A blank state is the measured-
// nothing-yet case and says so; it is never shown as unsubscribed.
export function customerConsentView(state) {
  if (state === null || state === undefined || state === '') {
    return { label: 'not checked yet', tone: '', measured: false };
  }
  const tone = state === 'subscribed' ? 'pos' : state === 'unsubscribed' ? 'neg' : '';
  return { label: String(state).replace(/_/g, ' '), tone, measured: true };
}

// Outreach to an existing CUSTOMER, not a creator found on the web. The
// creator template opens "We found your {platform} through {source}", which
// read by somebody who has bought from you nine times is worse than silence.
// Same tokens, same per-brand editing, its own default (20261124030000).
export const DEFAULT_CUSTOMER_OUTREACH = {
  subject: 'Would you want to partner with {brand}?',
  body: 'Hi {name},\n\nYou have shopped with us{orders_line}, so you already know {brand} better than most people we talk to. We run an affiliate program and we would rather have customers in it than strangers: {commission}.\n\nIf you are up for it, this link has the terms and lets you join: {signup_link}\n\nNot interested? Just reply and say so and we will leave it there.\n\n{sender}',
};
// The same rule as outreachTemplate: a body with no {signup_link} is not
// usable, so the default stands in rather than sending a message nobody can
// act on.
export function customerOutreachTemplate(program) {
  const subject = typeof program?.customer_outreach_subject === 'string' && program.customer_outreach_subject.trim()
    ? program.customer_outreach_subject : DEFAULT_CUSTOMER_OUTREACH.subject;
  const body = typeof program?.customer_outreach_body === 'string' && program.customer_outreach_body.includes('{signup_link}')
    ? program.customer_outreach_body : DEFAULT_CUSTOMER_OUTREACH.body;
  return { subject, body };
}

// Do-not-contact, read the way the database reads it. Blake 2026-11-24: "skip
// do not contacts yes as they don't want contact." This is the convenience
// pass so a suppressed customer never appears on a list to be picked; the
// database is still the boundary (affiliate_outreach_can_contact() and the
// trigger that refuses to approve such a draft).
//
// `email` and `domain` are the two kinds that can match an email address, and
// they are normalised exactly as affiliate_normalize_contact does: an email
// lowercased and trimmed, a domain also stripped of scheme and www.
export function customerSuppressed(email, suppressions = []) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const at = e.lastIndexOf('@');
  const domain = at > 0 ? e.slice(at + 1) : '';
  for (const s of suppressions || []) {
    const v = String(s?.value_normalized || '').trim().toLowerCase();
    if (!v) continue;
    if (s.kind === 'email' && v === e) return true;
    if (s.kind === 'domain' && domain) {
      const d = v.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/+$/, '');
      // A suppressed domain covers its subdomains, which is how a company
      // that asked not to be contacted stops being contacted at mail.x.com.
      if (d && (domain === d || domain.endsWith(`.${d}`))) return true;
    }
  }
  return false;
}

// What a picked customer becomes: an ordinary prospect row. `platform` is
// 'other' because they have no channel yet -- finding one is the social
// scan's job, and claiming 'web' would say we looked.
//
// The order facts go in `evidence`, which is what the rest of the studio
// already reads for provenance, so the row explains itself on screen without
// any new column.
export function customerProspectRow({ customer, social = null, collectedAt = new Date().toISOString() }) {
  const c = customer || {};
  const email = String(c.email_lc || '').trim().toLowerCase();
  const orders = Number(c.order_count);
  const spend = Number(c.lifetime_spend);
  return {
    source: 'customer',
    // Lined up for outreach, which is what 'approved' means here (it is not a
    // decision about the person; see PROSPECT_LABEL).
    status: 'approved',
    platform: 'other',
    display_name: customerDisplayName(c) || email || null,
    contact_email: email || null,
    handle: null,
    profile_url: null,
    collected_at: collectedAt,
    evidence: {
      found_via: 'your own customers',
      note: customerEvidenceNote(c),
      customer_key: c.customer_key || null,
      order_count: Number.isFinite(orders) ? orders : null,
      lifetime_spend: Number.isFinite(spend) ? spend : null,
      first_order_at: c.first_order_at || null,
      last_order_at: c.last_order_at || null,
      // Carried so a reader can see it was a filter, never a gate, and so a
      // blank stays blank rather than becoming "not subscribed".
      email_consent_state: c.email_consent_state ?? null,
      // What "Find their social accounts" found, carried as evidence only.
      // Never the prospect's own profile_url: that column feeds the identity
      // index, and the same profile already on the list from Discovery would
      // refuse this customer's row outright.
      ...(customerSocialEvidence(social) ? { social: customerSocialEvidence(social) } : {}),
    },
  };
}

// ── Find their social accounts ──────────────────────────────────────────
// A result row is evidence only when it names a profile; 'ambiguous', 'none'
// and the rest carry nothing a reader could act on.
export const SOCIAL_KEPT = ['found', 'below', 'no_count'];
// Why a profile is believed to be the customer (match_basis), and what the
// page calls it. Anything unknown reads as a name match: never promoted.
export const SOCIAL_BASIS = {
  email_handle: { trust: 'likely', pill: 'Likely', why: 'The handle matches their email name' },
  city: { trust: 'likely', pill: 'Likely', why: 'Their city appears on the profile' },
  name_only: { trust: 'name', pill: 'Name match', why: 'Only the name matches. Check it is them' },
};
export function customerSocialEvidence(s) {
  if (!s || !SOCIAL_KEPT.includes(s.status) || !s.profile_url) return null;
  return {
    status: s.status,
    platform: s.platform || null,
    handle: s.handle || null,
    profile_url: s.profile_url,
    // NULL is "no result stated a count", never zero.
    followers: Number.isFinite(Number(s.followers)) && s.followers !== null ? Number(s.followers) : null,
    followers_quote: s.followers_quote || null,
    match_basis: SOCIAL_BASIS[s.match_basis] ? s.match_basis : 'name_only',
    source_url: s.source_url || null,
    checked_at: s.checked_at || null,
  };
}
export function compactCount(n) {
  const v = Number(n);
  if (n === null || n === undefined || !Number.isFinite(v)) return '';
  if (v >= 1e6) return `${(Math.floor(v / 1e5) / 10).toString()}M`;
  if (v >= 1e4) return `${Math.floor(v / 1e3)}K`;
  if (v >= 1e3) return `${(Math.floor(v / 100) / 10).toString()}K`;
  return String(Math.floor(v));
}
// What the Social column says for one customer. `row` is their
// affiliate_customer_social row for this program, or undefined if never
// scanned. Only http(s) links are ever handed back as `url`.
export function customerSocialView(row) {
  if (!row) return { label: '—', tone: 'muted', url: null, scanned: false };
  const url = /^https?:\/\//i.test(String(row.profile_url || '')) ? row.profile_url : null;
  const who = row.handle || (url ? url.replace(/^https?:\/\/(www\.)?/i, '') : '');
  const count = row.followers === null || row.followers === undefined ? '' : `${compactCount(row.followers)}${row.followers_approx ? '+' : ''}`;
  // How far to trust it (Blake, 2026-11-24). Only a second signal makes a
  // find "Likely"; a name alone is what a namesake has too, so it says so.
  const basis = SOCIAL_BASIS[row.match_basis] || SOCIAL_BASIS.name_only;
  const tier = { trust: basis.trust, why: basis.why, rejectable: true };
  switch (row.status) {
    case 'found': return { label: `${who} · ${count}`, tone: basis.trust === 'likely' ? 'pos' : 'warn', url, scanned: true, quote: row.followers_quote || '', ...tier };
    case 'below': return { label: `${who} · ${count}`, tone: 'muted', url, scanned: true, quote: row.followers_quote || '', note: 'under your bar', ...tier };
    case 'no_count': return { label: `${who} · count not shown`, tone: 'muted', url, scanned: true, ...tier };
    case 'rejected': return { label: 'Not them', tone: 'muted', url: null, scanned: true };
    case 'ambiguous': return { label: 'Several possible', tone: 'muted', url: null, scanned: true };
    case 'none': return { label: 'None found', tone: 'muted', url: null, scanned: true };
    case 'pending': return { label: 'Queued', tone: 'muted', url: null, scanned: false };
    case 'error': return { label: 'Not checked', tone: 'muted', url: null, scanned: false };
    default: return { label: '—', tone: 'muted', url: null, scanned: false };
  }
}
// The progress line. Live counts only: never a cost, a spend or a budget
// (Blake 2026-11-24).
export function customerScanLine(scan) {
  if (!scan) return '';
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const found = Number(scan.found || 0);
  const tail = `${n(scan.checked)} of ${n(scan.requested)} checked · ${n(found)} found`;
  if (scan.status === 'running') return Number(scan.requested || 0) ? `Scanning… ${tail}` : 'Scanning… lining up customers';
  if (scan.status === 'stopped') return `Last scan: ${tail}. Stopped early, more to check.`;
  if (scan.status === 'error') return `Last scan: ${tail}. It hit a problem, more to check.`;
  return `Last scan: ${tail}.`;
}
// The Hunt's own lines (Blake 2026-11-24: "Find 25" means 25 finds come
// back). Progress counts finds against what was asked; a finished hunt says
// plainly why it ended. Never a cost.
export function huntProgress(scan) {
  const n0 = (v) => Number(v || 0);
  const want = n0(scan?.filters?.want);
  const found = n0(scan?.found);
  const checked = n0(scan?.checked);
  // A scan from before "Find N" has no goal: its progress is customers checked.
  const pct = want ? Math.min(100, Math.round((found / want) * 100))
    : n0(scan?.requested) ? Math.min(100, Math.round((checked / n0(scan.requested)) * 100)) : 0;
  return { want, found, checked, pct };
}
export function huntLine(scan) {
  if (!scan) return '';
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const { want, found, checked } = huntProgress(scan);
  if (scan.status === 'running') return want ? `Found ${n(found)} of ${n(want)} · ${n(checked)} checked` : `${n(checked)} checked · ${n(found)} found`;
  const end = scan.filters?.end;
  if (end === 'goal') return `Last search: found ${n(found)} · ${n(checked)} checked.`;
  if (end === 'pool') return `Last search checked everyone in this slice: ${n(found)} found of ${n(want)} asked for. Widen the dates or lower the minimum orders to find more.`;
  if (end === 'cap') return `Last search checked ${n(checked)}, the most one search checks: ${n(found)} found. Press Find to keep going.`;
  return customerScanLine(scan);
}
// name_lc is stored lowercased; it needs casing back before a person reads it.
export function customerDisplayName(c) {
  return String(c?.name_lc || '').replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1)).trim();
}
export function customerEvidenceNote(c) {
  const orders = Number(c?.order_count);
  const bits = [];
  if (Number.isFinite(orders) && orders > 0) bits.push(`${orders} order${orders === 1 ? '' : 's'}`);
  if (c?.last_order_at) bits.push(`last ${String(c.last_order_at).slice(0, 10)}`);
  return bits.length ? `Your customer: ${bits.join(', ')}.` : 'Your customer.';
}
// "{orders_line}" in the customer template: " nine times" reads as a brag, so
// it is a plain count, and it is EMPTY when the count is unknown rather than
// filling in a guess.
export function customerOrdersLine(c) {
  const orders = Number(c?.order_count);
  if (!Number.isFinite(orders) || orders < 1) return '';
  return orders === 1 ? ' once' : ` ${orders} times`;
}

// The customer template's own save, with the same rules as templateRow: a
// value equal to SILO's default is stored as NULL so the program follows the
// default rather than pinning a copy of it, and a body with no {signup_link}
// is refused rather than saved unusable.
export function customerTemplateRow(subject, body) {
  const errors = [];
  const subj = String(subject ?? '').trim();
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  const row = {
    customer_outreach_subject: subj === '' || subj === DEFAULT_CUSTOMER_OUTREACH.subject ? null : subj,
    customer_outreach_body: text === '' || text === DEFAULT_CUSTOMER_OUTREACH.body ? null : text,
  };
  if (row.customer_outreach_subject && row.customer_outreach_subject.length > 200) errors.push('Keep the customer subject under 200 characters.');
  if (row.customer_outreach_body && row.customer_outreach_body.length > 5000) errors.push('Keep the customer message under 5,000 characters.');
  if (row.customer_outreach_body && !row.customer_outreach_body.includes('{signup_link}')) errors.push('Keep {signup_link} in the customer message: it is how they join.');
  return { row, errors };
}
