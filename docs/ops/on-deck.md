# On Deck — direct-link preview

Requested by Blake: `/v2/on-deck.html`, **no navigation entry**. Match the approved
Beacon mockups. Curate a few worthwhile proposals, not a catalog-sized inbox.

## Preflight / design (before implementation)

Inspected production columns, constraints, policies and EXECUTE grants for
product_workflow_briefs, launch_calendar/tasks, seo_tasks/projects, ad_ideas,
products_master, shopify_product_skus, Search Console and Meta data. Existing
product handoffs require purchasing authority, reviewed versions and canonical
catalog identity. Launch writes are company-scoped; SEO has its own approval
gate. New preview is restricted to active company owner/admin members, with
existing domain gates rechecked at each handoff. No finance records are copied
into this shared queue. No existing permission helper or action is broadened.

Call path: opt-in GitHub worker → explicit-company source queries → deterministic
product/page/objective screening → bounded Supabase Edge draft → stored proposal →
versioned user decision → transactional draft/task handoff → stored receipt.
The worker cannot invoke the authenticated approval endpoint. It cannot send,
publish, approve purchasing, post journals, or alter ad budgets.

Tests defined before implementation: cross-company and disabled-user denial;
anonymous/client service-RPC denial; budget reservation concurrency/replay and
unknown provider outcomes; stale editor/source rejection; approved output
idempotency and rollback; product-vs-size selection, cross-store SKU overlap,
missing costs/seasonality/lead time, insufficient evidence, top-three and overall
queue limits; SEO page dedupe; objective-specific ad scoring; dismiss cooldown;
revision failure preservation; XSS/mobile/empty/missing-migration UI; no nav edit.

Partial failure: a provider attempt is reserved before calling Claude. Unknown
outcomes consume the reservation, not zero dollars. Draft creation and action
receipts share a DB transaction. A replay returns the existing output. Failed
revisions retain previous content but block approval until another review.

Live-only verification after merge/apply: source-query latency at catalog scale,
real Claude quality/token use, scheduler firing, actual company roles, source
freshness and an authorized test-company handoff. No migration, deployment,
provider call or production mutation is authorized by this PR request.

## Workspace controls and review page

Preparation controls are in **Workspace Settings → Company → On Deck**
(`/v2/settings-company.html#on-deck-settings`). Only workspace owners edit the
cap, restock review budget, enabled workflows and preparation toggle. Preview
admins can read usage but cannot change it. The settings card fails closed if
the migration or usage query is unavailable. Existing company settings remain usable.

On Deck opens on the prepared draft: compact workflow cards, a paper preview,
collapsed task details/rationale, and explicit approval actions. Evidence,
revision comparison and history remain available. The page has no spend or
labor KPI band. Settings retains monthly attempt costs, failures/holds and
human-recorded outcomes for cost review; this does not implement customer
billing or infer labor savings. Approval and product-vetting gates are unchanged.

## Pilot behavior

- Six active slots, at most three per workflow. Rank within workflows, then take
  their strongest candidates in turns; scores from different units never compete.
- Restock uses exact store mappings and whole-product sales/stock, with conservative
  cost and buying-budget gates. Ambiguous/partial cross-store mappings, multiple
  stock-owning stores, missing costs/lead times/seasonal policy, young demand and
  uncertain or partially received POs are held. This deliberately favors precision
  over catalog coverage. An approval records a human product vetting note and creates
  a full-spread **draft** brief with null size quantities. No PO is created.
- SEO dedupes repeated connected-property page/day observations before sums. It
  requires 14 observed days, 500 impressions, position 4–20, low observed CTR, fresh
  Search Console data and an inspected title/H1. No predicted lift.
- Ads reuse Ad Studio's pooled, objective-specific evidence rules. Only supported
  objectives, at least moderate evidence, a valid creative/destination and an index
  above 1.15 qualify. One outstanding source/ad, no direct spend recommendations.
- Launches need a usable brief and public product-readiness rows. Existing campaign
  tasks suppress duplicates. Private tasks are never copied to the shared proposal.
- Product freshness, source epochs and the exact displayed proposal version are
  checked before approval. Missing evidence blocks approval until a human resolves
  it with a recorded explanation. Every destination retains its own final workflow.

## Cost contract and operations

The worker uses `claude-sonnet-5`, $2/M input and $10/M output, no tools/thinking/cache,
a 60,000 UTF-8-byte prompt ceiling and 4,000 output tokens. Each attempt reserves
$0.25 before the provider call (above the bounded token cost); known usage replaces
the reservation, unknown usage retains it. Limits are $0–$100/company/UTC month,
20 attempts in a rolling 24 hours, and one outstanding attempt per proposal.
The provider/model/pricing contract must be revalidated before activation; changing
models or pricing requires updating the reservation and its tests together. Cost
figures cover these model calls, not existing sync infrastructure or taxes.

