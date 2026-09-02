/* The Ask SILO -> dashboard hop: save an answer as a report, land on the
 * canvas with it already added.
 *
 * The Ask SILO page pulls in marked/dompurify to render answers; neither is
 * under test, so both are stubbed. */
'use strict';
const { startSuite } = require('../lib/harness');

const STUB = (body) => ({ contentType: 'text/javascript', body });
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n); fail++; } };

(async () => {
  const suite = await startSuite({
    viewport: { width: 1440, height: 900 },
    extraRoutes: {
      '**/marked**': STUB('window.marked={parse:s=>s};'),
      '**/dompurify**': STUB('window.DOMPurify={sanitize:s=>s};'),
      '**/purify**': STUB('window.DOMPurify={sanitize:s=>s};'),
    },
  });
  const { BASE, ctx } = suite;
  const { page: p, errors: errs } = await suite.newPage();
 p.on('pageerror',e=>errs.push(String(e)));

 // ── Ask SILO: reach the save dialog the way a user does ──
 // Seed the chat history sessionStorage key, so the page's own
 // restoreHistoryFromSession() renders a real assistant message with a real
 // "Save report" button. No test hooks in production code.
 await p.addInitScript(() => {
   sessionStorage.setItem('silo_chat_history_v1', JSON.stringify([
     { role: 'user', content: 'What were our top products last 30 days?' },
     { role: 'assistant', content: 'Top products are...',
       queries: ['select product_title, net_sales, units from sales'] },
   ]));
 });
 await p.goto(`${BASE}/v2/silo-chat.html`);
 await p.waitForSelector('[data-save-id]', { timeout: 15000 });
 ok('a restored answer offers "Save report"', (await p.locator('[data-save-id]').count()) >= 1);
 await p.click('[data-save-id]');
 await p.waitForSelector('#saveDialogBackdrop.open', { timeout: 5000 });
 await p.waitForTimeout(700);
 ok('the save dialog offers a dashboard target', await p.isVisible('#saveDialogDashboard'));
 const opts = await p.$$eval('#saveDialogDashboard option', os => os.map(o => o.textContent.trim()));
 ok('it lists existing dashboards and a "new" option: ' + JSON.stringify(opts),
    opts.length >= 2 && opts.some(o => o.includes('New dashboard')));
 ok('default is "just save" so nothing changes for people who ignore it',
    (await p.inputValue('#saveDialogDashboard')) === '');
 ok('new-dashboard name field starts hidden', await p.isHidden('#saveDialogNewDashWrap'));
 await p.selectOption('#saveDialogDashboard', '__new__');
 await p.waitForTimeout(250);
 ok('picking "New dashboard" reveals the name field', await p.isVisible('#saveDialogNewDashWrap'));
 ok('button says what it will do', (await p.textContent('#btnConfirmSave')).includes('open dashboard'));
 await p.selectOption('#saveDialogDashboard', '');
 await p.waitForTimeout(200);
 ok('and reverts when you pick "just save"', (await p.textContent('#btnConfirmSave')).trim() === 'Save');

 // Full round trip: pick the existing dashboard and save.
 await p.selectOption('#saveDialogDashboard', 'D1');
 await p.fill('#saveDialogName', 'Top products 30d');
 const navUrls = [];
 p.on('framenavigated', f => { if (f === p.mainFrame()) navUrls.push(f.url()); });
 await Promise.all([
   p.waitForURL(/\/v3\/dashboard\.html/, { timeout: 10000 }),
   p.click('#btnConfirmSave'),
 ]);
 ok('saving hands off to the dashboard carrying the new report id',
    navUrls.some(u => /\/v3\/dashboard\.html\?id=D1&edit=1&add_report=/.test(u)));
 ok('the report really was saved first',
    (await p.evaluate(() => window.__FAKE_DB__ ? window.__FAKE_DB__.silo_chat_saved_reports.length : 0)) >= 4);

 // ── The receiving end: /v3/dashboard.html?...&add_report=R1 ──
 const p2=await ctx.newPage(); const errs2=[];
 p2.on('pageerror',e=>errs2.push(String(e)));
 // Persist the stub DB across the reload below, the way a real DB would.
 await p2.addInitScript(()=>{ try{ sessionStorage.setItem('__PERSIST_FAKE_DB__','1'); }catch{} });
 await p2.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=R1`);
 await p2.waitForSelector('.dw',{timeout:15000});
 await p2.waitForTimeout(900);
 ok('the handed-off report lands as a widget', (await p2.locator('.dw').count())===1);
 const w = await p2.evaluate(()=>window.__siloDashboard.runtime.getWidgets()[0]);
 ok('bound to the right report', w.report_id==='R1');
 ok('a visual was recommended, not left as a table', w.visual_type==='bar');
 ok('it drew', (await p2.locator('.dw-chart canvas').count())>=1);
 ok('it was SAVED, not left dirty', !(await p2.textContent('#btnSave')).includes('•'));
 ok('persisted to the widget table', (await p2.evaluate(()=>window.__FAKE_DB__.dashboard_widgets.length))===1);
 ok('add_report stripped from the URL so a refresh cannot duplicate it',
    !p2.url().includes('add_report'));

 // ── refresh must not add a second copy ──
 await p2.reload();
 await p2.waitForSelector('.dw',{timeout:15000});
 await p2.waitForTimeout(500);
 ok('after refresh there is still exactly one tile', (await p2.locator('.dw').count())===1);

 // ── a multi-query report says which query it took ──
 const p3=await ctx.newPage();
 await p3.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=R2`);
 await p3.waitForSelector('.dw',{timeout:15000});
 await p3.waitForTimeout(900);
 const w3=await p3.evaluate(()=>window.__siloDashboard.runtime.getWidgets().find(x=>x.report_id==='R2'));
 // Changed deliberately: the LAST query of a tool loop is the answer, the
 // earlier ones are the model working up to it.
 ok('multi-query report defaults to the LAST query, not the first', w3 && w3.query_index===1);
 ok('and the status names which query is showing',
    (await p3.textContent('#status')).toLowerCase().includes('query 2 is showing'));

 // ── a leading information_schema probe is skipped ──
 const p3b=await ctx.newPage();
 await p3b.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=R8`);
 await p3b.waitForSelector('.dw',{timeout:15000});
 await p3b.waitForTimeout(900);
 const w3b=await p3b.evaluate(()=>window.__siloDashboard.runtime.getWidgets().find(x=>x.report_id==='R8'));
 ok('a schema-lookup query is never the default', w3b && w3b.query_index===1);

 // ── a report with no SQL is refused, not turned into a dead tile ──
 const p4=await ctx.newPage();
 await p4.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=R4`);
 await p4.waitForSelector('#status:not([hidden])',{timeout:15000});
 ok('a no-SQL report is refused with a reason',
    (await p4.textContent('#status')).includes('no stored SQL'));

 // ── an unknown id ──
 const p5=await ctx.newPage();
 await p5.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=nope`);
 await p5.waitForSelector('#status:not([hidden])',{timeout:15000});
 ok('an unknown report id explains itself',
    (await p5.textContent('#status')).includes('could not be found'));

 // ── narrow screens: collapse to one column, and never save that layout ──
 const mob = await suite.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
 const pm = await mob.newPage();
 await pm.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1&add_report=R1`);
 await pm.waitForSelector('.dw',{timeout:15000}); await pm.waitForTimeout(900);
 ok('phone width collapses the grid to one column',
    (await pm.evaluate(()=>window.__siloDashboard.runtime.grid.getColumn()))===1);
 const stored = await pm.evaluate(()=>window.__siloDashboard.runtime.getWidgets()[0].layout);
 const reported = await pm.evaluate(()=>Object.fromEntries(window.__siloDashboard.runtime.layout()));
 const id0 = Object.keys(reported)[0];
 ok(`a save from a phone reports the 12-col layout, not the collapsed one (${JSON.stringify(reported[id0])})`,
    reported[id0] && reported[id0].w === stored.w && reported[id0].w !== 1);
 ok('the tile still renders its chart at phone width',
    (await pm.locator('.dw-chart canvas').count())>=1);

 ok('no page errors in Ask SILO', errs.length===0||(console.log(errs.slice(0,4)),false));
 ok('no page errors on the dashboard', errs2.length===0||(console.log(errs2.slice(0,4)),false));
 await suite.close();
 console.log(`\n${pass}/${pass+fail} checks passed`); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
