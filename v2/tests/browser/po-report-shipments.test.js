/* Runs the actual inline page script and DOM with synthetic, in-memory SDK data.
 * No credentials, external requests, or production writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
let source = fs.readFileSync(path.join(root, 'v2/po-report.html'), 'utf8');
// Optional mutation probes demonstrate that assertions detect the regressions.
const mutations = {
  zero: ['assignment.qty ?? line?.qty', 'assignment.qty || line?.qty'],
  search: ['shipment.carrier, shipment.tracking_number,', ''],
  unassigned: ['if(!po) return [];', 'if(!po || !shipmentLinesFor(shipment.id).length) return [];'],
  refresh: ['        applyFilters();', '        /* mutation: stale view after field save */'],
};
if(process.env.PO_SHIP_MUTATION) {
  const mutation = mutations[process.env.PO_SHIP_MUTATION];
  assert.ok(mutation && source.includes(mutation[0]), 'known mutation target');
  source = source.replace(...mutation);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if(url.pathname === '/v2/po-report.html') return route.fulfill({ contentType: 'text/html', body: source.replace(/<script\b[^>]*src=[^>]*>[\s\S]*?<\/script>/g, '') });
      if(url.hostname === 'fixture.test' && url.pathname.endsWith('.css')) {
        const file = path.join(root, url.pathname);
        if(fs.existsSync(file)) return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(file) });
      }
      return route.abort();
    });
    await page.addInitScript(() => {
      const po = { id: 'p1', po_name: 'Autumn PO', status: 'Approved', factory_name: 'Factory A', expected_arrival_date: '2026-11-01', date_bucket: 'Fall' };
      const line = { po_header_id: 'p1', po_line_id: 'l1', product_title: 'Cap', sku: 'CAP', qty: 100, status: 'Approved' };
      window.fixture = {
        v_po_incoming_summary: [po, { ...po, id: 'p2', po_name: 'Closed PO', status: 'Received' }],
        v_po_incoming_lines: [line, { ...line, po_line_id: 'l2', product_title: 'Tee', sku: 'TEE', qty: 20 }],
        factories: [],
        incoming_shipments: [
          { id: 's1', po_header_id: 'p1', carrier: 'Ocean Carrier', tracking_number: 'TRACK-1', shipment_status: 'Delayed', eta: '2027-01-01', notes: '<img src=x onerror=alert(1)>' },
          { id: 's2', po_header_id: 'p1', tracking_number: 'TRACK-2' },
          { id: 's3', po_header_id: 'p1' },
          { id: 's4', po_header_id: 'p1' },
          { id: 's5', po_header_id: 'p2' },
          { id: 'orphan', po_header_id: 'outside-visible-pos' },
        ],
        incoming_shipment_lines: [
          { id: 'a1', shipment_id: 's1', po_line_id: 'l1', qty: 40 },
          { id: 'a2', shipment_id: 's2', po_line_id: 'l1', qty: 60 },
          { id: 'a3', shipment_id: 's2', po_line_id: 'l2', qty: 0 },
          { id: 'a4', shipment_id: 's4', po_line_id: 'l2', qty: null },
        ],
      };
      window.__SILO_CONFIG__ = { SUPABASE_URL: 'https://fixture.test', SUPABASE_ANON_KEY: 'fixture' };
      window.supabase = { createClient: () => ({ from(table) {
        let payload, op = 'select', ids;
        const query = {
          select() { return query; }, order() { return query; },
          insert(value) { op = 'insert'; payload = value; return query; },
          update(value) { op = 'update'; payload = value; return query; },
          delete() { op = 'delete'; return query; },
          eq(key, value) { ids = [value]; return query; }, in(key, values) { ids = values; return query; },
          then(resolve) {
            if(window.failSave && op !== 'select') { window.failSave = false; return Promise.resolve({ error: { message: 'Synthetic save failure' } }).then(resolve); }
            let rows = window.fixture[table];
            if(op === 'update') rows.filter(r => ids.includes(r.id)).forEach(r => Object.assign(r, payload));
            if(op === 'delete') window.fixture[table] = rows = rows.filter(r => !ids.includes(r.id));
            if(op === 'insert') rows.push(...[payload].flat().map((r, i) => ({ id: 'new-' + rows.length + i, ...r })));
            return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(resolve);
          }
        };
        return query;
      } }) };
    });
    await page.goto('https://fixture.test/v2/po-report.html');
    await page.waitForFunction(() => document.querySelector('#shipmentTableCount').textContent === '4');
    await page.click('[data-tab="shipments"]');
    assert.equal(await page.locator('[data-panel="shipments"]').isVisible(), true);
    const row = id => page.locator('#shipmentTbody tr').filter({ has: page.locator('.bcn-mono', { hasText: new RegExp('^' + id + '$') }) });
    assert.equal(await row('s1').locator('td').nth(9).textContent(), '40');
    assert.equal(await row('s2').locator('td').nth(9).textContent(), '60'); // zero must not default to 20
    assert.equal(await row('s3').locator('td').nth(9).textContent(), '—');
    assert.match(await row('s3').textContent(), /No lines assigned/);
    assert.equal(await row('s4').locator('td').nth(9).textContent(), '20*');
    assert.equal(await page.locator('#shipmentTbody img').count(), 0);
    await page.fill('#arrivalTo', '2026-12-01'); // PO date, not shipment ETA
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '4');
    await page.selectOption('#statusFilter', 'Approved');
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '4');
    for(const [query, expected] of [['oCeAn', '1'], ['track-2', '1'], ['CAP', '2'], ['Autumn', '4'], ['nonexistent', '0']]) {
      await page.fill('#searchInput', query);
      assert.equal(await page.locator('#shipmentTableCount').textContent(), expected, query);
    }
    await page.fill('#searchInput', '');
    await page.selectOption('#factoryFilter', 'Factory A');
    await page.selectOption('#bucketFilter', 'Fall');
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '4');
    await page.selectOption('#statusFilter', '');
    await page.click('[data-scope="all"]');
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '5');
    await page.click('[data-scope="open"]');
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '4');
    await row('s1').locator('button').click();
    assert.equal(await page.locator('#shipDrawer').isVisible(), true);
    await page.locator('[data-ship-field="tracking_number"][data-shipment-id="s1"]').fill('UPDATED');
    await page.locator('[data-ship-field="tracking_number"][data-shipment-id="s1"]').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#shipmentTbody').textContent.includes('UPDATED'));
    await page.evaluate(() => updateShipmentLineQty('a1', '0'));
    assert.equal(await row('s1').locator('td').nth(9).textContent(), '0');
    await page.evaluate(() => { window.failSave = true; return updateShipmentField('s1', 'carrier', 'FAILED'); });
    assert.match(await row('s1').textContent(), /Ocean Carrier/);
    await page.evaluate(() => addShipment('p1'));
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '5');
    await page.evaluate(() => { window.fixture.incoming_shipment_lines.push({ id: 'missing', shipment_id: 's3', po_line_id: 'unavailable', qty: null }); return loadShipments(); });
    assert.match(await row('s3').textContent(), /Line details unavailable/);
    assert.equal(await row('s3').locator('td').nth(9).textContent(), '—');
    await page.evaluate(() => removeShipmentLine('a2'));
    assert.equal(await row('s2').locator('td').nth(9).textContent(), '0');
    await page.evaluate(() => { window.confirm = () => true; return deleteShipment('s4'); });
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '4');
    await page.evaluate(() => closeShipDrawer());
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('[data-tab="shipments"]').isVisible(), true);
    assert.equal(await page.locator('[data-panel="shipments"] .bcn-matrix-scroll').evaluate(el => el.scrollWidth > el.clientWidth), true);
    await page.click('[data-tab="pos"]');
    assert.equal(await page.locator('[data-panel="pos"]').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS shipment tab: boot, filters/search, splits/zero/default/missing quantities, escaping, drawer navigation, saves/reload/failure recovery');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
