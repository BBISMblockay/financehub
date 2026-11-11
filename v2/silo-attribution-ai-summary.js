// "Generate AI summary" on the Attribution page.
//
// This does NOT build a second analysis. Everything it sends is a figure the
// page has already loaded, reconciled against Shopify and rendered on screen
// (summarize(), channelTeamwork(), findings(), spendTotal()), so the summary
// can never disagree with the tables above it. The model is told not to query
// anything: an answer assembled from its own SQL would be a different report
// wearing this one's heading.
//
// The question goes to the SAME surface as Ask SILO -- the `silo-chat` edge
// function -- so prompt rules, the audit log, the company re-verification and
// AI-credit metering are all the existing ones. Nothing new is metered or
// stored for this feature.
//
// Fail-soft by construction: the card is only mounted when the page hands it
// an `ask` function, every failure stays inside the card, and the attribution
// report itself never depends on it.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Sanitiser settings copied from Ask SILO (v2/silo-chat.html, security audit
// 2026-10-08): answers are prose, never markup, so images, styles and embeds
// are refused rather than filtered.
const ANSWER_PURIFY = { FORBID_TAGS: ['img', 'style', 'svg', 'video', 'audio', 'picture', 'source', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['style', 'srcset', 'background', 'poster'] };

const MAX_CHANNEL_LINES = 12;

export const money = (cents, currency) => cents == null || !Number.isFinite(Number(cents))
  ? 'not tracked'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(cents) / 100);

// Does this period hold anything a summary could be about? A loaded report
// with no orders is not an error and not a zero: it is a period the sync has
// no sales for, and asking the model to narrate it would spend AI credit on
// "there is no data".
export const hasSomethingToSummarize = data => !!data && Number(data.orderCount) > 0;

// The question, built from figures only. Pure and exported so the wording is
// testable without a browser, and so it is reviewable in one place: this text
// is the whole contract with the model.
//
// No company, brand or industry is named anywhere in here. The store label and
// the channel names come from the caller's own data, which is where every
// company-specific fact belongs.
export function buildSummaryPrompt(data) {
  if (!hasSomethingToSummarize(data)) throw Error('No attribution data to summarize');
  const currency = data.currency || 'USD';
  const cash = cents => money(cents, currency);
  const lines = [];
  const say = (label, value) => lines.push(`- ${label}: ${value}`);

  lines.push('REPORT');
  say('Store', data.store || 'not named');
  say('Period', `${data.start} through ${data.end} (${data.days} day${data.days === 1 ? '' : 's'}, reconciled against the store's own sales)`);
  say('Look-back window for giving credit', `${data.windowDays} days`);
  say('Net sales', cash(data.netCents));
  say('Orders', Number(data.orderCount).toLocaleString());
  const spend = data.spend || {};
  say('Marketing spend', spend.cents == null ? 'not tracked'
    : spend.complete ? `${cash(spend.cents)} (complete for the whole period)`
    : `${cash(spend.cents)} so far, INCOMPLETE -- still missing ${(spend.gaps || []).join(', ') || 'at least one source'}`);
  say('Return on spend', spend.complete && Number(spend.cents) > 0 ? `${(Number(data.netCents) / Number(spend.cents)).toFixed(1)}x` : 'not available, because spend is not complete for the whole period');
  if (data.multiChannel) {
    const m = data.multiChannel;
    say('Orders that touched more than one channel', m.total ? `${m.multi.toLocaleString()} of ${m.total.toLocaleString()}` : 'none identified');
    say('Orders with no channel we could identify', `${Math.max(0, Number(m.total || 0) - Number(m.any || 0)).toLocaleString()}`);
  }
  if (data.journeys) say('Orders with a complete visit history (used for shared credit)', `${Number(data.journeys.eligible).toLocaleString()} of ${Number(data.journeys.total).toLocaleString()}`);

  const channels = (data.channels || []).slice(0, MAX_CHANNEL_LINES);
  if (channels.length) {
    lines.push('', 'CHANNELS (last-click sales | shared sales | spend | started / helped / closed)');
    for (const c of channels) {
      lines.push(`- ${c.channel}: ${cash(c.netCents)} | ${c.sharedCents == null ? 'shared credit unavailable' : cash(c.sharedCents)} | ${c.spendCents == null ? (c.spendStatus === 'none' ? 'spend not tracked' : 'spend not synced') : cash(c.spendCents) + (c.spendStatus && c.spendStatus !== 'complete' ? ` (${c.spendStatus})` : '')} | ${Number(c.started || 0).toLocaleString()} / ${Number(c.assisted || 0).toLocaleString()} / ${Number(c.closed || 0).toLocaleString()}`);
    }
    if ((data.channels || []).length > channels.length) lines.push(`- (${(data.channels || []).length - channels.length} smaller channels not listed)`);
  }
  const paths = (data.paths || []).slice(0, 3);
  if (paths.length) {
    lines.push('', 'MOST COMMON OBSERVED PATHS');
    for (const p of paths) lines.push(`- ${(p.path || []).join(' then ')} then purchase: ${Number(p.count || 0).toLocaleString()} orders, ${cash(p.netCents)}`);
  }
  const findings = (data.findings || []).slice(0, 5);
  if (findings.length) {
    lines.push('', 'PATTERNS THE PAGE ALREADY POINTS OUT (do not just repeat these -- tie them together)');
    for (const f of findings) lines.push(`- ${f.title}: ${f.text}`);
  }

  return [
    'Write a short summary of this marketing attribution report for the person looking at it right now.',
    '',
    'Every figure you need is below. It has already been computed and reconciled by SILO. Do not run any SQL, do not use any tool and do not look anything else up: an answer built from your own queries would not match the report on screen.',
    '',
    'How to write it:',
    '- One opening sentence that says what the period looks like overall, then three to five short bullets. Under 200 words.',
    '- Name specific channels and amounts from the figures. No headings, no tables.',
    '- Last-click and shared credit are two ways of splitting the SAME sales total. Never add them together, and never present either as extra sales.',
    '- Only use return on spend where spend is complete for the whole period; where it is not, say so instead of computing one.',
    '- This shows the path customers took, not proof a channel caused a sale. Do not say a channel caused, drove or added sales, and do not call anything incremental.',
    '- A missing figure means not tracked or not synced, never zero. Say which.',
    '- Finish with at most two specific things worth checking next. No promises and no actions you cannot see in these figures.',
    '',
    lines.join('\n'),
  ].join('\n');
}

