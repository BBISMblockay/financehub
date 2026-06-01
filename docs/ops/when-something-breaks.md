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

## GitHub Action failed

| Workflow | What failed | Check |
|----------|-------------|--------|
| Nightly Silo Sync | `sync-silo-inventory-sales.mjs` | Secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; Sheet URLs |
| AR Google Sheets Sync | `npm run sync:ar` | Same secrets; AR sheet publish URLs in `server/ar-sync.mjs` |

---

## Still stuck

1. Browser DevTools → Console (client errors).  
2. Supabase → Logs / SQL for RLS or missing views.  
3. Architecture context: [app-status.html](../../legacy/app-status.html).
