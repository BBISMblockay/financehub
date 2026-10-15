/* On Deck: database gates are authoritative; drafts and receipts stay distinct. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.__SILO_CONFIG__ || {};
  const state = { reviewState: null, db: null, co: null, settings: {}, rows: [], selected: null, view: 'review', tab: 'draft', events: [], attempts: [], detailRequest: 0, loading: false, loaded: false, codingLoaded: false, proposalsLoaded: false, desk: 'briefing', access: { proposals: false, coding: { review: false, post: false } }, coding: null };
  const groups = { review: ['ready'], preparing: ['preparing', 'revision'], needs: ['needs_info', 'failed'], completed: ['completed', 'dismissed', 'screened'] };
  const names = { restock: 'PRODUCT RESTOCK', launch: 'LAUNCH CAMPAIGN', seo: 'SEARCH OPPORTUNITY', ads: 'AD CREATIVE' };
  const actionLabels = { restock: 'Create draft product brief', launch: 'Create launch tasks', seo: 'Create draft SEO task', ads: 'Create ad idea' };
  const modules = { restock: 'Purchasing', launch: 'Marketing', seo: 'Marketing', ads: 'Marketing' };
  const effect = { restock: 'DRAFT BRIEF', launch: 'TASKS', seo: 'SEO TASK', ads: 'AD IDEA' };
  const destinations = { restock: ['Product workflow', '/v3/product-workflow.html', 'A draft brief with the complete product spread. Size quantities and PO approval follow there.'], launch: ['Launch calendar', '/v2/launch-calendar.html', 'Open marketing tasks with the exact approved copy. No publishing or messages.'], seo: ['SEO tasks', '/v2/seo-tasks.html', 'An editable SEO task. Publishing requires separate review.'], ads: ['Ad Studio', '/v2/ad-studio.html', 'An idea with a frozen evidence baseline. No campaign or budget changes.'] };
  const when = v => v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not yet';
  function node(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
  function button(text, fn, primary) { const b = node('button', text, `bcn-btn ${primary ? 'bcn-btn--primary' : 'bcn-btn--ghost'}`); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function message(text, bad = false, id = 'status', retry = null) {
    const el = $(id); el.replaceChildren(); el.className = 'bcn-status' + (bad ? ' bcn-status--neg' : ''); el.hidden = !text;
    if (!text) return;
    el.append(node('span', text));
    // A failure the user can act on gets an action, never an instruction to
    // install something that is already installed.
    if (retry) el.append(button('Retry', retry));
  }
  function check(result) { if (result.error) throw new Error(result.error.message || 'Request failed'); return result.data; }
  async function rpc(name, args) { return check(await state.db.rpc(name, args)); }
  function selected() { return state.rows.find(p => p.id === state.selected); }
  // The single status every surface renders. Never computed inline again.
  function statusOf(p) { return window.SiloOnDeckBriefing.statusOf(p, { settings: state.settings, review: state.reviewState, now: Date.now() }); }
  function safeLink(label, href) {
    const a = node('a', label); try { const u = new URL(href, location.origin); if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) { a.href = u.href; a.rel = 'noopener noreferrer'; } } catch { /* render plain text */ } return a;
  }
  function receiptLink(p) {
    const out = p.output || {}, links = node('div', null, 'od-buttons'); if (out.label) links.append(node('p', out.label));
    const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    const ids = out.kind === 'launch_tasks' ? (out.ids || []).filter(uuid) : uuid(out.id) ? [out.id] : [];
    ids.forEach((id, i) => {
      const path = { seo_task: '/v2/seo-tasks.html?task=', ad_idea: '/v2/ad-studio.html?view=ideas&idea=', product_brief: '/v3/product-workflow.html?brief=', launch_tasks: '/v2/tasks.html?task=' }[out.kind];
      if (path) links.append(safeLink(ids.length > 1 ? 'Open task ' + (i + 1) : 'Open created ' + ({ seo_task: 'SEO task', ad_idea: 'idea', product_brief: 'brief', launch_tasks: 'task' }[out.kind]), path + id));
    });
    if (!links.querySelector('a')) links.append(node('p', 'The exact result link is unavailable. Reload before continuing.'));
    return links;
  }
  async function companyStillActive() {
    if ((await cfg.ensureActiveCompany(state.db))?.id !== state.co) {
      state.loaded = state.proposalsLoaded = state.codingLoaded = false;
      state.rows = []; state.settings = {}; state.coding?.close();
      $('briefing').hidden = $('all-work-top').hidden = $('workspace').hidden = true;
      $('prepare').disabled = true;
      throw new Error('Active company changed. Reload On Deck before continuing.');
    }
  }
  async function load() {
    if (state.loading) return;
    state.loading = true; $('refresh').disabled = true; $('briefing').setAttribute('aria-busy', 'true');
    try {
      await companyStillActive();
      // Two independent access paths. A failure in one never hides the other.
      const errors = [];
      state.codingLoaded = false; state.proposalsLoaded = false; state.reviewFailed = false;
      if (state.access.coding.review) { try { await state.coding.load(); state.codingLoaded = true; } catch (e) { state.coding.close(); errors.push(installMessage(e, 'Transaction coding review')); } }
      if (state.access.proposals) {
        try {
          const [settings, active, history] = await Promise.all([
            state.db.from('on_deck_settings').select('*').eq('company_entity_id', state.co).maybeSingle(),
            state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', ['ready', 'preparing', 'revision', 'needs_info', 'failed']).order('created_at'),
            state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', groups.completed).order('updated_at', { ascending: false }).limit(100),
          ]);
          state.settings = check(settings) || {}; state.rows = [...check(active), ...check(history)]; state.proposalsLoaded = true;
          state.reviewState = null;
          // This call decides every proposal's status. If it fails, say so and
          // offer a retry: do not guess a status and do not blame an install.
          try { const review = await rpc('on_deck_review_state'); if (Array.isArray(review?.proposals)) state.reviewState = review; else state.reviewFailed = true; }
          catch (e) { state.reviewFailed = true; }
          for (const row of state.rows) { const review = state.reviewState?.proposals.find(x => x.id === row.id); row.source_current = review?.source_current; row.preparation = review?.preparation; }
          $('workspace').hidden = false; $('prepare').disabled = !state.settings.enabled;
          renderOverview(); renderQueue(); await select(state.selected);
        } catch (e) { state.rows = []; state.settings = {}; state.proposalsLoaded = false; $('workspace').hidden = true; $('prepare').disabled = true; errors.push(installMessage(e, 'On Deck')); }
      }
      state.loaded = true; renderReady(); renderAfter(); renderBriefing();
      if (state.reviewFailed) errors.push('SILO could not load the status of your recommendations. Your saved drafts are unchanged.');
      if (errors.length) message(errors.join(' '), true, 'status', state.reviewFailed ? load : null);
      else message(state.access.proposals && !state.settings.enabled ? 'Background preparation is off. Enable it in Workspace Settings.' : '');
    } catch (e) { state.loaded = false; state.proposalsLoaded = false; state.codingLoaded = false; $('briefing').hidden = true; $('all-work-top').hidden = true; $('workspace').hidden = true; message(installMessage(e, 'On Deck'), true); }
    finally { state.loading = false; $('refresh').disabled = false; $('briefing').setAttribute('aria-busy', 'false'); }
  }
  function setDesk(desk, focus = false) {
    state.desk = desk; document.body.dataset.desk = desk;
    for (const b of $('desk-views').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.desk === desk));
    $('desk-title').textContent = desk === 'briefing' ? 'Your next move.' : 'All work.';
    $('desk-subtitle').textContent = desk === 'briefing' ? 'One useful action, backed by your connected business.' : 'Prepared drafts, evidence, items needing input and recorded actions.';
    if (desk === 'briefing') state.coding?.close();
    if (focus) { $('desk-title').tabIndex = -1; $('desk-title').focus(); $('desk-title').scrollIntoView({ block: 'start' }); }
  }
  async function openBriefingAction(item, evidence = false) {
    try {
      await companyStillActive();
      // Recheck expiry at click time, including a page left open overnight.
      const current = window.SiloOnDeckBriefing.build({ rows: state.proposalsLoaded ? state.rows : [], coding: state.codingLoaded ? state.coding.items() : [] });
      if (![current.featured, ...current.secondary, ...current.upkeep].some(i => i && i.id === item.id && i.type === item.type)) { renderBriefing(); throw new Error('This recommendation is no longer available. Refresh to review current evidence.'); }
      setDesk('work');
      if (item.type === 'coding') { await state.coding.open(item.id); $('coding-review').scrollIntoView({ block: 'start' }); $('coding-review').tabIndex = -1; $('coding-review').focus(); }
      else { state.view = item.readiness === 'investigate' ? 'needs' : 'review'; state.selected = item.id; state.tab = evidence || item.readiness === 'investigate' ? 'brief' : 'draft'; renderQueue(); await select(item.id); $('detail').tabIndex = -1; $('detail').focus(); $('workspace').scrollIntoView({ block: 'start' }); }
    } catch (e) { message(e.message, true); }
  }
  function renderBriefing() {
    if (!state.loaded) return;
    const box = $('briefing'); box.replaceChildren(); box.hidden = false;
    const model = window.SiloOnDeckBriefing.build({ rows: state.proposalsLoaded ? state.rows : [], coding: state.codingLoaded ? state.coding.items() : [] });
    const checked = node('p', null, 'od-briefing-status bcn-mono');
    checked.append(node('span', state.proposalsLoaded && state.settings.last_screen_at ? `Screened ${when(state.settings.last_screen_at)}` : 'Connected work reviewed', 'od-meta'));
    if ((!state.proposalsLoaded && state.access.proposals) || (!state.codingLoaded && state.access.coding.review)) checked.append(node('span', 'Some connected work could not be loaded. See the notice above.'));
    box.append(checked);
    if (state.proposalsLoaded) {
      box.append(node('p', window.SiloOnDeckBriefing.currentStatus(state.rows).text, 'od-attention'));
      if (/^Preparation failed/.test(state.settings.last_status || '')) box.append(node('p', state.settings.last_status, 'od-attention'));
      if (state.settings.requested_at && new Date(state.settings.requested_at) > new Date(state.settings.last_screen_at || 0)) box.append(node('p', 'Refresh requested. Waiting for the next scheduler run; this is not a completed preparation.'));
    }
    const layout = node('div', null, 'od-briefing-layout'); box.append(layout);
    const item = model.featured;
    if (item) {
      const hero = node('article', null, 'bcn-card od-hero'); hero.dataset.recommendation = item.id;
      const head = node('div', null, 'bcn-card-header od-opportunity-head');
      head.append(signalIcon(item.kind), node('span', `TODAY’S OPPORTUNITY · ${item.category}`, 'bcn-mono'));
      const label = node('span', item.readiness === 'investigate' ? 'Needs context' : 'Draft ready', 'od-signal-status'); label.dataset.status = item.readiness === 'investigate' ? 'context' : 'ready'; head.append(label); hero.append(head);
      const body = node('div', null, 'bcn-card-body'); body.append(node('h2', item.headline), node('p', item.finding, 'od-finding'));
      const metrics = node('dl', null, 'od-briefing-metrics'); item.metrics.forEach(([label, value]) => evidenceCard(metrics, label, value)); body.append(metrics);
      const reasons = node('div', null, 'od-briefing-reasons');
      [['Why act', item.why], ['Potential benefit', item.benefit]].forEach(([label, value]) => { const col = node('div'); col.append(node('h3', label, 'bcn-mono'), node('p', value)); reasons.append(col); }); body.append(reasons);
      const assumptions = node('details', null, 'od-briefing-assumptions'); assumptions.append(node('summary', 'Assumptions and how to check the outcome'), node('p', item.caveat), node('p', item.measure)); body.append(assumptions); hero.append(body);
      const foot = node('div', null, 'bcn-card-foot od-prepared'); foot.append(node('p', item.prepared), button(item.action, () => openBriefingAction(item), true));
      if (item.type === 'proposal') foot.append(button('See evidence', () => openBriefingAction(item, true))); hero.append(foot);
      const sources = node('div', null, 'od-briefing-sources'); sources.append(node('span', 'Review first. Nothing publishes, orders or changes your budget automatically.'), node('span', item.sources, 'bcn-mono')); hero.append(sources); layout.append(hero);
    } else {
      const empty = node('section', null, 'bcn-card od-briefing-empty');
      empty.append(node('h2', 'No growth opportunity to recommend yet.'), node('p', model.watching ? 'Some opportunities are still being prepared or need stronger evidence or input. They remain available in All work.' : 'Prepared recommendations will appear when your connected evidence supports a useful next step.'));
      empty.append(button('View all work', () => setDesk('work', true)));
      if (state.access.proposals && state.proposalsLoaded && state.settings.enabled) empty.append(button('Request refreshed opportunities', requestPreparation, true));
      if (state.access.proposals && state.proposalsLoaded && !state.settings.enabled) empty.append(safeLink('Set up background preparation', '/v2/settings-company.html#on-deck-settings'));
      layout.append(empty);
      if (state.proposalsLoaded) {
        const diagnostics = node('details'); diagnostics.append(node('summary', `Last successful screening: ${when(state.settings.last_screen_at)}`));
        const held = Object.entries(state.settings.diagnostics?.held || {});
        if (held.length) held.forEach(([reason,count]) => diagnostics.append(node('p', `${count} held: ${reason}`)));
        else diagnostics.append(node('p', 'No saved screening reasons are available yet.'));
        diagnostics.append(node('p', 'These are prior screening results, not current ready drafts. Restock gates check identity and product policy before the cost ceiling.'));
        empty.append(diagnostics);
      }
    }
    const supporting = [...model.secondary, ...model.upkeep].slice(0, 2);
    if (supporting.length) {
      const more = node('section', null, 'bcn-card od-secondary'); const head = node('div', null, 'bcn-card-header'); head.append(node('h2', 'ALSO WORTH A LOOK', 'bcn-mono')); more.append(head);
      supporting.forEach(i => {
        const row = node('div', null, 'od-briefing-row'); row.dataset.recommendation = i.id;
        row.dataset.role = i.type === 'coding' || i.kind === 'launch' ? 'upkeep' : 'opportunity';
        const words = node('div'); const caption = node('div', null, 'od-row-caption'); caption.append(signalIcon(i.kind), node('span', i.type === 'coding' ? 'BOOKKEEPING' : i.category, 'bcn-mono'));
        words.append(caption, node('h3', i.type === 'coding' ? 'Keep your books current' : i.headline), node('p', i.type === 'coding' ? `${i.metrics[0][1]} suggested classifications · routine upkeep.` : i.sources));
        row.append(words, button(i.action, () => openBriefingAction(i))); more.append(row);
      }); layout.append(more);
    }
    const watch = node('section', null, 'bcn-card od-watch'); const words = node('div');
    const monitoring = state.proposalsLoaded && state.settings.enabled;
    words.append(node('h2', monitoring ? 'Background watch' : 'Your connected work'), node('p', `${model.opportunities} growth ${model.opportunities === 1 ? 'opportunity' : 'opportunities'} · ${model.preparing} preparing · ${model.needsInput} needing input. Evidence, revisions and all remaining work are available in All work.`));
    watch.append(signalIcon('watch'), words, button('All work →', () => setDesk('work', true))); box.append(watch);
    const recent = state.proposalsLoaded ? state.rows.find(p => p.status === 'completed' && p.output) : null;
    if (recent) {
      const result = node('section', null, 'bcn-card od-watch'); const copy = node('div');
      copy.append(node('h2', 'Recent action recorded'), node('p', `${title(recent)} · ${recent.output.label || 'Draft work created'}. Approval is not proof of business lift.`));
      result.append(copy, button('View recorded action', () => { setDesk('work'); state.view = 'completed'; state.selected = recent.id; state.tab = 'impact'; renderQueue(); select(recent.id).catch(e => message(e.message, true)); $('workspace').scrollIntoView({ block: 'start' }); })); box.append(result);
    }
    // Keep consequential unknown posting outcomes visible even in the briefing.
    const unresolved = state.codingLoaded ? state.coding.items().filter(i => i.stage_reason === 'posting_unresolved') : [];
    if (unresolved.length) { const warning = node('p', `${unresolved.length} QuickBooks posting outcome${unresolved.length === 1 ? '' : 's'} need checking. Open All work to inspect the entry.`, 'od-attention'); warning.setAttribute('role', 'status'); box.append(warning); }
  }
  function installMessage(e, what) {
    return /does not exist|schema cache|could not find/i.test(e.message)
      ? `${what} is not installed in this environment yet. Apply the On Deck migrations before using it.` : e.message;
  }
  /* "Ready for your review": real records only -- coding batches from the
     finance queue and proposals a person must decide. No placeholders. */
  function proposalCard(p) {
    const c = node('article', null, 'od-rcard'); c.dataset.proposal = p.id;
    const st = statusOf(p), ready = st.key === 'ready';
    const top = node('div', null, 'od-rcard-top');
    top.append(mark(p.kind), node('span', modules[p.kind] || 'Workflow', 'od-rcard-module'), node('span', ready ? effect[p.kind] : st.label.toUpperCase(), `od-rpill od-rpill--${st.tone}`));
    c.append(top, node('h3', title(p)), node('p', names[p.kind].charAt(0) + names[p.kind].slice(1).toLowerCase(), 'od-rcard-sub'));
    const missing = p.content?.missing || [];
    c.append(node('p', ready ? destinations[p.kind][2] : st.detail || 'Additional input is needed before approval. Open the proposal to inspect what is missing.', 'od-rcard-detail'));
    const ev = node('details', null, 'od-rcard-evidence'); ev.append(node('summary', `Why it is here · draft v${p.version}`), node('p', p.selection_reason)); c.append(ev);
    c.append(button('Review →', () => {
      setDesk('work'); state.view = p.status === 'ready' ? 'review' : ['preparing','revision'].includes(p.status) ? 'preparing' : 'needs'; state.selected = p.id; state.tab = 'draft'; renderQueue();
      select(p.id).catch(e => message(e.message, true)); $('workspace').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, true));
    return c;
  }
  function renderReady() {
    const grid = $('ready-cards'); grid.replaceChildren();
    // Recorded entries are done in SILO and belong under "After approval".
    const coding = state.codingLoaded ? state.coding.items().filter(i => !window.SiloOnDeckCoding.isRecorded(i)) : [];
    const proposals = state.proposalsLoaded ? state.rows.filter(p => ['ready', 'needs_info', 'failed'].includes(p.status)) : [];
    coding.forEach(i => grid.append(state.coding.card(i)));
    proposals.forEach(p => grid.append(proposalCard(p)));
    state.coding?.markActive();
    const reviewable = coding.filter(i => window.SiloOnDeckCoding.isPending(i)).length + proposals.filter(p => statusOf(p).key === 'ready').length;
    $('ready-count').textContent = String(reviewable);
    $('ready-section').hidden = false;
    if (!grid.children.length) {
      const empty = node('div', null, 'od-empty');
      empty.append(node('strong', 'Nothing is waiting for you.'), node('span', 'Prepared work appears here when it is ready for a decision. SILO does not fill this space with weak suggestions.'));
      grid.append(empty);
    }
  }
  /* "After approval": what actually happened, with the record it created. */
  function renderAfter() {
    const box = $('after-cards'); box.replaceChildren(); const att = $('attention'); att.replaceChildren();
    const posted = state.codingLoaded ? state.coding.items().filter(i => window.SiloOnDeckCoding.isRecorded(i)) : [];
    const done = state.access.proposals ? state.rows.filter(p => p.status === 'completed').slice(0, 3) : [];
    posted.slice(0, 6).forEach(i => {
      const c = node('article', null, 'od-after'); c.dataset.batch = i.batch_id;
      const sent = i.stage === 'posted';
      // Without the ledger installed (ledger_legacy) nothing is recorded in SILO's
      // books: the card describes the QuickBooks entry alone, never a ledger record.
      const legacy = !!i.ledger_legacy;
      const doc = i.qbo_doc_number || i.qbo_journal_entry_id || 'entry';
      c.append(node('span', legacy ? (sent ? 'In QuickBooks' : 'Approved') : 'In SILO ledger', 'od-rpill od-rpill--posted'),
        node('h3', legacy ? (sent ? 'Posted to QuickBooks' : 'QuickBooks entry approved') : 'Transactions recorded'),
        node('p', [i.source_name, i.label].filter(Boolean).join(' · '), 'od-rcard-sub'));
      const dl = node('dl'); evidenceCard(dl, 'OWNER', 'Finance'); evidenceCard(dl, 'RECORD', legacy ? 'QuickBooks entry' : 'SILO ledger');
      evidenceCard(dl, 'QUICKBOOKS', legacy ? (sent ? `Posted · ${doc}` : 'Approved, not sent yet') : (sent ? `Also sent · ${doc}` : 'Not sent (optional)'));
      c.append(dl);
      if (i.stage_reason !== 'posting_disabled') c.append(button('View entry', () => state.coding.open(i.batch_id)));
      box.append(c);
    });
    done.forEach(p => {
      const c = node('article', null, 'od-after');
      c.append(node('span', 'Completed', 'od-rpill od-rpill--posted'), node('h3', title(p)), node('p', p.output?.label || 'Action recorded', 'od-rcard-sub'));
      const dl = node('dl'); evidenceCard(dl, 'OWNER', modules[p.kind] || 'Workflow'); c.append(dl, receiptLink(p)); box.append(c);
    });
    const unresolved = state.codingLoaded ? state.coding.items().filter(i => i.stage_reason === 'posting_unresolved').length : 0;
    const failed = state.access.proposals ? state.rows.filter(p => p.status === 'failed').length : 0;
    const notes = [];
    if (unresolved) notes.push(`${unresolved} journal ${unresolved === 1 ? 'entry has' : 'entries have'} an unknown posting outcome. Open ${unresolved === 1 ? 'it' : 'them'} in Transactions to check QuickBooks.`);
    if (failed) notes.push(`${failed} proposal${failed === 1 ? '' : 's'} could not be prepared. See “Needs you” in Workflow proposals.`);
    notes.forEach(t => { const n = node('div', null, 'od-attention'); n.setAttribute('role', 'status'); n.append(node('strong', '!', 'od-attention-mark'), node('span', t)); att.append(n); });
    $('after-section').hidden = !box.children.length && !att.children.length;
  }
  function renderOverview() {
    const s = state.settings;
    $('screened-at').textContent = `Screened ${when(s.last_screen_at)}${s.requested_at && new Date(s.requested_at) > new Date(s.last_screen_at || 0) ? ' · Queued' : ''}`;
    const box = $('screening'); box.replaceChildren(); const d = s.diagnostics || {};
    box.append(node('p', `${d.qualified || 0} qualified · ${d.shortlisted || 0} shortlisted. Up to six active proposals; strongest candidates first.`));
    const list = node('ul'); Object.entries(d.held || {}).forEach(([reason, count]) => list.append(node('li', `${count} · ${reason}`))); box.append(list);
  }
  function signalIcon(kind) {
    const el = node('span', null, 'od-signal-icon'); el.dataset.kind = kind; el.setAttribute('aria-hidden', 'true');
    const shapes = { seo: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', ads: '<path d="M4 18V11M10 18V7M16 18V3M3 21h18"/>', restock: '<path d="m3 7 9-4 9 4-9 4-9-4v10l9 4 9-4V7M12 11v10"/>', coding: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M8 8h8M8 12h8M8 16h5"/>', launch: '<path d="M5 19 19 5M6 5h13v13"/>', watch: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>' };
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (shapes[kind] || shapes.watch) + '</svg>';
    return el;
  }
  function mark(kind) {
    const el = node('span', { launch: '↗', seo: '⌕', restock: '▦', ads: '✦' }[kind] || '◇', 'od-mark');
    el.dataset.kind = kind; el.setAttribute('aria-hidden', 'true'); return el;
  }
  function title(p) { return p.title.includes(' · ') ? p.title.split(' · ').slice(1).join(' · ') : p.title; }
  function renderQueue() {
    const visible = state.rows.filter(p => groups[state.view].includes(p.status));
    for (const b of $('views').querySelectorAll('button')) { b.setAttribute('aria-pressed', b.dataset.view === state.view); b.querySelector('b').textContent = state.rows.filter(p => groups[b.dataset.view].includes(p.status)).length; }
    if (!visible.some(p => p.id === state.selected)) state.selected = visible[0]?.id || null;
    $('queue-count').textContent = state.view === 'completed' ? 'LATEST 100' : String(visible.length).padStart(2, '0');
    const queue = $('queue'); queue.replaceChildren();
    if (!visible.length) { const empty = node('div', null, 'od-empty'); empty.append(node('strong', 'Nothing on deck here.'), node('span', state.settings.enabled ? 'No qualifying proposals in this view. Preparation will not fill the queue with weak suggestions.' : 'Enable preparation to start screening connected data.')); queue.append(empty); }
    const ordered = state.view === 'completed' ? [...visible.filter(p => p.status === 'completed'), ...visible.filter(p => p.status !== 'completed')] : visible;
    let category = null;
    ordered.forEach(p => {
      if (state.view === 'completed') { const label = p.status === 'completed' ? 'Created draft work' : 'Dismissed / skipped opportunities'; if (label !== category) { queue.append(node('h3', label, 'od-section-label')); category = label; } }
      const card = node('button', null, 'od-card'); card.type = 'button'; card.setAttribute('aria-pressed', p.id === state.selected);
      const top = node('div', null, 'od-card-top'); top.append(mark(p.kind), node('span', names[p.kind], 'od-kicker'));
      card.append(top, node('h3', title(p)), node('span', `${statusOf(p).label} · v${p.version}`, 'od-state'));
      card.addEventListener('click', () => { state.selected = p.id; state.tab = 'draft'; renderQueue(); select(p.id).catch(e => message(e.message, true)); }); queue.append(card);
    });
  }
  async function select(id) {
    state.selected = id; const token = ++state.detailRequest, p = selected(); state.events = []; state.attempts = []; renderDetail();
    if (!p) return;
    const [events, attempts] = await Promise.all([
      state.db.from('on_deck_events').select('*').eq('company_entity_id', state.co).eq('proposal_id', p.id).order('created_at', { ascending: false }).limit(50),
      state.db.from('on_deck_attempts').select('*').eq('company_entity_id', state.co).eq('proposal_id', p.id).order('created_at', { ascending: false }).limit(1000),
    ]);
    if (token !== state.detailRequest) return;
    state.events = check(events); state.attempts = check(attempts); renderDetail();
  }
  function evidenceCard(dl, label, value) { const item = node('div'); item.append(node('dt', label), node('dd', value == null ? 'Unknown' : value)); dl.append(item); }
  function renderDetail() {
    const detail = $('detail'), rail = $('rail'), p = selected(); detail.replaceChildren(); rail.replaceChildren();
    if (!p) { const empty = node('div', null, 'od-empty'); empty.append(node('strong', 'Good decisions start with good evidence.'), node('span', 'Your strongest opportunities will appear here with a draft, a reason to act, and a clear destination.')); detail.append(empty); return; }
    const c = p.content || {}, s = p.source || {}, drifted = p.source_current === false, expired = !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.now();
    const head = node('div', null, 'od-detail-head'); head.append(node('span', names[p.kind], 'od-pill'), node('h2', title(p)), node('p', `Draft ${p.version} · ${statusOf(p).label}`, 'od-meta')); detail.append(head);
    const B = window.SiloOnDeckBriefing, blockers = B.draftBlockers(p), editable = B.canReview(p, state.reviewState?.review_contract === 2, Date.now(), state.reviewState?.drift_warns === true);
    if (!['completed', 'dismissed', 'screened'].includes(p.status)) {
      const step = node('section', null, 'od-next-step'); step.append(node('h3', 'Your next step'));
      const prep = B.preparation(p, state.settings, state.reviewState || {});
      if (['preparing','revision','failed'].includes(p.status)) {
        const reasons = { previous_attempt: 'An earlier attempt is still finishing. Its result cannot replace this version; wait for it to finish or be reconciled.', context_open: 'Context work is still open. Record findings or detach the link before requesting new preparation.', disabled: 'Background preparation is off for this workflow. Enable it in Workspace Settings.', credit_exhausted: 'Workspace AI credit is exhausted. Add credit in Workspace Settings, then request preparation.', credit_unavailable: 'AI credit could not be checked. Retry preparation after the service recovers.', budget_cap: 'The monthly preparation cap is reached. Review the cap in Workspace Settings or wait for the next month.', daily_cap: 'The daily safety cap is reached. Try again after earlier attempts leave the 24-hour window.', screening: 'Waiting for the scheduler to screen current evidence.', drafting: 'Waiting for the scheduler to prepare a draft.', unconfirmed: 'Preparation state is unavailable. Reload to check it; no running job is confirmed.', reserved: 'A preparation attempt is running. Review the resulting version when it finishes.' };
        step.append(node('p', prep.state.charAt(0).toUpperCase() + prep.state.slice(1) + ' — ' + (reasons[prep.reason] || 'Preparation did not finish. Reload status or request fresh screening.')));
        if (c.body) step.append(node('p', 'Your previous draft is retained below for reference. It cannot authorize work using stale evidence.'));
        if (prep.state === 'paused') step.append(safeLink('Review preparation settings', '/v2/settings-company.html#on-deck-settings'));
        if (prep.state === 'running') step.append(button('Reload status', load));
      }
      // A sync that refreshed the data says so and leaves the draft usable. Only an
      // expired draft, or one whose freshness could not be read, stops the work.
      if (expired || typeof p.source_current !== 'boolean') step.append(node('p', expired ? 'The saved evidence expired. Refresh evidence to queue a fresh draft.' : 'Freshness is unavailable. Reload before saving or creating work.'));
      else if (drifted) step.append(node('p', statusOf(p).notice || '', 'od-meta'));
      if (blockers.length) { const list = node('ul', null, 'od-input-list'); blockers.forEach(x => list.append(node('li', x))); step.append(node('p', 'Still needed before creation:'), list); }
      else if (editable) step.append(node('p', 'Review the evidence and saved work, then confirm creation. Publishing and implementation happen separately.'));
      const review = button('Review draft', openEditor, true); review.disabled = !editable; step.append(review);
      if (!editable) {
        const st = statusOf(p);
        // The same status that labelled the card explains the disabled button.
        step.append(node('p', st.detail || (st.key === 'working' ? 'Wait for preparation, or keep the previous revision before editing.' : 'Saving requires confirmed current, unexpired evidence. Your prior copy remains available below.'), 'od-meta'));
        if (st.action === 'retry') step.append(button('Retry', load));
      }
      detail.append(step);
    }
    const tabs = node('nav', null, 'od-tabs'); tabs.setAttribute('aria-label', 'Proposal detail');
    [['draft', 'Prepared draft'], ['brief', 'Evidence'], ['impact', 'Outcome'], ['activity', 'History']].forEach(([key, label]) => { const b = button(label, () => { state.tab = key; renderDetail(); }); b.setAttribute('aria-pressed', state.tab === key); tabs.append(b); }); detail.append(tabs);
    const panel = node('div', null, 'od-panel');
    if (state.tab === 'brief') {
      panel.append(node('h3', 'Why this earned a place'), node('p', p.selection_reason));
      const metrics = node('dl', null, 'od-evidence');
      if (p.kind === 'restock') { const v = s.vetting || {}; evidenceCard(metrics, 'PRODUCT UNITS / 30D', v.units30); evidenceCard(metrics, 'TOTAL DAYS OF COVER', v.days_cover); evidenceCard(metrics, 'LEAD TIME', `${v.lead_days ?? '—'} days`); evidenceCard(metrics, 'REALIZED MARGIN', v.realized_margin == null ? null : `${(v.realized_margin * 100).toFixed(1)}%`); evidenceCard(metrics, 'ON HAND / INCOMING', `${v.on_hand ?? '—'} / ${v.incoming ?? '—'}`); evidenceCard(metrics, 'COST BOUND / BUY BUDGET', `${v.budget_bound?.toFixed?.(0) ?? '—'} / ${v.buying_budget ?? '—'} (company currency)`); panel.append(metrics, node('p', v.demand_note), node('div', 'Whole product first. All mapped SKUs are included; no size has been selected for purchase.', 'od-warning'), node('p', (s.skus || []).join(' · '))); }
      else if (p.kind === 'seo') { evidenceCard(metrics, 'SEARCH IMPRESSIONS', s.impressions); evidenceCard(metrics, 'CLICKS', s.clicks); evidenceCard(metrics, 'WEIGHTED POSITION', Number(s.position).toFixed(1)); evidenceCard(metrics, 'OBSERVED DAYS', s.days); panel.append(metrics, safeLink(s.url, s.url), node('p', `Current title: ${s.inspection?.title || 'Unknown'}\nCurrent description: ${s.inspection?.meta_description || 'Not present'}`)); }
      else if (p.kind === 'ads') { evidenceCard(metrics, 'OBJECTIVE', s.objective); evidenceCard(metrics, 'EVIDENCE', s.evidence); evidenceCard(metrics, 'METRIC', s.baseline?.metric_label || s.metric); evidenceCard(metrics, 'VS OBJECTIVE BASELINE', `${Number(s.index).toFixed(2)}×`); panel.append(metrics, node('p', s.current_copy), node('p', 'Meta-reported performance is observational. The variation is a test hypothesis, not a forecast.')); }
      else { evidenceCard(metrics, 'LAUNCH', s.launch_date); evidenceCard(metrics, 'AUDIENCE', s.audience); panel.append(metrics, node('p', s.design_intent)); const list = node('ul'); (s.readiness || []).forEach(r => list.append(node('li', `${r.product}: ${r.status || 'Readiness unknown'}`))); panel.append(node('h3', 'Product readiness'), list); }

      if (expired && p.status !== 'completed') panel.append(node('div', 'Evidence window expired. Refresh preparation and review the updated draft before approving.', 'od-warning'));
      const source = node('details'); source.append(node('summary', 'Inspect saved source evidence'), node('pre', JSON.stringify(s, null, 2), 'od-source')); panel.append(source);
    } else if (state.tab === 'draft') {
      if (!c.body) panel.append(node('p', p.status === 'failed' ? 'Preparation did not complete. Refresh to request a new screening.' : 'The next preparation run will draft this proposal.'));
      else { const paper = node('div', null, 'od-paper'); paper.append(node('span', 'DRAFT / FOR YOUR REVIEW', 'od-paper-label'), node('h3', c.subject), node('p', c.summary), node('p', c.body)); panel.append(paper); const tasks = node('div', null, 'od-tasks'); (c.tasks || []).forEach(t => { const task = node('details', null, 'od-task'); task.append(node('summary', t.title), node('p', t.detail)); tasks.append(task); }); panel.append(tasks); const rationale = node('details', null, 'od-rationale'); rationale.append(node('summary', 'Why this draft'), node('p', c.reason)); panel.append(rationale); }
      const savedInputs = window.SiloOnDeckBriefing.inputPlan(p);
      if (savedInputs.length) { const inputs = node('section'); inputs.append(node('h3','Inputs and saved answers')); savedInputs.forEach(i => { const entry=node('div',null,'od-review-input'); entry.append(node('strong',i.label),node('p',i.mode==='answered' ? i.answer : i.mode==='carry' ? 'Research to complete before publishing or implementing — carried into draft work.' : 'Unanswered' + (i.answer ? ' (reopened): ' + i.answer : ''))); inputs.append(entry); }); panel.append(inputs); }
      const prev = state.events.find(e => e.detail?.previous_content?.body && e.detail.previous_content.body !== c.body)?.detail.previous_content;
      if (prev) { const diff = node('details'); diff.append(node('summary', 'Compare with previous draft')); const cols = node('div', null, 'od-diff'); [prev, c].forEach((value, index) => { const col = node('div'); col.append(node('h4', index ? 'CURRENT' : 'PREVIOUS'), node('pre', [value.subject, value.summary, value.body, ...(value.tasks || []).map(t => `${t.title}\n${t.detail}`)].join('\n\n'))); cols.append(col); }); diff.append(cols); panel.append(diff); }
    } else if (state.tab === 'impact') {
      panel.append(node('h3', 'What happened'), node('p', p.output ? p.output.label : p.status === 'dismissed' ? 'Opportunity dismissed; no draft work was created. ' + (p.dismiss_reason || '') : p.status === 'screened' ? 'Skipped after screening; no draft work was created.' : 'No action has been confirmed.'));
      panel.append(node('h3', 'Observed value'), node('p', p.value_minutes == null ? 'No time saving or business outcome has been recorded. Revenue lift is not inferred from an approval.' : `${p.value_minutes} minutes saved, reported ${when(p.value_recorded_at)}.\n${p.value_note || ''}`));
      if (p.status === 'completed') panel.append(button('Record observed value', () => decision('value')));
    } else {
      panel.append(node('p', 'Latest 50 events. Previous draft content is retained for review.'));
      state.events.forEach(e => { const row = node('details', null, 'od-event'); row.append(node('summary', `${when(e.created_at)} · ${e.event_type.replaceAll('_', ' ')}`), node('pre', JSON.stringify(e.event_type.startsWith('context_') ? { note: e.detail?.note || 'Context link updated. Task details are shown only while accessible.' } : e.detail, null, 2))); panel.append(row); });
      state.attempts.slice(0, 20).forEach(a => panel.append(node('p', `${when(a.created_at)} · ${a.state}${a.error_code ? ` · ${a.error_code}` : ''}`)));
      if (p.dismiss_reason) panel.append(node('p', `Dismissed: ${p.dismiss_reason}`));
    }
    detail.append(panel);
    if (drifted && !['completed','dismissed','screened'].includes(p.status)) detail.append(node('p', p.source_version === '' ? 'Fresh screening was requested. Saved findings and your previous draft are retained; check the preparation status above.' : 'Your data has refreshed since this draft was prepared. The evidence above is what it was built on; editing and creating work are still available until it expires.', 'od-warning'));
    if (p.kind === 'seo' && c.proposed_title) detail.append(node('h3', 'Proposed search copy'), node('p', c.proposed_title), node('p', c.proposed_meta_description));
    if (c.optional_context?.length) { const extra = node('details'); extra.append(node('summary', 'Optional enrichment — not required for this draft')); c.optional_context.forEach(x => extra.append(node('p', x))); detail.append(extra); }
    if (p.kind === 'seo' && c.body && (!c.proposed_title || !c.proposed_meta_description)) detail.append(node('p', 'This draft needs a proposed SEO title and meta description. Fill them in Review draft, or request preparation separately.', 'od-warning'));
    if (p.kind === 'seo' && state.reviewState?.seo === false) detail.append(node('p', 'An SEO approver must create the SEO draft. You can still assign context work.', 'od-warning'));
    renderContext(detail, p);
    const footer = node('div', null, 'od-footer');
    if (p.status === 'completed') footer.append(receiptLink(p));
    else if (!['dismissed', 'screened'].includes(p.status)) {
      const approve = button(actionLabels[p.kind], () => decision('approve'), true);
      const denied = p.kind === 'seo' && state.reviewState?.seo !== true || p.kind === 'restock' && state.reviewState?.purchasing !== true;
      approve.disabled = !editable || p.status !== 'ready' || blockers.length > 0 || denied;
      footer.append(approve);
      if (approve.disabled) footer.append(node('p', denied ? 'A reviewer with destination approval permission must create this work.' : blockers.length ? 'Save the missing fields and required answers in Review draft before confirming creation.' : 'Creation requires a saved ready version and current evidence; check the next step above.', 'od-meta'));
      if (!['preparing', 'revision'].includes(p.status)) footer.append(button('Refresh evidence', () => simpleAction('refresh')));
      if (p.status === 'revision') footer.append(button('Keep previous draft', () => simpleAction('cancel_revision')));
      footer.append(button('Dismiss', () => decision('dismiss')));
    }
    detail.append(footer);
    const dest = destinations[p.kind], connected = node('section'); connected.append(node('span', 'ON APPROVAL →', 'od-eyebrow'), node('h3', dest[0]), node('p', 'Creates draft work for final review.')); if (p.output) connected.append(receiptLink(p)); else connected.append(safeLink('Open workspace ↗', dest[1])); rail.append(connected);
    const revision = node('section'); revision.append(node('h3', 'Give it a nudge'));
    const field = node('textarea'); field.className = 'bcn-field'; field.rows = 3; field.maxLength = 2000; field.placeholder = 'What would make this stronger?'; field.setAttribute('aria-label', 'Revision instructions');
    const revise = button('Request revision', async () => { if (!field.value.trim()) { message('Describe the revision first.', true); field.focus(); return; } revise.disabled = true; await simpleAction('revise', field.value); }, true);
    revise.disabled = !state.settings.enabled || typeof p.source_current !== 'boolean' || p.source_version === '' || state.reviewState?.review_contract !== 2 || ['completed', 'dismissed', 'screened', 'preparing', 'revision'].includes(p.status) || expired; field.disabled = revise.disabled; revision.append(field, revise, node('p', revise.disabled ? 'Revision requires enabled preparation, current evidence and an active draft.' : 'This requests paid AI preparation within your workspace limits. Saving edits does not.', 'od-meta')); rail.append(revision);
    const rules = node('section'); rules.append(node('h3', 'You have the final say'), node('p', 'Creation saves draft work only. AI revision is separate and may use credit.'), node('span', `Evidence expires ${when(p.valid_until)}`, 'od-meta')); rail.append(rules);
  }
  function renderContext(panel, p) {
    if (['completed', 'dismissed', 'screened'].includes(p.status)) return;
    const work = p.context_work || {}, task = state.reviewState?.context_tasks?.find(t => t.id === work.task_id);
    if (work.task_id) {
      panel.append(node('h3', 'Context work'));
      if (task) panel.append(node('p', task.title || 'Linked context task'), safeLink('Open context task', '/v2/tasks.html?task=' + work.task_id), node('p', `Owner: ${task.owner || 'Needs reassignment'} · ${task.status}. Review findings before importing them.`));
      else panel.append(node('p', 'Linked context task is unavailable. It may have been deleted or access changed. Detach the link to continue; its contents are not shown.'));
      if (task && work.state === 'resolved') panel.append(node('p', 'Recorded findings: ' + work.resolution));
      if (state.reviewState?.review_contract === 2) { const detach = button('Detach context link', () => openContext(p, true)); detach.disabled = ['preparing','revision'].includes(p.status); panel.append(detach); if (detach.disabled) panel.append(node('p', 'Wait for preparation before changing the context link.', 'od-meta')); }
    }
    if (!state.reviewState || (work.task_id && !task)) return;
    if (!['preparing', 'revision'].includes(p.status) && ((p.content?.missing || []).length || work.state === 'open')) {
      const assign = button(work.state === 'open' ? 'Record findings and refresh draft' : 'Assign context work', () => openContext(p));
      assign.disabled = work.state !== 'open' && !window.SiloOnDeckBriefing.canReview(p, state.reviewState?.review_contract === 2, Date.now(), state.reviewState?.drift_warns === true);
      panel.append(assign, node('p', work.state === 'open' ? 'Saving findings requests a fresh screen and may use AI credit. You can answer inputs manually in Review draft instead.' : assign.disabled ? 'Assigning context work needs confirmed current evidence.' : 'Secondary option: ask an owner to gather required facts. This does not create the proposed destination work.', 'od-meta'));
    }
  }
  let contextProposal, contextResolving, contextDetaching;
  function openContext(p, detach = false) {
    if (dialogBusy) return;
    contextProposal = p; contextDetaching = detach; contextResolving = !detach && p.context_work?.state === 'open';
    $('context-title').textContent = detach ? 'Detach unavailable or replaced context' : contextResolving ? 'Record context findings' : 'Assign required context';
    $('context-explanation').textContent = p.title;
    $('context-missing').replaceChildren(); (p.content?.missing || []).forEach(x => $('context-missing').append(node('li', x)));
    $('context-recovery').hidden = !detach; $('context-detach-note').value = ''; $('context-detach-note').required = detach; $('context-detach-note').minLength = detach ? 12 : 0; $('context-assignment').hidden = contextResolving || detach; $('context-findings-label').hidden = !contextResolving;
    const task = state.reviewState?.context_tasks?.find(t => t.id === p.context_work?.task_id);
    $('context-findings').value = contextResolving && !task?.notes_truncated && !task?.notes_are_request ? task?.notes || '' : ''; $('context-findings').required = contextResolving;
    if (contextResolving && task?.notes_are_request) $('context-explanation').textContent += ' - This task has no importable findings beyond its original request or status updates. Enter actual findings and supporting evidence.';
    if (contextResolving && task?.notes_truncated) $('context-explanation').textContent += ' - Task notes exceed the import limit. Open the context task to read all notes, then enter the findings and evidence here. No partial notes were imported.';
      if (contextResolving) $('context-explanation').textContent += ' — Review the imported findings below. Request instructions are excluded; confirm the findings and supporting evidence before saving.';
    $('context-findings').minLength = contextResolving ? 12 : 0;
    $('context-owner').replaceChildren(new Option('Choose an owner', ''));
    (state.reviewState.assignees || []).forEach(a => $('context-owner').append(new Option(a.name, a.id)));
    $('context-task').replaceChildren(new Option('Create a new task', ''));
    (state.reviewState.tasks || []).forEach(t => $('context-task').append(new Option(t.task_title, t.id)));
    $('context-submit').textContent = detach ? 'Confirm detach' : contextResolving ? 'Save findings and queue fresh draft' : 'Confirm context task';
    message('', false, 'context-error'); $('context-dialog').showModal();
  }
  $('context-form').addEventListener('submit', e => {
    e.preventDefault();
    submit(e.target, 'context-error', async () => {
      await companyStillActive();
      const task = $('context-task').value, owner = $('context-owner').value;
      if (!contextResolving && !contextDetaching && (typeof contextProposal.source_current !== 'boolean' || contextProposal.source_version === '' || !Number.isFinite(Date.parse(contextProposal.valid_until)) || Date.parse(contextProposal.valid_until) <= Date.now())) throw new Error('Evidence changed or expired. Refresh before assigning context work.');
      if (!contextResolving && !contextDetaching && !task && !owner) throw new Error('Choose an owner or an existing owned task.');
      await rpc('on_deck_context', { p_id: contextProposal.id, p_version: contextProposal.version,
        p_action: contextDetaching ? 'detach' : contextResolving ? 'resolve' : task ? 'link' : 'create', p_assignee: owner || null,
        p_task: task || null, p_note: contextDetaching ? $('context-detach-note').value.trim() : contextResolving ? $('context-findings').value.trim() : null });
    }, 'context-dialog');
  });
  async function mutate(p, action, extra = {}) { await companyStillActive(); if (['edit', 'revise', 'approve'].includes(action) && (!Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.now())) throw new Error('Evidence expired. Refresh evidence before saving or approving.'); return rpc('on_deck_decide', { p_id: p.id, p_version: p.version, p_action: action, ...extra }); }
  let actionBusy = false;
  async function simpleAction(action, note) { if (actionBusy) return; actionBusy = true; const p = selected(); try { const result = await mutate(p, action, { p_note: note || null }); state.view = action === 'refresh' ? 'needs' : action === 'revise' ? 'preparing' : result?.status === 'ready' ? 'review' : 'needs'; state.selected = p.id; state.tab = 'draft'; await load(); message(action === 'cancel_revision' ? 'Previous draft restored for review. Any model call already started still counts toward the cap.' : action === 'revise' ? 'Revision queued. Your previous draft remains in history; approval waits for the new version.' : 'Fresh screening requested; previous copy retained. Check the preparation status for queued, running or paused work.'); } catch (e) { message(e.message, true); renderDetail(); } finally { actionBusy = false; } }
  let dialogProposal, dialogAction;
  function decision(action) {
    if (dialogBusy) return;
    dialogProposal = selected(); dialogAction = action; $('decision-note').value = ''; $('minutes').value = dialogProposal.value_minutes ?? ''; message('', false, 'decision-error');
    const approve = action === 'approve', value = action === 'value';
    $('decision-title').textContent = approve ? actionLabels[dialogProposal.kind] : value ? 'Record observed value' : 'Dismiss proposal';
    $('decision-explanation').textContent = approve ? `${destinations[dialogProposal.kind][2]} You are approving version ${dialogProposal.version}.` : value ? 'Record time saved and an observed outcome. This is a human report, not automated revenue attribution.' : 'Why is this not worth pursuing? This source will be held for 30 days.';
    $('minutes-label').hidden = !value; $('minutes').required = value; $('decision-note').required = !approve || dialogProposal.kind === 'restock'; $('decision-note').minLength = approve && dialogProposal.kind === 'restock' ? 12 : 1;
    const checks = $('decision-checks'); checks.replaceChildren();
    if (approve && dialogProposal.kind === 'restock') ['I reviewed whole-product demand, including promotions and stockouts.', 'I verified realized margin, seasonality and supplier lead time.', 'I checked incoming purchases and the cash budget. Size allocation is still undecided.'].forEach(label => { const row = node('label', null, 'od-check'), input = node('input'); input.type = 'checkbox'; input.required = true; row.append(input, node('span', label)); checks.append(row); });
    $('decision-submit').textContent = approve ? `Confirm · ${actionLabels[dialogProposal.kind]}` : value ? 'Save observed value' : 'Dismiss for 30 days'; $('decision-dialog').showModal();
  }
  function addTask(t = { title: '', detail: '' }) {
    if ($('edit-tasks').children.length >= 5) return;
    const row = node('div', null, 'od-review-task'), title = node('input'), detail = node('textarea');
    title.className = detail.className = 'bcn-field'; title.value = t.title; title.maxLength = 200; title.required = true; title.setAttribute('aria-label', 'Launch task title');
    detail.value = t.detail; detail.maxLength = 1500; detail.rows = 3; detail.setAttribute('aria-label', 'Launch task detail');
    row.append(title, detail, button('Remove task', () => { row.remove(); $('edit-add-task').disabled = false; updateReviewBlockers(); })); $('edit-tasks').append(row); $('edit-add-task').disabled = $('edit-tasks').children.length >= 5;
  }
  function editorPatch() {
    const content = { ...dialogProposal.content, recommend: true, tasks: dialogProposal.content?.tasks || [] };
    ['subject','summary','body','reason'].forEach(k => { content[k] = $('edit-' + k).value; });
    if (dialogProposal.kind === 'seo') { content.proposed_title = $('edit-seo-title').value.trim(); content.proposed_meta_description = $('edit-seo-meta').value.trim(); }
    if (dialogProposal.kind === 'launch') content.tasks = [...$('edit-tasks').children].map(row => ({ title: row.querySelector('input').value.trim(), detail: row.querySelector('textarea').value }));
    const answers = [...$('edit-missing').children].map(row => ({ value: row.querySelector('textarea').value, carry: !!row.querySelector('[data-carry]')?.checked, reopen: row.querySelector('[data-reopen]')?.checked }));
    return window.SiloOnDeckBriefing.prepareHandoff({ ...dialogProposal, content }, answers, $('edit-note').value.trim());
  }
  function updateReviewBlockers() {
    try { const patch = editorPatch(), blockers = window.SiloOnDeckBriefing.draftBlockers({ ...dialogProposal, content: patch.content }); $('edit-blockers').textContent = blockers.length ? 'Before creation: ' + blockers.join(' · ') : 'No draft fields remain blocked. Save, then separately confirm creation.'; }
    catch (e) { $('edit-blockers').textContent = e.message; }
  }
  function openEditor() {
    if (dialogBusy || !window.SiloOnDeckBriefing.canReview(selected(), state.reviewState?.review_contract === 2, Date.now(), state.reviewState?.drift_warns === true)) return;
    dialogProposal = selected(); const c = dialogProposal.content || {};
    ['subject', 'summary', 'body','reason'].forEach(key => { $('edit-' + key).value = c[key] || ''; }); $('edit-note').value = ''; $('edit-reload').hidden = true; message('', false, 'edit-error');
    $('edit-seo').hidden = dialogProposal.kind !== 'seo'; $('edit-seo-title').value = c.proposed_title || ''; $('edit-seo-meta').value = c.proposed_meta_description || '';
    const evidence = $('edit-evidence-content'); evidence.replaceChildren(node('p', dialogProposal.selection_reason));
    if (dialogProposal.kind === 'seo') evidence.append(node('p', 'Current title: ' + (dialogProposal.source?.inspection?.title || 'Unknown')), node('p', 'Current description: ' + (dialogProposal.source?.inspection?.meta_description || 'Unknown')));
    const source = node('details'); source.append(node('summary', 'Inspect saved evidence'), node('pre', JSON.stringify(dialogProposal.source, null, 2), 'od-source')); evidence.append(source);
    $('edit-tasks').replaceChildren(); if (dialogProposal.kind === 'launch') (c.tasks || []).forEach(addTask); $('edit-task-rules').hidden = dialogProposal.kind !== 'launch'; $('edit-add-task').hidden = dialogProposal.kind !== 'launch'; $('edit-add-task').disabled = $('edit-tasks').children.length >= 5;
    const inputs = $('edit-missing'); inputs.replaceChildren();
    window.SiloOnDeckBriefing.inputPlan(dialogProposal).forEach(item => {
      const row = node('section', null, 'od-review-input'), label = node('label', item.label + (item.research ? ' — optional research' : ' — required fact')), answer = node('textarea');
      answer.className = 'bcn-field'; answer.rows = 3; answer.maxLength = 1200; answer.value = item.answer || ''; answer.setAttribute('aria-label', item.label); label.append(answer); row.append(label);
      if (item.research) { const carry = node('input'); carry.type = 'checkbox'; carry.dataset.carry = ''; carry.checked = item.mode === 'carry'; const choice = node('label', null, 'od-check'); choice.append(carry, node('span', 'Carry unanswered research into created work')); row.append(choice); }
      const reopen = node('input'); reopen.type = 'checkbox'; reopen.dataset.reopen = ''; reopen.checked = item.mode === 'unanswered' && !!item.answer; const choice = node('label', null, 'od-check'); choice.append(reopen, node('span', reopen.checked ? 'Keep this answer open until verified' : 'Reopen this answer (keep text for reference)')); row.append(choice); inputs.append(row);
    });
    $('edit-input-heading').hidden = !inputs.children.length; updateReviewBlockers(); $('edit-dialog').showModal();
  }
  $('edit-reload').addEventListener('click', async () => { if (dialogBusy) return; $('edit-reload').disabled = true; await load(); $('edit-dialog').close(); $('edit-reload').disabled = false; openEditor(); });
  $('edit-add-task').addEventListener('click', () => { addTask(); updateReviewBlockers(); });
  $('edit-form').addEventListener('input', updateReviewBlockers);
  let dialogBusy = false;
  async function submit(form, errorId, fn, dialog) {
    if (dialogBusy) return;
    dialogBusy = true;
    const controls = [...$(dialog).querySelectorAll('button')], disabled = controls.map(b => b.disabled);
    controls.forEach(b => { b.disabled = true; });
    try { await fn(); $(dialog).close(); await load(); } catch (e) { message(e.message, true, errorId); if (dialog === 'edit-dialog') $('edit-reload').hidden = false; }
    finally { controls.forEach((b,i) => { b.disabled = disabled[i]; }); dialogBusy = false; }
  }
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('cancel', e => { if (dialogBusy) e.preventDefault(); }));
  $('decision-form').addEventListener('submit', e => { e.preventDefault(); const proposal = dialogProposal, action = dialogAction; submit(e.target, 'decision-error', async () => { await mutate(proposal, action, { p_note: $('decision-note').value.trim(), p_minutes: action === 'value' ? Number($('minutes').value) : null }); if (['approve', 'dismiss'].includes(action)) { state.view = 'completed'; state.selected = proposal.id; state.tab = 'impact'; } }, 'decision-dialog'); });
  $('edit-form').addEventListener('submit', e => {
    e.preventDefault(); const proposal = dialogProposal;
    try {
      const patch = editorPatch();
      if (window.SiloOnDeckBriefing.creationBody(patch.content).length > 5000) throw new Error('Draft copy and saved answers must fit the combined 5000-character limit.');
      if (proposal.kind === 'launch') { const tasks = patch.content.tasks; if (tasks.length < 1 || tasks.length > 5 || new Set(tasks.map(t => t.title.trim().toLowerCase())).size !== tasks.length) throw new Error('Before Save, provide one to five launch tasks with unique titles.'); }
      if (patch.note.trim().length < 12) throw new Error('Explain your review in at least 12 characters.');
      submit(e.target, 'edit-error', async () => {
        const saved = await mutate(proposal, 'edit', { p_content: patch.content, p_note: patch.note });
        state.view = (saved?.status || (window.SiloOnDeckBriefing.draftBlockers({ ...proposal, content: patch.content }).length ? 'needs_info' : 'ready')) === 'ready' ? 'review' : 'needs'; state.selected = proposal.id; state.tab = 'draft';
      }, 'edit-dialog');
    } catch (e) { message(e.message, true, 'edit-error'); }
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { if (!dialogBusy) b.closest('dialog').close(); }));
  $('refresh').addEventListener('click', load);
  $('desk-views').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { if (b.dataset.desk === 'briefing') renderBriefing(); setDesk(b.dataset.desk); }));
  async function requestPreparation() { if (actionBusy) return; actionBusy = true; $('prepare').disabled = true; try { await companyStillActive(); await rpc('on_deck_request_preparation'); await load(); message('Screening requested for the next hourly scheduler run. There is no charge until a qualified proposal is drafted.'); } catch (e) { message(e.message, true); $('prepare').disabled = !state.settings.enabled; } finally { actionBusy = false; } }
  $('prepare').addEventListener('click', requestPreparation);
  $('views').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; state.tab = 'draft'; renderQueue(); select(state.selected).catch(e => message(e.message, true)); }));
  async function init() {
    try {
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) throw new Error('SILO connection configuration is unavailable.');
      state.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      const auth = check(await state.db.auth.getSession()); if (!auth.session) { message('Sign in to SILO to open On Deck.'); $('status').append(' ', safeLink('Sign in', '/pages/login.html')); return; }
      state.co = (await cfg.ensureActiveCompany(state.db))?.id; if (!state.co) throw new Error('Select an active company before opening On Deck.');
      const profile = check(await state.db.from('profiles').select('email,role').eq('id', auth.session.user.id).maybeSingle());
      window.SiloChrome?.mount({ appEl: '#silo-app', active: 'start/on-deck', user: { email: profile?.email || auth.session.user.email || '', role: profile?.role || '' }, crumbs: ['On Deck'], supabaseClient: state.db });
      // Coding review is gated in the database to the finance population;
      // proposals to company owner/admin membership. Either one opens the page.
      const missing = e => /does not exist|schema cache|could not find/i.test(e.message);
      let absent = 0;
      try { state.access.proposals = !!(await rpc('on_deck_can_review')); } catch (e) { if (!missing(e)) throw e; absent++; }
      try { const a = await rpc('on_deck_coding_access'); state.access.coding = { review: !!a?.review, post: !!a?.post }; } catch (e) { if (!missing(e)) throw e; absent++; }
      if (absent === 2) throw new Error('On Deck is not installed in this environment yet. Apply the On Deck migrations first.');
      if (!state.access.proposals && !state.access.coding.review) throw new Error('On Deck requires an active company owner or admin membership, or finance access.');
      if (state.access.coding.review) state.coding = window.SiloOnDeckCoding.mount({ db: state.db, co: state.co, cfg, access: state.access.coding, reviewEl: $('coding-review'), message, stillActive: companyStillActive, onChange: async () => { renderReady(); renderAfter(); renderBriefing(); } });
      $('prepare').hidden = !state.access.proposals; $('settings-link').hidden = !state.access.proposals;
      await load();
      const linked = new URLSearchParams(location.search).get('proposal'), match = state.rows.find(p => p.id === linked);
      if (match) { setDesk('work'); state.view = Object.keys(groups).find(k => groups[k].includes(match.status)); renderQueue(); await select(match.id); }
    } catch (e) { message(/does not exist|schema cache|could not find/i.test(e.message) ? 'On Deck is not installed in this environment yet. Apply the preview migration before enabling preparation.' : e.message, true); }
  }
  init();
})();
