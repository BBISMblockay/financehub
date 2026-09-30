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
  { id: 'c1', title: 'Scoped copy', source: 'system', company_entity_id: 'C1', visibility: 'company' },
  { id: 'm1', title: 'My draft', source: 'manual', company_entity_id: 'C1', visibility: 'private', created_by: 'U1', created_by_name: 'Blake' },
  { id: 'm2', title: 'Colleague shared', source: 'ask_silo', company_entity_id: 'C1', visibility: 'company', created_by: 'U2', created_by_name: 'Jess' },
  { id: 'm3', title: 'My shared', source: 'manual', company_entity_id: 'C1', visibility: 'company', created_by: 'U1' },
  { id: 'a1', title: 'My archived', source: 'manual', company_entity_id: 'C1', visibility: 'private', created_by: 'U1', archived_at: '2026-09-30' },
  { id: 'a2', title: 'Shared archived', source: 'manual', company_entity_id: 'C1', visibility: 'company', created_by: 'U2', archived_at: '2026-09-30' },
  { id: 'x1', title: 'Other tenant', source: 'manual', company_entity_id: 'C2', visibility: 'company', created_by: 'U1' },
  { id: 'p2', title: 'Colleague private', source: 'manual', company_entity_id: 'C1', visibility: 'private', created_by: 'U2' },
];

test('My Reports is creator-only, both private and shared; Company includes your shared reports', () => {
  const split = L.splitReports(rows, 'U1', 'C1');
  eq(split.silo.map((r) => r.id), ['s1']);
  eq(split.mine.map((r) => r.id), ['m1', 'm3']);
  eq(split.company.map((r) => r.id), ['c1', 'm2', 'm3']);
  eq(split.archived.map((r) => r.id), ['a1']);
});

test('archived rows never land in active tabs; restoring preserves original scopes', () => {
  const own = { ...rows[5], visibility: 'company' };
  eq(L.splitReports([own], 'U1', 'C1').mine.length, 0);
  eq(L.splitReports([own], 'U1', 'C1').company.length, 0);
  const restored = L.splitReports([{ ...own, archived_at: null }], 'U1', 'C1');
  eq(restored.mine.length, 1); eq(restored.company.length, 1); eq(restored.archived.length, 0);
});

test('ownership fails closed for missing identity/company, other owners/tenants and system definitions', () => {
  truthy(L.ownsReport(rows[2], 'U1', 'C1'));
  for (const row of [rows[0], rows[1], rows[3], rows[7], null]) eq(L.ownsReport(row, 'U1', 'C1'), false);
  eq(L.ownsReport(rows[2], null, 'C1'), false);
  eq(L.ownsReport(rows[2], 'U1', null), false);
  const split = L.splitReports(rows);
  eq(split.mine.length + split.company.length + split.archived.length, 0);
});

test('tab from URL: default, known, legacy, unknown, restricted', () => {
  eq(L.tabFromSearch(''), 'silo');
  eq(L.tabFromSearch('?tab=dashboards'), 'dashboards');
  eq(L.tabFromSearch('?tab=company'), 'company');
  eq(L.tabFromSearch('?tab=archived'), 'archived');
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
  const many = [
    { id: 'newer', name: 'Marketing', source: 'system', company_entity_id: null },
    { id: '5110da5b-0000-4000-a000-000000000001', name: 'Overview', source: 'system', company_entity_id: null },
    { id: 'older', name: 'Sales', source: 'system', company_entity_id: null },
    { id: 'company', source: 'user', company_entity_id: 'C1' },
  ];
  eq(L.orderDashboards(many).map((d) => d.id),
    ['5110da5b-0000-4000-a000-000000000001', 'newer', 'older', 'company']);
});

test('dashboard badge: SILO for a SILO board, visibility otherwise', () => {
  eq(L.dashboardScopeLabel({ source: 'system', company_entity_id: null, visibility: 'company' }), 'SILO');
  eq(L.dashboardScopeLabel({ source: 'user', company_entity_id: 'C1', visibility: 'private' }), 'Only me');
  eq(L.dashboardScopeLabel({ source: 'user', company_entity_id: 'C1', visibility: 'company' }), 'Company');
});

const result = R.summary();
process.exit(result.fail ? 1 : 0);
