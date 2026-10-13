'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, FIXTURES } = require('../lib/harness');

(async () => {
  const suite = await startSuite();
  try {
    const { page, errors } = await suite.newPage();
    const config = fs.readFileSync(path.join(FIXTURES, 'fake-config.js'), 'utf8');
    const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8');
    await page.route('**/pages/config.js', r => r.fulfill({ contentType: 'text/javascript',
      body: config.replace("entity_key: 'baseballism'", "entity_key: 'stlhd'") }));
    await page.route('**/@supabase/supabase-js**', r => r.fulfill({ contentType: 'text/javascript', body: fake + `
      window.__FAKE_DB__.silo_chat_saved_reports.push(
        { id: 'PRIVATE', title: 'Private sentinel', source: 'manual', company_entity_id: 'C1', created_by: 'U2', visibility: 'private' },
        { id: 'FOREIGN', title: 'Foreign sentinel', source: 'manual', company_entity_id: 'C2', created_by: 'U1', visibility: 'company' });
    ` }));
    await page.goto(`${suite.BASE}/v3/dashboards.html`);
    await page.waitForSelector('#siloBody .lib-card');
    assert.equal((await page.textContent('#hubTitle')).trim(), 'Reports');
    assert.equal((await page.textContent('.silo-sb-link[data-nav-id="reports/dashboards"]')).trim(), 'Reports');
    assert.deepEqual(await page.locator('#libTabs [role="tab"]:visible').evaluateAll(ts => ts.map(t => t.dataset.tab)), ['silo', 'dashboards']);
    assert.equal(await page.locator('#siloBody .lib-card[data-id^="reports/"]').count(), 0);
    assert.equal(await page.locator('#siloBody .lib-card[data-id="PRIVATE"], #siloBody .lib-card[data-id="FOREIGN"], #siloBody .lib-card[data-id="R1"]').count(), 0);
    assert.equal(await page.isHidden('#btnNewReport'), true);
    const systemIds = await page.evaluate(() => window.__FAKE_DB__.silo_chat_saved_reports.filter(r => r.source === 'system' && r.company_entity_id == null && !r.archived_at).map(r => r.id).sort());
    assert.deepEqual(await page.locator('#siloBody .lib-card').evaluateAll(cs => cs.map(c => c.dataset.id).sort()), systemIds);
    for (let i = 0; i < 3; i++) {
      await page.fill('#librarySearch', 'no-such-report');
      await page.click('#tab-dashboards');
      await page.waitForSelector('#listBody .lib-card');
      assert.equal(await page.inputValue('#librarySearch'), '');
      assert.equal(await page.isVisible('#btnNew'), true);
      await page.click('#tab-silo');
      assert.equal(await page.locator('#siloBody .lib-card').count(), systemIds.length);
    }
    await page.reload();
    await page.waitForSelector('#siloBody .lib-card');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(n => document.querySelectorAll('#siloBody .lib-card').length === n, systemIds.length);
    await page.click('#siloBody .lib-card[data-id="S1"] .lib-link');
    await page.waitForSelector('[gs-id="preview-table"] table');
    assert.equal(await page.isHidden('#previewBuilder'), true);
    assert.equal(await page.isHidden('#btnEdit'), true);
    assert.equal(await page.isHidden('#btnSaveView'), true);
    assert.equal(await page.evaluate(() => window.__FAKE_DB__.queryCalls.some(c => c.op !== 'select')), false);
    const calls = await page.evaluate(() => window.__FAKE_DB__.rpcCalls.filter(c => c.name === 'chat_run_readonly_query'));
    assert.ok(calls.length > 0, 'preview uses existing caller-scoped query engine');
    await page.goto(`${suite.BASE}/v3/dashboard.html?report=S1`);
    await page.waitForSelector('[gs-id="preview-table"] table');
    assert.equal(await page.isHidden('#previewBuilder'), true, 'direct preview keeps authoring hidden');
    // Missing source and no data stay distinct; neither introduces authoring.
    for (const [result, expected] of [
      [{ data: [], error: null }, /No rows/i],
      [{ data: null, error: { message: 'source unavailable' } }, /source unavailable/],
    ]) {
      await page.route('**/@supabase/supabase-js**', r => r.fulfill({ contentType: 'text/javascript', body: fake + `
        window.__FAKE_RPC_HANDLERS__ = { chat_run_readonly_query: () => (${JSON.stringify(result)}) };
      ` }));
      await page.reload();
      await page.waitForFunction(() => window.__siloDashboard?.runtime && document.querySelector('[gs-id="preview-table"]'));
      await page.waitForFunction(() => /No rows|source unavailable/.test(document.getElementById('grid').textContent));
      assert.match(await page.textContent('#grid'), expected);
      assert.equal(await page.isHidden('#previewBuilder'), true);
    }
    await page.route('**/@supabase/supabase-js**', r => r.fulfill({ contentType: 'text/javascript', body: fake + `window.__FAKE_DB__.silo_chat_saved_reports = [];` }));
    await page.goto(`${suite.BASE}/v3/dashboards.html`);
    await page.waitForFunction(() => /No SILO reports/.test(document.getElementById('siloBody').textContent));
    await page.click('#tab-dashboards');
    await page.waitForSelector('#listBody .lib-card');
    // A missing/private report never creates a preview or an authoring route.
    await page.goto(`${suite.BASE}/v3/dashboard.html?report=PRIVATE`);
    await page.waitForFunction(() => /does not exist, or it is private/.test(document.getElementById('status').textContent));
    assert.equal(await page.isHidden('#previewBuilder'), true);
    assert.equal(await page.evaluate(() => window.__siloDashboard?.preview || false), false);
    // Standard non-exec users and unresolved companies also fail closed for
    // authoring; grandfathered customization is covered by report-preview.
    await page.route('**/@supabase/supabase-js**', r => r.fulfill({ contentType: 'text/javascript', body: fake.replace("role: 'owner'", "role: 'user'") }));
    await page.goto(`${suite.BASE}/v3/dashboard.html?report=S1`);
    await page.waitForSelector('[gs-id="preview-table"] table');
    assert.equal(await page.isHidden('#previewBuilder'), true);
    await page.route('**/pages/config.js', r => r.fulfill({ contentType: 'text/javascript', body: config.replace('return this.getActiveCompany();', 'return null;') }));
    await page.reload();
    await page.waitForSelector('[gs-id="preview-table"] table');
    assert.equal(await page.isHidden('#previewBuilder'), true);
    assert.deepEqual(errors, []);
    console.log('PASS standard catalog, navigation, privacy classification, read-only previews, empty/missing sources');
  } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
