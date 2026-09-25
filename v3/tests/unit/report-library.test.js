/* The Reports library's rules: which tab a row belongs to, what one line a
 * card shows, what search matches, and which tab a URL asks for. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(['report-library.js']);
const L = g.SiloReportLibrary;
const R = createReporter('report library');
const { test, eq, truthy } = R;

const rows = [
  { id: 's1', title: 'Daily Sales', source: 'system', company_entity_id: null, visibility: 'company' },
  // A system-sourced row that is company-scoped is NOT a SILO report: the
  // classification is both conditions, not the source alone.
  { id: 'c1', title: 'Scoped copy', source: 'system', company_entity_id: 'C1', visibility: 'company' },
  { id: 'm1', title: 'My draft', source: 'manual', company_entity_id: 'C1', visibility: 'private', created_by_name: 'Blake' },
  { id: 'm2', title: 'Colleague shared', source: 'ask_silo', company_entity_id: 'C1', visibility: 'company', created_by_name: 'Jess' },
];

test('SILO Reports = system AND global; everything else is My Reports', () => {
  const { silo, mine } = L.splitReports(rows);
  eq(silo.map((r) => r.id), ['s1']);
  eq(mine.map((r) => r.id), ['c1', 'm1', 'm2']);
});

test('My Reports is not an ownership filter: a colleague\'s shared report stays', () => {
  truthy(L.splitReports(rows).mine.some((r) => r.id === 'm2'));
});

test('every row lands in exactly one tab', () => {
  const { silo, mine } = L.splitReports(rows);
  eq(silo.length + mine.length, rows.length);
  eq(silo.filter((r) => mine.includes(r)).length, 0);
});

test('tab from URL: default, known, legacy, unknown, restricted', () => {
  eq(L.tabFromSearch(''), 'silo');
  eq(L.tabFromSearch('?tab=dashboards'), 'dashboards');
  eq(L.tabFromSearch('?tab=reports'), 'mine');
  eq(L.tabFromSearch('?tab=nonsense'), 'silo');
  eq(L.tabFromSearch('?tab=silo', ['dashboards']), 'dashboards');
});

test('urlForTab sets tab and keeps every other parameter', () => {
  eq(L.urlForTab('https://x.test/v3/dashboards.html?foo=1&tab=silo#h', 'mine'), '/v3/dashboards.html?foo=1&tab=mine#h');
});

test('summary is the first sentence, verbatim; Details only when there is more', () => {
  const d = 'What ad platforms claim vs actual Shopify sales. Claims are attribution, not net sales.';
  eq(L.summaryOf(d), 'What ad platforms claim vs actual Shopify sales.');
  truthy(L.hasMore(d));
  eq(L.summaryOf('One line only.'), 'One line only.');
  eq(L.hasMore('One line only.'), false);
  eq(L.summaryOf(''), '');
  // A decimal or an abbreviation mid-sentence does not end the sentence.
  eq(L.summaryOf('Cover at 2.5 weeks e.g. tees. Blank means unknown.'), 'Cover at 2.5 weeks e.g. tees.');
});

test('search: every term must match, across title, description, question, author', () => {
  eq(L.filterReports(rows, 'jess').map((r) => r.id), ['m2']);
  eq(L.filterReports(rows, 'daily sales').map((r) => r.id), ['s1']);
  eq(L.filterReports(rows, 'daily zzz').length, 0);
  eq(L.filterReports(rows, '   ').length, rows.length);
  eq(L.filterDashboards([{ name: 'Monday review', description: 'Weekly' }], 'weekly').length, 1);
});

test('visibility badge', () => {
  eq(L.visibilityLabel({ visibility: 'private' }), 'Only me');
  eq(L.visibilityLabel({ visibility: 'company' }), 'Company');
});

test('SILO dashboard = system AND global, both required', () => {
  truthy(L.isSiloDashboard({ source: 'system', company_entity_id: null }));
  eq(L.isSiloDashboard({ source: 'system', company_entity_id: 'C1' }), false);
  eq(L.isSiloDashboard({ source: 'user', company_entity_id: null }), false);
  // A row read before the column existed has no source at all.
  eq(L.isSiloDashboard({ company_entity_id: 'C1' }), false);
});

test('SILO dashboards list first, the rest keep their order', () => {
  const boards = [
    { id: 'a', source: 'user', company_entity_id: 'C1' },
    { id: 's', source: 'system', company_entity_id: null },
    { id: 'b', source: 'user', company_entity_id: 'C1' },
  ];
  eq(L.orderDashboards(boards).map((d) => d.id), ['s', 'a', 'b']);
  eq(L.orderDashboards(null), []);
});

test('dashboard badge: SILO for a SILO board, visibility otherwise', () => {
  eq(L.dashboardScopeLabel({ source: 'system', company_entity_id: null, visibility: 'company' }), 'SILO');
  eq(L.dashboardScopeLabel({ source: 'user', company_entity_id: 'C1', visibility: 'private' }), 'Only me');
  eq(L.dashboardScopeLabel({ source: 'user', company_entity_id: 'C1', visibility: 'company' }), 'Company');
});

const result = R.summary();
process.exit(result.fail ? 1 : 0);
