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
  r.has(src, 'window.SiloPurchasingSuite?.refresh(mainEl, opts.active)', 'refreshes it after reconcile');
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

const out = r.summary();
process.exit(out.fail ? 1 : 0);
