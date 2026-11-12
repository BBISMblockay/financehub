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

## Second pass, 2026-11-11: Blake's five answers

Claude's review of this draft raised five findings; Blake answered each, and
this section is what changed. Nothing here relaxes a protection the first pass
added.

1. **Only a genuinely stuck post blocks the handover, and the reader can see
   it.** The first draft counted every `submitting`/`unknown` claim from every
   source with no time or scope bound, while the only surface that shows and
   resolves an unknown claim is a card import (`v2/on-deck-coding.js`). One
   stale attempt on a revenue journal, schedule, fixed asset or adjustment
   could therefore block reporting-only for good, with an error naming a count
   the reader could not see. `silo_claim_period_owner` now answers *which
   source owned the period* for each claim, from the account's own
   `posting_start_on`, its `authoritative_from` and the company takeover date,
   and `silo_claim_blocks_handover` reads it: a period that ends before SILO
   started posting that account is setup history, not an unresolved post. The
   approval trigger already refuses any new send for those months, so no send
   can be open and nothing is in doubt about SILO's own ledger. Such a claim is
   still listed, still names who owned the period, and is never released,
   rewritten or treated as resolved. During a build the trial balance, the
   Plaid history and the handover dates overlap without anything being broken,
   so a period that cannot be placed at all (no period on the row, no settings
   row) is NOT read as setup history: not knowing who owned a period is not
   evidence that SILO did not. `silo_open_posting_claims()` is the list the
   card shows on a P0BM3 refusal — owner, the date that settles it, the
   account, whether it blocks, and where each one is resolved — finance-gated
   to the same two narrow gates as the mode RPC, and read-only.
2. **Resuming the ledger catch-up stays connected to the setting.** Pressing
   Save with nothing changed is the documented way to resume a catch-up that
   could not finish in one pass. The first draft sent a checked write on that
   press, so a version another tab had moved on refused it (P0BM4) and the
   reader could not finish reversing or reconciling the ledger. The card now
   writes nothing when nothing changed, and the RPC answers an identical write
   from the committed row before the version and date checks — neither can make
   an identical write wrong. Every write that DOES change something is still
   compare-and-set.
3. **The takeover window is the company's own.** `accounting_settings`
   `takeover_earliest_on` / `takeover_latest_on` are configurable per company
   and fall back to the books start and `silo_business_today()`.
   `silo_takeover_window()` is the one definition; the date picker reads the
   same two columns, so it cannot offer a date the save will refuse. A stored
   value outside a window tightened later no longer locks the card, because an
   identical write is answered first.
4. **No slippage into posting, from any arm.** Finance approval remains the
   authority: a claim that still matches its approval is not slowed down by any
   of this, and marketing or retail reach posting through neither path — the
   claim table has no client write policy and `quickbooks-post-journal` gates
   on `can_manage_journal_entries()`. What was uneven is that the mode guard
   covered re-entry into `submitting` while `plaid_new_posting_claim`,
   `qbo_card_claim_matches_approval` and `qbo_card_posting_start_claim` fired
   on INSERT only, so a future path that moved a row back into `submitting`
   would have passed the mode guard while skipping the approval-hash match, the
   per-account posting start date and the open bank feed exception. All four now
   cover `insert or update of status`. Their bodies are unchanged, so the lock
   order they take (Plaid account, then the batch, then the company) is
   unchanged, and `verify_v2_schema.sql` asserts all four arms.
5. **The status message says what is true.** The closing line reports the
   setting read back from the database after the catch-up, not the one the
   press chose, so a change committed by another tab mid-loop is named as what
   is now in force rather than reported as "could not be confirmed". A refusal
   that reloading cannot clear no longer tells the reader to reload.

## Third pass, 2026-11-12: Blake's review of the second pass

Blake reviewed the second pass and found four things. The first is a safety
bug I introduced in the second pass; the rest are the experience.

