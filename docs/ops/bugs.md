# Known bugs & limitations

Only items that still matter today. Fixed items live in [CHANGELOG.md](CHANGELOG.md).

**Severity:** P1 = workflow blocked · P2 = workaround exists · P3 = polish

---

## Fix these first (P1)

No open P1s.

---

## Common (P2)

| Issue | Workaround |
|-------|------------|
| **`refresh_chat_schema_catalog()` deletes catalog rows for FUNCTIONS.** Its prune keeps only public relations, so the `seo_collection_candidates` entry seeded by `20260909380000` (and any future `relkind = 'f'` row) is removed by the refresh at the end of the same migration. Ask SILO knows that function from the prompt text, not the catalog. Found 2026-09-14 | Describe functions on the TABLE rows they read (appends), as `20260914120000` does; a fix to the prune is a small separate migration |
| **"No site row = day not ingested" is not strictly true.** `search_console_site_daily` gets a row only for days Google's site cut returned; a day with zero clicks and zero impressions returns no row, so the catalog/prompt/page rule reads a true zero as "not ingested". Conservative in the safe direction and not observed on this property | Leave the rule; if a zero-traffic day ever matters, distinguish it from the `sync_jobs` window of the run that covered it |
| **A failed Search Console nightly records no partial state.** `finishJob(jobId,'error')` writes the error and no `result`, unlike the backfill; a nightly that wrote page rows and then failed on query cannot say so from `sync_jobs` | Read the run log; the site row is written last so it never describes rows that are not there |
| **No period lock anywhere in SILO.** `entry_date` on card batches and adjustments is client-set and unchecked at approval; an entry dated before the accepted opening balance is approved (executed 2026-09-14, see [accounting-controls-review.md](accounting-controls-review.md)). Policy decision pending | Use QBO's closing date on the connected company; review every entry date at approval |
| **No bank reconciliation in SILO.** Coding, provider-change exceptions and the QBO history tie-out exist; a statement beginning/ending balance, cleared flags and a reconciled-period record do not | Reconcile in QBO after posting; treat `plaid_accounts.current_balance` as a hint, not a statement |
| BI vs Shopify report variance (online, Jan–Jun) restates only after a history re-import — sync fixes (cancelled orders included, shipping tax) apply to new days immediately but historical rows keep the old math until the backfill runs | Run Actions → "Shopify API Sync" with `sync_mode=history`, `history_days=200`, then re-reconcile against the Shopify export. If a residual Returns gap remains after restate, suspect exchange/store-credit returns (Redo) with $0 refund subtotals |
| Costing fallback JSON in `po_headers.internal_notes` | Apply migrations; move data into `po_costing` |
| Old bookmarks hit `/finance.html` instead of `/v2/finance.html` | Use `/v2/*` paths; nav links live in `v2/nav-config.js` (not `silo-chrome.js`, which only renders them) |
| Many v2 pages still iframe legacy HTML | Expected until Beacon migration (see roadmap) |
| Planning: projection seed has no product type | By design — see [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) |
| Optional DB view missing → empty open POs on planning page | Create view in Supabase or ignore |
| **`card-categorize` differs between production (v9) and `main`, and the difference is a prompt rule.** Production: "Where the CARD NAME names one of the locations listed above, use that location." Repo: "Only name a location when the merchant or card name clearly belongs to one store." Plus a `type Account` refactor and shorter comments on the deployed side, fuller comments on the repo side. **Deferred by decision (2026-09-10)** until there is enough real card coding to say which rule suggests better — shipping either one first ends the comparison. The drift check WARNS rather than fails on it, pinned to BOTH the deployed bundle hash and the function directory's git tree, so either a redeploy or any merged-but-undeployed repo change (edit, addition, removal, rename) makes it fail again. The 2026-09-14 history-evidence change to the function (`docs/ops/card-categorize-history.md`) ends the deferral by construction: the repo-tree pin in `DEFERRED_DRIFT` no longer matches, so the drift check will fail after merge until `card-categorize` is deployed from `main` and the entry is removed from `scripts/check-function-drift.mjs` | When there is enough usage: pick the rule, put the winning text in the repo, deploy from `main`, and delete the entry from `DEFERRED_DRIFT` in `scripts/check-function-drift.mjs` |

---

## Low priority (P3)

| Issue | Notes |
|-------|-------|
| Error UX differs (`alert` vs status line vs debug box) | See [errors.md](errors.md) |
| Planning v2 UX was clunky | Rebuilt from v1; old analysis in [planning-scenarios-v2-ux-plan.md](../planning-scenarios-v2-ux-plan.md) |

---

## Report a new bug

Add a row here (or a GitHub issue) with: symptom, page/URL, severity, workaround if any.
