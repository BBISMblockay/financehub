/** Deterministic screening precedes paid drafting. No quotas, predicted ROI or
 * size-level purchasing. Scores are comparable only within each workflow. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../../v2/ad-studio.js', import.meta.url), 'utf8'), sandbox);
const Ads = sandbox.module.exports;
export { MODEL, MAX_PROMPT_BYTES, MAX_OUTPUT_TOKENS, RESERVATION_USD, promptFor, validateDraft } from '../../supabase/functions/on-deck-prepare/draft.mjs';
const n = x => Number(x) || 0;
const text = x => String(x ?? '').trim();
const sum = (xs, f) => xs.reduce((a, x) => a + n(f(x)), 0);
const age = (date, now) => (now - new Date(date || 0)) / 86400000;
const recent = (date, days, now) => !!date && age(date, now) >= -1 && age(date, now) <= days;
const key = s => createHash('sha256').update(s).digest('hex');
export function safeUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function productGroups(mappings) {
  const groups = new Map(), skuGroups = new Map();
  for (const m of mappings) {
    const id = `${m.shop_domain}|${m.shopify_product_id}`;
    if (!groups.has(id)) groups.set(id, { id, rows: [], skus: new Set() });
    const g = groups.get(id); g.rows.push(m); g.skus.add(text(m.sku));
    if (!skuGroups.has(text(m.sku))) skuGroups.set(text(m.sku), new Set());
    skuGroups.get(text(m.sku)).add(id);
  }
  const seen = new Set(), output = [];
  for (const [id] of groups) {
    if (seen.has(id)) continue;
    const stack = [id], component = [];
    while (stack.length) {
      const next = stack.pop(); if (seen.has(next)) continue; seen.add(next);
      const g = groups.get(next); component.push(g);
      for (const sku of g.skus) for (const neighbor of skuGroups.get(sku)) if (!seen.has(neighbor)) stack.push(neighbor);
    }
    const canonical = component.sort((a, b) => Number(b.rows.every(m => m.status === 'active')) - Number(a.rows.every(m => m.status === 'active')) || a.id.localeCompare(b.id))[0];
    const skus = [...new Set(component.flatMap(g => [...g.skus]))].sort();
    // Identical SKU sets across stores are one product. Partial overlaps and
    // duplicate mappings need a person to resolve identity before any ranking.
    const ambiguous = !skus.length || skus.includes('') || skus.length > 100 ||
      component.some(g => g.rows.length !== skus.length || g.skus.size !== skus.length) ||
      new Set(component.map(g => g.rows[0].shop_domain)).size !== component.length;
    output.push({ skus, ambiguous, mapping: canonical.rows[0], stores: component.length, active: canonical.rows.every(m => m.status === 'active') });
  }
  return output;
}
export function curate({ products = [], mappings = [], seo = [], ads = [], launches = [], settings = {}, excludedKeys = new Set(), now = new Date() }) {
  now = new Date(now);
  const candidates = [], held = {}, screened = { restock: 0, seo: seo.length, ads: ads.length, launch: launches.length };
  const hold = reason => { held[reason] = (held[reason] || 0) + 1; };
  const productsBySku = new Map();
  for (const p of products) { const sku = text(p.sku); productsBySku.set(sku, productsBySku.has(sku) ? null : p); }
  for (const group of productGroups(mappings)) {
    screened.restock++;
    const ps = group.skus.map(sku => productsBySku.get(sku));
    if (group.ambiguous || !group.active || ps.some(p => !p)) { hold('Product identity needs attention'); continue; }
    if (ps.some(p => p.reorderable !== true || p.is_discontinued || n(p.unit_cost) <= 0 || n(p.lead_time_days) <= 0 || n(p.msrp) <= n(p.unit_cost))) { hold('Restock policy, cost or lead time missing'); continue; }
    if (ps.some(p => !recent(p.stock?.snapshot_at, 2, now) || p.stock?.units == null || n(p.stock?.shops) > 1 || n(p.incoming?.uncertain) > 0)) { hold('Stock or incoming purchase evidence unresolved'); continue; }
    const lead = Math.max(...ps.map(p => n(p.lead_time_days))), arrivalMonth = new Date(+now + lead * 86400000).getUTCMonth() + 1;
    if (ps.some(p => {
      if (p.is_seasonal === true) {
        const a = n(p.peak_start_month), b = n(p.peak_end_month);
        return !(a >= 1 && a <= 12 && b >= 1 && b <= 12) || !(a <= b ? arrivalMonth >= a && arrivalMonth <= b : arrivalMonth >= a || arrivalMonth <= b);
      }
      return p.is_evergreen !== true || p.is_drop === true;
    })) { hold('Seasonality or drop eligibility needs review'); continue; }
    const units30 = sum(ps, p => p.sales?.units30), units90 = sum(ps, p => p.sales?.units90), net90 = sum(ps, p => p.sales?.net90);
    const oldest = Math.max(...ps.map(p => p.sales?.first_day ? age(p.sales.first_day, now) : 0));
    if (units90 < 30 || units30 < 10 || units30 < units90 / 6 || oldest < 60 || Math.max(...ps.map(p => n(p.sales?.selling_days))) < 10 || !ps.some(p => recent(p.sales?.last_day, 7, now))) { hold('Insufficient sustained product demand'); continue; }
    const cost = Math.max(...ps.map(p => n(p.unit_cost))), realizedPrice = net90 / units90;
    // Conservative cost bound, not a made-up expected profit or size allocation.
    const margin = (realizedPrice - cost) / realizedPrice;
    const target = Math.max(0.35, ...ps.map(p => n(p.gross_margin_target) > 1 ? n(p.gross_margin_target) / 100 : n(p.gross_margin_target)));
    if (!Number.isFinite(margin) || margin < target) { hold('Realized product margin below floor'); continue; }
    const stock = sum(ps, p => p.stock.units), incoming = sum(ps, p => p.incoming.units), daily = Math.min(units30 / 30, units90 / 90);
    const cover = (stock + incoming) / daily;
    if (cover > lead + 14) { hold('Product has adequate cover'); continue; }
    const units = Math.max(0, Math.ceil(daily * (lead + 30) - stock - incoming));
    const budgetBound = units * cost;
    if (!n(settings.buy_budget) || budgetBound > n(settings.buy_budget)) { hold('Restock exceeds or lacks a buying budget'); continue; }
    const source = { catalog_group: { shop_domain: group.mapping.shop_domain, shopify_product_id: group.mapping.shopify_product_id },
      product: group.mapping.product_title, skus: group.skus, stores: group.stores,
      vetting: { units30, units90, net90, realized_margin: margin, margin_floor: target, on_hand: stock, incoming,
        days_cover: Math.round(cover * 10) / 10, lead_days: lead, budget_bound: budgetBound, buying_budget: n(settings.buy_budget),
        demand_note: 'Historical sales do not establish unconstrained demand. Review stockouts, promotions and seasonality before sizing.',
        allocation: 'No size quantities selected. Whole-product review required.' } };
    candidates.push({ kind: 'restock', key: key(group.skus.join('\n')), source_id: ps[0].id,
      title: `Review restock · ${group.mapping.product_title || 'Mapped product'}`.slice(0, 240), source,
      score: Math.max(0, lead + 14 - cover) * daily * (realizedPrice - cost),
      reason: `${units30} units sold in 30 days across the product; ${source.vetting.days_cover} days of cover versus ${lead}-day lead time. Ranked by cover urgency and historical contribution, after margin, seasonality, incoming-stock and budget gates.` });
  }
  const seenUrls = new Set();
  for (const p of [...seo].sort((a, b) => n(b.impressions) - n(a.impressions))) {
    const url = safeUrl(p.url); if (!url) { hold('SEO URL invalid'); continue; }
    const u = new URL(url); u.hash = ''; for (const name of [...u.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/.test(name)) u.searchParams.delete(name);
    if (seenUrls.has(u.href)) { hold('Duplicate SEO page'); continue; } seenUrls.add(u.href);
    const i = p.inspection;
    if (n(p.days) < 14 || n(p.impressions) < 500 || n(p.position) < 4 || n(p.position) > 20 || n(p.clicks) / n(p.impressions) > 0.08 || !recent(p.last_day, 5, now) || !i || i.http_status !== 200 || i.fetch_error || !recent(i.fetched_at, 30, now) || !text(i.title) || !text(i.h1)) { hold('SEO evidence incomplete or weak'); continue; }
    candidates.push({ kind: 'seo', key: key(u.href), title: `Improve search presentation · ${i.title}`.slice(0, 240),
      score: n(p.impressions) * (1 - n(p.clicks) / n(p.impressions)) / n(p.position), source: { ...p, url },
      reason: `${p.impressions} impressions, ${p.clicks} clicks and position ${n(p.position).toFixed(1)} over ${p.days} observed days. Prioritized by exposure and search position; no traffic lift is assumed.` });
  }
  const measured = ads.filter(a => n(a.objective_count) === 1 && recent(a.last_day, 3, now));
  const scored = Ads.score(measured, { minSpend: 100 });
  for (const a of scored) {
    const c = a.creative, base = Ads.baseline(measured, a.objective, { minSpend: 100 });
    if (!['purchase', 'thruplay', 'subscribers', 'traffic'].includes(a.objective) || n(a.spend) < 100 || !['moderate', 'strong'].includes(a.evidence) || base.ads < 2 || !['moderate', 'strong'].includes(base.evidence) || n(a.index) < 1.15 || !c || c.effective_status !== 'ACTIVE' || !recent(c.synced_at, 3, now) || !Ads.cleanCopy(c.body) || !safeUrl(c.link_url)) { hold('Ad lacks a supported, comparable creative opportunity'); continue; }
    candidates.push({ kind: 'ads', key: a.ad_id, title: `Draft a creative variation · ${a.ad_name || a.ad_id}`.slice(0, 240),
      score: a.index * Math.log1p(n(a.spend)), source: { ad_id: a.ad_id, objective: a.objective,
        baseline: JSON.parse(JSON.stringify(Ads.snapshot([a], { start: a.first_day, through: a.last_day }, { objectiveBaseline: base }))), metric: a.primary, value: a.value, index: a.index, evidence: a.evidence,
        spend: a.spend, first_day: a.first_day, last_day: a.last_day,
        current_copy: Ads.cleanCopy(c.body), current_title: Ads.cleanCopy(c.title), url: c.link_url },
      reason: `${a.evidence} evidence on ${Ads.METRICS[a.primary].label}; ${a.index.toFixed(2)}× the pooled ${a.objective} baseline (${base.ads} ads). Draft a testable variation; this does not establish why the original performed or promise lift.` });
  }
  for (const l of launches) {
    const days = Math.ceil((new Date(l.launch_date) - now) / 86400000);
    if (days < -1 || days > 30 || !text(l.design_intent) || !text(l.audience) || !(l.readiness || []).length || (l.tasks || []).some(t => /campaign|launch copy|marketing draft/i.test(t.title))) { hold('Launch brief incomplete or campaign work already exists'); continue; }
    candidates.push({ kind: 'launch', key: l.id, source_id: l.id, title: `Prepare launch campaign · ${l.title}`.slice(0, 240),
      score: 31 - Math.max(days, 0), source: l,
      reason: `Launch on ${l.launch_date}, with an audience and product brief available. Prioritized by launch proximity; product readiness remains visible for review.` });
  }
  const enabled = settings.workflows || ['restock', 'launch', 'seo', 'ads'];
  const eligible = candidates.filter(c => !excludedKeys.has(`${c.kind}:${c.key}`));
  const ranked = Object.fromEntries(enabled.map(kind => [kind, eligible.filter(c => c.kind === kind).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 3)]));
  // Round-robin preserves each workflow's own units; ROAS is not compared to
  // SEO impressions or purchase dollars. No weak candidates fill empty slots.
  const shortlist = [];
  for (let rank = 0; rank < 3; rank++) for (const kind of ['restock', 'launch', 'seo', 'ads']) if (ranked[kind]?.[rank] && shortlist.length < 6) shortlist.push({ ...ranked[kind][rank], reason: `${ranked[kind][rank].reason} Selected #${rank + 1} of ${eligible.filter(c => c.kind === kind).length} eligible ${kind} opportunities.` });
  return { shortlist, diagnostics: { screened, qualified: candidates.length, shortlisted: shortlist.length, held } };
}
