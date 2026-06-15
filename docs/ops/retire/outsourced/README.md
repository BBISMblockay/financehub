# Outsourced — sheet UI / legacy (not product nav)

Google Sheet as the app UI, or legacy page that reads sheets directly. **Not** in SILO sidebar. Rebuild as native Supabase tools when prioritized.

| Tool | Route | Replacement |
|------|-------|---------------|
| AP Manager | `/accountspayable.html` | Request manager + native AP views |
| BBISM Payables | `/ap-report.html` | Request manager / native reporting |
| Mailroom | `/mailroom.html` | Native mailroom (Supabase + storage) — **still needed** |
| Cashflow (current) | `/cashflow.html` | Native cash planner ([rebuild](../rebuild/README.md)) |

## Intake folding into Make Request

| Legacy | Action |
|--------|--------|
| Receipt upload (Jotform) | Fold into Make Request — ask receipt / travel / purchase |
| Travel report sheet | Fold into Make Request (travel type) + manager |
| Logistics Jotform | Make Request request type |

## Legacy Jotform queue

Open requests will be **migrated into Request Manager** manually. Historical rows already importable via `legacy-payment-requests-import` workflow.
