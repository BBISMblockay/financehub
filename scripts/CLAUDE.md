# scripts/ — sync, backfill and check scripts

Workflow schedules and what each sync writes: [`docs/agents/github-actions.md`](../docs/agents/github-actions.md).
Per-table rules for what the syncs write: `docs/agents/database.md`.

- Sync logic lives in `scripts/lib/*-sync-core.mjs`. Some edge functions ship VERBATIM copies
  (`supabase/functions/ad-platform-sync-run/lib/`), pinned identical by tests. Change the original and
  re-copy.
- Every sync write is an idempotent upsert, and the newest completed run wins (enforced by trigger on
  Search Console, SERP and Redo tables). Write a summary/site row LAST, so it never describes detail rows
  that failed to land.
- **A `concurrency` group on a sync workflow is the exception, not the default.** With
  `cancel-in-progress: false` a QUEUED run is cancelled as soon as another enters the group, so a
  group can silently drop a scheduled run -- which is why `shopify-sync.yml`, `meta-creative-backfill.yml`
  and `search-console-backfill.yml` refuse one: there a dropped run loses data nothing can recover.
  Take a group only where a dropped run costs nothing AND concurrent runs cost something, and say which
  in the workflow header: `plaid-sync.yml`, `on-deck-prepare.yml` and `seo-serp-sync.yml` (whose extra
  slots are redundant catch-ups by construction, while two overlapping runs would pay DataForSEO twice).
- **Never schedule the Shopify sync before 08:00 UTC** (still the previous Pacific day).
- Scripts that reason in Pacific do so as a westernmost BOUND. A zone west of Pacific breaks
  `tests/business-timezone-westmost.test.mjs` on purpose.
- Shopify's Admin API exposes only CURRENT inventory. A missed snapshot is unrecoverable.
- **Meta Graph API:** one bad field name refuses the whole request. Use the field-negotiation helpers
  (drop exactly the field Meta names) rather than a fixed field list. A null destination means
  "not resolved", never "none".
- Backfills ONLY ADD: never blank a resolved value with a null.
- Record each run in `sync_jobs`. `job_type` has a CHECK constraint; extend it for a new type.
- Tests: `scripts/tests/*.test.mjs` run in the "Sync logic tests" workflow.
