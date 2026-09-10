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
| BI vs Shopify report variance (online, Jan–Jun) restates only after a history re-import — sync fixes (cancelled orders included, shipping tax) apply to new days immediately but historical rows keep the old math until the backfill runs | Run Actions → "Shopify API Sync" with `sync_mode=history`, `history_days=200`, then re-reconcile against the Shopify export. If a residual Returns gap remains after restate, suspect exchange/store-credit returns (Redo) with $0 refund subtotals |
| Costing fallback JSON in `po_headers.internal_notes` | Apply migrations; move data into `po_costing` |
| Old bookmarks hit `/finance.html` instead of `/v2/finance.html` | Use `/v2/*` paths; nav links live in `v2/nav-config.js` (not `silo-chrome.js`, which only renders them) |
| Many v2 pages still iframe legacy HTML | Expected until Beacon migration (see roadmap) |
| Planning: projection seed has no product type | By design — see [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) |
| Optional DB view missing → empty open POs on planning page | Create view in Supabase or ignore |
| **Production's `notify_sample_events()` trigger is a hand-edited version no migration contains.** It fires SAMPLE_REQUESTED / SAMPLE_RECEIVED on insert and SAMPLE_SIZE_REQUEST (only for `catalog_photo_request`), and nothing else — the `SAMPLE_ASSIGNED`, `SAMPLE_WAREHOUSE_READY` and received-on-update paths that `20260818130000` → `20260818200000` define (and that the deployed `sample-notify` function handles) never fire from the DB. Found by the first scheduled drift check, 2026-09-10; verify checks 28 and 33 had said so for weeks. Whether the cut-down version was deliberate (too many notifications?) is unknown | Decide, then either re-apply `20260818200000_sample_received_transition_within_family.sql` in the SQL editor (restores all five event types) or check the prod version into a migration so the repo stops claiming otherwise. Do not leave both claiming to be right |
| **Two edge functions still differ from `main` after the 2026-09-10 reconciliation.** `page-inspect/inspect-lib.mjs`: repo is newer by one comment block (the corrected SSRF claim from review round 2); behaviour identical. `card-categorize`: deployed v9 (2026-08-31) and the repo copy (checked in 2026-09-02) each have edits the other lacks — the deployment has a `type Account` refactor and a prompt rule "Where the CARD NAME names one of the locations listed above, use that location"; the repo has the fuller comments and the rule "Only name a location when the merchant or card name clearly belongs to one store". Nobody has said which prompt rule is wanted. The other four were reconciled the same day: `review-finish` v20, `review-portal` v22, `sample-notify` v20 and `test-shopify-connection` v35 deployed from `main` (repo was newer); `shopify-oauth-callback` and `quickbooks-post-journal` had the NEWER version deployed, so the repo was updated to match instead | `page-inspect`: run "Deploy Edge Function" from `main` (not done by API client — it is the security-critical one and 43KB). `card-categorize`: pick the location rule, put the winning text in the repo, then deploy from `main` |

---

## Low priority (P3)

| Issue | Notes |
|-------|-------|
| Error UX differs (`alert` vs status line vs debug box) | See [errors.md](errors.md) |
| Planning v2 UX was clunky | Rebuilt from v1; old analysis in [planning-scenarios-v2-ux-plan.md](../planning-scenarios-v2-ux-plan.md) |

---

## Report a new bug

Add a row here (or a GitHub issue) with: symptom, page/URL, severity, workaround if any.
