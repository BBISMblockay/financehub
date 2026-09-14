# SILO reference

Raw lists. Edit freely. Pulled from the repo 2026-09-14 (`CLAUDE.md`, `v2/nav-config.js`, `docs/ops/roadmap.md`, `docs/ops/bugs.md`).

---

## Features

### Accounting
- Accounting / Transactions workspace (`/v2/transactions.html`) — bank + card feeds via Plaid
- Card Coding (rules first, AI second, human review, journal entry post)
- Accounting Export (month → journal entries + deposit register)
- QBO Reports (Balance Sheet, P&L, GL, Trial Balance, drill-down)
- Journal adjustments composer (draft → approve → post)
- Schedules (prepaid amortization)
- Fixed Assets (straight-line depreciation)
- Cash Flow Forecast (credit facilities, recurring/one-time items)
- BBISM Receivables (legacy wholesale page)
- Checkwriter (internal, no nav entry)

### Requests
- Payment Request (intake form)
- Request Manager (AP approval queue, Melio forwarding)
- Mail Intake
- Mailroom (routing, assignments, notifications)

### Planning
- Org Calendar
- Revenue Projection
- Planning Scenarios
- Launch Calendar (tasks, assets, channel plan, product readiness, actuals measurement)
- TikTok Live Schedule (claim board, host payouts)
- Task Manager

### Team
- Performance Reviews (templates, roster, review editor, employee portal, signatures)
- My Reviews
- Compensation Requests (manager → finance)

### Purchasing
- PO Builder
- PO Landed Cost
- PO Report
- Factories

### Inventory / Product
- Inventory Manager (sell-through, velocity)
- Products (catalog, samples, tracker)
- Product Concepts (Ask SILO branch, tester-only)

### Sales reports
- Sales Performance Overview
- Daily Sales Trend
- Top Sellers
- Product Type Performance
- Product Search
- Sales Report (verification)
- Returns Overview (built, hidden)

### Marketing
- Marketing Report (day / week / MTD / YTD, reality check card)
- Performance (ad platform KPIs)
- Explorer (drill platform → campaign → ad, CSV)
- SEO Overview (Search Console, exec-only)

### Reports / BI
- Ask SILO (agentic chat over read-only SQL, taught notes, saved reports)
- Dashboards (v3 canvas: table / kpi / bar / line / donut / matrix / combo / heatmap / waterfall / section / answer)
- Saved reports library
- Report builder (guided + SQL, parameters, row estimate)
- System reports + tie-outs (independent checks)

### Admin
- Integrations (connections, sync toggles)
- Backend (users, invites, roles, access requests)
- Company picker (multi-tenant)
- Profile (avatar, landing page)
- Help

---

## Tech stack

- Frontend: vanilla HTML / CSS / JS, no framework, no build step
- Design system: Beacon CSS (`v2/beacon.css`), Plus Jakarta Sans + IBM Plex Mono
- Charts: ECharts (v3 dashboards only)
- Grid: GridStack (v3 dashboards only)
- Markdown: marked + DOMPurify (Ask SILO, answer widgets)
- Database: Supabase Postgres, RLS on every table, `security_invoker` views
- Auth: Supabase Auth (email/password, org invites)
- Storage: Supabase Storage, 6 buckets
- Edge functions: Supabase (Deno/TypeScript), 31 in repo, manual deploy
- AI: Anthropic API (Ask SILO, card-categorize)
- Sync jobs: GitHub Actions → Node.js scripts (`scripts/`)
- Hosting: static (silo-baseballism.com)
- Email: Resend
- Slack: webhook + bot token (sample notifications)
- Side service: Express (`server/`) for AR sync only
- Tests: Node unit suites + Playwright browser suites, run in CI (no secrets)

---

## Integrations

