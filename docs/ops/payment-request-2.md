# Payment Request 2

Separate assisted intake at `/v2/purchase_request2.html`. The existing intake and AP workbench keep their behavior.

## Original PR preflight and decisions (historical)

- Live schema/policies/grants/triggers inspected read-only on 2026-09-19. `payment_requests` has no draft status, currency, or line-item columns. Inserts trigger the existing Slack notification. Ordinary requesters cannot update requests after submission. Attachments require an existing parent request for Storage RLS.
- Therefore reading a document is a bounded, authenticated, stateless Edge Function call. No request row or storage object is created by reading. Drafts, including file Blobs, live in IndexedDB on this device, keyed by user and company. The UI must explicitly state this limit.
- All six intake request types, optional Flex ID, multiple PO references, location, notes, requester identity and existing AP review remain. No new posting, payment, approval or costing write path.
- The PO summary view has no company column. Read `po_headers` with an explicit company filter and resolve factory names from same-company `factories`, under caller RLS. Suggestions never claim a match outside that returned set.
- Document extraction is untrusted evidence, not authorization. Validate values and document type/size/page count server-side. Do not fetch document URLs. Display suggestions for review, never silently replace typed values. Re-reading another document must not reuse an earlier response or imply that old fields belong to the new file.
- Duplicate checking is advisory and caller-visible only; a failed check is unavailable, not clear. Check vendor/invoice/amount, disclose the visibility limit, and require acknowledgement for possible duplicates. Existing database has no business duplicate uniqueness constraint; distinct drafts can still represent the same invoice.
- Submit keeps a durable client-minted request ID and frozen payload before the first insert. An ambiguous insert retries/reconciles that same ID, never creates a second request. Stable file IDs/paths let attachment retries resume safely. No destructive rollback of a request that AP may already be reading. Partial attachment failure must say the request exists and offer retry, not an invitation to resubmit.
- Concurrent draft edits use IndexedDB revision checks and a browser lock for submission. A changed active company or signed-out user invalidates the session before writes. AP remains the only editor after submission.

## Original PR tests defined before implementation

- Real handler with fake authentication/provider: reject unauthenticated, inactive, wrong-company and missing membership calls before the model; reject oversized, disguised, encrypted/long PDFs; refuse malformed/truncated provider output; validate null/zero/negative amounts and calendar dates.
- Real submission orchestration with fake storage/database: lost insert response, same-ID retry, file upload/metadata failures, recovery from a persisted checkpoint, no second insert/notification path for retries, and company drift before writes.
- Form/helper behavior: all six types; multi-PO freight; normalization; edits preserved when applying suggestions; stale extraction discarded; duplicate unavailable vs possible vs none; money/currency validation; no model-supplied IDs/approval fields accepted.
- Existing v2 unit gate; browser gate if available. Render the new page and exercise its entry/review flow using an isolated fixture, never a production payment request.
- Mutation checks must show the relevant tests fail when auth/company guards, frozen-payload recovery or empty-amount validation are removed.

## Original PR live verification requirements (see follow-up changes below)

- After merge, deploy `payment-request-extract` through Deploy Edge Function. Reuses `ANTHROPIC_API_KEY`; optional `PAYMENT_REQUEST_MODEL` override. Merging alone does not deploy it.
- Confirm model availability and extraction quality on representative vendor PDFs, receipts and scans. Automated provider fixtures verify wiring, not OCR accuracy.
- Signed-in Test Company end-to-end check: document -> reviewed request -> attachments visible in Request Manager -> existing receipt/Slack behavior. No production request, email or Slack notification is created during this PR's local tests.
- Drafts are device-local and can be removed by clearing browser data. No cross-device draft promise. Separate independently created drafts are not a server-level duplicate lock.

No migration or permission broadening is required.

## Original PR verification

- `node v2/tests/run.js --unit`: all 11 suites pass, including 18 new submission/form checks.
- `node --test supabase/functions/payment-request-extract/handler.test.mjs`: 9 handler checks pass.
- `node --test scripts/tests/nav-profile.test.mjs`: 4 checks pass.
- `node --check v2/payment-request2.js`, workflow YAML parse, and `git diff --check`: pass.
- Mutation tests: removing amount validation, the extraction company guard, or the pre-write checkpoint each makes the corresponding suite fail. Original implementations restored.
- Final integrated self-review covered source changes, explicit currency review, all submission side effects, tenant checks and recovery. Removed stale suggested PO links/currency when the source changes and fixed an undefined Beacon token.
- `node v2/tests/run.js --browser`: attempted; runner cannot launch because its Chromium executable is absent. CI installs Chromium and runs this gate. Rendered UI verification also remains pending: the remote browser could not reach the local fixture server; hosting that fixture in its runtime was refused with EPERM. No screenshots or visual-pass claims.
- The Deno entry-point check is included in CI; local dependency downloads did not complete. Live extraction, authentication/RLS and receipt delivery remain unverified as described above.
- Independent review is separate from this author self-review and remains pending.

