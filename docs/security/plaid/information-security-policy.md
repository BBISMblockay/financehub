# Information Security Policy — draft

Version: 0.1. Proposed owner: Security owner (unassigned).
Approver: accountable executive (unassigned). Effective date: **not adopted**.
Review: annually and after material incidents, data-use or architecture changes.
All obligations below are proposed requirements, not claims of current operation.

## Purpose and scope

Protect the confidentiality, integrity and availability of SILO data, including
Plaid credentials and financial information. Cover employees, contractors,
production/test environments, source control, CI, cloud administration, endpoints,
backups, support exports and vendors that receive or can access this data.

The executive approves policy and resources. The security owner maintains the
control register, risk/exception register and incident process. System owners
implement controls and produce evidence. Finance and privacy owners approve data
purpose, retention and holds. An authorized representative signs attestations.
Assign named people and deputies in the restricted evidence store before adoption.

## Data classification and handling

- **Public:** reviewed public policies and public source documentation.
- **Internal:** operational documentation without personal or financial details.
- **Confidential:** user information, transactions, account metadata, financial
  reports, audit payloads and access-review records.
- **Restricted:** API secrets, access/refresh tokens, encryption keys, recovery
  material and credentials granting privileged access.

Collect only data needed for the documented purpose. Keep confidential and
restricted data out of public Git history, issues, screenshots and CI artifacts.
Use synthetic data in tests. Encrypt sensitive data in transit and at rest;
restrict exports and backups to approved roles with logging and retention limits.

## Access and trust boundaries

Apply the [access policy](access-control-policy.md) to every system. Authenticate
each principal, authorize each sensitive action, and grant no trust solely from
network location, a hidden UI link or a signed-in session. Enforce tenant and role
boundaries server-side and in database policies. Inventory privileged paths that
bypass RLS and constrain their purpose. Require managed, patched devices and
document device/session checks or compensating controls for administrative access.

Separate user, administrative and workload identities. Give service identities
only necessary operations and prefer short-lived, audience-bound credentials.
The existing scheduler's OIDC design is one scoped example, not proof of the
whole architecture. Review trust boundaries after integration or role changes.

## Tokens, certificates and secrets

Keep Plaid secrets and long-lived tokens on the server. Store tokens encrypted
with keys held separately in approved secret storage. Limit and audit key reads.
Validate HTTPS certificates using trusted roots; do not disable verification.
Inventory public endpoints and certificate renewal ownership; alert before expiry
and test renewal. Follow Plaid's current API TLS requirements and do not pin
Plaid certificates (see [API guidance](https://plaid.com/docs/api/)).

Inventory credential owner, purpose, environment, permissions, creation/rotation
date and revocation method without recording secret values. Rotate upon suspected
exposure, access changes that compromise custody, and the approved credential
schedule. Validate a staged rotation before production. For encrypted stored Plaid
tokens, retain old-key decryptability during re-encryption, verify all records,
then retire the old key; simply replacing the environment key is not rotation.
Record recovery, rollback and verification evidence privately.

## Secure changes, monitoring and incidents

Use reviewed feature branches, synthetic regression tests and controlled
deployments. Apply [vulnerability management](vulnerability-management-policy.md).
Monitor authentication/authorization failures, privilege changes, secret access,
sync failures, deletion failures and security findings. Assign alert recipients,
test delivery, and limit log access; redact credentials and financial payloads.
Finance audit events are not a substitute for security and identity audit logs.

For suspected incidents: report to the designated security owner immediately;
triage impact and affected systems; contain access; preserve restricted evidence;
rotate/revoke affected credentials; investigate; recover and test controls.
The privacy/legal owner assesses contractual and applicable notification duties,
including Plaid obligations, using the actual agreement and incident facts.
Record decisions and conduct a post-incident review. Do not invent a universal
notification deadline or send notices from this draft.

Back up critical data and key recovery material under separate access controls.
Assign recovery objectives and run restore tests; re-apply deletion tombstones and
revoked credentials before restored systems can serve data.

## Vendors, exceptions and evidence

Inventory data processors and subprocessors, including Plaid, Supabase, hosting,
CI and optional AI categorization/reporting providers. Review contracts, permitted
uses, data locations, retention, deletion and incident obligations before sharing
new data. A source-code integration does not establish approved vendor use.

Exceptions need an owner, scope, reason, compensating control, executive/security
approval and expiry. Review at least quarterly and close with evidence. An internal
exception does not make an unmet Plaid attestation true. Retain adoption, training,
review and control-test evidence according to the approved retention schedule.