Hourly GitHub runs are best effort. Screening is daily or explicitly requested;
revisions are handled on the next run. A missed job is recoverable from DB state.
Calls are not automatically retried after provider failure. Interrupted reservations
older than 30 minutes settle as unknown; refresh/revision requires a new reservation.
If settlement itself fails, the original hold remains for reconciliation.

Monitor `on_deck_settings.last_status`, `diagnostics`, attempt state/error codes,
held/unknown costs and source-query latency. A preexisting draft is retained on a
failed revision. Pending revisions can be cancelled to keep the previous draft;
an already-started provider call remains charged, and its late result cannot
overwrite the restored version. A source outside the new shortlist can be archived automatically
only if no human has edited it. Human-edited decisions require explicit refresh.
Completed and dismissed sources cool down for 30 days; model-rejected ones for 14.
Metrics distinguish human edits, dismissals, confirmed handoffs, actual attempt costs
and user-recorded minutes/outcomes. A receipt is not a published result or proof of ROI.

Rollback: disable the repository variable and per-company preparation settings.
The page and prior receipts stay readable. Do not drop tables containing decisions
or costs. Disabling preparation does not revoke authority to review existing drafts.
No navigation entry was added. Company owner/admin preview access is intentional.

## Verification

- `node scripts/tests/on-deck-core.test.mjs`: deterministic screening and provider failures.
- `node scripts/tests/on-deck-database.test.mjs`: local PGlite migration/RLS, real Product
  Workflow draft handoff, other destination rows, retry, rollback, budget and source gates.
- `node v2/tests/browser/on-deck.test.js`: real page with a mocked external DB/provider.
- `node v2/tests/run.js --unit`: existing v2 regression suites.
- Mutations: `MUTATE=budget|version|source|company-read|idempotency|active-user`
  (choose one value per run) must make the database suite fail.

Local tests do not establish live model quality, scheduling, source-query performance
or production destination trigger behavior. Those require the separately authorized
activation check above. The page does not pretend to expose a public publishing API.

## Local verification record

Selection/provider checks, local database integration, schema-verifier checks,
six guard-removal mutations, 23 existing v2 unit suites, the targeted browser
suite, 38 Plaid database checks and 19 catalog-cleanup checks passed. Desktop and
390px mobile screenshots were inspected; the mobile test asserts the detail
panel's actual bounds rather than relying on document overflow hidden by the shell.

The full v2 browser command was attempted. The shared `silo.test` harness failed
with `net::ERR_EMPTY_RESPONSE` in this sandbox (22 suites failed, including the
then-in-progress On Deck fixture test). The final On Deck suite uses the harness's
loopback secure-context option and passes on local Chromium. Shared browser
regressions remain a CI/live-environment check; no shared harness code was changed.
No production migration, provider call, scheduler activation or live handoff ran.

## September 29 follow-up

Addressed the first independent review: the worker aliases `shopify_status`
as `status` against the installed mapping schema, explicitly disables thinking
for the pinned model, and both On Deck workflows install the committed root
lockfile with `npm ci --ignore-scripts`. The worker integration test executes the
actual selected fields against the table DDL from its original migration. It
fails if the old nonexistent column is restored. Provider tests assert the
outbound thinking setting and fail if it is removed.

Follow-up checks: 14 core/provider checks, worker schema integration, 11 browser
checks (including Workspace Settings save/owner permissions), all 23 v2 unit
suites, YAML parsing and diff whitespace. Desktop/mobile preview captures were
inspected. No new SQL or production change in this follow-up.

## Shared Anthropic secret / Edge drafting

`on-deck-prepare` is a new Supabase Edge Function. GitHub still screens and stages
candidates, then invokes it once per stored proposal with its ID, version and a
request UUID. The Edge handler reads the stored proposal, reserves the existing
budget, calls Anthropic, validates the result and settles usage. It reads the
same project-level `ANTHROPIC_API_KEY` already used by Ask SILO. GitHub needs
only its existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets; remove
any requirement to duplicate the Anthropic key there.

Keep JWT verification enabled when deploying `on-deck-prepare`. The handler also
requires the exact service-role credential; normal user/anonymous JWTs cannot
trigger it. No caller-supplied company, prompt, model, source or cost is accepted.
All draft modules are inside the function directory so the existing deployment
workflow bundles them. There are no new SQL migrations or secret values.

After merge, deploy `on-deck-prepare` via **Deploy Edge Function** (or the MCP with
`verify_jwt=true`) before running **On Deck preparation** on main. Keep the
existing repository variable and company controls. A 90-second provider timeout
bounds each invocation; the worker processes proposals sequentially. Interrupted
calls retain the existing conservative reservation and are not blindly retried.
A failed Edge invocation fails the company job, retaining prior drafts/holds.

Checks: `node scripts/tests/on-deck-edge.test.mjs` executes the deployed handler
and worker caller together; it covers authorization, request validation, stored
versions, cap refusal, replay, settlement and transport uncertainty. Existing
core/provider, worker-schema and database tests remain applicable. Live Edge
bundling, runtime secrets and an authorized first run remain deployment checks.
