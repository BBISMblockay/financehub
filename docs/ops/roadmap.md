# Roadmap

Three buckets only. Check items off in PRs when done.

---

## Now (stability)

- [x] Sync architecture: one GitHub Action reads Google Sheets → injects sales + inventory (named "Shopify sync" in the Action)
- [ ] Post-merge SQL checklist on every DB PR (`verify_v2_schema.sql`)
- [x] Align `profiles.role` with `po_builder_can_write` / `po_costing_can_write` — all 7 users are `admin`, enum is `owner/admin/user`

---

## Next (v2 product)

- [ ] Finish Beacon shell migration ([SILO-BRAND.md](../../v2/SILO-BRAND.md) — fewer iframe legacy pages)
- [ ] One canonical URL per tool (`/v2/...` preferred)
- [ ] Same error/status pattern on all v2 pages
- [ ] Native-only product nav — [retire/](./retire/README.md) subfolders (`native`, `sync-via-sheets`, `outsourced`, `external`, `remove`, `rebuild`)
- [ ] Shopify → Supabase pipeline (replace Better Reports → Sheets sync)
- [ ] Make Request (purchase + receipt + travel types)
- [ ] Native cashflow planner; native mailroom
- [ ] HR module (replaces payroll page)

---

## Later (platform)

- [ ] Smoke tests (auth + one read per critical page)
- [ ] Sync job summary in DB or admin health page
- [ ] Retire unused `legacy/` pages after v2 parity

---

## v2 migration snapshot

| Done | In progress |
|------|-------------|
| projections, launch-calendar, profile, po-builder, planning-scenarios, request manager | inventory, finance hub (native links only), mailroom (rebuild) |
| | cashflow native planner; Shopify direct sync |
