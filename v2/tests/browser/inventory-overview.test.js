/* Real page, real model, real chrome; synthetic read-only Supabase only.
 *
 * What this holds down:
 *   - the suite strip opens on Overview and still reaches every tab
 *   - the KPI band's figures are the model's, and negative stock is reported
 *     apart from the inventory value rather than netted into it
 *   - the filters re-query (they do not filter a stale client-side copy) and
 *     the location filter removes the Arriving card instead of showing a
 *     company-wide number under one store's heading
 *   - the deep links a tile emits land on the Inventory Manager's own lenses
 *   - the page only ever reads
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startSuite } = require('../lib/harness');
const { fixtures, rpc, companyId } = require('../fixtures/inventory-overview');

const ready = () => document.getElementById('asOf')
  && !/Loading/.test(document.getElementById('asOf').textContent);

(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/inventory-overview.html', fixtures(), {
      rpc, ready, cachedCompany: null, serverCompany: { id: companyId, title: 'Example Company' },
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const text = (sel) => page.locator(sel).innerText();

    /* ---- KPI band ---- */
    // 90,000 + 30,000 + 4,500 + 12,000 = 136,500. The -2,000 of negative
    // stock is NOT in it; it is reported on its own below.
    assert.equal(await text('#kpiValue'), '$136,500');
    assert.equal(await text('#kpiUnits'), '1,365');
    assert.match(await text('#kpiUnitsSub'), /across 2 locations/);
    assert.equal(await text('#kpiSkus'), '25', 'deep + ok + low SKUs');
    assert.match(await text('#kpiSkusSub'), /of 68 SKUs/);
    assert.equal(await text('#kpiOut'), '41');
    assert.match(await text('#kpiOutSub'), /2 negative on hand/);
    assert.equal(await text('#kpiInbound'), '3,540');
    assert.match(await text('#kpiInboundSub'), /1,000 late/);

    /* ---- Stock status ---- */
    // Only the bands that hold value are drawn; out and negative are counts
    // in the key, because a width for them would misstate the total.
    assert.equal(await page.locator('#stackStatus > *').count(), 3);
    const key = await text('#keyStatus');
    assert.match(key, /Out of stock\s*41\s*SKUs/);
    assert.match(key, /Negative on hand\s*2\s*SKUs\s*-\$2,000/);
    assert.equal(await page.locator('#keyStatus a[href="/v2/inventory.html?lens=oos"]').count(), 1);
    assert.equal(await page.locator('#keyStatus a[href="/v2/inventory.html?lens=negative"]').count(), 1);

    /* ---- Cards ---- */
    assert.equal(await page.locator('#tiles .inv-ov-tile').count(), 2);
    assert.match(await text('#tiles'), /Sample Tee/);
    assert.equal(await page.locator('#donutLegend > *').count(), 3, 'three types, no Other');
    assert.match(await text('#donutValue'), /\$137k/);
    assert.equal(await page.locator('#bars > *').count(), 2);
    assert.match(await text('#strip'), /NO SALE IN 90 DAYS/i);
    assert.match(await text('#strip'), /\$4,500/, 'the stale figure is the sum the database returned');
    assert.match(await text('#strip'), /6 SKUs/, 'held in 2+ locations');
    assert.match(await text('#asOf'), /Stock as of/);

    /* ---- Arriving: overdue is one bar, undated is its own ---- */
    const cols = await page.locator('#cols .inv-ov-col').allInnerTexts();
    assert.equal(cols.length, 4, 'Late, this month, next month, no date');
    assert.ok(cols[0].includes('Late'), cols.join('|'));
    assert.equal(await page.locator('#cols .is-late').count(), 1);
    assert.ok(cols[cols.length - 1].includes('No date'));

    /* ---- The suite strip ---- */
    const nav = page.locator('.suite-nav');
    assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'),
      '/v2/inventory-overview.html');
    for (const href of ['/v2/inventory.html', '/v2/products.html', '/v3/product-workflow.html']) {
      assert.equal(await nav.locator(`a[href="${href}"]`).count(), 1, href);
    }

    /* ---- Filters re-query, and inbound is dropped under a location ---- */
    const before = await page.evaluate(() => (window.__SQL__ || []).length);
    await page.selectOption('#selType', 'Caps');
    await page.waitForFunction((n) => (window.__SQL__ || []).length > n, before);
    await page.waitForFunction(() => document.getElementById('kpiValue').textContent === '$42,000');
    assert.ok(await page.evaluate(() => (window.__SQL__ || []).some((s) => /= 'Caps'/.test(s))),
      'the product type reached the SQL, rather than filtering a stale copy');
    // A type that is still in the list after filtering by it.
    assert.equal(await page.locator('#selType').inputValue(), 'Caps');
    assert.ok((await page.locator('#selType option').count()) > 1, 'the option list is not emptied');

    await page.selectOption('#selType', '');
    await page.waitForFunction(() => document.getElementById('kpiValue').textContent === '$136,500');
    await page.selectOption('#selLocation', 'north_shop');
    await page.waitForFunction(() => document.getElementById('kpiValue').textContent === '$12,000');
    assert.equal(await page.locator('#cardInbound').isVisible(), false,
      'a PO line has no location, so Arriving is hidden rather than wrong');
    assert.equal(await text('#kpiInbound'), '—');
    // Every link on the page now carries the location, so a drill-in shows the
    // same rows the tile was counting.
    assert.equal(await page.locator('#keyStatus a[href="/v2/inventory.html?lens=oos&loc=north_shop"]').count(), 1);

    /* ---- Reads only ---- */
    const queries = await page.evaluate(() => window.__QUERIES__);
    assert.ok(!queries.some((q) => ['insert', 'update', 'delete', 'upsert'].includes(q._op)));
    const settings = queries.filter((q) => q.table === 'company_settings');
    assert.ok(settings.length && settings.every((q) => q.filters.some(
      (f) => f.col === 'company_entity_id' && f.val === companyId)), 'company_settings is tenant scoped');
    const sql = await page.evaluate(() => window.__SQL__ || []);
    assert.ok(sql.length >= 5);
    assert.ok(sql.every((s) => /^\s*(select|with)\s/i.test(s)), 'every query is a SELECT');
    assert.ok(!sql.some((s) => s.includes(';')));
    // The matview behind the view is never read directly: the view carries the
    // tenant boundary.
    assert.ok(!sql.some((s) => s.includes('inventory_workboard_mv')));

    /* ---- The deep link the Overview emits actually works ---- */
    await page.selectOption('#selLocation', '');
    await page.waitForFunction(() => document.getElementById('kpiValue').textContent === '$136,500');
    assert.deepEqual(errors, []);

    /* ---- Screenshots ---- */
    fs.mkdirSync('/tmp/inventory-qa', { recursive: true });
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 390]) {
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.keyboard.press('Escape');
        if (width <= 900) {
          await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 1);
        }
        await page.waitForTimeout(250);
        await page.screenshot({
          path: `/tmp/inventory-qa/overview-${theme}-${width}.png`,
          fullPage: width === 390,
        });
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.setViewportSize({ width: 1440, height: 1100 });

    console.log('PASS inventory-overview');
  } finally {
    await suite.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
