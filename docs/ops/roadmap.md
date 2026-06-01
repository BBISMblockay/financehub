# Roadmap

Three buckets only. Check items off in PRs when done.

---

## Now (stability)

- [ ] Document which sync owns each sales/inventory channel
- [ ] Post-merge SQL checklist on every DB PR (`verify_v2_schema.sql`)
- [ ] Align `profiles.role` with `po_builder_can_write` / `po_costing_can_write`

---

## Next (v2 product)

- [ ] Finish Beacon shell migration ([SILO-BRAND.md](../../v2/SILO-BRAND.md) — fewer iframe legacy pages)
- [ ] One canonical URL per tool (`/v2/...` preferred)
- [ ] Same error/status pattern on all v2 pages

---

## Later (platform)

- [ ] Smoke tests (auth + one read per critical page)
- [ ] Sync job summary in DB or admin health page
- [ ] Retire unused `legacy/` pages after v2 parity

---

## v2 migration snapshot

| Done | In progress |
|------|-------------|
| projections, launch-calendar, profile, po-builder, planning-scenarios | inventory, finance, employeehub (custom layout) |
| | cashflow and others (iframe tool-shell) |
