# When something breaks

Use the **first symptom** that matches. Each path ends with a concrete fix or doc.

---

## Page shows “Missing Supabase config”

1. Open `/pages/config.js` in the deployed site (or locally).
2. Confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set (from `config.json` on deploy).
3. Hard-refresh the browser.

---

## Login loop or “Access denied”

| Symptom | Fix |
|---------|-----|
| Never gets past login | Check `EXPECT_EMAIL_CONFIRMATION` in config; user must confirm email in Supabase |
| Logged in but page blocks me | Check `profiles.role` in Supabase for that user; role-gated pages (e.g. backend) have an allowlist |
| Wrong data / empty tables | **RLS** — fix policies in Supabase, not the anon key in HTML |

Never put the **service role** key in static HTML.

---

## PO / costing / profile errors

| Error text | Fix |
|------------|-----|
| `relation "public.po_headers" does not exist` | Run SQL: [`supabase/apply_all_post_merge.sql`](../../supabase/apply_all_post_merge.sql) — see [supabase/README.md](../../supabase/README.md) |
| Profile won’t save | Run section 3 of the same file (profile RLS policies) |
| Costing “works” but looks wrong | Old data may live in `po_headers.internal_notes` as `[SILO_COSTING]` JSON — migrate after tables exist |

**Verify DB:** paste [`supabase/verify_v2_schema.sql`](../../supabase/verify_v2_schema.sql) in Supabase SQL Editor → every row should say `ok`.

---

## Sales or inventory numbers look wrong

1. **Which job owns this channel?**  
   - Retail locations → nightly **Silo Sheets** sync (`scripts/sync-silo-inventory-sales.mjs`)  
   - Online Shopify → **Express** sync (`server/index.mjs`)  
   Both write `sales_by_day` / `inventory_on_hand`. Mixing them without a rule causes confusion.

2. **Did nightly sync run?**  
   GitHub Actions → `Nightly Silo Sync` → check last run logs.

3. **Stale Sheet URL?**  
   Update CSV export URLs in [`config/silo-sources.mjs`](../../config/silo-sources.mjs), re-run sync.

4. **Shopify rate limit (429)?**  
   Sync retries automatically; wait and re-run, or space out cron jobs.

---

## Planning Scenarios numbers don’t match expectations

- Projection seed is **company-wide** (`revenue_projections` has no product type). Mix/ASP still come from filtered sales.  
- Details: [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md)

---

## BBISM Receivables missing recent orders (sync green, data stale)

**Retired 2026-10-13. Read this first:** BBISM receivables moved to Shopify. `shopify_orders` carries the
wholesale book's payment terms and paid dates, read through `shopify_orders_v`; the Google Sheets pipeline
below is history, its daily cron is removed, and `/v2/baseballismwholesale.html` shows a book frozen at the
sheet's last order (2026-09-14). Its banner now says so, including that payments after that date are missing
too. **So "BBISM Receivables is stale" is expected, not an incident** — nothing below needs doing unless
somebody deliberately refreshes the old book, and a balance there may already be settled in Shopify.
`ar-sync.yml` is still dispatchable for exactly that case, and the steps below are what to check if a
dispatch comes back stale.

The AR pipeline was: **Shopify → scheduled report → Google Sheet → `ar-sync.yml` (nightly) → `ar_invoices` → workbench page.**
The sync only reads what the sheet contains — if the scheduled report feeding the sheet stops adding new orders, every sync still succeeds while the workbench drifts out of date. (Happened Jul–Aug 2026: sheet froze at Jul 21, old rows kept rolling off, so the report was clearly still refreshing — its filter/date range had stopped matching new orders. It froze for good on Sep 14.)

You'll see it two ways:

1. The workbench shows an amber **"Stale data"** banner with the frozen date.
2. A DISPATCHED `AR Google Sheets Sync` run **fails** with the same message (data still syncs first — the red run is the alarm). Threshold: `AR_STALE_MAX_DAYS` repo variable, default 7. It no longer runs on a schedule, so this cannot turn Actions red on its own.

**First check WHICH kind of stale it is** — the banner distinguishes them:

- **"Rows are being hidden by row-level security"** — the sync's newest order (in `job_sync_state.payload.newest_order_date`) is newer than what the page can see. The rows exist but lack a `company_entity_id` stamp, so RLS hides them from every user (happened Jun–Aug 2026: the sync writes as service_role and never stamped rows inserted after the multi-tenant backfill — the page was blind to everything after Jun 12 while the DB had orders through Jul 21). Fix: run `supabase/migrations/20260803160000_ar_company_entity_backfill.sql` in the SQL editor (idempotent). The sync stamps every row it touches since that same PR, so this should not recur unless a new AR table is added without stamping.
- **"This is the historical wholesale book, frozen at …"** — the data really stops there, and since 2026-10-13 that is the expected steady state. Only if somebody wants the old book refreshed is there anything to fix, and the fix is upstream, not in this repo:

1. Open the AR Google Sheet — confirm the last order row matches the banner date (both tabs: `gid=0` and `gid=801564681`).
2. In Shopify, open the scheduled report that feeds the sheet (Better Reports → scheduled reports) and check its **date range** (a fixed end date is the usual culprit) and **filters** (customer tag / sales channel / status that new orders no longer match).
3. Make sure new orders land in the **same tabs** the sync reads — a re-created report writing to a new tab is invisible to the sync.
4. After fixing, re-run the action manually (workflow_dispatch) and confirm the banner clears.

---

## GitHub Action failed

| Workflow | What failed | Check |
|----------|-------------|--------|
| Nightly Silo Sync | `sync-silo-inventory-sales.mjs` | Secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; Sheet URLs |
| AR Google Sheets Sync (dispatch only since 2026-10-13) | `npm run sync:ar` | Same secrets; AR sheet publish URLs in `server/ar-sync.mjs`. A stale-source failure is expected — the sheet is retired |

---

## Still stuck

1. Browser DevTools → Console (client errors).  
2. Supabase → Logs / SQL for RLS or missing views.  
3. Architecture context: [the current architecture guide](../../CLAUDE.md).