| Integration | Direction | Status |
|---|---|---|
| Shopify (Admin API, OAuth) | sales, inventory, catalog, payouts, orders → SILO | live, nightly 08:30 + 14:30 UTC |
| QuickBooks Online (OAuth) | chart of accounts, customers, vendors, reports ← ; journal entries → | live |
| Plaid | bank + card transactions → SILO | live (v1) |
| Meta Ads | campaign + ad KPIs, creatives, organic FB/IG → | live |
| Google Ads | campaign KPIs → | built, needs repo secrets |
| GA4 | sessions → | live |
| TikTok Ads (OAuth) | campaign KPIs → | connected, never synced |
| Google Search Console | site / page / query daily → | live, nightly |
| Redo | returns / exchanges (webhook + backfill) → | live, partial coverage |
| Melio | invoice forwarding → | live |
| Resend | transactional email → | live |
| Slack | notifications → | code present, secrets unset |
| Anthropic | Ask SILO, card categorization | live |
| Google Sheets / Better Reports | legacy sales + inventory | retired 2026-07-08 |
| Supermetrics | ad data | dropped before launch |

---

## Roadmap

### Now
- SEO project phase 2 (recommendation writer, workflow page, keyword / SERP schema, provider)
- Period lock + bank reconciliation (needs policy call)
- Launch capture discipline (prompt for products / PO in launch form)
- Post-merge SQL checklist on every DB PR

### Analysis loop
- Campaign → launch mapping
- Concept → PO surfacing decision (built, hidden)
- Watch `provenance` on next phase-2 concept run

### Reporting
- Tie-outs for non-system reports (21 of 96 covered)
- Push CLAUDE.md data traps into the Ask SILO schema catalog
- Fix hardcoded `location_tag = 'online'` in Marketing RPCs (multi-tenant bug)
- Retail ad measurement (none today)
- Meta thruplay / lead history backfill
- TikTok Ads first sync
- Google Ads ad-group / ad-level detail

### Multi-tenant
- Materialized views vs `security_invoker`
- Company switcher in sidebar
- Per-company sync pipelines

### v2 product
- Finish Beacon shell migration (4 iframe wrappers left)
- One canonical URL per tool
- Same error / status pattern on all pages

### Built but not surfaced
- Product Concepts
- Concept → PO
- Returns Overview
- Dashboards / Saved reports / Report builder (exec-only)
- Ask SILO (exec-only)
- SEO workflow tables (no page yet)

### Platform
- Smoke tests (auth + one read per page)
- Sync health page
- Retire `legacy/` after v2 parity
- `launch_task_templates` RLS tightening (P2)

---

## Stats

### Repo
| | |
|---|---|
| v2 pages | 56 |
| v3 pages | 3 |
| Pages on Beacon shell | 33 |
| Iframe wrappers left | 4 |
| Migrations | 293 |
| Edge functions in repo | 31 |
| GitHub workflows | 23 |
| Script test files | 45 |
| v3 test suites | 30 |
| Open bugs | 0 P1, 6 P2/P3 |
| Commits on this branch history | 132 |

### Data (as documented, dates noted)
| | |
|---|---|
| Companies | 2 (Baseballism, Test Company) |
| Shopify stores synced | 19 |
| `sales_by_day` rows | 1,140,089 (2026-08-26) |
| `inventory_on_hand` rows (one snapshot) | 70,622 (2026-09-08) |
| `products_master` rows | 24,056 |
| SKUs live on Shopify | 3,818 (2026-09-02) |
| Product titles | 4,585 |
| Product types | 129 |
| Factories | 141 |
| Launches | 61 (17 measurable) |
| Saved reports | 96 (21 system) |
| Product concepts | 18 |
| YTD sales | $25.2M ($7.59M retail) |
| Platform-claimed vs actual online YTD | $15.9M vs $15.95M (99.7%) |

### Users
| | |
|---|---|
| Real users | 34 (2026-09-04): 32 admin, 2 non-admin |
| Active profiles | 30 (2026-08-26): 23 admin |
| Baseballism profiles | 29 (28 membership admin) |
| Owner | blake@baseballism.com (`owner` / `owner_admin`) |
| Profile roles | owner, admin, executive, user |
| Membership roles | owner_admin, admin, member, viewer |
| Nav profiles | grandfathered (Baseballism), standard (new companies) |
