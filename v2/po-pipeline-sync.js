/* PO -> Pipeline: how a new-product PO's lines become /v2/products.html
 * Pipeline items (product_tracker rows).
 *
 * One Pipeline item is one PRODUCT (a product title), while a PO carries one
 * line per SIZE. The sync this replaces ran per line, on line save only, and
 * wrote that one line's qty into expected_units, matching the item by title
 * on ANY PO -- so the last size saved won, whichever PO it was on
 * (Incotexco-496's youth tee read 105, its YXL line, instead of the 550 its
 * four size lines add up to), and lines that arrived by import, bulk SKU,
 * catalog or concept never reached the Pipeline until someone edited one.
 *
 * So the unit here is the whole PO: every product title on it, summed across
 * all of its size lines, synced after ANY change to the PO's lines. The same
 * figure v_launch_po_product_lookup.total_units gives the Pipeline drawer's
 * "PO / Incoming" pick, and what product_tracker.po_header_id's column
 * comment promises: "expected_units is read from that PO's total across every
 * size line, never one line's qty".
 *
 * Which Pipeline item a PO may write to (decided per product title):
 *   - one already recorded against THIS PO (po_header_id)   -> keep in step
 *   - an unlinked one (no po_header_id) not auto-added from
 *     a DIFFERENT PO that still carries the product         -> claim it
 *   - only ones belonging to another PO                     -> leave alone:
 *     "Expected Units (from the originating PO)" belongs to the first PO, and
 *     a duplicated or split PO must not overwrite it or add a second item
 *   - none                                                  -> create one
 *
 * "Still carries" matters. A PO is recreated when its factory changes (the
 * name comes from the factory), and deleting one nulls po_header_id, so an
 * item's note routinely names a PO that no longer holds the product --
 * Creytex-335's hoodies now sit on ShaoxingTianyun-111. A note alone would
 * leave such an item unclaimable by the PO that does carry the product,
 * forever. sync() looks the noted PO up; plan() blocks only when it cannot
 * tell, or when the noted PO really does still carry it.
 *
 * Expected units is the ONLY field a PO overwrites. Factory, manufacturer,
 * type and bulk ETA are filled when blank and never replaced, because the
 * Pipeline drawer is where a person corrects them.
 */
