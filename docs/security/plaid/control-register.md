# Required attestation register

Source: user-supplied Dashboard screenshot. All rows are due **2027-03-15**.
Reviewed 2026-09-14; every named owner, approver, evidence record and sign-off is
**unassigned/pending**. Suggested role ownership below is not an assignment.
Requirement labels summarize the screenshot; use its exact Dashboard text at signing.

| ID | Attestation requirement | Current assessment | Proposed owner | Policy / supporting reference | Evidence needed before sign-off |
|---|---|---|---|---|---|
| P01 | Defined and documented access control policy implemented | Draft / Partial | Security owner | [Access policy](access-control-policy.md); [E02](repository-evidence.md#e02-access-boundary) | Approved policy, system/role inventory, access approval and removal samples, deployed negative authorization tests |
| P02 | Periodic access reviews and audits performed | Unverified | Security owner + system owners | [Review procedure](access-control-policy.md#access-reviews); [template](evidence-templates.md#access-review-record) | Completed review with full population, reviewer decisions, dated remediation and next review |
| P03 | Robust MFA on internal systems storing or processing consumer data | Unverified; app enforcement gap | IT / identity owner | [MFA requirements](access-control-policy.md#mfa-and-identity) | Enforcement exports and login/recovery tests for every in-scope system, including privileged access and exceptions |
| P04 | Published privacy policy | Partial; publication checked, content gaps | Privacy owner | [Privacy review](privacy-policy-review.md); [E01](repository-evidence.md#e01-privacy-publication-and-scope) | Approved accurate text, anonymous HTTPS retrieval, linked notice in the user flow, confirmed contact and effective date |
| P05 | Data deletion and retention policy implemented | Draft / Gap | Privacy + engineering + finance | [Retention policy](data-retention-deletion-policy.md); [E04](repository-evidence.md#e04-pausing-is-not-deletion) | Approved schedule; tested revocation, deletion, holds, downstream and backup handling; completed request evidence |
| P06 | Secure tokens and certificates used for authentication | Partial | Engineering / infrastructure owner | [Token policy](information-security-policy.md#tokens-certificates-and-secrets); [E03](repository-evidence.md#e03-token-protection) | Deployed encryption/grants, secret-access review, certificate/TLS evidence, rotation/revocation drill |
| P07 | Automated de-provisioning/modification for terminated or transferred employees | Gap in repository evidence; external automation unverified | IT + HR owner | [Lifecycle procedure](access-control-policy.md#joiners-movers-and-leavers) | HR/IdP trigger and connector inventory, automated disable and transfer logs, session revocation and failure-alert tests |
| P08 | Zero trust access architecture implemented | Partial; organization-wide scope unverified | Security / architecture owner | [Trust boundaries](information-security-policy.md#access-and-trust-boundaries); [E02](repository-evidence.md#e02-access-boundary) | Architecture/system inventory, explicit identity checks, least privilege, device/session policy and boundary tests |
| P09 | Information Security Policy created | Draft | Accountable executive + security owner | [ISP](information-security-policy.md) | Approved version, effective date, owner, communication/acknowledgment and review record |
| P10 | Centralized identity and access management implemented | Partial for app; workforce IAM unverified | IT / identity owner | [Identity policy](access-control-policy.md#mfa-and-identity) | Authoritative IdP inventory, system enrollment/SSO or managed exceptions, provisioning mappings and reconciliation |
| P11 | MFA implemented on consumer-facing application where Plaid Link is deployed | Gap; applicability unresolved | Product + engineering owner | [MFA requirements](access-control-policy.md#mfa-and-identity); [E05](repository-evidence.md#e05-mfa) | Confirmed user/account scope; deployed enrollment and server/DB enforcement tests, recovery controls; or written accepted N/A rationale |
| P12 | Vulnerability scanning performed | Gap in repo workflows; external scanning unverified | Engineering / security owner | [Scanning policy](vulnerability-management-policy.md) | Scanner coverage, successful scheduled and change-triggered reports, triage evidence, alert delivery |
| P13 | Vulnerabilities patched within a defined SLA | Draft / Unverified | Engineering + system owners | [Proposed SLAs](vulnerability-management-policy.md#proposed-remediation-slas) | Approved SLA, timestamped findings/fixes/retests, overdue escalation and approved exceptions |
| P14 | EOL software monitored and policies updated for EOL management | Draft / Unverified | Engineering / infrastructure owner | [EOL policy](vulnerability-management-policy.md#end-of-life-management); [E06](repository-evidence.md#e06-scanning-and-software-inventory) | Version/support inventory, vendor lifecycle references, recurring reviews, upgrade tickets and completed upgrades |

## Per-control sign-off gate

For each ID, retain an [attestation record](evidence-templates.md#attestation-record)
with exact wording, legal entity, application/environment, evidence date range,
policy version, implementation and operating evidence, exceptions, reviewer,
authorized signer and decision date. Partial evidence does not support a full
attestation. Track remediation target dates separately from the Dashboard due date.

The repository assessment deliberately says **unverified**, rather than absent,
for controls that may exist in company systems outside this repository.
