/* The reported defect, exercised against the real v2/bi-daily-trend.html in a
 * browser: change the chart metric and watch the headline cards.
 *
 * The unit suite proves the arithmetic. It cannot prove the PAGE is wired to
 * it — and being wired to the wrong thing was the entire bug. So this suite
 * reads the actual rendered card text before and after switching the select.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

/* Two stores, two days. Net rises year over year; units FALL. If a card ever
 * borrows the other's comparison, the sign flips and no rounding hides it. */
const LOCATIONS = [
  { location_code: 'ONLINE', location_name: 'Online', store_type: 'ecom' },
  { location_code: 'HQ',     location_name: 'HQ',     store_type: 'retail' },
];

function salesRows() {
  const mk = (day, tag, net, qty, disc) => ({
    day_date: day, location_tag: tag,
    total_net_sales: net, total_quantity_sold: qty, total_discounts: disc,
  });
  return [
    // current period
    mk('2026-09-01', 'online', 600, 30, 6), mk('2026-09-01', 'hq', 400, 20, 4),
    mk('2026-09-02', 'online', 1200, 40, 12), mk('2026-09-02', 'hq', 800, 30, 8),
    // prior year, same calendar dates
    mk('2025-09-01', 'online', 500, 50, 3), mk('2025-09-01', 'hq', 300, 30, 2),
    mk('2025-09-02', 'online', 700, 35, 5), mk('2025-09-02', 'hq', 500, 25, 3),
  ];
}
// net:   3000 vs 2000  => +50.0%
// units:  120 vs 140   => -14.3%

const r = createReporter('daily-trend-metric');

const readCards = () => ({
  netLabel: document.getElementById('kpiPeriodNetLabel').textContent.trim(),
  net: document.getElementById('kpiPeriodNet').textContent.trim(),
  netVar: document.getElementById('kpiPeriodVar').textContent.trim(),
  units: document.getElementById('kpiPeriodQty').textContent.trim(),
  unitsVar: document.getElementById('kpiPeriodQtyVar').textContent.trim(),
  bestLabel: document.getElementById('kpiBestDayLabel').textContent.trim(),
  bestVal: document.getElementById('kpiBestDayVal').textContent.trim(),
});

(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/bi-daily-trend.html', {
      locations: LOCATIONS,
      sales_by_day_verification_v: salesRows(),
    }, {
      ready: () => {
        const n = document.getElementById('kpiPeriodNet');
        return n && n.textContent.trim() !== '—';
      },
    });

    // The page defaults its range to the last 90 days; drive it to the fixture.
    await page.evaluate(() => {
      document.getElementById('dateFrom').value = '2026-09-01';
      document.getElementById('dateTo').value = '2026-09-02';
      document.getElementById('btnRefresh').click();
    });
    await page.waitForTimeout(600);

    console.log('\n── with the chart on Net Sales (the default) ──');
    const atNet = await page.evaluate(readCards);
    r.ok('net card is currency', /^\$[\d,]+$/.test(atNet.net), JSON.stringify(atNet));
    r.ok('net card shows +50.0%', /\+50\.0%/.test(atNet.netVar), JSON.stringify(atNet));
    r.ok('units card is a plain count', /^[\d,]+$/.test(atNet.units), JSON.stringify(atNet));
    // THE fault that was invisible: the units card was wrong at the default too.
    r.ok('units card shows its OWN -14.3%, not the net card\'s +50.0%',
      /-14\.3%/.test(atNet.unitsVar), JSON.stringify(atNet));
    r.ok('the two cards do not read identically',
      atNet.netVar !== atNet.unitsVar, `both read "${atNet.netVar}"`);

    console.log('\n── switch the chart to Units ──');
    await page.selectOption('#metricMode', 'units');
    await page.waitForTimeout(300);
    const atUnits = await page.evaluate(readCards);

    r.ok('net card KEEPS currency formatting', /^\$[\d,]+$/.test(atUnits.net), JSON.stringify(atUnits));
    r.ok('net card value is unchanged', atUnits.net === atNet.net, `${atNet.net} -> ${atUnits.net}`);
    r.ok('net card variance is unchanged', atUnits.netVar === atNet.netVar, `${atNet.netVar} -> ${atUnits.netVar}`);
    r.ok('units card value is unchanged', atUnits.units === atNet.units, `${atNet.units} -> ${atUnits.units}`);
    r.ok('units card variance is unchanged', atUnits.unitsVar === atNet.unitsVar, `${atNet.unitsVar} -> ${atUnits.unitsVar}`);

    console.log('\n── switch the chart to Discounts ──');
    await page.selectOption('#metricMode', 'discounts');
    await page.waitForTimeout(300);
    const atDisc = await page.evaluate(readCards);
    r.ok('net card still unchanged', atDisc.net === atNet.net && atDisc.netVar === atNet.netVar, JSON.stringify(atDisc));
    r.ok('units card still unchanged', atDisc.units === atNet.units && atDisc.unitsVar === atNet.unitsVar, JSON.stringify(atDisc));

    console.log('\n── and back again ──');
    await page.selectOption('#metricMode', 'sales');
    await page.waitForTimeout(300);
    const back = await page.evaluate(readCards);
    r.ok('every headline value returns to exactly where it started',
      JSON.stringify({ n: back.net, nv: back.netVar, u: back.units, uv: back.unitsVar })
      === JSON.stringify({ n: atNet.net, nv: atNet.netVar, u: atNet.units, uv: atNet.unitsVar }),
      JSON.stringify(back));

    console.log('\n── best day DOES follow the chart, and names which metric ──');
    r.ok('names the metric at Net Sales', /Net sales/i.test(atNet.bestLabel), atNet.bestLabel);
    r.ok('names the metric at Units', /Units/i.test(atUnits.bestLabel), atUnits.bestLabel);
    r.ok('and its value reformats with the metric',
      atNet.bestVal.startsWith('$') && !atUnits.bestVal.startsWith('$'),
      `${atNet.bestVal} / ${atUnits.bestVal}`);

    console.log('\n── the comparison dates are disclosed ──');
    const notes = await page.evaluate(() => ({
      cmp: document.getElementById('comparisonNote').textContent.trim(),
      scope: document.getElementById('metricScopeNote').textContent.trim(),
    }));
    r.ok('the prior-year range is named on screen', /2025-09-01/.test(notes.cmp), notes.cmp);
    r.ok('the convention is named, not left implied', /calendar-date/.test(notes.cmp), notes.cmp);
    r.ok('the metric selector says what it governs', /headline/i.test(notes.scope), notes.scope);

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
