/* ============================================================================
   SILO v3 — Reports library (the three tabs on /v3/dashboards.html)
   --------------------------------------------------------------------------
   Pure decisions only: which tab a row belongs to, what one line a card
   shows, what search matches, and which tab a URL asks for. The page owns
   the DOM; this owns the rules, so node can execute them.

   Classification uses fields the rows already carry and nothing else:
     SILO Reports  source = 'system' AND company_entity_id IS NULL
     My Reports    every other report the caller can read -- their own
                   private ones AND company-shared ones by anyone. "My" is
                   the library's name, not an ownership filter: RLS already
                   decided what this person may read, and hiding a
                   colleague's shared report here would make it unreachable
                   from the library while still visible on a dashboard.
     Dashboards    every dashboard the caller can read.
   ========================================================================== */
(function (global) {
  'use strict';

  const TABS = Object.freeze([
    { id: 'silo', label: 'SILO Reports', noun: 'SILO reports' },
    { id: 'mine', label: 'My Reports', noun: 'reports' },
    { id: 'dashboards', label: 'Dashboards', noun: 'dashboards' },
  ]);
  const DEFAULT_TAB = 'silo';
  // ?tab=reports deep-linked the old combined "Saved reports" list. Its
  // readers were looking for saved (custom) reports, so it lands there.
  const LEGACY_TABS = Object.freeze({ reports: 'mine' });

  const isSiloReport = (r) => !!r && r.source === 'system' && r.company_entity_id == null;

  function splitReports(rows) {
    const silo = [];
    const mine = [];
    for (const r of rows || []) (isSiloReport(r) ? silo : mine).push(r);
    return { silo, mine };
  }

  function tabFromSearch(search, allowed) {
    const ids = allowed || TABS.map((t) => t.id);
    let raw = '';
    try { raw = new URLSearchParams(search || '').get('tab') || ''; } catch (_) { raw = ''; }
    const tab = LEGACY_TABS[raw] || raw;
    if (ids.includes(tab)) return tab;
    return ids.includes(DEFAULT_TAB) ? DEFAULT_TAB : ids[0];
  }

  /** The page URL with `tab` set, every other query parameter preserved. */
  function urlForTab(href, tab) {
    const u = new URL(href);
    u.searchParams.set('tab', tab);
    return u.pathname + u.search + u.hash;
  }

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /**
   * The one line a card shows: the first sentence of the stored text.
   * A prefix of the definition, never a rewrite, so it cannot say something
   * the definition does not -- the caveats that follow it ("not net sales",
   * "blank means unknown demand") stay one click away in Details.
   */
  function summaryOf(text) {
    const t = clean(text);
    if (!t) return '';
    const m = t.match(/^(.+?[.!?])(?=\s+[A-Z0-9“"(]|$)/);
    return m ? m[1] : t;
  }

  /** True when Details would show more than the card already does. */
  function hasMore(text) {
    const t = clean(text);
    return !!t && summaryOf(t) !== t;
  }

  function reportText(r) {
    return [r.title, r.description, r.question, r.created_by_name].map(clean).join(' ').toLowerCase();
  }
  function dashboardText(d) {
    return [d.name, d.description, d.created_by_name].map(clean).join(' ').toLowerCase();
  }

  /** Every whitespace-separated term must appear somewhere in the row. */
  function matches(haystack, query) {
    const terms = clean(query).toLowerCase().split(' ').filter(Boolean);
    return terms.every((t) => haystack.includes(t));
  }

  function filterReports(rows, query) {
    return (rows || []).filter((r) => matches(reportText(r), query));
  }
  function filterDashboards(rows, query) {
    return (rows || []).filter((d) => matches(dashboardText(d), query));
  }

  /** "Only me" / "Company" -- the one badge a custom report or board keeps. */
  function visibilityLabel(row) {
    return row && row.visibility === 'private' ? 'Only me' : 'Company';
  }

  const byTitle = (a, b) => clean(a.title).localeCompare(clean(b.title), undefined, { sensitivity: 'base' });

  global.SiloReportLibrary = {
    TABS,
    DEFAULT_TAB,
    isSiloReport,
    splitReports,
    tabFromSearch,
    urlForTab,
    summaryOf,
    hasMore,
    filterReports,
    filterDashboards,
    visibilityLabel,
    byTitle,
  };
})(typeof window !== 'undefined' ? window : globalThis);
