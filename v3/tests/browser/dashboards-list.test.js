/* The Reports library (/v3/dashboards.html): three tabs -- SILO Reports, My
 * Reports, Dashboards -- over what RLS already lets the viewer read. A
 * missing dashboard id still says so rather than rendering an empty canvas. */
'use strict';
const { startSuite } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c) => { checks++; if (c) console.log('  ok   ' + n); else { console.log('  FAIL ' + n); fails++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 820 } });
  const { BASE } = suite;
  const { page: p, errors: errs } = await suite.newPage();
  const ids = (sel) => p.$$eval(sel, (els) => els.map((e) => e.dataset.id));
  const visibleCards = (pane) => p.locator(`#${pane} .lib-card`).count();

  await p.goto(`${BASE}/v3/dashboards.html`);
  await p.waitForSelector('#siloBody .lib-card', { timeout: 10000 });

  // ── Naming and navigation ─────────────────────────────────────────────
  ok('heading reads Reports', (await p.textContent('#hubTitle')).trim() === 'Reports');
  ok('the sidebar row is labelled Reports',
    (await p.textContent('.silo-sb-link[data-nav-id="reports/dashboards"]')).includes('Reports'));
  ok('the separate saved-report library row is gone (the tabs replace it)',
    (await p.locator('.silo-sb-link[data-nav-id="reports/library"]').count()) === 0);
  ok('the report builder row stays',
    (await p.locator('.silo-sb-link[data-nav-id="reports/builder"]').count()) === 1);
  const tabs = await p.$$eval('#libTabs [role="tab"]', (els) => els.map((e) => e.dataset.tab));
  ok('three tabs, in order', tabs.join() === 'silo,mine,dashboards');
  ok('defaults to SILO Reports', (await p.getAttribute('#tab-silo', 'aria-selected')) === 'true');
  ok('...and only its pane is shown', !(await p.isHidden('#pane-silo'))
    && await p.isHidden('#pane-mine') && await p.isHidden('#pane-dashboards'));

  // ── Classification: every report in exactly one tab ───────────────────
  const db = await p.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports
    .map((r) => ({ id: r.id, silo: r.source === 'system' && r.company_entity_id == null })));
  const silo = await ids('#siloBody .lib-card');
  ok('SILO Reports holds exactly the global system reports',
    silo.slice().sort().join() === db.filter((r) => r.silo).map((r) => r.id).sort().join());
  ok('SILO cards carry no SILO/Global/query-count badges',
    (await p.locator('#siloBody .lib-card .bcn-pill').count()) === 0);
  ok('a SILO card opens the report builder (open/copy lives there)',
    /\/v3\/report-builder\.html\?id=/.test(await p.getAttribute('#siloBody .lib-link', 'href')));

  await p.click('#tab-mine');
  await p.waitForSelector('#mineBody .lib-card');
  const mine = await ids('#mineBody .lib-card');
  ok('My Reports holds every other readable report, company-shared included',
    mine.slice().sort().join() === db.filter((r) => !r.silo).map((r) => r.id).sort().join());
  ok('no report appears in both tabs', !mine.some((id) => silo.includes(id)));
  ok('custom reports keep their visibility badge',
    (await p.textContent('#mineBody .lib-card[data-id="R1"]')).includes('Company'));
  ok('New report is the contextual action here', await p.isVisible('#btnNewReport')
    && await p.isHidden('#btnNew'));
  ok('Ask SILO stays available as the secondary action', await p.isVisible('#btnAskSilo'));
  ok('the tab is in the URL', new URL(p.url()).searchParams.get('tab') === 'mine');

  // ── Details affordance ────────────────────────────────────────────────
  const det = p.locator('#mineBody .lib-card[data-id="R1"] .lib-details-btn');
  ok('Details starts collapsed', (await det.getAttribute('aria-expanded')) === 'false');
  await det.click();
  ok('Details expands in place', (await det.getAttribute('aria-expanded')) === 'true'
    && await p.isVisible('#mineBody .lib-card[data-id="R1"] .lib-details'));

  // ── Search is scoped to the active tab ────────────────────────────────
  await p.fill('#librarySearch', 'Daily sales');
  await p.waitForTimeout(150);
  const hits = await ids('#mineBody .lib-card');
  ok('search filters My Reports', hits.includes('R2') && !hits.includes('R1') && hits.length < mine.length);
  await p.fill('#librarySearch', 'zzzz-nothing-matches');
  await p.waitForTimeout(150);
  ok('no-result state names the tab', (await p.textContent('#mineBody')).includes('No reports match'));
  await p.click('#mineBody [data-clear-search]');
  ok('Clear search restores the list', (await visibleCards('mineBody')) === mine.length);
  await p.fill('#librarySearch', 'zzzz-nothing-matches');
  await p.click('#tab-silo');
  ok('switching tab clears the search', (await p.inputValue('#librarySearch')) === ''
    && (await visibleCards('siloBody')) === silo.length);

  // ── URL state survives reload and back ────────────────────────────────
  await p.click('#tab-dashboards');
  await p.waitForSelector('#listBody .lib-card');
  await p.reload();
  await p.waitForSelector('#listBody .lib-card', { timeout: 10000 });
  ok('reload returns to the same tab', (await p.getAttribute('#tab-dashboards', 'aria-selected')) === 'true');
  await Promise.all([p.waitForURL(/dashboard\.html\?id=D1/), p.click('#listBody .lib-link')]);
  ok('a dashboard card opens the canvas', /\/v3\/dashboard\.html\?id=D1$/.test(p.url()));
  await p.goBack();
  await p.waitForSelector('#listBody .lib-card', { timeout: 10000 });
  ok('Back returns to the Dashboards tab', (await p.getAttribute('#tab-dashboards', 'aria-selected')) === 'true');
  await p.goto(`${BASE}/v3/dashboards.html?tab=reports`);
  await p.waitForSelector('#mineBody .lib-card', { timeout: 10000 });
  ok('the old ?tab=reports link lands on My Reports',
    (await p.getAttribute('#tab-mine', 'aria-selected')) === 'true');

  // ── Keyboard ──────────────────────────────────────────────────────────
  await p.focus('#tab-mine');
  await p.keyboard.press('ArrowRight');
  ok('arrow keys move between tabs', (await p.getAttribute('#tab-dashboards', 'aria-selected')) === 'true');
  ok('a card title is a real, focusable link', (await p.locator('#listBody .lib-card a.lib-link').count()) === 1);
  ok('titles are not underlined at rest',
    (await p.$eval('#listBody .lib-link', (a) => getComputedStyle(a).textDecorationLine)) === 'none');

  // ── Dashboards: create flow ───────────────────────────────────────────
  ok('the seeded dashboard is listed', (await p.textContent('#listBody .lib-title')).trim() === 'Monday sales review');
  await p.click('#btnNew'); await p.waitForTimeout(200);
  ok('new-dashboard modal opens', await p.isVisible('#newBackdrop.open'));
  await p.click('#btnCreate');
  await p.waitForTimeout(200);
  ok('empty name is rejected', (await p.textContent('#status')).includes('Give the dashboard a name'));
  await p.fill('#newName', 'Ops daily');
  await p.fill('#newDescription', 'Yesterday at a glance');
  await Promise.all([p.waitForURL(/dashboard\.html\?id=D2&edit=1/, { timeout: 8000 }), p.click('#btnCreate')]);
  ok('create routes straight into edit mode', /dashboard\.html\?id=D2&edit=1/.test(p.url()));
  // The stub DB is per-page, so D2 does not survive the navigation -- which
  // makes this the not-found path, and worth asserting on its own.
  await p.waitForSelector('#status:not([hidden])', { timeout: 10000 });
  ok('unknown dashboard id explains itself', (await p.textContent('#status')).includes('does not exist'));
  ok('not-found does not show a blank canvas prompt', await p.isHidden('#blank'));
  ok('not-found hides edit affordances', await p.isHidden('#btnEdit') && await p.isHidden('#btnAddWidget'));

  // ── Phone width ───────────────────────────────────────────────────────
  const phone = await suite.newContext({ viewport: { width: 390, height: 844 } });
  const m = await phone.newPage();
  await m.goto(`${BASE}/v3/dashboards.html`);
  await m.waitForSelector('#siloBody .lib-card', { timeout: 10000 });
  ok('no horizontal scroll at phone width',
    await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.close();

  ok('no page errors', errs.length === 0 || (console.log(errs.slice(0, 5)), false));
  await suite.close();
  console.log(`\n${checks - fails}/${checks} checks passed`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
