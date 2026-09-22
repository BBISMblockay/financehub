'use strict';
const assert = require('node:assert/strict');
const { startSuite } = require('../lib/harness');

(async () => {
  const suite = await startSuite({ secureContext: true });
  try {
    // Fail on the actual missing capability rather than timing out at page boot.
    const probe = await suite.context.newPage();
    await probe.goto(`${suite.base}/v2/payment-request2.css`);
    assert.deepEqual(await probe.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, locks: typeof navigator.locks?.request })),
      { secure: true, uuid: 'function', locks: 'function' });
    await probe.close();
    const tables = {
      profiles: [{ id: 'test-user', is_active: true, active_company_id: 'test-company', role: 'owner', department: 'finance' }],
      entity_memberships: [{ user_id: 'test-user', entity_id: 'test-company' }],
      company_settings: [{ company_entity_id: 'test-company', default_currency: 'USD' }],
      payment_requests: [], factories: [], po_headers: [], locations: [],
    };
    const page = await suite.open('/v2/purchase_request2.html', tables, { ready: () => !document.querySelector('#app').hidden && document.querySelector('#poHelp').textContent.includes('accessible') });
    // Seed the device-local record the old client left after the actual error.
    await page.evaluate(async () => {
      const { saveDraft } = await import('/v2/payment-request2-drafts.js');
      const { requestPayload, FIELD_NAMES } = await import('/v2/payment-request2-core.js');
      const d = { id: 'recovery-test', revision: 0, status: 'submitting', reviewed: true,
        fields: { ...Object.fromEntries(FIELD_NAMES.map(k => [k, ''])), vendor_name: 'Café 🧾', amount_due: '25', currency: 'USD', request_type: 'invoice_vendor_payment', requester_email: 'test@example.invalid', notes_comments: '<img src=x onerror=alert(1)>' },
        poNames: ['PO-1'], files: [{ id: 'doc-1', name: 'invoice.csv', type: 'text/csv', blob: new Blob(['synthetic invoice']) }], applied: {}, primaryId: 'doc-1' };
      d.payload = requestPayload(d, 'test-user', 'test-company');
      d.payload.vendor_name += '\u0000'; d.fields.vendor_name += '\u0000';
      d.payload.notes_comments += '\uD800'; d.fields.notes_comments += '\uD800';
      d.lastSubmitError = { code: '22P05', message: 'unsupported Unicode escape sequence' };
      await saveDraft('test-company:test-user', d);
    });
    await page.reload();
    await page.getByRole('button', { name: /Resume submission/ }).click();
    await page.getByRole('button', { name: 'Review text repair', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.textContent(), /U\+0000/);
    assert.match(await dialog.textContent(), /Café 🧾/);
    assert.equal(await dialog.locator('img').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#vendor_name').inputValue(), 'Café 🧾\u0000');
    console.log('PASS real page cancellation preserves invalid saved text; preview uses inert text');
    await page.getByRole('button', { name: 'Review text repair', exact: true }).click();
    await page.getByRole('button', { name: 'Save corrected text', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Corrected text saved'));
    assert.equal(await page.locator('#vendor_name').inputValue(), 'Café 🧾');
    assert.equal(await page.locator('#vendor_name').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__QUERIES__.filter(q => q._op === 'insert').length), 0);
    await page.reload();
    await page.getByRole('button', { name: /Resume submission/ }).click();
    assert.equal(await page.locator('#vendor_name').inputValue(), 'Café 🧾');
    assert.match(await page.locator('#attachmentList').textContent(), /invoice.csv/);
    await page.getByRole('button', { name: 'Retry this request', exact: true }).click();
    await page.locator('#success').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#successId').textContent(), 'recovery-test');
    const inserts = await page.evaluate(() => window.__QUERIES__.filter(q => q._op === 'insert'));
    assert.equal(inserts.filter(q => q.table === 'payment_requests').length, 1);
    assert.equal(inserts.find(q => q.table === 'payment_requests').rows.amount_due, 25);
    assert.equal(inserts.filter(q => q.table === 'payment_request_files').length, 1);
    console.log('PASS saved repair survives reload; explicit retry submits same reference and attachment');
    const fresh = await suite.open('/v2/purchase_request2.html', tables, { ready: () => !document.querySelector('#app').hidden && document.querySelector('#poHelp').textContent.includes('accessible') });
    await fresh.locator('#vendor_name').fill('Bad\u0000Vendor');
    await fresh.getByRole('button', { name: 'Review text repair', exact: true }).click();
    await fresh.setViewportSize({ width: 390, height: 844 });
    assert(await fresh.getByRole('dialog').evaluate(el => el.getBoundingClientRect().width <= innerWidth));
    await fresh.getByRole('button', { name: 'Save corrected text', exact: true }).click();
    await fresh.waitForFunction(() => document.querySelector('#status').textContent.includes('Corrected text saved'));
    assert.equal(await fresh.locator('#vendor_name').inputValue(), 'BadVendor');
    assert.equal(await fresh.locator('#reviewed').isChecked(), false);
    assert.equal(await fresh.locator('#vendor_name').isDisabled(), false);
    console.log('PASS new-draft correction remains editable and requires human review; modal fits mobile');
  } finally { await suite.close(); }
})().catch(error => { console.error(error); process.exit(1); });
