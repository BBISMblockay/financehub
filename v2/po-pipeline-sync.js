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
 * Creating and claiming happen only for a new-product PO (or for the one
 * product someone pressed -> TRK on). Keeping items the PO ALREADY owns in
 * step happens on every PO, so unticking "New product PO" stops new items
 * without freezing the ones it made.
 *
 * An item whose product has LEFT the PO it is linked to -- its last line
 * deleted, or renamed to another title -- is released: unlinked, and its
 * expected units cleared (so is its launch readiness copy). Never deleted:
 * the item carries photos, samples and launch links a person made, and the
 * units are what stopped being true. A released item can be claimed again by
 * whichever PO carries the product next, this one included.
 *
 * Two tabs, or two people, can sync at once -- the same PO, or two POs that
 * carry the same product. The browser queue only serialises one tab; the
 * database is the boundary: a partial unique index on (company_entity_id,
 * lower(btrim(product_title))) over LINKED items (20260923190000) allows one
 * linked item per product per company, so the second insert or claim fails,
 * and sync() re-reads the item that won: its own PO's is brought in step,
 * another PO's is left alone, exactly as if it had been there all along.
 *
 * Every read is paged to the end (readAll). A release is destructive -- it
 * clears expected units and the launch copy -- so it may only be planned
 * from the PO's COMPLETE line list: a product lost past a response cap would
 * otherwise read as "left the PO".
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

  /** create: true = any product; an array of titleKeys = those products only;
   *  anything else = none. Undefined means true (the pure planner's default). */
  function mayCreate(create, key) {
    if (create === undefined || create === null || create === true) return true;
    return Array.isArray(create) && create.indexOf(key) !== -1;
  }

  /**
   * Decide what to write. Pure: no I/O.
   *
   *   po         { id, po_name, factory_id, factory_name, expected_arrival_date }
   *   totals     productTotals(lines) -- EVERY product on the PO
   *   trackers   the company's product_tracker rows
   *   create     who may be created or claimed (see mayCreate)
   *   noteHolds  optional (notedPoName, key) -> bool: does the PO an item's
   *              note names still carry that product? Omitted = assume it
   *              does, so an item auto-added from another PO is left alone
   *
   * Returns one action per product on the PO that has anything to say, plus
   * one per item this PO owns whose product is no longer on it:
   *   { kind, key, title, units, lineCount, row?, patch? }
   *   kind 'insert'     patch is the new row
   *   kind 'update'     patch names only the columns that change
   *   kind 'unchanged'  row already says what the PO says
   *   kind 'other_po'   row belongs to another PO (or was auto-added from
   *                     one that still carries it); nothing written
   *   kind 'release'    the product left this PO: unlink, clear the units
   */
  function plan(po, totals, trackers, create, noteHolds) {
    var p = po || {};
    var rows = trackers || [];
    var poName = hasText(p.po_name) ? String(p.po_name).trim() : '';
    var fills = {
      factory_id: hasText(p.factory_id) ? p.factory_id : null,
      manufacturer: hasText(p.factory_name) ? String(p.factory_name).trim() : null,
      bulk_eta: hasText(p.expected_arrival_date) ? String(p.expected_arrival_date).slice(0, 10) : null,
    };

    var onPo = new Set();
    var actions = [];
    (totals || []).forEach(function (t) {
      onPo.add(t.key);
      var base = { key: t.key, title: t.title, units: t.units, lineCount: t.lineCount };
      var same = rows.filter(function (r) { return titleKey(r.product_title) === t.key; });
      var own = same.find(function (r) { return sameId(r.po_header_id, p.id); });
      var canCreate = mayCreate(create, t.key);
      if (!own && !canCreate) return;
      // Another PO already owns this product: leave it alone, and claim
      // nothing -- one linked item per product (the unique index refuses a
      // second one anyway).
      var elsewhere = own ? null : same.find(function (r) { return hasText(r.po_header_id); });
      if (elsewhere) { actions.push(Object.assign({ kind: 'other_po', row: elsewhere }, base)); return; }
      var claimable = own ? null : same.find(function (r) {
        if (hasText(r.po_header_id)) return false;
        var noted = notedPoName(r.notes);
        if (!noted || noted.toLowerCase() === poName.toLowerCase()) return true;
        return typeof noteHolds === 'function' ? !noteHolds(noted, t.key) : false;
      });
      var row = own || claimable;

      if (!row) {
        if (same.length) { actions.push(Object.assign({ kind: 'other_po', row: same[0] }, base)); return; }
        actions.push(Object.assign({ kind: 'insert', patch: {
            product_title: t.title,
            product_type: t.productType,
            factory_id: fills.factory_id,
            manufacturer: fills.manufacturer,
            bulk_eta: fills.bulk_eta,
            expected_units: t.units,
            po_header_id: p.id,
            notes: ('Auto-added from PO: ' + poName).trim(),
          } }, base));
        return;
      }

      var patch = {};
      if (!sameId(row.po_header_id, p.id)) patch.po_header_id = p.id;
      var current = row.expected_units == null || row.expected_units === '' ? null : Number(row.expected_units);
      if (current !== t.units) patch.expected_units = t.units;
      if (!hasText(row.product_type) && t.productType) patch.product_type = t.productType;
      ['factory_id', 'manufacturer', 'bulk_eta'].forEach(function (c) {
        if (!hasText(row[c]) && fills[c]) patch[c] = fills[c];
      });
      actions.push(Object.keys(patch).length
        ? Object.assign({ kind: 'update', row: row, patch: patch }, base)
        : Object.assign({ kind: 'unchanged', row: row }, base));
    });

    // Items this PO owns whose product is no longer on it.
    rows.forEach(function (r) {
      if (!sameId(r.po_header_id, p.id)) return;
      var key = titleKey(r.product_title);
      if (onPo.has(key)) return;
      actions.push({ kind: 'release', key: key, title: String(r.product_title || '').trim(), units: null, lineCount: 0,
        row: r, patch: { po_header_id: null, expected_units: null } });
    });
    return actions;
  }

  var TRACKER_COLUMNS = 'id,product_title,po_header_id,expected_units,factory_id,manufacturer,product_type,bulk_eta,launch_id,notes';
  var UNIQUE_VIOLATION = '23505';

  function errText(e) { return (e && (e.message || e.details)) || String(e); }
  function isConflict(e) { return !!e && String(e.code || '') === UNIQUE_VIOLATION; }

  var PAGE = 1000;

  /**
   * Every row a query matches, however many responses that takes. A response
   * is capped (1,000 rows by default, and the cap is server configuration),
   * so this pages by offset in a stable order and stops only on an EMPTY
   * page -- stopping on a short one would silently truncate under any lower
   * cap. `build` returns a fresh query each call. Any page's error is the
   * whole read's error: a partial list is never returned.
   */
  async function readAll(build) {
    var all = [];
    for (;;) {
      var got = await build().order('id', { ascending: true }).range(all.length, all.length + PAGE - 1);
      if (got.error) return { data: null, error: got.error };
      var page = got.data || [];
      if (!page.length) return { data: all, error: null };
      // More than was asked for means the range was ignored; paging on would
      // re-read the same rows forever.
      if (page.length > PAGE) return { data: null, error: { message: 'The server ignored paging; the read was stopped.' } };
      all = all.concat(page);
    }
  }

  /**
   * For unlinked items whose note names a DIFFERENT PO, find out whether that
   * PO still carries the product. Returns plan()'s noteHolds, or undefined
   * (= assume it does) when nothing needs asking or the answer is unknown: a
   * failed read must never turn into claiming another PO's item. Two reads,
   * and only when such an item exists for a product on this PO.
   */
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

    // Paged: a noted PO, or one of its lines, lost past a response cap would
    // read as "gone" and hand its item to this PO.
    var heads = await readAll(function () {
      var hq = sb.from('po_headers').select('id,po_name');
      return o.companyId ? hq.eq('company_entity_id', o.companyId) : hq;
    });
    if (heads.error) return undefined;
    var nameById = new Map();
    heads.data.forEach(function (h) {
      var n = String(h.po_name || '').trim().toLowerCase();
      if (names.has(n)) nameById.set(String(h.id), n);
    });

    var held = new Set();
    if (nameById.size) {
      var ids = Array.from(nameById.keys());
      var got = await readAll(function () {
        var lq = sb.from('po_lines').select('id,po_header_id,title_snapshot').in('po_header_id', ids);
        return o.companyId ? lq.eq('company_entity_id', o.companyId) : lq;
      });
      if (got.error) return undefined;
      got.data.forEach(function (l) {
        held.add(nameById.get(String(l.po_header_id)) + '|' + titleKey(l.title_snapshot));
      });
    }
    return function (noted, key) { return held.has(String(noted).trim().toLowerCase() + '|' + key); };
  }

  function readTrackers(sb, o) {
    return readAll(function () {
      var tq = sb.from('product_tracker').select(TRACKER_COLUMNS);
      return o.companyId ? tq.eq('company_entity_id', o.companyId) : tq;
    });
  }

  /** The launch readiness copy of a launch-linked item follows its figure,
   *  exactly as the Pipeline drawer's own save does (launch_product_actuals_v
   *  reads it for % of expected). */
  async function syncReadiness(sb, row, units) {
    if (!hasText(row && row.launch_id)) return;
    var lpr = await sb.from('launch_product_readiness').update({ expected_units: units }).eq('product_tracker_id', row.id);
    if (lpr.error) throw new Error('Pipeline updated, but its launch still shows the old expected units: ' + errText(lpr.error));
  }

  /**
   * Another tab or person got there first: the unique index refused a second
   * linked item for this product. Re-read the linked item that won -- this
   * PO's, or another PO's -- and treat it exactly as if it had been there
   * when we planned: this PO's is brought in step, another PO's is left
   * alone. Returns the action actually applied.
   */
  async function resolveConflict(sb, o, po, a) {
    var got = await readTrackers(sb, o);
    if (got.error) throw new Error('Could not re-read the Pipeline after a conflict: ' + errText(got.error));
    var winner = got.data.filter(function (r) { return hasText(r.po_header_id) && titleKey(r.product_title) === a.key; });
    if (!winner.length) throw new Error('The Pipeline refused a duplicate item, and the existing one could not be found.');
    var total = { key: a.key, title: a.title, units: a.units, lineCount: a.lineCount, productType: a.patch && a.patch.product_type };
    var again = plan(po, [total], winner, [a.key])[0];
    if (again.kind === 'update') {
      var upd = await sb.from('product_tracker').update(again.patch).eq('id', again.row.id);
      if (upd.error) throw upd.error;
      if ('expected_units' in again.patch) await syncReadiness(sb, again.row, again.patch.expected_units);
    }
    return again;
  }

  /**
   * Read the PO's lines and the company's Pipeline, then apply plan().
   * Never throws: failures come back in `errors`, one per product, so one
   * refused write does not hide what the others did.
   *
   *   opts.po         the PO (see plan)
   *   opts.companyId  active company id, or null (RLS still scopes the reads
   *                   and the stamp trigger still stamps the insert)
   *   opts.create     see mayCreate; defaults to the PO's own "New product
   *                   PO" flag, so a restock PO never adds items by itself
   */
  async function sync(sb, opts) {
    var o = opts || {};
    var po = o.po || {};
    var out = { inserted: [], updated: [], unchanged: [], otherPo: [], released: [], errors: [] };
    if (!hasText(po.id)) return out;
    var create = o.create !== undefined ? o.create : !!po.is_new_product_po;

    var actions;
    try {
      // The COMPLETE line list, or nothing: releases are planned from it.
      var lines = await readAll(function () {
        var lq = sb.from('po_lines').select('id,title_snapshot,product_type_snapshot,qty').eq('po_header_id', po.id);
        return o.companyId ? lq.eq('company_entity_id', o.companyId) : lq;
      });
      if (lines.error) throw new Error('Could not read the PO lines: ' + errText(lines.error));
      var totals = productTotals(lines.data);

      // Read even when the PO has no lines left: that is exactly when the
      // items it owns have to be released.
      var trackers = await readTrackers(sb, o);
      if (trackers.error) throw new Error('Could not read the Pipeline: ' + errText(trackers.error));

      actions = plan(po, totals, trackers.data, create, await noteHoldsFor(sb, o, po, totals, trackers.data));
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
          if (isConflict(ins.error)) { pushResult(out, await resolveConflict(sb, o, po, a)); continue; }
          if (ins.error) throw ins.error;
          out.inserted.push(a);
        } else if (a.kind === 'update' || a.kind === 'release') {
          var upd = await sb.from('product_tracker').update(a.patch).eq('id', a.row.id);
          // Claiming an unlinked item can collide with an item another tab
          // just linked for the same product, from this PO or another.
          if (a.kind === 'update' && isConflict(upd.error)) { pushResult(out, await resolveConflict(sb, o, po, a)); continue; }
          if (upd.error) throw upd.error;
          (a.kind === 'release' ? out.released : out.updated).push(a);
          if ('expected_units' in a.patch) await syncReadiness(sb, a.row, a.patch.expected_units);
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

  function pushResult(out, a) {
    if (a.kind === 'update') out.updated.push(a);
    else if (a.kind === 'unchanged') out.unchanged.push(a);
    else out.otherPo.push(a);
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
    readAll: readAll,
    PAGE: PAGE,
    TRACKER_COLUMNS: TRACKER_COLUMNS,
  };
})(typeof window !== 'undefined' ? window : this);
