# SILO brand shell (v2)

All v2 tools should match **Revenue projections**, **Profile**, and **PO builder**: Beacon tokens, mono labels, band headers, KPI band, filter bar, and `bcn-card` / `bcn-table` matrix blocks.

## Required assets (order)

```html
<link rel="stylesheet" href="beacon.css" />
<link rel="stylesheet" href="silo-brand.css" />
<!-- page-specific <style> or CSS -->
<link rel="stylesheet" href="beacon-mirrors-unified.css" />
<link rel="stylesheet" href="v2-mobile.css" />
<script src="v2-shell.js" defer></script>
<script src="nav-config.js"></script>
<script src="silo-chrome.js"></script>
```

## Page skeleton

```html
<body>
  <div class="silo-app" id="silo-app">
    <main class="silo-main">
      <header class="bcn-header">…</header>
      <section class="bcn-kpi-band" aria-label="…">…</section>   <!-- optional -->
      <section class="bcn-filter-bar" aria-label="…">…</section> <!-- optional -->
      <!-- content: bcn-content grid, po-builder-main, or profile-wrap -->
    </main>
  </div>
</body>
```

Mount chrome after boot:

```js
SiloChrome.mount({
  appEl: '#silo-app',
  active: 'planning/revenue-projections',
  user: { email, role },
  crumbs: ['Planning', 'Revenue projections'],
  supabaseClient: sb,
});
```

## Embedded legacy tools

Use `tool-shell.js` + `data-tool` on `.silo-main` (see `v2/cashflow.html`). The shell renders `bcn-header` + dark `bcn-card` around the iframe.

## Migration status (audited 2026-08-16)

The reliable test is the script tags, not this table: a page that loads `silo-chrome.js` and **not**
`tool-shell.js` is on the full Beacon shell.

| Pattern | Pages |
|--------|--------|
| Full Beacon shell (33) | `accounting-export`, `bi-daily-trend`, `bi-product-search`, `bi-product-types`, `bi-sales-overview`, `bi-top-sellers`, `calendar`, `finance`, `insights`, `integrations`, `inventory`, `launch-calendar`, `live-schedule`, `mail-intake`, `mailroom`, `marketing-overview`, `my-review`, `planning-scenarios`, `po-builder`, `po-costing`, `po-report`, `products`, `profile`, `projections`, `purchase_request`, `request_manager`, `returns-overview`, `review-editor`, `review-templates`, `reviews`, `sales-verification`, `silo-chat`, `tasks` |
| Tool shell (iframe, 10) | `allocation`, `baseballismwholesale`, `buyer`, `cashflow`, `checkwriter`, `modelapps`, `recon`, `travel`, `wholesale`, `hidden/payroll` |
| Redirect stub (3) | `employeehub` → `/v2/finance.html`; `product-manager`, `product-samples` → `/v2/products.html` |
| Off-shell on purpose | `backend.html` (Tailwind CDN, no chrome), `company-picker.html` (pre-company selection), `launch-calendar-guide.html` (standalone doc) |

`planner.html` and `executive.html` no longer exist under `v2/` — earlier versions of this table listed them.

Legacy `.profile-card` / `.cost-card` inside `.silo-main` are harmonized via `silo-brand.css` until each page is rebuilt on `bcn-card`.

## Unused stylesheets

`po-builder-beacon.css` and `purchasing-hub-shell.css` have no references anywhere in the repo. Do not
add links to them; the live purchasing styles are `po-workbench.css` and `purchasing-page-content.css`.
