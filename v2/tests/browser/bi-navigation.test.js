/* Connected sales navigation: trend -> category -> product -> records.
 *
 * The thing worth testing is not that a link opens. It is that the
 * destination either HONOURS what the link carried or SAYS it could not — a
 * link that carries a filter to a page with no such control must never show
 * unfiltered numbers under a heading that implies otherwise.
 *
 * Also covered here because they are the same class of claim: a month still
 * filling up must not look comparable to a complete one, and changing the
 * grouping on Product Search must not change the reconciled totals.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const LOCATIONS = [
  { location_code: 'ONLINE', location_name: 'Online', store_type: 'ecom' },
  { location_code: 'HQ', location_name: 'HQ', store_type: 'retail' },
];

/* The same SKU sold under TWO historical product names — the case the task
 * warns must not be treated as duplicate records. */
function salesRows() {
  const mk = (day, tag, type, sku, name, qty, gross, disc, ref, net, total) => ({
    day_date: day, location_tag: tag, product_type: type, sku, product_name: name,
    total_quantity_sold: qty, total_gross_sales: gross, total_discounts: disc,
    total_refunds: ref, total_net_sales: net, total_sales: total, total_orders: 1,
  });
  return [
    mk('2026-07-05', 'online', 'Tee', 'SKU-1', 'Classic Tee', 10, 300, 20, 0, 280, 280),
    mk('2026-07-06', 'hq', 'Tee', 'SKU-1', 'Classic Tee (2026)', 5, 150, 10, 0, 140, 140),
    mk('2026-08-05', 'online', 'Tee', 'SKU-1', 'Classic Tee', 8, 240, 0, 0, 240, 240),
    mk('2026-08-06', 'online', 'Shorts', 'SKU-2', 'Mesh Shorts', 4, 200, 0, 0, 200, 200),
    mk('2026-09-02', 'online', 'Tee', 'SKU-1', 'Classic Tee', 3, 90, 0, 0, 90, 90),
  ];
}

