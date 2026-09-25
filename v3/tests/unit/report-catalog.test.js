/* The add-insight catalog: six recommendations first, every report still
 * reachable through a business-language tab, and catalog-wide search. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(['report-catalog.js']);
const C = g.SiloReportCatalog;
const R = createReporter('report catalog');
const { test, eq, truthy } = R;

const system = (id, title, description = '') => ({
  id, title, description, source: 'system', queries_run: ['select 1'],
});

const reports = [
  system('5110de50-0000-4000-a000-000000000001', 'Daily Sales'),
  system('5110de50-0000-4000-a000-000000000002', 'Top Products — last 30 days'),
  system('5110de50-0000-4000-a000-000000000003', 'Sales by Location — last 30 days'),
  system('5110de50-0000-4000-a000-000000000004', 'Open Purchase Orders'),
  system('c1000000-0000-4000-a000-000000000001', 'Logistics · Inventory and on order'),
  system('c1000000-0000-4000-a000-000000000002', 'Logistics · Purchase orders past their arrival date'),
  system('c1000000-0000-4000-a000-000000000003', 'Logistics · Units arriving by month'),
  system('c1000000-0000-4000-a000-000000000004', 'Logistics · Open units by factory'),
  system('c1000000-0000-4000-a000-000000000005', 'Logistics · Cover and momentum by product type'),
  system('c1000000-0000-4000-a000-000000000006', 'Logistics · Running thin'),
  system('c1000000-0000-4000-a000-000000000007', 'Logistics · Overstocked and slowing'),
  system('c1000000-0000-4000-a000-000000000008', 'Logistics · Dead stock (velocity-verified)'),
  system('c1000000-0000-4000-a000-000000000009', 'Logistics · Sell-through by product type'),
  system('c1000000-0000-4000-a000-00000000000a', 'Logistics · Top products by units sold'),
  system('c3000000-0000-4000-a000-000000000001', 'Ownership · Sales vs last year'),
  system('c3000000-0000-4000-a000-000000000002', 'Ownership · Net sales by day'),
  system('c3000000-0000-4000-a000-000000000003', 'Ownership · Sales by channel'),
  system('c3000000-0000-4000-a000-000000000004', 'Ownership · Paid media by platform'),
  system('c3000000-0000-4000-a000-000000000005', 'Ownership · What the ad platforms claim vs what actually sold'),
  system('c3000000-0000-4000-a000-000000000006', 'Ownership · Marketing efficiency by day'),
  system('c3000000-0000-4000-a000-000000000007', 'Ownership · Upcoming launches'),
  { id: 'mine', title: 'Cash bridge', question: 'How did cash move?', source: 'ask_silo', queries_run: ['select 1'] },
  { id: 'old', title: 'Old answer', source: 'ask_silo', queries_run: [] },
];

test('Overview is deliberately limited to six starter insights', () => {
  const overview = C.visibleReports(reports, 'overview', '');
  eq(overview.length, 6);
  truthy(overview.every((report) => report.source === 'system'));
});

test('the full shipped catalog is divided into focused business tabs', () => {
  const counts = C.tabCounts(reports);
  eq(counts, { overview: 6, sales: 7, marketing: 4, inventory: 6, purchasing: 4, saved: 1 });
});

test('every runnable report has one non-Overview home', () => {
  const homes = ['sales', 'marketing', 'inventory', 'purchasing', 'saved']
    .flatMap((tab) => C.visibleReports(reports, tab, '').map((report) => report.id));
  eq(homes.length, reports.filter(C.isRunnable).length);
  eq(new Set(homes).size, homes.length);
});

test('search crosses category boundaries instead of trapping the current tab', () => {
  const found = C.visibleReports(reports, 'marketing', 'running thin');
  eq(found.map((report) => report.id), ['c1000000-0000-4000-a000-000000000006']);
});

test('unrecognised future system reports stay visible under Saved', () => {
  const future = system('future', 'A new metric nobody categorised yet');
  eq(C.categoryFor(future), 'saved');
  eq(C.visibleReports([future], 'saved', '').length, 1);
});

test('cards drop redundant internal prefixes without changing stored titles', () => {
  const report = reports.find((r) => r.id === 'c3000000-0000-4000-a000-000000000006');
  eq(C.displayTitle(report), 'Marketing efficiency by day');
  eq(report.title, 'Ownership · Marketing efficiency by day');
});

// Production titles after the 2026-09-22 cleanup. The short titles lost the
// "Logistics ·" / "Ownership ·" context the old text rules leaned on, so the
// category has to come from the title itself -- six of these filed wrongly
// (Marketing Efficiency under Sales, Low Stock under Other) until it did.
test('the 17 live SILO report titles each file under the right category', () => {
  const live = {
    'Marketing Efficiency': 'marketing', 'Ads by Platform': 'marketing', 'Attribution vs Sales': 'marketing',
    'Sales vs Last Year': 'sales', 'Sales by Channel': 'sales', 'Daily Sales': 'sales',
    'Sales by Location': 'sales', 'Top Products': 'sales',
    'PO Units by Factory': 'purchasing', 'Monthly Arrivals': 'purchasing',
    'Overdue Purchase Orders': 'purchasing', 'Open Purchase Orders': 'purchasing',
    'Low Stock': 'inventory', 'Stock Cover': 'inventory', 'Inventory Summary': 'inventory',
    'Overstock': 'inventory', 'Stock Without Sales': 'inventory',
  };
  const wrong = Object.entries(live)
    .map(([title, want]) => [title, want, C.categoryFor(system('x', title))])
    .filter(([, want, got]) => want !== got);
  eq(wrong, []);
});

// Their DESCRIPTIONS are what misfiled them under the old rules: "not
// incremental sales" read as Sales, and "keeps arriving for weeks" matched
// Purchasing's "arriv". The title has to win, with the real text attached.
test('Email & SMS reports file under Marketing, whatever their caveats mention', () => {
  eq(C.categoryFor(system('c3000000-0000-4000-a000-000000000008', 'Email & SMS Performance',
    'Revenue is credited by Redo to email and SMS; it may overlap other channels’ attribution and is not incremental sales.')), 'marketing');
  eq(C.categoryFor(system('c3000000-0000-4000-a000-000000000009', 'Email & SMS Revenue Trend',
    'Credited revenue is not incremental sales. It lands on the order day and keeps arriving for weeks.')), 'marketing');
});

const result = R.summary();
process.exit(result.fail ? 1 : 0);
