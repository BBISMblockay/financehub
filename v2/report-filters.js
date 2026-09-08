/* Shared filter-state, chip and deep-link plumbing for SILO's report pages.
 *
 * WHY ONE FILE. Six pages needed the same three things — show what is
 * currently filtering the view, let each condition be removed on its own, and
 * hand the whole state to another page through the URL. Written six times
 * those diverge immediately, and the place it hurts is the hand-off: a link
 * that carries `channel` to a page which has no channel control silently
 * shows unfiltered data under a heading that claims otherwise.
 *
 * The rule that drives the design: a destination either represents a filter
 * or SAYS it cannot. There is no third option, and `describeDropped()` exists
 * so "cannot" is a visible sentence rather than a missing one.
 *
 * State is a plain object keyed by filter name. A page supplies DEFS
 * describing its own filters; nothing here knows about any particular page.
 */
(function () {
  'use strict';

  /* A def: { key, label, type, blank, format? , appliesAt? }
   *   key      the state key and the URL parameter name
   *   label    what the chip says before the value
   *   blank    the value meaning "not filtering" (default '' )
   *   format   value -> display string, for codes that need a name
   *   type     'text' | 'date' | 'enum' | 'number' — used when parsing URLs */

  function blankOf(def) {
    return Object.prototype.hasOwnProperty.call(def, 'blank') ? def.blank : '';
  }

  function isSet(state, def) {
    var v = state[def.key];
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v) !== String(blankOf(def));
  }

  /**
   * The active conditions, as removable chips. Order follows DEFS so the bar
   * does not reshuffle as filters come and go — a chip that moves when its
   * neighbour is removed is a chip you click by mistake.
   */
  function chips(state, defs) {
    var st = state || {};
    return (defs || []).filter(function (d) { return isSet(st, d); }).map(function (d) {
      var raw = st[d.key];
      var shown = d.format ? d.format(raw, st) : (Array.isArray(raw) ? raw.join(', ') : String(raw));
      return {
        key: d.key,
        label: d.label,
        value: raw,
        text: d.label + ': ' + shown,
        // A filter the current view cannot honour is shown struck through
        // rather than hidden, so a filter doing nothing still says so.
        inactive: typeof d.appliesAt === 'function' ? !d.appliesAt(st) : false
      };
    });
  }

  /** Clear one filter back to its blank value. */
  function clearField(state, defs, key) {
    var next = Object.assign({}, state);
    var def = (defs || []).filter(function (d) { return d.key === key; })[0];
    if (def) next[key] = blankOf(def);
    return next;
  }

  /** Clear every filter this page defines, leaving anything else untouched. */
  function resetAll(state, defs) {
    var next = Object.assign({}, state);
    (defs || []).forEach(function (d) { next[d.key] = blankOf(d); });
    return next;
  }

  function activeCount(state, defs) {
    return chips(state, defs).length;
  }

  /* ---------------------------------------------------------- deep links */

  /**
   * State -> URLSearchParams string, skipping blanks so a link carries only
   * what is actually filtering. `allow` optionally restricts which keys go,
   * which is how a source page sends only what the destination understands.
   */
  function toParams(state, defs, allow) {
    var st = state || {};
    var p = new URLSearchParams();
    (defs || []).forEach(function (d) {
      if (allow && allow.indexOf(d.key) === -1) return;
      if (!isSet(st, d)) return;
      var v = st[d.key];
      p.set(d.key, Array.isArray(v) ? v.join(',') : String(v));
    });
    return p.toString();
  }

  /**
   * URL -> state, taking ONLY keys this page defines. An unknown parameter is
   * returned in `unknown` rather than dropped silently, so the destination can
   * disclose that it ignored something.
   */
  function fromParams(search, defs) {
    var p = new URLSearchParams(search || '');
    var state = {};
    var known = {};
    (defs || []).forEach(function (d) {
      known[d.key] = true;
      if (!p.has(d.key)) return;
      var raw = p.get(d.key);
      if (d.type === 'number') {
        var n = Number(raw);
        if (isFinite(n)) state[d.key] = n;
      } else if (d.type === 'list') {
        state[d.key] = raw.split(',').filter(Boolean);
      } else if (d.type === 'enum' && Array.isArray(d.options) && d.options.indexOf(raw) === -1) {
        // An enum value this page does not offer is not applied. Substituting
        // the nearest option would be a quiet lie about what is on screen.
        return;
      } else {
        state[d.key] = raw;
      }
    });
    var unknown = [];
    p.forEach(function (v, k) { if (!known[k]) unknown.push({ key: k, value: v }); });
    return { state: state, unknown: unknown };
  }

  /**
   * What a destination could not honour, as a sentence for the UI.
   *
   * `requested` is everything the link carried; `applied` is what the page
   * actually took. Anything in the gap is named. This is the disclosure that
   * stops a filtered-looking page from showing unfiltered numbers.
   */
  function describeDropped(requested, applied, labels) {
    var dropped = [];
    Object.keys(requested || {}).forEach(function (k) {
      var want = requested[k];
      if (want === undefined || want === null || want === '') return;
      var got = (applied || {})[k];
      if (String(got) === String(want)) return;
      dropped.push({
        key: k,
        label: (labels && labels[k]) || k,
        value: want,
        // "not supported here" vs "supported but changed" are different
        // failures and read differently to someone chasing a number.
        reason: got === undefined || got === null || got === ''
          ? 'not available on this report'
          : 'changed to ' + got
      });
    });
    if (!dropped.length) return null;
    return {
      dropped: dropped,
      text: 'This link asked for ' +
        dropped.map(function (d) { return d.label + ' = ' + d.value + ' (' + d.reason + ')'; }).join('; ') +
        '. The figures below do not include that filter.'
    };
  }

  /**
   * Build a link to another report carrying only the keys it understands.
   * Returns the href AND what had to be left behind, so the caller can label
   * the link honestly instead of discovering the gap on arrival.
   */
  function linkTo(path, state, defs, supportedKeys) {
    var qs = toParams(state, defs, supportedKeys);
    var carried = {};
    (defs || []).forEach(function (d) {
      if (supportedKeys.indexOf(d.key) !== -1 && isSet(state || {}, d)) carried[d.key] = state[d.key];
    });
    var left = (defs || []).filter(function (d) {
      return supportedKeys.indexOf(d.key) === -1 && isSet(state || {}, d);
    }).map(function (d) { return { key: d.key, label: d.label, value: state[d.key] }; });
    return { href: qs ? path + '?' + qs : path, carried: carried, dropped: left };
  }

  var API = {
    chips: chips,
    clearField: clearField,
    resetAll: resetAll,
    activeCount: activeCount,
    isSet: isSet,
    toParams: toParams,
    fromParams: fromParams,
    describeDropped: describeDropped,
    linkTo: linkTo
  };

  if (typeof window !== 'undefined') window.SiloReportFilters = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
