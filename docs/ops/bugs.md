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
| **Six deployed edge functions differ from `main` in content**, per the drift check: `card-categorize` (84 lines), `sample-notify` (21), `shopify-oauth-callback` (10), `quickbooks-post-journal` (8), `page-inspect/inspect-lib.mjs` (8), `test-shopify-connection/shopify-scopes.ts` (5). Sources were first checked in on 2026-09-02 (#600), so for the older ones it is not yet known whether the repo copy was edited after check-in or checked in from something other than the deployment. `page-inspect` is the clear case: deployed 08:19 on 2026-09-09, its lib changed at 08:33 | Read the diff the check prints, then run "Deploy Edge Function" from `main` for each one the repo is right about — or fix the repo copy where the deployment is |

---

## Low priority (P3)

| Issue | Notes |
|-------|-------|
| Error UX differs (`alert` vs status line vs debug box) | See [errors.md](errors.md) |
| Planning v2 UX was clunky | Rebuilt from v1; old analysis in [planning-scenarios-v2-ux-plan.md](../planning-scenarios-v2-ux-plan.md) |

---

## Report a new bug

Add a row here (or a GitHub issue) with: symptom, page/URL, severity, workaround if any.
