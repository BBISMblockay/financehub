# Navigation profiles

Visibility-only nav polish for multi-company SILO. **Does not** change page logic, route guards, or data queries.

## Profiles

| Profile | Who | Behavior |
|---------|-----|----------|
| `grandfathered` | `entity_key = baseballism` | Full sidebar + finance hub |
| `standard` | All other companies, **and any session with no resolved company** | Company ops menu; BBISM-only links hidden |

Override via `entities.meta.nav_profile` when needed.

**Missing company resolves to `standard`, not `grandfathered`** (changed
2026-09-17). `getActiveCompany()` reads sessionStorage, which is per-tab, so a
user arriving on a v2 page from a bookmark or deep link is fully authenticated
with no cached company — and under the old fallback a *second tenant's* user was
served Baseballism's sidebar in that state. Nothing leaked (RLS scopes the data
either way, and the extra links render empty pages), but it was the last place
SILO silently defaulted to Baseballism's configuration, and it is the first
thing a prospect would notice.

Failing to the smaller menu matches how grant-based unlocks already behave:
first paint shows less, then `silo-chrome.js` re-renders. `mount()` calls
`ensureActiveCompany()` when no company is cached and repaints the nav with
whatever it resolves, so a grandfathered user on a deep link sees the standard
menu for one frame rather than permanently seeing the wrong company's menu.

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
