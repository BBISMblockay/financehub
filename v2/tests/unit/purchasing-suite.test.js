/* One "Purchasing" nav row, five tabs (2026-11-12).
 *
 * The sidebar used to carry four Purchasing rows -- PO Builder, PO Landed
 * Cost, PO Report and Factories. They are now one row whose pages share a tab
 * strip, with a new Overview at /v2/purchasing.html, and every page keeps its
 * own URL so existing bookmarks and the ?po_id= deep links still land.
 *
 * What can silently break: the nav collapsing back to four rows, a page losing
 * the strip (which makes the suite unreachable from that page), a tab pointing
 * at a file that is not there, a page mounting chrome under a nav key the
 * strip does not know, or the Overview's model mis-reading the rows it is
 * handed. Each is asserted here. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('purchasing-suite');
const root = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ROW = 'purchasing/home';
const TABS = [
  ['purchasing/home', '/v2/purchasing.html'],
  ['purchasing/po-builder', '/v2/po-builder.html'],
  ['purchasing/po-report', '/v2/po-report.html'],
  ['purchasing/po-costing', '/v2/po-costing.html'],
  ['purchasing/factories', '/v2/factories.html'],
];

function nav() {
  const context = { window: {} };
  vm.runInNewContext(read('v2/nav-config.js'), context);
  return context.window.SiloNav;
}

r.test('the sidebar draws one Purchasing row; the other four stay tabs of it', () => {
  const Nav = nav();
  r.eq(Nav.PURCHASING_ROW, ROW, 'PURCHASING_ROW');
  r.eq(Nav.PURCHASING_SUITE_PAGES.map((p) => p[0]), TABS.map((t) => t[0]), 'tab order');
  for (const profile of ['standard', 'grandfathered']) {
    const sections = Nav.navSectionsForProfile(profile, 'exec', 'owner', []);
    const all = sections.flatMap((s) => s.items);
    // Every tab stays a nav row, so "Jump to" and the gates are unchanged...
    for (const [id, href] of TABS) {
      const row = all.find((i) => i.id === id);
      r.truthy(row, `${profile}: ${id} is still a nav row`);
      r.eq(row.href, href, `${profile}: ${id} href`);
      if (id !== ROW) r.eq(row.tabOf, ROW, `${profile}: ${id} is a tab of the Purchasing row`);
    }
    // ...but only one of them is drawn in the sidebar.
    const drawn = Nav.sidebarSections(sections).flatMap((s) => s.items)
      .filter((i) => TABS.some(([id]) => id === i.id));
    r.eq(drawn.length, 1, `${profile}: one purchasing row in the sidebar`);
    r.eq(drawn[0].id, ROW, `${profile}: row id`);
    r.eq(drawn[0].label, 'Purchasing', `${profile}: row label`);
  }
});

r.test('every tab page exists, carries the strip and mounts its own nav key', () => {
  for (const [id, href] of TABS) {
    const file = href.slice(1);
    r.truthy(fs.existsSync(path.join(root, file)), `${href} must exist`);
    const src = read(file);
    r.has(src, 'purchasing-suite.js', `${href}: loads the strip`);
    r.has(src, 'purchasing-suite.css', `${href}: loads the strip's styles`);
    r.has(src, `'${id}'`, `${href}: mounts active:'${id}'`);
    // The strip must be parsed before silo-chrome.js mounts it.
    r.truthy(src.indexOf('purchasing-suite.js') < src.indexOf('silo-chrome.js'),
      `${href}: purchasing-suite.js loads before silo-chrome.js`);
  }
});

r.test('silo-chrome maps every suite page onto the one sidebar row', () => {
  const src = read('v2/silo-chrome.js');
  r.has(src, 'SiloPurchasingSuite?.contains(navActive)', 'maps the active id');
  r.has(src, 'Nav.PURCHASING_ROW', 'uses the exported row id');
  r.has(src, 'window.SiloPurchasingSuite?.mount(mainEl, opts.active)', 'mounts the strip');
  // 2026-11-13: every strip is redrawn through one helper, called when the
  // company, the department or the grants resolve -- not once after the
  // company reconcile.
  r.has(src, 'window.SiloPurchasingSuite?.refresh(mainEl, active)', 'is redrawn with the others');
  r.has(src, 'refreshSuiteStrips(mainEl, opts.active)', 'the helper runs on the paths that change what is visible');
});

r.test('the strip draws only tabs the nav returns, plus the open page', () => {
  const Nav = nav();
  const context = {
    window: {
      SiloNav: Nav,
      __SILO_CONFIG__: { getActiveCompany: () => null },
    },
    document: { createElement: () => { throw new Error('not needed'); } },
  };
  vm.runInNewContext(read('v2/purchasing-suite.js'), context);
  const suite = context.window.SiloPurchasingSuite;
  for (const [id] of TABS) r.truthy(suite.contains(id), `${id} is in the suite`);
  r.truthy(!suite.contains('reports/marketing-overview'), 'a foreign id is not');
});

r.test('the Overview model reads open POs, arrivals and costing phases', () => {
  const context = { window: {} };
  vm.runInNewContext(read('v2/purchasing-overview.js'), context);
  const Model = context.window.SiloPurchasingOverview;
  const pos = [
    { id: 'a', po_name: 'PO-1', factory_name: 'Alpha', status: 'In Production', total_units: 100,
      total_estimated_cost: 1000, effective_arrival_date: '2026-11-01', arrival_state: 'in_transit',
      shipment_count: 1, status_conflicts_with_shipments: false },
    { id: 'b', po_name: 'PO-2', factory_name: 'Alpha', status: 'Approved', total_units: 50,
      total_estimated_cost: 500, effective_arrival_date: '2026-12-01', arrival_state: 'unknown',
      shipment_count: 0, status_conflicts_with_shipments: false },
    { id: 'c', po_name: 'PO-3', factory_name: 'Beta', status: 'Draft', total_units: 10,
      total_estimated_cost: 90, effective_arrival_date: null, arrival_state: 'unknown', shipment_count: 0 },
    { id: 'd', po_name: 'PO-4', factory_name: 'Beta', status: 'Closed', total_units: 999,
      total_estimated_cost: 9999, effective_arrival_date: '2026-10-01', arrival_state: 'received', shipment_count: 2 },
  ];
  const costing = [{ po_header_id: 'a', phase: 'freight' }, { po_header_id: 'b', phase: null }];
  const m = Model.assess({ pos, costing, factoryCount: 3, errors: [] },
    { company: { id: 'co' }, today: '2026-11-13', currency: 'USD' });

  // Closed and Draft POs are not "open", and never reach the incoming totals.
  r.eq(m.builder.open, 2, 'open POs');
  r.eq(m.builder.drafts, 1, 'drafts');
  r.eq(m.builder.total, 4, 'all POs');
  r.eq(m.incoming.units, 150, 'incoming units');
  r.eq(m.incoming.estimatedCost, 1500, 'estimated cost');
  r.eq(m.incoming.late, 1, 'past due against the business date, not the browser clock');
  r.eq(m.incoming.noShipment, 1, 'no shipment logged');
  r.eq(m.incoming.undated, 0, 'no undated open PO here');
  r.eq(m.incoming.next30, 1, 'one arrival inside the 30-day window, the overdue one excluded');
  r.eq(m.incoming.rows.map((x) => x.id), ['a', 'b'], 'soonest arrival first');
  r.eq(m.incoming.rows[0].late, true, 'the overdue row is marked');
  r.eq(m.costing.freight, 1, 'one PO awaiting freight');
  r.eq(m.costing.notStarted, 1, 'one open PO with no phase');
  r.eq(m.factories.count, 3, 'factory count');
  r.eq(m.factories.withOpen, 1, 'factories with an open PO');
  r.eq(m.currency, 'USD', 'declared currency is carried, never assumed');
});

// The only async suite here: r.test() is synchronous, so this one is run and
// awaited before the summary below, with its own try/catch reporting.
async function periodWindowTest() {
  const context = { window: {} };
  vm.runInNewContext(read('v2/purchasing-overview.js'), context);
  const Model = context.window.SiloPurchasingOverview;

  r.eq(Model.DEFAULT_WINDOW_DAYS, 365, 'default window');
  r.eq(Model.resolveWindow(90).days, 90, 'a listed window is kept');
  r.eq(Model.resolveWindow('all').days, null, 'all time');
  r.eq(Model.resolveWindow(12345).days, 365, 'an unlisted window falls back to the default');
  r.eq(Model.resolveWindow('nonsense').days, 365, 'so does nonsense');

  // Record what each read asked the database for.
  const asked = [];
  const rowsFor = (filters) => (filters.some((f) => f.kind === 'in')
    ? [{ id: 'open-old', status: 'In Production' }]
    : [{ id: 'recent', status: 'Closed' }]);
  const query = (filters) => ({
    select() { return this; },
    order() { return this; },
    gte(col, value) { filters.push({ kind: 'gte', col, value }); return this; },
    in(col, values) { filters.push({ kind: 'in', col, values }); return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    range() {
      const data = rowsFor(filters);
      return Promise.resolve({ data, count: data.length, error: null });
    },
    then(res) { return Promise.resolve({ data: null, count: 0, error: null }).then(res); },
  });
  const db = {
    rpc: async () => ({ data: '2026-11-13', error: null }),
    from(table) {
      const filters = [];
      asked.push({ table, filters });
      return query(filters);
    },
  };
  const config = { ensureActiveCompany: async () => ({ id: 'co' }) };

  const model = await Model.load({ db, config, windowDays: 90 });
  const poReads = asked.filter((a) => a.table === 'v_po_incoming_summary');
  r.eq(poReads.length, 2, 'two reads: the window, and every open PO');
  r.eq(poReads[0].filters[0], { kind: 'gte', col: 'po_created_at', value: '2026-08-15' },
    'the window is measured from the business date, not the browser clock');
  r.eq(poReads[1].filters[0].values, Model.OPEN_STATUSES, 'open POs are read unconditionally');
  r.eq(model.windowDays, 90, 'the model reports the window it used');
  r.eq(model.cutoff, '2026-08-15', 'and the cutoff');
  // Both reads land in one deduplicated set.
  r.eq(model.builder.total, 2, 'the two reads merge without double-counting');

  // No business date means no honest cutoff: read everything, say all time.
  const noDate = { ...db, rpc: async () => ({ data: null, error: null }) };
  asked.length = 0;
  const all = await Model.load({ db: noDate, config, windowDays: 90 });
  r.eq(asked.filter((a) => a.table === 'v_po_incoming_summary').length, 1, 'one unfiltered read');
  r.eq(all.cutoff, null, 'no cutoff');
  r.eq(all.windowDays, null, 'and the page is told it is showing all time');
}

r.test('every chart the Overview declares is actually drawn into', () => {
  const page = read('v2/purchasing.html');
  // A card whose host id nothing renders into shows the "—" placeholder for
  // ever, which looks like "no data" rather than like a bug.
  for (const id of ['chartArrivals', 'chipsArrivals', 'chartPipeline', 'chartCosting',
    'chartFactories', 'cardAttention', 'cardArrivals']) {
    r.has(page, `id="${id}"`, `${id}: the card exists`);
    r.truthy(page.split(`'${id}'`).length > 1, `${id}: something renders into it`);
  }
  // The charts are SVG drawn at measured width; without the observer they
  // would be drawn once, at whatever width the card had before layout.
  r.has(page, 'ResizeObserver', 'the arrival chart redraws on resize');
  r.has(page, 'http://www.w3.org/2000/svg', 'drawn as real SVG');
});

r.test('the arrival timeline buckets every open PO exactly once', () => {
  const context = { window: {} };
  vm.runInNewContext(read('v2/purchasing-overview.js'), context);
  const Model = context.window.SiloPurchasingOverview;
  const open = [
    { total_units: 10, effective_arrival_date: '2026-10-02' },   // past due
    { total_units: 20, effective_arrival_date: '2026-11-20' },   // this month
    { total_units: 30, effective_arrival_date: '2027-01-05' },   // in window
    { total_units: 40, effective_arrival_date: '2028-01-05' },   // beyond six months
    { total_units: 50, effective_arrival_date: null },           // no date
  ];
  const t = Model.timeline(open, '2026-11-13');
  r.eq(t.months.map((m) => m.key),
    ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'], 'six months from today');
  r.eq(t.months[0].label, 'Nov 26', 'month label');
  r.eq(t.pastDue.units, 10, 'past due');
  r.eq(t.months[0].units, 20, 'this month');
  r.eq(t.months[2].units, 30, 'January');
  r.eq(t.later.units, 40, 'beyond the window');
  r.eq(t.undated.units, 50, 'no arrival date');
  const total = t.pastDue.units + t.later.units + t.undated.units
    + t.months.reduce((sum, m) => sum + m.units, 0);
  r.eq(total, 150, 'every open PO lands in exactly one bucket');
  r.eq(t.pastDue.pos + t.later.pos + t.undated.pos
    + t.months.reduce((sum, m) => sum + m.pos, 0), open.length, 'and is counted once');
});

r.test('the pipeline runs in workflow order and colours every status it draws', () => {
  const context = { window: {} };
  vm.runInNewContext(read('v2/purchasing-overview.js'), context);
  const Model = context.window.SiloPurchasingOverview;
  const pos = [
    { id: 'a', status: 'Received', total_units: 1 },
    { id: 'b', status: 'Draft', total_units: 2 },
    { id: 'c', status: 'Draft', total_units: 3 },
    { id: 'd', status: 'In Production', total_units: 4 },
  ];
  const m = Model.assess({ pos, costing: [], factoryCount: 0, errors: [] }, {});
  r.eq(m.builder.byStatus.map((x) => x.status), ['Draft', 'In Production', 'Received'], 'workflow order');
  r.eq(m.builder.byStatus[0].count, 2, 'counted');
  r.eq(m.builder.byStatus[0].units, 5, 'units summed');
  // Every status the model can emit must have a colour on the page, or a
  // segment of the pipeline bar renders with no fill at all.
  const page = read('v2/purchasing.html');
  const colours = page.slice(page.indexOf('const STATUS_COLOR = {'), page.indexOf('function render(model)'));
  for (const status of Model.PO_STATUSES) {
    r.has(colours, status.includes(' ') ? `'${status}'` : `${status}:`, `${status} has a colour`);
  }
});

r.test('a costing read that failed reports unknown rather than zero', () => {
  const context = { window: {} };
  vm.runInNewContext(read('v2/purchasing-overview.js'), context);
  const Model = context.window.SiloPurchasingOverview;
  const m = Model.assess({ pos: [], costing: undefined, factoryCount: undefined, errors: [] }, {});
  r.eq(m.costing.state, 'unknown', 'costing state');
  r.eq(m.costing.final, null, 'no phase is counted as zero');
  r.eq(m.factories.state, 'unknown', 'factory state');
  r.eq(m.factories.count, null, 'no factory count is invented');
  r.eq(m.currency, null, 'no currency is invented');
});

periodWindowTest()
  .then(() => r.ok('the period window cuts finished work only, never an open PO', true))
  .catch((err) => r.ok('the period window cuts finished work only, never an open PO', false,
    err && err.message ? err.message : String(err)))
  .then(() => {
    const out = r.summary();
    process.exit(out.fail ? 1 : 0);
  });