// The card. `ask` is the only way out to the network and the page owns it, so
// this module never sees a token, a client or a company id.
//
//   host : the element to render into
//   ask  : async (question) => { answer, ai_credit } -- throws with a message
//   credit : optional async () => ({ show, describeCharge }) for the cost note
export function mountAISummary(host, { ask, credit = null } = {}) {
  if (!host || typeof ask !== 'function') return { setData() {}, clear() {} };
  let data = null, running = false, chargeNote = null;

  const render = (state, body = '') => {
    const disabled = running || !hasSomethingToSummarize(data);
    host.innerHTML = `<section class="bcn-card attr-ai"><div class="bcn-card-header"><h2>AI summary</h2>
      <button class="bcn-btn bcn-btn--primary" id="ai-generate"${disabled ? ' disabled' : ''}>${running ? 'Writing…' : 'Generate AI summary'}</button></div>
      <div class="bcn-card-body" id="ai-body">${body || emptyState(state)}</div></section>`;
    const button = host.querySelector('#ai-generate');
    if (button) button.onclick = generate;
  };

  const emptyState = state => state === 'running'
    ? '<p class="attr-context">Reading the figures above and writing a summary. This usually takes under a minute.</p>'
    : hasSomethingToSummarize(data)
      ? '<p class="attr-context">Turn the numbers above into a few sentences: which channels carried the period, where last-click and shared credit disagree, and what is worth checking next. It reads only the figures already on this page, and it uses your workspace\'s AI credit.</p>'
      : '<p class="attr-context">No orders in this period yet, so there is nothing to summarize. Load a period the sync has sales for.</p>';

  async function generate() {
    if (running || !hasSomethingToSummarize(data)) return;
    const asked = data;
    running = true;
    render('running');
    let result = null, failure = null;
    try { result = await ask(buildSummaryPrompt(asked)); }
    catch (e) { failure = e?.message || String(e); }
    running = false;
    // The filters moved while it was writing: that answer is about a report
    // nobody is looking at any more, so it is dropped rather than shown under
    // different numbers.
    if (data !== asked) { render('idle'); return; }
    if (failure || !result?.answer) {
      render('idle', `<p class="bcn-status bcn-status--neg">${esc(failure || 'No summary came back. Try again.')}</p>`);
      return;
    }
    const text = String(result.answer);
    const html = (typeof window !== 'undefined' && window.marked && window.DOMPurify)
      ? window.DOMPurify.sanitize(window.marked.parse(text), ANSWER_PURIFY)
      : `<p style="white-space:pre-wrap">${esc(text)}</p>`;
    render('answer', `<div class="attr-ai-answer">${html}</div><p class="attr-context" id="ai-note">Written from the figures on this page only. It describes the paths customers took, not proof a channel caused a sale.</p>`);
    // What it cost, for the person who pays, exactly as Ask SILO decides it.
    // Entirely optional: a workspace without credit configured, or a failed
    // read, simply shows no note.
    if (credit && result.ai_credit) {
      try {
        if (chargeNote == null) chargeNote = await credit();
        const charge = chargeNote?.show ? chargeNote.describeCharge(result.ai_credit) : null;
        const note = host.querySelector('#ai-note');
        if (charge?.text && note) note.textContent += ` · ${charge.text}`;
      } catch { /* the summary is the point; its price tag is not */ }
    }
  }

  return {
    // Called on every report load. Null clears the card back to its empty
    // state, which is also what a failed load leaves behind.
    setData(next) { data = next || null; chargeNote = null; render('idle'); },
    clear() { data = null; render('idle'); },
  };
}

