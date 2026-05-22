/* ========================================================================
   PO costing — shared parse, allocate, prior-cost lookup (v1 + v2 pages)
   ======================================================================== */
(function (global) {
  const COSTING_TAG_OPEN = '[SILO_COSTING]';
  const COSTING_TAG_CLOSE = '[/SILO_COSTING]';

  function parseCostingBlock(internalNotes) {
    const text = String(internalNotes || '');
    const start = text.indexOf(COSTING_TAG_OPEN);
    const end = text.indexOf(COSTING_TAG_CLOSE);
    if (start < 0 || end < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start + COSTING_TAG_OPEN.length, end));
    } catch (_) {
      return null;
    }
  }

  function mergeCostingBlock(internalNotes, costing) {
    const text = String(internalNotes || '');
    const stripped = text.replace(/\[SILO_COSTING\][\s\S]*?\[\/SILO_COSTING\]/g, '').trim();
    const block = COSTING_TAG_OPEN + JSON.stringify(costing) + COSTING_TAG_CLOSE;
    return stripped ? stripped + '\n\n' + block : block;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function lineFobExt(line, overrides) {
    const o = overrides && overrides[line.id];
    const unit = o && o.fob_unit != null && o.fob_unit !== '' ? num(o.fob_unit) : num(line.unit_cost);
    const qty = num(line.qty);
    return unit * qty;
  }

  function normalizeOverrides(saved) {
    if (!saved || typeof saved !== 'object') return {};
    if (saved.lines && typeof saved.lines === 'object') return saved.lines;
    return saved;
  }

  /**
   * @param {Array} lines - po_lines rows with id, sku_snapshot, unit_cost, qty, title_snapshot...
   * @param {Object} header - { freight, duty_pct, misc, alloc_method }
   * @param {Object} lineOverrides - map lineId -> { fob_unit?, freight_alloc?, landed_unit?, locked? }
   */
  function computeCosting(lines, header, lineOverrides) {
    const overrides = lineOverrides || {};
    const freight = num(header.freight);
    const dutyPct = num(header.duty_pct);
    const misc = num(header.misc);
    const allocMethod = header.alloc_method || 'proportional';

    const rows = (lines || []).map(line => {
      const o = overrides[line.id] || {};
      const qty = Math.max(0, num(line.qty));
      const fobUnit = o.fob_unit != null && o.fob_unit !== '' ? num(o.fob_unit) : num(line.unit_cost);
      const fobExt = fobUnit * qty;
      return { line, o, qty, fobUnit, fobExt };
    });

    const fobTotal = rows.reduce((s, r) => s + r.fobExt, 0);
    const totalUnits = rows.reduce((s, r) => s + r.qty, 0);
    const dutyAmount = fobTotal * (dutyPct / 100);
    const poolFreight = freight;
    const poolDuty = dutyAmount;
    const poolMisc = misc;

    let sumManualFreight = 0;
    rows.forEach(r => {
      if (r.o.freight_alloc != null && r.o.freight_alloc !== '') sumManualFreight += num(r.o.freight_alloc);
    });
    const autoFreightPool = Math.max(0, poolFreight - sumManualFreight);
    const autoDutyPool = poolDuty;
    const autoMiscPool = poolMisc;

    const computed = rows.map(r => {
      let freightAlloc = 0;
      if (r.o.freight_alloc != null && r.o.freight_alloc !== '') {
        freightAlloc = num(r.o.freight_alloc);
      } else if (allocMethod === 'per_unit' && totalUnits > 0) {
        freightAlloc = autoFreightPool * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        freightAlloc = autoFreightPool * (r.fobExt / fobTotal);
      }

      let dutyAlloc = 0;
      if (r.o.duty_alloc != null && r.o.duty_alloc !== '') {
        dutyAlloc = num(r.o.duty_alloc);
      } else if (allocMethod === 'per_unit' && totalUnits > 0) {
        dutyAlloc = autoDutyPool * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        dutyAlloc = autoDutyPool * (r.fobExt / fobTotal);
      }

      let miscAlloc = 0;
      if (r.o.misc_alloc != null && r.o.misc_alloc !== '') {
        miscAlloc = num(r.o.misc_alloc);
      } else if (allocMethod === 'per_unit' && totalUnits > 0) {
        miscAlloc = autoMiscPool * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        miscAlloc = autoMiscPool * (r.fobExt / fobTotal);
      }

      const addOn = freightAlloc + dutyAlloc + miscAlloc;
      const landedExt = r.fobExt + addOn;
      let landedUnit = r.qty > 0 ? landedExt / r.qty : 0;
      if (r.o.landed_unit != null && r.o.landed_unit !== '') {
        landedUnit = num(r.o.landed_unit);
      }

      return {
        line_id: r.line.id,
        sku: r.line.sku_snapshot,
        title: r.line.title_snapshot,
        variant: r.line.variant_title_snapshot,
        qty: r.qty,
        fob_unit: r.fobUnit,
        fob_ext: r.fobExt,
        freight_alloc: freightAlloc,
        duty_alloc: dutyAlloc,
        misc_alloc: miscAlloc,
        landed_unit: landedUnit,
        landed_ext: landedUnit * r.qty,
        overrides: r.o,
      };
    });

    const landedTotal = computed.reduce((s, c) => s + c.landed_ext, 0);

    return {
      fob_total: fobTotal,
      freight: poolFreight,
      duty_pct: dutyPct,
      duty_amount: dutyAmount,
      misc: poolMisc,
      landed_total: landedTotal,
      lines: computed,
    };
  }

  function buildCostingPayload(lines, header, lineOverrides, notes) {
    const result = computeCosting(lines, header, lineOverrides);
    const linesMap = {};

    (lines || []).forEach(line => {
      const o = (lineOverrides && lineOverrides[line.id]) || {};
      const entry = {};
      if (o.fob_unit != null && o.fob_unit !== '') entry.fob_unit = num(o.fob_unit);
      if (o.freight_alloc != null && o.freight_alloc !== '') entry.freight_alloc = num(o.freight_alloc);
      if (o.duty_alloc != null && o.duty_alloc !== '') entry.duty_alloc = num(o.duty_alloc);
      if (o.misc_alloc != null && o.misc_alloc !== '') entry.misc_alloc = num(o.misc_alloc);
      if (o.landed_unit != null && o.landed_unit !== '') entry.landed_unit = num(o.landed_unit);
      if (Object.keys(entry).length) linesMap[line.id] = entry;
    });

    return {
      version: 2,
      updated_at: new Date().toISOString(),
      fob_total: result.fob_total,
      freight: num(header.freight),
      duty_pct: num(header.duty_pct),
      duty_amount: result.duty_amount,
      misc: num(header.misc),
      landed_total: result.landed_total,
      alloc_method: header.alloc_method || 'proportional',
      notes: notes || null,
      lines: linesMap,
      line_summary: result.lines.map(c => ({
        line_id: c.line_id,
        sku: c.sku,
        landed_unit: c.landed_unit,
        landed_ext: c.landed_ext,
      })),
    };
  }

  /** Prior FOB unit_cost by SKU from other POs (most recent line wins). */
  async function fetchPriorCostsBySku(db, skus, excludePoId) {
    const clean = [...new Set((skus || []).map(s => String(s || '').trim()).filter(Boolean))];
    if (!clean.length) return {};

    let q = db
      .from('po_lines')
      .select('id, sku_snapshot, unit_cost, qty, created_at, po_header_id')
      .in('sku_snapshot', clean)
      .order('created_at', { ascending: false })
      .limit(400);

    if (excludePoId) q = q.neq('po_header_id', excludePoId);

    const { data, error } = await q;
    if (error) throw error;

    const headerIds = [...new Set((data || []).map(r => r.po_header_id).filter(Boolean))];
    const headerNames = {};
    if (headerIds.length) {
      const { data: headers } = await db.from('po_headers').select('id, po_name, order_date').in('id', headerIds);
      for (const h of headers || []) headerNames[h.id] = h;
    }

    const bySku = {};
    for (const row of data || []) {
      const sku = String(row.sku_snapshot || '').trim();
      if (!sku || bySku[sku]) continue;
      const h = headerNames[row.po_header_id];
      bySku[sku] = {
        unit_cost: num(row.unit_cost),
        po_header_id: row.po_header_id,
        po_name: h?.po_name || 'Prior PO',
        order_date: h?.order_date || null,
        line_id: row.id,
      };
    }
    return bySku;
  }

  async function loadPoCostingContext(db, poId) {
    const [{ data: header, error: hErr }, { data: lines, error: lErr }] = await Promise.all([
      db.from('po_headers').select('id, po_name, internal_notes').eq('id', poId).maybeSingle(),
      db.from('po_lines').select('id, sku_snapshot, title_snapshot, variant_title_snapshot, unit_cost, qty, retail_price, line_notes, created_at').eq('po_header_id', poId).order('created_at', { ascending: true }),
    ]);
    if (hErr) throw hErr;
    if (lErr) throw lErr;

    const saved = parseCostingBlock(header?.internal_notes);
    const lineOverrides = normalizeOverrides(saved);
    const headerInputs = {
      freight: saved?.freight ?? 0,
      duty_pct: saved?.duty_pct ?? 0,
      misc: saved?.misc ?? 0,
      alloc_method: saved?.alloc_method || 'proportional',
    };

    const skus = (lines || []).map(l => l.sku_snapshot).filter(Boolean);
    const priorBySku = await fetchPriorCostsBySku(db, skus, poId);

    return {
      header,
      lines: lines || [],
      saved,
      lineOverrides,
      headerInputs,
      priorBySku,
      result: computeCosting(lines || [], headerInputs, lineOverrides),
    };
  }

  global.PoCostingLib = {
    COSTING_TAG_OPEN,
    COSTING_TAG_CLOSE,
    parseCostingBlock,
    mergeCostingBlock,
    normalizeOverrides,
    computeCosting,
    buildCostingPayload,
    fetchPriorCostsBySku,
    loadPoCostingContext,
    num,
  };
})(typeof window !== 'undefined' ? window : globalThis);
