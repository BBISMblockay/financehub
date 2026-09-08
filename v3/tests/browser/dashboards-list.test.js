/* The dashboards index: lists what exists, and a missing id says so rather
 * than rendering an empty canvas. */
'use strict';
const { startSuite } = require('../lib/harness');

let fails = 0, checks = 0;
const ok = (n, c) => { checks++; if (c) console.log('  ok   ' + n); else { console.log('  FAIL ' + n); fails++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 820 } });
  const { BASE, ctx } = suite;
  const { page: p, errors: errs } = await suite.newPage();
 p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
 await p.goto(`${BASE}/v3/dashboards.html`);
 await p.waitForSelector('.v3-dash-card',{timeout:10000});
 ok('lists the seeded dashboard',(await p.locator('.v3-dash-card').count())===1);
 ok('card names it',(await p.textContent('.v3-dash-name'))==='Monday sales review');
 ok('card links to the canvas',(await p.getAttribute('.v3-dash-card','href'))==='/v3/dashboard.html?id=D1');
 // The Reports section is now three rows -- open a board, find a
 // definition, build a new one -- still behind the same EXEC_ROLES
 // soft-launch gate the previously commented-out row carried. The fake
 // profile is an owner, so all three are visible here.
 ok('Reports is in the nav for an exec/owner',
   (await p.locator('.silo-sb-link[data-nav-id="reports/dashboards"]').count())===1);
 ok('...alongside the saved-report library',
   (await p.locator('.silo-sb-link[data-nav-id="reports/library"]').count())===1);
 ok('...and the report builder',
   (await p.locator('.silo-sb-link[data-nav-id="reports/builder"]').count())===1);
 ok('the page still works either way',await p.isVisible('.v3-dash-card'));
 // ── The saved-report library tab ─────────────────────────────────────
 await p.click('[data-pane="reports"]');
 await p.waitForTimeout(400);
 ok('the library tab shows saved reports',(await p.locator('#paneReports:not([hidden])').count())===1);
 // .bcn-card sets `display: flex`, which beats the UA's [hidden] rule --
 // without an explicit override the Dashboards pane stays on screen
 // underneath. Same trap this stylesheet already documents twice.
 ok('...and the dashboards pane is actually hidden, not merely marked',
   await p.isHidden('#paneDashboards'));
 ok('...and every saved report is listed, whatever its source',
   (await p.locator('#reportBody .v3-report-card').count())>=1);
 ok('...each linking to the builder rather than to a dashboard',
   /report-builder\.html\?id=/.test(await p.getAttribute('#reportBody .v3-report-card','href')));
 await p.fill('#reportSearch','zzzz-nothing-matches');
 await p.waitForTimeout(200);
 ok('filtering says so rather than showing an empty box',
   (await p.textContent('#reportBody')).includes('Nothing matches'));
 await p.fill('#reportSearch','');
 await p.click('[data-pane="dashboards"]');
 await p.waitForTimeout(200);

 await p.click('#btnNew'); await p.waitForTimeout(200);
 ok('new-dashboard modal opens',await p.isVisible('#newBackdrop.open'));
 await p.click('#btnCreate');
 await p.waitForTimeout(200);
 ok('empty name is rejected',(await p.textContent('#status')).includes('Give the dashboard a name'));
 await p.fill('#newName','Ops daily');
 await p.fill('#newDescription','Yesterday at a glance');
 await Promise.all([p.waitForURL(/dashboard\.html\?id=D2&edit=1/,{timeout:8000}),p.click('#btnCreate')]);
 ok('create routes straight into edit mode',/dashboard\.html\?id=D2&edit=1/.test(p.url()));
 // The stub DB is per-page, so D2 does not survive the navigation -- which
 // makes this the not-found path, and worth asserting on its own.
 await p.waitForSelector('#status:not([hidden])',{timeout:10000});
 ok('unknown dashboard id explains itself',(await p.textContent('#status')).includes('does not exist'));
 ok('not-found does not show a blank canvas prompt',await p.isHidden('#blank'));
 ok('not-found hides edit affordances',await p.isHidden('#btnEdit')&&await p.isHidden('#btnAddWidget'));
 ok('no page errors',errs.length===0||(console.log(errs.slice(0,5)),false));
 await suite.close();
 console.log(`\n${checks-fails}/${checks} checks passed`); process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
