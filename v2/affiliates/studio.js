// Affiliate Studio staff page. Every read is the caller's own session under
// RLS; every write is either a plain row write the policies allow, or one of
// the gated SECURITY DEFINER functions, which re-check the caller. Nothing in
// this file is a permission: hiding a button is convenience, the database
// decides. Pure logic (money, CSV, validation, labels) is in studio-core.js.
import {
  formatMoney, minorUnits, parseMajorToMinor, describeCommission, basisLabel, BASIS_LABELS, validateProgram, slugify,
  toCsv, IMPORT_TEMPLATE, fillTemplate, outreachTemplate, templateRow, prospectEditRow, liveCodeCount, affiliatePhotoUrl, OUTREACH_HEADER, outreachRows, sha256Hex, PAYOUT_HEADER, payoutRows,
  linkUrl, affiliateLink, storeLinkFor, applyUrl, stageLabels, safeHref, SEARCH_COUNTRIES, SEARCH_LANGUAGES, countryName, languageName, friendlySearchError,
  parseCsv, chunk, runKindLabel, followersFrom, creatorStats, prospectPhotoUrl, sourceLabel,
  dayShift, dayDiff, ovWindow, ovOtherCurrencyOrders, ovLedgerTotal, ovWeekly, ovUnpaid,
  pagedCollect, OV_PAGE_SIZE,
  ovWeeklySellers, ovPerAffiliate, ovReachOut, ovMessage, OV_REASONS, OV_EARNING_BASES, displayImage, suggestCode, seedView,
} from './studio-core.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
const fmtTime = (s) => (s ? new Date(s).toLocaleString() : '—');
// A link to a stored URL, or the text alone when the URL is not http(s).
const ext = (u, label) => { const h = safeHref(u); return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label); };
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
// "1 payout", "2 payouts": the Money tab reads as words, not "payout(s)".
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;

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
  // The ledger speaks in cents; say it in money.
  const min = /(\d+) is below the program minimum of (\d+)/.exec(m);
  if (min) return `${money(+min[1])} owed is under the ${money(+min[2])} payout minimum. Lower it in Setup to pay now.`;
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
      autoRefreshMark(S.programId, true);
      await reload();
      setStatus(researchSummary(data), data.status === 'ok' ? 'pos' : 'neg', 10000);
      return;
    }
    if (Date.now() > until) { S.watching = null; setStatus('Research is still running. Reload the page in a few minutes to see what it found.', 'info', 10000); return; }
    setTimeout(tick, 15000);
  };
  setTimeout(tick, 15000);
}

// Creator photos and YouTube stats cost nothing to refresh, so nobody
// presses a button for them: a manager's visit runs both in the background,
// at most once per program every 12 hours in this browser (a finished
// research run clears that, so its creators are filled in straight away).
const AUTO_REFRESH_MS = 12 * 3600 * 1000;
const autoKey = (id) => `silo.affiliates.autorefresh.${id}`;
function autoRefreshDue(id) {
  try { return Date.now() - Number(localStorage.getItem(autoKey(id)) || 0) > AUTO_REFRESH_MS; } catch (_) { return true; }
}
function autoRefreshMark(id, clear = false) {
  try { if (clear) localStorage.removeItem(autoKey(id)); else localStorage.setItem(autoKey(id), String(Date.now())); } catch (_) { /* per-browser convenience only */ }
}
let autoRefreshing = null;
// Something typed and not yet saved, or a field in use, on the page.
function formDirty() {
  const a = document.activeElement;
  if (a && a.matches?.('input, textarea, select')) return true;
  return [...document.querySelectorAll('.af-panel input, .af-panel textarea')].some((el) =>
    (el.type === 'checkbox' || el.type === 'radio') ? el.checked !== el.defaultChecked : (el.type !== 'file' ? el.value !== el.defaultValue : !!el.files?.length));
}
async function autoRefreshCreators(id) {
  if (!MANAGE || !id || autoRefreshing === id || !autoRefreshDue(id)) return;
  const pros = S.d?.prospects || [];
  const wantPhotos = pros.some((x) => !prospectPhotoUrl(x.evidence));
  const wantStats = pros.some((x) => x.platform === 'youtube');
  if (!wantPhotos && !wantStats) return;
  autoRefreshing = id; autoRefreshMark(id);
  try {
    const [ph, st] = await Promise.all([
      wantPhotos ? invoke('affiliate-research', { action: 'refresh_photos', program_id: id }).catch(() => null) : null,
      wantStats ? invoke('affiliate-research', { action: 'refresh_stats', program_id: id }).catch(() => null) : null,
    ]);
    // Redraw only when something changed and the person is still on this program.
    // Never under someone's typing: a half-filled form (a payment reference,
    // a prospect by hand) would be redrawn empty. The new photos then show on
    // the next redraw instead.
    const quiet = () => S.programId === id && !S.creating && S.tab !== 'program' && !formDirty();
    if (((ph?.stored || 0) + (st?.updated || 0)) > 0 && quiet()) {
      await loadPrograms(); await loadProgramData();
      // Checked again AFTER the reads: someone may have started typing while
      // they ran. The fresh data then shows on the next redraw instead.
      if (quiet()) render();
    }
  } finally { autoRefreshing = null; }
}

// The affiliate hears about a payment without anyone pressing a button.
// Fail-soft: the payment is recorded either way; the reply says if no email went.
const told = new Set();   // payouts this page already asked to announce
async function tellPayout(id) {
  const aff = (S.d?.payouts || []).find((x) => x.id === id)?.affiliate_id;
  if (!aff || told.has(id)) return '';
  told.add(id);
  try {
    const out = await invoke('affiliate-invite', { action: 'notify', affiliate_id: aff, kind: 'payout_status', payout_id: id });
    if (out.email === 'already_sent') return ' The affiliate was already emailed.';
    return out.email === 'sent' ? ' The affiliate was emailed.' : ` Not emailed: ${out.reason || out.email}.`;
  } catch (e) { return ` Not emailed: ${e.message}.`; }
}
// Every way a payout becomes paid (Record as paid, Send, Send all, a pending
// PayPal payment that settles later) ends in a reload, and this catches up:
// a payout paid in the last 14 days whose email is not done (and not in
// flight in the last 15 minutes) is announced. affiliate-invite claims the
// email in the database before sending, so two tabs cannot double it.
// Before 20261117040000 the fields are absent and nothing is sent.
const PAID_NOTICE_DAYS = 14;
async function announcePaidPayouts() {
  if (!MANAGE) return;
  const since = Date.now() - PAID_NOTICE_DAYS * 86400000;
  const due = (S.d?.payouts || []).filter((x) => x.status === 'marked_paid' && !told.has(x.id)
    && Object.prototype.hasOwnProperty.call(x, 'paid_notice_done_at') && x.paid_notice_done_at == null
    && (x.paid_notice_claimed_at == null || Date.now() - new Date(x.paid_notice_claimed_at).getTime() > 15 * 60000)
    && x.marked_paid_at && new Date(x.marked_paid_at).getTime() >= since);
  for (const x of due) await tellPayout(x.id);
}
// Same for a code a person added that is live now.
async function tellCodes(aff) {
  try {
    const out = await invoke('affiliate-invite', { action: 'notify', affiliate_id: aff, kind: 'codes_and_links' });
    return out.email === 'sent' ? ' The affiliate was emailed their code.' : ` Not emailed: ${out.reason || out.email}.`;
  } catch (e) { return ` Not emailed: ${e.message}.`; }
}

// SILO makes waiting codes in the brand's Shopify (affiliate-invite). Each
// code it cannot make stays waiting -- for a reconnect, a store pick, or the
// brand's own AI -- and the message says which.
async function makeInShopify(ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return 'Nothing is waiting.';
  const out = await invoke('affiliate-invite', { action: 'create_shopify_codes', code_ids: ids });
  return shopifyCodesMessage(out?.results || []);
}
function shopifyCodesMessage(results) {
  const n = (k) => results.filter((r) => k.includes(r.status)).length;
  const made = n(['created', 'adopted']);
  const parts = [];
  if (made) parts.push(`${num(made)} code(s) live in Shopify.`);
  const scope = results.find((r) => r.status === 'needs_scope');
  if (scope) parts.push(`${num(n(['needs_scope']))} waiting: ${scope.reason || 'reconnect Shopify in Integrations so SILO can make codes'}.`);
  const nostore = results.find((r) => r.status === 'no_store');
  if (nostore) parts.push(`${num(n(['no_store']))} waiting: ${nostore.reason || 'pick this program\'s Shopify store in Setup'}.`);
  const taken = results.find((r) => r.status === 'taken');
  if (taken) parts.push(`${num(n(['taken']))} waiting: ${taken.reason}.`);
  const noprod = results.find((r) => r.status === 'no_product');
  if (noprod) parts.push(`${num(n(['no_product']))} waiting: ${noprod.reason}.`);
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) parts.push(`${num(failed.length)} not made: ${failed[0].reason || 'Shopify said no'}.`);
  return parts.join(' ') || 'Nothing was waiting.';
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
// Prospects SILO emails an onboarding invite (affiliate-invite INVITE_SOURCES):
// added by hand, or applied. A creator a search found is sent a link by a person.
const INVITE_SOURCES = new Set(['manual', 'applied']);
// Email the signup invite. When it did not go out, the link is shown to send by hand.
// `where` is the element beside the button that asked, so the link shows on the visible tab.
const notEmailedCard = (rows) => card('Invite not emailed: send this link', rows.map((x) => `<p>${x.name ? `<strong>${esc(x.name)}</strong>: ` : ''}${esc(x.out.reason || x.out.email || 'not sent')}. Valid until ${fmtTime(x.out.expires_at)}.</p><div class="bcn-field af-mono af-copy">${esc(x.out.signup_url || '')}</div>`).join(''));
async function sendInvite(id, to = null, where = 'signupOut') {
  const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: id, email: true });
  if (out.emailed) return `Invite emailed to ${to || S.d.prospectById[id]?.contact_email || 'them'}.`;
  S.flash = { el: where, html: notEmailedCard([{ out }]) };
  return 'Invite not emailed. The link is below.';
}
// One action on many prospects. Each moves only from a state it may leave,
// exactly as its single button does; the rest are counted, not forced.
async function bulkProspects(ids, s) {
  const by = S.d.prospectById;
  const FROM = { approved: ['new', 'qualified', 'rejected'], rejected: ['new', 'qualified', 'approved'], suppressed: ['new', 'qualified', 'approved', 'invited'] };
  const ok = ids.filter((id) => by[id] && FROM[s]?.includes(by[id].status));
  const skipped = ids.length - ok.length;
  let done = 0; let invited = 0; let drafted = 0; let failed = 0; const unsent = [];
  if (s === 'suppressed') {
    for (const id of ok) { try { await A['prospect-suppress']({ id }); done += 1; } catch { failed += 1; } }
  } else if (ok.length) {
    const now = new Date().toISOString();
    for (const part of chunk(ok, 100)) {
      const rows = await updateRows('affiliate_prospects', { status: s, reviewed_by: me.id, reviewed_at: now, changed_by: me.id }, { id: part });
      done += rows.length;
    }
    if (s === 'approved') {
      // Same follow-up as approving one: an invite for someone added by hand
      // or who applied, a drafted message for a creator a search found.
      const live = new Set(S.d.drafts.filter((x) => ['draft', 'approved', 'exported'].includes(x.state)).map((x) => x.prospect_id));
      for (const id of ok) {
        const x = by[id];
        try {
          if (INVITE_SOURCES.has(x.source) && x.contact_email) { const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: id, email: true }); if (out.emailed) invited += 1; else unsent.push({ name: x.display_name || x.handle || x.contact_email, out }); }
          else if (!live.has(id)) { await A['draft-create']({ id }); drafted += 1; }
        } catch { failed += 1; }
      }
    }
  }
  S.sel.clear();
  if (unsent.length) S.flash = { el: 'signupOut', html: notEmailedCard(unsent) };
  const word = { approved: 'Approved', rejected: 'Rejected', suppressed: 'Added to do-not-contact:' }[s];
  return `${word} ${num(done)}.${invited ? ` ${num(invited)} invite(s) emailed.` : ''}${unsent.length ? ` ${num(unsent.length)} invite(s) not emailed: links below.` : ''}${drafted ? ` ${num(drafted)} message(s) drafted.` : ''}${skipped ? ` ${num(skipped)} skipped (already ${s === 'approved' ? 'approved or further' : 'past that step'}).` : ''}${failed ? ` ${num(failed)} could not be finished.` : ''}`;
}
function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── State ────────────────────────────────────────────────────────────────
const PROSPECT_LIST_CAP = 20;
const S = { programs: [], programId: null, tab: 'overview', profiles: [], brand: '', ovDays: 30, ovRank: 'sales', ovFilter: 'all', prospectFilter: 'new', prospectShowAll: false, prospectQuery: '', sel: new Set(), view: readView() };
const prog = () => S.programs.find((p) => p.id === S.programId) || null;
const otherPrograms = () => S.programs.filter((x) => x.id !== S.programId && x.status === 'active');

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
    // Product seeding (20261113093000). Read fail-soft below: before the
    // migration there is no table, and the page simply has no seeding.
    seeds: by('affiliate_seed_claims').order('requested_at', { ascending: false }).limit(300),
    // Affiliate content (20261117050000), fail-soft like seeding.
    content: by('affiliate_content_submissions').neq('state', 'uploading').order('submitted_at', { ascending: false }).limit(200),
    // The payout rail (20261113040000). The status VIEW, never the connection
    // table: the credentials are not readable by a browser session at all.
    payConn: db.from('affiliate_payout_connection_status_v').select('*').eq('provider', 'paypal').maybeSingle(),
    payAccounts: db.from('affiliate_payout_accounts').select('affiliate_id, payout_email, provider')
      .eq('company_entity_id', CO).eq('provider', 'paypal'),
    sends: db.from('affiliate_payout_sends')
      .select('id, payout_id, attempt, state, provider_status, provider_item_id, error_code, error_message, environment, created_at')
      .eq('company_entity_id', CO)
      // Newest first, and `attempt` breaks a tie: two attempts stamped in the
      // same instant must not leave the row describing the older one.
      .order('created_at', { ascending: false }).order('attempt', { ascending: false }).limit(200),
  };
  const keys = Object.keys(q);
  const res = await Promise.all(Object.values(q));
  const d = {}; const failed = [];
  res.forEach((r, i) => {
    d[keys[i]] = r.data ?? (keys[i] === 'health' ? null : []);
    if (r.error && keys[i] === 'seeds') { d.seeds = null; return; }
    if (r.error && keys[i] === 'content') { d.content = null; return; }
    if (r.error) failed.push(`${keys[i]}: ${r.error.message}`);
  });
  d.ledgerCount = res[keys.indexOf('ledgerCount')].count ?? 0;
  const ids = d.payouts.map((x) => x.id);
  if (ids.length) {
    const items = (await db.from('affiliate_payout_items').select('payout_id').eq('company_entity_id', CO).in('payout_id', ids)).data || [];
    const n = {}; items.forEach((i) => { n[i.payout_id] = (n[i.payout_id] || 0) + 1; });
    d.payouts.forEach((x) => { x.item_count = n[x.id] || 0; });
  }
  d.affById = Object.fromEntries(d.affiliates.map((a) => [a.id, a]));
  // Files are private: a signed URL for each one on screen, for an hour.
  d.contentUrl = {};
  const files = (d.content || []).filter((x) => x.kind === 'file' && x.storage_path && ['submitted', 'approved', 'used'].includes(x.state)).slice(0, 60);
  if (files.length) {
    try {
      const { data: urls } = await db.storage.from('affiliate-content').createSignedUrls(files.map((x) => x.storage_path), 3600);
      for (const u of urls || []) if (u?.signedUrl && u.path) d.contentUrl[u.path] = u.signedUrl;
    } catch { /* no preview: the row still shows */ }
  }
  // maybeSingle() answers one row, not a list.
  d.payConn = Array.isArray(d.payConn) ? (d.payConn[0] || null) : (d.payConn || null);
  d.payEmailByAff = Object.fromEntries((d.payAccounts || []).filter((x) => x.payout_email).map((x) => [x.affiliate_id, x.payout_email]));
  // The newest attempt per payout is the one that says where it stands.
  d.sendByPayout = {};
  for (const x of d.sends || []) if (!d.sendByPayout[x.payout_id]) d.sendByPayout[x.payout_id] = x;
  d.prospectById = Object.fromEntries(d.prospects.map((x) => [x.id, x]));
  // The Overview tab's windows. Both are read paged, because a program with
  // real volume has more rows in 180 days than one PostgREST page returns.
  // Null means "could not read": the tab then leaves those cards out rather
  // than showing a zero it cannot stand behind.
  [d.ovAttributions, d.ovLedger] = await Promise.all([loadOvAttributions(p), loadOvLedger(p)]);
  d.aiApps = await loadAiApps();
  d.stores = await loadStores();
  S.d = d;
  // A research run started earlier (another tab, a reload) is still watched.
  const live = d.runs?.find((r) => r.provider === 'anthropic' && r.status === 'running' && Date.now() - new Date(r.started_at).getTime() < RESEARCH_STALE_MS);
  if (live && S.watching !== live.id) watchResearch(live.id);
  autoRefreshCreators(p.id);
  announcePaidPayouts();
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

