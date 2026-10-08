/* Read-only presentation of already screened evidence. No API calls or forecasts. */
(function () {
  'use strict';
  const text = v => typeof v === 'string' ? v.trim() : '';
  const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const positive = v => number(v) !== null && number(v) > 0;
  const fmt = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const clean = v => text(v).replace(/\s+/g, ' ').toLowerCase();
  const name = p => text(p.title).split(' · ').slice(1).join(' · ') || text(p.title) || 'Prepared opportunity';
  // The current draft contract stores copy, not structured SEO fields. Fail
  // conservatively when a changed title/description cannot be identified.
  function seoChange(p) {
    const body = text(p.content?.body), inspected = p.source?.inspection || {};
    const field = label => {
      const match = body.match(new RegExp('(?:^|\\n)\\s*(?:Draft|Proposed)\\s+' + label + '\\s*:\\s*([^\\n]+)', 'i'));
      return match ? match[1].replace(/^["“]|["”]$/g, '').trim() : '';
    };
    const title = field('Title(?: Tag)?'), meta = field('Meta Description');
    return (title && clean(title) !== clean(inspected.title)) ||
      (meta && clean(meta) !== clean(inspected.meta_description));
  }
  function proposal(p, now) {
    const c = p.content || {}, s = p.source || {}, expires = Date.parse(p.valid_until);
    if (p.status !== 'ready' || c.recommend !== true || !text(c.body) || !Array.isArray(c.missing) || c.missing.length ||
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
  function build({ rows = [], coding = [], now = Date.now() } = {}) {
    const time = Number(now), candidates = rows.map(p => proposal(p, time)).filter(Boolean);
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
    candidates.sort((a, b) => a.priority - b.priority || a.rank - b.rank || order[a.kind] - order[b.kind] || String(a.id).localeCompare(String(b.id)));
    return { featured: candidates[0] || null, secondary: candidates.slice(1, 3), eligible: candidates.length,
      watching: rows.filter(p => ['ready', 'needs_info', 'preparing', 'revision', 'failed'].includes(p.status) && !candidates.some(c => c.type === 'proposal' && c.id === p.id)).length,
      needsInput: rows.filter(p => p.status === 'needs_info').length + coding.filter(i => i.stage === 'needs_input').length,
      preparing: rows.filter(p => ['preparing', 'revision'].includes(p.status)).length };
  }
  const api = { build, seoChange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SiloOnDeckBriefing = api;
})();
