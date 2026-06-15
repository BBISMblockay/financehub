# SILO retire / external manifest

This folder tracks tools that should **not appear in SILO product navigation** — either because they are being removed, rebuilt as native, or live outside SILO entirely.

**Goal:** SILO nav and finance hub show **native product only**. Legacy pages and external systems stay in the repo (or linked in docs) until each replacement ships.

## How to use

| File | Purpose |
|------|---------|
| [manifest.md](./manifest.md) | Master inventory: native vs retire vs external vs rebuild |
| [external-links.md](./external-links.md) | Bookmarks for systems that stay outside SILO (WPV, Power BI, etc.) |

When you remove something from `silo-chrome.js` or `v2/finance.html`, add or update its row in `manifest.md` in the same PR.

## Decision rules

1. **Native** — Supabase-backed (or syncing into Supabase); belongs in nav.
2. **Retire from nav** — Sheet UI, Jotform, iframe legacy, or duplicate of a native tool; file stays until rebuilt.
3. **External / not SILO** — Separate product or instance (WPV); document in `external-links.md`, never in nav.
4. **Rebuild** — Planned native work; tracked in manifest with target outcome.
