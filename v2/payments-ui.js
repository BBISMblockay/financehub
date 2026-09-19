/* Presentation only for Billing and Invoicing. No Stripe, auth or storage calls. */
(function () {
  'use strict';
  const paths = {
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    customer: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M19 7v6M16 10h6"/>',
    invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/>',
  };
  function icon(name) {
    return '<svg class="pay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + (paths[name] || paths.invoice) + '</svg>';
  }
  function decorate(root = document) {
    root.querySelectorAll('[data-pay-icon]').forEach((node) => {
      node.innerHTML = icon(node.dataset.payIcon);
    });
  }
  function filterInvoices(rows, status, search) {
    const term = String(search || '').trim().toLocaleLowerCase();
    return rows.filter((row) => (!status || row.status === status) && (!term || [
      row.number, row.customer_display_name, row.customer_display_email,
      row.customer_name, row.customer_email, row.stripe_invoice_id,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(term))));
  }
  window.SiloPaymentsUI = { icon, decorate, filterInvoices };
})();
