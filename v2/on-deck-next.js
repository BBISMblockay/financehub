/* On Deck, one screen.
   Every card answers the same three questions -- what SILO recommends and why,
   what it needs from you, and what the button does -- and carries exactly one
   button. Anything that is not a reviewable recommendation is not dressed up as
   one: it drops into "What SILO needs from you". Status comes from
   SiloOnDeckBriefing.statusOf and is never computed here; the database gates in
   on_deck_decide / on_deck_context stay authoritative, so this page only offers
   what those will accept. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.__SILO_CONFIG__ || {};
  const state = { db: null, co: null, settings: {}, rows: [], reviewState: null, reviewFailed: false, loading: false };
  const PER_KIND = 2, MAX_CARDS = 6;   // no one department takes over the surface
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

  // What the button does, said before it is pressed.
  const promises = {
    review: 'Opens this draft with its evidence. Nothing is created until you confirm there.',
    answer: 'Opens this draft so you can answer what is missing. Saving answers creates no work and runs no AI.',
    refresh: 'Asks SILO to screen your current data again and prepare a fresh draft. Your saved answers are kept.',
  };

  // One control per row, labelled with what pressing it does. A status with no
  // action (SILO is still working, or preparation is paused) gets no button:
  // there is nothing for the reader to press, and offering one would be a lie.
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

    const needs = node('div', null, 'odn-needs');
    needs.append(node('h4', 'What SILO needs from you'));
    // Only a complete draft reaches this grid (see pick), so the honest answer
    // here is "nothing"; the fallback exists so a status change between render
    // passes still reads truthfully rather than claiming completeness.
    needs.append(node('p', st.key === 'ready' ? 'Your judgement. The draft is complete; nothing is missing.' : st.detail || st.label));
    box.append(needs);

    const act = node('div', null, 'od-buttons');
    const control = actionButton(st, p);
    if (control) act.append(control); else act.append(node('span', st.label, `od-rpill od-rpill--${st.tone}`));
    box.append(act);
    if (promises[st.action]) box.append(node('p', promises[st.action], 'od-meta'));
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

  /* The brief is a factual read-back of the drafts SILO already screened: the
     same numbers the cards carry, so it reproduces exactly. It runs no AI and
     spends no tokens. */
  function renderBrief(summary) {
    const box = $('brief'); box.replaceChildren(); box.hidden = false;
    const lead = summary.ready
      ? `${summary.ready} ${summary.ready === 1 ? 'recommendation is' : 'recommendations are'} ready for you.`
      : summary.needs ? 'Nothing is ready to act on yet. SILO needs answers from you first.'
      : summary.preparing || summary.queued || summary.running ? 'SILO is still preparing. Nothing needs you yet.'
      : 'Nothing is ready to act on right now.';
    box.append(node('h2', lead));
    box.append(node('p', summary.text, 'odn-why'));
    const requested = state.settings.requested_at && new Date(state.settings.requested_at) > new Date(state.settings.last_screen_at || 0);
    box.append(node('p', `Last screened ${when(state.settings.last_screen_at)}.` + (requested ? ' A refresh is requested and waiting for the next run.' : ''), 'od-meta'));
    if (/^Preparation failed/.test(state.settings.last_status || '')) box.append(node('p', state.settings.last_status, 'od-attention'));
  }

  function renderCards(cards) {
    const box = $('cards'); box.replaceChildren(); box.hidden = false;
    box.append(node('h2', 'What SILO recommends'));
    if (!cards.length) {
      box.append(node('p', state.settings.enabled === false
        ? 'Background preparation is off for this workspace, so nothing is being prepared. An owner can turn it on in Workspace Settings.'
        : 'No recommendation is ready to act on. Anything SILO is working on, or waiting on you for, is below.', 'odn-why'));
      return;
    }
    const grid = node('div', null, 'od-ready-grid');
    cards.forEach(([item, p]) => grid.append(card(item, p)));
    box.append(grid);
  }

  // Everything that is not a recommendation: one line each, demoted on purpose.
  function renderNeeds(shown) {
    const box = $('needs'); box.replaceChildren();
    const rest = state.rows.filter(p => ['ready', 'needs_info', 'failed', 'preparing', 'revision'].includes(p.status) && !shown.has(p.id));
    box.hidden = !rest.length;
    if (!rest.length) return;
    box.append(node('h2', 'What SILO needs from you'));
    box.append(node('p', 'These are not recommendations yet. They are drafts SILO cannot finish on its own.', 'odn-why'));
    const list = node('div', null, 'odn-list');
    rest.forEach(p => {
      const st = statusOf(p), row = node('div', null, 'odn-row');
      row.append(node('span', title(p), 'odn-row-name'));
      row.append(node('span', st.label, `od-rpill od-rpill--${st.tone}`));
      if (st.detail) row.append(node('span', st.detail, 'od-meta'));
      const control = actionButton(st, p, false);
      if (control) row.append(control);
      list.append(row);
    });
    box.append(list);
  }

  function renderDone() {
    const box = $('done'); box.replaceChildren();
    const done = state.rows.filter(p => p.status === 'completed');
    box.hidden = !done.length;
    if (!done.length) return;
    box.append(node('h2', 'Recently created'));
    const list = node('div', null, 'odn-list');
    done.forEach(p => {
      const row = node('div', null, 'odn-row');
      row.append(node('span', title(p), 'odn-row-name'));
      row.append(node('span', `created ${when(p.approved_at)}`, 'od-meta'));
      const link = createdLink(p); if (link) row.append(link);
      list.append(row);
    });
    box.append(list);
  }

  /* Rank order from the briefing, then the rule that makes this surface
     trustworthy: only a draft SILO can finish on its own is presented as a
     recommendation. A draft still waiting on answers, a refresh or the
     scheduler is not an actionable business suggestion, so it drops to the
     strip below instead of being dressed up as one. Capped per department so
     one of them cannot take the page. */
  function pick(model) {
    const byId = new Map(state.rows.map(p => [p.id, p])), seen = new Map(), out = [];
    for (const item of model.cards || []) {
      const p = item.type === 'proposal' ? byId.get(item.id) : null;
      if (!p || statusOf(p).key !== 'ready') continue;
      const n = seen.get(item.kind) || 0;
      if (n >= PER_KIND || out.length >= MAX_CARDS) continue;
      seen.set(item.kind, n + 1);
      out.push([item, p]);
    }
    return out;
  }

  function render() {
    renderBrief(B().currentStatus(state.rows, Date.now(), state.reviewState?.drift_warns === true));
    const cards = pick(B().build({ rows: state.rows, coding: [], driftWarns: state.reviewState?.drift_warns === true }));
    renderCards(cards);
    renderNeeds(new Set(cards.map(([, p]) => p.id)));
    renderDone();
  }

  async function companyStillActive() {
    if ((await cfg.ensureActiveCompany?.(state.db))?.id !== state.co) throw new Error('Active company changed. Reload On Deck before continuing.');
  }

  // Returns true when the page is showing a complete, trustworthy picture.
  async function load() {
    if (state.loading) return false;
    state.loading = true; $('refresh').disabled = true;
    try {
      await companyStillActive();
      const [settings, active, history] = await Promise.all([
        state.db.from('on_deck_settings').select('*').eq('company_entity_id', state.co).maybeSingle(),
        state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', ['ready', 'preparing', 'revision', 'needs_info', 'failed']).order('created_at'),
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
    window.SiloChrome?.mount({ appEl: '#silo-app', active: 'start/on-deck-next', user: { email: session.user.email, role: profile.role }, crumbs: [['SILO', '/v2/home.html'], ['On Deck', null]], supabaseClient: state.db });
    let allowed = false;
    try { allowed = !!await rpc('on_deck_can_review'); } catch (e) { allowed = false; }
    if (!allowed) { message('On Deck review is for company admins. Ask an owner for access.', true); return; }
    $('refresh').addEventListener('click', load);
    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
