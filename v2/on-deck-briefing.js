/* Read-only presentation of already screened evidence. No API calls or forecasts. */
(function () {
  'use strict';
  const text = v => typeof v === 'string' ? v.trim() : '';
  const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const positive = v => number(v) !== null && number(v) > 0;
  const fmt = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const clean = v => text(v).replace(/\s+/g, ' ').toLowerCase();
  function currentStatus(rows = [], now = Date.now()) {
    const active = rows.filter(p => ['ready','needs_info','failed','preparing','revision'].includes(p.status));
    const stale = p => p.source_current === false || !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= now;
    const ready = active.filter(p => p.status === 'ready' && p.source_current === true && !stale(p) && !draftBlockers(p).length).length;
    const needs = active.filter(p => p.status === 'needs_info').length, failed = active.filter(p => p.status === 'failed').length;
    const expired = active.filter(stale).length, preparing = active.filter(p => ['preparing','revision'].includes(p.status)).length;
    const running = active.filter(p => p.preparation?.state === 'running').length, paused = active.filter(p => p.preparation?.state === 'paused').length, queued = active.filter(p => p.preparation?.state === 'queued').length;
    const unknown = active.filter(p => typeof p.source_current !== 'boolean').length;
    return { ready, needs, failed, stale: expired, preparing, queued, running, paused, unknown,
      text: `${ready} actionable drafts; ${needs} need context; ${failed} failed; ${queued} queued, ${running} running, ${paused} paused. ${expired} active drafts have stale evidence and cannot be approved.${unknown ? ` Freshness unavailable for ${unknown} drafts; reload before review.` : ''}` };
  }
  const name = p => text(p.title).split(' · ').slice(1).join(' · ') || text(p.title) || 'Prepared opportunity';
  // Prefer structured SEO fields; legacy parsing only compares displayed copy.
  // Eligibility still requires complete structured fields.
  function seoChange(p) {
    const body = text(p.content?.body), inspected = p.source?.inspection || {};
    const field = label => {
      const match = body.match(new RegExp('(?:^|\\n)\\s*(?:Draft|Proposed)\\s+' + label + '\\s*:\\s*([^\\n]+)', 'i'));
      return match ? match[1].replace(/^["“]|["”]$/g, '').trim() : '';
    };
    const title = text(p.content?.proposed_title) || field('Title(?: Tag)?'), meta = text(p.content?.proposed_meta_description) || field('Meta Description');
    return (title && clean(title) !== clean(inspected.title)) ||
      (meta && clean(meta) !== clean(inspected.meta_description));
  }
  function proposal(p, now) {
    const c = p.content || {}, s = p.source || {}, expires = Date.parse(p.valid_until);
    if (p.source_current !== true || draftBlockers(p).length || p.status !== 'ready' || c.recommend !== true || !text(c.body) || !Array.isArray(c.missing) || c.missing.length ||
        !Number.isFinite(expires) || expires <= now || !text(p.selection_reason)) return null;
    const base = { id: p.id, type: 'proposal', kind: p.kind, name: name(p), priority: 1,
      rank: Number((p.selection_reason.match(/Selected #(\d+)/) || [])[1]) || 99,
      caveat: 'Potential benefit, not a forecast. Review the evidence and assumptions before acting.',
      prepared: 'A draft is prepared for your review.', evidence: p.selection_reason, metrics: [] };
    if (p.kind === 'seo') {
      if (!positive(s.impressions) || number(s.clicks) === null || s.clicks < 0 || s.clicks > s.impressions ||
          !positive(s.position) || !positive(s.days) || !text(s.inspection?.title) || !seoChange(p)) return null;
      return { ...base, category: 'SEO', headline: `Test clearer search copy for ${base.name}`,
        finding: `${fmt(s.impressions)} impressions and ${fmt(s.clicks)} clicks over ${fmt(s.days)} observed days. A search-copy change is prepared.`,
        why: 'Review how this page presents your business to people already finding it in search.',
        benefit: 'Test whether the proposed copy attracts more relevant clicks.',
        caveat: 'Search position and query mix also affect click-through. No traffic or revenue lift is predicted.',
        measure: 'Compare clicks and click-through after publishing, accounting for position and query mix.',
        sources: 'Search Console + inspected website', action: 'Review SEO test',
        metrics: [['Impressions', fmt(s.impressions)], ['Observed CTR', `${(s.clicks / s.impressions * 100).toFixed(2)}%`], ['Average position', fmt(s.position)]] };
    }
    if (p.kind === 'ads') {
      if (!positive(s.index) || !['moderate', 'strong'].includes(s.evidence) || !text(s.objective) || !text(s.current_copy)) return null;
      return { ...base, category: 'Marketing', headline: `Test a creative variation for ${base.name}`,
        finding: `This ad has ${s.evidence} evidence and a ${Number(s.index).toFixed(2)}× performance index against its pooled objective baseline.`,
        why: 'Use an evidence-backed creative as the starting point for a focused test.',
        benefit: 'Learn whether a new creative angle improves performance for this campaign objective.',
        caveat: 'Reported ad performance is observational. This does not establish a cause or promise a lift.',
        measure: `Compare the test against the saved ${s.objective} objective baseline in Ad Studio.`,
        sources: 'Ad performance + saved creative', action: 'Review campaign test',
        metrics: [['Objective', s.objective], ['Performance index', `${Number(s.index).toFixed(2)}×`], ['Evidence', s.evidence]] };
    }
    if (p.kind === 'restock') {
      const v = s.vetting || {};
      if (number(v.days_cover) === null || v.days_cover < 0 || !positive(v.lead_days) || !positive(v.units30)) return null;
      return { ...base, category: 'Purchasing', priority: v.days_cover < v.lead_days ? 0 : 1,
        headline: `Review replenishment for ${base.name}`,
        finding: `${fmt(v.days_cover)} days of total cover, including incoming stock, versus a ${fmt(v.lead_days)}-day lead time.`,
        why: 'Review supply timing against recent sales before deciding what to buy.',
        benefit: 'Could reduce stockout exposure if demand and delivery timing continue.',
        caveat: 'Historical sales are not unconstrained demand. Review promotions, seasonality and existing orders.',
        measure: 'Check actual stock availability and delivery dates after purchasing decisions.',
        prepared: 'A whole-product brief is prepared. Size quantities and PO approval follow in Product Studio.',
        sources: 'Sales + inventory + purchasing evidence', action: 'Review restock brief',
        metrics: [['Total cover', `${fmt(v.days_cover)} days`], ['Lead time', `${fmt(v.lead_days)} days`], ['Units sold / 30d', fmt(v.units30)]] };
    }
    if (p.kind === 'launch') {
      if (!text(s.launch_date) || !Number.isFinite(Date.parse(s.launch_date)) || !text(s.audience)) return null;
      return { ...base, category: 'Marketing', priority: 3, headline: `Review prepared launch work for ${base.name}`,
        finding: `A campaign draft is prepared from your team's brief for the ${s.launch_date} launch.`,
        why: 'Move existing launch work forward with a reviewed campaign draft.',
        benefit: 'Could help your team coordinate launch messaging and tasks.',
        caveat: 'Based on employee-prepared launch inputs. Product readiness still requires review.',
        measure: 'Track completion of the created launch tasks. Task completion is not proof of sales lift.',
        sources: 'Launch calendar + employee brief', action: 'Review launch draft',
        metrics: [['Launch date', s.launch_date], ['Prepared tasks', String(c.tasks?.length || 0)]] };
    }
    return null;
  }
  function discovery(p, now) {
    const s = p.source || {}, expires = Date.parse(p.valid_until);
    if (p.source_current !== true || p.status !== 'needs_info' || p.content?.recommend !== true || !text(p.content?.body) ||
        !text(p.selection_reason) || !Number.isFinite(expires) || expires <= now) return null;
    if (p.kind === 'ads') {
      if (!positive(s.index) || !['moderate', 'strong'].includes(s.evidence) || !text(s.objective) || !text(s.current_copy)) return null;
      return { id: p.id, type: 'proposal', kind: 'ads', name: name(p), category: 'Marketing', priority: 2,
        rank: Number((p.selection_reason.match(/Selected #(\d+)/) || [])[1]) || 99, readiness: 'investigate',
        headline: 'Find your next creative test', finding: name(p) + ' has ' + s.evidence + ' evidence and a ' + Number(s.index).toFixed(2) + '× index against its pooled objective baseline.',
        why: 'Inspect a measured creative as a starting point for a new message or angle.',
        benefit: 'Could help identify a focused creative test for this campaign objective.',
        prepared: 'Performance evidence and an initial draft are saved. The draft still needs context before approval.',
        caveat: 'Performance is observational. A stronger index does not guarantee that a variation will improve sales.',
        measure: 'Resolve the missing context before choosing a test, then compare results against the saved objective baseline.',
        sources: 'Ad performance + saved creative', action: 'Investigate creative opportunity', evidence: p.selection_reason,
        metrics: [['Objective', s.objective], ['Performance index', Number(s.index).toFixed(2) + '×'], ['Evidence', s.evidence]] };
    }
    if (p.kind !== 'seo' || !positive(s.impressions) || number(s.clicks) === null || s.clicks < 0 || s.clicks > s.impressions ||
        !positive(s.position) || !positive(s.days) || !text(s.inspection?.title)) return null;
    return { id: p.id, type: 'proposal', kind: 'seo', name: name(p), category: 'Search', priority: 2,
      rank: Number((p.selection_reason.match(/Selected #(\d+)/) || [])[1]) || 99, readiness: 'investigate',
      headline: 'Investigate a search opportunity',
      finding: name(p) + ' appeared ' + fmt(s.impressions) + ' times in search and received ' + fmt(s.clicks) + ' clicks over ' + fmt(s.days) + ' observed days.',
      why: 'People already find this page in search. Inspect the queries and search snippet before choosing a change.',
      benefit: 'Could reveal a useful search-copy or content test. These numbers alone do not establish underperformance.',
      prepared: 'Search evidence and an initial draft are saved. The draft still needs context before approval.',
      caveat: 'No click-through benchmark or traffic lift is assumed. Query mix, search position and prior tests matter.',
      measure: 'Confirm a specific change from the evidence, then compare clicks and CTR while accounting for query mix and position.',
      sources: 'Search Console + inspected website', action: 'Investigate search opportunity', evidence: p.selection_reason,
      metrics: [['Search impressions', fmt(s.impressions)], ['Observed CTR', (s.clicks / s.impressions * 100).toFixed(2) + '%'], ['Average position', fmt(s.position)]] };
  }
  function build({ rows = [], coding = [], now = Date.now() } = {}) {
    const time = Number(now), candidates = rows.map(p => proposal(p, time) || discovery(p, time)).filter(Boolean);
    for (const i of coding) {
      // Daily-ledger coding only. Legacy approvals stay in the existing reviewer.
      if (i.stage !== 'code' || i.ledger_unavailable || !positive(i.open_suggestions)) continue;
      candidates.push({ id: i.batch_id, type: 'coding', kind: 'coding', category: 'Finance', priority: 2, rank: 99,
        name: [i.source_name, i.label].filter(Boolean).join(' · '), headline: `Review ${fmt(i.open_suggestions)} suggested transaction classifications`,
        finding: 'Suggested accounts are prepared from your bank feed. Review each classification before saving.',
        why: 'Keep your books current by resolving prepared transaction classifications.',
        benefit: 'Could make financial reporting more useful by keeping transactions accurately classified.',
        caveat: 'Suggestions need human review. The transaction amount is not a saving or business gain.',
        prepared: 'Suggested accounts and supporting transaction details are ready to inspect.',
        measure: 'Check that reviewed transactions are recorded correctly in the SILO ledger.',
        sources: 'Bank feed + coding suggestions', action: 'Review transactions',
        metrics: [['Suggested classifications', fmt(i.open_suggestions)], ['Source', i.source_name || 'Bank feed']], evidence: 'Review accounts and transaction details before saving.' });
    }
    const order = { ads: 0, seo: 1, restock: 2, coding: 3, launch: 4 };
    candidates.sort((a, b) => a.priority - b.priority || (a.kind === b.kind ? a.rank - b.rank : order[a.kind] - order[b.kind]) || String(a.id).localeCompare(String(b.id)));
    const growth = candidates.filter(i => ['ads', 'seo', 'restock'].includes(i.kind));
    const upkeep = candidates.filter(i => !growth.includes(i));
    return { featured: growth[0] || null, secondary: growth.slice(1, 3), upkeep: upkeep.slice(0, 1), opportunities: growth.length, eligible: candidates.length,
      watching: rows.filter(p => ['ready', 'needs_info', 'preparing', 'revision', 'failed'].includes(p.status) && !candidates.some(c => c.type === 'proposal' && c.id === p.id)).length,
      needsInput: rows.filter(p => p.status === 'needs_info').length + coding.filter(i => i.stage === 'needs_input').length,
      preparing: rows.filter(p => ['preparing', 'revision'].includes(p.status)).length };
  }
  // The producer's required/optional arrays are the structured rule. Legacy
  // missing labels stay required regardless of their wording.
  function inputPlan(p) {
    const c = p.content || {};
    if (Array.isArray(c.review_inputs)) return c.review_inputs.map(i => ({ ...i, research: i.requirement === 'optional' }));
    return [...(c.missing || []).map((label, i) => ({ id: 'required:' + i, label, requirement: 'required', answer: '', mode: 'unanswered', research: false })),
      ...(c.optional_context || []).map((label, i) => ({ id: 'optional:' + i, label, requirement: 'optional', answer: '', mode: 'unanswered', research: true }))];
  }
  function creationBody(c) {
    const inputs = inputPlan({content:c}), sections = [typeof c.body === 'string' ? c.body : ''];
    const answers = inputs.filter(i => i.mode === 'answered').map(i => i.label + ': ' + i.answer);
    const research = inputs.filter(i => i.requirement === 'optional' && i.mode === 'carry').map(i => '- ' + i.label);
    if (answers.length) sections.push('Confirmed task context:\n' + answers.join('\n'));
    if (research.length) sections.push('Research to complete before publishing or implementing:\n' + research.join('\n'));
    return sections.join('\n\n');
  }
  function draftBlockers(p) {
    const c = p.content || {}, blockers = [];
    if (!Array.isArray(c.missing) || !Array.isArray(c.tasks)) blockers.push('Review the saved input and task lists.');
    if (c.recommend !== true) blockers.push('Review a recommended draft.');
    for (const [key, label, max] of [['subject', 'Draft title', 200], ['body', 'Draft copy', 5000]]) {
      if (!text(c[key])) blockers.push(label + ' is required.');
      else if (c[key].length > max) blockers.push(label + ' exceeds ' + max + ' characters.');
    }
    if (typeof c.summary !== 'string' || c.summary.length > 500) blockers.push('Summary must be at most 500 characters.');
    if (typeof c.reason !== 'string' || c.reason.length > 2000) blockers.push('Draft rationale must be at most 2000 characters.');
    inputPlan(p).filter(i => i.requirement === 'required' && (i.mode !== 'answered' || text(i.answer).length < 4)).forEach(i => blockers.push(i.label));
    if (p.kind === 'seo') {
      if (!text(c.proposed_title)) blockers.push('Proposed SEO title is required.');
      if (!text(c.proposed_meta_description)) blockers.push('Proposed meta description is required.');
      if ((c.proposed_title || '').length > 200 || (c.proposed_meta_description || '').length > 500) blockers.push('SEO title/meta exceed their limits (200/500 characters).');
    }
    const tasks = c.tasks || [];
    if (p.kind === 'launch' && (tasks.length < 1 || tasks.length > 5)) blockers.push('Review one to five launch tasks.');
    if (tasks.some(t => !text(t.title) || t.title.length > 200 || typeof t.detail !== 'string' || t.detail.length > 1500)) blockers.push('Each launch task needs a title (up to 200 characters) and detail (up to 1500).');
    if (p.kind === 'launch' && new Set(tasks.map(t => clean(t.title))).size !== tasks.length) blockers.push('Launch task titles must be unique.');
    if (creationBody(c).length > 5000) blockers.push('Draft copy and saved answers exceed the combined 5000-character limit.');
    return blockers;
  }
  function prepareHandoff(p, answers, note) {
    const c = p.content || {};
    const review_inputs = inputPlan(p).map((item, i) => {
      const a = answers[i] || {}, answer = text(a.value);
      if (answer.length > 1200) throw new Error('Each answer must be at most 1200 characters.');
      const mode = a.reopen ? 'unanswered' : answer.length >= 4 ? 'answered' : item.research && a.carry === true ? 'carry' : 'unanswered';
      return { id: item.id, label: item.label, requirement: item.requirement, answer, mode };
    });
    const missing = review_inputs.filter(i => i.requirement === 'required' && i.mode !== 'answered').map(i => i.label);
    return { content: { ...c, recommend: true, review_inputs, missing }, note: note || 'Reviewed draft inputs; unanswered required facts remain blockers.' };
  }
  function preparation(p, settings = {}, review = {}) {
    const actual = review.proposals?.find(i => i.id === p.id)?.preparation;
    if (actual) return actual;
    if (settings.enabled !== true || (Array.isArray(settings.workflows) && !settings.workflows.includes(p.kind))) return { state: 'paused', reason: 'disabled' };
    if (p.source_version === '' || ['preparing', 'revision'].includes(p.status)) return { state: 'unknown', reason: 'unconfirmed' };
    return { state: p.status === 'failed' ? 'failed' : 'idle' };
  }
  // ONE status per proposal. Every surface renders from this and nothing else,
  // so a card and its detail can never disagree about the same row. `review` is
  // the on_deck_review_state payload, or null when that call failed: a null
  // review means the status is UNKNOWN, never "needs input" and never "ready".
  const STATUS_REASONS = {
    previous_attempt: 'An earlier attempt is still finishing.',
    context_open: 'Context work is still open.',
    disabled: 'Background preparation is off for this workflow.',
    credit_exhausted: 'Workspace AI credit is exhausted.',
    credit_unavailable: 'AI credit could not be checked.',
    budget_cap: 'The monthly preparation cap is reached.',
    daily_cap: 'The daily safety cap is reached.',
    screening: 'Waiting for the scheduler to screen current evidence.',
    drafting: 'Waiting for the scheduler to prepare a draft.',
    preparation_failed: 'Refresh evidence to queue a fresh draft. Your previous copy is kept.',
  };
  function statusOf(p, ctx = {}) {
    const now = ctx.now || Date.now();
    const review = ctx.review || null;
    const prep = preparation(p, ctx.settings || {}, review || {});
    if (p.status === 'completed') return { key: 'done', label: 'Completed', tone: 'posted', action: 'open-created' };
    if (p.status === 'dismissed') return { key: 'dismissed', label: 'Dismissed', tone: 'muted', action: null };
    if (p.status === 'screened') return { key: 'screened', label: 'Not shortlisted', tone: 'muted', action: null };
    if (!review || review.review_contract !== 2 || typeof p.source_current !== 'boolean') {
      return { key: 'unavailable', label: 'Status unavailable', tone: 'warn', action: 'retry',
        detail: 'SILO could not load this proposal\u2019s status. Your saved draft is unchanged.' };
    }
    // The preparation state decides first, and only a reserved attempt earns the
    // working label: `status` is 'preparing' for a row that is paused on an
    // exhausted credit, queued behind the scheduler, or finished failing, and
    // reading the lifecycle status first told the reviewer to wait for work that
    // could not proceed while the next-step paragraph said "Paused".
    if (prep.state === 'running') {
      return { key: 'working', label: 'SILO is preparing this', tone: 'working', action: null };
    }
    if (prep.state === 'paused') {
      return { key: 'blocked', label: 'Paused', tone: 'warn', action: null, detail: STATUS_REASONS[prep.reason] || 'Preparation is paused.' };
    }
    if (prep.state === 'queued') {
      return { key: 'queued', label: 'Queued to prepare', tone: 'working', action: null,
        detail: STATUS_REASONS[prep.reason] || 'Queued for the next preparation run.' };
    }
    if (prep.state === 'failed') {
      return { key: 'blocked', label: 'Preparation did not finish', tone: 'warn', action: 'refresh',
        detail: STATUS_REASONS.preparation_failed };
    }
    if (['preparing', 'revision'].includes(p.status)) {
      return { key: 'working', label: 'SILO is preparing this', tone: 'working', action: null };
    }
    const expired = !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until) <= now;
    if (p.status === 'failed') {
      return { key: 'blocked', label: 'Preparation did not finish', tone: 'warn', action: 'refresh',
        detail: STATUS_REASONS.preparation_failed };
    }
    if (p.source_current === false || expired) {
      return { key: 'stale', label: expired ? 'Evidence expired' : 'Evidence changed', tone: 'warn', action: 'refresh',
        detail: 'Refresh evidence before saving or creating work.' };
    }
    const blockers = draftBlockers(p);
    if (blockers.length) {
      const asks = inputPlan(p).filter(i => i.requirement === 'required' && (i.mode !== 'answered' || text(i.answer).length < 4)).length;
      return { key: 'needs_input', label: asks ? `Needs ${asks} answer${asks === 1 ? '' : 's'}` : 'Needs input', tone: 'needs_input',
        action: 'answer', asks, blockers };
    }
    return { key: 'ready', label: 'Ready for your review', tone: 'proposal', action: 'review' };
  }
  function canReview(p, installed = true, now = Date.now()) {
    return installed && p.source_current === true && Number.isFinite(Date.parse(p.valid_until)) && Date.parse(p.valid_until) > now && !['preparing', 'revision', 'completed', 'dismissed', 'screened'].includes(p.status);
  }
  const api = { build, seoChange, inputPlan, prepareHandoff, currentStatus, draftBlockers, preparation, canReview, creationBody, statusOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SiloOnDeckBriefing = api;
})();