## Follow-up: local reading (preflight / tests before implementation)

- Base: merged PR #726. No database, storage, notification or submission changes are needed. The optional interpretation endpoint retains its existing authenticated membership boundary.
- PDF.js extracts embedded text first. Tesseract.js reads images / scanned pages locally. Fixed CDN versions are lazy loaded; document bytes stay on the device during reading. Network access is still needed to load those libraries/language data initially.
- Deterministic label rules suggest only unambiguous fields. Distinguish amount due from invoice total, never infer currency from `$`, leave ambiguous dates/values empty and decline multiple invoice references. Keep source text visible and require existing human confirmation.
- Optional AI interpretation is an explicit second action over extracted text, never an automatic fallback. If the endpoint/key is absent, local suggestions and manual entry continue working.
- Tests to establish: digital PDF skips OCR; scanned/mixed pages use OCR; page/text/size bounds and cancellation; ambiguity/negative values/multiple invoices do not produce confident amounts; no provider calls during local reading; optional provider errors preserve local results; authenticated text-only endpoint rejects raw files and oversize input before provider use.


### Follow-up verification and rollout

- All 12 v2 unit suites pass, including 12 local-reader checks and the existing 18 submission checks. All 8 revised authenticated text-only handler checks pass; JS syntax and diff whitespace checks pass.
- Actual PDF.js 4.10.38 read a generated one-page invoice PDF successfully. Actual Tesseract.js 6.0.1 with pinned English data read a generated invoice PNG; the parser correctly produced invoice INV-1042, amount due 250.00, invoice total 1000.00 and USD. These engine checks ran in Node; they do not establish browser-worker rendering or accuracy across vendor invoices.
- Mutation tests caught bypassed AI consent, skipped scan OCR and accepted raw documents on the text endpoint. Originals restored before final tests.
- Full browser gate attempted: Chromium executable is missing in this environment, so rendered desktop/mobile behavior and browser-worker/CDN integration remain unverified locally. CI still runs the existing browser gate; representative browser invoice tests are required before rollout.
- Current main deleted `v2/nav-config.js` in commit 631ff17. This follow-up does not restore that file; Payment Request 2 now tolerates unavailable navigation chrome and keeps the authenticated form usable in a standalone layout. The broader missing-navigation issue predates this PR.
- Basic local reading needs only the frontend release, **no Edge deployment or AI key**. PDF.js, Tesseract.js, its WASM core and English language data are lazily downloaded from exact-version jsDelivr URLs. CDN access/workers/WASM must be allowed. This is not a promise of first-load offline operation. No new npm install or build is required by the static page.
- English OCR/label rules only for now. OCR can make mistakes; unfamiliar layouts, unlabeled vendors, ambiguous dates, negative values, multiple invoice references and non-US number formatting require human review/manual entry. A total alone is never treated as an amount due.
- Local limits: 4 MB, 10 PDF pages, 40,000 extracted characters, 8 million pixels per rendered OCR image and a 90-second operation timeout. Mixed pages with image operators use OCR even if they contain an embedded header.
- Optional assistance requires deploying updated `payment-request-extract` with the existing `ANTHROPIC_API_KEY`. Its input contract is now `{ company_id, text, consent: true }`; raw files/URLs are rejected. Old cached clients requesting raw-document AI must reload. If absent or on the old contract, the new page keeps local reading/manual entry available.
- Database migrations, RLS changes, notification changes and payment execution: none. No production documents or payment requests were submitted.
- Implementation references: [PDF.js API/examples](https://mozilla.github.io/pdf.js/examples/), [Tesseract worker API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [pinned language data](https://github.com/naptha/tessdata).

- Confirmed the downloaded Tesseract browser ESM uses `default.createWorker`; the adapter uses that actual export. Export contract checked in Node with `self` stubbed, separately from the real Node OCR test.
- Deno entry-point check attempted; the existing pinned Supabase import at esm.sh was refused by this environment's network. CI retains the typecheck job.
