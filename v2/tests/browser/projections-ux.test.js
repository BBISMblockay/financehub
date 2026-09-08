/* Projections: the page draws 30 location columns whatever you filter to.
 *
 * `renderMatrix()` used `state.locations` unconditionally, so selecting one
 * location in the filter narrowed the ROWS but still drew all 30 columns —
 * 29 of them empty — and with 30 unconstrained <col>s every column collapsed
 * to roughly 30px. That is the "too many locations competing at once" problem
 * and it is what these assertions pin down.
 *
 * Also covered: the scope-before-summary ordering, chips that clear one
 * condition at a time, and that switching daily/monthly does not silently
 * change which locations you are looking at.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const LOCATIONS = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  location_code: 'L' + String(i + 1).padStart(2, '0'),
  location_name: 'Location ' + (i + 1),
  domain: 'retail',
  store_type: 'Retail',
  is_active: true,
}));

/* Projections exist for the first three locations only, across three days —
 * so "only with data" has something real to narrow to. */
const PROJECTIONS = [];
let pid = 1;
['2026-09-10', '2026-09-11', '2026-09-12'].forEach((d) => {
  [1, 2, 3].forEach((locId) => {
    PROJECTIONS.push({
      id: pid++, projection_date: d, location_id: locId,
      projected_units: 100 * locId, projected_sales: 1000 * locId,
      notes: '', source: 'manual', scenario: 'active',
      created_at: d, updated_at: d, created_by: null, updated_by: null,
      locations: LOCATIONS[locId - 1],
    });
  });
});

const r = createReporter('projections-ux');

