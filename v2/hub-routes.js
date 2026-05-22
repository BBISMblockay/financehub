/**
 * Shared route tables for v2 department hubs (finance viewer, etc.)
 * v2Href = full-page navigation (SiloChrome + native or tool-shell wrapper)
 * src only = legacy path embedded in hub iframe with ?embed=1
 */
window.SILO_HUB_ROUTES = {
  finance: [
    {
      section: 'Overview',
      items: [
        { id: 'baseballism', label: 'Dashboard', v2Href: '/v2/employeehub.html' },
        { id: 'executive', label: 'Executive', v2Href: '/v2/executive.html' },
      ],
    },
    {
      section: 'Payables',
      items: [
        { id: 'ap-manager', label: 'AP Manager', src: '/accountspayable.html', v2Href: '/v2/ap-manager.html' },
        { id: 'mailroom', label: 'Mailroom Inbox', src: '/mailroom.html', v2Href: '/v2/mailroom.html' },
        { id: 'payables', label: 'BBISM Payables', src: '/ap-report.html', v2Href: '/v2/ap-payables.html' },
      ],
    },
    {
      section: 'Receivables',
      items: [
        { id: 'bbism-receivables', label: 'BBISM Receivables', v2Href: '/v2/baseballismwholesale.html' },
        { id: 'wpv-receivables', label: 'WPV Receivables', src: '/wpvaccounts.html' },
      ],
    },
    {
      section: 'Requests',
      items: [
        { id: 'travel-requests', label: 'Travel Requests', src: 'https://www.jotform.com/grid/200496754119055', external: true },
        { id: 'bars-requests', label: 'Bars Requests', src: 'https://www.jotform.com/grid/222686658265065', external: true },
        { id: 'travel-report', label: 'Travel Report', src: '/travel.html', v2Href: '/v2/travel.html' },
      ],
    },
    {
      section: 'Planning',
      items: [
        { id: 'projections', label: 'Revenue Projection', v2Href: '/v2/projections.html' },
        { id: 'marketing-calendar', label: 'Marketing Calendar', v2Href: '/v2/calendar.html' },
        { id: 'po-calendar', label: 'PO Calendar', v2Href: '/v2/planner.html' },
        { id: 'po-builder', label: 'PO Builder', v2Href: '/v2/po-builder.html' },
        { id: 'po-costing', label: 'PO Landed Cost', v2Href: '/v2/po-costing.html' },
        { id: 'po-report', label: 'PO Report', v2Href: '/v2/po-report.html' },
        { id: 'factories', label: 'Factories', src: '/pages/factories.html' },
      ],
    },
    {
      section: 'Inventory',
      items: [
        { id: 'inventory', label: 'Inventory Manager', v2Href: '/v2/inventory.html' },
        { id: 'product-tags', label: 'Product Tags', v2Href: '/v2/product-manager.html' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { id: 'sales-dashboard', label: 'BI Sales Dashboard', src: 'https://app.powerbi.com/view?r=eyJrIjoiY2U0MWI2ZmMtMTY3MS00MDY3LTg5NjctN2VlYjk0NGMxNzUzIiwidCI6IjIzYTkzNDJkLTFjODEtNGJkNS1hY2U0LThmYWY4ZWVlNTZiZCJ9', external: true },
        { id: 'payroll-bi', label: 'Payroll BI', src: '/payroll.html', v2Href: '/v2/payroll.html' },
        { id: 'cashflow', label: 'Cash flow', src: '/cashflow.html', v2Href: '/v2/cashflow.html' },
        { id: 'recon', label: 'Reconciliation', src: '/recon.html', v2Href: '/v2/recon.html' },
        { id: 'allocation', label: 'Allocation', src: '/allocation.html', v2Href: '/v2/allocation.html' },
        { id: 'checkwriter', label: 'Check writer', src: '/checkwriter.html', v2Href: '/v2/checkwriter.html' },
        { id: 'aprio', label: 'Aprio', src: '/aprio.html', v2Href: '/v2/aprio.html' },
      ],
    },
  ],

  employee: [
    {
      section: 'Submit & request',
      items: [
        { id: 'purchase', label: 'Purchase / invoice request', v2Href: '/v2/purchase_request.html' },
        { id: 'receipt', label: 'Receipt upload', src: 'https://form.jotform.com/202585858721161', external: true },
        { id: 'travel', label: 'Travel request', src: 'https://form.jotform.com/93366858544169', external: true },
        { id: 'cash', label: 'Cash reconciliation', src: 'https://docs.google.com/forms/d/e/1FAIpQLSckmYA0pninVJLOyPduZnMQ__b7gByaFJxoGCVYlKUVgQZcLA/viewform?embedded=true', external: true },
      ],
    },
    {
      section: 'Operations',
      items: [
        { id: 'logistics', label: 'Logistics', src: 'https://form.jotform.com/221717017586054', external: true },
        { id: 'travel-report', label: 'Travel report', src: '/travel.html', v2Href: '/v2/travel.html' },
      ],
    },
    {
      section: 'Reporting',
      items: [
        { id: 'analytics', label: 'Analytics', src: 'https://wpvportal.weebly.com/analytics-login---bbism.html', external: true },
        { id: 'requests', label: 'Requests hub', src: 'https://www.jotform.com/grid/200496570228052', external: true },
        { id: 'req-mgr', label: 'Request workbench', v2Href: '/v2/request_manager.html' },
      ],
    },
    {
      section: 'SILO',
      items: [
        { id: 'finance', label: 'Finance department', v2Href: '/v2/finance.html' },
        { id: 'profile', label: 'My profile', v2Href: '/v2/profile.html' },
      ],
    },
  ],
};
