/* ============================================================================
   SILO v3 — report catalog curation
   --------------------------------------------------------------------------
   The add-insight picker has two jobs that should not be conflated:
   preserve access to every runnable report, and keep the first screen small
   enough to make a choice. This module groups the shipped SILO definitions
   into business-language tabs and limits Overview to six useful starters.

   It is deliberately pure. Categorisation changes no report, SQL, dashboard
   or permission; it only decides where an already-readable card is shown.
   ========================================================================== */
(function (global) {
  'use strict';

  const TABS = Object.freeze([
    { id: 'overview', label: 'Overview' },
    { id: 'sales', label: 'Sales' },
    { id: 'marketing', label: 'Marketing' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'purchasing', label: 'Purchasing' },
    { id: 'saved', label: 'Saved' },
  ]);

  // Fixed ids make the customer-facing starter set stable even when someone
  // tweaks a report title. Titles are retained as a compatibility fallback
  // for older fixtures and copied installations that predate the ids.
  const OVERVIEW_IDS = new Set([
    '5110de50-0000-4000-a000-000000000001', // Daily Sales
    '5110de50-0000-4000-a000-000000000004', // Open Purchase Orders
    'c1000000-0000-4000-a000-000000000001', // Inventory and on order
    'c1000000-0000-4000-a000-000000000006', // Running thin
    'c3000000-0000-4000-a000-000000000001', // Sales vs last year
    'c3000000-0000-4000-a000-000000000006', // Marketing efficiency by day
  ]);
  const OVERVIEW_TITLES = new Set([
    'daily sales',
    'open purchase orders',
    'logistics · inventory and on order',
    'logistics · running thin',
    'ownership · sales vs last year',
    'ownership · marketing efficiency by day',
  ]);

  const textFor = (report) => [report.title, report.description, report.question]
    .filter(Boolean).join(' ').toLowerCase();

  function isRunnable(report) {
    return Array.isArray(report && report.queries_run) && report.queries_run.length > 0;
  }

  function isOverview(report) {
    const title = String(report && report.title || '').trim().toLowerCase();
    return report && report.source === 'system'
      && (OVERVIEW_IDS.has(report.id) || OVERVIEW_TITLES.has(title));
  }

  function categoryFor(report) {
    if (!report || report.source !== 'system') return 'saved';
    const text = textFor(report);

    if (/marketing|paid media|ad platform|launch/.test(text)) return 'marketing';
    if (/purchase order|\bpo\b|factory|arriv/.test(text)) return 'purchasing';
    if (/inventory|stock|weeks? of cover|cover and momentum|running thin|overstock|sell-through/.test(text)) return 'inventory';
    if (/sales|product|location|channel/.test(text)) return 'sales';

    // A future system definition must never disappear because this display
    // taxonomy has not learned its domain yet. Saved is the visible fallback.
    return 'saved';
  }

  function matchesSearch(report, search) {
    const q = String(search || '').trim().toLowerCase();
    return !q || textFor(report).includes(q);
  }

  function inTab(report, tab) {
    return tab === 'overview' ? isOverview(report) : categoryFor(report) === tab;
  }

  function visibleReports(reports, tab, search) {
    const runnable = (reports || []).filter(isRunnable);
    // Search is catalog-wide. A person who types "cash" should not have to
    // guess which tab SILO filed the answer under first.
    if (String(search || '').trim()) return runnable.filter((report) => matchesSearch(report, search));
    return runnable.filter((report) => inTab(report, tab));
  }

  function tabCounts(reports) {
    const runnable = (reports || []).filter(isRunnable);
    return Object.fromEntries(TABS.map((tab) => [
      tab.id,
      runnable.filter((report) => inTab(report, tab.id)).length,
    ]));
  }

  function displayTitle(report) {
    return String(report && report.title || '').replace(/^(Ownership|Logistics)\s*·\s*/i, '');
  }

  global.SiloReportCatalog = {
    TABS,
    isRunnable,
    isOverview,
    categoryFor,
    matchesSearch,
    visibleReports,
    tabCounts,
    displayTitle,
  };
})(typeof window !== 'undefined' ? window : globalThis);
