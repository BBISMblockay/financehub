/* Inventory signal + filter semantics for /v2/inventory.html.
 *
 * WHY THIS IS ITS OWN FILE. Everything here is a claim the page makes about
 * stock, and every one of them was wrong in a way that read as confident.
 * Pulling the rules out of the page makes them testable without a browser
 * (see v2/tests/unit/), which is the only reason the three bugs below can be
 * held down by a regression suite rather than by someone re-checking Sonic by
 * hand.
 *
 * THE ONE IDEA. `inventory_workboard_v.days_oos` is NULL when there is no
 * demand basis to divide by, and the page used to read it through a `num()`
 * helper that turns NULL into 0. Zero and unknown then became the same value,
 * and from there:
 *
 *   - "cover <= 7 days" matched every row with no demand data at all. Measured
 *     2026-09-07 against Baseballism: 58,384 of 66,745 rows have no cover
 *     basis, so the lens was mostly returning rows it knew nothing about --
 *     including a Sonic collectible pin with 1,002 units and no recorded sale.
 *   - a days-cover cell rendered `x ? x : "—"`, so a genuine 0 (out of stock,
 *     selling 15/day) printed the same em dash as "we have no idea".
 *
 * So: cover is `number | null`, null is never coerced, and every consumer has
 * to say what it means by null. That is the whole design.
 *
 * WHAT COUNTS AS "WE DON'T KNOW". The view hands us two independent facts:
 *   velocity_matched  false => the velocity join found nothing for this row.
 *                              We do not know whether it sold. UNKNOWN.
 *   velocity_matched  true  => the join matched. Zero really is zero.
 * Measured on the same day: 26,947 rows unmatched (3,267 of them holding
 * 141,242 units), and a separate 31,227 rows matched with no sales in the
 * trailing 30/7d windows. Those are different facts about the business and
 * this module keeps them apart.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    lowCoverDays: 14,    // at or under this many days of cover => Low cover
    watchDays: 30,       // at or under this => Watch
    overstockDays: 120,  // at or over this => Overstock
    excessCoverDays: 90, // at or over this => a transfer SEND candidate
    staleDays: 90        // no sale in this many days, with stock => Stale
  };

  /* ---------------------------------------------------------------- numbers */

  /** Finite number or null. Unlike the page's num(), never invents a 0. */
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /** Finite number or 0. For quantities, where absent genuinely means none. */
  function num(v) {
    var n = numOrNull(v);
    return n === null ? 0 : n;
  }

  /* ----------------------------------------------------------- demand basis */

  /**
   * How much we actually know about this row's demand.
   *
   *   'measured'  sold in the last 30d (or 7d); cover is computable
   *   'stale'     demand data exists, sold within 365d, nothing in 30d/7d
   *   'no_sales'  demand data exists and shows zero units in 365d
   *   'unknown'   no demand data joined at all -- NOT the same as zero
   *
   * An aggregate row (SKU / product / type) is 'unknown' only when EVERY
   * underlying location row was unmatched. A partially matched aggregate is
   * measured against the part we know about, and reports that via
   * demandCoverage() so the caller can say so rather than imply completeness.
   */
  function demandBasis(row) {
    if (!row) return 'unknown';
    var known = row.demand_known_count;
    // Location-level rows carry the raw flag; rollups carry the counter.
    if (known === undefined || known === null) {
      known = row.velocity_matched === false ? 0 : 1;
    }
    if (num(known) <= 0) return 'unknown';

    if (num(row.avg_day) > 0 || num(row.avg_day_7) > 0) return 'measured';
    if (num(row.qty_365d) > 0 || num(row.qty_120d) > 0 || num(row.qty_90d) > 0) return 'stale';
    return 'no_sales';
  }

  /**
   * For a rollup: how many of its underlying location rows had demand data.
   * `{ known, total, partial }`. `partial` is the honest caveat -- cover was
   * computed from the sales of `known` rows but the stock of all `total`.
   */
  function demandCoverage(row) {
    if (!row) return { known: 0, total: 0, partial: false };
    var total = row.demand_rows_count;
    var known = row.demand_known_count;
    if (total === undefined || total === null) {
      total = 1;
      known = row.velocity_matched === false ? 0 : 1;
    }
    total = num(total);
    known = num(known);
    return { known: known, total: total, partial: known > 0 && known < total };
  }

  /**
   * Days of cover, or null when there is no basis to compute it.
   *
   * Prefers the value the view already computed (so the page and any SQL
   * report agree to the decimal), and only falls back to dividing when the
   * row is a client-side rollup the view never saw.
   */
  function coverDays(row) {
    if (!row) return null;
    var stored = numOrNull(row.days_cover);
    if (stored !== null) return stored;
    var avg30 = num(row.avg_day);
    if (avg30 > 0) return num(row.avail_qty) / avg30;
    var avg7 = num(row.avg_day_7);
    if (avg7 > 0) return num(row.avail_qty) / avg7;
    return null;
  }

  /* --------------------------------------------------------------- signals */

  /* Ordered most to least urgent. `sev` drives the default sort, so adding a
   * code means deciding where it sits in a triage list, not just naming it. */
  var SIGNALS = {
    data_review:    { sev: 0, label: 'Data review',    cls: 'inv-flag--hold',
                      note: 'Negative units on hand. The count is wrong somewhere; treat every other number on this row as suspect.' },
    out_of_stock:   { sev: 1, label: 'Out of stock',   cls: 'inv-flag--oos',
                      note: 'No units on hand.' },
    low_cover:      { sev: 2, label: 'Low cover',      cls: 'inv-flag--buynow',
                      note: 'Days of cover is at or under the low-cover threshold, measured against recorded sales.' },
    watch:          { sev: 3, label: 'Watch',          cls: 'inv-flag--watch',
                      note: 'Cover is short but not yet at the low-cover threshold.' },
    unknown_demand: { sev: 4, label: 'Unknown demand', cls: 'inv-flag--unknown',
                      note: 'No sales history could be matched to this row, so days of cover cannot be calculated. This is not a claim that it does not sell.' },
    stale:          { sev: 5, label: 'Stale',          cls: 'inv-flag--stale',
                      note: 'Has sold within the last year but nothing in the recent windows, so there is no current rate to project cover from.' },
    no_sales:       { sev: 6, label: 'No recorded sales', cls: 'inv-flag--stale',
                      note: 'Sales history is available for this row and shows no units sold in the last 365 days.' },
    overstock:      { sev: 7, label: 'Overstock',      cls: 'inv-flag--overstock',
                      note: 'Cover is at or over the overstock threshold.' },
    ok:             { sev: 8, label: 'OK',             cls: '',
                      note: 'Cover is within the healthy band.' }
  };

  /* Selectable in the UI. Order is the order they are offered. */
  var SIGNAL_ORDER = ['data_review', 'out_of_stock', 'low_cover', 'watch',
                      'unknown_demand', 'stale', 'no_sales', 'overstock', 'ok'];

  /**
   * The one inventory status for a row.
   *
   * Deliberately NOT a recommendation: nothing here says buy, and nothing here
   * says a row is fine because no other flag fired. "OK" is only reachable
   * with a measured cover inside the healthy band -- a row we know nothing
   * about lands on `unknown_demand`, never on OK. That inversion is the whole
   * point of bug 3: two zero-stock Sonic sizes selling ~450/30d were reading
   * as "OK" because no transfer rule matched them.
   */
  function inventorySignal(row, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var onHand = num(row && row.avail_qty);
    var basis = demandBasis(row);
    var cover = coverDays(row);

    if (onHand < 0) return signal('data_review', row, basis, cover);
    if (onHand <= 0) return signal('out_of_stock', row, basis, cover);
    if (basis === 'unknown') return signal('unknown_demand', row, basis, cover);
    if (basis === 'no_sales') return signal('no_sales', row, basis, cover);
    if (basis === 'stale') return signal('stale', row, basis, cover);

    // basis === 'measured', so cover is a real number.
    if (cover === null) return signal('unknown_demand', row, basis, cover);
    if (cover <= o.lowCoverDays) return signal('low_cover', row, basis, cover);
    if (cover <= o.watchDays) return signal('watch', row, basis, cover);
    if (cover >= o.overstockDays) return signal('overstock', row, basis, cover);
    return signal('ok', row, basis, cover);
  }

  function signal(code, row, basis, cover) {
    var def = SIGNALS[code];
    var cov = demandCoverage(row);
    return {
      code: code,
      label: def.label,
      cls: def.cls,
      sev: def.sev,
      note: def.note,
      basis: basis,
      cover: cover,
      partial: cov.partial,
      coverage: cov
    };
  }

  /**
   * What the days-cover cell should read. Never a bare blank: an empty cell is
   * the thing that made "1,002 units, no idea" and "0 units, selling 15/day"
   * look identical.
   *
   * Returns `{ text, title, muted }`.
   */
  function coverDisplay(row) {
    var cover = coverDays(row);
    var basis = demandBasis(row);
    if (cover !== null) {
      var cov = demandCoverage(row);
      // `(-0.1).toFixed(0)` is "-0", which reads as a typo. A cover between
      // -0.5 and 0 comes from negative stock and is shown as 0; the Data
      // review signal is what reports the negative count itself.
      var rounded = Math.round(cover);
      return {
        text: Object.is(rounded, -0) ? '0' : String(rounded),
        muted: false,
        title: cov.partial
          ? 'Days of cover, from the ' + cov.known + ' of ' + cov.total +
            ' underlying rows that have matched sales history. The other ' +
            (cov.total - cov.known) + ' contribute stock but no demand, so real cover is likely longer.'
          : 'Days of cover at the recorded sales rate.'
      };
    }
    if (basis === 'unknown') {
      return { text: 'Unknown', muted: true,
               title: 'No sales history matched this row, so cover cannot be calculated. Not the same as zero demand.' };
    }
    if (basis === 'no_sales') {
      return { text: 'No sales', muted: true,
               title: 'Sales history is available and shows no units sold in the last 365 days, so there is no rate to project cover from.' };
    }
    return { text: 'No recent sales', muted: true,
             title: 'Sold within the last year but nothing in the recent windows, so there is no current rate to project cover from.' };
  }

  /* -------------------------------------------------------------- transfers */

  /* Transfer eligibility is about where stock SITS relative to other
   * locations. It is not a health verdict, and it never returns "OK" -- the
   * old allocation table did, which is how a zero-stock size selling 450 a
   * month came to be labelled healthy. "—" here means "no transfer signal",
   * and the inventory status column is what says whether the row is fine. */
  var TRANSFER_NOTE =
    'Transfer compares this location against the others holding the same SKU: ' +
    '"Short here" is a candidate to receive units, "Excess here" a candidate to send them. ' +
    'A dash means no transfer signal — it is not a statement that stock is healthy. ' +
    'Read the Inventory column for that.';

  function transferStatus(row, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var onHand = num(row && row.avail_qty);
    var cover = coverDays(row);
    if (onHand < 0) return { code: 'none', label: '—', cls: '' };
    if (cover === null || onHand <= 0) return { code: 'none', label: '—', cls: '' };
    if (cover <= o.lowCoverDays) return { code: 'short', label: 'Short here', cls: 'inv-flag--buynow' };
    // Deliberately 90, not the 120 that flags Overstock: a location can be
    // worth drawing stock FROM well before its stock is a problem overall.
    // This is the threshold the old allocation table used, kept as it was.
    if (cover >= o.excessCoverDays) return { code: 'excess', label: 'Excess here', cls: 'inv-flag--transfer' };
    return { code: 'none', label: '—', cls: '' };
  }

  /* ---------------------------------------------------------------- filters */

  /* A lens is a saved shortcut that writes into ONE named filter field. That
   * is what makes "Clear lenses" able to clear only what a lens put there --
   * bug 1, where it was wired to a wholesale reset and erased the search box
   * and the location scope along with the lens. */
  var LENSES = {
    cover7:   { field: 'maxCoverDays', value: 7,  label: 'Cover ≤ 7 days' },
    cover14:  { field: 'maxCoverDays', value: 14, label: 'Cover ≤ 14 days' },
    onhand10: { field: 'maxOnHand',    value: 10, label: 'On hand ≤ 10' },
    oos:      { field: 'signal',       value: 'out_of_stock',   label: 'Out of stock' },
    unknown:  { field: 'signal',       value: 'unknown_demand', label: 'Unknown demand' },
    negative: { field: 'signal',       value: 'data_review',    label: 'Negative inventory' },
    stale:    { field: 'sort',         value: 'stale_desc',     label: 'Stale first' }
  };

  /* Fields a lens is allowed to own, and what "cleared" means for each. */
  var LENS_FIELD_DEFAULTS = { maxCoverDays: null, maxOnHand: null, signal: '__ALL__', sort: 'signal' };

  function emptyState() {
    return {
      level: 'product',
      q: '',
      location: '__ALL__',
      productType: '__ALL__',
      tag: '__ALL__',
      subTag: '__ALL__',
      indicator: '__ALL__',
      signal: '__ALL__',
      maxCoverDays: null,
      maxOnHand: null,
      minSold30: null,
      sort: 'signal',
      lenses: []
    };
  }

  /** Reset all — the explicit, separate action bug 1 asks to keep. */
  function resetAll(state) {
    var fresh = emptyState();
    // The view level is not a filter; resetting filters must not throw the
    // user back to a different table than the one they are reading.
    if (state && state.level) fresh.level = state.level;
    return fresh;
  }

  /**
   * Clear ONLY what the active lenses set. Search, location, product type,
   * tags, indicators and hand-typed thresholds all survive.
   */
  function clearLenses(state) {
    var next = Object.assign({}, state || emptyState());
    var active = (next.lenses || []).slice();
    active.forEach(function (id) {
      var lens = LENSES[id];
      if (!lens) return;
      // Only revert the field if it still holds what this lens put there.
      // A value the user typed over is theirs, not the lens's.
      if (next[lens.field] === lens.value) {
        next[lens.field] = LENS_FIELD_DEFAULTS[lens.field];
      }
    });
    next.lenses = [];
    return next;
  }

  /** Turn a lens on/off. Two lenses owning the same field replace each other. */
  function toggleLens(state, id) {
    var lens = LENSES[id];
    if (!lens) return state;
    var next = Object.assign({}, state);
    var lenses = (next.lenses || []).slice();
    var on = lenses.indexOf(id) !== -1;

    if (on) {
      lenses = lenses.filter(function (x) { return x !== id; });
      if (next[lens.field] === lens.value) next[lens.field] = LENS_FIELD_DEFAULTS[lens.field];
    } else {
      // Drop any other lens that owns the same field: one value, one owner.
      lenses = lenses.filter(function (x) { return !LENSES[x] || LENSES[x].field !== lens.field; });
      lenses.push(id);
      next[lens.field] = lens.value;
    }
    next.lenses = lenses;
    return next;
  }

  /* Tag columns only exist below the product-type rollup. Applying a tag
   * filter at type level used to silently return zero rows, which reads as
   * "no matching stock" rather than "this filter has no meaning here". */
  function fieldAppliesAtLevel(field, level) {
    if (level === 'type') {
      return ['tag', 'subTag', 'indicator'].indexOf(field) === -1;
    }
    return true;
  }

  function searchBlob(row) {
    return [row.product_type, row.product, row.sku, row.barcode, row.variant,
            row.tag, row.sub_tag, row.indicator_group, row.collection, row.location]
      .join(' ').toLowerCase();
  }

  /**
   * Does this row survive the filter state?
   *
   * The cover filter is the fix for bug 2: a row qualifies only when cover is
   * an actual number. A row whose cover is unknown is EXCLUDED from a "cover
   * <= N" lens, because it has not been shown to be under N -- it has not been
   * shown to be anything.
   */
  function matchesFilters(row, state, opts) {
    var st = state || emptyState();
    var level = st.level || (row && row.level) || 'product';

    if (st.q) {
      var q = String(st.q).trim().toLowerCase();
      if (q && searchBlob(row).indexOf(q) === -1) return false;
    }
    if (st.location && st.location !== '__ALL__') {
      if (!rowMatchesLocation(row, st.location)) return false;
    }
    if (st.productType && st.productType !== '__ALL__') {
      if ((String(row.product_type || 'Uncategorized').trim()) !== st.productType) return false;
    }
    if (fieldAppliesAtLevel('tag', level) && st.tag && st.tag !== '__ALL__') {
      if (String(row.tag || '').trim() !== st.tag) return false;
    }
    if (fieldAppliesAtLevel('subTag', level) && st.subTag && st.subTag !== '__ALL__') {
      if (String(row.sub_tag || '').trim() !== st.subTag) return false;
    }
    if (fieldAppliesAtLevel('indicator', level) && st.indicator && st.indicator !== '__ALL__') {
      if (String(row.indicator_group || '').trim() !== st.indicator) return false;
    }

    if (st.maxCoverDays !== null && st.maxCoverDays !== undefined && st.maxCoverDays !== '') {
      var cover = coverDays(row);
      if (cover === null) return false;              // unknown is not "under N"
      if (cover > num(st.maxCoverDays)) return false;
    }
    if (st.maxOnHand !== null && st.maxOnHand !== undefined && st.maxOnHand !== '') {
      if (num(row.avail_qty) > num(st.maxOnHand)) return false;
    }
    if (st.minSold30 !== null && st.minSold30 !== undefined && st.minSold30 !== '') {
      if (num(row.sold_30) < num(st.minSold30)) return false;
    }
    if (st.signal && st.signal !== '__ALL__') {
      if (inventorySignal(row, opts).code !== st.signal) return false;
    }
    return true;
  }

  /** Location scoping walks the rollup's children, same as it always has. */
  function rowMatchesLocation(r, source) {
    if (!source || source === '__ALL__') return true;
    if (r.level === 'location') return r.source_id === source;
    if (r.level === 'sku') return (r.children || []).some(function (x) { return x.source_id === source; });
    if (r.level === 'product') {
      return (r.children || []).some(function (s) {
        return (s.children || []).some(function (x) { return x.source_id === source; });
      });
    }
    if (r.level === 'type') {
      return (r.children || []).some(function (p) {
        return (p.children || []).some(function (s) {
          return (s.children || []).some(function (x) { return x.source_id === source; });
        });
      });
    }
    return true;
  }

  /* ------------------------------------------------------------------ chips */

  /**
   * Every applied condition, as a removable chip. `field` is what to clear;
   * `lens` marks chips that came from a lens so removing one also un-presses
   * the button. Chips that do not apply at the current level are returned
   * with `inactive: true` rather than hidden, so a filter that is silently
   * doing nothing still says so.
   */
  function activeChips(state) {
    var st = state || emptyState();
    var level = st.level || 'product';
    var chips = [];
    var lensFor = function (field) {
      var hit = (st.lenses || []).filter(function (id) {
        return LENSES[id] && LENSES[id].field === field && st[field] === LENSES[id].value;
      });
      return hit.length ? hit[0] : null;
    };
    var add = function (field, label, extra) {
      chips.push(Object.assign({ field: field, label: label, lens: lensFor(field), inactive: false }, extra || {}));
    };

    if (st.q) add('q', 'Search: "' + st.q + '"');
    if (st.location && st.location !== '__ALL__') {
      add('location', 'Location: ' + (st.locationLabel || st.location));
    }
    if (st.productType && st.productType !== '__ALL__') add('productType', 'Type: ' + st.productType);
    if (st.tag && st.tag !== '__ALL__') {
      add('tag', 'Tag: ' + st.tag, { inactive: !fieldAppliesAtLevel('tag', level) });
    }
    if (st.subTag && st.subTag !== '__ALL__') {
      add('subTag', 'Sub tag: ' + st.subTag, { inactive: !fieldAppliesAtLevel('subTag', level) });
    }
    if (st.indicator && st.indicator !== '__ALL__') {
      add('indicator', 'Indicator: ' + st.indicator, { inactive: !fieldAppliesAtLevel('indicator', level) });
    }
    if (st.signal && st.signal !== '__ALL__') {
      add('signal', 'Signal: ' + ((SIGNALS[st.signal] || {}).label || st.signal));
    }
    if (st.maxCoverDays !== null && st.maxCoverDays !== undefined && st.maxCoverDays !== '') {
      add('maxCoverDays', 'Cover ≤ ' + st.maxCoverDays + ' days');
    }
    if (st.maxOnHand !== null && st.maxOnHand !== undefined && st.maxOnHand !== '') {
      add('maxOnHand', 'On hand ≤ ' + st.maxOnHand + ' units');
    }
    if (st.minSold30 !== null && st.minSold30 !== undefined && st.minSold30 !== '') {
      add('minSold30', 'Sold 30d ≥ ' + st.minSold30 + ' units');
    }
    return chips;
  }

  /** Clear one chip's field, and the lens that set it if there was one. */
  function clearField(state, field) {
    var next = Object.assign({}, state || emptyState());
    var blank = { q: '', location: '__ALL__', productType: '__ALL__', tag: '__ALL__',
                  subTag: '__ALL__', indicator: '__ALL__', signal: '__ALL__',
                  maxCoverDays: null, maxOnHand: null, minSold30: null, sort: 'signal' };
    if (Object.prototype.hasOwnProperty.call(blank, field)) next[field] = blank[field];
    next.lenses = (next.lenses || []).filter(function (id) {
      return !LENSES[id] || LENSES[id].field !== field;
    });
    return next;
  }

  /* ------------------------------------------------------------------ sorts */

  var SORTS = [
    { value: 'signal',       label: 'Inventory signal (most urgent first)' },
    { value: 'cover_asc',    label: 'Days cover — lowest first (measured only)' },
    { value: 'cover_desc',   label: 'Days cover — highest first (measured only)' },
    { value: 'qty_desc',     label: 'On hand — highest first' },
    { value: 'qty_asc',      label: 'On hand — lowest first' },
    { value: 'sold30_desc',  label: 'Sold 30d — highest first' },
    { value: 'sold7_desc',   label: 'Sold 7d — highest first' },
    { value: 'sold365_desc', label: 'Sold 365d — highest first' },
    { value: 'value_desc',   label: 'Retail value on hand — highest first' },
    { value: 'stale_desc',   label: 'Last sold — oldest first' },
    { value: 'name_asc',     label: 'Name / SKU (A→Z)' }
  ];

  /* A row with no measurable cover sorts to the END of both cover sorts. It
   * is not the lowest cover and it is not the highest; putting it at either
   * extreme is the same false claim in a different direction. */
  function compareRows(a, b, sort, opts) {
    var ac, bc;
    switch (sort) {
      case 'cover_asc':
        ac = coverDays(a); bc = coverDays(b);
        if (ac === null && bc === null) return 0;
        if (ac === null) return 1;
        if (bc === null) return -1;
        return ac - bc;
      case 'cover_desc':
        ac = coverDays(a); bc = coverDays(b);
        if (ac === null && bc === null) return 0;
        if (ac === null) return 1;
        if (bc === null) return -1;
        return bc - ac;
      case 'qty_asc': return num(a.avail_qty) - num(b.avail_qty);
      case 'qty_desc': return num(b.avail_qty) - num(a.avail_qty);
      case 'sold7_desc': return num(b.qty_7d) - num(a.qty_7d);
      case 'sold30_desc': return num(b.sold_30) - num(a.sold_30);
      case 'sold365_desc': return num(b.qty_365d) - num(a.qty_365d);
      case 'value_desc': return num(b.inv_value) - num(a.inv_value);
      case 'stale_desc': return num(a.last_sold_ms) - num(b.last_sold_ms);
      case 'name_asc':
        return String(a.product_type || a.product || a.sku || '')
          .localeCompare(String(b.product_type || b.product || b.sku || ''));
      case 'signal':
      default: {
        var sa = inventorySignal(a, opts).sev;
        var sb = inventorySignal(b, opts).sev;
        if (sa !== sb) return sa - sb;
        // Within a severity band, the biggest money at stake reads first.
        return num(b.inv_value) - num(a.inv_value);
      }
    }
  }

  var API = {
    DEFAULTS: DEFAULTS,
    SIGNALS: SIGNALS,
    SIGNAL_ORDER: SIGNAL_ORDER,
    LENSES: LENSES,
    SORTS: SORTS,
    TRANSFER_NOTE: TRANSFER_NOTE,
    numOrNull: numOrNull,
    coverDays: coverDays,
    coverDisplay: coverDisplay,
    demandBasis: demandBasis,
    demandCoverage: demandCoverage,
    inventorySignal: inventorySignal,
    transferStatus: transferStatus,
    emptyState: emptyState,
    resetAll: resetAll,
    clearLenses: clearLenses,
    toggleLens: toggleLens,
    clearField: clearField,
    fieldAppliesAtLevel: fieldAppliesAtLevel,
    matchesFilters: matchesFilters,
    rowMatchesLocation: rowMatchesLocation,
    activeChips: activeChips,
    compareRows: compareRows
  };

  if (typeof window !== 'undefined') window.SiloInventorySignals = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
