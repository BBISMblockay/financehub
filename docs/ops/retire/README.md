# SILO retire / product boundary docs

Tracks what belongs in **SILO product navigation** vs what is **outsourced**, **external**, **being removed**, or **synced via Sheets until Shopify**.

**Goal:** Nav shows native SILO only. Legacy files stay in repo until each replacement ships.

## Folders

| Folder | Meaning |
|--------|---------|
| [native/](./native/README.md) | SILO-owned tools in primary nav |
| [tools/](./tools/README.md) | Active SILO tools — **not** in nav (bookmark/direct URL) |
| [sync-via-sheets/](./sync-via-sheets/README.md) | Native UI today; data still Sheets → Supabase until Shopify pipeline |
| [outsourced/](./outsourced/README.md) | Sheet-as-UI or legacy intake — not product nav; rebuild native |
| [external/](./external/README.md) | Not SILO — separate instance or link-out only |
| [remove/](./remove/README.md) | Leaving SILO entirely (delete when safe) |
| [rebuild/](./rebuild/README.md) | Planned native work (priority queue) |

**Index:** [manifest.md](./manifest.md)

## Rules

1. Removing from nav → update the right folder README + `manifest.md` in the same PR.
2. **Make Request** replaces purchase-only + receipt/travel Jotform intakes (receipt folds in).
3. Open legacy Jotform rows → migrate into Request Manager (manual migration).
4. P0 rebuild: **Shopify → Supabase** (replace Better Reports → Sheets for sales/inventory).
