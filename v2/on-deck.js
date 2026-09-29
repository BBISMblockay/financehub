/* On Deck: database gates are authoritative; drafts and receipts stay distinct. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.__SILO_CONFIG__ || {};
  const state = { db: null, co: null, owner: false, settings: {}, stats: {}, rows: [], selected: null, view: 'review', tab: 'brief', events: [], attempts: [], detailRequest: 0, loading: false };
  const groups = { review: ['ready'], preparing: ['preparing', 'revision'], needs: ['needs_info', 'failed'], completed: ['completed', 'dismissed', 'screened'] };
  const names = { restock: 'PRODUCT RESTOCK', launch: 'LAUNCH CAMPAIGN', seo: 'SEARCH OPPORTUNITY', ads: 'AD CREATIVE' };
  const actionLabels = { restock: 'Approve product review & create brief', launch: 'Approve copy & create tasks', seo: 'Approve draft & create SEO task', ads: 'Approve draft & create ad idea' };
  const destinations = { restock: ['Product workflow', '/v3/product-workflow.html', 'A draft brief with the complete product spread. Size quantities and PO approval follow there.'], launch: ['Launch calendar', '/v2/launch-calendar.html', 'Open marketing tasks with the exact approved copy. No publishing or messages.'], seo: ['SEO tasks', '/v2/seo-tasks.html', 'An editable SEO task. Publishing requires separate review.'], ads: ['Ad Studio', '/v2/ad-studio.html', 'An idea with a frozen evidence baseline. No campaign or budget changes.'] };
  const fmtMoney = v => '$' + Number(v || 0).toFixed(2);
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
  async function companyStillActive() { if ((await cfg.ensureActiveCompany(state.db))?.id !== state.co) throw new Error('Active company changed. Reload On Deck before continuing.'); }
  async function load() {
    if (state.loading) return;
    state.loading = true; $('refresh').disabled = true;
    try {
      await companyStillActive();
      const [settings, stats, active, history] = await Promise.all([
        state.db.from('on_deck_settings').select('*').eq('company_entity_id', state.co).maybeSingle(),
        state.db.rpc('on_deck_stats'),
        state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', ['ready', 'preparing', 'revision', 'needs_info', 'failed']).order('created_at'),
        state.db.from('on_deck_proposals').select('*').eq('company_entity_id', state.co).in('status', groups.completed).order('updated_at', { ascending: false }).limit(100),
      ]);
      state.settings = check(settings) || {}; state.stats = check(stats) || {}; state.rows = [...check(active), ...check(history)];
      $('workspace').hidden = false; $('prepare').disabled = !state.settings.enabled; $('settings').disabled = !state.owner;
      renderOverview(); renderQueue(); await select(state.selected);
      message(state.settings.enabled ? (state.settings.last_status || 'Preparation enabled. The next scheduler run can prepare your lineup.') : 'Background preparation is off. A company owner can enable the capped pilot in Prep settings.');
    } catch (e) { message(/does not exist|schema cache|could not find/i.test(e.message) ? 'On Deck is not installed in this environment yet. Apply the preview migration before enabling preparation.' : e.message, true); }
    finally { state.loading = false; $('refresh').disabled = false; }
  }
  function renderOverview() {
    const s = state.settings, m = state.stats, ready = state.rows.filter(p => p.status === 'ready').length;
    $('brief-title').textContent = ready ? `${ready} worthwhile move${ready === 1 ? '' : 's'} ready for your call.` : 'A focused lineup. No filler.';
    $('brief-copy').textContent = ready ? 'Review the evidence, shape the draft, then decide what moves forward.' : 'We look for strong product, launch, search and ad opportunities. Missing evidence stays visible.';
    $('screened-at').textContent = `LAST SCREENED ${when(s.last_screen_at)}${s.requested_at && new Date(s.requested_at) > new Date(s.last_screen_at || 0) ? ' · REQUEST QUEUED' : ''}`;
    $('spend').textContent = fmtMoney(m.spent); $('cap').textContent = `${s.enabled ? `of ${fmtMoney(s.monthly_cap_usd)} cap` : 'Preparation off'} · ${fmtMoney(m.unknown_or_reserved)} held / uncertain`;
    $('actions').textContent = m.actions || 0; $('saved').textContent = m.minutes == null ? 'Not recorded' : `${m.minutes} min`;
    const box = $('screening'); box.replaceChildren(); const d = s.diagnostics || {};
    box.append(node('p', `${d.qualified || 0} qualified · ${d.shortlisted || 0} shortlisted at the last screening. ${m.attempts || 0} paid attempts this UTC month, including ${m.failed_attempts || 0} failed or unknown outcomes. ${m.edited_actions || 0} actions accepted after edits; ${m.dismissed || 0} dismissed decisions.`));
    const list = node('ul'); Object.entries(d.held || {}).forEach(([reason, count]) => list.append(node('li', `${count} · ${reason}`))); box.append(list);
    box.append(node('p', Object.entries(m.workflow_spend || {}).map(([kind, usd]) => `${names[kind]} ${fmtMoney(usd)}`).join(' · ') || 'No preparation charges recorded.'));
  }
  function renderQueue() {
    const visible = state.rows.filter(p => groups[state.view].includes(p.status));
    for (const b of $('views').querySelectorAll('button')) { b.setAttribute('aria-pressed', b.dataset.view === state.view); b.querySelector('b').textContent = state.rows.filter(p => groups[b.dataset.view].includes(p.status)).length; }
    if (!visible.some(p => p.id === state.selected)) state.selected = visible[0]?.id || null;
    $('queue-count').textContent = state.view === 'completed' ? 'LATEST 100' : String(visible.length).padStart(2, '0');
    const queue = $('queue'); queue.replaceChildren();
    if (!visible.length) { const empty = node('div', null, 'od-empty'); empty.append(node('strong', 'Nothing on deck here.'), node('span', state.settings.enabled ? 'No qualifying proposals in this view. Preparation will not fill the queue with weak suggestions.' : 'Enable preparation to start screening connected data.')); queue.append(empty); }
    visible.forEach(p => {
      const card = node('button', null, 'od-card'); card.type = 'button'; card.setAttribute('aria-pressed', p.id === state.selected);
      card.append(node('span', names[p.kind], 'od-kicker'), node('h3', p.title), node('p', p.selection_reason), node('span', `${p.status.replaceAll('_', ' ')} · v${p.version} · ${when(p.updated_at)}`, 'od-meta'));
      card.addEventListener('click', () => { state.selected = p.id; state.tab = 'brief'; renderQueue(); select(p.id).catch(e => message(e.message, true)); }); queue.append(card);
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
    const c = p.content || {}, s = p.source || {}, expired = new Date(p.valid_until) < new Date();
    const head = node('div', null, 'od-detail-head'); head.append(node('span', names[p.kind], 'od-pill'), node('h2', p.title), node('p', `Version ${p.version} · ${p.status.replaceAll('_', ' ')} · prepared ${when(p.updated_at)}`, 'od-meta')); detail.append(head);
    const tabs = node('nav', null, 'od-tabs'); tabs.setAttribute('aria-label', 'Proposal detail');
    [['brief', 'Decision brief'], ['draft', 'Prepared draft'], ['impact', 'Value & cost'], ['activity', 'History']].forEach(([key, label]) => { const b = button(label, () => { state.tab = key; renderDetail(); }); b.setAttribute('aria-pressed', state.tab === key); tabs.append(b); }); detail.append(tabs);
    const panel = node('div', null, 'od-panel');
    if (state.tab === 'brief') {
      panel.append(node('h3', 'Why this earned a place'), node('p', p.selection_reason));
      const metrics = node('dl', null, 'od-evidence');
      if (p.kind === 'restock') { const v = s.vetting || {}; evidenceCard(metrics, 'PRODUCT UNITS / 30D', v.units30); evidenceCard(metrics, 'TOTAL DAYS OF COVER', v.days_cover); evidenceCard(metrics, 'LEAD TIME', `${v.lead_days ?? '—'} days`); evidenceCard(metrics, 'REALIZED MARGIN', v.realized_margin == null ? null : `${(v.realized_margin * 100).toFixed(1)}%`); evidenceCard(metrics, 'ON HAND / INCOMING', `${v.on_hand ?? '—'} / ${v.incoming ?? '—'}`); evidenceCard(metrics, 'COST BOUND / BUY BUDGET', `${v.budget_bound?.toFixed?.(0) ?? '—'} / ${v.buying_budget ?? '—'} (company currency)`); panel.append(metrics, node('p', v.demand_note), node('div', 'Whole product first. All mapped SKUs are included; no size has been selected for purchase.', 'od-warning'), node('p', (s.skus || []).join(' · '))); }
      else if (p.kind === 'seo') { evidenceCard(metrics, 'SEARCH IMPRESSIONS', s.impressions); evidenceCard(metrics, 'CLICKS', s.clicks); evidenceCard(metrics, 'WEIGHTED POSITION', Number(s.position).toFixed(1)); evidenceCard(metrics, 'OBSERVED DAYS', s.days); panel.append(metrics, safeLink(s.url, s.url), node('p', `Current title: ${s.inspection?.title || 'Unknown'}\nCurrent description: ${s.inspection?.meta_description || 'Not present'}`)); }
      else if (p.kind === 'ads') { evidenceCard(metrics, 'OBJECTIVE', s.objective); evidenceCard(metrics, 'EVIDENCE', s.evidence); evidenceCard(metrics, 'METRIC', s.baseline?.metric_label || s.metric); evidenceCard(metrics, 'VS OBJECTIVE BASELINE', `${Number(s.index).toFixed(2)}×`); panel.append(metrics, node('p', s.current_copy), node('p', 'Meta-reported performance is observational. The variation is a test hypothesis, not a forecast.')); }
      else { evidenceCard(metrics, 'LAUNCH', s.launch_date); evidenceCard(metrics, 'AUDIENCE', s.audience); panel.append(metrics, node('p', s.design_intent)); const list = node('ul'); (s.readiness || []).forEach(r => list.append(node('li', `${r.product}: ${r.status || 'Readiness unknown'}`))); panel.append(node('h3', 'Product readiness'), list); }
      if ((c.missing || []).length) { panel.append(node('h3', 'Resolve before approval')); const list = node('ul'); c.missing.forEach(m => list.append(node('li', m))); panel.append(list); }
      if (expired && p.status !== 'completed') panel.append(node('div', 'Evidence window expired. Refresh preparation and review the updated draft before approving.', 'od-warning'));
      const source = node('details'); source.append(node('summary', 'Inspect saved source evidence'), node('pre', JSON.stringify(s, null, 2), 'od-source')); panel.append(source);
    } else if (state.tab === 'draft') {
      if (!c.body) panel.append(node('p', p.status === 'failed' ? 'Preparation did not complete. Refresh to request a new screening.' : 'The next preparation run will draft this proposal.'));
      else { const paper = node('div', null, 'od-paper'); paper.append(node('h3', c.subject), node('p', c.summary), node('p', c.body)); panel.append(paper); (c.tasks || []).forEach(t => { panel.append(node('h3', t.title), node('p', t.detail)); }); panel.append(node('h3', 'Draft rationale'), node('p', c.reason)); }
      const prev = state.events.find(e => e.detail?.previous_content?.body && e.detail.previous_content.body !== c.body)?.detail.previous_content;
      if (prev) { const diff = node('details'); diff.append(node('summary', 'Compare with previous draft')); const cols = node('div', null, 'od-diff'); [prev, c].forEach((value, index) => { const col = node('div'); col.append(node('h4', index ? 'CURRENT' : 'PREVIOUS'), node('pre', [value.subject, value.summary, value.body, ...(value.tasks || []).map(t => `${t.title}\n${t.detail}`)].join('\n\n'))); cols.append(col); }); diff.append(cols); panel.append(diff); }
    } else if (state.tab === 'impact') {
      const total = state.attempts.reduce((a, t) => a + Number(t.cost_usd ?? t.reserved_usd), 0);
      panel.append(node('h3', 'Measured preparation cost'), node('p', `${fmtMoney(total)} USD across ${state.attempts.length} attempts, including revisions and failures. Unknown outcomes retain their charge bound.`));
      panel.append(node('h3', 'What happened'), node('p', p.output ? p.output.label : 'No action has been confirmed.'));
      panel.append(node('h3', 'Observed value'), node('p', p.value_minutes == null ? 'No time saving or business outcome has been recorded. Revenue lift is not inferred from an approval.' : `${p.value_minutes} minutes saved, reported ${when(p.value_recorded_at)}.\n${p.value_note || ''}`));
      if (p.status === 'completed') panel.append(button('Record observed value', () => decision('value')));
    } else {
      panel.append(node('p', 'Latest 50 events. Previous draft content is retained for review.'));
      state.events.forEach(e => { const row = node('details', null, 'od-event'); row.append(node('summary', `${when(e.created_at)} · ${e.event_type.replaceAll('_', ' ')}`), node('pre', JSON.stringify(e.detail, null, 2))); panel.append(row); });
      state.attempts.slice(0, 20).forEach(a => panel.append(node('p', `${when(a.created_at)} · ${a.state} · ${fmtMoney(a.cost_usd ?? a.reserved_usd)} USD${a.error_code ? ` · ${a.error_code}` : ''}`)));
      if (p.dismiss_reason) panel.append(node('p', `Dismissed: ${p.dismiss_reason}`));
    }
    detail.append(panel);
    const footer = node('div', null, 'od-footer');
    if (p.status === 'completed') footer.append(receiptLink(p));
    else if (!['dismissed', 'screened'].includes(p.status)) {
      const approve = button(actionLabels[p.kind], () => decision('approve'), true); approve.disabled = p.status !== 'ready' || expired || (c.missing || []).length > 0; footer.append(approve);
      if (!['preparing', 'revision'].includes(p.status)) { const edit = button('Edit draft', openEditor); edit.disabled = !c.body || expired; footer.append(edit, button('Refresh evidence', () => simpleAction('refresh'))); }
      if (p.status === 'revision') footer.append(button('Keep previous draft', () => simpleAction('cancel_revision')));
      footer.append(button('Dismiss', () => decision('dismiss')));
    }
    detail.append(footer);
    const dest = destinations[p.kind], connected = node('section'); connected.append(node('span', 'NEXT IN THE WORKFLOW', 'od-eyebrow'), node('h3', dest[0]), node('p', dest[2])); if (p.output) connected.append(receiptLink(p)); else connected.append(safeLink('Open workspace ↗', dest[1])); rail.append(connected);
    const revision = node('section'); revision.append(node('h3', 'Make it stronger'), node('p', 'Ask for a specific change. The next hourly run creates a new version; every attempt counts toward the cap.'));
    const field = node('textarea'); field.className = 'bcn-field'; field.rows = 4; field.maxLength = 2000; field.placeholder = 'e.g. Lead with the launch story and make the CTA more specific'; field.setAttribute('aria-label', 'Revision instructions');
    const revise = button('Request revision', async () => { if (!field.value.trim()) { message('Describe the revision first.', true); field.focus(); return; } revise.disabled = true; await simpleAction('revise', field.value); }, true);
    revise.disabled = !state.settings.enabled || ['completed', 'dismissed', 'screened', 'preparing', 'revision'].includes(p.status) || expired; field.disabled = revise.disabled; revision.append(field, revise); rail.append(revision);
    const rules = node('section'); rules.append(node('h3', 'Your call, every time'), node('p', 'Approve the exact draft shown. On Deck records the handoff and returns a receipt. External publishing, ad spending and purchase approval stay in their destination workflows.'), node('span', `EVIDENCE VALID UNTIL ${when(p.valid_until)}`, 'od-meta')); rail.append(rules);
  }
  async function mutate(p, action, extra = {}) { await companyStillActive(); return rpc('on_deck_decide', { p_id: p.id, p_version: p.version, p_action: action, ...extra }); }
  async function simpleAction(action, note) { const p = selected(); try { await mutate(p, action, { p_note: note || null }); await load(); message(action === 'cancel_revision' ? 'Previous draft restored for review. Any model call already started still counts toward the cap.' : action === 'revise' ? 'Revision queued. Your previous draft remains in history; approval waits for the new version.' : 'Fresh screening requested. The next run will recheck whether this opportunity qualifies.'); } catch (e) { message(e.message, true); renderDetail(); } }
  let dialogProposal, dialogAction;
  function decision(action) {
    dialogProposal = selected(); dialogAction = action; $('decision-note').value = ''; $('minutes').value = dialogProposal.value_minutes ?? ''; message('', false, 'decision-error');
    const approve = action === 'approve', value = action === 'value';
    $('decision-title').textContent = approve ? actionLabels[dialogProposal.kind] : value ? 'Record observed value' : 'Dismiss proposal';
    $('decision-explanation').textContent = approve ? `${destinations[dialogProposal.kind][2]} You are approving version ${dialogProposal.version}.` : value ? 'Record time saved and an observed outcome. This is a human report, not automated revenue attribution.' : 'Why is this not worth pursuing? This source will be held for 30 days.';
    $('minutes-label').hidden = !value; $('minutes').required = value; $('decision-note').required = !approve || dialogProposal.kind === 'restock'; $('decision-note').minLength = approve && dialogProposal.kind === 'restock' ? 12 : 1;
    const checks = $('decision-checks'); checks.replaceChildren();
    if (approve && dialogProposal.kind === 'restock') ['I reviewed whole-product demand, including promotions and stockouts.', 'I verified realized margin, seasonality and supplier lead time.', 'I checked incoming purchases and the cash budget. Size allocation is still undecided.'].forEach(label => { const row = node('label', null, 'od-check'), input = node('input'); input.type = 'checkbox'; input.required = true; row.append(input, node('span', label)); checks.append(row); });
    $('decision-submit').textContent = approve ? 'Confirm & create draft work' : value ? 'Save observed value' : 'Dismiss for 30 days'; $('decision-dialog').showModal();
  }
  function openEditor() {
    dialogProposal = selected(); const c = dialogProposal.content || {}; ['subject', 'summary', 'body'].forEach(key => { $(`edit-${key}`).value = c[key] || ''; }); $('edit-note').value = ''; message('', false, 'edit-error');
    const tasks = $('edit-tasks'); tasks.replaceChildren(); (c.tasks || []).forEach((t, i) => { const label = node('label', `Task ${i + 1}`), title = node('input'), detail = node('textarea'); title.className = detail.className = 'bcn-field'; title.value = t.title; title.maxLength = 200; title.required = true; title.setAttribute('aria-label', `Task ${i + 1} title`); detail.value = t.detail; detail.maxLength = 1500; detail.rows = 3; detail.setAttribute('aria-label', `Task ${i + 1} detail`); label.append(title, detail); tasks.append(label); });
    const missing = $('edit-missing'); missing.replaceChildren(); (c.missing || []).forEach(item => { const label = node('label', null, 'od-check'), checkbox = node('input'); checkbox.type = 'checkbox'; label.append(checkbox, node('span', `Resolved: ${item}`)); missing.append(label); }); $('edit-dialog').showModal();
  }
  async function submit(form, errorId, fn, dialog) { const b = form.querySelector('[type=submit]'); b.disabled = true; try { await fn(); $(dialog).close(); await load(); } catch (e) { message(e.message, true, errorId); } finally { b.disabled = false; } }
  $('decision-form').addEventListener('submit', e => { e.preventDefault(); submit(e.target, 'decision-error', () => mutate(dialogProposal, dialogAction, { p_note: $('decision-note').value.trim(), p_minutes: dialogAction === 'value' ? Number($('minutes').value) : null }), 'decision-dialog'); });
  $('edit-form').addEventListener('submit', e => { e.preventDefault(); const original = dialogProposal.content, content = { ...original, recommend: true }; ['subject', 'summary', 'body'].forEach(k => { content[k] = $(`edit-${k}`).value; }); content.tasks = [...$('edit-tasks').querySelectorAll('label')].map(l => ({ title: l.querySelector('input').value, detail: l.querySelector('textarea').value })); const checks = [...$('edit-missing').querySelectorAll('input')]; content.missing = (original.missing || []).filter((_, i) => !checks[i].checked); submit(e.target, 'edit-error', () => mutate(dialogProposal, 'edit', { p_content: content, p_note: $('edit-note').value }), 'edit-dialog'); });
  $('settings').addEventListener('click', () => { const s = state.settings; $('enabled').checked = !!s.enabled; $('monthly-cap').value = s.monthly_cap_usd ?? 100; $('buy-budget').value = s.buy_budget ?? ''; document.querySelectorAll('[name=workflow]').forEach(c => { c.checked = (s.workflows || ['restock', 'launch', 'seo', 'ads']).includes(c.value); }); message('', false, 'settings-error'); $('settings-dialog').showModal(); });
  $('settings-form').addEventListener('submit', e => { e.preventDefault(); submit(e.target, 'settings-error', async () => { await companyStillActive(); await rpc('on_deck_configure', { p_enabled: $('enabled').checked, p_cap: Number($('monthly-cap').value), p_buy_budget: $('buy-budget').value ? Number($('buy-budget').value) : null, p_workflows: [...document.querySelectorAll('[name=workflow]:checked')].map(c => c.value) }); }, 'settings-dialog'); });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('refresh').addEventListener('click', load);
  $('prepare').addEventListener('click', async () => { $('prepare').disabled = true; try { await companyStillActive(); await rpc('on_deck_request_preparation'); await load(); message('Screening requested for the next hourly scheduler run. There is no charge until a qualified proposal is drafted.'); } catch (e) { message(e.message, true); $('prepare').disabled = !state.settings.enabled; } });
  $('views').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; state.tab = 'brief'; renderQueue(); select(state.selected).catch(e => message(e.message, true)); }));
  async function init() {
    try {
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) throw new Error('SILO connection configuration is unavailable.');
      state.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      const auth = check(await state.db.auth.getSession()); if (!auth.session) { message('Sign in to SILO to open On Deck.'); $('status').append(' ', safeLink('Sign in', '/pages/login.html')); return; }
      state.co = (await cfg.ensureActiveCompany(state.db))?.id; if (!state.co) throw new Error('Select an active company before opening On Deck.');
      const profile = check(await state.db.from('profiles').select('email,role').eq('id', auth.session.user.id).maybeSingle());
      window.SiloChrome?.mount({ appEl: '#silo-app', active: '', user: { email: profile?.email || auth.session.user.email || '', role: profile?.role || '' }, crumbs: ['Preview', 'On Deck'], supabaseClient: state.db });
      if (!await rpc('on_deck_can_review')) throw new Error('On Deck preview requires an active company owner or admin membership.');
      const membership = check(await state.db.from('entity_memberships').select('role').eq('entity_id', state.co).eq('user_id', auth.session.user.id).maybeSingle()); state.owner = membership?.role === 'owner_admin';
      await load();
    } catch (e) { message(/does not exist|schema cache|could not find/i.test(e.message) ? 'On Deck is not installed in this environment yet. Apply the preview migration before enabling preparation.' : e.message, true); }
  }
  init();
})();
