# Bank workspace PR validation

Implementation based on main `184739fda43800eb60595cced25bb213137e9c78`.

All nine requested suites pass, plus `bank-workspace` and `finance-dialog`.
The suites execute actual page callbacks, Edge handlers and local PostgreSQL
migrations/RLS; external IO is synthetic. The CSV scenario parses two statement
rows, imports them into a CSV source, saves coding via the existing RPC and
builds a balanced $37.50 preview. It does not post a journal.

New coverage includes bank treatments stripping account/location suggestions
for clearing movements, deposit and unknown; bank inflow refunds; signed Item
history metadata; read-only history preview preserving the cursor; unconfirmed
or changed cutover refusing configuration; each rendered account state/action;
explicit suggestion acceptance; and finance-dialog cancellation/confirmation.

Mutation checks fail their assertions when account suggestions are allowed for
clearing treatments, cutover confirmation is bypassed, or stale detection is
removed. Existing posting and Plaid failure-path suites also pass.

Read-only production verification: 157 statements executed. All 156 pre-existing
checks pass with the production drift-check repairs in this PR. The only missing
check is the new history column: its migration is intentionally unapplied.
The migration applies twice and its check passes in disposable local PostgreSQL.
No production migration, deployment, journal, mapping, sync or coding write was
performed for this PR.

## Outstanding visual gate

Desktop/phone screenshots in both themes are **not captured**. The Cloud browser
rejected the local preview URL under its URL security policy. No visual QA or
real-browser CSV upload is claimed. Keep this PR draft until an allowed preview
URL is available and those checks are completed.

`node scripts/tests/bank-workspace-preview.mjs <scratch-dir>` produces an offline
synthetic fixture from the actual page and scripts, including light/dark pages,
390×844 phone iframe previews and a two-row CSV. It has no real credentials and
no external banking or accounting operations. The regular test suite verifies
the upload callbacks; the fixture is for the outstanding browser/visual pass.

## Review follow-up: production drift and build gate

The verifier repairs address real failing production checks introduced by #670
and #671: the replaced posting-claim index, renamed draft-write policy and five
service-owned tables without insert-stamp triggers. They are not cosmetic.
The stamp coverage check now names all seven exceptions, including
inventory_on_hand and sales_by_day, instead of an unexplained minus-two allowance.
The finance checks still verify the stronger active-claim and draft-only guards.

Shared Plaid types now declare the nullable history input and typed sync arrays.
A failed history preview can proceed only after explicit acknowledgement that
available history is unknown and the selected cutover is permanent. Tests cover
page/update/time limits and refused acknowledgement. An already leased account
refuses preview before contacting Plaid; a sync starting after that read may still
race with a preview, which writes neither transactions nor a cursor.
