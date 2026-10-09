# On Deck action loop preflight

The September preview can persist a draft but treats every model unknown as a
hard blocker. The October briefing only opens that blocker. This change adds
owned context work without approving the underlying recommendation.

Call sites: hourly `scripts/on-deck-prepare.mjs` stages explicit-company facts;
the service-only Edge handler calls `promptFor`, `validateDraft`, reserve and
finish. Browser `on-deck.js` reads proposals and invokes versioned decisions.
The existing decide RPC alone creates destination records. Coding is separate.

Inputs: immutable screened source, bounded existing public SEO/launch work and
page inspection, saved human context, prior draft and revision request. Missing
facts necessary for a safe draft remain blockers; optional measurement/targeting
enrichment is explicitly labelled and is never invented or treated as known.
Legacy missing lists are not silently cleared. SEO copy gets dedicated fields.

Live preflight read: proposal/task policies, decide/source/stage functions,
SEO gate, task assignee/launch nullability and task/SEO triggers. Proposal access
requires active company admin membership. Context tasks must be public, in the
same company and owned by an active member. No permissions are broadened.

Context create/link and resolution lock the proposal, record events and increment
its version in one transaction. A repeated create returns its existing task;
resolution retries return the recorded result. Errors roll back. Resolution
queues fresh screening and retains findings; it never clears missing or approves.
Provider interruption retains existing reservation/history rules. Refresh
preserves context, while re-screening can retire an unqualified opportunity.
No deletion, publishing, purchasing, provider run or production mutation here.

Tests before implementation: real local SQL migration and RPC fixtures for
context create/link/resolve/replay, tenant/member denial, stale versions,
structured SEO transfer, existing launch-task reuse and rollback; actual page
with mocked transport for ownership, findings, fresh review and stale UI;
worker/provider fixtures for evidence and prompt propagation, optional vs required
inputs and truthful preparation counts. Mutations must fail the new assertions.

Live-only rollout checks: apply/verify migration, deploy Edge, then authorized
company acceptance of task visibility and real draft quality. Local tests do not
prove live provider quality, scheduler firing, or production UI acceptance.

Implementation verification: local SQL tests execute the actual migration twice
and cover ten context/handoff scenarios, including rollback/replay, inaccessible
tasks, structured copy, freshness, launch re-screening, closed work and long notes.
Five real-page browser fixtures exercise the context-to-review flow and stale
controls, with mocked transport. Provider/worker contracts use mocked responses;
no provider job or paid request was run. Existing unit/browser, On Deck, coding,
posting and Plaid suites passed. Three action-loop mutation cases were caught.

Independent review found and corrected launch self-suppression, member findings
access, blocked SEO validation, enrichment freshness, silent note truncation and
completed-task reuse. Reused open launch tasks retain notes/owner/status and get
approved copy appended exactly once. Long notes require opening the full task.

Deployment order: apply the migration and run schema verification; deploy the
on-deck-prepare Edge function; release the worker/static changes. No new secrets.
Production acceptance must use an authorized company reviewer and member owner:
blocked proposal -> owned task -> member notes -> reviewed findings -> scheduled
fresh draft -> human approval -> destination task with the approved copy. Also
verify wrong-company/private task rejection, stale refresh, replay, and existing
open task reuse. A shipped card alone does not establish this acceptance.

## Recovery against PR 940

Reconciled with main `8574145`, retaining the explicit research-carryover dialog
and separate draft-creation confirmation. Legacy SEO drafts still require reviewed
structured copy or fresh preparation; summary text is never substituted for SEO copy.
Expiry is checked at submission and by the database edit/revise transaction.
Pending dialog saves block Close/Escape and capture the submitted proposal/action.
Linked ordinary context tasks are excluded from campaign-existence screening while
their proposal is active, so reviewed findings return to preparation.

Recovery verification adds expired-edit rollback and linked-task
resolve/facts/curate/stage tests (12 database scenarios), and open-dialog expiry
and pending-save controls (15 briefing browser checks). Deliberately removing the
expiry guard, linked-task exclusion, or dialog button lock makes these tests fail.
The backend and integrated frontend received separate independent local review;
automation review markers and exact-head CI are reported separately in the PR.

## Cycle 1 corrections

Context creation/linking stores a hash of the initial task notes. Unchanged request
instructions cannot become resolved findings, and the dialog leaves them out of
the findings field. New assignments require current unexpired evidence; retries
of an existing assignment create nothing and resolution may still queue refresh.
Unlinked campaign work can make a stale launch ineligible after refresh; it must
not be kept alive by assigning obsolete context. Linked context work is excluded
from campaign screening through its durable proposal link.

Evidence samples are ordered by update time, disclose omitted collections, and
withhold long notes rather than presenting an excerpt as complete. The prompt
treats withheld evidence as unknown. Duplicate normalized launch task titles are
rejected by provider and database validation before destination writes.
Regression cases cover each finding; removing each SQL guard causes a failure.
