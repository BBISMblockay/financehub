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

  /**
   * profiles: which nav profiles include this link
   * sectionStandard: optional section label for standard profile
   * labelStandard: optional link label for standard profile
   */
  const NAV_ITEMS = [
    { id: 'hub', section: 'Start', label: 'SILO home', href: '/index.html', profiles: ['grandfathered', 'standard'] },
    { id: 'finance/menu', section: 'Start', label: 'Finance department', labelStandard: 'Company home', href: '/v2/finance.html', profiles: ['grandfathered', 'standard'] },
    { id: 'people/profile', section: 'Start', label: 'My profile', href: '/v2/profile.html', profiles: ['grandfathered', 'standard'] },

    { id: 'people/dashboard', section: 'Overview', label: 'Dashboard', href: '/v2/employeehub.html', profiles: ['grandfathered'] },

    { id: 'finance/ap-manager', section: 'Payables', label: 'AP Manager', href: '/accountspayable.html', profiles: ['grandfathered'] },
    { id: 'finance/mailroom', section: 'Payables', label: 'Mailroom Inbox', href: '/v2/mailroom.html', profiles: ['grandfathered'] },

    { id: 'wholesale/customers', section: 'Receivables', label: 'BBISM Receivables', href: '/v2/baseballismwholesale.html', profiles: ['grandfathered'] },
    { id: 'wholesale/wpv', section: 'Receivables', label: 'WPV Receivables', href: '/v2/wpvaccounts.html', profiles: ['grandfathered'] },

    { id: 'finance/payment-request', section: 'Requests', sectionStandard: 'Operations', label: 'Payment Request', href: '/v2/purchase_request.html', profiles: ['grandfathered', 'standard'] },
    { id: 'finance/request-manager', section: 'Requests', sectionStandard: 'Operations', label: 'Request Manager', href: '/v2/request_manager.html', profiles: ['grandfathered', 'standard'] },
    { id: 'finance/travel', section: 'Requests', sectionStandard: 'Operations', label: 'Travel Report', href: '/v2/travel.html', profiles: ['grandfathered'] },

    { id: 'planning/revenue-projections', section: 'Planning', label: 'Revenue Projection', href: '/v2/projections.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/scenarios', section: 'Planning', label: 'Planning scenarios', href: '/v2/planning-scenarios.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/launch-calendar', section: 'Planning', label: 'Launch calendar', href: '/v2/launch-calendar.html', profiles: ['grandfathered', 'standard'] },
    { id: 'planning/tasks', section: 'Planning', label: 'Task Manager', href: '/v2/tasks.html', profiles: ['grandfathered', 'standard'] },

    { id: 'purchasing/po-builder', section: 'Purchasing', label: 'PO Builder', href: '/v2/po-builder.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/po-costing', section: 'Purchasing', label: 'PO Landed Cost', href: '/v2/po-costing.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/po-report', section: 'Purchasing', label: 'PO Report', href: '/v2/po-report.html', profiles: ['grandfathered', 'standard'] },
    { id: 'purchasing/factories', section: 'Purchasing', label: 'Factories', href: '/pages/factories.html', profiles: ['grandfathered', 'standard'] },

    { id: 'creative/product-samples', section: 'Creative', sectionStandard: 'Product & inventory', label: 'Product Tracker', href: '/v2/product-samples.html', profiles: ['grandfathered', 'standard'] },

    { id: 'inventory/workboard', section: 'Inventory', sectionStandard: 'Product & inventory', label: 'Inventory Manager', href: '/v2/inventory.html', profiles: ['grandfathered', 'standard'] },
    { id: 'inventory/products', section: 'Inventory', sectionStandard: 'Product & inventory', label: 'Product Hub', href: '/v2/product-manager.html', profiles: ['grandfathered', 'standard'] },

    { id: 'reports/dashboard', section: 'Reports', label: 'Dashboard', href: '/v2/bi-dashboard.html', profiles: ['grandfathered'] },
    { id: 'reports/sales-overview', section: 'Reports', label: 'Sales Performance Overview', href: '/v2/bi-sales-overview.html', profiles: ['grandfathered'] },
    { id: 'reports/daily-trend', section: 'Reports', label: 'Daily Sales Trend', href: '/v2/bi-daily-trend.html', profiles: ['grandfathered'] },
    { id: 'reports/returns', section: 'Reports', label: 'Returns & Refunds', href: '/v2/bi-returns.html', profiles: ['grandfathered'] },
    { id: 'reports/top-sellers', section: 'Reports', label: 'Top Sellers', href: '/v2/bi-top-sellers.html', profiles: ['grandfathered'] },
    { id: 'reports/product-types', section: 'Reports', label: 'Product Type Performance', href: '/v2/bi-product-types.html', profiles: ['grandfathered'] },
    { id: 'reports/product-search', section: 'Reports', label: 'Product Search', href: '/v2/bi-product-search.html', profiles: ['grandfathered'] },
    { id: 'finance/sales-bi', section: 'Reports', label: 'BI Sales Dashboard (legacy)', href: 'https://app.powerbi.com/view?r=eyJrIjoiY2U0MWI2ZmMtMTY3MS00MDY3LTg5NjctN2VlYjk0NGMxNzUzIiwidCI6IjIzYTkzNDJkLTFjODEtNGJkNS1hY2U0LThmYWY4ZWVlNTZiZCJ9', external: true, profiles: ['grandfathered'] },
    { id: 'people/payroll', section: 'Reports', label: 'Payroll BI', href: '/v2/payroll.html', profiles: ['grandfathered'] },

    { id: 'settings/integrations', section: 'Settings', label: 'Integrations', href: '/v2/integrations.html', profiles: ['grandfathered', 'standard'] },
  ];

  const STANDARD_SECTION_ORDER = ['Start', 'Operations', 'Planning', 'Purchasing', 'Product & inventory'];

  /**
   * @param {'grandfathered' | 'standard'} profile
   * @returns {{ section: string, items: typeof NAV_ITEMS }[]}
   */
  function navSectionsForProfile(profile) {
    const visible = NAV_ITEMS.filter((item) => item.profiles.includes(profile));
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
  function navSectionsForCompany(company) {
    return navSectionsForProfile(resolveNavProfile(company));
  }

  global.SiloNav = {
    resolveNavProfile,
    navSectionsForProfile,
    navSectionsForCompany,
    NAV_ITEMS,
  };
})(window);
