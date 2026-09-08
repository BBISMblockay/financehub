/* Connected navigation for SILO's sales reports.
 *
 * Trend -> category -> product -> underlying records. Each hop carries the
 * dates, the channel/store group, the category and (where it means the same
 * thing) the metric, so the destination opens on the slice you clicked rather
 * than on its own defaults.
 *
 * TWO CONVENTIONS, AND THEY DO DIFFERENT JOBS.
 *
 *   URL parameters   are the link. They survive a copy-paste, a refresh and
 *                    the back button, which sessionStorage does not.
 *   silo:bi:filters  is the existing sessionStorage hand-off already used by
 *                    bi-daily-trend / bi-product-types / bi-product-search /
 *                    bi-top-sellers. It is kept, and still carries the last
 *                    dates and store group between pages when you navigate by
 *                    the sidebar rather than by a link.
 *
 * Precedence on arrival is URL first, then sessionStorage, then the page's
 * own default. A link is an explicit request; a remembered filter is not.
 *
 * THE RULE THAT MATTERS. A destination either represents a filter or says it
 * cannot. `dropped` is returned from every resolve so the page can print the
 * gap. A link that carries a channel to a report with no channel control must
 * not quietly show all channels under a heading that says otherwise.
 */
(function () {
  'use strict';

  var SHARED_KEY = 'silo:bi:filters';

  /* Every parameter any sales report understands. A page declares which of
   * these it SUPPORTS; anything else in the link is reported, not applied. */
  var PARAMS = {
    dateFrom:   { label: 'From' },
    dateTo:     { label: 'To' },
    storeGroup: { label: 'Store group' },
    productType:{ label: 'Product type' },
    sku:        { label: 'SKU' },
    productName:{ label: 'Product' },
    metric:     { label: 'Metric' },
    preset:     { label: 'Exception filter' }
  };

  function readShared() {
    try { return JSON.parse(sessionStorage.getItem(SHARED_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function writeShared(patch) {
    try {
      sessionStorage.setItem(SHARED_KEY, JSON.stringify(Object.assign(readShared(), patch)));
    } catch (e) { /* private mode */ }
  }

  /**
   * Work out what this page should open with.
   *
   * `supported` is the list of parameter names this report can actually
   * honour. Returns the values to apply, plus what arrived and could not be —
   * which the caller is expected to SHOW, not swallow.
   */
  function resolveIncoming(supported, opts) {
    var o = opts || {};
    var search = o.search !== undefined ? o.search : (typeof location !== 'undefined' ? location.search : '');
    var p = new URLSearchParams(search || '');
    var shared = o.shared !== undefined ? o.shared : readShared();

    var applied = {};
    var dropped = [];
    var fromUrl = {};

    p.forEach(function (value, key) {
      if (!PARAMS[key]) {
        dropped.push({ key: key, label: key, value: value, reason: 'not a recognised report filter' });
        return;
      }
      fromUrl[key] = value;
      if (supported.indexOf(key) === -1) {
        dropped.push({
          key: key, label: PARAMS[key].label, value: value,
          reason: 'this report has no ' + PARAMS[key].label.toLowerCase() + ' control'
        });
        return;
      }
      // An enum-ish value the page does not offer is refused rather than
      // approximated. Substituting the nearest option is a quiet lie.
      if (o.validate && o.validate[key] && !o.validate[key](value)) {
        dropped.push({
          key: key, label: PARAMS[key].label, value: value,
          reason: 'not available on this report'
        });
        return;
      }
      applied[key] = value;
    });

    // Fall back to the remembered filters for anything the link did not carry.
    supported.forEach(function (key) {
      if (applied[key] !== undefined) return;
      if (shared[key] !== undefined && shared[key] !== null && shared[key] !== '') applied[key] = shared[key];
    });

    return { applied: applied, dropped: dropped, fromUrl: fromUrl, hadLink: Object.keys(fromUrl).length > 0 };
  }

  /** A sentence naming what this report could not honour, or null. */
  function droppedNote(dropped) {
    if (!dropped || !dropped.length) return null;
    return 'Opened from a link that also asked for '
      + dropped.map(function (d) { return d.label + ' = "' + d.value + '" (' + d.reason + ')'; }).join('; ')
      + '. Those are not applied below.';
  }

  /**
   * Build a link to another report.
   *
   * Returns the href plus what was left behind, so a caller can label the link
   * honestly BEFORE it is followed rather than have the destination apologise
   * afterwards.
   */
  function buildLink(path, values, supported) {
    var p = new URLSearchParams();
    var dropped = [];
    Object.keys(values || {}).forEach(function (k) {
      var v = values[k];
      if (v === undefined || v === null || v === '' || v === 'all' || v === '__ALL__') return;
      if (supported.indexOf(k) === -1) {
        dropped.push({ key: k, label: (PARAMS[k] || {}).label || k, value: v });
        return;
      }
      p.set(k, String(v));
    });
    var qs = p.toString();
    return { href: qs ? path + '?' + qs : path, dropped: dropped };
  }

  /* What each destination can actually honour. Kept here rather than in each
   * page so a link and its target cannot drift apart silently. */
  var SUPPORTS = {
    '/v2/bi-daily-trend.html':    ['dateFrom', 'dateTo', 'storeGroup', 'metric'],
    '/v2/bi-product-types.html':  ['dateFrom', 'dateTo', 'storeGroup', 'metric'],
    '/v2/bi-product-search.html': ['dateFrom', 'dateTo', 'storeGroup', 'productType', 'sku', 'productName'],
    '/v2/sales-verification.html':['dateFrom', 'dateTo', 'storeGroup', 'preset']
  };

  function supportsOf(path) { return SUPPORTS[path] || []; }

  /** Convenience: link to a destination by path, using its declared support. */
  function linkFor(path, values) {
    return buildLink(path, values, supportsOf(path));
  }

  /**
   * Replace the current URL with the applied state, without adding a history
   * entry. Refresh then reproduces what is on screen, and Back still goes to
   * the page you came FROM rather than stepping through filter changes.
   */
  function syncUrl(values, supported) {
    if (typeof history === 'undefined' || !history.replaceState) return;
    var link = buildLink(location.pathname, values, supported);
    history.replaceState(null, '', link.href);
  }

  var API = {
    SHARED_KEY: SHARED_KEY,
    PARAMS: PARAMS,
    SUPPORTS: SUPPORTS,
    supportsOf: supportsOf,
    readShared: readShared,
    writeShared: writeShared,
    resolveIncoming: resolveIncoming,
    droppedNote: droppedNote,
    buildLink: buildLink,
    linkFor: linkFor,
    syncUrl: syncUrl
  };

  if (typeof window !== 'undefined') window.SiloBiNav = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
