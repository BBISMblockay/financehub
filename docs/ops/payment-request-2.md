# Payment Request 2

Separate assisted intake at `/v2/purchase_request2.html`. The existing intake and AP workbench keep their behavior.

## Preflight and decisions (before implementation)

- Live schema/policies/grants/triggers inspected read-only on 2026-09-19. `payment_requests` has no draft status, currency, or line-item columns. Inserts trigger the existing Slack notification. Ordinary requesters cannot update requests after submission. Attachments require an existing parent request for Storage RLS.
- Therefore reading a document is a bounded, authenticated, stateless Edge Function call. No request row or storage object is created by reading. Drafts, including file Blobs, live in IndexedDB on this device, keyed by user and company. The UI must explicitly state this limit.
- All six intake request types, optional Flex ID, multiple PO references, location, notes, requester identity and existing AP review remain. No new posting, payment, approval or costing write path.
- The PO summary view has no company column. Read `po_headers` with an explicit company filter and resolve factory names from same-company `factories`, under caller RLS. Suggestions never claim a match outside that returned set.
- Document extraction is untrusted evidence, not authorization. Validate values and document type/size/page count server-side. Do not fetch document URLs. Display suggestions for review, never silently replace typed values. Re-reading another document must not reuse an earlier response or imply that old fields belong to the new file.
- Duplicate checking is advisory and caller-visible only; a failed check is unavailable, not clear. Check vendor/invoice/amount, disclose the visibility limit, and require acknowledgement for possible duplicates. Existing database has no business duplicate uniqueness constraint; distinct drafts can still represent the same invoice.
- Submit keeps a durable client-minted request ID and frozen payload before the first insert. An ambiguous insert retries/reconciles that same ID, never creates a second request. Stable file IDs/paths let attachment retries resume safely. No destructive rollback of a request that AP may already be reading. Partial attachment failure must say the request exists and offer retry, not an invitation to resubmit.
- Concurrent draft edits use IndexedDB revision checks and a browser lock for submission. A changed active company or signed-out user invalidates the session before writes. AP remains the only editor after submission.

## Tests defined before implementation

- Real handler with fake authentication/provider: reject unauthenticated, inactive, wrong-company and missing membership calls before the model; reject oversized, disguised, encrypted/long PDFs; refuse malformed/truncated provider output; validate null/zero/negative amounts and calendar dates.
- Real submission orchestration with fake storage/database: lost insert response, same-ID retry, file upload/metadata failures, recovery from a persisted checkpoint, no second insert/notification path for retries, and company drift before writes.
- Form/helper behavior: all six types; multi-PO freight; normalization; edits preserved when applying suggestions; stale extraction discarded; duplicate unavailable vs possible vs none; money/currency validation; no model-supplied IDs/approval fields accepted.
- Existing v2 unit gate; browser gate if available. Render the new page and exercise its entry/review flow using an isolated fixture, never a production payment request.
- Mutation checks must show the relevant tests fail when auth/company guards, frozen-payload recovery or empty-amount validation are removed.

## Live verification still required

- After merge, deploy `payment-request-extract` through Deploy Edge Function. Reuses `ANTHROPIC_API_KEY`; optional `PAYMENT_REQUEST_MODEL` override. Merging alone does not deploy it.
- Confirm model availability and extraction quality on representative vendor PDFs, receipts and scans. Automated provider fixtures verify wiring, not OCR accuracy.
- Signed-in Test Company end-to-end check: document -> reviewed request -> attachments visible in Request Manager -> existing receipt/Slack behavior. No production request, email or Slack notification is created during this PR's local tests.
- Drafts are device-local and can be removed by clearing browser data. No cross-device draft promise. Separate independently created drafts are not a server-level duplicate lock.

No migration or permission broadening is required.

## PR verification

- `node v2/tests/run.js --unit`: all 11 suites pass, including 18 new submission/form checks.
- `node --test supabase/functions/payment-request-extract/handler.test.mjs`: 9 handler checks pass.
- `node --test scripts/tests/nav-profile.test.mjs`: 4 checks pass.
- `node --check v2/payment-request2.js`, workflow YAML parse, and `git diff --check`: pass.
- Mutation tests: removing amount validation, the extraction company guard, or the pre-write checkpoint each makes the corresponding suite fail. Original implementations restored.
- Final integrated self-review covered source changes, explicit currency review, all submission side effects, tenant checks and recovery. Removed stale suggested PO links/currency when the source changes and fixed an undefined Beacon token.
- `node v2/tests/run.js --browser`: attempted; runner cannot launch because its Chromium executable is absent. CI installs Chromium and runs this gate. Rendered UI verification also remains pending: the remote browser could not reach the local fixture server; hosting that fixture in its runtime was refused with EPERM. No screenshots or visual-pass claims.
- The Deno entry-point check is included in CI; local dependency downloads did not complete. Live extraction, authentication/RLS and receipt delivery remain unverified as described above.
- Independent review is separate from this author self-review and remains pending.
