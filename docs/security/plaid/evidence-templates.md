# Evidence templates

**Blank templates only. Store completed records in a restricted evidence store.**
Use opaque IDs in the public register. Each record must identify the collecting
person, collection date, scope/environment, evidence source and independent
reviewer. Do not use synthetic test output as production operating evidence.

## Attestation record

```text
Evidence ID / control ID (P01-P14):
Exact Dashboard attestation wording and due date:
Legal entity / application / users / environments / systems in scope:
Policy title, version, approval record and effective date:
Named control owner / deputy:
Implementation evidence IDs and deployed commit/configuration:
Operating evidence IDs and observation period:
Tests, expected result, observed result and collection date:
Coverage limitations, exceptions, expiry and remediation IDs:
Applicability rationale / Plaid acceptance reference if N/A:
Independent reviewer / review date / decision:
Authorized signer / authority basis / sign-off date:
Decision: pending | supported | not supported | N/A accepted
Submission timestamp / exact response / receipt ID (after submission only):
Next review / evidence refresh date:
```

## Access review record

```text
Review ID / date range / next due date:
Identity source and every target system / export timestamps:
Population totals (humans, privileged, workloads, local exceptions):
Per identity: business owner, employment status, company memberships,
             roles, privilege, last use, MFA enforcement, keep/change/remove,
             reviewer, reason and deadline.
Outstanding invites, emergency accounts and service-account owners checked:
Removal/change evidence, session-denial test and closure timestamp:
Unresolved findings / escalation / approver:
Reviewer / independent closure verifier:
```

## Lifecycle automation test

```text
Test ID / synthetic identity / environment / event type:
Authoritative event timestamp / effective time:
Expected target systems and old/new grants:
Per-target action, timestamp, result and retry state:
Termination and transfer outcomes (test separately):
Existing access/refresh sessions and direct API denial results:
Invite, emergency access, service ownership and secret-custody checks:
Injected connector failure / alert recipient / alert received timestamp:
Containment, retry, reconciliation and independent verification:
```

## Retention or deletion record

```text
Request ID / received date / verified authority / deadline basis:
Subject/company/Item scope (restricted record only):
Inventory of primary, audit, exception, derived, export, vendor and backup copies:
Approved retention schedule/version / holds and their authority/expiry:
Ingestion pause and in-flight work coordination:
Provider revocation result / confirmation ID / ambiguous outcome handling:
Per-store disposition, timestamp, result, retry and owner:
Held subset and reason / backup expiry / restore deletion-ledger reference:
Downstream request and confirmation IDs:
Verification / reviewer / response sent / follow-up date:
Final state: pending | partial | verified complete for stated scope
```

## Vulnerability and EOL record

```text
Finding/inventory ID / asset owner / environment / exact deployed version:
Scanner and coverage / run timestamp / restricted report ID:
First detection / severity and exposure rationale:
SLA due date / containment / remediation owner and ticket:
Fix commit / deployed version / deployment timestamp / retest result:
Exception approval, compensating controls and expiry (if any):
Vendor support/EOL source URL / checked date / support end date:
Upgrade target / compatibility test / completion evidence:
Independent closure reviewer / date / next inventory review:
```

## Policy approval and exception record

```text
Policy name/version or exception ID:
Scope / owner / approver / decision date / effective date:
Business reason / risk / compensating control (exceptions only):
Communication and acknowledgment evidence:
Review/expiry date / affected controls / closure evidence:
```

Keep the public register's status pending until the authorized review is recorded.
Policy adoption, operational verification and Dashboard submission are separate events.
