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
    const spread = ['product','restock'].includes(kind) && Array.isArray(row.variants);
    return {
      ...(spread ? { catalog_scope: 'product', catalog_group: row.catalog_group || null, source_variant_identity: identity(row), source_variant_versions: row.variants.map(v=>({id:v.id,updated_at:v.updated_at ?? null})).sort((a,b)=>a.id.localeCompare(b.id)) } : {}),
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
      // A concept with no size breakdown gets NO line: an unsized line holding
      // the whole quantity is exactly what Ready for PO exists to stop.
      lines: spread ? row.variants.map(v => ({product_master_id:v.id,sku:v.sku,size:v.mapped_variant_title || v.variant_title || '',qty:null,unit_cost:number(v.unit_cost),retail_price:number(v.msrp)})) : (sizes.length ? sizes : concept ? [] : [[row.variant_title || '', '']])
        .map(([size, qty]) => ({ size, qty: concept ? Number(qty) : qty, unit_cost: cost, retail_price: retail })),
      // Ask SILO's total is a proposal; sizing and the confirmation are always
      // left for a person, never inferred (one populated size is not one size).
      ...(concept ? { po_readiness: { size_mode: null, total_qty: Number.isInteger(Number(row.suggested_qty)) && Number(row.suggested_qty) > 0 ? Number(row.suggested_qty) : null, range_confirmed: false, confirmed_lines: [] } } : {}),
      restock: kind === 'restock' ? { lead_days: row.lead_time_days ?? '', cover_days: row.target_stock_days ?? 90, safety_units: 0, basis: null, ...(spread ? {bases:[]} : {}) } : null,
    };
  }
  function identity(row) {
    return row.variants.map(v => Object.fromEntries(['id','sku','product_title','product_type','variant_title','mapped_variant_title','mapped_product_title','shopify_variant_id'].map(k => [k,v[k] ?? null]))).sort((a,b) => a.id.localeCompare(b.id));
  }
  function spreadRestock(content) {
    return content.lines.map(line => ({...restock({...content.restock,basis:content.restock?.bases?.find(b => b.product_id === line.product_master_id)}),line}));
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
    if(reviewed && content.catalog_scope==='product' && content.lines.some(l=>l.qty===null || l.qty==='' || !Number.isInteger(Number(l.qty)) || Number(l.qty)<0)) throw new Error('Choose units for every SKU; use zero to exclude a size.');
    if (reviewed && kind === 'restock') {
      if (content.catalog_scope === 'product') {
        if (content.lines.some(l => l.qty === null || l.qty === '' || !Number.isInteger(Number(l.qty)) || Number(l.qty)<0)) throw new Error('Choose units for every SKU; use zero to exclude a size.');
        const results = spreadRestock(content);
        if (results.some(r => r.warnings.length || r.qty === null || Number(r.line.qty)!==r.qty) && !content.decision_note?.trim()) throw new Error('Explain the restock override or evidence warnings in the decision note.');
        return content;
      }
      const result = restock(content.restock);
      if ((result.warnings.length || result.qty === null || Number(content.lines[0]?.qty) !== result.qty)
          && !content.decision_note?.trim()) throw new Error('Explain the restock override or evidence warnings in the decision note.');
    }
    return content;
  }
  // Mirror of product_concept_po_readiness_issues() (20260930120000) for the
  // on-page checklist. The database is the authority; the same messages come
  // back from it. ctx: { factoryIds, archived, isCollection }.
  const WHOLE = /^[0-9]{1,7}$/;
  const MONEY = /^\s*[0-9]+(\.[0-9]+)?\s*$/;
  const text = value => value === null || value === undefined ? '' : String(value);
  function confirmedLines(lines) {
    return (lines || []).map(l => [text(l?.size).trim(), l?.qty === null || l?.qty === undefined ? null : String(l.qty)]);
  }
  function readinessIssues(content, ctx = {}) {
    if (ctx.archived) return ['The concept is archived or not in the active company'];
    if (ctx.isCollection) return ['This is a collection. Mark each product in it ready for PO separately'];
    if (!content || typeof content !== 'object') return ['Save the purchasing details first'];
    const issues = [];
    if (!text(content.title).trim()) issues.push('Add a product title');
    if (!text(content.product_type).trim()) issues.push('Choose a product type');
    if (!(ctx.factoryIds || []).includes(content.factory_id)) issues.push('Choose a factory in the active company');
    const r = content.po_readiness && typeof content.po_readiness === 'object' ? content.po_readiness : {};
    const stated = WHOLE.test(text(r.total_qty)) && Number(r.total_qty) >= 1 && Number(r.total_qty) <= 1000000 ? Number(r.total_qty) : null;
    if (stated === null) issues.push('Enter a positive whole-unit total quantity');
    if (!['sized', 'one_size'].includes(r.size_mode)) issues.push('Choose whether the product is sized or one size');
    const lines = Array.isArray(content.lines) ? content.lines : [];
    if (!lines.length) issues.push('Add the size/variant range');
    else if (lines.length > 100) issues.push('Use at most 100 sizes/variants');
    else {
      let badQty = false, badSize = false, badMoney = false, total = 0;
      lines.forEach(l => {
        if (!l || typeof l !== 'object') { badQty = badSize = true; return; }
        if (!WHOLE.test(text(l.qty)) || Number(l.qty) < 1) badQty = true; else total += Number(l.qty);
        if (!text(l.size).trim()) badSize = true;
        [l.unit_cost, l.retail_price].forEach(v => { if (v !== null && v !== undefined && (!MONEY.test(text(v)) || Number(v) > 1000000)) badMoney = true; });
      });
      if (badQty) issues.push('Give every size a whole quantity of at least 1 (remove sizes you are not buying)');
      if (badSize) issues.push('Name every size/variant');
      else if (new Set(lines.map(l => text(l.size).trim().toLowerCase())).size !== lines.length) issues.push('List each size/variant once');
      if (badMoney) issues.push('Unit cost and retail price must be blank or 0-1,000,000');
      if (r.size_mode === 'one_size' && lines.length !== 1) issues.push('A one-size product has exactly one line');
      if (!badQty && stated !== null && total !== stated) issues.push(`Sizes total ${total} units but the confirmed total is ${stated}`);
    }
    const confirmed = Array.isArray(r.confirmed_lines) ? r.confirmed_lines.map(e => [text(e?.[0]).trim(), e?.[1] === null || e?.[1] === undefined ? null : String(e[1])]) : [];
    if (r.range_confirmed !== true || !lines.length || JSON.stringify(confirmed) !== JSON.stringify(confirmedLines(lines))) issues.push('Confirm the size/variant range and quantities');
    return issues;
  }
  root.SiloProductWorkflow = { preset, restock, spreadRestock, identity, validate, readinessIssues, confirmedLines };
})(typeof window !== 'undefined' ? window : module.exports);
