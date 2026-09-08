/* Headline KPI + day-completeness semantics for /v2/bi-daily-trend.html.
 *
 * WHY THIS IS ITS OWN FILE. The page has a chart metric selector (Net sales /
 * Units / Discounts) and two headline cards that are NOT the chart. Those are
 * different things, and the page had merged them: one `metricKey()` drove the
 * chart, the table, the CSV *and* both headline cards, so changing what the
 * chart plotted silently rewrote the cards above it.
 *
 * THE THREE DEFECTS, all in one function:
 *
 *   1. `fmtVal()` switches to a plain number when the chart metric is units.
 *      It was applied to the Net Sales card, so charting Units stripped the
 *      currency formatting off a dollar figure -- $412,183 became 412,183.
 *   2. One `varPct` was computed from the CHART metric (k.cur vs k.py) and
 *      written to the Net Sales card. Charting Units put the units growth
 *      rate under a dollar value.
 *   3. The Units card did not compute anything at all:
 *          el.kpiPeriodQtyVar.textContent = el.kpiPeriodVar.textContent;
 *      It copied the Net card's string verbatim, so it never once displayed
 *      the units year-over-year figure it claimed to.
 *
 * The rule this file exists to hold: a headline card owns its metric, its
 * formatter and its own prior-year comparison. The chart selector changes the
 * chart. Nothing above it moves.
 *
 * WHAT LEGITIMATELY FOLLOWS THE CHART: "Best Day" is best-by-the-charted-
 * metric, which is a reasonable reading and is kept -- but it is labelled with
 * the metric now, because "Best Day" alone did not say which.
 */
