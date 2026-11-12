# Accounting workspace design

## Outcome and acceptance criteria (preflight)

Finance and executive users enter Accounting at a useful overview rather than a
configuration form. They can move into existing bank activity, journals, reports,
setup, and a month-end review workspace without losing any existing destination.

- Overview presents scoped bank balances (separate currencies and account types),
  recorded period review/delivery counts, recent journals, and actionable setup status.
  It does not invent income, expense, cash-history, or completion figures.
- Month-end selects a month and links actual period journals/imports to existing
  review controls. It never claims to lock or close books, or to verify QBO delivery.
- Setup leads with connections and mapping. Advanced opening-history controls remain
  reachable, including from existing hashes and migration jumps. Financial decisions
  retain their existing confirmation dialogs, permissions, and persisted results.
- Transactions retains account/date scopes, coding, approval, posting/recovery,
  drawers, and OAuth callbacks. Readability and navigation improve without new writes.
- Errors, missing data, and a missing company do not become zero, connected, or done.
  Every new financial read uses the resolved active company and existing RLS.
- Desktop/mobile and light/dark layouts remain usable; navigation, disclosures,
  repeated refresh/month changes, and existing dialog dismissal flows are exercised.

## Non-goals and dependencies

No accounting logic, RLS, database schema, approval gate, provider sync, journal
posting, automated acceptance, or production data change. No migration, edge deploy,
or secret required. The existing backend remains the source of truth. A read-only
month-end hub is not a new ledger close or reconciliation engine.

## Preflight call paths and risks

New pages call an auth/finance-gated, read-only controller; it resolves company once
before scoped queries. Accounting navigation is mounted only by SiloChrome for
registered accounting pages. Existing Transactions and Books write handlers keep
all original IDs and dependencies; no backend operation is added to navigation.
Current main was inspected at 79c2b788. Open PRs 1254 (Plaid refresh) and 1255
(API log retention) do not edit these UI surfaces.

New summaries must paginate or count, distinguish read failure from an empty result,
and separate SILO categorization from recorded QuickBooks posting. Connection records
are not proof of live provider health. Month changes must discard stale responses.
The new UI adds no destructive operation, retry write, or resumable job.

## Verification plan

Before implementation: existing finance regression scripts, full v2 unit/browser
suites, and new synthetic browser coverage for the final real pages. Inspect
screenshots in light/dark/mobile. Mutation checks should demonstrate that removing
company scope or error distinction fails new tests. Browser stubs prove UI wiring,
not live tenant RLS or provider status. Live sign-in and representative finance-role
smoke checks remain a user-enable gate for Blake after deployment, not a claim here.

## Implementation and current evidence

Implemented a read-only Overview and Month-end review hub, simpler shared
navigation, connection-first Setup, folded historical setup and bookkeeping
editor, and a more readable Transactions workbench. Existing financial handlers
and confirmation dialogs remain in place. Setup links directly to the existing
bank connections and account mapping panes through a presentation-only view
parameter; OAuth resumption and explicit journal links retain priority.

Local v2 unit suites and the focused accounting/transaction regression commands
pass. The new model tests include pagination, mixed currencies, missing balances,
error states, company changes, finance denial and stale-response suppression.
Mutation checks cover missing company scope, zero coercion, stale mapping and
opening-history visibility. A separate source review identified and corrected
stale company reconciliation, categorized-period counts and disconnected mappings.

Browser verification is pending, not passed: local Chromium exits before opening
any page because socket creation is prohibited. The installed cloud browser also
refused local file previews under its URL policy. No screenshots of the implemented
UI are represented as verified. Synthetic real-page tests are checked in for the
Overview, Month-end and Setup; they capture light/dark desktop/mobile images when
run in an environment that supports Chromium. Existing transaction dialog and
filter suites remain part of CI.

Before merge: run the full v2 browser suite in a working Chromium environment,
review the generated screenshots and exercise setup disclosure/hash navigation,
More dismissal, transaction drawers and month selection. Blake/reviewer owns this
gate. Before user enablement: smoke-test sign-in and the finance/executive role
with a representative non-production company and verify provider state wording.
No production connection, posting, acceptance, or configuration was changed.
