# Payment Request 2 Unicode recovery

## Preflight

The reported insert error is PostgreSQL 22P05. A NUL or unpaired UTF-16
surrogate in a submitted string can cause it; the user's exact offending field
has not been inspected. Valid accents, non-Latin text and emoji must survive.

Call path: page submit -> validateFields/requestPayload -> submitRequest ->
checkpoint -> same-company read -> insert -> attachments -> receipt. PDF/OCR
suggestions and manual entry both reach requestPayload. Frozen drafts bypass
field validation and reuse payload. saveDraft enforces revisions; the page uses
a per-request Web Lock. All new recovery must use those same barriers.

No database policies, grants, triggers or functions change. No production writes
or real submissions are part of verification. Live authentication/RLS and the
particular user's device-local draft remain rollout verification requirements.

Recovery is a user-reviewed, local-only text correction, never an AP update.
Only known editable text fields may change. Frozen recovery requires a recorded
22P05 rejection, no saved-request/receipt checkpoint, the original user/company,
and a fresh successful read finding no existing request. Unknown read state or
an existing row refuses recovery. The original reference, amount, type, dates,
attachments and all other frozen data remain. A failed checkpoint must leave
the in-memory draft unchanged. A later retry still checks the same ID before
inserting, so a row that appears meanwhile is reconciled, never overwritten.

## Tests defined before implementation

- Reject NUL and lone surrogates in new payloads, including manual PO references;
  preserve valid surrogate pairs, accents, newlines and literal backslash text.
- Review/cancel correction; recover a persisted rejected payload with unchanged
  ID, money and attachments; resume successfully with exactly one insert.
- Refuse other error codes, already saved rows, failed reads, wrong identity,
  context changes, and revision/checkpoint conflicts without modifying the draft.
- Exercise the real page's repair control and confirmation with synthetic data;
  verify no insert occurs until the subsequent explicit submission.
- Run existing v2 unit/browser gates and draft-storage tests; mutate Unicode
  validation, absence guard and checkpoint order to prove regression coverage.

## Verification

- `node v2/tests/run.js --unit`: all 15 suites pass; 28 payment-request checks.
- `node v2/tests/draft-storage/storage.test.mjs`: all 7 scenarios pass, including
  actual IndexedDB recovery, stale-tab rejection and completed-record scrubbing.
- Mutations removing text validation, the existing-row refusal, or persist-before-
  in-memory-replacement each fail the regression suite; restored afterward.
- Syntax checks and `git diff --check` pass. Final integrated self-review covered
  new input, resumed payloads, review cancellation, sign-out, locks and retries.
- Read-only live catalog inspection confirmed the requester SELECT policy includes
  own rows in the active company, authenticated SELECT/INSERT grants, and the
  primary key on request ID. No production records were read or written.
- Added a browser test executing the actual page against synthetic fixtures:
  preview/cancel, same-reference recovery/reload/submission, attachment retention,
  inert HTML text, new-draft review reset and mobile dialog sizing. Local browser
  gate was attempted but could not launch: Chromium is absent and its download
  failed/timed out. Browser results are pending CI; no visual pass is claimed.
- The exact source of the user's reported 22P05 is not proven from their private
  draft. This fixes unsupported text present in the submitted fields; a 22P05
  arising entirely inside a database trigger would need separate investigation.

## Rollout

Frontend release only; no migration, Edge Function deployment or secret changes.
After release, reload `/v2/purchase_request2.html` on the same device/browser,
resume the rejected draft, select **Review text repair**, check the proposed
corrections, save, then explicitly **Retry this request**. Do not clear site data.
The correction removes NUL and replaces lone surrogates with the visible replacement
character; it does not infer missing letters. If the proposal does not match the
original document, cancel. A correction that leaves required data invalid refuses
rather than submitting incomplete information. Old generic-error drafts can first
retry to have local validation identify the unsupported text without an insert.
