/* On Deck, one screen.
   The surface carries recommendations and nothing else. A draft SILO has not
   finished -- being prepared, queued, paused, expired, or of unknown state --
   is not surfaced at all: it goes inside a collapsed summary of SILO's own
   progress, because a reader cannot act on it and a page full of machinery
   reads as work. What is left is a card per recommendation (what SILO
   recommends, why, the evidence, one button that says what it does) and, when
   SILO is waiting on an answer, one line per question.
   Status comes from SiloOnDeckBriefing.statusOf and is never computed here; the
   database gates in on_deck_decide / on_deck_context stay authoritative, so
   this page only offers what those will accept. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.__SILO_CONFIG__ || {};
  const state = { db: null, co: null, settings: {}, rows: [], reviewState: null, reviewFailed: false, loading: false };
  const PER_KIND = 2, MAX_CARDS = 6;   // no one department takes over the surface
  const OPEN = ['ready', 'preparing', 'revision', 'needs_info', 'failed'];
  const when = v => v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  const B = () => window.SiloOnDeckBriefing;

  function node(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
  function button(text, fn, primary) { const b = node('button', text, `bcn-btn ${primary ? 'bcn-btn--primary' : 'bcn-btn--ghost'}`); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function safeLink(label, href, primary) {
    const a = node('a', label, primary ? 'bcn-btn bcn-btn--primary' : 'bcn-btn bcn-btn--ghost');
    try {
      const u = new URL(href, location.origin);
      if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) { a.href = u.href; a.rel = 'noopener'; return a; }
    } catch (e) { /* fall through to the inert label below */ }
    return node('span', label + ' (link unavailable)', 'od-meta');
  }
  function message(text, bad = false, retry = null) {
    const el = $('status'); el.replaceChildren(); el.className = 'bcn-status' + (bad ? ' bcn-status--neg' : ''); el.hidden = !text;
    if (!text) return;
    el.append(node('span', text));
    if (retry) el.append(button('Retry', retry));
  }
  function check(result) { if (result.error) throw new Error(result.error.message || 'Request failed'); return result.data; }
  async function rpc(name, args) { return check(await state.db.rpc(name, args)); }
  function statusOf(p) { return B().statusOf(p, { settings: state.settings, review: state.reviewState, now: Date.now() }); }
  function title(p) { return String(p.title || '').split(' · ').slice(1).join(' · ') || String(p.title || 'Prepared opportunity'); }

  // One jump, to the draft itself. The editor, its full evidence and the separate
  // creation confirmation live on /v2/on-deck.html; this surface decides what
  // deserves attention, it does not re-implement the review.
  const reviewHref = p => '/v2/on-deck.html?proposal=' + encodeURIComponent(p.id);

  function createdLink(p) {
    const out = p.output || {};
    const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    const ids = out.kind === 'launch_tasks' ? (out.ids || []).filter(uuid) : uuid(out.id) ? [out.id] : [];
    const path = { seo_task: '/v2/seo-tasks.html?task=', ad_idea: '/v2/ad-studio.html?view=ideas&idea=', product_brief: '/v3/product-workflow.html?brief=', launch_tasks: '/v2/tasks.html?task=' }[out.kind];
    const label = { seo_task: 'SEO task', ad_idea: 'idea', product_brief: 'brief', launch_tasks: 'task' }[out.kind] || 'record';
    if (!ids.length || !path) return null;
    return safeLink('Open created ' + label, path + ids[0], true);
  }

  // What the button does, and what it needs from the reader, in one line each.
  const promises = {
    review: 'Nothing is missing — this needs your judgement. Nothing is created until you confirm.',
    answer: 'Opens this draft so you can answer what is missing. Saving answers creates no work and runs no AI.',
    refresh: 'Asks SILO to screen your current data again and prepare a fresh draft. Your saved answers are kept.',
  };

  // One control per card or row, labelled with what pressing it does. A status
  // with no action (SILO is still working, or preparation is paused) gets no
  // button: there is nothing to press, and offering one would be a lie.
  function actionButton(st, p, primary = true) {
    if (st.action === 'open-created') return createdLink(p) || node('span', 'The created record link is unavailable. Reload before continuing.', 'od-meta');
    if (st.action === 'refresh') return button('Refresh evidence', () => refreshEvidence(p), primary);
    if (st.action === 'retry') return button('Retry', load, primary);
    if (st.action === 'answer') return safeLink(st.asks ? `Answer ${st.asks} question${st.asks === 1 ? '' : 's'}` : 'Answer what is missing', reviewHref(p), primary);
    if (st.action === 'review') return safeLink('Review draft', reviewHref(p), primary);
    return null;
  }

  function card(item, p) {
    const st = statusOf(p), box = node('article', null, 'od-card odn-card');
    box.append(node('span', item.category || 'OPPORTUNITY', 'od-pill'));
    box.append(node('h3', item.headline || title(p)));
    if (item.finding) box.append(node('p', item.finding));
    if (item.why) box.append(node('p', item.why, 'odn-why'));
    if ((item.metrics || []).length) {
      const row = node('dl', null, 'odn-metrics');
      item.metrics.slice(0, 3).forEach(([label, value]) => { row.append(node('dt', label)); row.append(node('dd', String(value), 'bcn-num')); });
      box.append(row);
    }
    const act = node('div', null, 'od-buttons');
    const control = actionButton(st, p);
    if (control) act.append(control); else act.append(node('span', st.label, `od-rpill od-rpill--${st.tone}`));
    box.append(act);
    // Only a complete draft reaches this grid (see pick), so the promise line is
    // the whole answer to "what does it need from me"; the fallback keeps a
    // status that changed between render passes from reading as completeness.
    box.append(node('p', promises[st.action] || st.detail || st.label, 'od-meta'));
    if (st.notice) box.append(node('p', st.notice, 'od-meta'));
    if (item.caveat) box.append(node('p', item.caveat, 'od-meta'));
    return box;
  }

  async function refreshEvidence(p) {
    try {
      await companyStillActive();
      await rpc('on_deck_decide', { p_id: p.id, p_version: p.version, p_action: 'refresh' });
      // Reload first: load() owns the status line, so a confirmation set before
      // it would be wiped, and one set after a failed reload would hide the error.
      if (await load()) message('Fresh screening requested. Your saved answers and the previous draft are kept until it arrives.');
    } catch (e) { message(e.message, true); }
  }

  function compactRow(p, st, label) {
    const row = node('div', null, 'odn-row');
    row.append(node('span', title(p), 'odn-row-name'));
    if (label) row.append(node('span', label, 'od-meta'));
    const control = actionButton(st, p, false);
    if (control) row.append(control);
    return row;
  }
  function list(rows) { const box = node('div', null, 'odn-list'); rows.forEach(r => box.append(r)); return box; }

  function renderCards(cards, extra) {
    const box = $('cards'); box.replaceChildren(); box.hidden = false;
    box.append(node('h2', 'What SILO recommends'));
    if (!cards.length) {
      box.append(node('p', state.settings.enabled === false
        ? 'Background preparation is off for this workspace, so nothing is being prepared. An owner can turn it on in Workspace Settings.'
        : 'Nothing is ready for you to act on right now.', 'odn-why'));
      return;
    }
    const grid = node('div', null, 'od-ready-grid');
    cards.forEach(([item, p]) => grid.append(card(item, p)));
    box.append(grid);
    if (extra.length) {
      box.append(node('p', 'Also ready for review', 'odn-why'));
      box.append(list(extra.map(p => compactRow(p, statusOf(p)))));
    }
  }

  // The one thing besides a recommendation that belongs on the surface: a draft
  // SILO finished and cannot go further on without an answer from the reader.
  function renderAsks(shown) {
    const box = $('needs'); box.replaceChildren();
    const asks = state.rows.filter(p => OPEN.includes(p.status) && !shown.has(p.id) && statusOf(p).key === 'needs_input');
    box.hidden = !asks.length;
    if (!asks.length) return;
    box.append(node('h2', 'SILO needs an answer from you'));
    box.append(list(asks.map(p => compactRow(p, statusOf(p)))));
  }

  function renderDone() {
    const box = $('done'); box.replaceChildren();
    const done = state.rows.filter(p => p.status === 'completed');
    box.hidden = !done.length;
    if (!done.length) return;
    box.append(node('h2', 'Recently created'));
    box.append(list(done.map(p => {
      const row = node('div', null, 'odn-row');
      row.append(node('span', title(p), 'odn-row-name'));
      row.append(node('span', `created ${when(p.approved_at)}`, 'od-meta'));
      const link = createdLink(p); if (link) row.append(link);
      return row;
    })));
  }

  /* SILO's own machinery, collapsed. Everything in here is a draft the reader
     cannot act on yet: being prepared, queued behind the scheduler, paused on a
     blocker, past its evidence window, or of a state SILO could not read. None
     of it is surfaced as a recommendation, and none of it is counted as one. */
  function renderEngine(shown) {
    const box = $('engine'); box.replaceChildren();
    const rest = state.rows.filter(p => OPEN.includes(p.status) && !shown.has(p.id) && statusOf(p).key !== 'needs_input');
    box.hidden = !rest.length && !state.settings.last_screen_at;
    if (box.hidden) return;
    const wrap = node('details', null, 'odn-engine');
    wrap.append(node('summary', rest.length ? `What SILO is still working on (${rest.length})` : 'SILO’s own progress'));
    if (rest.length) wrap.append(list(rest.map(p => { const st = statusOf(p); return compactRow(p, st, [st.label, st.detail].filter(Boolean).join(' \u2014 ')); })));
    const requested = state.settings.requested_at && new Date(state.settings.requested_at) > new Date(state.settings.last_screen_at || 0);
    wrap.append(node('p', `Last screened ${when(state.settings.last_screen_at)}.` + (requested ? ' A refresh is requested and waiting for the next run.' : ''), 'od-meta'));
    if (/^Preparation failed/.test(state.settings.last_status || '')) wrap.append(node('p', state.settings.last_status, 'od-attention'));
    box.append(wrap);
  }

  /* Rank order from the briefing, then the rule that makes this surface
     trustworthy: only a draft SILO can finish on its own is presented as a
     recommendation. Capped per department so one of them cannot take the page;
     a ready draft beyond the cap keeps its place in "Also ready". */
  function pick(model) {
    const byId = new Map(state.rows.map(p => [p.id, p])), seen = new Map(), out = [], extra = [];
    for (const item of model.cards || []) {
      const p = item.type === 'proposal' ? byId.get(item.id) : null;
      if (!p || statusOf(p).key !== 'ready') continue;
      const n = seen.get(item.kind) || 0;
      if (n >= PER_KIND || out.length >= MAX_CARDS) { extra.push(p); continue; }
      seen.set(item.kind, n + 1);
      out.push([item, p]);
    }
    return { out, extra };
  }

  function render() {
    const { out, extra } = pick(B().build({ rows: state.rows, coding: [], driftWarns: state.reviewState?.drift_warns === true }));
    renderCards(out, extra);
    const shown = new Set([...out.map(([, p]) => p.id), ...extra.map(p => p.id)]);
    renderAsks(shown);
    renderEngine(shown);
    renderDone();
  }

  // A page is scoped to the company it loaded with. If that changed under it,
  // the previous company's recommendations, numbers and created-record links
  // must come OFF the screen: a notice above stale tenant content still reads
  // as advice about the company now selected. /v2/on-deck.html clears on this
  // same path.
  function clearSurfaces() {
    state.settings = {}; state.rows = []; state.reviewState = null; state.reviewFailed = false;
    for (const id of ['cards', 'needs', 'engine', 'done']) { const el = $(id); el.replaceChildren(); el.hidden = true; }
  }
  async function companyStillActive() {
    if ((await cfg.ensureActiveCompany?.(state.db))?.id !== state.co) {
      clearSurfaces();
      throw new Error('Active company changed. Reload On Deck before continuing.');
    }
  }

  // Returns true when the page is showing a complete, trustworthy picture.
  async function load() {
    if (state.loading) return false;
    state.loading = true; $('refresh').disabled = true;
    try {
      await companyStillActive();
      const [settings, active, history] = await Promise.all([
        state.db.from('on_deck_settings').select('*').eq('company_entity_id', state.co).maybeSingle(),
        state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', OPEN).order('created_at'),
        state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).eq('status', 'completed').order('approved_at', { ascending: false }).limit(5),
      ]);
      state.settings = check(settings) || {};
      state.rows = [...check(active), ...check(history)];
      // This call decides every proposal's status. If it fails, say what failed
      // and offer a retry; never guess a status and never blame an install.
      state.reviewState = null; state.reviewFailed = false;
      try {
        const review = await rpc('on_deck_review_state');
        if (Array.isArray(review?.proposals)) state.reviewState = review; else state.reviewFailed = true;
      } catch (e) { state.reviewFailed = true; }
      for (const row of state.rows) {
        const review = state.reviewState?.proposals.find(x => x.id === row.id);
        row.source_current = review?.source_current; row.preparation = review?.preparation;
      }
      render();
      message(state.reviewFailed ? 'SILO could not load the status of your recommendations. Your saved drafts are unchanged.' : '', state.reviewFailed, state.reviewFailed ? load : null);
      return !state.reviewFailed;
    } catch (e) {
      message(e.message, true, load);
      return false;
    } finally { state.loading = false; $('refresh').disabled = false; }
  }

  async function start() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { message('Missing Supabase config', true); return; }
    state.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data: { session } } = await state.db.auth.getSession();
    if (!session) { location.href = '/pages/login.html?next=' + encodeURIComponent(location.pathname); return; }
    state.co = (await cfg.ensureActiveCompany?.(state.db))?.id || null;
    if (!state.co) { message('No active company. Choose one before using On Deck.', true); return; }
    let profile = {};
    try { profile = check(await state.db.from('profiles').select('role').eq('id', session.user.id).maybeSingle()) || {}; } catch (e) { profile = {}; }
    // Deliberately not in v2/nav-config.js: this page is reached by URL while it
    // is evaluated against /v2/on-deck.html, and it would replace that entry
    // rather than sit beside it. The sidebar highlights On Deck regardless.
    window.SiloChrome?.mount({ appEl: '#silo-app', active: 'start/on-deck', user: { email: session.user.email, role: profile.role }, crumbs: [['SILO', '/v2/home.html'], ['On Deck', null]], supabaseClient: state.db });
    let allowed = false;
    try { allowed = !!await rpc('on_deck_can_review'); } catch (e) { allowed = false; }
    if (!allowed) { message('On Deck review is for company admins. Ask an owner for access.', true); return; }
    $('refresh').addEventListener('click', load);
    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
