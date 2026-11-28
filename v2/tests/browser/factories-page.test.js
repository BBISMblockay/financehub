/* /v2/factories.html, rebuilt 2026-11-28.
 *
 * What the page used to be: 145 rows of editable inputs, sorted by name, with
 * nothing on the row to say whether the factory is one you order from. Three
 * things it got wrong that this suite pins:
 *
 *   1. It read a `contact_phone` column. The column is `phone`, so every
 *      phone cell on the live page read "Column missing".
 *   2. `payment_terms`, `shipping_terms`, `address` and `is_active` exist on
 *      the table and the page never showed any of them.
 *   3. Delete was offered for every row, including factories with PO history
 *      (the FK is `on delete restrict`, so it was an error message waiting to
 *      happen). Archive is the path now; delete only with no POs.
 *
 * And the new judgement: which POs are "not sent" is read from the company's
 * own po_status_options (is_open / is_final), never a list in the page.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('factories-page');

const CO = 'test-company';

const factory = (o) => Object.assign({
  id: 'fac-x', factory_name: 'Factory X', short_code: null, contact_name: null, contact_email: null,
  phone: null, payment_terms: null, shipping_terms: null, address: null, country: null, notes: null,
  is_active: true, company_entity_id: CO,
}, o);

const po = (o) => Object.assign({
  id: 'po-x', po_name: 'PO-X', factory_id: 'fac-1', status: 'Sent to Factory',
  order_date: '2026-09-01', req_ship_date: '2026-10-01', expected_arrival_date: '2026-11-01',
  total_units: 100, effective_arrival_date: null, arrival_variance_days: null, company_entity_id: CO,
}, o);

/* Two factories with history and one that has never been ordered from. */
const FACTORIES = [
  factory({ id: 'fac-1', factory_name: 'Incotexco', short_code: 'IN', country: 'Colombia',
            contact_name: 'Ana', contact_email: 'ana@incotexco.test', phone: '+57 555 0101',
            payment_terms: '30/70', shipping_terms: 'FOB Cartagena', address: 'Calle 1' }),
  factory({ id: 'fac-2', factory_name: 'Shaoxing Tianyun', country: 'China' }),
  factory({ id: 'fac-3', factory_name: 'Never Used Co', country: 'Vietnam' }),
  factory({ id: 'fac-4', factory_name: 'Retired Vendor', is_active: false }),
];

const POS = [
  // Incotexco: 1 open (4,000u), 1 draft (500u), 1 received 90 days after order, late.
  po({ id: 'po-1', po_name: 'IN-900', factory_id: 'fac-1', status: 'In Production', total_units: 4000, order_date: '2026-10-01' }),
  po({ id: 'po-2', po_name: 'IN-901', factory_id: 'fac-1', status: 'Draft', total_units: 500, order_date: '2026-11-20' }),
  po({ id: 'po-3', po_name: 'IN-800', factory_id: 'fac-1', status: 'Received', total_units: 2000,
       order_date: '2026-06-01', effective_arrival_date: '2026-08-30', arrival_variance_days: 12 }),
  // Shaoxing: 1 open, smaller, and one received on time.
  po({ id: 'po-4', po_name: 'SX-700', factory_id: 'fac-2', status: 'Sent to Factory', total_units: 900, order_date: '2026-11-02' }),
  po({ id: 'po-5', po_name: 'SX-600', factory_id: 'fac-2', status: 'Received', total_units: 300,
       order_date: '2026-07-01', effective_arrival_date: '2026-08-10', arrival_variance_days: -3 }),
];

/* The company's steps. 'Awaiting approval' is this company's own pre-send
 * stage: neither open nor final, so a PO sitting at it counts as not sent. */
const STEPS = [
  { name: 'Draft', sort_order: 10, is_open: false, is_final: false, is_active: true },
  { name: 'Awaiting approval', sort_order: 15, is_open: false, is_final: false, is_active: true },
  { name: 'Sent to Factory', sort_order: 30, is_open: true, is_final: false, is_active: true },
  { name: 'In Production', sort_order: 50, is_open: true, is_final: false, is_active: true },
  { name: 'Received', sort_order: 90, is_open: false, is_final: true, is_active: true },
  { name: 'Closed', sort_order: 100, is_open: false, is_final: true, is_active: true },
];

/* The queue a person fills in SILO: one PO already with a connection, one
 * already sent. The draft itself comes from the database function, never from
 * the page, so the fixture answers that RPC. */
