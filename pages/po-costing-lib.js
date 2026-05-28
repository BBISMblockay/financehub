/* ========================================================================
   PO costing — compute, prior SKU lookup, Supabase persistence (po_costing)
   Fallback: [SILO_COSTING] in po_headers.internal_notes when tables absent
   ======================================================================== */
(function (global) {
  const COSTING_TAG_OPEN = '[SILO_COSTING]';
  const COSTING_TAG_CLOSE = '[/SILO_COSTING]';
  const PHASE = { FOB: 'fob', FREIGHT: 'freight', FINAL: 'final' };

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

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

  function normalizeOverrides(saved) {
    if (!saved || typeof saved !== 'object') return {};
    if (saved.lines && typeof saved.lines === 'object') return saved.lines;
    return saved;
  }

  function overridesFromDbRows(costingLines) {
    const map = {};
    for (const row of costingLines || []) {
      if (!row.po_line_id) continue;
      map[row.po_line_id] = {
        fob_unit: row.fob_unit,
        freight_alloc: row.freight_alloc,
        duty_alloc: row.duty_alloc,
        misc_alloc: row.misc_alloc,
        landed_unit: row.landed_unit,
        cost_source: row.cost_source,
        prior_po_header_id: row.prior_po_header_id,
        prior_unit_cost: row.prior_unit_cost,
        prior_landed_unit: row.prior_landed_unit,
        line_notes: row.line_notes,
      };
    }
    return map;
  }

  function isMissingTableError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('po_costing');
  }

  /**
   * @param {Array} lines - po_lines
   * @param {Object} header - { freight, duty_pct, misc, alloc_method }
   * @param {Object} lineOverrides - map lineId -> overrides
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

    let sumManualFreight = 0;
    rows.forEach(r => {
      if (r.o.freight_alloc != null && r.o.freight_alloc !== '') sumManualFreight += num(r.o.freight_alloc);
    });
    const autoFreightPool = Math.max(0, freight - sumManualFreight);

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
        dutyAlloc = dutyAmount * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        dutyAlloc = dutyAmount * (r.fobExt / fobTotal);
      }

      let miscAlloc = 0;
      if (r.o.misc_alloc != null && r.o.misc_alloc !== '') {
        miscAlloc = num(r.o.misc_alloc);
      } else if (allocMethod === 'per_unit' && totalUnits > 0) {
        miscAlloc = misc * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        miscAlloc = misc * (r.fobExt / fobTotal);
      }

      let landedUnit = r.qty > 0 ? (r.fobExt + freightAlloc + dutyAlloc + miscAlloc) / r.qty : 0;
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

    return {
      fob_total: fobTotal,
      freight,
      duty_pct: dutyPct,
      duty_amount: dutyAmount,
      misc,
      landed_total: computed.reduce((s, c) => s + c.landed_ext, 0),
      lines: computed,
    };
  }

  /**
   * Split a shared freight invoice across multiple POs.
   * @param {Array} poContexts - array of ctx objects; each needs header, lines, result.fob_total
   * @param {number} totalFreight - total freight invoice amount
   * @param {string} method - 'proportional' (by FOB) | 'per_unit' (by qty)
   * @returns {Array<{po_header_id, po_name, fob_total, unit_count, freight_share}>}
   */
  function computeFreightSplit(poContexts, totalFreight, method) {
    const freight = num(totalFreight);
    const pos = (poContexts || []).filter(c => c && c.header);
    if (!pos.length) return [];

    const weights = pos.map(c =>
      method === 'per_unit'
        ? (c.lines || []).reduce((s, l) => s + num(l.qty), 0)
        : num(c.result?.fob_total ?? 0)
    );
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    return pos.map((c, i) => ({
      po_header_id: c.header.id,
      po_name: c.header.po_name || 'Untitled',
      fob_total: num(c.result?.fob_total ?? 0),
      unit_count: (c.lines || []).reduce((s, l) => s + num(l.qty), 0),
      freight_share: totalWeight > 0
        ? freight * (weights[i] / totalWeight)
        : freight / pos.length,
    }));
  }

  function headerInputsFromCostingRow(pc) {
    if (!pc) {
      return { freight: 0, duty_pct: 0, misc: 0, alloc_method: 'proportional' };
    }
    return {
      freight: pc.freight_amount ?? 0,
      duty_pct: pc.duty_pct ?? 0,
      misc: pc.misc_amount ?? 0,
      alloc_method: pc.alloc_method || 'proportional',
    };
  }

  function headerInputsFromLegacy(saved) {
    return {
      freight: saved?.freight ?? 0,
      duty_pct: saved?.duty_pct ?? 0,
      misc: saved?.misc ?? 0,
      alloc_method: saved?.alloc_method || 'proportional',
    };
  }

  /** Prior costs by SKU — po_lines + optional v_po_sku_prior_cost view */
  async function fetchPriorCostsBySku(db, skus, excludePoId) {
    const clean = [...new Set((skus || []).map(s => String(s || '').trim()).filter(Boolean))];
    if (!clean.length) return {};

    const bySku = {};

    try {
      let vq = db.from('v_po_sku_prior_cost').select('*').in('sku_snapshot', clean).limit(200);
      const { data: vdata, error: verr } = await vq;
      if (!verr && vdata) {
        for (const row of vdata) {
          const sku = String(row.sku_snapshot || '').trim();
          if (!sku || bySku[sku]) continue;
          if (excludePoId && row.po_header_id === excludePoId) continue;
          bySku[sku] = {
            unit_cost: num(row.prior_costing_fob ?? row.fob_unit_cost),
            landed_unit: row.prior_landed_unit != null ? num(row.prior_landed_unit) : null,
            po_header_id: row.po_header_id,
            po_name: row.po_name || 'Prior PO',
            order_date: row.order_date || null,
          };
        }
      }
    } catch (_) {}

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

    for (const row of data || []) {
      const sku = String(row.sku_snapshot || '').trim();
      if (!sku || bySku[sku]) continue;
      const h = headerNames[row.po_header_id];
      bySku[sku] = {
        unit_cost: num(row.unit_cost),
        landed_unit: null,
        po_header_id: row.po_header_id,
        po_name: h?.po_name || 'Prior PO',
        order_date: h?.order_date || null,
        line_id: row.id,
      };
    }
    return bySku;
  }

  async function loadCostingFromDb(db, poId) {
    const { data: pc, error: pcErr } = await db
      .from('po_costing')
      .select('*')
      .eq('po_header_id', poId)
      .maybeSingle();
    if (pcErr) throw pcErr;
    if (!pc) return null;

    const { data: pcl, error: pclErr } = await db
      .from('po_costing_lines')
      .select('*')
      .eq('po_costing_id', pc.id);
    if (pclErr) throw pclErr;

    return { costing: pc, costingLines: pcl || [] };
  }

  async function loadPoCostingContext(db, poId) {
    const [{ data: header, error: hErr }, { data: lines, error: lErr }] = await Promise.all([
      db.from('po_headers').select('id, po_name, internal_notes, status').eq('id', poId).maybeSingle(),
      db
        .from('po_lines')
        .select('id, sku_snapshot, title_snapshot, variant_title_snapshot, unit_cost, qty, retail_price, line_notes, created_at')
        .eq('po_header_id', poId)
        .order('created_at', { ascending: true }),
    ]);
    if (hErr) throw hErr;
    if (lErr) throw lErr;
    if (!header) throw new Error('PO not found');

    let persistence = 'notes';
    let costing = null;
    let costingLines = [];
    let lineOverrides = {};
    let headerInputs = { freight: 0, duty_pct: 0, misc: 0, alloc_method: 'proportional' };
    let saved = null;

    try {
      const dbRow = await loadCostingFromDb(db, poId);
      if (dbRow) {
        persistence = 'database';
        costing = dbRow.costing;
        costingLines = dbRow.costingLines;
        lineOverrides = overridesFromDbRows(costingLines);
        headerInputs = headerInputsFromCostingRow(costing);
      }
    } catch (e) {
      if (!isMissingTableError(e)) console.warn('po_costing load:', e);
    }

    if (persistence === 'notes') {
      saved = parseCostingBlock(header.internal_notes);
      lineOverrides = normalizeOverrides(saved);
      headerInputs = headerInputsFromLegacy(saved);
    }

    const skus = (lines || []).map(l => l.sku_snapshot).filter(Boolean);
    const priorBySku = await fetchPriorCostsBySku(db, skus, poId);

    return {
      header,
      lines: lines || [],
      persistence,
      costing,
      costingLines,
      saved,
      lineOverrides,
      headerInputs,
      priorBySku,
      result: computeCosting(lines || [], headerInputs, lineOverrides),
    };
  }

  /**
   * Persist costing to po_costing + po_costing_lines; fallback to internal_notes.
   * @param {Object} opts
   * @param {string} opts.phase - fob | freight | final
   * @param {string} [opts.costSource]
   * @param {Object} [opts.factoryInvoice] - { ref, date, amount }
   * @param {Object} [opts.freightInvoice] - { ref }
   * @param {string} [opts.fobNotes]
   * @param {string} [opts.freightNotes]
   * @param {boolean} [opts.markShipped]
   * @param {boolean} [opts.lockFob]
   * @param {boolean} [opts.pushFobToPoLines]
   * @param {boolean} [opts.pushLandedToPoLines]
   * @param {string} [opts.userId]
   */
  async function savePoCosting(db, ctx, headerInputs, lineOverrides, opts) {
    opts = opts || {};
    const lines = ctx.lines || [];
    const result = computeCosting(lines, headerInputs, lineOverrides);
    const now = new Date().toISOString();

    const row = {
      po_header_id: ctx.header.id,
      phase: opts.phase || ctx.costing?.phase || PHASE.FOB,
      cost_source: opts.costSource ?? ctx.costing?.cost_source ?? null,
      factory_invoice_ref: opts.factoryInvoice?.ref ?? ctx.costing?.factory_invoice_ref ?? null,
      factory_invoice_date: opts.factoryInvoice?.date ?? ctx.costing?.factory_invoice_date ?? null,
      factory_invoice_amount: opts.factoryInvoice?.amount != null ? num(opts.factoryInvoice.amount) : ctx.costing?.factory_invoice_amount,
      fob_notes: opts.fobNotes != null ? opts.fobNotes : ctx.costing?.fob_notes,
      freight_amount: num(headerInputs.freight),
      duty_pct: num(headerInputs.duty_pct),
      misc_amount: num(headerInputs.misc),
      alloc_method: headerInputs.alloc_method || 'proportional',
      freight_invoice_ref: opts.freightInvoice?.ref ?? ctx.costing?.freight_invoice_ref ?? null,
      freight_notes: opts.freightNotes != null ? opts.freightNotes : ctx.costing?.freight_notes,
      fob_total: result.fob_total,
      duty_amount: result.duty_amount,
      landed_total: result.landed_total,
      updated_at: now,
      updated_by: opts.userId || null,
    };

    if (opts.markShipped) {
      row.shipped_at = now;
      row.phase = PHASE.FREIGHT;
    }
    if (opts.lockFob) {
      row.fob_locked_at = now;
    }
    if (opts.phase === PHASE.FREIGHT || opts.phase === PHASE.FINAL) {
      row.freight_applied_at = now;
    }

    let persistence = 'notes';

    try {
      const { data: upserted, error: upErr } = await db
        .from('po_costing')
        .upsert(row, { onConflict: 'po_header_id' })
        .select('*')
        .single();
      if (upErr) throw upErr;
      persistence = 'database';

      const lineRows = result.lines.map(c => {
        const o = lineOverrides[c.line_id] || {};
        return {
          po_costing_id: upserted.id,
          po_line_id: c.line_id,
          fob_unit: c.fob_unit,
          cost_source: o.cost_source || null,
          prior_po_header_id: o.prior_po_header_id || null,
          prior_unit_cost: o.prior_unit_cost != null ? num(o.prior_unit_cost) : null,
          prior_landed_unit: o.prior_landed_unit != null ? num(o.prior_landed_unit) : null,
          freight_alloc: c.freight_alloc,
          duty_alloc: c.duty_alloc,
          misc_alloc: c.misc_alloc,
          landed_unit: c.landed_unit,
          landed_ext: c.landed_ext,
          line_notes: o.line_notes || null,
          updated_at: now,
        };
      });

      if (lineRows.length) {
        const { error: lnErr } = await db
          .from('po_costing_lines')
          .upsert(lineRows, { onConflict: 'po_line_id' });
        if (lnErr) throw lnErr;
      }

      ctx.costing = upserted;
      ctx.persistence = 'database';
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
      const legacy = {
        version: 3,
        updated_at: now,
        phase: row.phase,
        cost_source: row.cost_source,
        factory_invoice_ref: row.factory_invoice_ref,
        factory_invoice_amount: row.factory_invoice_amount,
        fob_total: result.fob_total,
        freight: row.freight_amount,
        duty_pct: row.duty_pct,
        duty_amount: result.duty_amount,
        misc: row.misc_amount,
        landed_total: result.landed_total,
        alloc_method: row.alloc_method,
        notes: opts.freightNotes || opts.fobNotes || null,
        shipped_at: row.shipped_at,
        lines: lineOverrides,
      };
      const merged = mergeCostingBlock(ctx.header.internal_notes, legacy);
      const { error: hErr } = await db.from('po_headers').update({ internal_notes: merged }).eq('id', ctx.header.id);
      if (hErr) throw hErr;
      ctx.header.internal_notes = merged;
      ctx.persistence = 'notes';
      persistence = 'notes';
    }

    if (opts.pushFobToPoLines || opts.pushLandedToPoLines) {
      for (const c of result.lines) {
        const o = lineOverrides[c.line_id] || {};
        let unit = null;
        if (opts.pushLandedToPoLines) unit = c.landed_unit;
        else if (opts.pushFobToPoLines) {
          unit = o.fob_unit != null && o.fob_unit !== '' ? num(o.fob_unit) : c.fob_unit;
        }
        if (unit == null) continue;
        await db.from('po_lines').update({ unit_cost: unit }).eq('id', c.line_id);
      }
    }

    ctx.lineOverrides = lineOverrides;
    ctx.headerInputs = headerInputs;
    ctx.result = result;

    return { persistence, result, costing: ctx.costing };
  }

  async function markPoShipped(db, ctx, userId) {
    return savePoCosting(
      db,
      ctx,
      ctx.headerInputs || headerInputsFromCostingRow(ctx.costing),
      ctx.lineOverrides || {},
      { markShipped: true, userId, phase: PHASE.FREIGHT }
    );
  }

  function phaseLabel(phase) {
    if (phase === PHASE.FREIGHT) return 'Awaiting / adding freight';
    if (phase === PHASE.FINAL) return 'Landed (final)';
    return 'FOB & factory invoice';
  }

  global.PoCostingLib = {
    COSTING_TAG_OPEN,
    COSTING_TAG_CLOSE,
    PHASE,
    parseCostingBlock,
    mergeCostingBlock,
    normalizeOverrides,
    overridesFromDbRows,
    computeCosting,
    computeFreightSplit,
    fetchPriorCostsBySku,
    loadPoCostingContext,
    savePoCosting,
    markPoShipped,
    phaseLabel,
    headerInputsFromCostingRow,
    num,
    isMissingTableError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
