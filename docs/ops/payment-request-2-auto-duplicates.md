# Automatic duplicate checks — preflight

Payment Request 2 currently asks users to click Check now, although submission already performs a fresh duplicate lookup. Remove the routine click: check automatically after a short pause when payee and valid amount are present, including suggestions and resumed drafts. Changes to payee, invoice, amount, currency or draft/company must invalidate previous results and acknowledgement immediately. Unrelated edits should not trigger extra queries. Superseded responses/errors and sign-out must not repaint the current request. Lookup failures cannot count as clearance; submission must still perform a fresh company-scoped lookup and require acknowledgement of the exact current matches. Keep matching rules, access restrictions and AP review unchanged.

Tests before implementation: debounce/incomplete inputs, suggestion/restored-draft snapshots, unrelated edits, out-of-order success/error, sign-out cancellation, failed lookup/retry, submission during pending background lookup, and changed matches invalidating acknowledgement. No schema changes or production writes.

## Verification

- Automatic lookup runs 500 ms after relevant fields change, including filled suggestions and restored drafts. Notes and other unrelated fields do not trigger extra queries. Previous results/acknowledgement are invalidated immediately when matching inputs change.
- The existing company-filtered, access-controlled lookup and 1,000-row limit are preserved. No policies/grants, writes or backend deployment changes. Errors never count as clearance. The fresh submission check requires acknowledgement tied to the checked details and exact match IDs.
- Eight new checks cover debounce, immutable snapshots, draft/company changes, stale success/error suppression, cancellation, lookup retries, submission racing a background lookup, and the actual form changed/submit functions with a mocked authenticated database. The form integration verifies company/vendor filters and confirms that changed matches and lookup errors prevent submission.
- Tests were defined first and initially failed on the missing implementation. Mutations removing automatic form scheduling, amount invalidation, stale-response rejection and submission acknowledgement checks each fail the suite. Fixes restored.
- All 13 v2 unit suites pass on the standalone change. The browser gate was attempted: all 11 suites fail to launch because Playwright's Chromium executable is absent locally. Authenticated browser behavior and production query latency remain unverified. Before release, verify auto-check after manual entry, Fill empty fields and draft restoration, then edit payee/invoice/amount and confirm that matches refresh without a button.

- Integrated with the PDF preview correction in PR #729: all 14 v2 unit suites pass. Preserved the preview import, source-change disposal and sign-out cleanup while replacing the old duplicate-check generation counter.