const EMAILS = [
  { id: 'em-1', po_header_id: 'po-1', factory_id: 'fac-1', to_email: 'ana@incotexco.test',
    subject: 'IN-900', body: 'body', status: 'claimed', queued_at: '2026-11-27T10:00:00Z',
    claimed_by_app: 'Claude', company_entity_id: CO },
  { id: 'em-2', po_header_id: 'po-4', factory_id: 'fac-2', to_email: 'sx@tianyun.test',
    subject: 'SX-700', body: 'body', status: 'sent', queued_at: '2026-11-20T10:00:00Z',
    sent_at: '2026-11-21T09:00:00Z', sent_via: 'Claude', company_entity_id: CO },
];

const DRAFT = {
  po_header_id: 'po-2', po_name: 'IN-901', factory_id: 'fac-1', factory_name: 'Incotexco',
  to_email: 'ana@incotexco.test',
  subject: 'Demo Apparel Inc. IN-901 · 500 units · ship by 05 Jan 2027',
  body: 'Hi Ana,\n\nPlease find attached purchase order IN-901.',
  styles: 2, units: 500, attachment_filename: 'IN-901.pdf', missing: [],
};

const tables = (over = {}) => Object.assign({
  factories: FACTORIES,
  v_po_header_summary: POS,
  po_status_options: STEPS.map((s) => Object.assign({ company_entity_id: CO }, s)),
  po_vendor_emails: EMAILS,
  profiles: [{ id: 'u1', email: 'tester@example.com', role: 'admin' }],
}, over);

/* open()'s rpc fixtures are eval'd in the page, so each value is SOURCE, not
 * an object: a plain object arrives as "[object Object]" and the page then
 * fails to parse it. */
const RPCS = { po_vendor_email_draft: `(() => (${JSON.stringify(DRAFT)}))` };

const READY = { rpc: RPCS, ready: () => document.querySelectorAll('#factoryTbody tr[data-row-id]').length > 0 };

const rowNames = (page) => page.$$eval('#factoryTbody tr[data-row-id] .fac-name',
  (nodes) => nodes.map((n) => (n.childNodes[0] ? n.childNodes[0].textContent : n.textContent).trim()));