// ── Overview windows ─────────────────────────────────────────────────────
// 180 days covers every window the Overview offers (30 or 90 days) plus the
// same length again to compare it against, and the 12-week chart.
const OV_DAYS_BACK = 180;
// A deterministic order, so no row is seen twice or skipped across page
// boundaries. A page that errors abandons the whole read (pagedCollect turns
// a null page into a null read): a short read would understate every number
// on the tab.
function loadPaged(table, cols, since, programId) {
  return pagedCollect(async (i) => {
    try {
      const { data, error } = await db.from(table).select(cols)
        .eq('company_entity_id', CO).eq('program_id', programId)
        .gte('order_day', since)
        .order('order_day', { ascending: false }).order('id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      return error ? null : (data || []);
    } catch (_) { return null; }
  });
}
const loadOvAttributions = (p) => (p ? loadPaged('affiliate_attributions',
  'id, affiliate_id, order_id, order_day, basis, gross_subtotal_cents, commissionable_cents, order_currency',
  dayShift(today(), OV_DAYS_BACK), p.id) : null);
const loadOvLedger = (p) => (p ? loadPaged('affiliate_commission_ledger',
  'id, affiliate_id, order_day, amount_cents, currency', dayShift(today(), OV_DAYS_BACK), p.id) : null);

// Where this program's affiliate links open: the same rule as the database's
// affiliate_program_store_url -- the store address, else the only Shopify store.
function storeOf(p) {
  if (p?.store_url) return p.store_url;
  if (Array.isArray(p?.shop_domains) && p.shop_domains.length === 1) return `https://${p.shop_domains[0]}`;
  const st = S.d?.stores;
  return Array.isArray(st) && st.length === 1 ? `https://${st[0]}` : null;
}
const needsStore = (p) => !storeOf(p);
// The stores a program covers (20261117030000): NULL = every store.
const hasStorePick = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'shop_domains'));
const storeName = (d) => String(d).replace(/\.myshopify\.com$/, '');
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
// A box with nothing in it is not drawn (Blake, 2026-11-17: "a lot of shit
// to look at"). A tab left with nothing says so once (see render()).
const EMPTY_ONLY = /^\s*<div class="bcn-empty">[^<]*<\/div>\s*$/;
const card = (title, body, meta = '', extraClass = '') => (EMPTY_ONLY.test(body) ? '' : `<div class="bcn-card${extraClass ? ` ${extraClass}` : ''}"><div class="bcn-card-header"><h2>${esc(title)}</h2>${meta ? `<span class="bcn-card-meta">${meta}</span>` : ''}</div><div class="bcn-card-body">${body}</div></div>`);
const empty = (t) => `<div class="bcn-empty">${esc(t)}</div>`;
function table(cols, rows, emptyText = 'Nothing here yet.') {
  if (!rows.length) return empty(emptyText);
  return `<div class="af-scroll"><table class="bcn-table"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="af-num"' : c.left ? ' class="bcn-th-left"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="af-num"' : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function itemList(rows, renderRow, emptyText = 'Nothing here yet.', layout = 'stack') {
  if (!rows.length) return empty(emptyText);
  const cls = layout === 'grid' ? 'af-items af-items--grid' : 'af-items';
  return `<div class="${cls}" role="list">${rows.map(renderRow).join('')}</div>`;
}
// ── Queues ───────────────────────────────────────────────────────────────
// Blake, 2026-11-17: "selection boxes or approved queues". Tick rows, then
// act on the ticked ones; nothing moves until a person presses. Each queue
// keeps its own ticks, and a tick on a row that left the queue is dropped.
const QSEL = {}; const QROWS = {};
const qsel = (k) => (QSEL[k] ||= new Set());
function queue(k, rows, renderRow, actions, emptyText) {
  const sel = qsel(k);
  const ids = rows.map((r) => r.id); QROWS[k] = ids;
  for (const id of [...sel]) if (!ids.includes(id)) sel.delete(id);
  if (!rows.length) return empty(emptyText);
  const can = actions.length > 0;
  const all = ids.every((id) => sel.has(id));
  const bar = can ? `<div class="af-row af-bulk af-q-bar"><label class="af-q-all"><input type="checkbox" class="af-pick" data-act="q-all" data-q="${k}"${all ? ' checked' : ''} /> Select all ${num(rows.length)}</label>${sel.size ? `<span class="af-mono">${num(sel.size)} selected</span>${actions.map(([label, act, kind = 'surface', opts = {}]) => btn(label, act, { q: k }, kind, opts)).join('')}` : ''}</div>` : '';
  const pick = (r) => (can ? `<input type="checkbox" class="af-pick af-q-pick" data-act="q-pick" data-q="${k}" data-id="${esc(r.id)}" aria-label="Select"${sel.has(r.id) ? ' checked' : ''} />` : '');
  return `${bar}<div class="af-q" role="list">${rows.map((r) => `<div class="af-q-row${sel.has(r.id) ? ' is-selected' : ''}" role="listitem">${pick(r)}<div class="af-q-body">${renderRow(r)}</div></div>`).join('')}</div>`;
}
const picked = (k) => [...qsel(k)];

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
function photoAvatar(person, photo) {
  return personAvatar(person, 'lg') + (photo ? `<img class="af-avatar-photo" src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
}
document.addEventListener('error', (ev) => { if (ev.target?.classList?.contains('af-avatar-photo')) ev.target.remove(); }, true);
// Tiles or a list (table with the same photos). Remembered per viewer.
const VIEW_KEY = 'silo.affiliates.view';
function readView() { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'tiles'; } catch { return 'tiles'; } }
function viewToggle() {
  return `<div class="af-view-toggle" role="group" aria-label="View">${[['tiles', 'Tiles'], ['list', 'List']].map(([v, label]) => `<button type="button" class="bcn-btn${S.view === v ? ' bcn-btn--primary' : ' bcn-btn--ghost'}" data-act="view-set" data-v="${v}" aria-pressed="${S.view === v}">${label}</button>`).join('')}</div>`;
}
const listThumb = (person, photo) => `<span class="af-list-thumb">${photoAvatar(person, photo)}</span>`;
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
// Nothing is folded away (Blake, 2026-11-13: "i don't want hiding optional
// confusion"). Detail and admin views are not drawn on the screen they came
// from: each is collected here and shown, open, on the Records tab.
const RECORDS = new Map();
const more = (label, parts) => { RECORDS.set(label, parts.filter(Boolean)); return ''; };
// A plain, always-open section with a heading.
const section = (label, parts) => { const p = parts.filter(Boolean); return p.length ? `<section class="af-section"><h3 class="af-settings-title">${esc(label)}</h3><div class="af-stack">${p.join('')}</div></section>` : ''; };
// Records is one list at a time, picked from a row of chips (Blake
// 2026-11-17: it read as "a big spreadsheet of slop"). Each list shows its
// first RECORD_ROWS rows; "Show all" opens the rest in place.
const RECORD_GROUPS = [
  ['codes', 'Codes', ['Codes and links']],
  ['orders', 'Orders', ['Every order']],
  ['money', 'Ledger', ['Balances', 'Periods and ledger']],
  ['messages', 'Messages', ['Message history']],
  ['recruiting', 'Recruiting', ['Recruiting tools']],
  ['team', 'Team', ['Team and status']],
];
const RECORD_ROWS = 12;
function renderRecords() {
  RECORDS.clear();
  // The screens these come from draw into their own (hidden) panels, which
  // fills RECORDS; the records themselves are drawn only here.
  renderAffiliates(); renderProspects(); renderOutreach(); renderPayoutsTab({ quiet: true });
  if (MANAGE && prog()) more('Team and status', ['<div id="managersCard"></div>', S.d ? stageCard() : '']);
  const groups = RECORD_GROUPS.map(([key, title, keys]) => ({ key, title, parts: keys.flatMap((k) => RECORDS.get(k) || []) })).filter((g) => g.parts.length);
  if (!groups.some((g) => g.key === S.recTab)) S.recTab = groups[0]?.key || null;
  const g = groups.find((x) => x.key === S.recTab);
  const chips = `<div class="af-rec-chips" role="tablist" aria-label="Records">${groups.map((x) => `<button type="button" class="af-rec-chip${x.key === S.recTab ? ' is-on' : ''}" role="tab" aria-selected="${x.key === S.recTab}" data-act="rec-tab" data-k="${x.key}">${esc(x.title)}</button>`).join('')}</div>`;
  $('recordsBody').innerHTML = g ? `${chips}<div class="af-rec-list${S.recAll ? '' : ' af-rec-capped'}" id="recList">${g.parts.join('')}</div>` : empty('Nothing recorded yet.');
  // "Show all" only where a list is longer than the first rows.
  const list = $('recList');
  if (list && !S.recAll && [...list.querySelectorAll('[role="list"]')].some((l) => l.children.length > RECORD_ROWS)) {
    list.insertAdjacentHTML('beforeend', `<div class="af-row">${btn('Show all', 'rec-all', {}, 'surface')}</div>`);
  }
  renderManagers();
}
const surface = (title, body, meta = '', id = '') => {
  if (EMPTY_ONLY.test(body)) return '';
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section class="af-surface"${idAttr}><header class="af-surface-head"><h2>${esc(title)}</h2>${meta ? `<span class="af-muted">${esc(meta)}</span>` : ''}</header><div class="af-surface-body">${body}</div></section>`;
};
const val = (id) => ($(id)?.value ?? '').trim();
const today = () => new Date().toISOString().slice(0, 10);
const money = (c) => formatMoney(c, prog()?.currency);

function scrollWorkflowTo(id) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}
function workflowFocusTab(t) {
  if (t === 'people') { scrollWorkflowTo('affiliatesBody'); return; }
  if (t === 'program') { scrollWorkflowTo('programBody'); return; }
  if (t === 'prospects') {
    S.prospectFilter = 'new';
    S.prospectShowAll = false;
    scrollWorkflowTo('afCreatorsList');
    return;
  }
  if (t === 'payouts') scrollWorkflowTo('payoutsBody');
  else scrollWorkflowTo(`${t}Body`);
}
function renderWorkflowTabCounts() {
  const p = prog(); const d = S.d; const h = d?.health;
  if (!p || !h) return;
  const msgN = Number(h.outreach_approved || 0) + Number(h.outreach_exported || 0) + d.drafts.filter((x) => x.state === 'draft').length;
  const payN = (d.balances || []).filter((b) => b.currency === p.currency && Number(b.unclaimed_cents) > 0).length;
  const onboardN = Number(h.codes_never_seen || 0) + d.codes.filter((c) => c.status === 'pending').length;
  const contentN = (d.content || []).filter((x) => x.state === 'submitted').length;
  const appliedN = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status)).length;
  const counts = { people: Math.max(0, Number(h.prospects_new || 0) - appliedN) + onboardN + contentN, comms: msgN + appliedN, payouts: payN };
  for (const b of document.querySelectorAll('#tabs [data-tab]')) {
    const n = counts[b.dataset.tab];
    let badge = b.querySelector('.af-tab-count');
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'af-tab-count'; b.appendChild(badge); }
      badge.textContent = num(n);
    } else if (badge) badge.remove();
  }
}
// Four panels, not six: Home, People, Money, Setup. The old tab names are
// still how the rest of this file refers to a place -- they are now the
// SECTION inside a panel, and PANEL_OF says which panel holds each one.
const PANEL_OF = {
  overview: 'overview', people: 'people', payouts: 'payouts', program: 'program', records: 'records',
  prospects: 'people', outreach: 'comms', comms: 'comms', affiliates: 'people', share: 'comms',
};
// Where a panel's "no program yet" message goes, since People and Setup each
// hold more than one body.
const FIRST_BODY = { overview: 'overviewBody', people: 'affiliatesBody', comms: 'outreachBody', payouts: 'payoutsBody', program: 'programBody', records: 'recordsBody' };
const PANEL_RENDERERS = {
  overview: [renderOverview],
  people: [renderAffiliates, renderProspects],
  comms: [renderOutreach, renderShare],
  payouts: [renderPayoutsTab],
  program: [renderProgram],
  records: [renderRecords],
};

function render() {
  const p = prog();
  const main = document.querySelector('.silo-main.af-studio');
  main?.classList.toggle('af-studio--ready', !!p);
  main?.classList.toggle('af-studio--workflow', !!p && !['overview', 'program', 'records'].includes(S.tab));
  for (const s of document.querySelectorAll('[data-panel]')) s.hidden = s.dataset.panel !== S.tab;
  for (const b of document.querySelectorAll('#tabs [data-tab]')) {
    const on = PANEL_OF[b.dataset.tab] === S.tab;
    b.classList.toggle('bcn-tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  renderKpis();
  if (!p && S.tab !== 'program') {
    const body = $(FIRST_BODY[S.tab] || 'overviewBody');
    if (body) body.innerHTML = card('Start here', `<p>No affiliate program exists for this company yet.</p>${MANAGE ? btn('Create a program', 'new-program', {}, 'primary') : '<p class="af-muted">Ask someone with Affiliate Studio access to create one.</p>'}`);
    return;
  }
  for (const r of (PANEL_RENDERERS[S.tab] || PANEL_RENDERERS.overview)) r();
  const panel = document.querySelector(`[data-panel="${PANEL_OF[S.tab] || 'overview'}"]`);
  const first = $(FIRST_BODY[PANEL_OF[S.tab]] || '');
  if (panel && first && ![...panel.querySelectorAll('.af-stack, .af-ov')].some((el) => el.innerHTML.trim())) first.innerHTML = empty('Nothing waiting here.');
  renderWorkflowTabCounts();
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
// Everything waiting on a person, in one list.
function todoItems() {
  const d = S.d; const p = prog(); if (!d || !p) return [];
  const h = d.health || {};
  const items = [];
  // `extra` is the button that finishes the job from here. Blake, 2026-11-13:
  // "I shouldn't have to press so many buttons to move along the flow" -- so a
  // row that can be done in one press carries that press, and Open is the way
  // to look rather than the way to act.
  const items_ = [];
  const add = (n, text, tab, extra = '') => { if (n) items_.push({ text, tab, extra }); };
  add(p.status !== 'active', `The program is ${p.status}. Set it to active in Setup to start recruiting.`, 'program');
  add(!p.terms_markdown, 'Write your program terms in Setup. Affiliates accept them to join.', 'program');
  const appliedWaiting = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status)).length;
  const toReview = Math.max(0, Number(h.prospects_new || 0) - appliedWaiting);
  add(appliedWaiting, `${num(appliedWaiting)} application(s) waiting.`, 'outreach');
  add(toReview, `${num(toReview)} creator(s) waiting for your review.`, 'prospects');
  const drafts = d.drafts.filter((x) => x.state === 'draft').length;
  add(drafts, `${num(drafts)} message(s) to approve.`, 'outreach', MANAGE ? btn(`Approve all ${num(drafts)}`, 'q-msgs', {}, 'primary') : '');
  const dmReady = d.drafts.filter((x) => x.state === 'approved' && isDm(x)).length;
  const emailReady = Math.max(0, Number(h.outreach_approved || 0) - dmReady);
  add(emailReady, `${num(emailReady)} approved message(s) waiting for your MCP agent to send.`, 'outreach', MANAGE ? btn('Copy prompt', 'copy-send-prompt', {}, 'surface') : '');
  add(dmReady, `${num(dmReady)} creator(s) with no email to message on social.`, 'outreach');
  add(Number(h.outreach_exported || 0), `${num(h.outreach_exported)} sent message(s) to mark as sent.`, 'outreach');
  const pending = d.codes.filter((c) => c.status === 'pending').length;
  add(pending, `${num(pending)} code(s) waiting to be made in Shopify.`, 'affiliates', MANAGE ? btn('Make in Shopify', 'code-make', {}, 'primary') : '');
  const coded = new Set(d.codes.filter((c) => c.status !== 'retired').map((c) => c.affiliate_id));
  const codeless = d.affiliates.filter((a) => a.status === 'active' && !coded.has(a.id)).length;
  add(codeless, `${num(codeless)} affiliate(s) without a code.`, 'affiliates', MANAGE ? btn(`Make ${num(codeless)} code(s)`, 'q-codes', {}, 'primary') : '');
  add(Number(h.codes_never_seen || 0), `${num(h.codes_never_seen)} code(s) have never appeared on an order. Check each exists in Shopify with the same spelling.`, 'affiliates');
  const unattributed = (h.attributions_ambiguous || 0) + (h.attributions_multi_code_refused || 0) + (h.attributions_outside_window || 0) + (h.attributions_currency_mismatch || 0) + (h.attributions_refunds_unmeasured || 0);
  add(unattributed, `${num(unattributed)} order(s) with an affiliate code were not credited.`, 'payouts');
  const seedAsks = (d.seeds || []).filter((x) => x.state === 'requested').length;
  add(seedAsks, `${num(seedAsks)} product request(s) from affiliates.`, 'people', MANAGE ? btn(`Approve all ${num(seedAsks)}`, 'q-seeds', {}, 'primary') : '');
  const seedCodes = (d.seeds || []).filter((x) => x.state === 'approved').length;
  add(seedCodes, `${num(seedCodes)} product code(s) waiting to be made in Shopify.`, 'people', MANAGE ? btn('Make in Shopify', 'seed-make', {}, 'primary') : '');
  const contentAsks = (d.content || []).filter((x) => x.state === 'submitted').length;
  add(contentAsks, `${num(contentAsks)} piece(s) of content from affiliates to review.`, 'affiliates');
  const owed = (d.balances || []).filter((x) => x.currency === p.currency && Number(x.unclaimed_cents) > 0).length;
  add(MANAGE && owed, `${num(owed)} affiliate(s) with earnings to put in a payout.`, 'payouts', btn(`Build ${num(owed)} payout(s)`, 'q-payouts', {}, 'primary'));
  const toApprove = d.payouts.filter((x) => x.status === 'draft').length;
  add(MONEY && toApprove, `${num(toApprove)} payout(s) to approve.`, 'payouts');
  if (!items_.length && !d.prospects.length) items_.push({ text: 'Find your first creators: describe who you want and press Find creators.', tab: 'prospects', extra: '' });
  return items_;
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
function aiHubOverviewSection() {
  if (!MANAGE || !prog() || !S.d) return '';
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
  // The prompts are buttons, never a fold-out to find them in.
  const hints = !workSend && !workCodes && (canSend || canCode)
    ? `<div class="af-ai-actions af-ai-actions--tight">${btn('Copy send prompt', 'copy-send-prompt', {}, 'surface')}${btn('Copy codes prompt', 'copy-codes-prompt', {}, 'surface')}</div>`
    : '';
  const manageKind = connectPrimary ? 'primary' : '';
  return card('Your AI', `
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
  const labels = stageLabels({ discoveryRuns: d.runs, notifications: d.notifications, codesSeen: d.codes.filter((c) => c.verified_at).length, codesTotal: liveCodeCount(d.codes), ledgerEntries: d.ledgerCount, sources: 0 });
  const row = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.stage)} <span class="af-stage af-label-${esc(r.label.replace(' ', '-'))}">${esc(r.label)}</span></div><div class="af-muted">${esc(r.detail)}</div></div></article>`;
  return card('How each part works for this company', itemList(labels, row, 'Nothing to report yet.'));
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
// The program's own outreach message exists once 20261111020000 is applied.
// Product seeding exists once 20261113093000 is applied.
const hasSeeding = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'seeding_enabled'));
// Content bonus exists once 20261117050000 is applied.
const hasContentBonus = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'content_bonus_cents'));
const storesCard = (p, dis) => {
  const st = Array.isArray(S.d?.stores) ? S.d.stores : [];
  if (!hasStorePick() || st.length < 2) return '';
  const picked = Array.isArray(p.shop_domains) ? p.shop_domains : null;
  return card('Stores', setRow('Counts orders from', `<div class="af-chips-tog">${st.map((x) => { const on = !picked || picked.includes(x); return `<button type="button" class="af-chip-tog pStore${on ? ' is-on' : ''}" data-store="${esc(x)}" aria-pressed="${on}" ${dis}>${esc(storeName(x))}</button>`; }).join('')}</div>`));
};
const hasOutreachMessage = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'outreach_body'));
// Setup is a settings page, not a form (Blake, 2026-11-13: "looks like 98
// windows forms, need modernized"; "i don't want hiding"). Every setting is
// in plain sight, in a card per subject, one row each: the name on the left,
// the control on the right. Choices are chips and switches, not dropdowns.
// An existing program saves as you go; a new one has one Create button.
const setRow = (label, control, id = '') => `<div class="af-set-row"${id ? ` id="${id}"` : ''}><div class="af-set-label">${esc(label)}</div><div class="af-set-ctl">${control}</div></div>`;
// A row of chips standing in for a select: the hidden input keeps the id the
// form reads, and a press sets it and announces the change.
const seg = (id, options, cur, dis) => `<div class="af-seg" role="radiogroup" data-seg-for="${id}">${options.map(([v, label]) => `<button type="button" class="af-seg-btn${String(cur ?? '') === String(v) ? ' is-on' : ''}" role="radio" aria-checked="${String(cur ?? '') === String(v)}" data-seg="${id}" data-v="${esc(v)}" ${dis}>${esc(label)}</button>`).join('')}</div><input type="hidden" id="${id}" value="${esc(cur ?? '')}" />`;
const PLATFORM_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', twitch: 'Twitch', x: 'X', pinterest: 'Pinterest', blog: 'Blog', web: 'Web' };
const setInput = (id, attrs = '') => `<input class="bcn-field af-set-input" id="${id}" ${attrs} />`;
function syncCommissionFields() {
  const kind = $('pKind')?.value;
  const pct = $('rowPct'); const fix = $('rowFixed');
  if (pct) pct.hidden = kind === 'fixed_per_order';
  if (fix) fix.hidden = kind === 'percent_of_net';
  const seedOn = $('pSeedOn')?.value !== '0';
  for (const r of document.querySelectorAll('.af-seed-dep')) r.hidden = !seedOn;
}
function renderProgram(isNew = S.creating) {
  const p = isNew ? {} : (prog() || {});
  const dis = MANAGE ? '' : 'disabled';
  const plats = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web'];
  const units = minorUnits(p.currency || 'USD');
  const major = (c) => (c === null || c === undefined ? '' : (Number(c) / units).toString());
  const cur = esc(p.currency || 'USD');
  const program = card('Program', [
    setRow('Name', setInput('pName', `${dis} value="${esc(p.name || '')}" placeholder="Creator program"`)),
    setRow('Status', seg('pStatus', [['draft', 'Draft'], ['active', 'Active'], ['paused', 'Paused'], ['closed', 'Closed']], p.status ?? 'draft', dis)),
    setRow('Joining', seg('pIntake', [['invite_only', 'Invite only'], ['open', 'Open applications']], p.intake_mode ?? 'invite_only', dis)),
    !isNew && p.id && p.intake_mode === 'open' ? setRow('Application link', `<div class="af-row">${btn('Copy link', 'copy-text', { t: applyUrl(location.origin, CO, p.slug) }, 'primary')}<a class="bcn-btn" href="${esc(safeHref(applyUrl(location.origin, CO, p.slug)) || '#')}" target="_blank" rel="noopener">Open</a></div>`) : '',
    setRow('Link name', setInput('pSlug', `${dis} value="${esc(p.slug || '')}" placeholder="creator-program"`)),
    setRow('Owner', `<select class="bcn-field af-set-input" id="pOwner" ${dis}><option value="">—</option>${S.profiles.map((u) => `<option value="${u.id}"${u.id === p.owner_user_id ? ' selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select>`),
  ].join(''));
  const pay = card('Pay', [
    setRow('Commission', seg('pKind', [['percent_of_net', '% of order'], ['fixed_per_order', 'Fixed per order']], p.commission_kind ?? 'percent_of_net', dis)),
    setRow('Percent', `<div class="af-set-unit">${setInput('pPct', `${dis} type="number" step="0.001" min="0" max="100" value="${esc(p.commission_percent ?? '')}"`)}<span>%</span></div>`, 'rowPct'),
    setRow('Per order', `<div class="af-set-unit">${setInput('pFixed', `${dis} inputmode="decimal" value="${esc(major(p.commission_fixed_cents))}"`)}<span>${cur}</span></div>`, 'rowFixed'),
    hasAutoCode() ? setRow('Their code takes off', `<div class="af-set-unit">${setInput('pAutoPct', `${dis} type="number" step="1" min="1" max="100" placeholder="—" value="${esc(isNew ? 10 : (p.default_discount_percent ?? ''))}"`)}<span>%</span></div>`) : '',
    setRow('Currency', setInput('pCur', `${dis} maxlength="3" value="${esc(p.currency || 'USD')}" style="max-width:6rem"`)),
    setRow('Pay affiliates', seg('pPayMethod', [['manual', 'By hand'], ['paypal_payouts', 'PayPal']], p.payout_method ?? 'manual', dis)),
    setRow('Payout minimum', `<div class="af-set-unit">${setInput('pMin', `${dis} inputmode="decimal" placeholder="0" value="${esc(major(p.payout_minimum_cents))}"`)}<span>${cur}</span></div>`),
    setRow('Payable after', `<div class="af-set-unit">${setInput('pHold', `${dis} type="number" min="0" max="365" value="${esc(p.refund_hold_days ?? 30)}"`)}<span>days</span></div>`),
    hasContentBonus() ? setRow('Content bonus', `<div class="af-set-unit">${setInput('pBonus', `${dis} inputmode="decimal" placeholder="—" value="${esc(major(p.content_bonus_cents))}"`)}<span>${cur} per piece you use</span></div>`) : '',
  ].join(''));
  const seeding = hasSeeding() ? card('Product seeding', [
    setRow('Offer products', seg('pSeedOn', [['1', 'On'], ['0', 'Off']], p.seeding_enabled === false ? '0' : '1', dis)),
    `<div class="af-seed-dep">${setRow('Product % off', `<div class="af-set-unit">${setInput('pSeedPct', `${dis} type="number" step="1" min="1" max="100" value="${esc(p.seed_discount_percent ?? 50)}"`)}<span>%</span></div>`)}</div>`,
    `<div class="af-seed-dep">${setRow('Paid back after', `<div class="af-set-unit">${setInput('pSeedMult', `${dis} type="number" step="0.5" min="1" max="20" value="${esc(p.seed_multiple ?? 3)}"`)}<span>× what they paid in sales</span></div>`)}</div>`,
  ].join('')) : '';
  const recruit = card('Who you recruit', [
    setRow('Niche', setInput('pNiche', `${dis} value="${esc(p.niche || '')}" placeholder="youth baseball training"`)),
    setRow('Audience', setInput('pAudience', `${dis} value="${esc(p.audience_notes || '')}" placeholder="Who the ideal creator speaks to"`)),
    setRow('Countries', setInput('pGeo', `${dis} value="${esc((p.geographies || []).join(', '))}" placeholder="US, CA"`)),
    setRow('Platforms', `<div class="af-chips-tog">${plats.map((x) => `<button type="button" class="af-chip-tog pPlat${(p.platforms || []).includes(x) ? ' is-on' : ''}" data-plat="${x}" aria-pressed="${(p.platforms || []).includes(x)}" ${dis}>${esc(PLATFORM_NAMES[x] || x)}</button>`).join('')}</div>`),
  ].join(''));
  // The message to creators is prepped on Comms now (Blake, 2026-11-17).
  const message = '';
  const terms = card(`Terms${p.terms_version ? ` · v${p.terms_version}` : ''}`,
    `<textarea class="bcn-field af-set-input" id="pTerms" rows="8" ${dis} placeholder="Commission, crediting, refunds, payouts, rules">${esc(p.terms_markdown || '')}</textarea>`);
  const codes = card('Codes', [
    setRow('Codes start', setInput('pStart', `${dis} type="date" value="${esc(p.default_code_starts_on || '')}"`)),
    setRow('Codes end', setInput('pEnd', `${dis} type="date" value="${esc(p.default_code_ends_on || '')}"`)),
    setRow('Grace after a code ends', `<div class="af-set-unit">${setInput('pGrace', `${dis} type="number" min="0" max="365" value="${esc(p.attribution_window_days ?? 0)}"`)}<span>days</span></div>`),
    setRow('Two codes on one order', seg('pPrec', [['first_affiliate_code', 'Credit one'], ['single_code_only', 'Credit none']], p.code_precedence ?? 'first_affiliate_code', dis)),
  ].join(''));
  // Who can run Studio and how each part works are on Records (Blake,
  // 2026-11-17: "so many boxes"); Setup is the program's own settings.
  const access = '';
  const create = isNew && MANAGE ? `<div class="af-settings-save">${btn('Create program', 'save-program', {}, 'primary')}${S.programs.length ? btn('Cancel', 'cancel-new', {}, 'surface') : ''}</div>` : '';
  const saved = !isNew && MANAGE ? '<span class="af-set-saved" id="setSaved" aria-live="polite"></span>' : '';
  $('programBody').innerHTML = `<div class="af-settings">${saved}
    <div class="af-settings-col">${program}${storesCard(p, dis)}${pay}${seeding}${codes}${create}</div>
    <div class="af-settings-col">${recruit}${message}${terms}${access}</div></div>`;
  syncCommissionFields();
}

