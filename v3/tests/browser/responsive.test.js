/* Desktop, tablet and phone -- and the one property that has to survive all
 * three: the DESKTOP arrangement.
 *
 * Below 700px GridStack collapses to one column, and layout() refuses to
 * serialise a collapsed grid. That refusal is the whole reason a save from a
 * phone does not overwrite everyone's 12-column board with the phone's, and
 * it is easy to break by "improving" the geometry reader, so it is asserted
 * here rather than left to the header comment.
 *
 * Doubles as the screenshot pass: V3_TEST_SCREENSHOTS=1 writes one image per
 * viewport for the PR. */
'use strict';
const { startSuite } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c, extra) => {
  checks++;
  if (c) console.log('  ok   ' + n);
  else { console.log('  FAIL ' + n + (extra ? '\n        ' + extra : '')); fails++; }
};

const SHOT = !!process.env.V3_TEST_SCREENSHOTS;
const DIR = process.env.V3_SHOT_DIR || '.';

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 900 } });
  const { BASE } = suite;

  const seedScript = `
    db.dashboards[0].filter_state = { store: 'Portland' };
    db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'S0', dashboard_id: 'D1', report_id: null, query_index: 0, title: 'Act on this',
        visual_type: 'section', visual_config: {}, layout: { x: 0, y: 0, w: 12, h: 1 }, sort_order: 0 },
      { id: 'K1', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Net sales',
        visual_type: 'kpi', visual_config: { y_field: 'net_sales', sparkline: true, abbreviate: true },
        layout: { x: 0, y: 1, w: 3, h: 2 }, sort_order: 1 },
      { id: 'K2', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Units',
        visual_type: 'kpi', visual_config: { y_field: 'units', compare: 'previous_row' },
        layout: { x: 3, y: 1, w: 3, h: 2 }, sort_order: 2 },
      { id: 'B1', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Top products',
        visual_type: 'bar', visual_config: { x_field: 'product_title', y_field: 'net_sales', sort: 'desc', limit: 10 },
        layout: { x: 6, y: 1, w: 6, h: 4 }, sort_order: 3 },
      { id: 'S1', dashboard_id: 'D1', report_id: null, query_index: 0, title: 'What already happened',
        visual_type: 'section', visual_config: {}, layout: { x: 0, y: 5, w: 12, h: 1 }, sort_order: 4 },
      { id: 'H1', dashboard_id: 'D1', report_id: 'P4', query_index: 0, title: 'Units by size and location',
        visual_type: 'heatmap', visual_config: { row_field: 'size', x_field: 'location', y_field: 'units' },
        layout: { x: 0, y: 6, w: 6, h: 4 }, sort_order: 5 },
      { id: 'W1', dashboard_id: 'D1', report_id: 'P5', query_index: 0, title: 'Cash bridge',
        visual_type: 'waterfall', visual_config: { x_field: 'step', y_field: 'delta' },
        layout: { x: 6, y: 6, w: 6, h: 4 }, sort_order: 6 },
      { id: 'T1', dashboard_id: 'D1', report_id: 'P3', query_index: 0, title: 'One store',
        visual_type: 'table', visual_config: { totals: 'row' },
        layout: { x: 0, y: 10, w: 12, h: 4 }, sort_order: 7 });`;

  /* Seeded per CONTEXT, not once: sessionStorage is scoped to the browser
     context, and the tablet and phone each open their own. Seeding only the
     first one is how a "responsive" suite ends up asserting about an empty
     board on two of its three viewports. */
  const seedInto = (src) => {
    // eslint-disable-next-line no-new-func
    new Function('db', src)(window.__FAKE_DB__);
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: window.__FAKE_DB__.dashboards,
      dashboard_widgets: window.__FAKE_DB__.dashboard_widgets,
      silo_chat_saved_reports: window.__FAKE_DB__.silo_chat_saved_reports,
      dashboard_filter_views: window.__FAKE_DB__.dashboard_filter_views,
    }));
  };

  // ── Desktop ───────────────────────────────────────────────────────────
  console.log('\n── desktop (1440) ──');
  const { page, errors } = await suite.newPage();
  await page.addInitScript(() => {
    try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch (e) { /* ignore */ }
  });
  await page.goto(`${BASE}/v3/dashboard.html?id=D1`);
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.evaluate(seedInto, seedScript);
  await page.reload();
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.waitForTimeout(1200);

  ok('every tile drew', (await page.locator('.dw').count()) === 8);
  ok('the grid is 12 columns', (await page.evaluate(() => window.__siloDashboard.runtime.grid.getColumn())) === 12);
  const desktopGeo = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  ok('the header does not wrap its own title',
    (await page.evaluate(() => document.querySelector('.bcn-header').getBoundingClientRect().height)) < 70,
    String(await page.evaluate(() => document.querySelector('.bcn-header').getBoundingClientRect().height)));
  ok('the description is behind the disclosure, not competing with the title',
    await page.isHidden('#headerInfo'));
  await page.click('#btnInfo');
  await page.waitForTimeout(200);
  ok('...and opens when asked', await page.isVisible('#headerInfo'));
  await page.click('#btnInfo');

  if (SHOT) await page.screenshot({ path: `${DIR}/v3-desktop.png`, fullPage: false });

  // The canvas is the only thing that scrolls; the filter bar has to stay
  // put or a long board loses it. Done AFTER the screenshot so the image
  // shows the top of the board rather than wherever this left it.
  await page.evaluate(() => { document.getElementById('canvas').scrollTop = 400; });
  await page.waitForTimeout(200);
  ok('the filter bar stays visible while the canvas scrolls',
    await page.isVisible('#slicerBar')
    && (await page.evaluate(() => document.getElementById('slicerBar').getBoundingClientRect().top)) >= 0);
  await page.evaluate(() => { document.getElementById('canvas').scrollTop = 0; });
  await page.waitForTimeout(200);

  // Compact density, same layout.
  await page.click('#btnDensity');
  await page.waitForTimeout(600);
  const compactGeo = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  ok('compact density changes no geometry', JSON.stringify(desktopGeo) === JSON.stringify(compactGeo));
  if (SHOT) await page.screenshot({ path: `${DIR}/v3-desktop-compact.png`, fullPage: false });
  await page.click('#btnDensity');
  await page.waitForTimeout(400);

  // Edit mode, inspector open: the tile IS the preview.
  await page.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.waitForTimeout(900);
  await page.click('.dw[data-widget-id="B1"] [data-act="configure"]');
  await page.waitForSelector('#inspectorTabs [data-tab="visual"]');
  await page.waitForTimeout(300);
  ok('the inspector rings the tile it is editing, so the preview is the real tile',
    (await page.locator('.dw[data-widget-id="B1"].is-inspecting').count()) === 1);
  ok('all four tabs are offered for an ordinary chart',
    (await page.locator('#inspectorTabs .v3-insp-tab').count()) === 4);
  if (SHOT) await page.screenshot({ path: `${DIR}/v3-editor.png`, fullPage: false });

  // ── Tablet ────────────────────────────────────────────────────────────
  console.log('\n── tablet (900) ──');
  const tabletCtx = await suite.newContext({ viewport: { width: 900, height: 1000 } });
  const tablet = await tabletCtx.newPage();
  await tablet.addInitScript(() => {
    try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch (e) { /* ignore */ }
  });
  await tablet.goto(`${BASE}/v3/dashboard.html?id=D1`);
  await tablet.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await tablet.evaluate(seedInto, seedScript);
  await tablet.reload();
  await tablet.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await tablet.waitForTimeout(1000);
  ok('a tablet keeps the 12-column arrangement',
    (await tablet.evaluate(() => window.__siloDashboard.runtime.grid.getColumn())) === 12);
  ok('nothing overflows the page horizontally',
    await tablet.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (SHOT) await tablet.screenshot({ path: `${DIR}/v3-tablet.png`, fullPage: false });

  // ── Phone ─────────────────────────────────────────────────────────────
  console.log('\n── phone (390) ──');
  const phoneCtx = await suite.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  await phone.addInitScript(() => {
    try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch (e) { /* ignore */ }
  });
  await phone.goto(`${BASE}/v3/dashboard.html?id=D1`);
  await phone.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await phone.evaluate(seedInto, seedScript);
  await phone.reload();
  await phone.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await phone.waitForTimeout(1200);

  ok('below 700px the grid collapses to one column',
    (await phone.evaluate(() => window.__siloDashboard.runtime.grid.getColumn())) === 1);
  ok('every tile is still drawn, stacked', (await phone.locator('.dw').count()) === 8);
  // The stack has to read the way the desktop board reads -- top to bottom,
  // then left to right. GridStack's own collapse runs before any widget
  // exists, so left alone it adds each tile at its 12-column y and every
  // collision pushes the tile already there down, inverting each row.
  const phoneOrder = await phone.evaluate(() =>
    [...document.querySelectorAll('.grid-stack-item')]
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
      .map((e) => e.getAttribute('gs-id')));
  ok('...in the desktop’s reading order, not reversed within each row',
    JSON.stringify(phoneOrder) === JSON.stringify(['S0', 'K1', 'K2', 'B1', 'S1', 'H1', 'W1', 'T1']),
    JSON.stringify(phoneOrder));
  ok('nothing overflows the page horizontally',
    await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    String(await phone.evaluate(() => document.documentElement.scrollWidth)));
  ok('the filter bar wraps rather than clipping its own fields',
    await phone.evaluate(() => {
      const b = document.getElementById('slicerBar');
      return b.clientHeight >= b.scrollHeight - 1;
    }));
  ok('a wide table scrolls inside its own box, not the page',
    await phone.evaluate(() => {
      const w = document.querySelector('.dw-table-wrap');
      return !!w && getComputedStyle(w).overflowX !== 'visible';
    }));

  // THE property: a save from a phone must not overwrite the desktop layout.
  const phoneGeo = await phone.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  ok('layout() refuses to serialise the collapsed grid, handing back the SAVED geometry',
    JSON.stringify(phoneGeo) === JSON.stringify(desktopGeo),
    JSON.stringify(phoneGeo));

  if (SHOT) await phone.screenshot({ path: `${DIR}/v3-phone.png`, fullPage: false });

  ok('no page errors on any viewport', errors.length === 0, errors.slice(0, 5).join('\n'));

  await suite.close();
  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