const cells = (page, id) => page.$eval(`tr[data-row-id="${id}"]`,
  (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
const text = (page, sel) => page.$eval(sel, (n) => n.textContent.trim());

(async () => {
  const suite = await startSuite();
  try {
    // ── 1. the list opens on factories you actually order from ─────────────
    let page = await suite.open('/v2/factories.html', tables(), READY);

    let names = await rowNames(page);
    R.test('opens on the factories with PO history, ranked by open units', () => {
      R.eq(names, ['Incotexco', 'Shaoxing Tianyun']);
    });
    R.test('a factory never ordered from is not in the default view', () => {
      R.eq(names.includes('Never Used Co'), false);
    });
    R.test('an archived factory is not in the default view either', () => {
      R.eq(names.includes('Retired Vendor'), false);
    });

    const inco = await cells(page, 'fac-1');
    R.test('the row carries PO context, not just contact fields', () => {
      R.eq(inco[1], '1', 'one open PO (In Production)');
      R.eq(inco[2], '4,000', 'its units');
      R.eq(inco[3], '1', 'one PO not yet sent (Draft)');
      R.eq(inco[4], '90d', 'lead time from order to arrival');
      R.eq(inco[5], '0 of 1', 'and it landed late');
      R.eq(inco[6], '2026-11-20', 'last order date');
    });

    const sx1 = await cells(page, 'fac-2');
    R.test('a factory with no email says so on the row', () => {
      R.eq(sx1[7], 'Add email');
      R.eq(inco[7], 'ana@incotexco.test', 'and one with an email shows it');
    });

    const kpis = {
      ordered: await text(page, '#kpiOrdered'),
      openPos: await text(page, '#kpiOpenPos'),
      preSend: await text(page, '#kpiPreSend'),
      noEmail: await text(page, '#kpiNoEmail'),
      noEmailSub: await text(page, '#kpiNoEmailSub'),
    };
    R.test('the KPI band counts the email gap against the factories you use', () => {
      R.eq(kpis.ordered, '2');
      R.eq(kpis.openPos, '2');
      R.eq(kpis.preSend, '1');
      R.eq(kpis.noEmail, '2', 'Shaoxing and Never Used Co');
      R.truthy(kpis.noEmailSub.includes('1'), 'one of them you order from');
    });

    // ── 2. the activity filter reaches the rest ────────────────────────────
    await page.selectOption('#activityFilter', 'never');
    await page.waitForFunction(() => document.querySelectorAll('#factoryTbody tr[data-row-id]').length === 1);
    const neverRows = await rowNames(page);
    R.test('"never ordered" finds the factory with no POs', () => {
      R.eq(neverRows, ['Never Used Co']);
    });
    await page.selectOption('#activityFilter', 'archived');
    await page.waitForFunction(() => document.querySelectorAll('#factoryTbody tr[data-row-id]').length === 1);
    const archivedRows = await rowNames(page);
    R.test('"archived" is the only way to see an archived factory', () => {
      R.eq(archivedRows, ['Retired Vendor']);
    });
    await page.selectOption('#activityFilter', 'ordered');
    await page.waitForFunction(() => document.querySelectorAll('#factoryTbody tr[data-row-id]').length === 2);

    // ── 3. the drawer shows the fields the old page never did ──────────────
    await page.click('tr[data-row-id="fac-1"]');
    await page.waitForFunction(() => !document.getElementById('facDrawer').hidden);
    const detail = await page.$eval('#dDetails', (n) => n.textContent.replace(/\s+/g, ' ').trim());
    R.test('the drawer shows phone from `phone`, and the terms and address', () => {
      R.truthy(detail.includes('+57 555 0101'), 'phone, which the old page read as contact_phone and lost');
      R.truthy(detail.includes('30/70'), 'payment terms');
      R.truthy(detail.includes('FOB Cartagena'), 'shipping terms');
      R.truthy(detail.includes('Calle 1'), 'address');
    });
    const acts = await page.$$eval('#dFoot [data-act]', (ns) => ns.map((n) => n.getAttribute('data-act')));
    R.test('a factory with PO history is not offered Delete', () => {
      R.eq(acts.includes('delete'), false, 'the FK is on delete restrict');
      R.truthy(acts.includes('archive'), 'archive is the path');
    });
    const drawerPos = await page.$$eval('#dPoWrap .fac-po-name',
      (ns) => ns.map((n) => n.textContent.trim().split(' ')[0]));
    R.test('the drawer lists the factory\'s POs, newest first', () => {
      R.eq(drawerPos, ['IN-901', 'IN-900', 'IN-800']);
    });

    // ── 4. editing writes only what changed ────────────────────────────────
    await page.click('#dFoot [data-act="edit"]');
    await page.waitForFunction(() => !document.getElementById('dForm').hidden);
    await page.fill('#eContactEmail', 'new@incotexco.test');
    await page.click('#dFoot [data-act="save"]');
    await page.waitForFunction(() => document.getElementById('dForm').hidden);
    const writes = await page.evaluate(() => window.__QUERIES__
      .filter((q) => q._op === 'update' && q.table === 'factories')
      .map((q) => q.patch));
    R.test('saving sends only the column that changed', () => {
      R.eq(writes.length, 1);
      R.eq(Object.keys(writes[0]), ['contact_email']);
      R.eq(writes[0].contact_email, 'new@incotexco.test');
    });

    // ── 5. archive is a write of is_active, not a delete ───────────────────
    await page.click('#dFoot [data-act="archive"]');
    await page.waitForFunction(() => document.querySelectorAll('#factoryTbody tr[data-row-id]').length === 1);
    const arch = await page.evaluate(() => window.__QUERIES__
      .filter((q) => q._op === 'update' && q.table === 'factories' && 'is_active' in (q.patch || {}))
      .map((q) => q.patch));
    const afterArchive = await rowNames(page);
    const anyDelete = await page.evaluate(() => window.__QUERIES__.some((q) => q._op === 'delete'));
    R.test('archiving flips is_active and drops the row out of the default view', () => {
      R.eq(arch, [{ is_active: false }]);
      R.eq(afterArchive, ['Shaoxing Tianyun']);
      R.eq(anyDelete, false, 'nothing was deleted');
    });
    await page.close();

    // ── 6. "not sent" follows the company's own steps ──────────────────────
    // Shaoxing's open PO is moved to this company's own pre-send stage. It is
    // neither open nor final, so the PO counts as not sent — no list of status
    // names in the page could know that.
    const ownStage = tables({
      v_po_header_summary: POS.map((p) => (p.id === 'po-4' ? Object.assign({}, p, { status: 'Awaiting approval' }) : p)),
    });
    page = await suite.open('/v2/factories.html', ownStage, READY);
    const sx2 = await cells(page, 'fac-2');
    const preSend2 = await text(page, '#kpiPreSend');
    R.test('a company-defined stage that is neither open nor final counts as not sent', () => {
      R.eq(sx2[1], '—', 'not counted as open');
      R.eq(sx2[3], '1', 'counted as not sent');
      R.eq(preSend2, '2');
    });
    await page.close();

    // ── 7. the steps table is unreadable: the page still classifies ───────
    page = await suite.open('/v2/factories.html', tables(), Object.assign({ broken: ['po_status_options'] }, READY));
    const fbRows = await rowNames(page);
    const fbSx = await cells(page, 'fac-2');
    const fbInco = await cells(page, 'fac-1');
    R.test('without po_status_options the page falls back and still loads', () => {
      R.eq(fbRows, ['Incotexco', 'Shaoxing Tianyun']);
      R.eq(fbSx[1], '1', 'Sent to Factory still reads as open');
      R.eq(fbInco[3], '1', 'and Draft still reads as not sent');
    });
    await page.close();

    // ── 8. queueing a PO email ────────────────────────────────────────────
    page = await suite.open('/v2/factories.html', tables(), READY);
    const kpiQueued = await text(page, '#kpiQueued');
    const kpiQueuedSub = await text(page, '#kpiQueuedSub');
    R.test('the KPI counts what is queued and what a connection already has', () => {
      R.eq(kpiQueued, '0', 'nothing is queued');
      R.truthy(kpiQueuedSub.includes('1'), 'one is with the AI now');
    });

    await page.click('tr[data-row-id="fac-1"]');
    await page.waitForFunction(() => !document.getElementById('facDrawer').hidden);
    const poStates = await page.$$eval('#dPoWrap .fac-po', (nodes) => nodes.map((n) => {
      const name = n.querySelector('.fac-po-name').textContent.trim().split(' ')[0];
      const btn = n.querySelector('[data-email-po]');
      const pill = n.querySelector('.bcn-pill--accent, .bcn-pill--pos');
      return [name, btn ? btn.textContent.trim() : (pill ? pill.textContent.trim() : null)];
    }));
    R.test('each PO says where its factory email stands', () => {
      const m = Object.fromEntries(poStates);
      R.eq(m['IN-901'], 'Email', 'a draft PO with no email offers one');
      R.eq(m['IN-900'], 'With your AI', 'the one a connection claimed says so');
      R.eq(m['IN-800'], null, 'a received PO offers nothing');
    });

    await page.click('#dPoWrap [data-email-po="po-2"]');
    await page.waitForFunction(() => document.getElementById('emailModal').open
      && document.getElementById('emSubject').value.length > 0);
    const composed = await page.evaluate(() => ({
      to: document.getElementById('emTo').value,
      subject: document.getElementById('emSubject').value,
      body: document.getElementById('emBody').value,
      note: document.getElementById('emNote').textContent,
      rpcs: window.__QUERIES__.filter((q) => q._op === 'rpc').map((q) => q.table),
    }));
    R.test('the drafted copy comes from the database, not from the page', () => {
      R.truthy(composed.rpcs.includes('rpc:po_vendor_email_draft'), 'it asked the draft function');
      R.eq(composed.to, 'ana@incotexco.test');
      R.truthy(composed.subject.includes('IN-901'), 'subject carries the PO');
      R.truthy(composed.body.includes('IN-901'), 'body carries the PO');
      R.truthy(composed.note.includes('IN-901.pdf'), 'and it says what gets attached');
    });

    await page.click('#btnEmailQueue');
    await page.waitForFunction(() => window.__QUERIES__
      .some((q) => q._op === 'insert' && q.table === 'po_vendor_emails'));
    const queuedWrite = await page.evaluate(() => window.__QUERIES__
      .filter((q) => q._op === 'insert' && q.table === 'po_vendor_emails').map((q) => q.rows)[0]);
    R.test('queueing writes the copy the person saw, as queued', () => {
      R.eq(queuedWrite.po_header_id, 'po-2');
      R.eq(queuedWrite.status, 'queued');
      R.eq(queuedWrite.to_email, 'ana@incotexco.test');
      R.truthy(String(queuedWrite.body).includes('IN-901'), 'the body is the drafted one');
      R.eq(queuedWrite.factory_id, 'fac-1');
    });
    await page.close();

    // ── 9. before the migration lands, the page still works ───────────────
    page = await suite.open('/v2/factories.html', tables(),
      Object.assign({ broken: ['po_vendor_emails'] }, READY));
    await page.click('tr[data-row-id="fac-1"]');
    await page.waitForFunction(() => !document.getElementById('facDrawer').hidden);
    const noQueue = await page.evaluate(() => ({
      rows: document.querySelectorAll('#factoryTbody tr[data-row-id]').length,
      buttons: document.querySelectorAll('[data-email-po]').length,
      kpi: document.getElementById('kpiQueued').textContent.trim(),
    }));
    R.test('an unreadable email queue hides the button instead of breaking the page', () => {
      R.eq(noQueue.rows, 2, 'the list still loads');
      R.eq(noQueue.buttons, 0, 'no email buttons are offered');
      R.eq(noQueue.kpi, '—');
    });
    await page.close();

  } catch (e) {
    R.ok('suite ran to completion', false, e && e.stack);
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