// Chips and switches on Setup, and saving as you go.
document.addEventListener('click', (ev) => {
  const s = ev.target.closest('[data-seg]');
  if (s && !s.disabled) {
    const box = s.closest('.af-seg');
    for (const b of box.querySelectorAll('[data-seg]')) { const on = b === s; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); }
    const inp = $(s.dataset.seg); if (inp) { inp.value = s.dataset.v; inp.dispatchEvent(new Event('change', { bubbles: true })); }
    syncCommissionFields();
    return;
  }
  const c = ev.target.closest('[data-plat], [data-store]');
  if (c && !c.disabled) {
    c.classList.toggle('is-on'); c.setAttribute('aria-pressed', String(c.classList.contains('is-on')));
    c.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
// Autosave. Each edit is captured WHEN it happens -- the form's values and
// the program they belong to -- so a save that runs later can never read
// another program's form or land on another program. Switching programs
// saves what is pending first.
let saveTimer = null; let saving = Promise.resolve(); let pendingSave = null;
// "From search" picks out one search's results on the prospect list.
document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'pQuery') return;
  S.prospectQuery = ev.target.value; S.sel.clear(); S.prospectShowAll = false; render();
});
document.addEventListener('change', (ev) => {
  if (S.creating || !MANAGE || !ev.target.closest('#programBody')) return;
  clearTimeout(saveTimer);
  try { pendingSave = { id: S.programId, row: programRowFromForm() }; } catch (e) { pendingSave = null; setStatus(friendly(e), 'neg'); return; }
  saveTimer = setTimeout(flushProgramSave, 350);
});
function flushProgramSave() {
  clearTimeout(saveTimer);
  const p = pendingSave; pendingSave = null;
  if (p) saving = saving.then(() => autosaveProgram(p));
  return saving;
}
async function autosaveProgram({ id, row }) {
  const el = () => (S.programId === id ? $('setSaved') : null);
  try {
    if (el()) el().textContent = 'Saving…';
    await updateRows('affiliate_programs', { ...row, changed_by: me.id }, { id });
    // The row as the database now has it (a terms edit bumps its version),
    // without redrawing the page under the person's cursor.
    const fresh = must(await db.from('affiliate_programs').select('*').eq('company_entity_id', CO).eq('id', id).maybeSingle());
    if (fresh) S.programs = S.programs.map((x) => (x.id === fresh.id ? fresh : x));
    if (el()) el().textContent = 'Saved';
  } catch (e) {
    if (el()) el().textContent = '';
    setStatus(friendly(e), 'neg');
  }
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
    platforms: [...document.querySelectorAll('.pPlat.is-on')].map((x) => x.dataset.plat),
    intake_mode: val('pIntake'), commission_kind: val('pKind'), commission_percent: val('pPct'), commission_fixed: val('pFixed'),
    currency: val('pCur'), default_code_starts_on: val('pStart'), default_code_ends_on: val('pEnd'),
    attribution_window_days: val('pGrace'), code_precedence: val('pPrec'), refund_hold_days: val('pHold'),
    ...($('pPayMethod') ? { payout_method: val('pPayMethod') } : {}),
    ...(hasAutoCode() ? { default_discount_percent: val('pAutoPct') } : {}),
    ...($('programBody')?.querySelector('.pStore') ? { shop_domains: [...document.querySelectorAll('.pStore')].map((x) => ({ d: x.dataset.store, on: x.classList.contains('is-on') })) } : {}),
    ...($('pBonus') ? { content_bonus: val('pBonus') } : {}),
    payout_minimum: val('pMin'), discovery_max_cost_usd: S.creating ? '' : (prog()?.discovery_max_cost_usd ?? ''), terms_markdown: $('pTerms').value,
  });
}

