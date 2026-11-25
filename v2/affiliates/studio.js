// Affiliate Studio staff page. Every read is the caller's own session under
// RLS; every write is either a plain row write the policies allow, or one of
// the gated SECURITY DEFINER functions, which re-check the caller. Nothing in
// this file is a permission: hiding a button is convenience, the database
// decides. Pure logic (money, CSV, validation, labels) is in studio-core.js.
import {
  formatMoney, minorUnits, parseMajorToMinor, describeCommission, basisLabel, BASIS_LABELS, validateProgram, slugify,
  toCsv, IMPORT_TEMPLATE, fillTemplate, outreachTemplate, templateRow, prospectEditRow, asWebUrl, liveCodeCount, affiliatePhotoUrl, OUTREACH_HEADER, outreachRows, sha256Hex, PAYOUT_HEADER, payoutRows,
  linkUrl, affiliateLink, storeLinkFor, applyUrl, stageLabels, safeHref, SEARCH_COUNTRIES, SEARCH_LANGUAGES, countryName, languageName, friendlySearchError,
  parseCsv, chunk, runKindLabel, followersFrom, creatorStats, prospectPhotoUrl, sourceLabel, pastCustomerBadge,
  dayShift, dayDiff, ovWindow, ovOtherCurrencyOrders, ovLedgerTotal, ovWeekly, ovUnpaid,
  pagedCollect, OV_PAGE_SIZE,
  ovWeeklySellers, ovPerAffiliate, ovReachOut, ovMessage, OV_REASONS, OV_EARNING_BASES, displayImage, suggestCode, seedView,
  customerQuerySpec, customerConsentView, CUSTOMER_CONSENTS, CUSTOMER_PAGE_SIZE, CUSTOMER_SORTS,
  identityKeys, groupPeople, dropClosedRows, assignedProspectRow,
  customerOutreachTemplate, customerSuppressed, customerProspectRow, customerContactPath, customerNoPathReason, customerDisplayName, customerOrdersLine, customerTemplateRow,
  customerSocialView, customerScanLine, huntLine, huntProgress, LIKELY_SCORE, liveScan, scanTermsFromRead, huntCounts,
  postPlatform, postStats, compactCount, clockDuration, POST_SORTS, sortPosts, offerOpen, postNeedsStats, parseSiloPeople, askSources,
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
// Earnings, payouts and PayPal addresses are read only by Studio managers and
// finance (20261119070000). Anyone else sees the program, not the money.
const SEES_MONEY = MANAGE || MONEY;
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
// Move a set of outreach drafts from one state to the next, and say which
// ones the database would not move. One statement for the common case; a
// refusal (the recipient went onto the do-not-contact list after the draft
// was written, and the drafts guard refuses to contact them) raises and so
// fails the whole statement, which is why the retry is row by row. Each row
// is independent, and a row that does not move is left exactly as it was.
async function moveDrafts(rows, patch, fromState) {
  const moved = []; const refused = [];
  if (!rows.length) return { moved, refused };
  try {
    // Only the rows this update really changed: one another person deleted or
    // sent meanwhile simply does not match, and is left out without an error
    // (review on #1334).
    const done = (await updateRows('affiliate_outreach_drafts', patch, { id: rows.map((x) => x.id), state: fromState })).map((r) => r.id);
    return { moved: rows.filter((x) => done.includes(x.id)), refused };
  } catch { /* a refusal fails the whole statement; find out which ones */ }
  for (const x of rows) {
    try { await updateRows('affiliate_outreach_drafts', patch, { id: x.id, state: fromState }); moved.push(x); }
    catch (e) { refused.push({ x, why: friendly(e) }); }
  }
  return { moved, refused };
}
// The deliverable half of an export: a personal sign-up link for each row,
// the file, and the batch stamped with what the file contains. A batch with
// no fingerprint was claimed and never delivered, which is what 'batch-finish'
// looks for. Returns how many rows carry no link.
async function deliverBatch(batchId, drafts, stamp) {
  const links = {};
  for (const x of drafts) {
    if (!x.recipient_email) { links[x.id] = { error: 'No email address, so no personal link. Send the open-application link, or add their email first.' }; continue; }
    try { const out = await invoke('affiliate-invite', { action: 'signup_link', prospect_id: x.prospect_id }); links[x.id] = { url: out.signup_url, expires_at: out.expires_at }; }
    catch (e) { links[x.id] = { error: friendly(e) }; }
  }
  const csv = toCsv(OUTREACH_HEADER, outreachRows(drafts, links));
  await db.from('affiliate_outreach_batches').update({ row_count: drafts.length, fingerprint: await sha256Hex(csv) }).eq('id', batchId).eq('company_entity_id', CO);
  download(`outreach-${prog().slug}-${String(stamp).slice(0, 10)}.csv`, csv);
  return Object.values(links).filter((l) => l.error).length;
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
  // The open dialog counts too: its form is outside the panels (Blake
  // 2026-11-20), and a background refresh must still hold off while someone
  // is half way through it.
  return [...document.querySelectorAll('.af-panel input, .af-panel textarea, dialog[open] input, dialog[open] textarea')].some((el) =>
    (el.type === 'checkbox' || el.type === 'radio') ? el.checked !== el.defaultChecked : (el.type !== 'file' ? el.value !== el.defaultValue : !!el.files?.length));
}
async function autoRefreshCreators(id) {
  if (!MANAGE || !id || autoRefreshing === id || !autoRefreshDue(id)) return;
  // On People the page holds every program's creators; this program's only.
  const company = !!S.d?.company;
  const pros = (S.d?.prospects || []).filter((x) => !company || x.program_id === id);
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
    const quiet = () => (company ? companyScope() : S.programId === id) && !S.creating && S.tab !== 'program' && !formDirty();
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
// Ending a code in SILO also turns it off in Shopify (audit 2026-11-18), so
// it stops working at checkout. A failure is said, never hidden: the code row
// then offers "Turn off in Shopify" again.
async function endInShopify(ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return '';
  // In batches of 25 (the function's limit), and every id must come back
  // with an outcome: one missing is reported as still on, never as done.
  let results = [];
  try {
    for (const part of chunk(ids, 25)) results = results.concat((await invoke('affiliate-invite', { action: 'end_shopify_codes', code_ids: part }))?.results || []);
  } catch (e) { return `Could not turn ${results.length ? 'all of them' : 'it'} off in Shopify yet (${e.message}). Press Turn off in Shopify on the code.`; }
  const answered = new Set(results.map((r) => r.code_id));
  for (const id of ids) if (!answered.has(id)) results.push({ code_id: id, status: 'unanswered', reason: 'no answer from Shopify for one code; press Turn off in Shopify on it' });
  const n = (k) => results.filter((r) => r.status === k).length;
  const parts = [];
  if (n('ended')) parts.push(`${num(n('ended'))} turned off in Shopify.`);
  if (n('manual')) parts.push(`${num(n('manual'))} made by hand: turn it off in Shopify yourself.`);
  const bad = results.find((r) => !['ended', 'manual'].includes(r.status));
  if (bad) parts.push(`Still on in Shopify: ${bad.reason || bad.status}.`);
  return parts.join(' ');
}
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

// A preview link: 32 random bytes, URL-safe, the shape the portal accepts.
function previewToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
// Adds a person to another program: their own row there, with who they are
// and the evidence but none of the first program's decisions. Returns that
// row's id. If they are already there (another tab, or a row the page had not
// loaded), that row is used rather than a second one.
async function assignToProgram(id, programId, status = 'approved') {
  const x = S.d?.prospectById?.[id];
  const p = S.programs.find((y) => y.id === programId);
  if (!x || !p) throw new Error('Pick a program first.');
  const keys = new Set(identityKeys(x));
  const same = (r) => identityKeys(r).some((k) => keys.has(k));
  const there = (S.d.prospects || []).find((r) => r.program_id === p.id && same(r));
  if (there) return there.id;
  const row = assignedProspectRow(x, p.id, status);
  try {
    return must(await db.from('affiliate_prospects').insert({
      ...row, company_entity_id: CO,
      ...(status === 'new' ? {} : { reviewed_by: me.id, reviewed_at: new Date().toISOString() }),
      created_by: me.id, changed_by: me.id,
    }).select('id').single()).id;
  } catch (e) {
    if (e?.code !== '23505') throw e;
    // Already in that program: find that row by the same identity.
    const { data } = await db.from('affiliate_prospects').select('*').eq('company_entity_id', CO).eq('program_id', p.id).limit(2000);
    const made = (data || []).find(same);
    if (!made) throw e;
    return made.id;
  }
}
function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── State ────────────────────────────────────────────────────────────────
const PROSPECT_LIST_CAP = 20;
// Declared before S, because S.view calls readView() as it is built: a const
// read before its own initializer throws, and the choice silently reverted.
const VIEW_KEY = 'silo.affiliates.view';
const S = { programs: [], programId: null, tab: 'people', peopleSub: 'discovery', cust: null, commsTab: 'approve', profiles: [], brand: '', ovDays: 30, ovFrom: '', ovTo: '', ovRank: 'sales', ovFilter: 'all', affFilter: 'current', prospectFilter: 'new', prospectShowAll: false, prospectQuery: '', find: '', sel: new Set(), view: readView() };
const prog = () => S.programs.find((p) => p.id === S.programId) || null;
// "All programs" (Blake 2026-11-18: a company manages a group of people, not
// program by program). People and Home read across every program; the other
// tabs are per program and ask which one.
const ALL = '*';
const isAll = () => S.programId === ALL && S.programs.length > 1;
const otherPrograms = () => S.programs.filter((x) => x.id !== S.programId && x.status === 'active');
// People sit above programs (Blake 2026-11-24: "people is above programs"),
// and so do Money, Records and the Program numbers (Blake 2026-11-25: "money
// - should not be tabbed at program level...all entity level. same with
// records"). Those tabs always read every program the person may see and
// show no program picker; only Outreach, Share and Setup work one program at
// a time. A button on a company tab works in the program of the row it sits
// on (see ctxProgram).
const COMPANY_TABS = new Set(['people', 'payouts', 'records', 'overview']);
const companyScope = () => COMPANY_TABS.has(S.tab) && S.programs.length > 0;
// A company tab holding more than one program: no single program describes
// the page, so its money, rail and currency come from each row's own program.
const companyMulti = () => !!S.d?.company && S.programs.length > 1;
// The currency most programs use, for company-wide totals (summed per
// currency, never across).
const mainCurrency = () => {
  const n = {};
  for (const x of S.programs) { const c = (x.currency || 'USD').toUpperCase(); n[c] = (n[c] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
};
const progOf = (x) => S.programs.find((p) => p.id === x?.program_id) || null;
// Programs a person can be added to or searched for: anything not closed.
const openPrograms = () => S.programs.filter((x) => x.status !== 'closed');
// Where Find creators and Add creators save what they find. There is no
// picker (Blake 2026-11-24: "SHOW ONE LIST"): everybody found shows on the
// one company list whichever program holds the row, and "Add to <program>"
// puts them in any other.
const findProgram = () => openPrograms().find((x) => x.id === S.programId) || openPrograms()[0] || null;

async function loadPrograms() {
  S.programs = must(await db.from('affiliate_programs').select('*').eq('company_entity_id', CO).order('created_at'));
  const qp = new URLSearchParams(location.search).get('program');
  // An open program is the default; a closed one is only ever picked on purpose.
  if (!isAll() && !S.programs.some((p) => p.id === S.programId)) S.programId = (S.programs.find((p) => p.id === qp) || openPrograms()[0] || S.programs[0])?.id || null;
  const opt = (p) => `<option value="${p.id}"${p.id === S.programId ? ' selected' : ''}>${esc(p.name)} · ${esc(p.status)}</option>`;
  const closed = S.programs.filter((p) => p.status === 'closed');
  $('programSel').innerHTML = S.programs.length
    ? (S.programs.length > 1 ? `<option value="${ALL}"${isAll() ? ' selected' : ''}>All programs</option>` : '')
      + openPrograms().map(opt).join('')
      + (closed.length ? `<optgroup label="Closed">${closed.map(opt).join('')}</optgroup>` : '')
    : '<option value="">No programs yet</option>';
  $('btnNewProgram').hidden = !MANAGE;
}

// Every read is numbered, and only the newest may become what the page shows:
// two tab changes in a row (People, then Outreach) start two reads of
// different scope, and the slower one must not land last and put every
// program's drafts on a one-program tab.
let loadGen = 0;
async function loadProgramData() {
  const gen = ++loadGen;
  // People first: it is company-wide in every mode, "All programs" included.
  const company = companyScope();
  if (!company && isAll()) return loadAllData(gen);
  const p = company ? null : prog();
  if (!p && !company) { S.d = null; return; }
  // Company scope reads every program at once (RLS still decides which ones).
  const by = (t, cols = '*') => (p ? db.from(t).select(cols).eq('company_entity_id', CO).eq('program_id', p.id) : db.from(t).select(cols).eq('company_entity_id', CO));
  const cap = p ? 500 : 2000;
  const q = {
    health: p ? db.from('affiliate_program_health_v').select('*').eq('company_entity_id', CO).eq('program_id', p.id).maybeSingle()
      : db.from('affiliate_program_health_v').select('*').eq('company_entity_id', CO),
    runs: by('affiliate_discovery_runs').order('started_at', { ascending: false }).limit(25),
    // Company scope reads every prospect, paged (loadCompanyProspects).
    ...(p ? { prospects: by('affiliate_prospects').order('collected_at', { ascending: false }).limit(cap) } : {}),
    drafts: by('affiliate_outreach_drafts').order('created_at', { ascending: false }).limit(cap),
    batches: by('affiliate_outreach_batches').order('created_at', { ascending: false }).limit(50),
    codes: by('affiliate_codes').order('starts_on', { ascending: false }),
    links: by('affiliate_links').order('starts_on', { ascending: false }),
    attributions: by('affiliate_attributions').order('order_day', { ascending: false }).limit(300),
    performance: by('affiliate_performance_v'),
    periods: by('affiliate_commission_periods').order('period_start', { ascending: false }),
    ledger: by('affiliate_commission_ledger').order('created_at', { ascending: false }).limit(300),
    ledgerCount: p ? db.from('affiliate_commission_ledger').select('id', { count: 'exact', head: true }).eq('company_entity_id', CO).eq('program_id', p.id)
      : db.from('affiliate_commission_ledger').select('id', { count: 'exact', head: true }).eq('company_entity_id', CO),
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
      .select('id, payout_id, attempt, state, provider_status, provider_batch_id, provider_item_id, error_code, error_message, environment, created_at')
      .eq('company_entity_id', CO)
      // Newest first, and `attempt` breaks a tie: two attempts stamped in the
      // same instant must not leave the row describing the older one.
      .order('created_at', { ascending: false }).order('attempt', { ascending: false }).limit(200),
  };
  const keys = Object.keys(q);
  // The creator list is read paged and NOT in that batch: a program with more
  // creators than one PostgREST page returns would otherwise show only its
  // first 1,000, and the share audience dialog saves over what it shows
  // (review cycle 2 of #1350).
  const [res, affRead] = await Promise.all([Promise.all(Object.values(q)), loadAffiliates(p)]);
  const prosRead = p ? null : await loadCompanyProspects();
  // The whole do-not-contact list, paged: a person must never look
  // contactable because their entry fell off the end of one capped read.
  const supRead = await loadSuppressions();
  const d = {}; const failed = [];
  res.forEach((r, i) => {
    d[keys[i]] = r.data ?? (keys[i] === 'health' ? null : []);
    if (r.error && keys[i] === 'seeds') { d.seeds = null; return; }
    if (r.error && keys[i] === 'content') { d.content = null; return; }
    if (r.error) failed.push(`${keys[i]}: ${r.error.message}`);
  });
  // Could not read the whole list: nobody is offered to another program
  // (supUnknown), and the page says so.
  d.suppressions = supRead || [];
  d.supUnknown = !supRead;
  if (!supRead) failed.push('do-not-contact list: could not be read in full');
  // Company scope: one health row per program, added up for the tab badges.
  if (!p) d.health = sumHealth(d.health);
  // Company scope: every person, or -- if a page would not read -- the newest
  // 2,000 and a plain warning, never a short list presented as everybody.
  if (!p) {
    if (prosRead) d.prospects = prosRead;
    else {
      const r = await db.from('affiliate_prospects').select('*').eq('company_entity_id', CO).order('collected_at', { ascending: false }).limit(cap);
      d.prospects = r.data || [];
      failed.push(r.error ? `prospects: ${r.error.message}` : `prospects: only the newest ${num(cap)} loaded`);
    }
  }
  d.company = !p;
  // affFull says whether that list is the whole program. Null means a page
  // errored or the list ran past the page cap; the page still works off one
  // plain read, and affFull being false is what stops a save from treating
  // the names it showed as the entire audience.
  if (affRead) { d.affiliates = affRead; d.affFull = true; }
  else {
    const r = await (p ? db.from('affiliates').select('*').eq('company_entity_id', CO).eq('program_id', p.id) : db.from('affiliates').select('*').eq('company_entity_id', CO)).order('created_at');
    d.affiliates = r.data || [];
    d.affFull = false;
    if (r.error) failed.push(`affiliates: ${r.error.message}`);
  }
  d.ledgerCount = res[keys.indexOf('ledgerCount')].count ?? 0;
  const ids = d.payouts.map((x) => x.id);
  if (ids.length) {
    const items = (await db.from('affiliate_payout_items').select('payout_id').eq('company_entity_id', CO).in('payout_id', ids)).data || [];
    const n = {}; items.forEach((i) => { n[i.payout_id] = (n[i.payout_id] || 0) + 1; });
    d.payouts.forEach((x) => { x.item_count = n[x.id] || 0; });
  }
  // Who each share is for (20261121210000), read for exactly the shares on
  // screen and paged, because one company-wide page would silently stop at
  // its limit and a share whose rows fell off the end would read as being for
  // everyone. NULL means could-not-read, which is NOT the same as nobody
  // named: the page then shows what every share meant before the migration
  // and does not offer to change it, rather than saving a guess over it.
  d.audience = await loadAudience((d.feed || []).map((x) => x.id));
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
  // What those two actually cover, so a later range can tell "already loaded"
  // from "needs reading further back" without guessing.
  S.ovLoadedFrom = ovFloor();
  d.aiApps = await loadAiApps();
  d.stores = await loadStores();
  if (gen !== loadGen) return;
  S.d = d;
  // A research run started earlier (another tab, a reload) is still watched.
  const live = d.runs?.find((r) => r.provider === 'anthropic' && r.status === 'running' && Date.now() - new Date(r.started_at).getTime() < RESEARCH_STALE_MS);
  if (live && S.watching !== live.id) watchResearch(live.id);
  if (p) autoRefreshCreators(p.id);
  else (async () => { for (const x of openPrograms()) await autoRefreshCreators(x.id); })();
  announcePaidPayouts();
  if (failed.length) setStatus(`Some data did not load (has the Affiliate Studio migration been applied?): ${failed.slice(0, 3).join('; ')}`, 'neg');
}

// The company's health: every program's row added up. Null when unread.
function sumHealth(rows) {
  if (!Array.isArray(rows)) return rows || null;
  const out = {};
  for (const r of rows) for (const [k, v] of Object.entries(r || {})) if (typeof v === 'number') out[k] = (out[k] || 0) + v;
  return out;
}

// Every program at once: who is in what, and the company's totals. Read only
// what the two all-program views draw; null means "could not read".
async function loadAllData(gen = ++loadGen) {
  const by = (t, cols = '*') => db.from(t).select(cols).eq('company_entity_id', CO);
  const keys = ['affiliates', 'codes', 'performance', 'balances'];
  const res = await Promise.all([
    by('affiliates').order('created_at'),
    by('affiliate_codes', 'id, affiliate_id, program_id, code, status, starts_on, ends_on, discount_percent').order('starts_on', { ascending: false }),
    by('affiliate_performance_v'),
    by('affiliate_balances_v'),
  ]);
  const d = { all: true };
  const failed = [];
  res.forEach((r, i) => { d[keys[i]] = r.error ? null : (r.data || []); if (r.error) failed.push(`${keys[i]}: ${r.error.message}`); });
  if (gen !== loadGen) return;
  S.d = d;
  if (failed.length) setStatus(`Some data did not load: ${failed.slice(0, 3).join('; ')}`, 'neg');
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

// Everyone in one program, in pages. `created_at` alone is not a stable page
// boundary, so `id` breaks the tie. Null means a page errored or the list runs
// past the page cap -- see affFull in loadProgramData.
async function loadAffiliates(p) {
  return pagedCollect(async (i) => {
    try {
      const base = db.from('affiliates').select('*').eq('company_entity_id', CO);
      const { data, error } = await (p ? base.eq('program_id', p.id) : base)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      if (error) return null;
      return data || [];
    } catch (_) { return null; }
  });
}

// The company's do-not-contact list, in pages. Null when it is not whole.
async function loadSuppressions() {
  return pagedCollect(async (i) => {
    try {
      const { data, error } = await db.from('affiliate_suppressions').select('*').eq('company_entity_id', CO)
        .order('created_at', { ascending: false }).order('id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      return error ? null : (data || []);
    } catch (_) { return null; }
  });
}

// Every prospect the company has, newest first, in pages with id breaking
// ties. Null means a page errored or it ran past the page cap.
async function loadCompanyProspects() {
  return pagedCollect(async (i) => {
    try {
      const { data, error } = await db.from('affiliate_prospects').select('*').eq('company_entity_id', CO)
        .order('collected_at', { ascending: false }).order('id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      return error ? null : (data || []);
    } catch (_) { return null; }
  });
}

// Who each share is for. Read for exactly the shares on screen, in pages, so
// a company with more audience rows than one page holds cannot leave a
// narrowed share looking like it is for everyone. pagedCollect returns null
// for a read that errored or stopped short, and null is carried all the way
// to the dialog: could-not-read must never be saved over as "nobody named"
// (review of #1350).
async function loadAudience(feedIds) {
  const ids = (feedIds || []).filter(Boolean);
  if (!ids.length) return [];
  return pagedCollect(async (i) => {
    try {
      const { data, error } = await db.from('affiliate_feed_audience')
        .select('feed_item_id, affiliate_id')
        .eq('company_entity_id', CO).in('feed_item_id', ids)
        .order('feed_item_id', { ascending: true }).order('affiliate_id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      // Before 20261121210000 there is no table at all. That is not a failure
      // to report: no share was narrowed, because none could be.
      if (error) return error.code === '42P01' ? [] : null;
      return data || [];
    } catch (_) { return null; }
  });
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
      // No program: the company's rows (a company tab), RLS still deciding
      // which programs this person may read.
      let q = db.from(table).select(cols).eq('company_entity_id', CO);
      if (programId) q = q.eq('program_id', programId);
      const { data, error } = await q
        .gte('order_day', since)
        .order('order_day', { ascending: false }).order('id', { ascending: true })
        .range(i * OV_PAGE_SIZE, i * OV_PAGE_SIZE + OV_PAGE_SIZE - 1);
      return error ? null : (data || []);
    } catch (_) { return null; }
  });
}
// How far back the two windowed reads go: 180 days, or further when a custom
// range asks for older days. Without this a range picked from the calendar
// would quietly read as zero rather than as "we did not load that far back".
function ovFloor() {
  const base = dayShift(today(), OV_DAYS_BACK);
  // The window BEFORE the chosen one, because every figure on Home and Money
  // is shown against it: loading only the chosen days would compare a real
  // January against a December that was never read, which reads as zero.
  const w = ovWindows();
  const from = w.custom ? String(w.prevFrom || '') : '';
  return ISO_DAY.test(from) && from < base ? from : base;
}
const loadOvAttributions = (p) => loadPaged('affiliate_attributions',
  'id, affiliate_id, order_id, order_day, basis, gross_subtotal_cents, commissionable_cents, order_currency',
  ovFloor(), p?.id || null);
const loadOvLedger = (p) => loadPaged('affiliate_commission_ledger',
  'id, affiliate_id, order_day, amount_cents, currency', ovFloor(), p?.id || null);
// A custom range that reaches past what is loaded re-reads those two, and
// only those two.
async function reloadOvWindow() {
  const p = S.d?.company ? null : prog();
  if ((!p && !S.d?.company) || !S.d) return;
  const [a, l] = await Promise.all([loadOvAttributions(p), loadOvLedger(p)]);
  S.d.ovAttributions = a; S.d.ovLedger = l; S.ovLoadedFrom = ovFloor();
}

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
// Moving onto or off People changes what the page reads (every program, or
// the one picked), so crossing that line reads again.
async function goTab(t) {
  const was = companyScope();
  S.tab = t;
  if (was !== companyScope()) { S.sel.clear(); await loadProgramData(); }
}
// The program a People button acts in: the one it names, else the one of the
// row its id belongs to. Ids are unique across tables.
function ctxProgram(ds) {
  if (ds.pg && S.programs.some((x) => x.id === ds.pg)) return ds.pg;
  const id = ds.id; const d = S.d;
  if (!id || !d) return null;
  const hit = d.prospectById?.[id] || d.affById?.[id]
    || [d.codes, d.links, d.drafts, d.seeds, d.payouts].map((list) => (list || []).find((x) => x.id === id)).find(Boolean);
  return hit?.program_id || null;
}

// ── Rendering helpers ────────────────────────────────────────────────────
// A box with nothing in it is not drawn (Blake, 2026-11-17: "a lot of shit
// to look at"). A tab left with nothing says so once (see render()).
const EMPTY_ONLY = /^\s*<div class="bcn-empty">[^<]*<\/div>\s*$/;
// `icon` is trusted markup (a source's logo, e.g. shopifyMark()) drawn before the title.
const card = (title, body, meta = '', extraClass = '', icon = '') => (EMPTY_ONLY.test(body) ? '' : `<div class="bcn-card${extraClass ? ` ${extraClass}` : ''}"><div class="bcn-card-header"><h2>${icon}${esc(title)}</h2>${meta ? `<span class="bcn-card-meta">${meta}</span>` : ''}</div><div class="bcn-card-body">${body}</div></div>`);
// An empty box can carry the one button that fills it (audit finding 12,
// 2026-11-25). `go` is that button; a box with one is never dropped as empty,
// which is the point of it.
const empty = (t, go = '') => `<div class="bcn-empty">${esc(t)}${go ? `<div class="af-empty-go">${go}</div>` : ''}</div>`;
// ── Search ───────────────────────────────────────────────────────────────
// One box at the top of every tab (Blake 2026-11-24: "ALL tabs should and
// need to be searchable"; he chose filter-in-place plus jump links). Every
// list the page draws goes through table / itemList / queue / shareList, and
// each keeps only the rows whose visible text holds every word typed.
// Button and menu labels are not part of a row's text, so "short" never
// matches a Shortlist button.
const findWords = () => String(S.find || '').toLowerCase().split(/\s+/).filter(Boolean);
const plainText = (html) => String(html || '')
  .replace(/<(button|select)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .toLowerCase();
const textHits = (text, words = findWords()) => words.every((w) => text.includes(w));
// `emptyText` is the line, or { text, go } when there is a button that fills it.
const findEmpty = (e) => (findWords().length
  ? empty(`No matches for "${S.find.trim()}" here.`)
  : empty(typeof e === 'string' ? e : (e?.text || ''), typeof e === 'string' ? '' : (e?.go || '')));
// A column with `sort` gets a header button; `sort` on the table says which
// action it fires and which key and direction are on now.
function table(cols, rows, emptyText = 'Nothing here yet.', sort = null) {
  if (findWords().length) rows = rows.filter((r) => textHits(plainText(cols.map((c) => c.f(r)).join(' '))));
  if (!rows.length) return findEmpty(emptyText);
  const head = (c) => {
    // A column may draw its own heading (the select-all box); everything else
    // is text, escaped.
    if (c.hHtml) return c.hHtml;
    if (!sort || !c.sort) return esc(c.h);
    const on = sort.k === c.sort;
    const arrow = on ? (sort.dir > 0 ? '↑' : '↓') : '↕';
    return `<button type="button" class="af-th-sort${on ? ' is-on' : ''}" data-act="${sort.act}" data-k="${c.sort}" aria-label="Sort by ${esc(c.h)}">${esc(c.h)}<span aria-hidden="true">${arrow}</span></button>`;
  };
  return `<div class="af-scroll"><table class="bcn-table"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="af-num"' : c.left ? ' class="bcn-th-left"' : ''}${sort && c.sort === sort.k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${head(c)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="af-num"' : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function itemList(rows, renderRow, emptyText = 'Nothing here yet.', layout = 'stack') {
  let html = rows.map(renderRow);
  if (findWords().length) html = html.filter((h) => textHits(plainText(h)));
  if (!html.length) return findEmpty(emptyText);
  const cls = layout === 'grid' ? 'af-items af-items--grid' : 'af-items';
  return `<div class="${cls}" role="list">${html.join('')}</div>`;
}
// ── Queues ───────────────────────────────────────────────────────────────
// Blake, 2026-11-17: "selection boxes or approved queues". Tick rows, then
// act on the ticked ones; nothing moves until a person presses. Each queue
// keeps its own ticks, and a tick on a row that left the queue is dropped.
const QSEL = {}; const QROWS = {};
const qsel = (k) => (QSEL[k] ||= new Set());
const subtabs = (label, items, act, current) => `<nav class="bcn-tabs af-subtabs" role="tablist" aria-label="${esc(label)}">${items.map(([k, title, n]) => `<button type="button" class="bcn-tab${k === current ? ' bcn-tab--active' : ''}" role="tab" aria-selected="${k === current}" data-act="${act}" data-k="${esc(k)}">${esc(title)}${n ? ` <span class="af-tab-count">${num(n)}</span>` : ''}</button>`).join('')}</nav>`;
function queue(k, rows, renderRow, actions, emptyText, opts = {}) {
  // A search narrows what Select all can tick, too.
  if (findWords().length) rows = rows.filter((r) => textHits(plainText(renderRow(r))));
  const sel = qsel(k);
  const ids = rows.map((r) => r.id); QROWS[k] = ids;
  for (const id of [...sel]) if (!ids.includes(id)) sel.delete(id);
  if (!rows.length) return findEmpty(emptyText);
  const can = actions.length > 0;
  const all = ids.every((id) => sel.has(id));
  const bar = can ? `<div class="af-row af-bulk af-q-bar"><label class="af-q-all"><input type="checkbox" class="af-pick" data-act="q-all" data-q="${k}"${all ? ' checked' : ''} /> Select all ${num(rows.length)}</label>${sel.size ? `<span class="af-mono">${num(sel.size)} selected</span>${actions.map(([label, act, kind = 'surface', opts = {}]) => btn(label, act, { q: k }, kind, opts)).join('')}` : ''}</div>` : '';
  const pick = (r) => (can ? `<input type="checkbox" class="af-pick af-q-pick" data-act="q-pick" data-q="${k}" data-id="${esc(r.id)}" aria-label="Select"${sel.has(r.id) ? ' checked' : ''} />` : '');
  return `${bar}<div class="af-q${opts.grid ? ' af-q--grid' : ''}" role="list">${rows.map((r) => `<div class="af-q-row${sel.has(r.id) ? ' is-selected' : ''}" role="listitem">${pick(r)}<div class="af-q-body">${renderRow(r)}</div></div>`).join('')}</div>`;
}
// The same queue as a dense table: one row per line, the ticks in the first
// column and Select all in its header (audit finding 7, 2026-11-25). The
// selection bookkeeping is `queue`'s, so the bulk actions are unchanged.
function queueTable(k, rows, cols, actions, emptyText) {
  const sel = qsel(k);
  const txt = (r) => plainText(cols.map((c) => c.f(r)).join(' '));
  if (findWords().length) rows = rows.filter((r) => textHits(txt(r)));
  const ids = rows.map((r) => r.id); QROWS[k] = ids;
  for (const id of [...sel]) if (!ids.includes(id)) sel.delete(id);
  if (!rows.length) return findEmpty(emptyText);
  const can = actions.length > 0;
  const all = ids.length > 0 && ids.every((id) => sel.has(id));
  const bar = can && sel.size
    ? `<div class="af-row af-bulk af-q-bar"><span class="af-mono">${num(sel.size)} selected</span>${
      actions.map(([label, act, kind = 'surface', o = {}]) => btn(label, act, { q: k }, kind, o)).join('')}</div>`
    : '';
  const pickCol = can ? [{
    hHtml: `<input type="checkbox" class="af-pick" data-act="q-all" data-q="${k}"${all ? ' checked' : ''} aria-label="Select all ${num(rows.length)}" />`,
    f: (r) => `<input type="checkbox" class="af-pick af-q-pick" data-act="q-pick" data-q="${k}" data-id="${esc(r.id)}" aria-label="Select"${sel.has(r.id) ? ' checked' : ''} />`,
  }] : [];
  return `${bar}${table([...pickCol, ...cols], rows, emptyText)}`;
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
// A post is whatever the affiliate's phone produced. Chrome cannot decode most
// .mov files, and a <video> that never loads keeps its 300x150 default, so the
// tile used to hold an empty box of the wrong shape. Say what the file is
// instead; the file itself still opens in a new tab (Blake 2026-11-21).
document.addEventListener('error', (ev) => {
  const t = ev.target;
  if (t?.classList?.contains('af-avatar-photo')) { ev.target.remove(); return; }
  if (!t?.classList?.contains('af-content-media')) return;
  const box = t.closest('.af-ctile-media');
  if (!box) return;
  box.classList.add('af-ctile-media--none');
  box.textContent = t.tagName === 'VIDEO' ? 'Video' : 'Photo';
}, true);
// An uploaded video's length comes from the file itself once the browser has
// read its header; until then (or if it cannot) the badge stays hidden.
document.addEventListener('loadedmetadata', (ev) => {
  const t = ev.target;
  if (t?.tagName !== 'VIDEO' || !t.classList?.contains('af-content-media')) return;
  const badge = t.closest('.af-ctile-media')?.querySelector('.af-ctile-dur');
  if (!badge || !Number.isFinite(t.duration) || t.duration <= 0) return;
  badge.textContent = clockDuration(t.duration); badge.hidden = false;
}, true);
// Tiles or a list (table with the same photos). Remembered per viewer.
// Lists by default: tiles take three times the height for the same rows
// (Blake 2026-11-20, "tiles are way large"). The choice is still remembered.
function readView() { try { return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'list'; } catch { return 'list'; } }
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
  // `title` is for a button whose label is a glyph: the sentence a screen
  // reader and a hover both get.
  const extra = `${opts.cls ? ` ${opts.cls}` : ''}`;
  return `<button class="bcn-btn${mod}${extra}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}${opts.confirm ? ' data-confirm="1"' : ''}${opts.disabled ? ' disabled' : ''}${opts.title ? ` title="${esc(opts.title)}" aria-label="${esc(opts.title)}"` : ''}>${esc(label)}</button>`;
};
const field = (label, inner) => `<div class="bcn-field-group"><label class="bcn-label">${esc(label)}</label>${inner}</div>`;
// The same, with the sentence that used to sit under the field on hover
// instead. `label` is still text: only the hint is markup.
const fieldTip = (label, tip, inner) => `<div class="bcn-field-group"><label class="bcn-label">${esc(label)}${info(tip)}</label>${inner}</div>`;
const input = (id, attrs = '') => `<input class="bcn-field" id="${id}" ${attrs} />`;
const pill = (t, kind = '') => `<span class="bcn-pill${kind ? ` bcn-pill--${kind}` : ''}">${esc(t)}</span>`;
// The explanation a line used to carry, on hover instead (Blake 2026-11-20:
// shorter instructions, info hovers as needed). Never the only place
// something important is said -- it is detail, not the instruction.
const info = (text) => `<span class="af-info" tabindex="0" role="note" title="${esc(text)}" aria-label="${esc(text)}">i</span>`;
const STATUS_TONE = { active: 'pos', approved: 'pos', signed_up: 'pos', marked_paid: 'pos', sent: 'accent', exported: 'accent', invited: 'accent', qualified: 'accent', under_review: 'accent', rejected: 'neg', suppressed: 'neg', terminated: 'neg', void: 'neg', bounced: 'neg', declined: 'neg' };
const statusPill = (s) => pill(s, STATUS_TONE[s] || '');
// A creator SILO found is not an approved anything yet: shortlisting them
// only lines them up for a message (Blake 2026-11-20). The stored status is
// unchanged; this is what it is called on screen.
const PROSPECT_LABEL = { new: 'to review', qualified: 'to review', approved: 'shortlisted', rejected: 'not a fit', invited: 'invited', signed_up: 'signed up', suppressed: 'do not contact' };
const prospectPill = (s) => pill(PROSPECT_LABEL[s] || s, STATUS_TONE[s] || '');
// Already bought from this company. The badge is the whole feature: no queue,
// no hold on an outreach draft (Blake 2026-11-23).
const customerPill = (x) => {
  const b = pastCustomerBadge(x, (progOf(x) || prog())?.currency);
  return b ? `<span class="bcn-pill${b.tone ? ` bcn-pill--${b.tone}` : ''}" title="${esc(b.title)}">${esc(b.label)}</span>` : '';
};
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
  ['products', 'Products', ['Products']],
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
  // Who runs Studio is the company's; a program's status belongs to one
  // program, so it shows only when one program is on the page.
  if (MANAGE && prog()) more('Team and status', ['<div id="managersCard"></div>', S.d && !companyMulti() ? stageCard() : '']);
  const groups = RECORD_GROUPS.map(([key, title, keys]) => ({ key, title, parts: keys.flatMap((k) => RECORDS.get(k) || []) })).filter((g) => g.parts.length);
  if (!groups.some((g) => g.key === S.recTab)) S.recTab = groups[0]?.key || null;
  const g = groups.find((x) => x.key === S.recTab);
  const chips = subtabs('Records', groups.map((x) => [x.key, x.title, 0]), 'rec-tab', S.recTab);
  $('recordsBody').innerHTML = g ? `${chips}<div class="af-rec-list${S.recAll ? '' : ' af-rec-capped'}" id="recList">${g.parts.join('')}</div>` : empty('Nothing recorded yet.');
  // "Show all" only where a list is longer than the first rows.
  const list = $('recList');
  if (list && !S.recAll && [...list.querySelectorAll('[role="list"]')].some((l) => l.children.length > RECORD_ROWS)) {
    list.insertAdjacentHTML('beforeend', `<div class="af-row">${btn('Show all', 'rec-all', {}, 'surface')}</div>`);
  }
  renderManagers();
}
// Records tables sort in place: the header says which column and which way,
// and the rows are ordered here (table() only draws the header).
const recSortSpec = () => ({ act: 'rec-sort', k: S.recSort?.k || '', dir: S.recSort?.dir || -1 });
const recSortRows = (rows, getters) => {
  const sp = S.recSort;
  if (!sp?.k || !getters[sp.k]) return rows;
  const g = getters[sp.k];
  return [...rows].sort((a, b) => {
    const x = g(a); const y = g(b);
    if (x === y) return 0;
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return (x > y ? 1 : -1) * sp.dir;
  });
};
// `actions` are buttons that belong to the whole list and stay in its header,
// so a control like Export never hides at the bottom of a card (audit
// finding 5).
const surface = (title, body, meta = '', id = '', actions = '', icon = '') => {
  if (EMPTY_ONLY.test(body) && !actions) return '';
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section class="af-surface"${idAttr}><header class="af-surface-head"><h2>${icon}${esc(title)}</h2>${meta ? `<span class="af-muted">${esc(meta)}</span>` : ''}${actions ? `<div class="af-surface-acts">${actions}</div>` : ''}</header><div class="af-surface-body">${body}</div></section>`;
};
const val = (id) => ($(id)?.value ?? '').trim();
const today = () => new Date().toISOString().slice(0, 10);
const money = (c, currency = null) => formatMoney(c, currency || ovCur());

function scrollWorkflowTo(id) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}
// Which People sub-tab a place name lands on.
function peopleSubFor(t) {
  if (t === 'prospects') S.peopleSub = 'discovery';
  else if (t === 'people' || t === 'affiliates') S.peopleSub = 'affiliates';
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
  const d = S.d; const h = d?.health;
  // Company scope (People) has no one program; its counts are every program's.
  const p = d?.company ? null : prog();
  if ((!p && !d?.company) || !h) return;
  const msgN = Number(h.outreach_approved || 0) + Number(h.outreach_exported || 0) + d.drafts.filter((x) => x.state === 'draft').length;
  const payN = (d.balances || []).filter((b) => (!p || b.currency === p.currency) && Number(b.unclaimed_cents) > 0).length;
  const onboardN = Number(h.codes_never_seen || 0) + d.codes.filter((c) => c.status === 'pending').length;
  const contentN = (d.content || []).filter((x) => x.state === 'submitted').length;
  const appliedN = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status)).length;
  const toReview = Math.max(0, Number(h.prospects_new || 0) - appliedN);
  const counts = { people: toReview + onboardN, comms: msgN + appliedN, share: contentN, payouts: payN };
  // The People sub-tabs carry the same badges, so the split does not hide
  // what is waiting behind the sub-tab you are not on.
  const subCounts = { affiliates: onboardN, discovery: toReview };
  for (const b of document.querySelectorAll('#peopleSubtabs [data-k]')) {
    const n = subCounts[b.dataset.k];
    let badge = b.querySelector('.af-tab-count');
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'af-tab-count'; b.appendChild(badge); }
      badge.textContent = num(n);
    } else if (badge) badge.remove();
  }
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
  prospects: 'people', outreach: 'comms', comms: 'comms', affiliates: 'people', share: 'share',
};
// Where a panel's "no program yet" message goes, since People and Setup each
// hold more than one body.
const FIRST_BODY = { overview: 'overviewBody', people: 'affiliatesBody', comms: 'outreachBody', share: 'shareBody', payouts: 'payoutsBody', program: 'programBody', records: 'recordsBody' };
const PANEL_RENDERERS = {
  overview: [renderOverview],
  people: [renderAffiliates, renderProspects, renderCustomers],
  comms: [renderOutreach],
  // What reps see in their portal has its own tab (Blake 2026-11-18: "bring
  // back the share tab").
  share: [renderShare],
  payouts: [renderPayoutsTab],
  program: [renderProgram],
  records: [renderRecords],
};

// What the search matches beyond this tab, read from what the page holds,
// so a person is never left thinking a name is nowhere. Only who somebody is
// counts here -- name, handle, email, code -- never a message body or a link.
const whoText = (...xs) => xs.filter((v) => v !== null && v !== undefined && v !== '').join(' ').toLowerCase();
// How many rows the open tab shows after the search.
const HIT_ROWS = '.af-q-row, .af-items > *, table.bcn-table tbody tr, .af-slist > .af-srow';
function renderFindHits() {
  const el = $('studioHits'); if (!el) return;
  const words = findWords(); const d = S.d;
  const x = $('studioQx'); if (x) x.hidden = !words.length;
  if (!words.length) { el.hidden = true; el.innerHTML = ''; return; }
  const codesOf = {};
  for (const c of d?.codes || []) (codesOf[c.affiliate_id] ||= []).push(c.code);
  const affWho = (a) => (a ? whoText(a.display_name, a.contact_email, a.handle, ...(codesOf[a.id] || [])) : '');
  const prosWho = (y) => (y ? whoText(y.display_name, y.handle, y.contact_email) : '');
  const n = {
    people: (d?.affiliates || []).filter((a) => textHits(affWho(a), words)).length + (d?.prospects || []).filter((y) => textHits(prosWho(y), words)).length,
    comms: (d?.drafts || []).filter((y) => textHits(whoText(y.recipient_email, y.recipient_handle, prosWho(d.prospectById?.[y.prospect_id])), words)).length,
    payouts: (d?.payouts || []).filter((y) => textHits(affWho(d.affById?.[y.affiliate_id]), words)).length,
  };
  const label = { people: 'People', comms: 'Outreach', payouts: 'Money' };
  const here = PANEL_OF[S.tab] || S.tab;
  const panel = document.querySelector(`[data-panel="${here}"]`);
  const hereN = panel ? panel.querySelectorAll(HIT_ROWS).length : 0;
  const chip = (txt, act, data, on = false) => `<button type="button" class="af-seg-btn${on ? ' is-on' : ''}"${act ? ` data-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}` : ' disabled'}>${esc(txt)}</button>`;
  const chips = [chip(`This tab · ${num(hereN)}`, null, {}, true),
    ...Object.keys(n).filter((k) => n[k] > 0 && k !== here).map((k) => chip(`${label[k]} · ${num(n[k])}`, 'go-tab', { t: k })),
    ...S.programs.filter((y) => textHits(whoText(y.name, y.slug), words)).map((y) => chip(`Program: ${y.name}`, 'pick-program', { id: y.id, t: 'program' }))];
  el.hidden = false;
  el.innerHTML = `<span class="af-find-q">“${esc(S.find.trim())}”</span><div class="af-seg" role="group" aria-label="Search results">${chips.join('')}</div>`;
}

function renderProgramPick(company) {
  const el = $('progPick'); if (!el) return;
  const list = S.programs;
  el.hidden = company || list.length < 2 || S.creating;
  if (el.hidden) { el.innerHTML = ''; return; }
  const opts = list;
  const on = (id) => (id === ALL ? isAll() : S.programId === id);
  el.innerHTML = `<span class="af-muted">Program</span><div class="af-seg" role="radiogroup" aria-label="Program">${opts.map((y) => `<button type="button" class="af-seg-btn${on(y.id) ? ' is-on' : ''}" role="radio" aria-checked="${on(y.id)}" data-act="pick-prog" data-id="${esc(y.id)}">${esc(y.name)}</button>`).join('')}</div>`;
}

function render() {
  const p = prog();
  const company = companyScope();
  const main = document.querySelector('.silo-main.af-studio');
  main?.classList.toggle('af-studio--ready', !!p || isAll() || company);
  main?.classList.toggle('af-studio--workflow', (!!p || company) && !['overview', 'program', 'records'].includes(S.tab));
  // No program filter at the top of the page (Blake 2026-11-24: "remove
  // that"). People is one company list. A tab that is about one program's
  // settings, numbers or money picks it inside the tab, with buttons. The
  // old dropdown stays in index.html, hidden there, so it never shows even
  // while the page is still loading.
  renderProgramPick(company);
  for (const s of document.querySelectorAll('[data-panel]')) s.hidden = s.dataset.panel !== S.tab;
  renderPeopleSubtabs();
  renderDialog();
  for (const b of document.querySelectorAll('#tabs [data-tab]')) {
    const on = PANEL_OF[b.dataset.tab] === S.tab;
    b.classList.toggle('bcn-tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  renderKpis();
  if (!company && isAll()) { renderAll(); return; }
  if (!p && !company && S.tab !== 'program') {
    const body = $(FIRST_BODY[S.tab] || 'overviewBody');
    if (body) body.innerHTML = card('Start here', `<p>No affiliate program exists for this company yet.</p>${MANAGE ? btn('Create a program', 'new-program', {}, 'primary') : '<p class="af-muted">Ask someone with Affiliate Studio access to create one.</p>'}`);
    return;
  }
  for (const r of (PANEL_RENDERERS[S.tab] || PANEL_RENDERERS.overview)) r();
  const panel = document.querySelector(`[data-panel="${PANEL_OF[S.tab] || 'overview'}"]`);
  const first = $(FIRST_BODY[PANEL_OF[S.tab]] || '');
  if (panel && first && ![...panel.querySelectorAll('.af-stack, .af-ov')].some((el) => el.innerHTML.trim())) first.innerHTML = findEmpty('Nothing waiting here.');
  renderFindHits();
  renderWorkflowTabCounts();
}

// People holds two jobs: the affiliates in the programme, and discovery --
// the creators who are not in it yet. One sub-tab each (Blake 2026-11-20), so
// neither list has to be scrolled past to reach the other.
function renderPeopleSubtabs() {
  const bar = $('peopleSubtabs');
  if (!bar) return;
  const sub = ['discovery', 'customers'].includes(S.peopleSub) ? S.peopleSub : 'affiliates';
  bar.hidden = false;
  for (const b of bar.querySelectorAll('[data-k]')) {
    const on = b.dataset.k === sub;
    b.classList.toggle('bcn-tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const aff = $('affiliatesBody'); const pros = $('prospectsBody'); const cust = $('customersBody');
  if (aff) aff.hidden = sub !== 'affiliates';
  if (pros) pros.hidden = sub !== 'discovery';
  if (cust) cust.hidden = sub !== 'customers';
}


// ── Your Customers ────────────────────────────────────────────────────────
// Blake, 2026-11-24: the repeat buyers to recruit from, as the third People
// sub-tab rather than a report of its own ("if the data is there, literally
// what are we waiting for ha?").
//
// LAZY, and that is the point: the read only happens once somebody opens the
// sub-tab, so People stays exactly as fast as it was for everybody who never
// looks at it. `S.cust` is null until then.
//
// FAIL SOFT. A company whose stores have no `read_customers` scope, or whose
// customer sync has not run, still has order history -- so the list and the
// counts work and only the consent column is blank. If the read itself fails
// (an older database without the consent columns, say) the tab says so and
// nothing else on People is affected.
const CUST_DEFAULTS = () => ({
  from: dayShift(today(), 365), to: today(), minOrders: 3, consent: 'any',
  sort: 'orders', page: 0,
  rows: [], total: null, kpi: null, loading: false, error: '', loaded: false,
  // Ticks are kept by customer_key, and a tick on a row that left the view is
  // dropped when the view reloads -- the same stance as the prospect list.
  sel: new Set(),
  // "Find their social accounts": the COMPANY's result row per customer on
  // the page (the same in every program -- Blake 2026-11-24, people come
  // before program), and the company's latest scan. scanReady is false until the tables exist
  // (a database before the migration), which hides the scan bar.
  social: {}, scan: null, scanReady: false, scanCount: 25, scanTerms: null, socialOnly: false,
  // Which view: 'hunt' (the scan and the finds it brought back, the landing
  // view) or 'all' (every customer, tagged). huntTier picks which finds.
  view: 'hunt', huntTier: 'top', hunt: null,
});
// Which of the Your Customers filters are not the ones the page opens with:
// the count on the Filter button, so an untouched view says "Filter" rather
// than "Filter · 3" for its own defaults.
const custFiltersOn = (c, spec) => {
  const dflt = { from: dayShift(today(), 365), to: today(), minOrders: 3, consent: 'any' };
  return [
    spec.from && spec.from !== dflt.from ? 'from' : '',
    spec.to && spec.to !== dflt.to ? 'to' : '',
    spec.minOrders !== dflt.minOrders ? 'minOrders' : '',
    spec.consent !== dflt.consent ? 'consent' : '',
    c.socialOnly ? 'social' : '',
  ].filter(Boolean);
};
const custState = () => (S.cust ||= CUST_DEFAULTS());
const SOCIAL_COLS = 'id, customer_key, status, match_basis, match_score, platform, handle, profile_url, followers, followers_approx, followers_quote, source_url, checked_at';
// The decision on each find (review: shortlisted / not_fit / suppressed,
// 20261125210000). Probed once: before that migration the column is not
// there, and the page keeps working exactly as before, with no Shortlisted
// or Archive tab.
let custReview = null;
async function reviewReady() {
  if (custReview === null) {
    try {
      const r = await db.from('affiliate_customer_social').select('review').eq('company_entity_id', CO).limit(1);
      custReview = !r.error;
    } catch (_) { custReview = false; }
  }
  return custReview;
}
const socialCols = () => (custReview ? `${SOCIAL_COLS}, review` : SOCIAL_COLS);
const SCAN_COLS = 'id, status, requested, checked, found, below, no_count, ambiguous, not_found, failed, min_followers, filters, error_message, started_at, heartbeat_at, finished_at';
// The scan row and the page's result rows, read together. Fail-soft: either
// read failing leaves the list as it was and hides only the scan bar.
let scanTimer = null;
async function loadSocial(c, keys) {
  await reviewReady();
  const [scan, soc] = await Promise.all([
    db.from('affiliate_customer_scans').select(SCAN_COLS).eq('company_entity_id', CO)
      .order('started_at', { ascending: false }).limit(1),
    keys.length
      ? db.from('affiliate_customer_social').select(socialCols()).eq('company_entity_id', CO).in('customer_key', keys)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (scan.error || soc.error) { c.scanReady = false; c.scan = null; c.social = {}; return; }
  c.scanReady = true;
  c.scan = liveScan(scan.data?.[0]);
  c.social = Object.fromEntries((soc.data || []).map((r) => [r.customer_key, r]));
}
// Hunt: the scan and the people it brought back, not the whole customer list
// with tags (Blake 2026-11-24: "show more of a module ... visual loading and
// hunting the queue ... then bring back the found opportunity rather than
// show all customers and tag possible"). Every find of the company's, best
// first: over the bar, or under it / no count stated. Everyone found is
// listed whatever their consent (Blake 2026-11-24); the consent tag decides
// how they are reached (customerContactPath). Only an erased customer drops
// out, as they would from a scan.
// Over the bar splits by the match score: Likely (LIKELY_SCORE and up, or an
// unscored older row with a second signal) or Check (everything else over the
// bar). Only Likely counts toward the finds asked for.
// Shortlisted and Archive (Blake 2026-11-25: "an archive style tab - so
// lists don't just grow on working queues") hold the finds already decided:
// added to a program, or Not a fit / Not them / Do not contact. The three
// working tabs hold only the undecided.
const HUNT_TIERS = { top: ['found'], check: ['found'], more: ['below', 'no_count'], shortlisted: [], archive: [] };
const HUNT_DONE = ['shortlisted', 'archive'];
function huntTier(q, tier) {
  const t = HUNT_TIERS[tier] && (custReview || !HUNT_DONE.includes(tier)) ? tier : 'top';
  if (t === 'shortlisted') return q.eq('review', 'shortlisted').neq('status', 'rejected');
  if (t === 'archive') return q.or('status.eq.rejected,review.eq.not_fit,review.eq.suppressed');
  q = q.in('status', HUNT_TIERS[t]);
  if (custReview) q = q.is('review', null);
  if (t === 'top') return q.gte('match_score', LIKELY_SCORE);
  // Unscored (older) rows are Check too, as the scan counts them.
  if (t === 'check') return q.or(`match_score.is.null,match_score.lt.${LIKELY_SCORE}`);
  return q;
}
const HUNT_LIMIT = 200;
const HUNT_NEVER = ['redacted'];
const HUNT_SEEN = ['found', 'below', 'no_count', 'ambiguous', 'none', 'error'];
// The over-the-bar answers whose customer the list hides (erased since
// their search). Every page of them, as the tab counts count every row.
async function huntHidden() {
  // Keyset pages (id after the last one seen), so an answer a running scan
  // writes between two reads never repeats one; de-duplicated all the same.
  const byId = new Map();
  for (let after = null; ;) {
    let q = db.from('affiliate_customer_social').select(custReview ? 'id, customer_key, status, match_score, review' : 'id, customer_key, status, match_score')
      .eq('company_entity_id', CO).in('status', ['found', 'below', 'no_count']);
    if (after !== null) q = q.gt('id', after);
    const { data: page, error } = await q.order('id', { ascending: true }).limit(1000);
    if (error) throw error;
    for (const r of page || []) byId.set(r.id, r);
    if (!page || page.length < 1000) break;
    after = page[page.length - 1].id;
  }
  const rows = [...byId.values()];
  const out = [];
  for (let i = 0; i < rows.length; i += 150) {
    const part = rows.slice(i, i + 150);
    const { data: p, error: pErr } = await db.from('company_customer_profiles').select('customer_key')
      .eq('company_entity_id', CO).in('customer_key', part.map((r) => r.customer_key)).in('email_consent_state', HUNT_NEVER);
    if (pErr) throw pErr;
    const gone = new Set((p || []).map((r) => r.customer_key));
    for (const r of part) if (gone.has(r.customer_key)) out.push(r);
  }
  return out;
}
// Reads only; returns null when the scan tables are not there yet (a
// database before the migration), so the caller falls back to the full list.
async function readHunt(tier) {
  await reviewReady();
  const finds = (t) => huntTier(db.from('affiliate_customer_social').select('customer_key', { count: 'exact', head: true })
    .eq('company_entity_id', CO), t);
  const none = Promise.resolve({ count: null, error: null });
  const [scan, top, check, more, listed, archived, hits] = await Promise.all([
    db.from('affiliate_customer_scans').select(SCAN_COLS).eq('company_entity_id', CO)
      .order('started_at', { ascending: false }).limit(1),
    finds('top'),
    finds('check'),
    finds('more'),
    custReview ? finds('shortlisted') : none,
    custReview ? finds('archive') : none,
    // Likely finds most-sure first; the rest biggest first.
    huntTier(db.from('affiliate_customer_social').select(socialCols()).eq('company_entity_id', CO), tier)
      .order(tier === 'top' ? 'match_score' : 'followers', { ascending: false, nullsFirst: false })
      .order('followers', { ascending: false, nullsFirst: false }).order('checked_at', { ascending: false }).limit(HUNT_LIMIT),
  ]);
  if (scan.error || hits.error) return null;
  const sc = liveScan(scan.data?.[0]);
  // The last few people checked, so a running hunt visibly moves.
  let recent = [];
  if (sc?.status === 'running') {
    const r = await db.from('affiliate_customer_social').select('display_name, status, checked_at')
      .eq('company_entity_id', CO).eq('scan_id', sc.id).in('status', HUNT_SEEN)
      .order('checked_at', { ascending: false }).limit(5);
    recent = r.error ? [] : (r.data || []);
  }
  const keys = (hits.data || []).map((r) => r.customer_key);
  let rows = [];
  if (keys.length) {
    const p = await db.from('company_customer_profiles').select(CUST_COLS).eq('company_entity_id', CO)
      .in('customer_key', keys)
      .or(`email_consent_state.is.null,email_consent_state.not.in.(${HUNT_NEVER.join(',')})`);
    if (p.error) throw p.error;
    const at = new Map(keys.map((k, i) => [k, i]));
    rows = (p.data || []).sort((a, b) => at.get(a.customer_key) - at.get(b.customer_key));
  }
  // The list never shows a customer erased since their search, so
  // neither do the tab counts. A failed read leaves the stored counts.
  let hidden = [];
  try { hidden = await huntHidden(); } catch (_) { hidden = []; }
  return {
    scan: sc, rows, recent,
    social: Object.fromEntries((hits.data || []).map((r) => [r.customer_key, r])),
    // NULL means the count did not come back, never zero.
    counts: huntCounts({ top: top.count ?? null, check: check.count ?? null, more: more.count ?? null, shortlisted: listed.count ?? null, archive: archived.count ?? null }, hidden),
  };
}
// One decision on many finds (affiliate_customer_social_review), in parts
// the function accepts. Returns how many rows changed.
async function markCustomers(keys, review) {
  let n = 0;
  for (const part of chunk(keys, 500)) n += Number(must(await db.rpc('affiliate_customer_social_review', { p_keys: part, p_review: review })) || 0);
  return n;
}
function applyHunt(c, h) {
  c.scanReady = true; c.scan = h.scan; c.social = h.social; c.rows = h.rows; c.total = h.rows.length; c.hunt = h;
  const inView = new Set(c.rows.map((x) => x.customer_key));
  for (const k of [...c.sel]) if (!inView.has(k)) c.sel.delete(k);
}

// While a scan runs, its progress and the rows it answers refresh every few
// seconds, so nobody presses again wondering whether it is working.
function pollScan() {
  clearTimeout(scanTimer);
  const c = custState();
  if (c.scan?.status !== 'running' || S.peopleSub !== 'customers') return;
  scanTimer = setTimeout(async () => {
    const cc = custState();
    try {
      if (cc.view === 'hunt') {
        // A filter or tier change while this read was out owns the view.
        const seq = custSeq;
        const h = await readHunt(cc.huntTier);
        if (h && seq === custSeq && cc.view === 'hunt') applyHunt(cc, h);
      } else await loadSocial(cc, cc.rows.map((x) => x.customer_key));
    } catch (_) { /* next tick tries again */ }
    renderCustomers();
    pollScan();
  }, 4000);
}
const CUST_COLS = 'customer_key, name_lc, email_lc, order_count, first_order_at, last_order_at, lifetime_spend, email_consent_state, sms_consent_state, consent_checked_at';
const custMoney = (v) => (v === null || v === undefined
  ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: prog()?.currency || 'USD', maximumFractionDigits: 0 }));

// The headline counts. Separate head-only counts rather than one aggregate,
// because PostgREST cannot aggregate and a count is an index-free scan either
// way; they run together, so the tab waits for one round trip, not four.
async function custCounts(spec) {
  const base = () => {
    let q = db.from('company_customer_profiles').select('customer_key', { count: 'exact', head: true })
      .eq('company_entity_id', CO);
    if (spec.from) q = q.gte('last_order_at', spec.from);
    if (spec.toExclusive) q = q.lt('last_order_at', spec.toExclusive);
    return q;
  };
  const [all, two, three, subbed] = await Promise.all([
    base().gte('order_count', 1),
    base().gte('order_count', 2),
    base().gte('order_count', 3),
    base().gte('order_count', 1).eq('email_consent_state', 'subscribed'),
  ]);
  return {
    customers: all.count ?? null,
    repeat: two.count ?? null,
    loyal: three.count ?? null,
    // NULL means the count did not come back, never zero subscribers.
    subscribed: subbed.count ?? null,
  };
}

// Which read owns the view. A filter change while a read is in flight must
// NOT be dropped: dropping it leaves the old rows on screen under the new
// filter, so customers outside the chosen segment stay tickable. And an older
// read must not land on top of a newer one. So every read takes a ticket, a
// newer read supersedes it, and a superseded read discards its own results
// and leaves the view to the read that now owns it.
let custSeq = 0;
async function loadCustomers(force = false) {
  const c = custState();
  if (c.loaded && !force) return;
  // The lazy first read never stacks; a filter or page change always counts.
  if (c.loading && !force) return;
  const seq = ++custSeq;
  const mine = () => seq === custSeq;
  c.loading = true; c.error = ''; renderCustomers();
  const spec = customerQuerySpec(c);
  try {
    if (c.view === 'hunt') {
      // The company's own niche words, once, for the box beside Find.
      if (c.scanTerms === null && MANAGE) {
        // A failed read stays null: the press then sends no words at all.
        let got = null;
        try { got = scanTermsFromRead(await db.from('entities').select('meta').eq('id', CO).maybeSingle()); } catch (_) { got = null; }
        if (c.scanTerms === null) c.scanTerms = got;
      }
      const h = await readHunt(c.huntTier);
      if (!mine()) return;
      if (h) { applyHunt(c, h); c.loaded = true; return; }
      // No scan tables yet: the plain list, with no Hunt to offer.
      c.view = 'all';
    }
    let q = db.from('company_customer_profiles').select(CUST_COLS, { count: 'exact' })
      .eq('company_entity_id', CO)
      .gte('order_count', spec.minOrders);
    if (spec.from) q = q.gte('last_order_at', spec.from);
    if (spec.toExclusive) q = q.lt('last_order_at', spec.toExclusive);
    if (spec.consentIsNull) q = q.is('email_consent_state', null);
    else if (spec.consentState) q = q.eq('email_consent_state', spec.consentState);
    // "Found accounts only": every customer a scan matched to an account --
    // over the bar, under it, or with no count stated -- the same people the
    // list marks with one (Blake, 2026-11-24: the filter showed fewer than the
    // list did). A pilot finds tens, so one bounded list of keys is enough.
    if (c.socialOnly) {
      const { data: hit, error: hErr } = await db.from('affiliate_customer_social').select('customer_key')
        .eq('company_entity_id', CO).in('status', ['found', 'below', 'no_count'])
        .order('followers', { ascending: false }).limit(500);
      if (hErr) throw hErr;
      q = q.in('customer_key', (hit || []).map((r) => r.customer_key).concat(['~none~']));
    }
    for (const o of spec.order) q = q.order(o.column, { ascending: o.ascending, nullsFirst: false });
    const { data, error, count } = await q.range(spec.range[0], spec.range[1]);
    if (error) throw error;
    if (!mine()) return;
    c.rows = data || [];
    c.total = count ?? null;
    {
      const inView = new Set(c.rows.map((x) => x.customer_key));
      for (const k of [...c.sel]) if (!inView.has(k)) c.sel.delete(k);
    }
    // The counts describe the date window, not the current filters, so the
    // "2+ orders" tile does not change when you filter TO 2+ orders.
    const kpi = await custCounts(spec).catch(() => null);
    if (!mine()) return;
    c.kpi = kpi;
    await loadSocial(c, c.rows.map((x) => x.customer_key)).catch(() => { c.scanReady = false; });
    if (!mine()) return;
    c.loaded = true;
  } catch (e) {
    if (!mine()) return;
    c.rows = []; c.total = null; c.kpi = null; c.loaded = true;
    c.error = friendly(e);
  } finally {
    if (mine()) {
      c.loading = false;
      renderCustomers();
      pollScan();
    }
  }
}

// Customers are the company's. Which programs one is already in, by their
// address, and one Add button per program to push the ticked ones into.
// The address map is built once per load of the prospects, not per row.
let progsByEmail = { rows: null, map: new Map() };
function customerProgramsPill(x) {
  const e = String(x?.email_lc || '').toLowerCase();
  const rows = S.d?.prospects;
  if (!e || !rows) return '';
  if (progsByEmail.rows !== rows) {
    const map = new Map();
    for (const y of rows) {
      const k = String(y.contact_email || '').toLowerCase();
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      if (!map.get(k).includes(y.program_id)) map.get(k).push(y.program_id);
    }
    progsByEmail = { rows, map };
  }
  const all = progsByEmail.map.get(e) || [];
  const open = all.filter((id) => S.programs.find((y) => y.id === id)?.status !== 'closed');
  const ids = open.length ? open : all;
  return ids.length ? ` ${pill(`In ${ids.map(progName).join(', ')}`, '')}` : '';
}
// One bulk bar for every customer list (Blake 2026-11-25: "shouldn't all
// customers bulk actions be same as find creators, or discovery"): Shortlist,
// Add to program, Not a fit, Not them, Do not contact. Archive offers Restore.
function custBulkBar(c, tier) {
  const n = c.sel.size;
  if (!MANAGE || !n) return '';
  const acts = tier === 'archive'
    ? `${btn('Restore', 'cust-review', { s: '' }, 'primary', { title: 'Back to the working lists. Only Not a fit can be restored here; Do not contact is undone on the do-not-contact list.' })}`
    : `${tier === 'shortlisted' ? custAddButtons('add') : custAddButtons()}${custReview ? btn('Not a fit', 'cust-review', { s: 'not_fit' }) : ''}${btn('Not them', 'cust-bulk-notthem', {}, 'surface', { title: 'The account found is somebody else. They are not searched again.' })}${btn('Do not contact', 'cust-dnc', {}, 'surface', { confirm: true })}`;
  return `<div class="af-row af-bulk"><span class="af-mono">${num(n)} selected</span>${acts}${btn('Clear', 'cust-select-none')}</div>`;
}
// Shortlist puts the ticked finds into a program's outreach (a prospect row
// and a drafted message), as Shortlist does on Discovery. With several open
// programs it is Shortlist into the first and Add to each of the others.
// `mode` 'add' (on Shortlisted) offers only the Add to buttons.
function custAddButtons(mode = '') {
  const list = openPrograms();
  if (!list.length) return '';
  const first = mode === 'add' ? [] : [btn('Shortlist', 'cust-add', { pg: list[0].id }, 'primary', { title: `Adds them to ${list[0].name} and drafts their message` })];
  const rest = (mode === 'add' ? list : list.slice(1)).map((y) => btn(`Add to ${y.name}`, 'cust-add', { pg: y.id }));
  return [...first, ...(list.length > 1 || mode === 'add' ? rest : [])].join('');
}
// The Hunt view: the slice to hunt, a live module while it runs, then only
// the people it brought back.
function huntBody({ c, spec, filters, running, socialCell, consentCell, pickable, noPath }) {
  const s = c.scan;
  const n0 = (v) => Number(v || 0);
  const { want, pct } = huntProgress(s);
  const chk = n0(s?.checked);
  const toCheck = n0(s?.filters?.to_check);
  const matched = n0(s?.found) + toCheck + n0(s?.below) + n0(s?.no_count);
  const bar = num(s?.min_followers || 750);
  const tile = (label, v) => `<div class="bcn-kpi"><div class="bcn-kpi-label">${esc(label)}</div><div class="bcn-kpi-value bcn-num">${v}</div></div>`;
  const press = MANAGE
    ? `<div class="af-row af-cust-scan">
        ${field(`Finds wanted (${bar}+ followers)`, input('custScanCount', `type="number" min="1" max="500" value="${esc(String(c.scanCount))}" style="max-width:6rem"`))}
        ${field('Niche words', input('custScanTerms', `type="text" maxlength="500" placeholder="baseball, softball" value="${esc(c.scanTerms || '')}" style="max-width:16rem"`))}
        ${btn(running ? 'Finding…' : 'Find', 'cust-scan', {}, 'primary', { disabled: running })}
        <span class="af-mono" id="custScanLine">${esc(running ? '' : huntLine(s))}</span>
      </div>`
    : `<div class="af-row af-cust-scan"><span class="af-mono" id="custScanLine">${esc(running ? '' : huntLine(s))}</span></div>`;
  // While it runs: a bar that fills, counts that tick, the last names checked.
  const live = running
    ? `<div class="af-hunt-live" id="custHuntLive" role="status" aria-live="polite">
        <div class="af-hunt-head"><strong>Searching your customers</strong><span class="af-mono">${s?.requested || chk ? huntLine(s) : 'Lining up customers…'}</span></div>
        <div class="af-pay-meter af-hunt-meter"><i style="width:${pct}%"></i></div>
        <div class="af-hunt-tiles">${tile(want ? `Found of ${num(want)}` : `${bar}+ followers`, num(s?.found))}${tile('Checked', num(chk))}${tile('Accounts matched', num(matched))}${tile('To check', num(toCheck))}</div>
        ${c.hunt?.recent?.length ? `<div class="af-muted af-hunt-recent">Just checked: ${c.hunt.recent.map((r) => esc(r.display_name || 'a customer')).join(' · ')}</div>` : ''}
      </div>`
    : '';
  const counts = c.hunt?.counts || {};
  const tierList = [['top', `Likely · ${bar}+`, counts.top], ['check', `Check · ${bar}+`, counts.check], ['more', 'Under the bar', counts.more]];
  if (custReview) tierList.push(['shortlisted', 'Shortlisted', counts.shortlisted], ['archive', 'Archive', counts.archive]);
  const tiers = subtabs('Finds', tierList, 'cust-hunt-tier', c.huntTier);
  // Sort by a column header, as on Discovery: numbers biggest first, words A to Z.
  const SORT = {
    customer: (x) => (customerDisplayName(x) || x.email_lc || '').toLowerCase(),
    match: (x) => { const r = c.social[x.customer_key]; return r?.match_score ?? -1; },
    followers: (x) => Number(c.social[x.customer_key]?.followers ?? -1),
    orders: (x) => Number(x.order_count || 0),
    spend: (x) => Number(x.lifetime_spend || 0),
    last: (x) => String(x.last_order_at || ''),
  };
  const hs = c.hSort;
  const shown = hs && SORT[hs.k]
    ? [...c.rows].sort((a, b) => { const x = SORT[hs.k](a); const y = SORT[hs.k](b); return (x < y ? -1 : x > y ? 1 : 0) * hs.dir; })
    : c.rows;
  const allPicked = MANAGE && !!shown.length && shown.every((x) => c.sel.has(x.customer_key));
  const list = table([
    // Every find can be ticked: Not a fit, Not them and Do not contact need
    // no way to reach them. Adding to a program still skips anyone it cannot
    // reach, and says how many.
    ...(MANAGE ? [{ hHtml: allPicked
      ? '<input type="checkbox" class="af-pick" data-act="cust-select-none" aria-label="Clear selection" checked />'
      : `<input type="checkbox" class="af-pick" data-act="cust-select-all" data-all="1" aria-label="Select all ${num(shown.length)}" />`,
    h: '', f: (x) => `<input type="checkbox" class="af-pick" data-act="cust-pick" data-k="${esc(x.customer_key)}" aria-label="Select ${esc(customerDisplayName(x) || x.email_lc)}"${c.sel.has(x.customer_key) ? ' checked' : ''} />` }] : []),
    { left: true, h: 'Customer', sort: 'customer', f: (x) => `${esc(customerDisplayName(x) || '—')}${customerProgramsPill(x)}<div class="af-muted">${esc([x.email_lc, noPath(x)].filter(Boolean).join(' · ') || '—')}</div>` },
    { left: true, h: 'Account', sort: 'match', f: socialCell },
    // Everyone found is listed; this tag decides email or DM.
    { left: true, h: 'Status', f: consentCell },
    { num: true, h: 'Orders', sort: 'orders', f: (x) => num(x.order_count) },
    { num: true, h: 'Lifetime spend', sort: 'spend', f: (x) => custMoney(x.lifetime_spend) },
    { h: 'Last order', sort: 'last', f: (x) => fmtDate(x.last_order_at) },
  ], shown, c.loading ? 'Loading…' : (c.huntTier === 'top'
    ? (running ? 'Nobody over the bar yet. Finds appear here as they come back.' : 'Nobody over the bar yet. Press Find to check more customers.')
    : c.huntTier === 'archive' ? 'Nothing archived. Not a fit, Not them and Do not contact land here.'
      : c.huntTier === 'shortlisted' ? 'Nobody shortlisted yet. Tick finds and press Shortlist.' : 'Nobody here yet.'), { act: 'cust-hsort', k: hs?.k || '', dir: hs?.dir || -1 });
  const bulk = custBulkBar(c, c.huntTier);
  const more = c.total != null && (counts[c.huntTier] ?? counts.top) > c.total
    ? `<p class="af-muted">Showing the top ${num(c.total)}.</p>` : '';
  return `${c.error ? `<div class="bcn-status bcn-status--neg">${esc(c.error)}</div>` : ''}
    <p class="af-muted">Checks your repeat buyers for social accounts, best customers first, and brings back the ones worth a look.</p>
    ${filters}
    ${press}
    ${live}
    ${tiers}
    ${bulk}
    ${list}
    ${more}`;
}

function renderCustomers() {
  const body = $('customersBody');
  if (!body) return;
  const c = custState();
  // Opening the sub-tab is what triggers the first read -- from here rather
  // than from the sub-tab button, so arriving by any route loads it once.
  if (S.peopleSub === 'customers' && !c.loaded && !c.loading) queueMicrotask(() => loadCustomers());
  const spec = customerQuerySpec(c);
  const sorts = [['orders', 'Most orders'], ['spend', 'Highest spend'], ['recent', 'Ordered most recently'], ['oldest', 'Longest-standing'], ['name', 'Name']];
  const consentLabel = { any: 'Any', subscribed: 'Subscribed', not_subscribed: 'Not subscribed', unsubscribed: 'Unsubscribed', pending: 'Pending', unmeasured: 'Not checked yet' };
  const k = c.kpi;
  const kpis = [
    ['Customers', num(k?.customers)],
    ['2+ orders', num(k?.repeat)],
    ['3+ orders', num(k?.loyal)],
    ['Email subscribed', num(k?.subscribed)],
  ];
  const filters = `<div class="af-cust-filters">
    <p class="af-muted">The dates pick customers by their most recent order; lifetime spend is their whole history, not just the window.</p>
    ${field('Last order from', input('custFrom', `type="date" value="${esc(c.from)}"`))}
    ${field('Through', input('custTo', `type="date" value="${esc(c.to)}"`))}
    ${field('Minimum orders', input('custMin', `type="number" min="1" max="50" value="${esc(String(spec.minOrders))}" style="max-width:5.5rem"`))}
    ${field('Email consent', `<select class="bcn-field" id="custConsent">${CUSTOMER_CONSENTS.map((x) => `<option value="${x}"${x === spec.consent ? ' selected' : ''}>${esc(consentLabel[x] || x)}</option>`).join('')}</select>`)}
    ${c.scanReady && c.view !== 'hunt' ? field('Social', `<select class="bcn-field" id="custSocial"><option value="any"${c.socialOnly ? '' : ' selected'}>Anyone</option><option value="found"${c.socialOnly ? ' selected' : ''}>Found accounts only</option></select>`) : ''}
  </div>`;
  // Find their social accounts: one search per customer, top of this view
  // first. Progress is live counts, never a cost.
  const running = c.scan?.status === 'running';
  const scanBar = c.scanReady && (MANAGE || c.scan)
    ? `<div class="af-row af-cust-scan">
        <span class="af-mono" id="custScanLine">${esc(running ? customerScanLine(c.scan) : huntLine(c.scan))}</span>
      </div>`
    : '';
  const socialCell = (row) => {
    const v = customerSocialView(c.social[row.customer_key]);
    const text = v.url
      ? `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.label)}</a>`
      : `<span class="af-muted">${esc(v.label)}</span>`;
    const r = c.social[row.customer_key];
    // The tier and why, on every find a profile was chosen for: "Likely" only
    // with a second signal, otherwise "Name match" to check by eye.
    const tierPill = v.trust ? `<span class="bcn-pill bcn-pill--${v.trust === 'likely' ? 'pos' : 'warn'} af-score-pill" title="${esc(v.tip || v.why || '')}">${esc(v.pill)}</span> ` : '';
    const title = [v.why, v.quote].filter(Boolean).join(' · ');
    // A red x on the match (Blake 2026-11-25); the hover says what it does.
    const notThem = MANAGE && v.rejectable && r?.id ? ` ${btn('✕', 'cust-social-reject', { id: r.id }, 'ghost', { title: 'Not them: remove this match. They are not searched again.', cls: 'af-x-btn' })}` : '';
    return `${tierPill}<span class="af-mono"${title ? ` title="${esc(title)}"` : ''}>${text}</span>${v.note ? ` <span class="af-muted">${esc(v.note)}</span>` : ''}${notThem}`;
  };
  const consentCell = (row) => {
    const v = customerConsentView(row.email_consent_state);
    const s = customerConsentView(row.sms_consent_state);
    // The tag decides the contact path: an unsubscribed customer is reached
    // by DM only, never email.
    const dmOnly = row.email_consent_state === 'unsubscribed' ? ' <span class="af-muted">DM only</span>' : '';
    return `${pill(v.label, v.tone)}${dmOnly}${s.measured ? ` <span class="af-muted">SMS ${esc(s.label)}</span>` : ''}`;
  };
  // A customer with no way to reach them (no email, unsubscribed with no
  // account found, do-not-contact) has nothing to tick: the row still shows
  // (they are a real customer and count towards the totals) and says why
  // instead of offering an action that would fail.
  const pickable = (x) => MANAGE && !!customerContactPath(x, c.social[x.customer_key], S.d?.suppressions || []);
  const noPath = (x) => customerNoPathReason(x, c.social[x.customer_key], S.d?.suppressions || []);
  // As on Find creators: Select all is the header box and the bar is the
  // same. Here somebody SILO cannot reach (no email and no account found, or
  // on the do-not-contact list) still has no tick box, and the row says why.
  const onPage = c.rows.filter((x) => pickable(x));
  const allTicked = MANAGE && !!onPage.length && onPage.every((x) => c.sel.has(x.customer_key));
  const rows = table([
    ...(MANAGE ? [{ hHtml: !onPage.length ? '' : allTicked
      ? '<input type="checkbox" class="af-pick" data-act="cust-select-none" aria-label="Clear selection" checked />'
      : `<input type="checkbox" class="af-pick" data-act="cust-select-all" aria-label="Select all ${num(onPage.length)} on this page" />`,
    h: '', f: (x) => (pickable(x)
      ? `<input type="checkbox" class="af-pick" data-act="cust-pick" data-k="${esc(x.customer_key)}" aria-label="Select ${esc(customerDisplayName(x) || x.email_lc)}"${c.sel.has(x.customer_key) ? ' checked' : ''} />`
      : '') }] : []),
    { left: true, h: 'Customer', f: (x) => `${esc(customerDisplayName(x) || '—')}${customerProgramsPill(x)}<div class="af-muted">${esc([x.email_lc, noPath(x)].filter(Boolean).join(' · ') || '—')}</div>` },
    { num: true, h: 'Orders', f: (x) => num(x.order_count) },
    { num: true, h: 'Lifetime spend', f: (x) => custMoney(x.lifetime_spend) },
    { h: 'First order', f: (x) => fmtDate(x.first_order_at) },
    { h: 'Last order', f: (x) => fmtDate(x.last_order_at) },
    { left: true, h: 'Email consent', f: consentCell },
    ...(c.scanReady ? [{ left: true, h: 'Social', f: socialCell }] : []),
  ], c.rows, c.loading ? 'Loading…' : 'Nobody matches these filters.');
  // Add to outreach: one press writes a prospect and a draft for each ticked
  // customer, and the drafts wait on Outreach exactly like a creator's would
  // (Blake 2026-11-24: "no matter where they lead from discovery or customer
  // routes").
  const bulk = custBulkBar(c, 'all');
  const pages = c.total === null ? null : Math.max(1, Math.ceil(c.total / CUSTOMER_PAGE_SIZE));
  const foot = pages && pages > 1
    ? `<div class="af-list-foot af-cust-pager">
        ${btn('Previous', 'cust-page', { p: String(spec.page - 1) }, 'surface', { disabled: spec.page <= 0 })}
        <span class="af-mono">Page ${num(spec.page + 1)} of ${num(pages)}</span>
        ${btn('Next', 'cust-page', { p: String(spec.page + 1) }, 'surface', { disabled: spec.page + 1 >= pages })}
      </div>`
    : '';
  // Consent arrives from the Shopify customer sync and lands per store, so a
  // company part-way through its first pull sees real counts and blank
  // consent. Saying so beats a column of blanks that reads as opted out.
  const notChecked = c.rows.length && c.rows.every((x) => x.email_consent_state === null)
    ? `<p class="af-muted">Email consent has not been checked for anyone in this view yet. It fills in from the Shopify customer sync, and a blank never means unsubscribed.</p>`
    : '';
  // One control row (audit finding 1): how the list is ranked stays in sight,
  // the rest of the filters open under a Filter button that carries how many
  // are on, so nothing narrows this list invisibly.
  const custFiltCount = custFiltersOn(c, spec).length;
  const custFiltOpen = S.custFiltOpen === undefined ? custFiltCount > 0 : !!S.custFiltOpen;
  const custCtlRow = `<div class="af-ctl">
    ${field('Rank by', `<select class="bcn-field" id="custSort">${sorts.map(([v, label]) => `<option value="${v}"${v === spec.sort ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`)}
    <span class="af-ctl-gap"></span>
    ${btn(custFiltCount ? `Filter · ${custFiltCount}` : 'Filter', 'cust-filter-open', {}, custFiltOpen ? 'primary' : 'surface')}
  </div>${custFiltOpen ? `<div class="af-panelette">${filters}</div>` : ''}`;
  // Re-rendering replaces the filter row, which would drop the caret out of
  // whichever box was just used. The focus (and the caret inside a text box)
  // is put back on the same control afterwards.
  const act = document.activeElement;
  const keepId = act && body.contains(act) ? act.id : '';
  const keepAt = keepId && typeof act.selectionStart === 'number' ? act.selectionStart : null;
  // Hunt or every customer. Only once the scan tables exist; before that the
  // list is all there is.
  const views = c.scanReady
    ? subtabs('Your customers view', [['hunt', 'Find creators'], ['all', 'All customers']], 'cust-view', c.view)
    : '';
  const hunting = c.view === 'hunt' && c.scanReady;
  if (hunting) body.innerHTML = surface('Your customers', `${views}${huntBody({ c, spec, filters, running, socialCell, consentCell, pickable, noPath })}`,
    c.hunt?.counts?.top == null ? '' : `${num(c.hunt.counts.top)} over the bar`, 'afCustomers', '', shopifyMark('af-head-mark'));
  else body.innerHTML = surface('Your customers',
    `${views}
     ${c.error ? `<div class="bcn-status bcn-status--neg">${esc(c.error)}</div>` : ''}
     ${custCtlRow}
     ${scanBar}
     <div class="af-kv-line af-cust-kpis">${kpis.map(([label, v]) => `<span><span class="bcn-num">${v}</span> ${esc(label)}</span>`).join(' · ')}</div>
     ${notChecked}
     ${bulk}
     ${rows}
     ${foot}`,
    c.total === null ? '' : `${num(c.total)} match these filters`, 'afCustomers', '', shopifyMark('af-head-mark'));
  if (keepId) {
    const back = $(keepId);
    if (back) {
      back.focus();
      // A date or number box refuses a caret position; its value is already
      // restored by the render, so there is nothing else to put back.
      if (keepAt !== null) { try { back.setSelectionRange(keepAt, keepAt); } catch { /* not a text box */ } }
    }
  }
}

// ── Dialogs ──────────────────────────────────────────────────────────────
// Adding or editing someone happens in the middle of the screen (Blake
// 2026-11-20: "center pop up not hidden top of page edit"). The forms keep
// the field ids they had inline, so every save action is unchanged; only
// where they are drawn moved.
const PLATS = ['instagram', 'tiktok', 'youtube', 'twitch', 'x', 'pinterest', 'blog', 'web', 'other'];
const platSelect = (id, sel = '') => `<select class="bcn-field" id="${id}">${PLATS.map((x) => `<option value="${x}"${x === sel ? ' selected' : ''}>${esc(PLATFORM_NAMES[x] || x)}</option>`).join('')}</select>`;
const dlgFoot = (...buttons) => `<div class="af-dialog-foot">${buttons.filter(Boolean).join('')}</div>`;

function prospectEditBody(ed) {
  return `<div class="af-grid">
    ${field('Name', input('epName', `value="${esc(ed.display_name || '')}" maxlength="200"`))}
    ${field('Platform', platSelect('epPlat', ed.platform))}
    ${field('Handle', input('epHandle', `value="${esc(ed.handle || '')}" placeholder="@name"`))}
    ${field('Profile URL', input('epUrl', `value="${esc(ed.profile_url || '')}" placeholder="https://"`))}
    ${field('Email', input('epEmail', `type="email" value="${esc(ed.contact_email || '')}"`))}
  </div>${dlgFoot(btn('Save', 'prospect-save', { id: ed.id }, 'primary'), btn('Cancel', 'dialog-close'))}`;
}
function addCreatorsBody() {
  return `<div class="af-grid">
    ${field('Name', input('mpName'))}${field('Platform', platSelect('mpPlat'))}
    ${field('Handle', input('mpHandle', 'placeholder="@name"'))}${field('Profile URL', input('mpUrl', 'placeholder="https://"'))}
    ${field('Email', input('mpEmail', 'type="email"'))}${field('Where you found them', input('mpSource', 'placeholder="A link, or how you met"'))}
  </div>${field('Note', input('mpNote', 'placeholder="e.g. met at a tournament"'))}
  ${dlgFoot(btn('Add', 'prospect-add', {}, 'primary'), btn('Cancel', 'dialog-close'))}<div id="mpOut"></div>
  <div class="af-row" style="margin-top:14px;">${fieldTip('Or import a CSV', 'One creator per row, with a profile link. Download the template for the columns SILO reads.', '<input class="bcn-field" type="file" id="impFile" accept=".csv,text/csv" />')}${btn('Import', 'import-run', {}, 'primary')}${btn('Download template', 'import-template', {}, 'ghost')}</div>`;
}
function affToolBody(a, k) {
  const d = S.d; const p = prog();
  if (k === 'program') {
    // Which programs this person is ALREADY in. Read on demand, as far as this
    // account may see: a manager given one program sees the one membership
    // they were given, which is the isolation, not an omission
    // (20261121230000). Null means it could not be read, and then the picker
    // offers every program as it did before -- adding them to one they are in
    // is answered with "Already in ..." rather than a second membership.
    const inAlready = S.personProg && S.personProg.id === a.id ? S.personProg.rows : null;
    const inIds = new Set((inAlready || []).map((x) => x.program_id));
    const canAdd = otherPrograms().filter((x) => !inIds.has(x.id));
    const alsoIn = (inAlready || []).filter((x) => x.program_id !== S.programId)
      .map((x) => x.program_name).filter(Boolean);
    if (inAlready && !canAdd.length) {
      return `<p class="af-muted">${esc(a.display_name || 'They')} is already in every active program.</p>${dlgFoot(btn('Close', 'dialog-close'))}`;
    }
    return `<input type="hidden" id="apAff" value="${esc(a.id)}" /><div class="af-grid--settings">
      ${alsoIn.length ? `<p class="af-muted af-span-full">Also in ${esc(alsoIn.join(', '))}. One person, one payout address: their PayPal is the same in every program.</p>` : ''}
      ${field('Program', `<select class="bcn-field" id="apProg">${canAdd.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}
      ${field('Their rate', seg('apKind', [['', "Program's rate"], ['percent_of_net', '% of order'], ['fixed_per_order', 'Fixed per order']], '', ''))}
      ${field('%', input('apPct', 'type="number" min="0" max="100" step="0.5" placeholder="10"'))}
      ${field('Per order', input('apFixed', 'type="number" min="0" step="0.01" placeholder="5.00"'))}
      <div class="af-span-full">${dlgFoot(btn('Add to program', 'aff-add-program', {}, 'primary'), btn('Cancel', 'dialog-close'))}</div></div>`;
  }
  if (k === 'link') {
    return `<input type="hidden" id="lAff" value="${esc(a.id)}" /><div class="af-grid--settings">
      ${field('Name', input('lSlug', 'placeholder="pat-spring"'))}
      ${field('Page (https)', input('lDest', 'placeholder="https://yourstore.com/collections/new"'))}
      ${fieldTip('utm_campaign', 'Tags the visits this link sends, so your analytics can tell them apart.', input('lCamp', `value="${esc(p.slug)}"`))}
      <div class="af-span-full">${dlgFoot(btn('Add link', 'link-add', {}, 'primary'), btn('Cancel', 'dialog-close'))}</div></div>`;
  }
  return `<input type="hidden" id="cAff" value="${esc(a.id)}" /><div class="af-grid--settings">
    ${field('Code', input('cCode', 'class="bcn-field bcn-field--mono"'))}
    ${field('% off', input('cPct', 'type="number" min="1" max="100" step="1" value="10"'))}
    ${fieldTip('In Shopify', 'SILO makes the code in your store itself. Pick "I made it" only for a code that already exists there.', `<select class="bcn-field" id="cHow"><option value="ai" selected>SILO makes it</option><option value="exists">I made it</option></select>`)}
    ${field('Starts', input('cStart', `type="date" value="${esc(p.default_code_starts_on || today())}"`))}${field('Ends', input('cEnd', `type="date" value="${esc(p.default_code_ends_on || '')}"`))}
    <div class="af-span-full">${dlgFoot(btn('Add code', 'code-add', {}, 'primary'), btn('Cancel', 'dialog-close'))}</div></div>
    ${aiCodesBlock(d.aiApps)}`;
}
// What is open, if anything. `key` is what tells a re-render that the SAME
// form is still open, so typing is not wiped by a background refresh.
// The programs they are not in yet, to push them into: one menu. Never
// somebody on the do-not-contact list (company-wide, so no step towards
// contacting them is offered at all). It lives in More now, not on the row.
const addToSelect = (g) => {
  const d = S.d;
  if (!MANAGE || !g || g.suppressed || d?.supUnknown) return '';
  const missing = openPrograms().filter((y) => !g.programIds.includes(y.id));
  return missing.length
    ? `<select class="bcn-field af-addto" data-id="${esc(g.x.id)}" aria-label="Add to another program"><option value="">Add to program…</option>${missing.map((y) => `<option value="${esc(y.id)}">${esc(y.name)}</option>`).join('')}</select>`
    : '';
};
function dialogSpec() {
  const d = S.d;
  if (!MANAGE || !d) return null;
  const ed = S.editProspect ? d.prospectById[S.editProspect] : null;
  if (ed) return { key: `prospect:${ed.id}`, title: `Edit ${ed.display_name || ed.handle || 'creator'}`, body: prospectEditBody(ed) };
  if (S.addCreators) return { key: 'add-creators', title: 'Add creators', body: addCreatorsBody() };
  const mp = S.moreProspect ? d.prospectById[S.moreProspect] : null;
  // Keyed by the buttons themselves. Status is not enough: Mark contacted and
  // Draft message change a draft, not the creator, and a key that did not move
  // left the pressed button sitting there to be pressed again.
  if (mp) {
    // Every program this person is in, each with its own status and buttons
    // (one row per person on the list, so the programs live here).
    const group = Object.values(S.viewPeople || {}).find((g) => g.rows.some((r) => r.id === mp.id));
    const rows = group?.rows || [mp];
    const add = addToSelect(group);
    const blocks = rows.map((r) => {
      const acts = prospectActions(r).join('');
      return { acts, html: `${rows.length > 1 ? `<div class="af-allprog-row"><div class="af-allprog-name">${esc(progName(r.program_id))}</div>${prospectPill(r.status)}</div>` : ''}<div class="af-actions" style="flex-direction:column;align-items:stretch;">${acts}</div>` };
    });
    return { key: `more:${mp.id}:${blocks.map((x) => x.acts).join('|')}:${add ? 'add' : ''}`, title: mp.display_name || mp.handle || 'Creator', body: `${blocks.map((x) => x.html).join('')}${add ? `<div class="af-row" style="margin-top:10px;">${add}</div>` : ''}${dlgFoot(btn('Close', 'dialog-close'))}` };
  }
  // Every button an affiliate row used to carry, in one menu (audit findings
  // 2 and 8). The row keeps the one that moves them along.
  const ma = S.moreAffiliate ? d.affById[S.moreAffiliate] : null;
  if (ma) {
    const rows = (d.affiliates || []).filter((x) => sameAffiliatePerson(x, ma));
    // "Add to program" once per person, on their first live membership, the
    // same rule the card used.
    const addOn = rows.find((r) => ['active', 'paused'].includes(r.status))?.id;
    const blocks = rows.map((r) => `${rows.length > 1 ? `<div class="af-allprog-row"><div class="af-allprog-name">${esc(progName(r.program_id))}</div>${statusPill(r.status)}</div>` : ''}${affMoreBody(r, r.id === addOn)}`);
    return { key: `affmore:${ma.id}:${blocks.join('').length}`, title: ma.display_name || ma.contact_email || 'Affiliate', body: `${blocks.join('')}${dlgFoot(btn('Close', 'dialog-close'))}` };
  }
  // Who a share is for. Nobody ticked means the whole program, which is what
  // every share has meant until now, so the dialog opens on that honestly
  // rather than pre-ticking everyone and calling it the same thing.
  if (S.feedWho) {
    const f = (d.feed || []).find((x) => x.id === S.feedWho);
    if (f) {
      // Saving replaces the whole audience, so it may only be offered over one
      // we actually read. Null means we did not.
      if (!Array.isArray(d.audience)) {
        return { key: `whono:${f.id}`, title: `Who sees ${f.title}`,
          body: `<p class="af-muted">Who this share is for could not be read, so it cannot be changed here. Everyone in the program sees it, which is what every share meant before this. Reload and try again.</p>
            ${dlgFoot(btn('Close', 'dialog-close'))}` };
      }
      const picked = new Set(d.audience.filter((x) => x.feed_item_id === f.id).map((x) => x.affiliate_id));
      const live = (d.affiliates || []).filter((x) => x.status !== 'ended');
      const line = (x) => `<label class="af-item af-item--compact" style="display:flex;gap:10px;align-items:center;"><input type="checkbox" class="af-who" value="${esc(x.id)}"${picked.has(x.id) ? ' checked' : ''} /><span>${esc(x.display_name || x.contact_email || 'Creator')}</span></label>`;
      return { key: `who:${f.id}:${[...picked].sort().join(',')}`, title: `Who sees ${f.title}`,
        body: `<p class="af-muted">Tick nobody and it stays with everyone in this program, which is how it is shared now.</p>
          ${d.affFull === false ? '<p class="af-muted">Not every creator in this program could be listed, so saving changes only the ones shown here.</p>' : ''}
          ${live.length ? live.map(line).join('') : empty('No creators in this program yet.')}
          ${dlgFoot(`${btn('Save', 'feed-who-save', { id: f.id }, 'primary')}${btn('Cancel', 'dialog-close')}`)}` };
    }
  }
  // One post, opened from the wall. Keyed by its state as well as its id, so
  // a decision taken here redraws the buttons instead of offering the same
  // one again.
  if (S.contentOpen) {
    const x = (d.content || []).find((y) => y.id === S.contentOpen);
    if (x) return { key: `post:${x.id}:${x.state}:${x.offer_state || ''}:${x.offer_cents || ''}:${x.stats_at || ''}`, title: 'Post', body: contentOpenBody(x) };
  }
  const a = S.affTool ? d.affById[S.affTool.id] : null;
  if (a) {
    const k = S.affTool.k;
    const title = k === 'program' ? `Add ${a.display_name} to another program`
      : k === 'link' ? `Link for ${a.display_name}` : `Code for ${a.display_name}`;
    // The key moves when their other memberships arrive, or the dialog would
    // keep the body it drew before the read came back.
    const loaded = k === 'program' ? (S.personProg && S.personProg.id === a.id && S.personProg.rows ? `p${S.personProg.rows.length}` : 'p?') : '';
    return { key: `tool:${a.id}:${k}:${loaded}`, title, body: affToolBody(a, k) };
  }
  return null;
}
function closeDialogState() { S.contentOpen = null; S.editProspect = null; S.addCreators = false; S.affTool = null; S.moreProspect = null; S.moreAffiliate = null; S.feedWho = null; S.personProg = null; }
function renderDialog() {
  const dlg = $('afDialog');
  if (!dlg) return;
  const spec = dialogSpec();
  if (!spec) {
    S.dlgKey = null;
    if (dlg.open) dlg.close();
    // Emptied, not just hidden: a closed form leaves no half-typed fields in
    // the page for anything else to read.
    $('afDialogBody').innerHTML = '';
    $('afDialogTitle').textContent = '';
    return;
  }
  if (S.dlgKey !== spec.key) {
    $('afDialogTitle').textContent = spec.title;
    $('afDialogBody').innerHTML = spec.body;
    S.dlgKey = spec.key;
  }
  if (!dlg.open) dlg.showModal();
}

// ── All programs ─────────────────────────────────────────────────────────
// One card per PERSON: a program membership is an affiliates row, and the
// same person in two programs is two rows with the same address
// (20261118010000). Grouped by that address.
const progName = (id) => S.programs.find((x) => x.id === id)?.name || 'Program';
const effRate = (a) => {
  const pr = S.programs.find((x) => x.id === a.program_id) || {};
  return rateShort(a.commission_kind ? { ...pr, commission_kind: a.commission_kind, commission_percent: a.commission_percent, commission_fixed_cents: a.commission_fixed_cents } : pr);
};
function allPeople(d) {
  const by = new Map();
  for (const a of d.affiliates || []) {
    const k = String(a.contact_email || a.id).trim().toLowerCase();
    if (!by.has(k)) by.set(k, { key: k, name: a.display_name, email: a.contact_email, a, rows: [] });
    by.get(k).rows.push(a);
  }
  return [...by.values()];
}
function renderAll() {
  for (const id of ['prospectsBody']) { const el = $(id); if (el) el.innerHTML = ''; }
  const tab = PANEL_OF[S.tab] || 'overview';
  if (tab === 'overview') return renderAllHome();
  const body = $(FIRST_BODY[tab]);
  if (body) body.innerHTML = card('Pick a program', `<p>This tab works one program at a time.</p><div class="af-row">${
    S.programs.map((x) => btn(x.name, 'pick-program', { id: x.id }, 'surface')).join('')}</div>`);
}
function renderAllHome() {
  const d = S.d; const el = $('overviewBody');
  if (!el) return;
  const people = d?.affiliates ? allPeople(d) : [];
  const activePeople = people.filter((x) => x.rows.some((a) => a.status === 'active')).length;
  // Money is summed per currency, never across currencies.
  const sumBy = (rows, cur, f) => (rows || []).filter((r) => cur(r)).reduce((n, r) => n + Number(f(r) || 0), 0);
  const curs = [...new Set(S.programs.map((x) => x.currency).filter(Boolean))];
  const perProg = S.programs.map((x) => {
    const perf = (d?.performance || []).filter((r) => r.program_id === x.id);
    const bal = (d?.balances || []).filter((r) => r.program_id === x.id && r.currency === x.currency);
    return {
      p: x,
      people: (d?.affiliates || []).filter((a) => a.program_id === x.id && a.status === 'active').length,
      orders: perf.reduce((n, r) => n + Number(r.attributed_orders || 0), 0),
      sales: sumBy(perf, (r) => !r.order_currency || r.order_currency === x.currency, (r) => Number(r.gross_subtotal_cents || 0) - Number(r.refunded_subtotal_cents || 0)),
      earned: sumBy(bal, () => true, (r) => r.earned_cents),
      owed: sumBy(bal, (r) => Number(r.unclaimed_cents) > 0, (r) => r.unclaimed_cents),
    };
  });
  // A closed program drops off the table once it owes nothing; the totals
  // above still count everything it earned.
  const progRows = perProg.filter((r) => r.p.status !== 'closed' || r.owed > 0);
  const tot = (k, cur) => perProg.filter((r) => r.p.currency === cur).reduce((n, r) => n + r[k], 0);
  const moneyLine = (k) => curs.map((c) => formatMoney(tot(k, c), c)).join(' · ') || formatMoney(0, 'USD');
  const k = (label, v) => `<div class="bcn-kpi"><div class="bcn-kpi-label">${esc(label)}</div><div class="bcn-kpi-value">${v}</div></div>`;
  el.innerHTML = [
    `<div class="bcn-kpi-band af-allprog-kpis">${k('Active people', num(activePeople))}${k('Programs', num(S.programs.filter((x) => x.status === 'active').length))}${k('Orders from codes', num(perProg.reduce((n, r) => n + r.orders, 0)))}${k('Sales from codes', esc(moneyLine('sales')))}${k('Commission earned', esc(moneyLine('earned')))}${k('Owed now', esc(moneyLine('owed')))}</div>`,
    card('By program', table([
      { left: true, h: 'Program', f: (r) => `${esc(r.p.name)}<div class="af-muted">${esc(rateShort(r.p))}</div>` },
      { left: true, h: 'Status', f: (r) => statusPill(r.p.status) },
      { h: 'People', num: true, f: (r) => num(r.people) },
      { h: 'Orders', num: true, f: (r) => num(r.orders) },
      { h: 'Sales', num: true, f: (r) => esc(formatMoney(r.sales, r.p.currency)) },
      { h: 'Earned', num: true, f: (r) => esc(formatMoney(r.earned, r.p.currency)) },
      { h: 'Owed', num: true, f: (r) => esc(formatMoney(r.owed, r.p.currency)) },
      { h: '', f: (r) => btn('Setup', 'pick-program', { id: r.p.id, t: 'program' }, 'surface') },
    ], progRows, 'No programs yet.'), 'All time'),
  ].join('');
}
// The same table on the company view of Program, where it is the program
// COLUMN rather than a page of its own (audit finding 9, 2026-11-25): more
// programs shows more, not less.
function byProgramCard() {
  const d = S.d || {};
  const rows = S.programs.map((x) => {
    const perf = (d.performance || []).filter((r) => r.program_id === x.id);
    const bal = (d.balances || []).filter((r) => r.program_id === x.id && r.currency === x.currency);
    return {
      p: x,
      people: (d.affiliates || []).filter((a) => a.program_id === x.id && a.status === 'active').length,
      orders: perf.reduce((n, r) => n + Number(r.attributed_orders || 0), 0),
      sales: perf.reduce((n, r) => n + ((!r.order_currency || r.order_currency === x.currency)
        ? Number(r.gross_subtotal_cents || 0) - Number(r.refunded_subtotal_cents || 0) : 0), 0),
      owed: bal.reduce((n, r) => n + (Number(r.unclaimed_cents) > 0 ? Number(r.unclaimed_cents) : 0), 0),
    };
  });
  // A closed program stays only while it still owes money; the total line
  // still counts everything every program did.
  const allRows = rows.splice(0, rows.length);
  rows.push(...allRows.filter((r) => r.p.status !== 'closed' || r.owed > 0));
  // A total line, only where every program is in the same currency: money is
  // summed per currency, never across.
  const curs = [...new Set(S.programs.map((x) => (x.currency || 'USD').toUpperCase()))];
  const sum = (k) => allRows.reduce((n, r) => n + Number(r[k] || 0), 0);
  const all = curs.length === 1 && allRows.length > 1
    ? [{ total: true, p: { name: 'All programs', currency: curs[0] }, people: sum('people'), orders: sum('orders'), sales: sum('sales'), owed: sum('owed') }]
    : [];
  return card('By program', table([
    { left: true, h: 'Program', f: (r) => (r.total ? `<strong>${esc(r.p.name)}</strong>` : `${esc(r.p.name)}<div class="af-sub">${esc(rateShort(r.p))}</div>`) },
    { left: true, h: 'Status', f: (r) => (r.total ? '' : statusPill(r.p.status)) },
    { h: 'People', num: true, f: (r) => num(r.people) },
    { h: 'Orders', num: true, f: (r) => num(r.orders) },
    { h: 'Sales', num: true, f: (r) => esc(formatMoney(r.sales, r.p.currency)) },
    { h: 'Owed', num: true, f: (r) => (SEES_MONEY ? esc(formatMoney(r.owed, r.p.currency)) : '—') },
    { h: '', f: (r) => (r.total ? '' : btn('Setup', 'pick-program', { id: r.p.id, t: 'program' }, 'surface')) },
  ], [...rows, ...all], 'No programs yet.'), 'All time');
}

function renderKpis() {
  const el = $('kpis');
  const h = S.d?.health;
  const p = prog();
  // The workflow rail carries counts when a program is loaded; skip the extra
  // KPI band. People is company-wide and has its own counts.
  if ((h && p) || companyScope()) {
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
  // `tip` is the sentence that used to sit in the row itself: on hover now,
  // so the list reads as a list of jobs (Blake 2026-11-20).
  const add = (n, text, tab, extra = '', rec = '', tip = '') => { if (n) items_.push({ text, tab, extra, rec, tip }); };
  add(p.status !== 'active', `The program is ${p.status}. Set it to active in Setup to start recruiting.`, 'program');
  add(!p.terms_markdown, 'Write your program terms in Setup. Affiliates accept them to join.', 'program');
  const appliedWaiting = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status)).length;
  const toReview = Math.max(0, Number(h.prospects_new || 0) - appliedWaiting);
  add(appliedWaiting, `${esc(plural(appliedWaiting, 'application'))} waiting.`, 'outreach');
  add(toReview, `${esc(plural(toReview, 'creator'))} to look at.`, 'prospects');
  const drafts = d.drafts.filter((x) => x.state === 'draft').length;
  add(drafts, `${esc(plural(drafts, 'message'))} to approve.`, 'outreach', MANAGE ? btn(`Approve all ${num(drafts)}`, 'q-msgs', {}, 'primary') : '');
  const dmReady = d.drafts.filter((x) => x.state === 'approved' && isDm(x)).length;
  const emailReady = Math.max(0, Number(h.outreach_approved || 0) - dmReady);
  add(emailReady, `${esc(plural(emailReady, 'message'))} ready to send from your own email.`, 'outreach', MANAGE ? btn('Copy prompt', 'copy-send-prompt', {}, 'surface') : '');
  add(dmReady, `${esc(plural(dmReady, 'creator'))} with no email, to message on social.`, 'outreach');
  add(Number(h.outreach_exported || 0), `${esc(plural(Number(h.outreach_exported || 0), 'sent message'))} to mark as sent.`, 'outreach');
  const pending = d.codes.filter((c) => c.status === 'pending').length;
  add(pending, `${esc(plural(pending, 'code'))} waiting to be made in Shopify.`, 'affiliates', MANAGE ? btn('Make in Shopify', 'code-make', {}, 'primary') : '');
  const coded = new Set(d.codes.filter((c) => c.status !== 'retired').map((c) => c.affiliate_id));
  const codeless = d.affiliates.filter((a) => a.status === 'active' && !coded.has(a.id)).length;
  add(codeless, `${esc(plural(codeless, 'affiliate'))} without a code.`, 'affiliates', MANAGE ? btn(`Make ${esc(plural(codeless, 'code'))}`, 'q-codes', {}, 'primary') : '');
  add(Number(h.codes_never_seen || 0), `${esc(plural(Number(h.codes_never_seen || 0), 'code'))} never seen on an order.`, 'affiliates', '', '', 'The code may not exist in Shopify, or may be spelled differently there.');
  const unattributed = (h.attributions_ambiguous || 0) + (h.attributions_multi_code_refused || 0) + (h.attributions_outside_window || 0) + (h.attributions_currency_mismatch || 0) + (h.attributions_refunds_unmeasured || 0);
  add(unattributed, `${esc(plural(unattributed, 'order'))} with a code, not credited.`, 'payouts', '', '', 'Usually two codes on one order, an order outside the attribution window, or refunds not measured yet.');
  const seedAsks = (d.seeds || []).filter((x) => x.state === 'requested').length;
  add(seedAsks, `${esc(plural(seedAsks, 'product request'))} from affiliates.`, 'records', MANAGE ? btn(`Approve all ${num(seedAsks)}`, 'q-seeds', {}, 'primary') : '', 'products');
  const seedCodes = (d.seeds || []).filter((x) => x.state === 'approved').length;
  add(seedCodes, `${esc(plural(seedCodes, 'product code'))} waiting to be made in Shopify.`, 'records', MANAGE ? btn('Make in Shopify', 'seed-make', {}, 'primary') : '', 'products');
  const contentAsks = (d.content || []).filter((x) => x.state === 'submitted').length;
  add(contentAsks, `${esc(plural(contentAsks, 'post'))} from affiliates to look at.`, 'share');
  const owed = (d.balances || []).filter((x) => x.currency === p.currency && Number(x.unclaimed_cents) > 0).length;
  add(MANAGE && owed, `${esc(plural(owed, 'affiliate'))} with earnings to pay.`, 'payouts', btn(`Build ${esc(plural(owed, 'payout'))}`, 'q-payouts', {}, 'primary'));
  const toApprove = d.payouts.filter((x) => x.status === 'draft').length;
  add(MONEY && toApprove, `${esc(plural(toApprove, 'payout'))} to approve.`, 'payouts');
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
// The agreement PDF exists once 20261119010000 is applied.
const hasTermsFile = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'terms_file_path'));
const hasContentBonus = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'content_bonus_cents'));
// Twenty store chips printed in full to set one answer was most of Setup's
// weight (audit finding 11, 2026-11-25). The chosen stores are always on the
// page; the rest come in on "+N more", so nothing is hidden from a choice --
// only from the first glance.
const STORE_CHIPS_SHOWN = 4;
const storesCard = (p, dis) => {
  const st = Array.isArray(S.d?.stores) ? S.d.stores : [];
  if (!hasStorePick() || st.length < 2) return '';
  const picked = Array.isArray(p.shop_domains) ? p.shop_domains : null;
  const isOn = (x) => !picked || picked.includes(x);
  const chip = (x) => `<button type="button" class="af-chip-tog pStore${isOn(x) ? ' is-on' : ''}" data-store="${esc(x)}" aria-pressed="${isOn(x)}" ${dis}>${esc(storeName(x))}</button>`;
  // Every chosen store, then enough of the rest to make the choice readable.
  const lead = st.filter(isOn);
  const rest = st.filter((x) => !isOn(x));
  const shown = S.storesAll || st.length <= STORE_CHIPS_SHOWN + 1
    ? st
    : [...lead, ...rest].slice(0, Math.max(STORE_CHIPS_SHOWN, lead.length));
  const hidden = st.filter((x) => !shown.includes(x));
  // The hidden chips stay in the form, off-screen, so saving reads the same
  // answer whether or not the list was opened.
  return card('Stores', setRow('Counts orders from', `<div class="af-chips-tog">${shown.map(chip).join('')}${
    hidden.length ? `<button type="button" class="af-chip-tog af-chip-more" data-act="stores-all">+${num(hidden.length)} more</button>` : ''}</div>${
    hidden.length ? `<div class="af-chips-off">${hidden.map(chip).join('')}</div>` : ''}`), '', '', shopifyMark('af-head-mark'));
};
const hasOutreachMessage = () => S.programs.some((x) => Object.prototype.hasOwnProperty.call(x, 'outreach_body'));
// Setup is a settings page, not a form (Blake, 2026-11-13: "looks like 98
// windows forms, need modernized"; "i don't want hiding"). Every setting is
// in plain sight, in a card per subject, one row each: the name on the left,
// the control on the right. Choices are chips and switches, not dropdowns.
// An existing program saves as you go; a new one has one Create button.
const applyLinkCtl = (p) => (p.intake_mode === 'open'
  ? `<div class="af-row">${btn('Copy link', 'copy-text', { t: applyUrl(location.origin, CO, p.slug) }, 'primary')}<a class="bcn-btn" href="${esc(safeHref(applyUrl(location.origin, CO, p.slug)) || '#')}" target="_blank" rel="noopener">Open</a></div>`
  : '<div class="af-row" id="applyClosed"><span class="af-muted">Choose Open applications above to get a link people can apply with.</span></div>');
// A quiet heading inside a settings card: the rows under it are set once and
// rarely revisited. It hides nothing (Blake 2026-11-13: "i don't want hiding").
const setSub = (label) => `<div class="af-set-sub">${esc(label)}</div>`;
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
    // Always shown (Blake 2026-11-19: "apply link ... is not in setup"): with
    // Invite only it says how to open it instead of disappearing.
    !isNew && p.id ? setRow('Application link', applyLinkCtl(p), 'rowApply') : '',
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
    // Set once and rarely touched again: same page, same type size, quieter
    // heading (audit finding 11 -- weight differs, nothing hides).
    setSub('Advanced'),
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
  // Automatic searches are set per company on Billing, not per program
  // (Blake 2026-11-25: "in setup -- instruct/ link to billing ... for auto
  // discovery search etc."). Setup says where, rather than repeating them.
  const auto = isNew ? '' : card('Automatic searches', `<p class="af-muted">Nightly Find on your customers, nightly Discovery of new creators and the monthly spending limit are set once for the whole company, in Workspace Settings under Billing. Everything Affiliate Studio does is one line on your bill there.</p>
    <div class="af-row"><a class="bcn-btn bcn-btn--primary" href="../billing.html#studioCard">Open Billing settings</a></div>`);
  // The message to creators is prepped on Comms now (Blake, 2026-11-17).
  const message = '';
  // The agreement: written terms, a PDF the brand uploads (20261119010000),
  // or both. Affiliates sign whichever is here; changing either is a new version.
  const fileRow = !hasTermsFile() || isNew ? '' : p.terms_file_path
    ? `<div class="af-terms-file"><span class="af-terms-file-icon">PDF</span><span class="af-terms-file-name">${esc(p.terms_file_name || 'Agreement')}</span>${btn('Open', 'terms-file-open')}${dis ? '' : btn('Remove', 'terms-file-remove', {}, 'surface', { confirm: true })}</div>`
    : (dis ? '' : `<div class="af-terms-file af-terms-file--empty"><input class="bcn-field" type="file" id="pTermsFile" accept="application/pdf,.pdf" aria-label="Agreement PDF" />${btn('Upload agreement', 'terms-file-upload', {}, 'primary')}</div><p class="af-muted">Optional. A PDF of your partnership agreement, up to 10 MB. Affiliates open it and sign before they join.</p>`);
  const terms = card(`Terms${p.terms_version ? ` · v${p.terms_version}` : ''}`,
    `${fileRow}<textarea class="bcn-field af-set-input" id="pTerms" rows="8" ${dis} placeholder="${p.terms_file_path ? 'Anything to add to the agreement (optional)' : 'Commission, crediting, refunds, payouts, rules'}">${esc(p.terms_markdown || '')}</textarea>`);
  const codes = card('Codes', [
    setRow('Codes start', setInput('pStart', `${dis} type="date" value="${esc(p.default_code_starts_on || '')}"`)),
    setRow('Codes end', setInput('pEnd', `${dis} type="date" value="${esc(p.default_code_ends_on || '')}"`)),
    setSub('Advanced'),
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
    <div class="af-settings-col">${recruit}${auto}${message}${terms}${access}</div></div>`;
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
// The Your Customers filters. Every one of them is a new read, so the change
// is debounced: typing in a date field fires on each keystroke in some
// browsers, and four reads per keystroke would be four scans of the table.
let custTimer = null;
document.addEventListener('change', (ev) => {
  const id = ev.target?.id;
  if (id === 'custScanCount') { custState().scanCount = Math.max(1, Math.min(500, Math.floor(Number(ev.target.value)) || 25)); return; }
  if (id === 'custScanTerms') { custState().scanTerms = String(ev.target.value || ''); return; }
  if (!['custFrom', 'custTo', 'custMin', 'custConsent', 'custSort', 'custSocial'].includes(id)) return;
  const c = custState();
  if (id === 'custSocial') c.socialOnly = ev.target.value === 'found';
  if (id === 'custFrom') c.from = ev.target.value;
  else if (id === 'custTo') c.to = ev.target.value;
  else if (id === 'custMin') c.minOrders = ev.target.value;
  else if (id === 'custConsent') c.consent = ev.target.value;
  else if (id === 'custSort') c.sort = ev.target.value;
  c.page = 0;
  clearTimeout(custTimer);
  custTimer = setTimeout(() => loadCustomers(true), 250);
});
// Posts from affiliates: sort by newest, views or engagement.
document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'contentSort') return;
  S.contentSort = ev.target.value; render();
});
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
    // The application link follows Joining and the link name at once.
    const ctl = fresh && S.programId === id ? document.querySelector('#rowApply .af-set-ctl') : null;
    if (ctl) ctl.innerHTML = applyLinkCtl({ ...fresh, ...row });
    if (el()) el().textContent = 'Saved';
  } catch (e) {
    if (el()) el().textContent = '';
    setStatus(friendly(e), 'neg');
  }
}

async function renderManagers() {
  const el = $('managersCard'); if (!el) return;
  // program_id arrives with 20261121210000; until it is applied the column is
  // not there, so a failed read falls back to the grant list without it and
  // every grant reads as "All programs", which is what it is.
  let rows = [];
  let scoped = true;
  const full = await db.from('affiliate_program_managers').select('id, user_id, created_at, program_id').eq('company_entity_id', CO);
  if (full.error) {
    scoped = false;
    rows = (await db.from('affiliate_program_managers').select('id, user_id, created_at').eq('company_entity_id', CO)).data || [];
  } else { rows = full.data || []; }
  const name = (id) => { const u = S.profiles.find((x) => x.id === id); return esc(u?.name || u?.email || id); };
  const progLabel = (id) => esc(S.programs.find((x) => x.id === id)?.name || 'one program');
  // A grant that names no program is every program, which is what every grant
  // made before 2026-11-21 is.
  const covers = (r) => (r.program_id ? `${progLabel(r.program_id)} only` : 'All programs');
  const mgrRow = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${name(r.user_id)} ${pill(covers(r), r.program_id ? '' : 'accent')}</div><div class="af-muted">Since ${fmtDate(r.created_at)}</div></div><div class="af-item-foot">${btn('Remove', 'remove-manager', { id: r.id }, 'surface', { confirm: true })}</div></article>`;
  el.innerHTML = card('Who can run Affiliate Studio', `${itemList(rows, mgrRow, 'Only owners and executives so far.')}
    <div class="af-row" style="margin-top:8px;">${field('Grant access to', `<select class="bcn-field" id="mgrUser"><option value="">—</option>${S.profiles.map((u) => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join('')}</select>`)}${
      scoped ? field('For', `<select class="bcn-field" id="mgrProgram"><option value="">All programs</option>${S.programs.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>`) : ''
    }${btn('Grant', 'add-manager', {}, 'primary')}</div>
    <p class="af-muted">Someone granted one program sees and changes only that program. Granted all, they work across every one, which is how every grant before today was made.</p>`);
}

// The link name is made URL-safe as typed ("Testing-2" -> "testing-2"), so
// a capital letter or a space never blocks the save (Blake 2026-11-18).
function tidySlug() {
  const el = $('pSlug'); const typed = el?.value.trim() || '';
  const slug = slugify(typed || val('pName'));
  if (el && typed && slug && typed !== slug) el.value = slug;
  return slug;
}
function readProgramForm() {
  return validateProgram({
    name: val('pName'), slug: tidySlug(), status: val('pStatus'), owner_user_id: val('pOwner'),
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
    has_terms_file: !S.creating && !!prog()?.terms_file_path,
  });
}

// ── Prospects ────────────────────────────────────────────────────────────
// The Discovery filters. Applications wait on Outreach > Inbound (Blake,
// 2026-11-17), not under To review.
// Archive holds Not a fit and Do not contact (Blake 2026-11-25), so the
// working filters only grow with open work. Somebody who signed up is an
// affiliate now and lives on Affiliates, not anywhere in Discovery.
const PROSPECT_GROUPS = { new: ['new', 'qualified'], approved: ['approved', 'invited'], archive: ['rejected', 'suppressed'], all: ['new', 'qualified', 'approved', 'invited', 'rejected', 'suppressed'] };
const PROSPECT_OPEN = ['new', 'qualified', 'approved', 'invited'];
const prospectInGroup = (x, g) => (!PROSPECT_GROUPS[g] || PROSPECT_GROUPS[g].includes(x.status)) && !(g === 'new' && x.source === 'applied');
// A bulk press on people becomes their program rows: each row in the filter
// on screen, or every row for Do not contact (which is company-wide anyway).
function pickedProspectRows(s) {
  const ids = [];
  for (const id of S.sel) {
    const g = S.viewPeople?.[id];
    if (!g) { ids.push(id); continue; }
    for (const x of g.rows) if (s === 'suppressed' || prospectInGroup(x, S.prospectFilter || 'new')) ids.push(x.id);
  }
  return [...new Set(ids)];
}
// Every action a creator row offers, in the order they are used. The row
// shows the first; More shows them all.
function prospectActions(x) {
  const d = S.d;
  if (!MANAGE || !d) return [];
  const live = new Set(d.drafts.filter((y) => ['draft', 'approved', 'exported'].includes(y.state)).map((y) => y.prospect_id));
  const contacted = new Set(d.drafts.filter((y) => y.state === 'sent').map((y) => y.prospect_id));
  const b = [];
  // The step that moves this person along comes first, because the row shows
  // the first button and More holds the rest: for somebody already
  // shortlisted that is the message or the invite, never "Not a fit".
  if (['new', 'qualified', 'rejected'].includes(x.status)) b.push(btn('Shortlist', 'prospect-status', { id: x.id, s: 'approved' }, 'primary'));
  if (x.status === 'approved' && !live.has(x.id)) b.push(btn('Draft message', 'draft-create', { id: x.id }));
  if (['approved', 'invited'].includes(x.status) && x.contact_email) b.push(INVITE_SOURCES.has(x.source) ? btn(x.status === 'invited' ? 'Resend invite' : 'Send invite', 'invite-send', { id: x.id }) : btn('Signup link', 'signup-link', { id: x.id }));
  if (['new', 'qualified', 'approved'].includes(x.status) && !live.has(x.id) && !contacted.has(x.id)) b.push(btn('Mark contacted', 'prospect-contacted', { id: x.id }));
  if (['new', 'qualified', 'approved'].includes(x.status)) b.push(btn('Not a fit', 'prospect-status', { id: x.id, s: 'rejected' }));
  if (x.status === 'rejected') b.push(prospectPill('rejected'));
  if (!['suppressed', 'signed_up', 'rejected'].includes(x.status)) b.push(btn('Do not contact', 'prospect-suppress', { id: x.id }, 'surface', { confirm: true }));
  if (x.status !== 'suppressed') b.push(btn('Edit', 'prospect-edit', { id: x.id }, 'ghost'));
  return b;
}
function renderProspects() {
  const d = S.d;
  // Where Find creators and Add creators save (see findProgram).
  const fp = findProgram();
  const filter = S.prospectFilter || 'new';
  // Everybody found, in any program, once each (Blake 2026-11-24: "Discovery
  // should show all discovered no matter the program"). A card is in a
  // filter when any of their programs has them there.
  // One filter row (Blake 2026-11-25: "better filtering and sorting"):
  // platform, program, has an email, follower floor. The status chips below
  // count what these leave.
  const F = (S.dFilt ||= { plat: '', prog: '', email: false, minF: 0 });
  const allPeople = dropClosedRows(groupPeople(d.prospects, d.suppressions), S.programs.filter((y) => y.status === 'closed').map((y) => y.id));
  const followersOf = (g) => Math.max(0, ...g.rows.map((x) => Number(followersFrom(x.evidence)?.count) || 0));
  const engagementOf = (g) => { const r = g.rows.map((x) => creatorStats(x.evidence)?.rate).filter((v) => v != null); return r.length ? Math.max(...r) : null; };
  const emailOf = (g) => g.rows.map((x) => x.contact_email).find(Boolean) || '';
  const plats = [...new Set(allPeople.flatMap((g) => g.rows.map((x) => x.platform)).filter(Boolean))].sort();
  if (F.plat && !plats.includes(F.plat)) F.plat = '';
  if (F.prog && !openPrograms().some((y) => y.id === F.prog)) F.prog = '';
  const people = allPeople.filter((g) => (!F.plat || g.rows.some((x) => x.platform === F.plat))
    && (!F.prog || g.programIds.includes(F.prog))
    && (!F.email || !!emailOf(g))
    && (!F.minF || followersOf(g) >= F.minF));
  // A person is archived only when none of their programs still has them in
  // open work; Do not contact archives the whole person, company-wide.
  const inGroup = (g, f) => {
    if (g.suppressed) return f === 'archive' || f === 'all';
    if (f === 'archive') return g.rows.some((x) => prospectInGroup(x, f)) && !g.rows.some((x) => PROSPECT_OPEN.includes(x.status));
    return g.rows.some((x) => prospectInGroup(x, f));
  };
  // The search a prospect came from, so one search's results can be picked out.
  const fromQuery = (x) => String(x.evidence?.last_seen_query || x.evidence?.query || '').trim();
  const queries = [...new Set(people.filter((g) => inGroup(g, filter)).flatMap((g) => g.rows.map(fromQuery)).filter(Boolean))].slice(0, 30);
  if (S.prospectQuery && !queries.includes(S.prospectQuery)) S.prospectQuery = '';
  const list = people.filter((g) => inGroup(g, filter) && (!S.prospectQuery || g.rows.some((x) => fromQuery(x) === S.prospectQuery)));
  // Sort by a column header; numbers start biggest first, words A to Z.
  const SORT = {
    creator: (g) => String(g.x.display_name || g.x.handle || '').toLowerCase(),
    followers: followersOf,
    engagement: (g) => engagementOf(g) ?? -1,
    email: (g) => emailOf(g).toLowerCase() || '\uffff',
    status: (g) => String(g.suppressed ? 'suppressed' : g.x.status || ''),
    program: (g) => g.rows.map((x) => progName(x.program_id)).join(', ').toLowerCase(),
  };
  const ds = S.dSort;
  if (ds && SORT[ds.k]) {
    const key = SORT[ds.k];
    list.sort((a, b) => { const x = key(a); const y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * ds.dir; });
  }
  // Bulk selection is by person, held as the id of the row on their card.
  const inView = new Set(list.map((g) => g.x.id));
  for (const id of [...S.sel]) if (!inView.has(id)) S.sel.delete(id);
  S.viewIds = list.map((g) => g.x.id);
  S.viewPeople = Object.fromEntries(list.map((g) => [g.x.id, g]));
  // One row per person (Blake 2026-11-24, his sheet: Creator, Followers,
  // Email, Status, Program, More): the programs they are in are a column, not
  // a line each, and adding them to another program is one menu on the row.
  // Two buttons on the row, the rest behind More (Blake 2026-11-20: "there is
  // a lot there"). More opens the same buttons in the centre pop-up, so
  // nothing is lost and nothing folds out over the list.
  // Somebody in several programs has a row in each, with its own status. The
  // row shown is the one that puts them in this filter (Shortlisted shows
  // their shortlisted program), and More lists every program's own buttons.
  const shownRow = (g) => g.rows.find((x) => prospectInGroup(x, filter)) || g.x;
  // One button on the row -- the next thing to do with this person -- and a
  // menu holding every other one (Blake 2026-11-25: "all the functions, not
  // all the noise"). Nothing is dropped: More opens the same buttons, plus
  // the other programs they can be added to.
  const rowActions = (x, g) => {
    if (!MANAGE) return '';
    const b = prospectActions(x);
    const many = (g?.rows.length || 1) > 1;
    if (!b.length && !many) return '';
    const shown = b.slice(0, 1);
    if (b.length > 1 || many || addTo(g)) shown.push(btn('···', 'prospect-more', { id: x.id }, 'ghost', { title: `More for ${x.display_name || x.handle || 'this creator'}`, cls: 'af-more-btn' }));
    return `<div class="af-rowacts">${shown.join('')}</div>`;
  };
  const addTo = addToSelect;
  // "Add to program…" moved off the row and into More (Blake 2026-11-25): it
  // is still one menu per person, just not one open on every row.
  const actions = (g) => (g.suppressed ? '' : rowActions(shownRow(g), g));
  const headPill = (g) => prospectPill(g.suppressed ? 'suppressed' : shownRow(g).status);
  const programsOf = (g) => [...new Set(g.rows.map((x) => progName(x.program_id)))].filter(Boolean).join(', ');
  const who = (x) => {
    const link = x.profile_url ? ext(x.profile_url, x.display_name || x.handle || x.profile_url) : esc(x.display_name || x.handle);
    return `${link}<div class="af-muted">${esc(x.platform)}${x.handle ? ` · ${esc(x.handle)}` : ''}</div>${x.contact_email ? `<div class="af-muted">${esc(x.contact_email)}</div>` : ''}`;
  };
  const sourceLine = (x) => { const e = x.evidence || {}; return `${esc(sourceLabel(x.source))}${e.query ? ` · “${esc(e.query)}”` : ''}${e.found_via ? ` · found via ${esc(String(e.found_via).slice(0, 120))}` : ''} · ${fmtDate(x.collected_at)}${x.source_url ? ` · ${ext(x.source_url, 'source')}` : ''}`; };
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
  // "Approved" read as a decision about the person; at this point it only
  // means they are lined up for outreach (Blake 2026-11-20).
  const filters = [['new', 'To review'], ['approved', 'Shortlisted'], ['archive', 'Archive'], ['all', 'All']];
  const runs = d.runs.slice(0, 10);
  const prospectCard = (g) => {
    const x = g.x;
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
        ${headPill(g)}${customerPill(x)}
      </header>
      <p class="af-catalog-summary-p">${esc(evidenceSummary(x, 120))}</p>
      <div class="af-kv-line"><span class="bcn-num">${followersVal}</span> followers · <span class="bcn-num">${pct}</span> engagement</div>
      ${facts.length ? `<div class="af-muted af-catalog-facts">${facts.join(' · ')}</div>` : ''}
      <div class="af-muted">${sourceLine(x)}</div>
      ${openPrograms().length > 1 ? `<div class="af-kv-line"><span class="af-muted">Program</span> ${esc(programsOf(g))}</div>` : ''}
      <footer class="af-item-foot af-catalog-foot">${actions(g)}</footer>
    </article>`;
  };
  const capped = S.prospectShowAll ? list : list.slice(0, PROSPECT_LIST_CAP);
  const seg = (label, key, opts) => `<div class="af-dfilter"><span class="af-muted">${esc(label)}</span><div class="af-seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, txt]) => `<button type="button" class="af-seg-btn${String(F[key]) === String(v) ? ' is-on' : ''}" role="radio" aria-checked="${String(F[key]) === String(v)}" data-act="d-filter" data-key="${key}" data-v="${esc(String(v))}">${esc(txt)}</button>`).join('')}</div></div>`;
  const anyFilter = F.plat || F.prog || F.email || F.minF;
  const dFilterRow = `<div class="af-dfilters">${[
    plats.length > 1 ? seg('Platform', 'plat', [['', 'All'], ...plats.map((x) => [x, PLATFORM_NAMES[x] || x])]) : '',
    openPrograms().length > 1 ? seg('Program', 'prog', [['', 'All'], ...openPrograms().map((y) => [y.id, y.name])]) : '',
    seg('Email', 'email', [[false, 'Any'], [true, 'Has email']]),
    seg('Followers', 'minF', [[0, 'Any'], [1000, '1k+'], [10000, '10k+'], [100000, '100k+']]),
    anyFilter ? btn('Clear filters', 'd-filter-clear', {}, 'ghost') : '',
  ].join('')}</div>`;
  const dSortSpec = { act: 'd-sort', k: S.dSort?.k || '', dir: S.dSort?.dir || -1 };
  const listFoot = list.length > PROSPECT_LIST_CAP
    ? (S.prospectShowAll
      ? `<div class="af-list-foot">${btn(`Show first ${PROSPECT_LIST_CAP}`, 'prospect-show-fewer')}</div>`
      : `<div class="af-list-foot">${btn(`Show all ${list.length}`, 'prospect-show-all')}</div>`)
    : '';
  // Find is a button on the control row; its two fields open under it. They
  // open by themselves while a search is running and when there is nobody on
  // the list yet, so the empty page still shows what to do.
  const canFind = !!(MANAGE && fp);
  const findOpen = canFind && (researching || !people.length || (S.dFindOpen === undefined ? false : !!S.dFindOpen));
  const findRow = findOpen
    ? `<div class="af-panelette af-find-inline">${field('Find more like…', input('rsFocus', `maxlength="500" value="${esc(S.findFocus || '')}" placeholder="${esc(fp.niche ? `e.g. ${fp.niche} creators on TikTok` : 'e.g. youth baseball coaches with drill videos')}"`))}${field('How many', input('rsCount', `type="number" min="5" max="50" value="${esc(String(S.findCount || 25))}" style="max-width:5.5rem"`))}${btn(researching ? 'Finding…' : 'Find', 'research-run', { pg: fp.id }, 'primary', { disabled: researching })}</div>`
    : '';
  // One control row (Blake 2026-11-25): what you are looking at on the left,
  // Filter and the view on the right. The four filter rows that used to sit
  // above the table are the same controls, in a panel that opens under it --
  // and it opens by itself whenever a filter is on, so nothing filters the
  // list invisibly.
  // Editing a creator, adding creators and the code/link forms all open in
  // the middle of the screen now (Blake 2026-11-20); see dialogSpec().
  const allPicked = !!list.length && list.every((g) => S.sel.has(g.x.id));
  const filtCount = [F.plat, F.prog, F.email, F.minF].filter(Boolean).length;
  // Open by itself the first time a filter is on, so nothing narrows the list
  // invisibly; after that the button decides, and the count on it says how
  // many filters are set even when it is shut.
  const filtOpen = S.dFiltOpen === undefined ? !!anyFilter : !!S.dFiltOpen;
  const statusSeg = `<div class="af-seg" role="radiogroup" aria-label="Which creators">${filters.map(([f, label]) => `<button type="button" class="af-seg-btn${f === filter ? ' is-on' : ''}" role="radio" aria-checked="${f === filter}" data-act="prospect-filter" data-f="${f}">${esc(label)} <span class="af-mono">${people.filter((g) => inGroup(g, f)).length}</span></button>`).join('')}</div>`;
  // Tiles have no header row to hold the select-all box, so it rides in the
  // control row there.
  const tileSelectAll = MANAGE && S.view !== 'list' && list.length
    ? btn(allPicked ? 'Clear selection' : `Select all ${list.length}`, allPicked ? 'prospect-select-none' : 'prospect-select-all')
    : '';
  const ctlRow = `<div class="af-ctl">${statusSeg}<span class="af-ctl-gap"></span>${tileSelectAll}${
    btn(filtCount ? `Filter · ${filtCount}` : 'Filter', 'd-filter-open', {}, filtOpen ? 'primary' : 'surface')}${viewToggle()}${
    canFind ? `${btn('Add creators', 'add-creators', { pg: fp.id })}${btn(researching ? 'Finding…' : 'Find creators', 'd-find-open', {}, 'primary')}` : ''}</div>${
    findRow}${filtOpen ? `<div class="af-panelette">${dFilterRow}</div>` : ''}`;
  // The program a row is in is worth a column only when the rows differ; one
  // program repeated down every row says nothing.
  const showProgramCol = openPrograms().length > 1 && new Set(list.map((g) => programsOf(g))).size > 1;
  // Everything this row tells you about the person, in one cell: their state
  // when it is not already the filter you are in, whether they have bought
  // from you, how engaged their audience is, and their email if we have one.
  const signalCell = (g) => {
    const x = g.x;
    const st = creatorStats(x.evidence);
    const bits = [
      g.suppressed || shownRow(g).status !== PROSPECT_GROUPS[filter]?.[0] ? headPill(g) : '',
      customerPill(x),
      st?.rate != null ? pill(`${(st.rate * 100).toFixed(1)}% eng`) : '',
      x.contact_email ? `<span class="bcn-pill" title="${esc(x.contact_email)}">email<span class="af-offscreen"> ${esc(x.contact_email)}</span></span>` : '',
    ].filter(Boolean);
    return bits.length ? `<div class="af-signal">${bits.join('')}</div>` : '<span class="af-muted">—</span>';
  };

  $('prospectsBody').innerHTML = [
    surface('Creators', `${ctlRow}
      ${MANAGE && S.sel.size ? `<div class="af-row af-bulk">
        <span class="af-mono">${num(S.sel.size)} selected</span>${btn('Shortlist', 'prospect-bulk', { s: 'approved' }, 'primary')}${btn('Not a fit', 'prospect-bulk', { s: 'rejected' })}${openPrograms().length > 1 && !d.supUnknown ? openPrograms().map((y) => btn(`Add to ${y.name}`, 'prospect-bulk-assign', { to: y.id })).join('') : ''}${btn('Do not contact', 'prospect-bulk', { s: 'suppressed' }, 'surface', { confirm: true })}${btn('Clear', 'prospect-select-none')}
      </div>` : ''}
      ${S.view === 'list'
        ? table([
          ...(MANAGE ? [{ hHtml: allPicked
            ? `<input type="checkbox" class="af-pick" data-act="prospect-select-none" aria-label="Clear selection" checked />`
            : `<input type="checkbox" class="af-pick" data-act="prospect-select-all" aria-label="Select all ${num(list.length)}" />`,
          h: '', f: ({ x }) => `<input type="checkbox" class="af-pick" data-act="prospect-pick" data-id="${esc(x.id)}" aria-label="Select ${esc(x.display_name || x.handle || 'creator')}"${S.sel.has(x.id) ? ' checked' : ''} />` }] : []),
          { left: true, h: 'Creator', sort: 'creator', f: ({ x }) => `<div class="af-list-who">${listThumb({ name: x.display_name, email: x.contact_email }, prospectPhotoUrl(x.evidence))}<div>${x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Creator') : esc(x.display_name || x.handle || 'Creator')}<div class="af-muted">${esc(x.platform || 'creator')}${x.handle ? ` · ${esc(x.handle)}` : ''}</div></div></div>` },
          { h: 'Followers', num: true, sort: 'followers', f: ({ x }) => { const f = followersFrom(x.evidence); return f ? num(f.count) : '—'; } },
          // Engagement, the email and the status were a column each, two of
          // them empty on most rows (Blake 2026-11-25). One cell now: what
          // this row tells you, and nothing where there is nothing.
          { left: true, h: 'Signal', sort: 'engagement', f: (g) => signalCell(g) },
          ...(showProgramCol ? [{ left: true, h: 'Program', sort: 'program', f: (g) => esc(programsOf(g)) }] : []),
          { h: '', f: (g) => actions(g) },
        ], capped, anyFilter ? 'Nobody matches these filters.' : filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.', dSortSpec)
        : itemList(capped, prospectCard, filter === 'new' ? 'Nobody to review. Press Find creators.' : 'Nobody here yet.', 'grid')}
      ${listFoot}
      <div id="signupOut"></div>`, `${list.length} in this view · ${people.length} people`, 'afCreatorsList'),
    more('Recruiting tools', [
    card('Recent runs', itemList(runs, (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${openPrograms().length > 1 ? `${esc(progName(r.program_id))} · ` : ''}${esc(r.query || '—')} ${r.dry_run ? pill('dry run') : pill(runKindLabel(r), 'accent')}</div><div class="af-muted">${fmtTime(r.started_at)} · ${statusPill(r.status)}</div><div class="af-kv-line">${num(r.prospects_new)} new · ${num(r.results_returned)} results · ${num(r.emails_found)} emails${r.error ? ` · ${esc(friendlySearchError(r.error))}` : ''}</div></div></article>`, 'Discovery has not run yet.')),
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
  // The person first, their address under it: a raw channel id as the headline
  // reads as noise, and every draft starts from one template, so the whole
  // body on every row is the same text over and over (Blake 2026-11-20).
  const named = (x) => d.prospectById[x.prospect_id]?.display_name || x.recipient_email || x.recipient_handle || '—';
  const who = (x) => `${esc(named(x))}<div class="af-sub">${esc([x.recipient_email || x.recipient_handle, x.channel].filter(Boolean).join(' · ') || '—')}</div>`;
  const editing = S.editDraft ? d.drafts.find((x) => x.id === S.editDraft) : null;
  // "Via <app>": a batch an AI connection claimed (outreach:send) to send from
  // the approver's own mailbox, and a send it recorded. Null for a person.
  const batchById = Object.fromEntries((d.batches || []).map((b) => [b.id, b]));
  const viaBatch = (x) => { const b = batchById[x.batch_id]; return b?.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''; };
  // "I already sent this one myself" has to be here, on the draft, not three
  // states away: a message sent by hand outside SILO is the ordinary case,
  // and a draft nobody marks sits in this queue for weeks (Blake 2026-11-24).
  // One line per message, the way Discovery reads (audit finding 7).
  const whoCol = { left: true, h: 'Person', f: who };
  const subjCol = { left: true, h: 'Message', f: (x) => `<div class="af-sub">${esc(x.subject || '—')}</div>` };
  const draftCols = [whoCol, subjCol,
    { left: true, h: 'Drafted', f: (x) => `<span class="af-sub">${fmtDate(x.created_at)}</span>` },
    { h: '', f: (x) => (MANAGE ? `<div class="af-rowacts">${btn('Mark as sent', 'draft-sent-now', { id: x.id }, 'primary')}${btn('Edit', 'draft-edit', { id: x.id })}</div>` : '') }];
  const approvedCols = [whoCol, subjCol,
    { left: true, h: 'Approved', f: (x) => `<span class="af-sub">${fmtTime(x.approved_at)}</span>` },
    { h: '', f: (x) => (MANAGE ? `<div class="af-rowacts">${btn('Mark as sent', 'dm-sent', { id: x.id }, 'primary')}</div>` : '') }];
  const exportedCols = [whoCol,
    { left: true, h: 'Exported', f: (x) => `<div class="af-sub">${fmtTime(x.exported_at)}</div>${viaBatch(x)}` },
    { left: true, h: 'Where you sent it', f: (x) => (MANAGE ? `<input class="bcn-field" id="ev-${x.id}" placeholder="Sent-folder link, DM screenshot ref" />` : '') },
    { h: '', f: (x) => (MANAGE ? `<div class="af-rowacts">${btn('Mark as sent', 'draft-sent', { id: x.id }, 'primary')}</div>` : '') }];
  const drafts = byState('draft'); const readyAll = byState('approved'); const out = byState('exported');
  const ready = readyAll.filter((x) => !isDm(x)); const readyDm = readyAll.filter(isDm);
  const dmInfo = (x) => {
    const pr = d.prospectById[x.prospect_id] || {};
    // A customer's account lives in their evidence (never the prospect's own
    // profile_url, which feeds the identity index), so read it from there.
    const soc = pr.evidence?.social || null;
    const url = pr.profile_url || soc?.profile_url || '';
    const plat = pr.profile_url ? pr.platform : (soc?.platform || pr.platform);
    const where = url ? ext(url, `Open ${PLATFORM_NAMES[plat] || plat || 'profile'}`) : '';
    return { pr, plat, where };
  };
  const dmCols = [
    { left: true, h: 'Person', f: (x) => { const { pr, plat } = dmInfo(x); return `${esc(pr.display_name || x.recipient_handle || '—')}<div class="af-sub">${esc(PLATFORM_NAMES[plat] || plat || 'social')}${x.recipient_handle ? ` · ${esc(x.recipient_handle)}` : ''}</div>`; } },
    { left: true, h: 'Message', f: (x) => `<div class="af-evidence">${esc(dmText(x).slice(0, 160))}${dmText(x).length > 160 ? '…' : ''}</div>` },
    { h: '', f: (x) => `<div class="af-rowacts">${dmInfo(x).where}${MANAGE ? btn('Copy message', 'dm-copy', { id: x.id }, 'primary') + btn('Mark as sent', 'dm-sent', { id: x.id }) : ''}</div>` },
  ];
  const canSend = (d.aiApps || []).some((a) => a.canSend);
  // What the program has saved, unless something is typed and unsaved: the
  // template form only exists on its own chip, so switching away would
  // otherwise rebuild it from the saved row and lose the edit.
  const tpl = { ...outreachTemplate(p), ...(S.tplDraft || {}) };
  // The customer template, same buffer stance. Two templates rather than one
  // (Blake 2026-11-24): a creator is a stranger being pitched, a customer
  // already buys from you, and one message cannot be both.
  const custTpl = { ...customerOutreachTemplate(p), ...(S.custTplDraft || {}) };
  const TAGS = ['{name}', '{brand}', '{platform}', '{source}', '{commission}', '{sender}', '{signup_link}'];
  const CUST_TAGS = ['{name}', '{brand}', '{orders_line}', '{commission}', '{sender}', '{signup_link}'];
  // The emails SILO sent affiliates on its own (invites, codes, payouts).
  const NOTE_KIND = { signup_invite: 'Invite', signup_confirmation: 'Welcome', portal_link: 'Portal link', link_renewal: 'New portal link', codes_and_links: 'Codes and links', payout_status: 'Payout' };
  const noteCols = [
    { left: true, h: 'Email', f: (n) => esc(NOTE_KIND[n.kind] || String(n.kind || '').replaceAll('_', ' ')) },
    { left: true, h: 'Person', f: (n) => esc(d.affById[n.affiliate_id]?.display_name || n.to_email || '—') },
    { left: true, h: 'Status', f: (n) => `${statusPill(n.status)}${n.status !== 'sent' && n.reason ? `<div class="af-sub af-sub--bad">${esc(n.reason)}</div>` : ''}` },
    { left: true, h: 'Sent', f: (n) => `<span class="af-sub">${fmtTime(n.created_at)}</span>` },
  ];
  // Inbound: people who found the brand and applied (Blake, 2026-11-17).
  const applied = d.prospects.filter((x) => x.source === 'applied' && ['new', 'qualified'].includes(x.status));
  const appCols = [
    { left: true, h: 'Applicant', f: (x) => `${x.profile_url ? ext(x.profile_url, x.display_name || x.handle || 'Applicant') : esc(x.display_name || x.handle || 'Applicant')}<div class="af-sub">${esc([PLATFORM_NAMES[x.platform] || x.platform || '', x.handle, x.contact_email].filter(Boolean).join(' · ') || '—')}</div>` },
    { left: true, h: 'What they said', f: (x) => (x.evidence?.note || x.evidence?.pitch ? `<div class="af-evidence">${esc(String(x.evidence.note || x.evidence.pitch).slice(0, 220))}</div>` : '<span class="af-sub">—</span>') },
    { left: true, h: 'Applied', f: (x) => `<span class="af-sub">${fmtTime(x.collected_at || x.created_at)}</span>` },
    { h: '', f: (x) => (MANAGE ? `<div class="af-rowacts">${btn('Approve', 'prospect-status', { id: x.id, s: 'approved' }, 'primary')}${btn('Not a fit', 'prospect-status', { id: x.id, s: 'rejected' })}</div>` : '') },
  ];
  // One list at a time, picked from chips, as Records and Share already are
  // (Blake 2026-11-20: the tab scrolled for pages; 2026-11-25: "let's keep em
  // separate for now tab wise"). Nothing folds: a chip is a tab, and the list
  // under it is open.
  const views = [
    ['approve', 'To approve', drafts.length, () => surface('To approve', queueTable('msgs', drafts, draftCols, MANAGE ? [['Approve selected', 'q-msg-ok', 'primary'], ['Approve and export CSV', 'q-msg-export', 'surface', { confirm: true }], ['Mark as sent', 'q-msg-sent', 'surface', { confirm: true }], ['Delete selected', 'q-msg-del', 'ghost', { confirm: true }]] : [],
      { text: 'No drafts. Approving a creator drafts their message here.', go: btn('Find creators', 'go-tab', { t: 'people' }, 'primary') }), `${num(drafts.length)} draft(s)`)],
    // How these get sent stays at the top, as one small line with the Copy
    // agent prompt beside it -- not a block that pushes the queue down and
    // not buried under it (Blake 2026-11-25: "keep small instruction and copy
    // prompt up top").
    ['email', 'Send by email', ready.length, () => surface('Send by email', `<div class="af-queue-head">${aiSendBlock(d.aiApps)}${
      canSend ? '<a class="bcn-btn" href="../settings-connect-ai.html">Manage AI connections</a>' : '<a class="bcn-btn bcn-btn--primary" href="../settings-connect-ai.html">Connect your AI</a>'}${
      MANAGE && ready.length ? btn(`Export ${ready.length} as CSV`, 'outreach-export', {}, 'surface', { confirm: true }) : ''}</div>
      ${table(approvedCols, ready, { text: 'Nothing approved yet.', go: drafts.length ? btn(`Approve ${num(drafts.length)} waiting`, 'comms-tab', { k: 'approve' }, 'primary') : '' })}`, `${num(ready.length)} approved`)],
    ['dm', 'Send by DM', readyDm.length, () => surface('Send by DM', table(dmCols, readyDm, 'Nobody is waiting on a DM.'), `${num(readyDm.length)} with no email`), !readyDm.length],
    ['sent', 'Mark sent', out.length, () => surface('Mark sent', table(exportedCols, out, 'Nothing exported.'), `${num(out.length)} exported`), !out.length],
    ['inbound', 'Inbound', applied.length, () => surface('Inbound', table(appCols, applied, 'No applications waiting.'), `${num(applied.length)} applied`)],
    ['template', 'Template', 0, () => card('Message template', `${field('Subject', input('tplSubject', `${MANAGE ? '' : 'disabled'} maxlength="200" value="${esc(tpl.subject)}"`))}
      ${field('Message', `<textarea class="bcn-field" id="tplBody" rows="8" ${MANAGE ? '' : 'disabled'}>${esc(tpl.body)}</textarea>`)}
      <div class="af-set-tags">${TAGS.map((t) => `<span class="af-mono">${t}</span>`).join('')}</div>
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${btn('Save template', 'tpl-save', {}, 'primary')}${drafts.length ? btn(`Redraft ${num(drafts.length)} waiting`, 'tpl-redraft', {}, 'surface', { confirm: true }) : ''}</div>` : ''}`, 'New drafts start from this')
      + card('Message to your own customers', `<p class="af-muted">Used when you add somebody from People &gt; Your Customers. They already buy from you, so this one does not pitch them like a stranger.</p>
      ${field('Subject', input('custTplSubject', `${MANAGE ? '' : 'disabled'} maxlength="200" value="${esc(custTpl.subject)}"`))}
      ${field('Message', `<textarea class="bcn-field" id="custTplBody" rows="8" ${MANAGE ? '' : 'disabled'}>${esc(custTpl.body)}</textarea>`)}
      <div class="af-set-tags">${CUST_TAGS.map((t) => `<span class="af-mono">${t}</span>`).join('')}</div>
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${btn('Save customer template', 'cust-tpl-save', {}, 'primary')}</div>` : ''}`, 'Your Customers drafts start from this'), !hasOutreachMessage()],
    ['notices', 'Emails SILO sent', (d.notifications || []).length, () => card('Emails to affiliates', table(noteCols, (d.notifications || []).slice(0, 15), 'Nothing sent yet.'), 'Sent by SILO'), !(d.notifications || []).length],
  ].filter(([, , , , hide]) => !hide);
  // Open on what is waiting, so the first thing seen is the first thing to do.
  if (!views.some(([k]) => k === S.commsTab)) S.commsTab = (views.find(([, , n]) => n) || views[0] || [])[0] || 'approve';
  const chosenComms = views.find(([k]) => k === S.commsTab);
  const commsChips = subtabs('Outreach', views.map(([k, label, n]) => [k, label, n]), 'comms-tab', S.commsTab);
  // Sent, outcomes and export batches live on Records, not here: this
  // registers that Records group and renders nothing on Outreach.
  more('Message history', [
    card('Sent and outcomes', itemList(byState(['sent', 'replied', 'declined', 'bounced', 'signed_up']), (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${who(x)} ${statusPill(x.state)}</div><div class="af-muted">Marked ${fmtTime(x.sent_marked_at)}${x.sent_via_app ? ` · via ${esc(x.sent_via_app)}` : ''}</div>${x.sent_evidence ? `<div class="af-kv-line">${esc(x.sent_evidence)}</div>` : ''}</div>${MANAGE && x.state === 'sent' ? `<div class="af-item-foot"><div class="af-actions">${btn('Asked to stop', 'draft-optout', { id: x.id }, 'danger', { confirm: true })}</div></div>` : ''}</article>`, 'Nothing sent yet.')),
    card('Export batches', itemList(d.batches, (b) => {
      // No fingerprint means the file was never built: the messages are
      // claimed and nobody has them. Say so, and offer the download.
      const waiting = !b.fingerprint && d.drafts.some((x) => x.batch_id === b.id && x.state === 'exported');
      return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${fmtTime(b.exported_at)} · ${num(b.row_count)} row(s)</div>${b.created_by_app ? `<div class="af-muted">Via ${esc(b.created_by_app)}</div>` : ''}${waiting ? '<div class="af-muted">Not downloaded. The messages are waiting in this batch.</div>' : ''}<div class="af-mono af-copy" style="font-size:11px;margin-top:4px;">${esc(b.fingerprint || '—')}</div></div>${waiting && MANAGE ? `<div class="af-item-foot"><div class="af-actions">${btn('Download it', 'batch-finish', { id: b.id }, 'primary')}</div></div>` : ''}</article>`;
    }, 'No exports yet.')),
  ]);
  $('outreachBody').innerHTML = [
    editing ? card('Edit message', `${field('Subject', input('edSubject', `value="${esc(editing.subject || '')}"`))}${field('Message ({signup_link} is replaced at export)', `<textarea class="bcn-field" id="edBody" rows="10">${esc(editing.body || '')}</textarea>`)}<div class="af-row" style="margin-top:8px;">${btn('Save', 'draft-save', { id: editing.id }, 'primary')}${btn('Close', 'draft-edit-close')}</div>`) : '',
    commsChips,
    // The chip is the heading, so the list under it has to show its empty
    // line rather than vanish the way a stacked card does.
    chosenComms?.[3]() || `<section class="af-surface"><header class="af-surface-head"><h2>${esc(chosenComms?.[1] || 'Outreach')}</h2></header><div class="af-surface-body">${empty('Nothing waiting here.')}</div></section>`,
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
// How a prospect may be reached. A creator: email if they have one, else a
// DM. A customer: by their CURRENT email consent (re-read, not the snapshot
// taken when they were added), so somebody who has since unsubscribed is
// never given an email draft (customerContactPath). Null: no way to reach.
async function prospectContact(x) {
  if (!x) return null;
  if (x.source !== 'customer') {
    return x.contact_email ? { channel: 'email', email: x.contact_email, handle: null } : { channel: 'dm', email: null, handle: x.handle || x.profile_url };
  }
  let consent = x.evidence?.email_consent_state ?? null;
  const key = x.evidence?.customer_key;
  if (key) {
    const r = await db.from('company_customer_profiles').select('email_consent_state')
      .eq('company_entity_id', CO).eq('customer_key', key).maybeSingle();
    if (r.error) throw r.error;
    if (r.data) consent = r.data.email_consent_state;
  }
  return customerContactPath({ email_lc: x.contact_email, email_consent_state: consent }, x.evidence?.social || null, S.d?.suppressions || []);
}
// A creator with no public email is reached by a DM the person sends by hand
// (Blake, 2026-11-17: "use social or email to connect"). SILO sends nothing.
const isDm = (x) => x.channel !== 'email' || !x.recipient_email;
function dmText(x) {
  const p = prog();
  const join = p?.intake_mode === 'open' && p.slug ? applyUrl(location.origin, CO, p.slug) : "reply with your email and I'll send your invite link";
  return String(x.body || '').split('{signup_link}').join(join);
}
// Mark messages as sent by hand, from 'draft' or 'approved'. A draft that was
// never approved is approved by the same press: somebody sending a message
// themselves has made that decision, and the two facts are stamped with the
// same person and time rather than left half-recorded (Blake 2026-11-24).
async function markSentByHand(ids) {
  const stamp = new Date().toISOString();
  let n = 0;
  const failed = [];
  for (const id of ids) {
    const x = S.d.drafts.find((r) => r.id === id);
    if (!x || !['draft', 'approved'].includes(x.state)) continue;
    const plat = PLATFORM_NAMES[S.d.prospectById[x.prospect_id]?.platform] || 'social';
    const how = isDm(x) ? `Sent by DM on ${plat}` : 'Sent by email by hand';
    try {
      const rows = await updateRows('affiliate_outreach_drafts', {
        state: 'sent',
        approved_by: x.approved_by || me.id,
        approved_at: x.approved_at || stamp,
        sent_marked_by: me.id,
        sent_marked_at: stamp,
        sent_evidence: how,
      }, { id, state: x.state });
      n += rows.length;
    } catch (e) {
      failed.push(friendly(e));
    }
  }
  if (!n && failed.length) throw new Error(failed[0]);
  return n;
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
  // On People the rows are every program's; the program-level switches then
  // read as "any program has it on".
  const d = S.d; const p = companyMulti() ? null : prog();
  const on = p ? !!p.seeding_enabled : S.programs.some((x) => x.seeding_enabled);
  if (!d.seeds || (!d.seeds.length && !on)) return '';
  const order = { requested: 0, approved: 1, code_ready: 2, purchased: 3, earned: 4 };
  const rows = [...d.seeds].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  const row = (c) => {
    const v = seedView(c); const a = d.affById[c.affiliate_id];
    const m = (x) => formatMoney(x, c.currency || (progOf(c) || p)?.currency);
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
  const live = rows.filter((x) => ['approved', 'code_ready', 'purchased'].includes(x.state));
  const done = rows.filter((x) => !['requested', 'approved', 'code_ready', 'purchased'].includes(x.state));
  const meta = !p ? '' : p.seeding_enabled ? `${esc(Number(p.seed_discount_percent))}% off · sell ${esc(Number(p.seed_multiple))}×` : 'Off';
  // A product the company shared is approved as it is asked for
  // (20261120030000), so "To decide" only ever holds products an affiliate
  // named themselves.
  const sharedNote = on
    ? `<p class="af-muted">A product you shared on Share is sent as soon as it is asked for.${info('Sharing the product is the decision. Only a product an affiliate names themselves waits for you here.')}</p>`
    : '';
  const acts = MANAGE ? [['Approve selected', 'q-seed-ok', 'primary'], ['Decline selected', 'q-seed-no']] : [];
  return surface('Products', [
    sharedNote,
    asks.length ? `<h3 class="af-settings-title">They asked for · ${num(asks.length)}</h3>${queue('seeds', asks, row, acts, '')}` : '',
    live.length ? `<h3 class="af-settings-title">In progress · ${num(live.length)}</h3>${itemList(live, row)}` : '',
    done.length ? `<h3 class="af-settings-title">Finished · ${num(done.length)}</h3>${itemList(done, row)}` : '',
    rows.length ? '' : empty('Nothing yet. Affiliates ask from their portal.'),
  ].join(''), meta);
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
  const word = { approve: 'kept', use: 'bought', decline: 'marked not used' }[decision];
  return `${num(n)} ${word}.${paid ? ` ${money(paid)} in bonuses added; it pays with the next payout.` : ''}${skipped ? ` ${num(skipped)} skipped (already decided).` : ''}`;
}
// "Submitted / approved / used" read as three decisions about the same post
// (Blake 2026-11-20: "approved pending picked is a bit odd"). The states are
// unchanged in the database; on screen they say what has happened to it.
// A used post is one the brand bought (Blake 2026-11-25 mockup: "Purchased").
const CONTENT_PILL = { submitted: ['New', 'accent'], approved: ['Kept', 'accent'], used: ['Purchased', 'pos'], declined: ['Not used', ''] };
const CONTENT_FILTERS = [['new', 'New', ['submitted']], ['kept', 'Kept', ['approved']], ['paid', 'Purchased', ['used']], ['no', 'Not used', ['declined']], ['all', 'All', null]];
const CONTENT_VIEW_KEY = 'silo_af_content_view';
function readContentView() { try { return localStorage.getItem(CONTENT_VIEW_KEY) === 'list' ? 'list' : 'tiles'; } catch { return 'tiles'; } }
// What one post is, for the tile: the file, the platform's own thumbnail for
// a YouTube link, else the platform's name.
function postMedia(x, big = false) {
  const d = S.d;
  const open = big ? '' : `data-act="content-open" data-id="${esc(x.id)}"`;
  const tag = big ? 'div' : 'button';
  const attrs = big ? '' : `type="button" ${open}`;
  const st = postStats(x);
  const dur = `<span class="af-ctile-dur af-mono"${st.seconds === null ? ' hidden' : ''}>${esc(clockDuration(st.seconds))}</span>`;
  if (x.kind === 'link') {
    const plat = postPlatform(x.link_url) || 'Link';
    if (x.thumbnail_url) return `<${tag} class="af-ctile-media" ${attrs} aria-label="Open this post"><img class="af-content-media" src="${esc(x.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="af-ctile-play" aria-hidden="true">▶</span>${dur}</${tag}>`;
    return `<${tag} class="af-ctile-media af-ctile-media--none" ${attrs} aria-label="Open this post">${esc(plat)}</${tag}>`;
  }
  const u = d.contentUrl?.[x.storage_path];
  const video = /^video\//.test(x.file_type || '');
  if (!u) return `<${tag} class="af-ctile-media af-ctile-media--none" ${attrs} aria-label="Open this post">${video ? 'Video' : 'Photo'}</${tag}>`;
  return `<${tag} class="af-ctile-media" ${attrs} aria-label="Open this ${video ? 'video' : 'photo'}">${video
    ? `<video class="af-content-media" src="${esc(u)}#t=0.1" muted playsinline preload="metadata"></video><span class="af-ctile-play" aria-hidden="true">▶</span>${dur}`
    : `<img class="af-content-media" src="${esc(u)}" alt="" loading="lazy" />`}</${tag}>`;
}
// Views and engagement only where SILO measured them; blank otherwise.
function postNumbers(x) {
  const st = postStats(x);
  const parts = [st.views !== null ? `${compactCount(st.views)} views` : '', st.eng !== null ? `${(st.eng * 100).toFixed(1)}% eng.` : ''].filter(Boolean);
  return parts.join(' · ');
}
const postWho = (x) => S.d.affById[x.affiliate_id];
const postHandle = (a) => (a?.handle ? `@${String(a.handle).replace(/^@/, '')}` : '');
// What the post can still have done to it, by the server's own rules.
function postMoney(x) {
  const p = prog(); const bonus = Number(p.content_bonus_cents || 0);
  const live = ['submitted', 'approved'].includes(x.state);
  return { bonus, live, canBuy: MANAGE && live && (!bonus || MONEY), canOffer: MANAGE && MONEY && live, open: offerOpen(x) };
}
function postStatePill(x) {
  if (x.state === 'used' && x.bonus_cents) return pill(`✓ Purchased ${formatMoney(x.bonus_cents, x.currency)}`, 'pos');
  if (offerOpen(x)) return pill(`Offered ${formatMoney(x.offer_cents, x.offer_currency)}`, 'warn');
  const [label, tone] = CONTENT_PILL[x.state] || [x.state, ''];
  return pill(label, tone);
}
function postButtons(x) {
  const m = postMoney(x);
  return [
    m.canBuy && m.bonus ? btn(`Buy ${money(m.bonus)}`, 'content-decide', { id: x.id, k: 'use' }, 'primary', { confirm: true }) : '',
    m.canOffer ? btn(m.open ? 'Change offer' : 'Offer', 'content-offer-open', { id: x.id }, 'ghost') : '',
  ].join('');
}
// Numbers for the YouTube posts on screen, once per page load: the video's
// own public counts, read by SILO with the official API. Fail-soft: no key,
// no quota, no numbers.
async function ensureContentStats() {
  if (S.contentStatsAsked || !S.d?.content?.some((x) => postNeedsStats(x))) return;
  S.contentStatsAsked = true;
  try {
    const out = await invoke('affiliate-research', { action: 'content_stats' });
    if (!Number(out?.updated)) return;
    const ids = S.d.content.map((x) => x.id);
    const { data } = await db.from('affiliate_content_submissions').select('id, view_count, like_count, comment_count, duration_seconds, thumbnail_url, stats_at')
      .eq('company_entity_id', CO).in('id', ids.slice(0, 200));
    const byId = new Map((data || []).map((r) => [r.id, r]));
    S.d.content = S.d.content.map((x) => ({ ...x, ...(byId.get(x.id) || {}) }));
    if (S.tab === 'share' && S.shareTab === 'content') render();
  } catch { /* numbers are extra; the posts are the point */ }
}
function contentCard() {
  const d = S.d; const p = prog();
  if (!d.content) return '';
  const bonus = Number(p.content_bonus_cents || 0);
  // One tile: the post, who sent it, its numbers, where it stands. The
  // caption and the link are in the opened view (Blake 2026-11-23); the tile
  // OPENS the post rather than leaving for a new tab.
  const row = (x) => {
    const a = postWho(x);
    const nums = postNumbers(x);
    return `<article class="af-ctile" role="listitem">${postMedia(x)}
      <div class="af-ctile-txt"><div class="af-ctile-who">${listThumb({ name: a?.display_name, email: a?.contact_email }, affiliatePhotoUrl(a || {}))}<span class="af-ctile-name">${esc(postHandle(a) || a?.display_name || '—')}</span></div>
      <div class="af-ctile-nums af-mono">${nums ? esc(nums) : '&nbsp;'}</div>
      <div class="af-ctile-foot">${postStatePill(x)}<span class="af-muted">${fmtDate(x.submitted_at)}</span></div>
      ${(() => { const b = postButtons(x); return b ? `<div class="af-ctile-acts">${b}</div>` : ''; })()}</div></article>`;
  };
  const counts = Object.fromEntries(CONTENT_FILTERS.map(([k, , states]) => [k, states ? d.content.filter((x) => states.includes(x.state)).length : d.content.length]));
  // Open on whichever list has something waiting, so the first thing on
  // screen is the thing to do.
  const want = S.contentFilter || (counts.new ? 'new' : 'all');
  const states = (CONTENT_FILTERS.find(([k]) => k === want) || [])[2];
  const sortK = S.contentSort || 'new';
  const list = sortPosts(states ? d.content.filter((x) => states.includes(x.state)) : d.content, sortK);
  const chips = CONTENT_FILTERS.filter(([k]) => k === 'all' || counts[k])
    .map(([k, label]) => `<button type="button" class="bcn-btn af-filter-chip${k === want ? ' af-filter-chip--on bcn-btn--primary' : ''}" data-act="content-filter" data-f="${k}">${esc(label)} <span class="af-mono">${num(counts[k])}</span></button>`).join('');
  const sortSel = `<select class="bcn-field af-content-sort" id="contentSort" aria-label="Sort posts">${POST_SORTS.map(([k, l]) => `<option value="${k}"${k === sortK ? ' selected' : ''}>Sort: ${esc(l)}</option>`).join('')}</select>`;
  const view = S.contentView || readContentView();
  const viewTog = `<div class="af-view-toggle" role="group" aria-label="View">${[['tiles', 'Tiles'], ['list', 'List']].map(([v, label]) => `<button type="button" class="bcn-btn${view === v ? ' bcn-btn--primary' : ' bcn-btn--ghost'}" data-act="content-view" data-v="${v}" aria-pressed="${view === v}">${label}</button>`).join('')}</div>`;
  // Paying the bonus is a money decision: only payout approvers.
  const canUse = MANAGE && (!bonus || MONEY);
  const payLabel = bonus ? `Buy ${money(bonus)} each` : 'Mark as used';
  // The same rule as one post's own buttons: on a list of declined posts the
  // only thing the server will do is keep them, and a bought post is final.
  const acts = !MANAGE ? [] : [
    ...(canUse && !['paid', 'no'].includes(want) ? [[payLabel, 'q-content-use', 'primary', { confirm: bonus > 0 }]] : []),
    ...(['new', 'all', 'no'].includes(want) ? [[want === 'no' ? 'Keep after all' : 'Keep', 'q-content-ok']] : []),
    ...(!['paid', 'no'].includes(want) ? [['Not used', 'q-content-no']] : []),
  ];
  const emptyText = want === 'new' ? 'Nothing new. Affiliates post from their portal.' : 'Nothing here.';
  const cols = [
    { h: 'Post', f: (x) => `<span class="af-ctile af-ctile--row">${postMedia(x)}</span>` },
    { h: 'Creator', left: true, f: (x) => { const a = postWho(x); return `<span class="af-ctile-who">${listThumb({ name: a?.display_name, email: a?.contact_email }, affiliatePhotoUrl(a || {}))}<span>${esc(a?.display_name || '—')}${postHandle(a) ? ` <span class="af-muted">${esc(postHandle(a))}</span>` : ''}</span></span>`; } },
    { h: 'Views', num: true, f: (x) => { const v = postStats(x).views; return v === null ? '' : esc(compactCount(v)); } },
    { h: 'Eng.', num: true, f: (x) => { const e = postStats(x).eng; return e === null ? '' : `${(e * 100).toFixed(1)}%`; } },
    { h: 'Length', num: true, f: (x) => esc(clockDuration(postStats(x).seconds)) },
    { h: 'Sent', f: (x) => fmtDate(x.submitted_at) },
    { h: 'Status', f: (x) => postStatePill(x) },
    { h: '', f: (x) => `<span class="af-row-acts">${postButtons(x)}${btn('Open', 'content-open', { id: x.id }, 'ghost')}</span>` },
  ];
  const body = view === 'list'
    ? queueTable('content', shareCap(list), cols, acts, emptyText)
    : queue('content', shareCap(list), row, acts, emptyText, { grid: true });
  const meta = bonus ? `A post you buy earns ${money(bonus)}` : 'No set price for posts';
  queueMicrotask(() => { ensureContentStats(); });
  return surface('Posts from affiliates', [
    `<div class="af-filter-bar">${chips}<span class="af-filter-gap"></span>${sortSel}${viewTog}${info('Affiliates share posts from their own portal. Buy one at the program price, or offer a price for one post: they accept in their portal and it pays with their next payout. Views come from YouTube for YouTube links; other posts have no numbers SILO can read, so they stay blank.')}</div>`,
    body,
    shareMore(list.length),
  ].join(''), meta);
}
// A post on its own, big enough to actually look at, with the decisions for
// that one post. The wall is for picking which one to open; this is where a
// post is judged (Blake 2026-11-23).
function contentOpenBody(x) {
  const d = S.d;
  const a = postWho(x);
  const m = postMoney(x);
  const u = x.kind === 'link' ? null : d.contentUrl?.[x.storage_path];
  const video = /^video\//.test(x.file_type || '');
  const big = x.kind === 'link'
    ? `${x.thumbnail_url ? `<div class="af-copen-media">${postMedia(x, true)}</div>` : ''}<p>${ext(x.link_url, x.link_url)}</p>`
    : u
      ? `<div class="af-copen-media">${video
          ? `<video src="${esc(u)}" controls playsinline preload="metadata"></video>`
          : `<img src="${esc(u)}" alt="" />`}</div>`
      : `<p class="af-muted">The ${video ? 'video' : 'photo'} could not be loaded. It is still on file.</p>`;
  const act = (lbl, k, kind, opts) => btn(lbl, 'content-decide', { id: x.id, k }, kind, opts);
  // Only what the server will actually do to a post in THIS state
  // (affiliate_content_decide, 20261117050000): a declined post can only be
  // kept, a bought one is final, and one still uploading is nobody's
  // decision yet. Offering the rest made the button do nothing.
  const acts = !MANAGE ? '' : [
    ...(m.canBuy ? [act(m.bonus ? `Buy ${money(m.bonus)}` : 'Mark as used', 'use', 'primary', { confirm: m.bonus > 0 })] : []),
    ...(['submitted', 'declined'].includes(x.state) ? [act(x.state === 'declined' ? 'Keep after all' : 'Keep', 'approve')] : []),
    ...(m.live ? [act('Not used', 'decline')] : []),
  ].join('');
  const cur = prog().currency || 'USD';
  // An offer is a payment once accepted, so only payout approvers make one.
  const offerBox = !m.canOffer ? '' : `<div class="af-offer-box" id="offerBox">
      <div class="af-row">${field(m.open ? `Offer sent: ${formatMoney(x.offer_cents, x.offer_currency)}. Change it` : 'Offer a price for this post', `<div class="af-set-unit">${input('offerAmt', `inputmode="decimal" placeholder="350" value="${m.open ? esc(String(Number(x.offer_cents) / minorUnits(x.offer_currency))) : ''}"`)}<span>${esc(cur)}</span></div>`)}
      ${btn(m.open ? 'Update offer' : 'Send offer', 'content-offer', { id: x.id }, 'primary')}${m.open ? btn('Withdraw', 'content-offer-withdraw', { id: x.id }, 'ghost') : ''}</div>
      <p class="af-muted">${esc(a?.display_name || 'They')} accept${a?.display_name ? 's' : ''} or decline${a?.display_name ? 's' : ''} it in their portal. Nothing is owed until they accept; then it pays with their next payout. Keep, Not used or Buy on this post withdraws an open offer.</p></div>`;
  const offerNote = x.offer_state === 'declined' ? `<p class="af-muted">They declined the ${esc(formatMoney(x.offer_cents, x.offer_currency))} offer.</p>`
    : x.offer_state === 'accepted' ? `<p class="af-muted">They accepted the ${esc(formatMoney(x.offer_cents, x.offer_currency))} offer.</p>` : '';
  const nums = postNumbers(x);
  const st = postStats(x);
  return `${big}
    <div class="af-ctile-who" style="margin-top:10px;">${listThumb({ name: a?.display_name, email: a?.contact_email }, affiliatePhotoUrl(a || {}))}<strong>${esc(a?.display_name || '—')}</strong>${postHandle(a) ? `<span class="af-muted">${esc(postHandle(a))}</span>` : ''}${postStatePill(x)}</div>
    <div class="af-muted">${fmtDate(x.submitted_at)}${nums ? ` · <span class="af-mono">${esc(nums)}</span>` : ''}${st.seconds !== null ? ` · ${esc(clockDuration(st.seconds))}` : ''}${x.stats_source === 'youtube_api' && x.stats_at ? ` · from YouTube, ${fmtDate(x.stats_at)}` : ''}</div>
    ${x.caption ? `<p>${esc(x.caption)}</p>` : ''}
    ${offerNote}${offerBox}
    ${u ? `<p class="af-muted">${ext(u, video ? 'Open the video on its own' : 'Open the photo on its own')}</p>` : ''}
    ${dlgFoot(`${acts}${btn('Close', 'dialog-close')}`)}`;
}
async function contentOffer(id, cents) {
  const { data, error } = await db.rpc('affiliate_content_offer', { p_id: id, p_cents: cents });
  if (error) throw new Error(error.message.replace(/^affiliate_content_\w+:\s*/, ''));
  return data;
}

// ── Ask SILO, from Affiliate Studio (20261125230000) ──────────────────────
// The same Ask SILO, asked with workflow 'affiliate_studio': it knows it is on
// affiliates, reads this company's data under the asker's own RLS, and its
// usage is billed on the Affiliate Studio line. The answer names people in a
// silo-people block; each is looked up in what THIS page holds and shown as a
// row with the page's own buttons. An id the page does not hold is dropped.
// SILO suggests; every Shortlist / Not a fit / Do not contact is a press.
const ASK = { history: [], busy: false, answer: null, people: [], sources: [], error: null, customers: {} };
const ASK_WAIT_MS = 240000;
async function askSilo(question) {
  const { data: fresh } = await db.auth.getSession();
  const token = fresh?.session?.access_token;
  if (!token) throw new Error('Your sign-in has expired. Reload the page and sign in again.');
  const requestId = crypto.randomUUID ? crypto.randomUUID() : null;
  const history = [...ASK.history, { role: 'user', content: question }].slice(-8);
  const started = Date.now();
  const res = await fetch(`${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/silo-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ history, workflow: 'affiliate_studio', company_entity_id: CO, ...(requestId ? { request_id: requestId, async: true } : {}) }),
  });
  let body = await res.json().catch(() => ({}));
  let status = Number(body?.http_status) || res.status;
  // A long answer is committed to silo_chat_responses and collected by id
  // (the asker's own row under RLS), as Ask SILO itself does.
  if (res.status === 202 && body?.pending && requestId) {
    let polls = 0; let got = null;
    while (Date.now() - started < ASK_WAIT_MS) {
      await new Promise((r) => setTimeout(r, polls < 10 ? 2000 : 4000));
      polls += 1;
      const { data, error } = await db.from('silo_chat_responses').select('http_status, response').eq('request_id', requestId).maybeSingle();
      if (error) break;
      if (data?.response) { got = data; break; }
    }
    if (!got) throw new Error('This is taking longer than expected. It may still finish; ask again in a minute.');
    body = got.response; status = Number(got.http_status) || 200;
  }
  if (status < 200 || status >= 300 || body?.error) throw new Error(body?.error || `Ask SILO could not answer (${status}).`);
  if (!body?.answer) throw new Error('No answer came back. Try again.');
  return { history, body };
}
async function askRun() {
  const q = val('askQ');
  if (!q || ASK.busy) return;
  ASK.busy = true; ASK.error = null; renderAsk();
  try {
    const { history, body } = await askSilo(q);
    const parsed = parseSiloPeople(body.answer);
    ASK.history = [...history, { role: 'assistant', content: body.answer }];
    ASK.question = q; ASK.answer = parsed.text; ASK.people = parsed.people;
    ASK.sources = askSources(body.queries_run);
    // Customer finds are not all on the page: read just the ones named, as
    // the asker, in the active company.
    const keys = parsed.people.filter((x) => x.kind === 'customer').map((x) => x.id);
    ASK.customers = {};
    if (keys.length) {
      const { data } = await db.from('affiliate_customer_social').select('customer_key, display_name, city, platform, handle, profile_url, followers, match_score, status, review')
        .eq('company_entity_id', CO).in('customer_key', keys);
      for (const r of data || []) ASK.customers[r.customer_key] = r;
    }
    const q2 = $('askQ'); if (q2) q2.value = '';
  } catch (e) { ASK.error = friendly(e); }
  finally { ASK.busy = false; renderAsk(); }
}
// One named person, from the page's own data, or null when it holds none.
function askPerson(x) {
  const d = S.d || {};
  if (x.kind === 'affiliate') {
    const a = d.affById?.[x.id]; if (!a) return null;
    return { name: a.display_name || a.contact_email || 'Affiliate', sub: [postHandle(a), progName(a.program_id)].filter(Boolean).join(' · '), photo: affiliatePhotoUrl(a), email: a.contact_email,
      tag: pill(a.status === 'active' ? 'Affiliate' : a.status, a.status === 'active' ? 'pos' : ''), acts: btn('···', 'aff-more', { id: a.id }, 'ghost', { title: 'More' }) };
  }
  if (x.kind === 'prospect') {
    const p = d.prospectById?.[x.id]; if (!p) return null;
    const open = ['new', 'qualified'].includes(p.status);
    const off = p.status === 'suppressed';
    return { name: p.display_name || p.handle || p.contact_email || 'Creator', sub: [p.handle, p.platform, p.followers ? `${compactCount(p.followers)} followers` : ''].filter(Boolean).join(' · '),
      photo: prospectPhotoUrl(p.evidence), email: p.contact_email,
      tag: pill(off ? 'Do not contact' : p.status === 'approved' || p.status === 'invited' ? 'Shortlisted' : open ? 'To review' : p.status, off ? 'neg' : open ? 'accent' : ''),
      acts: !MANAGE || off ? '' : `${open ? `${btn('Shortlist', 'prospect-status', { id: p.id, s: 'approved', pg: p.program_id }, 'primary')}${btn('Not a fit', 'prospect-status', { id: p.id, s: 'rejected', pg: p.program_id }, 'ghost')}` : ''}${btn('···', 'prospect-more', { id: p.id }, 'ghost', { title: 'More' })}` };
  }
  const c = ASK.customers[x.id]; if (!c || c.status === 'rejected') return null;
  const off = c.review === 'suppressed';
  return { name: c.display_name || c.handle || 'Customer', sub: [c.handle, c.platform, c.followers ? `${compactCount(c.followers)} followers` : '', c.city].filter(Boolean).join(' · '), photo: null, email: null,
    tag: pill(off ? 'Do not contact' : c.review === 'shortlisted' ? 'Shortlisted' : c.review === 'not_fit' ? 'Not a fit' : 'Customer', off ? 'neg' : 'accent'),
    acts: !MANAGE || off ? '' : `${!c.review ? btn('Not a fit', 'ask-cust-notfit', { k: c.customer_key }, 'ghost') : ''}${btn('Open', 'ask-cust-open', { q: c.display_name || c.handle || '' }, 'ghost')}` };
}
// Light formatting for the answer: paragraphs, bullets and **bold**, all
// escaped first. The answer is text from the model, never markup.
function askText(t) {
  const lines = esc(t).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').split('\n');
  let html = ''; let inList = false;
  for (const l of lines) {
    const li = /^\s*[-*•]\s+(.*)$/.exec(l);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return inList ? `${html}</ul>` : html;
}
function renderAsk() {
  const el = $('askBody'); if (!el) return;
  const rows = ASK.people.map((x) => ({ x, v: askPerson(x) })).filter((r) => r.v);
  const dropped = ASK.people.length - rows.length;
  const list = rows.length ? `<div class="af-ask-rows" role="list">${rows.map(({ x, v }) => `<div class="af-ask-row" role="listitem">
      ${listThumb({ name: v.name, email: v.email }, v.photo)}
      <div class="af-ask-who"><strong>${esc(v.name)}</strong>${v.sub ? `<span class="af-muted">${esc(v.sub)}</span>` : ''}${x.why ? `<span class="af-ask-why">${esc(x.why)}</span>` : ''}</div>
      ${v.tag}<span class="af-row-acts">${v.acts}</span></div>`).join('')}</div>` : '';
  el.innerHTML = [
    ASK.busy ? '<p class="af-muted af-ask-busy">SILO is reading your data…</p>' : '',
    ASK.error ? `<p class="bcn-status bcn-status--neg">${esc(ASK.error)}</p>` : '',
    !ASK.busy && ASK.answer ? `<div class="af-ask-answer">${ASK.question ? `<p class="af-muted">${esc(ASK.question)}</p>` : ''}${askText(ASK.answer)}</div>${list}${
      dropped ? `<p class="af-muted">${num(dropped)} named ${dropped === 1 ? 'person is' : 'people are'} not on this page, so ${dropped === 1 ? 'is' : 'are'} not shown.</p>` : ''}${
      ASK.sources.length ? `<div class="af-ask-src"><span class="af-muted">Read</span>${ASK.sources.map((x) => pill(x)).join('')}</div>` : ''}
      <div class="af-ask-foot"><span class="af-muted">SILO suggests; nothing is changed until you press a button.</span>${btn('Clear', 'ask-clear', {}, 'ghost')}</div>` : '',
  ].join('');
  el.hidden = !(ASK.busy || ASK.error || ASK.answer);
  const go = $('askGo'); if (go) { go.disabled = ASK.busy; go.textContent = ASK.busy ? 'Asking…' : 'Ask'; }
}
$('askForm')?.addEventListener('submit', (ev) => { ev.preventDefault(); askRun(); });

// The one store this program sells through: its own pick, else the company's
// only store. Null means the company has several and the program has not said
// which, and then nothing is filtered -- a guess would hide real products.
function programShop() {
  const p = prog();
  const picked = Array.isArray(p?.shop_domains) ? p.shop_domains.filter(Boolean) : [];
  if (picked.length === 1) return picked[0];
  const st = Array.isArray(S.d?.stores) ? S.d.stores : [];
  return picked.length ? null : (st.length === 1 ? st[0] : null);
}
// The program store's name for a message, or a plain word when there is none.
const shopLabel = () => { const sh = programShop(); return sh ? storeName(sh) : 'this program\u2019s store'; };
// Search the PROGRAM STORE'S OWN product list, not the company-wide one.
// The same product carries a different handle in different stores -- the main
// store calls 6432 Men's `6432-t-shirt` while the retail stores call it
// `6432` -- and a product code can only be made against the handle its own
// store uses. `products_master` is one row per company and keeps whichever
// handle it saw, so searching it offers handles the program's store cannot
// make a code for, and filtering it by this store hides products the store
// really does sell (Blake 2026-11-20). Drafts and archived products are left
// out: their pages are not public, so a share of one is a dead link.
// Returns null when the store's list cannot be used, and the caller then
// searches the company-wide one as before.
async function storeProducts(shop, like) {
  const { data, error } = await db.from('shopify_product_skus')
    .select('product_title, product_handle')
    .eq('company_entity_id', CO).eq('shop_domain', shop)
    .or('shopify_status.eq.active,shopify_status.is.null')
    .ilike('product_title', like).limit(400);
  // A failed read is not an empty store.
  if (error) return null;
  if (!data || !data.length) {
    // Nothing matched here. Either this store sells none of them or SILO has
    // not read its catalog yet, and only the second earns the fallback, so
    // ask whether the shop has any product row at all.
    const seen = await db.from('shopify_product_skus').select('product_handle')
      .eq('company_entity_id', CO).eq('shop_domain', shop).limit(1);
    return (seen.error || !seen.data || !seen.data.length) ? null : [];
  }
  const seen = new Set();
  return data
    .filter((x) => /^[A-Za-z0-9_.-]+$/.test(x.product_handle || '') && !seen.has(x.product_handle) && seen.add(x.product_handle))
    .map((x) => ({ product_title: x.product_title || x.product_handle, shopify_handle: x.product_handle }));
}
// The store's list carries no picture, so borrow one from the company-wide
// list where the handles agree. No picture is not a reason to hide a product.
async function withProductImages(rows) {
  if (!rows.length) return rows;
  const { data, error } = await db.from('products_master').select('shopify_handle, image_url, product_type')
    .eq('company_entity_id', CO).in('shopify_handle', rows.map((x) => x.shopify_handle));
  if (error || !data) return rows;
  const by = new Map();
  for (const x of data) if (!by.has(x.shopify_handle) || (!by.get(x.shopify_handle).image_url && x.image_url)) by.set(x.shopify_handle, x);
  const out = rows.map((x) => ({ ...x, image_url: by.get(x.shopify_handle)?.image_url || null, product_type: by.get(x.shopify_handle)?.product_type || '' }));
  // The handle is the very thing that differs between stores, so matching on
  // it alone leaves the store's own version of a product with no picture.
  // Fall back to its title, which the two lists do agree on, for the ones
  // still bare -- a thumbnail, never anything a code is made from.
  const bare = out.filter((x) => !x.image_url && x.product_title);
  if (!bare.length) return out;
  const t = await db.from('products_master').select('product_title, image_url, product_type')
    .eq('company_entity_id', CO).in('product_title', [...new Set(bare.map((x) => x.product_title))]).not('image_url', 'is', null);
  if (t.error || !t.data?.length) return out;
  const byTitle = new Map();
  for (const x of t.data) if (!byTitle.has(x.product_title)) byTitle.set(x.product_title, x);
  for (const x of out) {
    const hit = x.image_url ? null : byTitle.get(x.product_title);
    if (hit) { x.image_url = hit.image_url; x.product_type = x.product_type || hit.product_type || ''; }
  }
  return out;
}
// ── Affiliates ───────────────────────────────────────────────────────────
// Every button an affiliate's row and menu can offer. Module scope so the
// More dialog can draw the same set (audit finding 2).
  // Finding 8 of the simplicity audit: the status cell was a status pill, a
  // signup line, a code line and a code state stacked four deep. One chip and
  // one mono sub-line now carry the same facts; the buttons that were mixed in
  // there live on the row and in its menu.
function affStuck(a) {
  const d = S.d;
  const codesOf = (x) => d.codes.filter((c) => c.affiliate_id === x.id);
  const from = d.prospectById[a.from_prospect_id];
    const invite = (d.notifications || []).find((n) => n.affiliate_id === a.id && n.kind === 'signup_invite');
    const canInvite = MANAGE && from?.contact_email && ['approved', 'invited'].includes(from.status) && INVITE_SOURCES.has(from.source);
    const waiting = codesOf(a).filter((c) => c.status === 'pending');
    const code = liveCodeOf(a.id);
    if (a.status === 'terminated') return { sub: a.terms_accepted_at ? 'ended' : 'ended before signing up' };
    if (!a.terms_accepted_at) {
      const sub = invite && invite.status !== 'sent' ? `invite not delivered · ${invite.reason || invite.to_email || ''}`
        : invite ? `invite sent ${fmtDate(invite.created_at)} · not signed up yet`
        : 'no invite email on record';
      return { sub, bad: !!(invite && invite.status !== 'sent'), from, act: canInvite ? btn(invite || a.status === 'invited' ? 'Resend' : 'Send invite', 'invite-send', { id: from.id }, 'primary') : '' };
    }
    const signed = `joined ${fmtDate(a.terms_accepted_at)}`;
    if (waiting.length) return { sub: `${signed} · code ${waiting[0].code} not in Shopify yet`, bad: true, act: MANAGE ? btn('Retry code', 'code-make', { id: waiting[0].id }, 'primary') : '' };
    if (!code) return { sub: `${signed} · no code`, act: MANAGE ? btn('Add code', 'aff-tool', { id: a.id, k: 'code' }, 'primary') : '' };
    const used = codesOf(a).find((c) => c.code === code)?.verified_at;
    return { sub: `${signed} · ${code} live · ${used ? 'used on an order' : 'no orders yet'}` };
}
function affSignal(a) {
  const st = affStuck(a);
  return `<div class="af-signal">${statusPill(a.status)}</div><div class="af-sub${st.bad ? ' af-sub--bad' : ''}">${esc(st.sub)}</div>`;
}
// One button -- the thing that moves this person along -- and a menu with
// everything else, the same shape Discovery uses.
function affRowActions(a) {
  if (!MANAGE) return '';
  const st = affStuck(a);
  const rest = affActions(a);
  const first = st.act || (['active', 'paused'].includes(a.status) ? btn('Portal link', 'portal-link', { id: a.id }) : '');
  const menu = btn('···', 'aff-more', { id: a.id }, 'ghost', { title: `More for ${a.display_name || 'this affiliate'}`, cls: 'af-more-btn' });
  if (!first && !rest) return '';
  return `<div class="af-rowacts">${first}${menu}</div>`;
}
// The one line under the chip: where this person is, in words.
const affStuckLine = (a) => affStuck(a).sub;

// Two affiliates rows are the same PERSON when they share an address; a row
// per program is how a membership is stored (see allPeople).
const sameAffiliatePerson = (x, y) => String(x.contact_email || x.id).trim().toLowerCase() === String(y.contact_email || y.id).trim().toLowerCase();
// What the More menu shows for one membership: where they are stuck, then
// every button, stacked so each is easy to hit.
const affMoreBody = (a, addProgram = true) => `${affSteps(a)}<div class="af-actions" style="flex-direction:column;align-items:stretch;">${affActions(a, addProgram).replace('<div class="af-actions">', '').replace(/<\/div>$/, '')}</div>`;
function affActions(a, addProgram = true) {
  const d = S.d;
  const codesOf = (x) => d.codes.filter((c) => c.affiliate_id === x.id);
    if (!MANAGE) return '';
    const b = [];
    if (['active', 'paused'].includes(a.status)) b.push(btn('Portal link', 'portal-link', { id: a.id }));
    if (['active', 'paused'].includes(a.status) && a.terms_accepted_at) b.push(btn('View as rep', 'view-as-rep', { id: a.id }));
    // Someone invited who never signed up (or was ended before signing up)
    // can be invited again from their own card (Blake 2026-11-18: "there is
    // no resend button"). The server re-opens an ended, never-signed-up
    // affiliate when it mints the new link.
    // Resend and Send invite now sit on the affiliate's status line (stepsOf).
    // Invite again, for one ended before signing up, stays here.
    const from = d.prospectById[a.from_prospect_id];
    if (!a.terms_accepted_at && a.status === 'terminated' && from?.contact_email && ['approved', 'invited'].includes(from.status) && INVITE_SOURCES.has(from.source)) {
      b.push(btn('Invite again', 'invite-send', { id: from.id }, 'primary'));
    }
    if (a.status !== 'terminated') b.push(btn('Add code', 'aff-tool', { id: a.id, k: 'code' }), btn('Add link', 'aff-tool', { id: a.id, k: 'link' }));
    // One affiliate per company, in any program (Blake 2026-11-17).
    if (addProgram && ['active', 'paused'].includes(a.status) && S.programs.some((x) => x.id !== a.program_id && x.status === 'active')) b.push(btn('Add to program', 'aff-tool', { id: a.id, k: 'program' }));
    if (a.status === 'active') b.push(btn('Pause', 'affiliate-status', { id: a.id, s: 'paused' }));
    if (a.status === 'paused') b.push(btn('Resume', 'affiliate-status', { id: a.id, s: 'active' }));
    if (a.status !== 'terminated') b.push(btn('End', 'affiliate-status', { id: a.id, s: 'terminated' }, 'danger', { confirm: true }));
    return `<div class="af-actions">${b.join('')}</div>`;
  }

function affSteps(a) {
  const d = S.d;
  const codesOf = (x) => d.codes.filter((c) => c.affiliate_id === x.id);
    // Where this person is stuck, and the one thing that unsticks them
    // (Blake 2026-11-18: "one place to see invite sent, accepted, code
    // active, or code failed", with the next action right there).
    const from = d.prospectById[a.from_prospect_id];
    const invite = (d.notifications || []).find((n) => n.affiliate_id === a.id && n.kind === 'signup_invite');
    const canInvite = MANAGE && from?.contact_email && ['approved', 'invited'].includes(from.status) && INVITE_SOURCES.has(from.source);
    const fixEmail = MANAGE && from ? btn('Fix email', 'prospect-edit', { id: from.id }, 'ghost') : '';
    const step1 = a.terms_accepted_at ? `${pill('Signed up', 'pos')} <span class="af-muted">${fmtDate(a.terms_accepted_at)}</span>`
      : a.status === 'terminated' ? pill('Ended before signing up')
      : invite && invite.status !== 'sent' ? `${pill('Invite not delivered', 'neg')} <span class="af-muted">${esc(invite.reason || invite.to_email || '')}</span>${fixEmail}${canInvite ? btn('Resend', 'invite-send', { id: from.id }) : ''}`
      : invite ? `${pill('Invite sent', 'accent')} <span class="af-muted">${fmtDate(invite.created_at)} to ${esc(invite.to_email || a.contact_email)} · not signed up yet</span>${fixEmail}${canInvite ? btn('Resend', 'invite-send', { id: from.id }) : ''}`
      : `${pill(a.status === 'invited' ? 'Invited' : 'Not signed up', 'accent')} <span class="af-muted">no invite email on record</span>${fixEmail}${canInvite ? btn(a.status === 'invited' ? 'Resend' : 'Send invite', 'invite-send', { id: from.id }) : ''}`;
    const code = liveCodeOf(a.id);
    const all = codesOf(a);
    const waiting = all.filter((c) => c.status === 'pending');
    const step2 = a.status === 'terminated' ? ''
      : code ? `${pill(`Code ${code} live`, 'pos')} <span class="af-muted">${all.find((c) => c.code === code)?.verified_at ? 'used on an order' : 'not used on an order yet'}</span>`
      : waiting.length ? `${pill(`Code ${waiting[0].code} not in Shopify yet`, 'neg')}${MANAGE ? btn('Retry code', 'code-make', { id: waiting[0].id }) : ''}`
      : a.terms_accepted_at ? `${pill('No code', 'accent')}${MANAGE ? btn('Add code', 'aff-tool', { id: a.id, k: 'code' }) : ''}` : '';
    return `<div class="af-steps">${[step1, step2].filter(Boolean).map((x) => `<div class="af-row af-step">${x}</div>`).join('')}</div>`;
  }

function renderAffiliates() {
  const d = S.d;
  const multiProg = S.programs.length > 1;
  const codesOf = (a) => d.codes.filter((c) => c.affiliate_id === a.id);
  const linksOf = (a) => d.links.filter((l) => l.affiliate_id === a.id);
  const actions = affActions;
  const stepsOf = affSteps;
  const canCode = (d.aiApps || []).some((a) => a.canCode);
  // Codes, links and programme membership are asked for in the middle of
  // the screen now (Blake 2026-11-20); see affToolBody().
  // Each membership is judged by its OWN program: its store for links, its
  // terms version. The page holds every program at once here.
  const linksBlockOf = (a) => {
    const code = liveCodeOf(a.id);
    const store = storeOf(progOf(a));
    const linkRows = [store && code ? affiliateLink(store, code, '/') : null, ...linksOf(a).map((l) => (store && code ? storeLinkFor(store, code, l.destination_url) : null) || linkUrl(l) || l.destination_url)].filter(Boolean);
    return linkRows.length ? `<div class="af-row">${btn('Copy link', 'copy-text', { t: linkRows[0] }, 'surface')}${linkRows.length > 1 ? `<span class="af-muted">+${num(linkRows.length - 1)} more in their portal</span>` : ''}</div>` : '';
  };
  const codesHtmlOf = (a) => codesOf(a).map((c) => `<span class="af-code-pill" title="${esc(fmtDate(c.starts_on))} → ${c.ends_on ? esc(fmtDate(c.ends_on)) : 'open'}">${esc(c.code)}${c.status === 'pending' ? ' · waiting' : c.verified_at ? '' : ' · new'}</span>`).join('') || '<span class="af-muted">No codes</span>';
  const termsOf = (a) => (a.terms_version_accepted ? `Terms v${a.terms_version_accepted}${a.terms_version_accepted < (progOf(a)?.terms_version ?? 0) ? ' · update pending' : ''}` : 'Terms not accepted');
  const affiliateRow = (a) => {
    const terms = termsOf(a);
    const steps = stepsOf(a);
    const codesHtml = codesHtmlOf(a);
    const linksBlock = linksBlockOf(a);
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
      ${steps}
      <div class="af-codes">${codesHtml}</div>
      ${linksBlock ? `<div class="af-catalog-links">${linksBlock}</div>` : ''}
      <footer class="af-item-foot af-catalog-foot">${affRowActions(a)}</footer>
    </article>`;
  };
  // Ended affiliates are archived out of the main list (Blake 2026-11-18:
  // "archive terminated or ended"). Nothing is deleted; Ended shows them.
  //
  // One card per PERSON (a membership is an affiliates row per program, the
  // same address in each): a block per program they are in. A person has
  // ended when every membership has.
  const persons = allPeople(d);
  const endedP = persons.filter((x) => x.rows.every((a) => a.status === 'terminated'));
  const currentP = persons.filter((x) => !endedP.includes(x));
  const showEnded = S.affFilter === 'ended' && endedP.length > 0;
  const shownP = (showEnded ? endedP : currentP).map((x) => ({ ...x, all: x.rows, rows: showEnded ? x.rows : x.rows.filter((a) => a.status !== 'terminated') }));
  const ended = d.affiliates.filter((a) => a.status === 'terminated');
  const affShown = shownP.flatMap((x) => x.rows);
  const membership = (a, addProgram) => `<div class="af-allprog"><div class="af-allprog-row"><div class="af-allprog-name">${esc(progName(a.program_id))}<div class="af-muted">${esc(effRate(a))} · ${esc(termsOf(a))}</div></div>${statusPill(a.status)}</div>
      <div class="af-sub">${esc(affStuckLine(a))}</div><div class="af-codes">${codesHtmlOf(a)}</div>${linksBlockOf(a) ? `<div class="af-catalog-links">${linksBlockOf(a)}</div>` : ''}${affRowActions(a)}</div>`;
  const personCard = (x) => {
    const a = x.rows[0];
    // "Add to program" once per person, on their first live membership, and
    // only while there is an active program they are not in.
    const missing = S.programs.some((y) => y.status === 'active' && !x.all.some((r) => r.program_id === y.id));
    const addOn = missing ? x.rows.find((r) => ['active', 'paused'].includes(r.status))?.id : null;
    return `<article class="af-item af-item--tile af-item--catalog" role="listitem">
      <header class="af-catalog-head">
        <div class="af-catalog-thumb">${photoAvatar({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence))}</div>
        <div class="af-catalog-title">
          <div class="af-catalog-name">${esc(a.display_name)}</div>
          <div class="af-catalog-sub">${esc(a.contact_email)}</div>
          <div class="af-catalog-meta">${num(x.rows.length)} program${x.rows.length === 1 ? '' : 's'}</div>
        </div>
      </header>
      ${x.rows.map((r) => membership(r, r.id === addOn)).join('')}
    </article>`;
  };
  const affChips = endedP.length ? [['current', 'Current', currentP.length], ['ended', 'Ended', endedP.length]].map(([f, label, n]) => `<button type="button" class="bcn-btn af-filter-chip${f === (S.affFilter === 'ended' ? 'ended' : 'current') ? ' af-filter-chip--on bcn-btn--primary' : ''}" data-act="aff-filter" data-f="${f}">${label} <span class="af-mono">${num(n)}</span></button>`).join('') : '';
  const affEmpty = S.affFilter === 'ended' ? 'No ended affiliates.' : endedP.length ? 'No current affiliates. Ended ones are under Ended.' : 'No affiliates yet. They appear here when someone you invite opens their signup link.';
  $('affiliatesBody').innerHTML = [
    surface('Affiliates', `${d.affiliates.length ? `<div class="af-ctl">${affChips}<span class="af-ctl-gap"></span>${viewToggle()}</div>` : ''}${S.view === 'list'
      ? table([
        { left: true, h: 'Affiliate', f: (a) => `<div class="af-list-who">${listThumb({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence))}<div>${esc(a.display_name)}<div class="af-muted">${esc(a.contact_email)}</div></div></div>` },
        ...(multiProg ? [{ left: true, h: 'Program', f: (a) => esc(progName(a.program_id)) }] : []),
        { left: true, h: 'Status', f: (a) => affSignal(a) },
        { left: true, h: 'Codes', f: (a) => codesOf(a).filter((c) => c.status !== 'retired').map((c) => `<span class="af-code-pill">${esc(c.code)}</span>`).join('') || '<span class="af-muted">None</span>' },
        { h: 'Links', num: true, f: (a) => num(linksOf(a).length) },
        { h: '', f: (a) => affRowActions(a) },
      ], affShown, affEmpty)
      : (multiProg ? itemList(shownP, personCard, affEmpty, 'grid') : itemList(affShown, affiliateRow, affEmpty, 'grid'))}<div id="affOut"></div>`, multiProg ? `${num(currentP.length)} ${currentP.length === 1 ? 'person' : 'people'} across ${num(S.programs.length)} programs` : `${num(d.affiliates.length - ended.length)} in this program`),
    MANAGE && S.programs.some((x) => x.status !== 'closed' && needsStore(x)) ? `<div class="bcn-status bcn-status--warn" id="storeNeeded">Add your website on Share to turn on affiliate links.</div>` : '',
    // Product requests live in Records → Products, not People (Blake
    // 2026-11-18: "shouldn't go in people and shouldn't just become giant list").
    more('Products', [seedsCard()]),
    more('Codes and links', [
      // A hundred codes as stacked cards is a scroll with nothing lined up
      // (audit finding 7). Same facts, as a table you can scan and sort.
      MANAGE ? card('All codes', table([
        { left: true, h: 'Code', sort: 'code', f: (c) => `<span class="af-mono">${esc(c.code)}</span>` },
        { left: true, h: 'Person', sort: 'who', f: (c) => `${esc(d.affById[c.affiliate_id]?.display_name || '—')}${multiProg ? `<div class="af-muted">${esc(progName(c.program_id))}</div>` : ''}` },
        { left: true, h: 'Made by', f: (c) => (c.status === 'pending' ? `${pill('waiting for Shopify', 'warn')} <span class="af-sub">${esc(Number(c.discount_percent))}% off</span>` : c.shopify_created_via_app ? `Shopify via ${esc(c.shopify_created_via_app)}` : 'You made it') },
        { left: true, h: 'Window', f: (c) => `<span class="af-sub">${fmtDate(c.starts_on)} → ${c.ends_on ? fmtDate(c.ends_on) : 'open'}</span>` },
        { left: true, h: 'Seen', f: (c) => (c.verified_at ? `<span class="af-sub">${fmtDate(c.verified_at)}</span>` : '<span class="af-muted">never</span>') },
        { h: '', f: (c) => `<div class="af-rowacts">${c.status === 'active' ? btn('Retire', 'code-retire', { id: c.id }, 'surface', { confirm: true })
          : c.status === 'pending' ? `${btn('Make in Shopify', 'code-make', { id: c.id }, 'primary')}${btn('Cancel', 'code-retire', { id: c.id }, 'surface', { confirm: true })}`
          : c.shopify_ended_at ? pill('off in Shopify')
          : c.shopify_discount_id && MANAGE ? `${pill('retired')}${btn('Turn off in Shopify', 'code-end', { id: c.id }, 'surface')}${c.shopify_end_error ? `<span class="af-muted">${esc(c.shopify_end_error)}</span>` : ''}`
          : pill('retired')}</div>` },
      ], recSortRows(d.codes, { code: (c) => String(c.code || '').toLowerCase(), who: (c) => String(d.affById[c.affiliate_id]?.display_name || '').toLowerCase() }), 'No codes yet.', recSortSpec())) : '',
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
  return shareRow(img, title, sub, action);
}
// Share is one compact list at a time (Blake 2026-11-18: "a lot of massive
// things everywhere"): a small square picture, the title, one button.
function shareRow(img, title, sub, action, extra = '') {
  return `<div class="af-srow" role="listitem">${img ? `<img class="af-srow-img" src="${esc(img)}" alt="" loading="lazy">` : '<span class="af-srow-img af-srow-noimg"></span>'}<div class="af-srow-txt"><strong>${esc(title)}</strong>${sub ? `<div class="af-muted">${esc(sub)}</div>` : ''}${extra}</div>${action ? `<div class="af-srow-act">${action}</div>` : ''}</div>`;
}
const shareList = (rows, emptyText) => {
  if (findWords().length) rows = rows.filter((h) => textHits(plainText(h)));
  return rows.length ? `<div class="af-slist" role="list">${rows.join('')}</div>` : findEmpty(emptyText);
};
// Share shows the 10 most recent of each list (Blake 2026-11-18: "max
// pagination at 10 most recent as default"); Show all opens the rest in place.
const SHARE_CAP = 10;
const shareCap = (rows) => (S.shareAll ? rows : rows.slice(0, SHARE_CAP));
const shareMore = (total) => (!S.shareAll && total > SHARE_CAP ? `<div class="af-list-foot">${btn(`Show all ${num(total)}`, 'share-all')}</div>` : '');

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
  const inProgram = (d.affiliates || []).filter((a) => a.status !== 'ended');
  const sharedAll = d.feed.filter((f) => !f.parent_source_id);
  const KIND = { launch: 'Launch', product: 'Product', ad: 'Ad' };
  // A share with nobody named is for the whole program, which is every share
  // made before 2026-11-21. Naming anyone narrows it to those people.
  // A null audience is could-not-read, not nobody-named: say what every share
  // meant before this existed, and do not offer to change what we never read,
  // because saving replaces the whole audience (review of #1350).
  const audKnown = Array.isArray(d.audience);
  const audOf = (id) => (audKnown ? d.audience.filter((x) => x.feed_item_id === id) : []);
  const who = (f) => { const n = audOf(f.id).length; return n ? `${num(n)} of ${num(inProgram.length)}` : 'Everyone'; };
  const sharedRows = sharedAll.map((f) => shareRow(f.image_url, f.title,
    `${KIND[f.kind] || ''}${f.event_on ? ` · ${fmtDate(f.event_on)}` : ''}${f.kind === 'launch' && childCount(f) ? ` · ${childCount(f)} product(s) to push` : ''} · ${esc(who(f))}`,
    MANAGE ? `${audKnown ? btn('Who sees it', 'feed-who', { id: f.id }, 'surface') : ''}${btn('Stop sharing', 'feed-remove', { id: f.id })}` : ''));
  // The store links open is picked from the program's connected Shopify
  // stores (Blake 2026-11-17), not typed. Typed only with no store connected.
  const pickable = (Array.isArray(d.stores) ? d.stores : []).filter((x) => !Array.isArray(p.shop_domains) || !p.shop_domains.length || p.shop_domains.includes(x));
  const curHost = (() => { try { return new URL(storeOf(p) || '').hostname; } catch { return ''; } })();
  const storeLine = !MANAGE ? '' : pickable.length
    ? `<div class="af-share-store"><span class="af-muted">Links open on</span><div class="af-chips-tog">${pickable.map((x) => { const on = curHost === x; return `<button type="button" class="af-chip-tog${on ? ' is-on' : ''}" data-act="store-pick" data-store="${esc(x)}" aria-pressed="${on}">${esc(storeName(x))}</button>`; }).join('')}</div>${
      curHost && !pickable.includes(curHost) ? `<span class="af-muted">Now: ${esc(curHost)}</span>` : ''}${needsStore(p) ? '<span class="bcn-status bcn-status--warn" id="storeNeeded">Pick one to turn on affiliate links.</span>' : ''}</div>`
    : `<div class="af-share-store"><div class="af-row">${field('Affiliate links open', input('storeUrl', needsStore(p) ? 'placeholder="https://www.yourstore.com"' : `value="${esc(p.store_url || storeOf(p) || '')}"`))}${btn('Save', 'store-save', {}, 'primary')}</div>${
      needsStore(p) ? '<p class="bcn-status bcn-status--warn" id="storeNeeded">Add it once to turn on affiliate links.</p>' : ''}</div>`;
  const waiting = (d.content || []).filter((x) => x.state === 'submitted').length;
  const tabs = [
    ['shared', 'Shared', sharedAll.length],
    ['content', 'From affiliates', waiting || null],
    ['launches', 'Launches', launches.length],
    ['ads', 'Ads', ads.length],
    ['products', 'Products', null],
  ];
  if (!tabs.some(([k]) => k === S.shareTab)) S.shareTab = waiting ? 'content' : 'shared';
  const chips = subtabs('Share', tabs.map(([k, label, n]) => [k, label, n]), 'share-tab', S.shareTab);
  const capped = (rows, emptyText) => `${shareList(shareCap(rows), emptyText)}${shareMore(rows.length)}`;
  const views = {
    shared: () => card('What your affiliates see', capped(sharedRows, 'Nothing shared yet. Pick from Launches, Ads or Products.'), `${num(sharedAll.length)} shared`),
    // What affiliates send in comes back through Share too (Blake 2026-11-18).
    content: () => contentCard() || card('From affiliates', empty('Content did not load. Reload the page.')),
    launches: () => card('Upcoming launches', capped(launches, 'No upcoming launches.')),
    ads: () => card('Recent ads', capped(ads, 'No recent ads with a picture.')),
    products: () => card('Products', `<div class="af-row">${field('Find a product', input('prodQ', `placeholder="Name" value="${esc(sh.q)}"`))}${btn('Search', 'prod-search', {}, 'surface')}</div>${
      products.length ? capped(products, '') : (sh.q ? empty(sh.otherStore ? `Nothing by that name in ${esc(shopLabel())}.` : 'No products match.') : '<p class="af-muted">Search to pick products.</p>')}${
      sh.otherStore ? `<p class="af-muted">${num(sh.otherStore)} match in your other stores. This program\u2019s codes are made in ${esc(shopLabel())}, so only what that store sells can be shared here \u2014 and one product can be named differently from store to store.</p>` : ''}`, '', '', shopifyMark('af-head-mark')),
  };
  $('shareBody').innerHTML = [
    storeLine,
    chips,
    views[S.shareTab](),
    sh.failed.length ? `<p class="af-muted">Could not load: ${esc(sh.failed.join(', '))}.</p>` : '',
  ].join('');
}

// ── Commissions ──────────────────────────────────────────────────────────
// "Why didn't this order count?" / "why did my balance drop?" answered on the
// page (Blake 2026-11-18): one order, the code, the eligible amount, every
// commission line and where each one went.
function orderLookupHtml() {
  const L = S.lookup;
  const form = `<div class="af-row">${field('Order number', input('olq', `placeholder="1001" value="${esc(L?.q || '')}" inputmode="numeric"`))}${btn('Look up', 'order-lookup', {}, 'surface')}${L ? btn('Clear', 'order-lookup-clear', {}, 'ghost') : ''}</div>`;
  if (!L) return card('Look up an order', form);
  if (L.loading) return card('Look up an order', `${form}<p class="af-muted">Looking…</p>`);
  if (L.error) return card('Look up an order', `${form}<p class="af-muted">${esc(L.error)}</p>`);
  const p = prog();
  if (!L.attr) {
    const o = L.order;
    const why = !o ? `SILO has no order ${esc(L.q)} yet. Orders arrive a few times a day; a very new one may not be here yet.`
      : !(o.discount_codes || []).length ? `Order ${esc(o.order_number || L.q)} used no discount code, so no affiliate is credited.`
      : `Order ${esc(o.order_number || L.q)} used ${(o.discount_codes || []).map((c) => `<span class="af-mono">${esc(c)}</span>`).join(', ')}, which is not a code in ${esc(p?.name || 'this program')}.`;
    return card('Look up an order', `${form}<p>${why}</p>`);
  }
  const a = L.attr;
  const cur = a.order_currency || p?.currency;
  const KIND = { accrual: 'Earned', refund_adjustment: 'Taken back (refund or cancellation)', manual_adjustment: 'Adjusted by hand', seed_payback: 'Product payback' };
  const PAY = { draft: 'in a draft payout', approved: 'in an approved payout', exported: 'in an exported payout', marked_paid: 'paid', paid: 'paid' };
  const kv = (k, v) => `<div class="af-kv-line"><span class="af-muted">${esc(k)}</span> ${v}</div>`;
  const lines = L.lines.length ? `<div class="af-slist" role="list">${L.lines.map((l) => `<div class="af-srow" role="listitem"><div class="af-srow-txt"><strong>${esc(KIND[l.kind] || l.kind)}</strong><div class="af-muted">${fmtDate(l.created_at)}${l.memo ? ` · ${esc(l.memo)}` : ''}</div></div><div class="af-srow-act"><span class="af-mono">${esc(formatMoney(l.amount_cents, l.currency))}</span><div class="af-muted">${esc(L.payoutOf[l.id] ? PAY[L.payoutOf[l.id]] || L.payoutOf[l.id] : 'not in a payout yet')}</div></div></div>`).join('')}</div>`
    : `<p class="af-muted">${BASIS_LABELS[a.basis]?.earns ? 'No commission yet. Commissions update every night.' : 'No commission: this order is not credited.'}</p>`;
  const total = L.lines.reduce((n, l) => n + Number(l.amount_cents || 0), 0);
  return card('Look up an order', `${form}
    <div class="af-item-head">Order <span class="af-mono">${esc(a.order_number || a.order_id)}</span> · ${fmtDate(a.order_day)} ${BASIS_LABELS[a.basis]?.earns ? pill('counted', 'pos') : pill('not counted')}</div>
    ${kv('Why', esc(basisLabel(a.basis)))}
    ${kv('Affiliate', esc(S.d.affById[a.affiliate_id]?.display_name || '—'))}
    ${kv('Code', a.matched_code ? `<span class="af-mono">${esc(a.matched_code)}</span>` : '—')}${a.codes_on_order > 1 ? kv('Codes on the order', num(a.codes_on_order)) : ''}
    ${kv('Order subtotal', esc(formatMoney(a.gross_subtotal_cents, cur)))}
    ${kv('Refunded', esc(formatMoney(a.refunded_subtotal_cents, cur)))}
    ${kv('Eligible for commission', esc(formatMoney(a.commissionable_cents, cur)))}
    <h3 class="af-settings-title" style="margin:12px 0 4px;">Commission</h3>${lines}
    ${L.lines.length ? kv('Net', `<span class="af-mono">${esc(formatMoney(total, p?.currency))}</span>`) : ''}`);
}
async function orderLookup(q) {
  const p = prog();
  q = String(q || '').trim().replace(/^#/, '');
  if (!q) return 'Type an order number.';
  S.lookup = { q, loading: true }; renderPayoutsTab({ quiet: true });
  const variants = [q, `#${q}`];
  try {
    let aq = db.from('affiliate_attributions').select('*').eq('company_entity_id', CO);
    if (!companyMulti()) aq = aq.eq('program_id', p.id);
    const { data: at, error } = await aq.in('order_number', variants).limit(1);
    if (error) throw error;
    const attr = (at || [])[0] || null;
    if (!attr) {
      const { data: o } = await db.from('shopify_orders').select('order_number, discount_codes').eq('company_entity_id', CO).in('order_number', variants).limit(1);
      S.lookup = { q, attr: null, order: (o || [])[0] || null };
    } else {
      const { data: lines, error: lErr } = await db.from('affiliate_commission_ledger').select('id, kind, amount_cents, currency, memo, created_at')
        .eq('company_entity_id', CO).eq('attribution_id', attr.id).order('created_at');
      if (lErr) throw lErr;
      const payoutOf = {};
      const ids = (lines || []).map((l) => l.id);
      if (ids.length) {
        const { data: items } = await db.from('affiliate_payout_items').select('ledger_entry_id, payout_id').eq('company_entity_id', CO).in('ledger_entry_id', ids);
        const pids = [...new Set((items || []).map((i) => i.payout_id))];
        const { data: pays } = pids.length ? await db.from('affiliate_payouts').select('id, status').eq('company_entity_id', CO).in('id', pids).neq('status', 'void') : { data: [] };
        const st = Object.fromEntries((pays || []).map((x) => [x.id, x.status]));
        for (const i of items || []) if (st[i.payout_id]) payoutOf[i.ledger_entry_id] = st[i.payout_id];
      }
      S.lookup = { q, attr, lines: lines || [], payoutOf };
    }
  } catch (e) { S.lookup = { q, error: `Could not look that up: ${e.message}` }; }
  renderPayoutsTab({ quiet: true });
  return null;
}

function commissionsBodyHtml() {
  const d = S.d; const p = prog();
  const perf = d.performance.map((r) => ({ ...r, a: d.affById[r.affiliate_id] }));
  const perfRow = (r) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(r.a?.display_name || '—')}</div><div class="af-kv-line">${num(r.attributed_orders)} credited orders · base ${formatMoney(r.commissionable_cents, r.order_currency)}${r.orders_with_unknown_base ? ` · ${num(r.orders_with_unknown_base)} unknown base` : ''}</div></div></article>`;
  const attrRow = (r) => {
    const earns = BASIS_LABELS[r.basis]?.earns;
    const base = formatMoney(r.commissionable_cents, r.order_currency);
    return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(d.affById[r.affiliate_id]?.display_name || '—')} ${earns ? pill(basisLabel(r.basis), 'pos') : pill(basisLabel(r.basis))}</div><div class="af-muted">${fmtDate(r.order_day)} · <span class="af-mono">${esc(r.order_number || r.order_id)}</span> · <span class="af-mono">${esc(r.matched_code || '—')}</span></div><div class="af-kv-line">Base ${base}${r.codes_on_order > 1 ? ` · ${r.codes_on_order} codes on order` : ''}</div></div>${r.order_number ? `<div class="af-item-foot"><div class="af-actions">${btn('Explain', 'order-explain', { q: r.order_number })}</div></div>` : ''}</article>`;
  };
  const periodRow = (x) => {
    const t = d.periodTotals.filter((r) => r.period_id === x.id);
    const total = t.length ? t.map((r) => formatMoney(r.amount_cents, r.currency)).join(', ') : formatMoney(0, p.currency);
    return `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${fmtDate(x.period_start)} → ${fmtDate(x.period_end)} ${statusPill(x.status)}</div><div class="af-kv-line">Total ${total}${x.approved_at ? ` · approved ${fmtTime(x.approved_at)}` : ''}</div></div><div class="af-item-foot"><div class="af-actions">${MANAGE && x.status === 'open' ? btn('Submit', 'period-submit', { id: x.id }, 'surface') : ''}${MONEY && x.status === 'under_review' ? btn('Approve', 'period-approve', { id: x.id }, 'primary', { confirm: true }) : ''}</div></div></article>`;
  };
  const ledgerRow = (l) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head">${esc(d.affById[l.affiliate_id]?.display_name || '—')} · ${formatMoney(l.amount_cents, l.currency)}</div><div class="af-muted">${fmtTime(l.created_at)} · ${esc(l.kind.replaceAll('_', ' '))}${l.order_id ? ` · <span class="af-mono">${esc(l.order_id)}</span>` : ''}</div>${l.memo ? `<div class="af-kv-line">${esc(l.memo)}</div>` : ''}</div></article>`;
  return [
    orderLookupHtml(),
    // The same photo leaderboard as Home when the history loaded.
    Array.isArray(d.ovAttributions) && Array.isArray(d.ovLedger) ? ovLeaderboard(ovList()) : card('By affiliate', itemList(perf, perfRow, 'No credited orders yet.'), 'Commissions update every night'),
    // The same window as Home and Money, by two calendar dates (Blake
    // 2026-11-20). These two lists are the latest 300 rows the page holds,
    // not the whole history, so the dates narrow what is here and both the
    // subtitle and the empty line keep saying so -- an older date is "not in
    // the latest 300", which is not the same as "nothing happened".
    // A table, not stacked cards (audit finding 7): same rows, lined up and
    // sortable, four to a screen instead of two.
    more('Every order', [card('Orders', `<div class="af-ctl">${rangePicker('ovo')}</div>${table([
      { left: true, h: 'Order', sort: 'order', f: (r) => `<span class="af-mono">${esc(r.order_number || r.order_id)}</span><div class="af-sub">${fmtDate(r.order_day)}</div>` },
      { left: true, h: 'Person', sort: 'who', f: (r) => esc(d.affById[r.affiliate_id]?.display_name || '—') },
      { left: true, h: 'Code', f: (r) => `<span class="af-mono">${esc(r.matched_code || '—')}</span>` },
      { left: true, h: 'Basis', f: (r) => (BASIS_LABELS[r.basis]?.earns ? pill(basisLabel(r.basis), 'pos') : pill(basisLabel(r.basis))) },
      { num: true, h: 'Base', sort: 'base', f: (r) => `${formatMoney(r.commissionable_cents, r.order_currency)}${r.codes_on_order > 1 ? `<div class="af-sub">${r.codes_on_order} codes on order</div>` : ''}` },
      { h: '', f: (r) => `<div class="af-rowacts">${r.order_number ? btn('Explain', 'order-explain', { q: r.order_number }) : ''}</div>` },
    ], recSortRows(recWindow(d.attributions, (x) => x.order_day), {
      order: (r) => String(r.order_number || r.order_id || ''),
      who: (r) => String(d.affById[r.affiliate_id]?.display_name || '').toLowerCase(),
      base: (r) => Number(r.commissionable_cents || 0),
    }), recWin().custom ? 'No orders on those dates, within the latest 300.' : 'No orders matched yet.', recSortSpec())}`, recWin().custom ? `${fmtDate(recWin().from)} – ${fmtDate(recWin().to)} · of the latest 300` : 'latest 300', '', shopifyMark('af-head-mark'))]),
    more('Periods and ledger', [
      card('Review periods', `${itemList(d.periods, periodRow, 'No periods yet.')}
      ${MANAGE ? `<div class="af-row" style="margin-top:8px;">${field('Start', input('perStart', 'type="date"'))}${field('End', input('perEnd', 'type="date"'))}${btn('Open period', 'period-add', {}, 'primary')}</div>` : ''}`),
      card('Commission ledger', `${table([
        { left: true, h: 'Person', sort: 'who', f: (l) => esc(d.affById[l.affiliate_id]?.display_name || '—') },
        { left: true, h: 'Kind', f: (l) => `${esc(l.kind.replaceAll('_', ' '))}${l.order_id ? `<div class="af-sub">${esc(l.order_id)}</div>` : ''}` },
        { left: true, h: 'When', sort: 'when', f: (l) => `<span class="af-sub">${fmtTime(l.created_at)}</span>` },
        { left: true, h: 'Why', f: (l) => (l.memo ? esc(l.memo) : '<span class="af-muted">—</span>') },
        { num: true, h: 'Amount', sort: 'amount', f: (l) => formatMoney(l.amount_cents, l.currency) },
      ], recSortRows(recWindow(d.ledger, (x) => x.order_day || x.created_at), {
        who: (l) => String(d.affById[l.affiliate_id]?.display_name || '').toLowerCase(),
        when: (l) => String(l.created_at || ''),
        amount: (l) => Number(l.amount_cents || 0),
      }), recWin().custom ? 'No commission lines on those dates, within the latest 300.' : 'No commission lines yet.', recSortSpec())}
      ${MONEY ? `<div class="af-row" style="margin-top:8px;">${field('Adjust affiliate', `<select class="bcn-field" id="adjAff">${d.affiliates.map((a) => `<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select>`)}${field(`Amount in ${esc(p.currency)}`, input('adjAmt', 'inputmode="decimal"'))}${field('Why', input('adjMemo'))}${btn('Add adjustment', 'adjust', {}, 'primary', { confirm: true })}</div>` : '<p class="af-muted">Manual adjustments need journal-entry approval.</p>'}`),
    ]),
  ].join('');
}

// ── Payouts ──────────────────────────────────────────────────────────────
function renderPayoutsTab({ quiet = false } = {}) {
  if (!SEES_MONEY) { $('payoutsBody').innerHTML = card('Money', '<p class="af-muted" id="moneyHidden">Earnings and payouts are shown to Affiliate Studio managers and finance.</p>'); return; }
  $('payoutsBody').innerHTML = `${payoutPayHtml()}<section id="commissionsBody" class="af-stack" aria-label="Commissions">${commissionsBodyHtml()}</section>`;
  // After the rows are on the page, so a settled attempt redraws over them.
  if (!quiet && payProgs().some(paysByPaypal)) checkOpenAttemptsOnce();
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
// The programs Money is about: every one on a company tab, else the one picked.
const payProgs = () => (companyMulti() ? S.programs : [prog()].filter(Boolean));
const paysByPaypal = (x) => x?.payout_method === 'paypal_payouts';
function sendablePayouts() {
  return (S.d.payouts || [])
    .filter((x) => x.method === 'paypal_payouts' && ['approved', 'exported'].includes(x.status))
    .filter((x) => sendState(x).sendable);
}

function payoutPayHtml() {
  const d = S.d; const multi = companyMulti(); const p = multi ? null : prog();
  // Each row's own program decides its currency and how it is paid.
  const progFor = (r) => progOf(r) || p;
  const curOf = (r) => progFor(r)?.currency;
  const progTag = (r) => (multi ? ` · ${esc(progName(r.program_id))}` : '');
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
      // PayPal never confirmed the attempt. Checking it is read-only, so the
      // one way to ask PayPal again is this button, with the same key.
      else if (st.blocked && MONEY && st.attempt?.state === 'unknown' && !st.attempt.provider_batch_id) b.push(btn('Retry send', 'pp-retry', { id: x.id }, 'surface', { confirm: true }));
      else if (st.blocked) { /* nothing to do here: the attempt is the answer */ }
      else if (!payConnLive(S.d.payConn)) b.push('<span class="af-muted">Connect PayPal first</span>');
      else if (!st.email) b.push('<span class="af-muted">No PayPal address from them yet</span>');
      else if (MONEY) {
        b.push(btn(st.test ? 'Test send (sandbox)' : 'Send with PayPal', 'pp-send', { id: x.id }, 'primary', { confirm: true }));
      }
    }
    if (MANAGE && x.status === 'exported' && x.export_batch_id) b.push(btn('Download again', 'payout-redownload', { batch: x.export_batch_id, pg: x.program_id }));
    // Void is one quiet button; the reason box opens only once it is pressed
    // (Blake 2026-11-18: no always-on input boxes on Money).
    if (MONEY && ['draft', 'approved', 'exported'].includes(x.status)) {
      // Opening and closing only toggles these nodes, never redraws the tab,
      // so text typed into any other box on Money survives.
      b.push(btn('Void', 'payout-void-open', { id: x.id }, 'ghost'),
        `<span class="af-void" id="vw-${x.id}" hidden><input class="bcn-field" id="vr-${x.id}" placeholder="Why void it?" aria-label="Reason to void" />${btn('Void payout', 'payout-void', { id: x.id }, 'danger', { confirm: true })}${btn('Cancel', 'payout-void-close', { id: x.id }, 'ghost')}</span>`);
    }
    return `<div class="af-actions">${b.join('')}</div>`;
  };
  const approved = d.payouts.filter((x) => x.status === 'approved');
  const paypalRail = payProgs().some(paysByPaypal);
  const byHand = payProgs().filter((x) => !paysByPaypal(x));
  const railBtns = (kind) => byHand.map((x) => btn(multi ? `Pay ${x.name} with PayPal` : 'Pay with PayPal instead', 'pp-use-rail', { pg: x.id }, kind, { confirm: true })).join('');
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
        ? card('Payout account', `<div class="af-pp-head">${paypalMark('af-pp-logo')}${pill('Not used', '')}</div><p class="af-muted">${multi ? 'Your programs pay by hand.' : 'This program pays by hand.'}</p>
          <div class="af-row" style="margin-top:8px;">${railBtns('primary')}</div>`)
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
        <div class="af-row" style="margin-top:8px;">${btn('Check connection', 'pp-test')}${btn('Check payment status', 'pp-refresh')}${MONEY ? btn('Disconnect', 'pp-disconnect', {}, 'surface', { confirm: true }) : ''}</div>${
          multi && byHand.length && MANAGE ? `<p class="af-muted">Paid by hand: ${esc(byHand.map((x) => x.name).join(', '))}</p><div class="af-row">${railBtns('surface')}</div>` : ''}`);
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
    const a = d.affById[affId];
    if (!paysByPaypal(a ? progFor(a) : p)) return '';
    return em ? `<span class="af-pp-chip" title="Paid to this PayPal">${paypalMark('af-pp-chip-logo')}<span class="af-mono">${esc(em)}</span></span>`
      : '<span class="af-pp-chip af-pp-chip--none">No PayPal email yet</span>';
  };
  const face = (a) => (a ? listThumb({ name: a.display_name, email: a.contact_email }, affiliatePhotoUrl(a, d.prospectById[a.from_prospect_id]?.evidence)) : '');
  // Owed, big; how much of what they earned is already paid, as a meter;
  // and the PayPal account it goes to (Blake 2026-11-17: visuals, logos).
  const balanceRow = (r) => {
    const earned = Number(r.earned_cents) || 0; const paidC = Number(r.paid_cents) || 0;
    const pct = earned > 0 ? Math.min(100, Math.round(paidC / earned * 100)) : 0;
    return `<article class="af-item af-item--pay" role="listitem"><div class="af-item-body"><div class="af-item-head af-list-who">${face(r.a)}<span>${esc(r.a?.display_name || '—')}</span></div>${multi ? `<div class="af-muted">${esc(progName(r.program_id))}</div>` : ''}`
      + `<div class="af-pay-owed"><span class="af-pay-owed-num">${formatMoney(r.unclaimed_cents, r.currency)}</span><span class="af-muted">owed</span></div>`
      + `<div class="af-pay-meter" role="img" aria-label="${pct}% of earnings paid"><i style="width:${pct}%"></i></div>`
      + `<div class="af-muted af-pay-meter-cap">${formatMoney(paidC, r.currency)} paid of ${formatMoney(earned, r.currency)} earned</div>${ppChip(r.affiliate_id)}</div>`
      + `<div class="af-item-foot">${MANAGE && r.currency === curOf(r) && Number(r.unclaimed_cents) > 0 ? btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'primary') : ''}</div></article>`;
  };
  const payoutRow = (x) => `<article class="af-item af-item--compact" role="listitem"><div class="af-item-body"><div class="af-item-head af-list-who">${face(d.affById[x.affiliate_id])}<span>${esc(d.affById[x.affiliate_id]?.display_name || '—')}</span> ${statusPill(x.status)}</div><div class="af-item-stats">${formatMoney(x.amount_cents, x.currency)}${x.method === 'paypal_payouts' ? paypalMark('af-pp-inline') : ''}</div><div class="af-muted">${fmtDate(x.created_at)}${progTag(x)} · ${plural(x.item_count, 'line')}${x.external_reference ? ` · ref ${esc(x.external_reference)}` : ''}${x.void_reason ? ` · ${esc(x.void_reason)}` : ''}</div>${sendLine(x)}</div><div class="af-item-foot">${act(x)}</div></article>`;
  // Export is a control of the whole list, so it sits in the header and is
  // always there: greyed with the reason when there is nothing approved
  // (audit finding 5 -- Blake could not find the payout CSV because it only
  // existed once a payout was approved, at the foot of a card).
  const exportBtn = MANAGE
    ? btn(approved.length ? `Export CSV · ${num(approved.length)}` : 'Export CSV', 'payout-export', {}, approved.length && !sendable.length ? 'primary' : 'surface',
      { confirm: !!approved.length, disabled: !approved.length, title: approved.length ? `Download ${plural(approved.length, 'approved payout')} as a CSV` : 'Nothing approved to export yet. Build a payout, approve it, and this downloads it as a CSV.' })
    : '';
  // Money opens with money (audit finding 4): what is owed, who is waiting
  // and the payouts themselves. Connecting PayPal is a one-time setup step,
  // so it sits under them -- with a chip up here while it is missing.
  const connChip = paypalRail && !live && MANAGE
    ? `<div class="bcn-status bcn-status--warn" id="payConnWanted">PayPal is not connected yet, so payouts cannot be sent. Connect it under Payout account below.</div>`
    : '';
  return [
  moneyTop(),
  connChip,
  surface('Ready to pay', table([
    { left: true, h: 'Affiliate', f: (r) => `<div class="af-list-who">${face(r.a)}<div>${esc(r.a?.display_name || '—')}${multi ? `<div class="af-muted">${esc(progName(r.program_id))}</div>` : ''}${ppChip(r.affiliate_id)}</div></div>` },
    { num: true, h: 'Owed', f: (r) => `<span class="af-pay-owed-num">${formatMoney(r.unclaimed_cents, r.currency)}</span>` },
    { left: true, h: 'Paid of earned', f: (r) => {
      const earned = Number(r.earned_cents) || 0; const paidC = Number(r.paid_cents) || 0;
      const pct = earned > 0 ? Math.min(100, Math.round(paidC / earned * 100)) : 0;
      return `<div class="af-pay-meter" role="img" aria-label="${pct}% of earnings paid"><i style="width:${pct}%"></i></div><div class="af-sub">${formatMoney(paidC, r.currency)} of ${formatMoney(earned, r.currency)}</div>`;
    } },
    { h: '', f: (r) => `<div class="af-rowacts">${MANAGE && r.currency === curOf(r) && Number(r.unclaimed_cents) > 0 ? btn('Build payout', 'payout-build', { aff: r.affiliate_id }, 'primary') : ''}</div>` },
  ], bal.filter((r) => Number(r.unclaimed_cents) > 0),
    { text: 'Nothing waiting in a payout yet.', go: btn('See credited orders', 'go-tab', { t: 'records', k: 'orders' }) }), plural(bal.length, 'affiliate')),
  d.payouts.some((x) => x.status === 'draft') ? surface('To approve', queue('payouts', d.payouts.filter((x) => x.status === 'draft'), payoutRow,
    MONEY ? [['Approve selected', 'q-payout-ok', 'primary', { confirm: true }]] : [], ''), `${num(d.payouts.filter((x) => x.status === 'draft').length)} draft(s)`) : '',
  surface('Payouts', `${itemList(d.payouts.filter((x) => x.status !== 'draft'), payoutRow, 'No payouts yet.')}
    ${MANAGE && MONEY && sendable.length ? `<div class="af-pay-actions">${
      // Pay day is one button, not one per affiliate. Each payout is still its
      // own attempt, its own idempotency key and its own row -- the loop is in
      // the page, not in the payment -- so nothing about sending twice changes.
      btn(`${sendTest ? 'Test send' : 'Send'} ${plural(sendable.length, 'approved payout')}`, 'pp-send-all', {}, 'primary', { confirm: true })
    }</div>` : ''}`, '', '', exportBtn),
  payConnCard(),
  // Build payout lives on Money (audit finding 10); this is the record, so it
  // reads rather than repeating the button.
  more('Balances', [card('All balances', table([
    { left: true, h: 'Affiliate', f: (r) => `${esc(r.a?.display_name || '—')}${multi ? `<div class="af-muted">${esc(progName(r.program_id))}</div>` : ''}` },
    { left: true, h: 'Currency', f: (r) => `<span class="af-sub">${esc(r.currency)}</span>` },
    { num: true, h: 'Earned', f: (r) => formatMoney(r.earned_cents, r.currency) },
    { num: true, h: 'Unpaid', f: (r) => formatMoney(r.unclaimed_cents, r.currency) },
    { num: true, h: 'Paid', f: (r) => formatMoney(r.paid_cents, r.currency) },
  ], bal, 'Nothing earned yet.'), 'Build a payout on Money')]),
  ].join('');
}

// ── Actions ──────────────────────────────────────────────────────────────
// A customer prospect's own variables. The creator set would fill {source}
// with "a search", which is a lie to somebody who has been buying from the
// brand for years, and has no {orders_line} at all. The order facts come off
// the prospect's evidence, which is where cust-add put them.
const customerVars = (x, p = progOf(x) || prog()) => {
  const owner = S.profiles.find((u) => u.id === p.owner_user_id);
  return {
    name: x.display_name || 'there', brand: S.brand || p.name, program: p.name,
    orders_line: customerOrdersLine({ order_count: x.evidence?.order_count ?? null }),
    commission: describeCommission({ kind: p.commission_kind, percent: p.commission_percent, fixed_cents: p.commission_fixed_cents, currency: p.currency }),
    sender: owner?.name || '',
  };
};
// Which template and which variables a prospect's draft is written from.
// Source decides it, everywhere a draft is written or rewritten, so no caller
// can pitch a customer as a stranger.
// The prospect's OWN program writes it: on People the page holds every
// program at once, and a message must never carry another program's terms.
const draftFor = (x) => {
  const p = progOf(x) || prog();
  return x?.source === 'customer'
    ? { tpl: customerOutreachTemplate(p), vars: customerVars(x, p) }
    : { tpl: outreachTemplate(p), vars: outreachVars(x, p) };
};
const outreachVars = (x, p = progOf(x) || prog()) => {
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
const ovCur = () => (companyMulti() ? mainCurrency() : (prog()?.currency || 'USD').toUpperCase());
// Every currency the company's programs are in, the most common first. Money
// is shown per currency and never summed across them, so a program in another
// currency is not silently left out of a company figure (review cycle 1).
function ovCurrencies() {
  const n = {};
  for (const x of S.programs) { const c = (x.currency || 'USD').toUpperCase(); n[c] = (n[c] || 0) + 1; }
  const list = Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b));
  return list.length ? list : [ovCur()];
}
const ovDay = (back) => dayShift(today(), back);
// 30 / 90 / any two dates. The same control heads Home, Money and Records, so
// one choice follows you between them.
// `ns` keeps each copy's fields apart: a hidden tab keeps its markup, so two
// pickers with the same id would leave the handler reading the one that is
// not on screen.
function rangePicker(ns) {
  const w = ovWindows();
  const seg = [30, 90].map((n) => btn(`${n} days`, 'ov-window', { n }, !w.custom && n === w.days ? 'dark' : 'surface')).join('');
  const from = S.ovFrom || ''; const to = S.ovTo || '';
  return `<div class="af-range">${seg}
    <input type="date" id="${ns}From" value="${esc(from)}" max="${esc(today())}" aria-label="From" />
    <span class="af-range-sep">to</span>
    <input type="date" id="${ns}To" value="${esc(to)}" max="${esc(today())}" aria-label="To" />
    ${btn('Apply', 'ov-range', { ns }, 'surface')}${w.custom ? btn('Clear', 'ov-range-clear', {}, 'ghost') : ''}</div>`;
}
// Records keeps the window Home and Money are on: a list is filtered only
// once two dates are picked, never by the 30/90 chips, because those lists
// are "the latest 300" rather than a measure of a period.
const recWin = () => ovWindows();
function recWindow(rows, dayOf) {
  const w = recWin();
  if (!w.custom) return rows || [];
  return (rows || []).filter((x) => { const d = String(dayOf(x) || '').slice(0, 10); return d && d >= w.from && d <= w.to; });
}
// The two windows the tab compares: the chosen one, and the one before it.
function ovWindows() {
  // Two calendar dates win over the 30/90 chips (Blake 2026-11-20). The
  // window before it is the same length, ending the day before `from`, so the
  // "vs previous" comparisons mean the same thing either way.
  const { from, to } = ovRange();
  if (from && to) {
    const days = Math.max(1, dayDiff(to, from) + 1);
    const prevTo = dayShift(from, 1);
    return { days, from, to, prevFrom: dayShift(prevTo, days - 1), prevTo, custom: true };
  }
  const days = S.ovDays;
  return { days, from: ovDay(days - 1), to: today(), prevFrom: ovDay(days * 2 - 1), prevTo: ovDay(days) };
}
// The custom range, only once BOTH ends are set and in order: a half-typed
// date must not silently empty every figure on the page.
function ovRange() {
  const from = String(S.ovFrom || ''); const to = String(S.ovTo || '');
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return { from: '', to: '' };
  return { from, to };
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// What the window is called, wherever a sentence names it.
const ovWindowLabel = () => {
  const w = ovWindows();
  return w.custom ? `${fmtDate(w.from)} – ${fmtDate(w.to)}` : `last ${num(w.days)} days`;
};
// Whole currency units, for the big figures. Exact amounts stay on Pay.
function moneyRound(cents, currency = null) {
  const cur = (currency || ovCur() || 'USD').toUpperCase();
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
  const rows = items.map((x) => `<div class="af-ov-ro-row"><div class="af-ov-ro-b"><div class="af-ov-why">${esc(x.text)}${x.tip ? info(x.tip) : ''}</div></div>`
    + `<div class="af-todo-acts">${x.extra || ''}${btn('Open', 'go-tab', x.rec ? { t: x.tab, k: x.rec } : { t: x.tab })}</div></div>`).join('');
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
      // Money in a list carries its cents; only the KPI tiles round (audit
      // finding 12 -- the same screen showed $44.09, $44 and $4).
      + `<div class="af-ov-money">${esc(formatMoney(x.sales, ovCur()))}<span>${esc(ovPlural(x.orders, 'order'))}</span></div>`
      + `<div class="af-ov-money af-ov-money--comm">${esc(formatMoney(x.comm, ovCur()))}<span>commission</span></div>`
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
  const d = S.d; const multi = companyMulti(); const p = multi ? null : prog();
  if (!d || (!p && !multi) || !Array.isArray(d.ovLedger)) return '';
  const cur = ovCur();
  const w = ovWindows();
  const sales = Array.isArray(d.ovAttributions) ? ovWindow(d.ovAttributions, { from: w.from, to: w.to, currency: ovCur() }) : null;
  const comm = ovLedgerTotal(d.ovLedger, { from: w.from, to: w.to, currency: ovCur() });
  const owed = ovUnpaid(d.balances, cur);
  const toPay = (d.balances || []).filter((b) => b.currency === cur && Number(b.unclaimed_cents) > 0).length;
  // Paid is counted over the SAME window as sales and commission, custom
  // range included -- not over a rolling N days of its own.
  const paidRows = (d.payouts || []).filter((x) => x.status === 'marked_paid' && x.currency === cur
    && x.marked_paid_at && String(x.marked_paid_at).slice(0, 10) >= w.from && String(x.marked_paid_at).slice(0, 10) <= w.to);
  const paid = paidRows.reduce((t, x) => t + Number(x.amount_cents || 0), 0);
  const inFlight = (d.payouts || []).filter((x) => ['draft', 'approved', 'exported'].includes(x.status) && x.currency === cur);
  const flightCents = inFlight.reduce((t, x) => t + Number(x.amount_cents || 0), 0);
  const viaPaypal = multi ? S.programs.every(paysByPaypal) : paysByPaypal(p);
  const stage = (mark, label, value, sub, tone = '') => `<div class="af-flow-step${tone ? ` af-flow-step--${tone}` : ''}"><div class="af-flow-mark">${mark}</div><div class="af-flow-lab">${esc(label)}</div><div class="af-flow-val">${value}</div><div class="af-flow-sub">${sub}</div></div>`;
  // The arrows went with the pastel tiles (audit finding 6): a KPI band
  // reads as one row without them.
  const arrow = '';
  const icon = (path) => `<svg class="af-flow-ico" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  return `<section class="af-flow" aria-label="Where the money is, last ${num(w.days)} days">
    ${stage(shopifyMark(), 'Sales from codes', sales ? esc(moneyRound(sales.sales)) : '—', sales ? `${esc(ovPlural(sales.orders, 'order'))} in Shopify` : 'Shopify')}
    ${arrow}
    ${stage(icon('<path d="M12 3v18M17 7.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5S9.2 11 12 11.5s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5"/>'), 'Commission earned', esc(moneyRound(comm)), esc(multi ? `${num(S.programs.length)} programs` : rateShort(p)), 'pos')}
    ${arrow}
    ${stage(icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), 'Owed now', esc(money(owed + 0)), `${esc(ovPlural(toPay, 'affiliate'))}${inFlight.length ? ` · ${esc(money(flightCents))} in ${esc(plural(inFlight.length, 'payout'))}` : ''}`, owed > 0 ? 'warn' : '')}
    ${arrow}
    ${stage(viaPaypal ? paypalMark() : icon('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>'), viaPaypal ? 'Paid with PayPal' : 'Paid by hand', esc(money(paid)), `${esc(ovPlural(paidRows.length, 'payout'))}`, 'accent')}
  </section><div class="af-row af-flow-note"><span style="flex:1;">${esc(w.custom ? `${fmtDate(w.from)} to ${fmtDate(w.to)}` : `Last ${num(w.days)} days`)} · owed is everything unpaid today${info('Sales, commission and paid cover the dates picked. Owed is the whole unpaid balance, whenever it was earned.')}</span>${rangePicker('ovm')}</div>`;
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
// Setup to the first invite, as one short checklist on Home (Blake
// 2026-11-18: "Get to the first invite ... checklist inside Studio"). Each
// step is read from data the page already has and carries the one press that
// does it. It goes away once someone has been invited.
function firstInviteSteps(d, p) {
  const terms = Boolean(p.terms_markdown || p.terms_file_path);
  return [
    { done: Array.isArray(d.stores) && d.stores.length > 0, text: 'Connect your Shopify store', go: '<a class="bcn-btn" href="../integrations.html">Integrations</a>' },
    { done: !needsStore(p), text: 'Add your website so affiliate links open your store', go: btn('Share', 'go-tab', { t: 'share' }) },
    { done: terms, text: 'Add your program terms', go: btn('Setup', 'go-tab', { t: 'program' }) },
    { done: p.status === 'active', text: 'Set the program to active', go: btn('Setup', 'go-tab', { t: 'program' }) },
    { done: d.prospects.length > 0 || d.affiliates.length > 0, text: 'Add your first creator', go: btn('People', 'go-tab', { t: 'prospects' }) },
    { done: d.affiliates.length > 0, text: 'Send their invite', go: btn('People', 'go-tab', { t: 'prospects' }) },
  ];
}
function firstInviteCard(d, p) {
  if (!MANAGE || d.affiliates.length) return '';
  const steps = firstInviteSteps(d, p);
  const next = steps.findIndex((x) => !x.done);
  const row = (x, i) => `<div class="af-row af-step" data-setup-step="${i}">${x.done ? pill('Done', 'pos') : pill(`${i + 1}`, i === next ? 'accent' : '')}<span${x.done ? ' class="af-muted"' : ''}>${esc(x.text)}</span>${!x.done && i === next ? x.go : ''}</div>`;
  return `<div id="firstInvite">${card('Get to your first invite', `<div class="af-steps">${steps.map(row).join('')}</div>`, `${num(steps.filter((x) => x.done).length)} of ${num(steps.length)} done`)}</div>`;
}
function renderOverview() {
  const el = $('overviewBody'); const d = S.d;
  // One layout at any number of programs (audit finding 9, 2026-11-25). The
  // company view reads every program already, so the numbers, the chart and
  // the leaderboard are the same ones summed; `p` is null and anything that
  // describes a single program leaves itself out.
  const multi = companyMulti();
  const p = multi ? null : prog();
  if (!el || !d || (!p && !multi)) return;
  if (d.all) { renderAllHome(); return; }
  if (d.ovAttributions === null || d.ovLedger === null) {
    el.innerHTML = card('Overview', `<p>The order and commission history did not load, so none of these numbers are shown. Reload, or open Affiliates and Pay for the same data.</p>${btn('Reload', 'ov-reload')}`);
    return;
  }
  const w = ovWindows();
  // One currency for a program; every currency the company's programs use for
  // the company view. Money is listed per currency, counts are the company's.
  const curs = multi ? ovCurrencies() : [ovCur()];
  const mixed = curs.length > 1;
  const win = (c, back = false) => ovWindow(d.ovAttributions, { from: back ? w.prevFrom : w.from, to: back ? w.prevTo : w.to, currency: c });
  const cur = curs.map((c) => win(c));
  const prev = curs.map((c) => win(c, true));
  const comm = curs.map((c) => ovLedgerTotal(d.ovLedger, { from: w.from, to: w.to, currency: c }));
  const commPrev = curs.map((c) => ovLedgerTotal(d.ovLedger, { from: w.prevFrom, to: w.prevTo, currency: c }));
  const sumOf = (list, k) => list.reduce((n, x) => n + Number(x[k] || 0), 0);
  const orders = sumOf(cur, 'orders'); const ordersPrev = sumOf(prev, 'orders');
  const sellers = new Set(cur.flatMap((x) => x.sellers)).size;
  const sellersPrev = new Set(prev.flatMap((x) => x.sellers)).size;
  // One figure per currency, joined -- never one number standing for two.
  const perCur = (vals) => curs.map((c, i) => moneyRound(vals[i], c)).join(' · ');
  const active = d.affiliates.filter((a) => a.status === 'active').length;
  const opt = { today: today(), weeks: OV_WEEKS, currency: ovCur() };
  // A trend line can only be drawn in one currency; it says which.
  const sparkNote = mixed ? `<span>${esc(`trend in ${ovCur()}`)}</span>` : '';
  const avgOrder = orders && !mixed ? moneyRound(cur[0].sales / cur[0].orders, curs[0]) : '';
  const metrics = [
    ovMetricCard('Sales from codes', perCur(cur.map((x) => x.sales)),
      `${mixed ? '' : ovDelta(cur[0].sales, prev[0].sales)}<span>vs previous ${num(w.days)} days</span>${sparkNote}`,
      ovSpark(ovWeekly(d.ovAttributions, { ...opt, pick: (r) => (OV_EARNING_BASES.includes(r.basis) ? Number(r.gross_subtotal_cents || 0) : 0) }), 'accent')),
    ovMetricCard('Commission earned', SEES_MONEY ? perCur(comm) : '—',
      `${mixed ? '' : ovDelta(comm[0], commPrev[0])}<span>${esc(p ? rateShort(p) : ovPlural(S.programs.length, 'program'))}</span>`,
      ovSpark(ovWeekly(d.ovLedger, { ...opt, pick: (r) => Number(r.amount_cents || 0) }), 'pos')),
    ovMetricCard('Orders', num(orders),
      `${ovDelta(orders, ordersPrev)}<span>${esc(avgOrder ? `${avgOrder} average order` : `${num(curs.length)} currencies`)}</span>`,
      ovSpark(ovWeekly(d.ovAttributions, { ...opt, pick: (r) => (OV_EARNING_BASES.includes(r.basis) ? 1 : 0) }), 'accent')),
    ovMetricCard('Selling affiliates', num(sellers),
      `${ovDelta(sellers, sellersPrev)}<span>of ${num(active)} active</span>`,
      ovSpark(ovWeeklySellers(d.ovAttributions, opt), 'warn')),
  ].join('');
  const owedLine = curs.map((c) => money(ovUnpaid(d.balances, c), c)).join(' · ');
  const liveCodes = d.codes.filter((c) => c.status === 'active').length;
  // Orders in a currency NO program of this company is in: still not counted
  // above, so the band says how many there are.
  const inScope = new Set(curs);
  const otherCur = mixed
    ? new Set((d.ovAttributions || []).filter((r) => r?.order_day && r.order_day >= w.from && r.order_day <= w.to
      && !inScope.has(String(r.order_currency || curs[0]).toUpperCase())).map((r) => r.order_id)).size
    : ovOtherCurrencyOrders(d.ovAttributions, { from: w.from, to: w.to, currency: curs[0] });
  const lastLedger = (d.ledger || [])[0]?.created_at;
  const bandItem = (lab, v) => `<div class="af-ov-bi"><div class="af-ov-bl">${esc(lab)}</div><div class="af-ov-bv">${v}</div></div>`;
  const band = '<div class="af-ov-band">'
    + bandItem('Commission unpaid', SEES_MONEY ? esc(owedLine) : '—')
    + bandItem('Codes live', `${num(liveCodes)}${d.health?.codes_never_seen ? ` · ${num(d.health.codes_never_seen)} never used` : ''}`)
    + (otherCur ? bandItem('Other currency', esc(ovPlural(otherCur, 'order'))) : '')
    + '<div class="af-ov-bsep"></div>'
    + bandItem('Commissions updated', esc(lastLedger ? fmtTime(lastLedger) : 'not yet'))
    + '</div>';
  el.innerHTML = (p ? firstInviteCard(d, p) : '')
    + `<div class="af-row"><span class="af-muted" style="flex:1;">${esc(w.custom ? `${fmtDate(w.from)} to ${fmtDate(w.to)}` : `Last ${num(w.days)} days, through today`)}</span>${rangePicker('ovh')}</div>`
    + `<div class="af-ov-metrics">${metrics}</div>`
    + band
    + `<div class="af-ov-cols"><div>${ovLeaderboard(ovList())}${ovChartCard()}</div>`
    + `<div>${p ? `${ovTodoCard()}${ovAutoCard()}` : byProgramCard()}${ovReachOutCard(ovReachList())}${aiHubOverviewSection()}</div></div>`;
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
  'new-program': async () => { S.creating = true; await goTab('program'); render(); },
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
    // No program picked means every program, which is the only thing a grant
    // could mean before 20261121210000. The field is absent until it is
    // applied, and an absent field is the same answer.
    const forProgram = $('mgrProgram') ? (val('mgrProgram') || null) : null;
    const row = { company_entity_id: CO, user_id: val('mgrUser'), granted_by: me.id };
    if (forProgram) row.program_id = forProgram;
    const r = await db.from('affiliate_program_managers').insert(row);
    // A grant they already hold is not a failure worth a Postgres message.
    if (r.error && r.error.code === '23505') throw new Error('They already have that access.');
    must(r);
    return forProgram ? 'Access granted for that program.' : 'Access granted.';
  },
  'remove-manager': async ({ id }) => { const r = must(await db.from('affiliate_program_managers').delete().eq('id', id).eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Only an owner or executive can remove access.'); return 'Access removed.'; },
  // A chip swap must not throw away what someone has typed: the editor and
  // the template live in this body and are rebuilt from the saved row.
  'comms-tab': ({ k }) => {
    if (k === S.commsTab) return null;
    if ($('tplBody')) S.tplDraft = { subject: val('tplSubject'), body: $('tplBody').value };
    if ($('custTplBody')) S.custTplDraft = { subject: val('custTplSubject'), body: $('custTplBody').value };
    S.commsTab = k;
    keepFields('outreachBody', renderOutreach);
    return null;
  },
  'rec-tab': ({ k }) => { S.recTab = k; S.recAll = false; renderRecords(); return null; },
  'share-all': () => { S.shareAll = true; renderShare(); return null; },
  // The rest of the stores, on the page beside the ones already chosen.
  'stores-all': () => { S.storesAll = true; keepFields('programBody', () => renderProgram()); return null; },
  'share-tab': ({ k }) => { S.shareTab = k; S.shareAll = false; renderShare(); return null; },
  'rec-all': () => { S.recAll = true; renderRecords(); return null; },
  'view-set': ({ v }) => { S.view = v === 'list' ? 'list' : 'tiles'; try { localStorage.setItem(VIEW_KEY, S.view); } catch { /* per-viewer convenience only */ } render(); return null; },
  'terms-file-upload': async () => {
    const p = prog(); const file = $('pTermsFile')?.files?.[0];
    if (!file) return 'Pick a PDF first.';
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return 'The agreement must be a PDF.';
    if (file.size > 10 * 1024 * 1024) return 'The agreement must be 10 MB or smaller.';
    const buf = await file.arrayBuffer();
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const path = `${p.id}/${sha}.pdf`;
    // The same file again lands on the same path: already there is fine.
    const { error: upErr } = await db.storage.from('affiliate-terms').upload(path, buf, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message || '')) throw new Error(`Upload failed: ${upErr.message}`);
    const name = String(file.name || 'Agreement.pdf').slice(0, 200);
    const { data, error } = await db.from('affiliate_programs').update({ terms_file_path: path, terms_file_name: name, terms_file_sha256: sha })
      .eq('id', p.id).eq('company_entity_id', CO).select('id, terms_version');
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error('The agreement was not saved: you may not have permission to change this program.');
    return `Agreement uploaded. It is now version ${data[0].terms_version}; new affiliates sign it.`;
  },
  'terms-file-remove': async () => {
    const p = prog();
    if (p.status === 'active' && !String(p.terms_markdown || '').trim()) return 'Write the terms below first: an active program needs something for affiliates to sign.';
    const { data, error } = await db.from('affiliate_programs').update({ terms_file_path: null, terms_file_name: null, terms_file_sha256: null })
      .eq('id', p.id).eq('company_entity_id', CO).select('id');
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error('Not removed: you may not have permission to change this program.');
    return 'Agreement removed. The written terms are what new affiliates sign.';
  },
  'terms-file-open': async () => {
    const p = prog();
    const { data, error } = await db.storage.from('affiliate-terms').createSignedUrl(p.terms_file_path, 600);
    if (error || !data?.signedUrl) throw new Error(`Could not open the agreement: ${error?.message || 'no link'}`);
    window.open(data.signedUrl, '_blank', 'noopener');
    return null;
  },
  'aff-filter': ({ f }) => { S.affFilter = f === 'ended' ? 'ended' : 'current'; keepFields('affiliatesBody', render); return null; },
  'prospect-filter': ({ f }) => { S.prospectFilter = f; S.prospectShowAll = false; S.sel.clear(); render(); scrollWorkflowTo('afCreatorsList'); return null; },
  'prospect-pick': ({ id }) => { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); render(); return null; },
  // Every prospect in the view, not only the cards on screen.
  'prospect-select-all': () => { for (const id of S.viewIds || []) S.sel.add(id); render(); return null; },
  'prospect-select-none': () => { S.sel.clear(); render(); return null; },
  'prospect-bulk': async ({ s }) => bulkProspects(pickedProspectRows(s), s),
  // Push the people ticked into another program, shortlisted there.
  'prospect-bulk-assign': async ({ to }) => {
    const p = S.programs.find((x) => x.id === to);
    if (!p) throw new Error('Pick a program first.');
    if (S.d?.supUnknown) throw new Error('The do-not-contact list could not be read, so nobody was added. Reload and try again.');
    let added = 0; let already = 0; let blocked = 0; let failed = 0;
    for (const id of S.sel) {
      const g = S.viewPeople?.[id];
      if (!g) continue;
      if (g.suppressed) { blocked += 1; continue; }
      if (g.programIds.includes(to)) { already += 1; continue; }
      try { await assignToProgram(g.x.id, to, 'approved'); added += 1; } catch { failed += 1; }
    }
    S.sel.clear();
    return `Added ${num(added)} to ${p.name}, shortlisted.${already ? ` ${num(already)} already there.` : ''}${blocked ? ` ${num(blocked)} on do not contact.` : ''}${failed ? ` ${num(failed)} could not be added.` : ''}`;
  },
  // Queues: tick one, tick all, then act on the ticked rows.
  'q-pick': ({ q, id }) => { const sel = qsel(q); if (sel.has(id)) sel.delete(id); else sel.add(id); render(); return null; },
  'q-all': ({ q }) => { const sel = qsel(q); const ids = QROWS[q] || []; if (ids.length && ids.every((id) => sel.has(id))) sel.clear(); else ids.forEach((id) => sel.add(id)); render(); return null; },
  'q-msg-ok': async () => {
    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';
    const rows = ids.map((id) => S.d.drafts.find((r) => r.id === id)).filter(Boolean);
    // One recipient the database will not let you contact must not fail the
    // whole press: the rest are approved and that one is named.
    const { moved, refused } = await moveDrafts(rows, { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, 'draft');
    qsel('msgs').clear();
    const stale = ids.length - moved.length - refused.length;
    return `${num(moved.length)} message(s) approved.${stale > 0 ? ` ${num(stale)} were no longer drafts.` : ''}${refused.length ? ` ${num(refused.length)} could not be approved: ${refused[0].why}` : ''}`;
  },
  'q-msg-del': async () => {
    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';
    const r = must(await db.from('affiliate_outreach_drafts').delete().in('id', ids).eq('state', 'draft').eq('company_entity_id', CO).select('id'));
    qsel('msgs').clear();
    return `${num(r.length)} draft(s) deleted.`;
  },
  'q-seed-ok': async () => { const ids = picked('seeds'); if (!ids.length) return 'Tick at least one.'; const m = await seedDecide(ids, true); qsel('seeds').clear(); return m; },
  'q-seed-no': async () => { const ids = picked('seeds'); if (!ids.length) return 'Tick at least one.'; const m = await seedDecide(ids, false); qsel('seeds').clear(); return m; },
  'content-filter': ({ f }) => { S.contentFilter = f; qsel('content').clear(); render(); return null; },
  'content-open': ({ id }) => { S.contentOpen = id; render(); return null; },
  'ask-clear': () => { ASK.history = []; ASK.answer = null; ASK.people = []; ASK.sources = []; ASK.error = null; renderAsk(); return null; },
  'ask-cust-notfit': async ({ k }) => { await markCustomers([k], 'not_fit'); if (ASK.customers[k]) ASK.customers[k].review = 'not_fit'; renderAsk(); return 'Marked not a fit. It is in Archive on Your customers.'; },
  'ask-cust-open': async ({ q }) => {
    S.peopleSub = 'customers'; await goTab('people');
    const box = $('studioQ'); if (box) box.value = q || ''; S.find = q || ''; render(); return null;
  },
  'content-view': ({ v }) => { S.contentView = v === 'list' ? 'list' : 'tiles'; try { localStorage.setItem(CONTENT_VIEW_KEY, S.contentView); } catch { /* per viewer only */ } render(); return null; },
  'content-offer-open': ({ id }) => { S.contentOpen = id; render(); setTimeout(() => $('offerAmt')?.focus(), 0); return null; },
  'content-offer': async ({ id }) => {
    const x = (S.d.content || []).find((y) => y.id === id);
    const cur = prog().currency || 'USD';
    const cents = parseMajorToMinor(val('offerAmt'), cur);
    if (!Number.isFinite(cents) || cents === null || cents < 1) throw new Error('Enter the amount to offer.');
    await contentOffer(id, cents);
    return `Offer of ${formatMoney(cents, cur)} sent. ${postWho(x || {})?.display_name || 'They'} can accept it in their portal.`;
  },
  'content-offer-withdraw': async ({ id }) => { await contentOffer(id, null); return 'Offer withdrawn.'; },
  // One post's own decision. Clearing what is open first means the reload the
  // dispatcher runs draws the wall, not a dialog over a post that just moved.
  'content-decide': async ({ id, k }) => { const m = await contentDecide([id], k); S.contentOpen = null; return m; },
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
    // Saved is saved: the unsaved buffer would otherwise outlive it and win
    // over what the program now holds.
    S.tplDraft = null;
    return 'Template saved. New drafts start from it.';
  },
  'cust-tpl-save': async () => {
    const { row, errors } = customerTemplateRow(val('custTplSubject'), $('custTplBody').value);
    if (errors.length) throw new Error(errors.join(' '));
    await updateRows('affiliate_programs', { ...row, changed_by: me.id }, { id: S.programId });
    S.custTplDraft = null;
    return 'Customer template saved. Drafts from Your Customers start from it.';
  },
  // Waiting drafts re-filled from the saved template; approved ones are left alone.
  'tpl-redraft': async () => {
    const drafts = S.d.drafts.filter((x) => x.state === 'draft' && S.d.prospectById[x.prospect_id]);
    let n = 0;
    for (const x of drafts) {
      // By SOURCE, not by which Redraft button was pressed: a mixed queue
      // rewrites each draft from its own template, so redrafting after a
      // creator-template edit cannot replace a customer's message with the
      // creator pitch.
      const { tpl, vars } = draftFor(S.d.prospectById[x.prospect_id]);
      try {
        const rows = await updateRows('affiliate_outreach_drafts', { subject: fillTemplate(tpl.subject, vars), body: fillTemplate(tpl.body, vars), changed_by: me.id, updated_at: new Date().toISOString() }, { id: x.id, state: 'draft' });
        n += rows.length;
      } catch { /* approved meanwhile: left as approved */ }
    }
    return `${num(n)} draft(s) redrafted from the template.`;
  },
  'ov-window': ({ n }) => { S.ovDays = Number(n) === 90 ? 90 : 30; S.ovFrom = ''; S.ovTo = ''; render(); },
  'ov-range': async ({ ns }) => {
    const from = val(`${ns}From`); const to = val(`${ns}To`);
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) throw new Error('Pick both dates.');
    if (from > to) throw new Error('The first date comes first.');
    // Decide on the NEW range, and against what is loaded rather than what
    // the old range would have needed: a range whose own start is inside the
    // loaded history can still be compared against a period that is not
    // (June-November needs the previous December), and widening only the end
    // date does the same.
    const was = { from: S.ovFrom, to: S.ovTo };
    S.ovFrom = from; S.ovTo = to;
    const need = ovFloor();
    if (!S.ovLoadedFrom || need < S.ovLoadedFrom) {
      try { await reloadOvWindow(); } catch (e) { S.ovFrom = was.from; S.ovTo = was.to; throw e; }
    }
    render();
    return null;
  },
  'ov-range-clear': () => { S.ovFrom = ''; S.ovTo = ''; render(); return null; },
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
  // From the all-programs view into one program, on the tab asked for.
  'pick-prog': async ({ id }) => { await setProgram(id); return null; },
  // Discovery's filter row and sortable headers. The first press on a number
  // sorts biggest first, on a word A to Z; pressing it again flips it.
  'd-filter': ({ key, v }) => {
    const F = (S.dFilt ||= { plat: '', prog: '', email: false, minF: 0 });
    F[key] = key === 'email' ? v === 'true' : key === 'minF' ? Number(v) || 0 : v;
    S.sel.clear(); S.prospectShowAll = false; render(); return null;
  },
  'd-filter-clear': () => { S.dFilt = { plat: '', prog: '', email: false, minF: 0 }; S.sel.clear(); render(); return null; },
  // The filter panel is a panel, not a fold-out menu: it stays open until it
  // is closed, and it opens itself whenever a filter is on.
  // Find creators opens its two fields; it never runs a search on its own.
  'd-find-open': () => { S.dFindOpen = !(S.dFindOpen === undefined ? false : S.dFindOpen); keepFields('prospectsBody', render); return null; },
  'd-filter-open': () => {
    const F = S.dFilt || {};
    const open = S.dFiltOpen === undefined ? !!(F.plat || F.prog || F.email || F.minF) : !!S.dFiltOpen;
    S.dFiltOpen = !open;
    keepFields('prospectsBody', render);
    return null;
  },
  'rec-sort': ({ k }) => { S.recSort = S.recSort?.k === k ? { k, dir: -S.recSort.dir } : { k, dir: 1 }; render(); return null; },
  'd-sort': ({ k }) => {
    const first = ['followers', 'engagement'].includes(k) ? -1 : 1;
    S.dSort = S.dSort?.k === k ? { k, dir: -S.dSort.dir } : { k, dir: first };
    render(); return null;
  },
  'pick-program': async ({ id, t }) => {
    await flushProgramSave(); S.programId = id; S.creating = false; S.shareAll = false; S.affTool = null; S.lookup = null; S.tplDraft = null; S.custTplDraft = null; if (t) S.tab = PANEL_OF[t] || t;
    $('programSel').value = id; await loadProgramData(); render(); return null;
  },
  'go-tab': async ({ t, k }) => { if (k) { S.recTab = k; S.recAll = false; } peopleSubFor(t); await goTab(PANEL_OF[t] || t); S.creating = false; render(); workflowFocusTab(t); },
  'prospect-more': ({ id }) => { S.moreProspect = id; render(); return null; },
  'aff-more': ({ id }) => { S.moreAffiliate = id; S.affTool = null; render(); return null; },
  'people-sub': async ({ k }) => { S.peopleSub = ['discovery', 'customers'].includes(k) ? k : 'affiliates'; await goTab('people'); render(); return null; },
  // Re-ranking and paging are reads, so they return null: no status line, no
  // reload() of the whole program.
  'cust-sort': ({ k }) => { const c = custState(); c.sort = k; c.page = 0; loadCustomers(true); return null; },
  'cust-pick': ({ k }) => { const c = custState(); if (c.sel.has(k)) c.sel.delete(k); else c.sel.add(k); renderCustomers(); return null; },
  // On Find creators every find can be ticked (data-all); on All customers
  // only those SILO can reach, as before.
  'cust-select-all': ({ all } = {}) => { const c = custState(); for (const x of c.rows) if (all || customerContactPath(x, c.social[x.customer_key], S.d?.suppressions || [])) c.sel.add(x.customer_key); renderCustomers(); return null; },
  'cust-hsort': ({ k }) => {
    const c = custState();
    const first = ['customer'].includes(k) ? 1 : -1;
    c.hSort = c.hSort?.k === k ? { k, dir: -c.hSort.dir } : { k, dir: first };
    renderCustomers(); return null;
  },
  // Not a fit, or Restore ('' -- only Not a fit comes back).
  'cust-review': async ({ s: to }) => {
    const c = custState();
    const keys = [...c.sel];
    if (!keys.length) return 'Tick at least one customer.';
    const n = await markCustomers(keys, to || null);
    c.sel.clear();
    loadCustomers(true);
    if (!to) return `${num(n)} restored to the working lists.${n < keys.length ? ` ${num(keys.length - n)} were not Not a fit, so they stay.` : ''}`;
    // On All customers a ticked customer may never have been searched: there
    // is no find to mark, and the message says so rather than counting them.
    return `${num(n)} marked Not a fit and moved to Archive.${n < keys.length ? ` ${num(keys.length - n)} had no find to mark (not searched yet, or already decided).` : ''}`;
  },
  // "Not them" on every ticked find that has an account matched.
  'cust-bulk-notthem': async () => {
    const c = custState();
    const ids = [...c.sel].map((k) => c.social[k]).filter((r) => r?.id && ['found', 'below', 'no_count', 'ambiguous'].includes(r.status)).map((r) => r.id);
    if (!ids.length) return 'None of the ticked finds has an account to reject.';
    let done = 0; let failed = 0;
    for (const id of ids) { try { must(await db.rpc('affiliate_customer_social_reject', { p_id: id })); done += 1; } catch (_) { failed += 1; } }
    c.sel.clear();
    loadCustomers(true);
    return `${num(done)} marked Not them and moved to Archive. They will not be searched again.${failed ? ` ${num(failed)} could not be changed.` : ''}`;
  },
  // Do not contact: their email (and the account found) on the company's
  // do-not-contact list, the same list Discovery uses, then Archive.
  'cust-dnc': async () => {
    const c = custState();
    const keys = [...c.sel];
    if (!keys.length) return 'Tick at least one customer.';
    const byKey = new Map(c.rows.map((x) => [x.customer_key, x]));
    // Only a find whose do-not-contact entries all landed (or were already
    // there) is archived: one with nothing to list, or a refused insert,
    // stays on the working list, so the list and the archive never disagree.
    const listed = []; let failed = 0;
    for (const k of keys) {
      const x = byKey.get(k); const r = c.social[k];
      const rows = [];
      if (x?.email_lc) rows.push({ kind: 'email', value_normalized: x.email_lc });
      if (r?.profile_url) rows.push({ kind: 'profile_url', value_normalized: r.profile_url });
      if (!rows.length) { failed += 1; continue; }
      try {
        for (const row of rows) {
          const { error } = await db.from('affiliate_suppressions').insert({ ...row, company_entity_id: CO, reason: 'do_not_contact', source: 'affiliate_studio', created_by: me.id });
          if (error && error.code !== '23505') throw error;
        }
        listed.push(k);
      } catch (_) { failed += 1; }
    }
    const done = listed.length;
    if (custReview && listed.length) await markCustomers(listed, 'suppressed').catch(() => {});
    c.sel.clear();
    loadCustomers(true);
    return `${num(done)} added to the do-not-contact list and moved to Archive.${failed ? ` ${num(failed)} could not be added.` : ''}`;
  },
  'cust-select-none': () => { custState().sel.clear(); renderCustomers(); return null; },
  // Picked customers enter the SAME outreach flow a creator does: a prospect
  // row and a draft, and nothing else differs after this point. The draft is
  // written straight away (Blake 2026-11-24: "draft right away"), from the
  // program's customer template.
  //
  // Each customer is its own insert pair rather than one bulk insert, so one
  // row the database refuses -- a suppressed address, a constraint -- does not
  // discard the rest, and the count reported is what actually landed.
  'cust-add': async ({ pg } = {}) => {
    const c = custState();
    const p = openPrograms().find((x) => x.id === pg) || prog();
    if (!p) throw new Error('Pick a program first.');
    if (!c.sel.size) return 'Tick at least one customer.';
    const sup = S.d?.suppressions || [];
    // The prospects this page has loaded are the NEWEST 500, so this map
    // spares a round trip and is not the duplicate guard: a customer added
    // longer ago, or from a second tab, is not in it. The guard is
    // `affiliate_prospects_customer_identity`, and a row it refuses is
    // adopted below rather than reported as a failure.
    const pid = new Map();
    // This program's rows only: the page holds every program's on People,
    // and a customer in another program is somebody to add HERE, not reuse.
    for (const x of (S.d?.prospects || [])) {
      const e = String(x.contact_email || '').toLowerCase();
      if (e && x.source === 'customer' && x.program_id === p.id && !pid.has(e)) pid.set(e, x.id);
    }
    // A prospect whose draft is missing -- the second write of the pair
    // failed last time -- must be FINISHED on a retry, not reported as
    // already in the program. There is no transaction from the browser, so
    // resuming is what makes the pair safe to retry.
    const drafted = new Set((S.d?.drafts || []).map((x) => x.prospect_id));
    // Consent as it is NOW, not as it was when the list loaded: a sync can
    // turn somebody unsubscribed while the page is open, and they must never
    // get an email draft. A failed read stops the press (fails closed).
    const picked0 = c.rows.filter((x) => c.sel.has(x.customer_key));
    const nowConsent = new Map();
    for (let i = 0; i < picked0.length; i += 150) {
      const part = picked0.slice(i, i + 150).map((x) => x.customer_key);
      const r = await db.from('company_customer_profiles').select('customer_key, email_consent_state')
        .eq('company_entity_id', CO).in('customer_key', part);
      if (r.error) throw new Error('Could not re-check their email consent, so nothing was added. Try again.');
      for (const row of r.data || []) nowConsent.set(row.customer_key, row.email_consent_state ?? null);
    }
    // Somebody no longer on file is not added.
    const picked = picked0.filter((x) => nowConsent.has(x.customer_key))
      .map((x) => ({ ...x, email_consent_state: nowConsent.get(x.customer_key) }));
    let added = 0; let resumed = 0; let skippedSup = 0; let skippedDupe = 0; let failed = 0; let noWay = picked0.length - picked.length; let dms = 0;
    const done = [];
    for (const x of picked) {
      if (x.email_lc && customerSuppressed(x.email_lc, sup)) { skippedSup += 1; continue; }
      // The consent tag decides the path: email where it allows, otherwise a
      // DM to the matched account, which SILO never sends. Nobody
      // unsubscribed ever gets an email draft.
      const path = customerContactPath(x, c.social[x.customer_key] || null, sup);
      if (!path) { noWay += 1; continue; }
      try {
        const row = customerProspectRow({ customer: x, social: c.social[x.customer_key] || null });
        let id = pid.get(x.email_lc) || null;
        let fresh = false;
        if (!id) {
          try {
            id = must(await db.from('affiliate_prospects').insert({
              ...row, company_entity_id: CO, program_id: p.id,
              reviewed_by: me.id, reviewed_at: new Date().toISOString(), created_by: me.id, changed_by: me.id,
            }).select('id').single()).id;
            fresh = true;
          } catch (e) {
            // 23505: the identity index already holds this customer, from
            // before the loaded window or from another tab. Adopt that row,
            // so one person still ends up with one prospect and one draft.
            if (e?.code !== '23505') throw e;
            id = must(await db.from('affiliate_prospects').select('id')
              // eq, not ilike: an underscore is a LIKE wildcard and is
              // ordinary in an email address, so ilike could adopt somebody
              // else's prospect row. The column holds what this tab wrote,
              // which is already the lowercased address.
              .eq('company_entity_id', CO).eq('program_id', p.id).eq('source', 'customer')
              .eq('contact_email', x.email_lc).limit(1).maybeSingle())?.id || null;
            if (!id) throw e;
          }
        }
        pid.set(x.email_lc, id);
        if (!fresh) {
          // This customer was already a prospect. They get a message only if
          // they have none AT ALL -- not a live one, not one already sent --
          // so finishing an interrupted attempt can never be a second
          // approach to somebody who has had one. The loaded drafts answer
          // this for the common case; beyond that window, the database does.
          const has = drafted.has(id) || (must(await db.from('affiliate_outreach_drafts').select('id')
            .eq('company_entity_id', CO).eq('prospect_id', id).limit(1)) || []).length > 0;
          if (has) { drafted.add(id); skippedDupe += 1; done.push(x.customer_key); continue; }
        }
        const { tpl, vars } = draftFor({ ...row, id, program_id: p.id });
        try {
          must(await db.from('affiliate_outreach_drafts').insert({
            company_entity_id: CO, program_id: p.id, prospect_id: id, channel: path.channel,
            recipient_email: path.email, recipient_handle: path.handle,
            subject: fillTemplate(tpl.subject, vars), body: fillTemplate(tpl.body, vars), created_by: me.id,
          }));
        } catch (e) {
          // One live draft per prospect is the database's rule. Hitting it
          // means the message this press would have written is already
          // waiting, which is not a failure to report.
          if (e?.code !== '23505') throw e;
          drafted.add(id); skippedDupe += 1; done.push(x.customer_key); continue;
        }
        drafted.add(id);
        if (path.channel === 'dm') dms += 1;
        if (fresh) added += 1; else resumed += 1;
        done.push(x.customer_key);
      } catch (_) { failed += 1; }
    }
    // Everyone now in a program (new, finished, or already there) moves to
    // Shortlisted. A failure here leaves them on the working list, no worse.
    if (custReview && done.length) await markCustomers(done, 'shortlisted').catch(() => {});
    c.sel.clear();
    loadCustomers(true);
    const bits = [`${num(added)} draft${added === 1 ? '' : 's'} created in ${p.name}`];
    if (resumed) bits.push(`${num(resumed)} message${resumed === 1 ? '' : 's'} finished from an earlier attempt`);
    if (skippedDupe) bits.push(`${num(skippedDupe)} already in the program`);
    if (dms) bits.push(`${num(dms)} unsubscribed, so a DM to send by hand`);
    if (skippedSup) bits.push(`${num(skippedSup)} on your do-not-contact list`);
    if (noWay) bits.push(`${num(noWay)} with no way to reach them`);
    if (failed) bits.push(`${num(failed)} could not be added`);
    return `${bits.join(' · ')}. Approve them on Outreach.`;
  },
  // "Not them": a find that is somebody else. The database keeps the row, so
  // that customer is never searched again for this company.
  'cust-social-reject': async ({ id }) => {
    const c = custState();
    must(await db.rpc('affiliate_customer_social_reject', { p_id: id }));
    await loadSocial(c, c.rows.map((x) => x.customer_key)).catch(() => {});
    renderCustomers();
    return 'Marked as not them. They will not be searched again.';
  },
  // A press while a scan runs joins it (the function answers with the running
  // scan), so pressing twice never pays twice.
  'cust-scan': async () => {
    const c = custState();
    // Company level: no program is sent. The program is chosen only when a
    // ticked customer is added to outreach.
    const spec = customerQuerySpec(c);
    const out = await invoke('affiliate-research', {
      action: 'customer_scan', finds: c.scanCount,
      // Saved as the company's own niche words with the press (not sent
      // until the box has been read, so an unread box never clears them).
      ...(c.scanTerms === null ? {} : { terms: c.scanTerms }),
      filters: { sort: spec.sort, minOrders: spec.minOrders, consent: spec.consent, from: spec.from, to: c.to || null },
    });
    if (c.view === 'hunt') {
      const h = await readHunt(c.huntTier).catch(() => null);
      if (h) applyHunt(c, h);
    } else await loadSocial(c, c.rows.map((x) => x.customer_key)).catch(() => {});
    if (!c.scan || c.scan.status !== 'running') c.scan = { status: 'running', requested: 0, checked: 0, found: 0 };
    renderCustomers();
    pollScan();
    if (c.view === 'hunt') return out?.joined ? 'A search is already running. Its progress is below.' : 'Searching. Finds appear below as they come back.';
    return out?.joined ? 'A scan is already running. Its progress is below.' : 'Scanning. Results fill in on this list as they come back.';
  },
  'cust-filter-open': () => {
    const c = custState(); const spec = customerQuerySpec(c);
    const on = S.custFiltOpen === undefined ? custFiltersOn(c, spec).length > 0 : !!S.custFiltOpen;
    S.custFiltOpen = !on; renderCustomers(); return null;
  },
  'cust-view': ({ k }) => { const c = custState(); c.view = k === 'all' ? 'all' : 'hunt'; c.sel.clear(); c.page = 0; loadCustomers(true); return null; },
  'cust-hunt-tier': ({ k }) => { const c = custState(); c.huntTier = ['check', 'more', ...(custReview ? HUNT_DONE : [])].includes(k) ? k : 'top'; c.sel.clear(); loadCustomers(true); return null; },
  'cust-page': ({ p }) => { const c = custState(); c.page = Math.max(0, Number(p) || 0); loadCustomers(true); return null; },
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
  'aff-tool': async ({ id, k }) => {
    S.affTool = { id, k };
    // Opened from the More menu, this replaces it rather than hiding behind it.
    S.moreAffiliate = null;
    // Their other memberships, for the add-to-program dialog only. Fail-soft:
    // null is "could not read", and the dialog then behaves as it did before.
    if (k === 'program') {
      S.personProg = { id, rows: null };
      render();
      try {
        const { data, error } = await db.rpc('affiliate_person_programs', { p_affiliate: id });
        S.personProg = { id, rows: error ? null : (data || []) };
      } catch (_) { S.personProg = { id, rows: null }; }
    }
    render();
    scrollWorkflowTo('affiliatesBody');
    return null;
  },
  'aff-tool-close': () => { S.affTool = null; render(); return null; },
  'dialog-close': () => { closeDialogState(); render(); return null; },
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
  'prospect-assign': async ({ id, to }) => {
    if (S.d?.supUnknown) throw new Error('The do-not-contact list could not be read, so nobody was added. Reload and try again.');
    const p = S.programs.find((x) => x.id === to);
    await assignToProgram(id, to, 'approved');
    return `Added to ${p?.name || 'the program'} and shortlisted. Draft their message from Shortlisted.`;
  },
  'prospect-edit': ({ id }) => { S.editProspect = id; render(); scrollWorkflowTo('prospectsBody'); return null; },
  'prospect-edit-close': () => { S.editProspect = null; render(); return null; },
  'prospect-save': async ({ id }) => {
    const x = S.d.prospectById[id]; if (!x) return null;
    const row = prospectEditRow({ name: val('epName'), platform: val('epPlat'), handle: val('epHandle'), url: val('epUrl'), email: val('epEmail') }, x);
    await updateRows('affiliate_prospects', { ...row, changed_by: me.id }, { id });
    // A creator who now has an email is reached by email: their waiting
    // message moves from DM to email. Sent ones keep their history.
    let moved = 0;
    if (row.contact_email && row.contact_email !== (x.contact_email || '').toLowerCase()
      // ...unless they are a customer who unsubscribed: they stay on DM.
      && (await prospectContact({ ...x, ...row }))?.channel === 'email') {
      const r = must(await db.from('affiliate_outreach_drafts').update({ channel: 'email', recipient_email: row.contact_email })
        .eq('company_entity_id', CO).eq('prospect_id', id).in('state', ['draft', 'approved']).select('id'));
      moved = r?.length || 0;
    }
    // Someone invited who has not signed up yet gets their next invite at
    // the corrected address, and their record shows it (Fix email).
    let fixed = false;
    if (row.contact_email && row.contact_email !== (x.contact_email || '').toLowerCase()) {
      const aff = S.d.affiliates.find((a) => a.from_prospect_id === id && !a.terms_accepted_at && a.status === 'invited');
      if (aff) fixed = (await updateRows('affiliates', { contact_email: row.contact_email, changed_by: me.id }, { id: aff.id })).length > 0;
    }
    S.editProspect = null;
    return `Saved.${fixed ? ' Resend the invite to reach the new address.' : ''}${moved ? ` ${num(moved)} waiting message(s) will now go by email.` : ''}`;
  },
  'prospect-add': async () => {
    // Addresses are tidied the way people type them (instagram.com/name gets
    // https://); "Where you found them" that is not an address ("Instagram",
    // "met at a show") is kept as a note instead of failing the save
    // (Blake 2026-11-18: affiliate_prospects_source_url_check).
    const url = asWebUrl(val('mpUrl')); const handle = val('mpHandle');
    if (url === undefined) throw new Error('The profile URL should be a web address, like instagram.com/name.');
    const source = asWebUrl(val('mpSource'));
    const foundVia = source === undefined ? val('mpSource') : null;
    if (!url && !handle) throw new Error('A handle or a profile URL is needed to tell creators apart.');
    if (val('mpEmail') && !val('mpEmail').includes('@')) throw new Error('That email address is not valid.');
    // Added with an email: approved and invited at once (the invite is emailed).
    const email = val('mpEmail') || null;
    const now = new Date().toISOString();
    const row = must(await db.from('affiliate_prospects').insert({
      company_entity_id: CO, program_id: S.programId, display_name: val('mpName') || handle || url, platform: val('mpPlat'),
      handle: handle || null, profile_url: url || null, contact_email: email,
      source: 'manual', source_url: source || null, evidence: { note: val('mpNote') || null, ...(foundVia ? { found_via: foundVia } : {}), entered_by: me.email || me.id }, created_by: me.id,
      ...(email ? { status: 'approved', reviewed_by: me.id, reviewed_at: now } : {}),
    }).select('id').single());
    if (!email) return 'Prospect added.';
    return `Added. ${await sendInvite(row.id, email, 'mpOut')}`;
  },
  'research-run': async () => {
    const out = await invoke('affiliate-research', { action: 'research', program_id: S.programId, focus: $('rsFocus')?.value || '', count: Number(val('rsCount')) || 25 });
    S.findFocus = '';
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
      company_entity_id: CO, program_id: x.program_id, prospect_id: id, channel: x.contact_email ? 'email' : 'dm',
      recipient_email: x.contact_email || null, recipient_handle: x.contact_email ? null : (x.handle || x.profile_url),
      subject: null, body: 'Contacted outside SILO.', created_by: me.id, state: 'sent',
      approved_by: me.id, approved_at: at, sent_marked_by: me.id, sent_marked_at: at, sent_evidence: 'Contacted by hand',
    }));
    return 'Marked contacted.';
  },
  'draft-create': async ({ id }) => {
    // A customer prospect appears on the creators list too, so this path
    // picks its template by source as well -- and its channel by their
    // CURRENT consent: an unsubscribed customer gets a DM, never an email.
    const x = S.d.prospectById[id]; const { tpl, vars } = draftFor(x);
    const path = await prospectContact(x);
    if (!path) throw new Error('No way to reach them: no email they allow, and no account to message.');
    must(await db.from('affiliate_outreach_drafts').insert({
      company_entity_id: CO, program_id: x.program_id, prospect_id: id, channel: path.channel,
      recipient_email: path.email, recipient_handle: path.handle,
      subject: fillTemplate(tpl.subject, vars), body: fillTemplate(tpl.body, vars), created_by: me.id,
    }));
    return 'Draft created. Approve it on Outreach.';
  },
  'draft-edit': ({ id }) => { S.editDraft = id; render(); },
  'draft-edit-close': () => { S.editDraft = null; render(); },
  'draft-save': async ({ id }) => { await updateRows('affiliate_outreach_drafts', { subject: val('edSubject'), body: $('edBody').value, changed_by: me.id, updated_at: new Date().toISOString() }, { id, state: 'draft' }); S.editDraft = null; return 'Saved.'; },
  'draft-delete': async ({ id }) => { const r = must(await db.from('affiliate_outreach_drafts').delete().eq('id', id).eq('state', 'draft').eq('company_entity_id', CO).select('id')); if (!r.length) throw new Error('Not deleted: only a draft can be deleted, by a manager.'); return 'Deleted.'; },
  'draft-approve': async ({ id }) => { await updateRows('affiliate_outreach_drafts', { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, { id, state: 'draft' }); return 'Approved.'; },
  // "I already sent this one myself." A message sent by hand outside SILO is
  // the ordinary case, so it is marked in one press from wherever the draft
  // sits -- approval and the send recorded together, because they happened
  // together. One row at a time: the evidence line names the channel, and a
  // row the database refuses leaves the others alone.
  'draft-sent-now': async ({ id }) => `${num(await markSentByHand([id]))} marked as sent.`,
  'q-msg-sent': async () => {
    const ids = picked('msgs');
    if (!ids.length) return 'Tick at least one.';
    const n = await markSentByHand(ids);
    qsel('msgs').clear();
    return `${num(n)} marked as sent.`;
  },
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
    setStatus('Message copied. Send it from your own account, then press Mark as sent.', 'pos', 5000);
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
  // Approve the ticked messages and download them as a CSV in one press
  // (Blake 2026-11-19: "need csv email export from queue").
  'q-msg-export': async () => {
    const ids = picked('msgs'); if (!ids.length) return 'Tick at least one.';
    const email = ids.filter((id) => { const x = S.d.drafts.find((r) => r.id === id); return x && !isDm(x); });
    if (!email.length) return 'None of those has an email address: send them by DM.';
    // Only the rows this update really approved are exported: one another
    // person deleted or sent meanwhile is left out, and one the database
    // refuses to approve (the recipient asked not to be contacted) is named
    // rather than failing the whole press.
    const rows = email.map((id) => S.d.drafts.find((r) => r.id === id)).filter(Boolean);
    const { moved, refused } = await moveDrafts(rows, { state: 'approved', approved_by: me.id, approved_at: new Date().toISOString() }, 'draft');
    const done = moved.map((r) => r.id);
    for (const x of S.d.drafts) if (done.includes(x.id)) x.state = 'approved';
    qsel('msgs').clear();
    const m = done.length ? await A['outreach-export']({ only: done }) : 'Nothing was exported.';
    const gone = email.length - done.length - refused.length;
    return `${m}${gone > 0 ? ` ${num(gone)} were no longer drafts and were left out.` : ''}${refused.length ? ` ${num(refused.length)} could not be approved: ${refused[0].why}` : ''}${email.length < ids.length ? ` ${num(ids.length - email.length)} with no email stay for DM.` : ''}`;
  },
  'outreach-export': async ({ only } = {}) => {
    const picks = S.d.drafts.filter((x) => x.state === 'approved' && !isDm(x) && (!only || only.includes(x.id))).slice(0, 200);
    if (!picks.length) return 'Nothing to export: messages with no email are sent by DM.';
    const now = new Date().toISOString();
    const batch = must(await db.from('affiliate_outreach_batches').insert({ company_entity_id: CO, program_id: S.programId, channel: 'email', row_count: 0, exported_at: now, exported_by: me.id, created_by: me.id }).select('id').single());
    // The drafts MOVE FIRST, and only the ones that moved are exported. The
    // database is what knows who may be contacted -- it refuses to export a
    // message to anyone added to the do-not-contact list since approval -- so
    // reading the list here would be a second, staler copy of that rule.
    // Doing it the other way round cost three things at once (review
    // 2026-11-23): a suppressed person's address went into the file, the one
    // refused row failed the whole batch's update, and the drafts stayed
    // 'approved' so the next export minted new signup links, killing the
    // links in the file someone may already have sent.
    // The page's own copy of the rows is left alone: the database decided,
    // and the reload after the action is what the screen follows.
    const { moved: drafts, refused } = await moveDrafts(picks, { state: 'exported', batch_id: batch.id, exported_at: now }, 'approved');
    const left = refused.length ? ` ${num(refused.length)} left out: ${refused[0].why}` : '';
    if (!drafts.length) {
      await db.from('affiliate_outreach_batches').delete().eq('id', batch.id).eq('company_entity_id', CO);
      return `Nothing was exported.${left}`;
    }
    const missing = await deliverBatch(batch.id, drafts, now);
    return `Exported ${drafts.length}.${left} ${missing ? `${missing} have no personal link; the file says why.` : ''} Send them, then mark each one sent.`;
  },
  // A batch the browser claimed but never delivered -- the tab was closed or
  // refreshed between the claim and the download -- is finished from Records.
  // The rows are already this batch's, so nothing else is claimed and no
  // other batch's links are touched; it is the only way back to a file for
  // messages that are already marked exported (review of #1357).
  'batch-finish': async ({ id }) => {
    const b = (S.d.batches || []).find((x) => x.id === id);
    const rows = S.d.drafts.filter((x) => x.batch_id === id && x.state === 'exported');
    if (!rows.length) return 'Nothing is waiting in that batch.';
    const missing = await deliverBatch(id, rows, b?.exported_at || new Date().toISOString());
    return `Downloaded ${rows.length}.${missing ? ` ${missing} have no personal link; the file says why.` : ''} Send them, then mark each one sent.`;
  },
  // View as rep (Blake 2026-11-24): their own portal, read-only, in a new
  // tab. A one-hour preview link made for this press: the raw link is made
  // here and only its hash is stored, it never replaces or resets the rep's
  // own links, and the server refuses every change it asks for. The tab is
  // opened inside the click, before anything is awaited, so the browser does
  // not block it as a pop-up.
  'view-as-rep': async ({ id }) => {
    const w = window.open('', '_blank');
    try {
      const raw = previewToken();
      must(await db.rpc('affiliate_issue_preview_token', { p_affiliate_id: id, p_token_hash: await sha256Hex(raw) }));
      const url = new URL('portal.html', location.href);
      url.searchParams.set('view', 'rep');
      url.searchParams.set('t', raw);
      if (!w) { setStatus('Your browser blocked the new tab. Allow pop-ups for SILO and press View as rep again.', 'neg'); return null; }
      w.opener = null;
      w.location.replace(url.toString());
      setStatus('Opened their portal in a new tab. Read-only, for one hour.', 'pos', 5000);
      return null;
    } catch (e) { w?.close(); throw e; }
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
    if (s === 'terminated') {
      // Ending someone ends their codes, here and at checkout. Pausing does
      // not: a paused affiliate comes back with the same code.
      //
      // The CODES go first, and nothing here is swallowed (review
      // 2026-11-23). Marking the affiliate ended first and then failing to
      // read or retire their codes said "Affiliate ended" while the code was
      // still live at checkout -- and the End button was gone, so the only
      // way back was retiring each code by hand. Now a failure leaves the
      // affiliate exactly as they were, with the button still there to press
      // again. Shopify is last because it reports rather than throws: a code
      // retired in SILO stops earning even if the store still has to be told.
      const codes = must(await db.from('affiliate_codes').select('id, status, source, shopify_discount_id, shopify_ended_at').eq('company_entity_id', CO).eq('affiliate_id', id));
      const live = codes.filter((c) => c.status === 'active' || c.status === 'pending');
      if (live.length) await updateRows('affiliate_codes', { status: 'retired', changed_by: me.id }, { id: live.map((c) => c.id) });
      await updateRows('affiliates', { status: s, changed_by: me.id }, { id });
      // Everything the store still has to be told about, which is not only
      // what this press retired: an attempt that retired the codes and then
      // failed on the affiliate left them retired, and a second press would
      // otherwise find nothing live and report an ending Shopify never heard
      // of (review of #1357). A code already retired counts only where there
      // is something to turn off -- SILO's own code carries its discount id,
      // and a code made by hand is reported as yours to turn off -- so one
      // that was only ever waiting to be made is left out.
      const owed = codes.filter((c) => !c.shopify_ended_at
        && (c.status === 'active' || (c.status === 'retired' && (c.shopify_discount_id || c.source === 'manual'))));
      if (!live.length && !owed.length) return 'Affiliate ended.';
      const ended = await endInShopify(owed.map((c) => c.id));
      return `Affiliate ended${live.length ? ` and ${num(live.length)} code(s) retired` : ''}. ${ended}`.trim();
    }
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
  'feed-who': ({ id }) => { S.feedWho = id; renderDialog(); return null; },
  // Nobody ticked is not an empty audience, it is no audience: the share goes
  // back to the whole program. So the rows are replaced, never merged.
  // One call, one transaction, with the share locked. Emptying the audience
  // and filling it again in two steps would leave the share open to the whole
  // program in between -- and open for good if the second step never landed,
  // because no audience rows means everyone (review of #1350).
  'feed-who-save': async ({ id }) => {
    // p_scope is literally the boxes the dialog drew. Anyone it never showed
    // -- a creator past a truncated page, or one who has left the program and
    // is still a named recipient -- keeps their row instead of being dropped
    // by a list that did not include them (review cycle 2 of #1350).
    const boxes = [...document.querySelectorAll('#afDialogBody .af-who')];
    const want = boxes.filter((x) => x.checked).map((x) => x.value);
    const r = await db.rpc('affiliate_feed_set_audience', { p_item: id, p_affiliates: want, p_scope: boxes.map((x) => x.value) });
    if (r.error) throw r.error;
    S.feedWho = null;
    await reload();
    const n = Number(r.data?.named ?? want.length);
    return n ? `Shared with ${num(n)} creator(s).` : 'Shared with everyone in this program.';
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
    S.share.otherStore = 0;
    if (!q) { S.share.products = []; renderShare(); return; }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // What this program's own store sells, so every result carries a handle a
    // code can be made against (Blake 2026-11-20).
    const shop = programShop();
    const mine = shop ? await storeProducts(shop, like) : null;
    if (mine) {
      S.share.products = await withProductImages(mine.slice(0, 30));
      // An empty list reads as a failed search unless it says where the
      // company's other matches are.
      if (!mine.length) {
        const { data } = await db.from('products_master').select('shopify_handle')
          .eq('company_entity_id', CO).ilike('product_title', like).not('shopify_handle', 'is', null).limit(120);
        S.share.otherStore = new Set((data || []).map((x) => x.shopify_handle)).size;
      }
      renderShare();
      return;
    }
    // No store picked, or its list is unreadable or not synced yet: fall back
    // to the company-wide list, as before.
    const { data, error } = await db.from('products_master').select('product_title, product_type, image_url, shopify_handle')
      .eq('company_entity_id', CO).ilike('product_title', like).not('shopify_handle', 'is', null).limit(120);
    if (error) throw error;
    const seen = new Set();
    const found = (data || []).filter((x) => /^[A-Za-z0-9_.-]+$/.test(x.shopify_handle || '') && !seen.has(x.shopify_handle) && seen.add(x.shopify_handle));
    S.share.products = found.slice(0, 30);
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
  'code-retire': async ({ id }) => {
    const was = S.d.codes.find((c) => c.id === id)?.status;
    await updateRows('affiliate_codes', { status: 'retired', changed_by: me.id }, { id });
    return was === 'pending' ? 'Code cancelled.' : `Code retired. ${await endInShopify([id])}`.trim();
  },
  'code-end': async ({ id }) => (await endInShopify([id])) || 'Nothing to turn off.',
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
  'order-lookup': async () => orderLookup(val('olq')),
  'order-lookup-clear': () => { S.lookup = null; renderPayoutsTab({ quiet: true }); return null; },
  'order-explain': async ({ q }) => { S.tab = 'payouts'; render(); const r = await orderLookup(q); $('olq')?.scrollIntoView({ block: 'center' }); return r; },
  'pp-retry': async ({ id }) => {
    const r = await invoke('affiliate-payouts', { action: 'refresh', payout_id: id, retry: true });
    const x = (r.results || [])[0] || {};
    if (x.error) return x.error;
    return x.state === 'paid' ? 'PayPal paid it.' : x.state === 'sent' ? 'PayPal accepted it. Checking again shortly.' : (x.message || 'PayPal has not answered yet.');
  },
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
  // On a company tab every program's approved payouts go out at once: one
  // claim and one file per program, since a claim, its batch and its
  // checksum belong to one program.
  'payout-export': async () => {
    const approved = S.d.payouts.filter((x) => x.status === 'approved');
    const jobs = companyMulti()
      ? [...new Set(approved.map((x) => x.program_id))].map((id) => ({ programId: id, slug: S.programs.find((y) => y.id === id)?.slug || 'program', ids: approved.filter((x) => x.program_id === id).map((x) => x.id) }))
      : [{ programId: S.programId, slug: prog().slug, ids: approved.map((x) => x.id) }];
    const affById = S.d.affById;
    let n = 0; let skippedN = 0; const notes = [];
    for (const { programId, slug, ids } of jobs) {
      const r = must(await db.rpc('affiliate_claim_payout_export', { p_program: programId, p_payouts: ids, p_batch: null }));
      const csv = toCsv(PAYOUT_HEADER, payoutRows(r.payouts || [], affById));
      download(`payouts-${slug}-${today()}.csv`, csv);
      n += (r.payouts || []).length; skippedN += (r.skipped || []).length;
      // The payouts are already exported and the file is downloaded; a missing
      // fingerprint only loses the file's checksum, so say so rather than fail.
      try { must(await db.rpc('affiliate_set_payout_export_fingerprint', { p_batch: r.batch_id, p_fingerprint: await sha256Hex(csv) })); } catch (e) { notes.push(`The file's checksum was not saved (${e.message}).`); }
    }
    const files = jobs.length > 1 ? ` in ${num(jobs.length)} files, one per program` : '';
    const done = `Exported ${n}${files}${skippedN ? ` (${skippedN} changed since the page loaded and were left out)` : ''}. Pay them in your own system, then record each reference.`;
    return notes.length ? `${done} ${notes[0]}` : done;
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
  'payout-void-open': async ({ id }) => voidToggle(id, true),
  'payout-void-close': async ({ id }) => voidToggle(id, false),
  'payout-void': async ({ id }) => {
    if (!val(`vr-${id}`)) throw new Error('Say why it is being voided.');
    must(await db.rpc('affiliate_void_payout', { p_payout: id, p_reason: val(`vr-${id}`) }));
    return 'Payout voided. Its lines can be paid again in a new payout.';
  },
};

// Shows or hides one payout's void reason box in place (no render(), which
// would rebuild the whole Money tab and drop anything typed elsewhere).
// Re-render without losing what someone has typed in an open form (review
// on #1321: the Current/Ended filter wiped a half-filled Add code form).
function keepFields(rootId, fn) {
  const root = $(rootId);
  const saved = [...(root?.querySelectorAll('input[id], select[id], textarea[id]') || [])]
    .filter((el) => el.type !== 'file')
    .map((el) => [el.id, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value]);
  fn();
  for (const [id, v] of saved) {
    const el = $(id);
    if (!el) continue;
    if (typeof v === 'boolean') el.checked = v; else el.value = v;
    document.querySelectorAll(`[data-seg="${CSS.escape(id)}"]`).forEach((b) => {
      const on = b.dataset.v === String(v);
      b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on));
    });
  }
}
function voidToggle(id, open) {
  const wrap = $(`vw-${id}`);
  const opener = document.querySelector(`#payoutsBody [data-act="payout-void-open"][data-id="${CSS.escape(id)}"]`);
  if (!wrap || !opener) return;
  wrap.hidden = !open; opener.hidden = open;
  if (open) $(`vr-${id}`)?.focus(); else { const r = $(`vr-${id}`); if (r) r.value = ''; opener.focus(); }
}

// Two-click confirm for anything that cannot be quietly undone: the first
// click arms the button for four seconds.
document.addEventListener('click', async (ev) => {
  const tab = ev.target.closest('#tabs [data-tab]');
  if (tab) { await goTab(PANEL_OF[tab.dataset.tab] || tab.dataset.tab); S.creating = false; render(); workflowFocusTab(tab.dataset.tab); return; }
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.confirm && !b.dataset.armed) {
    b.dataset.armed = '1'; const label = b.textContent; b.textContent = 'Click again to confirm';
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
    return;
  }
  const fn = A[b.dataset.act]; if (!fn) return;
  // People lists every program at once, so a button there works in the
  // program of the row it sits on. Later steps (a dialog's Save) keep it.
  if (companyScope()) {
    const pg = ctxProgram(b.dataset);
    if (pg && pg !== S.programId) { S.programId = pg; if ($('programSel')) $('programSel').value = pg; }
  }
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
  } finally {
    b.disabled = false;
    // An action that finished its form (or failed after clearing it) must not
    // leave the modal sitting over the page: the dialog follows the state,
    // whether or not the action reloaded.
    renderDialog();
  }
});
// "Add to program…" on a person's row: picking a program adds them to it,
// exactly as the Add to button did.
document.addEventListener('change', async (ev) => {
  const sel = ev.target.closest?.('select.af-addto');
  if (!sel || !sel.value) return;
  const to = sel.value;
  // Like any People button, it works in the program of the row it sits on.
  const pg = ctxProgram({ id: sel.dataset.id });
  if (pg && pg !== S.programId) { S.programId = pg; if ($('programSel')) $('programSel').value = pg; }
  sel.disabled = true;
  try {
    const msg = await A['prospect-assign']({ id: sel.dataset.id, to });
    if (typeof msg === 'string') { setStatus(msg, 'pos', 5000); await reload(); }
  } catch (e) {
    setStatus(friendly(e), 'neg');
  } finally {
    sel.disabled = false; sel.value = '';
  }
});
// Escape, the backdrop and the browser's own close all mean the same thing:
// nothing is open any more, so the state that opened it is cleared too.
$('afDialog')?.addEventListener('close', () => { if (S.dlgKey) { closeDialogState(); S.dlgKey = null; render(); } });
$('afDialog')?.addEventListener('click', (ev) => { if (ev.target === $('afDialog')) $('afDialog').close(); });
async function setProgram(id) { await flushProgramSave(); S.programId = id; if ($('programSel')) $('programSel').value = id; S.creating = false; S.shareAll = false; S.affTool = null; S.lookup = null; S.tplDraft = null; S.custTplDraft = null; await loadProgramData(); render(); }
$('programSel').addEventListener('change', (e) => setProgram(e.target.value));
$('btnNewProgram').addEventListener('click', () => A['new-program']());
// Typing redraws the tab a beat after the last key; Escape clears it.
let findTimer = null;
$('studioQ')?.addEventListener('input', (e) => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => { S.find = e.target.value; render(); }, 150);
});
$('studioQx')?.addEventListener('click', () => { const q = $('studioQ'); if (q) { q.value = ''; q.focus(); } clearTimeout(findTimer); S.find = ''; render(); });
$('studioQ')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.value) { e.target.value = ''; clearTimeout(findTimer); S.find = ''; render(); }
});

try {
  const { data: ent } = await db.from('entities').select('title').eq('id', CO).maybeSingle();
  S.brand = ent?.title || '';
  await ensureProfiles();
  await reload();
  if (!S.programs.length && MANAGE) { S.creating = true; S.tab = 'program'; render(); }
} catch (e) {
  setStatus(friendly(e), 'neg');
}
