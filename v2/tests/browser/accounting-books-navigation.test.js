/* Presentation-only setup navigation: real page + isolated fixture reads. */
'use strict';
const assert = require('node:assert/strict');
const { startSuite } = require('../lib/harness');
const fixtures = {
  accounting_settings: [{ qbo_connection_id: 'qbo', bookkeeping_mode: 'silo', accounting_start_date: '2026-08-01', accounting_basis: 'Accrual', fiscal_year_start_month: 1 }],
  accounting_qbo_connections: [{ id: 'qbo', company_name: 'Example Company', environment: 'production' }],
  accounting_accounts: [{ id: 'a', name: 'Operating checking', account_type: 'Bank', qbo_account_id: 'bank', is_active: true }],
  plaid_connections: [{ id: 'p', institution_name: 'Example Bank', status: 'active' }],
  card_sources: [{ id: 's', display_name: 'Operating checking', is_active: true, ingest_mode: 'plaid', qbo_connection_id: 'qbo', credit_qbo_account_id: 'bank' }],
  can_manage_journal_entries: [true], is_exec_or_owner: [true], silo_business_today: ['2026-11-12']
};
(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/accounting-books.html#setup', fixtures, {
      ready: () => window.SiloBooks && document.getElementById('setupMappingStatus').textContent.includes('1 of 1')
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.keyboard.press('Escape');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
        await page.click('[data-surface="setup"]');
        assert.equal(await page.locator('.books-setup-links').isVisible(), true);
        await page.click('.books-setup-links a[href="#setupMappings"]');
        await page.locator('#setupMappingStatus').waitFor({ state: 'visible' });
        assert.match(await page.locator('#setupMappingStatus').innerText(), /1 of 1 active accounts mapped/);
        await page.click('.books-setup-links a[href="#openingSetup"]');
        // Native hash navigation dispatches hashchange after the click resolves.
        // Wait for the user-visible result, rather than racing that handler.
        await page.locator('#seedForm').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#openingSetup').getAttribute('open'), '');
        assert.equal(await page.locator('#seedForm').isVisible(), true);
        await page.click('.books-setup-links a[href="#accounts"]');
        await page.locator('#accountsTable').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#accountsTable').isVisible(), true);
        await page.click('[data-surface="ledger"]');
        assert.equal(await page.locator('.books-setup-links').isVisible(), false);
        assert.equal(await page.locator('#ledger').isVisible(), true);
        await page.click('[data-surface="register"]');
        assert.equal(await page.locator('#newJournal').isVisible(), true);
        await page.click('[data-surface="setup"]');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width} overflow`);
      }
    }
    console.log('PASS Books setup navigation: desktop/mobile, both themes, mapping/opening/chart deep links, ledger/journal controls preserved');
  } finally { await suite.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
