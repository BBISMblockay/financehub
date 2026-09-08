/* The BI workspace: filters that commit, tiles that say what they are, and
 * a canvas you can actually work on.
 *
 * Most of these assertions exist because of something that went wrong in
 * live testing. Where that is true the comment says so, because the reason
 * is the part worth keeping.
 *
 * The strongest assertions read window.__FAKE_DB__.rpcCalls rather than
 * pixels: a tile can look right and be running the wrong query, which is
 * exactly how two widgets shipped rendering an information_schema lookup. */
'use strict';
const { startSuite, inspectorTab } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c, extra) => {
  checks++;
  if (c) console.log('  ok   ' + n);
  else { console.log('  FAIL ' + n + (extra ? '\n        ' + extra : '')); fails++; }
};

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 900 } });
  const { BASE } = suite;
  const { page, errors } = await suite.newPage();

  await page.addInitScript(() => {
    try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch (e) { /* ignore */ }
  });

  const seed = (body) => page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    new Function('db', src)(window.__FAKE_DB__);
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: window.__FAKE_DB__.dashboards,
      dashboard_widgets: window.__FAKE_DB__.dashboard_widgets,
      silo_chat_saved_reports: window.__FAKE_DB__.silo_chat_saved_reports,
      dashboard_filter_views: window.__FAKE_DB__.dashboard_filter_views,
    }));
  }, body);

  const openBoard = async (qs = '') => {
    await page.goto(`${BASE}/v3/dashboard.html?id=D1${qs}`);
    await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
    await page.waitForTimeout(500);
  };

  const rpcQueries = () => page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
  const clearRpc = () => page.evaluate(() => { window.__FAKE_DB__.rpcCalls.length = 0; });

  // ══════════════════════════════════════════════════════════════════════
  // 1. A parameterised report works the moment it is added
  // ══════════════════════════════════════════════════════════════════════
  // The live failure: adding a saved report that declares {{store}} showed
  // "which is not a declared parameter" until the dashboard was saved and
  // reloaded. The declaration was always right; the picker never selected
  // the column, so the widget was handed report_parameters=undefined.
  console.log('\n── a parameterised report, added and working immediately ──');

  await openBoard('&edit=1');
  await page.click('#btnAddWidget');
  await page.waitForSelector('.v3-report-card');
  await page.click('.v3-report-card:has-text("Sales by product, one store")');
  await page.waitForSelector('.dw', { timeout: 5000 });
  await page.waitForTimeout(600);

  const tileText = await page.textContent('.dw');
  ok('the tile does NOT claim the parameter is undeclared',
    !/not a declared parameter/.test(tileText), tileText.slice(0, 200));
  ok('...and it drew real rows instead',
    (await page.locator('.dw-table, .dw-chart, .dw-kpi').count()) >= 1, tileText.slice(0, 200));

  let calls = await rpcQueries();
  ok('the report ran with its own declared DEFAULT substituted in',
    calls.some((q) => q === "select product_title, net_sales from s where store = 'Portland'"),
    JSON.stringify(calls));
  ok('no {{token}} ever reached the RPC', !calls.some((q) => /\{\{/.test(q)), JSON.stringify(calls));

  ok('the filter bar appeared without a reload', await page.isVisible('#slicerBar'));
  // The control must not render blank over results the default filtered.
  ok('...and the control shows the value the query actually ran with',
    (await page.inputValue('#slicerFields [data-param="store"]')) === 'Portland');
  ok('...with the applied value stated as a chip too',
    (await page.textContent('#filterChips')).includes('Portland'));

  // ══════════════════════════════════════════════════════════════════════
  // 2. A TEXT filter commits
  // ══════════════════════════════════════════════════════════════════════
  // The live failure: a typed store name showed in the box, changed nothing,
  // and was reverted by the next date change. Cause: the bar committed on
  // `change` only, and every apply rebuilt the whole bar's innerHTML.
  console.log('\n── a typed filter commits, and is never silently discarded ──');

  await clearRpc();
  const store = page.locator('#slicerFields [data-param="store"]');
  await store.click();
  await store.fill('Austin');
  await page.waitForTimeout(150);

  ok('while typing, the value is marked as NOT YET APPLIED',
    (await page.textContent('#filterChips')).includes('not applied yet'));
  ok('...and the field itself says so', await page.isVisible('.v3-slicer-field.is-pending'));
  ok('nothing has run yet -- typing is not a query per keystroke',
    (await rpcQueries()).length === 0);

  await store.press('Enter');
  await page.waitForTimeout(600);
  calls = await rpcQueries();
  ok('Enter commits, and the RPC got the typed value as a quoted literal',
    calls.some((q) => q === "select product_title, net_sales from s where store = 'Austin'"),
    JSON.stringify(calls));
  ok('the pending marker clears once it is applied',
    !(await page.textContent('#filterChips')).includes('not applied yet'));
  // The tile was auto-suggested as a chart, so "did it redraw" is best
  // asked of its state rather than its text: no notice, no error, and a
  // drawn body.
  ok('the tile redrew cleanly on the new store’s rows',
    (await page.locator('.dw .dw-empty--error, .dw .dw-empty--warn').count()) === 0
    && (await page.locator('.dw-chart, .dw-table, .dw-kpi').count()) >= 1,
    (await page.textContent('.dw')).slice(0, 160));

  // The second half of the live symptom: another control moving used to
  // wipe the text field back to its old value.
  await page.evaluate(() => window.__siloDashboard.runtime.setParamValues({ store: 'Austin' }));
  await page.waitForTimeout(200);
  ok('a repaint driven by another control does not revert the applied value',
    (await page.inputValue('#slicerFields [data-param="store"]')) === 'Austin');

  // Blur commits too -- clicking away from a filled box is the other way
  // people expect it to take.
  await store.fill('Portland');
  await store.blur();
  await page.waitForTimeout(600);
  ok('blur commits as well as Enter',
    (await page.evaluate(() => window.__siloDashboard.runtime.getParamValues().store)) === 'Portland');

  // ══════════════════════════════════════════════════════════════════════
  // 3. A widget a filter cannot reach says so
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── unsupported filters are marked, not left looking stale ──');

  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WA', dashboard_id: 'D1', report_id: 'P3', query_index: 0, title: 'One store',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 },
      { id: 'WB', dashboard_id: 'D1', report_id: 'P6', query_index: 0, title: 'Company-wide',
        visual_type: 'table', visual_config: {}, layout: { x: 6, y: 0, w: 6, h: 4 }, sort_order: 1 });`);
  await openBoard();

  ok('the tile that reads the filter is not marked',
    (await page.locator('.dw[data-widget-id="WA"] .dw-nofilter').count()) === 0);
  ok('the tile that does NOT read it is marked "not filtered"',
    (await page.locator('.dw[data-widget-id="WB"] .dw-nofilter').count()) === 1);
  ok('...and the marker names the parameter it ignores',
    /\{\{store\}\}/.test(await page.getAttribute('.dw[data-widget-id="WB"] .dw-nofilter', 'title')));

  // A filter change must not silently leave the unfiltered tile looking
  // like it moved with everything else.
  await clearRpc();
  await page.locator('#slicerFields [data-param="store"]').fill('Austin');
  await page.locator('#slicerFields [data-param="store"]').press('Enter');
  await page.waitForTimeout(600);
  calls = await rpcQueries();
  ok('only the participating widget re-ran', calls.length === 1, JSON.stringify(calls));

  // ══════════════════════════════════════════════════════════════════════
  // 4. Saved filter views
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── personal saved views ──');

  await page.click('#btnSaveView');
  await page.waitForTimeout(200);
  ok('the save dialog lists what it is about to store',
    (await page.textContent('#viewSummary')).includes('Austin'));
  await page.fill('#viewName', 'Austin only');
  await page.click('#btnConfirmView');
  await page.waitForTimeout(500);

  const views = await page.evaluate(() => window.__FAKE_DB__.dashboard_filter_views);
  ok('the view stored the filter values', views.length === 1 && views[0].filter_state.store === 'Austin',
    JSON.stringify(views));
  ok('...and nothing else -- no copy of the dashboard or its widgets',
    (await page.evaluate(() => window.__FAKE_DB__.dashboards.length)) === 1
    && (await page.evaluate(() => window.__FAKE_DB__.dashboard_widgets.length)) === 2);
  ok('the view appears in the picker', (await page.locator('#viewSelect option').count()) === 2);

  await page.selectOption('#viewSelect', '');
  await page.waitForTimeout(500);
  ok('picking "Dashboard default" goes back to the board’s own position',
    (await page.evaluate(() => window.__siloDashboard.runtime.getParamValues().store)) === 'Portland');
  const viewId = views[0].id;
  await page.selectOption('#viewSelect', viewId);
  await page.waitForTimeout(500);
  ok('picking the saved view applies it again',
    (await page.evaluate(() => window.__siloDashboard.runtime.getParamValues().store)) === 'Austin');

  await page.click('#btnResetFilters');
  await page.waitForTimeout(500);
  ok('Reset returns to the dashboard default in one click',
    (await page.evaluate(() => window.__siloDashboard.runtime.getParamValues().store)) === 'Portland');

  // ══════════════════════════════════════════════════════════════════════
  // 5. Table tools
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── reading a table ──');

  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WT', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Top products',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 12, h: 5 }, sort_order: 0 });`);
  await openBoard();
  await page.waitForSelector('.dw-table');

  ok('a table offers search and export in VIEW mode -- reading, not editing',
    (await page.locator('[data-role="table-search"]').count()) === 1
    && (await page.locator('[data-act="export-csv"]').count()) === 1);

  await page.fill('[data-role="table-search"]', 'pin');
  await page.waitForTimeout(300);
  ok('search filters the rows on screen',
    (await page.locator('.dw-table tbody tr').count()) === 1);
  ok('...and says what it matched, against what is loaded',
    (await page.textContent('.dw-foot-note')).includes('Search matched 1 of 4 loaded rows'));
  ok('searching did NOT mark the dashboard dirty -- it is reading',
    await page.isHidden('#dirtyPill'));
  ok('the search box kept focus while typing',
    await page.evaluate(() => document.activeElement && document.activeElement.dataset.role === 'table-search'));

  await page.fill('[data-role="table-search"]', '');
  await page.waitForTimeout(300);
  await page.click('.dw-table th [data-sort-col="units"]');
  await page.waitForTimeout(300);
  const firstCell = await page.textContent('.dw-table tbody tr:first-child td:first-child');
  ok('clicking a header sorts by it', firstCell.includes('Bubbles'), firstCell);
  ok('...and the header announces the direction to assistive tech',
    (await page.getAttribute('.dw-table th:nth-child(3)', 'aria-sort')) === 'descending');
  await page.click('.dw-table th [data-sort-col="units"]');
  await page.waitForTimeout(300);
  ok('clicking again reverses it',
    (await page.textContent('.dw-table tbody tr:first-child td:first-child')).includes('Pin'));

  ok('the horizontal scroller is keyboard-reachable',
    (await page.getAttribute('.dw-table-wrap', 'tabindex')) === '0');

  // ══════════════════════════════════════════════════════════════════════
  // 6. Canvas: duplicate, full screen, collapse, density
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── the canvas ──');

  await openBoard('&edit=1');
  await page.waitForSelector('.dw-table');
  await page.click('.dw [data-act="duplicate"]');
  await page.waitForTimeout(500);
  ok('duplicate adds a second tile', (await page.locator('.dw').count()) === 2);
  const dupCfg = await page.evaluate(() => {
    const ws = window.__siloDashboard.runtime.getWidgets();
    return { titles: ws.map((w) => w.title), sameReport: ws[0].report_id === ws[1].report_id,
      sharedConfig: ws[0].visual_config === ws[1].visual_config };
  });
  ok('...pointing at the same report', dupCfg.sameReport);
  ok('...named as a copy so the two are tellable apart', /\(copy\)$/.test(dupCfg.titles[1]), JSON.stringify(dupCfg.titles));
  // A shared config object would make editing one silently change the other.
  ok('...with its OWN config object, not a shared reference', !dupCfg.sharedConfig);
  ok('duplicating marks the board unsaved rather than writing silently',
    await page.isVisible('#dirtyPill'));

  await page.reload();
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.waitForTimeout(500);
  ok('the duplicate was NOT persisted without a Save',
    (await page.locator('.dw').count()) === 1);

  // Full screen moves the body rather than re-rendering it, so a table
  // keeps its loaded pages and a chart keeps its instance.
  await page.click('.dw [data-act="fullscreen"]');
  await page.waitForTimeout(400);
  ok('full screen opens', await page.isVisible('#fsOverlay'));
  ok('...with the tile’s own body, moved rather than redrawn',
    (await page.locator('#fsBody .dw-table').count()) === 1);
  ok('...and the grid no longer holds it while it is out',
    (await page.locator('#grid .dw-table').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('Escape closes it', await page.isHidden('#fsOverlay'));
  ok('...and the body goes back to its tile', (await page.locator('#grid .dw-table').count()) === 1);

  // Density is a per-reader preference and must not touch any saved layout.
  const geoBefore = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  await page.click('#btnDensity');
  await page.waitForTimeout(400);
  ok('compact density is applied to the page',
    (await page.getAttribute('body', 'data-density')) === 'compact');
  const geoAfter = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  ok('...and changes no widget geometry at all',
    JSON.stringify(geoBefore) === JSON.stringify(geoAfter), JSON.stringify(geoAfter));
  ok('...and does not mark the dashboard dirty', await page.isHidden('#dirtyPill'));
  await page.click('#btnDensity');
  await page.waitForTimeout(300);

  // Sections: collapsing detaches the tiles below so the board gets
  // shorter, and expanding restores the geometry exactly.
  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WS', dashboard_id: 'D1', report_id: null, query_index: 0, title: 'Act on this',
        visual_type: 'section', visual_config: {}, layout: { x: 0, y: 0, w: 12, h: 1 }, sort_order: 0 },
      { id: 'W1', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Top products',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 1, w: 6, h: 4 }, sort_order: 1 },
      { id: 'WS2', dashboard_id: 'D1', report_id: null, query_index: 0, title: 'Background',
        visual_type: 'section', visual_config: {}, layout: { x: 0, y: 5, w: 12, h: 1 }, sort_order: 2 },
      { id: 'W2', dashboard_id: 'D1', report_id: 'R2', query_index: 0, title: 'Daily',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 6, w: 6, h: 4 }, sort_order: 3 });`);
  await openBoard();
  ok('four tiles to start', (await page.locator('.dw').count()) === 4);
  const geoBeforeCollapse = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));

  await page.click('.dw[data-widget-id="WS"] [data-act="collapse"]');
  await page.waitForTimeout(400);
  ok('collapsing a section hides only the tiles it introduces',
    await page.isHidden('.grid-stack-item[gs-id="W1"]') && await page.isVisible('.grid-stack-item[gs-id="W2"]'));
  ok('...and the heading itself stays', await page.isVisible('.dw[data-widget-id="WS"]'));
  ok('...with the control stating it is collapsed',
    (await page.getAttribute('.dw[data-widget-id="WS"] [data-act="collapse"]', 'aria-expanded')) === 'false');

  await page.click('.dw[data-widget-id="WS"] [data-act="collapse"]');
  await page.waitForTimeout(400);
  ok('expanding brings them back', await page.isVisible('.grid-stack-item[gs-id="W1"]'));
  const geoAfterCollapse = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  // GridStack compacts on removal; re-adding alone would leave that
  // compaction in place, which is a layout nobody arranged.
  ok('...at exactly the geometry they had before',
    JSON.stringify(geoBeforeCollapse) === JSON.stringify(geoAfterCollapse),
    JSON.stringify(geoAfterCollapse));

  // ══════════════════════════════════════════════════════════════════════
  // 7. Cross-filter and drill-through
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── clicking a value ──');

  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WX', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Products',
        visual_type: 'table', visual_config: { cross_filter: 'store' },
        layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 },
      { id: 'WY', dashboard_id: 'D1', report_id: 'P3', query_index: 0, title: 'One store',
        visual_type: 'table', visual_config: {}, layout: { x: 6, y: 0, w: 6, h: 4 }, sort_order: 1 });`);
  await openBoard();
  await clearRpc();
  await page.click('.dw[data-widget-id="WX"] td[data-value="Bubbles and Doubles Tee"]');
  await page.waitForTimeout(600);
  calls = await rpcQueries();
  ok('clicking a dimension cell re-runs the OTHER widget through the filter',
    calls.some((q) => q === "select product_title, net_sales from s where store = 'Bubbles and Doubles Tee'"),
    JSON.stringify(calls));
  ok('...and the source tile shows it is driving the selection',
    (await page.locator('.dw[data-widget-id="WX"] .dw-selection').count()) === 1);
  await page.click('.dw[data-widget-id="WX"] td[data-value="Bubbles and Doubles Tee"]');
  await page.waitForTimeout(600);
  ok('clicking the same value again clears the selection',
    (await page.locator('.dw-selection').count()) === 0);

  // Drill-through carries the WHOLE current filter position, so the
  // destination's numbers reconcile with the one that was clicked.
  await seed(`db.dashboards.push({ id: 'D2', company_entity_id: 'C1', created_by: 'U1', created_by_name: 'Blake',
      name: 'Store detail', description: null, visibility: 'company',
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' });
    db.dashboard_widgets.find((w) => w.id === 'WX').visual_config =
      { drill_to: 'D2', drill_key: 'store' };`);
  await openBoard();
  await page.click('.dw[data-widget-id="WX"] td[data-value="Pin of the Month"]');
  await page.waitForTimeout(800);
  const url = page.url();
  ok('drill-through lands on the destination dashboard', /id=D2/.test(url), url);
  ok('...carrying the clicked value as a filter', /f\.store=Pin\+of\+the\+Month|f\.store=Pin%20of%20the%20Month/.test(url), url);

  // ══════════════════════════════════════════════════════════════════════
  // 8. The new visuals are offered only when they can draw
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── visuals that cannot draw are not offered ──');

  // Start from an empty board so "the tile" is unambiguous.
  await seed('db.dashboard_widgets.length = 0;');
  await openBoard('&edit=1');
  await page.click('#btnAddWidget');
  await page.waitForSelector('.v3-report-card');
  await page.click('.v3-report-card:has-text("Units by size and location")');
  await page.waitForSelector('.dw', { timeout: 5000 });
  await page.waitForTimeout(600);
  await inspectorTab(page, 'visual');
  ok('a two-dimension result offers Heatmap',
    !(await page.isDisabled('.v3-visual-opt input[value="heatmap"]')));
  await page.click('.v3-visual-opt:has(input[value="heatmap"])');
  await page.waitForTimeout(800);
  ok('...and it draws', (await page.locator('.dw-chart canvas').count()) >= 1,
    (await page.textContent('.dw-body')).slice(0, 220));
  ok('...saying how many pairs had no row at all, rather than colouring them zero',
    /had no row/.test(await page.textContent('.dw-foot')),
    await page.textContent('.dw-foot'));

  await page.click('#btnCloseInspector');
  await seed('db.dashboard_widgets.length = 0;');
  await openBoard('&edit=1');
  await page.click('#btnAddWidget');
  await page.waitForSelector('.v3-report-card');
  await page.click('.v3-report-card:has-text("Top products 30d")');
  await page.waitForSelector('.dw', { timeout: 5000 });
  await page.waitForTimeout(600);
  await inspectorTab(page, 'visual');
  ok('a ONE-dimension result does not offer Heatmap',
    await page.isDisabled('.v3-visual-opt input[value="heatmap"]'));
  ok('...and says what is missing rather than hiding the option',
    /two dimensions/.test(await page.textContent('.v3-visual-opt:has(input[value="heatmap"])')));

  // ══════════════════════════════════════════════════════════════════════
  // 9. Save / reload keeps everything
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── save and reload ──');

  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WK', dashboard_id: 'D1', report_id: 'R1', query_index: 0, title: 'Sales KPI',
        visual_type: 'kpi', visual_config: {}, layout: { x: 0, y: 0, w: 3, h: 2 }, sort_order: 0 });`);
  await openBoard('&edit=1');
  await page.waitForTimeout(400);

  // The live bug: a KPI with two numeric columns and no measure chosen used
  // to draw the first one under whatever title the card carried.
  ok('a KPI with no measure chosen says so instead of guessing',
    (await page.textContent('.dw')).includes('no measure selected'));
  await page.click('.dw [data-act="configure"]');
  await page.waitForSelector('#inspectorTabs [data-tab="data"]');
  await inspectorTab(page, 'data');
  await page.selectOption('#inspY', 'net_sales');
  await page.waitForTimeout(400);
  ok('choosing the measure draws it', /\$4[0-9]{2},[0-9]{3}/.test(await page.textContent('.dw-kpi-value')));

  await inspectorTab(page, 'format');
  // The checkbox is inside its label, which is the click target -- Playwright
  // refuses to click the input "through" it.
  await page.click('.rb-col:has(#inspAbbrev)');
  await page.waitForTimeout(300);
  await page.click('#btnCloseInspector');
  await page.click('#btnSave');
  await page.waitForTimeout(700);
  ok('save clears the unsaved marker', await page.isHidden('#dirtyPill'));
  ok('...and confirms in the status line',
    /saved/i.test(await page.textContent('#status')));

  await openBoard();
  await page.waitForTimeout(600);
  const persisted = await page.evaluate(() => window.__siloDashboard.runtime.getWidgets()[0].visual_config);
  ok('the measure survived the reload', persisted.y_field === 'net_sales', JSON.stringify(persisted));
  ok('...and so did the format choice', persisted.abbreviate === true, JSON.stringify(persisted));
  ok('...and the tile draws the abbreviated number',
    /^\$4[0-9]{2}(\.[0-9])?k$/.test((await page.textContent('.dw-kpi-value')).trim()),
    await page.textContent('.dw-kpi-value'));

  // ══════════════════════════════════════════════════════════════════════
  // 10. Empty, zero-denominator and error states
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── the states nobody plans for ──');

  await seed(`db.silo_chat_saved_reports.push(
      { id: 'RE', title: 'Broken report', question: null, description: 'Points at nothing',
        source: 'manual', company_entity_id: 'C1', visibility: 'company',
        created_by: 'U1', created_by_name: 'Blake', created_at: '2026-09-01T00:00:00Z',
        queries_run: ['select * from gone'] });
    db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'WE', dashboard_id: 'D1', report_id: 'RE', query_index: 0, title: 'Broken',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 });`);
  await openBoard();
  ok('a failing query explains itself rather than showing a blank tile',
    (await page.textContent('.dw-empty--error')).includes('relation does not exist'));
  ok('...and offers a retry, because a real share of these are a timeout',
    (await page.locator('[data-act="retry"]').count()) === 1);
  await clearRpc();
  await page.click('[data-act="retry"]');
  await page.waitForTimeout(500);
  ok('retry actually re-runs the query rather than redrawing the failure',
    (await rpcQueries()).length >= 1);

  ok('no page errors throughout', errors.length === 0, errors.slice(0, 5).join('\n'));

  if (process.env.V3_TEST_SCREENSHOTS) await page.screenshot({ path: 'bi-workspace.png', fullPage: true });
  await suite.close();
  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
