# Plaid attestation preparation

**Status: draft documentation; no attestation is approved or submitted.**

Prepared 2026-09-14 against `BBISMblockay/financehub` commit
`49073824154d9ae95e82e6376c057aacd7ae9d40`. The supplied Plaid Dashboard
screenshot lists 14 required attestations, each due **2027-03-15**. Its wording
is a requirements input, not proof that SILO has implemented a control.
Confirm the exact wording, scope and deadline in the Dashboard before submission.

This package covers SILO's Plaid Link/Transactions integration, its downstream
data, and the people and systems that can access it. It does not certify
organization-wide practices or replace Plaid's questionnaire. A policy merged
into Git is documentation, not evidence of adoption or operation.

## Start here

1. Assign named owners and confirm the internal-business-account scope in
   [the control register](control-register.md). Do not presume the consumer-MFA
   attestation is inapplicable because SILO is described as internal.
2. Review and formally adopt the draft [information security policy](information-security-policy.md),
   [access policy](access-control-policy.md), [retention policy](data-retention-deletion-policy.md),
   and [vulnerability policy](vulnerability-management-policy.md).
3. Execute the [remediation plan](remediation-plan.md), including privacy review
   using [the proposed privacy changes](privacy-policy-review.md).
4. Collect dated evidence using [the evidence templates](evidence-templates.md).
   Compare production against [the source review](repository-evidence.md).
5. Only an authorized organizational representative may approve an attestation,
   after verifying its entire scope and recording the evidence and exceptions.

## Public repository boundary

This repository is public. Keep policy text, synthetic examples, public source
references and opaque evidence IDs here. Keep personnel/access lists, security
settings exports, vulnerability details, bank data, incident records, signatures
and completed evidence forms in an access-controlled evidence store. Do not
commit credentials, MFA recovery codes, real tokens, private dashboard links or
the supplied screenshot. The templates are intentionally unfilled.

## Status vocabulary

- **Draft:** proposed policy or procedure; adoption has not been demonstrated.
- **Partial:** relevant source controls exist; complete operation is unverified.
- **Gap:** an implementation or documented-process gap was found in this review.
- **Unverified:** external settings or operating evidence were not inspected.
- **Verified:** requires dated operating evidence, reviewer and confirmed scope.
- **N/A approved:** requires documented scope rationale and Plaid acceptance
  where the Dashboard requires the attestation. Internal approval alone does not
  remove a Plaid requirement.

No control in this package is currently marked Verified or N/A approved.

## Sources

Checked 2026-09-14:

- [Plaid OAuth registration](https://plaid.com/docs/link/oauth/) describes the
  security questionnaire as a prerequisite for certain institution access.
- [Plaid API data handling](https://plaid.com/docs/api/#storing-api-data) requires
  secure token handling and keeps long-lived tokens out of the browser.
- [Plaid Item removal](https://plaid.com/docs/api/items/#itemremove) documents
  removing an Item. This is distinct from deleting SILO's stored data.
- [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa) explains enrollment
  and assurance levels. SDK support alone does not enforce MFA.
- [Existing bank-feed runbook](../../ops/plaid-bank-feed-v1.md) remains the
  integration/rollout reference. This package does not authorize a deployment,
  production data change, or dashboard attestation.
