# On Deck freshness recovery preflight

The source fingerprint is called by the scheduler before/after each facts read,
staging, reservation, review-state reads, context assignment and edit/approval.
The live definition matches the action-loop migration. It is stable, security
definer, uses an empty search path and is executable only by service_role among
the API roles (anon/authenticated denied). The forward replacement retains these
boundaries and every source branch, caching the same company-local date once.

UI inputs are company-scoped loaded proposals, server freshness, saved screening
diagnostics and existing settings. Old run summaries must not assert present
readiness. Stale/failed drafts remain inspectable and unapprovable; refresh queues
the existing authorized request RPC, never directly prepares or approves work.
Settings retain the numeric per-product ceiling and existing filtering policy.

Worker failures can occur after staging or an uncertain provider result. Keep
prior drafts, cost holds and existing idempotency behavior; record only an
allowlisted stage/workflow and constrained error code, never raw messages,
request bodies, tokens, identifiers or business content. No production writes,
schema applies, deployments, settings changes or paid calls are part of this PR.

Before implementation tests: compare legacy/new fingerprints for all branches,
company zones and cutoff boundaries; count timezone calls over a large fixture;
prove stale/failed/needs-context/empty UI status and explicit refresh; preserve
company settings on save and show actual currency/no-ceiling warning; inject a
57014 failure with sensitive message text and verify sanitized stored/logged
diagnostics. Mutations must catch the old per-row expression and UI/error guards.

Live acceptance after separately authorized rollout remains required: the
optimized production fingerprint, a successful scheduler screen, and a usable
draft cannot be established by fixture tests or a deployment alone.

## Local verification

- The source-date fixture compares all four fingerprint branches across four
  company timezones and three clocks (48 comparisons), checks one timezone call
  over 20,000 additional sales rows, reapplies the replacement, and confirms the
  existing API-role grants. Reintroducing the per-row expression fails with
  20,094 calls instead of one.
- `node v2/tests/run.js --unit`: all 31 suites passed.
- `node v2/tests/run.js --browser`: 38 suites passed initially; the remaining
  On Deck suite exposed missing persistence in its currency-save fixture.
  Its scoped SDK fixture was corrected and the 11-check suite passed separately.
- Targeted core, worker, edge, database, action-loop and action-contract suites
  passed, as did `plaid-bank-feed-database.test.mjs` and workflow YAML parsing.
- Independent review found and resolved unknown-freshness readiness, legacy SEO
  readiness, the Settings query's missing kind, and saved-currency label refresh.

Production application remains a separate, explicitly authorized step: apply
`20261009171424_on_deck_source_date_once.sql`, run the schema verifier, then
measure the actual fingerprint and review a successful preparation. No edge
function changed in this follow-up. Merge alone does not establish live success.

Mutation checks also caught removal of confirmed freshness, stale and structured SEO guards, the saved-currency refresh, the empty-state refresh action, and sanitized error diagnostics. All temporary mutations were restored before publication.