1. **An in-progress QuickBooks post is judged on its status alone, never on a
   date.** The second pass decided "setup history" from `period_end` against a
   floor built out of `posting_start_on`, `authoritative_from` and
   `silo_takeover_on` -- all of which can be CHANGED later. Moving the takeover
   date forward past an open claim's period would therefore have stopped a live
   or unresolved send from blocking the handover. That was wrong in principle
   as well: every `submitting`/`unknown` row IS an attempted send, because
   `quickbooks-post-journal` inserts the claim with `attempt_count = 1` and
   `last_attempt_at` stamped immediately before the Intuit write, so the entry
   may be in QuickBooks whatever month it covers.
   `silo_claim_blocks_handover` is now status-only, and `verify_v2_schema.sql`
   fails if any date column or the owner function reappears in its body.
2. **The setup-history distinction moved to where it belongs: approved
   imports.** This is where the Plaid backfill and the trial-balance era really
   do overlap the handover dates. An approved import whose activity all
   predates SILO posting that account can never be sent --
   `card_posting_start_refusal` refuses it and the resync reverses its ledger
   entries -- so counting it told the reader to "post it or reopen it" when
   neither is possible, stranding the company in SILO mode for good.
   `silo_batch_blocks_handover` judges those on the dates, because the same
   dates are what makes them unsendable, and it reads the batch's CONTENTS
   (`card_coding_effective_lines`) exactly as the approval trigger does, so a
   cut-over inside a period leaves the lines on SILO's side still blocking.
   They are listed, and left exactly as they are.
3. **An old stored date cannot block resuming the catch-up.** The second pass
   fixed the RPC but left the card's own `validate()` ahead of the press, and
   the date input is prefilled with what is stored -- which can sit outside a
   window tightened since. The date is now judged only when the reader is
   CHOOSING one; a press that changes nothing goes straight to the resync.
4. **A status that could not be read back is not shown as current.** If the
   read-back after the catch-up fails, the card says so and puts "Setting not
   confirmed" in the headline instead of leaving the last value it
   knew standing as fact.
5. **Recovery is an action.** `silo_handover_blockers()` returns both kinds of
   thing in the way with a `review_path`, and the card renders one panel --
   headed "In the way" -- with a short reason and a "Review" link per row
   (`/v2/transactions.html?batch=<id>` for an import or bank-coding post,
   `/v2/accounting-books.html#register` for any other entry). No uuid is shown.

## Verification results for this draft

Third pass (2026-11-12, PostgreSQL 16.15):

- PASS 14 PGlite groups. The two that matter most here: an unresolved post
  still blocks with the takeover date set to null, to a date inside its period
  and to a date after it, and is never released; and an import approved during
  setup stops blocking once the account's `posting_start_on` moves past it,
  with the import left `approved` and untouched.
- PASS all 10 database mutation hooks, including the two written for this
  pass: `claim-judged-by-date` puts a date test back into the in-progress
  question, and `setup-imports-block` makes setup imports count again.
- PASS 9 real multi-session races and all 5 race mutations, unchanged from the
  second pass.
- PASS 14 accounting-mode page tests, including the three new ones: a refused
  handover renders a link rather than an id, an old stored date still resumes
  the catch-up (while a NEW out-of-window date is still refused), and a failed
  read-back is not reported as the current setting.
- PASS the real Chromium suites again (`accounting-migration-flow`,
  `accounting-trust-surfaces`, `accounting-dialogs`, `accounting-ledger`,
  `on-deck-coding`), all 42 v2 unit suites and the neighbouring finance
  database suites.
- Rendered the refused-handover panel in Chromium at 1180px and at 390px: two
  rows, two working links, no page errors, no horizontal overflow. Screenshots
  in the project files (`books-handover-blockers-2026-11-12-*.png`). Colours
  are not judged from those: the isolated harness does not load the shell, so
  the Beacon tokens and the webfont are absent.

