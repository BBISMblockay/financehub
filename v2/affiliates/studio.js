// Affiliate Studio staff page. Every read is the caller's own session under
// RLS; every write is either a plain row write the policies allow, or one of
// the gated SECURITY DEFINER functions, which re-check the caller. Nothing in
// this file is a permission: hiding a button is convenience, the database
// decides. Pure logic (money, CSV, validation, labels) is in studio-core.js.
import {
  formatMoney, minorUnits, parseMajorToMinor, describeCommission, basisLabel, BASIS_LABELS, validateProgram, slugify,
  toCsv, fillTemplate, DEFAULT_OUTREACH, OUTREACH_HEADER, outreachRows, sha256Hex, PAYOUT_HEADER, payoutRows,
  linkUrl, affiliateLink, storeLinkFor, applyUrl, stageLabels, safeHref, SEARCH_COUNTRIES, SEARCH_LANGUAGES, countryName, languageName, friendlySearchError,
  parseCsv, chunk, runKindLabel, followersFrom, sourceLabel,
} from './studio-core.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
const fmtTime = (s) => (s ? new Date(s).toLocaleString() : '—');
// A link to a stored URL, or the text alone when the URL is not http(s).
const ext = (u, label) => { const h = safeHref(u); return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label); };
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));

function setStatus(msg, type = 'info', ms = 0) {
  const el = $('status');
  el.className = `bcn-status bcn-status--${type}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(setStatus.t);
  if (ms) setStatus.t = setTimeout(() => { el.hidden = true; }, ms);
}

const cfg = window.__SILO_CONFIG__ || {};
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  setStatus('Missing Supabase config — check pages/config.js', 'neg');
  throw new Error('missing config');
}
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const { data: { session } } = await db.auth.getSession();
if (!session) {
  location.href = '/pages/login.html?next=' + encodeURIComponent('/v2/affiliates/index.html');
  throw new Error('no session');
}
const me = session.user;
const co = (await cfg.ensureActiveCompany?.(db)) || null;

const { data: myProfile } = await db.from('profiles').select('role').eq('id', me.id).maybeSingle();
window.SiloChrome?.mount({
  appEl: '#silo-app', active: 'marketing/affiliates',
  user: { email: me.email || '', role: myProfile?.role ? String(myProfile.role) : 'user' },
  crumbs: ['Marketing', 'Affiliate Studio'], supabaseClient: db,
});

if (!co?.id) {
  setStatus('Pick a company first: Affiliate Studio works on one company at a time.', 'neg');
  throw new Error('no company');
}
const CO = co.id;

const [{ data: canManage }, { data: canApprove }] = await Promise.all([
  db.rpc('can_manage_affiliate_programs'), db.rpc('can_approve_affiliate_commissions'),
]);
const MANAGE = canManage === true;
const MONEY = canApprove === true;
if (!MANAGE) setStatus('You can view Affiliate Studio. Changing it needs Affiliate Studio access (an owner or executive can grant it on the Program tab).', 'info');

// ── Errors and writes ────────────────────────────────────────────────────
function friendly(err) {
  const m = String(err?.message || err || 'Something went wrong');
  if (err?.code === '42501' || /not permitted|permission denied|row-level security/i.test(m)) return 'You do not have permission for that. ' + m.replace(/^[a-z_]+: /, '');
  if (err?.code === '23505' || /duplicate key|unique/i.test(m)) return 'That already exists. ' + (err?.details || '');
  return m.replace(/^[a-z_]+: /, '');
}
const must = ({ data, error }) => { if (error) throw error; return data; };
// An RLS-refused UPDATE succeeds with zero rows; that is a refusal, by name.
async function updateRows(table, patch, match) {
  let q = db.from(table).update(patch);
  for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
  const rows = must(await q.eq('company_entity_id', CO).select('id'));
  if (!rows?.length) throw new Error('Nothing was changed: the row was not found, or you do not have permission to change it.');
  return rows;
}
// AI research runs in the background; the page watches its run row.
const RESEARCH_STALE_MS = 10 * 60_000;
function researchSummary(r) {
  if (r.status !== 'ok') return `Research did not finish. ${friendlySearchError(r.error)}`;
  if (!r.prospects_new && !r.prospects_updated) return 'Research finished. No creators could be confirmed this time. Try a different focus.';
  return `Research finished: ${num(r.prospects_new || 0)} new creator(s)${r.prospects_updated ? `, ${num(r.prospects_updated)} refreshed` : ''}.`;
}
function watchResearch(runId) {
  S.watching = runId;
  const until = Date.now() + RESEARCH_STALE_MS;
  const tick = async () => {
    if (S.watching !== runId) return;
    const { data } = await db.from('affiliate_discovery_runs').select('status, prospects_new, prospects_updated, error')
      .eq('id', runId).eq('company_entity_id', CO).maybeSingle();
    if (data && data.status !== 'running') {
      S.watching = null;
      await reload();
      setStatus(researchSummary(data), data.status === 'ok' ? 'pos' : 'neg', 10000);
      return;
    }
    if (Date.now() > until) { S.watching = null; setStatus('Research is still running. Reload the page in a few minutes to see what it found.', 'info', 10000); return; }
    setTimeout(tick, 15000);
  };
  setTimeout(tick, 15000);
}

async function invoke(fn, body) {
  const { data: { session: s } } = await db.auth.getSession();
  const res = await fetch(`${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${s?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `The ${fn} service answered ${res.status}. It may not be deployed yet.`);
  return out;
}
function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── State ────────────────────────────────────────────────────────────────
const S = { programs: [], programId: null, tab: 'prospects', profiles: [], brand: '' };
const prog = () => S.programs.find((p) => p.id === S.programId) || null;

async function loadPrograms() {
  S.programs = must(await db.from('affiliate_programs').select('*').eq('company_entity_id', CO).order('created_at'));
  const qp = new URLSearchParams(location.search).get('program');
  if (!S.programs.some((p) => p.id === S.programId)) S.programId = (S.programs.find((p) => p.id === qp) || S.programs[0])?.id || null;
  $('programSel').innerHTML = S.programs.length
    ? S.programs.map((p) => `<option value="${p.id}"${p.id === S.programId ? ' selected' : ''}>${esc(p.name)} · ${esc(p.status)}</option>`).join('')
    : '<option value="">No programs yet</option>';
  $('btnNewProgram').hidden = !MANAGE;
}

async function loadProgramData() {
  const p = prog();
  if (!p) { S.d = null; return; }
  const by = (t, cols = '*') => db.from(t).select(cols).eq('company_entity_id', CO).eq('program_id', p.id);
  const q = {
    health: db.from('affiliate_program_health_v').select('*').eq('company_entity_id', CO).eq('program_id', p.id).maybeSingle(),
    sources: by('affiliate_prospect_sources').order('created_at'),
    runs: by('affiliate_discovery_runs').order('started_at', { ascending: false }).limit(25),
    prospects: by('affiliate_prospects').order('collected_at', { ascending: false }).limit(500),
    suppressions: db.from('affiliate_suppressions').select('*').eq('company_entity_id', CO).order('created_at', { ascending: false }).limit(500),
    drafts: by('affiliate_outreach_drafts').order('created_at', { ascending: false }).limit(500),
    batches: by('affiliate_outreach_batches').order('created_at', { ascending: false }).limit(50),
    affiliates: by('affiliates').order('created_at'),
    codes: by('affiliate_codes').order('starts_on', { ascending: false }),
    links: by('affiliate_links').order('starts_on', { ascending: false }),
    attributions: by('affiliate_attributions').order('order_day', { ascending: false }).limit(300),
    performance: by('affiliate_performance_v'),
    periods: by('affiliate_commission_periods').order('period_start', { ascending: false }),
    ledger: by('affiliate_commission_ledger').order('created_at', { ascending: false }).limit(300),
    ledgerCount: db.from('affiliate_commission_ledger').select('id', { count: 'exact', head: true }).eq('company_entity_id', CO).eq('program_id', p.id),
    balances: by('affiliate_balances_v'),
    periodTotals: by('affiliate_period_totals_v'),
    payouts: by('affiliate_payouts').order('created_at', { ascending: false }).limit(200),
    notifications: by('affiliate_notifications').order('created_at', { ascending: false }).limit(50),
    feed: by('affiliate_feed_items').order('shared_at', { ascending: false }).limit(200),
  };
  const keys = Object.keys(q);
  const res = await Promise.all(Object.values(q));
  const d = {}; const failed = [];
  res.forEach((r, i) => { d[keys[i]] = r.data ?? (keys[i] === 'health' ? null : []); if (r.error) failed.push(`${keys[i]}: ${r.error.message}`); });
  d.ledgerCount = res[keys.indexOf('ledgerCount')].count ?? 0;
  const ids = d.payouts.map((x) => x.id);
  if (ids.length) {
    const items = (await db.from('affiliate_payout_items').select('payout_id').eq('company_entity_id', CO).in('payout_id', ids)).data || [];
    const n = {}; items.forEach((i) => { n[i.payout_id] = (n[i.payout_id] || 0) + 1; });
    d.payouts.forEach((x) => { x.item_count = n[x.id] || 0; });
  }
  d.affById = Object.fromEntries(d.affiliates.map((a) => [a.id, a]));
  d.prospectById = Object.fromEntries(d.prospects.map((x) => [x.id, x]));
  d.aiApps = await loadAiApps();
  d.stores = await loadStores();
  S.d = d;
  // A research run started earlier (another tab, a reload) is still watched.
  const live = d.runs?.find((r) => r.provider === 'anthropic' && r.status === 'running' && Date.now() - new Date(r.started_at).getTime() < RESEARCH_STALE_MS);
  if (live && S.watching !== live.id) watchResearch(live.id);
  if (failed.length) setStatus(`Some data did not load (has the Affiliate Studio migration been applied?): ${failed.slice(0, 3).join('; ')}`, 'neg');
}

// Your own AI connections to THIS company, for the Messages tab. A connection
// covers only the company it was approved in, so this is what tells you
// whether "send my approved affiliate messages" will find anything. Read
// fail-soft: null means "could not tell", never "none".
async function loadAiApps() {
  try {
    const { data, error } = await db.from('silo_api_grants')
      .select('id, client_id, scopes, expires_at, revoked_at')
      .eq('user_id', me.id).eq('company_entity_id', CO);
    if (error || !Array.isArray(data)) return null;
    const live = data.filter((g) => !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > new Date()));
    const names = {};
    if (live.length) {
      try {
        const r = await db.rpc('silo_api_connection_labels', { p_grant_ids: live.map((g) => g.id) });
        (Array.isArray(r.data) ? r.data : []).forEach((x) => { if (x.client_name) names[x.grant_id] = x.client_name; });
      } catch (_) { /* a missing name is cosmetic */ }
    }
    return live.map((g) => ({ name: names[g.id] || 'AI app', canSend: (g.scopes || []).includes('outreach:send'),
      canCode: (g.scopes || []).includes('codes:create') }));
  } catch (_) { return null; }
}

