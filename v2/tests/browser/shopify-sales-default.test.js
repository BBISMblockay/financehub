/* Real Integrations UI, fake external services. Exercise explicit saves,
 * tenant-scoped returned rows, legacy defaults, and dismissed async work. */
'use strict';
const assert = require('node:assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const CO = 'test-company';
const ID = '11111111-2222-4333-8444-555555555555';
const CODE = 'shopify_online_' + ID.replace(/-/g, '');
const PANEL = '#loc-panel-' + ID;
const SELECT = '#sales-default-select-' + ID;
const NAME = '#sales-default-name-' + ID;
const STATUS = '#sales-default-status-' + ID;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };

// The shared harness intentionally simplifies UPDATE. This fixture models the
// exact filter/returning semantics used by this page, including an RLS zero-row
// response and delayed requests, and changes only its in-memory fixture rows.
const writesStub = `
(() => {
  const create = window.supabase.createClient;
  window.__DEFAULT_WRITES__ = [];
  window.supabase.createClient = function (...args) {
    const db = create(...args);
    const from = db.from;
    db.from = function (table) {
      const query = from(table);
      if (!['locations', 'shopify_connections'].includes(table)) return query;
      query.update = function (patch) {
        const q = { table, patch, filters: [], columns: null };
        const api = {
          eq: (column, value) => { q.filters.push({ column, value }); return api; },
          is: (column, value) => { q.filters.push({ column, value }); return api; },
          select: (columns) => { q.columns = columns; return api; },
          maybeSingle: async () => {
            window.__DEFAULT_WRITES__.push(q);
            const mode = window.__DEFAULT_WRITE_MODE__;
            if (window.__DEFAULT_WRITE_GATE__) await window.__DEFAULT_WRITE_GATE__;
            if (mode === 'error') return { data: null, error: { message: 'fixture: permission denied' } };
            if (mode === 'zero') return { data: null, error: null };
            const rows = (window.__FIXTURE_TABLES__[table] || []).filter(row => q.filters.every(f => row[f.column] === f.value));
            if (rows.length !== 1) return { data: null, error: null };
            Object.assign(rows[0], patch);
            return { data: Object.fromEntries(q.columns.split(',').map(c => [c.trim(), rows[0][c.trim()]])), error: null };
          }
        };
        return api;
      };
      return query;
    };
    return db;
  };
})();`;

const location = (id, code, name, company = CO) => ({ id, company_entity_id: company, location_code: code, location_name: name, store_type: 'retail', shopify_location_id: null });
const tables = () => ({
  profiles: [{ id: 'test-user', name: 'Test Admin', role: 'owner', active_company_id: CO }],
  shopify_connections: [{ id: ID, company_entity_id: CO, shop_domain: 'batnutz.myshopify.com', shop_name: 'Bat Nutz', last_test_status: 'ok', default_location_code: null, location_id: null, scopes_missing: [], meta: {}, sync_enabled: false }],
  locations: [location(10, 'retail', 'Retail location'), location(20, 'foreign', 'Other company location', 'other-company')],
  shopify_location_mappings: [],
});
const reads = async page => page.evaluate(() => window.__DEFAULT_WRITES__);
const status = async page => page.locator(STATUS).innerText();

