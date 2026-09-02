/* The v3 dashboard canvas, end to end: add a report, switch every visual,
 * drag/resize, save, reload identically. This is the V1 milestone as a test.
 *
 * The real dashboard.html runs the real dashboard-renderer.js -- only the
 * outside world (Supabase, the CDN) is faked. See ../lib/harness.js. */
'use strict';
const fs = require('fs');
const path = require('path');
const { startSuite } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c) => { checks++; if (c) console.log('  ok   ' + n); else { console.log('  FAIL ' + n); fails++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 900 } });
  const { BASE, ctx } = suite;
  const { page, errors } = await suite.newPage();

  // ── 1. Empty dashboard in edit mode ─────────────────────────────────
  await page.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
  await page.waitForSelector('#btnAddWidget:not([hidden])', { timeout: 10000 });
  ok('empty dashboard shows the blank state', await page.isVisible('#blank'));
  ok('header shows the dashboard name', (await page.textContent('#headerName')) === 'Monday sales review');
  ok('edit mode reveals the meta bar', await page.isVisible('#metaBar'));

  // ── 2. Add a widget from a saved report ─────────────────────────────
  await page.click('#btnAddWidget');
  await page.waitForSelector('.v3-report-card');
  ok('picker lists every source, not just Ask SILO', (await page.locator('.v3-report-card').count()) === 10); // +2: the parameterised fixtures added for slicers
  ok('a saved report with no stored SQL is not offered',
    (await page.locator('.v3-report-card[data-report="R4"]').count()) === 0);
  ok('...and the picker says so rather than hiding it silently',
    (await page.textContent('#addBody')).includes('1 saved report hidden'));
  ok('a central SILO definition is offered as a widget source',
    (await page.locator('.v3-report-card[data-report="S1"]').count()) === 1);
  ok('the system definition is badged as its own source',
    (await page.locator('.v3-report-card[data-report="S1"]').textContent()).includes('SILO report'));
  ok('a global definition reads Global, not Company',
    (await page.locator('.v3-report-card[data-report="S1"]').textContent()).includes('Global'));
  ok('a system report shows its description in place of a chat question',
    (await page.locator('.v3-report-card[data-report="S1"]').textContent()).includes('central SILO definition'));
  ok('an Ask SILO save is badged as Ask SILO',
    (await page.locator('.v3-report-card[data-report="R1"]').textContent()).includes('Ask SILO'));
  await page.click('.v3-report-card[data-report="R1"]');
  await page.waitForSelector('.dw');
  ok('a tile was added', (await page.locator('.dw').count()) === 1);
  ok('blank state hides once a widget exists', await page.isHidden('#blank'));
  ok('inspector opened for the new widget', await page.isVisible('#inspector.open'));

  const badgeText = async (sel = '.dw-type-badge') => (await page.textContent(sel)).replace(/[^a-z]/gi, '');
  const recType = await badgeText();
  ok(`top-N product query auto-suggests bar, not donut [got ${recType}]`, recType === 'bar');
  ok('chart canvas rendered', (await page.locator('.dw-chart canvas').count()) >= 1);

  // ── 3. Switch visual types, same dataset ────────────────────────────
  const switchTo = async (type) => {
    await page.click(`.v3-visual-opt:has(input[value="${type}"])`);
    await page.waitForTimeout(220);
  };
  await switchTo('table');
  ok('Table renders a table', (await page.locator('.dw-table').count()) === 1);
  ok('table header uses the query columns',
    (await page.locator('.dw-table thead th').allTextContents()).join(',') === 'product_title,net_sales,units');
  ok('badge says table', (await badgeText()) === 'table');
  ok('in edit mode the type badge is the control, not a status pill',
    (await page.locator('button.dw-type-badge--btn[data-act="configure"]').count()) === 1);

  await switchTo('line');
  ok('Line renders a canvas', (await page.locator('.dw-chart canvas').count()) >= 1);
  await switchTo('donut');
  ok('Donut renders a canvas', (await page.locator('.dw-chart canvas').count()) >= 1);
  await switchTo('kpi');
  ok('KPI renders a number', (await page.locator('.dw-kpi-value').count()) === 1);
  const kpiText = await page.textContent('.dw-kpi-value');
  ok(`KPI sums net_sales as currency [${kpiText}]`, /^\$4[0-9]{2},[0-9]{3}/.test(kpiText));

  await switchTo('bar');
  ok('back to Bar renders a canvas', (await page.locator('.dw-chart canvas').count()) >= 1);

  // Measures are a multi-select now: adding then removing swaps the measure,
  // and y_field must follow the first one so KPI/table keep working.
  await page.click('.rb-col:has([data-measure="units"])');
  await page.waitForTimeout(300);
  ok('adding a second measure keeps both',
    (await page.evaluate(() => (window.__siloDashboard.runtime.getWidgets()[0].visual_config.measures || []).length)) === 2);
  await page.click('.rb-col:has([data-measure="net_sales"])');
  await page.waitForTimeout(300);
  const cfgNow = await page.evaluate(() => window.__siloDashboard.runtime.getWidgets()[0].visual_config);
  ok('removing the other leaves just units', JSON.stringify(cfgNow.measures) === '["units"]');
  ok('y_field follows the first measure', cfgNow.y_field === 'units');

  // Rename the widget.
  await page.fill('#inspTitle', 'Top sellers by units');
  await page.waitForTimeout(120);
  ok('tile title follows the inspector', (await page.textContent('.dw-title')) === 'Top sellers by units');

  // Regression: gridstack's save() omits h when it equals minH, which
  // silently reloaded every shrunk KPI at the default height.
  await switchTo('kpi');
  await page.waitForTimeout(300);
  const kpiGeo = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  const kpiId = Object.keys(kpiGeo)[0];
  ok('switching to KPI shrinks the tile and reports a real height '
     + JSON.stringify(kpiGeo[kpiId]),
    kpiGeo[kpiId].w === 3 && kpiGeo[kpiId].h === 2);
  await switchTo('bar');

  await page.click('#btnCloseInspector');

  // ── 4. Drag and resize ──────────────────────────────────────────────
  const before = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  const item = page.locator('.grid-stack-item').first();
  // GridStack autohides the resize handle until the tile is hovered.
  await item.hover();
  await page.waitForTimeout(120);
  const handle = page.locator('.grid-stack-item .ui-resizable-se').first();
  ok('resize handle appears on hover', await handle.isVisible());
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 230, hb.y + 180, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(320);
  const after = await page.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  const id0 = Object.keys(after)[0];
  ok(`resize changed geometry (${JSON.stringify(before[id0])} -> ${JSON.stringify(after[id0])})`,
    after[id0].w > before[id0].w && after[id0].h > before[id0].h);
  ok('resize marked the dashboard dirty', (await page.textContent('#btnSave')).includes('•'));

  // ── 5. Save ─────────────────────────────────────────────────────────
  await page.fill('#dashDescription', 'Weekly sell-through check');
  await page.click('#btnSave');
  await page.waitForFunction(() => !document.getElementById('btnSave').textContent.includes('•'), null, { timeout: 5000 });
  const saved = await page.evaluate(() => window.__FAKE_DB__.dashboard_widgets);
  ok('exactly one widget row persisted', saved.length === 1);
  ok('persisted visual_type is bar', saved[0].visual_type === 'bar');
  ok('persisted measure is units', saved[0].visual_config.y_field === 'units');
  ok('persisted title', saved[0].title === 'Top sellers by units');
  ok('persisted layout matches the grid', JSON.stringify(saved[0].layout) === JSON.stringify(after[id0]));
  ok('persisted report + query index', saved[0].report_id === 'R1' && saved[0].query_index === 0);
  ok('payload carries no view-only columns',
    !Object.keys(saved[0]).some((k) => ['report_title', 'query_sql', 'report_query_count', '_new'].includes(k)));
  const dashRow = await page.evaluate(() => window.__FAKE_DB__.dashboards[0]);
  ok('dashboard description saved', dashRow.description === 'Weekly sell-through check');

  // ── 6. Reload -> identical ──────────────────────────────────────────
  const dbSnapshot = await page.evaluate(() => JSON.stringify({
    dashboards: window.__FAKE_DB__.dashboards, dashboard_widgets: window.__FAKE_DB__.dashboard_widgets }));
  await ctx.addInitScript((snap) => { window.__RESTORE__ = snap; }, dbSnapshot);
  const page2 = await ctx.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await page2.addInitScript(() => {
    // Re-seed the fake DB from the snapshot the moment it is created.
    const apply = () => {
      if (!window.__FAKE_DB__ || !window.__RESTORE__) return false;
      const s = JSON.parse(window.__RESTORE__);
      window.__FAKE_DB__.dashboards = s.dashboards;
      window.__FAKE_DB__.dashboard_widgets = s.dashboard_widgets;
      return true;
    };
    Object.defineProperty(window, '__FAKE_DB_HOOK__', { value: apply });
    const iv = setInterval(() => { if (apply()) clearInterval(iv); }, 1);
  });
  await page2.goto(`${BASE}/v3/dashboard.html?id=D1`);
  await page2.waitForSelector('.dw', { timeout: 10000 });
  ok('reloaded in view mode with the widget', (await page2.locator('.dw').count()) === 1);
  ok('reloaded title identical', (await page2.textContent('.dw-title')) === 'Top sellers by units');
  ok('reloaded visual identical', (await page2.textContent('.dw-type-badge')).replace(/[^a-z]/gi,'') === 'bar');
  ok('reloaded chart drew', (await page2.locator('.dw-chart canvas').count()) >= 1);
  const reloadedLayout = await page2.evaluate(() => Object.fromEntries(window.__siloDashboard.runtime.layout()));
  ok(`reloaded geometry identical (${JSON.stringify(reloadedLayout[id0])})`,
    JSON.stringify(reloadedLayout[id0]) === JSON.stringify(after[id0]));
  ok('view mode hides edit affordances', await page2.isHidden('#btnAddWidget') && await page2.isHidden('#metaBar'));
  ok('view mode offers a per-widget refresh', (await page2.locator('[data-act="reload"]').count()) === 1);

  // ── 7. Multi-query report picks a dataset ───────────────────────────
  await page2.click('#btnEdit');
  await page2.waitForSelector('#btnAddWidget:not([hidden])');
  await page2.click('#btnAddWidget');
  await page2.waitForSelector('.v3-report-card');
  await page2.click('.v3-report-card[data-report="R2"]');
  await page2.waitForSelector('.v3-query-card');
  ok('multi-query report asks which dataset', (await page2.locator('.v3-query-card').count()) === 2);
  ok('each query is described by what it reads, not just raw SQL',
    (await page2.textContent('.v3-query-from')).includes('from '));
  ok('and can be previewed in place', (await page2.locator('[data-run="0"]').count()) === 1);
  ok('and refined into its own report', (await page2.locator('[data-refine="0"]').count()) === 1);
  await page2.click('[data-run="0"]');
  await page2.waitForFunction(() => {
    const r = document.querySelector('[data-result="0"]');
    return r && r.textContent && !/Running/.test(r.textContent);
  }, null, { timeout: 10000 });
  ok('previewing shows the columns it returns',
    (await page2.textContent('[data-result="0"]')).includes('day_date'));
  await page2.click('[data-query-index="1"]');
  await page2.waitForTimeout(500);
  ok('second widget added', (await page2.locator('.dw').count()) === 2);
  const w2 = await page2.evaluate(() => window.__siloDashboard.runtime.getWidgets()[1]);
  ok('widget bound to query index 1', w2.query_index === 1);
  ok('date dimension auto-suggests a line chart', w2.visual_type === 'line');

  // ── 7b. Semantic typing, grounded in the schema catalog ─────────────
  await page2.click('#btnAddWidget');
  await page2.waitForSelector('.v3-report-card');
  await page2.click('.v3-report-card[data-report="R3"]');
  await page2.waitForTimeout(700);
  const wSem = await page2.evaluate(() => {
    const rt = window.__siloDashboard.runtime;
    const w = rt.getWidgets().find((x) => x.report_id === 'R3');
    return { sem: rt.semanticsFor(w, rt.rowsFor(w.id)), cfg: w.visual_config, type: w.visual_type };
  });
  ok(`total_units is a COUNT, not currency (the original bug) [${wSem.sem.total_units}]`, wSem.sem.total_units === 'count');
  ok('net_sales is currency', wSem.sem.net_sales === 'currency');
  ok('conversion_rate is percent', wSem.sem.conversion_rate === 'percent');
  ok('product_title is a category', wSem.sem.product_title === 'category');
  ok('the measure picked is the currency column, not the id-ish one', wSem.cfg.y_field === 'net_sales');
  ok('currency defaults to sum', wSem.cfg.aggregate === 'sum');
  await page2.click('#btnCloseInspector');

  // ── 8. Broken source report ─────────────────────────────────────────
  // Point one widget at SQL the stub rejects, the way a saved report whose
  // schema moved under it would behave.
  await page2.evaluate(() => { window.__siloDashboard.runtime.getWidgets()[0].query_sql = 'select * from gone'; });
  await page2.evaluate(() => window.__siloDashboard.runtime.refresh());
  await page2.waitForTimeout(400);
  ok('a failing query shows an error state, not a blank tile',
    (await page2.locator('.dw-empty--error').count()) === 1);

  // ── 9. A central SILO definition becomes a widget, no Ask SILO involved ──
  await page2.click('#btnAddWidget');
  await page2.waitForSelector('.v3-report-card');
  await page2.click('.v3-report-card[data-report="S1"]');
  await page2.waitForTimeout(700);
  ok('system report added as another widget', (await page2.locator('.dw').count()) === 4);
  // By report_id, not index -- index-based lookups break every time a test
  // above adds a widget.
  const w3 = await page2.evaluate(() =>
    window.__siloDashboard.runtime.getWidgets().find((x) => x.report_id === 'S1'));
  ok('widget points at the system definition', w3.report_id === 'S1');
  ok('system report auto-suggests a line chart from its date column', w3.visual_type === 'line');
  ok('the system widget actually drew',
    (await page2.locator('.dw').nth(3).locator('canvas').count()) >= 1);
  await page2.click('#btnCloseInspector');

  // ── 10. A report that returns nested JSON ────────────────────────────
  await page2.click('#btnAddWidget');
  await page2.waitForSelector('.v3-report-card');
  await page2.click('.v3-report-card[data-report="R6"]');
  await page2.waitForTimeout(800);
  const jsonW = await page2.evaluate(() =>
    window.__siloDashboard.runtime.getWidgets().find(x => x.report_id === 'R6'));
  ok('a nested-JSON report is added as a TABLE, not a chart', jsonW && jsonW.visual_type === 'table');
  const jsonTile = page2.locator('.dw').filter({ hasText: 'Ad spend vs Online Sales' }).first();
  const jsonText = await jsonTile.textContent();
  ok('and its cells show the JSON, not [object Object]',
    !jsonText.includes('[object Object]') && jsonText.includes('total_spend'));
  await page2.click('#btnCloseInspector');

  // ── 11. The ROAS acceptance test: three measures, one chart ──────────
  await page2.click('#btnAddWidget');
  await page2.waitForSelector('.v3-report-card');
  await page2.click('.v3-report-card[data-report="R7"]');
  await page2.waitForTimeout(900);
  ok('the flat daily query auto-picks a line chart',
    (await page2.evaluate(() => window.__siloDashboard.runtime.getWidgets().find(x => x.report_id === 'R7').visual_type)) === 'line');
  ok('the inspector offers measures as multi-select',
    (await page2.locator('[data-measure]').count()) >= 3);
  // add the other two measures
  for (const m of ['ad_spend', 'roas']) {
    const box = page2.locator(`[data-measure="${m}"]`);
    if (!(await box.isChecked())) { await page2.click(`.rb-col:has([data-measure="${m}"])`); await page2.waitForTimeout(350); }
  }
  const cfg7 = await page2.evaluate(() =>
    window.__siloDashboard.runtime.getWidgets().find(x => x.report_id === 'R7').visual_config);
  ok('all three measures are stored: ' + JSON.stringify(cfg7.measures),
    (cfg7.measures || []).length === 3);
  const axes = await page2.evaluate(() => {
    const rt = window.__siloDashboard.runtime;
    const w = rt.getWidgets().find(x => x.report_id === 'R7');
    const sh = window.SiloChart.shape(rt.rowsFor(w.id), w.visual_config, rt.semanticsFor(w, rt.rowsFor(w.id)));
    return { series: sh.series.map(s => [s.field, s.axis]), second: sh.hasSecondAxis };
  });
  ok('roas gets its own axis: ' + JSON.stringify(axes.series), axes.second === true);
  // By widget id: two tiles have near-identical titles, and hasText is
  // case-insensitive, so it would grab the jsonb TABLE tile instead.
  const id7 = await page2.evaluate(() =>
    window.__siloDashboard.runtime.getWidgets().find(x => x.report_id === 'R7').id);
  const tile7 = page2.locator(`.dw[data-widget-id="${id7}"]`);
  ok('and the tile actually draws it', (await tile7.locator('canvas').count()) >= 1);
  // ECharts draws the legend on canvas, so assert on the option instead.
  const opt7 = await page2.evaluate(() => {
    const rt = window.__siloDashboard.runtime;
    const w = rt.getWidgets().find(x => x.report_id === 'R7');
    const rows = rt.rowsFor(w.id);
    const sh = window.SiloChart.shape(rows, w.visual_config, rt.semanticsFor(w, rows));
    const o = window.SiloChart.optionFor(w.visual_type, sh);
    return { series: o.series.length, legend: !!o.legend, axes: Array.isArray(o.yAxis) ? o.yAxis.length : 1,
             rightAxis: Array.isArray(o.yAxis) ? o.yAxis[1].position : null };
  });
  ok('three series, a legend and two axes: ' + JSON.stringify(opt7),
    opt7.series === 3 && opt7.legend && opt7.axes === 2 && opt7.rightAxis === 'right');
  await page2.click('#btnCloseInspector');

  ok('no uncaught page errors (edit page)', errors.length === 0 || (console.log(errors.slice(0, 6)), false));
  ok('no uncaught page errors (view page)', errors2.length === 0 || (console.log(errors2.slice(0, 6)), false));

  await suite.close();
  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