(function (root) {
  'use strict';

  var AUTO_NOTE = /^\s*(?:Auto-added|Pushed) from PO:\s*([^\n]*)/i;

  function hasText(v) { return v != null && String(v).trim() !== ''; }

  /** The matching key for a product title. lower(trim()) on purpose: it is
   *  exactly what 20260923160000 and the July backfill match on in SQL. */
  function titleKey(title) { return String(title == null ? '' : title).trim().toLowerCase(); }

  /** The PO name an auto-added item's note names, or null. */
  function notedPoName(notes) {
    var m = AUTO_NOTE.exec(String(notes || ''));
    return m && hasText(m[1]) ? m[1].trim() : null;
  }

  /**
   * One entry per product title on the PO: the title as first written, the
   * summed qty of every line carrying it, how many lines that was, and the
   * first product type seen. Lines with no title are not a product and are
   * skipped. A total of 0 is reported as units: null -- "no quantity on this
   * PO", never a confident zero.
   */
  function productTotals(lines) {
    var byKey = new Map();
    (lines || []).forEach(function (l) {
      if (!l || !hasText(l.title_snapshot)) return;
      var title = String(l.title_snapshot).trim();
      var key = titleKey(title);
      var g = byKey.get(key);
      if (!g) { g = { key: key, title: title, sum: 0, lineCount: 0, productType: null }; byKey.set(key, g); }
      var q = Number(l.qty);
      if (isFinite(q) && q > 0) g.sum += q;
      g.lineCount += 1;
      if (!g.productType && hasText(l.product_type_snapshot)) g.productType = String(l.product_type_snapshot).trim();
    });
    return Array.from(byKey.values()).map(function (g) {
      return { key: g.key, title: g.title, units: g.sum > 0 ? g.sum : null, lineCount: g.lineCount, productType: g.productType };
    });
  }

  function sameId(a, b) { return hasText(a) && hasText(b) && String(a) === String(b); }

  /**
   * Decide what to write. Pure: no I/O.
   *
   *   po         { id, po_name, factory_id, factory_name, expected_arrival_date }
   *   totals     productTotals(lines)
   *   trackers   the company's product_tracker rows
   *   onlyKeys   optional array of titleKeys: plan for those products only
   *   noteHolds  optional (notedPoName, key) -> bool: does the PO an item's
   *              note names still carry that product? Omitted = assume it
   *              does, so an item auto-added from another PO is left alone
   *
   * Returns one action per product:
   *   { kind, key, title, units, lineCount, row?, patch? }
   *   kind 'insert'     patch is the new row
   *   kind 'update'     patch names only the columns that change
   *   kind 'unchanged'  row already says what the PO says
   *   kind 'other_po'   row belongs to another PO; nothing written
   */
  function plan(po, totals, trackers, onlyKeys, noteHolds) {
    var p = po || {};
    var rows = trackers || [];
    var poName = hasText(p.po_name) ? String(p.po_name).trim() : '';
    var fills = {
      factory_id: hasText(p.factory_id) ? p.factory_id : null,
      manufacturer: hasText(p.factory_name) ? String(p.factory_name).trim() : null,
      bulk_eta: hasText(p.expected_arrival_date) ? String(p.expected_arrival_date).slice(0, 10) : null,
    };

    var only = onlyKeys ? new Set(onlyKeys) : null;
    return (totals || []).filter(function (t) { return !only || only.has(t.key); }).map(function (t) {
      var base = { key: t.key, title: t.title, units: t.units, lineCount: t.lineCount };
      var same = rows.filter(function (r) { return titleKey(r.product_title) === t.key; });
      var own = same.find(function (r) { return sameId(r.po_header_id, p.id); });
      var claimable = own ? null : same.find(function (r) {
        if (hasText(r.po_header_id)) return false;
        var noted = notedPoName(r.notes);
        if (!noted || noted.toLowerCase() === poName.toLowerCase()) return true;
        return typeof noteHolds === 'function' ? !noteHolds(noted, t.key) : false;
      });
      var row = own || claimable;

      if (!row) {
        if (same.length) return Object.assign({ kind: 'other_po', row: same[0] }, base);
        return Object.assign({ kind: 'insert', patch: {
            product_title: t.title,
            product_type: t.productType,
            factory_id: fills.factory_id,
            manufacturer: fills.manufacturer,
            bulk_eta: fills.bulk_eta,
            expected_units: t.units,
            po_header_id: p.id,
            notes: ('Auto-added from PO: ' + poName).trim(),
          } }, base);
      }

      var patch = {};
      if (!sameId(row.po_header_id, p.id)) patch.po_header_id = p.id;
      var current = row.expected_units == null || row.expected_units === '' ? null : Number(row.expected_units);
      if (current !== t.units) patch.expected_units = t.units;
      if (!hasText(row.product_type) && t.productType) patch.product_type = t.productType;
      ['factory_id', 'manufacturer', 'bulk_eta'].forEach(function (c) {
        if (!hasText(row[c]) && fills[c]) patch[c] = fills[c];
      });
      return Object.keys(patch).length
        ? Object.assign({ kind: 'update', row: row, patch: patch }, base)
        : Object.assign({ kind: 'unchanged', row: row }, base);
    });
  }

  var TRACKER_COLUMNS = 'id,product_title,po_header_id,expected_units,factory_id,manufacturer,product_type,bulk_eta,launch_id,notes';

  function errText(e) { return (e && (e.message || e.details)) || String(e); }

  /**
   * For unlinked items whose note names a DIFFERENT PO, find out whether that
   * PO still carries the product. Returns plan()'s noteHolds, or undefined
   * (= assume it does) when nothing needs asking or the answer is unknown: a
   * failed read must never turn into claiming another PO's item. Two reads,
   * and only when such an item exists for a product on this PO.
   */
  var HEADER_PAGE = 1000;

  async function noteHoldsFor(sb, o, po, totals, trackers) {
    var keys = new Set(totals.map(function (t) { return t.key; }));
    var mine = String(po.po_name || '').trim().toLowerCase();
    var names = new Set();
    (trackers || []).forEach(function (r) {
      if (hasText(r.po_header_id) || !keys.has(titleKey(r.product_title))) return;
      var n = notedPoName(r.notes);
      if (n && n.toLowerCase() !== mine) names.add(n.toLowerCase());
    });
    if (!names.size) return undefined;

    // Paged: a response is capped (1,000 rows by default), and a noted PO
    // lost past the cap would read as "gone" and hand its item to this PO.
    var nameById = new Map();
    for (var from = 0; ; from += HEADER_PAGE) {
      var hq = sb.from('po_headers').select('id,po_name');
      if (o.companyId) hq = hq.eq('company_entity_id', o.companyId);
      var heads = await hq.order('id', { ascending: true }).range(from, from + HEADER_PAGE - 1);
      if (heads.error) return undefined;
      var page = heads.data || [];
      page.forEach(function (h) {
        var n = String(h.po_name || '').trim().toLowerCase();
        if (names.has(n)) nameById.set(String(h.id), n);
      });
      if (page.length < HEADER_PAGE) break;
    }

    var held = new Set();
    if (nameById.size) {
      var lq = sb.from('po_lines').select('po_header_id,title_snapshot').in('po_header_id', Array.from(nameById.keys()));
      if (o.companyId) lq = lq.eq('company_entity_id', o.companyId);
      var got = await lq;
      if (got.error) return undefined;
      (got.data || []).forEach(function (l) {
        held.add(nameById.get(String(l.po_header_id)) + '|' + titleKey(l.title_snapshot));
      });
    }
    return function (noted, key) { return held.has(String(noted).trim().toLowerCase() + '|' + key); };
  }

  /**
   * Read the PO's lines and the company's Pipeline, then apply plan().
   * Never throws: failures come back in `errors`, one per product, so one
   * refused write does not hide what the others did.
   *
   *   opts.po         the PO (see plan)
   *   opts.companyId  active company id, or null (RLS still scopes the reads
   *                   and the stamp trigger still stamps the insert)
   *   opts.onlyKeys   optional, see plan
   */
  async function sync(sb, opts) {
    var o = opts || {};
    var po = o.po || {};
    var out = { inserted: [], updated: [], unchanged: [], otherPo: [], errors: [] };
    if (!hasText(po.id)) return out;

    var actions;
    try {
      var lq = sb.from('po_lines').select('title_snapshot,product_type_snapshot,qty').eq('po_header_id', po.id);
      if (o.companyId) lq = lq.eq('company_entity_id', o.companyId);
      var lines = await lq;
      if (lines.error) throw new Error('Could not read the PO lines: ' + errText(lines.error));

      var totals = productTotals(lines.data);
      if (o.onlyKeys) totals = totals.filter(function (t) { return o.onlyKeys.indexOf(t.key) !== -1; });
      if (!totals.length) return out;

      var tq = sb.from('product_tracker').select(TRACKER_COLUMNS);
      if (o.companyId) tq = tq.eq('company_entity_id', o.companyId);
      var trackers = await tq;
      if (trackers.error) throw new Error('Could not read the Pipeline: ' + errText(trackers.error));

      actions = plan(po, totals, trackers.data, o.onlyKeys, await noteHoldsFor(sb, o, po, totals, trackers.data));
    } catch (e) {
      out.errors.push({ title: null, message: errText(e) });
      return out;
    }

    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      try {
        if (a.kind === 'insert') {
          var row = Object.assign({}, a.patch);
          if (o.companyId) row.company_entity_id = o.companyId;
          var ins = await sb.from('product_tracker').insert(row);
          if (ins.error) throw ins.error;
          out.inserted.push(a);
        } else if (a.kind === 'update') {
          var upd = await sb.from('product_tracker').update(a.patch).eq('id', a.row.id);
          if (upd.error) throw upd.error;
          out.updated.push(a);
          // A Pipeline item linked to a launch has a paired
          // launch_product_readiness row carrying its own copy of the figure
          // (launch_product_actuals_v reads it for % of expected). Keep it in
          // step, exactly as the Pipeline drawer's own save does.
          if ('expected_units' in a.patch && hasText(a.row.launch_id)) {
            var lpr = await sb.from('launch_product_readiness').update({ expected_units: a.patch.expected_units }).eq('product_tracker_id', a.row.id);
            if (lpr.error) throw new Error('Pipeline updated, but its launch still shows the old expected units: ' + errText(lpr.error));
          }
        } else if (a.kind === 'unchanged') {
          out.unchanged.push(a);
        } else {
          out.otherPo.push(a);
        }
      } catch (e) {
        out.errors.push({ title: a.title, message: errText(e) });
      }
    }
    return out;
  }

  /**
   * Coalesce overlapping syncs per key (a PO id). Autosave fires a line save
   * 650ms after typing stops, so edits across several lines overlap; two
   * concurrent syncs could both find no Pipeline item and both insert one.
   * A request made while one is running does not start a second: it marks
   * the running one to go round again, so the last change is always synced
   * and never twice in parallel. `merge(pending, next)` combines what was
   * asked for while waiting; without it the newest argument wins.
   */
  function createQueue(run, merge) {
    var slots = new Map();
    return function request(key, arg) {
      var s = slots.get(key);
      if (s) {
        s.arg = s.again && merge ? merge(s.arg, arg) : arg;
        s.again = true;
        return s.promise;
      }
      s = { arg: arg, again: false, promise: null };
      slots.set(key, s);
      s.promise = (async function () {
        try {
          var last;
          do { s.again = false; last = await run(s.arg); } while (s.again);
          return last;
        } finally { slots.delete(key); }
      })();
      return s.promise;
    };
  }

  root.SiloPoPipeline = {
    titleKey: titleKey,
    notedPoName: notedPoName,
    productTotals: productTotals,
    plan: plan,
    sync: sync,
    createQueue: createQueue,
    TRACKER_COLUMNS: TRACKER_COLUMNS,
  };
})(typeof window !== 'undefined' ? window : this);
