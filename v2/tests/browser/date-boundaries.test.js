/* Product Type Performance honoured the MONTHS of a custom range, not its days.
 *
 * Reported against a real range of 2026-08-09 -> 2026-09-07: the drill-through
 * opened 2026-08-01 -> 2026-09-30, and the category totals matched that wider
 * window. Three independent places rounded to month boundaries:
 *
 *   runLoad()      fetched from `months[0]-01`, so Aug 1-8 came back too
 *   recompute()    filtered rows by month MEMBERSHIP, so Aug 1-8 were counted
 *   currentRange() rebuilt the link range from the month list, widening BOTH
 *                  ends -- and past today, asking for days that do not exist
 *
 * The fixture makes the arithmetic checkable rather than approximate: every
 * day carries exactly $10 net for each product type, so a total IS a day
 * count. Aug 9-31 is 23 days ($230), Sep 1-7 is 7 days ($70), total $300.
 * The pre-fix page reported $380 -- a full 31-day August.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const TYPES = ['Youth Shorts', 'Tee'];
const SALES = [];
{
  const d = new Date(Date.UTC(2026, 5, 1));           // Jun 1
  const end = new Date(Date.UTC(2026, 8, 20));        // Sep 20
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    TYPES.forEach((t) => SALES.push({
      day_date: iso, location_tag: 'store-a', product_type: t,
      total_quantity_sold: 1, total_gross_sales: 11, total_discounts: 1,
      total_sales: 10, total_net_sales: 10,
    }));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
const LOCATIONS = [{ location_code: 'STORE-A', location_name: 'Store A', store_type: 'Retail' }];

const r = createReporter('date-boundaries');

const cellNumber = (s) => Number(String(s).replace(/[^0-9.-]/g, '')) || 0;

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 950 } });
  try {
    const page = await suite.open('/v2/bi-product-types.html', {
      sales_by_day_verification_v: SALES,
      locations: LOCATIONS,
    }, {
      ready: () => {
        const n = document.getElementById('statusText');
        return n && !/Loading/.test(n.textContent);
      },
    });
    await page.waitForTimeout(600);

    console.log('\n── a custom range is applied by DAY, not by month ──');
    await page.evaluate(() => document.querySelector('[data-months="custom"]').click());
    await page.waitForTimeout(250);
    await page.fill('#dateFrom', '2026-08-09');
    await page.fill('#dateTo', '2026-09-07');
    await page.evaluate(() => document.getElementById('dateTo').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(900);

    const view = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#matrixBody tr')]
        .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      return {
        status: document.getElementById('statusText').textContent,
        headers: [...document.querySelectorAll('#matrixHead th')].map((t) => t.textContent.trim()),
        youth: rows.find((x) => /Youth Shorts/.test(x[0] || '')),
        search: location.search,
        kpiSub: document.getElementById('kpiTotalSub').textContent.trim(),
      };
    });

    const aug = cellNumber(view.youth[1]);
    const sep = cellNumber(view.youth[2]);
    const tot = cellNumber(view.youth[3]);
    r.ok('August counts Aug 9-31 only (23 days = $230), not the whole month',
      aug === 230, `August cell = ${view.youth[1]} (pre-fix reported $310 for a full month)`);
    r.ok('September counts Sep 1-7 (7 days = $70)', sep === 70, `September cell = ${view.youth[2]}`);
    r.ok('the row total is the 30 days actually asked for', tot === 300, `total = ${view.youth[3]}`);
    r.ok('and the total is the sum of its columns', tot === aug + sep, `${aug} + ${sep} vs ${tot}`);

    console.log('\n── a month the range only partly covers says so ──');
    r.ok('August is marked PARTIAL even though it is a past month',
      /PARTIAL/.test(view.headers[1] || ''), JSON.stringify(view.headers));
    r.ok('September is marked PARTIAL too', /PARTIAL/.test(view.headers[2] || ''), JSON.stringify(view.headers));
    const why = await page.evaluate(() =>
      [...document.querySelectorAll('#matrixHead th')].map((t) => t.title || ''));
    r.ok('the August header explains WHICH days it covers',
      /Aug 9 onward/.test(why[1] || ''), JSON.stringify(why[1]));

    console.log('\n── the window is stated, not left to the column headings ──');
    r.ok('the status line names the exact days',
      /Aug 9 2026/.test(view.status) && /Sep 7 2026/.test(view.status), view.status);
    r.ok('the KPI subtitle names them too', /Aug 9/.test(view.kpiSub) && /Sep 7/.test(view.kpiSub), view.kpiSub);

    console.log('\n── the URL carries the exact range ──');
    r.ok('dateFrom is the day entered, not the month start',
      /dateFrom=2026-08-09/.test(view.search), view.search);
    r.ok('dateTo is the day entered, not the month end',
      /dateTo=2026-09-07/.test(view.search), view.search);

    console.log('\n── the CSV export carries the same window ──');
    const csv = await page.evaluate(() => {
      let captured = null;
      const realCreate = URL.createObjectURL;
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { captured = { name: this.download }; };
      URL.createObjectURL = function (blob) { captured = Object.assign(captured || {}, { blob: true }); return 'blob:x'; };
      document.getElementById('btnExport').click();
      HTMLAnchorElement.prototype.click = realClick;
      URL.createObjectURL = realCreate;
      return captured;
    });
    r.ok('the file name records the range it covers',
      csv && /2026-08-09_to_2026-09-07/.test(csv.name || ''), JSON.stringify(csv));

    console.log('\n── the drill-through opens on the SAME slice ──');
    await page.evaluate(() => document.querySelector('[data-drill-type="Youth Shorts"]').click());
    await page.waitForTimeout(1200);
    const dest = await page.evaluate(() => ({
      path: location.pathname, search: location.search,
      from: (document.getElementById('dateFrom') || {}).value,
      to: (document.getElementById('dateTo') || {}).value,
    }));
    r.ok('it lands on Product Search', /bi-product-search/.test(dest.path), dest.path);
    r.ok('carrying the start day, not the month start',
      dest.from === '2026-08-09', `destination opened on ${dest.from} (pre-fix: 2026-08-01)`);
    r.ok('and the end day, not the month end',
      dest.to === '2026-09-07', `destination opened through ${dest.to} (pre-fix: 2026-09-30)`);

    console.log('\n── a preset range does not ask for days that do not exist ──');
    await page.goto(page.url().split('?')[0].replace('bi-product-search', 'bi-product-types'));
    await page.waitForFunction(() => {
      const n = document.getElementById('statusText');
      return n && !/Loading/.test(n.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-months="3"]').click());
    await page.waitForTimeout(900);
    const preset = await page.evaluate(() => ({
      search: location.search,
      today: window.SiloDailyTrendKpis.pacificToday(),
    }));
    const to = (preset.search.match(/dateTo=([0-9-]+)/) || [])[1];
    r.ok('a 3-month preset ends today, never at a future month end',
      to === preset.today, `dateTo=${to}, Pacific today=${preset.today}`);

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
