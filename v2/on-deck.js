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
  function message(text, bad = false, id = 'status') { const el = $(id); el.textContent = text; el.className = 'bcn-status' + (bad ? ' bcn-status--neg' : ''); el.hidden = !text; }
  function check(result) { if (result.error) throw new Error(result.error.message || 'Request failed'); return result.data; }
  async function rpc(name, args) { return check(await state.db.rpc(name, args)); }
  function selected() { return state.rows.find(p => p.id === state.selected); }
  function safeLink(label, href) {
    const a = node('a', label); try { const u = new URL(href, location.origin); if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) { a.href = u.href; a.rel = 'noopener noreferrer'; } } catch { /* render plain text */ } return a;
  }
  function receiptLink(p) { const url = p.output?.url; return url && /^\/v[23]\/[a-z-]+\.html(?:\?brief=[a-f0-9-]+)?$/.test(url) ? safeLink(p.output.label, url) : node('p', 'Action recorded. Open the destination workspace to continue.'); }
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
      state.codingLoaded = false; state.proposalsLoaded = false;
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
          try { const review = await rpc('on_deck_review_state'); if (Array.isArray(review?.proposals)) state.reviewState = review; } catch (e) { errors.push('Context actions and freshness checks unavailable. Refresh after the On Deck update is installed.'); }
          for (const row of state.rows) row.source_current = state.reviewState?.proposals.find(x => x.id === row.id)?.source_current;
          $('workspace').hidden = false; $('prepare').disabled = !state.settings.enabled;
          renderOverview(); renderQueue(); await select(state.selected);
        } catch (e) { state.rows = []; state.settings = {}; state.proposalsLoaded = false; $('workspace').hidden = true; $('prepare').disabled = true; errors.push(installMessage(e, 'On Deck')); }
      }
      state.loaded = true; renderReady(); renderAfter(); renderBriefing();
      if (errors.length) message(errors.join(' '), true);
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
      if (state.access.proposals && state.proposalsLoaded && !state.settings.enabled) empty.append(safeLink('Set up background preparation', '/v2/settings-company.html#on-deck-settings'));
      layout.append(empty);
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
    const ready = p.status === 'ready';
    const top = node('div', null, 'od-rcard-top');
    top.append(mark(p.kind), node('span', modules[p.kind] || 'Workflow', 'od-rcard-module'), node('span', ready ? effect[p.kind] : 'NEEDS INPUT', `od-rpill od-rpill--${ready ? 'proposal' : 'needs_input'}`));
    c.append(top, node('h3', title(p)), node('p', names[p.kind].charAt(0) + names[p.kind].slice(1).toLowerCase(), 'od-rcard-sub'));
    const missing = p.content?.missing || [];
    c.append(node('p', ready ? destinations[p.kind][2] : 'Additional input is needed before approval. Open the proposal to inspect what is missing.', 'od-rcard-detail'));
    const ev = node('details', null, 'od-rcard-evidence'); ev.append(node('summary', `Why it is here · draft v${p.version}`), node('p', p.selection_reason)); c.append(ev);
    c.append(button('Review →', () => {
      setDesk('work'); state.view = ready ? 'review' : 'needs'; state.selected = p.id; state.tab = 'draft'; renderQueue();
      select(p.id).catch(e => message(e.message, true)); $('workspace').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, true));
    return c;
  }
  function renderReady() {
    const grid = $('ready-cards'); grid.replaceChildren();
    // Recorded entries are done in SILO and belong under "After approval".
    const coding = state.codingLoaded ? state.coding.items().filter(i => !window.SiloOnDeckCoding.isRecorded(i)) : [];
    const proposals = state.proposalsLoaded ? state.rows.filter(p => ['ready', 'needs_info'].includes(p.status)) : [];
    coding.forEach(i => grid.append(state.coding.card(i)));
    proposals.forEach(p => grid.append(proposalCard(p)));
    state.coding?.markActive();
    const reviewable = coding.filter(i => window.SiloOnDeckCoding.isPending(i)).length + proposals.filter(p => p.status === 'ready').length;
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
    visible.forEach(p => {
      const card = node('button', null, 'od-card'); card.type = 'button'; card.setAttribute('aria-pressed', p.id === state.selected);
      const top = node('div', null, 'od-card-top'); top.append(mark(p.kind), node('span', names[p.kind], 'od-kicker'));
      card.append(top, node('h3', title(p)), node('span', `${p.status.replaceAll('_', ' ')} · v${p.version}`, 'od-state'));
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
    const c = p.content || {}, s = p.source || {}, stale = p.source_current === false, expired = !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.now();
    const head = node('div', null, 'od-detail-head'); head.append(node('span', names[p.kind], 'od-pill'), node('h2', title(p)), node('p', `Draft ${p.version} · ${p.status.replaceAll('_', ' ')}`, 'od-meta')); detail.append(head);
    if (!['completed', 'dismissed', 'screened'].includes(p.status)) {
      const step = node('section', null, 'od-next-step'); step.append(node('h3', 'Your next step'));
      if (stale) step.append(node('p', 'Source evidence changed. Refresh evidence before preparing the draft task.'));
      else if (expired) step.append(node('p', 'The saved evidence expired. Refresh evidence before preparing or creating a task.'));
      else if (['preparing', 'revision'].includes(p.status)) step.append(node('p', 'Preparation is running. Review the new version when it is ready.'));
      else if ((c.missing || []).length) {
        step.append(node('p', 'Before task creation, the saved draft needs this context. Here is exactly what is outstanding.'));
        const inputs = node('ul', null, 'od-input-list');
        window.SiloOnDeckBriefing.inputPlan(p).forEach(i => { const li = node('li'); li.append(node('span', i.research ? 'Research for the draft task' : 'Required input', i.research ? 'od-input-label od-input-label--research' : 'od-input-label'), node('span', i.label)); inputs.append(li); }); step.append(inputs);
        step.append(node('p', 'Research questions can be carried into an unpublished task without pretending they are answered. Required inputs need your information.'));
        const prep = button('Prepare draft task', openHandoff, true); prep.disabled = !c.body; step.append(prep);
      } else if (p.status === 'ready') step.append(node('p', 'Context is ready. Review the prepared copy, then use ' + actionLabels[p.kind] + ' below. Publishing and implementation happen separately.'));
      else step.append(node('p', 'A usable prepared draft is not ready yet. Refresh evidence or request a revision to continue.'));
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
      const prev = state.events.find(e => e.detail?.previous_content?.body && e.detail.previous_content.body !== c.body)?.detail.previous_content;
      if (prev) { const diff = node('details'); diff.append(node('summary', 'Compare with previous draft')); const cols = node('div', null, 'od-diff'); [prev, c].forEach((value, index) => { const col = node('div'); col.append(node('h4', index ? 'CURRENT' : 'PREVIOUS'), node('pre', [value.subject, value.summary, value.body, ...(value.tasks || []).map(t => `${t.title}\n${t.detail}`)].join('\n\n'))); cols.append(col); }); diff.append(cols); panel.append(diff); }
    } else if (state.tab === 'impact') {
      panel.append(node('h3', 'What happened'), node('p', p.output ? p.output.label : 'No action has been confirmed.'));
      panel.append(node('h3', 'Observed value'), node('p', p.value_minutes == null ? 'No time saving or business outcome has been recorded. Revenue lift is not inferred from an approval.' : `${p.value_minutes} minutes saved, reported ${when(p.value_recorded_at)}.\n${p.value_note || ''}`));
      if (p.status === 'completed') panel.append(button('Record observed value', () => decision('value')));
    } else {
      panel.append(node('p', 'Latest 50 events. Previous draft content is retained for review.'));
      state.events.forEach(e => { const row = node('details', null, 'od-event'); row.append(node('summary', `${when(e.created_at)} · ${e.event_type.replaceAll('_', ' ')}`), node('pre', JSON.stringify(e.detail, null, 2))); panel.append(row); });
      state.attempts.slice(0, 20).forEach(a => panel.append(node('p', `${when(a.created_at)} · ${a.state}${a.error_code ? ` · ${a.error_code}` : ''}`)));
      if (p.dismiss_reason) panel.append(node('p', `Dismissed: ${p.dismiss_reason}`));
    }
    detail.append(panel);
    if (stale && p.status !== 'completed') detail.append(node('p', p.source_version === '' ? 'Fresh preparation is queued. Saved findings and your previous draft are retained.' : 'Source evidence changed since this draft. Refresh evidence before editing or approving.', 'od-warning'));
    if (p.kind === 'seo' && c.proposed_title) detail.append(node('h3', 'Proposed search copy'), node('p', c.proposed_title), node('p', c.proposed_meta_description));
    if (c.optional_context?.length) { const extra = node('details'); extra.append(node('summary', 'Optional enrichment — not required for this draft')); c.optional_context.forEach(x => extra.append(node('p', x))); detail.append(extra); }
    if (p.kind === 'seo' && c.body && (!c.proposed_title || !c.proposed_meta_description)) detail.append(node('p', 'Refresh this older draft to prepare separate SEO title and meta-description fields.', 'od-warning'));
    if (p.kind === 'seo' && state.reviewState?.seo === false) detail.append(node('p', 'An SEO approver must create the SEO draft. You can still assign context work.', 'od-warning'));
    renderContext(detail, p);
    const footer = node('div', null, 'od-footer');
    if (p.status === 'completed') footer.append(receiptLink(p));
    else if (!['dismissed', 'screened'].includes(p.status)) {
      const approve = button(actionLabels[p.kind], () => decision('approve'), true); approve.disabled = p.status !== 'ready' || expired || stale || (c.missing || []).length > 0 || (p.kind === 'seo' && (!c.proposed_title || !c.proposed_meta_description || state.reviewState?.seo === false)); footer.append(approve);
      if (!['preparing', 'revision'].includes(p.status)) { const edit = button('Edit draft', openEditor); edit.disabled = !c.body || expired || stale; footer.append(edit, button('Refresh evidence', () => simpleAction('refresh'))); }
      if (p.status === 'revision') footer.append(button('Keep previous draft', () => simpleAction('cancel_revision')));
      footer.append(button('Dismiss', () => decision('dismiss')));
    }
    detail.append(footer);
    const dest = destinations[p.kind], connected = node('section'); connected.append(node('span', 'ON APPROVAL →', 'od-eyebrow'), node('h3', dest[0]), node('p', 'Creates draft work for final review.')); if (p.output) connected.append(receiptLink(p)); else connected.append(safeLink('Open workspace ↗', dest[1])); rail.append(connected);
    const revision = node('section'); revision.append(node('h3', 'Give it a nudge'));
    const field = node('textarea'); field.className = 'bcn-field'; field.rows = 3; field.maxLength = 2000; field.placeholder = 'What would make this stronger?'; field.setAttribute('aria-label', 'Revision instructions');
    const revise = button('Request revision', async () => { if (!field.value.trim()) { message('Describe the revision first.', true); field.focus(); return; } revise.disabled = true; await simpleAction('revise', field.value); }, true);
    revise.disabled = !state.settings.enabled || ['completed', 'dismissed', 'screened', 'preparing', 'revision'].includes(p.status) || expired || stale; field.disabled = revise.disabled; revision.append(field, revise); rail.append(revision);
    const rules = node('section'); rules.append(node('h3', 'You have the final say'), node('p', 'Nothing publishes or spends here.'), node('span', `Evidence expires ${when(p.valid_until)}`, 'od-meta')); rail.append(rules);
  }
  function renderContext(panel, p) {
    if (['completed', 'dismissed', 'screened'].includes(p.status)) return;
    const work = p.context_work || {};
    if (work.task_id) {
      panel.append(node('h3', 'Context work'), node('p', work.title), safeLink('Open context task', '/v2/tasks.html?task=' + work.task_id));
      const task = state.reviewState?.context_tasks?.find(t => t.id === work.task_id);
      if (task) panel.append(node('p', `Owner: ${task.owner || 'Needs reassignment'} · ${task.status}. The owner records findings in task notes; an On Deck reviewer imports and reviews them here.`));
      if (work.state === 'resolved') panel.append(node('p', 'Recorded findings: ' + work.resolution));
    }
    if (!state.reviewState) return;
    if (!['preparing', 'revision'].includes(p.status) && ((p.content?.missing || []).length || work.state === 'open')) {
      const assign = button(work.state === 'open' ? 'Record findings and refresh draft' : 'Create or link context task', () => openContext(p));
      assign.disabled = work.state !== 'open' && (p.source_current === false || !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.now());
      panel.append(assign);
    }
  }
  let contextProposal, contextResolving;
  function openContext(p) {
    if (dialogBusy) return;
    contextProposal = p; contextResolving = p.context_work?.state === 'open';
    $('context-title').textContent = contextResolving ? 'Record context findings' : 'Assign required context';
    $('context-explanation').textContent = p.title;
    $('context-missing').replaceChildren(); (p.content?.missing || []).forEach(x => $('context-missing').append(node('li', x)));
    $('context-assignment').hidden = contextResolving; $('context-findings-label').hidden = !contextResolving;
    const task = state.reviewState?.context_tasks?.find(t => t.id === p.context_work?.task_id);
    $('context-findings').value = contextResolving && !task?.notes_truncated && !task?.notes_are_request ? task?.notes || '' : ''; $('context-findings').required = contextResolving;
    if (contextResolving && task?.notes_are_request) $('context-explanation').textContent += ' - This task still contains only its original request. Enter actual findings and supporting evidence.';
    if (contextResolving && task?.notes_truncated) $('context-explanation').textContent += ' - Task notes exceed the import limit. Open the context task to read all notes, then enter the findings and evidence here. No partial notes were imported.';
      if (contextResolving) $('context-explanation').textContent += ' — Review the imported task notes below. Replace request text with the actual findings and supporting evidence before saving.';
    $('context-findings').minLength = contextResolving ? 12 : 0;
    $('context-owner').replaceChildren(new Option('Choose an owner', ''));
    (state.reviewState.assignees || []).forEach(a => $('context-owner').append(new Option(a.name, a.id)));
    $('context-task').replaceChildren(new Option('Create a new task', ''));
    (state.reviewState.tasks || []).forEach(t => $('context-task').append(new Option(t.task_title, t.id)));
    $('context-submit').textContent = contextResolving ? 'Save findings and queue fresh draft' : 'Confirm context task';
    message('', false, 'context-error'); $('context-dialog').showModal();
  }
  $('context-form').addEventListener('submit', e => {
    e.preventDefault();
    submit(e.target, 'context-error', async () => {
      await companyStillActive();
      const task = $('context-task').value, owner = $('context-owner').value;
      if (!contextResolving && (contextProposal.source_current === false || !Number.isFinite(Date.parse(contextProposal.valid_until)) || Date.parse(contextProposal.valid_until) <= Date.now())) throw new Error('Evidence changed or expired. Refresh before assigning context work.');
      if (!contextResolving && !task && !owner) throw new Error('Choose an owner or an existing owned task.');
      await rpc('on_deck_context', { p_id: contextProposal.id, p_version: contextProposal.version,
        p_action: contextResolving ? 'resolve' : task ? 'link' : 'create', p_assignee: owner || null,
        p_task: task || null, p_note: contextResolving ? $('context-findings').value.trim() : null });
    }, 'context-dialog');
  });
  async function mutate(p, action, extra = {}) { await companyStillActive(); if (['edit', 'revise', 'approve'].includes(action) && (!Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= Date.now())) throw new Error('Evidence expired. Refresh evidence before saving or approving.'); return rpc('on_deck_decide', { p_id: p.id, p_version: p.version, p_action: action, ...extra }); }
  async function simpleAction(action, note) { const p = selected(); try { await mutate(p, action, { p_note: note || null }); await load(); message(action === 'cancel_revision' ? 'Previous draft restored for review. Any model call already started still counts toward the cap.' : action === 'revise' ? 'Revision queued. Your previous draft remains in history; approval waits for the new version.' : 'Fresh screening requested. The next run will recheck whether this opportunity qualifies.'); } catch (e) { message(e.message, true); renderDetail(); } }
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
  function openHandoff() {
    if (dialogBusy) return;
    dialogProposal = selected(); const box = $('handoff-inputs'); box.replaceChildren(); message('', false, 'handoff-error');
    window.SiloOnDeckBriefing.inputPlan(dialogProposal).forEach((item, i) => {
      const label = node('label', null, 'od-handoff-input'); label.dataset.index = i;
      if (item.research) { const checkbox = node('input'); checkbox.type = 'checkbox'; label.append(checkbox, node('span', 'Carry into draft task: ' + item.label)); }
      else { label.append(node('span', item.label + ' — required')); const value = node('textarea'); value.rows = 3; value.maxLength = 1200; value.placeholder = 'Add the information needed to prepare this task'; value.setAttribute('aria-label', item.label); label.append(value); }
      box.append(label);
    }); $('handoff-dialog').showModal();
  }
  function openEditor() {
    if (dialogBusy) return;
    dialogProposal = selected(); const c = dialogProposal.content || {}; ['subject', 'summary', 'body'].forEach(key => { $(`edit-${key}`).value = c[key] || ''; }); $('edit-note').value = ''; message('', false, 'edit-error');
    $('edit-seo').hidden = dialogProposal.kind !== 'seo'; $('edit-seo-title').value = c.proposed_title || ''; $('edit-seo-meta').value = c.proposed_meta_description || '';
    const tasks = $('edit-tasks'); tasks.replaceChildren(); (c.tasks || []).forEach((t, i) => { const label = node('label', `Task ${i + 1}`), title = node('input'), detail = node('textarea'); title.className = detail.className = 'bcn-field'; title.value = t.title; title.maxLength = 200; title.required = true; title.setAttribute('aria-label', `Task ${i + 1} title`); detail.value = t.detail; detail.maxLength = 1500; detail.rows = 3; detail.setAttribute('aria-label', `Task ${i + 1} detail`); label.append(title, detail); tasks.append(label); });
    const missing = $('edit-missing'); missing.replaceChildren(); (c.missing || []).forEach(item => { const label = node('label', null, 'od-check'), checkbox = node('input'); checkbox.type = 'checkbox'; label.append(checkbox, node('span', `Resolved: ${item}`)); missing.append(label); }); $('edit-dialog').showModal();
  }
  let dialogBusy = false;
  async function submit(form, errorId, fn, dialog) {
    if (dialogBusy) return;
    dialogBusy = true;
    const controls = [...$(dialog).querySelectorAll('button')], disabled = controls.map(b => b.disabled);
    controls.forEach(b => { b.disabled = true; });
    try { await fn(); $(dialog).close(); await load(); } catch (e) { message(e.message, true, errorId); }
    finally { controls.forEach((b,i) => { b.disabled = disabled[i]; }); dialogBusy = false; }
  }
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('cancel', e => { if (dialogBusy) e.preventDefault(); }));
  $('handoff-dialog').querySelector('[data-handoff-close]').addEventListener('click', () => { if (!dialogBusy) $('handoff-dialog').close(); });
  $('handoff-form').addEventListener('input', () => message('', false, 'handoff-error'));
  $('handoff-form').addEventListener('submit', async e => {
    e.preventDefault();
    const proposal = dialogProposal;
    try {
      const answers = [...$('handoff-inputs').querySelectorAll('label')].map(l => ({ carry: !!l.querySelector('input')?.checked, value: l.querySelector('textarea')?.value || '' }));
      const patch = window.SiloOnDeckBriefing.prepareHandoff(proposal, answers);
      await submit(e.target, 'handoff-error', async () => { await mutate(proposal, 'edit', { p_content: patch.content, p_note: patch.note }); state.view = patch.content.missing.length ? 'needs' : 'review'; state.selected = proposal.id; state.tab = 'draft'; }, 'handoff-dialog');
      if (!$('handoff-dialog').open && state.proposalsLoaded && selected()?.id === proposal.id) message(patch.content.missing.length ? 'Task prep saved. The remaining inputs are listed above.' : 'Task prep saved. Review the copy below, then confirm draft task creation.');
    } catch (error) { message(error.message, true, 'handoff-error'); }
  });
  $('decision-form').addEventListener('submit', e => { e.preventDefault(); const proposal = dialogProposal, action = dialogAction; submit(e.target, 'decision-error', async () => { await mutate(proposal, action, { p_note: $('decision-note').value.trim(), p_minutes: action === 'value' ? Number($('minutes').value) : null }); if (['approve', 'dismiss'].includes(action)) { state.view = 'completed'; state.selected = proposal.id; state.tab = 'impact'; } }, 'decision-dialog'); });
  $('edit-form').addEventListener('submit', e => { e.preventDefault(); const proposal = dialogProposal, original = proposal.content, content = { ...original, recommend: true }; ['subject', 'summary', 'body'].forEach(k => { content[k] = $(`edit-${k}`).value; }); content.tasks = [...$('edit-tasks').querySelectorAll('label')].map(l => ({ title: l.querySelector('input').value, detail: l.querySelector('textarea').value })); const checks = [...$('edit-missing').querySelectorAll('input')]; if (proposal.kind === 'seo') { content.proposed_title = $('edit-seo-title').value.trim(); content.proposed_meta_description = $('edit-seo-meta').value.trim(); } content.missing = (original.missing || []).filter((_, i) => !checks[i].checked); submit(e.target, 'edit-error', async () => { await mutate(proposal, 'edit', { p_content: content, p_note: $('edit-note').value }); state.view = content.missing.length ? 'needs' : 'review'; state.selected = proposal.id; state.tab = 'draft'; }, 'edit-dialog'); });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { if (!dialogBusy) b.closest('dialog').close(); }));
  $('refresh').addEventListener('click', load);
  $('desk-views').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { if (b.dataset.desk === 'briefing') renderBriefing(); setDesk(b.dataset.desk); }));
  $('prepare').addEventListener('click', async () => { $('prepare').disabled = true; try { await companyStillActive(); await rpc('on_deck_request_preparation'); await load(); message('Screening requested for the next hourly scheduler run. There is no charge until a qualified proposal is drafted.'); } catch (e) { message(e.message, true); $('prepare').disabled = !state.settings.enabled; } });
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
