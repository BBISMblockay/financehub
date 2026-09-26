/* Library-only page links: preserve discovery when saved reports fail, keep
 * standard workspaces unchanged, and never pretend these pages are widgets. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, FIXTURES, REPO_ROOT } = require('../lib/harness');

(async () => {
  const suite = await startSuite();
  try {
    const { page, errors } = await suite.newPage();
    const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8');
    // Existing non-exec viewers must still have a route into their reports.
    await page.route('**/@supabase/supabase-js**', (r) => r.fulfill({
      contentType: 'text/javascript', body: fake.replace("role: 'owner'", "role: 'user'"),
    }));
    await page.goto(`${suite.BASE}/v3/dashboards.html`);
    await page.waitForSelector('#siloBody .lib-card[data-id="R12"]');
    assert.equal(await page.locator('.silo-sb-link[data-nav-id="reports/dashboards"]').count(), 1);
    assert.equal(await page.locator('.silo-sb-link[data-nav-id="reports/daily-trend"]').count(), 0);
    const pages = await page.evaluate(() => window.SiloNav.SALES_REPORT_PAGES);
    assert.equal(pages.length, 6);
    assert.equal(await page.locator('#siloBody .lib-card[data-id^="reports/"]').count(), 6);
    for (const report of pages) {
      const link = page.locator(`#siloBody .lib-card[data-id="${report.id}"] .lib-link`);
      assert.equal(await link.getAttribute('href'), report.href);
      const html = fs.readFileSync(path.join(REPO_ROOT, report.href), 'utf8');
      assert.match(html, /active:'reports\/dashboards'/, 'destination highlights the shared Reports entry');
    }
    await page.fill('#librarySearch', 'daily sales trend');
    assert.equal(await page.locator('#siloBody .lib-card').count(), 1);
    assert.equal(await page.locator('#siloBody .lib-link').getAttribute('href'), '/v2/bi-daily-trend.html');
    assert.match(await page.textContent('#libCount'), /^1 of /);
    await page.fill('#librarySearch', '');

    // A backend failure cannot remove the replacement for the old static menu.
    await page.route('**/@supabase/supabase-js**', (r) => r.fulfill({
      contentType: 'text/javascript', body: fake + `
        const create = window.supabase.createClient;
        window.supabase.createClient = (...args) => {
          const client = create(...args), from = client.from.bind(client);
          client.from = (table) => table === 'silo_chat_saved_reports_v'
            ? { select() { return this; }, order() { return Promise.resolve({ error: { message: 'fixture unavailable' } }); } }
            : from(table);
          return client;
        };`,
    }));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('siloBody').textContent.includes('fixture unavailable'));
    assert.equal(await page.locator('#siloBody .lib-card').count(), 6);
    await page.fill('#librarySearch', 'SKU');
    assert.equal(await page.locator('#siloBody .lib-card').count(), 2);
    assert.match(await page.textContent('#siloBody'), /Couldn't load reports/);
    await page.click('#tab-mine');
    assert.equal(await page.locator('#mineBody .lib-card').count(), 0);

    const config = fs.readFileSync(path.join(FIXTURES, 'fake-config.js'), 'utf8');
    await page.route('**/pages/config.js', (r) => r.fulfill({
      contentType: 'text/javascript', body: config.replace("entity_key: 'baseballism'", "entity_key: 'another-company'"),
    }));
    await page.goto(`${suite.BASE}/v3/dashboards.html?tab=silo`);
    await page.waitForSelector('#listBody .lib-card');
    assert.equal(await page.isHidden('#tab-silo'), true);
    assert.equal(await page.locator('#siloBody .lib-card').count(), 0);
    assert.equal((await page.textContent('#hubTitle')).trim(), 'Dashboards');
    assert.deepEqual(errors, []);
    console.log('PASS report links, search, non-exec discovery, load failure, standard workspace');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
