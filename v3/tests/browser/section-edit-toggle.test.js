/* A section keeps its collapse arrow across Edit -> Done. setEditable()
 * rebuilt every tile's head actions with the regular-tile template, so
 * leaving edit mode turned a section's collapse arrow into "Refresh this
 * widget" (found in the 2026-09-25 UI walkthrough on the Redo board). */
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
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        dashboards: [{ id: 'D1', company_entity_id: 'C1', created_by: 'U1', created_by_name: 'Blake', source: 'user',
          name: 'Board', visibility: 'company', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' }],
        dashboard_widgets: [
          { id: 'SEC', dashboard_id: 'D1', report_id: null, query_index: 0, title: 'Returns', visual_type: 'section',
            visual_config: {}, layout: { x: 0, y: 0, w: 12, h: 1 }, sort_order: 0 },
          { id: 'T1', dashboard_id: 'D1', report_id: 'S1', query_index: 0, title: 'Sales', visual_type: 'table',
            visual_config: {}, layout: { x: 0, y: 1, w: 12, h: 4 }, sort_order: 1 },
        ],
        profiles: [{ id: 'U1', name: 'Blake', email: 'blake@baseballism.com', role: 'owner' }],
      }));
    });
    await page.goto(`${suite.BASE}/v3/dashboard.html?id=D1`);
    await page.waitForSelector('[gs-id="SEC"] [data-act="collapse"]');

    const sectionActs = () => page.$$eval('[gs-id="SEC"] .dw-head-actions [data-act]', (els) => els.map((e) => e.dataset.act));
    assert.deepEqual(await sectionActs(), ['collapse'], 'view mode: the collapse arrow only');

    await page.click('#btnEdit');
    assert.deepEqual(await sectionActs(), ['configure', 'duplicate', 'remove'], 'edit mode: section controls, no collapse');

    await page.click('#btnEdit'); // Done
    assert.deepEqual(await sectionActs(), ['collapse'], 'after Done: the collapse arrow is back, not "Refresh this widget"');
    const tableActs = await page.$$eval('[gs-id="T1"] .dw-head-actions [data-act]', (els) => els.map((e) => e.dataset.act));
    assert.ok(tableActs.includes('reload'), 'a regular tile still gets its refresh button');

    await page.click('[gs-id="SEC"] [data-act="collapse"]');
    assert.equal(await page.locator('[gs-id="T1"]').isVisible(), false, 'and it still collapses the section');
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'no page errors');
    console.log('  ok   section keeps its collapse arrow across Edit -> Done');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
