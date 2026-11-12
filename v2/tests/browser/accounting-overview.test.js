/* Real pages/controller/read model/chrome, synthetic read-only Supabase only. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {startSuite} = require('../lib/harness');
const {fixtures,rpc,companyId} = require('../fixtures/accounting-overview');
const ready = () => !document.getElementById('reviewMonth').disabled && !!document.querySelector('[data-accounting-suite]');
const finished = page => page.waitForFunction(() => document.getElementById('workspaceContent').getAttribute('aria-busy') === 'false');
(async () => {
 const suite = await startSuite();
 try {
  const page = await suite.open('/v2/accounting.html',fixtures(),{rpc,ready,cachedCompany:null,serverCompany:{id:companyId,title:'Example Company'}});
  const errors = []; page.on('pageerror',e => errors.push(e.message));
  assert.equal(await page.inputValue('#reviewMonth'),'2026-11');
  assert.match(await page.locator('#workspaceDate').innerText(),/Example Company/);
  assert.match(await page.locator('#bookkeepingMode').innerText(),/Bookkeeping in SILO/);
  assert.equal(await page.locator('.aw-kpi').filter({hasText:'Bank accounts'}).locator('.aw-kpi-value').innerText(),'4');
  assert.equal(await page.locator('.aw-kpi').filter({hasText:'Periods to review'}).locator('.aw-kpi-value').innerText(),'2');
  assert.match(await page.locator('.aw-balance-totals').innerText(),/Unavailable/);
  assert.match(await page.locator('.aw-balance-totals').innerText(),/CA\$4,000.00/);
  assert.doesNotMatch(await page.locator('.aw-balance-totals').innerText(),/12,500|500.00/);
  assert.doesNotMatch(await page.locator('#workspaceContent').innerText(),/OTHER TENANT SECRET/);
  assert.match(await page.locator('#workspaceContent').innerText(),/November adjustment/);
  assert.doesNotMatch(await page.locator('#workspaceContent').innerText(),/October adjustment/);
  const queries = await page.evaluate(() => window.__QUERIES__);
  const tables = ['accounting_settings','accounting_opening_balances','accounting_accounts','plaid_connections','plaid_accounts','card_sources','card_import_batches_v','accounting_journal_register'];
  for (const table of tables) {
    const reads = queries.filter(q => q.table === table); assert.ok(reads.length,table);
    assert.ok(reads.every(q => q.filters.some(f => f.col === 'company_entity_id' && f.val === companyId)),table+' tenant scope');
  }
  assert.ok(!queries.some(q => q.table === 'quickbooks_connections'));
  assert.ok(!queries.some(q => ['insert','update','delete','upsert'].includes(q._op)));
  assert.deepEqual(await page.evaluate(() => window.__INVOKES__ || []),[]);
  const nav = page.locator('[data-accounting-suite]');
  assert.equal(await nav.locator('.accounting-suite-links a').count(),5);
  assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'),'/v2/accounting.html');
  for (const href of ['transactions.html','invoicing.html','qbo-reports.html','accounting-month-end.html']) {
    assert.equal(await nav.locator(`a[href="/v2/${href}"]`).count(),1,href);
  }
  await nav.locator('summary').click();
  assert.equal(await nav.locator('a[href="/v2/schedules.html"]').isVisible(),true);
  assert.equal(await nav.locator('a[href="/v2/fixed-assets.html"]').isVisible(),true);
  await nav.locator('summary').press('Escape');
  assert.equal(await nav.locator('details').getAttribute('open'),null);
  assert.equal(await nav.locator('a[href="/v2/accounting-books.html#setup"]').isVisible(),true);
  fs.mkdirSync('/tmp/accounting-qa',{recursive:true});
  async function screenshots(p,prefix) {
    for (const theme of ['light','dark']) for (const width of [1440,390]) {
      await p.evaluate(t => document.documentElement.dataset.theme=t,theme); await p.setViewportSize({width,height:1000});
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`${prefix} ${theme} ${width} overflow`);
      await p.screenshot({path:`/tmp/accounting-qa/${prefix}-${theme}-${width}.png`,fullPage:true});
    }
  }
  await screenshots(page,'overview');
  await page.fill('#reviewMonth','2026-10'); await page.dispatchEvent('#reviewMonth','change'); await finished(page);
  assert.match(await page.locator('#workspaceContent').innerText(),/October adjustment/);
  assert.doesNotMatch(await page.locator('#workspaceContent').innerText(),/November adjustment/);
  // Race the first read against a later selection. Gating is installed in the
  // synthetic query layer, not by replacing production load()/render().
  await page.evaluate(() => {window.__FIXTURE_TABLE_GATES__.accounting_journal_register = new Promise(resolve => {window.__releaseOld = resolve;});});
  await page.fill('#reviewMonth','2026-09'); await page.dispatchEvent('#reviewMonth','change');
  await page.waitForFunction(() => window.__QUERIES__.some(q => q.table === 'accounting_journal_register' && q.filters.some(f => f.val === '2026-09-01')));
  await page.evaluate(() => {delete window.__FIXTURE_TABLE_GATES__.accounting_journal_register;});
  await page.fill('#reviewMonth','2026-11'); await page.dispatchEvent('#reviewMonth','change'); await finished(page);
  await page.evaluate(() => window.__releaseOld()); await page.waitForTimeout(100);
  assert.equal(await page.inputValue('#reviewMonth'),'2026-11'); assert.match(await page.locator('#workspaceContent').innerText(),/November adjustment/);
  // Failed refresh clears sensitive prior render, with a real retry path.
  await page.evaluate(() => {window.__FIXTURE_RPC__.can_manage_journal_entries = () => false;});
  await page.click('#refreshOverview'); await finished(page);
  assert.match(await page.locator('#status').innerText(),/Finance access/);
  assert.doesNotMatch(await page.locator('#workspaceContent').innerText(),/Operating checking/);
  await page.evaluate(() => {window.__FIXTURE_RPC__.can_manage_journal_entries = () => true;});
  await page.click('#refreshOverview'); await finished(page); assert.match(await page.locator('#workspaceContent').innerText(),/Operating checking/);
  assert.deepEqual(errors,[],'No unhandled errors through failed refresh');
  const month = await suite.open('/v2/accounting-month-end.html?month=2026-10',fixtures(),{rpc,ready});
  assert.equal(await month.inputValue('#reviewMonth'),'2026-10');
  assert.equal(await month.locator('[data-accounting-suite] [aria-current="page"]').getAttribute('href'),'/v2/accounting-month-end.html');
  assert.equal(await month.locator('#reviewDetail a[href="transactions.html?batch=oct-approved&company=test-company"]').count(),1);
  assert.equal(await month.locator('#reviewDetail a[href*="nov-draft"]').count(),0);
  await month.click('[data-check="journals"]'); assert.equal(await month.locator('[data-check="journals"]').getAttribute('aria-pressed'),'true');
  assert.match(await month.locator('#reviewDetail').innerText(),/Uncertain submissions/);
  await month.click('[data-check="reports"]'); assert.equal(await month.locator('#reviewDetail a[href="accounting-books.html#ledger"]').count(),1);
  await month.click('[data-check="specialists"]'); assert.equal(await month.locator('#reviewDetail a[href="accounting-export.html"]').count(),1);
  await month.click('[data-check="activity"]');
  await screenshots(month,'month-end');
  await month.fill('#reviewMonth','2026-11'); await month.dispatchEvent('#reviewMonth','change'); await finished(month);
  assert.equal(await month.locator('#reviewDetail a[href*="nov-draft"]').count(),1); assert.equal(await month.locator('#reviewDetail a[href*="oct-approved"]').count(),0);
  const failed = await suite.open('/v2/accounting.html',fixtures(),{rpc,ready,broken:['plaid_accounts','card_import_batches_v']});
  assert.match(await failed.locator('#status').innerText(),/bank accounts.*bank periods|bank periods.*bank accounts/);
  assert.equal(await failed.locator('.aw-kpi').filter({hasText:'Bank accounts'}).locator('.aw-kpi-value').innerText(),'Unknown');
  assert.equal(await failed.locator('.aw-kpi').filter({hasText:'Periods to review'}).locator('.aw-kpi-value').innerText(),'Unknown');
  assert.match(await failed.locator('#workspaceContent').innerText(),/November adjustment/);
  const empty = fixtures(); for (const key of tables) empty[key] = []; empty.accounting_qbo_connections=[];
  const noData = await suite.open('/v2/accounting.html',empty,{rpc,ready});
  assert.equal(await noData.locator('.aw-kpi').filter({hasText:'Bank accounts'}).locator('.aw-kpi-value').innerText(),'0');
  assert.match(await noData.locator('#workspaceContent').innerText(),/No bank accounts yet/);
  const reportOnly = fixtures(); reportOnly.accounting_settings[0].bookkeeping_mode='qbo';
  const ro = await suite.open('/v2/accounting.html',reportOnly,{rpc,ready}); assert.match(await ro.locator('#bookkeepingMode').innerText(),/Reporting only/);
  console.log('PASS Accounting: real overview/month-end boot, scopes, mixed currencies/missing balances, links, period selection, races, failures/retry, empty/reporting-only, eight responsive screenshots');
 } finally { await suite.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
