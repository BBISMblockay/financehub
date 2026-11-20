/* ============================================================================
   SILO v3 — Reports library (the three tabs on /v3/dashboards.html)
   --------------------------------------------------------------------------
   Pure decisions only: which tab a row belongs to, what one line a card
   shows, what search matches, and which tab a URL asks for. The page owns
   the DOM; this owns the rules, so node can execute them.

   Classification is a view over rows already authorized by RLS:
     SILO Reports     global system definitions
     My Reports       active reports created by the signed-in user
     Company Reports  active company-visible reports, including the user's
     Archived         archived reports created by the signed-in user
   My and Company deliberately overlap for your shared reports. Archiving is
   organization, not access revocation: existing dashboards keep working.
   ========================================================================== */
(function (global) {
  'use strict';

  // Views, in the order they are offered. "SILO templates" first because it is
  // the only one that is never empty, and a front door that opens on an empty
  // list reads as a product with no reports in it.
  //
  // The ids are URL values and are NOT renamed: `?tab=scheduled` is in links,
  // bookmarks and the back button. Only the labels changed.
  const TABS = Object.freeze([
    { id: 'silo', label: 'SILO templates', noun: 'SILO templates' },
    { id: 'company', label: 'Company reports', noun: 'company reports' },
    { id: 'mine', label: 'My reports', noun: 'reports' },
    { id: 'archived', label: 'Archived', noun: 'archived reports' },
    { id: 'dashboards', label: 'Dashboards', noun: 'dashboards' },
    { id: 'scheduled', label: 'Schedules', noun: 'schedules' },
  ]);
  const DEFAULT_TAB = 'silo';
  // ?tab=reports deep-linked the old combined "Saved reports" list. Its
  // readers were looking for saved (custom) reports, so it lands there.
  const LEGACY_TABS = Object.freeze({ reports: 'mine' });

  const isSiloReport = (r) => !!r && r.source === 'system' && r.company_entity_id == null;
  // Same two fields, same rule, for a board. Both must hold: the table's CHECK
  // ties them together, and a row with only one of them is not SILO's.
  const isSiloDashboard = (d) => !!d && d.source === 'system' && d.company_entity_id == null;

  /** Pin SILO Overview, then other SILO boards, then company boards. */
  function orderDashboards(rows) {
    const list = rows || [];
    const overviewId = '5110da5b-0000-4000-a000-000000000001';
    return list.filter((d) => isSiloDashboard(d) && d.id === overviewId)
      .concat(list.filter((d) => isSiloDashboard(d) && d.id !== overviewId),
        list.filter((d) => !isSiloDashboard(d)));
  }

  function ownsReport(r, userId, companyId) {
    return !!(r && userId && companyId && r.created_by === userId
      && r.company_entity_id === companyId && r.source !== 'system');
  }

  function splitReports(rows, userId, companyId) {
    const split = { silo: [], mine: [], company: [], archived: [] };
    for (const r of rows || []) {
      if (isSiloReport(r)) { if (!r.archived_at) split.silo.push(r); continue; }
      if (!companyId || r.company_entity_id !== companyId) continue;
      const own = ownsReport(r, userId, companyId);
      if (r.archived_at) { if (own) split.archived.push(r); continue; }
      if (own) split.mine.push(r);
      if (r.visibility === 'company') split.company.push(r);
    }
    return split;
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

  /** The badge a dashboard card shows: SILO for a SILO board, else visibility. */
  function dashboardScopeLabel(d) {
    return isSiloDashboard(d) ? 'SILO' : visibilityLabel(d);
  }

  /* ── What a row shows ─────────────────────────────────────────────────── */

  /**
   * What this report answers, in one line.
   *
   * The stored description first, the Ask SILO question behind it, and nothing
   * invented from the title when there is neither: a made-up summary is worse
   * than a blank, because a reader cannot tell it apart from a real one.
   */
  function answersOf(report) {
    const r = report || {};
    return summaryOf(String(r.description || '').trim() || String(r.question || '').trim());
  }

  /**
   * Where a report's title goes.
   *
   * To RESULTS, always -- `/v3/dashboard.html?report=<id>` draws the report
   * with the viewer's own data and its own filters. Opening a report used to
   * land in the report builder's SQL view for a grandfathered workspace, which
   * is an authoring tool and the single biggest reason Reports read as a SQL
   * workbench. SQL is still one click away (builderHref) for whoever already
   * has it; it is just no longer what "open" means.
   *
   * A page link (one of SiloNav.SALES_REPORT_PAGES) keeps its own href.
   */
  function readerHref(report) {
    const r = report || {};
    if (r.href) return r.href;
    if (!r.id) return null;
    return `/v3/dashboard.html?report=${encodeURIComponent(r.id)}`;
  }

  /** The Advanced Builder link for a report, or null where authoring is not
   *  offered. Unchanged URL, so every existing deep link still resolves. */
  function builderHref(report, navProfile) {
    const r = report || {};
    if (!r.id || r.href || navProfile !== 'grandfathered') return null;
    return `/v3/report-builder.html?id=${encodeURIComponent(r.id)}`;
  }

  /**
   * Which report each schedule points at, so the library can say whether a
   * report is scheduled without a read per row. Keyed by report id; a report
   * with two schedules keeps the one that sends next, because that is the
   * answer to "when does this arrive".
   */
  function scheduleIndex(rows) {
    const byReport = new Map();
    for (const row of rows || []) {
      const id = row && row.report_id;
      if (!id) continue;
      const held = byReport.get(id);
      if (!held) { byReport.set(id, row); continue; }
      const a = held.next_run_at ? Date.parse(held.next_run_at) : Infinity;
      const b = row.next_run_at ? Date.parse(row.next_run_at) : Infinity;
      if (b < a) byReport.set(id, row);
    }
    return byReport;
  }

  /** "Scheduled" in a few words, or '' when it is not. Paused and off are
   *  stated rather than shown as scheduled: a report whose email was switched
   *  off three weeks ago is not a report anyone is receiving. */
  function scheduledLabel(row, cadenceLabel) {
    if (!row) return '';
    if (row.is_paused) return 'Paused';
    if (!row.is_active) return 'Off';
    const label = typeof cadenceLabel === 'function' ? cadenceLabel(row.cadence_preset) : '';
    return label || 'Scheduled';
  }

  /**
   * The views this viewer is offered.
   *
   * Pure, because the rules are the kind that quietly rot: before this, a
   * standard (merchant) workspace saw only SILO templates and Dashboards, and
   * its own saved and shared reports were reachable only through an
   * undocumented `?manage=reports` URL -- while Schedules was gated on the
   * grandfathered profile, so a merchant could not see or manage the email
   * their own workspace was sending. Both were a hangover from the days when
   * opening a report meant opening the SQL builder.
   *
   * `?manage=reports` still resolves and still means "organise reports", so
   * every existing link keeps working; it is simply no longer the only way in.
   */
  function allowedTabsFor(opts) {
    const o = opts || {};
    const base = o.navProfile === 'standard'
      ? (o.explicitManagement
        ? ['company', 'mine', 'archived', 'dashboards']
        : ['silo', 'company', 'mine', 'dashboards'])
      : ['silo', 'company', 'mine', 'archived', 'dashboards'];
    // Schedules is admin-only because RLS is: report_email_schedules is scoped
    // to is_entity_admin(), so a member offered the tab would get an empty
    // table and no reason for it.
    return o.isScheduleAdmin ? base.concat(['scheduled']) : base;
  }

  const byTitle = (a, b) => clean(a.title).localeCompare(clean(b.title), undefined, { sensitivity: 'base' });

  global.SiloReportLibrary = {
    TABS,
    DEFAULT_TAB,
    isSiloReport,
    splitReports,
    ownsReport,
    tabFromSearch,
    urlForTab,
    summaryOf,
    hasMore,
    filterReports,
    filterDashboards,
    visibilityLabel,
    isSiloDashboard,
    orderDashboards,
    dashboardScopeLabel,
    byTitle,
    answersOf,
    readerHref,
    builderHref,
    scheduleIndex,
    scheduledLabel,
    allowedTabsFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
