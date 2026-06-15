# Native rebuild queue

## P0 — Shopify → Supabase

Replace: Shopify → Better Reports → Google Sheets → nightly sync → Supabase  

Target: Shopify Admin API and/or webhooks → Supabase (inventory, orders, sales rollups).

Touches: `scripts/sync-silo-inventory-sales.mjs`, inventory manager, sales verification, projections, wholesale orders.

## P1 — Make Request

Rename/expand `/v2/purchase_request.html`:

- Request types: **purchase**, **receipt**, **travel** (dynamic fields)
- Receipt upload Jotform → retired
- Travel sheet report → retired for intake; reporting in manager

## P1 — Cashflow planner

Native planner on Supabase: open payables, upcoming POs, cash on hand. Retire sheet-based `/cashflow.html`.

## P2 — Mailroom native

Document intake, classification, routing — Supabase + storage (like payment request files).

## P2 — HR module (replaces payroll page)

Teams, employees, groups, departments. Current `/v2/payroll.html` is placeholder until this ships.

## P3 — Migrate legacy Jotform open requests

User-driven migration of open items into Request Manager; stop new Jotform submissions.
