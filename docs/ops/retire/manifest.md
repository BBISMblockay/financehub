# SILO tool manifest

Last updated from product direction (Jun 2026). Nav should reflect **native only**; this file is the source of truth for everything else.

---

## Native — keep in SILO nav

| Tool | Route | Data |
|------|-------|------|
| Finance hub | `/v2/finance.html` | Shell |
| My profile | `/v2/profile.html` | Supabase `profiles` |
| Payment request *(→ Make Request)* | `/v2/purchase_request.html` | Supabase `payment_requests` + storage |
| Request manager | `/v2/request_manager.html` | Supabase |
| Mailroom | `/v2/mailroom.html` | Legacy sheet UI today — **keep in nav**, rebuild native |
| BBISM receivables | `/v2/baseballismwholesale.html` | Supabase AR + `ar-sync` |
| Revenue projections | `/v2/projections.html` | Supabase |
| Planning scenarios | `/v2/planning-scenarios.html` | Supabase |
| Launch calendar | `/v2/launch-calendar.html` | Supabase |
| Task manager | `/v2/tasks.html` | Supabase |
| PO builder / costing / report | `/v2/po-*.html` | Supabase |
| Factories | `/pages/factories.html` | Supabase |
| Inventory manager | `/v2/inventory.html` | Supabase (+ nightly sync) |
| Product hub / tracker | `/v2/product-manager.html`, `/v2/product-samples.html` | Supabase |
| Sales verification | `/v2/sales-verification.html` | Supabase |
| Payroll | `/v2/payroll.html` | Supabase |
| Backend admin | `/v2/backend.html` | Supabase |

### Native data pipelines (not UI)

| Pipeline | Script / workflow | Direction |
|----------|-------------------|-----------|
| Sales + inventory sync | `nightly-silo-sync.yml` → `sync-silo-inventory-sales.mjs` | Sheets today → **replace with Shopify API / webhooks → Supabase** |
| AR sync | `ar-sync.yml` | Sheets → Supabase (BBISM wholesale AR) |

---

## Retire from nav (files may remain in repo)

| Tool | Route | Why | Replacement |
|------|-------|-----|-------------|
| AP Manager | `/accountspayable.html` | Google Sheet UI | Request manager + native AP views |
| BBISM Payables | `/ap-report.html` | Google Sheet report | Request manager / native payables reporting |
| Travel report | `/travel.html` | Google Sheet dashboard | **Make Request** (travel type) + manager |
| Travel requests (Jotform) | Jotform grid | Outsourced intake | **Make Request** — dynamic travel fields |
| Receipt / logistics Jotforms | Jotform forms | Outsourced | **Make Request** request types |
| Employee hub | `/v2/employeehub.html` | Embed launcher, redundant with SiloChrome | Profile + finance hub + native intakes |
| Executive | `/executive.html` | Sheet + Power BI mashup | Native exec views on Supabase (later) |
| Cashflow (current) | `/cashflow.html` | Legacy / sheet-import | **Native cash planner** (POs, payables, cash on hand) |
| Wholesale orders (sheet) | `/pages/wholesale.html` | CSV from Sheets | Native on Supabase after sales pipeline |
| Check writer, recon, buyer, aprio, allocation | various | iframe legacy | Rebuild only if still needed |

---

## External — not SILO (see [external-links.md](./external-links.md))

| Tool | Notes |
|------|-------|
| WPV receivables | Separate instance; never in SILO nav |
| Power BI sales dashboard | External link only |
| Bars requests | Separate product coming; Jotform retired with it |

---

## Native rebuild queue (priority)

### P0 — Sales & inventory source of truth

**Replace:** Shopify → Better Reports → Google Sheets → GitHub Action → Supabase  

**Target:** Shopify Admin API and/or webhooks → Supabase directly (inventory, orders, sales rollups). Sheets become optional export only, not the pipeline.

**Touches:** `scripts/sync-silo-inventory-sales.mjs`, nightly workflow, inventory manager, sales verification, projections inputs.

### P1 — Make Request (expand payment request)

**Replace:** Purchase-only intake + Jotform travel/receipt/logistics  

**Target:** Single `/v2/purchase_request.html` (rename UX to **Make Request**) with dynamic fields by request type (payment, travel, reimbursement, etc.). Same Supabase tables + storage pattern.

### P1 — Cashflow planner

**Replace:** Legacy cashflow + sheet imports  

**Target:** Native planner: open payables, upcoming POs, scheduled payments, cash on hand — all Supabase.

### P2 — Mailroom native

**Replace:** Sheet-backed mailroom UI  

**Target:** Document intake, classification, routing in Supabase + storage (same pattern as payment request files).

### P3 — Nav cleanup complete

- [x] Remove retired tools from `silo-chrome.js` and `v2/finance.html` (this PR)
- [ ] Delete or redirect legacy HTML when native replacement ships
- [ ] Remove employee hub after profile + make-request cover pathways

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06 | Initial manifest; native-only nav; WPV/BI external; retire AP Manager, payables report, travel, bars, employee hub from nav |
