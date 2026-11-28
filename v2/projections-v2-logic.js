/* Projections planning sheet — the arithmetic, with no DOM and no network.
 *
 * It lives in its own file so the two things that decide whether a filled
 * period is right can be tested without a browser:
 *   1. which historical day stands behind each planned day, and
 *   2. which cells a fill is allowed to write.
 *
 * Loaded as a plain <script> by testing/projections-v2.html, which reads
 * window.SiloProjPlan. The repo is an ES module package, so the test imports
 * this file for its side effect and reads the same global
 * (scripts/tests/projections-planning.test.mjs).
 */
(function (root, factory) {
  root.SiloProjPlan = factory();
})(globalThis, function () {
  'use strict';

  const DAY_MS = 86400000;
  const PAGE_ROWS = 1000;

  function isoDate(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(+d) ? null : d;
  }
  function addDays(iso, n) {
    const d = parseISO(iso);
    if (!d) return '';
    return isoDate(new Date(+d + n * DAY_MS));
  }
  function dayOfWeek(iso) {
    const d = parseISO(iso);
    return d ? d.getUTCDay() : -1;
  }
  /** Every date in [from, to], inclusive. Empty when the range is backwards. */
  function datesBetween(from, to) {
    const a = parseISO(from), b = parseISO(to);
    if (!a || !b || +a > +b) return [];
    const out = [];
    for (let t = +a; t <= +b; t += DAY_MS) out.push(isoDate(new Date(t)));
    return out;
  }
  /** The month a `YYYY-MM` string names, as a date range. */
  function monthRange(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!m) return null;
    const first = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
    const last = new Date(Date.UTC(+m[1], +m[2], 0));
    return { from: isoDate(first), to: isoDate(last) };
  }

  /* --- which historical day stands behind a planned day -------------------
   * Weekday-aligned is 364 days (52 weeks) back, so a Saturday is compared
   * with a Saturday: in retail the day of the week moves sales far more than
   * the date does, and a plain one-year shift lands Saturday on Friday. The
   * calendar option exists for the businesses where the date is the event
   * (the 1st, the 15th, a holiday that does not move).
   */
  function basisDate(iso, yearsBack, align) {
    if (!parseISO(iso)) return '';
    if (align === 'date') {
      const d = parseISO(iso);
      const y = d.getUTCFullYear() - yearsBack;
      const shifted = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      // 29 Feb in a non-leap year rolls into March; pull it back to the 28th
      // rather than quietly planning the wrong month.
      if (shifted.getUTCMonth() !== d.getUTCMonth()) return isoDate(new Date(Date.UTC(y, d.getUTCMonth() + 1, 0)));
      return isoDate(shifted);
    }
    return addDays(iso, -364 * yearsBack);
  }

  const actualKey = (locationId, date) => `${locationId}|${date}`;

  /** Build the lookup the fill reads: { 'locId|date': net sales }. */
  function indexActuals(rows) {
    const map = new Map();
    for (const r of rows || []) {
      const id = r.location_id ?? r.locationId;
      const date = String(r.day_date || r.date || '').slice(0, 10);
      if (id == null || !date) continue;
      const n = Number(r.net ?? r.total_net_sales ?? r.value);
      if (!Number.isFinite(n)) continue;
      map.set(actualKey(id, date), (map.get(actualKey(id, date)) || 0) + n);
    }
    return map;
  }

  /** The last `count` occurrences of `iso`'s weekday strictly before `before`. */
  function sameWeekdayBefore(iso, before, count) {
    const dow = dayOfWeek(iso);
    if (dow < 0) return [];
    let cursor = addDays(before, -1);
    while (cursor && dayOfWeek(cursor) !== dow) cursor = addDays(cursor, -1);
    const out = [];
    for (let i = 0; i < count && cursor; i++) {
      out.push(cursor);
      cursor = addDays(cursor, -7);
    }
    return out;
  }

  /* --- the fill ----------------------------------------------------------
   * Returns what WOULD be written. The page previews this, and only an
   * explicit Apply turns it into upserts, so a basis with no history behind it
   * shows as "0 days" instead of writing zeros over a plan.
   */
  function buildFill(opts) {
    const {
      dates = [], locationIds = [], actuals = new Map(), existing = new Map(),
      basis = 'ly', growthPct = 0, align = 'weekday', scope = 'empty',
      periodFrom = dates[0] || '', flatBase = null,
    } = opts || {};
    const factor = 1 + (Number(growthPct) || 0) / 100;
    const writes = [];
    let noHistory = 0, skippedFilled = 0;

    for (const locationId of locationIds) {
      // 'flat' spreads one number across the period, so its base is computed
      // once per location rather than per day.
      let flat = null;
      if (basis === 'flat') {
        if (flatBase != null && Number.isFinite(Number(flatBase))) {
          flat = Number(flatBase);
        } else {
          const lyDates = dates.map((d) => basisDate(d, 1, align));
          const vals = lyDates.map((d) => actuals.get(actualKey(locationId, d))).filter((v) => Number.isFinite(v));
          flat = vals.length ? vals.reduce((a, b) => a + b, 0) / dates.length : null;
        }
      }
      for (const date of dates) {
        const already = existing.get(actualKey(locationId, date));
        if (scope !== 'all' && already != null) { skippedFilled++; continue; }
        let base = null;
        if (basis === 'flat') {
          base = flat;
        } else if (basis === 'avg3') {
          const vals = [1, 2, 3]
            .map((y) => actuals.get(actualKey(locationId, basisDate(date, y, align))))
            .filter((v) => Number.isFinite(v));
          base = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        } else if (basis === 'trailing8') {
          const vals = sameWeekdayBefore(date, periodFrom || date, 8)
            .map((d) => actuals.get(actualKey(locationId, d)))
            .filter((v) => Number.isFinite(v));
          base = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        } else {
          const v = actuals.get(actualKey(locationId, basisDate(date, 1, align)));
          base = Number.isFinite(v) ? v : null;
        }
        if (base == null) { noHistory++; continue; }
        const value = Math.max(0, Math.round(base * factor));
        writes.push({ date, location_id: locationId, value, was: already == null ? null : already });
      }
    }
    return {
      writes,
      total: writes.reduce((a, w) => a + w.value, 0),
      noHistory,
      skippedFilled,
      overLimit: writes.length > PAGE_ROWS * 5,
    };
  }

  /* --- an AI draft is a proposal, never a write --------------------------
   * The model returns rows; this decides which of them the page is even
   * allowed to show. Anything outside the period, outside the locations the
   * person was planning, negative, or absurd is dropped with a reason, so a
   * bad draft is visibly short rather than silently wrong.
   */
  function validateDraftRows(rows, opts) {
    const { dates = [], locationIds = [], existing = new Map(), maxValue = 50000000, scope = 'empty' } = opts || {};
    const okDates = new Set(dates);
    const okLocs = new Set(locationIds.map(String));
    const accepted = [], rejected = [];
    const seen = new Set();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const date = String(raw?.projection_date || raw?.date || '').slice(0, 10);
      const locationId = raw?.location_id ?? raw?.locationId;
      const value = Number(raw?.projected_sales ?? raw?.value);
      const note = raw?.note == null ? '' : String(raw.note).slice(0, 280);
      const reason = !okDates.has(date) ? 'outside the period'
        : !okLocs.has(String(locationId)) ? 'not one of the locations being planned'
        : !Number.isFinite(value) || value < 0 ? 'not a positive number'
        : value > maxValue ? 'implausibly large'
        : seen.has(actualKey(locationId, date)) ? 'duplicate day'
        : (scope !== 'all' && existing.get(actualKey(locationId, date)) != null) ? 'day already has a plan'
        : null;
      if (reason) { rejected.push({ date, location_id: locationId, value, reason }); continue; }
      seen.add(actualKey(locationId, date));
      accepted.push({ date, location_id: locationId, value: Math.round(value), note, was: existing.get(actualKey(locationId, date)) ?? null });
    }
    return { accepted, rejected, total: accepted.reduce((a, r) => a + r.value, 0) };
  }

  /* Every day of history this period can possibly read: the same day one, two
   * and three years back under BOTH alignments, the eight preceding same
   * weekdays, and the period's own days. The page asks for exactly these days
   * instead of three whole years, because a three-year range over a company
   * with many locations is more rows than a paged read can return -- and
   * oldest-first truncation would drop the most recent weeks, which is exactly
   * what "trailing 8 weeks" is built on. */
  function historyDates(dates = [], periodFrom = '') {
    const want = new Set();
    const start = periodFrom || dates[0] || '';
    for (const d of dates) {
      if (!d) continue;
      want.add(d);
      for (const years of [1, 2, 3]) {
        for (const align of ['weekday', 'date']) {
          const b = basisDate(d, years, align);
          if (b) want.add(b);
        }
      }
      for (const b of sameWeekdayBefore(d, start || d, 8)) want.add(b);
    }
    return [...want].sort();
  }

  /* The same days as contiguous blocks, which is how the page asks for them:
   * four short ranges read on an index, instead of one three-year range (over
   * 19s on production, past the 8s timeout a browser query gets) or a list of
   * 187 separate dates. */
  function historyRanges(dates = [], periodFrom = '') {
    const days = historyDates(dates, periodFrom);
    const out = [];
    for (const d of days) {
      const last = out[out.length - 1];
      if (last && addDays(last.to, 1) === d) last.to = d;
      else out.push({ from: d, to: d });
    }
    return out;
  }

  function sumValues(map) {
    let t = 0;
    for (const v of map.values()) if (Number.isFinite(v)) t += v;
    return t;
  }

  return {
    DAY_MS, PAGE_ROWS,
    isoDate, parseISO, addDays, dayOfWeek, datesBetween, monthRange,
    basisDate, actualKey, indexActuals, sameWeekdayBefore,
    buildFill, validateDraftRows, sumValues, historyDates, historyRanges,
  };
});