// The company's active Shopify stores, to say where links open when the
// program has no store address. Fail-soft: unreadable means "unknown".
async function loadStores() {
  try {
    const { data, error } = await db.from('shopify_connections').select('shop_domain, is_active').eq('company_entity_id', CO);
    if (error || !Array.isArray(data)) return null;
    return data.filter((x) => x.is_active !== false && /^[A-Za-z0-9.-]+$/.test(x.shop_domain || '')).map((x) => x.shop_domain.toLowerCase());
  } catch (_) { return null; }
}
// Where this program's affiliate links open: the same rule as the database's
// affiliate_program_store_url -- the store address, else the only Shopify store.
function storeOf(p) {
  if (p?.store_url) return p.store_url;
  const st = S.d?.stores;
  return Array.isArray(st) && st.length === 1 ? `https://${st[0]}` : null;
}
const needsStore = (p) => !p?.store_url && !(Array.isArray(S.d?.stores) && S.d.stores.length === 1);
// The code an affiliate's links apply today: an active one in its window.
function liveCodeOf(affId) {
  const t = today();
  return S.d.codes.find((c) => c.affiliate_id === affId && c.status === 'active' && c.starts_on <= t && (!c.ends_on || c.ends_on >= t))?.code || null;
}

async function reload() {
  await loadPrograms();
  await loadProgramData();
  render();
}

