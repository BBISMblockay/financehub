# Remediation and evidence plan

Prepared 2026-09-14. Targets below are proposed internal milestones, not commitments
already accepted by named owners. Dashboard deadline: **2027-03-15** for all 14 rows.
Every work item starts **open**. Track implementation PRs and restricted evidence
IDs here once assigned; do not store private findings or personal records here.

| Work item | Proposed target | Controls | Exit criteria |
|---|---|---|---|
| R01 Assign accountable owners and confirm Plaid scope | 2026-09-30 | All; P11 especially | Named executive/security/IT/privacy/finance/engineering owners privately recorded; actual user/account scope, exact Dashboard wording and deadline confirmed; P11 N/A question resolved with Plaid if appropriate |
| R02 Adopt policies and inventory systems/data/vendors | 2026-10-15 | P01/P05/P08/P09/P10/P13/P14 | Approved versions/effective dates, communicated policy, complete system/data/identity inventory, no unresolved retention durations |
| R03 Enforce and test human MFA and lifecycle automation | 2026-11-15 | P03/P07/P10/P11 | Cloud/admin MFA exports, application assurance enforcement, direct API/RPC tests, automated termination/transfer and failed-connector drills, recovery/session-revocation verification |
| R04 Implement revocation/deletion and approve privacy updates | 2026-11-30 | P04/P05/P06 | Pause vs revoke vs erase implemented distinctly; safe audit/hold/backup/downstream handling tested; accurate approved notice published and linked |
| R05 Establish vulnerability scans, patch tracking and EOL inventory | 2026-10-31 | P12/P13/P14 | Coverage across manifests/CDN/Edge/runtime; successful scheduled scan and alert test; owners/SLAs assigned; unsupported software disposition recorded |
| R06 Complete first access review and token/trust-boundary drills | 2026-10-31 | P01/P02/P06/P08 | Full access population reviewed and findings closed; production boundary evidence; certificate and key-rotation/recovery tests |
| R07 Accumulate operating evidence and repeat reviews/scans | 2027-01-31 | P02/P03/P07/P12/P13/P14 | Recurring reviews/scans occurred at adopted cadences; failures and overdue exceptions resolved or accurately disclosed |
| R08 Conduct final control-by-control review | 2027-02-15 | All | Exact claim, scope, deployed evidence, owner and authorized reviewer recorded for each of 14 controls; stale evidence refreshed |
| R09 Submit supported attestations and retain receipts | 2027-03-01 | All | Authorized representative submits accurate responses; unresolved controls escalated to Plaid rather than signed as implemented |

## Implementation acceptance checks

- **MFA:** enrolled, unenrolled, password-only, expired/recovered sessions and
  direct API/RPC access; protect both Link actions and financial data reads.
- **Lifecycle:** terminate and transfer synthetic identities; check every company
  membership and system; force connector failure and verify alert/retry plus
  manual containment. Existing sessions must lose sensitive access.
- **Deletion:** revoke an Item, remove eligible copies, retain only approved held
  records, prevent re-ingestion, retry ambiguous failures and rehearse restoration.
  A successful pause action cannot pass this check.
- **Tokens:** prove client denial on the secret table, tenant-bound ciphertext,
  rotation without stranded connections and certificate renewal/expiry alerts.
- **Scanning:** prove scheduled and change-triggered scans actually ran across the
  declared inventory; failed/skipped scans generate action, and fixes are retested.
- **Privacy:** test anonymous access and notice placement; reconcile signup,
  bank-account scope, optional AI disclosures, retention and the request channel.

This is a documentation PR. Implement security controls in separately reviewed
changes with staging evidence and the normal deployment process. Existing app
behavior and organizational settings remain unverified except where the source
review explicitly records an observation.
