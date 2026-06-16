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

## Migration status

| Pattern | Pages |
|--------|--------|
| Full Beacon shell | `projections.html`, `launch-calendar.html`, `profile.html`, `po-builder.html` |
| Tool shell (iframe) | Finance, sales, wholesale, ops, purchasing mirrors (`cashflow.html`, etc.) |
| Custom layout + mirrors CSS | `inventory.html`, `finance.html`, `employeehub.html`, `executive.html`, `planner.html`, `calendar.html` |

Legacy `.profile-card` / `.cost-card` inside `.silo-main` are harmonized via `silo-brand.css` until each page is rebuilt on `bcn-card`.
