// Affiliate Studio staff page. Every read is the caller's own session under
// RLS; every write is either a plain row write the policies allow, or one of
// the gated SECURITY DEFINER functions, which re-check the caller. Nothing in
// this file is a permission: hiding a button is convenience, the database
// decides. Pure logic (money, CSV, validation, labels) is in studio-core.js.
import {
  formatMoney, minorUnits, parseMajorToMinor, describeCommission, basisLabel, BASIS_LABELS, validateProgram, slugify,
  toCsv, fillTemplate, DEFAULT_OUTREACH, OUTREACH_HEADER, outreachRows, sha256Hex, PAYOUT_HEADER, payoutRows,
  linkUrl, affiliateLink, storeLinkFor, applyUrl, stageLabels, safeHref, SEARCH_COUNTRIES, SEARCH_LANGUAGES, countryName, languageName, friendlySearchError,
  parseCsv, chunk, runKindLabel, followersFrom, prospectPhotoUrl, sourceLabel,
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
const card = (title, body, meta = '', extraClass = '') => `<div class="bcn-card${extraClass ? ` ${extraClass}` : ''}"><div class="bcn-card-header"><h2>${esc(title)}</h2>${meta ? `<span class="bcn-card-meta">${meta}</span>` : ''}</div><div class="bcn-card-body">${body}</div></div>`;
const empty = (t) => `<div class="bcn-empty">${esc(t)}</div>`;
function table(cols, rows, emptyText = 'Nothing here yet.') {
  if (!rows.length) return empty(emptyText);
  return `<div class="af-scroll"><table class="bcn-table"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="af-num"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="af-num"' : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function itemList(rows, renderRow, emptyText = 'Nothing here yet.', layout = 'stack') {
  if (!rows.length) return empty(emptyText);
  const cls = layout === 'grid' ? 'af-items af-items--grid' : 'af-items';
  return `<div class="${cls}" role="list">${rows.map(renderRow).join('')}</div>`;
}
function personAvatar(person, size = 'lg') {
  const g = globalThis.SiloAvatar;
  if (g?.html) return g.html(person, size, 'af-item-avatar');
  const n = String(person?.name || person?.display_name || '').trim();
  const e = String(person?.email || person?.contact_email || '').trim();
  const ch = (n ? n[0] : e ? e[0] : '?').toUpperCase();
  return `<span class="af-avatar" aria-hidden="true">${esc(ch)}</span>`;
}
// Initials, with the creator's photo laid over them when research found one.
// A photo that no longer loads (platform photo links expire) is removed, so
// the initials show again.
function photoAvatar(person, evidence) {
  const photo = prospectPhotoUrl(evidence);
  return personAvatar(person, 'lg') + (photo ? `<img class="af-avatar-photo" src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
}
document.addEventListener('error', (ev) => { if (ev.target?.classList?.contains('af-avatar-photo')) ev.target.remove(); }, true);
function evidenceSummary(x, max = 160) {
  const e = x?.evidence || {};
  const t = String(e.snippet || e.note || e.pitch || e.title || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'No fit notes yet.';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
function catalogStatBar(pct) {
  const w = Math.max(8, Math.min(100, Number(pct) || 0));
  return `<span class="af-catalog-bar" aria-hidden="true"><span class="af-catalog-bar-fill" style="width:${w}%"></span></span>`;
}
const btn = (label, act, data = {}, kind = 'surface', opts = {}) => {
  const mod = kind === 'surface' ? '' : ` bcn-btn--${kind}`;
  return `<button class="bcn-btn${mod}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}${opts.confirm ? ' data-confirm="1"' : ''}${opts.disabled ? ' disabled' : ''}>${esc(label)}</button>`;
};
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
  renderPipeline();
  renderAiHub();
  if (!p && S.tab !== 'program') {
    $(`${S.tab}Body`).innerHTML = card('Start here', `<p>No affiliate program exists for this company yet.</p>${MANAGE ? btn('Create a program', 'new-program', {}, 'primary') : '<p class="af-muted">Ask someone with Affiliate Studio access to create one.</p>'}`);
    return;
  }
  ({ program: renderProgram, prospects: renderProspects, outreach: renderOutreach, affiliates: renderAffiliates, share: renderShare, payouts: () => { renderPayouts(); renderCommissions(); } })[S.tab]();
}

function renderKpis() {
  const el = $('kpis');
  const h = S.d?.health;
  const p = prog();
  // The workflow rail carries counts when a program is loaded; skip the extra KPI band.
  if (h && p) {
    el.innerHTML = '';
    el.classList.add('af-kpis-off');
    return;
  }
  el.classList.remove('af-kpis-off');
  const k = (label, v) => `<div class="bcn-kpi"><div class="bcn-kpi-label">${esc(label)}</div><div class="bcn-kpi-value">${v}</div></div>`;
  el.innerHTML = k('Programs', num(S.programs.length));
}

// ── To do ────────────────────────────────────────────────────────────────
// Everything waiting on a person, in one list. What runs by itself is said
// once, under it: joining queues a code, your AI creates it, the rep is
// emailed when it goes live, and commissions update every night.
const HOW_IT_WORKS = 'You approve creators and messages. Your AI sends them and creates codes. Reps get their code by email when it goes live, and commissions update every night. You approve payouts.';
function todoItems() {
  const d = S.d; const p = prog(); if (!d || !p) return [];
  const h = d.health || {};
  const items = [];
  const add = (n, text, tab, extra = '') => { if (n) items.push({ text, tab, extra }); };
  add(p.status !== 'active', `The program is ${p.status}. Set it to active in Settings to start recruiting.`, 'program');
  add(!p.terms_markdown, 'Write your program terms in Settings. Affiliates accept them to join.', 'program');
  add(Number(h.prospects_new || 0), `${num(h.prospects_new)} creator(s) waiting for your review.`, 'prospects');
  const drafts = d.drafts.filter((x) => x.state === 'draft').length;
  add(drafts, `${num(drafts)} message(s) to approve.`, 'outreach');
  add(Number(h.outreach_approved || 0), `${num(h.outreach_approved)} approved message(s) waiting for your MCP agent to send.`, 'outreach', MANAGE ? btn('Copy prompt', 'copy-send-prompt', {}, 'surface') : '');
  add(Number(h.outreach_exported || 0), `${num(h.outreach_exported)} sent message(s) to mark as sent.`, 'outreach');
  const pending = d.codes.filter((c) => c.status === 'pending').length;
  add(pending, `${num(pending)} code(s) waiting for your MCP agent to create in Shopify.`, 'affiliates', MANAGE ? btn('Copy prompt', 'copy-codes-prompt', {}, 'surface') : '');
  const coded = new Set(d.codes.filter((c) => c.status !== 'retired').map((c) => c.affiliate_id));
  const codeless = d.affiliates.filter((a) => a.status === 'active' && !coded.has(a.id)).length;
  add(codeless, `${num(codeless)} affiliate(s) without a code. Add one.`, 'affiliates');
  add(Number(h.codes_never_seen || 0), `${num(h.codes_never_seen)} code(s) have never appeared on an order. Check each exists in Shopify with the same spelling.`, 'affiliates');
  const unattributed = (h.attributions_ambiguous || 0) + (h.attributions_multi_code_refused || 0) + (h.attributions_outside_window || 0) + (h.attributions_currency_mismatch || 0) + (h.attributions_refunds_unmeasured || 0);
  add(unattributed, `${num(unattributed)} order(s) with an affiliate code were not credited. Open Pay → Commissions and orders.`, 'payouts');
  const owed = (d.balances || []).filter((x) => x.currency === p.currency && Number(x.unclaimed_cents) > 0).length;
  add(MANAGE && owed, `${num(owed)} affiliate(s) with earnings to put in a payout.`, 'payouts');
  const toApprove = d.payouts.filter((x) => x.status === 'draft').length;
  add(MONEY && toApprove, `${num(toApprove)} payout(s) to approve.`, 'payouts');
  if (!items.length && !d.prospects.length) items.push({ text: 'Find your first creators: describe who you want and press Find creators.', tab: 'prospects', extra: '' });
  return items;
}
function renderNextStep() {
  const el = $('nextStep'); if (!el) return;
  if (!S.d || !prog()) { el.hidden = true; return; }
  const items = todoItems();
  el.hidden = false;
  const tabLabel = { program: 'Settings', prospects: 'Find', outreach: 'Messages', affiliates: 'Affiliates', share: 'Share', payouts: 'Pay' };
  const rows = items.map((x, i) => {
    const go = x.tab !== S.tab ? btn(`Go to ${tabLabel[x.tab] || x.tab}`, 'go-tab', { t: x.tab }, i === 0 ? 'primary' : 'surface') : '';
    return `<li class="af-todo-item"><span class="af-todo-text">${esc(x.text)}</span><div class="af-todo-acts">${x.extra || ''}${go}</div></li>`;
  }).join('');
  el.innerHTML = `<header class="af-todo-head"><h2 class="af-todo-title">To do</h2>${items.length ? pill(String(items.length), 'accent') : ''}</header>`
    + (rows ? `<ul class="af-todo">${rows}</ul>` : '<p class="af-muted af-todo-none">Nothing waiting on you.</p>')
    + `<details class="af-todo-how"><summary>What runs on its own</summary><p class="af-todo-how-body">${esc(HOW_IT_WORKS)}</p></details>`;
}
function renderPipeline() {
  const el = $('afPipeline');
  if (!el) return;
  const p = prog();
  const h = S.d?.health;
  if (!p || !h) { el.hidden = true; return; }
  const d = S.d;
  const msgN = Number(h.outreach_approved || 0) + Number(h.outreach_exported || 0) + d.drafts.filter((x) => x.state === 'draft').length;
  const payN = (d.balances || []).filter((b) => b.currency === p.currency && Number(b.unclaimed_cents) > 0).length;
  const onboardN = Number(h.codes_never_seen || 0) + d.codes.filter((c) => c.status === 'pending').length;
  const steps = [
    { t: 'prospects', label: 'Find', n: Number(h.prospects_new || 0) },
    { t: 'outreach', label: 'Message', n: msgN },
    { t: 'affiliates', label: 'Onboard', n: onboardN },
    { t: 'share', label: 'Share', n: 0, mute: true },
    { t: 'payouts', label: 'Pay', n: payN },
  ];
  el.hidden = false;
  el.innerHTML = steps.map((s) => {
    const on = S.tab === s.t;
    const badge = s.n > 0 && !s.mute ? `<span class="af-pipe-count">${num(s.n)}</span>` : '';
    return `<button type="button" class="af-pipe-step${on ? ' af-pipe-step--on' : ''}" data-act="go-tab" data-t="${s.t}" aria-current="${on ? 'step' : 'false'}"><span class="af-pipe-label">${esc(s.label)}</span>${badge}</button>`;
  }).join('');
}
function aiEnabledRow(label, apps, enabled, waiting) {
  const state = apps === null ? pill('Unknown', '') : enabled ? pill('Allowed', 'pos') : pill('Not allowed', '');
  const wait = waiting ? `<span class="af-wait">${num(waiting)} waiting</span>` : '';
  return `<div class="af-ai-status-row"><span>${esc(label)}</span>${state}${wait}</div>`;
}
function aiHubIntro(canSend, canCode) {
  if (canSend && canCode) {
    return 'Approve in Studio, then run agent prompts in whatever MCP client you use. SILO can hand off work your connection allows.';
  }
  return 'Connect SILO MCP for this company and allow send outreach and Shopify codes on that connection.';
}
const AI_HUB_SCOPE_NOTE = 'Allowed = you ticked it on your SILO connection. SILO does not see Shopify, Gmail, or other MCPs in your agent.';
function renderAiHub() {
  const el = $('afAiHub');
  if (!el) return;
  if (!MANAGE || !prog() || !S.d) { el.hidden = true; return; }
  const apps = S.d.aiApps;
  const canSend = (apps || []).some((a) => a.canSend);
  const canCode = (apps || []).some((a) => a.canCode);
  const approvedMsgs = S.d.drafts.filter((x) => x.state === 'approved').length;
  const pendingCodes = S.d.codes.filter((c) => c.status === 'pending').length;
  const connectPrimary = apps !== null && !canSend && !canCode;
  const workSend = canSend && approvedMsgs > 0;
  const workCodes = canCode && pendingCodes > 0;
  const copyBtns = [
    workSend ? btn('Copy send prompt', 'copy-send-prompt', {}, workSend && !workCodes ? 'primary' : 'surface') : '',
    workCodes ? btn('Copy codes prompt', 'copy-codes-prompt', {}, workCodes && !workSend ? 'primary' : 'surface') : '',
  ].filter(Boolean).join('');
  const hintLines = [
    !workSend ? `<p class="af-muted"><strong>Send:</strong> ${esc(SEND_PROMPT_HINT)}</p>` : '',
    !workCodes ? `<p class="af-muted"><strong>Codes:</strong> ${esc(CODES_PROMPT_HINT)}</p>` : '',
    connectPrimary ? '<p class="af-muted">Pick this company in the workspace, then allow send outreach and create Shopify codes on the connection.</p>' : '',
    !workSend && !workCodes && (canSend || canCode)
      ? `<div class="af-ai-actions af-ai-actions--tight">${btn('Copy send prompt', 'copy-send-prompt', {}, 'surface')}${btn('Copy codes prompt', 'copy-codes-prompt', {}, 'surface')}</div>`
      : '',
  ].filter(Boolean).join('');
  const hintSummary = 'Agent prompts';
  const hints = hintLines
    ? `<details class="af-ai-hint"><summary>${hintSummary}</summary><div class="af-ai-hint-body">${hintLines}</div></details>`
    : '';
  const manageKind = connectPrimary ? 'primary' : '';
  el.hidden = false;
  el.innerHTML = card('Your AI', `
    <p class="af-muted" style="margin:0;">${esc(aiHubIntro(canSend, canCode))}</p>
    <div class="af-ai-status">
      ${aiEnabledRow('Send outreach', apps, canSend, approvedMsgs)}
      ${aiEnabledRow('Create Shopify codes', apps, canCode, pendingCodes)}
    </div>
    <p class="af-muted af-ai-note">${esc(AI_HUB_SCOPE_NOTE)}</p>
    <div class="af-ai-foot">
      <div class="af-ai-actions">
        ${copyBtns}
        <a class="bcn-btn${manageKind ? ` bcn-btn--${manageKind}` : ''}" href="../settings-connect-ai.html">${connectPrimary ? 'Connect your AI' : 'Manage connections'}</a>
        ${hints}
      </div>
    </div>`, 'SILO MCP');
}
function stageCard() {
  const d = S.d;
  const labels = stageLabels({ discoveryRuns: d.runs, notifications: d.notifications, codesSeen: d.codes.filter((c) => c.verified_at).length, ledgerEntries: d.ledgerCount, sources: d.sources.length });
  const row = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.stage)} <span class="af-stage af-label-${esc(r.label.replace(' ', '-'))}">${esc(r.label)}</span></div><div class="af-muted">${esc(r.detail)}</div></div></article>`;
  return card('How each part works for this company', itemList(labels, row, 'Nothing to report yet.'), 'verified = SILO has seen it work here');
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

// The automatic first code exists once 20261110180000 is applied (the
// program rows then carry the column).
const hasAutoCode = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'default_discount_percent'));
const settingsBlock = (title, inner) => `<section class="af-settings-block"><h3 class="af-settings-title">${esc(title)}</h3>${inner}</section>`;
function syncCommissionFields() {
  const kind = $('pKind')?.value;
  const pct = $('pPct')?.closest('.bcn-field-group');
  const fix = $('pFixed')?.closest('.bcn-field-group');
  if (pct) pct.hidden = kind === 'fixed_per_order';
  if (fix) fix.hidden = kind === 'percent_of_net';
}
function renderProgram(isNew = S.creating) {
  const p = isNew ? {} : (prog() || {});
  const dis = MANAGE ? '' : 'disabled';
  const o = (v, label, cur) => `<option value="${v}"${String(cur ?? '') === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const plats = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web'];
  const units = minorUnits(p.currency || 'USD');
  const major = (c) => (c === null || c === undefined ? '' : (Number(c) / units).toString());
  const form = `
    ${settingsBlock('Basics', `<div class="af-grid--settings">
      ${field('Name', input('pName', `${dis} value="${esc(p.name || '')}" placeholder="e.g. Creator program"`))}
      ${field('Status', `<select class="bcn-field" id="pStatus" ${dis}>${o('draft', 'Draft', p.status ?? 'draft')}${o('active', 'Active: recruiting', p.status)}${o('paused', 'Paused', p.status)}${o('closed', 'Closed', p.status)}</select>`)}
      <div class="af-span-full">${field('What kind of creators? (your niche)', input('pNiche', `${dis} value="${esc(p.niche || '')}" placeholder="e.g. youth baseball training"`))}</div>
    </div>`)}
    ${settingsBlock('Platforms', `<div class="af-checks af-checks--boxed">${plats.map((x) => `<label><input type="checkbox" class="pPlat" value="${x}" ${dis} ${(p.platforms || []).includes(x) ? 'checked' : ''}/> ${x}</label>`).join('')}</div>`)}
    ${settingsBlock('Commission & codes', `<div class="af-grid--settings">
      ${field('Commission type', `<select class="bcn-field" id="pKind" ${dis}>${o('percent_of_net', 'Percent of net order', p.commission_kind ?? 'percent_of_net')}${o('fixed_per_order', 'Fixed per order', p.commission_kind)}</select>`)}
      ${field('Percent', input('pPct', `${dis} type="number" step="0.001" min="0" max="100" value="${esc(p.commission_percent ?? '')}"`))}
      ${field('Fixed amount per order', input('pFixed', `${dis} inputmode="decimal" value="${esc(major(p.commission_fixed_cents))}"`))}
      ${hasAutoCode() ? field('Code % off for new affiliates', input('pAutoPct', `${dis} type="number" step="1" min="1" max="100" placeholder="10" title="Blank: no automatic code" value="${esc(isNew ? 10 : (p.default_discount_percent ?? ''))}"`)) : ''}
    </div>`)}
    ${settingsBlock(`Program terms${p.terms_version ? ` (v${p.terms_version})` : ''}`, `<textarea class="bcn-field" id="pTerms" rows="5" ${dis} placeholder="Commission, how orders are credited, refunds, payouts, what affiliates may not do. Editing saves a new version.">${esc(p.terms_markdown || '')}</textarea>`)}
    ${MANAGE ? `<div class="af-settings-save">${btn(isNew ? 'Create program' : 'Save changes', 'save-program', {}, 'primary')}${isNew && S.programs.length ? btn('Cancel', 'cancel-new', {}, 'surface') : ''}</div>` : ''}
    ${more('Advanced settings', [`<p class="af-muted af-settings-sub">Link, owner, who you recruit</p><div class="af-grid--settings">
      ${field('Short name (apply link)', input('pSlug', `${dis} value="${esc(p.slug || '')}" placeholder="creator-program"`))}
      ${field('Designated employee', `<select class="bcn-field" id="pOwner" ${dis}><option value="">—</option>${S.profiles.map((u) => o(u.id, u.name || u.email, p.owner_user_id)).join('')}</select>`)}
      ${field('Audience notes', input('pAudience', `${dis} value="${esc(p.audience_notes || '')}" placeholder="Who the ideal creator speaks to"`))}
      ${field('Countries', input('pGeo', `${dis} value="${esc((p.geographies || []).join(', '))}" placeholder="US, CA"`))}
      ${field('Joining', `<select class="bcn-field" id="pIntake" ${dis}>${o('invite_only', 'Invite only', p.intake_mode ?? 'invite_only')}${o('open', 'Open applications', p.intake_mode)}</select>`)}
    </div><p class="af-muted af-settings-sub">Money, codes, payouts</p><div class="af-grid--settings">
      ${field('Currency', input('pCur', `${dis} maxlength="3" value="${esc(p.currency || 'USD')}"`))}
      ${field('Default code start', input('pStart', `${dis} type="date" value="${esc(p.default_code_starts_on || '')}"`))}
      ${field('Default code end', input('pEnd', `${dis} type="date" value="${esc(p.default_code_ends_on || '')}"`))}
      ${field('Grace days after code ends', input('pGrace', `${dis} type="number" min="0" max="365" value="${esc(p.attribution_window_days ?? 0)}"`))}
      ${field('Several codes on one order', `<select class="bcn-field" id="pPrec" ${dis}>${o('first_affiliate_code', 'Credit one code', p.code_precedence ?? 'first_affiliate_code')}${o('single_code_only', 'Do not credit', p.code_precedence)}</select>`)}
      ${field('Refund hold (days)', input('pHold', `${dis} type="number" min="0" max="365" value="${esc(p.refund_hold_days ?? 30)}"`))}
      ${field('Payout minimum', input('pMin', `${dis} inputmode="decimal" value="${esc(major(p.payout_minimum_cents))}"`))}
    </div>`])}`;
  let extra = '';
  if (!isNew && p.id) {
    const url = applyUrl(location.origin, CO, p.slug);
    extra += card('Open applications link', p.intake_mode === 'open'
      ? `<div class="bcn-field af-mono af-copy">${esc(url)}</div>`
      : '<p class="af-muted">Invite only.</p>');
    extra += '<div id="managersCard"></div>';
  }
  $('programBody').innerHTML = card(isNew ? 'New program' : 'Settings', form) + (extra ? more('Sharing, access and how it works', [extra, S.d ? stageCard() : '']) : '');
  $('pKind')?.addEventListener('change', syncCommissionFields);
  syncCommissionFields();
  if (!isNew && p.id) renderManagers();
}

async function renderManagers() {
  const el = $('managersCard'); if (!el) return;
  const { data } = await db.from('affiliate_program_managers').select('id, user_id, created_at').eq('company_entity_id', CO);
  const rows = data || [];
  const name = (id) => { const u = S.profiles.find((x) => x.id === id); return esc(u?.name || u?.email || id); };
  const mgrRow = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${name(r.user_id)}</div><div class="af-muted">Since ${fmtDate(r.created_at)}</div></div><div class="af-item-foot">${btn('Remove', 'remove-manager', { id: r.id }, 'surface', { confirm: true })}</div></article>`;
  el.innerHTML = card('Who can run Affiliate Studio', `${itemList(rows, mgrRow, 'Only owners and executives so far.')}
    <div class="af-row" style="margin-top:8px;">${field('Grant access to', `<select class="bcn-field" id="mgrUser"><option value="">—</option>${S.profiles.map((u) => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join('')}</select>`)}${btn('Grant', 'add-manager', {}, 'primary')}</div>`);
}

function readProgramForm() {
  return validateProgram({
    name: val('pName'), slug: val('pSlug') || slugify(val('pName')), status: val('pStatus'), owner_user_id: val('pOwner'),
    niche: val('pNiche'), audience_notes: val('pAudience'), geographies: val('pGeo'),
    platforms: [...document.querySelectorAll('.pPlat:checked')].map((x) => x.value),
    intake_mode: val('pIntake'), commission_kind: val('pKind'), commission_percent: val('pPct'), commission_fixed: val('pFixed'),
    currency: val('pCur'), default_code_starts_on: val('pStart'), default_code_ends_on: val('pEnd'),
    attribution_window_days: val('pGrace'), code_precedence: val('pPrec'), refund_hold_days: val('pHold'),
    ...(hasAutoCode() ? { default_discount_percent: val('pAutoPct') } : {}),
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
    if (!['suppressed', 'signed_up', 'rejected'].includes(x.status)) b.push(btn('Do not contact', 'prospect-suppress', { id: x.id }, 'surface', { confirm: true }));
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
  const prospectCard = (x) => {
    const f = followersFrom(x.evidence);
    const followersVal = f ? num(f.count) : '—';
    const reach = x.contact_email ? 92 : 18;
    const title = x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Creator') : esc(x.display_name || x.handle || 'Creator');
    const sub = `${x.platform || 'creator'}${x.handle ? ` · ${x.handle}` : ''}`;
    const meta = x.contact_email ? esc(x.contact_email) : 'No public email yet';
    return `<article class="af-item af-item--tile af-item--catalog" role="listitem">
      <header class="af-catalog-head">
        <div class="af-catalog-thumb">${photoAvatar({ name: x.display_name, email: x.contact_email }, x.evidence)}</div>
        <div class="af-catalog-title">
          <div class="af-catalog-name">${title}</div>
          <div class="af-catalog-sub">${esc(sub)}</div>
          <div class="af-catalog-meta">${meta}</div>
        </div>
        ${statusPill(x.status)}
      </header>
      <section class="af-catalog-summary">
        <h3 class="af-catalog-summary-h">Summary</h3>
        <p class="af-catalog-summary-p">${esc(evidenceSummary(x))}</p>
      </section>
      <div class="af-catalog-stats">
        <div class="af-catalog-stat">
          <span class="af-catalog-stat-lbl">Followers</span>
          <span class="af-catalog-stat-val${f ? ' af-catalog-stat-val--up' : ''}">${f ? '<span class="af-catalog-up" aria-hidden="true">↑</span> ' : ''}${followersVal}</span>
        </div>
        <div class="af-catalog-stat af-catalog-stat--bar">
          <span class="af-catalog-stat-lbl">Reach</span>
          <span class="af-catalog-stat-barwrap">${catalogStatBar(reach)}<span class="af-catalog-stat-num">${x.contact_email ? 'Has email' : 'No email'}</span></span>
        </div>
      </div>
      <details class="af-item-more af-catalog-more"><summary>Source details</summary><div class="af-item-detail">${provenance(x)}</div></details>
      <footer class="af-item-foot af-catalog-foot">${actions(x)}</footer>
    </article>`;
  };
  $('prospectsBody').innerHTML = [
    MANAGE ? card('Find creators', `
      <div class="af-row">${field('Who are you looking for?', input('rsFocus', `maxlength="500" placeholder="${esc(p.niche ? `e.g. ${p.niche} creators on TikTok` : 'e.g. youth baseball coaches with drill videos')}"`))}${btn(researching ? 'Finding…' : 'Find creators', 'research-run', {}, 'primary', { disabled: researching })}</div>`, '', 'af-card-hero') : '',
    card('Creators', `<div class="af-filter-bar">${filters.map(([f, label]) => `<button type="button" class="bcn-btn af-filter-chip${f === filter ? ' af-filter-chip--on bcn-btn--primary' : ''}" data-act="prospect-filter" data-f="${f}">${esc(label)} <span class="af-mono">${d.prospects.filter((x) => inGroup(x, f)).length}</span></button>`).join('')}</div>
      ${itemList(list, prospectCard, filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.', 'grid')}
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
      ${itemList(d.sources, (s) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">“${esc(s.query)}”</div><div class="af-muted">${esc(s.platform_hint === 'blog' ? 'websites' : s.platform_hint || 'program platforms')} · ${esc(countryName(s.location_code))} · ${esc(languageName(s.language_code))}</div><div class="af-kv-line">${num(s.max_results)} results · last ${fmtDate(s.last_run_at)}${s.last_error ? ` · ${esc(friendlySearchError(s.last_error))}` : ''}</div></div><div class="af-item-foot">${MANAGE ? btn(s.enabled ? 'Pause' : 'Resume', 'source-toggle', { id: s.id, on: s.enabled ? '0' : '1' }, 'surface') : ''}</div></article>`, 'No searches yet.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Search words', input('srcQuery', `placeholder="${esc(p.niche ? `${p.niche} creator` : 'e.g. youth baseball drills youtube')}"`))}${field('Platform', `<select class="bcn-field" id="srcPlat"><option value="">program platforms</option>${['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest'].map((x) => `<option>${x}</option>`).join('')}<option value="blog">websites</option></select>`)}${field('Country', `<select class="bcn-field" id="srcLoc">${SEARCH_COUNTRIES.map(([iso, code, name]) => `<option value="${code}"${iso === (p.geographies?.[0] || 'US') ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>`)}${field('Language', `<select class="bcn-field" id="srcLang">${SEARCH_LANGUAGES.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('')}</select>`)}${field('Results', input('srcMax', 'type="number" min="10" max="100" value="30"'))}${btn('Add search', 'source-add', {}, 'primary')}</div>` : ''}`),
    card('Recent runs', itemList(runs, (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.query || '—')} ${r.dry_run ? pill('dry run') : pill(runKindLabel(r), 'accent')}</div><div class="af-muted">${fmtTime(r.started_at)} · ${statusPill(r.status)}</div><div class="af-kv-line">${num(r.prospects_new)} new · ${num(r.results_returned)} results · ${num(r.emails_found)} emails${r.error ? ` · ${esc(friendlySearchError(r.error))}` : ''}</div></div></article>`, 'Discovery has not run for this program yet.')),
    card('Do-not-contact list', `
      ${itemList(d.suppressions, (s) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head"><span class="af-mono">${esc(s.value_normalized)}</span> ${pill(s.kind)}</div><div class="af-muted">${esc(s.reason)} · ${fmtDate(s.created_at)}</div></div><div class="af-item-foot">${MANAGE ? btn('Remove', 'suppression-remove', { id: s.id }, 'surface', { confirm: true }) : ''}</div></article>`, 'Nobody is on the list.')}
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
  const draftCard = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-item-detail">${msg(x)}</div><div class="af-muted">${fmtDate(x.created_at)}</div></div><div class="af-item-foot">${MANAGE ? `${btn('Edit', 'draft-edit', { id: x.id })}${btn('Approve', 'draft-approve', { id: x.id }, 'primary')}${btn('Delete', 'draft-delete', { id: x.id }, 'ghost', { confirm: true })}` : ''}</div></article>`;
  const approvedCard = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-item-detail">${msg(x)}</div><div class="af-muted">Approved ${fmtTime(x.approved_at)}</div></div></article>`;
  const exportedCard = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-muted">Exported ${fmtTime(x.exported_at)}${viaBatch(x)}</div>${MANAGE ? `<div class="af-row" style="margin-top:8px;"><input class="bcn-field" id="ev-${x.id}" placeholder="Where: sent-folder link, DM screenshot ref" />${btn('Mark sent', 'draft-sent', { id: x.id }, 'primary')}</div>` : ''}</div></article>`;
  const boardCol = (title, items, render, empty) => `<section class="af-board-col"><header class="af-board-head"><h3>${esc(title)}</h3>${items.length ? pill(String(items.length), 'accent') : ''}</header><div class="af-board-cards">${items.length ? items.map(render).join('') : `<p class="af-board-empty">${esc(empty)}</p>`}</div></section>`;
  $('outreachBody').innerHTML = [
    editing ? card('Edit message', `${field('Subject', input('edSubject', `value="${esc(editing.subject || '')}"`))}${field('Message ({signup_link} is replaced at export)', `<textarea class="bcn-field" id="edBody" rows="10">${esc(editing.body || '')}</textarea>`)}<div class="af-row" style="margin-top:8px;">${btn('Save', 'draft-save', { id: editing.id }, 'primary')}${btn('Close', 'draft-edit-close')}</div>`) : '',
    card('Messages', `<div class="af-board">${boardCol('Drafts', byState('draft'), draftCard, 'No drafts. Approve a creator on Find creators to draft one.')}${boardCol('Ready to send', byState('approved'), approvedCard, 'Nothing approved yet.')}${boardCol('Mark sent', byState('exported'), exportedCard, 'Nothing is waiting.')}</div>
      ${aiSendBlock(d.aiApps)}
      <div class="af-row" style="margin-top:12px;">${(d.aiApps || []).some((a) => a.canSend) ? '<a class="bcn-btn" href="../settings-connect-ai.html">Manage AI connections</a>' : '<a class="bcn-btn bcn-btn--primary" href="../settings-connect-ai.html">Connect your AI</a>'}${MANAGE && byState('approved').length ? btn(`Or export ${byState('approved').length} to send yourself`, 'outreach-export', {}, 'surface', { confirm: true }) : ''}</div>`, `${byState('draft').length + byState('approved').length + byState('exported').length} in the workflow`),
    more('More options', [
    card('Sent and outcomes', itemList(byState(['sent', 'replied', 'declined', 'bounced', 'signed_up']), (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)} ${statusPill(x.state)}</div><div class="af-muted">Marked ${fmtTime(x.sent_marked_at)}${x.sent_via_app ? ` · via ${esc(x.sent_via_app)}` : ''}</div>${x.sent_evidence ? `<div class="af-kv-line">${esc(x.sent_evidence)}</div>` : ''}</div>${MANAGE && x.state === 'sent' ? `<div class="af-item-foot"><div class="af-actions">${btn('Replied', 'draft-outcome', { id: x.id, s: 'replied' }, 'surface')}${btn('Declined', 'draft-outcome', { id: x.id, s: 'declined' }, 'surface')}${btn('Bounced', 'draft-outcome', { id: x.id, s: 'bounced' }, 'surface')}${btn('Asked to stop', 'draft-optout', { id: x.id }, 'danger', { confirm: true })}</div></div>` : ''}</article>`, 'Nothing sent yet.')),
    card('Export batches', itemList(d.batches, (b) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${fmtTime(b.exported_at)} · ${num(b.row_count)} row(s)</div>${b.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''}<div class="af-mono af-copy" style="font-size:11px;margin-top:4px;">${esc(b.fingerprint || '—')}</div></div></article>`, 'No exports yet.'), 'compare with sha256sum of a file to prove it is this export'),
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

// What the person pastes into their own AI (or sets as a daily task there).
const SEND_PROMPT = 'Using SILO, send my approved affiliate outreach from my own mailbox, then mark each one sent with where I sent it from.';
const CODES_PROMPT = 'Using SILO, create every affiliate code waiting for Shopify in my Shopify store, then mark each one created in SILO.';
const SEND_PROMPT_HINT = 'Using SILO, send approved outreach from my mailbox; mark each one sent.';
const CODES_PROMPT_HINT = 'Using SILO, create waiting affiliate codes in Shopify; mark each in SILO.';
function aiCodesBlock(apps) {
  const can = (apps || []).filter((a) => a.canCode);
  if (can.length) return `<div class="af-ai-tab-hint" id="aiCodesHow"><span class="af-muted">A connected MCP client with codes allowed may create Shopify codes when it can reach Shopify—SILO only sees what you allowed on the connection.</span>${btn('Copy agent prompt', 'copy-codes-prompt', {}, 'surface')}</div>`;
  return '<p class="af-muted" id="aiCodesHow">Want codes made for you? <a href="../settings-connect-ai.html">Connect your AI</a> and allow “create affiliate codes”.</p>';
}

function aiSendBlock(apps) {
  const send = (apps || []).filter((a) => a.canSend);
  if (send.length) return `<div class="af-ai-tab-hint" id="aiSendHow"><span class="af-muted">A connected MCP client with send allowed may send approved messages when it has mail access—SILO only sees what you allowed on the connection.</span>${btn('Copy agent prompt', 'copy-send-prompt', {}, 'surface')}</div>`;
  return '<p class="af-muted" id="aiSendHow">Your own MCP client sends approved messages from your email. Connect SILO MCP while this company is selected and enable send outreach.</p>';
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
  const affiliateRow = (a) => {
    const code = liveCodeOf(a.id);
    const store = storeOf(p);
    const linkRows = [store && code ? affiliateLink(store, code, '/') : null, ...linksOf(a).map((l) => (store && code ? storeLinkFor(store, code, l.destination_url) : null) || linkUrl(l) || l.destination_url)].filter(Boolean);
    const codesHtml = codesOf(a).map((c) => `<span class="af-code-pill" title="${esc(fmtDate(c.starts_on))} → ${c.ends_on ? esc(fmtDate(c.ends_on)) : 'open'}">${esc(c.code)}${c.status === 'pending' ? ' · AI' : c.verified_at ? '' : ' · new'}</span>`).join('') || '<span class="af-muted">No codes</span>';
    const terms = a.terms_version_accepted ? `Terms v${a.terms_version_accepted}${a.terms_version_accepted < p.terms_version ? ' · update pending' : ''}` : 'Terms not accepted';
    const linksBlock = linkRows.length ? `<details class="af-item-more"><summary>${num(linkRows.length)} link(s)</summary>${linkRows.map((u) => `<div class="af-mono af-copy" style="font-size:11px;margin-top:4px;">${esc(u)}</div>`).join('')}</details>` : '';
    const codeCount = codesOf(a).filter((c) => c.status !== 'retired').length;
    return `<article class="af-item af-item--tile af-item--catalog" role="listitem">
      <header class="af-catalog-head">
        <div class="af-catalog-thumb">${photoAvatar({ name: a.display_name, email: a.contact_email }, d.prospectById[a.from_prospect_id]?.evidence)}</div>
        <div class="af-catalog-title">
          <div class="af-catalog-name">${esc(a.display_name)}</div>
          <div class="af-catalog-sub">${esc(a.contact_email)}</div>
          <div class="af-catalog-meta">${esc(terms)}</div>
        </div>
        ${statusPill(a.status)}
      </header>
      <section class="af-catalog-summary">
        <h3 class="af-catalog-summary-h">Codes</h3>
        <div class="af-codes">${codesHtml}</div>
      </section>
      <div class="af-catalog-stats">
        <div class="af-catalog-stat">
          <span class="af-catalog-stat-lbl">Live codes</span>
          <span class="af-catalog-stat-val${codeCount ? ' af-catalog-stat-val--up' : ''}">${codeCount ? '<span class="af-catalog-up" aria-hidden="true">↑</span> ' : ''}${num(codeCount)}</span>
        </div>
        <div class="af-catalog-stat af-catalog-stat--bar">
          <span class="af-catalog-stat-lbl">Links</span>
          <span class="af-catalog-stat-barwrap">${catalogStatBar(linkRows.length ? 85 : 20)}<span class="af-catalog-stat-num">${num(linkRows.length)} link(s)</span></span>
        </div>
      </div>
      ${linksBlock ? `<div class="af-catalog-links">${linksBlock}</div>` : ''}
      <footer class="af-item-foot af-catalog-foot">${actions(a)}</footer>
    </article>`;
  };
  $('affiliatesBody').innerHTML = [
    card('Affiliates', `${itemList(d.affiliates, affiliateRow, 'No affiliates yet. They appear here when someone you invite opens their signup link.', 'grid')}<div id="affOut"></div>`),
    MANAGE && needsStore(p) ? `<div class="bcn-status bcn-status--warn" id="storeNeeded">Add your website on the Share tab to turn on affiliate links.</div>` : '',
    MANAGE ? card('Give an affiliate a code', `<div class="af-grid--settings">
      ${field('Affiliate', `<select class="bcn-field" id="cAff">${affOpts}</select>`)}
      ${field('Code', input('cCode', 'class="bcn-field bcn-field--mono"'))}
      ${field('% off', input('cPct', 'type="number" min="1" max="100" step="1" value="10"'))}
      <div class="af-span-full">${btn('Add code', 'code-add', {}, 'primary')}</div>
    </div>
      <details class="af-more"><summary>Code options</summary><div class="af-grid--settings">${field('Starts', input('cStart', `type="date" value="${esc(p.default_code_starts_on || today())}"`))}${field('Ends', input('cEnd', `type="date" value="${esc(p.default_code_ends_on || '')}"`))}${field('In Shopify', `<select class="bcn-field" id="cHow"><option value="exists"${canCode ? '' : ' selected'}>I made it</option><option value="ai"${canCode ? ' selected' : ''}>My AI makes it</option></select>`)}</div></details>
      ${aiCodesBlock(d.aiApps)}`) : '',
    more('Codes and links', [
      MANAGE ? card('All codes', itemList(d.codes, (c) => {
        const shop = c.status === 'pending' ? `${pill('waiting for AI', 'warn')} · ${esc(Number(c.discount_percent))}% off` : c.shopify_created_via_app ? `Shopify via ${esc(c.shopify_created_via_app)}` : 'You made it';
        const seen = c.verified_at ? `First seen ${fmtDate(c.verified_at)}` : 'Not seen on an order yet';
        const act = c.status === 'active' ? btn('Retire', 'code-retire', { id: c.id }, 'surface', { confirm: true }) : c.status === 'pending' ? btn('Cancel', 'code-retire', { id: c.id }, 'surface', { confirm: true }) : pill('retired');
        return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head"><span class="af-mono">${esc(c.code)}</span> · ${esc(d.affById[c.affiliate_id]?.display_name)}</div><div class="af-muted">${fmtDate(c.starts_on)} → ${c.ends_on ? fmtDate(c.ends_on) : 'open'}</div><div class="af-kv-line">${shop} · ${seen}</div></div><div class="af-item-foot">${act}</div></article>`;
      }, 'No codes yet.')) : '',
      MANAGE ? card('Give an affiliate a link to a page', `<div class="af-row">${field('Affiliate', `<select class="bcn-field" id="lAff">${affOpts}</select>`)}${field('Name', input('lSlug', 'placeholder="pat-spring"'))}${field('Page (https)', input('lDest', 'placeholder="https://yourstore.com/collections/new"'))}${field('utm_campaign', input('lCamp', `value="${esc(p.slug)}"`))}${btn('Add link', 'link-add', {}, 'primary')}</div>`) : '',
    ]),
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
  return `<article class="af-share-card">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="af-share-noimg"></span>'}<div class="af-share-txt"><strong>${esc(title)}</strong>${sub ? `<div class="af-muted">${esc(sub)}</div>` : ''}</div><div class="af-item-foot" style="padding:0;border:0;background:transparent;margin-top:auto;">${action}</div></article>`;
}
function shareGrid(rows) { return rows.length ? `<div class="af-share-grid">${rows.join('')}</div>` : ''; }

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
  const storeCard = MANAGE ? (needsStore(p)
    ? card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', 'placeholder="https://www.yourstore.com"'))}${btn('Save', 'store-save', {}, 'primary')}</div><p class="bcn-status bcn-status--warn" id="storeNeeded">Add it once to turn on affiliate links.</p>`)
    : card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', `value="${esc(p.store_url || storeOf(p) || '')}"`))}${btn('Save', 'store-save', {}, 'primary')}</div>`)) : '';
  $('shareBody').innerHTML = [
    card('What your affiliates see', `${sharedRows.length ? `<div class="af-seen">${sharedRows.join('')}</div>` : empty('Nothing shared yet. Pick launches or ads below.')}`,
      `${d.feed.length} shared`),
    storeCard,
    card('Pick what to share', `${launches.length ? `<h3 class="af-settings-title" style="margin:12px 0 8px;">Upcoming launches</h3>${shareGrid(launches)}` : ''}${ads.length ? `<h3 class="af-settings-title" style="margin:${launches.length ? 16 : 0}px 0 8px;">Recent ads</h3>${shareGrid(ads)}` : ''}${!launches.length && !ads.length ? empty('No upcoming launches or recent ads yet.') : ''}`),
    more('Add products', [
      card('Products', `<div class="af-row">${field('Find a product', input('prodQ', `placeholder="Name" value="${esc(sh.q)}"`))}${btn('Search', 'prod-search', {}, 'surface')}</div>${products.length ? shareGrid(products) : (sh.q ? empty('No products match.') : '<p class="af-muted">Search to pick products.</p>')}`),
      sh.failed.length ? `<p class="af-muted">Could not load: ${esc(sh.failed.join(', '))}.</p>` : '',
    ]),
  ].join('');
}

// ── Commissions ──────────────────────────────────────────────────────────
function renderCommissions() {
  const d = S.d; const p = prog();
  const from = S.rangeFrom || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = S.rangeTo || today();
  const openPeriods = d.periods.filter((x) => x.status === 'open');
  const perf = d.performance.map((r) => ({ ...r, a: d.affById[r.affiliate_id] }));
  const perfRow = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.a?.display_name || '—')}</div><div class="af-kv-line">${num(r.attributed_orders)} credited orders · base ${formatMoney(r.commissionable_cents, r.order_currency)}${r.orders_with_unknown_base ? ` · ${num(r.orders_with_unknown_base)} unknown base` : ''}</div></div></article>`;
  const attrRow = (r) => {
    const earns = BASIS_LABELS[r.basis]?.earns;
    const base = formatMoney(r.commissionable_cents, r.order_currency);
    return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(d.affById[r.affiliate_id]?.display_name || '—')} ${earns ? pill(basisLabel(r.basis), 'pos') : pill(basisLabel(r.basis))}</div><div class="af-muted">${fmtDate(r.order_day)} · <span class="af-mono">${esc(r.order_number || r.order_id)}</span> · <span class="af-mono">${esc(r.matched_code || '—')}</span></div><div class="af-kv-line">Base ${base}${r.codes_on_order > 1 ? ` · ${r.codes_on_order} codes on order` : ''}</div></div></article>`;
  };
  const periodRow = (x) => {
    const t = d.periodTotals.filter((r) => r.period_id === x.id);
    const total = t.length ? t.map((r) => formatMoney(r.amount_cents, r.currency)).join(', ') : formatMoney(0, p.currency);
    return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${fmtDate(x.period_start)} → ${fmtDate(x.period_end)} ${statusPill(x.status)}</div><div class="af-kv-line">Total ${total}${x.approved_at ? ` · approved ${fmtTime(x.approved_at)}` : ''}</div></div><div class="af-item-foot"><div class="af-actions">${MANAGE && x.status === 'open' ? btn('Submit', 'period-submit', { id: x.id }, 'surface') : ''}${MONEY && x.status === 'under_review' ? btn('Approve', 'period-approve', { id: x.id }, 'primary', { confirm: true }) : ''}</div></div></article>`;
  };
  const ledgerRow = (l) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(d.affById[l.affiliate_id]?.display_name || '—')} · ${formatMoney(l.amount_cents, l.currency)}</div><div class="af-muted">${fmtTime(l.created_at)} · ${esc(l.kind.replaceAll('_', ' '))}${l.order_id ? ` · <span class="af-mono">${esc(l.order_id)}</span>` : ''}</div>${l.memo ? `<div class="af-kv-line">${esc(l.memo)}</div>` : ''}</div></article>`;
  $('commissionsBody').innerHTML = [
    card('Commissions', `<p class="af-muted">Commissions update every night.</p>
      <div class="af-grid--settings" style="margin-top:10px;">${field('From', input('rFrom', `type="date" value="${from}"`))}${field('To', input('rTo', `type="date" value="${to}"`))}
      ${field('Put new lines in period', `<select class="bcn-field" id="rPeriod"><option value="">open period for each order</option>${openPeriods.map((x) => `<option value="${x.id}">${fmtDate(x.period_start)} → ${fmtDate(x.period_end)}</option>`).join('')}</select>`)}
      </div>
      <div class="af-row" style="margin-top:10px;">${MANAGE ? `${btn('Match orders', 'resolve', {}, 'surface')}${btn('Calculate', 'accrue', {}, 'surface')}${btn('Update now', 'update-commissions', {}, 'primary')}` : ''}</div>
      <div id="runOut"></div>`),
    card('By affiliate', itemList(perf, perfRow, 'No credited orders yet.'), 'code on order, not proof of cause'),
    more('Every order decision', [card('Orders', itemList(d.attributions, attrRow, 'No orders matched yet. Match orders above.'), 'latest 300')]),
    more('Periods & ledger', [
      card('Review periods', `${itemList(d.periods, periodRow, 'No periods yet.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Start', input('perStart', 'type="date"'))}${field('End', input('perEnd', 'type="date"'))}${btn('Open period', 'period-add', {}, 'primary')}</div>` : ''}`),
      card('Commission ledger', `${itemList(d.ledger, ledgerRow, 'No commission lines yet.')}
      ${MONEY ? `<div class="af-row" style="margin-top:8px;">${field('Adjust affiliate', `<select class="bcn-field" id="adjAff">${d.affiliates.map((a) => `<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select>`)}${field(`Amount in ${esc(p.currency)}`, input('adjAmt', 'inputmode="decimal"'))}${field('Why', input('adjMemo'))}${btn('Add adjustment', 'adjust', {}, 'primary', { confirm: true })}</div>` : '<p class="af-muted">Manual adjustments need journal-entry approval.</p>'}`, 'append-only'),
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
  const balanceRow = (r) => `<article class="af-item af-item--pay" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.a?.display_name || '—')}</div><div class="af-item-stats">${formatMoney(r.unclaimed_cents, r.currency)}<span class="af-muted" style="font-size:12px;font-weight:400;"> not yet in a payout</span></div><div class="af-muted" style="margin-top:4px;">Earned ${formatMoney(r.earned_cents, r.currency)} · Paid ${formatMoney(r.paid_cents, r.currency)}</div></div><div class="af-item-foot">${MANAGE && r.currency === p.currency && Number(r.unclaimed_cents) > 0 ? btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'primary') : ''}</div></article>`;
  const payoutRow = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(d.affById[x.affiliate_id]?.display_name || '—')} ${statusPill(x.status)}</div><div class="af-item-stats">${formatMoney(x.amount_cents, x.currency)}</div><div class="af-muted">${fmtDate(x.created_at)} · ${num(x.item_count)} line(s)${x.external_reference ? ` · ref ${esc(x.external_reference)}` : ''}${x.void_reason ? ` · ${esc(x.void_reason)}` : ''}</div></div><div class="af-item-foot">${act(x)}</div></article>`;
  $('payoutsBody').innerHTML = [
    `<p class="af-muted">Pay from your bank or payment tool, then record it. Payable ${num(p.refund_hold_days)} days after the order.</p>`,
    card('Ready to pay', itemList(bal.filter((r) => Number(r.unclaimed_cents) > 0), balanceRow, 'Nothing waiting in a payout yet.', 'grid'), `${bal.length} affiliate(s)`),
    card('Payouts', `${itemList(d.payouts, payoutRow, 'No payouts yet.')}
    ${MANAGE && approved.length ? `<div class="af-row" style="margin-top:8px;">${btn(`Export ${approved.length} approved payout(s)`, 'payout-export', {}, 'primary', { confirm: true })}</div>` : ''}`),
    more('Balance detail', [card('All balances', itemList(bal, (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.a?.display_name || '—')} · ${esc(r.currency)}</div><div class="af-kv-line">Earned ${formatMoney(r.earned_cents, r.currency)} · unpaid ${formatMoney(r.unclaimed_cents, r.currency)} · paid ${formatMoney(r.paid_cents, r.currency)}</div></div>${MANAGE && r.currency === p.currency ? `<div class="af-item-foot">${btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'surface')}</div>` : ''}</article>`, 'Nothing earned yet.'))]),
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
    // A link that went to the rep's own inbox is theirs alone: it is never
    // shown here, and it is the only kind that lets a rep who works with
    // several brands move between them. A link we hand you instead opens this
    // brand only, so send it yourself and tell them it is personal.
    S.flash = { el: 'affOut', html: card('Portal link', out.email === 'sent'
      ? `<p>Emailed to the affiliate. Valid until ${fmtTime(out.expires_at)}.</p>`
      : `<p>Not emailed (${esc(out.reason || out.email)}). Send this to them yourself; it opens ${esc(co?.title || 'this brand')} only. Valid until ${fmtTime(out.expires_at)}.</p><div class="bcn-field af-mono af-copy">${esc(out.portal_url || '')}</div>`) };
    return out.email === 'sent' ? 'Portal link emailed.' : 'Portal link created.';
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
  'copy-send-prompt': async () => {
    try { await navigator.clipboard.writeText(SEND_PROMPT); } catch { setStatus(SEND_PROMPT, 'info'); return null; }
    return 'Copied. Paste it into your AI, or set it as a daily task there.';
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