(async () => {
  const suite = await startSuite();
  try {
    await suite.context.route('**/cdn.jsdelivr.net/**supabase**', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript() + writesStub }));
    let pendingList = null;
    let holdNextList = false;
    await suite.context.route('**/functions/v1/shopify-sync-run', async route => {
      const body = route.request().postDataJSON();
      assert.equal(body.action, 'list_shopify_locations', 'the UI must never start a sales sync to provision a preview');
      if (holdNextList) { holdNextList = false; pendingList = route; return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, locations: [{ id: '123', name: 'Warehouse' }] }) });
    });
    const page = await suite.open('/v2/integrations.html', tables(), {
      cachedCompany: { id: CO, title: 'Bat Nutz' },
      ready: () => !!document.querySelector('.int-store-tr'),
      rpc: { wow_channel_status: () => ({ configured: false, unclassified_count: 0 }) },
    });
    const map = page.getByRole('button', { name: 'Map locations', exact: true });
    const save = () => page.getByRole('button', { name: 'Save default', exact: true });
    const rename = () => page.getByRole('button', { name: 'Save display name', exact: true });
    const refresh = async () => { await page.locator(PANEL).getByRole('button', { name: 'Refresh', exact: true }).click(); await page.waitForSelector(SELECT); };
    await map.click();
    await page.waitForSelector(SELECT);
    check((await page.locator(PANEL).innerText()).includes('Bat Nutz Online will be created on the next sales sync'), 'company-title preview before first sync');
    eq(await reads(page), [], 'load is read-only');
    eq(await page.locator(NAME).count(), 0, 'name editing waits for a real location');
    check(!(await page.locator(SELECT).innerText()).includes('Other company'), 'location choices are company scoped');

    await page.selectOption(SELECT, '10');
    eq(await reads(page), [], 'selection alone does not save');
    await save().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.startsWith('Default sales location saved'), ID);
    let write = (await reads(page)).at(-1);
    eq(write.table, 'shopify_connections');
    eq(write.patch, { default_location_code: 'retail' }, 'only default code changes');
    eq(write.filters, [{ column: 'company_entity_id', value: CO }, { column: 'id', value: ID }], 'connection save is explicitly scoped');
    eq(await page.locator(SELECT).inputValue(), '10', 'saved explicit default remains selected');
    eq(await page.locator(NAME).count(), 0, 'an explicit real location cannot be renamed here');
    await refresh();
    eq(await page.locator(SELECT).inputValue(), '10', 'refresh preserves the explicit default');

    // Model the atomic server provisioning which happens on the next sync.
    await page.evaluate(({ ID, CODE, CO }) => {
      window.__FIXTURE_TABLES__.shopify_connections[0].default_location_code = CODE;
      window.__FIXTURE_TABLES__.locations.push({ id: 30, company_entity_id: CO, location_code: CODE, location_name: 'Bat Nutz Online', store_type: 'online', shopify_location_id: null });
    }, { ID, CODE, CO });
    await refresh();
    eq(await page.locator(NAME).inputValue(), 'Bat Nutz Online');
    await page.fill(NAME, '  Bat Nutz Web  ');
    await rename().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.startsWith('Display name saved'), ID);
    write = (await reads(page)).at(-1);
    eq(write.patch, { location_name: 'Bat Nutz Web', updated_by: 'test-user' }, 'rename changes only label and audit user');
    eq(write.filters, [{ column: 'company_entity_id', value: CO }, { column: 'id', value: 30 }, { column: 'location_code', value: CODE }, { column: 'shopify_location_id', value: null }]);
    eq(await page.locator(NAME).inputValue(), 'Bat Nutz Web');
    const auto = await page.evaluate(code => window.__FIXTURE_TABLES__.locations.find(x => x.location_code === code), CODE);
    eq([auto.id, auto.location_code, auto.store_type, auto.shopify_location_id], [30, CODE, 'online', null], 'rename preserves identity, type and absence of Shopify id');

    // Empty and denied saves are distinguishable from a confirmed save.
    const beforeEmpty = (await reads(page)).length;
    await page.fill(NAME, '   ');
    await rename().click();
    check((await status(page)).includes('Enter a display name'), 'blank name rejected visibly');
    eq((await reads(page)).length, beforeEmpty, 'blank name makes no request');
    await page.fill(NAME, 'Denied name');
    await page.evaluate(() => { window.__DEFAULT_WRITE_MODE__ = 'zero'; });
    await rename().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.startsWith('Save failed:'), ID);
    check((await status(page)).includes('not confirmed saved'), 'zero-row RLS denial never claims success');
    await page.waitForTimeout(6500);
    check(await page.locator(STATUS).isVisible(), 'save failure has no expiry timer');
    await page.evaluate(() => { window.__DEFAULT_WRITE_MODE__ = 'error'; });
    await page.selectOption(SELECT, '10');
    await save().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.includes('permission denied'), ID);
    check((await status(page)).includes('permission denied'), 'server errors stay visible');

    // Repeated click and refresh while writing cannot cause another write.
    await page.evaluate(() => {
      window.__DEFAULT_WRITE_MODE__ = null;
      window.__DEFAULT_WRITE_GATE__ = new Promise(resolve => { window.__RELEASE_DEFAULT_WRITE__ = resolve; });
    });
    const beforeRepeated = (await reads(page)).length;
    await page.evaluate(id => { saveShopifySalesDefault(id, 'default'); saveShopifySalesDefault(id, 'default'); }, ID);
    await page.waitForFunction(n => window.__DEFAULT_WRITES__.length > n, beforeRepeated);
    eq((await reads(page)).length, beforeRepeated + 1, 'repeated handlers serialize writes');
    check(await save().isDisabled(), 'save disables while writing');
    check(await page.locator(PANEL).getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), 'refresh disabled while writing');
    await map.click();
    await page.evaluate(() => { window.__RELEASE_DEFAULT_WRITE__(); window.__DEFAULT_WRITE_GATE__ = null; });
    await page.waitForTimeout(80);
    check(await page.locator(PANEL).isHidden(), 'pending save does not reopen a dismissed mapper');
    check(!(await page.locator(PANEL).textContent()).includes('Default sales location saved'), 'pending save does not paint stale success after dismissal');
    await map.click();
    await page.waitForSelector(SELECT);
    eq(await page.locator(SELECT).inputValue(), '10', 'reopening reloads the confirmed saved value');

    // A dismissed load cannot replace a newer panel or resurrect its result.
    holdNextList = true;
    await page.locator(PANEL).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(id => document.getElementById('loc-panel-' + id)?.textContent.includes('Loading Shopify'), ID);
    for (let i = 0; !pendingList && i < 100; i += 1) await page.waitForTimeout(10);
    assert.ok(pendingList, 'delayed list reached the route fixture');
    await map.click();
    await pendingList.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, locations: [{ id: 'stale', name: 'Stale Shopify result' }] }) });
    pendingList = null;
    await page.waitForTimeout(80);
    check(await page.locator(PANEL).isHidden(), 'pending load stays dismissed');
    check(!(await page.locator(PANEL).textContent()).includes('Stale Shopify result'), 'pending load does not render into dismissed panel');
    await map.click();
    await page.waitForSelector(SELECT);

    // Legacy location pointers are displayed, never silently replaced by an
    // automatic preview or cleared when an existing location is selected.
    await page.evaluate(() => { Object.assign(window.__FIXTURE_TABLES__.shopify_connections[0], { default_location_code: null, location_id: 10 }); });
    await refresh();
    eq(await page.locator(SELECT).inputValue(), '10', 'legacy location pointer resolves to its existing location');
    eq(await page.locator(SELECT + ' option[value="__automatic__"]').count(), 0, 'automatic option cannot erase legacy location pointer');
    check(!(await page.locator(PANEL).innerText()).includes('will be created on the next sales sync'), 'legacy pointer is not mistaken for an absent fallback');
    await save().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.startsWith('Default sales location saved'), ID);
    eq((await reads(page)).at(-1).patch, { default_location_code: 'retail' }, 'legacy pointer remains untouched');

    // A workspace switch while the panel is open is rejected before write.
    const beforeSwitch = (await reads(page)).length;
    await page.evaluate(() => { window.__FIXTURE_SERVER_COMPANY__ = { id: 'other-company', title: 'Other' }; });
    await save().click();
    await page.waitForFunction(id => document.getElementById('sales-default-status-' + id)?.textContent.includes('active company changed'), ID);
    eq((await reads(page)).length, beforeSwitch, 'stale company form writes nothing');
    console.log(`  shopify-sales-default: ${assertions} assertions passed`);
  } finally { await suite.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
