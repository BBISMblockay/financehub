/* Opening a SILO report (/v3/dashboard.html?report=<id>) reads it like an
 * expanded tile on a temporary board: a chart where the rows have a shape,
 * the full table under it, nothing written, no Edit, and a way onto a real
 * dashboard or into the builder. */
'use strict';
const assert = require('assert/strict');
const { startSuite } = require('../lib/harness');

(async () => {
  const suite = await startSuite();
  try {
    const { page, errors } = await suite.newPage();
    await page.goto(`${suite.BASE}/v3/dashboard.html?report=S1`);
    await page.waitForSelector('[gs-id="preview-table"] table');
    const before = await page.evaluate(() => ({
      dashboards: window.__FAKE_DB__.dashboards.length,
      widgets: window.__FAKE_DB__.dashboard_widgets.length,
    }));

    assert.equal((await page.textContent('#headerName')).trim(), 'Daily Sales');
    assert.equal((await page.textContent('#headerScope')).trim(), 'SILO report');
    assert.match(await page.textContent('#headerMeta'), /Not saved to any dashboard/);
    assert.equal(await page.locator('[gs-id="preview-chart"]').count(), 1, 'a date + number report gets a chart');
    const chartType = await page.evaluate(() =>
      window.__siloDashboard.runtime.getWidgets().find((w) => w.id === 'preview-chart').visual_type);
    assert.equal(chartType, 'line', 'the chart is the recommendation for a time series');
    const order = await page.evaluate(() => window.__siloDashboard.runtime.getWidgets()
      .map((w) => [w.id, w.layout.y]));
    assert.deepEqual(order, [['preview-chart', 0], ['preview-table', 5]], 'chart above, table below');
    assert.ok((await page.locator('[gs-id="preview-table"] tbody tr').count()) > 0, 'the table shows rows');

    assert.equal(await page.isHidden('#btnEdit'), true, 'a preview has no Edit');
    assert.equal(await page.isHidden('#btnCopy'), true);
    assert.equal(await page.isHidden('#btnSaveView'), true, 'no saved views without a dashboard');
    assert.match(await page.getAttribute('#previewBuilder', 'href'), /report-builder\.html\?id=S1/);
    assert.equal((await page.textContent('#previewBuilder')).trim(), 'Customize a copy');

    // "Add to a dashboard" lists the boards this person can edit and hands
    // off to the existing ?add_report flow.
    assert.equal(await page.isVisible('#previewAdd'), true);
    const opts = await page.$$eval('#previewAdd option', (os) => os.map((o) => o.value).filter(Boolean));
    assert.deepEqual(opts, ['D1']);
    const after = await page.evaluate(() => ({
      dashboards: window.__FAKE_DB__.dashboards.length,
      widgets: window.__FAKE_DB__.dashboard_widgets.length,
    }));
    assert.deepEqual(after, before, 'opening a report writes nothing');
    await Promise.all([page.waitForURL(/dashboard\.html\?id=D1&add_report=S1/), page.selectOption('#previewAdd', 'D1')]);
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'no page errors');
    console.log('  ok   SILO report preview: chart + table, nothing saved, add-to-dashboard hand-off');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
