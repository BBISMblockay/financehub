/* /v2/products.html — the sample flow, the PO link, and the filters.
 *
 * Four things this page got wrong, each of the same family: a value that
 * cannot be recovered being presented as though it were known.
 *
 *  1. Caps offered one `Snap` chip. The POs order a youth snapback and an
 *     adult one as separate products (`Beast Mode Cap - Youth` and an adult
 *     cap BOTH ship a variant literally called `Snap`), so a size request
 *     for a youth cap read identically to an adult one. Splitting the chip
 *     is easy; what these tests hold down is the harder half — the rows that
 *     already store a bare `Snap` are neither rewritten to one of the two
 *     nor dropped, because which they meant is not recoverable.
 *
 *  2. A PO / Incoming result could not be clicked or saved.
 *     `v_launch_po_product_lookup` has NO `id` column at all — it is grouped
 *     by (PO, product title) and keys on `po_header_id` — so the picker read
 *     `r.id`, got undefined, and wrote `product_master_id=''`. The click
 *     appeared to do nothing. A PO is not a products_master row and must
 *     never be stored as one.
 *
 *  3. Expected Units is labelled "(from the originating PO)" and nothing had
 *     ever filled it, so it was typed by hand one size line at a time. It
 *     now reads `total_units`, which the view already sums across every size
 *     line for that product on that PO.
 *
 *  4. The long dropdowns (141 factories, every PO, every launch, ~130
 *     product types) are searchable. The control WRAPS a real <select>, so
 *     the tests assert on the select — the thing that actually gets saved —
 *     never on the text in the box.
 *
 * Plus the state every checkout is in between merging the page and applying
 * migration 20260915230000: `product_tracker.po_header_id` does not exist
 * yet. The page must still load, still save, and must not claim a link it
 * cannot store.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('products-page');

// v_launch_po_product_lookup rows as the real view produces them: one row per
// (PO, product title), total_units ALREADY summed over its size lines. The
// two rows are the real Incotexco-496 shape — a mens tee across 6 sizes and
// its youth counterpart across 4, which is exactly the case a per-size figure
// gets wrong.
const PO_LOOKUP = [
  { po_header_id: 'po-incotexco', po_name: 'Incotexco-496',
    product_title: 'Elevate & Celebrate T-Shirt', product_type: 'T-Shirt',
    factory_name: 'Incotexco', factory_id: 'fac-1',
    expected_arrival_date: '2026-11-02', variant_count: 6, total_units: 325 },
  { po_header_id: 'po-incotexco', po_name: 'Incotexco-496',
    product_title: 'Elevate & Celebrate T-Shirt - Youth', product_type: 'T-Shirt',
    factory_name: 'Incotexco', factory_id: 'fac-1',
    expected_arrival_date: '2026-11-02', variant_count: 4, total_units: 550 },
];

const TABLES = {
  po_headers: [
    { id: 'po-incotexco', po_name: 'Incotexco-496' },
    { id: 'po-mastercap', po_name: 'MasterCap-100' },
  ],
  factories: [
    { id: 'fac-1', factory_name: 'Incotexco' },
    { id: 'fac-2', factory_name: 'MasterCap' },
  ],
  launch_calendar: [
    { id: 'lch-1', title: 'Back To School 2026' },
    { id: 'lch-2', title: 'Holiday Drop' },
  ],
  products_master: [
    { id: 'pm-1', sku: 'M-TEE', product_title: 'Caught Stealin Tee', product_type: 'T-Shirt',
      vendor_original: 'Incotexco', subcategory: 'Tees', department: 'Mens', tags: ['bestseller'], notes: null, updated_at: '2026-09-01' },
    { id: 'pm-2', sku: 'SNAP-CAP', product_title: 'Beast Mode Cap - Youth', product_type: 'Cap',
      vendor_original: 'MasterCap', subcategory: 'Caps', department: 'Youth', tags: [], notes: null, updated_at: '2026-09-02' },
    { id: 'pm-3', sku: 'HOOD', product_title: 'Hustle Club Hoodie', product_type: 'Hoodie',
      vendor_original: 'Incotexco', subcategory: null, department: null, tags: [], notes: null, updated_at: '2026-09-03' },
    // A catalog row with no product_type at all. loadReferenceData() excludes
    // these with .not('product_type','is',null); if that ever stops being
    // honoured, the type filter grows a blank entry that reads like a real
    // category whose name did not load.
    { id: 'pm-4', sku: 'UNTYPED', product_title: 'Untyped thing', product_type: null,
      vendor_original: null, subcategory: null, department: null, tags: [], notes: null, updated_at: '2026-09-04' },
  ],
  profiles: [{ id: 'usr-1', name: 'Alec', email: 'alec@baseballism.com' }],
  product_samples: [
    // The ambiguous legacy value, on a row that is genuinely a youth cap.
    { id: 'smp-legacy', sample_ref: 'S-001', product_title: 'Beast Mode Cap - Youth',
      sample_status: 'warehouse_ready', sizes_ready_warehouse: 'Snap',
      size_requests: null, sizes_picked_up: null, photo_status: 'pending', copy_status: 'pending' },
    { id: 'smp-clean', sample_ref: 'S-002', product_title: 'Caught Stealin Tee',
      sample_status: 'pps_received', sizes_ready_warehouse: 'M, L',
      size_requests: null, sizes_picked_up: null, photo_status: 'pending', copy_status: 'pending' },
  ],
  // Carries a factory, a type and a launch, because "+ New Sample from this
  // Product" copies those three across into the sample drawer — and all three
  // are searchable selects there.
  product_tracker: [{ id: 'trk-1', product_title: 'Existing pipeline item', expected_units: 75,
    photo_complete: 'pending', factory_id: 'fac-2', product_type: 'Cap', launch_id: 'lch-1',
    collection: 'Caps', product_master_id: null, product_title_snapshot: null }],
  product_sample_tracker_links: [],
  v_launch_po_product_lookup: PO_LOOKUP,
  sample_notification_log_v: [],
  product_sample_activity: [],
  launch_product_readiness: [],
};

// The pipeline KPI band is the last thing boot() fills, so it is the honest
// "the page has finished loading" signal.
const READY = () => {
  const n = document.getElementById('ptKpiTotal');
  return n && n.textContent !== '—';
};

const capChips = (page, gridId) => page.$$eval(`#${gridId} .smp-size-chip`, (els) => els.map((e) => ({
  label: e.querySelector('span').textContent,
  value: e.querySelector('.ck-whs').dataset.size,
  checked: e.querySelector('.ck-whs').checked,
  legacy: e.classList.contains('smp-size-chip--legacy'),
})));

// The combobox is a view over a real <select>; address it through the select
// it wraps so a test can never pass by reading its own input box.
const combo = (id) => `.smp-combo:has(#${id})`;

(async () => {
  const suite = await startSuite();

  try {
    // ── 1. youth snapback vs adult snapback ────────────────────────────────
    const page = await suite.open('/v2/products.html', TABLES, { ready: READY });

    await page.click('.bcn-tab[data-tab="samples"]');
    await page.click('#btnNew');

    const fresh = await capChips(page, 'sizeGridCaps');
    R.test('a new sample is offered both snapbacks, and neither is a bare "Snap"', () => {
      R.eq(fresh.map((c) => c.label),
        ['Youth Snap', 'Adult Snapback', '6⅞', '7', '7⅛', '7¼', '7⅜', '7½', 'One Size'],
        'cap chip labels');
      R.eq(fresh[0].value, 'Youth Snap', 'the youth chip stores a youth value');
      R.eq(fresh[1].value, 'Adult Snap', 'the adult chip stores an adult value');
      R.truthy(!fresh.some((c) => c.value === 'Snap'),
        'a NEW sample must never be offered the value nobody can interpret');
    });

    await page.check('#sizeGridCaps .smp-size-chip:nth-child(1) .ck-whs');
    const ticked = await page.evaluate(() => Array.from(
      document.querySelectorAll('#drawer input[data-kind="whs"]:checked')).map((c) => c.dataset.size).join(', '));
    R.test('ticking Youth Snap is what gets saved', () => R.eq(ticked, 'Youth Snap'));

    await page.click('#btnCancelDrawer');
    await page.click('#samplesBody tr[data-id="smp-legacy"]');
    const legacyChips = await capChips(page, 'sizeGridCaps');
    R.test('a row that already stores "Snap" keeps it, labelled for what it is', () => {
      const legacy = legacyChips.find((c) => c.value === 'Snap');
      R.truthy(legacy, 'the stored value must still have a chip, or re-saving this row would delete it');
      R.eq(legacy.checked, true, 'and it must still be ticked');
      R.eq(legacy.label, 'Snap (legacy)');
      R.eq(legacy.legacy, true, 'and be marked as legacy, not offered as a size to pick');
      R.eq(legacyChips.filter((c) => c.checked).length, 1,
        'it must NOT be silently re-read as the adult snapback');
    });

    await page.click('#btnCancelDrawer');
    await page.click('#samplesBody tr[data-id="smp-clean"]');
    const cleanValues = await page.$$eval('#sizeGridCaps .ck-whs', (els) => els.map((e) => e.dataset.size));
    R.test('a row that never stored it gets no legacy chip', () =>
      R.truthy(!cleanValues.includes('Snap'), 'got: ' + JSON.stringify(cleanValues)));
    await page.click('#btnCancelDrawer');

    // ── 2. PO / Incoming can be clicked, and lands in the right column ─────
    await page.click('#btnNew');
    await page.evaluate(() => { document.getElementById('moreDetailsSection').open = true; });
    await page.selectOption('#prodSource', 'po_incoming');
    await page.fill('#prodSearchInput', 'Elevate');
    await page.waitForSelector('#prodSearchResults.open .smp-prod-hit');

    const metas = await page.$$eval('#prodSearchResults .smp-prod-hit-meta', (e) => e.map((x) => x.textContent));
    R.test('the picker shows the COMBINED units and the size-line count before you pick', () => {
      R.has(metas[0], '325 units', 'the 6 mens size lines, summed');
      R.has(metas[0], '6 size lines', 'and how many lines that is, so it is checkable against the PO');
      R.has(metas[1], '550 units', 'the youth row is its own product with its own 4 lines');
    });

    await page.click('#prodSearchResults .smp-prod-hit:first-child');
    await page.waitForSelector('#linkedProductChip .smp-linked-chip--po');
    const linked = await page.evaluate(() => ({
      po: document.getElementById('fldPoHeaderId').value,
      poLabel: document.getElementById('fldPoHeaderId').selectedOptions[0] && document.getElementById('fldPoHeaderId').selectedOptions[0].textContent,
      master: document.getElementById('fldProductMasterId').value,
      chip: document.getElementById('linkedProductChip').textContent,
      title: document.getElementById('fldTitle').value,
      type: document.getElementById('fldProductType').value,
      factory: document.getElementById('fldFactoryId').value,
      eta: document.getElementById('fldBulkEta').value,
      status: document.getElementById('status').textContent,
      comboText: document.querySelector('.smp-combo:has(#fldPoHeaderId) .smp-combo-input').value,
    }));
    R.test('clicking a PO result links it, to po_header_id and not product_master_id', () => {
      R.eq(linked.po, 'po-incotexco', 'the PO id lands in the PO field');
      R.eq(linked.poLabel, 'Incotexco-496');
      R.eq(linked.master, '', 'a PO is not a products_master row and must never be written as one');
      R.has(linked.chip, 'PO · Incotexco-496', 'and it is visible where the link was made');
      R.eq(linked.comboText, 'Incotexco-496', 'the searchable control shows what is selected');
    });
    R.test('the PO fills the fields the drawer left blank', () => {
      R.eq(linked.title, 'Elevate & Celebrate T-Shirt');
      R.eq(linked.type, 'T-Shirt');
      R.eq(linked.factory, 'fac-1');
      R.eq(linked.eta, '2026-11-02');
      R.has(linked.status, '325 units across 6 size lines', 'and says what it linked');
    });

    await page.evaluate(() => { window.__QUERIES__.length = 0; });
    await page.click('#btnSave');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'product_samples' && q._op === 'insert'));
    const smpWrite = await page.evaluate(() =>
      window.__QUERIES__.find((q) => q.table === 'product_samples' && q._op === 'insert').rows);
    R.test('and saving the sample actually writes that PO', () => {
      R.eq(smpWrite.po_header_id, 'po-incotexco');
      R.eq(smpWrite.product_master_id, null);
    });

    // ── 3. Expected Units is the whole PO, not one size line ──────────────
    await page.click('.bcn-tab[data-tab="tracker"]');
    await page.click('#btnNew');
    await page.selectOption('#ptProdSource', 'po_incoming');
    await page.fill('#ptProdSearchInput', 'Elevate');
    await page.waitForSelector('#ptProdSearchResults.open .smp-prod-hit');
    await page.click('#ptProdSearchResults .smp-prod-hit:first-child');
    await page.waitForSelector('#ptLinkedProductChip .smp-linked-chip--po');
    const pt = await page.evaluate(() => ({
      units: document.getElementById('ptFldExpectedUnits').value,
      title: document.getElementById('ptFldTitle').value,
      factory: document.getElementById('ptFldFactoryId').value,
      eta: document.getElementById('ptFldBulkEta').value,
      master: document.getElementById('ptFldProductMasterId').value,
      chip: document.getElementById('ptLinkedProductChip').textContent,
    }));
    R.test('a PO pick fills Expected Units with every size line summed', () => {
      R.eq(pt.units, '325', 'the 6 size lines sum to 325; the first line alone is 75');
      R.eq(pt.title, 'Elevate & Celebrate T-Shirt');
      R.eq(pt.factory, 'fac-1');
      R.eq(pt.eta, '2026-11-02');
      R.eq(pt.master, '', 'still not a products_master id');
      R.has(pt.chip, 'PO · Incotexco-496');
      R.not(pt.chip, 'database update', 'the column exists here, so no caveat belongs on the chip');
    });

    await page.fill('#ptFldExpectedUnits', '75');
    await page.fill('#ptProdSearchInput', 'Elevate');
    await page.waitForSelector('#ptProdSearchResults.open .smp-prod-hit');
    await page.click('#ptProdSearchResults .smp-prod-hit:first-child');
    R.test('a hand-typed single-size figure is REPLACED — that is the bug', async () => {
      R.eq(await page.inputValue('#ptFldExpectedUnits'), '325');
    });

    await page.fill('#ptFldTitle', 'My own name for it');
    await page.fill('#ptProdSearchInput', 'Elevate');
    await page.waitForSelector('#ptProdSearchResults.open .smp-prod-hit');
    await page.click('#ptProdSearchResults .smp-prod-hit:nth-child(2)');
    const kept = await page.inputValue('#ptFldTitle');
    const followed = await page.inputValue('#ptFldExpectedUnits');
    R.test('but a title someone typed is not clobbered', () => {
      R.eq(kept, 'My own name for it');
      R.eq(followed, '550', 'while the PO-owned number does follow the PO');
    });

    await page.evaluate(() => { window.__QUERIES__.length = 0; });
    await page.click('#ptBtnSave');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'product_tracker' && q._op === 'insert'));
    const ptWrite = await page.evaluate(() =>
      window.__QUERIES__.find((q) => q.table === 'product_tracker' && q._op === 'insert').rows);
    R.test('and the pipeline item saves both the PO and the combined figure', () => {
      R.eq(ptWrite.po_header_id, 'po-incotexco');
      R.eq(ptWrite.expected_units, 550);
    });

    // ── 4. searchable filters ─────────────────────────────────────────────
    const wrapped = await page.evaluate(() => {
      const has = (id) => !!(document.getElementById(id) && document.getElementById(id).closest('.smp-combo'));
      return {
        ptLaunchFilter: has('ptLaunchFilter'), ptTypeFilter: has('ptTypeFilter'),
        fLaunchFilter: has('fLaunchFilter'), ptFldFactoryId: has('ptFldFactoryId'),
        fldPoHeaderId: has('fldPoHeaderId'), fldAssignedTo: has('fldAssignedTo'),
        fStatus: has('fStatus'), ptPhotoFilter: has('ptPhotoFilter'), ptSamplesFilter: has('ptSamplesFilter'),
      };
    });
    R.test('the long dropdowns became searchable and the short ones did not', () => {
      R.eq(wrapped, {
        ptLaunchFilter: true, ptTypeFilter: true, fLaunchFilter: true,
        ptFldFactoryId: true, fldPoHeaderId: true, fldAssignedTo: true,
        fStatus: false, ptPhotoFilter: false, ptSamplesFilter: false,
      }, 'a search box over four fixed options is worse than the dropdown it replaces');
    });

    const typeOpts = await page.$$eval('#ptTypeFilter option', (e) => e.map((x) => x.textContent));
    R.test('the product-type filter offers no blank entry', () => {
      R.eq(typeOpts, ['All product types', 'Cap', 'Hoodie', 'T-Shirt'],
        'a catalog row with no product_type must be excluded, not offered as a nameless category');
    });

    // Enhancing an already-enhanced select must be a no-op. Every call site in
    // the page hands it fresh elements, so without this the guard is
    // unexecuted code that only looks safe.
    const reEnhanced = await page.evaluate(() => {
      const bar = document.getElementById('ptTypeFilter').closest('.bcn-filter-bar');
      const before = bar.querySelectorAll('.smp-combo').length;
      window.SiloCombo.enhanceAll(['ptTypeFilter', 'ptLaunchFilter']);
      window.SiloCombo.enhanceAll(['ptTypeFilter', 'ptLaunchFilter']);
      return {
        before,
        after: bar.querySelectorAll('.smp-combo').length,
        inputs: bar.querySelectorAll('.smp-combo-input').length,
      };
    });
    R.test('enhancing a select twice does not stack a second control beside it', () => {
      // Counting inputs inside the select's OWN wrapper cannot see this: a
      // second enhance builds a new wrapper around the select, so that wrapper
      // holds exactly one input and the orphaned one sits next to it. Count
      // the wrappers in the bar, which is where a stray box would show up.
      R.eq(reEnhanced.after, reEnhanced.before, 'wrapper count changed: ' + JSON.stringify(reEnhanced));
      R.eq(reEnhanced.inputs, reEnhanced.before, 'one search box per filter: ' + JSON.stringify(reEnhanced));
    });

    await page.click(`${combo('ptLaunchFilter')} .smp-combo-input`);
    await page.waitForSelector(`${combo('ptLaunchFilter')} .smp-combo-list.open`);
    const allOpts = await page.$$eval(`${combo('ptLaunchFilter')} .smp-combo-opt`, (e) => e.map((x) => x.textContent));
    await page.fill(`${combo('ptLaunchFilter')} .smp-combo-input`, 'holi');
    const hits = await page.$$eval(`${combo('ptLaunchFilter')} .smp-combo-opt`, (e) => e.map((x) => x.textContent));
    await page.click(`${combo('ptLaunchFilter')} .smp-combo-opt`);
    const picked = await page.evaluate(() => document.getElementById('ptLaunchFilter').value);
    const tableAfter = await page.evaluate(() => document.getElementById('trackerBody').textContent);
    R.test('typing narrows it, and picking drives the REAL filter', () => {
      R.eq(allOpts, ['All launches', 'Back To School 2026', 'Holiday Drop'], 'every option is offered');
      R.eq(hits, ['Holiday Drop'], 'typing narrows to the match');
      R.eq(picked, 'lch-2', 'the select — the thing every other read uses — is what gets set');
      R.has(tableAfter, 'No products match', 'and the change event reached the listener that re-renders');
    });

    await page.fill(`${combo('ptLaunchFilter')} .smp-combo-input`, 'zzz no such launch');
    await page.click('#ptSearch');
    await page.waitForFunction(() => !document.querySelector('.smp-combo:has(#ptLaunchFilter) .smp-combo-list.open'));
    const restored = await page.inputValue(`${combo('ptLaunchFilter')} .smp-combo-input`);
    const stillSet = await page.evaluate(() => document.getElementById('ptLaunchFilter').value);
    R.test('abandoning a half-typed search restores the real selection', () => {
      R.eq(restored, 'Holiday Drop', 'stray text where a value should be reads as a filter that is not set');
      R.eq(stillSet, 'lch-2');
    });

    // Clear the launch filter the previous case set, or the row is filtered out.
    await page.evaluate(() => {
      const sel = document.getElementById('ptLaunchFilter');
      sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('.bcn-tab[data-tab="tracker"]');
    await page.waitForSelector('#trackerBody tr[data-pt-id="trk-1"]');
    await page.click('#trackerBody tr[data-pt-id="trk-1"]');
    await page.click(`${combo('ptFldFactoryId')} .smp-combo-input`);
    await page.waitForSelector(`${combo('ptFldFactoryId')} .smp-combo-list.open`);
    await page.keyboard.press('Escape');
    const drawerStillOpen = await page.evaluate(() => document.getElementById('ptDrawer').classList.contains('open'));
    await page.keyboard.press('Escape');
    const drawerClosed = await page.evaluate(() => !document.getElementById('ptDrawer').classList.contains('open'));
    R.test('Escape closes the dropdown without closing the drawer behind it', () => {
      R.eq(drawerStillOpen, true, 'the first Escape belongs to the dropdown');
      R.eq(drawerClosed, true, 'the second, with nothing open, closes the drawer');
    });

    // The catalog tab rebuilds its filter selects from the loaded rows, so
    // they are enhanced on a different path from the static ones above.
    await page.click('.bcn-tab[data-tab="catalog"]');
    await page.waitForFunction(() => document.getElementById('ctKpiRows').textContent !== '—');
    const ctWrapped = await page.$$eval('.ct-filter', (els) => els.map((e) => ({ key: e.dataset.key, combo: !!e.closest('.smp-combo') })));
    await page.click('.smp-combo:has([data-key="product_type"]) .smp-combo-input');
    await page.fill('.smp-combo:has([data-key="product_type"]) .smp-combo-input', 'cap');
    await page.click('.smp-combo:has([data-key="product_type"]) .smp-combo-opt');
    const ctValue = await page.evaluate(() => document.querySelector('.ct-filter[data-key="product_type"]').value);
    const ctCount = await page.evaluate(() => document.getElementById('ctKpiFiltered').textContent);
    R.test('the catalog filters, which are rebuilt rather than static, work the same', () => {
      R.eq(ctWrapped.length, 3, 'category, subcategory, department');
      R.truthy(ctWrapped.every((w) => w.combo), 'all three enhanced: ' + JSON.stringify(ctWrapped));
      R.eq(ctValue, 'Cap', 'picking sets the real select');
      R.eq(ctCount, '1', 'and ctFiltered() applied it');
    });

    // Switching away and back rebuilds them again; enhancing twice would
    // stack a second input over the first.
    await page.click('.bcn-tab[data-tab="tracker"]');
    await page.click('.bcn-tab[data-tab="catalog"]');
    const inputCounts = await page.$$eval('#ctFilterSelects .smp-combo', (els) => els.map((e) => e.querySelectorAll('input').length));
    R.test('a rebuild does not stack a second control on the first', () =>
      R.truthy(inputCounts.every((c) => c === 1), 'got: ' + JSON.stringify(inputCounts)));

    // ── 4b. prefilled selects must SHOW what they will save ───────────────
    // "+ New Sample from this Product" and the Catalog's "+ Request Sample"
    // both set fldProductType / fldFactoryId / fldLaunchId directly, AFTER
    // populateDrawerSelects() has already synced. A searchable control is a
    // view over its select, so a view that was not refreshed shows the old
    // label while the select holds the new value -- the screen then disagrees
    // with what the save writes, which is the whole failure mode this page's
    // changes exist to remove.
    await page.evaluate(() => {
      const t = document.getElementById('ptLaunchFilter');
      t.value = ''; t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('.bcn-tab[data-tab="tracker"]');
    await page.waitForSelector('#trackerBody tr[data-pt-id="trk-1"]');
    await page.click('#trackerBody tr[data-pt-id="trk-1"]');
    await page.click('#ptBtnNewSample');
    await page.waitForSelector('#drawer.open');
    const prefilled = await page.evaluate(() => {
      const read = (id) => {
        const sel = document.getElementById(id);
        const wrap = sel.closest('.smp-combo');
        return {
          value: sel.value,
          shownLabel: wrap ? wrap.querySelector('.smp-combo-input').value : null,
          selectedLabel: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '',
        };
      };
      return { type: read('fldProductType'), factory: read('fldFactoryId'), launch: read('fldLaunchId') };
    });
    R.test('a prefilled sample drawer shows the factory, type and launch it will save', () => {
      R.eq(prefilled.factory.value, 'fac-2', 'the select carries the pipeline item\'s factory');
      R.eq(prefilled.factory.shownLabel, prefilled.factory.selectedLabel,
        'the search box must show the selected factory, not a stale/blank label');
      R.eq(prefilled.type.value, 'Cap');
      R.eq(prefilled.type.shownLabel, prefilled.type.selectedLabel);
      R.eq(prefilled.launch.value, 'lch-1');
      R.eq(prefilled.launch.shownLabel, prefilled.launch.selectedLabel);
    });
    await page.click('#btnCancelDrawer');

    await page.close();

    // ── 5. the database state between merge and migration 20260915230000 ──
    const pre = await suite.open('/v2/products.html', TABLES, {
      ready: READY,
      missingColumns: { product_tracker: ['po_header_id'] },
    });

    R.test('without the migration the page still loads', async () => {
      R.eq(await pre.evaluate(() => document.getElementById('ptKpiTotal').textContent), '1');
    });

    await pre.click('.bcn-tab[data-tab="tracker"]');
    await pre.click('#btnNew');
    await pre.selectOption('#ptProdSource', 'po_incoming');
    await pre.fill('#ptProdSearchInput', 'Elevate');
    await pre.waitForSelector('#ptProdSearchResults.open .smp-prod-hit');
    await pre.click('#ptProdSearchResults .smp-prod-hit:first-child');
    await pre.waitForSelector('#ptLinkedProductChip .smp-linked-chip--po');
    const preUnits = await pre.inputValue('#ptFldExpectedUnits');
    const preChip = await pre.evaluate(() => document.getElementById('ptLinkedProductChip').textContent);
    R.test('the pick still prefills, and the chip does not claim a link it cannot store', () => {
      R.eq(preUnits, '325', 'the combined figure needs no new column');
      R.has(preChip, 'storing the PO link itself needs a database update',
        'a chip that claims a link the save cannot make would be a lie');
    });

    await pre.fill('#ptFldTitle', 'Pipeline item without the migration');
    await pre.evaluate(() => { window.__QUERIES__.length = 0; });
    await pre.click('#ptBtnSave');
    await pre.waitForFunction(() => window.__QUERIES__.some((q) => q.table === 'product_tracker' && q._op === 'insert'));
    const preWrite = await pre.evaluate(() =>
      window.__QUERIES__.find((q) => q.table === 'product_tracker' && q._op === 'insert').rows);
    const savedOk = await pre.evaluate(() => document.getElementById('status').textContent);
    R.test('and the write omits the column entirely, so the save still succeeds', () => {
      R.truthy(!Object.prototype.hasOwnProperty.call(preWrite, 'po_header_id'),
        'sending an unknown column fails the WHOLE insert — that would turn "the PO link '
        + 'is not stored yet" into "nothing on this page saves". Sent: '
        + JSON.stringify(Object.keys(preWrite)));
      R.eq(preWrite.expected_units, 325);
      R.not(savedOk, 'does not exist', 'and no column error reached the user: ' + savedOk);
    });

    await pre.close();
  } finally {
    await suite.close();
  }

  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})();