// The network side, kept here so the page stays about attribution.
//
// Same request shape as Ask SILO: one user turn, a client-minted request id,
// the tab's own company id (used by the server only to REFUSE a mismatch), and
// deferred delivery -- a long answer is committed to silo_chat_responses and
// collected by id, because the connection between a browser and the function
// is closed at about two minutes.
export function askSiloSummary(db, { functionsUrl, companyId, waitMs = 240000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!db || !functionsUrl) throw Error('Missing Supabase configuration');
  return async function ask(question) {
    const { data: fresh } = await db.auth.getSession();
    const token = fresh?.session?.access_token;
    if (!token) throw Error('Your sign-in has expired. Reload the page and sign in again.');
    const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : null;
    const started = Date.now();
    const res = await fetch(`${functionsUrl}/silo-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        history: [{ role: 'user', content: question }],
        ...(requestId ? { request_id: requestId, async: true } : {}),
        company_entity_id: companyId,
      }),
    });
    let body = await res.json().catch(() => ({}));
    let status = Number(body?.http_status) || res.status;
    if (res.status === 202 && body?.pending && requestId) {
      // Poll the caller's own row. RLS on silo_chat_responses scopes it to the
      // person who asked, so this can only ever find this request's answer.
      let polls = 0, collected = null;
      while (Date.now() - started < waitMs) {
        await sleep(polls < 10 ? 2000 : 4000);
        polls += 1;
        const { data, error } = await db.from('silo_chat_responses').select('http_status, response').eq('request_id', requestId).maybeSingle();
        if (error) break;
        if (data?.response) { collected = data; break; }
      }
      if (!collected) throw Error('This is taking longer than expected. It may still finish — try again in a minute.');
      body = collected.response;
      status = Number(collected.http_status) || 200;
    }
    if (status < 200 || status >= 300 || body?.error) throw Error(body?.error || `The summary could not be written (${status}).`);
    if (!body?.answer) throw Error('No summary came back. Try again.');
    return { answer: body.answer, ai_credit: body.ai_credit };
  };
}

// The cost note, read once per report. Ask SILO shows a per-answer price only
// to the person who pays for the workspace (v2/ai-credit.js: costsVisible), and
// that rule is not re-decided here.
export function aiCreditNote(db, SiloAICredit) {
  if (!db || !SiloAICredit) return null;
  return async function credit() {
    const { summary, error } = await SiloAICredit.load(db);
    const described = SiloAICredit.describe(summary, error);
    return { show: SiloAICredit.costsVisible(described), describeCharge: SiloAICredit.describeCharge };
  };
}
