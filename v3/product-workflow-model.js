/* Pure rules for the direct-link product workflow preview. */
(function (root) {
  'use strict';
  const number = value => value === null || value === undefined || value === '' ? null : Number(value);
  function preset(kind, row = {}) {
    const concept = kind === 'concept';
    const sizes = concept && row.suggested_size_breakdown && typeof row.suggested_size_breakdown === 'object'
      ? Object.entries(row.suggested_size_breakdown).filter(([, qty]) => Number.isInteger(Number(qty)) && Number(qty) > 0) : [];
    const cost = number(concept ? row.economics?.unit_cost : row.unit_cost);
    const retail = number(concept ? row.economics?.msrp : row.msrp);
    return {
      source_updated_at: row.updated_at || null,
      title: row.title || row.product_title || '',
      design_intent: concept ? row.concept_summary || row.creative_story || '' : row.notes || '',
      product_type: concept ? row.suggested_product_type || '' : row.product_type || '',
      product_callouts: concept ? row.brand_fit || '' : '',
      marketing_angle: row.marketing_angle || '', audience: row.audience || '',
      special_callouts: concept ? row.supply_constraints || '' : '',
      draft_copy: row.suggested_marketing_copy || '',
      creative_dos: row.visual_direction || '', creative_donts: '', copy_dos: '', copy_donts: '',
      launch_date: row.suggested_launch_date || '', factory_id: row.suggested_factory_id || '', decision_note: '',
      lines: (sizes.length ? sizes : [[row.variant_title || '', concept ? row.suggested_qty ?? '' : '']])
        .map(([size, qty]) => ({ size, qty, unit_cost: cost, retail_price: retail })),
      restock: kind === 'restock' ? { lead_days: row.lead_time_days ?? '', cover_days: row.target_stock_days ?? 90, safety_units: 0, basis: null } : null,
    };
  }
  function restock(r, now = Date.now()) {
    const warnings = [];
    const b = r?.basis;
    const lead = number(r?.lead_days), cover = number(r?.cover_days), safety = number(r?.safety_units);
    if (![lead, cover, safety].every(v => v !== null && Number.isFinite(v) && v >= 0)
        || !Number.isInteger(lead) || !Number.isInteger(cover) || !Number.isInteger(safety) || lead + cover > 730) {
      return { qty: null, warnings: ['Enter whole lead days, cover days and safety units; lead + cover must be at most 730.'] };
    }
    if (!b || b.horizon_days !== lead + cover) return { qty: null, warnings: ['Refresh the basis for this lead time and cover.'] };
    const units = number(b.units_90d), stock = number(b.on_hand), incoming = number(b.incoming_units);
    if (units === null) warnings.push('No recorded sales basis for this SKU; demand is unknown.');
    if (stock === null) warnings.push('No stock snapshot for this SKU.');
    if (units < 0 || stock < 0) warnings.push('Negative sales or stock requires a manual decision.');
    if (Number(b.sales_names) > 1) warnings.push('This SKU has multiple as-sold names. Check for a rename or SKU collision.');
    if (Number(b.uncertain_po_lines) > 0) warnings.push('Overdue, undated or partially received PO lines are excluded. Review incoming stock.');
    const stockAge = now - Date.parse(b.stock_as_of);
    if (!Number.isFinite(stockAge) || stockAge > 2 * 86400000) warnings.push('Stock is missing or older than 48 hours.');
    const basisAge = now - Date.parse(b.observed_at);
    if (!Number.isFinite(basisAge) || basisAge > 86400000) warnings.push('This saved basis is older than 24 hours. Refresh before buying.');
    const usable = [units, stock, incoming].every(v => v !== null && Number.isFinite(v) && v >= 0);
    const velocity = usable ? units / 90 : null;
    return { qty: usable ? Math.max(0, Math.ceil(velocity * (lead + cover) + safety - stock - incoming)) : null,
      velocity, cover: velocity > 0 ? stock / velocity : null, warnings };
  }
  function validate(content, kind, reviewed = false) {
    if (!content.title?.trim()) throw new Error('Enter a brief title.');
    if (reviewed && !content.design_intent?.trim()) throw new Error('Add the product intent before review.');
    if (reviewed && kind === 'restock') {
      const result = restock(content.restock);
      if ((result.warnings.length || result.qty === null || Number(content.lines[0]?.qty) !== result.qty)
          && !content.decision_note?.trim()) throw new Error('Explain the restock override or evidence warnings in the decision note.');
    }
    return content;
  }
  root.SiloProductWorkflow = { preset, restock, validate };
})(typeof window !== 'undefined' ? window : module.exports);