// ── Rendering helpers ────────────────────────────────────────────────────
const card = (title, body, meta = '') => `<div class="bcn-card"><div class="bcn-card-header"><h2>${esc(title)}</h2>${meta ? `<span class="bcn-card-meta">${meta}</span>` : ''}</div><div class="bcn-card-body">${body}</div></div>`;
const empty = (t) => `<div class="bcn-empty">${esc(t)}</div>`;
function table(cols, rows, emptyText = 'Nothing here yet.') {
  if (!rows.length) return empty(emptyText);
  return `<div class="af-scroll"><table class="bcn-table"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="af-num"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="af-num"' : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const btn = (label, act, data = {}, kind = 'ghost', opts = {}) => `<button class="bcn-btn bcn-btn--${kind}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}${opts.confirm ? ' data-confirm="1"' : ''}${opts.disabled ? ' disabled' : ''}>${esc(label)}</button>`;
const field = (label, inner) => `<div class="bcn-field-group"><label class="bcn-label">${esc(label)}</label>${inner}</div>`;
const input = (id, attrs = '') => `<input class="bcn-field" id="${id}" ${attrs} />`;
const pill = (t, kind = '') => `<span class="bcn-pill${kind ? ` bcn-pill--${kind}` : ''}">${esc(t)}</span>`;
const statusPill = (s) => pill(s, ({ active: 'pos', approved: 'pos', signed_up: 'pos', marked_paid: 'pos', sent: 'accent', exported: 'accent', invited: 'accent', qualified: 'accent', under_review: 'accent', rejected: 'neg', suppressed: 'neg', terminated: 'neg', void: 'neg', bounced: 'neg', declined: 'neg' })[s] || '');
// Secondary tools stay one click away, closed by default, so each tab shows
// only what most people need.
const more = (label, parts) => { const p = parts.filter(Boolean); return p.length ? `<details class="af-more"><summary>${esc(label)}</summary><div class="af-stack">${p.join('')}</div></details>` : ''; };
const val = (id) => ($(id)?.value ?? '').trim();
const today = () => new Date().toISOString().slice(0, 10);
const money = (c) => formatMoney(c, prog()?.currency);

function render() {
  const p = prog();
  for (const s of document.querySelectorAll('[data-panel]')) s.hidden = s.dataset.panel !== S.tab;
  for (const b of document.querySelectorAll('#tabs [data-tab]')) {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('bcn-tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  renderKpis();
  renderNextStep();
  if (!p && S.tab !== 'program') {
    $(`${S.tab}Body`).innerHTML = card('Start here', `<p>No affiliate program exists for this company yet.</p>${MANAGE ? btn('Create a program', 'new-program', {}, 'primary') : '<p class="af-muted">Ask someone with Affiliate Studio access to create one.</p>'}`);
    return;
  }
  ({ program: renderProgram, prospects: renderProspects, outreach: renderOutreach, affiliates: renderAffiliates, share: renderShare, payouts: () => { renderPayouts(); renderCommissions(); } })[S.tab]();
}

function renderKpis() {
  const h = S.d?.health;
  const k = (label, v) => `<div class="bcn-kpi"><div class="bcn-kpi-label">${esc(label)}</div><div class="bcn-kpi-value">${v}</div></div>`;
  const bal = (S.d?.balances || []).filter((b) => b.currency === prog()?.currency);
  const sum = (f) => bal.reduce((a, b) => a + Number(b[f] || 0), 0);
  $('kpis').innerHTML = h ? [
    k('Creators to review', num(h.prospects_new)), k('Active affiliates', num(h.affiliates_active)),
    k('Credited orders', num(h.attributions_earning)), k('Unpaid earned', bal.length ? money(sum('earned_cents') - sum('paid_cents')) : '—'),
  ].join('') : k('Programs', num(S.programs.length));
}

// ── Next step ────────────────────────────────────────────────────────────
// One line under the header: the most useful thing to do now.
function nextSteps() {
  const d = S.d; const p = prog(); if (!d || !p) return [];
  const h = d.health || {};
  const steps = [];
  if (p.status !== 'active') steps.push({ text: `The program is ${p.status}. Set it to active in Settings to start finding and recruiting creators.`, tab: 'program' });
  if (!p.terms_markdown) steps.push({ text: 'Write your program terms in Settings. Affiliates accept them to join.', tab: 'program' });
  if (h.prospects_new) steps.push({ text: `${num(h.prospects_new)} creator(s) waiting for your review.`, tab: 'prospects' });
  if (h.outreach_approved) steps.push({ text: `${num(h.outreach_approved)} approved message(s) ready for your AI to send.`, tab: 'outreach' });
  if (h.outreach_exported) steps.push({ text: `${num(h.outreach_exported)} sent message(s) to mark as sent.`, tab: 'outreach' });
  if (h.codes_never_seen) steps.push({ text: `${num(h.codes_never_seen)} code(s) have never appeared on an order. Check each exists in Shopify with the same spelling.`, tab: 'affiliates' });
  const unattributed = (h.attributions_ambiguous || 0) + (h.attributions_multi_code_refused || 0) + (h.attributions_outside_window || 0) + (h.attributions_currency_mismatch || 0) + (h.attributions_refunds_unmeasured || 0);
  if (unattributed) steps.push({ text: `${num(unattributed)} order(s) with an affiliate code were not credited. Payouts → More shows why.`, tab: 'payouts' });
  if (!steps.length && !d.prospects.length) steps.push({ text: 'Find your first creators: describe who you want and press Find creators.', tab: 'prospects' });
  return steps;
}
function renderNextStep() {
  const el = $('nextStep'); if (!el) return;
  const steps = nextSteps();
  el.hidden = !steps.length;
  if (!steps.length) return;
  const [first] = steps;
  el.innerHTML = `<strong>Next:</strong> ${esc(first.text)}${first.tab !== S.tab ? ` <button class="bcn-btn bcn-btn--ghost" data-act="go-tab" data-t="${first.tab}">Go</button>` : ''}${steps.length > 1 ? `<details class="af-more"><summary>+${steps.length - 1} more</summary><ul>${steps.slice(1).map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></details>` : ''}`;
}
function stageCard() {
  const d = S.d;
  const labels = stageLabels({ discoveryRuns: d.runs, notifications: d.notifications, codesSeen: d.codes.filter((c) => c.verified_at).length, ledgerEntries: d.ledgerCount, sources: d.sources.length });
  return card('How each part works for this company', table([
    { h: 'Part', f: (r) => `<strong>${esc(r.stage)}</strong>` },
    { h: 'Status', f: (r) => `<span class="af-stage af-label-${esc(r.label.replace(' ', '-'))}">${esc(r.label)}</span>` },
    { h: 'What that means', f: (r) => `<span class="af-evidence">${esc(r.detail)}</span>` },
  ], labels), 'verified = SILO has seen it work here');
}

// ── Program ──────────────────────────────────────────────────────────────
async function ensureProfiles() {
  if (S.profiles.length) return;
  const { data: mem } = await db.from('entity_memberships').select('user_id').eq('entity_id', CO);
  const ids = (mem || []).map((m) => m.user_id).filter(Boolean);
  if (ids.length) S.profiles = (await db.from('profiles').select('id, name, email').in('id', ids).order('name')).data || [];
  // Memberships may be visible only to admins; fall back to the profiles this
  // user can already see, which RLS limits to their own companies.
  if (!S.profiles.length) S.profiles = (await db.from('profiles').select('id, name, email').eq('is_active', true).order('name')).data || [];
}

function renderProgram(isNew = S.creating) {
  const p = isNew ? {} : (prog() || {});
  const dis = MANAGE ? '' : 'disabled';
  const o = (v, label, cur) => `<option value="${v}"${String(cur ?? '') === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const plats = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web'];
  const units = minorUnits(p.currency || 'USD');
  const major = (c) => (c === null || c === undefined ? '' : (Number(c) / units).toString());
  const form = `
    <div class="af-grid">
      ${field('Name', input('pName', `${dis} value="${esc(p.name || '')}" placeholder="e.g. Creator program"`))}
      ${field('Status', `<select class="bcn-field" id="pStatus" ${dis}>${o('draft', 'Draft', p.status ?? 'draft')}${o('active', 'Active: recruiting', p.status)}${o('paused', 'Paused', p.status)}${o('closed', 'Closed', p.status)}</select>`)}
      ${field('What kind of creators? (your niche)', input('pNiche', `${dis} value="${esc(p.niche || '')}" placeholder="e.g. youth baseball training"`))}
    </div>
    ${field('Platforms', `<div class="af-checks">${plats.map((x) => `<label><input type="checkbox" class="pPlat" value="${x}" ${dis} ${(p.platforms || []).includes(x) ? 'checked' : ''}/> ${x}</label>`).join('')}</div>`)}
    <div class="af-grid">
      ${field('Commission type', `<select class="bcn-field" id="pKind" ${dis}>${o('percent_of_net', 'Percent of net order', p.commission_kind ?? 'percent_of_net')}${o('fixed_per_order', 'Fixed per order', p.commission_kind)}</select>`)}
      ${field('Percent', input('pPct', `${dis} type="number" step="0.001" min="0" max="100" value="${esc(p.commission_percent ?? '')}"`))}
      ${field('Fixed amount per order', input('pFixed', `${dis} inputmode="decimal" value="${esc(major(p.commission_fixed_cents))}"`))}
    </div>
    ${field(`Program terms${p.terms_version ? ` (version ${p.terms_version}; editing makes a new version)` : ''}`, `<textarea class="bcn-field" id="pTerms" rows="6" ${dis} placeholder="What the affiliate agrees to: commission, how orders are credited, refunds, when and how you pay, what they may not do.">${esc(p.terms_markdown || '')}</textarea>`)}
    ${more('Advanced settings', [`<div class="af-grid">
      ${field('Short name (used in the apply link)', input('pSlug', `${dis} value="${esc(p.slug || '')}" placeholder="creator-program"`))}
      ${field('Designated employee (replies go to them)', `<select class="bcn-field" id="pOwner" ${dis}><option value="">—</option>${S.profiles.map((u) => o(u.id, u.name || u.email, p.owner_user_id)).join('')}</select>`)}
      ${field('Audience notes', input('pAudience', `${dis} value="${esc(p.audience_notes || '')}" placeholder="Who the ideal creator speaks to"`))}
      ${field('Countries (comma separated)', input('pGeo', `${dis} value="${esc((p.geographies || []).join(', '))}" placeholder="US, CA"`))}
      ${field('Joining', `<select class="bcn-field" id="pIntake" ${dis}>${o('invite_only', 'Invite only', p.intake_mode ?? 'invite_only')}${o('open', 'Open applications (you review each)', p.intake_mode)}</select>`)}
      ${field('Currency', input('pCur', `${dis} maxlength="3" value="${esc(p.currency || 'USD')}"`))}
      ${field('Default code start', input('pStart', `${dis} type="date" value="${esc(p.default_code_starts_on || '')}"`))}
      ${field('Default code end', input('pEnd', `${dis} type="date" value="${esc(p.default_code_ends_on || '')}"`))}
      ${field('Grace days after a code ends', input('pGrace', `${dis} type="number" min="0" max="365" value="${esc(p.attribution_window_days ?? 0)}"`))}
      ${field('Several codes on one order', `<select class="bcn-field" id="pPrec" ${dis}>${o('first_affiliate_code', 'Credit the one affiliate code', p.code_precedence ?? 'first_affiliate_code')}${o('single_code_only', 'Do not credit', p.code_precedence)}</select>`)}
      ${field('Refund hold (days)', input('pHold', `${dis} type="number" min="0" max="365" value="${esc(p.refund_hold_days ?? 30)}"`))}
      ${field('Payout minimum', input('pMin', `${dis} inputmode="decimal" value="${esc(major(p.payout_minimum_cents))}"`))}
    </div>`])}
    ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${btn(isNew ? 'Create program' : 'Save changes', 'save-program', {}, 'primary')}${isNew && S.programs.length ? btn('Cancel', 'cancel-new') : ''}</div>` : ''}`;
  let extra = '';
  if (!isNew && p.id) {
    const url = applyUrl(location.origin, CO, p.slug);
    extra += card('Open applications link', p.intake_mode === 'open'
      ? `<div class="bcn-field af-mono af-copy">${esc(url)}</div>`
      : '<p class="af-muted">Invite only.</p>');
    extra += '<div id="managersCard"></div>';
  }
  $('programBody').innerHTML = card(isNew ? 'New program' : 'Settings', form) + (extra ? more('Sharing, access and how it works', [extra, S.d ? stageCard() : '']) : '');
  if (!isNew && p.id) renderManagers();
}

async function renderManagers() {
  const el = $('managersCard'); if (!el) return;
  const { data } = await db.from('affiliate_program_managers').select('id, user_id, created_at').eq('company_entity_id', CO);
  const rows = data || [];
  const name = (id) => { const u = S.profiles.find((x) => x.id === id); return esc(u?.name || u?.email || id); };
  el.innerHTML = card('Who can run Affiliate Studio', `    ${table([{ h: 'Person', f: (r) => name(r.user_id) }, { h: 'Since', f: (r) => fmtDate(r.created_at) }, { h: '', f: (r) => btn('Remove', 'remove-manager', { id: r.id }, 'ghost', { confirm: true }) }], rows, 'Only owners and executives so far.')}
    <div class="af-row" style="margin-top:8px;">${field('Grant access to', `<select class="bcn-field" id="mgrUser"><option value="">—</option>${S.profiles.map((u) => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join('')}</select>`)}${btn('Grant', 'add-manager')}</div>`);
}

function readProgramForm() {
  return validateProgram({
    name: val('pName'), slug: val('pSlug') || slugify(val('pName')), status: val('pStatus'), owner_user_id: val('pOwner'),
    niche: val('pNiche'), audience_notes: val('pAudience'), geographies: val('pGeo'),
    platforms: [...document.querySelectorAll('.pPlat:checked')].map((x) => x.value),
    intake_mode: val('pIntake'), commission_kind: val('pKind'), commission_percent: val('pPct'), commission_fixed: val('pFixed'),
    currency: val('pCur'), default_code_starts_on: val('pStart'), default_code_ends_on: val('pEnd'),
    attribution_window_days: val('pGrace'), code_precedence: val('pPrec'), refund_hold_days: val('pHold'),
    payout_minimum: val('pMin'), discovery_max_cost_usd: S.creating ? '' : (prog()?.discovery_max_cost_usd ?? ''), terms_markdown: $('pTerms').value,
  });
}

// ── Prospects ────────────────────────────────────────────────────────────
function renderProspects() {
  const d = S.d; const p = prog();
  const filter = S.prospectFilter || 'new';
  const GROUPS = { new: ['new', 'qualified'], approved: ['approved', 'invited', 'signed_up'], all: null };
  const inGroup = (x, g) => !GROUPS[g] || GROUPS[g].includes(x.status);
  const list = d.prospects.filter((x) => inGroup(x, filter));
  const live = new Set(d.drafts.filter((x) => ['draft', 'approved', 'exported'].includes(x.state)).map((x) => x.prospect_id));
  const actions = (x) => {
    if (!MANAGE) return '';
    const b = [];
    if (['new', 'qualified', 'rejected'].includes(x.status)) b.push(btn('Approve', 'prospect-status', { id: x.id, s: 'approved' }, 'primary'));
    if (['new', 'qualified', 'approved'].includes(x.status)) b.push(btn('Reject', 'prospect-status', { id: x.id, s: 'rejected' }));
    if (x.status === 'rejected') b.push(pill('rejected'));
    if (x.status === 'approved' && !live.has(x.id)) b.push(btn('Draft message', 'draft-create', { id: x.id }));
    if (['approved', 'invited'].includes(x.status) && x.contact_email) b.push(btn('Signup link', 'signup-link', { id: x.id }));
    if (!['suppressed', 'signed_up', 'rejected'].includes(x.status)) b.push(btn('Do not contact', 'prospect-suppress', { id: x.id }, 'ghost', { confirm: true }));
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const who = (x) => {
    const link = x.profile_url ? ext(x.profile_url, x.display_name || x.handle || x.profile_url) : esc(x.display_name || x.handle);
    return `${link}<div class="af-muted">${esc(x.platform)}${x.handle ? ` · ${esc(x.handle)}` : ''}</div>${x.contact_email ? `<div class="af-muted">${esc(x.contact_email)}</div>` : ''}`;
  };
  const provenance = (x) => {
    const e = x.evidence || {};
    return `<div class="af-evidence">${e.title ? `<strong>${esc(e.title)}</strong><br>` : ''}${esc(e.snippet || e.note || e.pitch || '')}</div>
      <div class="af-muted">${esc(sourceLabel(x.source))}${e.query ? ` · “${esc(e.query)}”` : ''} · ${fmtDate(x.collected_at)}${x.source_url ? ` · ${ext(x.source_url, 'source')}` : ''}</div>`;
  };
  const contact = (x) => (x.contact_email
    ? `${esc(x.contact_email)}${x.contact_source_url ? `<div class="af-muted">${ext(x.contact_source_url, 'where it was stated')}</div>` : '<div class="af-muted">entered by a person</div>'}`
    : '<span class="af-muted">not found</span>');
  const followers = (x) => {
    const f = followersFrom(x.evidence);
    if (!f) return '<span class="af-muted">—</span>';
    const where = f.source_url ? `${ext(f.source_url, f.kind === 'profile' ? 'on their profile' : f.kind === 'other_page' ? 'from another page' : 'where it was stated')}${f.as_of ? ` · ${fmtDate(f.as_of)}` : ''}` : (x.source === 'csv_import' ? 'from your list' : '');
    return `${num(f.count)}${where ? `<div class="af-muted">${where}</div>` : ''}`;
  };
  const researching = S.watching && d.runs.some((r) => r.id === S.watching);
  const filters = [['new', 'To review'], ['approved', 'Approved'], ['all', 'All']];
  const runs = d.runs.slice(0, 10);
  $('prospectsBody').innerHTML = [
    MANAGE ? card('Find creators', `
      <div class="af-row">${field('Who are you looking for?', input('rsFocus', `maxlength="500" placeholder="${esc(p.niche ? `e.g. ${p.niche} creators on TikTok` : 'e.g. youth baseball coaches with drill videos')}"`))}${btn(researching ? 'Finding…' : 'Find creators', 'research-run', {}, 'primary', { disabled: researching })}</div>`) : '',
    card('Creators', `<div class="bcn-tabs" style="margin:0 0 8px;">${filters.map(([f, label]) => `<button class="bcn-tab${f === filter ? ' bcn-tab--active' : ''}" data-act="prospect-filter" data-f="${f}">${esc(label)}&nbsp;<span class="af-mono">${d.prospects.filter((x) => inGroup(x, f)).length}</span></button>`).join('')}</div>
      ${table([
        { h: 'Creator', f: who }, { h: 'Followers', num: true, f: followers }, { h: 'Why they fit', f: provenance }, { h: '', f: actions },
      ], list, filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.')}
      <div id="signupOut"></div>`, `${d.prospects.length} total`),
    more('More options', [
    MANAGE ? card('How many to find', field('Creators per run (5 to 50)', input('rsCount', 'type="number" min="5" max="50" value="25"'))) : '',
    MANAGE ? card('Import a list', `<p class="af-muted">CSV, one creator per row with a profile link.</p>
      <div class="af-row">${field('File', '<input class="bcn-field" type="file" id="impFile" accept=".csv,text/csv" />')}${btn('Import', 'import-run', {}, 'primary')}</div>`) : '',
    MANAGE ? card('Add a prospect by hand', `<div class="af-grid">
      ${field('Name', input('mpName'))}${field('Platform', `<select class="bcn-field" id="mpPlat">${['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web', 'other'].map((x) => `<option>${x}</option>`).join('')}</select>`)}
      ${field('Handle', input('mpHandle', 'placeholder="@name"'))}${field('Profile URL', input('mpUrl', 'placeholder="https://"'))}
      ${field('Email (only one they published or gave you)', input('mpEmail', 'type="email"'))}${field('Where you found them (URL)', input('mpSource', 'placeholder="https://"'))}
    </div>${field('Note', input('mpNote', 'placeholder="e.g. met at a tournament, asked to join"'))}<div class="af-row" style="margin-top:8px;">${btn('Add prospect', 'prospect-add', {}, 'primary')}</div>`) : '',
    card('Saved Google searches', `
      ${table([
        { h: 'Search', f: (s) => `“${esc(s.query)}”<div class="af-muted">${esc(s.platform_hint === 'blog' ? 'websites' : s.platform_hint || 'program platforms')} · ${esc(countryName(s.location_code))} · ${esc(languageName(s.language_code))}</div>` },
        { h: 'Results wanted', num: true, f: (s) => num(s.max_results) },
        { h: 'Last run', f: (s) => `${fmtDate(s.last_run_at)}${s.last_error ? `<div class="af-muted">${esc(friendlySearchError(s.last_error))}</div>` : ''}` },
        { h: '', f: (s) => (MANAGE ? btn(s.enabled ? 'Pause' : 'Resume', 'source-toggle', { id: s.id, on: s.enabled ? '0' : '1' }) : '') },
      ], d.sources, 'No searches yet.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Search words', input('srcQuery', `placeholder="${esc(p.niche ? `${p.niche} creator` : 'e.g. youth baseball drills youtube')}"`))}${field('Platform', `<select class="bcn-field" id="srcPlat"><option value="">program platforms</option>${['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest'].map((x) => `<option>${x}</option>`).join('')}<option value="blog">websites</option></select>`)}${field('Country', `<select class="bcn-field" id="srcLoc">${SEARCH_COUNTRIES.map(([iso, code, name]) => `<option value="${code}"${iso === (p.geographies?.[0] || 'US') ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>`)}${field('Language', `<select class="bcn-field" id="srcLang">${SEARCH_LANGUAGES.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('')}</select>`)}${field('Results', input('srcMax', 'type="number" min="10" max="100" value="30"'))}${btn('Add search', 'source-add', {}, 'primary')}</div>` : ''}`),
    card('Recent runs', table([
      { h: 'When', f: (r) => fmtTime(r.started_at) }, { h: 'Search', f: (r) => esc(r.query) },
      { h: 'Kind', f: (r) => (r.dry_run ? pill('dry run') : pill(runKindLabel(r), 'accent')) },
      { h: 'Results', num: true, f: (r) => num(r.results_returned) }, { h: 'Profiles', num: true, f: (r) => num(r.profiles_recognized) },
      { h: 'New', num: true, f: (r) => num(r.prospects_new) }, { h: 'Emails stated', num: true, f: (r) => num(r.emails_found) },
      { h: 'Skipped (opted out)', num: true, f: (r) => num(r.suppressed_skipped) },
      { h: 'Result', f: (r) => `${statusPill(r.status)}${r.error ? `<div class="af-muted">${esc(friendlySearchError(r.error))}</div>` : ''}` },
    ], runs, 'Discovery has not run for this program yet.')),
    card('Do-not-contact list', `
      ${table([{ h: 'Type', f: (s) => esc(s.kind) }, { h: 'Value', f: (s) => `<span class="af-mono">${esc(s.value_normalized)}</span>` }, { h: 'Reason', f: (s) => esc(s.reason) }, { h: 'Added', f: (s) => fmtDate(s.created_at) }, { h: '', f: (s) => (MANAGE ? btn('Remove', 'suppression-remove', { id: s.id }, 'ghost', { confirm: true }) : '') }], d.suppressions, 'Nobody is on the list.')}
      <div class="af-row" style="margin-top:8px;">${field('Type', '<select class="bcn-field" id="supKind"><option>email</option><option>domain</option><option>handle</option><option value="profile_url">profile URL</option></select>')}${field('Value', input('supVal'))}${field('Reason', '<select class="bcn-field" id="supReason"><option value="opted_out">asked not to be contacted</option><option value="bounced">bounced</option><option value="complained">complained</option><option value="competitor">competitor</option><option value="do_not_contact">do not contact</option><option value="manual">other</option></select>')}${btn('Add', 'suppression-add')}</div>`),
    ]),
  ].join('');
}

// ── Outreach ─────────────────────────────────────────────────────────────
function renderOutreach() {
  const d = S.d;
  const byState = (s) => d.drafts.filter((x) => (Array.isArray(s) ? s.includes(x.state) : x.state === s));
  const who = (x) => `${esc(x.recipient_email || x.recipient_handle)}<div class="af-muted">${esc(d.prospectById[x.prospect_id]?.display_name || '')} · ${esc(x.channel)}</div>`;
  const msg = (x) => `<div class="af-evidence"><strong>${esc(x.subject)}</strong><br>${esc(String(x.body || '').slice(0, 220))}${String(x.body || '').length > 220 ? '…' : ''}</div>`;
  const editing = S.editDraft ? d.drafts.find((x) => x.id === S.editDraft) : null;
  // "Via <app>": a batch an AI connection claimed (outreach:send) to send from
  // the approver's own mailbox, and a send it recorded. Null for a person.
  const batchById = Object.fromEntries((d.batches || []).map((b) => [b.id, b]));
  const viaBatch = (x) => { const b = batchById[x.batch_id]; return b?.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''; };
  $('outreachBody').innerHTML = [
    editing ? card('Edit message', `${field('Subject', input('edSubject', `value="${esc(editing.subject || '')}"`))}${field('Message ({signup_link} is replaced at export)', `<textarea class="bcn-field" id="edBody" rows="10">${esc(editing.body || '')}</textarea>`)}<div class="af-row" style="margin-top:8px;">${btn('Save', 'draft-save', { id: editing.id }, 'primary')}${btn('Close', 'draft-edit-close')}</div>`) : '',
    card('Drafts', table([
      { h: 'To', f: who }, { h: 'Message', f: msg }, { h: 'Created', f: (x) => fmtDate(x.created_at) },
      { h: '', f: (x) => (MANAGE ? `<div class="af-actions">${btn('Edit', 'draft-edit', { id: x.id })}${btn('Approve', 'draft-approve', { id: x.id }, 'primary')}${btn('Delete', 'draft-delete', { id: x.id }, 'ghost', { confirm: true })}</div>` : '') },
    ], byState('draft'), 'No drafts. Approve a creator on Find creators to draft one.'), `${byState('draft').length}`),
    card('Approved, ready to send', `${table([{ h: 'To', f: who }, { h: 'Message', f: msg }, { h: 'Approved', f: (x) => fmtTime(x.approved_at) }], byState('approved'), 'Nothing approved yet.')}
      ${aiSendBlock(d.aiApps)}
      <div class="af-row" style="margin-top:8px;">${(d.aiApps || []).some((a) => a.canSend) ? '<a class="bcn-btn bcn-btn--ghost" href="../settings-connect-ai.html">Manage AI connections</a>' : '<a class="bcn-btn bcn-btn--primary" href="../settings-connect-ai.html">Connect your AI</a>'}${MANAGE && byState('approved').length ? btn(`Or export ${byState('approved').length} to send yourself`, 'outreach-export', {}, 'ghost', { confirm: true }) : ''}</div>`),
    card('Waiting to be marked sent', table([
      { h: 'To', f: who }, { h: 'Exported', f: (x) => `${fmtTime(x.exported_at)}${viaBatch(x)}` },
      { h: 'Mark sent', f: (x) => (MANAGE ? `<div class="af-row"><input class="bcn-field" id="ev-${x.id}" placeholder="Where: sent-folder link, DM screenshot ref" />${btn('Mark sent', 'draft-sent', { id: x.id }, 'primary')}</div>` : '') },
    ], byState('exported'), 'Nothing is waiting.')),
    more('More options', [
    card('Sent and outcomes', table([
      { h: 'To', f: who }, { h: 'State', f: (x) => statusPill(x.state) }, { h: 'Marked by', f: (x) => `${fmtTime(x.sent_marked_at)}<div class="af-muted">${esc(x.sent_evidence || '')}</div>${x.sent_via_app ? `<div class="af-muted">Via ${esc(x.sent_via_app)}</div>` : ''}` },
      { h: '', f: (x) => (MANAGE && x.state === 'sent' ? `<div class="af-actions">${btn('Replied', 'draft-outcome', { id: x.id, s: 'replied' })}${btn('Declined', 'draft-outcome', { id: x.id, s: 'declined' })}${btn('Bounced', 'draft-outcome', { id: x.id, s: 'bounced' })}${btn('Asked to stop', 'draft-optout', { id: x.id }, 'danger', { confirm: true })}</div>` : '') },
    ], byState(['sent', 'replied', 'declined', 'bounced', 'signed_up']), 'Nothing sent yet.')),
    card('Export batches', table([
      { h: 'Exported', f: (b) => `${fmtTime(b.exported_at)}${b.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}, sent from the approver's mailbox</div>` : ''}` }, { h: 'Rows', num: true, f: (b) => num(b.row_count) },
      { h: 'Fingerprint (SHA-256 of the file)', f: (b) => `<span class="af-mono af-copy">${esc(b.fingerprint || '—')}</span>` },
    ], d.batches, 'No exports yet.'), 'compare with sha256sum of a file to prove it is this export'),
    ]),
  ].join('');
}

async function publishAdImage(path) {
  if (!IMG_PATH_RE.test(path) || !path.startsWith(`${CO}/`)) return null;
  const { data: blob, error } = await db.storage.from('ad-creative-images').download(path);
  if (error || !blob) throw new Error('Could not read that ad\'s picture. Try again, or share it without one later.');
  const up = await db.storage.from('affiliate-feed-images').upload(path, blob, { contentType: blob.type || undefined, upsert: false });
  // Content-addressed: the same file shared before is already there.
  if (up.error && !/exist|duplicate/i.test(up.error.message || '')) throw new Error(`Could not publish the picture: ${up.error.message}`);
  return db.storage.from('affiliate-feed-images').getPublicUrl(path).data.publicUrl;
}

// Which of your AI apps can create codes in Shopify for this company.
// What the person pastes into their own AI (or sets as a daily task there).
const CODES_PROMPT = 'Using SILO, create every affiliate code waiting for Shopify in my Shopify store, then mark each one created in SILO.';
function aiCodesBlock(apps) {
  const can = [...new Set((apps || []).filter((a) => a.canCode).map((a) => a.name))];
  if (can.length) return `<div class="af-row" id="aiCodesHow"><span class="af-muted">${can.map((n) => pill(n, 'pos')).join(' ')} makes your codes in Shopify.</span>${btn('Copy prompt for your AI', 'copy-codes-prompt')}</div>`;
  return '<p class="af-muted" id="aiCodesHow">Want codes made for you? <a href="../settings-connect-ai.html">Connect your AI</a> and allow “create affiliate codes”.</p>';
}

// Which of your AI apps can send for this company, in one line.
function aiSendBlock(apps) {
  const send = [...new Set((apps || []).filter((a) => a.canSend).map((a) => a.name))];
  if (send.length) return `<p class="af-muted" id="aiSendHow">${send.map((n) => pill(n, 'pos')).join(' ')} sends approved messages from your email. Ask it to “send my approved affiliate messages”.</p>`;
  return '<p class="af-muted" id="aiSendHow">Your own AI sends approved messages from your email. Connect it while this company is selected and allow “send approved affiliate outreach”.</p>';
}

// ── Affiliates ───────────────────────────────────────────────────────────
function renderAffiliates() {
  const d = S.d; const p = prog();
  const codesOf = (a) => d.codes.filter((c) => c.affiliate_id === a.id);
  const linksOf = (a) => d.links.filter((l) => l.affiliate_id === a.id);
  const actions = (a) => {
    if (!MANAGE) return '';
    const b = [];
    if (['active', 'paused'].includes(a.status)) b.push(btn('Portal link', 'portal-link', { id: a.id }), btn('Email codes & links', 'notify-codes', { id: a.id }));
    if (a.status === 'active') b.push(btn('Pause', 'affiliate-status', { id: a.id, s: 'paused' }));
    if (a.status === 'paused') b.push(btn('Resume', 'affiliate-status', { id: a.id, s: 'active' }));
    if (a.status !== 'terminated') b.push(btn('End', 'affiliate-status', { id: a.id, s: 'terminated' }, 'danger', { confirm: true }));
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const canCode = (d.aiApps || []).some((a) => a.canCode);
  const affOpts = d.affiliates.filter((a) => a.status !== 'terminated').map((a) => `<option value="${a.id}">${esc(a.display_name)} (${esc(a.status)})</option>`).join('');
  $('affiliatesBody').innerHTML = [
    card('Affiliates', `${table([
      { h: 'Affiliate', f: (a) => `<strong>${esc(a.display_name)}</strong><div class="af-muted">${esc(a.contact_email)}</div>` },
      { h: 'Status', f: (a) => statusPill(a.status) },
      { h: 'Terms', f: (a) => (a.terms_version_accepted ? `v${a.terms_version_accepted} on ${fmtDate(a.terms_accepted_at)}${a.terms_version_accepted < p.terms_version ? '<div class="af-muted">older than current terms</div>' : ''}` : '<span class="af-muted">not accepted</span>') },
      { h: 'Codes', f: (a) => codesOf(a).map((c) => `<span class="af-mono">${esc(c.code)}</span> <span class="af-muted">${fmtDate(c.starts_on)}→${c.ends_on ? fmtDate(c.ends_on) : 'open'}${c.status === 'retired' ? ' · retired' : c.status === 'pending' ? ' · waiting for your AI' : (c.verified_at ? ' · seen on orders' : ' · not seen yet')}</span>`).join('<br>') || '—' },
      { h: 'Links', f: (a) => { const code = liveCodeOf(a.id); const store = storeOf(p);
        const rows = [store && code ? affiliateLink(store, code, '/') : null, ...linksOf(a).map((l) => (store && code ? storeLinkFor(store, code, l.destination_url) : null) || linkUrl(l) || l.destination_url)].filter(Boolean);
        return rows.map((u) => `<span class="af-mono af-copy">${esc(u)}</span>`).join('<br>') || '—'; } },
      { h: '', f: actions },
    ], d.affiliates, 'No affiliates yet. They appear here when someone you invite opens their signup link.')}<div id="affOut"></div>`),
    MANAGE && needsStore(p) ? `<div class="bcn-status bcn-status--warn" id="storeNeeded">Add your website on the Share tab to turn on affiliate links.</div>` : '',
    MANAGE ? card('Give an affiliate a code', `<div class="af-row">${field('Affiliate', `<select class="bcn-field" id="cAff">${affOpts}</select>`)}${field('Code', input('cCode', 'class="bcn-field bcn-field--mono"'))}${btn('Add code', 'code-add', {}, 'primary')}</div>
      <details class="af-more"><summary>Options</summary><div class="af-row">${field('Starts', input('cStart', `type="date" value="${esc(p.default_code_starts_on || today())}"`))}${field('Ends', input('cEnd', `type="date" value="${esc(p.default_code_ends_on || '')}"`))}${field('In Shopify', `<select class="bcn-field" id="cHow"><option value="exists"${canCode ? '' : ' selected'}>I made it</option><option value="ai"${canCode ? ' selected' : ''}>My AI makes it</option></select>`)}${field('% off', input('cPct', 'type="number" min="1" max="100" step="1" value="10"'))}</div></details>
      ${aiCodesBlock(d.aiApps)}
      ${table([{ h: 'Code', f: (c) => `<span class="af-mono">${esc(c.code)}</span>` }, { h: 'Affiliate', f: (c) => esc(d.affById[c.affiliate_id]?.display_name) }, { h: 'Dates', f: (c) => `${fmtDate(c.starts_on)} → ${c.ends_on ? fmtDate(c.ends_on) : 'open'}` },
        { h: 'In Shopify', f: (c) => (c.status === 'pending' ? `${pill('waiting for your AI', 'warn')}<div class="af-muted">${esc(Number(c.discount_percent))}% off</div>` : c.shopify_created_via_app ? `created via ${esc(c.shopify_created_via_app)}<div class="af-muted">${fmtDate(c.shopify_created_at)}</div>` : '<span class="af-muted">made by you</span>') },
        { h: 'First seen', f: (c) => (c.verified_at ? `${fmtDate(c.verified_at)}<div class="af-muted">order ${esc(c.first_seen_order_id)}</div>` : '<span class="af-muted">never</span>') },
        { h: '', f: (c) => (c.status === 'active' ? btn('Retire', 'code-retire', { id: c.id }, 'ghost', { confirm: true }) : c.status === 'pending' ? btn('Cancel', 'code-retire', { id: c.id }, 'ghost', { confirm: true }) : pill('retired')) }], d.codes, 'No codes yet.')}`) : '',
    more('More options', [MANAGE ? card('Give an affiliate a link to a page', `      <div class="af-row">${field('Affiliate', `<select class="bcn-field" id="lAff">${affOpts}</select>`)}${field('Name', input('lSlug', 'placeholder="pat-spring"'))}${field('Page (https)', input('lDest', 'placeholder="https://yourstore.com/collections/new"'))}${field('utm_campaign', input('lCamp', `value="${esc(p.slug)}"`))}${btn('Add link', 'link-add', {}, 'primary')}</div>`) : '']),
  ].join('');
}

// ── Share: what affiliates see in their portal ───────────────────────────
// The brand picks each item (Blake, 2026-11-10). Sharing stores a snapshot of
// only what an affiliate may see; the portal gives each affiliate their own
// link to it, which applies their code at checkout.
const pathOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? (x.pathname || '/') : null; } catch { return null; } };
const httpsOr = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? u : null);
// An Ad Studio archive object: <company>/<sha256>.<ext>, the same path in the
// public feed bucket once shared.
const IMG_PATH_RE = /^[A-Za-z0-9-]{1,64}\/[0-9a-f]{16,64}\.(jpg|jpeg|png|webp|gif)$/;
const safePath = (p) => (/^\/[A-Za-z0-9/_.~%-]*$/.test(String(p || '')) && !String(p).startsWith('//') ? p : null);

async function loadShareSources() {
  const t = today();
  const [l, a] = await Promise.all([
    db.from('launch_calendar').select('id, title, launch_date, launch_image_url, landing_page_url, status')
      .eq('company_entity_id', CO).gte('launch_date', t).order('launch_date').limit(50),
    // The company's recent ads, with the picture each one ran with (Ad
    // Studio's archive). The images are private; Studio shows them through
    // short-lived signed links, and sharing one copies it to the public feed
    // bucket so affiliates can see it.
    db.rpc('ad_studio_ads', { p_days: 60 }),
  ]);
  const ads = (Array.isArray(a.data) ? a.data : [])
    .filter((x) => IMG_PATH_RE.test(x.image_path || '') && Number(x.image_shared_by || 0) < 2)
    .sort((x, y) => Number(y.recent_spend || 0) - Number(x.recent_spend || 0) || String(y.last_day).localeCompare(String(x.last_day)))
    .slice(0, 24);
  const signed = {};
  if (ads.length) {
    try {
      const r = await db.storage.from('ad-creative-images').createSignedUrls(ads.map((x) => x.image_path), 3600);
      (r.data || []).forEach((x) => { if (x.signedUrl && !x.error) signed[x.path] = x.signedUrl; });
    } catch (_) { /* no preview is cosmetic; sharing still copies the image */ }
  }
  S.share = { launches: l.data || [], ads, signed, products: S.share?.products || [], q: S.share?.q || '',
    failed: [l.error && 'launches', a.error && 'ads'].filter(Boolean) };
}

function shareItem(kind, srcId, title, sub, img, payload) {
  const shared = S.d.feed.find((f) => f.kind === kind && f.source_id === String(srcId));
  const action = !MANAGE ? (shared ? pill('shared', 'pos') : '')
    : shared ? btn('Stop sharing', 'feed-remove', { id: shared.id })
    : btn('Share', 'feed-add', { kind, src: srcId, p: JSON.stringify(payload) }, 'primary');
  return `<div class="af-share-row">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="af-share-noimg"></span>'}<div class="af-share-txt"><strong>${esc(title)}</strong>${sub ? `<div class="af-muted">${esc(sub)}</div>` : ''}</div>${action}</div>`;
}

async function renderShare() {
  const p = prog();
  $('shareBody').innerHTML = card('Share with affiliates', '<p class="af-muted">Loading…</p>');
  if (!S.share || S.share.programId !== p.id) { await loadShareSources(); S.share.programId = p.id; }
  const sh = S.share; const d = S.d;
  const launches = sh.launches.map((x) => shareItem('launch', x.id, x.title || 'Launch', fmtDate(x.launch_date), httpsOr(x.launch_image_url),
    { title: x.title || 'Launch', event_on: x.launch_date, image_url: httpsOr(x.launch_image_url), product_path: x.landing_page_url ? pathOf(x.landing_page_url) : null }));
  const products = sh.products.map((x) => shareItem('product', x.shopify_handle, x.product_title, x.product_type || '', httpsOr(x.image_url),
    { title: x.product_title, image_url: httpsOr(x.image_url), product_path: `/products/${x.shopify_handle}` }));
  const ads = sh.ads.map((x) => shareItem('ad', x.ad_id, x.title || x.ad_name || 'Ad',
    [x.effective_status === 'ACTIVE' ? 'Running now' : x.last_day ? `Ran until ${fmtDate(x.last_day)}` : '', x.body ? String(x.body).slice(0, 90) : ''].filter(Boolean).join(' · '),
    sh.signed[x.image_path] || null,
    { title: String(x.title || x.ad_name || 'Ad').slice(0, 200), note: x.body ? String(x.body).slice(0, 1000) : null,
      product_path: safePath(x.link_path) || (x.link_url ? pathOf(x.link_url) : null), image_path: x.image_path }));
  const sharedRows = d.feed.map((f) => `<div class="af-seen-item">${f.image_url ? `<img src="${esc(f.image_url)}" alt="" loading="lazy">` : `<div class="af-seen-none">${esc(f.title)}</div>`}<div class="af-seen-body"><strong>${esc(f.title)}</strong><div class="af-muted">${esc(({ launch: 'Launch', product: 'Product', ad: 'Ad' })[f.kind])}${f.event_on ? ` · ${fmtDate(f.event_on)}` : ''}</div>${MANAGE ? btn('Stop sharing', 'feed-remove', { id: f.id }) : ''}</div></div>`);
  $('shareBody').innerHTML = [
    card('What your affiliates see', `${sharedRows.length ? `<div class="af-seen">${sharedRows.join('')}</div>` : empty('Nothing shared yet.')}`,
      `${d.feed.length} shared`),
    MANAGE ? (needsStore(p)
      ? card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', 'placeholder="https://www.yourstore.com"'))}${btn('Save', 'store-save', {}, 'primary')}</div><p class="bcn-status bcn-status--warn" id="storeNeeded">Add it once to turn on affiliate links.</p>`)
      : more(`Links open ${storeOf(p)}`, [card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', `value="${esc(p.store_url || storeOf(p) || '')}"`))}${btn('Save', 'store-save', {}, 'primary')}</div><span id="storeNow" hidden></span>`)])) : '',
    card('Upcoming launches', (launches.length ? launches.join('') : empty('No upcoming launches on the launch calendar.'))
),
    card('Products', `<div class="af-row">${field('Find a product', input('prodQ', `placeholder="Name" value="${esc(sh.q)}"`))}${btn('Search', 'prod-search', {}, 'ghost')}</div>${products.length ? products.join('') : (sh.q ? empty('No products match.') : '')}`),
    card('Recent ads', `${ads.length ? ads.join('') : empty('No recent ads yet.')}`),
    sh.failed.length ? `<p class="af-muted">Could not load: ${esc(sh.failed.join(', '))}.</p>` : '',
  ].join('');
}

// ── Commissions ──────────────────────────────────────────────────────────
function renderCommissions() {
  const d = S.d; const p = prog();
  const from = S.rangeFrom || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = S.rangeTo || today();
  const openPeriods = d.periods.filter((x) => x.status === 'open');
  const perf = d.performance.map((r) => ({ ...r, a: d.affById[r.affiliate_id] }));
  $('commissionsBody').innerHTML = [
    card('Commissions', `
      ${MANAGE ? `<div class="af-row">${btn('Update commissions', 'update-commissions', {}, 'primary')}</div>` : ''}<div id="runOut"></div>`),
    more('More options', [
    card('Dates and period', `<div class="af-row">${field('From', input('rFrom', `type="date" value="${from}"`))}${field('To', input('rTo', `type="date" value="${to}"`))}
      ${field('Put new lines in period', `<select class="bcn-field" id="rPeriod"><option value="">the open period that contains each order</option>${openPeriods.map((x) => `<option value="${x.id}">${fmtDate(x.period_start)} → ${fmtDate(x.period_end)}</option>`).join('')}</select>`)}
      ${MANAGE ? btn('Match orders only', 'resolve') + btn('Calculate only', 'accrue') : ''}</div>`),
    card('Per affiliate', table([
      { h: 'Affiliate', f: (r) => esc(r.a?.display_name || '—') },
      { h: 'Credited orders', num: true, f: (r) => num(r.attributed_orders) },
      { h: 'Merchandise', num: true, f: (r) => formatMoney(r.gross_subtotal_cents, r.order_currency) },
      { h: 'Refunded', num: true, f: (r) => formatMoney(r.refunded_subtotal_cents, r.order_currency) },
      { h: 'Commission base', num: true, f: (r) => formatMoney(r.commissionable_cents, r.order_currency) },
      { h: 'Base unknown', num: true, f: (r) => num(r.orders_with_unknown_base) },
    ], perf, 'No credited orders yet.'), 'sales with an affiliate’s code, not proof the affiliate caused them'),
    card('Order decisions', table([
      { h: 'Day', f: (r) => fmtDate(r.order_day) }, { h: 'Order', f: (r) => `<span class="af-mono">${esc(r.order_number || r.order_id)}</span>` },
      { h: 'Code', f: (r) => `<span class="af-mono">${esc(r.matched_code || '—')}</span>${r.codes_on_order > 1 ? `<div class="af-muted">${r.codes_on_order} codes on order</div>` : ''}` },
      { h: 'Affiliate', f: (r) => esc(d.affById[r.affiliate_id]?.display_name || '—') },
      { h: 'Decision', f: (r) => (BASIS_LABELS[r.basis]?.earns ? pill(basisLabel(r.basis), 'pos') : pill(basisLabel(r.basis))) },
      { h: 'Base', num: true, f: (r) => formatMoney(r.commissionable_cents, r.order_currency) },
    ], d.attributions, 'No orders matched yet. Run step 1.'), 'latest 300'),
    card('Review periods', `
      ${table([
        { h: 'Period', f: (x) => `${fmtDate(x.period_start)} → ${fmtDate(x.period_end)}` }, { h: 'Status', f: (x) => statusPill(x.status) },
        // From the database, not the 300 newest ledger lines the page holds.
        { h: 'Total', num: true, f: (x) => { const t = d.periodTotals.filter((r) => r.period_id === x.id); return t.length ? t.map((r) => formatMoney(r.amount_cents, r.currency)).join('<br>') : money(0); } },
        { h: 'Approved', f: (x) => (x.approved_at ? fmtTime(x.approved_at) : '—') },
        { h: '', f: (x) => `<div class="af-actions">${MANAGE && x.status === 'open' ? btn('Submit for approval', 'period-submit', { id: x.id }) : ''}${MONEY && x.status === 'under_review' ? btn('Approve', 'period-approve', { id: x.id }, 'primary', { confirm: true }) : ''}</div>` },
      ], d.periods, 'No periods yet. Without one, commission lines are still reviewed when a payout is approved.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Start', input('perStart', 'type="date"'))}${field('End', input('perEnd', 'type="date"'))}${btn('Open period', 'period-add')}</div>` : ''}`),
    card('Commission ledger', `${table([
      { h: 'When', f: (l) => fmtTime(l.created_at) }, { h: 'Affiliate', f: (l) => esc(d.affById[l.affiliate_id]?.display_name || '—') },
      { h: 'Kind', f: (l) => esc(l.kind.replace('_', ' ')) }, { h: 'Order', f: (l) => `<span class="af-mono">${esc(l.order_id || '—')}</span>` },
      { h: 'Base', num: true, f: (l) => formatMoney(l.basis_cents, l.currency) },
      { h: 'Rate', num: true, f: (l) => (l.rate_kind === 'percent_of_net' ? `${Number(l.rate_value)}%` : l.rate_kind ? formatMoney(l.rate_value, l.currency) : '—') },
      { h: 'Amount', num: true, f: (l) => formatMoney(l.amount_cents, l.currency) },
      { h: 'Memo', f: (l) => `<span class="af-evidence">${esc(l.memo || '')}</span>` },
    ], d.ledger, 'No commission lines yet.')}
    ${MONEY ? `<div class="af-row" style="margin-top:8px;">${field('Adjust affiliate', `<select class="bcn-field" id="adjAff">${d.affiliates.map((a) => `<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select>`)}${field(`Amount in ${esc(p.currency)} (negative to reduce)`, input('adjAmt', 'inputmode="decimal"'))}${field('Why (kept forever)', input('adjMemo'))}${btn('Add adjustment', 'adjust', {}, 'primary', { confirm: true })}</div>` : '<p class="af-muted">Manual adjustments need the same approval right as journal entries.</p>'}`, 'append-only'),
    ]),
  ].join('');
}

// ── Payouts ──────────────────────────────────────────────────────────────
function renderPayouts() {
  const d = S.d; const p = prog();
  const bal = d.balances.map((b) => ({ ...b, a: d.affById[b.affiliate_id] }));
  const act = (x) => {
    const b = [];
    if (MONEY && x.status === 'draft') b.push(btn('Approve', 'payout-approve', { id: x.id }, 'primary', { confirm: true }));
    if (MONEY && x.status === 'exported') b.push(`<input class="bcn-field" id="ref-${x.id}" placeholder="Payment reference" style="max-width:160px;" /><input class="bcn-field" id="pev-${x.id}" placeholder="Evidence: where it shows as paid" style="max-width:220px;" />`, btn('Record as paid', 'payout-paid', { id: x.id }, 'primary', { confirm: true }));
    if (MANAGE && x.status === 'exported' && x.export_batch_id) b.push(btn('Download again', 'payout-redownload', { batch: x.export_batch_id }));
    if (MANAGE && ['approved', 'exported', 'marked_paid'].includes(x.status)) b.push(btn('Tell affiliate', 'payout-notify', { id: x.id, aff: x.affiliate_id }));
    if (MONEY && ['draft', 'approved', 'exported'].includes(x.status)) b.push(`<input class="bcn-field" id="vr-${x.id}" placeholder="Reason to void" style="max-width:160px;" />`, btn('Void', 'payout-void', { id: x.id }, 'danger', { confirm: true }));
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const approved = d.payouts.filter((x) => x.status === 'approved');
  $('payoutsBody').innerHTML = [
    `<p class="af-muted">Pay from your bank or payment tool, then record it. Payable ${num(p.refund_hold_days)} days after the order.</p>`,
    card('Balances', table([
      { h: 'Affiliate', f: (r) => esc(r.a?.display_name || '—') }, { h: 'Currency', f: (r) => `<span class="af-mono">${esc(r.currency)}</span>` },
      { h: 'Earned', num: true, f: (r) => formatMoney(r.earned_cents, r.currency) }, { h: 'Refund corrections', num: true, f: (r) => formatMoney(r.refund_adjustment_cents, r.currency) },
      { h: 'In a payout', num: true, f: (r) => formatMoney(r.claimed_cents, r.currency) }, { h: 'Paid', num: true, f: (r) => formatMoney(r.paid_cents, r.currency) },
      { h: 'Not yet in a payout', num: true, f: (r) => formatMoney(r.unclaimed_cents, r.currency) },
      { h: '', f: (r) => (MANAGE && r.currency === p.currency ? btn('Build payout', 'payout-build', { aff: r.affiliate_id }) : '') },
    ], bal, 'Nothing earned yet.')),
    card('Payouts', `${table([
      { h: 'Created', f: (x) => fmtDate(x.created_at) }, { h: 'Affiliate', f: (x) => esc(d.affById[x.affiliate_id]?.display_name || '—') },
      { h: 'Amount', num: true, f: (x) => formatMoney(x.amount_cents, x.currency) }, { h: 'Lines', num: true, f: (x) => num(x.item_count) },
      { h: 'Status', f: (x) => `${statusPill(x.status)}${x.external_reference ? `<div class="af-muted">ref ${esc(x.external_reference)}</div>` : ''}${x.void_reason ? `<div class="af-muted">${esc(x.void_reason)}</div>` : ''}` },
      { h: '', f: act },
    ], d.payouts, 'No payouts yet.')}
    ${MANAGE && approved.length ? `<div class="af-row" style="margin-top:8px;">${btn(`Export ${approved.length} approved payout(s)`, 'payout-export', {}, 'primary', { confirm: true })}</div>` : ''}`),
  ].join('');
}

// ── Actions ──────────────────────────────────────────────────────────────
const outreachVars = (x) => {
  const p = prog();
  const owner = S.profiles.find((u) => u.id === p.owner_user_id);
  return {
    name: x.display_name || x.handle || 'there', brand: S.brand || p.name, program: p.name,
    platform: x.platform === 'web' || x.platform === 'blog' ? 'site' : `${x.platform} channel`,
    source: x.evidence?.domain ? `a search on ${x.evidence.domain}` : 'a search',
    commission: describeCommission({ kind: p.commission_kind, percent: p.commission_percent, fixed_cents: p.commission_fixed_cents, currency: p.currency }),
    sender: owner?.name || '',
  };
};

const A = {
  'new-program': () => { S.creating = true; S.tab = 'program'; render(); },
  'cancel-new': () => { S.creating = false; render(); },
  'save-program': async () => {
    const { row, errors } = readProgramForm();
    if (errors.length) throw new Error(errors.join(' '));
    if (S.creating) {
      const created = must(await db.from('affiliate_programs').insert({ ...row, company_entity_id: CO, created_by: me.id }).select('id').single());
      S.creating = false; S.programId = created.id;
      return 'Program created.';
    }
    await updateRows('affiliate_programs', { ...row, changed_by: me.id }, { id: S.programId });
    return 'Saved.';
  },
  'add-manager': async () => {
    if (!val('mgrUser')) throw new Error('Pick a person.');
    must(await db.from('affiliate_program_managers').insert({ company_entity_id: CO, user_id: val('mgrUser'), granted_by: me.id }));
    return 'Access granted.';
  },
  'remove-manager': async ({ id }) => { const r = must(await db.from('affiliate_program_managers').delete().eq('id', id).eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Only an owner or executive can remove access.'); return 'Access removed.'; },
  'prospect-filter': ({ f }) => { S.prospectFilter = f; render(); },
  'go-tab': ({ t }) => { S.tab = t; S.creating = false; render(); },
  'prospect-status': async ({ id, s }) => {
    await updateRows('affiliate_prospects', { status: s, reviewed_by: me.id, reviewed_at: new Date().toISOString(), changed_by: me.id }, { id });
    if (s !== 'approved') return `Creator ${s}.`;
    // Approving drafts the message, unless one is already in progress.
    const live = S.d.drafts.some((x) => x.prospect_id === id && ['draft', 'approved', 'exported'].includes(x.state));
    if (!live) { await A['draft-create']({ id }); S.tab = 'prospects'; }
    return live ? 'Creator approved.' : 'Creator approved. Their message is drafted on the Messages tab.';
  },
  'prospect-suppress': async ({ id }) => {
    const x = S.d.prospectById[id];
    const rows = [];
    if (x.contact_email) rows.push({ kind: 'email', value_normalized: x.contact_email });
    if (x.profile_url) rows.push({ kind: 'profile_url', value_normalized: x.profile_url });
    else if (x.handle) rows.push({ kind: 'handle', value_normalized: x.handle });
    for (const r of rows) {
      const { error } = await db.from('affiliate_suppressions').insert({ ...r, company_entity_id: CO, reason: 'do_not_contact', source: 'affiliate_studio', created_by: me.id });
      if (error && error.code !== '23505') throw error;
    }
    await updateRows('affiliate_prospects', { status: 'suppressed', reviewed_by: me.id, reviewed_at: new Date().toISOString() }, { id });
    return 'Added to the do-not-contact list.';
  },
  'prospect-add': async () => {
    const url = val('mpUrl'); const handle = val('mpHandle');
    if (!url && !handle) throw new Error('A handle or a profile URL is needed to tell creators apart.');
    if (val('mpEmail') && !val('mpEmail').includes('@')) throw new Error('That email address is not valid.');
    must(await db.from('affiliate_prospects').insert({
      company_entity_id: CO, program_id: S.programId, display_name: val('mpName') || handle || url, platform: val('mpPlat'),
      handle: handle || null, profile_url: url || null, contact_email: val('mpEmail') || null,
      source: 'manual', source_url: val('mpSource') || null, evidence: { note: val('mpNote') || null, entered_by: me.email || me.id }, created_by: me.id,
    }));
    return 'Prospect added.';
  },
  'source-add': async () => {
    if (!val('srcQuery')) throw new Error('Type what to search for.');
    const added = must(await db.from('affiliate_prospect_sources').insert({
      company_entity_id: CO, program_id: S.programId, kind: 'serp_query', query: val('srcQuery'), platform_hint: val('srcPlat') || null,
      location_code: Number(val('srcLoc')) || null, language_code: val('srcLang') || null, max_results: Number(val('srcMax')) || 30, created_by: me.id,
    }).select('id').single());
    return added ? 'Search saved. Find creators will check it on every run.' : 'Search saved.';
  },
  'research-run': async () => {
    const out = await invoke('affiliate-research', { action: 'research', program_id: S.programId, focus: $('rsFocus')?.value || '', count: Number(val('rsCount')) || 25 });
    watchResearch(out.run_id);
    return 'Research started. It takes a few minutes; new creators appear in Prospects when it finishes.';
  },
  'import-run': async () => {
    const file = $('impFile')?.files?.[0];
    if (!file) throw new Error('Choose a CSV file first.');
    if (file.size > 5_000_000) throw new Error('That file is too large. Split it into files under 5 MB.');
    const rows = parseCsv(await file.text());
    if (!rows.length) throw new Error('The file has no rows under its header.');
    const t = { kept: 0, prospects_new: 0, prospects_updated: 0, skipped_minors: 0, skipped_not_profile: 0, suppressed_skipped: 0 };
    const parts = chunk(rows, 200); // each part is one request, well inside the function's time limit
    for (const [i, part] of parts.entries()) {
      if (parts.length > 1) setStatus(`Importing part ${i + 1} of ${parts.length}…`, 'info');
      const o = await invoke('affiliate-research', { action: 'import', program_id: S.programId, rows: part });
      for (const k of Object.keys(t)) t[k] += Number(o[k]) || 0;
    }
    return `Imported ${num(t.kept)} creator(s): ${num(t.prospects_new)} new, ${num(t.prospects_updated)} updated.`
      + `${t.skipped_minors ? ` ${num(t.skipped_minors)} skipped as likely minors.` : ''}`
      + `${t.skipped_not_profile ? ` ${num(t.skipped_not_profile)} had no profile link.` : ''}`
      + `${t.suppressed_skipped ? ` ${num(t.suppressed_skipped)} are on the do-not-contact list.` : ''}`;
  },
  'source-toggle': async ({ id, on }) => { await updateRows('affiliate_prospect_sources', { enabled: on === '1' }, { id }); return on === '1' ? 'Search resumed.' : 'Search paused.'; },
  'suppression-add': async () => {
    if (!val('supVal')) throw new Error('Type the address, domain, handle or URL.');
    must(await db.from('affiliate_suppressions').insert({ company_entity_id: CO, kind: val('supKind'), value_normalized: val('supVal'), reason: val('supReason'), source: 'affiliate_studio', created_by: me.id }));
    return 'Added to the do-not-contact list.';
  },
  'suppression-remove': async ({ id }) => { const r = must(await db.from('affiliate_suppressions').delete().eq('id', id).eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Only an Affiliate Studio manager can remove an entry.'); return 'Removed.'; },
  'signup-link': async ({ id }) => {
    const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: id });
    S.flash = { el: 'signupOut', html: card('Signup link (send it yourself)', `<p>Personal to this person, valid until ${fmtTime(out.expires_at)}. SILO has not sent it. Making a new one cancels this one.</p><div class="bcn-field af-mono af-copy">${esc(out.signup_url)}</div>`) };
    return 'Signup link created.';
  },
  'draft-create': async ({ id }) => {
    const x = S.d.prospectById[id]; const vars = outreachVars(x);
    must(await db.from('affiliate_outreach_drafts').insert({
      company_entity_id: CO, program_id: S.programId, prospect_id: id, channel: x.contact_email ? 'email' : 'dm',
      recipient_email: x.contact_email || null, recipient_handle: x.contact_email ? null : (x.handle || x.profile_url),
      subject: fillTemplate(DEFAULT_OUTREACH.subject, vars), body: fillTemplate(DEFAULT_OUTREACH.body, vars), created_by: me.id,
    }));
    S.tab = 'outreach';
    return 'Draft created. Review it on the Outreach tab.';
  },
  'draft-edit': ({ id }) => { S.editDraft = id; render(); },
  'draft-edit-close': () => { S.editDraft = null; render(); },
  'draft-save': async ({ id }) => { await updateRows('affiliate_outreach_drafts', { subject: val('edSubject'), body: $('edBody').value, changed_by: me.id, updated_at: new Date().toISOString() }, { id, state: 'draft' }); S.editDraft = null; return 'Saved.'; },
  'draft-delete': async ({ id }) => { const r = must(await db.from('affiliate_outreach_drafts').delete().eq('id', id).eq('state', 'draft').eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Not deleted: only a draft can be deleted, by a manager.'); return 'Deleted.'; },
  'draft-approve': async ({ id }) => { await updateRows('affiliate_outreach_drafts', { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, { id, state: 'draft' }); return 'Approved.'; },
  'draft-sent': async ({ id }) => {
    const ev = val(`ev-${id}`);
    if (!ev) throw new Error('Say where it was sent from, such as a sent-folder link.');
    await updateRows('affiliate_outreach_drafts', { state: 'sent', sent_marked_by: me.id, sent_marked_at: new Date().toISOString(), sent_evidence: ev }, { id, state: 'exported' });
    return 'Marked sent.';
  },
  'draft-outcome': async ({ id, s }) => { await updateRows('affiliate_outreach_drafts', { state: s }, { id, state: 'sent' }); return `Recorded: ${s}.`; },
  'draft-optout': async ({ id }) => {
    const x = S.d.drafts.find((r) => r.id === id);
    await A['prospect-suppress']({ id: x.prospect_id });
    await updateRows('affiliate_outreach_drafts', { state: 'declined', outcome_note: 'asked not to be contacted' }, { id });
    return 'Recorded, and added to the do-not-contact list.';
  },
  'outreach-export': async () => {
    const drafts = S.d.drafts.filter((x) => x.state === 'approved').slice(0, 200);
    const links = {};
    for (const x of drafts) {
      if (!x.recipient_email) { links[x.id] = { error: 'No email address, so no personal link. Send the open-application link, or add their email first.' }; continue; }
      try { const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: x.prospect_id }); links[x.id] = { url: out.signup_url, expires_at: out.expires_at }; }
      catch (e) { links[x.id] = { error: friendly(e) }; }
    }
    const csv = toCsv(OUTREACH_HEADER, outreachRows(drafts, links));
    const fingerprint = await sha256Hex(csv);
    const now = new Date().toISOString();
    const batch = must(await db.from('affiliate_outreach_batches').insert({ company_entity_id: CO, program_id: S.programId, channel: 'email', row_count: drafts.length, exported_at: now, exported_by: me.id, fingerprint, created_by: me.id }).select('id').single());
    // The file is downloaded before the drafts move, so a failure below
    // still leaves the person holding the links that were just created.
    download(`outreach-${prog().slug}-${now.slice(0, 10)}.csv`, csv);
    await updateRows('affiliate_outreach_drafts', { state: 'exported', batch_id: batch.id, exported_at: now }, { id: drafts.map((x) => x.id), state: 'approved' });
    const missing = Object.values(links).filter((l) => l.error).length;
    return `Exported ${drafts.length}. ${missing ? `${missing} have no personal link; the file says why.` : ''} Send them, then mark each one sent.`;
  },
  'portal-link': async ({ id }) => {
    const out = await invoke('affiliate-invite', { action: 'portal_link', affiliate_id: id, email: true });
    S.flash = { el: 'affOut', html: card('Portal link', `<p>${out.email === 'sent' ? 'Emailed to the affiliate.' : `Not emailed (${esc(out.reason || out.email)}). Send it yourself.`} Valid until ${fmtTime(out.expires_at)}.</p><div class="bcn-field af-mono af-copy">${esc(out.portal_url)}</div>`) };
    return 'Portal link created.';
  },
  'notify-codes': async ({ id }) => { const out = await invoke('affiliate-invite', { action: 'notify', affiliate_id: id, kind: 'codes_and_links' }); return out.email === 'sent' ? 'Emailed.' : `Not emailed: ${out.reason || out.email}.`; },
  'affiliate-status': async ({ id, s }) => { await updateRows('affiliates', { status: s, changed_by: me.id }, { id }); return `Affiliate ${s}.`; },
  'code-add': async () => {
    if (!val('cAff') || !val('cCode')) throw new Error('Pick an affiliate and type the code.');
    const ai = val('cHow') === 'ai';
    const pct = Number(val('cPct'));
    if (ai && !(pct > 0 && pct <= 100)) throw new Error('Type the percent off your AI should give, from 1 to 100.');
    must(await db.from('affiliate_codes').insert({ company_entity_id: CO, program_id: S.programId, affiliate_id: val('cAff'), code: val('cCode'), starts_on: val('cStart') || today(), ends_on: val('cEnd') || null, created_by: me.id,
      ...(ai ? { status: 'pending', discount_percent: pct } : {}) }));
    return ai ? 'Code saved. Ask your AI to create your waiting SILO affiliate codes in Shopify.' : 'Code added. It is credited from the next “Match orders” run.';
  },
  'feed-add': async ({ kind, src, p }) => {
    const x = JSON.parse(p || '{}');
    // An ad's picture is private to the company; sharing copies exactly that
    // file to the public feed bucket, at the same path, so affiliates see it.
    if (x.image_path) x.image_url = await publishAdImage(x.image_path);
    must(await db.from('affiliate_feed_items').insert({ company_entity_id: CO, program_id: S.programId, kind, source_id: String(src),
      title: String(x.title || '').slice(0, 200), note: x.note || null, image_url: x.image_url || null, product_path: x.product_path || null, event_on: x.event_on || null }));
    return 'Shared. It shows in your affiliates\' portal now.';
  },
  'feed-remove': async ({ id }) => {
    const { data, error } = await db.from('affiliate_feed_items').delete().eq('id', id).select();
    if (error) throw error;
    if (!data?.length) throw new Error('Not removed: your account may no longer manage this program.');
    return 'No longer shared.';
  },
  'store-save': async () => {
    const v = val('storeUrl').toLowerCase().replace(/\/+$/, '');
    if (v && !/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) throw new Error('Use your store address only, like https://yourstore.com');
    await updateRows('affiliate_programs', { store_url: v || null, changed_by: me.id }, { id: S.programId });
    return 'Store address saved.';
  },
  'prod-search': async () => {
    const q = val('prodQ');
    S.share.q = q;
    if (!q) { S.share.products = []; renderShare(); return; }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { data, error } = await db.from('products_master').select('product_title, product_type, image_url, shopify_handle')
      .eq('company_entity_id', CO).ilike('product_title', like).not('shopify_handle', 'is', null).limit(120);
    if (error) throw error;
    const seen = new Set();
    S.share.products = (data || []).filter((x) => /^[A-Za-z0-9_.-]+$/.test(x.shopify_handle || '') && !seen.has(x.shopify_handle) && seen.add(x.shopify_handle)).slice(0, 30);
    renderShare();
  },
  'copy-codes-prompt': async () => {
    try { await navigator.clipboard.writeText(CODES_PROMPT); } catch { setStatus(CODES_PROMPT, 'info'); return null; }
    return 'Copied. Paste it into your AI, or set it as a daily task there.';
  },
  'code-retire': async ({ id }) => { const was = S.d.codes.find((c) => c.id === id)?.status; await updateRows('affiliate_codes', { status: 'retired', changed_by: me.id }, { id }); return was === 'pending' ? 'Code cancelled.' : 'Code retired.'; },
  'link-add': async () => {
    const dest = val('lDest');
    if (!/^https:\/\//i.test(dest)) throw new Error('The page must start with https://');
    must(await db.from('affiliate_links').insert({ company_entity_id: CO, program_id: S.programId, affiliate_id: val('lAff'), slug: val('lSlug'), destination_url: dest, utm_source: 'affiliate', utm_medium: 'affiliate', utm_campaign: val('lCamp') || null, starts_on: today(), created_by: me.id }));
    return 'Link added.';
  },
  'update-commissions': async () => {
    const m = await A.resolve(); const runOut = S.flash?.html || '';
    await A.accrue(); S.flash = { el: 'runOut', html: runOut + (S.flash?.html || '') };
    return 'Commissions updated.';
  },
  resolve: async () => {
    S.rangeFrom = val('rFrom'); S.rangeTo = val('rTo');
    const r = must(await db.rpc('affiliate_resolve_attributions', { p_program: S.programId, p_from: S.rangeFrom, p_to: S.rangeTo }));
    const parts = Object.entries(r.by_basis || {}).map(([k, v]) => `${basisLabel(k)}: ${v}`);
    S.flash = { el: 'runOut', html: `<p>${num(r.rows_written)} order(s) recorded${r.conflict_other_program ? `, ${num(r.conflict_other_program)} skipped because another program already credits them` : ''}. ${esc(parts.join('; '))}</p>` };
    return 'Orders matched.';
  },
  accrue: async () => {
    S.rangeFrom = val('rFrom'); S.rangeTo = val('rTo');
    const r = must(await db.rpc('affiliate_accrue_commissions', { p_program: S.programId, p_from: S.rangeFrom, p_to: S.rangeTo, p_period: val('rPeriod') || null }));
    S.flash = { el: 'runOut', html: `<p>${num(r.entries_accrued)} new line(s), ${num(r.entries_reduced)} correction(s), ${num(r.unchanged)} unchanged. Net ${money(r.net_amount_cents)}. Skipped: ${num(r.skipped_inactive_affiliate)} for an affiliate who is not active, ${num(r.skipped_unknown_base)} with refunds not yet measured.</p>` };
    return 'Commissions calculated.';
  },
  'period-add': async () => { must(await db.from('affiliate_commission_periods').insert({ company_entity_id: CO, program_id: S.programId, period_start: val('perStart'), period_end: val('perEnd'), created_by: me.id })); return 'Period opened.'; },
  'period-submit': async ({ id }) => { must(await db.rpc('affiliate_submit_period', { p_period: id })); return 'Submitted for approval.'; },
  'period-approve': async ({ id }) => { must(await db.rpc('affiliate_approve_period', { p_period: id })); return 'Period approved.'; },
  adjust: async () => {
    const cents = parseMajorToMinor(val('adjAmt'), prog().currency);
    if (!cents || Number.isNaN(cents)) throw new Error('Enter a non-zero amount.');
    if (!val('adjMemo')) throw new Error('Say why. The reason is kept with the line forever.');
    must(await db.from('affiliate_commission_ledger').insert({ company_entity_id: CO, program_id: S.programId, affiliate_id: val('adjAff'), kind: 'manual_adjustment', source: 'manual', amount_cents: cents, currency: prog().currency, memo: val('adjMemo'), created_by: me.id }));
    return 'Adjustment added.';
  },
  'payout-build': async ({ aff }) => { must(await db.rpc('affiliate_build_payout', { p_affiliate: aff, p_through: null })); return 'Draft payout built. It needs approval.'; },
  'payout-approve': async ({ id }) => { must(await db.rpc('affiliate_approve_payout', { p_payout: id })); return 'Payout approved.'; },
  // The claim comes first: the database moves the approved payouts to
  // exported under one batch, under the program's money lock, and returns
  // exactly what it claimed. The file is built from that answer, so a payout
  // approved, voided or exported elsewhere in the meantime can never be in a
  // file without being marked, or marked without being in a file.
  // Everything the file needs is captured BEFORE the first await: switching
  // program while the claim is in flight must not label program A's payouts
  // with program B's name and affiliates (review cycle 2).
  'payout-export': async () => {
    const programId = S.programId; const slug = prog().slug; const affById = S.d.affById;
    const ids = S.d.payouts.filter((x) => x.status === 'approved').map((x) => x.id);
    const r = must(await db.rpc('affiliate_claim_payout_export', { p_program: programId, p_payouts: ids, p_batch: null }));
    const csv = toCsv(PAYOUT_HEADER, payoutRows(r.payouts || [], affById));
    download(`payouts-${slug}-${today()}.csv`, csv);
    const skipped = (r.skipped || []).length;
    const done = `Exported ${(r.payouts || []).length}${skipped ? ` (${skipped} changed since the page loaded and were left out)` : ''}. Pay them in your own system, then record each reference.`;
    // The payouts are already exported and the file is downloaded; a missing
    // fingerprint only loses the file's checksum, so say so rather than fail.
    try { must(await db.rpc('affiliate_set_payout_export_fingerprint', { p_batch: r.batch_id, p_fingerprint: await sha256Hex(csv) })); } catch (e) { return `${done} The file's checksum was not saved (${e.message}).`; }
    return done;
  },
  // Download a claimed export again (a lost or blocked download). Nothing is
  // re-marked; the payouts still waiting to be paid in that batch come back.
  'payout-redownload': async ({ batch }) => {
    const programId = S.programId; const slug = prog().slug; const affById = S.d.affById;
    const r = must(await db.rpc('affiliate_claim_payout_export', { p_program: programId, p_payouts: null, p_batch: batch }));
    download(`payouts-${slug}-${today()}-again.csv`, toCsv(PAYOUT_HEADER, payoutRows(r.payouts || [], affById)));
    return `Downloaded ${(r.payouts || []).length} again. Nothing was changed.`;
  },
  'payout-paid': async ({ id }) => {
    if (!val(`ref-${id}`) || !val(`pev-${id}`)) throw new Error('Enter the payment reference and where it shows as paid.');
    must(await db.rpc('affiliate_mark_payout_paid', { p_payout: id, p_external_reference: val(`ref-${id}`), p_evidence: val(`pev-${id}`) }));
    return 'Recorded as paid.';
  },
  'payout-void': async ({ id }) => {
    if (!val(`vr-${id}`)) throw new Error('Say why it is being voided.');
    must(await db.rpc('affiliate_void_payout', { p_payout: id, p_reason: val(`vr-${id}`) }));
    return 'Payout voided. Its lines can be paid again in a new payout.';
  },
  'payout-notify': async ({ id, aff }) => { const out = await invoke('affiliate-invite', { action: 'notify', affiliate_id: aff, kind: 'payout_status', payout_id: id }); return out.email === 'sent' ? 'Affiliate emailed.' : `Not emailed: ${out.reason || out.email}.`; },
};

// Two-click confirm for anything that cannot be quietly undone: the first
// click arms the button for four seconds.
document.addEventListener('click', async (ev) => {
  const tab = ev.target.closest('#tabs [data-tab]');
  if (tab) { S.tab = tab.dataset.tab; S.creating = false; render(); return; }
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.confirm && !b.dataset.armed) {
    b.dataset.armed = '1'; const label = b.textContent; b.textContent = 'Click again to confirm';
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
    return;
  }
  const fn = A[b.dataset.act]; if (!fn) return;
  b.disabled = true;
  try {
    const msg = await fn({ ...b.dataset });
    if (typeof msg === 'string') {
      setStatus(msg, 'pos', 5000);
      await reload();
      if (S.flash) { const el = $(S.flash.el); if (el) el.innerHTML = S.flash.html; S.flash = null; }
    }
  } catch (e) {
    setStatus(friendly(e), 'neg');
  } finally { b.disabled = false; }
});
$('programSel').addEventListener('change', async (e) => { S.programId = e.target.value; S.creating = false; await loadProgramData(); render(); });
$('btnNewProgram').addEventListener('click', () => A['new-program']());

try {
  const { data: ent } = await db.from('entities').select('title').eq('id', CO).maybeSingle();
  S.brand = ent?.title || '';
  await ensureProfiles();
  await reload();
  if (!S.programs.length && MANAGE) { S.creating = true; S.tab = 'program'; render(); }
} catch (e) {
  setStatus(friendly(e), 'neg');
}