// ── Prospects ────────────────────────────────────────────────────────────
function renderProspects() {
  const d = S.d; const p = prog();
  const filter = S.prospectFilter || 'new';
  const GROUPS = { new: ['new', 'qualified'], approved: ['approved', 'invited', 'signed_up'], all: null };
  // Applications wait on Outreach > Inbound (Blake, 2026-11-17), not here.
  const inGroup = (x, g) => (!GROUPS[g] || GROUPS[g].includes(x.status)) && !(g === 'new' && x.source === 'applied');
  // The search a prospect came from, so one search's results can be picked out.
  const fromQuery = (x) => String(x.evidence?.last_seen_query || x.evidence?.query || '').trim();
  const queries = [...new Set(d.prospects.filter((x) => inGroup(x, filter)).map(fromQuery).filter(Boolean))].slice(0, 30);
  if (S.prospectQuery && !queries.includes(S.prospectQuery)) S.prospectQuery = '';
  const list = d.prospects.filter((x) => inGroup(x, filter) && (!S.prospectQuery || fromQuery(x) === S.prospectQuery));
  // Bulk selection: only prospects in this view stay selected.
  const inView = new Set(list.map((x) => x.id));
  for (const id of [...S.sel]) if (!inView.has(id)) S.sel.delete(id);
  S.viewIds = list.map((x) => x.id);
  const live = new Set(d.drafts.filter((x) => ['draft', 'approved', 'exported'].includes(x.state)).map((x) => x.prospect_id));
  const contacted = new Set(d.drafts.filter((x) => x.state === 'sent').map((x) => x.prospect_id));
  const actions = (x) => {
    if (!MANAGE) return '';
    const b = [];
    if (['new', 'qualified', 'rejected'].includes(x.status)) b.push(btn('Approve', 'prospect-status', { id: x.id, s: 'approved' }, 'primary'));
    if (['new', 'qualified', 'approved'].includes(x.status)) b.push(btn('Reject', 'prospect-status', { id: x.id, s: 'rejected' }));
    if (x.status === 'rejected') b.push(pill('rejected'));
    if (x.status === 'approved' && !live.has(x.id)) b.push(btn('Draft message', 'draft-create', { id: x.id }));
    if (['new', 'qualified', 'approved'].includes(x.status) && !live.has(x.id) && !contacted.has(x.id)) b.push(btn('Mark contacted', 'prospect-contacted', { id: x.id }));
    if (['approved', 'invited'].includes(x.status) && x.contact_email) b.push(INVITE_SOURCES.has(x.source) ? btn(x.status === 'invited' ? 'Resend invite' : 'Send invite', 'invite-send', { id: x.id }) : btn('Signup link', 'signup-link', { id: x.id }));
    if (!['suppressed', 'signed_up', 'rejected'].includes(x.status)) b.push(btn('Do not contact', 'prospect-suppress', { id: x.id }, 'surface', { confirm: true }));
    if (x.status !== 'suppressed') b.push(btn('Edit', 'prospect-edit', { id: x.id }, 'ghost'));
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const who = (x) => {
    const link = x.profile_url ? ext(x.profile_url, x.display_name || x.handle || x.profile_url) : esc(x.display_name || x.handle);
    return `${link}<div class="af-muted">${esc(x.platform)}${x.handle ? ` · ${esc(x.handle)}` : ''}</div>${x.contact_email ? `<div class="af-muted">${esc(x.contact_email)}</div>` : ''}`;
  };
  const sourceLine = (x) => { const e = x.evidence || {}; return `${esc(sourceLabel(x.source))}${e.query ? ` · “${esc(e.query)}”` : ''} · ${fmtDate(x.collected_at)}${x.source_url ? ` · ${ext(x.source_url, 'source')}` : ''}`; };
  const provenance = (x) => {
    const e = x.evidence || {};
    return `<div class="af-evidence">${e.title ? `<strong>${esc(e.title)}</strong><br>` : ''}${esc(e.snippet || e.note || e.pitch || '')}</div>
      <div class="af-muted">${sourceLine(x)}</div>`;
  };
  const contact = (x) => (x.contact_email
    ? `${esc(x.contact_email)}${x.contact_source_url ? `<div class="af-muted">${ext(x.contact_source_url, 'where it was stated')}</div>` : '<div class="af-muted">entered by a person</div>'}`
    : '<span class="af-muted">not found</span>');
  const followers = (x) => {
    const f = followersFrom(x.evidence);
    if (!f) return '<span class="af-muted">—</span>';
    const where = f.source_url ? `${ext(f.source_url, f.kind === 'youtube' ? 'YouTube' : f.kind === 'profile' ? 'on their profile' : f.kind === 'other_page' ? 'from another page' : 'where it was stated')}${f.as_of ? ` · ${fmtDate(f.as_of)}` : ''}` : (x.source === 'csv_import' ? 'from your list' : '');
    return `${num(f.count)}${where ? `<div class="af-muted">${where}</div>` : ''}`;
  };
  const researching = S.watching && d.runs.some((r) => r.id === S.watching);
  const filters = [['new', 'To review'], ['approved', 'Approved'], ['all', 'All']];
  const runs = d.runs.slice(0, 10);
  const prospectCard = (x) => {
    const f = followersFrom(x.evidence);
    const followersVal = f ? num(f.count) : '—';
    const st = creatorStats(x.evidence);
    const pct = st?.rate != null ? `${(st.rate * 100).toFixed(1)}%` : '—';
    const facts = st ? [
      st.avgViews != null ? `${num(st.avgViews)} avg views` : '',
      st.topics.length ? esc(st.topics.join(', ')) : '',
      st.brands.length ? `Links: ${esc(st.brands.join(', '))}` : '',
      st.sponsored ? `${num(st.sponsored)} of ${num(st.sample)} recent videos sponsored` : '',
      st.others.length ? st.others.map((o) => ext(o.profile_url, o.platform)).join(' · ') : '',
    ].filter(Boolean) : [];
    const title = x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Creator') : esc(x.display_name || x.handle || 'Creator');
    const sub = `${x.platform || 'creator'}${x.handle ? ` · ${x.handle}` : ''}`;
    const meta = x.contact_email ? esc(x.contact_email) : 'No public email yet';
    return `<article class="af-item af-item--tile af-item--catalog${S.sel.has(x.id) ? ' is-selected' : ''}" role="listitem">
      <header class="af-catalog-head">
        ${MANAGE ? `<input type="checkbox" class="af-pick" data-act="prospect-pick" data-id="${esc(x.id)}" aria-label="Select ${esc(x.display_name || x.handle || 'creator')}"${S.sel.has(x.id) ? ' checked' : ''} />` : ''}
        <div class="af-catalog-thumb">${photoAvatar({ name: x.display_name, email: x.contact_email }, prospectPhotoUrl(x.evidence))}</div>
        <div class="af-catalog-title">
          <div class="af-catalog-name">${title}</div>
          <div class="af-catalog-sub">${esc(sub)}</div>
          <div class="af-catalog-meta">${meta}</div>
        </div>
        ${statusPill(x.status)}
      </header>
      <p class="af-catalog-summary-p">${esc(evidenceSummary(x, 120))}</p>
      <div class="af-kv-line"><span class="bcn-num">${followersVal}</span> followers · <span class="bcn-num">${pct}</span> engagement</div>
      ${facts.length ? `<div class="af-muted af-catalog-facts">${facts.join(' · ')}</div>` : ''}
      <div class="af-muted">${sourceLine(x)}</div>
      <footer class="af-item-foot af-catalog-foot">${actions(x)}</footer>
    </article>`;
  };
  const capped = S.prospectShowAll ? list : list.slice(0, PROSPECT_LIST_CAP);
  const listFoot = list.length > PROSPECT_LIST_CAP
    ? (S.prospectShowAll
      ? `<div class="af-list-foot">${btn(`Show first ${PROSPECT_LIST_CAP}`, 'prospect-show-fewer')}</div>`
      : `<div class="af-list-foot">${btn(`Show all ${list.length}`, 'prospect-show-all')}</div>`)
    : '';
  const findRow = MANAGE
    ? `<div class="af-find-inline">${field('Find more like…', input('rsFocus', `maxlength="500" placeholder="${esc(p.niche ? `e.g. ${p.niche} creators on TikTok` : 'e.g. youth baseball coaches with drill videos')}"`))}${field('How many', input('rsCount', 'type="number" min="5" max="50" value="25" style="max-width:5.5rem"'))}${btn(researching ? 'Finding…' : 'Find creators', 'research-run', {}, 'primary', { disabled: researching })}${btn('Add creators', 'add-creators')}</div>`
    : '';
  // Fill in what search did not find (Blake, 2026-11-17: "so they can CRM it
  // up"). A person's entry is kept: research only fills blanks.
  const ed = S.editProspect ? d.prospectById[S.editProspect] : null;
  const PLATS = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web', 'other'];
  const editor = ed && MANAGE ? card(`Edit ${ed.display_name || ed.handle || 'creator'}`, `<div class="af-grid">
      ${field('Name', input('epName', `value="${esc(ed.display_name || '')}" maxlength="200"`))}
      ${field('Platform', `<select class="bcn-field" id="epPlat">${PLATS.map((x) => `<option value="${x}"${x === ed.platform ? ' selected' : ''}>${esc(PLATFORM_NAMES[x] || x)}</option>`).join('')}</select>`)}
      ${field('Handle', input('epHandle', `value="${esc(ed.handle || '')}" placeholder="@name"`))}
      ${field('Profile URL', input('epUrl', `value="${esc(ed.profile_url || '')}" placeholder="https://"`))}
      ${field('Email', input('epEmail', `type="email" value="${esc(ed.contact_email || '')}"`))}
    </div><div class="af-row" style="margin-top:8px;">${btn('Save', 'prospect-save', { id: ed.id }, 'primary')}${btn('Close', 'prospect-edit-close')}</div>`) : '';
  const adder = S.addCreators && MANAGE ? card('Add creators', `<div class="af-grid">
      ${field('Name', input('mpName'))}${field('Platform', `<select class="bcn-field" id="mpPlat">${PLATS.map((x) => `<option value="${x}">${esc(PLATFORM_NAMES[x] || x)}</option>`).join('')}</select>`)}
      ${field('Handle', input('mpHandle', 'placeholder="@name"'))}${field('Profile URL', input('mpUrl', 'placeholder="https://"'))}
      ${field('Email', input('mpEmail', 'type="email"'))}${field('Where you found them', input('mpSource', 'placeholder="https://"'))}
    </div>${field('Note', input('mpNote', 'placeholder="e.g. met at a tournament"'))}<div class="af-row" style="margin-top:8px;">${btn('Add', 'prospect-add', {}, 'primary')}${btn('Close', 'add-creators-close')}</div><div id="mpOut"></div>
    <div class="af-row" style="margin-top:12px;">${field('Or import a CSV (one creator per row, with a profile link)', '<input class="bcn-field" type="file" id="impFile" accept=".csv,text/csv" />')}${btn('Import', 'import-run', {}, 'primary')}${btn('Download template', 'import-template', {}, 'ghost')}</div>`) : '';
  $('prospectsBody').innerHTML = [
    editor,
    adder,
    surface('Creators', `${findRow}<div class="af-filter-bar">${filters.map(([f, label]) => `<button type="button" class="bcn-btn af-filter-chip${f === filter ? ' af-filter-chip--on bcn-btn--primary' : ''}" data-act="prospect-filter" data-f="${f}">${esc(label)} <span class="af-mono">${d.prospects.filter((x) => inGroup(x, f)).length}</span></button>`).join('')}${viewToggle()}</div>
      ${MANAGE && (list.length || S.prospectQuery) ? `<div class="af-row af-bulk">
        ${queries.length > 1 ? `<select class="bcn-field" id="pQuery" aria-label="From search"><option value="">All searches</option>${queries.map((q) => `<option value="${esc(q)}"${q === S.prospectQuery ? ' selected' : ''}>${esc(q)}</option>`).join('')}</select>` : ''}
        ${btn(`Select all ${list.length}`, 'prospect-select-all')}
        ${S.sel.size ? `<span class="af-mono">${num(S.sel.size)} selected</span>${btn('Approve', 'prospect-bulk', { s: 'approved' }, 'primary')}${btn('Reject', 'prospect-bulk', { s: 'rejected' })}${btn('Do not contact', 'prospect-bulk', { s: 'suppressed' }, 'surface', { confirm: true })}${btn('Clear', 'prospect-select-none')}` : ''}
      </div>` : ''}
      ${S.view === 'list'
        ? table([
          ...(MANAGE ? [{ h: '', f: (x) => `<input type="checkbox" class="af-pick" data-act="prospect-pick" data-id="${esc(x.id)}" aria-label="Select ${esc(x.display_name || x.handle || 'creator')}"${S.sel.has(x.id) ? ' checked' : ''} />` }] : []),
          { left: true, h: 'Creator', f: (x) => `<div class="af-list-who">${listThumb({ name: x.display_name, email: x.contact_email }, prospectPhotoUrl(x.evidence))}<div>${x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Creator') : esc(x.display_name || x.handle || 'Creator')}<div class="af-muted">${esc(x.platform || 'creator')}${x.handle ? ` · ${esc(x.handle)}` : ''}</div></div></div>` },
          { h: 'Followers', num: true, f: (x) => { const f = followersFrom(x.evidence); return f ? num(f.count) : '—'; } },
          { h: 'Engagement', num: true, f: (x) => { const st = creatorStats(x.evidence); return st?.rate != null ? `${(st.rate * 100).toFixed(1)}%` : '—'; } },
          { left: true, h: 'Email', f: (x) => (x.contact_email ? esc(x.contact_email) : '<span class="af-muted">—</span>') },
          { left: true, h: 'Status', f: (x) => statusPill(x.status) },
          { h: '', f: (x) => actions(x) },
        ], capped, filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.')
        : itemList(capped, prospectCard, filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.', 'grid')}
      ${listFoot}
      <div id="signupOut"></div>`, `${list.length} in this view · ${d.prospects.length} total`, 'afCreatorsList'),
    more('Recruiting tools', [
    card('Recent runs', itemList(runs, (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.query || '—')} ${r.dry_run ? pill('dry run') : pill(runKindLabel(r), 'accent')}</div><div class="af-muted">${fmtTime(r.started_at)} · ${statusPill(r.status)}</div><div class="af-kv-line">${num(r.prospects_new)} new · ${num(r.results_returned)} results · ${num(r.emails_found)} emails${r.error ? ` · ${esc(friendlySearchError(r.error))}` : ''}</div></div></article>`, 'Discovery has not run for this program yet.')),
    card('Do-not-contact list', `
      ${itemList(d.suppressions, (s) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head"><span class="af-mono">${esc(s.value_normalized)}</span> ${pill(s.kind)}</div><div class="af-muted">${esc(s.reason)} · ${fmtDate(s.created_at)}</div></div><div class="af-item-foot">${MANAGE ? btn('Remove', 'suppression-remove', { id: s.id }, 'surface', { confirm: true }) : ''}</div></article>`, 'Nobody is on the list.')}
      <div class="af-row" style="margin-top:8px;">${field('Type', '<select class="bcn-field" id="supKind"><option>email</option><option>domain</option><option>handle</option><option value="profile_url">profile URL</option></select>')}${field('Value', input('supVal'))}${field('Reason', '<select class="bcn-field" id="supReason"><option value="opted_out">asked not to be contacted</option><option value="bounced">bounced</option><option value="complained">complained</option><option value="competitor">competitor</option><option value="do_not_contact">do not contact</option><option value="manual">other</option></select>')}${btn('Add', 'suppression-add')}</div>`),
    ]),
  ].join('');
}

// ── Outreach ─────────────────────────────────────────────────────────────
function renderOutreach() {
  const d = S.d; const p = prog();
  const byState = (st) => d.drafts.filter((x) => (Array.isArray(st) ? st.includes(x.state) : x.state === st));
  const who = (x) => `${esc(x.recipient_email || x.recipient_handle)}<div class="af-muted">${esc(d.prospectById[x.prospect_id]?.display_name || '')} · ${esc(x.channel)}</div>`;
  const msg = (x) => `<div class="af-evidence"><strong>${esc(x.subject)}</strong><br>${esc(String(x.body || '').slice(0, 220))}${String(x.body || '').length > 220 ? '…' : ''}</div>`;
  const editing = S.editDraft ? d.drafts.find((x) => x.id === S.editDraft) : null;
  // "Via <app>": a batch an AI connection claimed (outreach:send) to send from
  // the approver's own mailbox, and a send it recorded. Null for a person.
  const batchById = Object.fromEntries((d.batches || []).map((b) => [b.id, b]));
  const viaBatch = (x) => { const b = batchById[x.batch_id]; return b?.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''; };
  const draftCard = (x) => `<article class="af-item af-item--compact"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-item-detail">${msg(x)}</div><div class="af-muted">${fmtDate(x.created_at)}</div></div><div class="af-item-foot">${MANAGE ? btn('Edit', 'draft-edit', { id: x.id }) : ''}</div></article>`;
  const approvedCard = (x) => `<article class="af-item af-item--compact"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-item-detail">${msg(x)}</div><div class="af-muted">Approved ${fmtTime(x.approved_at)}</div></div>${MANAGE ? `<div class="af-item-foot"><div class="af-actions">${btn('Mark sent', 'dm-sent', { id: x.id })}</div></div>` : ''}</article>`;
  const exportedCard = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)}</div><div class="af-muted">Exported ${fmtTime(x.exported_at)}${viaBatch(x)}</div>${MANAGE ? `<div class="af-row" style="margin-top:8px;"><input class="bcn-field" id="ev-${x.id}" placeholder="Where: sent-folder link, DM screenshot ref" />${btn('Mark sent', 'draft-sent', { id: x.id }, 'primary')}</div>` : ''}</div></article>`;
  const drafts = byState('draft'); const readyAll = byState('approved'); const out = byState('exported');
  const ready = readyAll.filter((x) => !isDm(x)); const readyDm = readyAll.filter(isDm);
  const dmCard = (x) => {
    const pr = d.prospectById[x.prospect_id] || {};
    const where = pr.profile_url ? ext(pr.profile_url, `Open ${PLATFORM_NAMES[pr.platform] || pr.platform || 'profile'}`) : '';
    return `<article class="af-item af-item--compact"><div class="af-item-body"><div class="af-item-head">${esc(pr.display_name || x.recipient_handle || '—')}<div class="af-muted">${esc(PLATFORM_NAMES[pr.platform] || pr.platform || 'social')}${x.recipient_handle ? ` · ${esc(x.recipient_handle)}` : ''}</div></div><div class="af-item-detail"><div class="af-evidence">${esc(dmText(x).slice(0, 220))}${dmText(x).length > 220 ? '…' : ''}</div></div></div>
      <div class="af-item-foot"><div class="af-actions">${where}${MANAGE ? btn('Copy message', 'dm-copy', { id: x.id }, 'primary') + btn('Mark sent', 'dm-sent', { id: x.id }) : ''}</div></div></article>`;
  };
  const canSend = (d.aiApps || []).some((a) => a.canSend);
  const tpl = outreachTemplate(p);
  const TAGS = ['{name}', '{brand}', '{platform}', '{source}', '{commission}', '{sender}', '{signup_link}'];
  // The emails SILO sent affiliates on its own (invites, codes, payouts).
  const NOTE_KIND = { signup_invite: 'Invite', signup_confirmation: 'Welcome', portal_link: 'Portal link', link_renewal: 'New portal link', codes_and_links: 'Codes and links', payout_status: 'Payout' };
  const noteRow = (n) => `<article class="af-item af-item--compact"><div class="af-item-body"><div class="af-item-head">${esc(NOTE_KIND[n.kind] || String(n.kind || '').replaceAll('_', ' '))} · ${esc(d.affById[n.affiliate_id]?.display_name || n.to_email || '—')} ${statusPill(n.status)}</div><div class="af-muted">${fmtTime(n.created_at)}${n.status !== 'sent' && n.reason ? ` · ${esc(n.reason)}` : ''}</div></div></article>`;
  // Inbound: people who found the brand and applied (Blake, 2026-11-17).
  const applied = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status));
  const appCard = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Applicant') : esc(x.display_name || x.handle || 'Applicant')}<div class="af-muted">${esc(PLATFORM_NAMES[x.platform] || x.platform || '')}${x.handle ? ` · ${esc(x.handle)}` : ''}${x.contact_email ? ` · ${esc(x.contact_email)}` : ''}</div></div>${x.evidence?.note || x.evidence?.pitch ? `<div class="af-item-detail">${esc(String(x.evidence.note || x.evidence.pitch).slice(0, 300))}</div>` : ''}<div class="af-muted">Applied ${fmtTime(x.collected_at || x.created_at)}</div></div>${MANAGE ? `<div class="af-item-foot"><div class="af-actions">${btn('Approve', 'prospect-status', { id: x.id, s: 'approved' }, 'primary')}${btn('Reject', 'prospect-status', { id: x.id, s: 'rejected' })}</div></div>` : ''}</article>`;
  $('outreachBody').innerHTML = [
    surface('Inbound', itemList(applied, appCard, 'No applications waiting.'), `${num(applied.length)} applied`),
    editing ? card('Edit message', `${field('Subject', input('edSubject', `value="${esc(editing.subject || '')}"`))}${field('Message ({signup_link} is replaced at export)', `<textarea class="bcn-field" id="edBody" rows="10">${esc(editing.body || '')}</textarea>`)}<div class="af-row" style="margin-top:8px;">${btn('Save', 'draft-save', { id: editing.id }, 'primary')}${btn('Close', 'draft-edit-close')}</div>`) : '',
    surface('To approve', queue('msgs', drafts, draftCard, MANAGE ? [['Approve selected', 'q-msg-ok', 'primary'], ['Delete selected', 'q-msg-del', 'ghost', { confirm: true }]] : [],
      'No drafts. Approving a creator drafts their message here.'), `${num(drafts.length)} draft(s)`),
    readyDm.length ? surface('Send by DM', itemList(readyDm, dmCard), `${num(readyDm.length)} with no email`) : '',
    surface('Send by email', `${itemList(ready, approvedCard, 'Nothing approved yet.')}
      ${aiSendBlock(d.aiApps)}
      <div class="af-row" style="margin-top:12px;">${canSend ? '<a class="bcn-btn" href="../settings-connect-ai.html">Manage AI connections</a>' : '<a class="bcn-btn bcn-btn--primary" href="../settings-connect-ai.html">Connect your AI</a>'}${MANAGE && ready.length ? btn(`Or export ${ready.length} to send yourself`, 'outreach-export', {}, 'surface', { confirm: true }) : ''}</div>`, `${num(ready.length)} approved`),
    out.length ? surface('Mark sent', itemList(out, exportedCard), `${num(out.length)} exported`) : '',
    hasOutreachMessage() ? card('Message template', `${field('Subject', input('tplSubject', `${MANAGE ? '' : 'disabled'} maxlength="200" value="${esc(tpl.subject)}"`))}
      ${field('Message', `<textarea class="bcn-field" id="tplBody" rows="8" ${MANAGE ? '' : 'disabled'}>${esc(tpl.body)}</textarea>`)}
      <div class="af-set-tags">${TAGS.map((t) => `<span class="af-mono">${t}</span>`).join('')}</div>
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${btn('Save template', 'tpl-save', {}, 'primary')}${drafts.length ? btn(`Redraft ${num(drafts.length)} waiting`, 'tpl-redraft', {}, 'surface', { confirm: true }) : ''}</div>` : ''}`, 'New drafts start from this') : '',
    card('Emails to affiliates', itemList((d.notifications || []).slice(0, 15), noteRow, 'Nothing sent yet.'), 'Sent by SILO'),
    more('Message history', [
    card('Sent and outcomes', itemList(byState(['sent', 'replied', 'declined', 'bounced', 'signed_up']), (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)} ${statusPill(x.state)}</div><div class="af-muted">Marked ${fmtTime(x.sent_marked_at)}${x.sent_via_app ? ` · via ${esc(x.sent_via_app)}` : ''}</div>${x.sent_evidence ? `<div class="af-kv-line">${esc(x.sent_evidence)}</div>` : ''}</div>${MANAGE && x.state === 'sent' ? `<div class="af-item-foot"><div class="af-actions">${btn('Asked to stop', 'draft-optout', { id: x.id }, 'danger', { confirm: true })}</div></div>` : ''}</article>`, 'Nothing sent yet.')),
    card('Export batches', itemList(d.batches, (b) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${fmtTime(b.exported_at)} · ${num(b.row_count)} row(s)</div>${b.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''}<div class="af-mono af-copy" style="font-size:11px;margin-top:4px;">${esc(b.fingerprint || '—')}</div></div></article>`, 'No exports yet.')),
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
const SEND_PROMPT = 'Using SILO, send my approved affiliate outreach by email from my own mailbox, then mark each one sent with where I sent it from. Creators with no email stay in SILO for me to message on social.';
// A creator with no public email is reached by a DM the person sends by hand
// (Blake, 2026-11-17: "use social or email to connect"). SILO sends nothing.
const isDm = (x) => x.channel !== 'email' || !x.recipient_email;
function dmText(x) {
  const p = prog();
  const join = p?.intake_mode === 'open' && p.slug ? applyUrl(location.origin, CO, p.slug) : "reply with your email and I'll send your invite link";
  return String(x.body || '').split('{signup_link}').join(join);
}
const CODES_PROMPT = 'Using SILO, create every affiliate code and product code waiting for Shopify in my Shopify store, exactly as SILO describes each one, then mark each one created in SILO.';
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

// ── Product seeding ──────────────────────────────────────────────────────
// An affiliate asks for a product at the seeding price; approving makes a
// one-use code for that product, which SILO makes in Shopify and emails to
// that person only. Selling the multiple pays the purchase back through the ledger.
async function seedDecide(ids, approve) {
  const { data, error } = await db.rpc('affiliate_seed_decide', { p_claims: ids, p_approve: approve });
  if (error) throw new Error(error.message.replace(/^affiliate_seed_\w+:\s*/, ''));
  const n = Number(data?.decided || 0); const skipped = Number(data?.skipped || 0);
  const tail = skipped ? `, ${num(skipped)} skipped (no email on file, or already answered)` : '';
  if (!approve) return `${num(n)} declined${tail}.`;
  // SILO makes each approved product code in Shopify and emails it to that
  // affiliate. One it cannot make waits on the To do list.
  let made = '';
  try { made = ' ' + shopifyCodesMessage((await invoke('affiliate-invite', { action: 'create_shopify_codes', seed_ids: ids }))?.results || []); }
  catch (e) { made = ` Codes not made yet: ${e.message}`; }
  return `${num(n)} approved${tail}.${made}`;
}
function seedsCard() {
  const d = S.d; const p = prog();
  if (!d.seeds || (!d.seeds.length && !p.seeding_enabled)) return '';
  const order = { requested: 0, approved: 1, code_ready: 2, purchased: 3, earned: 4 };
  const rows = [...d.seeds].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  const row = (c) => {
    const v = seedView(c); const a = d.affById[c.affiliate_id];
    const m = (x) => formatMoney(x, c.currency || p.currency);
    const bar = v.pct === null ? '' : `<div class="af-seed-prog"><span class="af-seed-bar"><i style="width:${Math.max(2, v.pct)}%"></i></span><span class="af-mono">${m(c.progress_cents ?? 0)} / ${m(c.goal_cents)}</span></div>`;
    const acts = !MANAGE ? '' : c.state === 'requested'
      ? btn('Approve', 'seed-decide', { id: c.id, ok: '1' }, 'primary') + btn('Decline', 'seed-decide', { id: c.id, ok: '0' }, 'surface')
      : ['approved', 'code_ready', 'purchased'].includes(c.state) ? btn('Cancel', 'seed-cancel', { id: c.id }, 'surface', { confirm: true }) : '';
    const sub = [c.code ? `<span class="af-mono">${esc(c.code)}</span>` : '', c.note ? esc(c.note) : '', c.seed_order_number ? `Order ${esc(c.seed_order_number)}` : ''].filter(Boolean).join(' · ');
    return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body">
      <div class="af-item-head">${esc(c.product_title)} · ${esc(a?.display_name || '—')} ${pill(v.label, v.tone)}</div>
      ${sub ? `<div class="af-kv-line">${sub}</div>` : ''}${bar}</div>${acts ? `<div class="af-item-foot">${acts}</div>` : ''}</article>`;
  };
  const asks = rows.filter((x) => x.state === 'requested');
  const rest = rows.filter((x) => x.state !== 'requested');
  const meta = p.seeding_enabled ? `${esc(Number(p.seed_discount_percent))}% off · sell ${esc(Number(p.seed_multiple))}×` : 'Off';
  const acts = MANAGE ? [['Approve selected', 'q-seed-ok', 'primary'], ['Decline selected', 'q-seed-no']] : [];
  return surface('Products', `${asks.length ? queue('seeds', asks, row, acts, '') : ''}${rest.length ? itemList(rest, row) : asks.length ? '' : empty('No product requests yet. Affiliates ask from their portal.')}`, meta);
}

// ── Content ──────────────────────────────────────────────────────────────
// What affiliates made for the brand (20261117050000). Use = the brand picked
// it, and pays the program's content bonus once through the normal payout
// approval. Nothing is decided without a press.
async function contentDecide(ids, decision) {
  if (!ids.length) return 'Tick at least one.';
  const { data, error } = await db.rpc('affiliate_content_decide', { p_ids: ids, p_decision: decision });
  if (error) throw new Error(error.message.replace(/^affiliate_content_\w+:\s*/, ''));
  qsel('content').clear();
  const n = Number(data?.decided || 0); const skipped = Number(data?.skipped || 0); const paid = Number(data?.bonus_cents || 0);
  const word = { approve: 'approved', use: 'used', decline: 'declined' }[decision];
  return `${num(n)} ${word}.${paid ? ` ${money(paid)} in bonuses added; it pays with the next payout.` : ''}${skipped ? ` ${num(skipped)} skipped (already decided).` : ''}`;
}
const CONTENT_PILL = { submitted: ['To review', 'warn'], approved: ['Approved', 'pos'], used: ['Used', 'pos'], declined: ['Declined', ''] };
function contentCard() {
  const d = S.d; const p = prog();
  if (!d.content) return '';
  const bonus = Number(p.content_bonus_cents || 0);
  const media = (x) => {
    if (x.kind === 'link') return `<div class="af-kv-line">${ext(x.link_url, x.link_url)}</div>`;
    const u = d.contentUrl?.[x.storage_path];
    if (!u) return `<div class="af-muted">${esc(/^video\//.test(x.file_type || '') ? 'Video' : 'Photo')}</div>`;
    return /^video\//.test(x.file_type || '')
      ? `<video class="af-content-media" src="${esc(u)}" controls preload="metadata"></video>`
      : `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img class="af-content-media" src="${esc(u)}" alt="" loading="lazy" /></a>`;
  };
  const row = (x) => {
    const [label, tone] = CONTENT_PILL[x.state] || [x.state, ''];
    const a = d.affById[x.affiliate_id];
    const paid = x.state === 'used' && x.bonus_cents ? ` · +${esc(formatMoney(x.bonus_cents, x.currency))}` : '';
    return `<article class="af-item af-item--compact"><div class="af-item-body">
      <div class="af-item-head">${esc(a?.display_name || '—')} ${pill(label, tone)}</div>
      ${media(x)}${x.caption ? `<div class="af-kv-line">${esc(x.caption)}</div>` : ''}
      <div class="af-muted">${fmtDate(x.submitted_at)}${paid}</div></div></article>`;
  };
  const waiting = d.content.filter((x) => x.state === 'submitted');
  const approved = d.content.filter((x) => x.state === 'approved');
  const done = d.content.filter((x) => ['used', 'declined'].includes(x.state)).slice(0, 30);
  const useLabel = bonus ? `Use selected (+${money(bonus)} each)` : 'Use selected';
  // Using a piece with a bonus is a money decision: only payout approvers.
  const canUse = MANAGE && (!bonus || MONEY);
  const actsNew = MANAGE ? [...(canUse ? [[useLabel, 'q-content-use', 'primary', { confirm: bonus > 0 }]] : []), ['Approve selected', 'q-content-ok'], ['Decline selected', 'q-content-no']] : [];
  const actsOk = MANAGE ? [...(canUse ? [[useLabel, 'q-content-use', 'primary', { confirm: bonus > 0 }]] : []), ['Decline selected', 'q-content-no']] : [];
  const meta = bonus ? `Used content earns ${money(bonus)}` : 'No content bonus set';
  return surface('Content', [
    waiting.length ? `<h3 class="af-settings-title">To review</h3>${queue('content', waiting, row, actsNew, '')}` : '',
    approved.length ? `<h3 class="af-settings-title">Approved</h3>${queue('contentOk', approved, row, actsOk, '')}` : '',
    done.length ? `<h3 class="af-settings-title">Decided</h3>${itemList(done, row)}` : '',
    d.content.length ? '' : empty('No content yet. Affiliates share it from their portal.'),
  ].join(''), meta);
}

