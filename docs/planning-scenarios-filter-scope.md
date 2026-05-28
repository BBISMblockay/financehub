# Planning Scenarios v2 — filter scope parity

## v1 reference

`legacy/pages/planning-scenarios.html` applies product type, channel, search, and date filters **before** aggregation:

1. `FILTERED_SALES`, `FILTERED_INVENTORY`, `FILTERED_OPEN_PO_ROWS` are built in `run()`.
2. Scenario units, historical totals, inventory gap, and open PO coverage use those filtered arrays.
3. `buildProductFamilies()` only sees `FILTERED_INVENTORY`; demand share is `demand / sum(demand)` within that family set (sums to 100% in scope).
4. `revenuePlanForMonth`: manual `revplan_*` if set, else `allRevenueForMonth` (channel-scoped company revenue). Product-type slice comes from `mixPctForMonth`, not by bypassing the plan inputs.
5. Open PO date filter in v1: `to` only (no `from` on PO `month_key`).

## v2 regressions fixed

| Issue | Symptom | Fix |
|-------|---------|-----|
| `revenuePlanForMonth` runtime bypass | Projection/open PO mode ignored `revplan_*` and broke product-type mix after seed | Restored v1: manual → `allRevenueForMonth` only |
| `selDataSource = revenue_projections` | Wrapper triggered bypass on every projection seed UI change | Seed mode on `filtersCard.dataset.seedMode`; engine `dataSource` stays `manual` |
| KPI strip read comparison cards | Caps filter showed wrong units/gap | `renderKpiStrip()` from `selectedScenario()` in filtered scope |
| Pre-run gap with empty inventory | Inflated gap before Run | KPI/gap show “Run scenario” until inventory loaded |
| Open PO `from` filter | v2 differed from v1 PO window | PO filter uses `to` only (v1 parity) |

## Projection seed limitation

`revenue_projections` has **no product_type**. Seeding only fills monthly `revplan_*` totals (optionally filtered by location/scenario/date). Mix, ASP, units, families, gap, and KPIs still use filtered sales/inventory per active product type/channel/search.

## Acceptance checklist

- [ ] Same date range: **All** vs **Caps** — scenario units, gap table, families, export only Caps; demand shares sum to ~100% across Caps families.
- [ ] Switch back to **All** — full model restored.
- [ ] Product type + search / channel / location (location affects projection seed rows only).
- [ ] Projection seed → revplan filled → Run uses v1 engine path (not live projection bypass).
