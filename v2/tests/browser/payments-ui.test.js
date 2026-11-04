'use strict';
const assert = require('node:assert/strict');
const { startSuite } = require('../lib/harness');
const { tables, plan } = require('../lib/payments-fixtures');

(async () => {
  const suite = await startSuite();
  let passed = 0;
  async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
  try {
    const billing = await suite.open('/v2/billing.html', tables(), {
      ready: () => document.querySelector('#current')?.textContent.includes('Growth'),
    });
    await check('one current plan card, reachable portal and labelled icon controls', async () => {
      assert.equal(await billing.locator('#planCard').isVisible(), false);
      assert.equal(await billing.getByRole('button', { name: 'Manage billing' }).isVisible(), true);
      assert.equal(await billing.getByRole('button', { name: 'Refresh from Stripe' }).isVisible(), true);
      assert.equal(await billing.getByRole('link', { name: /Download invoice .* PDF/ }).isVisible(), true);
    });
    const empty = await suite.open('/v2/billing.html', tables('empty'), {
      ready: () => document.querySelector('#current')?.textContent.includes('No subscription'),
    });
    await check('hidden portal stays hidden despite inline-flex button styling', async () => {
      assert.equal(await empty.locator('#btnPortal').isVisible(), false);
      assert.equal(await empty.getByRole('button', { name: 'Subscribe', exact: true }).isVisible(), true);
    });
    const twoPlans = tables(); twoPlans.billing_plans.push({ ...plan, plan_key: 'scale', title: 'Scale' });
    const alternatives = await suite.open('/v2/billing.html', twoPlans, {
      ready: () => !!document.querySelector('[data-portal]'),
    });
    await check('live alternatives offer the billing portal, not checkout', async () => {
      assert.equal(await alternatives.locator('[data-plan]').count(), 0);
      assert.equal(await alternatives.getByRole('button', { name: 'Change plan in Stripe' }).isVisible(), true);
    });
    const invoices = await suite.open('/v2/invoicing.html', tables(), {
      ready: () => document.querySelector('#invoiceCount')?.textContent === '4 of 4',
    });
    await check('Accounting workspace selects Invoicing once', async () => {
      assert.equal(await invoices.locator('[data-accounting-suite] [aria-current="page"]').textContent(), 'Invoicing');
      assert.equal(await invoices.locator('[data-accounting-suite] a[href="/v2/invoicing.html"]').count(), 1);
    });
    await check('search, status selection, and empty result combine', async () => {
      await invoices.getByRole('searchbox', { name: 'Search latest invoices' }).fill('cedar');
      assert.equal(await invoices.locator('#invoiceCount').textContent(), '1 of 4');
      await invoices.getByRole('combobox', { name: 'Invoice status' }).selectOption('paid');
      assert.match(await invoices.locator('#tblInvoices').textContent(), /No invoices match/);
      await invoices.getByRole('searchbox', { name: 'Search latest invoices' }).fill('');
      await invoices.getByRole('button', { name: /All invoices/ }).click();
      assert.equal(await invoices.locator('#invoiceCount').textContent(), '4 of 4');
    });
    await check('invoice drawer is keyboard reachable and Escape returns focus', async () => {
      const trigger = invoices.getByRole('button', { name: 'View invoice INV-1041', exact: true });
      await trigger.focus(); await invoices.keyboard.press('Enter');
      assert.equal(await invoices.getByRole('dialog').isVisible(), true);
      assert.equal(await invoices.locator('#invoiceDetail [data-act="send"]').count(), 0);
      assert.equal(await invoices.locator('#invoiceDetail [data-act="sync"]').count(), 1);
      await invoices.keyboard.press('Escape');
      assert.equal(await invoices.locator('#dlgInvoiceDetail').isVisible(), false);
      assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    });
    await check('draft actions remain available in detail without sending anything', async () => {
      await invoices.getByRole('button', { name: 'View invoice draft', exact: true }).click();
      assert.equal(await invoices.locator('#invoiceDetail [data-act="send"]').count(), 1);
      assert.equal(await invoices.locator('#invoiceDetail [data-act="finalize"]').count(), 1);
      assert.match(await invoices.locator('#invoiceDetail').textContent(), /Nothing is emailed/);
      await invoices.getByRole('button', { name: 'Close invoice details' }).click();
    });
    await check('new customer form remains available with the existing fields', async () => {
      await invoices.getByRole('button', { name: 'New customer', exact: true }).click();
      assert.equal(await invoices.locator('#dlgCustomer').isVisible(), true);
      assert.equal(await invoices.locator('#custName').isVisible(), true);
      assert.equal(await invoices.locator('#custEmail').isVisible(), true);
      await invoices.keyboard.press('Escape');
    });
    for (const theme of ['light', 'dark']) {
      await check(`${theme}: native drawer has opaque background and no page overflow on phone`, async () => {
        await invoices.setViewportSize({ width: 390, height: 844 });
        await invoices.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        assert.equal(await invoices.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await invoices.getByRole('button', { name: 'View invoice INV-1041', exact: true }).click();
        const shape = await invoices.locator('#dlgInvoiceDetail').evaluate((node) => ({
          width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
          bg: getComputedStyle(node).backgroundColor,
        }));
        assert(shape.width <= 390 && shape.height <= 844);
        assert.notEqual(shape.bg, 'rgba(0, 0, 0, 0)');
        await invoices.keyboard.press('Escape');
        await billing.setViewportSize({ width: 390, height: 844 });
        assert.equal(await billing.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      });
    }
    const error = await suite.open('/v2/invoicing.html', tables(), {
      broken: ['stripe_invoices_v'], ready: () => document.querySelector('#invoiceScope')?.textContent === 'Invoices unavailable',
    });
    await check('read failure does not paint healthy zero metrics', async () => {
      assert.equal(await error.locator('#invoiceOverview').isVisible(), false);
      assert.match(await error.locator('#tblInvoices').textContent(), /Unable to load invoices/);
    });
  } finally { await suite.close(); }
  console.log(`${passed} payments browser checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