Second pass (2026-11-11, PostgreSQL 16.15 — CI's major version):

- Passed 14 PGlite groups against the actual finance migrations, including the
  three added here: setup history is listed and does not block, an unplaceable
  period still counts, the configurable window is enforced and its floor agrees
  with the live `silo_posting_start_for_source` in `silo` mode, and a claim
  moved back into `submitting` after a reapproval is refused by the approval
  match (P0OD1).
- All 10 database mutation hooks killed, each in the test that names the
  protection: `window-not-configurable`, `blocking-claims-widened`,
  `unplaceable-read-as-setup` and `sibling-guards-insert-only` are new.
- Passed 9 real PostgreSQL **16.15** multi-session races, which closes the
  earlier version gap: the eight from the first pass plus a card claim
  RE-ENTERING `submitting` against a held reapproval, which is the new risk from
  widening the three sibling guards to UPDATE. It waits on the batch and is
  refused; it does not deadlock. All five race mutations killed, and
  `trigger-order-first` still reproduces `40P01` in race 5.
- Passed 12 accounting-mode page tests, including the refused-handover list and
  the configurable window.
- **Passed the two real Chromium suites the first pass could not launch:**
  `accounting-migration-flow` 28/28 and `accounting-trust-surfaces` 9/9, plus
  `accounting-dialogs`, `accounting-ledger`, the five On Deck suites and
  `transactions-filters`. All 42 v2 unit suites, and the existing
  bookkeeping-mode, card posting start, On Deck coding, accounting
  display/foundation/ledger, silo-ledger, Plaid bank feed and finance posting
  handler suites. Workflow YAML parses; `git diff --check` clean.
- Still not proven: runtime role parity in an authorized test company, and the
  migration itself remains unapplied.

First pass:

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
  `accounting-trust-surfaces` could not launch in the first pass's environment.
  Both pass in the second pass, above.

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

**Intentional behavior changes:** handover now refuses any sending or uncertain
posting attempt that belongs to a period SILO owns, not only approved card
imports — setup history from before an account's posting start is listed but
does not block. A stale updated tab must reload before it can CHANGE the
setting; it can still resume a ledger catch-up. Takeover dates outside the
company's configurable window are rejected server-side. No default company
mode, existing ledger entry, approved snapshot, or posted QBO entry is rewritten.

**Release state:** draft only; not merged, migration not applied, no Edge Function
deployed, not runtime-verified or user-enabled. No new secret or runtime flag.
Static assets can precede the migration: a row without `bookkeeping_version`
uses the old RPC. After the column exists, checked failures never downgrade.
Apply the migration atomically only with Blake's approval, run schema checks,
and verify the intended state before considering user enablement.

**Rollback:** roll back the frontend independently if necessary; the legacy RPC
remains available. Do not restore the old early trigger while keeping the new
locking guard — and note the trap: re-running `20261015190000_bookkeeping_mode.sql`
on its own recreates `bookkeeping_mode_claim`, which this migration drops, so the
new verify check reads BROKEN until `20261111201400` is applied again. Running
`apply_all_post_merge.sql` in order is safe. A rollback must also restore the
three sibling claim triggers to INSERT-only together with the guard, or verify
reads BROKEN on the four-arm assertion. A full server rollback must restore BOTH the prior guard body
and trigger definition together under explicit approval. Leave the additive
version column in place; dropping it is unnecessary and loses edit history.

## Copy pass (2026-11-12)

Every string this change adds to the Accounting card was cut to a short label
or one short sentence. No instructional paragraphs: the refusal names what is
in the way and each row carries a `Review` link, instead of telling the reader
what to do about it. The blocker reasons live in
`silo_handover_blockers()` (`Posting to QuickBooks`, `Check in QuickBooks`,
`Approved during setup. Not in the way.`, `Approved in SILO, not sent.`), so
the card renders them and adds nothing.
