/* PO Report's drafted deliveries card (receiving:write, 20261117220000):
 * what a person is shown before they turn an AI's reading of a receiving
 * document into a shipment, and what happens when they answer it.
 *
 * Runs the actual inline page script and DOM with synthetic, in-memory SDK
 * data. No credentials, external requests, or production writes.
 *
 * What is worth asserting here, and why:
 *   * the card is HIDDEN when nothing is waiting, so the tab is unchanged for
 *     a company that does not use this;
 *   * every line shows ordered against receiving and the variance, because the
 *     variance is the thing the person is being asked to accept;
 *   * the over-receipt, the uncertain match, the document's own wording and
 *     "document counts, not a warehouse count" are all on screen -- a draft
 *     that hides its own doubts is worse than no draft;
 *   * Confirm calls the confirm RPC and nothing else, and a PO status the
 *     person's account may not change is REPORTED, not swallowed;
 *   * Discard records nothing;
 *   * a page whose database does not have the RPCs yet renders as before.
 *
 * Mutations (each must fail this suite):
 *   PO_RECEIPT_MUTATION=always-visible  the card shows even with nothing waiting
 *   PO_RECEIPT_MUTATION=no-variance     the variance column is not computed
 *   PO_RECEIPT_MUTATION=silent-po       a refused PO status reports as success
 *   PO_RECEIPT_MUTATION=no-source-text  the document's own wording is not shown
 *   PO_RECEIPT_MUTATION=hard-fail       a missing RPC breaks the page
 *
 * Run: node v2/tests/browser/po-report-drafted-receipts.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
let source = fs.readFileSync(path.join(root, 'v2/po-report.html'), 'utf8');

const mutations = {
  'always-visible': ["el.receiptCard.classList.toggle('hidden-safe', !list.length);", "el.receiptCard.classList.remove('hidden-safe');"],
  'no-variance': ['const variance = qty - ordered;', 'const variance = 0;'],
  'silent-po': ["} else if(data && data.po_status_requested && data.po_status_applied !== true){", '} else if(false){'],
  'no-source-text': ['${l.source_text ? `<span class="po-receipt-src', '${false ? `<span class="po-receipt-src'],
  'hard-fail': ['      } catch (err) {\n        state.receipts = [];\n      }', '      } finally {\n      }'],
};
if (process.env.PO_RECEIPT_MUTATION) {
  const m = mutations[process.env.PO_RECEIPT_MUTATION];
  assert.ok(m && source.includes(m[0]), 'known mutation target');
  source = source.replace(...m);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v2/po-report.html') {
        return route.fulfill({ contentType: 'text/html', body: source.replace(/<script\b[^>]*src=[^>]*>[\s\S]*?<\/script>/g, '') });
      }
      if (url.hostname === 'fixture.test' && url.pathname.endsWith('.css')) {
        const file = path.join(root, url.pathname);
        if (fs.existsSync(file)) return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(file) });
      }
      return route.abort();
    });

    await page.addInitScript(() => {
      const po = { id: 'p1', po_name: 'Autumn PO', status: 'Sent to Factory', factory_name: 'Factory A',
        expected_arrival_date: '2026-11-01', date_bucket: 'Fall', current_eta: '2026-11-16',
        effective_arrival_date: '2026-11-16', arrival_variance_days: 15, arrival_state: 'in_transit',
        shipment_count: 0, status_conflicts_with_shipments: false };
      const line = { po_header_id: 'p1', po_line_id: 'l1', product_title: 'Cap', sku: 'CAP', qty: 100, status: 'Sent to Factory' };
      // The shape silo_receiving_draft_json() returns, as the database builds it.
      const draft = {
        draft_id: 'd1', state: 'pending', po_header_id: 'p1', po_name: 'Autumn PO',
        shipment_status: 'Delivered', ship_date: '2026-10-23', eta: null, received_date: '2026-11-16',
        tracking_number: null, carrier: null, container_ref: 'KCMTAR-38/39/42',
        warehouse_location: 'WH3', received_by: 'Bennet', notes: 'Counts from the packing list.',
        qty_basis: 'expected', source_label: 'Slack #receiving',
        source_url: 'https://example.slack.test/archives/C1/p1700000000',
        suggested_po_status: 'Received', via: 'Claude',
        lines: [
          { po_line_id: 'l1', sku: 'CAP', title: 'Cap', variant: 'One size', qty: 106, ordered: 100,
            source_text: 'CAP', notes: null, match: 'sku_exact' },
          { po_line_id: 'l2', sku: 'TEE', title: 'Tee', variant: 'M', qty: 18, ordered: 20,
            source_text: 'blue crewneck', notes: null, match: 'check' },
        ],
        totals: { lines: 2, units_receiving: 124, units_ordered_on_those_lines: 120, variance_units: 4 },
        over_receipt_lines: [{ sku: 'CAP', ordered: 100, receiving: 106, already_received: 0 }],
        lines_to_check: [{ sku: 'TEE', source_text: 'blue crewneck' }],
        po_lines_not_in_this_receipt: ['HAT'],
        confirm_in_silo: '/v2/po-report.html?receipt=d1',
        what_happens_next: 'Nothing has changed in SILO.',
        tell_the_person: 'Say which lines you were not sure about.',
      };
      window.fixture = {
        v_po_incoming_summary: [po],
        v_po_incoming_lines: [line],
        factories: [],
        v_shipment_booking_summary: [],
        incoming_shipments: [],
        incoming_shipment_lines: [],
      };
      /* The fixture's mode comes from the URL, not from a page.evaluate:
         addInitScript runs again on every navigation, so anything set on the
         previous page is gone by the time the next one loads -- which quietly
         made two of these cases test nothing at all. */
      const mode = new URLSearchParams(location.search).get('fixture') || '';
      window.drafts = mode === 'empty' ? [] : [draft];
      window.rpcMissing = mode === 'norpc';
      window.rpcCalls = [];
      // What the confirm RPC answers. The default is the interesting case: the
      // shipment landed and the PO status did NOT, because this account may
      // not change that purchase order.
      window.confirmAnswer = { draft_id: 'd1', state: 'applied', changed: true, shipment_id: 's-new',
        po_status_requested: 'Received', po_status_applied: false,
        message: 'Shipment recorded. The PO\'s status was not changed.' };
      window.__SILO_CONFIG__ = { SUPABASE_URL: 'https://fixture.test', SUPABASE_ANON_KEY: 'fixture' };
      window.supabase = { createClient: () => ({
        rpc(name, args) {
          window.rpcCalls.push({ name, args });
          if (window.rpcMissing) return Promise.resolve({ data: null, error: { message: 'function does not exist' } });
          if (name === 'silo_receiving_pending_drafts') return Promise.resolve({ data: window.drafts, error: null });
          if (name === 'silo_receiving_confirm_draft') { window.drafts = []; return Promise.resolve({ data: window.confirmAnswer, error: null }); }
          if (name === 'silo_receiving_reject_draft') { window.drafts = []; return Promise.resolve({ data: { state: 'rejected', changed: true }, error: null }); }
          return Promise.resolve({ data: null, error: null });
        },
        from(table) {
          let payload, op = 'select', ids, single = false;
          const query = {
            select() { return query; }, order() { return query; },
            single() { single = true; return query; },
            insert(v) { op = 'insert'; payload = v; return query; },
            update(v) { op = 'update'; payload = v; return query; },
            delete() { op = 'delete'; return query; },
            eq(k, v) { ids = [v]; return query; }, in(k, v) { ids = v; return query; },
            then(resolve) {
              let rows = window.fixture[table] || [];
              if (op === 'update') rows.filter((r) => ids.includes(r.id)).forEach((r) => Object.assign(r, payload));
              if (op === 'insert') rows.push(...[payload].flat().map((r, i) => ({ id: 'new-' + i, ...r })));
              const out = single ? (rows[0] || null) : rows;
              return Promise.resolve({ data: JSON.parse(JSON.stringify(out ?? null)), error: null }).then(resolve);
            },
          };
          return query;
        },
      }) };
    });

    await page.goto('https://fixture.test/v2/po-report.html');
    await page.waitForFunction(() => document.querySelector('#receiptCard')
      && !document.querySelector('#receiptCard').classList.contains('hidden-safe'));

    // The link the AI hands the person lands on the right tab.
    await page.goto('https://fixture.test/v2/po-report.html?receipt=d1');
    await page.waitForFunction(() => document.querySelector('[data-receipt="d1"]'));
    assert.equal(await page.locator('[data-panel="shipments"]').isVisible(), true,
      'the ?receipt= link opens the Shipments tab, not the default one');

    const card = page.locator('[data-receipt="d1"]');
    const text = await card.textContent();
    assert.match(text, /Autumn PO/);
    assert.match(text, /Drafted by Claude/, 'the person is told which application drafted it');
    assert.match(text, /Slack #receiving/);
    assert.equal(await card.locator('a[href="https://example.slack.test/archives/C1/p1700000000"]').count(), 1,
      'the source document is one click away');
    assert.match(text, /124 units · 2 lines/);
    assert.match(text, /1 line over ordered/, 'the over-receipt is on screen');
    assert.match(text, /1 line to check/, 'and so is the match the AI was unsure about');
    assert.match(text, /Document counts, not a warehouse count/);
    assert.match(text, /1 PO line not in this delivery/);
    assert.match(text, /Sets PO to Received/);
    assert.match(text, /KCMTAR-38\/39\/42/);
    assert.match(text, /Received 2026-11-16/);

    // Ordered, receiving and the variance, per line.
    const rowText = async (i) => (await card.locator('tbody tr').nth(i).textContent()).replace(/\s+/g, ' ');
    assert.match(await rowText(0), /CAP.*Document: CAP.*One size 100 106 \+6/);
    assert.match(await rowText(1), /TEE.*Document: blue crewneck · check this match.*M 20 18 -2/,
      'an uncertain line shows the document\'s own wording and says to check it');
    assert.equal(await card.locator('.po-receipt-over').count() > 0, true, 'the over-receipt is marked');

    // Nothing is recorded by merely looking at it.
    assert.deepEqual(await page.evaluate(() => window.rpcCalls.map((c) => c.name)),
      ['silo_receiving_pending_drafts'], 'rendering a draft calls nothing but the read');

    // Confirming: one RPC, and the refused PO status is reported.
    await card.locator('[data-confirm-receipt="d1"]').click();
    await page.waitForFunction(() => document.querySelector('#receiptCard').classList.contains('hidden-safe'));
    const calls = await page.evaluate(() => window.rpcCalls);
    const confirmCall = calls.find((c) => c.name === 'silo_receiving_confirm_draft');
    assert.deepEqual(confirmCall.args, { p_draft_id: 'd1' }, 'the page sends the draft id and nothing else');
    assert.equal(calls.filter((c) => c.name === 'silo_receiving_confirm_draft').length, 1, 'confirmed once');
    const status = await page.locator('#status').textContent();
    assert.match(status, /status was not changed/,
      'a PO this account may not change is said out loud, not swallowed');

    // Discarding records nothing.
    await page.goto('https://fixture.test/v2/po-report.html');
    await page.evaluate(() => { window.rpcCalls = []; });
    await page.waitForFunction(() => document.querySelector('[data-receipt="d1"]'));
    await page.click('[data-tab="shipments"]');
    await page.locator('[data-discard-receipt="d1"]').click();
    await page.waitForFunction(() => document.querySelector('#receiptCard').classList.contains('hidden-safe'));
    const after = await page.evaluate(() => window.rpcCalls.map((c) => c.name));
    assert.ok(after.includes('silo_receiving_reject_draft'));
    assert.ok(!after.includes('silo_receiving_confirm_draft'), 'discarding never confirms');
    assert.match(await page.locator('#status').textContent(), /Nothing was recorded/);

    // Nothing waiting: the card is not in the page at all, on the tab where it
    // lives (a hidden panel would make any assertion about it pass).
    await page.goto('https://fixture.test/v2/po-report.html?fixture=empty');
    await page.waitForFunction(() => document.querySelector('#statusFilter').options.length > 1);
    await page.click('[data-tab="shipments"]');
    assert.equal(await page.locator('#receiptCard').isVisible(), false,
      'a company with nothing drafted sees the tab exactly as before');
    assert.equal(await page.locator('[data-receipt]').count(), 0);

    // A database without the RPCs yet: the page still loads the rest. The
    // receipts read happens BEFORE the filters are populated, so a refusal
    // that is not caught takes the whole page with it.
    await page.goto('https://fixture.test/v2/po-report.html?fixture=norpc');
    await page.waitForFunction(() => document.querySelector('#statusFilter').options.length > 1,
      'the filters, which are populated after the receipts are read, still render');
    await page.click('[data-tab="shipments"]');
    assert.equal(await page.locator('#receiptCard').isVisible(), false);
    assert.equal(await page.locator('#shipmentTableCount').textContent(), '0');
    assert.deepEqual(errors, [], 'a missing RPC must not break PO Report');

    console.log('PASS drafted deliveries: variance and doubts on screen, confirm reports a refused PO status, discard records nothing, fail-soft without the RPCs');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
