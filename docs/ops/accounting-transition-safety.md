# Accounting transition safety: first lifecycle slice

## Outcome and acceptance criteria (preflight)

A finance user in Books & setup can change bookkeeping mode without racing a
QuickBooks journal send from any posting surface. A pending or uncertain send
must prevent reporting-only handover. Two updated tabs must not overwrite one
another's reviewed mode/date choice. QuickBooks remains the statement authority.
Existing clients and ledger resync retain their current behavior.

Acceptance: serialized claim-first and mode-first transactions; all-source
submitting/unknown claims block handover; terminal receipts remain writable;
explicit active-company and expected-version checks on the new RPC; server
validation of takeover dates; no-op saves do not create a revision; legacy
callers remain compatible; existing ledger/approval/posting tests still pass.

## Read-only preflight, 2026-11-11

Baseline: main `895e17cd9a31287a1c95e3de7ae509ce9052ae78`. No open PRs returned
by the connected repository search; isolated clean checkout used.

Call graph:
- `v2/accounting-books.html` mounts `SiloBooksMode` from `v2/accounting-mode.js`.
- That module alone calls `set_bookkeeping_mode` in application source, then
  `silo_ledger_resync_posting_start` once per source in bounded pages.
- Every new journal send in `quickbooks-post-journal/index.ts` inserts a
  `submitting` claim before the Intuit write. Bank imports, revenue and all
  journal-adjustment kinds share this path. Recovery updates existing claims
  to `posted`, `unknown` or `failed`; confirmed-absent retry inserts a NEW claim.
- `bookkeeping_mode_claim` is a BEFORE INSERT trigger. It reads mode without
  the advisory lock. `card_posting_start_guard` already takes that lock.
- `set_bookkeeping_mode` takes that lock only for qbo handover, checks approved
  card batches only, and saves two settings. Other live claims can slip past.

Read live function definitions, pg_policies, pg_constraint, pg_trigger and
role privileges on Silo before editing. Live mode/claim functions match main.
Accounting settings has authenticated finance-only active-company SELECT, no
client write policy and only SELECT granted to authenticated. Posting claims
have active-company SELECT only; the trusted posting function writes with the
service role. Narrow finance RPC gates remain unchanged. `books_authority` is
CHECKed to `qbo`. No new client write policies or broader role grants are needed.

## Design boundaries and risks

Use the existing company advisory lock, before the settings row lock. Claim
creation takes existing Plaid account/batch locks first, then the company lock
before reading mode. The `zz_bookkeeping_mode_claim` trigger sorts after those
guards, matching approval’s batch-before-company order. A losing claimant sees committed qbo
and refuses before network mutation. A losing handover sees the committed
submitting/unknown claim and refuses, preserving recovery. Receipt updates
must not be blocked: a started network call cannot be cancelled by a setting.
The handover reads claims/batches without row locks, avoiding inverted locks
with claim finalization and approval. Independent review caught the initial
company-before-batch inversion; an explicit native race covers the correction. Settings writes serialize on the company
lock and row lock. READ COMMITTED is the supported RPC isolation level.

Add a mode/date revision and checked RPC for updated clients. Preserve the old
RPC signature as a serialized compatibility wrapper; cached clients cannot
supply their reviewed version and therefore retain their prior last-writer
semantics. The new UI must never fall back to the legacy RPC on an error.

No financial calculation, posting payload, source-date precedence, approval,
opening balance, QBO realm selection or provider write changes. No cleanup or
historical data rewrite. The migration adds a column and functions/trigger only.
No migration, deployment, merge or financial write is authorized by this task.

## Explicit next slices, not delivered here

Durable mode/date convergence jobs, job fencing, strict activation for new
companies, versioned per-source date editing, multi-realm identity proof,
server-owned rules, reference/opening orchestration, reconciliation and close
remain separate work. The existing browser-owned ledger catch-up can still be
interrupted and resumed with Save. This slice does not claim unattended setup,
close readiness or a universal accounting configuration revision.

## Verification plan and release gates