// ── Affiliates ───────────────────────────────────────────────────────────
function renderAffiliates() {
  const d = S.d; const p = prog();
  const codesOf = (a) => d.codes.filter((c) => c.affiliate_id === a.id);
  const linksOf = (a) => d.links.filter((l) => l.affiliate_id === a.id);
  const actions = (a) => {
    if (!MANAGE) return '';
    const b = [];
    if (['active', 'paused'].includes(a.status)) b.push(btn('Portal link', 'portal-link', { id: a.id }));
    if (a.status !== 'terminated') b.push(btn('Add code', 'aff-tool', { id: a.id, k: 'code' }), btn('Add link', 'aff-tool', { id: a.id, k: 'link' }));
    // One affiliate per company, in any program (Blake 2026-11-17).
    if (['active', 'paused'].includes(a.status) && otherPrograms().length) b.push(btn('Add to program', 'aff-tool', { id: a.id, k: 'program' }));
    if (a.status === 'active') b.push(btn('Pause', 'affiliate-status', { id: a.id, s: 'paused' }));
    if (a.status === 'paused') b.push(btn('Resume', 'affiliate-status', { id: a.id, s: 'active' }));
    if (a.status !== 'terminated') b.push(btn('End', 'affiliate-status', { id: a.id, s: 'terminated' }, 'danger', { confirm: true }));
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const canCode = (d.aiApps || []).some((a) => a.canCode);
  // A code or a link is given from the affiliate's own card (Blake,
  // 2026-11-17: fewer forms): one small form, for that person, at the top.
  const toolAff = S.affTool ? d.affById[S.affTool.id] : null;
  const tool = !MANAGE || !toolAff ? '' : S.affTool.k === 'program'
    ? card(`Add ${toolAff.display_name} to another program`, `<input type="hidden" id="apAff" value="${esc(toolAff.id)}" /><div class="af-grid--settings">
      ${field('Program', `<select class="bcn-field" id="apProg">${otherPrograms().map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}
      ${field('Their rate', seg('apKind', [['', "Program's rate"], ['percent_of_net', '% of order'], ['fixed_per_order', 'Fixed per order']], '', ''))}
      ${field('%', input('apPct', 'type="number" min="0" max="100" step="0.5" placeholder="10"'))}
      ${field('Per order', input('apFixed', 'type="number" min="0" step="0.01" placeholder="5.00"'))}
      <div class="af-span-full af-row">${btn('Add to program', 'aff-add-program', {}, 'primary')}${btn('Close', 'aff-tool-close')}</div></div>`)
    : S.affTool.k === 'link'
    ? card(`Link for ${toolAff.display_name}`, `<input type="hidden" id="lAff" value="${esc(toolAff.id)}" /><div class="af-row">${field('Name', input('lSlug', 'placeholder="pat-spring"'))}${field('Page (https)', input('lDest', 'placeholder="https://yourstore.com/collections/new"'))}${field('utm_campaign', input('lCamp', `value="${esc(p.slug)}"`))}${btn('Add link', 'link-add', {}, 'primary')}${btn('Close', 'aff-tool-close')}</div>`)
    : card(`Code for ${toolAff.display_name}`, `<input type="hidden" id="cAff" value="${esc(toolAff.id)}" /><div class="af-grid--settings">
      ${field('Code', input('cCode', 'class="bcn-field bcn-field--mono"'))}
      ${field('% off', input('cPct', 'type="number" min="1" max="100" step="1" value="10"'))}
      ${field('In Shopify', `<select class="bcn-field" id="cHow"><option value="ai" selected>SILO makes it</option><option value="exists">I made it</option></select>`)}
      ${field('Starts', input('cStart', `type="date" value="${esc(p.default_code_starts_on || today())}"`))}${field('Ends', input('cEnd', `type="date" value="${esc(p.default_code_ends_on || '')}"`))}
      <div class="af-span-full af-row">${btn('Add code', 'code-add', {}, 'primary')}${btn('Close', 'aff-tool-close')}</div></div>
      ${aiCodesBlock(d.aiApps)}`);
  const affiliateRow = (a) => {
    const code = liveCodeOf(a.id);
    const store = storeOf(p);
    const linkRows = [store && code ? affiliateLink(store, code, '/') : null, ...linksOf(a).map((l) => (store && code ? storeLinkFor(store, code, l.destination_url) : null) || linkUrl(l) || l.destination_url)].filter(Boolean);
    const codesHtml = codesOf(a).map((c) => `<span class="af-code-pill" title="${esc(fmtDate(c.starts_on))} → ${c.ends_on ? esc(fmtDate(c.ends_on)) : 'open'}">${esc(c.code)}${c.status === 'pending' ? ' · waiting' : c.verified_at ? '' : ' · new'}</span>`).join('') || '<span class="af-muted">No codes</span>';
    const terms = a.terms_version_accepted ? `Terms v${a.terms_version_accepted}${a.terms_version_accepted < p.terms_version ? ' · update pending' : ''}` : 'Terms not accepted';
    const linksBlock = linkRows.length ? `<div class="af-row">${btn('Copy link', 'copy-text', { t: linkRows[0] }, 'surface')}${linkRows.length > 1 ? `<span class="af-muted">+${num(linkRows.length - 1)} more in their portal</span>` : ''}</div>` : '';
    return `<article class="af-item af-item--tile af-item--catalog" role="listitem">
      <header class="af-catalog-head">
        <div class="af-catalog-thumb">${photoAvatar({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence))}</div>
        <div class="af-catalog-title">
          <div class="af-catalog-name">${esc(a.display_name)}</div>
          <div class="af-catalog-sub">${esc(a.contact_email)}</div>
          <div class="af-catalog-meta">${esc(terms)}</div>
        </div>
        ${statusPill(a.status)}
      </header>
      <div class="af-codes">${codesHtml}</div>
      ${linksBlock ? `<div class="af-catalog-links">${linksBlock}</div>` : ''}
      <footer class="af-item-foot af-catalog-foot">${actions(a)}</footer>
    </article>`;
  };
  $('affiliatesBody').innerHTML = [
    tool,
    surface('Affiliates', `${d.affiliates.length ? `<div class="af-filter-bar">${viewToggle()}</div>` : ''}${S.view === 'list'
      ? table([
        { left: true, h: 'Affiliate', f: (a) => `<div class="af-list-who">${listThumb({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence))}<div>${esc(a.display_name)}<div class="af-muted">${esc(a.contact_email)}</div></div></div>` },
        { left: true, h: 'Status', f: (a) => statusPill(a.status) },
        { left: true, h: 'Codes', f: (a) => codesOf(a).filter((c) => c.status !== 'retired').map((c) => `<span class="af-code-pill">${esc(c.code)}</span>`).join('') || '<span class="af-muted">None</span>' },
        { h: 'Links', num: true, f: (a) => num(linksOf(a).length) },
        { h: '', f: (a) => actions(a) },
      ], d.affiliates, 'No affiliates yet. They appear here when someone you invite opens their signup link.')
      : itemList(d.affiliates, affiliateRow, 'No affiliates yet. They appear here when someone you invite opens their signup link.', 'grid')}<div id="affOut"></div>`, `${d.affiliates.length} in this program`),
    MANAGE && needsStore(p) ? `<div class="bcn-status bcn-status--warn" id="storeNeeded">Add your website on Outreach to turn on affiliate links.</div>` : '',
    seedsCard(),
    contentCard(),
    more('Codes and links', [
      MANAGE ? card('All codes', itemList(d.codes, (c) => {
        const shop = c.status === 'pending' ? `${pill('waiting for Shopify', 'warn')} · ${esc(Number(c.discount_percent))}% off` : c.shopify_created_via_app ? `Shopify via ${esc(c.shopify_created_via_app)}` : 'You made it';
        const seen = c.verified_at ? `First seen ${fmtDate(c.verified_at)}` : 'Not seen on an order yet';
        const act = c.status === 'active' ? btn('Retire', 'code-retire', { id: c.id }, 'surface', { confirm: true }) : c.status === 'pending' ? `${btn('Make in Shopify', 'code-make', { id: c.id }, 'primary')}${btn('Cancel', 'code-retire', { id: c.id }, 'surface', { confirm: true })}` : pill('retired');
        return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head"><span class="af-mono">${esc(c.code)}</span> · ${esc(d.affById[c.affiliate_id]?.display_name)}</div><div class="af-muted">${fmtDate(c.starts_on)} → ${c.ends_on ? fmtDate(c.ends_on) : 'open'}</div><div class="af-kv-line">${shop} · ${seen}</div></div><div class="af-item-foot">${act}</div></article>`;
      }, 'No codes yet.')) : '',
    ]),
  ].join('');
}

