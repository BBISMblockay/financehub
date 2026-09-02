/* Editing a saved report.
 *
 * The property under test is not "the form loads". It is that the page is
 * honest about three things BEFORE anyone types:
 *   - whether this save will overwrite the original or fork it
 *   - how many tiles the save changes
 *   - which of those tiles the save breaks
 *
 * A builder that gets any of those wrong sends people back to saving a
 * second report, which is the library rot this whole change exists to stop.
 */
'use strict';
const { startSuite } = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n + (x ? '  [' + x + ']' : '')); fail++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 940 } });
  const { BASE } = suite;
  const { page: p, errors: errs } = await suite.newPage();
  // The blast-radius assertions need widgets to exist BEFORE the page loads
  // (usage is fetched once, at load), and the stub DB otherwise resets on
  // every navigation the way a real one would not.
  await p.addInitScript(() => { try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch { /* ignore */ } });
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  const openReport = async (id) => {
    await p.goto(`${BASE}/v3/report-builder.html?id=${id}`);
    await p.waitForSelector('.rb-src', { timeout: 15000 });
    await p.waitForTimeout(600);
  };

  // ── A guided report reopens GUIDED ─────────────────────────────────
  console.log('\n── reopening a guided report ──');
  await openReport('R10');
  ok('the page says it is editing, not creating',
     (await p.textContent('#pageTitle')) === 'Edit report');
  ok('and names the report it is editing',
     (await p.textContent('#pageSub')).includes('Spend by platform'));
  ok('the breadcrumb agrees with the heading — the chrome mounts before the report is known',
     (await p.textContent('.silo-crumbs .crumb-last')) === 'Edit report',
     await p.textContent('.silo-crumbs .crumb-last'));
  ok('the BUILD tab is active, not SQL — a guided report must not reopen as a wall of SQL',
     await p.locator('#paneBuild').isVisible() && !(await p.locator('#paneSql').isVisible()));

  const st = await p.evaluate(() => {
    const b = window.__siloReportBuilder;
    return { rel: b.source && b.source.relname, cfg: b.cfg, editing: !!b.editing };
  });
  ok('the source is restored', st.rel === 'meta_ad_performance_daily', st.rel);
  ok('the dimensions are restored', JSON.stringify(st.cfg.dimensions) === '["platform"]',
     JSON.stringify(st.cfg.dimensions));
  ok('the measures are restored',
     st.cfg.measures.length === 1 && st.cfg.measures[0].column === 'spend'
       && st.cfg.measures[0].agg === 'sum',
     JSON.stringify(st.cfg.measures));
  ok('summarise survived the round trip', st.cfg.summarise === true);
  ok('the parameter declarations are restored',
     st.cfg.parameters.length === 1 && st.cfg.parameters[0].key === 'date_from',
     JSON.stringify(st.cfg.parameters));

  // The save dialog is pre-filled from the report, not blank.
  ok('the title is pre-filled', (await p.inputValue('#saveName')) === 'Spend by platform');
  ok('the visibility is pre-filled', (await p.inputValue('#saveVis')) === 'company');

  // ── Blast radius ───────────────────────────────────────────────────
  console.log('\n── what the edit will change ──');
  // Put two tiles on a dashboard that draw this report, one of them naming a
  // column, then reopen. The count has to come from the RPC, not from what
  // this user's own dashboards happen to show.
  await p.evaluate(() => {
    const db = window.__FAKE_DB__;
    db.dashboards[0].filter_state = { date_from: '2026-08-01' };
    db.dashboard_widgets.push(
      { id: 'W1', dashboard_id: 'D1', report_id: 'R10', query_index: 0, title: 'Spend',
        visual_type: 'bar', visual_config: { x_field: 'platform', y_field: 'sum_spend' },
        layout: { x: 0, y: 0, w: 6, h: 3 } },
      { id: 'W2', dashboard_id: 'D1', report_id: 'R10', query_index: 0, title: 'Spend table',
        visual_type: 'table', visual_config: { columns: ['platform', 'sum_spend'] },
        layout: { x: 6, y: 0, w: 6, h: 3 } });
    // The stub persists on ITS OWN writes; these were poked in directly, so
    // snapshot them by hand or the next navigation loses them.
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
      silo_chat_saved_reports: db.silo_chat_saved_reports }));
  });
  await openReport('R10');
  await p.click('#btnPreview');
  await p.waitForTimeout(700);
  await p.click('#btnSave');
  await p.waitForTimeout(400);
  let impact = await p.textContent('#impactPanel');
  ok('the save dialog states how many tiles the edit changes: ' + JSON.stringify(impact.slice(0, 80)),
     /2 tiles/.test(impact));
  ok('...and across how many dashboards', /1 dashboard/.test(impact));
  ok('a call actually went to saved_report_usage — the count is tenant-complete, not "what I can see"',
     await p.evaluate(() => window.__FAKE_DB__.rpcCalls.some((c) => c.name === 'saved_report_usage')));
  await p.click('#btnCancelSave');

  // Now drop the measure those tiles draw. The tile keeps rendering and
  // silently shows nothing, so the editor has to name the column.
  await p.evaluate(() => {
    const b = window.__siloReportBuilder;
    b.cfg.measures.length = 0;
    b.cfg.dimensions.length = 0;
    b.cfg.summarise = false;
  });
  await p.click('#btnPreview');
  await p.waitForTimeout(700);
  await p.click('#btnSave');
  await p.waitForTimeout(400);
  impact = await p.textContent('#impactPanel');
  ok('dropping a column tiles draw is called out BY NAME: ' + JSON.stringify(impact.slice(-160)),
     /sum_spend/.test(impact) && /render empty/.test(impact));
  await p.click('#btnCancelSave');

  // Undeclaring a parameter the board still supplies.
  await p.evaluate(() => {
    const b = window.__siloReportBuilder;
    b.cfg.parameters.length = 0;
    b.renderParams();
  });
  await p.click('#btnSave');
  await p.waitForTimeout(300);
  impact = await p.textContent('#impactPanel');
  ok('undeclaring a parameter a dashboard supplies is called out: ' + JSON.stringify(impact.slice(-140)),
     /date_from/.test(impact));
  await p.click('#btnCancelSave');

  // ── Saving over the original ───────────────────────────────────────
  console.log('\n── saving ──');
  await openReport('R10');
  await p.click('#btnPreview');
  await p.waitForTimeout(700);
  await p.click('#btnSave');
  await p.waitForTimeout(300);
  await p.fill('#saveDesc', 'Now with a description');
  await p.click('#btnConfirmSave');
  await p.waitForTimeout(500);
  const after = await p.evaluate(() => {
    const db = window.__FAKE_DB__;
    return { n: db.silo_chat_saved_reports.length,
             r: db.silo_chat_saved_reports.find((x) => x.id === 'R10') };
  });
  ok('an edit UPDATES — it does not mint a second report (this is the whole point)',
     after.n === (await p.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports.length)));
  ok('the change landed on the original row', after.r.description === 'Now with a description');
  ok('builder_config is written back, so the NEXT edit is guided too',
     !!(after.r.builder_config && after.r.builder_config.relname === 'meta_ad_performance_daily'),
     JSON.stringify(after.r.builder_config || null));
  ok('the status names the tiles that just changed',
     /tiles now draw/.test(await p.textContent('#status')),
     await p.textContent('#status'));

  // ── Hand-edited SQL drops the guided scaffolding ───────────────────
  console.log('\n── guided config is scaffolding, not truth ──');
  await openReport('R10');
  await p.click('[data-tab="sql"]');
  await p.fill('#sqlText', 'select day_date, net_sales from t1');
  await p.waitForTimeout(200);
  await p.click('#btnPreview');
  await p.waitForTimeout(700);
  const payload = await p.evaluate(() => window.__siloReportBuilder.reportPayload());
  ok('hand-editing the SQL clears builder_config — otherwise the next edit regenerates '
     + 'a query this report does not run', payload.builder_config === null,
     JSON.stringify(payload.builder_config));
  ok('and the SQL that was typed is what gets saved',
     payload.queries_run[0] === 'select day_date, net_sales from t1', payload.queries_run[0]);

  // ── Someone else's report ──────────────────────────────────────────
  // Two different people, because the answer differs by role and both
  // answers matter: an owner correcting a colleague's shared report is the
  // whole point of exec write access, and an admin must not be handed a
  // Save button that RLS will refuse.
  console.log('\n── someone else\'s report, as an owner ──');
  await openReport('R11');
  ok('an owner CAN edit a colleague\'s report — that is what exec write access is for',
     (await p.textContent('#pageTitle')) === 'Edit report',
     await p.textContent('#pageTitle'));

  console.log('\n── the same report, as an admin ──');
  await p.evaluate(() => {
    const db = window.__FAKE_DB__;
    db.profiles[0].role = 'admin';
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
      silo_chat_saved_reports: db.silo_chat_saved_reports, profiles: db.profiles }));
  });
  await openReport('R11');
  ok('the page says up front that it is read-only',
     (await p.textContent('#pageTitle')).includes('read-only'),
     await p.textContent('#pageTitle'));
  ok('and the primary button offers a copy rather than a Save that would fail',
     (await p.textContent('#btnSave')).includes('copy'), await p.textContent('#btnSave'));
  ok('the status explains whose it is and what saving does',
     /belongs to someone else/.test(await p.textContent('#status')),
     await p.textContent('#status'));
  ok('a multi-query chat report opens on the SQL tab — there is no guided config to restore',
     await p.locator('#paneSql').isVisible());

  await p.click('#btnPreview');
  await p.waitForTimeout(700);
  await p.click('#btnSave');
  await p.waitForTimeout(300);
  await p.click('#btnConfirmSave');
  await p.waitForTimeout(600);
  const forked = await p.evaluate(() => {
    const db = window.__FAKE_DB__;
    return { orig: db.silo_chat_saved_reports.find((x) => x.id === 'R11'),
             copies: db.silo_chat_saved_reports.filter((x) => /Jon's launch recap/.test(x.title)) };
  });
  ok('the original is untouched', forked.orig.created_by === 'U9' && !forked.orig.description);
  ok('a copy was created instead', forked.copies.length === 2, String(forked.copies.length));
  ok('the copy is named as a copy, so two identical titles never sit in the list',
     forked.copies.some((c) => /\(copy\)/.test(c.title)),
     forked.copies.map((c) => c.title).join(' | '));
  ok('the copy is `manual` — a hand-edited fork of a chat answer is not a chat answer',
     forked.copies.filter((c) => c.id !== 'R11').every((c) => c.source === 'manual'));
  ok('the page becomes an editor for the COPY, so the next save updates it rather than minting a third',
     /[?&]id=/.test(p.url()) && !/[?&]id=R11(&|$)/.test(p.url()), p.url());

  await p.evaluate(() => {
    const db = window.__FAKE_DB__;
    db.profiles[0].role = 'owner';
    sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
      dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
      silo_chat_saved_reports: db.silo_chat_saved_reports, profiles: db.profiles }));
  });

  // ── A central system definition ────────────────────────────────────
  console.log('\n── a central SILO definition ──');
  await openReport('R12');
  ok('a system report is read-only for everyone, including its own company',
     (await p.textContent('#pageTitle')).includes('read-only'));
  ok('and says it is shared by every company',
     /every company/.test(await p.textContent('#status')),
     await p.textContent('#status'));

  // ── A report that no longer exists ─────────────────────────────────
  console.log('\n── a broken link ──');
  await openReport('R-does-not-exist');
  ok('a missing report degrades to a NEW report rather than a dead page',
     /could not be opened/.test(await p.textContent('#status')),
     await p.textContent('#status'));
  ok('...and the page is usable', (await p.locator('.rb-src').count()) > 0);

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await suite.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
