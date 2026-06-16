# Navigation profiles

Visibility-only nav polish for multi-company SILO. **Does not** change page logic, route guards, or data queries.

## Profiles

| Profile | Who | Behavior |
|---------|-----|----------|
| `grandfathered` | `entity_key = baseballism` (or missing company in session) | Full sidebar + finance hub |
| `standard` | All other companies | Company ops menu; BBISM-only links hidden |

Override via `entities.meta.nav_profile` when needed.

## Standard menu (all new companies)

- **Start** — SILO home, Company home, My profile
- **Operations** — Payment Request, Request Manager
- **Planning** — Revenue Projection, Planning scenarios, Launch calendar, Task Manager
- **Purchasing** — PO Builder, PO Landed Cost, PO Report, Factories
- **Product & inventory** — Product Tracker, Inventory Manager, Product Hub

## Grandfathered-only (hidden for standard)

- Overview / Dashboard, Executive
- Payables (AP Manager, Mailroom, BBISM Payables)
- Receivables (BBISM, WPV)
- Travel Report, Jotform externals
- BI Sales Dashboard, Payroll BI

## Implementation

- `v2/nav-config.js` — item matrix + `SiloNav.navSectionsForCompany()`
- `v2/silo-chrome.js` — filters sidebar at render; shows company name under logo
- `v2/finance.html` — hides grandfathered hub tiles for standard profile

## Future

- Company switcher in sidebar
- `entities.meta.integrations.shopify` to toggle inventory/sales sources per company
