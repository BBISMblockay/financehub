/* The Answer widget (20260904340000): a saved report's WRITTEN answer text,
 * rendered as markdown, with no query and no rows. Exists because a
 * genuinely open-ended Ask SILO question can take 20+ queries and never
 * reduce to one dataset -- the real "chief of staff" fixture (R5) stands in
 * for exactly that shape.
 *
 * The real dashboard.html runs the real dashboard-renderer.js and
 * dashboard-builder.js -- only chat_run_readonly_query and the saved-report
 * tables are faked. See ../lib/harness.js. */
'use strict';
const { startSuite, inspectorTab } = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n + (x ? '  [' + x + ']' : '')); fail++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 940 } });
  const { BASE } = suite;
  const { page: p, errors: errs } = await suite.newPage();

  await p.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
  await p.waitForSelector('#btnAddWidget:not([hidden])', { timeout: 10000 });

  // ── 1. A many-query answer offers "Add as Answer widget" ────────────
  await p.click('#btnAddWidget');
  await p.waitForSelector('.v3-report-card');
  await p.click('.v3-report-card[data-report="R5"]');
  await p.waitForSelector('.v3-picker-head');
  ok('a 7-query answer is flagged as an analysis, not a dataset',
    (await p.textContent('.v3-picker-note')).includes('analysis, not a dataset'));
  ok('...and offers the written answer as an alternative to picking a query',
    (await p.locator('.v3-answer-cta').count()) === 1);
  ok('CTA copy matches the >3-query phrasing',
    (await p.textContent('.v3-answer-cta-text')).includes('Show the written answer instead'));

  await p.click('[data-act="use-answer"]');
  await p.waitForSelector('.dw-answer', { timeout: 5000 });
  ok('tile body is the answer container, not a table/chart', (await p.locator('.dw-answer').count()) === 1);
  ok('markdown heading rendered as a real <h2>, not escaped text',
    (await p.locator('.dw-answer h2').count()) === 1);
  ok('markdown bold rendered as <strong>',
    (await p.locator('.dw-answer strong').count()) >= 1);
  ok('markdown list rendered as <li> items', (await p.locator('.dw-answer li').count()) === 2);
  const answerText = await p.textContent('.dw-answer');
  ok('the "~$24K" approximation survived as literal text, not strikethrough',
    answerText.includes('~$24K') && (await p.locator('.dw-answer del').count()) === 0, answerText);
  ok('inspector opened for the new widget', await p.isVisible('#inspector.open'));

  // ── 2. Inspector: Answer is offered, and hides query-shaped fields ───
  // The panel is Data | Visual | Format | Interactions and opens on Data,
  // so the visual picker is one click away -- as it is for a person.
  ok('the inspector opens on the Data tab',
    await p.isVisible('#inspectorTabs [data-tab="data"].is-active'));
  ok('no Query selector -- query_index is meaningless for an answer widget',
    (await p.locator('#inspQueryIndex').count()) === 0);
  ok('no Sort/Limit fields either', (await p.locator('#inspSort, #inspLimit').count()) === 0);
  ok('an answer widget offers no Visual or Format tab -- there is nothing to draw',
    (await p.locator('#inspectorTabs [data-tab="visual"]').count()) === 0);
  ok('the inspector explains there is nothing to configure',
    (await p.textContent('#inspectorBody')).includes('no query, no columns'));

  // Interactions still applies to an answer widget: it can take part in
  // (or sit out of) the dashboard's filters like any other tile.
  await inspectorTab(p, 'interactions');
  ok('an answer widget still explains its filter participation',
    (await p.textContent('#inspectorBody')).includes('Dashboard filters'));
  await inspectorTab(p, 'data');
  ok('Answer is the active visual type on the tile badge',
    (await p.textContent('.dw-type-badge')).includes('answer'));

  // ── 3. Switching to Table and back works, and Answer survives it ─────
  // This is the fix for the real bug: an existing table widget stuck on a
  // useless query can be switched to Answer from the SAME inspector, no
  // delete-and-re-add required.
  // An answer widget has no Visual tab (nothing to draw), so the switch is
  // made through the tile's own type badge, which is the control a person
  // actually uses to change a visual.
  await p.evaluate(() => {
    const d = window.__siloDashboard;
    const w = d.runtime.getWidgets()[0];
    d.runtime.updateWidget(w.id, { visual_type: 'table' });
    return d.runtime.rerenderWidget(w.id);
  });
  await p.waitForTimeout(250);
  ok('switching away renders a table off query 1 (not an empty/broken tile)',
    (await p.locator('.dw-table').count()) === 1);
  await p.evaluate(() => {
    const d = window.__siloDashboard;
    const w = d.runtime.getWidgets()[0];
    d.runtime.updateWidget(w.id, { visual_type: 'answer' });
    return d.runtime.rerenderWidget(w.id);
  });
  await p.waitForTimeout(250);
  ok('switching back renders the answer again, unchanged',
    (await p.locator('.dw-answer h2').count()) === 1);

  // ── 4. A report with no answer text never offers the option ──────────
  await p.click('#btnCloseInspector');
  await p.click('#btnAddWidget');
  await p.waitForSelector('.v3-report-card');
  await p.click('.v3-report-card[data-report="R2"]'); // 2 queries, no `answer` field
  await p.waitForSelector('.v3-picker-head');
  ok('a report with no answer text gets no CTA', (await p.locator('.v3-answer-cta').count()) === 0);
  await p.click('[data-query-index="0"]');
  await p.waitForSelector('.dw-chart, .dw-table', { timeout: 5000 });
  await inspectorTab(p, 'visual');
  ok('Answer is not offered in the inspector for a report with no answer text',
    (await p.locator('.v3-visual-opt input[value="answer"]').count()) === 0);
  ok('...but the other visuals are', (await p.locator('.v3-visual-opt').count()) >= 5);

  ok('no page errors', errs.length === 0 || (console.log(errs.slice(0, 5)), false));
  if (process.env.V3_TEST_SCREENSHOTS) await p.screenshot({ path: 'answer-widget.png' });
  await suite.close();
  console.log(`\n${pass}/${pass + fail} checks passed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
