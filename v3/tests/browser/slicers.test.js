/* Dashboard slicers: a report declares parameters, the header supplies
 * them, one control drives every tile sharing a key.
 *
 * The injection cases go at the RUNTIME (setParamValues) rather than through
 * the inputs on purpose: input[type=number] already refuses "1 or 1=1", so
 * typing it would prove nothing about the substitution layer. */
'use strict';
const { startSuite } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c, extra) => { checks++; if (c) console.log('  ok   ' + n); else { console.log('  FAIL ' + n + (extra ? '\n        ' + extra : '')); fails++; } };

const isoToday = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 900 } });
  const { BASE, ctx } = suite;
  const { page, errors } = await suite.newPage();

  const T = isoToday();

  // The stub DB resets per navigation unless asked to persist; this suite
  // seeds rows and then reloads, so it needs the DB to survive like a real
  // one would.
  await page.addInitScript(() => {
    try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch {}
  });

  // The stub persists only on writes through its own query builder, so a
  // test that seeds rows directly has to write the snapshot itself.
  const seed = (fn) => page.evaluate((body) => {
    // eslint-disable-next-line no-new-func
    new Function('db', body)(window.__FAKE_DB__);
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: window.__FAKE_DB__.dashboards,
      dashboard_widgets: window.__FAKE_DB__.dashboard_widgets,
      silo_chat_saved_reports: window.__FAKE_DB__.silo_chat_saved_reports,
    }));
  }, fn);

  // ── 1. A board with no parameters hides the slicer bar ───────────────
  await page.goto(`${BASE}/v3/dashboard.html?id=D1`);
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await seed(`db.dashboard_widgets.push({ id: 'W0', dashboard_id: 'D1', report_id: 'R1', query_index: 0,
      title: 'Plain', visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 });`);
  await page.reload();
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.waitForTimeout(400);
  ok('unparameterised board hides the slicer bar',
    await page.locator('#slicerBar').isHidden());

  // ── 2. Parameterised widgets raise the bar, unioned by key ───────────
  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'W1', dashboard_id: 'D1', report_id: 'P1', query_index: 0, title: 'KPIs',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 },
      { id: 'W2', dashboard_id: 'D1', report_id: 'P2', query_index: 0, title: 'Channels',
        visual_type: 'table', visual_config: {}, layout: { x: 6, y: 0, w: 6, h: 4 }, sort_order: 1 });`);
  await page.reload();
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await page.waitForTimeout(600);

  ok('parameterised board shows the slicer bar', await page.locator('#slicerBar').isVisible());

  const keys = await page.$$eval('#slicerFields [data-param]', (els) => els.map((e) => e.dataset.param));
  ok('one control per key, unioned across reports (grain once, not twice)',
    JSON.stringify(keys.sort()) === JSON.stringify(['grain', 'min_sales', 'report_date']),
    'got ' + JSON.stringify(keys));

  const grainOpts = await page.$$eval('#slicerFields [data-param="grain"] option', (o) => o.map((x) => x.value));
  ok('enum options are INTERSECTED so a pick cannot break a tile (no ytd)',
    JSON.stringify(grainOpts) === JSON.stringify(['day', 'week', 'month']),
    'got ' + JSON.stringify(grainOpts));

  // ── 3. First load already ran the resolved SQL ───────────────────────
  let calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
  ok('first load substituted the date default into real SQL',
    calls.includes(`select metric, current_period from k(d => date '${T}', g => 'week')`),
    'got ' + JSON.stringify(calls));
  ok('no {{token}} ever reached the RPC',
    !calls.some((q) => /\{\{/.test(q)), 'got ' + JSON.stringify(calls));
  ok('two widgets on the same params cost two queries, not more', calls.length === 2,
    'got ' + calls.length);

  // ── 4. Moving a slicer re-runs only the affected widgets ─────────────
  await page.evaluate(() => { window.__FAKE_DB__.rpcCalls.length = 0; });
  await page.selectOption('#slicerFields [data-param="grain"]', 'day');
  await page.waitForTimeout(600);
  calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
  ok('changing grain re-ran BOTH widgets that declare it', calls.length === 2, 'got ' + calls.length);
  ok('grain change reached the RPC as a quoted literal',
    calls.includes(`select metric, current_period from k(d => date '${T}', g => 'day')`),
    'got ' + JSON.stringify(calls));
  ok('the tile redrew with the new grain’s rows',
    (await page.locator('.dw').first().innerText()).includes('net_sales@day'));

  await page.evaluate(() => { window.__FAKE_DB__.rpcCalls.length = 0; });
  await page.fill('#slicerFields [data-param="min_sales"]', '500');
  await page.locator('#slicerFields [data-param="min_sales"]').press('Enter');
  await page.waitForTimeout(600);
  calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
  ok('a key only one widget declares re-runs only that widget', calls.length === 1, 'got ' + calls.length);

  // ── 5. Validation happens in the RUNTIME, not just in the input ──────
  // input[type=number] already refuses "1 or 1=1", so typing it proves
  // nothing about the substitution layer. These go straight at the runtime,
  // which is what a hostile client (or a bad saved filter_state) would hit.
  for (const [label, value, expect] of [
    ['a non-numeric number param', '1 or 1=1', /must be a number/i],
    ['a quote-break in a number param', "0) union select 1 --", /must be a number/i],
    ['an undeclared enum value', 'DROP', /must be one of/i],
  ]) {
    await page.evaluate(() => { window.__FAKE_DB__.rpcCalls.length = 0; });
    const key = label.includes('enum') ? 'grain' : 'min_sales';
    await page.evaluate(([k, v]) => window.__siloDashboard.runtime.setParamValues({ [k]: v }), [key, value]);
    await page.waitForTimeout(400);
    calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
    ok(`${label} never reaches the RPC`, calls.length === 0, 'got ' + JSON.stringify(calls));
    const body = await page.locator('.dw').allInnerTexts();
    ok(`${label} shows the reason on the tile`, expect.test(body.join(' ')),
      'got ' + body.join(' | ').slice(0, 160));
    // Put it back so the next case starts from a working board.
    await page.evaluate(([k, v]) => window.__siloDashboard.runtime.setParamValues({ [k]: v }),
      [key, key === 'grain' ? 'week' : '0']);
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.__siloDashboard.runtime.setParamValues({ grain: 'week', min_sales: '0' }));
  await page.waitForTimeout(300);

  // ── 6. Reset returns to the saved position ───────────────────────────
  await page.selectOption('#slicerFields [data-param="grain"]', 'day');
  await page.waitForTimeout(400);
  await page.click('#btnResetFilters');
  await page.waitForTimeout(600);
  const resetGrain = await page.inputValue('#slicerFields [data-param="grain"]');
  ok('Reset restores the declared defaults', resetGrain === 'week', 'got ' + resetGrain);

  // ── 7. Date presets store the TOKEN, not the resolved date ───────────
  await page.evaluate(() => { window.__FAKE_DB__.rpcCalls.length = 0; });
  await page.selectOption('#slicerFields [data-param="report_date"]', 'today-7d');
  await page.waitForTimeout(600);
  const stored = await page.evaluate(() => window.__siloDashboard.runtime.getParamValues().report_date);
  ok('a relative preset is stored as a token, so the board keeps rolling',
    stored === 'today-7d', 'got ' + stored);
  const d7 = new Date(); d7.setDate(d7.getDate() - 7);
  const p = (n) => String(n).padStart(2, '0');
  const want = `${d7.getFullYear()}-${p(d7.getMonth() + 1)}-${p(d7.getDate())}`;
  calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.map((c) => c.args.query));
  ok('…but the RPC got the resolved date',
    calls.some((q) => q.includes(`date '${want}'`)), 'got ' + JSON.stringify(calls));
  ok('the resolved date is shown next to the control',
    (await page.locator('#slicerBar').innerText()).includes(want));

  // ── 8. Saving persists filter_state; a viewer's change does not ──────
  await page.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
  await page.waitForFunction(() => window.__siloDashboard, { timeout: 10000 });
  await seed(`db.dashboard_widgets.length = 0;
    db.dashboard_widgets.push(
      { id: 'W1', dashboard_id: 'D1', report_id: 'P1', query_index: 0, title: 'KPIs',
        visual_type: 'table', visual_config: {}, layout: { x: 0, y: 0, w: 6, h: 4 }, sort_order: 0 });`);
  await page.reload();
  await page.waitForFunction(() => window.__siloDashboard && window.__siloDashboard.builder, { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.selectOption('#slicerFields [data-param="grain"]', 'month');
  await page.waitForTimeout(500);
  ok('a slicer change in edit mode marks the dashboard dirty',
    await page.evaluate(() => window.__siloDashboard.builder.isDirty()));
  await page.click('#btnSave');
  await page.waitForTimeout(700);
  const saved = await page.evaluate(() =>
    (window.__FAKE_DB__.dashboards.find((d) => d.id === 'D1') || {}).filter_state);
  ok('Save writes filter_state', saved && saved.grain === 'month',
    'got ' + JSON.stringify(saved));
  ok('filter_state stores only DECLARED keys',
    saved && Object.keys(saved).every((k) => ['grain', 'report_date', 'min_sales'].includes(k)),
    'got ' + JSON.stringify(saved));

  ok('no page errors throughout', errors.length === 0, errors.slice(0, 4).join('\n        '));

  console.log(`\n${checks - fails}/${checks} checks passed\n`);
  await suite.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
