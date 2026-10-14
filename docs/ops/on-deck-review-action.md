# On Deck review to action

## Preflight

Rechecked audit commit `69c9dfefe15dc8aa69ba2e4e6c21d48199a13eab` against
main `09d8fe7d655f94efc184caa9a070bff1f8fde86f`: the audited frontend,
worker and action-loop functions are unchanged. Existing freshness checks,
SEO structured-copy approval checks, context findings extraction, task reuse,
and confirmation dialog are retained. All six journey gaps remain.

Outcome: an active company reviewer opens one opportunity, reviews evidence
beside editable work, saves and reopens answers, sees outstanding blockers,
separately confirms creation and follows an exact result link. No paid work
on Save, publishing, purchasing, posting, or production data changes.

Call sites: on-deck.js load/detail/editor/decision/context callbacks;
briefing eligibility and counts; hourly on-deck-prepare.mjs; shared Edge
draft contract; on_deck_finish, on_deck_decide, on_deck_context and
on_deck_review_state. Exact links additionally reach SEO Tasks, Ad Studio,
Tasks and the existing Product Studio brief route. Coding stays separate.

Inputs: company-scoped proposals, exact displayed versions, source fingerprint
and validity window, settings/caps, reserved attempts and scheduler outcomes,
required `missing` versus explicitly optional `optional_context`, reviewed
answers, SEO fields, launch rows and review reasons. Legacy missing strings
remain required; no phrase may downgrade a safety/business requirement.
Requirements cannot be dismissed or reclassified in this flow. An answer can
be reopened; carrying optional research is explicit and preserves it in work.

Boundaries: active-company admin On Deck gate, destination purchasing/SEO
gates, private task exclusion and active task owners. Detaching changes only
the proposal link, never the inaccessible task. Approval rechecks completeness,
freshness and version under the proposal lock. Completed approval replay
returns the existing output. Edits/links serialize and stale retries fail.
Uncertain writes retain the dialog and reloadable records; controls prevent
double submits. Refresh retains the prior content but invalidates approval.
Disabled/capped/credit-paused preparation is distinct from a reserved run.

Live-only assumptions: no Supabase admin connection/tool is available here;
production pg_policy, function grants/definitions, scheduler enablement and
provider state cannot be inspected. Local migrations and denied role/company
paths will be tested, with production inspection and an authorized synthetic
company walkthrough required before rollout/user enablement. Git reads work;
GitHub API is currently network-blocked, so open-PR inspection is pending.
A new unique branch is used; no existing branch is overwritten.

Tests defined before implementation: actual SQL for incomplete SEO finish/edit,
answer reopen/edit/carry/required downgrade refusal, private/deleted link detach
and replace, wrong company/member/stale/version/expiry denial, exact reviewed
titles/copy and links, duplicate approval replay and rollback. Real-page browser
fixtures for the same UI journey, empty/paused/failed/running preparation,
manual SEO completion, launch row editing, visible review reasons, uncertain
save and repeated clicks; desktop/dark/mobile screenshots. Provider/worker
tests use mocked transport, never paid calls. Mutation tests remove each guard
and must fail. Existing On Deck, coding, posting and affected destination
regressions remain required. Live and mocked evidence will be reported apart.

## Rollout and rollback

Apply the forward migration, verify schema and live grants/policies, then
release static and scheduler changes. Keep new review controls gated on the
new review-state contract. No new secrets or automatic production migration.
Merge is not deployment or authorized enablement. Roll back the static/worker
release first; keep additive columns and stricter server approval checks and
saved answers. Never delete created work or reset historical drafts to roll
back. Any server rollback requires a separately reviewed forward migration
that retains freshness, company gates, answers and exact-output replay.

## Resulting flow

| Before | After |
| --- | --- |
| Prepare task, edit draft and context assignment overlapped | One Review draft panel contains evidence, copy, SEO fields, launch rows and saved answers; context assignment is secondary |
| Answers disappeared into appended body text | Structured answers remain visible and editable; reopened answers stay blocked until explicitly verified |
| Empty SEO copy could become ready after answering questions | Complete field validation runs on finish, edit and approval; existing incomplete ready rows become needs_info |
| Refresh could switch selection or imply a job was running | The same opportunity remains selected; queued, reserved-running, paused and failed states have recovery explanations and retained copy |
| Private/deleted context links demanded restored access | An admin can detach with a reason without reading/changing the task, then link public owned work |
| Detaching a link whose evidence a refresh had already invalidated showed "queued" with nothing due for up to 24 hours | Detach renews the company's screening request when the proposal is still invalidated (`failed`, empty `source_version`), so the next scheduler run re-screens it; ordinary detach with current evidence enqueues nothing |
| Original source titles and generic workspace receipts | Reviewed titles/content/answers become draft records with exact task, idea or brief links; launch rows can be added/removed within the existing 1–5 limit |
| Completed mixed created work with skipped opportunities | Existing Outcomes shows separate Created and Dismissed/skipped sections, without a new tab |

