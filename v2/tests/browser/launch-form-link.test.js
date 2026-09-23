/* /v2/launch-calendar.html — the launch form's MEASUREMENT LINK.
 *
 * The real page, the real v2/launch-product-link.js, a fake Supabase. What is
 * asserted is what the page WRITES (recorded queries), not only what it shows:
 *
 *   1. an unlinked launch is not saved until the person makes a choice
 *   2. "products not known yet" is written, with no client-supplied `by`
 *   3. "attach next" writes none of the deferral columns
 *   4. linking a PO while editing a deferred launch clears the flag
 *   5. unlinked launches carry a follow-up marker and a MEASUREMENT filter
 *      finds them; a linked launch carries none
 *   6. before 20260922150000 is applied, ordinary saves still work and only
 *      the "not known yet" choice fails, naming the migration
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('launch-form-link');

const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const LAUNCHES = [
  { id: 'l-linked', title: 'Linked Drop', launch_date: day(1), status: 'planned', launch_readiness: 'not_reviewed', linked_po_id: 'po-1', company_entity_id: 'test-company' },
  { id: 'l-products', title: 'Products Drop', launch_date: day(2), status: 'planned', launch_readiness: 'not_reviewed', linked_po_id: null, company_entity_id: 'test-company' },
  { id: 'l-unknown', title: 'Mystery Drop', launch_date: day(3), status: 'planned', launch_readiness: 'not_reviewed', linked_po_id: null,
    products_unknown_at: '2026-09-01T00:00:00Z', products_unknown_note: 'waiting on factory', company_entity_id: 'test-company' },
  { id: 'l-missing', title: 'Bare Drop', launch_date: day(4), status: 'planned', launch_readiness: 'not_reviewed', linked_po_id: null, company_entity_id: 'test-company' },
];

const TABLES = {
  launch_calendar: LAUNCHES,
  launch_product_readiness: [{ id: 'pr-1', launch_id: 'l-products', product_title: 'Tee', company_entity_id: 'test-company', created_at: '2026-09-01' }],
  launch_tasks: [], launch_assets: [], launch_comments: [], launch_system_links: [],
  launch_channel_items: [], product_tracker: [], profiles: [],
};

const READY = () => {
  const s = document.getElementById('page-status');
  return s && /Ready\.|Load failed/.test(s.textContent);
};

const writes = (page) => page.evaluate(() => (window.__QUERIES__ || [])
  .filter((q) => q.table === 'launch_calendar' && (q._op === 'insert' || q._op === 'update'))
  .map((q) => ({ op: q._op, body: q._op === 'insert' ? q.rows : q.patch })));

async function newLaunch(page, title) {
  await page.click('#newLaunchBtn');
  await page.fill('#titleInput', title);
}

(async () => {
  const suite = await startSuite();
  try {
    // ── 1–3: a new launch ───────────────────────────────────────────────
    let page = await suite.open('/v2/launch-calendar.html', TABLES, { ready: READY });
    R.test('page boots on its real Supabase path', async () => {});
    R.eq(await page.textContent('#page-status'), 'Ready.', 'boot');

    await newLaunch(page, 'Fall Drop');
    const before = await page.textContent('#measureState');
    R.test('the form states the missing link before any save', () => {
      R.has(before, 'No products or PO attached');
      R.has(before, 'cannot be separated by date');
      R.not(before.toLowerCase(), 'estimat');
    });
    R.ok('the section is marked as needing a choice',
      await page.$eval('#measureSec', (e) => e.classList.contains('lf-measure--needs')));

    await page.click('#submitFormBtn');
    await page.waitForTimeout(150);
    R.eq((await writes(page)).length, 0, 'no write without a choice');
    R.test('the refusal says why, next to the choices', async () => {});
    R.has(await page.textContent('#formMsg'), 'no products or PO attached');
    R.ok('the section is flagged after the refusal',
      await page.$eval('#measureSec', (e) => e.classList.contains('lf-measure--flag')));
    R.ok('the modal stays open', await page.$eval('#launchModal', (e) => e.classList.contains('open')));

    R.ok('the note is hidden until "not known yet" is chosen', await page.$eval('#measureNote', (e) => e.hidden));
    await page.check('input[name="measureChoice"][value="unknown"]');
    R.ok('choosing "not known yet" reveals the note', !(await page.$eval('#measureNote', (e) => e.hidden)));
    R.eq(await page.textContent('#formMsg'), '', 'making a choice clears the refusal');
    await page.fill('#measureNote', 'waiting on Owen');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    let w = await writes(page);
    R.test('"not known yet" is written with its note and no client-supplied author', () => {
      R.eq(w.length, 1);
      R.eq(w[0].op, 'insert');
      R.truthy(/^\d{4}-\d{2}-\d{2}T/.test(w[0].body.products_unknown_at), 'timestamp written');
      R.eq(w[0].body.products_unknown_note, 'waiting on Owen');
      R.truthy(!('products_unknown_by' in w[0].body), 'author is stamped by the database');
    });
    R.has(await page.textContent('#page-status'), 'products not known yet', 'the saved message names the follow-up');

    await newLaunch(page, 'Winter Drop');
    await page.check('input[name="measureChoice"][value="attach_next"]');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    w = await writes(page);
    R.test('"attach next" saves and writes none of the deferral columns', () => {
      R.eq(w.length, 2);
      R.eq(Object.keys(w[1].body).filter((k) => k.startsWith('products_unknown')), []);
    });
    R.has(await page.textContent('#page-status'), 'add product lines', 'the follow-up hint is no longer overwritten');

    // ── 4: editing a deferred launch, then linking a PO ─────────────────
    await page.evaluate(() => openLaunchModal(launches.find((x) => x.id === 'l-unknown')));
    R.ok('a deferred launch opens on "not known yet"',
      await page.$eval('input[name="measureChoice"][value="unknown"]', (e) => e.checked));
    R.eq(await page.inputValue('#measureNote'), 'waiting on factory');
    await page.evaluate(() => applyPOToShell({ po_header_id: 'po-7', po_name: 'Incotexco-496', product_title: 'Tee' }));
    R.ok('once a PO is linked the choices step aside', await page.$eval('#measureChoices', (e) => e.hidden));
    R.has(await page.textContent('#measureState'), 'Linked to a PO');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    w = await writes(page);
    R.test('linking a PO clears the stored "not known yet"', () => {
      const u = w[w.length - 1];
      R.eq(u.op, 'update');
      R.eq(u.body.linked_po_id, 'po-7');
      R.eq(u.body.products_unknown_at, null);
      R.eq(u.body.products_unknown_note, null);
    });

    // "Attach next" on an EXISTING unlinked launch lands on its Products tab too.
    // Start from another tab: an earlier save may have left Products active.
    await page.evaluate(() => { switchDrawerTab('dp-tasks'); openLaunchModal(launches.find((x) => x.id === 'l-missing')); });
    await page.check('input[name="measureChoice"][value="attach_next"]');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    R.ok('editing with "attach next" opens the Products tab',
      await page.$eval('[data-dp="dp-products"]', (b) => b.classList.contains('active') || b.getAttribute('aria-selected') === 'true'));

    // A launch with attached products needs no choice.
    const n = (await writes(page)).length;
    await page.evaluate(() => openLaunchModal(launches.find((x) => x.id === 'l-products')));
    R.has(await page.textContent('#measureState'), '1 product attached');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    R.eq((await writes(page)).length, n + 1, 'attached products save without a choice');
    await page.close();

    // ── 5: follow-up visibility ─────────────────────────────────────────
    page = await suite.open('/v2/launch-calendar.html', TABLES, { ready: READY });
    await page.click('[data-tab="agenda"]');
    const markers = await page.$$eval('.agenda-row', (rows) => rows.map((r) => ({
      id: r.dataset.lid,
      m: (r.querySelector('[data-link-followup]') || {}).dataset?.linkFollowup || null,
    })));
    R.test('agenda markers: every unlinked launch, no linked one', () => {
      const by = Object.fromEntries(markers.map((x) => [x.id, x.m]));
      R.eq(by['l-linked'], null);
      R.eq(by['l-products'], null);
      R.eq(by['l-unknown'], 'unknown');
      R.eq(by['l-missing'], 'missing');
    });
    await page.click('button[aria-controls="lc2-filters"]');   // the filter bar is behind a toggle
    const filterIds = async (v) => {
      await page.selectOption('#linkFilter', v);
      return page.$$eval('.agenda-row', (rows) => rows.map((r) => r.dataset.lid).sort());
    };
    R.eq(await filterIds('needs'), ['l-missing', 'l-unknown'], 'needs = both kinds');
    R.eq(await filterIds('unknown'), ['l-unknown']);
    R.eq(await filterIds('missing'), ['l-missing']);
    R.eq(await filterIds('linked'), ['l-linked', 'l-products']);
    await page.click('#resetBtn');
    R.eq(await page.inputValue('#linkFilter'), '', 'reset clears the measurement filter');
    await page.evaluate(() => openDrawer('l-unknown'));
    R.ok('the drawer shows the marker too',
      !!(await page.$('#drawerLaunchMeta [data-link-followup="unknown"]')));

    // Attaching a product from the drawer: the database clears the flag in the
    // same transaction (trg_launch_products_unknown_clear, proven against
    // Postgres in scripts/tests/launch-products-unknown-database.test.mjs).
    // What the page owes is to READ THAT BACK rather than keep showing the
    // flag it loaded -- so assert a launch_calendar read follows each add path.
    const readBackAfterInsert = () => page.evaluate(() => {
      const q = window.__QUERIES__ || [];
      const ins = q.map((x, i) => (x.table === 'launch_product_readiness' && x._op === 'insert') ? i : -1).filter((i) => i >= 0).pop();
      return ins !== undefined && q.slice(ins + 1).some((x) => x.table === 'launch_calendar' && x._op === 'select');
    });
    await page.evaluate(() => quickAddProduct({ product_title: 'Quick Tee' }, null));
    R.ok('quick add re-reads the launch after attaching', await readBackAfterInsert());
    await page.evaluate(() => { openDrawer('l-unknown'); switchDrawerTab('dp-products'); openProductForm(null); });
    await page.fill('#prodTitle', 'Form Tee');
    await page.evaluate(() => saveProductReadiness({ preventDefault() {} }));
    R.ok('the product form re-reads the launch after attaching', await readBackAfterInsert());
    await page.close();

    // ── 6: before the migration is applied ──────────────────────────────
    page = await suite.open('/v2/launch-calendar.html', TABLES, {
      ready: READY,
      missingColumns: { launch_calendar: ['products_unknown_at', 'products_unknown_note', 'products_unknown_by'] },
    });
    await newLaunch(page, 'Pre-migration A');
    await page.check('input[name="measureChoice"][value="attach_next"]');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => !document.getElementById('launchModal').classList.contains('open'));
    R.ok('an ordinary save still works before the migration', true);
    await newLaunch(page, 'Pre-migration B');
    await page.check('input[name="measureChoice"][value="unknown"]');
    await page.click('#submitFormBtn');
    await page.waitForFunction(() => /Save failed/.test(document.getElementById('formMsg').textContent));
    R.has(await page.textContent('#formMsg'), '20260922150000', 'the failure names the migration');
    await page.close();
  } catch (err) {
    R.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = R.summary();
  process.exit(out.fail ? 1 : 0);
})();