Before implementation: define PGlite integration tests with real finance,
ledger and mode migrations; native PostgreSQL two-session claim/mode races in
both orders and competing-version writes; mutation tests that remove each
protection; mounted UI tests of RPC parameters, stale/error exits and retry;
existing finance, ledger, posting, company and UI suites.

Read-only production preflight is evidence about current schema, not a live
test of the new code. Local fixtures simplify auth helpers and do not prove
production membership policy parity. Before deployment Blake must authorize
and apply the migration, run full schema verification, and verify finance vs
non-finance roles plus two browser tabs in an authorized test company. No real
QBO journal is needed or authorized for that exercise.

## Verification results for this draft

- Passed 9 local PGlite integration groups against the actual finance migrations,
  including tenant/narrow-role boundaries, legacy compatibility, date and CAS
  validation, real approved card INSERT claims, every pending claim source,
  approved batch protection and unchanged QBO authority.
- Passed 8 real PostgreSQL 18.6 multi-session races: both claim/handover orders,
  terminal retry UPDATE, competing reviewed versions, and CSV/Plaid reapproval
  with matching and stale approval snapshots.
- All nine mutation hooks were killed. Restoring the early trigger order
  independently reproduces PostgreSQL `40P01` in each of the four card/Plaid
  races. Stale-version bypass also fails the native competing-editor race.
- Passed 10 accounting-mode tests, including mounted confirmation/RPC/resync,
  stale refusal, same-setting retry, pre-migration compatibility, duplicate
  clicks and a version change during catch-up. These use synthetic UI controls,
  not a real browser.
- Passed all 42 v2 unit suites; existing accounting foundation, QBO history,
  daily ledger, posted-adjustment mirror, cutover, bookkeeping-mode, Plaid,
  posting-handler, coding evidence/background/suggestion and accounting UI
  suites. Workflow YAML parses; JavaScript syntax and diff whitespace pass.
- Real Chromium suites `accounting-migration-flow` and
  `accounting-trust-surfaces` were attempted but could not launch: the environment
  refuses Chromium's local Unix socket (`Operation not permitted`), including
  the permitted escalation route. This is an UNVERIFIED browser gate, not a pass.

Independent source review identified the initial lock-order regression; after
correction, its second, correction-only pass found no remaining blocker in the
reviewed current call paths. It did not independently rerun tests. GitHub CI and
Claude's further review are separate evidence and must cover the eventual head.

## Review handoff and rollout

This is Phase 1a, not the full architecture plan. For the next review:
1. Trace the actual claim trigger order (Plaid account, batch, company) against
   approval/reopen and every posting surface. Keep unknown-outcome recovery.
2. Run the native races with `SILO_PG_REQUIRED=1`; never count a skipped race as
   green. Verify against CI's PostgreSQL 16 too, not only local PostgreSQL 18.6.
3. Verify updated/cached tabs before and after migration, both roles and company
   switching. A cached tab remains last-writer-wins by design. Do not claim
   universal optimistic concurrency until the legacy path can be retired.
4. Run the blocked real-browser suites and an authorized synthetic-company
   interactive proof. No real provider write is needed.
5. Before broader automation, implement durable convergence and persistent
   status, per-source versioning and explicit new-tenant activation from the
   architecture plan. The existing resync still needs the browser or Save retry.

**Intentional behavior changes:** handover now refuses any sending/uncertain
posting attempt, not only approved card imports. Stale updated tabs must reload.
Invalid company takeover dates are rejected server-side. No default company
mode, existing ledger entry, approved snapshot, or posted QBO entry is rewritten.

**Release state:** draft only; not merged, migration not applied, no Edge Function
deployed, not runtime-verified or user-enabled. No new secret or runtime flag.
Static assets can precede the migration: a row without `bookkeeping_version`
uses the old RPC. After the column exists, checked failures never downgrade.
Apply the migration atomically only with Blake's approval, run schema checks,
and verify the intended state before considering user enablement.

**Rollback:** roll back the frontend independently if necessary; the legacy RPC
remains available. Do not restore the old early trigger while keeping the new
locking guard. A full server rollback must restore BOTH the prior guard body
and trigger definition together under explicit approval. Leave the additive
version column in place; dropping it is unnecessary and loses edit history.
