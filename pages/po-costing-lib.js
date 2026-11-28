/* ========================================================================
   PO costing — compute, prior SKU lookup, Supabase persistence (po_costing)
   Fallback: [SILO_COSTING] in po_headers.internal_notes when tables absent
   ======================================================================== */
(function (global) {
  const COSTING_TAG_OPEN = '[SILO_COSTING]';
  const COSTING_TAG_CLOSE = '[/SILO_COSTING]';
  const PHASE = { FOB: 'fob', FREIGHT: 'freight', FINAL: 'final' };

  /** Shown, and thrown, when the bill bank could not be read for the open PO.
   *  Without it a failed read is indistinguishable from "this PO has no bills",
   *  and saving would record freight of zero. */
  const BANK_UNREAD = 'Could not read the freight bills for this PO, so freight was not saved. '
    + 'Reopen the PO and try again.';

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

  /** A bill's kind -> the cost bucket it lands in. Mirrors
   *  v_po_landed_cost_allocations.cost_bucket, so the page and the database
   *  cannot disagree about where a duty bill goes. */
  const ALLOC_BUCKET = {
    freight: 'freight', duty: 'duty', tariff: 'duty', brokerage: 'misc', other: 'misc',
    misc: 'misc',
  };

  /** Split `total` across `weights` so the parts sum to `total` EXACTLY, in
   *  cents. Proportional division leaves a remainder of a cent or two; left
   *  alone it makes the line shares disagree with the bill, which is the one
   *  thing the bank exists to prevent. The leftover cents go to the largest
   *  fractional parts (ties to the heavier weight, then to the earlier line),
   *  so the result is deterministic rather than order-of-floating-point.
   *  A zero total weight is an even split -- that is a PO whose lines have no
   *  cost or no quantity yet, and dropping the money would be worse. */
  function allocateToCents(total, weights) {
    const w = (weights || []).map(x => Math.max(0, num(x)));
    const n = w.length;
    if (!n) return [];
    const cents = Math.max(0, Math.round(num(total) * 100));
    const sum = w.reduce((a, b) => a + b, 0);
    const raw = sum > 0 ? w.map(x => (cents * x) / sum) : w.map(() => cents / n);
    const out = raw.map(x => Math.floor(x));
    let rem = cents - out.reduce((a, b) => a + b, 0);
    const order = raw
      .map((x, i) => ({ i: i, frac: x - Math.floor(x), w: w[i] }))
      .sort((a, b) => (b.frac - a.frac) || (b.w - a.w) || (a.i - b.i));
    for (let k = 0; k < order.length && rem > 0; k++) { out[order[k].i] += 1; rem -= 1; }
    return out.map(c => c / 100);
  }

  /** Which PO lines a shipment carried, and how many of each.
   *  `incoming_shipment_lines.qty` null means "this line's whole quantity" --
   *  that is the stored meaning and it is why a PO whose lines sit on TWO
   *  shipments with null qty reads as twice received. Here a null simply falls
   *  back to the PO line's own quantity for weighting; it is not a receipt. */
  function shipmentQtyMap(shipmentLines) {
    const map = {};
    for (const sl of shipmentLines || []) {
      if (!sl || !sl.shipment_id || !sl.po_line_id) continue;
      const bucket = (map[sl.shipment_id] = map[sl.shipment_id] || {});
      const q = sl.qty == null || sl.qty === '' ? null : num(sl.qty);
      if (!Object.prototype.hasOwnProperty.call(bucket, sl.po_line_id)) bucket[sl.po_line_id] = q;
      else if (q != null) bucket[sl.po_line_id] = (bucket[sl.po_line_id] || 0) + q;
    }
    return map;
  }

  /** Spread each landed-cost allocation over the lines it actually paid for.
   *
   *  An allocation naming a SHIPMENT reaches only that shipment's lines, in
   *  that shipment's quantities. That is the whole point: a PO that ships in
   *  two containers has two freight bills, and the first one must not land on
   *  units still at the factory. An allocation with no shipment is the whole
   *  PO, which is the only honest answer while a PO has no shipment rows.
   *
   *  An allocation whose container has been DELETED (`shipment_detached`) is
   *  not quietly promoted to a whole-PO allocation either; it is reported the
   *  same way, so a person says where that freight belongs now.
   *
   *  An allocation that reaches NO line (a shipment with no lines recorded) is
   *  returned in `unplaced` rather than dropped or spread somewhere else -- the
   *  page shows it, because silently moving money is how this went wrong before.
   *  @returns {{ byLine: Object, unplaced: Array, totals: Object }}
   */
  function spreadAllocations(rows, allocations, shipmentLines) {
    const byLine = {};
    rows.forEach(r => { byLine[r.line.id] = { freight: 0, duty: 0, misc: 0 }; });
    const totals = { freight: 0, duty: 0, misc: 0 };
    const unplaced = [];
    const shipMap = shipmentQtyMap(shipmentLines);

    for (const a of allocations || []) {
      if (!a) continue;
      const amount = num(a.amount);
      if (!(amount > 0)) continue;
      const bucket = ALLOC_BUCKET[String(a.cost_bucket || a.kind || 'freight')] || 'misc';
      totals[bucket] += amount;

      let targets;
      if (a.shipment_detached) {
        // The container this named has been deleted. Reading its null shipment
        // as "the whole PO" would spread one container's freight over units it
        // never carried, with nobody deciding anything -- so it lands nowhere
        // and is reported for reassignment instead.
        targets = [];
      } else if (a.shipment_id) {
        const m = shipMap[a.shipment_id];
        targets = !m ? [] : rows
          .filter(r => Object.prototype.hasOwnProperty.call(m, r.line.id))
          .map(r => ({ r: r, qty: m[r.line.id] == null ? r.qty : m[r.line.id] }));
      } else {
        targets = rows.map(r => ({ r: r, qty: r.qty }));
      }
      if (!targets.length) {
        unplaced.push({
          allocation: a, bucket: bucket,
          reason: a.shipment_detached ? 'shipment_gone' : 'no_lines',
        });
        continue;
      }

      const byUnits = String(a.method || '') === 'units';
      const weights = targets.map(t => (byUnits ? t.qty : t.qty * t.r.fobUnit));
      const shares = allocateToCents(amount, weights);
      targets.forEach((t, i) => { byLine[t.r.line.id][bucket] += shares[i]; });
    }

    return { byLine: byLine, unplaced: unplaced, totals: totals };
  }

  /**
   * @param {Array} lines - po_lines
   * @param {Object} header - { freight, duty_pct, misc, alloc_method }
   * @param {Object} lineOverrides - map lineId -> overrides
   * @param {Object} [context] - { allocationsLoaded, allocations, shipmentLines }.
   *   With `allocationsLoaded` true, freight and misc come from the BANK --
   *   allocations of real bills -- and the typed header totals are ignored.
   *   Without it the legacy header totals are used unchanged, which is what a
   *   page whose allocation read FAILED must fall back to: recomputing a PO's
   *   freight as 0 because a query errored would erase a landed cost.
   */
  function computeCosting(lines, header, lineOverrides, context) {
    const overrides = lineOverrides || {};
    const ctx = context || {};
    const fromBank = ctx.allocationsLoaded === true;
    const dutyPct = num(header.duty_pct);
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

    // The bank is the source of the money. `freight` and `misc` are what real
    // bills put on this PO, never a figure anybody typed here.
    const spread = fromBank
      ? spreadAllocations(rows, ctx.allocations, ctx.shipmentLines)
      : { byLine: {}, unplaced: [], totals: { freight: 0, duty: 0, misc: 0 } };
    const freight = fromBank ? spread.totals.freight : num(header.freight);
    const misc = fromBank ? spread.totals.misc : num(header.misc);

    // Duty still has a typed percentage of FOB beside any duty/tariff bill, so
    // a rate known before the broker's invoice arrives is not lost.
    const dutyAmount = fobTotal * (dutyPct / 100);

    let sumManualFreight = 0;
    rows.forEach(r => {
      if (r.o.freight_alloc != null && r.o.freight_alloc !== '') sumManualFreight += num(r.o.freight_alloc);
    });
    const autoFreightPool = Math.max(0, freight - sumManualFreight);

    const computed = rows.map(r => {
      const share = spread.byLine[r.line.id] || { freight: 0, duty: 0, misc: 0 };

      let freightAlloc = 0;
      if (r.o.freight_alloc != null && r.o.freight_alloc !== '') {
        freightAlloc = num(r.o.freight_alloc);
      } else if (fromBank) {
        freightAlloc = share.freight;
      } else if (allocMethod === 'per_unit' && totalUnits > 0) {
        freightAlloc = autoFreightPool * (r.qty / totalUnits);
      } else if (fobTotal > 0) {
        freightAlloc = autoFreightPool * (r.fobExt / fobTotal);
      }

      // Duty from bills is a dollar split; the typed percentage is spread the
      // old way on top of it.
      let dutyAlloc = 0;
      if (r.o.duty_alloc != null && r.o.duty_alloc !== '') {
        dutyAlloc = num(r.o.duty_alloc);
      } else {
        if (allocMethod === 'per_unit' && totalUnits > 0) {
          dutyAlloc = dutyAmount * (r.qty / totalUnits);
        } else if (fobTotal > 0) {
          dutyAlloc = dutyAmount * (r.fobExt / fobTotal);
        }
        if (fromBank) dutyAlloc += share.duty;
      }

      let miscAlloc = 0;
      if (r.o.misc_alloc != null && r.o.misc_alloc !== '') {
        miscAlloc = num(r.o.misc_alloc);
      } else if (fromBank) {
        miscAlloc = share.misc;
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
      // The duty FIGURE is the typed percentage plus whatever duty or tariff
      // bills were allocated, so the KPI band and the lines agree.
      duty_amount: dutyAmount + (fromBank ? spread.totals.duty : 0),
      misc,
      from_bank: fromBank,
      unplaced_allocations: spread.unplaced,
      landed_total: computed.reduce((s, c) => s + c.landed_ext, 0),
      lines: computed,
    };
  }

  /**
   * Multi-bucket split across POs — freight ($), tariff (% of FOB), duty (% of FOB), misc ($).
   * Each bucket has its own allocation method: 'proportional' | 'per_unit' | 'weight'.
   * @param {Array} poContexts - ctx objects; each needs header, lines, result
   * @param {Object} inputs - { freight, tariff_pct, duty_pct, misc }
   * @param {Object} methods - { freight, tariff, duty, misc } each 'proportional'|'per_unit'|'weight'
   * @param {Object} weightMap - { [poHeaderId]: { weight_kg, volume_cbm } }
   */
  function computeMultiSplit(poContexts, inputs, methods, weightMap) {
    const pos = (poContexts || []).filter(c => c && c.header);
    if (!pos.length) return [];
    const freight = num(inputs?.freight);
    const tariff_pct = num(inputs?.tariff_pct);
    const duty_pct = num(inputs?.duty_pct);
    const misc = num(inputs?.misc);
    const wm = weightMap || {};
    const posData = pos.map(c => ({
      po_header_id: c.header.id,
      po_name: c.header.po_name || 'Untitled',
      fob_total: num(c.result?.fob_total ?? 0),
      unit_count: (c.lines || []).reduce((s, l) => s + num(l.qty), 0),
      weight_kg: num(wm[c.header.id]?.weight_kg ?? 0),
      volume_cbm: num(wm[c.header.id]?.volume_cbm ?? 0),
    }));
    const totalFob = posData.reduce((s, p) => s + p.fob_total, 0);
    const totalUnits = posData.reduce((s, p) => s + p.unit_count, 0);
    const totalWeight = posData.reduce((s, p) => s + p.weight_kg, 0);
    const totalVolume = posData.reduce((s, p) => s + p.volume_cbm, 0);
    const tariff_total = totalFob * (tariff_pct / 100);
    const duty_total = totalFob * (duty_pct / 100);
    function allocate(total, method) {
      return posData.map(p => {
        if (method === 'per_unit') {
          return totalUnits > 0 ? total * (p.unit_count / totalUnits) : total / posData.length;
        } else if (method === 'weight') {
          if (totalWeight > 0) return total * (p.weight_kg / totalWeight);
          if (totalVolume > 0) return total * (p.volume_cbm / totalVolume);
          return totalFob > 0 ? total * (p.fob_total / totalFob) : total / posData.length;
        }
        return totalFob > 0 ? total * (p.fob_total / totalFob) : total / posData.length;
      });
    }
    const freightShares = allocate(freight, methods?.freight || 'proportional');
    const tariffShares = allocate(tariff_total, methods?.tariff || 'proportional');
    const dutyShares = allocate(duty_total, methods?.duty || 'proportional');
    const miscShares = allocate(misc, methods?.misc || 'proportional');
    return posData.map((p, i) => ({
      ...p,
      freight_share: freightShares[i],
      tariff_share: tariffShares[i],
      duty_share: dutyShares[i],
      misc_share: miscShares[i],
      total_share: freightShares[i] + tariffShares[i] + dutyShares[i] + miscShares[i],
    }));
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

  /** Every landed-cost bill allocated to this PO, with the shipment each one
   *  names and the bucket its kind belongs in. Reads the view, so the bucket
   *  mapping lives in one place. A failure THROWS: the caller must tell the
   *  difference between "no bills on this PO" and "could not look", because
   *  the second one saved as the first would wipe a landed cost. */
  async function loadLandedCostAllocations(db, poId, companyId) {
    let q = db.from('v_po_landed_cost_allocations')
      .select('allocation_id, po_header_id, shipment_id, shipment_detached, amount, method, notes, bill_id, kind, source, vendor_name, bill_ref, bill_date, bill_amount, cost_bucket, shipment_status, container_ref, ship_date')
      .eq('po_header_id', poId)
      .order('bill_date', { ascending: true, nullsFirst: false });
    if (companyId) q = q.eq('company_entity_id', companyId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  /** The bank: every bill with what is left on it. `onlyOpen` keeps the picker
   *  to bills that still have money to spend, which is the normal case; the
   *  dialog asks for everything when someone wants to see what a bill already
   *  paid for. */
  async function loadBillBank(db, companyId, opts) {
    const o = opts || {};
    let q = db.from('v_landed_cost_bill_balance')
      .select('bill_id, source, kind, vendor_name, bill_ref, bill_date, amount, allocated, remaining, allocation_count, po_names, allocation_state, notes')
      .order('bill_date', { ascending: false, nullsFirst: false })
      .limit(o.limit || 400);
    if (companyId) q = q.eq('company_entity_id', companyId);
    if (o.kind) q = q.eq('kind', o.kind);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    return o.onlyOpen ? rows.filter(r => num(r.remaining) > 0.004) : rows;
  }

  /** The PO's shipments and their lines, so an allocation naming a container
   *  can reach that container's units and nothing else. */
  async function loadPoShipments(db, poId, companyId) {
    let sq = db.from('incoming_shipments')
      .select('id, po_header_id, shipment_status, ship_date, eta, received_date, container_ref, carrier, booking_id')
      .eq('po_header_id', poId)
      .order('ship_date', { ascending: true, nullsFirst: false });
    if (companyId) sq = sq.eq('company_entity_id', companyId);
    const { data: shipments, error: sErr } = await sq;
    if (sErr) throw sErr;
    const ids = (shipments || []).map(s => s.id);
    if (!ids.length) return { shipments: [], shipmentLines: [] };
    let lq = db.from('incoming_shipment_lines')
      .select('id, shipment_id, po_line_id, qty')
      .in('shipment_id', ids);
    if (companyId) lq = lq.eq('company_entity_id', companyId);
    const { data: lines, error: lErr } = await lq;
    if (lErr) throw lErr;
    return { shipments: shipments || [], shipmentLines: lines || [] };
  }

  /** Just the shipments of a PO, for the allocation dialog's PO picker. The
   *  context loader is far too heavy to run for a PO somebody only ticked. */
  async function loadPoShipmentsForPicker(db, poId, companyId) {
    let q = db.from('incoming_shipments')
      .select('id, po_header_id, shipment_status, ship_date, eta, container_ref, carrier')
      .eq('po_header_id', poId)
      .order('ship_date', { ascending: true, nullsFirst: false });
    if (companyId) q = q.eq('company_entity_id', companyId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function loadPoCostingContext(db, poId) {
    const _co = window.__SILO_CONFIG__?.getActiveCompany?.() || null;
    let _qh = db.from('po_headers').select('id, po_name, internal_notes, status').eq('id', poId);
    if (_co?.id) _qh = _qh.eq('company_entity_id', _co.id);
    let _qlines = db.from('po_lines').select('id, sku_snapshot, title_snapshot, variant_title_snapshot, unit_cost, qty, retail_price, line_notes, created_at').eq('po_header_id', poId).order('created_at', { ascending: true });
    if (_co?.id) _qlines = _qlines.eq('company_entity_id', _co.id);
    const [{ data: header, error: hErr }, { data: lines, error: lErr }] = await Promise.all([
      _qh.maybeSingle(),
      _qlines,
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

    // The bank and the shipments. `allocationsLoaded` is false until BOTH
    // answer: a PO costed from a half-read bank would save the wrong freight.
    let allocations = [];
    let shipments = [];
    let shipmentLines = [];
    let allocationsLoaded = false;
    let allocationError = null;
    try {
      const [alloc, ship] = await Promise.all([
        loadLandedCostAllocations(db, poId, _co?.id),
        loadPoShipments(db, poId, _co?.id),
      ]);
      allocations = alloc;
      shipments = ship.shipments;
      shipmentLines = ship.shipmentLines;
      allocationsLoaded = true;
    } catch (e) {
      // Not fatal, and NOT silent: the page refuses to save freight while this
      // is set, and keeps showing the stored figure meanwhile.
      allocationError = e;
      console.error('landed cost allocations:', e);
    }

    const costContext = {
      allocationsLoaded: allocationsLoaded,
      allocations: allocations,
      shipmentLines: shipmentLines,
    };

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
      allocations,
      shipments,
      shipmentLines,
      allocationsLoaded,
      allocationError,
      costContext,
      result: computeCosting(lines || [], headerInputs, lineOverrides, costContext),
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
    // A save that touches freight while the bank could not be read would write
    // the recomputed figure -- which, with no allocations in hand, is zero.
    // Refuse by name rather than quietly erase a PO's landed cost.
    if (ctx.allocationError && opts.phase !== PHASE.FOB) {
      throw new Error(BANK_UNREAD);
    }
    const result = computeCosting(lines, headerInputs, lineOverrides, ctx.costContext);
    const now = new Date().toISOString();

    const row = {
      po_header_id: ctx.header.id,
      phase: opts.phase || ctx.costing?.phase || PHASE.FOB,
      cost_source: opts.costSource ?? ctx.costing?.cost_source ?? null,
      factory_invoice_ref: opts.factoryInvoice?.ref ?? ctx.costing?.factory_invoice_ref ?? null,
      factory_invoice_date: opts.factoryInvoice?.date ?? ctx.costing?.factory_invoice_date ?? null,
      factory_invoice_amount: opts.factoryInvoice?.amount != null ? num(opts.factoryInvoice.amount) : ctx.costing?.factory_invoice_amount,
      fob_notes: opts.fobNotes != null ? opts.fobNotes : ctx.costing?.fob_notes,
      // From the bank when it was read, so po_costing.freight_amount -- which
      // PO Report and the overview tile read -- always equals the sum of the
      // bills allocated to this PO. Nothing types this number any more.
      freight_amount: result.freight,
      duty_pct: num(headerInputs.duty_pct),
      misc_amount: result.misc,
      alloc_method: headerInputs.alloc_method || 'proportional',
      freight_invoice_ref: opts.freightInvoice?.ref ?? ctx.costing?.freight_invoice_ref ?? null,
      freight_carrier: opts.freightCarrier != null ? opts.freightCarrier : ctx.costing?.freight_carrier ?? null,
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

    // `po_lines.unit_cost` is what the FACTORY charges, and it is what every
    // PO total sums (v_po_header_summary.total_estimated_cost, PO Report, PO
    // Builder, Planning, launch readiness). Writing the LANDED unit back into
    // it -- which this did, with the checkbox on by default -- inflated those
    // totals by $59,620 across 134 lines on production and made the next
    // recompute start from a freight-inclusive figure. The landed cost lives in
    // po_costing_lines.landed_unit, and that is where readers take it from.
    // Only the FOB unit is ever pushed back.
    if (opts.pushFobToPoLines) {
      for (const c of result.lines) {
        const o = lineOverrides[c.line_id] || {};
        const unit = o.fob_unit != null && o.fob_unit !== '' ? num(o.fob_unit) : c.fob_unit;
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

  /** Recompute and re-store one PO's costing from the bank, without anybody
   *  opening it.
   *
   *  Allocating one invoice across several POs changes the landed cost of
   *  EVERY PO it touched, but only the open one was ever reloaded -- so the
   *  others kept their stored per-line shares until somebody opened and saved
   *  each of them. `po_costing_lines` is reportable (Ask SILO and saved
   *  reports read it), so a stale share is a wrong answer, not just a stale
   *  screen.
   *
   *  The PO-level totals are kept true by a database trigger whatever writes
   *  the allocation; this is the per-LINE half, which has to run through the
   *  same engine the page uses rather than a second copy of that math in SQL.
   *  A PO with no costing row yet is skipped: it has nothing stored to correct.
   *  @returns {Promise<boolean>} true if it was re-stored.
   */
  async function refreshStoredCosting(db, poId, userId) {
    const ctx = await loadPoCostingContext(db, poId);
    if (!ctx.costing || ctx.persistence !== 'database') return false;
    if (ctx.allocationError) throw new Error(BANK_UNREAD);
    await savePoCosting(db, ctx, ctx.headerInputs, ctx.lineOverrides || {}, {
      userId: userId || null,
      phase: ctx.costing.phase,
      costSource: ctx.costing.cost_source,
    });
    return true;
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
    allocateToCents,
    spreadAllocations,
    shipmentQtyMap,
    loadLandedCostAllocations,
    loadPoShipmentsForPicker,
    loadBillBank,
    computeMultiSplit,
    computeFreightSplit,
    fetchPriorCostsBySku,
    loadPoCostingContext,
    savePoCosting,
    refreshStoredCosting,
    markPoShipped,
    phaseLabel,
    headerInputsFromCostingRow,
    num,
    isMissingTableError,
    BANK_UNREAD,
  };
})(typeof window !== 'undefined' ? window : globalThis);