(function () {
  'use strict';

  /* --------------------------------------------------------------- formats */

  var money = function (v) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(Number(v || 0));
  };
  var numFmt = function (v) { return Number(v || 0).toLocaleString('en-US'); };

  /* Each card names its own field, its own prior-year field and its own
   * formatter. Adding a card means stating all three, which is exactly the
   * coupling that went missing. */
  var CARDS = [
    { key: 'net',   label: 'Period Net Sales', field: 'net', pyField: 'pyNet', format: money,
      hint: 'Net sales over the selected range. Independent of the chart metric.' },
    { key: 'units', label: 'Period Units',     field: 'qty', pyField: 'pyQty', format: numFmt,
      hint: 'Units sold over the selected range. Independent of the chart metric.' }
  ];

  function sum(days, field) {
    var t = 0;
    for (var i = 0; i < days.length; i++) t += Number(days[i][field] || 0);
    return t;
  }

  /**
   * Percentage change, or null when there is no prior-year base to divide by.
   * null is never rendered as 0% -- "no comparison" and "flat" are different.
   */
  function variance(cur, py) {
    if (!py) return null;
    return ((cur - py) / Math.abs(py)) * 100;
  }

  function varianceText(pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return 'vs LY —';
    return 'vs LY ' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
  }

  /**
   * The headline cards. Takes ONLY the day rows -- deliberately not the chart
   * metric, so it is not possible to make a card depend on it again without
   * changing this signature.
   */
  function headlineCards(days) {
    var rows = days || [];
    return CARDS.map(function (c) {
      var cur = sum(rows, c.field);
      var py = sum(rows, c.pyField);
      var pct = rows.length ? variance(cur, py) : null;
      return {
        key: c.key,
        label: c.label,
        hint: c.hint,
        value: cur,
        priorValue: py,
        text: rows.length ? c.format(cur) : '—',
        variance: pct,
        varianceText: rows.length ? varianceText(pct) : 'vs LY —',
        direction: pct === null ? 'flat' : (pct >= 0 ? 'pos' : 'neg')
      };
    });
  }

  /* Best day DOES follow the chart metric -- that is the useful reading -- but
   * it returns the metric label so the card can say which metric it means. */
  var METRICS = {
    net:       { field: 'net',       pyField: 'pyNet',       label: 'Net sales', format: money },
    units:     { field: 'qty',       pyField: 'pyQty',       label: 'Units',     format: numFmt },
    discounts: { field: 'discounts', pyField: 'pyDiscounts', label: 'Discounts', format: money }
  };

  function metric(name) { return METRICS[name] || METRICS.net; }

  function bestDay(days, metricName) {
    var rows = days || [];
    if (!rows.length) return null;
    var m = metric(metricName);
    var best = rows[0];
    for (var i = 1; i < rows.length; i++) {
      if (Number(rows[i][m.field] || 0) > Number(best[m.field] || 0)) best = rows[i];
    }
    return { day: best.day, value: Number(best[m.field] || 0), text: m.format(best[m.field]), metricLabel: m.label };
  }

  /* ------------------------------------------------- day completeness ----- */

  /**
   * Today in Pacific. The business runs on Pacific and the sales feed is only
   * complete through Pacific YESTERDAY (the nightly Shopify sync at 08:30 UTC
   * covers up to the previous Pacific day). `new Date()` on a UTC host is a
   * day ahead from 17:00 Pacific onward, which is exactly when someone is
   * still looking at the report.
   */
  function pacificToday(now) {
    var d = now || new Date();
    // en-CA gives YYYY-MM-DD directly.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  }

  /**
   * Is this day still filling up? Sales are complete only through Pacific
   * yesterday, so Pacific today and anything after it is partial -- and a
   * partial day is NOT comparable to a complete one, which is the whole
   * reason to mark it.
   */
  function isIncompleteDay(day, now) {
    if (!day) return false;
    return String(day) >= pacificToday(now);
  }

  /** Which of these rows are incomplete, and a sentence saying so. */
  function completenessNote(days, now) {
    var rows = (days || []).filter(function (d) { return isIncompleteDay(d.day, now); });
    if (!rows.length) return null;
    return {
      days: rows.map(function (d) { return d.day; }),
      text: rows.length === 1
        ? rows[0].day + ' is still in progress — sales are complete only through ' +
          'the previous Pacific day, so it is not comparable to the days before it.'
        : rows.length + ' days in this range are still in progress — sales are complete ' +
          'only through the previous Pacific day, so they are not comparable to complete days.'
    };
  }

  /* ------------------------------------------------ prior-year alignment -- */

  function isoDateOnly(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /**
   * The page's existing convention, unchanged: the prior-year range starts on
   * the SAME CALENDAR DATE one year earlier, and days are then paired by
   * position within the range.
   *
   * This is NOT a 364-day (weekday-aligned) shift, and this file does not
   * switch to one -- that would silently change every comparison on the page.
   * It is stated here so the trade-off is visible rather than folded into a
   * date helper: a calendar-date anchor keeps holidays and month boundaries
   * lined up, and lets weekdays drift by one or two days.
   */
  function addYears(iso, n) {
    var d = new Date(iso + 'T00:00:00');
    var wasFeb29 = d.getMonth() === 1 && d.getDate() === 29;
    d.setFullYear(d.getFullYear() + n);
    // setFullYear overflows Feb 29 into Mar 1 in a non-leap year -- clamp back
    // to Feb 28 so the offset never drifts by a day.
    if (wasFeb29 && d.getMonth() === 2) d.setDate(0);
    return isoDateOnly(d);
  }

  function priorYearRange(dateFrom, dateTo) {
    return { from: addYears(dateFrom, -1), to: addYears(dateTo, -1) };
  }

  /** A sentence naming the actual comparison dates, for the UI to show. */
  function comparisonNote(dateFrom, dateTo) {
    var py = priorYearRange(dateFrom, dateTo);
    return {
      from: py.from,
      to: py.to,
      text: 'Compared against ' + py.from + ' → ' + py.to +
            ' — the same calendar dates one year earlier, paired day by day. ' +
            'Weekdays therefore shift by a day or two; this is a calendar-date ' +
            'comparison, not a 364-day weekday-aligned one.'
    };
  }

  var API = {
    CARDS: CARDS,
    METRICS: METRICS,
    metric: metric,
    sum: sum,
    variance: variance,
    varianceText: varianceText,
    headlineCards: headlineCards,
    bestDay: bestDay,
    pacificToday: pacificToday,
    isIncompleteDay: isIncompleteDay,
    completenessNote: completenessNote,
    addYears: addYears,
    priorYearRange: priorYearRange,
    comparisonNote: comparisonNote,
    money: money,
    numFmt: numFmt
  };

  if (typeof window !== 'undefined') window.SiloDailyTrendKpis = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
