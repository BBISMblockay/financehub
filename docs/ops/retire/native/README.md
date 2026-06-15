# Native SILO — in product nav

SILO-owned tools. Data lives in Supabase (or will after sheet-sync tools move to Shopify).

## Finance & payables

| Tool | Route | Notes |
|------|-------|-------|
| Finance hub | `/v2/finance.html` | Landing |
| Payment request → **Make Request** | `/v2/purchase_request.html` | Expand for receipt / travel / purchase types |
| Request manager | `/v2/request_manager.html` | AP workbench; absorb legacy Jotform open items |

## Receivables & sales

| Tool | Route | Notes |
|------|-------|-------|
| BBISM receivables | `/v2/baseballismwholesale.html` | UI native; data via [sync-via-sheets](../sync-via-sheets/README.md) until Shopify |
| Sales verification | `/v2/sales-verification.html` | Fully native Supabase |

## Purchasing

| Tool | Route | Notes |
|------|-------|-------|
| PO builder / costing / report | `/v2/po-*.html` | Supabase |
| Factories | `/pages/factories.html` | Supabase |

Off-nav SILO tools (check writer, recon, buyer): [tools/](../tools/README.md).

## Planning & inventory

| Tool | Route | Notes |
|------|-------|-------|
| Revenue projections | `/v2/projections.html` | Supabase |
| Planning scenarios | `/v2/planning-scenarios.html` | Supabase |
| Launch calendar | `/v2/launch-calendar.html` | Supabase |
| Task manager | `/v2/tasks.html` | Supabase |
| Inventory manager | `/v2/inventory.html` | UI native; data via sheet sync → Shopify |
| Product hub / tracker | `/v2/product-manager.html`, `/v2/product-samples.html` | Supabase |

## People & admin

| Tool | Route | Notes |
|------|-------|-------|
| My profile | `/v2/profile.html` | Supabase |
| Backend admin | `/v2/backend.html` | Supabase |

## Not in nav (stubs / future)

| Tool | Route | Notes |
|------|-------|-------|
| Payroll | `/v2/payroll.html` | Rework as **HR module** (teams, employees, groups, depts) — [rebuild](../rebuild/README.md) |
| Allocation, Aprio | `/v2/allocation.html`, `/v2/aprio.html` | Stub redirects — rebuild if still needed |
