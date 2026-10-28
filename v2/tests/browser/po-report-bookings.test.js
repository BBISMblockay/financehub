/* The booking layer on /v2/po-report.html, driven through the real inline page
 * script and DOM with synthetic, in-memory SDK data. No credentials, external
 * requests or production writes.
 *
 * What it pins: a booking's dates are the ones a shipment travels on and are
 * shared by every PO in the container; the PO card shows the plan beside what
 * the shipments say, with the slip; a status that contradicts the shipments is
 * badged; attaching, creating and deleting a booking all work from the drawer;
 * deleting a booking keeps its shipments.
 *
 * Mutations: PO_BOOKING_MUTATION=own-dates  (shipment dates beat the booking's)
 *            PO_BOOKING_MUTATION=no-ata     (actual arrival stops winning)
 *            PO_BOOKING_MUTATION=no-conflict(the conflict badge is dropped)
 *            PO_BOOKING_MUTATION=no-slip    (the slip label is dropped)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
let source = fs.readFileSync(path.join(root, 'v2/po-report.html'), 'utf8');
const mutations = {
  'own-dates': ['eta: (b && (b.ata || b.eta)) || s.eta || null,', 'eta: s.eta || (b && (b.ata || b.eta)) || null,'],
  'no-ata': ['eta: (b && (b.ata || b.eta)) || s.eta || null,', 'eta: (b && b.eta) || s.eta || null,'],
  'no-conflict': ['${r.status_conflicts_with_shipments ?', '${false ?'],
  'no-slip': ['${escapeHtml(ARRIVAL_STATE_LABEL[r.arrival_state] || \'—\')}${arrivalSlipLabel(r)}', '${escapeHtml(ARRIVAL_STATE_LABEL[r.arrival_state] || \'—\')}'],
};
if(process.env.PO_BOOKING_MUTATION) {
  const mutation = mutations[process.env.PO_BOOKING_MUTATION];
  assert.ok(mutation && source.includes(mutation[0]), 'known mutation target');
  source = source.replace(...mutation);
}

function parseCsv(csv) {
  const rows = []; let row = [], cell = '', quoted = false;
  for(let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if(c === '"') {
      if(quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if(!quoted && (c === ',' || c === '\n')) {
      row.push(cell); cell = '';
      if(c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  row.push(cell); rows.push(row);
  const headers = rows.shift();
  return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i]])));
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
      // Two POs in one container, which is the situation the booking exists
      // for: PO-A planned 2026-09-18, PO-B planned 2026-07-30, both riding on
      // BK-1042 whose ETA is 2026-11-06. PO-C is marked Received while its
      // shipment is still in transit -- a real production contradiction.
      const base = { factory_name: 'Incotexco', date_bucket: 'Fall', status: 'Sent to Factory' };
      window.fixture = {
        v_po_incoming_summary: [
          { ...base, id: 'pA', po_name: 'Incotexco-480', expected_arrival_date: '2026-09-18',
            current_eta: '2026-11-06', effective_arrival_date: '2026-11-06', arrival_variance_days: 49,
            arrival_state: 'booked', shipment_count: 1, status_conflicts_with_shipments: false },
          { ...base, id: 'pB', po_name: 'Incotexco-486', expected_arrival_date: '2026-07-30',
            current_eta: '2026-11-06', effective_arrival_date: '2026-11-06', arrival_variance_days: 99,
            arrival_state: 'booked', shipment_count: 1, status_conflicts_with_shipments: false },
          { ...base, id: 'pC', po_name: 'Creytex-325', status: 'Received', expected_arrival_date: '2026-07-01',
            current_eta: '2026-11-20', effective_arrival_date: '2026-11-20', arrival_variance_days: 142,
            arrival_state: 'in_transit', shipment_count: 1, status_conflicts_with_shipments: true },
          { ...base, id: 'pD', po_name: 'Creytex-400', expected_arrival_date: '2026-12-15',
            current_eta: null, effective_arrival_date: '2026-12-15', arrival_variance_days: null,
            arrival_state: 'unknown', shipment_count: 0, status_conflicts_with_shipments: false },
        ],
        v_po_incoming_lines: ['pA','pB','pC','pD'].map((po, i) => ({
          po_header_id: po, po_line_id: 'l' + i, product_title: 'Tee ' + i, sku: 'TEE-' + i,
          qty: 100, status: po === 'pC' ? 'Received' : 'Sent to Factory', expected_arrival_date: '2026-09-18' })),
        factories: [],
        v_shipment_booking_summary: [
          { booking_id: 'b1', booking_ref: 'BK-1042', forwarder: 'Flexport', mode: 'Ocean',
            container_ref: 'MSKU7654321', origin_port: 'Ningbo', destination_port: 'LAX',
            etd: '2026-10-29', eta: '2026-11-06', ata: null, effective_eta: '2026-11-06',
            status: 'Booked', po_count: 2, shipment_count: 2, po_names: 'Incotexco-480, Incotexco-486',
            assigned_units: 200, notes: null },
        ],
        shipment_bookings: [
          { id: 'b1', booking_ref: 'BK-1042', forwarder: 'Flexport', mode: 'Ocean',
            container_ref: 'MSKU7654321', etd: '2026-10-29', eta: '2026-11-06', ata: null, status: 'Booked' },
        ],
        incoming_shipments: [
          { id: 'sA', po_header_id: 'pA', booking_id: 'b1', shipment_status: 'Not Shipped', ship_date: '2026-10-28', eta: null },
          { id: 'sB', po_header_id: 'pB', booking_id: 'b1', shipment_status: 'Not Shipped', ship_date: '2026-10-29', eta: null },
          { id: 'sC', po_header_id: 'pC', booking_id: null, shipment_status: 'In Transit', eta: '2026-11-20' },
        ],
        incoming_shipment_lines: [
          { id: 'aA', shipment_id: 'sA', po_line_id: 'l0', qty: null },
          { id: 'aB', shipment_id: 'sB', po_line_id: 'l1', qty: null },
        ],
      };
      // The booking summary view is derived, so a write to shipment_bookings
      // has to show up in it -- exactly as reloading the page would.
      window.resyncBookings = () => {
        window.fixture.v_shipment_booking_summary = window.fixture.shipment_bookings.map(b => {
          const ships = window.fixture.incoming_shipments.filter(s => s.booking_id === b.id);
          const poNames = [...new Set(ships.map(s => (window.fixture.v_po_incoming_summary.find(p => p.id === s.po_header_id) || {}).po_name).filter(Boolean))].sort();
          return { booking_id: b.id, booking_ref: b.booking_ref, forwarder: b.forwarder ?? null,
            mode: b.mode ?? null, container_ref: b.container_ref ?? null, origin_port: b.origin_port ?? null,
            destination_port: b.destination_port ?? null, etd: b.etd ?? null, eta: b.eta ?? null,
            ata: b.ata ?? null, effective_eta: b.ata ?? b.eta ?? null, status: b.status ?? 'Booked',
            po_count: poNames.length, shipment_count: ships.length,
            po_names: poNames.join(', ') || null, assigned_units: ships.length * 100, notes: b.notes ?? null };
        });
      };
      window.__SILO_CONFIG__ = { SUPABASE_URL: 'https://fixture.test', SUPABASE_ANON_KEY: 'fixture' };
      window.supabase = { createClient: () => ({ from(table) {
        let payload, op = 'select', ids, single = false;
        const query = {
          select() { return query; }, order() { return query; }, single() { single = true; return query; },
          insert(value) { op = 'insert'; payload = value; return query; },
          update(value) { op = 'update'; payload = value; return query; },
          delete() { op = 'delete'; return query; },
          eq(key, value) { ids = [value]; return query; }, in(key, values) { ids = values; return query; },
          then(resolve) {
            if(window.failSave && op !== 'select') { window.failSave = false; return Promise.resolve({ error: { message: 'Synthetic save failure' } }).then(resolve); }
            let rows = window.fixture[table] || [];
            if(op === 'update') rows.filter(r => ids.includes(r.id)).forEach(r => Object.assign(r, payload));
            if(op === 'delete') {
              window.fixture[table] = rows = rows.filter(r => !ids.includes(r.id));
              // The database's ON DELETE SET NULL, not a cascade.
              if(table === 'shipment_bookings') {
                window.fixture.incoming_shipments.forEach(s => { if(ids.includes(s.booking_id)) s.booking_id = null; });
              }
            }
            let inserted = [];
            if(op === 'insert') {
              const refs = new Set(rows.map(r => String(r.booking_ref || '').toLowerCase()));
              for(const r of [payload].flat()) {
                if(table === 'shipment_bookings' && refs.has(String(r.booking_ref || '').toLowerCase())) {
                  return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } }).then(resolve);
                }
                inserted.push({ id: 'new-' + rows.length + inserted.length, ...r });
              }
              rows.push(...inserted);
            }
            if(op !== 'select') window.resyncBookings();
            const source = window.fixture[table] || [];
            const out = single ? (inserted[0] || source[0] || null) : source;
            return Promise.resolve({ data: JSON.parse(JSON.stringify(out ?? null)), error: null }).then(resolve);
          }
        };
        return query;
      } }) };
    });
    await page.goto('https://fixture.test/v2/po-report.html');
    await page.waitForFunction(() => document.querySelector('#bookingTableCount').textContent === '1');
    // Creytex-325 is marked Received, which the default "open incoming" scope
    // hides -- and it is the PO whose status contradicts its shipments, so the
    // whole book is in scope for this test.
    await page.click('[data-scope="all"]');
    await page.waitForFunction(() => document.querySelector('#poTableCount').textContent === '4');

    // ── The Bookings tab ───────────────────────────────────────────────────
    await page.click('[data-tab="bookings"]');
    assert.equal(await page.locator('[data-panel="bookings"]').isVisible(), true);
    const bookingRow = id => page.locator(`[data-booking-row="${id}"]`);
    assert.match(await bookingRow('b1').textContent(), /BK-1042/);
    // Forwarder, mode and container are editable here, so a booking created
    // from this tab is not a dead end.
    assert.equal(await bookingRow('b1').locator('[data-booking-field="forwarder"]').inputValue(), 'Flexport');
    assert.equal(await bookingRow('b1').locator('[data-booking-field="mode"]').inputValue(), 'Ocean');
    assert.equal(await bookingRow('b1').locator('[data-booking-field="container_ref"]').inputValue(), 'MSKU7654321');
    assert.match(await bookingRow('b1').textContent(), /Incotexco-480, Incotexco-486/,
      'the container names both POs riding on it -- the thing that had no object before');
    assert.match(await page.locator('#bookingSummary').textContent(), /1 carrying more than one PO/);
    await bookingRow('b1').locator('[data-booking-field="container_ref"]').fill('MSKU0000001');
    await bookingRow('b1').locator('[data-booking-field="container_ref"]').dispatchEvent('change');
    await page.waitForFunction(() => window.fixture.shipment_bookings[0].container_ref === 'MSKU0000001');
    await bookingRow('b1').locator('[data-booking-field="container_ref"]').fill('MSKU7654321');
    await bookingRow('b1').locator('[data-booking-field="container_ref"]').dispatchEvent('change');
    await page.waitForFunction(() => window.fixture.shipment_bookings[0].container_ref === 'MSKU7654321');
    assert.equal(await bookingRow('b1').locator('[data-booking-field="eta"]').inputValue(), '2026-11-06');

    // ── A booking's dates are what its shipments travel on ───────────────
    await page.click('[data-tab="shipments"]');
    const shipRow = id => page.locator(`[data-shipment-row="${id}"]`);
    assert.match(await shipRow('sA').textContent(), /BK-1042/);
    assert.match(await shipRow('sA').textContent(), /2 POs/);
    const shipEta = id => shipRow(id).locator('[data-shipment-eta]').getAttribute('data-shipment-eta');
    assert.equal(await shipEta('sA'), '2026-11-06',
      "the booking's ETA, although this shipment has none of its own");
    assert.match(await shipRow('sA').textContent(), /From booking BK-1042/);
    assert.match(await shipRow('sC').textContent(), /No booking/);

    // ── Actual arrival beats the estimate, for every PO at once ──────────
    await page.click('[data-tab="bookings"]');
    await bookingRow('b1').locator('[data-booking-field="ata"]').fill('2026-11-02');
    await bookingRow('b1').locator('[data-booking-field="ata"]').dispatchEvent('change');
    await page.waitForFunction(() => window.fixture.shipment_bookings[0].ata === '2026-11-02');
    await page.click('[data-tab="shipments"]');
    await page.waitForFunction(() => document.querySelector('[data-shipment-row="sA"] [data-shipment-eta]')
      ?.getAttribute('data-shipment-eta') === '2026-11-02');
    for(const id of ['sA', 'sB']) {
      assert.equal(await shipEta(id), '2026-11-02',
        `${id} reads the actual arrival, not the estimate`);
    }
    await page.click('[data-tab="bookings"]');
    await bookingRow('b1').locator('[data-booking-field="ata"]').fill('');
    await bookingRow('b1').locator('[data-booking-field="ata"]').dispatchEvent('change');
    await page.waitForFunction(() => window.fixture.shipment_bookings[0].ata === null);

    // ── The PO card: plan, what the shipments say, and the slip ──────────
    await page.click('[data-tab="pos"]');
    const card = name => page.locator('.po-list article').filter({ hasText: name }).first();
    const slipped = await card('Incotexco-486').textContent();
    assert.match(slipped, /Planned/);
    assert.match(slipped, /Shipments say/);
    assert.match(slipped, /99 days late/, 'the slip is stated, not left to be worked out');
    assert.match(await card('Creytex-325').textContent(), /Status vs shipments/,
      'a PO marked Received whose shipment is still in transit is badged');
    assert.doesNotMatch(await card('Incotexco-480').textContent(), /Status vs shipments/);
    const quiet = await card('Creytex-400').textContent();
    assert.match(quiet, /No shipment logged/);
    assert.doesNotMatch(quiet, /days late/, 'no shipment logged is not "on time" and not "late"');

    // ── Attaching a shipment to an existing booking, from the drawer ─────
    await page.click('[data-tab="shipments"]');
    await shipRow('sC').locator('button').first().click();
    assert.equal(await page.locator('#shipDrawer').isVisible(), true);
    const select = page.locator('[data-booking-select="sC"]');
    assert.equal(await select.inputValue(), '');
    assert.match(await page.locator('.po-ship-booking-note').first().textContent(), /No booking/);
    await select.selectOption('b1');
    await page.waitForFunction(() => window.fixture.incoming_shipments.find(s => s.id === 'sC').booking_id === 'b1');
    assert.match(await page.locator('.po-ship-booking-note').first().textContent(), /travels on/);
    // sC has an ETA of its own (2026-11-20). On the booking, the BOOKING's
    // 2026-11-06 is what it travels on -- one container, one date.
    await page.evaluate(() => closeShipDrawer());
    assert.equal(await shipEta('sC'), '2026-11-06', "the booking's ETA replaces the shipment's own");
    await shipRow('sC').locator('button').first().click();

    // ── Creating a booking from the drawer, and the duplicate message ────
    await select.selectOption('');
    await page.waitForFunction(() => window.fixture.incoming_shipments.find(s => s.id === 'sC').booking_id == null);
    await page.click('[data-new-booking-for="sC"]');
    await page.fill('[data-new-booking="ref"]', 'BK-1042');
    await page.click('[data-create-booking="sC"]');
    await page.waitForFunction(() => !document.querySelector('#status').hidden);
    assert.match(await page.locator('#status').textContent(), /already exists/,
      'a duplicate reference points at the existing booking instead of making a second');
    assert.equal(await page.evaluate(() => window.fixture.shipment_bookings.length), 1);
    await page.fill('[data-new-booking="ref"]', 'BK-2001');
    await page.fill('[data-new-booking="forwarder"]', 'Maersk');
    await page.fill('[data-new-booking="eta"]', '2027-02-02');
    await page.click('[data-create-booking="sC"]');
    await page.waitForFunction(() => window.fixture.shipment_bookings.length === 2);
    assert.equal(await page.evaluate(() => window.fixture.incoming_shipments.find(s => s.id === 'sC').booking_id),
      await page.evaluate(() => window.fixture.shipment_bookings.find(b => b.booking_ref === 'BK-2001').id),
      'the new booking is attached to the shipment it was created from');
    assert.equal(await page.evaluate(() => window.fixture.shipment_bookings.find(b => b.booking_ref === 'BK-2001').eta), '2027-02-02');

    // ── A booking with no dates does not blank the shipment's own ────────
    await page.evaluate(() => {
      const b = window.fixture.shipment_bookings.find(x => x.booking_ref === 'BK-2001');
      b.eta = null; b.etd = null; window.resyncBookings();
      return loadShipments().then(() => renderShipDrawer());
    });
    assert.match(await page.locator('.po-ship-booking-note').first().textContent(), /no dates yet/);
    await page.evaluate(() => closeShipDrawer());
    assert.equal(await shipEta('sC'), '2026-11-20',
      "the shipment's own ETA still shows when its booking has none");

    // ── Bookings CSV ─────────────────────────────────────────────────────
    await page.click('[data-tab="bookings"]');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnExportBookings'),
    ]);
    const exported = parseCsv(fs.readFileSync(await download.path(), 'utf8'));
    const bk = exported.find(r => r.booking_ref === 'BK-1042');
    assert.equal(bk.forwarder, 'Flexport');
    assert.equal(bk.container_ref, 'MSKU7654321');
    assert.equal(bk.po_count, '2');
    assert.equal(bk.po_names, 'Incotexco-480, Incotexco-486');
    assert.equal(bk.effective_eta, '2026-11-06');

    // ── Deleting a booking keeps its shipments ───────────────────────────
    await page.evaluate(() => { window.confirm = () => true; });
    await bookingRow('b1').locator('[data-delete-booking]').click();
    await page.waitForFunction(() => window.fixture.shipment_bookings.every(b => b.id !== 'b1'));
    assert.equal(await page.evaluate(() => window.fixture.incoming_shipments.filter(s => ['sA','sB'].includes(s.id)).length), 2,
      'the shipments survive their booking');
    await page.click('[data-tab="shipments"]');
    await page.waitForFunction(() => document.querySelector('[data-shipment-row="sA"]').textContent.includes('No booking'));
    assert.match(await shipRow('sA').textContent(), /No booking/);

    // ── A failed save says so and does not leave a wrong value on screen ─
    await page.click('[data-tab="bookings"]');
    const remaining = await page.evaluate(() => window.fixture.shipment_bookings[0].id);
    await page.evaluate((id) => { window.failSave = true; return updateBookingField(id, 'status', 'Cancelled'); }, remaining);
    await page.waitForFunction(() => !document.querySelector('#status').hidden);
    assert.match(await page.locator('#status').textContent(), /Synthetic save failure/);
    assert.notEqual(await page.evaluate(() => window.fixture.shipment_bookings[0].status), 'Cancelled');

    assert.deepEqual(errors, []);
    console.log('PASS bookings: container spanning POs, booking dates winning, actual arrival, plan-vs-shipments on the PO card, attach/create/delete from the drawer, CSV, failed save');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