// ── Share: what affiliates see in their portal ───────────────────────────
// The brand picks each item (Blake, 2026-11-10). Sharing stores a snapshot of
// only what an affiliate may see; the portal gives each affiliate their own
// link to it, which applies their code at checkout.
const pathOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? (x.pathname || '/') : null; } catch { return null; } };
const httpsOr = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? u : null);
// What an affiliate's card shows: the same address, asked of the CDN at the
// size the card uses, so a thumbnail is not scaled up into a soft picture.
const cardImage = (u) => displayImage(httpsOr(u));
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
  // What each upcoming launch asks affiliates to push: the products attached
  // to it. Shared WITH the launch, never on their own, so the portal can show
  // them under the drop the affiliate claimed.
  let launchProducts = [];
  const launchIds = (l.data || []).map((x) => x.id);
  if (launchIds.length) {
    const r = await db.from('launch_product_readiness').select('launch_id, product_title')
      .eq('company_entity_id', CO).in('launch_id', launchIds).limit(300);
    launchProducts = r.data || [];
  }
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
  S.share = { launches: l.data || [], launchProducts, ads, signed, products: S.share?.products || [], q: S.share?.q || '',
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

// The products attached to a launch, snapshotted under it. Each is its own
// feed row carrying parent_source_id, so unsharing the launch takes them with
// it and nothing live is joined into an affiliate's read. A title the
// affiliate already sees on the launch is not repeated.
async function shareLaunchProducts(launchId) {
  const rows = (S.share?.launchProducts || []).filter((x) => String(x.launch_id) === String(launchId));
  if (!rows.length) return;
  const seen = new Set();
  const payload = [];
  for (const x of rows) {
    const title = String(x.product_title || '').trim().slice(0, 200);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    payload.push({ company_entity_id: CO, program_id: S.programId, kind: 'product',
      source_id: `launch:${launchId}:${title}`.slice(0, 100), parent_source_id: String(launchId), title });
  }
  if (!payload.length) return;
  try { await db.from('affiliate_feed_items').upsert(payload, { onConflict: 'program_id,kind,source_id', ignoreDuplicates: true }); }
  catch (_) { /* the launch is shared; its product list is not worth failing on */ }
}

async function renderShare() {
  const p = prog();
  $('shareBody').innerHTML = card('Share with affiliates', '<p class="af-muted">Loading…</p>');
  if (!S.share || S.share.programId !== p.id) { await loadShareSources(); S.share.programId = p.id; }
  const sh = S.share; const d = S.d;
  const launches = sh.launches.map((x) => shareItem('launch', x.id, x.title || 'Launch', fmtDate(x.launch_date), cardImage(x.launch_image_url),
    { title: x.title || 'Launch', event_on: x.launch_date, image_url: cardImage(x.launch_image_url), product_path: x.landing_page_url ? pathOf(x.landing_page_url) : null }));
  const products = sh.products.map((x) => shareItem('product', x.shopify_handle, x.product_title, x.product_type || '', cardImage(x.image_url),
    { title: x.product_title, image_url: cardImage(x.image_url), product_path: `/products/${x.shopify_handle}` }));
  const ads = sh.ads.map((x) => shareItem('ad', x.ad_id, x.title || x.ad_name || 'Ad',
    [x.effective_status === 'ACTIVE' ? 'Running now' : x.last_day ? `Ran until ${fmtDate(x.last_day)}` : '', x.body ? String(x.body).slice(0, 90) : ''].filter(Boolean).join(' · '),
    sh.signed[x.image_path] || null,
    { title: String(x.title || x.ad_name || 'Ad').slice(0, 200), note: x.body ? String(x.body).slice(0, 1000) : null,
      product_path: safePath(x.link_path) || (x.link_url ? pathOf(x.link_url) : null), image_path: x.image_path }));
  // A product shared under a launch belongs to that launch's card, not to a
  // card of its own.
  const childCount = (f) => d.feed.filter((g) => g.parent_source_id && String(g.parent_source_id) === String(f.source_id)).length;
  const sharedRows = d.feed.filter((f) => !f.parent_source_id).map((f) => `<div class="af-seen-item">${f.image_url ? `<img src="${esc(f.image_url)}" alt="" loading="lazy">` : `<div class="af-seen-none">${esc(f.title)}</div>`}<div class="af-seen-body"><strong>${esc(f.title)}</strong><div class="af-muted">${esc(({ launch: 'Launch', product: 'Product', ad: 'Ad' })[f.kind])}${f.event_on ? ` · ${fmtDate(f.event_on)}` : ''}${f.kind === 'launch' && childCount(f) ? ` · ${childCount(f)} product(s) to push` : ''}</div>${MANAGE ? btn('Stop sharing', 'feed-remove', { id: f.id }) : ''}</div></div>`);
  // The store links open is picked from the program's connected Shopify
  // stores (Blake 2026-11-17), not typed. Typed only with no store connected.
  const pickable = (Array.isArray(d.stores) ? d.stores : []).filter((x) => !Array.isArray(p.shop_domains) || !p.shop_domains.length || p.shop_domains.includes(x));
  const curHost = (() => { try { return new URL(storeOf(p) || '').hostname; } catch { return ''; } })();
  const storeCard = !MANAGE ? '' : pickable.length
    ? card('Store', `${setRow('Affiliate links open', `<div class="af-chips-tog">${pickable.map((x) => { const on = curHost === x; return `<button type="button" class="af-chip-tog${on ? ' is-on' : ''}" data-act="store-pick" data-store="${esc(x)}" aria-pressed="${on}">${esc(storeName(x))}</button>`; }).join('')}</div>`)}${
      curHost && !pickable.includes(curHost) ? `<p class="af-muted">Now: ${esc(curHost)}</p>` : ''}${needsStore(p) ? '<p class="bcn-status bcn-status--warn" id="storeNeeded">Pick one to turn on affiliate links.</p>' : ''}`)
    : needsStore(p)
      ? card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', 'placeholder="https://www.yourstore.com"'))}${btn('Save', 'store-save', {}, 'primary')}</div><p class="bcn-status bcn-status--warn" id="storeNeeded">Add it once to turn on affiliate links.</p>`)
      : card('Your website', `<div class="af-row">${field('Affiliate links open', input('storeUrl', `value="${esc(p.store_url || storeOf(p) || '')}"`))}${btn('Save', 'store-save', {}, 'primary')}</div>`);
  $('shareBody').innerHTML = [
    card('What your affiliates see', `${sharedRows.length ? `<div class="af-seen">${sharedRows.join('')}</div>` : empty('Nothing shared yet. Pick launches or ads below.')}`,
      `${d.feed.filter((f) => !f.parent_source_id).length} shared`),
    storeCard,
    card('Pick what to share', `${launches.length ? `<h3 class="af-settings-title" style="margin:12px 0 8px;">Upcoming launches</h3>${shareGrid(launches)}` : ''}${ads.length ? `<h3 class="af-settings-title" style="margin:${launches.length ? 16 : 0}px 0 8px;">Recent ads</h3>${shareGrid(ads)}` : ''}${!launches.length && !ads.length ? empty('No upcoming launches or recent ads yet.') : ''}`),
    section('Add products', [
      card('Products', `<div class="af-row">${field('Find a product', input('prodQ', `placeholder="Name" value="${esc(sh.q)}"`))}${btn('Search', 'prod-search', {}, 'surface')}</div>${products.length ? shareGrid(products) : (sh.q ? empty('No products match.') : '<p class="af-muted">Search to pick products.</p>')}`),
      sh.failed.length ? `<p class="af-muted">Could not load: ${esc(sh.failed.join(', '))}.</p>` : '',
    ]),
  ].join('');
}

// ── Commissions ──────────────────────────────────────────────────────────
function commissionsBodyHtml() {
  const d = S.d; const p = prog();
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
  return [
    // The same photo leaderboard as Home when the history loaded.
    Array.isArray(d.ovAttributions) && Array.isArray(d.ovLedger) ? ovLeaderboard(ovList()) : card('By affiliate', itemList(perf, perfRow, 'No credited orders yet.'), 'Commissions update every night'),
    more('Every order', [card('Orders', itemList(d.attributions, attrRow, 'No orders matched yet.'), 'latest 300')]),
    more('Periods and ledger', [
      card('Review periods', `${itemList(d.periods, periodRow, 'No periods yet.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Start', input('perStart', 'type="date"'))}${field('End', input('perEnd', 'type="date"'))}${btn('Open period', 'period-add', {}, 'primary')}</div>` : ''}`),
      card('Commission ledger', `${itemList(d.ledger, ledgerRow, 'No commission lines yet.')}
      ${MONEY ? `<div class="af-row" style="margin-top:8px;">${field('Adjust affiliate', `<select class="bcn-field" id="adjAff">${d.affiliates.map((a) => `<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select>`)}${field(`Amount in ${esc(p.currency)}`, input('adjAmt', 'inputmode="decimal"'))}${field('Why', input('adjMemo'))}${btn('Add adjustment', 'adjust', {}, 'primary', { confirm: true })}</div>` : '<p class="af-muted">Manual adjustments need journal-entry approval.</p>'}`),
    ]),
  ].join('');
}

// ── Payouts ──────────────────────────────────────────────────────────────
function renderPayoutsTab({ quiet = false } = {}) {
  $('payoutsBody').innerHTML = `${payoutPayHtml()}<section id="commissionsBody" class="af-stack" aria-label="Commissions">${commissionsBodyHtml()}</section>`;
  // After the rows are on the page, so a settled attempt redraws over them.
  if (!quiet && prog()?.payout_method === 'paypal_payouts') checkOpenAttemptsOnce();
}
// The status view exposes `credentials_set` and `is_active` -- never the
// credential itself and no `connected` flag. Read those two, or the Send
// button never appears on a rail that is in fact connected.
// Actions that can change stored state and then fail. The page re-reads after
// one, so the buttons describe the database and not what was true before.
const RELOAD_AFTER_FAILURE = new Set(['pp-send', 'pp-send-all', 'pp-refresh']);

function payConnLive(conn) {
  return Boolean(conn && conn.is_active !== false && conn.credentials_set);
}

// Whether this payout can be sent right now, by the SAME rule the database
// uses -- `affiliate_payout_send_claim` refuses a payout whose newest attempt
// in this environment is unknown, sent, unclaimed or PAID, and a live attempt
// blocks every environment while a sandbox test blocks only another test.
// One helper, because the row's buttons and "Send all approved" disagreeing
// means offering a person a button the database will refuse (found in the
// first sandbox run: Test send was still offered on an attempt already paid).
const BLOCKS_A_SEND = ['unknown', 'sent', 'unclaimed', 'paid'];
function sendState(x) {
  const sn = S.d.sendByPayout[x.id];
  const connEnv = S.d.payConn?.environment === 'live' ? 'live' : 'sandbox';
  const attemptEnv = sn?.environment === 'live' ? 'live' : 'sandbox';
  const open = Boolean(sn && BLOCKS_A_SEND.includes(sn.state));
  const blocked = open && (attemptEnv === 'live' || attemptEnv === connEnv);
  return {
    attempt: sn || null,
    attemptEnv,
    test: connEnv !== 'live',
    blocked,
    crossAccount: blocked && attemptEnv !== connEnv,
    email: S.d.payEmailByAff[x.affiliate_id] || null,
    sendable: !blocked && payConnLive(S.d.payConn) && Boolean(S.d.payEmailByAff[x.affiliate_id]),
  };
}

// Every payout with an attempt still open on the CONNECTED account, the ones
// that block a send first. Two boundaries matter here, and both were missed:
// - The endpoint's untargeted refresh reads only the oldest 50 open attempts
//   across the company, so each payout is checked by its OWN id (review
//   cycle 1).
// - The page's history list is the newest 200 attempts of ANY state, so an
//   older open attempt behind 200 paid ones is not in it. The worklist is
//   therefore its own query, open states only, paged to the end (cycle 2).
// An open attempt is always its payout's newest in its environment: the claim
// refuses a new attempt while one is open. Attempts on the other account are
// left alone, because reconciling across accounts is refused by design.
const OPEN_RANK = { unknown: 0, sent: 1, unclaimed: 2 };
const OPEN_PAGE = 1000;
async function openAttemptPayoutIds() {
  const connEnv = S.d.payConn?.environment === 'live' ? 'live' : 'sandbox';
  // Paged by a keyset on `id`, never by offset: this set shrinks while it is
  // read (another tab's check, or the reconcile straight after a send, can
  // settle a row), and an offset then skips whatever slid into the gap. `id`
  // is unique and never changes, so "everything below the last id seen" is
  // the same question however the set moved (review of #1274).
  const rows = [];
  for (let after = null; ;) {
    let q = db.from('affiliate_payout_sends')
      .select('id, payout_id, state, environment')
      .eq('company_entity_id', CO)
      .in('state', Object.keys(OPEN_RANK));
    if (after) q = q.lt('id', after);
    const page = must(await q.order('id', { ascending: false }).limit(OPEN_PAGE)) || [];
    rows.push(...page);
    if (page.length < OPEN_PAGE) break;
    after = page[page.length - 1].id;
  }
  const seen = new Set();
  return rows
    .filter((sn) => (sn.environment === 'live' ? 'live' : 'sandbox') === connEnv)
    .sort((x, y) => OPEN_RANK[x.state] - OPEN_RANK[y.state])
    .map((sn) => sn.payout_id)
    .filter((id) => !seen.has(id) && seen.add(id));
}
async function checkOpenAttempts() {
  const results = [];
  for (const id of await openAttemptPayoutIds()) {
    try {
      const r = await invoke('affiliate-payouts', { action: 'refresh', payout_id: id });
      results.push(...(r.results || []));
    } catch (e) {
      results.push({ payout_id: id, error: e.message });
    }
  }
  return results;
}
const SETTLED = ['paid', 'returned', 'refused', 'unclaimed'];

// Open attempts are checked once per page load, rather than behind a button a
// person has to know to press. The flag is what stops a re-render from
// calling PayPal again.
let ppAutoChecked = false;
async function checkOpenAttemptsOnce() {
  if (ppAutoChecked) return;
  if (!payConnLive(S.d.payConn)) return;
  ppAutoChecked = true;
  try {
    const results = await checkOpenAttempts();
    if (results.some((x) => SETTLED.includes(x.state))) await reload();
  } catch { /* the rows still say what the database knows; the card has a manual check */ }
}

// The payouts "Send all approved" would actually send, in the order shown.
function sendablePayouts() {
  return (S.d.payouts || [])
    .filter((x) => x.method === 'paypal_payouts' && ['approved', 'exported'].includes(x.status))
    .filter((x) => sendState(x).sendable);
}

function payoutPayHtml() {
  const d = S.d; const p = prog();
  const bal = d.balances.map((b) => ({ ...b, a: d.affById[b.affiliate_id] }));
  const act = (x) => {
    const b = [];
    if (MONEY && x.status === 'draft') b.push(btn('Approve', 'payout-approve', { id: x.id }, 'primary', { confirm: true }));
    if (MONEY && x.status === 'exported') b.push(`<input class="bcn-field" id="ref-${x.id}" placeholder="Payment reference" aria-label="Payment reference" /><input class="bcn-field" id="pev-${x.id}" placeholder="Where it shows as paid" aria-label="Where it shows as paid" />`, btn('Record as paid', 'payout-paid', { id: x.id }, 'primary', { confirm: true }));
    // The PayPal rail. A payout with an attempt in flight has no Send button:
    // the database refuses it anyway, and offering it would invite a person to
    // keep clicking at a payment that may already have gone.
    if (x.method === 'paypal_payouts' && ['approved', 'exported'].includes(x.status)) {
      const st = sendState(x);
      // A live attempt while the sandbox app is connected blocks the send and
      // cannot be checked either, so say which account to reconnect.
      if (st.blocked && st.crossAccount) b.push(`<span class="af-muted">Reconnect the ${st.attemptEnv} PayPal account to check that payment</span>`);
      else if (st.blocked) { /* nothing to do here: the attempt is the answer */ }
      else if (!payConnLive(S.d.payConn)) b.push('<span class="af-muted">Connect PayPal first</span>');
      else if (!st.email) b.push('<span class="af-muted">No PayPal address from them yet</span>');
      else if (MONEY) {
        b.push(btn(st.test ? 'Test send (sandbox)' : 'Send with PayPal', 'pp-send', { id: x.id }, 'primary', { confirm: true }));
      }
    }
    if (MANAGE && x.status === 'exported' && x.export_batch_id) b.push(btn('Download again', 'payout-redownload', { batch: x.export_batch_id }));
    // Void is one quiet button; the reason box opens only once it is pressed
    // (Blake 2026-11-18: no always-on input boxes on Money).
    if (MONEY && ['draft', 'approved', 'exported'].includes(x.status)) {
      b.push(S.voidOpen === x.id
        ? `<span class="af-void"><input class="bcn-field" id="vr-${x.id}" placeholder="Why void it?" aria-label="Reason to void" />${btn('Void payout', 'payout-void', { id: x.id }, 'danger', { confirm: true })}${btn('Cancel', 'payout-void-open', { id: '' }, 'ghost')}</span>`
        : btn('Void', 'payout-void-open', { id: x.id }, 'ghost'));
    }
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const approved = d.payouts.filter((x) => x.status === 'approved');
  const paypalRail = p.payout_method === 'paypal_payouts';
  const sendable = paypalRail ? sendablePayouts() : [];
  const sendTest = S.d.payConn?.environment !== 'live';
  const conn = d.payConn;
  const live = payConnLive(conn);

  // What an attempt is doing, in the words a person needs. `unknown` is the
  // one that matters: the money may have gone, so the next step is to check
  // rather than to send again.
  const SEND_WORDS = {
    unknown: 'sent, no answer yet — check before sending again',
    sent: 'sent, waiting on PayPal',
    unclaimed: 'waiting for them to claim it',
    paid: 'paid',
    returned: 'came back',
    refused: 'refused',
  };
  const sendLine = (x) => {
    const sn = d.sendByPayout[x.id];
    if (!sn) return '';
    const why = sn.error_message || sn.error_code;
    const where = sn.environment && sn.environment !== 'live' ? ' (sandbox test)' : '';
    return `<div class="af-muted">PayPal${where}: ${esc(SEND_WORDS[sn.state] || sn.state)}${sn.attempt > 1 ? ` · try ${num(sn.attempt)}` : ''}${why ? ` · ${esc(why)}` : ''}</div>`;
  };

  const payConnCard = () => {
    // The rail used to be reachable only by knowing to set a dropdown on
    // another tab first, so the thing you came to the Pay tab for was
    // invisible until then (Blake, first run: "very hidden and bad UI UX").
    if (!paypalRail) {
      return MANAGE
        ? card('Payout account', `<div class="af-pp-head">${paypalMark('af-pp-logo')}${pill('Not used', '')}</div><p class="af-muted">This program pays by hand.</p>
          <div class="af-row" style="margin-top:8px;">${btn('Pay with PayPal instead', 'pp-use-rail', {}, 'primary', { confirm: true })}</div>`)
        : '';
    }
    if (live) {
      const warn = conn.payouts_enabled === false
        ? `<p class="af-muted">PayPal has not enabled Payouts on this account yet. <a href="https://www.paypal.com/payoutsweb/landing" target="_blank" rel="noopener">Request access</a>.</p>`
        : (conn.last_test_success === false && conn.last_test_error ? `<p class="af-muted">${esc(conn.last_test_error)}</p>` : '');
      const sandbox = conn.environment !== 'live'
        ? '<p class="af-muted">Sandbox: test payments only. Nobody is paid and no payout is recorded as paid.</p>'
        : '';
      const state = conn.payouts_enabled === false ? pill('Payouts not enabled', 'warn') : conn.environment === 'live' ? pill('Live', 'pos') : pill('Sandbox', 'warn');
      return card('Payout account', `<div class="af-pp-head">${paypalMark('af-pp-logo')}${state}${conn.account_email ? `<span class="af-mono af-muted">${esc(conn.account_email)}</span>` : ''}</div>${sandbox}${warn}
        <div class="af-row" style="margin-top:8px;">${btn('Check connection', 'pp-test')}${btn('Check payment status', 'pp-refresh')}${MONEY ? btn('Disconnect', 'pp-disconnect', {}, 'surface', { confirm: true }) : ''}</div>`);
    }
    if (!MONEY) return card('Payout account', `<div class="af-pp-head">${paypalMark('af-pp-logo')}${pill('Not connected', 'warn')}</div><p class="af-muted">Someone who can approve payouts connects it.</p>`);
    // Live only (Blake 2026-11-18): the sandbox choice is gone from setup. A
    // company still on a sandbox app keeps working above until it reconnects.
    const ext = (href, label) => `<a class="af-ppc-link" href="${href}" target="_blank" rel="noopener">${label}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></a>`;
    return `<section class="af-ppc" aria-label="Connect PayPal">
      <div class="af-ppc-intro">${paypalMark('af-ppc-logo')}<h3 class="af-ppc-title">Connect PayPal</h3>
        <p class="af-ppc-sub">Pay affiliates straight from your own PayPal balance.</p>
        <div class="af-ppc-links">${ext('https://www.paypal.com/payoutsweb/landing', 'Get Payouts access')}${ext('https://developer.paypal.com/dashboard/applications', 'Create a Live app')}</div></div>
      <div class="af-ppc-form">
        <label class="af-ppc-field"><span>Client ID</span><input class="bcn-field" id="ppId" autocomplete="off" spellcheck="false" placeholder="From your Live app" /></label>
        <label class="af-ppc-field"><span>Secret</span><input class="bcn-field" id="ppSecret" type="password" autocomplete="off" placeholder="••••••••" /></label>
        ${btn('Connect PayPal', 'pp-connect', {}, 'primary')}</div>
    </section>`;
  };
  const ppChip = (affId) => {
    const em = d.payEmailByAff[affId];
    if (!paypalRail) return '';
    return em ? `<span class="af-pp-chip" title="Paid to this PayPal">${paypalMark('af-pp-chip-logo')}<span class="af-mono">${esc(em)}</span></span>`
      : '<span class="af-pp-chip af-pp-chip--none">No PayPal email yet</span>';
  };
  const face = (a) => (a ? listThumb({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence)) : '');
  // Owed, big; how much of what they earned is already paid, as a meter;
  // and the PayPal account it goes to (Blake 2026-11-17: visuals, logos).
  const balanceRow = (r) => {
    const earned = Number(r.earned_cents) || 0; const paidC = Number(r.paid_cents) || 0;
    const pct = earned > 0 ? Math.min(100, Math.round(paidC / earned * 100)) : 0;
    return `<article class="af-item af-item--pay" role="listitem"><div class="af-item-body"><div class="af-item-head af-list-who">${face(r.a)}<span>${esc(r.a?.display_name || '—')}</span></div>`
      + `<div class="af-pay-owed"><span class="af-pay-owed-num">${formatMoney(r.unclaimed_cents, r.currency)}</span><span class="af-muted">owed</span></div>`
      + `<div class="af-pay-meter" role="img" aria-label="${pct}% of earnings paid"><i style="width:${pct}%"></i></div>`
      + `<div class="af-muted af-pay-meter-cap">${formatMoney(paidC, r.currency)} paid of ${formatMoney(earned, r.currency)} earned</div>${ppChip(r.affiliate_id)}</div>`
      + `<div class="af-item-foot">${MANAGE && r.currency === p.currency && Number(r.unclaimed_cents) > 0 ? btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'primary') : ''}</div></article>`;
  };
  const payoutRow = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head af-list-who">${face(d.affById[x.affiliate_id])}<span>${esc(d.affById[x.affiliate_id]?.display_name || '—')}</span> ${statusPill(x.status)}</div><div class="af-item-stats">${formatMoney(x.amount_cents, x.currency)}${x.method === 'paypal_payouts' ? paypalMark('af-pp-inline') : ''}</div><div class="af-muted">${fmtDate(x.created_at)} · ${plural(x.item_count, 'line')}${x.external_reference ? ` · ref ${esc(x.external_reference)}` : ''}${x.void_reason ? ` · ${esc(x.void_reason)}` : ''}</div>${sendLine(x)}</div><div class="af-item-foot">${act(x)}</div></article>`;
  return [
  moneyTop(),
  payConnCard(),
  surface('Ready to pay', itemList(bal.filter((r) => Number(r.unclaimed_cents) > 0), balanceRow, 'Nothing waiting in a payout yet.', 'grid'), plural(bal.length, 'affiliate')),
  d.payouts.some((x) => x.status === 'draft') ? surface('To approve', queue('payouts', d.payouts.filter((x) => x.status === 'draft'), payoutRow,
    MONEY ? [['Approve selected', 'q-payout-ok', 'primary', { confirm: true }]] : [], ''), `${num(d.payouts.filter((x) => x.status === 'draft').length)} draft(s)`) : '',
  surface('Payouts', `${itemList(d.payouts.filter((x) => x.status !== 'draft'), payoutRow, 'No payouts yet.')}
    ${MANAGE && (approved.length || sendable.length) ? `<div class="af-pay-actions">${
      // Pay day is one button, not one per affiliate. Each payout is still its
      // own attempt, its own idempotency key and its own row -- the loop is in
      // the page, not in the payment -- so nothing about sending twice changes.
      MONEY && sendable.length ? btn(`${sendTest ? 'Test send' : 'Send'} ${plural(sendable.length, 'approved payout')}`, 'pp-send-all', {}, 'primary', { confirm: true }) : ''
    }${approved.length ? btn(`Export ${plural(approved.length, 'approved payout')}`, 'payout-export', {}, sendable.length ? 'surface' : 'primary', { confirm: true }) : ''}</div>` : ''}`),
  more('Balances', [card('All balances', itemList(bal, (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.a?.display_name || '—')} · ${esc(r.currency)}</div><div class="af-kv-line">Earned ${formatMoney(r.earned_cents, r.currency)} · unpaid ${formatMoney(r.unclaimed_cents, r.currency)} · paid ${formatMoney(r.paid_cents, r.currency)}</div></div>${MANAGE && r.currency === p.currency ? `<div class="af-item-foot">${btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'surface')}</div>` : ''}</article>`, 'Nothing earned yet.'))]),
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

// ── Overview ─────────────────────────────────────────────────────────────
// The tab an admin lands on: how the program is doing, who is carrying it,
// and who needs a message. The maths is in studio-core.js (ovWindow,
// ovPerAffiliate, ovReachOut and friends); this half only draws it, and only
// from rows the page has already read under RLS.
const OV_WEEKS = 12;
const ovCur = () => (prog()?.currency || 'USD').toUpperCase();
const ovDay = (back) => dayShift(today(), back);
// The two windows the tab compares: the chosen one, and the one before it.
function ovWindows() {
  const days = S.ovDays;
  return { days, from: ovDay(days - 1), to: today(), prevFrom: ovDay(days * 2 - 1), prevTo: ovDay(days) };
}
// Whole currency units, for the big figures. Exact amounts stay on Pay.
function moneyRound(cents) {
  const cur = ovCur();
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—';
  const v = Number(cents) / minorUnits(cur);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
  } catch { return `${Math.round(v)} ${cur}`; }
}
// The program's rate in a few characters. The full sentence stays in Settings.
function rateShort(p) {
  if (p.commission_kind === 'percent_of_net' && p.commission_percent !== null && p.commission_percent !== undefined) return `${Number(p.commission_percent)}% of net`;
  if (p.commission_kind === 'fixed_per_order' && p.commission_fixed_cents !== null && p.commission_fixed_cents !== undefined) return `${formatMoney(p.commission_fixed_cents, p.currency)} per order`;
  return 'rate set per affiliate';
}
function ovSpark(series, tone) {
  const w = 260; const h = 46; const pad = 4;
  const vals = (series || []).map((v) => Number(v) || 0);
  if (vals.length < 2 || vals.every((v) => v === 0)) return '';
  const lo = Math.min(...vals); const hi = Math.max(...vals); const span = (hi - lo) || 1;
  const x = (i) => (i / (vals.length - 1)) * w;
  const y = (v) => pad + (1 - (v - lo) / span) * (h - pad * 2);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="af-ov-spark af-ov-spark--${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="af-ov-ar" d="${line} L${w},${h} L0,${h} Z"></path>`
    + `<path class="af-ov-ln" d="${line}" vector-effect="non-scaling-stroke"></path>`
    + `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="2.6"></circle></svg>`;
}
function ovDelta(cur, prev) {
  if (!prev && !cur) return '<span class="af-ov-delta af-ov-delta--flat">—</span>';
  if (!prev) return '<span class="af-ov-delta af-ov-delta--up">new</span>';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const kind = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const sign = pct > 0 ? '▲ +' : pct < 0 ? '▼ −' : '';
  return `<span class="af-ov-delta af-ov-delta--${kind}">${sign}${Math.abs(pct)}%</span>`;
}
const ovPlural = (n, word) => `${num(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
const ovMetricCard = (lab, value, foot, spark) => `<article class="af-ov-metric"><div class="af-ov-lab">${esc(lab)}</div>`
  + `<div class="af-ov-val">${esc(value)}</div><div class="af-ov-foot">${foot}</div>${spark || ''}</article>`;
// Every per-affiliate number on the tab, computed once per render.
function ovList() {
  const w = ovWindows();
  return ovPerAffiliate({
    rows: S.d.ovAttributions, ledger: S.d.ovLedger, performance: S.d.performance,
    affiliates: S.d.affiliates, currency: ovCur(), from: w.from, to: w.to, prevFrom: w.prevFrom, prevTo: w.prevTo,
  });
}
function ovReachList() {
  return ovReachOut({
    affiliates: S.d.affiliates, codes: S.d.codes, performance: S.d.performance,
    perWindow: ovList(), today: today(), days: S.ovDays,
  });
}
function ovWhy(x) {
  if (x.kind === 'stuck') return `Invited <b>${num(x.days)}</b> days ago, still has not accepted the terms.`;
  if (x.kind === 'never') return `Code <b>${esc(x.code)}</b> has been live ${num(x.days)} days with no order.`;
  if (x.kind === 'quiet') return `No order in <b>${num(x.days)}</b> days.`;
  if (x.kind === 'drop') return `<b>${esc(moneyRound(x.sales))}</b> in ${num(S.ovDays)} days, down from ${esc(moneyRound(x.prevSales))}.`;
  if (x.firstSale) return 'First sale came in this week.';
  return `Up <b>${Math.round((x.growth || 0) * 100)}%</b> to ${esc(moneyRound(x.sales))}.`;
}
function ovTodoCard() {
  const items = todoItems();
  const rows = items.map((x) => `<div class="af-ov-ro-row"><div class="af-ov-ro-b"><div class="af-ov-why">${esc(x.text)}</div></div>`
    + `<div class="af-todo-acts">${x.extra || ''}${btn('Open', 'go-tab', { t: x.tab })}</div></div>`).join('');
  return card('Needs you', rows ? `<div class="af-ov-ro">${rows}</div>` : '<p class="af-muted">Nothing waiting on you.</p>',
    items.length ? pill(`${items.length} waiting`, 'accent') : pill('clear', 'pos'));
}
// What the program does without a press. Only steps that really run are
// listed: a switch here is never a promise. Turning one off puts that step
// back in Needs you.
const hasAutoShare = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'auto_share_launches'));
function ovAutoCard() {
  const p = prog(); if (!p) return '';
  const row = (label, on, ctl) => `<div class="af-auto-row"><span>${esc(label)}</span>${ctl || pill(on ? 'On' : 'Off', on ? 'pos' : '')}</div>`;
  const shareOn = p.auto_share_launches !== false;
  const shareCtl = hasAutoShare() && MANAGE
    ? `<button type="button" class="af-toggle${shareOn ? ' af-toggle--on' : ''}" role="switch" aria-checked="${shareOn}" aria-label="Share every launch" data-act="auto-share" data-on="${shareOn ? '0' : '1'}"><i></i></button>`
    : '';
  const codesOn = p.default_discount_percent != null && p.default_discount_percent !== '';
  // Friday auto-pay belongs to the payouts work; its columns may not exist
  // yet, and then no switch is shown. Turning it on is a money decision, so
  // only someone who may approve payouts gets a live switch.
  const hasAutoPay = Object.prototype.hasOwnProperty.call(p, 'payout_mode');
  const payOn = p.payout_mode === 'auto_friday';
  const ceiling = Number(p.auto_pay_ceiling_cents);
  const payLabel = `Pay every Friday${Number.isFinite(ceiling) && ceiling > 0 ? ` · up to ${formatMoney(ceiling, p.currency)}` : ''}`;
  const payCtl = MANAGE
    ? `<button type="button" class="af-toggle${payOn ? ' af-toggle--on' : ''}" role="switch" aria-checked="${payOn}" aria-label="Pay every Friday" data-act="auto-pay" data-on="${payOn ? '0' : '1'}"${MONEY ? '' : ' disabled title="Only someone who approves payouts can change this"'}><i></i></button>`
    : '';
  return card('Running on its own', '<div class="af-auto">'
    + (hasAutoShare() ? row('Share every launch', shareOn, shareCtl) : '')
    + (hasAutoCode() ? row(codesOn ? `Code for each new affiliate · ${Number(p.default_discount_percent)}% off` : 'Code for each new affiliate', codesOn) : '')
    + (hasAutoPay ? row(payLabel, payOn, payCtl) : '')
    + row('Commissions update nightly', true)
    + '</div>');
}
function ovLeaderboard(list) {
  const rank = S.ovRank;
  const sorted = [...list].sort((a, b) => (rank === 'orders' ? b.orders - a.orders
    : rank === 'growth' ? b.growth - a.growth : b.sales - a.sales));
  const top = Math.max(1, ...sorted.map((x) => x.sales));
  const rows = sorted.slice(0, 8).map((x, i) => {
    const a = x.aff;
    const photo = affiliatePhotoUrl(a, S.d.prospectById?.[a.from_prospect_id]?.evidence);
    const code = liveCodeOf(a.id);
    const sub = [a.handle ? `@${String(a.handle).replace(/^@/, '')}` : a.platform, code].filter(Boolean).join(' · ');
    const last = x.perf?.last_order_day ? `${num(dayDiff(today(), x.perf.last_order_day))}d` : '—';
    return `<div class="af-ov-lb-row"><div class="af-ov-rk">${i + 1}</div>`
      + `<div class="af-ov-avatar">${photoAvatar(a, photo)}</div>`
      + `<div class="af-ov-who"><div class="af-ov-nm">${esc(a.display_name)}</div>`
      + `<div class="af-ov-hd">${esc(sub || '—')}</div>`
      + `<div class="af-ov-bar"><i style="width:${Math.round((x.sales / top) * 100)}%"></i></div></div>`
      + `<div class="af-ov-money">${esc(moneyRound(x.sales))}<span>${esc(ovPlural(x.orders, 'order'))}</span></div>`
      + `<div class="af-ov-money af-ov-money--comm">${esc(moneyRound(x.comm))}<span>commission</span></div>`
      + `<div class="af-ov-when">${esc(last)}</div></div>`;
  }).join('');
  const seg = [['sales', 'Sales'], ['orders', 'Orders'], ['growth', 'Growth']]
    .map(([k, l]) => btn(l, 'ov-rank', { r: k }, k === rank ? 'dark' : 'surface')).join('');
  return card('Top affiliates', sorted.length
    ? `<div class="af-ov-lb">${rows}</div>`
    : empty(`No affiliate sold anything in the last ${num(S.ovDays)} days.`), seg);
}
function ovReachOutCard(items) {
  const counts = { all: items.length };
  for (const k of Object.keys(OV_REASONS)) counts[k] = items.filter((x) => x.kind === k).length;
  const chips = ['all', ...Object.keys(OV_REASONS)].filter((k) => k === 'all' || counts[k])
    .map((k) => btn(`${k === 'all' ? 'All' : OV_REASONS[k]} ${counts[k]}`, 'ov-filter', { f: k }, k === S.ovFilter ? 'dark' : 'surface')).join('');
  const shown = items.filter((x) => S.ovFilter === 'all' || x.kind === S.ovFilter);
  const rows = shown.slice(0, 12).map((x) => '<div class="af-ov-ro-row">'
    + `<span class="af-ov-dot af-ov-dot--${x.kind}"></span>`
    + `<div class="af-ov-ro-b"><div class="af-ov-ro-top"><span class="af-ov-nm">${esc(x.aff.display_name)}</span>`
    + `${pill(OV_REASONS[x.kind], x.kind === 'rise' ? 'pos' : x.kind === 'drop' ? 'neg' : 'accent')}</div>`
    + `<div class="af-ov-why">${ovWhy(x)}</div></div>`
    + `<div>${btn('Copy', 'ov-copy', { id: x.aff.id, k: x.kind })}</div></div>`).join('');
  return card('Reach out', `<div class="af-ov-chips">${chips}</div>`
    + (shown.length ? `<div class="af-ov-ro">${rows}</div>` : empty('Nobody needs a nudge right now.')),
  items.length ? pill(String(items.length), 'accent') : '');
}
function ovChartCard() {
  const opt = { today: today(), weeks: OV_WEEKS, currency: ovCur() };
  const weekly = ovWeekly(S.d.ovAttributions, { ...opt, pick: (r) => (OV_EARNING_BASES.includes(r.basis) ? Number(r.gross_subtotal_cents || 0) : 0) });
  return weekBarsCard('Sales from affiliate codes', weekly, 'Weekly sales from affiliate codes over the last 12 weeks', 'No order has carried an affiliate code in the last 12 weeks.');
}
// The Money tab's header. Blake 2026-11-17: the tiles and chart "don't help,
// want better visuals, PayPal logos, Shopify logos". So: where the money is,
// as one flow from the store to PayPal, each stage with its own mark.
const PAYPAL_MARK = 'https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-color.svg';
const shopifyMark = (cls = '') => `<svg class="af-flow-shopify ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="../../assets/landing/integration-icons.svg#icon-shopify"></use></svg>`;
const paypalMark = (cls = '') => `<img class="af-flow-paypal ${cls}" src="${PAYPAL_MARK}" alt="PayPal" width="74" height="20" loading="lazy" />`;
function moneyTop() {
  const d = S.d; const p = prog();
  if (!d || !p || !Array.isArray(d.ovLedger)) return '';
  const w = ovWindows();
  const sales = Array.isArray(d.ovAttributions) ? ovWindow(d.ovAttributions, { from: w.from, to: w.to, currency: ovCur() }) : null;
  const comm = ovLedgerTotal(d.ovLedger, { from: w.from, to: w.to, currency: ovCur() });
  const owed = ovUnpaid(d.balances, p.currency);
  const toPay = (d.balances || []).filter((b) => b.currency === p.currency && Number(b.unclaimed_cents) > 0).length;
  const since = Date.now() - w.days * 86400000;
  const paidRows = (d.payouts || []).filter((x) => x.status === 'marked_paid' && x.currency === p.currency && x.marked_paid_at && new Date(x.marked_paid_at).getTime() >= since);
  const paid = paidRows.reduce((t, x) => t + Number(x.amount_cents || 0), 0);
  const inFlight = (d.payouts || []).filter((x) => ['draft', 'approved', 'exported'].includes(x.status) && x.currency === p.currency);
  const flightCents = inFlight.reduce((t, x) => t + Number(x.amount_cents || 0), 0);
  const viaPaypal = p.payout_method === 'paypal_payouts';
  const stage = (mark, label, value, sub, tone = '') => `<div class="af-flow-step${tone ? ` af-flow-step--${tone}` : ''}"><div class="af-flow-mark">${mark}</div><div class="af-flow-lab">${esc(label)}</div><div class="af-flow-val">${value}</div><div class="af-flow-sub">${sub}</div></div>`;
  const arrow = '<div class="af-flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></div>';
  const icon = (path) => `<svg class="af-flow-ico" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  return `<section class="af-flow" aria-label="Where the money is, last ${num(w.days)} days">
    ${stage(shopifyMark(), 'Sales from codes', sales ? esc(moneyRound(sales.sales)) : '—', sales ? `${esc(ovPlural(sales.orders, 'order'))} in Shopify` : 'Shopify')}
    ${arrow}
    ${stage(icon('<path d="M12 3v18M17 7.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5S9.2 11 12 11.5s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5"/>'), 'Commission earned', esc(moneyRound(comm)), esc(rateShort(p)), 'pos')}
    ${arrow}
    ${stage(icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), 'Owed now', esc(money(owed + 0)), `${esc(ovPlural(toPay, 'affiliate'))}${inFlight.length ? ` · ${esc(money(flightCents))} in ${esc(plural(inFlight.length, 'payout'))}` : ''}`, owed > 0 ? 'warn' : '')}
    ${arrow}
    ${stage(viaPaypal ? paypalMark() : icon('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>'), viaPaypal ? 'Paid with PayPal' : 'Paid by hand', esc(money(paid)), `${esc(ovPlural(paidRows.length, 'payout'))}`, 'accent')}
  </section><p class="af-flow-note">Last ${num(w.days)} days · owed is today</p>`;
}
function weekBarsCard(title, weekly, aria, emptyText) {
  const units = minorUnits(ovCur());
  const peak = Math.max(...weekly.map((v) => v / units), 0);
  if (!peak) return emptyText ? card(title, empty(emptyText)) : '';
  const step = Math.pow(10, Math.floor(Math.log10(peak)));
  const max = Math.ceil(peak / step) * step;
  const W = 760; const H = 220; const L = 54; const R = 8; const T = 10; const B = 26;
  const iw = W - L - R; const ih = H - T - B;
  const y = (v) => T + (1 - v / max) * ih;
  const bw = Math.min(30, (iw / OV_WEEKS) * 0.56);
  const cx = (i) => L + (i + 0.5) * (iw / OV_WEEKS);
  const grid = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line class="af-ov-grid" x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}"></line>`
      + `<text class="af-ov-tick" x="${L - 9}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(moneyRound(v * units))}</text>`;
  }).join('');
  const bars = weekly.map((cents, i) => {
    const v = cents / units;
    const top = y(v); const base = y(0);
    return `<rect class="af-ov-bc" x="${(cx(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, base - top).toFixed(1)}" rx="2"></rect>`;
  }).join('');
  const labels = weekly.map((_, i) => (i % 2 === 0
    ? `<text class="af-ov-tick" x="${cx(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(ovDay((OV_WEEKS - 1 - i) * 7).slice(5))}</text>` : '')).join('');
  return card(title, '<div class="af-ov-chart">'
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">`
    + `${grid}${bars}${labels}<line class="af-ov-axis" x1="${L}" y1="${y(0).toFixed(1)}" x2="${W - R}" y2="${y(0).toFixed(1)}"></line></svg></div>`,
  '<span class="af-ov-legend">Weekly, last 12 weeks</span>');
}
function renderOverview() {
  const el = $('overviewBody'); const d = S.d; const p = prog();
  if (!el || !d || !p) return;
  if (d.ovAttributions === null || d.ovLedger === null) {
    el.innerHTML = card('Overview', `<p>The order and commission history did not load, so none of these numbers are shown. Reload, or open Affiliates and Pay for the same data.</p>${btn('Reload', 'ov-reload')}`);
    return;
  }
  const w = ovWindows();
  const cur = ovWindow(d.ovAttributions, { from: w.from, to: w.to, currency: ovCur() });
  const prev = ovWindow(d.ovAttributions, { from: w.prevFrom, to: w.prevTo, currency: ovCur() });
  const comm = ovLedgerTotal(d.ovLedger, { from: w.from, to: w.to, currency: ovCur() });
  const commPrev = ovLedgerTotal(d.ovLedger, { from: w.prevFrom, to: w.prevTo, currency: ovCur() });
  const active = d.affiliates.filter((a) => a.status === 'active').length;
  const opt = { today: today(), weeks: OV_WEEKS, currency: ovCur() };
  const metrics = [
    ovMetricCard('Sales from codes', moneyRound(cur.sales),
      `${ovDelta(cur.sales, prev.sales)}<span>vs previous ${num(w.days)} days</span>`,
      ovSpark(ovWeekly(d.ovAttributions, { ...opt, pick: (r) => (OV_EARNING_BASES.includes(r.basis) ? Number(r.gross_subtotal_cents || 0) : 0) }), 'accent')),
    ovMetricCard('Commission earned', moneyRound(comm),
      `${ovDelta(comm, commPrev)}<span>${esc(rateShort(p))}</span>`,
      ovSpark(ovWeekly(d.ovLedger, { ...opt, pick: (r) => Number(r.amount_cents || 0) }), 'pos')),
    ovMetricCard('Orders', num(cur.orders),
      `${ovDelta(cur.orders, prev.orders)}<span>${esc(moneyRound(cur.orders ? cur.sales / cur.orders : 0))} average order</span>`,
      ovSpark(ovWeekly(d.ovAttributions, { ...opt, pick: (r) => (OV_EARNING_BASES.includes(r.basis) ? 1 : 0) }), 'accent')),
    ovMetricCard('Selling affiliates', num(cur.sellers.length),
      `${ovDelta(cur.sellers.length, prev.sellers.length)}<span>of ${num(active)} active</span>`,
      ovSpark(ovWeeklySellers(d.ovAttributions, opt), 'warn')),
  ].join('');
  const owedCents = ovUnpaid(d.balances, p.currency);
  const liveCodes = d.codes.filter((c) => c.status === 'active').length;
  const otherCur = ovOtherCurrencyOrders(d.ovAttributions, { from: w.from, to: w.to, currency: ovCur() });
  const lastLedger = (d.ledger || [])[0]?.created_at;
  const bandItem = (lab, v) => `<div class="af-ov-bi"><div class="af-ov-bl">${esc(lab)}</div><div class="af-ov-bv">${v}</div></div>`;
  const band = '<div class="af-ov-band">'
    + bandItem('Commission unpaid', esc(money(owedCents)))
    + bandItem('Codes live', `${num(liveCodes)}${d.health?.codes_never_seen ? ` · ${num(d.health.codes_never_seen)} never used` : ''}`)
    + (otherCur ? bandItem('Other currency', esc(ovPlural(otherCur, 'order'))) : '')
    + '<div class="af-ov-bsep"></div>'
    + bandItem('Commissions updated', esc(lastLedger ? fmtTime(lastLedger) : 'not yet'))
    + '</div>';
  const windowSeg = [30, 90].map((n) => btn(`${n} days`, 'ov-window', { n }, n === w.days ? 'dark' : 'surface')).join('');
  el.innerHTML = `<div class="af-row"><span class="af-muted" style="flex:1;">Last ${num(w.days)} days, through today</span>${windowSeg}</div>`
    + `<div class="af-ov-metrics">${metrics}</div>`
    + band
    + `<div class="af-ov-cols"><div>${ovLeaderboard(ovList())}${ovChartCard()}</div>`
    + `<div>${ovTodoCard()}${ovAutoCard()}${ovReachOutCard(ovReachList())}${aiHubOverviewSection()}</div></div>`;
}

// The program row the Setup form describes, validated. Throws the reasons.
function programRowFromForm() {
  const { row, errors } = readProgramForm();
  if (errors.length) throw new Error(errors.join(' '));
  if ($('pSeedOn')) {
    const pct = Number(val('pSeedPct')); const mult = Number(val('pSeedMult'));
    if (!(pct >= 1 && pct <= 100 && Number.isInteger(pct))) throw new Error('Product % off is a whole number from 1 to 100.');
    if (!(mult >= 1 && mult <= 20)) throw new Error('Sell back is from 1 to 20 times.');
    Object.assign(row, { seeding_enabled: val('pSeedOn') === '1', seed_discount_percent: pct, seed_multiple: mult });
  }
  return row;
}

const A = {
  'new-program': () => { S.creating = true; S.tab = 'program'; render(); },
  'cancel-new': () => { S.creating = false; render(); },
  'save-program': async () => {
    const row = programRowFromForm();
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
  'rec-tab': ({ k }) => { S.recTab = k; S.recAll = false; renderRecords(); return null; },
  'rec-all': () => { S.recAll = true; renderRecords(); return null; },
  'view-set': ({ v }) => { S.view = v === 'list' ? 'list' : 'tiles'; try { localStorage.setItem(VIEW_KEY, S.view); } catch { /* per-viewer convenience only */ } render(); return null; },
  'prospect-filter': ({ f }) => { S.prospectFilter = f; S.prospectShowAll = false; S.sel.clear(); render(); scrollWorkflowTo('afCreatorsList'); return null; },
  'prospect-pick': ({ id }) => { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); render(); return null; },
  // Every prospect in the view, not only the cards on screen.
  'prospect-select-all': () => { for (const id of S.viewIds || []) S.sel.add(id); render(); return null; },
  'prospect-select-none': () => { S.sel.clear(); render(); return null; },
  'prospect-bulk': async ({ s }) => bulkProspects([...S.sel], s),
  // Queues: tick one, tick all, then act on the ticked rows.
  'q-pick': ({ q, id }) => { const sel = qsel(q); if (sel.has(id)) sel.delete(id); else sel.add(id); render(); return null; },
  'q-all': ({ q }) => { const sel = qsel(q); const ids = QROWS[q] || []; if (ids.length && ids.every((id) => sel.has(id))) sel.clear(); else ids.forEach((id) => sel.add(id)); render(); return null; },
  'q-msg-ok': async () => {
    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';
    const rows = await updateRows('affiliate_outreach_drafts', { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, { id: ids, state: 'draft' });
    qsel('msgs').clear();
    return `${num(rows.length)} message(s) approved.${rows.length < ids.length ? ` ${num(ids.length - rows.length)} were no longer drafts.` : ''}`;
  },
  'q-msg-del': async () => {
    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';
    const r = must(await db.from('affiliate_outreach_drafts').delete().in('id', ids).eq('state', 'draft').eq('company_entity_id', CO).select('id'));
    qsel('msgs').clear();
    return `${num(r.length)} draft(s) deleted.`;
  },
  'q-seed-ok': async () => { const ids = picked('seeds'); if (!ids.length) return 'Tick at least one.'; const m = await seedDecide(ids, true); qsel('seeds').clear(); return m; },
  'q-seed-no': async () => { const ids = picked('seeds'); if (!ids.length) return 'Tick at least one.'; const m = await seedDecide(ids, false); qsel('seeds').clear(); return m; },
  'q-content-use': async ({ q }) => { const ids = picked(q); const m = await contentDecide(ids, 'use'); qsel(q).clear(); return m; },
  'q-content-ok': async ({ q }) => { const ids = picked(q); const m = await contentDecide(ids, 'approve'); qsel(q).clear(); return m; },
  'q-content-no': async ({ q }) => { const ids = picked(q); const m = await contentDecide(ids, 'decline'); qsel(q).clear(); return m; },
  'q-payout-ok': async () => {
    const ids = picked('payouts'); if (!ids.length) return 'Tick at least one.';
    let ok = 0; let failed = 0;
    for (const id of ids) { const { error } = await db.rpc('affiliate_approve_payout', { p_payout: id }); if (error) failed += 1; else ok += 1; }
    qsel('payouts').clear();
    if (!ok && failed) throw new Error('No payout was approved. Approve them one at a time to see why.');
    return `${num(ok)} payout(s) approved${failed ? `, ${num(failed)} not approved` : ''}.`;
  },
  'tpl-save': async () => {
    const { row, errors } = templateRow(val('tplSubject'), $('tplBody').value);
    if (errors.length) throw new Error(errors.join(' '));
    await updateRows('affiliate_programs', { ...row, changed_by: me.id }, { id: S.programId });
    return 'Template saved. New drafts start from it.';
  },
  // Waiting drafts re-filled from the saved template; approved ones are left alone.
  'tpl-redraft': async () => {
    const tpl = outreachTemplate(prog());
    const drafts = S.d.drafts.filter((x) => x.state === 'draft' && S.d.prospectById[x.prospect_id]);
    let n = 0;
    for (const x of drafts) {
      const vars = outreachVars(S.d.prospectById[x.prospect_id]);
      try {
        const rows = await updateRows('affiliate_outreach_drafts', { subject: fillTemplate(tpl.subject, vars), body: fillTemplate(tpl.body, vars), changed_by: me.id, updated_at: new Date().toISOString() }, { id: x.id, state: 'draft' });
        n += rows.length;
      } catch { /* approved meanwhile: left as approved */ }
    }
    return `${num(n)} draft(s) redrafted from the template.`;
  },
  'ov-window': ({ n }) => { S.ovDays = Number(n) === 90 ? 90 : 30; render(); },
  'ov-rank': ({ r }) => { S.ovRank = ['sales', 'orders', 'growth'].includes(r) ? r : 'sales'; render(); },
  'ov-filter': ({ f }) => { S.ovFilter = f; render(); },
  'copy-text': async ({ t }) => {
    try { await navigator.clipboard.writeText(t); } catch { setStatus(t, 'info'); return null; }
    return 'Copied.';
  },
  'ov-copy': async ({ id, k }) => {
    const item = ovReachList().find((x) => x.aff.id === id && x.kind === k);
    if (!item) throw new Error('That affiliate is no longer on the list. Reload to see the current one.');
    const text = ovMessage(item, { brand: S.brand || prog()?.name || 'us', code: liveCodeOf(id) });
    try { await navigator.clipboard.writeText(text); } catch { setStatus(text, 'info'); return null; }
    return 'Copied. Send it from your own mailbox.';
  },
  'ov-reload': async () => { await reload(); return null; },
  // One press for the whole queue row. Each works over the rows on screen
  // and reports what it did; a partial failure says how many did not go.
  'q-msgs': async () => {
    const ids = S.d.drafts.filter((x) => x.state === 'draft').map((x) => x.id);
    if (!ids.length) return 'Nothing to approve.';
    const rows = await updateRows('affiliate_outreach_drafts', { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, { id: ids, state: 'draft' });
    return `${num(rows.length)} message(s) approved.`;
  },
  'q-codes': async () => {
    const p = prog();
    const pct = Number(p.default_discount_percent) > 0 ? Number(p.default_discount_percent) : 10;
    const coded = new Set(S.d.codes.filter((c) => c.status !== 'retired').map((c) => c.affiliate_id));
    const todo = S.d.affiliates.filter((a) => a.status === 'active' && !coded.has(a.id));
    if (!todo.length) return 'Every active affiliate has a code.';
    const taken = S.d.codes.map((c) => c.code);
    const rows = todo.map((a) => {
      const code = suggestCode(a.handle || a.display_name, pct, taken); taken.push(code);
      return { company_entity_id: CO, program_id: S.programId, affiliate_id: a.id, code, starts_on: today(), created_by: me.id, status: 'pending', discount_percent: pct };
    });
    const made = must(await db.from('affiliate_codes').insert(rows).select('id'));
    return makeInShopify((made || []).map((r) => r.id));
  },
  'q-payouts': async () => {
    const p = prog();
    const owed = (S.d.balances || []).filter((x) => x.currency === p.currency && Number(x.unclaimed_cents) > 0);
    let built = 0; let failed = 0;
    for (const b of owed) {
      const { error } = await db.rpc('affiliate_build_payout', { p_affiliate: b.affiliate_id, p_through: null });
      if (error) failed += 1; else built += 1;
    }
    if (!built && failed) throw new Error('No payout was built. Open Money and build them one at a time to see why.');
    return `${num(built)} draft payout(s) built${failed ? `, ${num(failed)} not built` : ''}. They need approval.`;
  },
  'q-seeds': async () => {
    const ids = (S.d.seeds || []).filter((x) => x.state === 'requested').map((x) => x.id);
    if (!ids.length) return 'Nothing to approve.';
    return seedDecide(ids, true);
  },
  'seed-decide': async ({ id, ok }) => seedDecide([id], ok === '1'),
  'seed-make': async () => {
    const ids = (S.d.seeds || []).filter((x) => x.state === 'approved').map((x) => x.id).slice(0, 25);
    if (!ids.length) return 'Nothing is waiting.';
    return shopifyCodesMessage((await invoke('affiliate-invite', { action: 'create_shopify_codes', seed_ids: ids }))?.results || []);
  },
  'seed-cancel': async ({ id }) => {
    const { error } = await db.rpc('affiliate_seed_cancel', { p_claim: id });
    if (error) throw new Error(error.message.replace(/^affiliate_seed_\w+:\s*/, ''));
    return 'Cancelled.';
  },
  'auto-share': async ({ on }) => {
    await updateRows('affiliate_programs', { auto_share_launches: on === '1', changed_by: me.id }, { id: S.programId });
    return on === '1' ? 'Launches will share themselves.' : 'Launches are shared by hand again.';
  },
  'auto-pay': async ({ on }) => {
    await updateRows('affiliate_programs', { payout_mode: on === '1' ? 'auto_friday' : 'approve_each', changed_by: me.id }, { id: S.programId });
    return on === '1' ? 'Payouts go out every Friday.' : 'Each payout waits for approval again.';
  },
  'go-tab': ({ t }) => { S.tab = PANEL_OF[t] || t; S.creating = false; render(); workflowFocusTab(t); },
  'prospect-show-all': () => { S.prospectShowAll = true; render(); scrollWorkflowTo('afCreatorsList'); return null; },
  'prospect-show-fewer': () => { S.prospectShowAll = false; render(); scrollWorkflowTo('afCreatorsList'); return null; },
  'prospect-status': async ({ id, s }) => {
    await updateRows('affiliate_prospects', { status: s, reviewed_by: me.id, reviewed_at: new Date().toISOString(), changed_by: me.id }, { id });
    if (s !== 'approved') return `Creator ${s}.`;
    // Someone added by hand or who applied is emailed their invite on approval.
    const x = S.d.prospectById[id];
    if (x && INVITE_SOURCES.has(x.source) && x.contact_email) return `Creator approved. ${await sendInvite(id)}`;
    // Approving drafts the message, unless one is already in progress.
    const live = S.d.drafts.some((x) => x.prospect_id === id && ['draft', 'approved', 'exported'].includes(x.state));
    if (!live) { await A['draft-create']({ id }); S.tab = 'people'; }
    return live ? 'Creator approved.' : 'Creator approved. Their message is drafted below.';
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
  'aff-tool': ({ id, k }) => { S.affTool = { id, k }; render(); scrollWorkflowTo('affiliatesBody'); return null; },
  'aff-tool-close': () => { S.affTool = null; render(); return null; },
  // Joined once, added anywhere: no second signup, their own rate if set.
  'aff-add-program': async () => {
    const kind = val('apKind') || null;
    const pct = kind === 'percent_of_net' ? Number(val('apPct')) : null;
    const fixed = kind === 'fixed_per_order' ? Math.round(Number(val('apFixed')) * 100) : null;
    if (kind === 'percent_of_net' && !(pct >= 0 && pct <= 100 && val('apPct') !== '')) throw new Error('Enter their % of each order.');
    if (kind === 'fixed_per_order' && !(fixed >= 0 && val('apFixed') !== '')) throw new Error('Enter their amount per order.');
    const target = S.programs.find((x) => x.id === val('apProg'));
    const r = must(await db.rpc('affiliate_add_to_program', { p_affiliate: val('apAff'), p_program: val('apProg'),
      p_commission_kind: kind, p_commission_percent: pct, p_commission_fixed_cents: fixed }));
    S.affTool = null;
    if (!r?.added) return `Already in ${target?.name || 'that program'}.`;
    const { data: waiting } = await db.from('affiliate_codes').select('id').eq('company_entity_id', CO).eq('affiliate_id', r.affiliate_id).eq('status', 'pending');
    const made = waiting?.length ? ` ${await makeInShopify(waiting.map((x) => x.id))}` : '';
    return `Added to ${target?.name || 'the program'}.${made}`;
  },
  'add-creators': () => { S.addCreators = !S.addCreators; render(); scrollWorkflowTo('prospectsBody'); return null; },
  'add-creators-close': () => { S.addCreators = false; render(); return null; },
  'prospect-edit': ({ id }) => { S.editProspect = id; render(); scrollWorkflowTo('prospectsBody'); return null; },
  'prospect-edit-close': () => { S.editProspect = null; render(); return null; },
  'prospect-save': async ({ id }) => {
    const x = S.d.prospectById[id]; if (!x) return null;
    const row = prospectEditRow({ name: val('epName'), platform: val('epPlat'), handle: val('epHandle'), url: val('epUrl'), email: val('epEmail') }, x);
    await updateRows('affiliate_prospects', { ...row, changed_by: me.id }, { id });
    // A creator who now has an email is reached by email: their waiting
    // message moves from DM to email. Sent ones keep their history.
    let moved = 0;
    if (row.contact_email && row.contact_email !== (x.contact_email || '').toLowerCase()) {
      const r = must(await db.from('affiliate_outreach_drafts').update({ channel: 'email', recipient_email: row.contact_email })
        .eq('company_entity_id', CO).eq('prospect_id', id).in('state', ['draft', 'approved']).select('id'));
      moved = r?.length || 0;
    }
    S.editProspect = null;
    return `Saved.${moved ? ` ${num(moved)} waiting message(s) will now go by email.` : ''}`;
  },
  'prospect-add': async () => {
    const url = val('mpUrl'); const handle = val('mpHandle');
    if (!url && !handle) throw new Error('A handle or a profile URL is needed to tell creators apart.');
    if (val('mpEmail') && !val('mpEmail').includes('@')) throw new Error('That email address is not valid.');
    // Added with an email: approved and invited at once (the invite is emailed).
    const email = val('mpEmail') || null;
    const now = new Date().toISOString();
    const row = must(await db.from('affiliate_prospects').insert({
      company_entity_id: CO, program_id: S.programId, display_name: val('mpName') || handle || url, platform: val('mpPlat'),
      handle: handle || null, profile_url: url || null, contact_email: email,
      source: 'manual', source_url: val('mpSource') || null, evidence: { note: val('mpNote') || null, entered_by: me.email || me.id }, created_by: me.id,
      ...(email ? { status: 'approved', reviewed_by: me.id, reviewed_at: now } : {}),
    }).select('id').single());
    if (!email) return 'Prospect added.';
    return `Added. ${await sendInvite(row.id, email, 'mpOut')}`;
  },
  'research-run': async () => {
    const out = await invoke('affiliate-research', { action: 'research', program_id: S.programId, focus: $('rsFocus')?.value || '', count: Number(val('rsCount')) || 25 });
    watchResearch(out.run_id);
    return 'Research started. It takes a few minutes; new creators appear in Prospects when it finishes.';
  },
  // The columns the import reads (affiliate-research importRowsToCandidates).
  'import-template': async () => {
    download('affiliate-import-template.csv', toCsv(...IMPORT_TEMPLATE));
    return 'Template downloaded. One creator per row; profile_url is required.';
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
  'suppression-add': async () => {
    if (!val('supVal')) throw new Error('Type the address, domain, handle or URL.');
    must(await db.from('affiliate_suppressions').insert({ company_entity_id: CO, kind: val('supKind'), value_normalized: val('supVal'), reason: val('supReason'), source: 'affiliate_studio', created_by: me.id }));
    return 'Added to the do-not-contact list.';
  },
  'suppression-remove': async ({ id }) => { const r = must(await db.from('affiliate_suppressions').delete().eq('id', id).eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Only an Affiliate Studio manager can remove an entry.'); return 'Removed.'; },
  'invite-send': async ({ id }) => sendInvite(id),
  'signup-link': async ({ id }) => {
    const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: id });
    S.flash = { el: 'signupOut', html: card('Signup link (send it yourself)', `<p>Personal to this person, valid until ${fmtTime(out.expires_at)}. SILO has not sent it. Making a new one cancels this one.</p><div class="bcn-field af-mono af-copy">${esc(out.signup_url)}</div>`) };
    return 'Signup link created.';
  },
  // Reached outside SILO (a DM, a call, their own email): recorded as a sent
  // message so the creator's history and counts include it.
  'prospect-contacted': async ({ id }) => {
    const x = S.d.prospectById[id]; if (!x) return null;
    const at = new Date().toISOString();
    must(await db.from('affiliate_outreach_drafts').insert({
      company_entity_id: CO, program_id: S.programId, prospect_id: id, channel: x.contact_email ? 'email' : 'dm',
      recipient_email: x.contact_email || null, recipient_handle: x.contact_email ? null : (x.handle || x.profile_url),
      subject: null, body: 'Contacted outside SILO.', created_by: me.id, state: 'sent',
      approved_by: me.id, approved_at: at, sent_marked_by: me.id, sent_marked_at: at, sent_evidence: 'Contacted by hand',
    }));
    return 'Marked contacted.';
  },
  'draft-create': async ({ id }) => {
    const x = S.d.prospectById[id]; const vars = outreachVars(x); const tpl = outreachTemplate(prog());
    must(await db.from('affiliate_outreach_drafts').insert({
      company_entity_id: CO, program_id: S.programId, prospect_id: id, channel: x.contact_email ? 'email' : 'dm',
      recipient_email: x.contact_email || null, recipient_handle: x.contact_email ? null : (x.handle || x.profile_url),
      subject: fillTemplate(tpl.subject, vars), body: fillTemplate(tpl.body, vars), created_by: me.id,
    }));
    return 'Draft created. Approve it on Outreach.';
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
  'dm-copy': async ({ id }) => {
    const x = S.d.drafts.find((r) => r.id === id); if (!x) return null;
    const t = dmText(x);
    try { await navigator.clipboard.writeText(t); } catch { setStatus(t, 'info'); return null; }
    setStatus('Message copied. Send it from your own account, then press Mark sent.', 'pos', 5000);
    return null;
  },
  'dm-sent': async ({ id }) => {
    const x = S.d.drafts.find((r) => r.id === id);
    const plat = PLATFORM_NAMES[S.d.prospectById[x?.prospect_id]?.platform] || 'social';
    const how = x && !isDm(x) ? 'Sent by email by hand' : `Sent by DM on ${plat}`;
    await updateRows('affiliate_outreach_drafts', { state: 'sent', sent_marked_by: me.id, sent_marked_at: new Date().toISOString(), sent_evidence: how }, { id, state: 'approved' });
    return 'Marked sent.';
  },
  'draft-optout': async ({ id }) => {
    const x = S.d.drafts.find((r) => r.id === id);
    await A['prospect-suppress']({ id: x.prospect_id });
    await updateRows('affiliate_outreach_drafts', { state: 'declined', outcome_note: 'asked not to be contacted' }, { id });
    return 'Recorded, and added to the do-not-contact list.';
  },
  'outreach-export': async () => {
    const drafts = S.d.drafts.filter((x) => x.state === 'approved' && !isDm(x)).slice(0, 200);
    if (!drafts.length) return 'Nothing to export: messages with no email are sent by DM.';
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
  'affiliate-status': async ({ id, s }) => {
    await updateRows('affiliates', { status: s, changed_by: me.id }, { id });
    if (s !== 'active') return `Affiliate ${s}.`;
    // Turning an affiliate on queues their first code in the database
    // (affiliate_queue_first_code); make it in Shopify now, not overnight.
    const { data: waiting } = await db.from('affiliate_codes').select('id').eq('company_entity_id', CO).eq('affiliate_id', id).eq('status', 'pending');
    return waiting?.length ? `Affiliate active. ${await makeInShopify(waiting.map((r) => r.id))}` : 'Affiliate active.';
  },
  'code-add': async () => {
    if (!val('cAff') || !val('cCode')) throw new Error('Pick an affiliate and type the code.');
    const ai = val('cHow') === 'ai';
    const pct = Number(val('cPct'));
    if (ai && !(pct > 0 && pct <= 100)) throw new Error('Type the percent off your AI should give, from 1 to 100.');
    const aff = val('cAff'); const starts = val('cStart') || today();
    const added = must(await db.from('affiliate_codes').insert({ company_entity_id: CO, program_id: S.programId, affiliate_id: aff, code: val('cCode'), starts_on: starts, ends_on: val('cEnd') || null, created_by: me.id,
      ...(ai ? { status: 'pending', discount_percent: pct } : {}) }).select('id'));
    if (ai) { S.affTool = null; return makeInShopify((added || []).map((r) => r.id)); }
    // A code made by hand is live now (or on its start day): tell the rep.
    const live = starts <= today() && S.d.affiliates.find((a) => a.id === aff)?.status === 'active';
    S.affTool = null;
    return `Code added. Orders using it are credited overnight.${live ? await tellCodes(aff) : ''}`;
  },
  'feed-add': async ({ kind, src, p }) => {
    const x = JSON.parse(p || '{}');
    // An ad's picture is private to the company; sharing copies exactly that
    // file to the public feed bucket, at the same path, so affiliates see it.
    if (x.image_path) x.image_url = await publishAdImage(x.image_path);
    must(await db.from('affiliate_feed_items').insert({ company_entity_id: CO, program_id: S.programId, kind, source_id: String(src),
      title: String(x.title || '').slice(0, 200), note: x.note || null, image_url: x.image_url || null, product_path: x.product_path || null, event_on: x.event_on || null }));
    // A launch carries what it asks affiliates to push. Best effort: the
    // launch is shared either way, and a product list can be attached later
    // by sharing it again.
    if (kind === 'launch') await shareLaunchProducts(String(src));
    return 'Shared. It shows in your affiliates\' portal now.';
  },
  'feed-remove': async ({ id }) => {
    const { data, error } = await db.from('affiliate_feed_items').delete().eq('id', id).select();
    if (error) throw error;
    if (!data?.length) throw new Error('Not removed: your account may no longer manage this program.');
    // The products shared under a launch go with it; left behind they would
    // be invisible rows nobody can reach.
    const gone = data[0];
    if (gone?.kind === 'launch' && gone.source_id) {
      await db.from('affiliate_feed_items').delete()
        .eq('company_entity_id', CO).eq('program_id', gone.program_id).eq('parent_source_id', String(gone.source_id));
    }
    return 'No longer shared.';
  },
  'store-pick': async ({ store }) => {
    if (!(S.d.stores || []).includes(store)) throw new Error('Pick one of your connected stores.');
    await updateRows('affiliate_programs', { store_url: `https://${store}`, changed_by: me.id }, { id: S.programId });
    return `Affiliate links open ${storeName(store)}.`;
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
  'code-make': async ({ id }) => makeInShopify(id ? [id] : S.d.codes.filter((c) => c.status === 'pending').map((c) => c.id)),
  'code-retire': async ({ id }) => { const was = S.d.codes.find((c) => c.id === id)?.status; await updateRows('affiliate_codes', { status: 'retired', changed_by: me.id }, { id }); return was === 'pending' ? 'Code cancelled.' : 'Code retired.'; },
  'link-add': async () => {
    const dest = val('lDest');
    if (!/^https:\/\//i.test(dest)) throw new Error('The page must start with https://');
    must(await db.from('affiliate_links').insert({ company_entity_id: CO, program_id: S.programId, affiliate_id: val('lAff'), slug: val('lSlug'), destination_url: dest, utm_source: 'affiliate', utm_medium: 'affiliate', utm_campaign: val('lCamp') || null, starts_on: today(), created_by: me.id }));
    S.affTool = null;
    return 'Link added.';
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
  // ── The PayPal rail. Every one of these is the edge function's answer, not
  // a claim this page makes: the page cannot see PayPal and does not pretend
  // to. 'pp-send' is the only action in Studio that moves money.
  'pp-connect': async () => {
    const id = val('ppId'); const secret = $('ppSecret')?.value?.trim();
    if (!id || !secret) throw new Error('Paste the client ID and the secret from your PayPal app.');
    const r = await invoke('affiliate-payouts', { action: 'connect', environment: 'live', client_id: id, client_secret: secret });
    return r.warning ? `Connected. ${r.warning}` : 'PayPal connected.';
  },
  'pp-test': async () => {
    const r = await invoke('affiliate-payouts', { action: 'test' });
    return r.payouts_enabled === false ? 'Connected, but PayPal has not enabled Payouts on this account yet.' : 'PayPal is working.';
  },
  'pp-use-rail': async () => {
    await updateRows('affiliate_programs', { payout_method: 'paypal_payouts', changed_by: me.id }, { id: S.programId });
    return 'This program now pays through PayPal. Connect the account below.';
  },
  'pp-disconnect': async () => { await invoke('affiliate-payouts', { action: 'disconnect' }); return 'Disconnected.'; },
  'pp-send': async ({ id }) => {
    const r = await invoke('affiliate-payouts', { action: 'send', payout_id: id });
    if (r.state === 'paid') {
      return S.d.payConn?.environment !== 'live'
        ? 'Sandbox test succeeded. Nobody was paid and the payout is still owed.'
        : `Paid.${await tellPayout(id)}`;
    }
    if (r.state === 'refused') return `PayPal refused it: ${r.message || r.code || 'no reason given'}. Nothing was sent.`;
    if (r.state === 'unclaimed') return 'Sent. They need a PayPal account to claim it; it comes back after 30 days if they do not.';
    return 'Sent. PayPal has not confirmed it yet — use Check payment status.';
  },
  // Pay day. One button, but still one payment per payout: each gets its own
  // claim, its own idempotency key and its own attempt row, so a failure in
  // the middle leaves every payout either sent once or not at all -- never a
  // batch half-believed. The list is read BEFORE the first call, so a payout
  // approved while this runs is not swept in without being seen.
  'pp-send-all': async () => {
    const ids = sendablePayouts().map((x) => x.id);
    if (!ids.length) throw new Error('Nothing is ready to send.');
    const tally = { paid: 0, sent: 0, unclaimed: 0, refused: 0, unknown: 0 };
    const trouble = [];
    for (const id of ids) {
      try {
        const r = await invoke('affiliate-payouts', { action: 'send', payout_id: id });
        if (tally[r.state] !== undefined) tally[r.state] += 1; else tally.unknown += 1;
        if (r.state === 'refused') trouble.push(r.message || r.code || 'refused');
      } catch (e) {
        // An attempt is on file whatever happened here, so the next Check
        // tells the truth. Keep going: one address PayPal dislikes must not
        // stop everyone else being paid.
        tally.unknown += 1;
        trouble.push(e.message);
      }
    }
    const said = [
      tally.paid ? `${num(tally.paid)} paid` : '',
      tally.sent ? `${num(tally.sent)} sent` : '',
      tally.unclaimed ? `${num(tally.unclaimed)} waiting to be claimed` : '',
      tally.refused ? `${num(tally.refused)} refused` : '',
      tally.unknown ? `${num(tally.unknown)} with no answer yet` : '',
    ].filter(Boolean).join(', ');
    const test = S.d.payConn?.environment !== 'live';
    return `${test ? 'Sandbox test: ' : ''}${said}.${test ? ' Nobody was paid and the payouts are still owed.' : ''}${trouble.length ? ` ${esc(trouble[0])}` : ''}`;
  },
  // The card's manual check runs the same targeted loop as the automatic one,
  // so it cannot be starved by the endpoint's oldest-50 window either.
  'pp-refresh': async () => {
    const results = await checkOpenAttempts();
    if (!results.length) return 'Nothing is waiting on PayPal.';
    const paid = results.filter((x) => x.state === 'paid').length;
    const failed = results.filter((x) => x.error).length;
    return `Checked ${num(results.length)}${paid ? `, ${num(paid)} now paid` : ''}${failed ? `, ${num(failed)} could not be checked` : ''}.`;
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
    return `Recorded as paid.${await tellPayout(id)}`;
  },
  'payout-void-open': async ({ id }) => { S.voidOpen = id || null; render(); if (id) $(`vr-${id}`)?.focus(); },
  'payout-void': async ({ id }) => {
    if (!val(`vr-${id}`)) throw new Error('Say why it is being voided.');
    must(await db.rpc('affiliate_void_payout', { p_payout: id, p_reason: val(`vr-${id}`) }));
    S.voidOpen = null;
    return 'Payout voided. Its lines can be paid again in a new payout.';
  },
};

// Two-click confirm for anything that cannot be quietly undone: the first
// click arms the button for four seconds.
document.addEventListener('click', async (ev) => {
  const tab = ev.target.closest('#tabs [data-tab]');
  if (tab) { S.tab = PANEL_OF[tab.dataset.tab] || tab.dataset.tab; S.creating = false; render(); workflowFocusTab(tab.dataset.tab); return; }
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
    // A send that FAILED may still have left an attempt on file -- that is
    // what `unknown` means, and the row must stop offering Send over stale
    // data, or the person clicks again at a payment that may already have
    // gone. Only the payment actions need this; everything else failed
    // before it changed anything.
    if (RELOAD_AFTER_FAILURE.has(b.dataset.act)) {
      try { await reload(); } catch { /* the message above is already shown */ }
    }
  } finally { b.disabled = false; }
});
$('programSel').addEventListener('change', async (e) => { await flushProgramSave(); S.programId = e.target.value; S.creating = false; await loadProgramData(); render(); });
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
