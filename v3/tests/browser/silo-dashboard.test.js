/* A SILO dashboard (20260925120000): listed first and labelled SILO, created
 * by SILO, never editable in place -- not even by an owner, whom the page
 * otherwise lets edit anyone's board -- and "Save a copy" makes a private
 * board the viewer owns and opens it in edit mode, leaving SILO's untouched. */
'use strict';
const assert = require('assert/strict');
const { startSuite } = require('../lib/harness');

(async () => {
  const suite = await startSuite();
  try {
    const { page, errors } = await suite.newPage();
    await page.addInitScript(() => {
      if (sessionStorage.getItem('__SEEDED__')) return;
      sessionStorage.setItem('__SEEDED__', '1');
      sessionStorage.setItem('__PERSIST_FAKE_DB__', '1');
      const w = (id, dash, report_id, title, visual_type, y, visual_config = {}) => ({
        id, dashboard_id: dash, company_entity_id: dash === 'SILOD' ? null : 'C1', created_by: dash === 'SILOD' ? null : 'U1',
        report_id, query_index: 0, title, visual_type, visual_config, layout: { x: 0, y, w: 12, h: 3 }, sort_order: y });
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        dashboards: [
          { id: 'D1', company_entity_id: 'C1', created_by: 'U1', created_by_name: 'Blake', source: 'user',
            name: 'Monday sales review', description: 'What sold last week', visibility: 'company',
            created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' },
          { id: 'SILOD', company_entity_id: null, created_by: null, created_by_name: 'SILO', source: 'system',
            name: 'Overview', description: 'Sales at a glance, for every company. Maintained by SILO.',
            visibility: 'company', filter_state: { date_from: 'today-28d' },
            created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
        ],
        dashboard_widgets: [
          w('SW1', 'SILOD', null, 'Sales', 'section', 0),
          w('SW2', 'SILOD', 'S1', 'Net sales by day', 'line', 1, { x_field: 'day_date', y_field: 'net_sales' }),
        ],
        // An OWNER: the page lets an owner edit a colleague's board, so this is
        // the viewer for whom "read-only" is not the default.
        profiles: [{ id: 'U1', name: 'Blake', email: 'blake@baseballism.com', role: 'owner' }],
      }));
    });

    // ── The library ─────────────────────────────────────────────────────
    await page.goto(`${suite.BASE}/v3/dashboards.html?tab=dashboards`);
    await page.waitForSelector('#listBody .lib-card');
    const order = await page.$$eval('#listBody .lib-card', (els) => els.map((e) => e.dataset.id));
    assert.deepEqual(order, ['SILOD', 'D1'], 'the SILO board lists first, though it was updated earlier');
    assert.equal((await page.textContent('#listBody .lib-card[data-id="SILOD"] .bcn-pill')).trim(), 'SILO');
    assert.equal((await page.textContent('#listBody .lib-card[data-id="D1"] .bcn-pill')).trim(), 'Company');

    // ── The board ───────────────────────────────────────────────────────
    await page.goto(`${suite.BASE}/v3/dashboard.html?id=SILOD&edit=1`);
    await page.waitForSelector('[gs-id="SW2"]');
    assert.equal((await page.textContent('#headerScope')).trim(), 'SILO');
    assert.match(await page.textContent('#headerMeta'), /Maintained by SILO for every company.*created by SILO/);
    assert.equal(await page.isHidden('#btnEdit'), true, 'no Edit, even for an owner');
    assert.equal(await page.evaluate(() => document.body.classList.contains('is-editing-dashboard')), false,
      '?edit=1 does not open edit mode on a SILO board');
    assert.equal(await page.isVisible('#btnCopy'), true, 'Save a copy is offered instead');

    // ── Save a copy ─────────────────────────────────────────────────────
    await Promise.all([page.waitForURL(/dashboard\.html\?id=D3&edit=1/), page.click('#btnCopy')]);
    await page.waitForSelector('[gs-id]');
    const state = await page.evaluate(() => window.__FAKE_DB__);
    const copy = state.dashboards.find((d) => d.id === 'D3');
    assert.equal(copy.name, 'Overview (copy)');
    assert.equal(copy.visibility, 'private', 'a copy starts as Only me');
    assert.equal(copy.company_entity_id, 'C1');
    assert.deepEqual(copy.filter_state, { date_from: 'today-28d' });
    const copied = state.dashboard_widgets.filter((x) => x.dashboard_id === 'D3');
    assert.deepEqual(copied.map((x) => x.title).sort(), ['Net sales by day', 'Sales']);
    assert.equal(copied.find((x) => x.title === 'Net sales by day').report_id, 'S1');
    assert.equal(state.dashboard_widgets.filter((x) => x.dashboard_id === 'SILOD').length, 2, "SILO's board is untouched");
    assert.equal((await page.textContent('#headerScope')).trim(), 'Only you');
    assert.equal(await page.isVisible('#btnEdit'), true, 'the copy is editable');
    assert.equal(await page.isHidden('#btnCopy'), true, 'a company board offers no copy button');
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'no page errors');
    console.log('  ok   SILO dashboard: listed first as SILO, read-only for an owner, copy is private and editable');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