const r = createReporter('bi-navigation');

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 950 } });
  const tables = { locations: LOCATIONS, sales_by_day_verification_v: salesRows() };

  /* product-search reads product_search_rollup(), a server-side rollup with
     the date/name/SKU filters pushed down. Modelled here so the page's own
     client-side filtering runs on the same shape it does in production.

     This function is stringified and re-evaluated INSIDE the page, so it must
     be self-contained -- it reads the seeded table rather than closing over
     anything in this file. */
  const rpcFixture = function (args) {
    var a = args || {};
    var src = (window.__FIXTURE_TABLES__ || {}).sales_by_day_verification_v || [];
    return src.filter(function (row) {
      if (a.p_date_from && row.day_date < a.p_date_from) return false;
      if (a.p_date_to && row.day_date > a.p_date_to) return false;
      if (a.p_name_term && String(row.product_name).toLowerCase().indexOf(String(a.p_name_term).toLowerCase()) === -1) return false;
      if (a.p_sku_term && String(row.sku).toLowerCase().indexOf(String(a.p_sku_term).toLowerCase()) === -1) return false;
      return true;
    }).map(function (row) {
      var out = {};
      Object.keys(row).forEach(function (k) { out[k] = row[k]; });
      out.location_name = row.location_tag === 'online' ? 'Online' : 'HQ';
      out.month = a.p_group_month ? String(row.day_date).slice(0, 7) : null;
      return out;
    });
  };

  try {
    /* ---------------------------------------------------- product types --- */
    console.log('\n── Product Types: partial months are marked ──');
    let page = await suite.open('/v2/bi-product-types.html', tables, {
      rpc: { product_search_rollup: rpcFixture },
      ready: () => {
        const b = document.getElementById('matrixBody');
        return b && !/Loading/.test(b.textContent);
      },
    });
    await page.waitForTimeout(600);

    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('#matrixHead th')].map((t) => ({
        text: t.textContent.trim(), partial: t.classList.contains('pt-month-partial'),
      })));
    r.ok('the matrix rendered months', heads.length > 2, JSON.stringify(heads.map((h) => h.text)));
    const partials = heads.filter((h) => h.partial);
    r.ok('the current month is marked partial', partials.length === 1, JSON.stringify(heads));
    r.ok('and it says so in the header', /PARTIAL/.test(partials[0] ? partials[0].text : ''), JSON.stringify(partials));
    r.ok('complete months are not marked',
      heads.filter((h) => /2[0-9]/.test(h.text) && !h.partial).length >= 1, JSON.stringify(heads.map((h) => h.text)));

    console.log('\n── Net Sales is offered, from the existing column ──');
    const metrics = await page.evaluate(() =>
      [...document.querySelectorAll('#metricMode option')].map((o) => o.value));
    r.ok('net is a metric option', metrics.includes('net'), JSON.stringify(metrics));
    r.ok('the previous options survive',
      ['total', 'gross', 'discounts', 'units'].every((m) => metrics.includes(m)), JSON.stringify(metrics));

    console.log('\n── a category row drills into Product Search ──');
    const drill = await page.evaluate(() => {
      const btn = document.querySelector('#matrixBody [data-drill-type]');
      return btn ? btn.dataset.drillType : null;
    });
    r.ok('category rows are clickable', !!drill, String(drill));

    await page.evaluate(() => document.querySelector('#matrixBody [data-drill-type]').click());
    await page.waitForTimeout(900);

    const url = new URL(page.url());
    r.ok('it lands on Product Search', /bi-product-search/.test(url.pathname), url.pathname);
    r.ok('carrying the category', !!url.searchParams.get('productType'), url.search);
    r.ok('carrying the date range',
      !!url.searchParams.get('dateFrom') && !!url.searchParams.get('dateTo'), url.search);

    console.log('\n── and Product Search opens on it ──');
    await page.waitForFunction(() => {
      const b = document.getElementById('tblBody');
      return b && !/Loading/.test(b.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(500);

    const applied = await page.evaluate(() => ({
      type: document.getElementById('typeSelect').value,
      from: document.getElementById('dateFrom').value,
      to: document.getElementById('dateTo').value,
      chips: [...document.querySelectorAll('#filterChips .ps-chip-active')].map((c) => c.textContent.trim()),
    }));
    r.ok('the category filter is applied, not just passed',
      applied.type === url.searchParams.get('productType'), JSON.stringify(applied));
    r.ok('the dates are applied', applied.from === url.searchParams.get('dateFrom'), JSON.stringify(applied));
    r.ok('and the active filters are visible as chips',
      applied.chips.some((c) => /Type/.test(c)), JSON.stringify(applied.chips));

    console.log('\n── a filter the destination cannot represent is DISCLOSED ──');
    await page.goto(suite.base + '/v2/bi-product-search.html?productType=Tee&metric=units&preset=blank_sku',
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.getElementById('tblBody');
      return b && !/Loading/.test(b.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(500);

    const note = await page.evaluate(() => {
      const n = document.getElementById('linkNote');
      return { hidden: n.hidden, text: n.textContent.trim() };
    });
    r.ok('the note is shown', note.hidden === false, JSON.stringify(note));
    r.ok('it names the metric it could not apply', /metric/i.test(note.text), note.text);
    r.ok('it names the exception filter it could not apply', /exception/i.test(note.text), note.text);
    r.ok('it says plainly they are not applied', /not applied/i.test(note.text), note.text);
    r.ok('the filter it CAN honour is still applied',
      await page.evaluate(() => document.getElementById('typeSelect').value) === 'Tee');

    /* ------------------------------------------------- grouping/totals --- */
    console.log('\n── grouping changes the grain, never the totals ──');
    await page.goto(suite.base + '/v2/bi-product-search.html?dateFrom=2026-07-01&dateTo=2026-09-30',
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.getElementById('tblBody');
      return b && !/Loading/.test(b.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(600);

    const readTotals = () => page.evaluate(() => ({
      rows: document.getElementById('rowCount').textContent.trim(),
      total: document.getElementById('kpiTotal').textContent.trim(),
      units: document.getElementById('kpiUnits').textContent.trim(),
      skus: document.getElementById('kpiSkus').textContent.trim(),
    }));

    const byName = await readTotals();
    r.ok('the default grain lists both historical names of SKU-1',
      /^2 rows|^3 rows/.test(byName.rows), JSON.stringify(byName));

    await page.evaluate(() => {
      const t = document.getElementById('toggleSkuRollup');
      t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const bySku = await readTotals();

    r.ok('consolidating by SKU reduces the row count',
      parseInt(bySku.rows, 10) < parseInt(byName.rows, 10), `${byName.rows} -> ${bySku.rows}`);
    r.ok('total sales are IDENTICAL across groupings',
      bySku.total === byName.total, `${byName.total} -> ${bySku.total}`);
    r.ok('units are identical too', bySku.units === byName.units, `${byName.units} -> ${bySku.units}`);
    r.ok('distinct SKUs are unchanged', bySku.skus === byName.skus, `${byName.skus} -> ${bySku.skus}`);

    const namesCol = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#tblHead th')].map((t) => t.textContent.trim());
      const cell = document.querySelector('#tblBody .ps-names-cell');
      return { heads, cell: cell ? cell.textContent.trim() : null, title: cell ? cell.title : null };
    });
    r.ok('a Names column appears in rollup mode',
      namesCol.heads.some((h) => /Names/.test(h)), JSON.stringify(namesCol.heads));
    r.ok('it reports how many names the SKU has sold under',
      /name/.test(namesCol.cell || ''), String(namesCol.cell));
    r.ok('and the names themselves stay reachable',
      (namesCol.title || '').length > 0, String(namesCol.title));

    console.log('\n── the grain is stated, not implied ──');
    const grain = await page.evaluate(() => document.getElementById('grainNote').textContent.trim());
    r.ok('the note says one row per SKU while consolidated', /One row per SKU/i.test(grain), grain);
    r.ok('and that totals do not move', /Totals are unchanged/i.test(grain), grain);

    await page.evaluate(() => {
      const t = document.getElementById('toggleStore');
      t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const grainStore = await page.evaluate(() => document.getElementById('grainNote').textContent.trim());
    r.ok('adding Store says the grain changed, not that a column appeared',
      /One row per SKU × store/i.test(grainStore), grainStore);
    const withStore = await readTotals();
    r.ok('splitting by store still does not move the totals',
      withStore.total === byName.total, `${byName.total} -> ${withStore.total}`);

    /* -------------------------------------------------- url round trip --- */
    console.log('\n── direct link, refresh and back ──');
    await page.goto(suite.base + '/v2/bi-product-search.html?productType=Shorts&dateFrom=2026-08-01&dateTo=2026-08-31',
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.getElementById('tblBody');
      return b && !/Loading/.test(b.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(500);
    r.ok('a direct link applies its filters',
      await page.evaluate(() => document.getElementById('typeSelect').value) === 'Shorts');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.getElementById('tblBody');
      return b && !/Loading/.test(b.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(500);
    const afterReload = await page.evaluate(() => ({
      type: document.getElementById('typeSelect').value,
      from: document.getElementById('dateFrom').value,
    }));
    r.ok('a refresh reproduces the same view', afterReload.type === 'Shorts', JSON.stringify(afterReload));
    r.ok('including the dates', afterReload.from === '2026-08-01', JSON.stringify(afterReload));

    const urlNow = new URL(page.url());
    r.ok('the URL still describes what is on screen',
      urlNow.searchParams.get('productType') === 'Shorts', urlNow.search);

    /* ------------------------------------------- sales report exceptions -- */
    console.log('\n── Sales Report: an active exception filter is unmistakable ──');
    await page.goto(suite.base + '/v2/sales-verification.html?preset=blank_sku', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const n = document.getElementById('statusText');
      return n && !/Loading/.test(n.textContent);
    }, { timeout: 25000 });
    await page.waitForTimeout(600);

    const sv = await page.evaluate(() => ({
      activeQuick: (document.querySelector('[data-quick].active') || {}).dataset,
      chips: [...document.querySelectorAll('#filterChips .sv-chip-active')].map((c) => ({
        text: c.textContent.trim(), exception: c.classList.contains('is-exception'),
      })),
    }));
    r.ok('the exception filter from the link is applied',
      sv.activeQuick && sv.activeQuick.quick === 'blank_sku', JSON.stringify(sv.activeQuick));
    r.ok('and it shows as a chip', sv.chips.some((c) => /Exception/.test(c.text)), JSON.stringify(sv.chips));
    r.ok('styled apart, because every figure below is a subset',
      sv.chips.some((c) => c.exception), JSON.stringify(sv.chips));

    r.ok('the four exception filters are all still present',
      await page.evaluate(() => [...document.querySelectorAll('[data-quick]')].map((b) => b.dataset.quick).join(','))
      === 'all,refund_discrepancy,blank_sku,negative_net');

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