const countCols = () => document.querySelectorAll('#matrix-head th').length;
const chipTexts = () => [...document.querySelectorAll('#filter-chips .pj-chip span:first-child')]
  .map((n) => n.textContent.trim());

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 940 } });
  try {
    const page = await suite.open('/v2/projections.html', {
      locations: LOCATIONS,
      revenue_projections: PROJECTIONS,
      launch_calendar: [],
      revenue_projection_history: [],
    }, {
      ready: () => {
        const b = document.getElementById('matrix-body');
        return b && !/Loading/.test(b.textContent);
      },
    });
    await page.waitForTimeout(500);

    console.log('\n── scope comes before the summary it describes ──');
    const order = await page.evaluate(() => {
      const main = document.querySelector('.silo-main');
      const idx = (sel) => [...main.children].findIndex((c) => c.matches(sel) || c.querySelector(sel));
      return { filters: idx('#filter-from'), kpis: idx('[data-kpi="grand"]'), matrix: idx('#matrix-table') };
    });
    r.ok('date/scope controls precede the KPI summary', order.filters < order.kpis, JSON.stringify(order));
    r.ok('the summary precedes the detail matrix', order.kpis < order.matrix, JSON.stringify(order));

    console.log('\n── identity columns stay pinned while the rest scrolls ──');
    const sticky = await page.evaluate(() => {
      const th = [...document.querySelectorAll('#matrix-head th')].slice(0, 2);
      return th.map((t) => getComputedStyle(t).position);
    });
    r.ok('DATE and LAUNCH headers are sticky', sticky.every((p) => p === 'sticky'), JSON.stringify(sticky));

    const widths = await page.evaluate(() =>
      [...document.querySelectorAll('#matrix-head th')].slice(2, -1).map((t) => Math.round(t.getBoundingClientRect().width)));
    r.ok('location columns keep a readable width (>= 60px)',
      widths.length > 0 && Math.min(...widths) >= 60, `min ${Math.min(...widths)}px across ${widths.length} cols`);

    console.log('\n── selecting one location draws ONE column, not 30 ──');
    const allCols = await page.evaluate(countCols);
    r.ok('all-locations view draws every location', allCols === 30 + 3, `${allCols} header cells`);

    await page.selectOption('#filter-location', '2');
    await page.waitForTimeout(300);
    const oneCol = await page.evaluate(countCols);
    // DATE + LAUNCH + the one location + TOTAL
    r.ok('one location selected => one location column', oneCol === 4, `${oneCol} header cells`);

    console.log('\n── the chip says what is filtering, and clears just that ──');
    let chips = await page.evaluate(chipTexts);
    r.ok('a location chip appears', chips.some((c) => /Location/.test(c)), JSON.stringify(chips));
    r.ok('the chip names the location code, not its id',
      chips.some((c) => /L02/.test(c)), JSON.stringify(chips));

    await page.evaluate(() => document.querySelector('#filter-chips [data-chip-clear="locationId"]').click());
    await page.waitForTimeout(300);
    r.ok('clearing the chip restores every column', await page.evaluate(countCols) === 33, 'columns after clear');
    r.ok('and the select is back to ALL',
      await page.evaluate(() => document.getElementById('filter-location').value) === '');

    console.log('\n── narrowing the visible columns ──');
    await page.evaluate(() => document.getElementById('more-filters').open = true);
    await page.evaluate(() => document.querySelector('[data-loc-pick="filled"]').click());
    await page.waitForTimeout(300);
    const filledCols = await page.evaluate(countCols);
    r.ok('"only with data" narrows to the three locations that have any',
      filledCols === 3 + 3, `${filledCols} header cells`);
    r.ok('the count line says what is shown',
      /Showing 3 of 30/.test(await page.evaluate(() => document.getElementById('loc-picker-count').textContent)),
      await page.evaluate(() => document.getElementById('loc-picker-count').textContent));

    console.log('\n── daily/monthly keeps the same locations in view ──');
    await page.evaluate(() => document.querySelector('[data-view="monthly"]').click());
    await page.waitForTimeout(300);
    const monthlyCols = await page.evaluate(countCols);
    // MONTH + 3 locations + TOTAL
    r.ok('monthly shows the same narrowed set', monthlyCols === 3 + 2, `${monthlyCols} header cells`);
    r.ok('monthly pins its identity column too',
      await page.evaluate(() => getComputedStyle(document.querySelector('#matrix-head th')).position) === 'sticky');
    await page.evaluate(() => document.querySelector('[data-view="daily"]').click());
    await page.waitForTimeout(300);
    r.ok('back to daily, still narrowed', await page.evaluate(countCols) === 6);

    console.log('\n── reset all ──');
    await page.evaluate(() => { document.getElementById('filter-search').value = 'zzz'; });
    await page.evaluate(() => document.getElementById('filter-search').dispatchEvent(new Event('input', { bubbles: true })));
    await page.waitForTimeout(400);
    r.ok('a search chip appears', (await page.evaluate(chipTexts)).some((c) => /Search/.test(c)));
    await page.evaluate(() => document.getElementById('btn-reset-filters').click());
    await page.waitForTimeout(300);
    r.ok('reset clears every chip', (await page.evaluate(chipTexts)).length === 0);
    r.ok('reset empties the search box',
      await page.evaluate(() => document.getElementById('filter-search').value) === '');

    console.log('\n── cell states are distinguishable ──');
    // Widen back to every location so there ARE empty cells to distinguish;
    // the "only with data" set is by definition all filled.
    await page.evaluate(() => document.querySelector('[data-loc-pick="all"]').click());
    await page.waitForTimeout(300);
    const states = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#matrix-body .td-cell')];
      return {
        editable: cells.filter((c) => c.dataset.editable === '1').length,
        empty: cells.filter((c) => c.classList.contains('td-cell--empty')).length,
        titled: cells.filter((c) => (c.title || '').length > 0).length,
      };
    });
    r.ok('filled cells are marked editable', states.editable > 0, JSON.stringify(states));
    r.ok('empty cells are distinguished', states.empty > 0, JSON.stringify(states));
    r.ok('every cell explains its state on hover', states.titled === states.editable + states.empty, JSON.stringify(states));
    r.ok('a legend names the states',
      await page.evaluate(() => !!document.querySelector('.pj-legend')));
    r.ok('and discloses that actuals are not overlaid here',
      /Actual sales are not overlaid/.test(await page.evaluate(() => document.querySelector('.pj-legend').textContent)));

    console.log('\n── narrow screen ──');
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => ({
      bodyScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      matrixScrolls: !!document.querySelector('.bcn-matrix-scroll'),
    }));
    r.ok('the page body does not scroll horizontally', !narrow.bodyScroll, JSON.stringify(narrow));
    r.ok('the wide table scrolls inside its own container', narrow.matrixScrolls);

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