The review panel keeps Close and Save visible while scrolling. Save runs no
provider and creates no destination record. Creation still requires its own
confirmation of the exact saved version. Interrupted saves retain the edits
and offer Reload saved version. Optional research is included at creation;
required facts cannot be downgraded, carried or dismissed here. Legacy missing
lists remain required rather than being inferred optional from their wording.

## Local verification and limits

- `node v2/tests/run.js --unit`: 34 suites passed.
- Full `v2/tests/run.js --browser`: 44 suites passed; attribution initially
  lacked its browser executable and was terminated. Its separate rerun passed
  with the suite's supported `SILO_CHROMIUM=/usr/bin/chromium` override. All 45
  browser suites executed successfully across these runs. The final affected
  On Deck/SEO/Ad Studio suites were also rerun after the review changes.
- `SILO_TEST_LOOPBACK_TRANSPORT=1 PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium`
  enables the existing harness's opt-in loopback transport in this cloud
  environment. Without it, the environment proxy rejects the synthetic
  `silo.test` host. Page bytes and the neutral page origin are retained; external
  services are still stubbed. CI's default transport is unchanged.
- `node scripts/tests/on-deck-review-action.test.mjs`: 8 real SQL scenario
  groups, applying the forward migration twice. Covers full SEO readiness,
  answer reopen/edit, required-fact downgrade/refusal, private/deleted link
  detachment and replacement, credits/caps/queued/reserved states, reviewed
  titles/copy, destination permissions, version/expiry and approval replay,
  and the Refresh -> screening run -> Detach sequence that must leave the
  proposal due for re-screening.
- `PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium node
  v2/tests/browser/on-deck-review-action.test.js`: real-page walkthrough of
  manual completion, reopen/edit/save, repeated submit, refresh recovery,
  private-link recovery, interrupted Save/reload, launch rows, exact destination
  records and separate outcomes. Desktop/light/dark and 390px screenshots
  inspected under `.screenshots/on-deck-review-*.png`.
- Matching core, worker, source-date, Edge, database, action-loop, action-contract,
  coding, posting and Plaid suites passed. Worker tests cover exact-version
  pause/failure metadata without storing raw provider errors. Workflow YAML
  parses and `git diff --check` passes.
- Five SQL guard mutations and six frontend mutations were caught. They are
  served/applied only inside isolated fixtures; tracked source is not changed.

Browser transport and provider/scheduler responses are mocked; no production
or paid provider request was made. SQL uses real PostgreSQL through PGlite,
with real On Deck migrations/RPCs and simplified upstream source/destination
fixtures and permission helpers. This proves local function enforcement and
replay, not live policy state, scheduler operation, provider quality, or
cross-connection races. Independent PR review remains outstanding.

Main advanced to `0041390e225e394889a319a373fde5b0dc910f2a` during verification
with an unrelated report-location fix. On Deck remains unchanged upstream;
those updates and their migration includes must be preserved in this branch.
All listed historical On Deck feature/fix branches are already integrated;
the remaining menu-visibility branch does not touch this flow.

## Authorized rollout acceptance (not performed)

Owner: Blake or an authorized release reviewer. Before user enablement, inspect
live On Deck function definitions, pg_policy and API-role grants; apply
`20261014120000_on_deck_review_action.sql` and require `verify_v2_schema.sql`
all-ok. Refresh the schema catalog after the additive column change. Then
release the static files and scheduler worker. No Edge function changed and no
new credential is required. The post-merge drift check will report the missing
migration until it is separately applied.

Using an isolated synthetic company in the authorized deployed environment,
repeat answer/save/reopen/edit/manual SEO completion, disabled/empty-credit
refresh, private/deleted link replacement, wrong-company rejection, concurrent
confirmation/replay, and exact output opening. Verify creation leaves SEO
approval_status=draft, ads status=idea and product briefs=draft; no publication,
message, purchase, or financial execution may occur. This gate blocks deployed
user enablement, not local implementation. Do not label release verified from
mocked walkthroughs or a green CI run.
