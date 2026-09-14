# Repository evidence and verification limits

Baseline: `49073824154d9ae95e82e6376c057aacd7ae9d40`, reviewed 2026-09-14.
Links are relative for navigation; retrieve this baseline commit when reproducing
the assessment. A source file or prior runbook is not a live configuration audit.
No production database queries or private admin-console inspection were performed.

## E01 Privacy publication and scope

[legal/privacy.html](../../../legal/privacy.html) exists. An unauthenticated HTTPS
GET to `https://silo-baseballism.com/legal/privacy.html` returned HTTP 200 on
2026-09-14, with the SILO Privacy Policy heading and no Plaid mention.
That verifies availability at that time, not accuracy of every statement.

The notice describes internal-only, invitation-based use and no public signup.
[pages/login.html](../../../pages/login.html) contains `auth.signUp` with organization
creation as well as invitation flows. Whether new signup is enabled in deployed
Supabase Auth settings remains unverified. Reconcile policy and actual use.

[card-categorize](../../../supabase/functions/card-categorize/index.ts) can send
stored transaction descriptors, merchant/card names, aggregate amounts and
accounting context to Anthropic when categorization is invoked. Include this
conditional downstream path in data mapping and privacy/vendor review; do not
claim that bank data can only flow to Plaid and Supabase.

## E02 Access boundary

[plaid-finance/handler.ts](../../../supabase/functions/plaid-finance/handler.ts)
validates the user with `auth.getUser`, obtains company/finance authorization in
one `plaid_finance_context` RPC, and scopes connection lookups to that company.
The [bank-feed migration](../../../supabase/migrations/20260912052930_plaid_bank_feed.sql)
checks active profiles in that RPC; defines finance/company-scoped read policies;
and explicitly revokes client access to `plaid_connection_secrets`.

[plaid-scheduled-sync/oidc.mjs](../../../supabase/functions/plaid-scheduled-sync/oidc.mjs)
validates GitHub JWT signatures and restricts issuer, audience, repository/owner IDs,
main branch, workflow and event type. [plaid-sync.yml](../../../.github/workflows/plaid-sync.yml)
uses short-lived OIDC for this job. Other workflows still use repository secrets;
this one job does not demonstrate centralized IAM across the organization.

Verify deployed definitions/grants, inactive and transferred users, cross-company
access, direct Data API/RPC access and privileged bypass paths. Frontend navigation
is not an authorization boundary. Inventory all deployed functions and public
legacy routes before making an organization-wide zero trust claim.

## E03 Token protection

[plaid-core.mjs](../../../supabase/functions/plaid-finance/plaid-core.mjs) uses
AES-256-GCM with a random 12-byte IV and authenticated company/Item/environment
context. The handler stores ciphertext separately from connection metadata and
only returns short-lived Link data to clients. Signed Link state binds the user,
company, connection and expiry. Provider errors are reduced to fixed safe messages.

This is source evidence, not proof of production key custody, deployed grants,
certificate monitoring or an exercised rotation process. The existing
[runbook](../../ops/plaid-bank-feed-v1.md) warns that replacing the encryption key
alone would strand existing ciphertext. Rotation must preserve decryptability or
deliberately re-establish connections.

## E04 Pausing is not deletion

The handler's `disconnect` action updates connection status and returns
`{ paused: true }`. It does not call `/item/remove`, delete stored ciphertext or
erase historical transactions. An `/item/remove` call exists only in a conditional
failed-initial-registration cleanup path; that is not a general deletion flow.

The migration makes `finance_audit_events` append-only and rejects update, delete
and truncate. Provider payloads can appear in transaction raw data, sync exceptions
and before/after audit data. A retention procedure must address these copies,
downstream records and backups without silently weakening accounting controls.

## E05 MFA

The login source uses email/password. The Plaid handler checks identity and finance
permission but has no MFA assurance check. Searches for `auth.mfa` and `aal2` across
application source and migrations found no app enforcement; a vendored SDK exposing
MFA APIs is not implementation. External MFA/SSO, dashboard settings and provider
enforcement were not inspected. Bank authentication inside Plaid Link does not
establish MFA for a SILO session.

## E06 Scanning and software inventory

Existing workflows run functional tests and deployment-drift checks. No dedicated
vulnerability scanning workflow, Dependabot configuration or patch SLA was found
in the reviewed source. GitHub security settings and external scanners were not
inspected. Functional tests do not prove vulnerability scanning.

Inventory at least:

- [Root package.json](../../../package.json): dependency ranges, no root lockfile.
- [v2 test packages](../../../v2/tests/package.json) and
  [v3 test packages](../../../v3/tests/package.json): separate dependency manifests.
- [Finance DB tests](../../../scripts/tests/finance-db/package.json) and
  [OIDC tests](../../../scripts/tests/plaid-oidc/package.json): manifests and lockfiles.
- [Scheduler Deno imports](../../../supabase/functions/plaid-scheduled-sync/deno.json)
  and its lockfile; URL/npm imports in other Edge Functions.
- CDN scripts and [the vendored SDK](../../../v2/lib/supabase-js.min.js), which a
  root npm scan will not inventory automatically.
- Node versions in all Actions, the Express runtime, Deno/Edge runtime, managed
  Postgres version/extensions and deployment tools. Most Actions request Node 22;
  [one-time-sales-backfill.yml](../../../.github/workflows/one-time-sales-backfill.yml)
  still requests Node 20. Record support dates from vendors and remediate or retire
  unsupported runnable paths; do not assume a manual job is out of scope.

## Verification performed for this package

On 2026-09-14, at the baseline above:

| Command / check | Observed result | Limit |
|---|---|---|
| `node scripts/tests/plaid-core.test.mjs` | 16 tests passed | Local protocol and crypto tests; no live bank |
| `node scripts/tests/plaid-finance-handler.test.mjs` | 65 executed scenarios passed; 4 deliberate regressions rejected | Real handler with synthetic provider/database IO; not live RLS |
| Anonymous GET of deployed privacy URL | HTTP 200, policy heading present, Plaid absent | Point-in-time publication only |

No new security enforcement, scanner, IAM connector or deletion job is introduced
by these documents. No claim is made about live RLS, current production MFA,
operating access reviews, vulnerability counts, key rotation or successful deletion.
