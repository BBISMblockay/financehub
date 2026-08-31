/* ========================================================================
   SILO nav profiles — visibility only (no route guards, no data logic).
   Load before silo-chrome.js on Beacon pages.
   ======================================================================== */
(function (global) {
  const BASEBALLISM_KEY = 'baseballism';

  /** @typedef {{ id: string, title?: string, entity_key?: string, meta?: object }} SiloCompany */

  /**
   * @param {SiloCompany | null | undefined} company
   * @returns {'grandfathered' | 'standard'}
   */
  function resolveNavProfile(company) {
    if (!company) return 'grandfathered';
    const metaProfile = company.meta && company.meta.nav_profile;
    if (metaProfile === 'grandfathered' || metaProfile === 'standard') return metaProfile;
    if (company.entity_key === BASEBALLISM_KEY) return 'grandfathered';
    return 'standard';
  }

  // Departments that see finance-sensitive links. Employee-facing forms
  // (Payment Request) are NOT gated — everyone submits those. Nav hiding is
  // UX only; the data itself is gated by department-aware RLS.
  const FINANCE_DEPTS = ['exec', 'finance'];

  // profiles.role values that see exec-only links (e.g. Ask SILO during its
  // soft launch). Same simplified profile-role check used client-side for
  // silo_chat_notes write access (review-templates.html, silo-chat.html) --
  // UX only, not a security boundary; membership owner_admin isn't checked
  // here the way the real is_exec_or_owner() RLS gate checks it.
  const EXEC_ROLES = ['owner', 'executive'];

  // profiles.role values that see admin-only links (e.g. Integrations,
  // which reads connection secrets gated server-side by is_admin_user() --
  // see 20260814000000_lock_connection_secrets_to_admin.sql). UX only, same
  // caveat as EXEC_ROLES: the real boundary is RLS, not this list.
  const ADMIN_ROLES = ['owner', 'admin', 'executive'];

  /**
   * profiles: which nav profiles include this link
   * departments: user departments that see this link (absent = everyone;
   *              a null/unresolved department shows everything, an unlisted
   *              one hides the link)
   * roles: profiles.role values that see this link (absent = everyone;
   *        a null/unresolved role shows everything, same fail-open
   *        behavior as departments -- avoids hiding links before the
   *        profile fetch lands)
   * grantTable: name of a table where a caller-visible row
   *             (select ... where user_id = auth.uid()) also unlocks this
   *             link even if `roles` doesn't match -- e.g. silo_chat_managers,
   *             so someone granted Ask SILO access via backend.html sees the
   *             link without needing an exec/owner profiles.role. Resolved
   *             async (silo-chrome.js) since it needs a DB round trip, same
   *             timing as departments; unlike departments this fails CLOSED
   *             (no extra visibility) if the check errors or hasn't run yet
   *             -- `roles` already decided "no" and this can only add a "yes".
   * sectionStandard: optional section label for standard profile
   * labelStandard: optional link label for standard profile
   */
  const NAV_ITEMS = [
    { id: 'finance/menu', section: 'Start', label: 'Home', href: '/v2/finance.html', profiles: ['grandfathered', 'standard'] },
    { id: 'start/insights', section: 'Start', label: 'Action Items', href: '/v2/insights.html', profiles: ['grandfathered', 'standard'] },
    { id: 'people/profile', section: 'Start', label: 'My Profile', href: '/v2/profile.html', profiles: ['grandfathered', 'standard'] },
    { id: 'start/help', section: 'Start', label: 'Help', href: '/v2/help.html', profiles: ['grandfathered', 'standard'] },


    { departments: FINANCE_DEPTS, id: 'finance/accounting-export', section: 'Accounting', sectionStandard: 'Operations', label: 'Accounting Export', href: '/v2/accounting-export.html', profiles: ['grandfathered', 'standard'] },
    { departments: FINANCE_DEPTS, id: 'finance/qbo-reports', section: 'Accounting', sectionStandard: 'Operations', label: 'QuickBooks Reports', href: '/v2/qbo-reports.html', profiles: ['grandfathered', 'standard'] },
    { departments: FINANCE_DEPTS, id: 'finance/schedules', section: 'Accounting', sectionStandard: 'Operations', label: 'Schedules', href: '/v2/schedules.html', profiles: ['grandfathered', 'standard'] },
    { departments: FINANCE_DEPTS, id: 'finance/card-coding', section: 'Accounting', sectionStandard: 'Operations', label: 'Card Coding', href: '/v2/card-coding.html', profiles: ['grandfathered', 'standard'] },
    { departments: FINANCE_DEPTS, id: 'wholesale/customers', section: 'Accounting', label: 'BBISM Receivables', href: '/v2/baseballismwholesale.html', profiles: ['grandfathered'] },
    // WPV Receivables removed 2026-08-16 — stale Google Sheets flow, page retired.
    { id: 'finance/payment-request', section: 'Accounting', sectionStandard: 'Operations', label: 'Payment Request', href: '/v2/purchase_request.html', profiles: ['grandfathered', 'standard'] },
    // logistics added alongside FINANCE_DEPTS so that department can still
    // see Request Manager to track payment requests they submitted --
    // RLS (payment_requests_active_select) already lets anyone see their
    // own created_by rows regardless of department; this just keeps the
    // nav link (and dept-guard.js on the page itself) from hiding it.
    { departments: [...FINANCE_DEPTS, 'logistics'], id: 'finance/request-manager', section: 'Accounting', sectionStandard: 'Operations', label: 'Request Manager', href: '/v2/request_manager.html', profiles: ['grandfathered', 'standard'] },
    { id: 'finance/mail-intake', section: 'Accounting', sectionStandard: 'Operations', label: 'Mail Intake', href: '/v2/mail-intake.html', profiles: ['grandfathered', 'standard'] },
    { departments: FINANCE_DEPTS, id: 'finance/mailroom', section: 'Accounting', sectionStandard: 'Operations', label: 'Mailroom', href: '/v2/mailroom.html', profiles: ['grandfathered', 'standard'] },
    // Travel Report removed 2026-08-16 — stale Google Sheets dashboard, page retired.

    { id: 'planning/calendar', section: 'Planning', label: 'Org Calendar', href: '/v2/calendar.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/revenue-projections', section: 'Planning', label: 'Revenue Projection', href: '/v2/projections.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/scenarios', section: 'Planning', label: 'Planning scenarios', href: '/v2/planning-scenarios.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/launch-calendar', section: 'Planning', label: 'Launch calendar', href: '/v2/launch-calendar.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/live-schedule', section: 'Planning', label: 'TikTok Live Schedule', href: '/v2/live-schedule.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/tasks', section: 'Planning', label: 'Task Manager', href: '/v2/tasks.html', profiles: ['grandfathered', 'standard'] },

    { id: 'team/reviews', section: 'Team', label: 'Performance Reviews', href: '/v2/reviews.html', profiles: ['grandfathered', 'standard'] },
    { id: 'team/my-review', section: 'Team', label: 'My Reviews', href: '/v2/my-review.html', profiles: ['grandfathered', 'standard'] },
    // Ungated on purpose: any manager can submit a request for their own
    // reports; the Finance Queue tab inside the page self-hides for
    // non-finance via an RPC check (current_user_can_manage_comp_requests()),
    // same "nav shows it to everyone, the page/RLS narrows what's actually
    // usable" shape as Payment Request / Request Manager above.
    { id: 'team/comp-requests', section: 'Team', label: 'Compensation', href: '/v2/comp-requests.html', profiles: ['grandfathered', 'standard'] },

    { id: 'purchasing/po-builder', section: 'Purchasing', label: 'PO Builder', href: '/v2/po-builder.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/po-costing', section: 'Purchasing', label: 'PO Landed Cost', href: '/v2/po-costing.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/po-report', section: 'Purchasing', label: 'PO Report', href: '/v2/po-report.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/factories', section: 'Purchasing', label: 'Factories', href: '/pages/factories.html', profiles: ['grandfathered', 'standard'] },

    { id: 'inventory/workboard', section: 'Inventory', sectionStandard: 'Product & inventory', label: 'Inventory Manager', href: '/v2/inventory.html', profiles: ['grandfathered', 'standard'] },
    { id: 'inventory/products', section: 'Inventory', sectionStandard: 'Product & inventory', label: 'Products', href: '/v2/products.html', profiles: ['grandfathered', 'standard'] },

    // 'Reports' was one flat drawer of 10 links and was the section every new
    // BI page landed in. Split into Sales and Marketing so each stays
    // readable in the accordion; the `id` prefixes stay `reports/` because
    // they are the `active` keys every page passes to SiloChrome.mount() and
    // renaming them would silently un-highlight the sidebar on all 9 pages.
    { id: 'reports/sales-overview', section: 'Sales', label: 'Sales Performance Overview', href: '/v2/bi-sales-overview.html', profiles: ['grandfathered'] },
    { id: 'reports/daily-trend', section: 'Sales', label: 'Daily Sales Trend', href: '/v2/bi-daily-trend.html', profiles: ['grandfathered'] },
    { id: 'reports/top-sellers', section: 'Sales', label: 'Top Sellers', href: '/v2/bi-top-sellers.html', profiles: ['grandfathered'] },
    { id: 'reports/product-types', section: 'Sales', label: 'Product Type Performance', href: '/v2/bi-product-types.html', profiles: ['grandfathered'] },
    { id: 'reports/product-search', section: 'Sales', label: 'Product Search', href: '/v2/bi-product-search.html', profiles: ['grandfathered'] },
    { id: 'reports/sales-report', section: 'Sales', label: 'Sales Report', href: '/v2/sales-verification.html', profiles: ['grandfathered'] },

    // Week over Week sits under Marketing: its KPI band is sales-shaped, but
    // it is a marketing report, read by and built for marketing.
    { id: 'reports/wow-report', section: 'Marketing', label: 'Week over Week', href: '/v2/wow-report.html', profiles: ['grandfathered'] },
    { id: 'reports/marketing-overview', section: 'Marketing', label: 'Marketing Performance', href: '/v2/marketing-overview.html', profiles: ['grandfathered'] },
    { id: 'reports/marketing-explorer', section: 'Marketing', label: 'Marketing Explorer', href: '/v2/marketing-explorer.html', profiles: ['grandfathered'] },

    // Deliberately left in its own 'Reports' section by the Sales/Marketing
    // split above, not moved and not promoted, because it is still in soft
    // launch. Section matters here beyond labelling: 'Reports' is absent
    // from STANDARD_SECTION_ORDER, so a standard-profile company drops this
    // link entirely regardless of role -- moving it to a listed section
    // would surface it to standard-profile execs. Give it a top-level row
    // when the launch opens up, not before.
    // Soft launch: exec-only for now. Everyone can already use the page and
    // read taught notes if they have the URL (nothing behind it needs
    // restricting) -- this just controls who sees it in the sidebar first.
    // Widen `roles` (or drop it) once ready for the whole team.
    { roles: EXEC_ROLES, grantTable: 'silo_chat_managers', id: 'reports/silo-chat', section: 'Reports', label: 'Ask SILO', href: '/v2/silo-chat.html', profiles: ['grandfathered', 'standard'] },
    // Hidden from nav for now -- redo_returns only covers a small, recent
    // slice of Shopify's actual refund volume (Redo doesn't see all refunds,
    // and there's no historical backfill yet). Page itself still works at
    // /v2/returns-overview.html; re-add this row once that's sorted out.
    // { id: 'reports/returns-overview', section: 'Sales', label: 'Returns & Exchanges', href: '/v2/returns-overview.html', profiles: ['grandfathered'] },


    // Admin-only: this page displays connection secrets (webhook/API keys,
    // OAuth tokens), now RLS-gated to is_admin_user() -- see
    // 20260814000000_lock_connection_secrets_to_admin.sql. Nav hiding is
    // UX only; ADMIN_ROLES is a client-side approximation of that gate.
    { roles: ADMIN_ROLES, id: 'settings/integrations', section: 'Settings', label: 'Integrations', href: '/v2/integrations.html', profiles: ['grandfathered', 'standard'] },
  ];

  // Standard-profile section order. A section missing from this list is
  // DROPPED for standard-profile companies (the grandfathered branch below
  // appends leftovers; this one does not) -- 'Sales' and 'Marketing' are
  // listed here purely so a future standard-profile report doesn't vanish
  // silently. No standard-profile item uses either section today.
  const STANDARD_SECTION_ORDER = ['Start', 'Operations', 'Planning', 'Team', 'Purchasing', 'Product & inventory', 'Sales', 'Marketing', 'Settings'];

  /**
   * @param {'grandfathered' | 'standard'} profile
   * @returns {{ section: string, items: typeof NAV_ITEMS }[]}
   */
  function navSectionsForProfile(profile, department, role, grantIds) {
    const dept = department ? String(department).toLowerCase() : null;
    const userRole = role ? String(role).toLowerCase() : null;
    const visible = NAV_ITEMS.filter((item) =>
      item.profiles.includes(profile)
      && (!item.departments || !dept || item.departments.includes(dept))
      && (!item.roles || !userRole || item.roles.includes(userRole)
          || (grantIds && grantIds.has && grantIds.has(item.id))));
    const bySection = new Map();

    for (const item of visible) {
      const sectionName = profile === 'standard' && item.sectionStandard ? item.sectionStandard : item.section;
      if (!bySection.has(sectionName)) bySection.set(sectionName, []);
      bySection.get(sectionName).push({
        ...item,
        label: profile === 'standard' && item.labelStandard ? item.labelStandard : item.label,
      });
    }

    const order = profile === 'standard'
      ? STANDARD_SECTION_ORDER
      : [...bySection.keys()];

    const sections = [];
    for (const name of order) {
      const items = bySection.get(name);
      if (items && items.length) sections.push({ section: name, items });
    }

    if (profile === 'grandfathered') {
      for (const [name, items] of bySection.entries()) {
        if (!sections.some((s) => s.section === name)) sections.push({ section: name, items });
      }
    }

    return sections;
  }

  /**
   * @param {SiloCompany | null | undefined} company
   */
  function navSectionsForCompany(company, department, role, grantIds) {
    return navSectionsForProfile(resolveNavProfile(company), department, role, grantIds);
  }

  global.SiloNav = {
    resolveNavProfile,
    navSectionsForProfile,
    navSectionsForCompany,
    NAV_ITEMS,
  };
})(window);
