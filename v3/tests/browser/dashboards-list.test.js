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
 ok('hidden from nav while in testing',(await p.locator('.silo-sb-link[data-nav-id="reports/dashboards"]').count())===0);
 ok('...and the page still works without a nav entry',await p.isVisible('.v3-dash-card'));
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
